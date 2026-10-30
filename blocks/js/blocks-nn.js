/* ブロック陣取りのネットをブラウザ（と Node）で計算する。重みは js/weights.js（train/export.py が書き出す）、形は train/netdef.py
 *
 *   const net = new BlocksNN.Net(BLOCKS_WEIGHTS, BLOCKS_WASM_B64);
 *   const out = net.evalBytes(bytes, n, idx);   // bytes = BlocksCore.features の形、idx = 知りたい手の方策の番号
 *   // → { logp: 手ごとの対数確率（idx の中で正規化）, u: 相対の色ごとの順位の値（−1〜1）, s: 相対の色ごとの得点の見込み }
 *   const r = net.evalPos(pos, moves);           // 局面から（手番の色を自分にして回す）。u・s は色ごと（相対ではない）
 *
 * 胴体の 3×3 畳み込みは WebAssembly の SIMD（train/nn.wat。囲碁と同じもの）、頭の小さな計算は JS
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./blocks-core.js'));
  else root.BlocksNN = factory(root.BlocksCore);
})(typeof self !== 'undefined' ? self : this, function (BC) {
  'use strict';
  const MAXN = 20, MAXM = MAXN + 2, MAXA = MAXM * MAXM, NORI = 91;

  function b64bytes(s) {
    if (typeof atob === 'function') { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  // y = x・W + b（W は [cin][cout]）
  function dense(x, W, b, cin, cout, out, relu) {
    for (let j = 0; j < cout; j++) out[j] = b ? b[j] : 0;
    for (let i = 0; i < cin; i++) { const v = x[i]; if (!v) continue; const r = i * cout; for (let j = 0; j < cout; j++) out[j] += v * W[r + j]; }
    if (relu) for (let j = 0; j < cout; j++) if (out[j] < 0) out[j] = 0;
    return out;
  }

  class Net {
    constructor(W, wasmB64) {
      this.W = W;
      this.blocks = W.blocks; this.C = W.ch; this.PH = W.ph; this.VH = W.vh; this.HID = W.hid; this.F = W.F; this.G = W.G;
      this.scoreScale = W.scoreScale || 20;
      const raw = b64bytes(W.b64);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const T = {};
      for (const t of W.tensors) {
        const count = t.s.reduce((a, b) => a * b, 1);
        const out = new Float32Array(count);
        if (t.q) {
          const co = t.s[t.s.length - 1], so = t.o + count + ((4 - (count % 4)) % 4);
          const taps = t.q === 2 ? t.s[0] * t.s[1] : 1, per = count / taps;
          const sc = new Float32Array(taps * co);
          for (let j = 0; j < taps * co; j++) sc[j] = dv.getFloat32(so + j * 4, true);
          for (let i = 0; i < count; i++) out[i] = dv.getInt8(t.o + i) * sc[Math.floor(i / per) * co + (i % co)];
        } else for (let i = 0; i < count; i++) out[i] = dv.getFloat32(t.o + i * 4, true);
        T[t.n] = out;
      }
      this.T = T;
      const C = this.C, F = this.F, PH = this.PH, VH = this.VH;
      let off = 1024;
      const alloc = floats => { const o = off; off += Math.ceil(floats * 4 / 64) * 64 + 64; return o; };
      const convs = [['stem.w', null, F, C, 9]];
      for (let i = 0; i < this.blocks; i++) convs.push([`b${i}.w1`, `b${i}.b1`, C, C, 9], [`b${i}.w2`, `b${i}.b2`, C, C, 9]);
      convs.push(['pol.w', 'pol.b', C, PH, 9], ['val.w', 'val.b', C, VH, 1]);
      this.layout = {};
      for (const [w, b, cin, cout, taps] of convs) this.layout[w] = { w: alloc(taps * cin * cout), b: alloc(cout), wn: w, bn: b, cin, cout, taps };
      this.bufIn = alloc(MAXA * F); this.bufA = alloc(MAXA * C); this.bufT = alloc(MAXA * C); this.bufY = alloc(MAXA * C);
      this.bufP = alloc(MAXA * PH); this.bufV = alloc(MAXA * VH);
      const pages = Math.ceil((off + 65536) / 65536);
      this.mem = new WebAssembly.Memory({ initial: pages });
      const mod = new WebAssembly.Module(b64bytes(wasmB64));
      this.conv = new WebAssembly.Instance(mod, { env: { mem: this.mem } }).exports.conv;
      this.f32 = new Float32Array(this.mem.buffer);
      for (const L of Object.values(this.layout)) {
        this.f32.set(T[L.wn], L.w / 4);
        if (L.bn) this.f32.set(T[L.bn], L.b / 4); // 胴体の最初の畳み込みのバイアスは JS で足す（盤全体の特徴と一緒に）
        delete T[L.wn];
      }
      this.pool = new Float32Array(2 * Math.max(C, PH, VH)); this.gh = new Float32Array(C); this.gv = new Float32Array(C);
      this.glob = new Float32Array(this.G); this.gs = new Float32Array(C);
      this.vh = new Float32Array(this.HID);
      this.bytes = new Uint8Array(MAXN * MAXN + this.G);
      this.lastN = 0;
      this.evals = 0;
    }

    _conv(name, inp, out, n, relu) {
      const L = this.layout[name];
      this.conv(inp, L.w, L.b, out, 0, n, L.cin, L.cout, relu ? 1 : 0, L.taps === 9 ? 0 : 4, L.taps === 9 ? 9 : 5);
    }
    _pool(buf, n, c, out) {
      const f = this.f32, M = n + 2, b0 = buf / 4;
      for (let j = 0; j < c; j++) { out[j] = 0; out[c + j] = -Infinity; }
      for (let y = 1; y <= n; y++) for (let x = 1; x <= n; x++) {
        const o = b0 + (y * M + x) * c;
        for (let j = 0; j < c; j++) { const v = f[o + j]; out[j] += v; if (v > out[c + j]) out[c + j] = v; }
      }
      const inv = 1 / (n * n);
      for (let j = 0; j < c; j++) out[j] *= inv;
    }

    // 入力のバイト（BlocksCore.features の形）から計算する
    evalBytes(bytes, n, idx) {
      const C = this.C, F = this.F, PH = this.PH, VH = this.VH, T = this.T, f = this.f32, M = n + 2, NN = n * n;
      if (this.lastN !== n) {
        f.fill(0, this.bufIn / 4, this.bufIn / 4 + MAXA * F);
        for (const b of [this.bufA, this.bufT, this.bufY]) f.fill(0, b / 4, b / 4 + MAXA * C);
        f.fill(0, this.bufP / 4, this.bufP / 4 + MAXA * PH); f.fill(0, this.bufV / 4, this.bufV / 4 + MAXA * VH);
        this.lastN = n;
      }
      // 盤の特徴（netdef.py の並び）
      const I = this.bufIn / 4;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = bytes[y * n + x], o = I + ((y + 1) * M + x + 1) * F, occ = v & 7;
        f[o] = occ === 1 ? 1 : 0; f[o + 1] = occ === 2 ? 1 : 0; f[o + 2] = occ === 3 ? 1 : 0; f[o + 3] = occ === 4 ? 1 : 0; f[o + 4] = occ === 0 ? 1 : 0;
        f[o + 5] = (v >> 3) & 1; f[o + 6] = (v >> 4) & 1; f[o + 7] = (v >> 5) & 1; f[o + 8] = (v >> 6) & 1; f[o + 9] = (v >> 7) & 1; f[o + 10] = 1;
      }
      const g = this.glob;
      for (let i = 0; i < this.G; i++) g[i] = bytes[NN + i];
      g[94] /= 84;
      // 胴体
      this._conv('stem.w', this.bufIn, this.bufA, n, false);
      dense(g, T['stem.gw'], T['stem.b'], this.G, C, this.gs, false);
      const A = this.bufA / 4, Y = this.bufY / 4, gs = this.gs;
      for (let y = 1; y <= n; y++) for (let x = 1; x <= n; x++) {
        const o = A + (y * M + x) * C;
        for (let j = 0; j < C; j++) { const v = f[o + j] + gs[j]; f[o + j] = v > 0 ? v : 0; }
      }
      for (let b = 0; b < this.blocks; b++) {
        this._conv(`b${b}.w1`, this.bufA, this.bufT, n, true);
        this._conv(`b${b}.w2`, this.bufT, this.bufY, n, false);
        this._pool(this.bufY, n, C, this.pool);
        dense(this.pool, T[`b${b}.g1w`], T[`b${b}.g1b`], 2 * C, C >> 1, this.gh, true);
        dense(this.gh, T[`b${b}.g2w`], T[`b${b}.g2b`], C >> 1, C, this.gv, false);
        const gv = this.gv;
        for (let y = 1; y <= n; y++) for (let x = 1; x <= n; x++) {
          const o = (y * M + x) * C;
          for (let j = 0; j < C; j++) { const v = f[A + o + j] + f[Y + o + j] + gv[j]; f[A + o + j] = v > 0 ? v : 0; }
        }
      }
      // 方策（知りたい手だけ）
      this._conv('pol.w', this.bufA, this.bufP, n, true);
      const k = idx ? idx.length : 0, logp = new Float32Array(k), ow = T['pol.ow'], ob = T['pol.ob'], P = this.bufP / 4;
      let mx = -Infinity;
      for (let i = 0; i < k; i++) {
        const id = idx[i], o = (id / NN) | 0, cell = id - o * NN, cy = (cell / n) | 0, cx = cell - cy * n;
        const po = P + ((cy + 1) * M + cx + 1) * PH;
        let s = ob[o];
        for (let j = 0; j < PH; j++) { const v = f[po + j]; if (v) s += v * ow[j * NORI + o]; }
        logp[i] = s; if (s > mx) mx = s;
      }
      let se = 0;
      for (let i = 0; i < k; i++) se += Math.exp(logp[i] - mx);
      const ls = mx + Math.log(se);
      for (let i = 0; i < k; i++) logp[i] -= ls;
      // 価値
      this._conv('val.w', this.bufA, this.bufV, n, true);
      const vp = this.pool;
      this._pool(this.bufV, n, VH, vp);
      const h = dense(vp, T['val.d1w'], T['val.d1b'], 2 * VH, this.HID, this.vh, true);
      const u = dense(h, T['val.uw'], T['val.ub'], this.HID, 4, new Float32Array(4), false);
      for (let i = 0; i < 4; i++) u[i] = Math.tanh(u[i]);
      const s = dense(h, T['val.sw'], T['val.sb'], this.HID, 4, new Float32Array(4), false);
      for (let i = 0; i < 4; i++) s[i] *= this.scoreScale;
      this.evals++;
      return { logp, u, s };
    }

    // 局面から: moves（置き方の番号の配列）の方策と、色ごとの順位の値・得点の見込み。aug = 2人 14×14 の斜めの裏返し
    evalPos(pos, moves, aug = 0) {
      const me = pos.turn, n = pos.n, sym = BC.canonSym(pos, me, aug);
      BC.features(pos, this.bytes, 0, sym);
      const T = pos.T, S = T.sym(sym), idx = new Int32Array(moves.length);
      for (let i = 0; i < moves.length; i++) idx[i] = T.POL[S[moves[i]]];
      const out = this.evalBytes(this.bytes, n, idx);
      const nc = pos.nc, u = new Float32Array(nc), s = new Float32Array(nc);
      for (let k = 0; k < nc; k++) { const c = (me + k) % nc; u[c] = out.u[k]; s[c] = out.s[k]; }
      return { logp: out.logp, u, s, rel: out };
    }
  }

  return { Net, dense };
});
