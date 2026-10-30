/* バックギャモンの評価ネット（TD-Gammon の系統。自己対局の TD(λ) だけで学ぶ）。ブラウザ・Web Worker・Node で共通
 *
 * 入力（196）: 手番側（これから振る側）と相手のそれぞれについて
 *   24 のポイント × 4 … 枚数 n が 1以上・2以上・3以上・(n−3)/2（4枚以上のとき）
 *   バーの枚数 / 2、上がった枚数 / 15
 * 中間層 H（シグモイド）→ 出力 5（シグモイド）: 手番側の 勝ち・ギャモン勝ち・バックギャモン勝ち・ギャモン負け・バックギャモン負け（どれも「以上」の確率）
 * 盤の形の知識（人が作った特徴量や評価式）は入れていない。強さは自己対局の結果だけから学ぶ
 */
(function (root, factory) {
  const NET = factory();
  if (typeof module === 'object' && module.exports) module.exports = NET;
  else root.BGNet = NET;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NIN = 196, NOUT = 5, MAXACT = 110;

  function offOf(a) { let s = 0; for (let i = 0; i < 25; i++) s += a[i]; return 15 - s; }
  // 中間層のシグモイドは表引き（誤差 1e-6 以下。Math.exp より約3倍速い）。学習と推論で同じものを使う
  const SN = 4096, SIG = new Float32Array(SN + 2);
  for (let i = 0; i <= SN + 1; i++) SIG[i] = 1 / (1 + Math.exp(-(i * 32 / SN - 16)));
  function sigm(x) {
    if (x <= -16) return SIG[0];
    if (x >= 16) return SIG[SN];
    const f = (x + 16) * (SN / 32), i = f | 0;
    return SIG[i] + (SIG[i + 1] - SIG[i]) * (f - i);
  }
  // 疎な入力（値が 0 でないものだけ）: idx・val に書いて個数を返す
  function encode(me, opp, idx, val) {
    let n = 0;
    for (let s = 0; s < 2; s++) {
      const a = s ? opp : me, base = s * 98;
      for (let i = 0; i < 24; i++) {
        const c = a[i];
        if (c <= 0) continue;
        const o = base + i * 4;
        idx[n] = o; val[n++] = 1;
        if (c >= 2) { idx[n] = o + 1; val[n++] = 1; }
        if (c >= 3) { idx[n] = o + 2; val[n++] = 1; }
        if (c > 3) { idx[n] = o + 3; val[n++] = (c - 3) / 2; }
      }
      if (a[24]) { idx[n] = base + 96; val[n++] = a[24] / 2; }
      const off = offOf(a);
      if (off) { idx[n] = base + 97; val[n++] = off / 15; }
    }
    return n;
  }

  // 重みは1本の Float32Array: W1[NIN][H]・b1[H]・W2[NOUT][H]・b2[NOUT]
  const sizeOf = H => NIN * H + H + NOUT * H + NOUT;
  function initWeights(H, rnd) {
    const w = new Float32Array(sizeOf(H));
    const r = rnd || Math.random;
    for (let i = 0; i < NIN * H; i++) w[i] = (r() * 2 - 1) * 0.1;
    const o2 = NIN * H + H;
    for (let i = 0; i < NOUT * H; i++) w[o2 + i] = (r() * 2 - 1) * 0.1;
    return w;
  }

  function Net(H, w) {
    this.H = H;
    this.w = w || initWeights(H);
    this.o1 = NIN * H; this.o2 = NIN * H + H; this.o3 = NIN * H + H + NOUT * H;
    this.h = new Float32Array(H);
    this.idx = new Int16Array(MAXACT); this.val = new Float32Array(MAXACT); this.n = 0;
    this.evals = 0;
  }
  // 局面（me が手番＝これから振る側）の5つの確率を out に
  Net.prototype.evaluate = function (me, opp, out) {
    this.n = encode(me, opp, this.idx, this.val);
    this.forward(out);
    sanity(me, opp, out);
  };
  Net.prototype.forward = function (out) {
    const H = this.H, h = this.h, w = this.w, idx = this.idx, val = this.val, n = this.n;
    const o1 = this.o1, o2 = this.o2, o3 = this.o3;
    for (let j = 0; j < H; j++) h[j] = w[o1 + j];
    for (let k = 0; k < n; k++) {
      const off = idx[k] * H, v = val[k];
      if (v === 1) for (let j = 0; j < H; j++) h[j] += w[off + j];
      else for (let j = 0; j < H; j++) h[j] += v * w[off + j];
    }
    for (let j = 0; j < H; j++) h[j] = sigm(h[j]);
    for (let k = 0; k < NOUT; k++) {
      let s = w[o3 + k];
      const base = o2 + k * H;
      for (let j = 0; j < H; j++) s += h[j] * w[base + j];
      out[k] = 1 / (1 + Math.exp(-s));
    }
    this.evals++;
  };
  // ---- 差分の評価: 同じ局面から動かした候補手を何度も評価するとき、元の局面の中間層（活性化の前）を覚えておき、
  //      枚数の変わったポイントの分だけ足し引きする（候補手1つあたり、行の足し算が約40回 → 数回）
  // 局面（a = これから振る側、b = 相手）を元にする。同じ配列ならそのまま使う
  Net.prototype.ensureBase = function (a, b) {
    if (this.bok) {
      let same = true;
      for (let i = 0; i < 25; i++) if (a[i] !== this.bac[i] || b[i] !== this.bbc[i]) { same = false; break; }
      if (same) return;
    }
    const H = this.H, w = this.w;
    this.bac = Int8Array.from(a); this.bbc = Int8Array.from(b);
    const base = this.base || (this.base = new Float32Array(H));
    for (let j = 0; j < H; j++) base[j] = w[this.o1 + j];
    this.n = encode(a, b, this.idx, this.val);
    for (let k = 0; k < this.n; k++) {
      const off = this.idx[k] * H, v = this.val[k];
      for (let j = 0; j < H; j++) base[j] += v * w[off + j];
    }
    this.boffA = offOf(a); this.boffB = offOf(b); this.bok = true;
  };
  // ポイント i の枚数 c の分を、符号 sg で h に足す
  function addRow(h, w, H, r, v) { const off = r * H; for (let j = 0; j < H; j++) h[j] += v * w[off + j]; }
  function addPoint(h, w, H, side, i, c, sg) {
    if (c <= 0) return;
    const base = side * 98;
    if (i < 24) {
      const o = base + i * 4;
      addRow(h, w, H, o, sg);
      if (c >= 2) addRow(h, w, H, o + 1, sg);
      if (c >= 3) addRow(h, w, H, o + 2, sg);
      if (c > 3) addRow(h, w, H, o + 3, sg * (c - 3) / 2);
    } else if (i === 24) addRow(h, w, H, base + 96, sg * c / 2);
    else addRow(h, w, H, base + 97, sg * c / 15);
  }
  // 元の局面から動いた局面（a2 = これから振る側、b2 = 相手。元と同じ向き）を評価
  Net.prototype.evaluateFrom = function (a2, b2, out) {
    const H = this.H, w = this.w, h = this.h;
    h.set(this.base);
    const A = this.bac, B = this.bbc;
    for (let i = 0; i < 25; i++) {
      if (a2[i] !== A[i]) { addPoint(h, w, H, 0, i, A[i], -1); addPoint(h, w, H, 0, i, a2[i], 1); }
      if (b2[i] !== B[i]) { addPoint(h, w, H, 1, i, B[i], -1); addPoint(h, w, H, 1, i, b2[i], 1); }
    }
    const oa = offOf(a2), ob = offOf(b2);
    if (oa !== this.boffA) { addPoint(h, w, H, 0, 25, this.boffA, -1); addPoint(h, w, H, 0, 25, oa, 1); }
    if (ob !== this.boffB) { addPoint(h, w, H, 1, 25, this.boffB, -1); addPoint(h, w, H, 1, 25, ob, 1); }
    for (let j = 0; j < H; j++) h[j] = sigm(h[j]);
    const o2 = this.o2, o3 = this.o3;
    for (let k = 0; k < NOUT; k++) {
      let s = w[o3 + k];
      const base = o2 + k * H;
      for (let j = 0; j < H; j++) s += h[j] * w[base + j];
      out[k] = 1 / (1 + Math.exp(-s));
    }
    this.evals++;
    sanity(a2, b2, out);
  };
  // 重みが変わったら（学習中）元の局面を作り直す
  Net.prototype.dropBase = function () { this.bok = false; };

  // 学習: 直前の forward の入力と中間層を使い、出力を target に近づける（交差エントロピーの勾配）
  Net.prototype.update = function (out, target, alpha) {
    const H = this.H, h = this.h, w = this.w, idx = this.idx, val = this.val, n = this.n;
    const o1 = this.o1, o2 = this.o2, o3 = this.o3;
    const dh = this._dh || (this._dh = new Float32Array(H));
    dh.fill(0);
    for (let k = 0; k < NOUT; k++) {
      const d = target[k] - out[k];
      if (d === 0) continue;
      const base = o2 + k * H, ad = alpha * d;
      for (let j = 0; j < H; j++) { dh[j] += d * w[base + j]; w[base + j] += ad * h[j]; }
      w[o3 + k] += ad;
    }
    for (let j = 0; j < H; j++) { const g = dh[j] * h[j] * (1 - h[j]) * alpha; dh[j] = g; w[o1 + j] += g; }
    for (let k = 0; k < n; k++) {
      const off = idx[k] * H, v = val[k];
      if (v === 1) for (let j = 0; j < H; j++) w[off + j] += dh[j];
      else for (let j = 0; j < H; j++) w[off + j] += v * dh[j];
    }
  };

  // 起こりえない値を直す: 1枚でも上げていればギャモン負けはない、相手が上げていればギャモン勝ちはない。「以上」の順を守る
  function sanity(me, opp, p) {
    if (offOf(me) > 0) { p[3] = 0; p[4] = 0; }
    if (offOf(opp) > 0) { p[1] = 0; p[2] = 0; }
    if (p[1] > p[0]) p[1] = p[0];
    if (p[2] > p[1]) p[2] = p[1];
    if (p[3] > 1 - p[0]) p[3] = 1 - p[0];
    if (p[4] > p[3]) p[4] = p[3];
  }
  // 相手から見た確率に（勝ち ↔ 負け）
  function flip(p, out) {
    const w = p[0], wg = p[1], wb = p[2], lg = p[3], lb = p[4];
    out[0] = 1 - w; out[1] = lg; out[2] = lb; out[3] = wg; out[4] = wb;
    return out;
  }
  // キューブなしのマネーの期待値（1点あたり）
  const equity = p => 2 * p[0] - 1 + p[1] - p[3] + p[2] - p[4];

  // 重みの読み書き（base64）
  function toB64(f32) {
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    let u8;
    if (typeof Buffer !== 'undefined') u8 = new Uint8Array(Buffer.from(b64, 'base64'));
    else { const s = atob(b64); u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); }
    return new Float32Array(u8.buffer, 0, u8.byteLength >> 2);
  }

  return { NIN, NOUT, MAXACT, encode, sizeOf, initWeights, Net, sanity, flip, equity, toB64, fromB64, offOf };
});
