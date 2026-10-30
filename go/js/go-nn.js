/* 囲碁のネットをブラウザ（と Node）で計算する。重みは js/weights.js（train/export.py が書き出す）
 *
 *   const G = {}; GoCore(G); GoNN(G);
 *   const net = new G.Net(GO_WEIGHTS, GO_WASM_B64);
 *   const out = net.run(board, sym);   // { logits: 点ごと＋パス, policy: 合法手だけで正規化した確率, wdl, value, score, own }
 *
 * 胴体の 3×3 畳み込みは WebAssembly の SIMD（train/nn.wat）、頭の小さな計算は JS。値はすべて手番の側から見たもの
 *   value = 勝ち確率 − 負け確率、score = 最後の目数の差の見込み、own[i] = 点 i が手番の側のものになる見込み（−1〜1）
 * 盤の大きさに依存する層がないので、9路で学んだネットを 13路・19路にも使える（ただし 9路ほどは強くない）
 */
function GoNN(G) {
  'use strict';
  const F = 19, MAXN = 19, MAXM = MAXN + 2, MAXA = MAXM * MAXM;

  function b64bytes(s) {
    if (typeof atob === 'function') { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  // 8通りの対称: (x, y) → 移る先。k&4 で x と y を入れ替え、k&1 で上下、k&2 で左右
  function symXY(k, n, x, y) {
    if (k & 4) { const t = x; x = y; y = t; }
    if (k & 1) y = n - 1 - y;
    if (k & 2) x = n - 1 - x;
    return [x, y];
  }

  class Net {
    constructor(W, wasmB64) {
      this.W = W;
      this.blocks = W.blocks; this.C = W.ch; this.H = W.head;
      const raw = b64bytes(W.b64);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const T = {};
      // テンソルを Float32Array に戻す（int8 は出力チャンネルごとの倍率を掛ける）
      for (const t of W.tensors) {
        const count = t.s.reduce((a, b) => a * b, 1);
        const out = new Float32Array(count);
        if (t.q) {
          // q=1: 倍率は出力チャンネルごと。q=2（3×3 などの畳み込み）: タップ×出力チャンネルごと
          const co = t.s[t.s.length - 1], so = t.o + count + ((4 - (count % 4)) % 4);
          const taps = t.q === 2 ? t.s[0] * t.s[1] : 1, per = count / taps;
          const sc = new Float32Array(taps * co);
          for (let j = 0; j < taps * co; j++) sc[j] = dv.getFloat32(so + j * 4, true);
          for (let i = 0; i < count; i++) out[i] = dv.getInt8(t.o + i) * sc[Math.floor(i / per) * co + (i % co)];
        } else for (let i = 0; i < count; i++) out[i] = dv.getFloat32(t.o + i * 4, true);
        T[t.n] = out;
      }
      this.T = T;
      const C = this.C, H = this.H;
      // WebAssembly のメモリの割り付け（バイト）。畳み込みの重みはメモリに置き、頭の重みは JS に置く
      let off = 1024;
      const alloc = floats => { const o = off; off += Math.ceil(floats * 4 / 64) * 64 + 64; return o; };
      const convs = [['stem.w', 'stem.b', F, C, 9]];
      for (let i = 0; i < this.blocks; i++) convs.push([`b${i}.w1`, `b${i}.b1`, C, C, 9], [`b${i}.w2`, `b${i}.b2`, C, C, 9]);
      convs.push(['pol.wg', 'pol.bg', C, H, 1], ['pol.w1', null, C, H, 1], ['val.w', 'val.b', C, H, 1]);
      this.layout = {};
      for (const [w, b, cin, cout, taps] of convs) this.layout[w] = { w: alloc(taps * cin * cout), b: alloc(cout), wn: w, bn: b, cin, cout, taps };
      this.bufIn = alloc(MAXA * F); this.bufA = alloc(MAXA * C); this.bufT = alloc(MAXA * C); this.bufY = alloc(MAXA * C);
      this.bufG = alloc(MAXA * H); this.bufP = alloc(MAXA * H); this.bufV = alloc(MAXA * H);
      const pages = Math.ceil((off + 65536) / 65536);
      this.mem = new WebAssembly.Memory({ initial: pages });
      const mod = new WebAssembly.Module(b64bytes(wasmB64));
      this.conv = new WebAssembly.Instance(mod, { env: { mem: this.mem } }).exports.conv;
      this.f32 = new Float32Array(this.mem.buffer);
      for (const L of Object.values(this.layout)) {
        this.f32.set(T[L.wn], L.w / 4);
        if (L.bn) this.f32.set(T[L.bn], L.b / 4);
        delete T[L.wn]; // 畳み込みの重みは WebAssembly のメモリにだけ置く（スマホでのメモリを半分に）
      }
      this.bytes = new Uint8Array(MAXN * MAXN + G.IN_EXTRA);
      this.ban = new Uint8Array(MAXN * MAXN);
      this.moves = new Int16Array(MAXN * MAXN + 1);
      this.pool = new Float32Array(2 * C); this.gh = new Float32Array(C); this.gv = new Float32Array(C);
      this.evals = 0;
    }

    _conv(name, inp, out, res, n, relu) {
      const L = this.layout[name];
      this.conv(inp, L.w, L.b, out, res, n, L.cin, L.cout, relu ? 1 : 0, L.taps === 9 ? 0 : 4, L.taps === 9 ? 9 : 5);
    }
    // 盤上の点だけの平均と最大（out[0..c) = 平均、out[c..2c) = 最大）
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
    // y = x・W + b（W は [cin][cout]）
    static dense(x, W, b, cin, cout, out, relu) {
      for (let j = 0; j < cout; j++) out[j] = b ? b[j] : 0;
      for (let i = 0; i < cin; i++) { const v = x[i]; if (!v) continue; const r = i * cout; for (let j = 0; j < cout; j++) out[j] += v * W[r + j]; }
      if (relu) for (let j = 0; j < cout; j++) if (out[j] < 0) out[j] = 0;
      return out;
    }

    // 入力のバイト（G.features の形）から計算する。sym = 対称の番号 0..7
    runBytes(bytes, n, sym = 0) {
      const C = this.C, H = this.H, T = this.T, f = this.f32, M = n + 2, NN = n * n;
      if (this.lastN !== n) {
        // 盤の大きさが変わったら、縁（0 のまま使う）を含めて消しておく
        f.fill(0, this.bufIn / 4, this.bufIn / 4 + MAXA * F);
        for (const b of [this.bufA, this.bufT, this.bufY]) f.fill(0, b / 4, b / 4 + MAXA * C);
        for (const b of [this.bufG, this.bufP, this.bufV]) f.fill(0, b / 4, b / 4 + MAXA * H);
        this.lastN = n;
      }
      // 点 i（y*n+x）の特徴を、対称で移した先の位置に書く
      const map = this.map && this.mapKey === n * 8 + sym ? this.map : this._map(n, sym);
      const g = bytes, komi = (g[NN + 2] - 128) / 30, p1 = g[NN], p2 = g[NN + 1];
      for (let i = 0; i < NN; i++) {
        const v = g[i], o = this.bufIn / 4 + map[i] * F;
        const stone = v & 3, libs = (v >> 2) & 3, ko = (v >> 4) & 1, rec = v >> 5;
        f[o] = stone === 1 ? 1 : 0; f[o + 1] = stone === 2 ? 1 : 0; f[o + 2] = stone === 0 ? 1 : 0;
        f[o + 3] = stone === 1 && libs === 1 ? 1 : 0; f[o + 4] = stone === 1 && libs === 2 ? 1 : 0; f[o + 5] = stone === 1 && libs === 3 ? 1 : 0;
        f[o + 6] = stone === 2 && libs === 1 ? 1 : 0; f[o + 7] = stone === 2 && libs === 2 ? 1 : 0; f[o + 8] = stone === 2 && libs === 3 ? 1 : 0;
        f[o + 9] = ko;
        for (let r = 1; r <= 5; r++) f[o + 9 + r] = rec === r ? 1 : 0;
        f[o + 15] = 1; f[o + 16] = komi; f[o + 17] = p1; f[o + 18] = p2;
      }
      // 胴体
      this._conv('stem.w', this.bufIn, this.bufA, 0, n, true);
      const A = this.bufA / 4, Y = this.bufY / 4;
      for (let b = 0; b < this.blocks; b++) {
        this._conv(`b${b}.w1`, this.bufA, this.bufT, 0, n, true);
        this._conv(`b${b}.w2`, this.bufT, this.bufY, 0, n, false);
        this._pool(this.bufY, n, C, this.pool);
        Net.dense(this.pool, T[`b${b}.g1w`], T[`b${b}.g1b`], 2 * C, C >> 1, this.gh, true);
        Net.dense(this.gh, T[`b${b}.g2w`], T[`b${b}.g2b`], C >> 1, C, this.gv, false);
        const gv = this.gv;
        for (let y = 1; y <= n; y++) for (let x = 1; x <= n; x++) {
          const o = (y * M + x) * C;
          for (let j = 0; j < C; j++) { const v = f[A + o + j] + f[Y + o + j] + gv[j]; f[A + o + j] = v > 0 ? v : 0; }
        }
      }
      // 方策
      this._conv('pol.wg', this.bufA, this.bufG, 0, n, true);
      const gp = new Float32Array(2 * H);
      this._pool(this.bufG, n, H, gp);
      const gb = Net.dense(gp, T['pol.gbw'], T['pol.b1'], 2 * H, H, new Float32Array(H), false);
      this._conv('pol.w1', this.bufA, this.bufP, 0, n, false);
      const logits = new Float32Array(NN + 1), w2 = T['pol.w2'], b2 = T['pol.b2'][0], P = this.bufP / 4;
      for (let i = 0; i < NN; i++) {
        const o = P + map[i] * H;
        let s = b2;
        for (let j = 0; j < H; j++) { const v = f[o + j] + gb[j]; if (v > 0) s += v * w2[j]; }
        logits[i] = s;
      }
      const ph = Net.dense(gp, T['pol.p1w'], T['pol.p1b'], 2 * H, H, new Float32Array(H), true);
      logits[NN] = Net.dense(ph, T['pol.p2w'], T['pol.p2b'], H, 1, new Float32Array(1), false)[0];
      // 価値・目数・地
      this._conv('val.w', this.bufA, this.bufV, 0, n, true);
      const own = new Float32Array(NN), ow = T['val.ownw'], ob = T['val.ownb'][0], V = this.bufV / 4;
      for (let i = 0; i < NN; i++) {
        const o = V + map[i] * H;
        let s = ob;
        for (let j = 0; j < H; j++) s += f[o + j] * ow[j];
        own[i] = Math.tanh(s);
      }
      const vp = new Float32Array(2 * H);
      this._pool(this.bufV, n, H, vp);
      const h = Net.dense(vp, T['val.d1w'], T['val.d1b'], 2 * H, 64, new Float32Array(64), true);
      const wl = Net.dense(h, T['val.wdlw'], T['val.wdlb'], 64, 3, new Float32Array(3), false);
      const mx = Math.max(wl[0], wl[1], wl[2]);
      const e0 = Math.exp(wl[0] - mx), e1 = Math.exp(wl[1] - mx), e2 = Math.exp(wl[2] - mx), es = e0 + e1 + e2;
      const wdl = [e0 / es, e1 / es, e2 / es];
      const score = Net.dense(h, T['val.scw'], T['val.scb'], 64, 1, new Float32Array(1), false)[0] * (this.W.scoreScale || 20);
      this.evals++;
      return { logits, wdl, value: wdl[2] - wdl[0], score, own };
    }
    _map(n, sym) {
      const M = n + 2, map = new Int16Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const [a, b] = symXY(sym, n, x, y); map[y * n + x] = (b + 1) * M + a + 1; }
      this.map = map; this.mapKey = n * 8 + sym;
      return map;
    }

    // 盤から計算する。moves（合法手の配列。なければここで作る）について方策の確率も返す
    run(board, sym = 0, moves = null) {
      const n = board.n, NN = n * n;
      let k;
      if (!moves) { k = board.legalMoves(this.moves, true, this.ban); moves = this.moves.subarray(0, k); G.features(board, this.bytes, 0, this.ban); }
      else G.features(board, this.bytes, 0, null);
      const out = this.runBytes(this.bytes, n, sym);
      const lg = out.logits, pol = new Float32Array(moves.length);
      let mx = -Infinity;
      for (let i = 0; i < moves.length; i++) { const v = lg[board.index(moves[i])]; pol[i] = v; if (v > mx) mx = v; }
      let s = 0;
      for (let i = 0; i < moves.length; i++) { pol[i] = Math.exp(pol[i] - mx); s += pol[i]; }
      for (let i = 0; i < moves.length; i++) pol[i] /= s;
      out.moves = Int16Array.from(moves); out.policy = pol;
      return out;
    }
  }

  G.Net = Net;
  G.symXY = symXY;
  return G;
}

if (typeof module !== 'undefined' && module.exports) module.exports = GoNN;
