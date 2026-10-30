/* 将棋の AI: 自己対局で学んだ小さなニューラルネットの評価 ＋ αβ探索
 * ブラウザ・Node・Web Worker のどこでも動く（ShogiCore(S) のあとに ShogiAI(S) を呼ぶ）
 *
 * 評価（NN）: 局面を「手番の側から見た」特徴と「相手から見た」特徴の2組にし、それぞれ
 *   特徴 → 隠れ層 H（足し算だけで差分更新）→ 2組を並べて 2H → 16 → 16 → 1
 *   と、特徴ごとの点数を足すだけの線形の部分（駒の価値のようなものを学ぶ）を足して評価値にする
 *   特徴: 駒×マス（2268）・持ち駒の枚数（76）・自玉から見た近くの駒の位置（1215）・敵玉から見た近くの駒の位置（1215）
 *   どの特徴がどれだけ良いかは何も教えていない（最初の世代は全部 0。自己対局の結果だけから学ぶ）
 * 探索: 反復深化・PVS・置換表（Web Worker どうしで共有して Lazy SMP）・静止探索・Null Move・LMR・枝刈り・千日手・入玉宣言
 */
function ShogiAI(S) {
  'use strict';
  const { Position, BLACK, WHITE, FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, UM, RY, DECLARE, MAXPLY, RAY, RAYLEN, KNT, STEP, SLIDE } = S;
  const MATE = 30000, MATE_IN_MAX = MATE - 1000, WIN_REP = 25000, INF = 32000, NOREP = 99999;
  const isMate = s => Math.abs(s) >= MATE_IN_MAX;
  const EVAL_SCALE = 600; // 勝率 = 1 / (1 + e^(−評価値/600))
  const winRate = s => (isMate(s) ? (s > 0 ? 1 : 0) : 1 / (1 + Math.exp(-s / EVAL_SCALE)));

  // ------------------------------------------------------------------ NN の特徴
  const KIND = new Int8Array(16).fill(-1);
  [FU, KY, KE, GI, KI, KA, HI, TO, NY, NK, NG, UM, RY].forEach((t, i) => { KIND[t] = i; });
  const A_KING_F = 26 * 81, A_KING_E = A_KING_F + 81, HAND0 = A_KING_E + 81;          // 2106, 2187, 2268
  const HOFS = [0, 0, 18, 22, 26, 30, 34, 36], HMAX = [0, 18, 4, 4, 4, 4, 2, 2], HPER = 38;
  const C0 = HAND0 + 2 * HPER, REL = 45, CK = 27 * REL, D0 = C0 + CK, NF = D0 + CK;      // 2344, 3559, 4774
  const WIN = 4; // 玉から見た近くの範囲（縦横 ±4）

  // 視点 p から見た、マス sq の駒 q の特徴（最大3つ）を out[n..] に書く。fk・ek は視点から見た自玉・敵玉のマス（盤を回したあと）
  function pieceFeat(p, q, sq, fk, ek, out, n) {
    const t = q & 15, own = (q >> 4) === p, s = p ? 80 - sq : sq, x = s % 9, y = (s / 9) | 0;
    if (t === OU) {
      if (own) {
        out[n++] = A_KING_F + s;
        if (ek >= 0) { const dx = Math.abs(x - (ek % 9)), dy = y - ((ek / 9) | 0); if (dx <= WIN && dy >= -WIN && dy <= WIN) out[n++] = D0 + 26 * REL + dx * 9 + dy + WIN; }
      } else {
        out[n++] = A_KING_E + s;
        if (fk >= 0) { const dx = Math.abs(x - (fk % 9)), dy = y - ((fk / 9) | 0); if (dx <= WIN && dy >= -WIN && dy <= WIN) out[n++] = C0 + 26 * REL + dx * 9 + dy + WIN; }
      }
      return n;
    }
    const pk = (own ? 0 : 13) + KIND[t];
    out[n++] = pk * 81 + s;
    if (fk >= 0) { const dx = Math.abs(x - (fk % 9)), dy = y - ((fk / 9) | 0); if (dx <= WIN && dy >= -WIN && dy <= WIN) out[n++] = C0 + pk * REL + dx * 9 + dy + WIN; }
    if (ek >= 0) { const dx = Math.abs(x - (ek % 9)), dy = y - ((ek / 9) | 0); if (dx <= WIN && dy >= -WIN && dy <= WIN) out[n++] = D0 + pk * REL + dx * 9 + dy + WIN; }
    return n;
  }
  const handFeat = (p, c, t, n) => HAND0 + (c === p ? 0 : HPER) + HOFS[t] + n - 1;
  const orient = (p, sq) => (sq < 0 ? -1 : p ? 80 - sq : sq);
  // 局面の特徴をすべて（視点 p）
  function features(pos, p, out) {
    const b = pos.board, fk = orient(p, pos.king[p]), ek = orient(p, pos.king[p ^ 1]);
    let n = 0;
    for (let sq = 0; sq < 81; sq++) { const q = b[sq]; if (q) n = pieceFeat(p, q, sq, fk, ek, out, n); }
    for (let c = 0; c < 2; c++) for (let t = 1; t <= 7; t++) { const k = pos.hand[c * 8 + t]; for (let j = 1; j <= k; j++) out[n++] = handFeat(p, c, t, j); }
    return n;
  }

  // ------------------------------------------------------------------ NN の重み
  const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const i16 = s => { const u = b64(s); return new Int16Array(u.buffer, u.byteOffset, u.byteLength >> 1); };
  // format 2: 最初の層は1バイトずつ。-128 は「別の列（w1x）の次の int16」の印（値は format 1 とまったく同じ。大きさは約半分）
  const w1of = W => {
    if (!W.w1q) return i16(W.w1);
    const u = b64(W.w1q), x = i16(W.w1x), w = new Int16Array(u.length);
    for (let i = 0, j = 0; i < u.length; i++) w[i] = u[i] === 128 ? x[j++] : (u[i] << 24) >> 24;
    return w;
  };
  class Net {
    // W: weights.js の SHOGI_WEIGHTS（なければ全部 0 = 何も知らない第0世代）
    constructor(W) {
      this.zero = !W || !(W.w1 || W.w1q);
      this.H = W && W.H ? W.H : 64; this.L2 = W && W.L2 ? W.L2 : 16; this.L3 = W && W.L3 ? W.L3 : 16;
      this.gen = W ? W.gen || 0 : 0;
      const H = this.H, L2 = this.L2, L3 = this.L3;
      if (this.zero) {
        this.w1 = new Int16Array(NF * H); this.p1 = new Int16Array(NF); this.b1 = new Int16Array(H);
        this.w2 = new Float32Array(2 * H * L2); this.b2 = new Float32Array(L2); this.w3 = new Float32Array(L2 * L3); this.b3 = new Float32Array(L3); this.w4 = new Float32Array(L3); this.b4 = 0;
      } else {
        this.w1 = w1of(W); this.p1 = i16(W.p1); this.b1 = Int16Array.from(W.b1);
        this.w2 = Float32Array.from(W.w2); this.b2 = Float32Array.from(W.b2); this.w3 = Float32Array.from(W.w3); this.b3 = Float32Array.from(W.b3); this.w4 = Float32Array.from(W.w4); this.b4 = +W.b4 || 0;
      }
      // 探索の手の並べ替え・枝刈りに使う駒の価値も、学んだ線形の部分から取り出す（人が決めた駒の価値は使わない）
      this.val = new Int32Array(16); this.hval = new Int32Array(8);
      if (!this.zero) {
        for (let t = 1; t < 16; t++) {
          if (KIND[t] < 0) continue;
          let s = 0;
          for (let sq = 0; sq < 81; sq++) s += this.p1[KIND[t] * 81 + sq] - this.p1[(13 + KIND[t]) * 81 + (80 - sq)];
          this.val[t] = Math.max(1, Math.round(s / 81 / 2));
        }
        for (let t = 1; t <= 7; t++) this.hval[t] = Math.max(1, Math.round((this.p1[handFeat(0, 0, t, 1)] - this.p1[handFeat(0, 1, t, 1)]) / 2));
      } else { this.val.fill(1); this.hval.fill(1); }
      this.val[OU] = 30000;
    }
  }

  // ------------------------------------------------------------------ WebAssembly SIMD（8つずつまとめて計算する。使えないブラウザでは JS で同じ計算）
  // 手で組み立てた小さなモジュール（外のツールは使わない）。関数は3つ:
  //   add(dst, src, n) / sub(dst, src, n): int16 の行を n 個ぶん足す・引く（アキュムレータの差分更新）
  //   dense(accS, accO, w2t, out, scr, H, L2): 隠れ層を 0〜127 に切って、2層目の重み（int16）との内積を out（int32）へ
  // 値はすべてバイトの位置（16の倍数）
  function simdBytes() {
    const leb = v => { const o = []; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
    const sleb = v => { const o = []; for (;;) { const b = v & 0x7f; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } };
    const vec = items => [...leb(items.length), ...items.flat()];
    const sec = (id, body) => [id, ...leb(body.length), ...body];
    const str = s => [...leb(s.length), ...Array.from(s, ch => ch.charCodeAt(0))];
    const V = (op, ...imm) => [0xfd, ...leb(op), ...imm];
    const MA = [4, 0];                                   // 16バイト境界・オフセット 0
    const lg = i => [0x20, i], ls = i => [0x21, i], ic = v => [0x41, ...sleb(v)];
    const ADD = 0x6a, SHL = 0x74, LTU = 0x49, BRIF = [0x0d, 0], LOOP = [0x03, 0x40], END = 0x0b;
    const LOAD = V(0x00, ...MA), STORE = V(0x0b, ...MA);
    const rowOp = op => [
      ...lg(2), ...ic(1), SHL, ...ls(4),                  // end = n * 2（バイト）
      ...LOOP,
      ...lg(0), ...lg(3), ADD,
      ...lg(0), ...lg(3), ADD, ...LOAD,
      ...lg(1), ...lg(3), ADD, ...LOAD,
      ...V(op), ...STORE,
      ...lg(3), ...ic(16), ADD, ...ls(3),
      ...lg(3), ...lg(4), LTU, ...BRIF,
      END, END];
    const clampStore = (dstExpr, srcLocal) => [...dstExpr, ...lg(srcLocal), ...lg(7), ADD, ...LOAD, ...lg(12), ...V(0x98), ...lg(13), ...V(0x96), ...STORE];
    const dense = [
      ...ic(0), ...V(0x10), ...ls(12),                    // zero（i16x8.splat 0）
      ...ic(127), ...V(0x10), ...ls(13),                  // 127
      ...lg(5), ...ic(1), SHL, ...ls(8),                  // end = H * 2
      ...LOOP,
      ...clampStore([...lg(4), ...lg(7), ADD], 0),        // scr[i] = clamp(accS[i])
      ...clampStore([...lg(4), ...lg(8), ADD, ...lg(7), ADD], 1), // scr[end + i] = clamp(accO[i])
      ...lg(7), ...ic(16), ADD, ...ls(7),
      ...lg(7), ...lg(8), LTU, ...BRIF,
      END,
      ...lg(8), ...ic(1), SHL, ...ls(8),                  // end2 = 2H * 2
      ...lg(2), ...ls(10),                                // wrow = w2t
      ...LOOP,                                            // j の繰り返し
      ...lg(12), ...ls(11), ...ic(0), ...ls(7),
      ...LOOP,
      ...lg(11),
      ...lg(4), ...lg(7), ADD, ...LOAD,
      ...lg(10), ...lg(7), ADD, ...LOAD,
      ...V(0xba), ...V(0xae), ...ls(11),                  // acc += dot_i16x8(x, w)
      ...lg(7), ...ic(16), ADD, ...ls(7),
      ...lg(7), ...lg(8), LTU, ...BRIF,
      END,
      ...lg(3), ...lg(9), ...ic(2), SHL, ADD,             // out + j * 4
      ...lg(11), ...V(0x1b, 0), ...lg(11), ...V(0x1b, 1), ADD, ...lg(11), ...V(0x1b, 2), ADD, ...lg(11), ...V(0x1b, 3), ADD,
      0x36, 2, 0,                                         // i32.store
      ...lg(10), ...lg(8), ADD, ...ls(10),
      ...lg(9), ...ic(1), ADD, ...ls(9),
      ...lg(9), ...lg(6), LTU, ...BRIF,
      END, END];
    const I32 = 0x7f, V128 = 0x7b;
    const body = (locals, code) => { const b = [...vec(locals), ...code]; return [...leb(b.length), ...b]; };
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
      ...sec(1, vec([[0x60, ...vec([[I32], [I32], [I32]]), 0], [0x60, ...vec([[I32], [I32], [I32], [I32], [I32], [I32], [I32]]), 0]])),
      ...sec(2, vec([[...str('e'), ...str('m'), 0x02, 0x00, 1]])),
      ...sec(3, vec([[0], [0], [1]])),
      ...sec(7, vec([[...str('add'), 0, 0], [...str('sub'), 0, 1], [...str('dense'), 0, 2]])),
      ...sec(10, vec([body([[2, I32]], rowOp(0x8e)), body([[2, I32]], rowOp(0x91)), body([[4, I32], [3, V128]], dense)])),
    ]);
  }
  let simdMod;
  function simdModule() {
    if (simdMod !== undefined) return simdMod;
    simdMod = null;
    try {
      const b = simdBytes();
      if (typeof WebAssembly === 'object' && WebAssembly.validate(b)) simdMod = new WebAssembly.Module(b);
    } catch (e) { simdMod = null; }
    return simdMod;
  }
  const a16 = n => (n + 15) & ~15;

  // 局面ごとの隠れ層（アキュムレータ）。指すたびに変わった特徴の分だけ足し引きする。玉が動いたら作り直す
  // simd: 使えるなら WebAssembly SIMD（アキュムレータは int16。第64世代で値は ±4000 ほどで、int16 に十分収まる）
  class Evaluator {
    constructor(net, opts = {}) {
      this.net = net;
      const H = net.H, L2 = net.L2;
      this.wasm = null;
      const mod = opts.simd !== false && !net.zero && H % 8 === 0 ? simdModule() : null;
      if (mod) {
        this.oW1 = 0;
        this.oAcc = a16(NF * H * 2);
        this.oW2 = this.oAcc + a16((MAXPLY + 1) * 2 * H * 2);
        this.oScr = this.oW2 + a16(L2 * 2 * H * 2);
        this.oOut = this.oScr + a16(4 * H);
        const pages = Math.ceil((this.oOut + L2 * 4 + 64) / 65536);
        const mem = new WebAssembly.Memory({ initial: pages });
        this.wasm = new WebAssembly.Instance(mod, { e: { m: mem } }).exports;
        new Int16Array(mem.buffer, this.oW1, NF * H).set(net.w1);
        // 2層目の重みは int16 にして、出口ごとに並べ直す（w2t[j][i]）。倍率は一番大きい重みが 32767 になるように
        // （127 × 32767 × 512 < 2^31 なので、H = 256 でも内積は int32 からあふれない）
        let wmax = 1e-9;
        for (let i = 0; i < net.w2.length; i++) wmax = Math.max(wmax, Math.abs(net.w2[i]));
        this.w2scale = Math.min(65536, 32767 / wmax);
        const w2t = new Int16Array(mem.buffer, this.oW2, L2 * 2 * H);
        for (let i = 0; i < 2 * H; i++) for (let j = 0; j < L2; j++) w2t[j * 2 * H + i] = Math.max(-32767, Math.min(32767, Math.round(net.w2[i * L2 + j] * this.w2scale)));
        this.accH = new Int16Array(mem.buffer, this.oAcc, (MAXPLY + 1) * 2 * H);
        this.out = new Int32Array(mem.buffer, this.oOut, L2);
      } else this.accH = new Int32Array((MAXPLY + 1) * 2 * H);
      this.accP = new Int32Array((MAXPLY + 1) * 2);
      this.dirty = new Uint8Array(MAXPLY + 1).fill(1);
      this.f = new Int32Array(8);
      this.buf = new Int32Array(320);
      this.h1 = new Float64Array(net.L2); this.h2 = new Float64Array(net.L3);
    }
    reset(pos) { this.dirty[pos.ply] = 1; }
    add(i, p, f) {
      const H = this.net.H;
      if (this.wasm) this.wasm.add(this.oAcc + (i * 2 + p) * H * 2, this.oW1 + f * H * 2, H);
      else { const w = this.net.w1, a = this.accH, o = (i * 2 + p) * H, r = f * H; for (let k = 0; k < H; k++) a[o + k] += w[r + k]; }
      this.accP[i * 2 + p] += this.net.p1[f];
    }
    sub(i, p, f) {
      const H = this.net.H;
      if (this.wasm) this.wasm.sub(this.oAcc + (i * 2 + p) * H * 2, this.oW1 + f * H * 2, H);
      else { const w = this.net.w1, a = this.accH, o = (i * 2 + p) * H, r = f * H; for (let k = 0; k < H; k++) a[o + k] -= w[r + k]; }
      this.accP[i * 2 + p] -= this.net.p1[f];
    }
    refresh(pos) {
      const i = pos.ply, H = this.net.H, b1 = this.net.b1;
      for (let p = 0; p < 2; p++) {
        const o = (i * 2 + p) * H;
        for (let k = 0; k < H; k++) this.accH[o + k] = b1[k];
        this.accP[i * 2 + p] = 0;
        const n = features(pos, p, this.buf);
        for (let j = 0; j < n; j++) this.add(i, p, this.buf[j]);
      }
      this.dirty[i] = 0;
    }
    // pos.make（または makeNull）の直後に呼ぶ
    push(pos) {
      const i = pos.ply, m = pos.mvS[i - 1];
      if (this.net.zero || this.dirty[i - 1]) { this.dirty[i] = 1; return; }
      const H = this.net.H;
      this.accH.copyWithin(i * 2 * H, (i - 1) * 2 * H, i * 2 * H);
      this.accP[i * 2] = this.accP[i * 2 - 2]; this.accP[i * 2 + 1] = this.accP[i * 2 - 1];
      this.dirty[i] = 0;
      if (m === 0) return;
      const pc = pos.pcS[i - 1], to = m & 127, from = (m >> 7) & 127, c = pc >> 4, f = this.f, b = pos.board, cap = pos.capS[i - 1];
      if ((pc & 15) === OU) { this.kingMoved(pos, i, c, pc, from, to, cap); return; }
      for (let p = 0; p < 2; p++) {
        const fk = orient(p, pos.king[p]), ek = orient(p, pos.king[p ^ 1]);
        let n;
        if (from > 80) {
          const t = from - 81;
          this.sub(i, p, handFeat(p, c, t, pos.hand[c * 8 + t] + 1));
          n = pieceFeat(p, pc, to, fk, ek, f, 0);
          for (let j = 0; j < n; j++) this.add(i, p, f[j]);
        } else {
          n = pieceFeat(p, pc, from, fk, ek, f, 0);
          for (let j = 0; j < n; j++) this.sub(i, p, f[j]);
          n = pieceFeat(p, b[to], to, fk, ek, f, 0);
          for (let j = 0; j < n; j++) this.add(i, p, f[j]);
          if (cap) {
            n = pieceFeat(p, cap, to, fk, ek, f, 0);
            for (let j = 0; j < n; j++) this.sub(i, p, f[j]);
            const ut = (cap & 15) > 8 ? (cap & 15) - 8 : cap & 15;
            this.add(i, p, handFeat(p, c, ut, pos.hand[c * 8 + ut]));
          }
        }
      }
    }
    // 玉が動いたとき: 玉そのものの特徴と、ほかの駒の「動いた玉から見た位置」だけを入れ替える
    kingMoved(pos, i, c, pc, from, to, cap) {
      const f = this.f, b = pos.board;
      for (let p = 0; p < 2; p++) {
        const mine = p === c;
        const ko = orient(p, from), kn = orient(p, to), other = orient(p, pos.king[c ^ 1]);
        const fkO = mine ? ko : other, ekO = mine ? other : ko, fkN = mine ? kn : other, ekN = mine ? other : kn;
        let n;
        if (cap) {
          n = pieceFeat(p, cap, to, fkO, ekO, f, 0);
          for (let j = 0; j < n; j++) this.sub(i, p, f[j]);
          const ut = (cap & 15) > 8 ? (cap & 15) - 8 : cap & 15;
          this.add(i, p, handFeat(p, c, ut, pos.hand[c * 8 + ut]));
        }
        n = pieceFeat(p, pc, from, fkO, ekO, f, 0);
        for (let j = 0; j < n; j++) this.sub(i, p, f[j]);
        n = pieceFeat(p, pc, to, fkN, ekN, f, 0);
        for (let j = 0; j < n; j++) this.add(i, p, f[j]);
        // ほかの駒: 自玉が動いたなら「自玉から見た位置」、敵玉が動いたなら「敵玉から見た位置」が変わる
        const base = mine ? C0 : D0, ox = ko % 9, oy = (ko / 9) | 0, nx = kn % 9, ny = (kn / 9) | 0;
        for (let sq = 0; sq < 81; sq++) {
          const q = b[sq];
          if (!q || sq === to) continue;
          const t = q & 15, own = (q >> 4) === p;
          let kind;
          if (t === OU) kind = 26; else kind = (own ? 0 : 13) + KIND[t];
          const s2 = p ? 80 - sq : sq, x = s2 % 9, y = (s2 / 9) | 0;
          let dx = Math.abs(x - ox), dy = y - oy;
          if (dx <= WIN && dy >= -WIN && dy <= WIN) this.sub(i, p, base + kind * REL + dx * 9 + dy + WIN);
          dx = Math.abs(x - nx); dy = y - ny;
          if (dx <= WIN && dy >= -WIN && dy <= WIN) this.add(i, p, base + kind * REL + dx * 9 + dy + WIN);
        }
      }
    }
    // 手番の側から見た評価値（600 で勝率 約73%）
    evaluate(pos) {
      const net = this.net;
      if (net.zero) return 0;
      const i = pos.ply;
      if (this.dirty[i]) this.refresh(pos);
      const H = net.H, L2 = net.L2, L3 = net.L3, a = this.accH, w2 = net.w2, h1 = this.h1, h2 = this.h2;
      const s = pos.stm, oS = (i * 2 + s) * H, oO = (i * 2 + (s ^ 1)) * H;
      if (this.wasm) {
        this.wasm.dense(this.oAcc + oS * 2, this.oAcc + oO * 2, this.oW2, this.oOut, this.oScr, H, L2);
        const out = this.out, sc = 1 / (127 * this.w2scale);
        for (let j = 0; j < L2; j++) h1[j] = out[j] * sc + net.b2[j];
      } else {
      for (let j = 0; j < L2; j++) h1[j] = net.b2[j];
      for (let k = 0; k < H; k++) {
        let v = a[oS + k];
        if (v <= 0) continue;
        if (v > 127) v = 127;
        v *= 1 / 127;
        const r = k * L2;
        for (let j = 0; j < L2; j++) h1[j] += v * w2[r + j];
      }
      for (let k = 0; k < H; k++) {
        let v = a[oO + k];
        if (v <= 0) continue;
        if (v > 127) v = 127;
        v *= 1 / 127;
        const r = (H + k) * L2;
        for (let j = 0; j < L2; j++) h1[j] += v * w2[r + j];
      }
      }
      for (let j = 0; j < L2; j++) h1[j] = h1[j] < 0 ? 0 : h1[j] > 1 ? 1 : h1[j];
      const w3 = net.w3;
      for (let j = 0; j < L3; j++) h2[j] = net.b3[j];
      for (let k = 0; k < L2; k++) { const v = h1[k]; if (!v) continue; const r = k * L3; for (let j = 0; j < L3; j++) h2[j] += v * w3[r + j]; }
      let out = net.b4;
      for (let j = 0; j < L3; j++) { const v = h2[j] < 0 ? 0 : h2[j] > 1 ? 1 : h2[j]; out += v * net.w4[j]; }
      const v = Math.round(out * EVAL_SCALE + (this.accP[i * 2 + s] - this.accP[i * 2 + (s ^ 1)]) / 2) | 0;
      return v > 20000 ? 20000 : v < -20000 ? -20000 : v;
    }
  }

  // ------------------------------------------------------------------ 置換表（Lazy SMP では SharedArrayBuffer で共有）
  // 1件 = 4つの int32: [k1 ^ w2 ^ w3（壊れた書き込みを見分ける）, k2, 手16bit|深さ+16 8bit|種類2bit|世代6bit, 評価値16bit|静的評価16bit]
  function makeTT(bits, shared) {
    const bytes = (1 << bits) * 16;
    return shared && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  }
  const BOUND_UPPER = 1, BOUND_LOWER = 2, BOUND_EXACT = 3;

  const MAXSP = 96, MAXMOVES = 640;
  const LMR = [];
  for (let d = 0; d < 64; d++) { LMR.push(new Int8Array(MAXMOVES)); for (let i = 1; i < MAXMOVES; i++) LMR[d][i] = d < 3 || i < 3 ? 0 : Math.floor(0.6 + Math.log(d) * Math.log(i) / 2.1); }

  class Searcher {
    constructor(net, opts = {}) {
      this.net = net instanceof Net ? net : new Net(net);
      this.ev = new Evaluator(this.net, { simd: opts.simd });
      const buf = opts.sharedTT || makeTT(opts.ttBits || 18, false);
      this.tt = new Int32Array(buf);
      this.ttMask = ((this.tt.length >> 2) - 1) & ~1;
      this.stopFlag = opts.stopFlag ? new Int32Array(opts.stopFlag) : null;
      this.helper = opts.helper || 0;
      this.moves = new Int32Array(MAXSP * MAXMOVES);
      this.mscore = new Int32Array(MAXSP * MAXMOVES);
      this.killers = new Int32Array(MAXSP * 2);
      this.hist = new Int32Array(2 * 89 * 81);
      this.pvT = new Int32Array(MAXSP * MAXSP);
      this.pvLen = new Int32Array(MAXSP);
      this.evS = new Int32Array(MAXSP);
      this.tried = new Int32Array(MAXSP * 64);
      this.tb = new Int32Array(2);           // 置換表から読んだ2語
      this.noise = 0; this.salt = 0; this.age = 0;
      this.useMate1 = opts.mate1 != null ? !!opts.mate1 : false; // 1手詰めの確かめ（読みの端）。速さと引き換えなので対戦で確かめてから
      this.nodes = 0; this.stopped = false;
      this.pos = null; this.jobId = 0; this.nodeLimit = 0; this.rootDepth = 1;
      this.deadline = Date.now() + 0.5;      // 小数の欄として作る（あとで型が変わると V8 の最適化が外れる）
    }
    clearTT() { this.tt.fill(0); this.hist.fill(0); }

    // ---------------------------------------------------------------- 置換表
    probe() {
      const pos = this.pos, k1 = pos.h1, k2 = pos.h2, tt = this.tt;
      let i = ((k2 ^ (k1 >>> 11)) & this.ttMask) << 2;
      for (let w = 0; w < 2; w++, i += 4) {
        const a = tt[i + 2], b = tt[i + 3];
        if (tt[i + 1] === k2 && (tt[i] ^ a ^ b) === k1) { this.tb[0] = a; this.tb[1] = b; return true; }
      }
      return false;
    }
    store(move, depth, bound, score, ev, sp) {
      const pos = this.pos, k1 = pos.h1, k2 = pos.h2, tt = this.tt;
      if (score >= MATE_IN_MAX) score += sp; else if (score <= -MATE_IN_MAX) score -= sp;
      const base = ((k2 ^ (k1 >>> 11)) & this.ttMask) << 2;
      let i = base;
      const d0 = (tt[base + 2] >>> 16) & 255, d1 = (tt[base + 6] >>> 16) & 255;
      if (tt[base + 1] === k2 && (tt[base] ^ tt[base + 2] ^ tt[base + 3]) === k1) i = base;
      else if (tt[base + 5] === k2 && (tt[base + 4] ^ tt[base + 6] ^ tt[base + 7]) === k1) i = base + 4;
      else {
        const a0 = (tt[base + 2] >>> 26) & 63, a1 = (tt[base + 6] >>> 26) & 63, age = this.age & 63;
        const s0 = d0 - (a0 === age ? 0 : 64), s1 = d1 - (a1 === age ? 0 : 64);
        i = s0 <= s1 ? base : base + 4;
      }
      // 同じ局面で手がないときは、前の手を残す
      if (!move && tt[i + 1] === k2) move = tt[i + 2] & 0xFFFF;
      const a = (move & 0xFFFF) | (((depth + 16) & 255) << 16) | (bound << 24) | ((this.age & 63) << 26);
      const b = (score & 0xFFFF) | (ev << 16);
      tt[i + 2] = a; tt[i + 3] = b; tt[i + 1] = k2; tt[i] = k1 ^ a ^ b;
    }

    checkStop() {
      if (this.stopFlag && Atomics.load(this.stopFlag, 0) !== this.jobId) this.stopped = true;
      else if (this.nodeLimit && this.nodes >= this.nodeLimit) this.stopped = true;
      else if (Date.now() >= this.deadline) this.stopped = true;
    }

    evaluate() {
      let v = this.ev.evaluate(this.pos);
      if (this.noise) {
        let h = Math.imul(this.pos.h1 ^ this.salt, 0x9E3779B1) ^ this.pos.h2;
        h = Math.imul(h ^ (h >>> 15), 0x85EBCA77);
        v += ((h >>> 8) % (2 * this.noise + 1)) - this.noise;
      }
      return v;
    }

    // 千日手（探索中は2回目で判定）。王手をかけ続けた側の負け、それ以外は引き分け
    repScore() {
      const pos = this.pos, i = pos.ply, k1 = pos.k1S[i], k2 = pos.k2S[i], lim = Math.max(0, i - 40);
      for (let j = i - 2; j >= lim; j -= 2) {
        if (pos.mvS[j] === 0 || pos.mvS[j + 1] === 0) return NOREP;
        if (j === i - 2) continue;
        if (pos.k1S[j] === k1 && pos.k2S[j] === k2) {
          let meAll = true, oppAll = true;
          for (let q = j; q < i; q++) {
            const chk = pos.chkS[q + 1];
            if (((i - q) & 1) === 0) { if (!chk) meAll = false; } else if (!chk) oppAll = false;
          }
          if (oppAll && !meAll) return WIN_REP;
          if (meAll && !oppAll) return -WIN_REP;
          return 0;
        }
      }
      return NOREP;
    }
    declareWin() {
      const pos = this.pos, c = pos.stm, k = pos.king[c];
      if (k < 0 || !S.inZone(c, (k / 9) | 0)) return false;
      return pos.declareInfo(c).ok;
    }

    // 指して、自玉が取られる手なら戻す
    makeLegal(m) {
      const pos = this.pos, c = pos.stm;
      if (this.ev.dirty[pos.ply] && !this.net.zero) this.ev.refresh(pos); // 親の隠れ層を先に作っておく（子は差分で済む）
      pos.make(m);
      if (pos.attacked(pos.king[c], c ^ 1)) { pos.unmake(); return false; }
      this.ev.push(pos);
      return true;
    }

    // 手の並べ替えの点数: 置換表の手 → 取る手（取る駒が高く、取る駒が安いほど先）→ 成る手 → キラー → 履歴
    scoreMoves(base, n, ttMove, sp) {
      const pos = this.pos, b = pos.board, val = this.net.val, c = pos.stm, k0 = this.killers[sp * 2], k1 = this.killers[sp * 2 + 1];
      const hb = c * 89 * 81;
      for (let i = base; i < base + n; i++) {
        const m = this.moves[i];
        if (m === ttMove) { this.mscore[i] = 1 << 30; continue; }
        const to = m & 127, from = (m >> 7) & 127;
        let s;
        if (from <= 80 && b[to]) s = (1 << 28) + val[b[to] & 15] * 16 - (val[b[from] & 15] >> 4) + ((m >> 14) & 1 ? 64 : 0);
        else if ((m >> 14) & 1) s = (1 << 27) + val[(b[from] & 15) + 8] - val[b[from] & 15];
        else if (m === k0) s = (1 << 26) + 2;
        else if (m === k1) s = (1 << 26) + 1;
        else s = this.hist[hb + from * 81 + to];
        this.mscore[i] = s;
      }
    }
    pick(i, end) {
      let bi = i, bs = this.mscore[i];
      for (let j = i + 1; j < end; j++) if (this.mscore[j] > bs) { bs = this.mscore[j]; bi = j; }
      if (bi !== i) {
        const m = this.moves[i]; this.moves[i] = this.moves[bi]; this.moves[bi] = m;
        const s = this.mscore[i]; this.mscore[i] = this.mscore[bi]; this.mscore[bi] = s;
      }
      return this.moves[i];
    }
    histUpdate(c, m, bonus) {
      const idx = c * 89 * 81 + ((m >> 7) & 127) * 81 + (m & 127), h = this.hist;
      h[idx] += bonus - (h[idx] * Math.abs(bonus)) / 16384;
    }

    // ---------------------------------------------------------------- 静止探索（取る手だけ。王手されていれば全部）
    qsearch(alpha, beta, sp, qd) {
      alpha |= 0; beta |= 0; // −0 を避ける（V8 が最適化をやめてしまう）
      const pos = this.pos;
      this.pvLen[sp] = sp;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stopped) return 0;
      const inCheck = pos.chkS[pos.ply] === 1;
      if (sp >= MAXSP - 2) return inCheck ? 0 : this.evaluate();
      if (inCheck) { const r = this.repScore(); if (r !== NOREP) return r; }
      let best, stand = -INF;
      const base = sp * MAXMOVES;
      let n;
      if (inCheck) {
        best = -MATE + sp;
        n = pos.genBoard(this.moves, base, 2, false) - base;
        n = pos.genDrops(this.moves, base + n) - base;
      } else {
        // 読みの端で、手番の側に1手詰めがあれば勝ち
        if (qd === 0 && this.useMate1 && pos.mate1()) return MATE - sp - 1;
        stand = this.evaluate();
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
        if (qd > 12) return stand;
        n = pos.genBoard(this.moves, base, 1, false) - base;
      }
      this.scoreMoves(base, n, 0, sp);
      const b = pos.board, val = this.net.val, them = pos.stm ^ 1;
      let legal = 0;
      for (let i = base; i < base + n; i++) {
        const m = this.pick(i, base + n);
        if (!inCheck) {
          const to = m & 127, from = (m >> 7) & 127, vv = val[b[to] & 15], va = val[b[from] & 15];
          // 取っても届かない・損な取り合いは読まない
          if (stand + vv * 2 + 200 < alpha && !((m >> 14) & 1)) continue;
          if (va > vv && pos.attacked(to, them)) continue;
        }
        if (!this.makeLegal(m)) continue;
        legal++;
        const v = 0 - this.qsearch(0 - beta, 0 - alpha, sp + 1, qd + 1);
        pos.unmake();
        if (this.stopped) return 0;
        if (v > best) {
          best = v;
          if (v > alpha) {
            alpha = v;
            this.pvT[sp * MAXSP + sp] = m;
            for (let j = sp + 1; j < this.pvLen[sp + 1]; j++) this.pvT[sp * MAXSP + j] = this.pvT[(sp + 1) * MAXSP + j];
            this.pvLen[sp] = this.pvLen[sp + 1];
            if (v >= beta) break;
          }
        }
      }
      if (inCheck && !legal) return -MATE + sp;
      return best;
    }

    // ---------------------------------------------------------------- αβ探索
    search(depth, alpha, beta, sp, nullOk) {
      alpha |= 0; beta |= 0;
      const pos = this.pos;
      if (depth <= 0) return this.qsearch(alpha, beta, sp, 0);
      this.pvLen[sp] = sp;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stopped) return 0;
      const pvNode = beta - alpha > 1, inCheck = pos.chkS[pos.ply] === 1;
      if (sp >= MAXSP - 2) return inCheck ? 0 : this.evaluate();
      if (sp > 0) {
        const r = this.repScore();
        if (r !== NOREP) return r;
        const ma = -MATE + sp, mb = MATE - sp - 1;
        if (alpha < ma) alpha = ma;
        if (beta > mb) beta = mb;
        if (alpha >= beta) return alpha;
      }
      if (!inCheck && this.declareWin()) return MATE - sp - 1;
      // 置換表
      let ttMove = 0, ttEval = -INF;
      if (this.probe()) {
        const a = this.tb[0], bv = this.tb[1];
        ttMove = a & 0xFFFF;
        const td = ((a >>> 16) & 255) - 16, bound = (a >>> 24) & 3;
        let ts = (bv << 16) >> 16;
        if (ts >= MATE_IN_MAX) ts -= sp; else if (ts <= -MATE_IN_MAX) ts += sp;
        ttEval = bv >> 16;
        if (!pvNode && td >= depth && (bound === BOUND_EXACT || (bound === BOUND_LOWER && ts >= beta) || (bound === BOUND_UPPER && ts <= alpha))) return ts;
      }
      let ev;
      if (inCheck) ev = -INF;
      else {
        ev = ttEval > -INF && ttEval !== 0 ? ttEval : this.evaluate();
        if (ttEval === -INF) this.store(0, -16, 0, 0, ev, sp);
      }
      this.evS[sp] = ev;
      const improving = !inCheck && sp >= 2 && ev > this.evS[sp - 2];
      if (!pvNode && !inCheck && !isMate(beta)) {
        // 静的評価が十分高い（浅い読みで逆転されそうにない）
        if (depth <= 6 && ev - (improving ? 90 : 120) * depth >= beta) return ev;
        // Null Move（パスしても β を超えるなら切る）
        if (nullOk && depth >= 3 && ev >= beta) {
          const R = 3 + (depth >> 2) + Math.min(2, Math.max(0, ((ev - beta) / 300) | 0));
          pos.makeNull(); this.ev.push(pos);
          const v = 0 - this.search(depth - 1 - R, 0 - beta, 1 - beta, sp + 1, false);
          pos.unmakeNull();
          if (this.stopped) return 0;
          if (v >= beta) return isMate(v) ? beta : v;
        }
      }
      // 置換表に手がない深い局面は、少し浅く読んで手を見つける
      if (pvNode && !ttMove && depth >= 6) {
        this.search(depth - 2, alpha, beta, sp, true);
        if (this.stopped) return 0;
        if (this.probe()) ttMove = this.tb[0] & 0xFFFF;
      }
      const base = sp * MAXMOVES;
      let n = pos.genBoard(this.moves, base, 2, false) - base;
      n = pos.genDrops(this.moves, base + n) - base;
      this.scoreMoves(base, n, ttMove, sp);
      const c = pos.stm, b = pos.board;
      let best = -INF, bestMove = 0, legal = 0, quiets = 0;
      const alpha0 = alpha;
      const tried = this.tried;
      let nTried = 0;
      for (let i = base; i < base + n; i++) {
        const m = this.pick(i, base + n);
        const to = m & 127, from = (m >> 7) & 127;
        const cap = from <= 80 && b[to] !== 0, promo = (m >> 14) & 1;
        const quiet = !cap && !promo;
        if (!pvNode && !inCheck && legal > 0 && quiet && best > -MATE_IN_MAX) {
          // 浅いところの遅い静かな手は読まない（取る手・成る手のあとに並んでいるので、ここから先は全部静かな手）
          if (depth <= 4 && quiets >= (improving ? 6 : 4) + depth * depth * 2) break;
          if (depth <= 3 && ev + 140 * depth + 60 <= alpha) break;
        }
        if (!this.makeLegal(m)) continue;
        legal++;
        if (quiet) { quiets++; if (nTried < 64) tried[sp * 64 + nTried++] = m; }
        const gives = pos.chkS[pos.ply] === 1;
        // 王手の延長: 取られない王手だけ（将棋は王手が多いので全部は延ばさない）
        let ext = 0;
        if (gives && sp < this.rootDepth * 2 && !pos.attacked(to, pos.stm)) ext = 1;
        const nd = depth - 1 + ext;
        let v;
        if (legal === 1) v = 0 - this.search(nd, 0 - beta, 0 - alpha, sp + 1, true);
        else {
          let r = 0;
          if (depth >= 3 && quiet && !inCheck && !gives) {
            r = LMR[Math.min(depth, 63)][Math.min(legal, MAXMOVES - 1)];
            if (pvNode) r--;
            if (m === this.killers[sp * 2] || m === this.killers[sp * 2 + 1]) r--;
            if (!improving) r++;
            if (r < 0) r = 0;
            if (r > nd - 1) r = Math.max(0, nd - 1);
          }
          v = 0 - this.search(nd - r, -1 - alpha, 0 - alpha, sp + 1, true);
          if (v > alpha && r > 0) v = 0 - this.search(nd, -1 - alpha, 0 - alpha, sp + 1, true);
          if (v > alpha && v < beta) v = 0 - this.search(nd, 0 - beta, 0 - alpha, sp + 1, true);
        }
        pos.unmake();
        if (this.stopped) return 0;
        if (v > best) {
          best = v;
          if (v > alpha) {
            alpha = v; bestMove = m;
            this.pvT[sp * MAXSP + sp] = m;
            for (let j = sp + 1; j < this.pvLen[sp + 1]; j++) this.pvT[sp * MAXSP + j] = this.pvT[(sp + 1) * MAXSP + j];
            this.pvLen[sp] = this.pvLen[sp + 1];
            if (v >= beta) {
              if (quiet) {
                if (this.killers[sp * 2] !== m) { this.killers[sp * 2 + 1] = this.killers[sp * 2]; this.killers[sp * 2] = m; }
                const bonus = Math.min(1600, depth * depth * 16);
                this.histUpdate(c, m, bonus);
                for (let k = 0; k < nTried - 1; k++) this.histUpdate(c, tried[sp * 64 + k], -bonus);
              }
              break;
            }
          }
        }
      }
      if (!legal) return -MATE + sp; // 指せる手がない = 負け（詰み）
      this.store(bestMove, depth, best >= beta ? BOUND_LOWER : best > alpha0 ? BOUND_EXACT : BOUND_UPPER, best, inCheck ? 0 : ev, sp);
      return best;
    }

    // 合法手ごとの浅い評価（取り合いだけ読む）。自己対局の序盤を散らすのに使う
    rootMoveScores(pos) {
      this.pos = pos; this.nodes = 0; this.stopped = false; this.nodeLimit = 0; this.jobId = 0;
      this.deadline = Date.now() + 1e12;
      this.ev.reset(pos);
      const out = [], buf = new Int32Array(MAXMOVES);
      let n = pos.genBoard(buf, 0, 2, false);
      n = pos.genDrops(buf, n);
      for (let i = 0; i < n; i++) {
        if (!this.makeLegal(buf[i])) continue;
        const v = 0 - this.qsearch(-INF, INF, 1, 0);
        pos.unmake();
        out.push({ m: buf[i], v });
      }
      return out;
    }

    // ---------------------------------------------------------------- 反復深化
    // opts: { timeMs, maxDepth, nodes, analyze, onInfo, jobId }
    think(pos, opts = {}) {
      const t0 = Date.now();
      this.pos = pos;
      this.jobId = opts.jobId || 0;
      this.nodes = 0; this.stopped = false;
      this.nodeLimit = opts.nodes || 0;
      this.deadline = opts.timeMs ? t0 + opts.timeMs : t0 + 1e12;
      this.age = (this.age + 1) & 63;
      this.killers.fill(0);
      for (let i = 0; i < this.hist.length; i++) this.hist[i] >>= 1;
      this.ev.reset(pos);
      const res = { move: 0, score: 0, depth: 0, pv: [], nodes: 0, time: 0 };
      if (pos.canDeclare()) { res.move = DECLARE; res.score = MATE - 1; res.pv = [DECLARE]; return res; }
      // 合法手
      const root = [];
      {
        const buf = new Int32Array(MAXMOVES);
        let n = pos.genBoard(buf, 0, 2, false);
        n = pos.genDrops(buf, n);
        for (let i = 0; i < n; i++) if (this.makeLegal(buf[i])) { pos.unmake(); root.push(buf[i]); }
      }
      if (!root.length) { res.score = -MATE; return res; }
      res.move = root[0];
      if (root.length === 1 && !opts.analyze) { res.depth = 1; res.pv = [root[0]]; return res; }
      const maxDepth = opts.maxDepth || 64;
      const rootScores = new Map(root.map(m => [m, -INF]));
      let prev = 0;
      for (let d = 1 + (this.helper & 1); d <= maxDepth; d++) {
        this.rootDepth = d;
        let delta = 60, alpha = -INF, beta = INF;
        if (d >= 4 && !isMate(prev)) { alpha = prev - delta; beta = prev + delta; }
        let score;
        for (;;) {
          score = this.searchRoot(root, d, alpha, beta, rootScores);
          if (this.stopped) break;
          if (score <= alpha) { alpha = Math.max(-INF, score - delta); delta *= 2; }
          else if (score >= beta) { beta = Math.min(INF, score + delta); delta *= 2; }
          else break;
          if (delta > 2000) { alpha = -INF; beta = INF; }
        }
        if (this.stopped && d > 1) break;
        prev = score;
        res.move = root[0]; res.score = score; res.depth = d;
        res.pv = Array.from(this.pvT.subarray(0, this.pvLen[0]));
        if (!res.pv.length || res.pv[0] !== root[0]) res.pv = [root[0]];
        res.nodes = this.nodes; res.time = Date.now() - t0;
        if (opts.onInfo) opts.onInfo(Object.assign({}, res));
        if (this.stopped) break;
        if (isMate(score) && d >= (MATE - Math.abs(score)) + 2 && !opts.analyze) break;
        // 次の深さを読み切れそうにないなら止める
        if (opts.timeMs && !opts.analyze && Date.now() - t0 > opts.timeMs * 0.55) break;
      }
      res.nodes = this.nodes; res.time = Date.now() - t0;
      return res;
    }
    searchRoot(root, depth, alpha, beta, rootScores) {
      const pos = this.pos;
      this.pvLen[0] = 0;
      let best = -INF, bestI = 0;
      for (let i = 0; i < root.length; i++) {
        const m = root[i];
        this.makeLegal(m);
        const gives = pos.chkS[pos.ply] === 1;
        const nd = depth - 1 + (gives && !pos.attacked(m & 127, pos.stm) ? 1 : 0);
        let v;
        if (i === 0) v = 0 - this.search(nd, 0 - beta, 0 - alpha, 1, true);
        else {
          const quiet = S.isDrop(m) || (!pos.capS[pos.ply - 1] && !((m >> 14) & 1));
          const r = depth >= 4 && quiet && !gives && i >= 4 ? 1 : 0;
          v = 0 - this.search(nd - r, -1 - alpha, 0 - alpha, 1, true);
          if (v > alpha && r) v = 0 - this.search(nd, -1 - alpha, 0 - alpha, 1, true);
          if (v > alpha && v < beta) v = 0 - this.search(nd, 0 - beta, 0 - alpha, 1, true);
        }
        pos.unmake();
        if (this.stopped) break;
        rootScores.set(m, v);
        if (v > best) {
          best = v; bestI = i;
          if (v > alpha) {
            alpha = v;
            this.pvT[0] = m;
            for (let j = 1; j < this.pvLen[1]; j++) this.pvT[j] = this.pvT[MAXSP + j];
            this.pvLen[0] = Math.max(1, this.pvLen[1]);
            if (v >= beta) break;
          }
        }
      }
      // 一番よかった手を先頭へ（次の深さで最初に読む）
      if (bestI > 0) { const m = root.splice(bestI, 1)[0]; root.unshift(m); }
      if (this.helper && root.length > 2) { // 補助のワーカーは2番目以降の順を少し混ぜて、違う枝を読む
        const k = 1 + ((this.helper * 7 + depth) % (root.length - 1));
        const m = root.splice(k, 1)[0]; root.splice(1, 0, m);
      }
      this.store(root[0], depth, best >= beta ? BOUND_LOWER : BOUND_EXACT, best, 0, 0);
      return best;
    }
  }

  Object.assign(S, { MATE, MATE_IN_MAX, WIN_REP, INF, isMate, winRate, EVAL_SCALE, NF, HAND0, C0, D0, HMAX, KIND, features, pieceFeat, handFeat, orient, Net, Evaluator, Searcher, makeTT });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ShogiAI;
