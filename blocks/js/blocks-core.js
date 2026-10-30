/* ブロック陣取りのルール（ピース・盤・合法手・得点・ネットの入力）。ブラウザ・Web Worker・Node で同じものを使う
 *
 *   const B = BlocksCore;                       // Node: require('./blocks-core.js')
 *   const pos = new B.Position('classic');      // 'classic'（20×20・4色・4人）/ 'team'（20×20・4色・2人で2色ずつ）/ 'duo'（14×14・2色・2人）
 *   const k = pos.legal();                      // 手番の色の合法手の数（pos.buf[0..k) に置き方の番号）。置けない色はここでパスにして次の色へ
 *   pos.play(pos.buf[0]); pos.undo();
 *   pos.over() / pos.scores() / pos.outcome()
 *
 * 置き方（placement）の番号: 盤の大きさごとに「21ピースの向き（全部で91通り）× 盤の上の位置」をすべて並べた通し番号
 * 盤は1行を1つの整数のビット（x 番目のビット = x 列目）で持つ。行 y・列 x のマスの番号は y*n + x（左上が 0）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlocksCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ ピース（1〜5マスのすべての形 = 21個）
  // 名前は形の数学の呼び名（ポリオミノ）。cells は基本の向きのマス [x, y]
  const PIECE_DEF = [
    ['1', [[0, 0]]],
    ['2', [[0, 0], [1, 0]]],
    ['I3', [[0, 0], [1, 0], [2, 0]]],
    ['V3', [[0, 0], [0, 1], [1, 1]]],
    ['I4', [[0, 0], [1, 0], [2, 0], [3, 0]]],
    ['L4', [[0, 0], [0, 1], [0, 2], [1, 2]]],
    ['T4', [[0, 0], [1, 0], [2, 0], [1, 1]]],
    ['S4', [[1, 0], [2, 0], [0, 1], [1, 1]]],
    ['O4', [[0, 0], [1, 0], [0, 1], [1, 1]]],
    ['F', [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]]],
    ['I5', [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]],
    ['L5', [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]]],
    ['N', [[1, 0], [1, 1], [0, 2], [1, 2], [0, 3]]],
    ['P', [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]],
    ['T5', [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]],
    ['U', [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]]],
    ['V5', [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]],
    ['W', [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]]],
    ['X', [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]],
    ['Y', [[1, 0], [0, 1], [1, 1], [1, 2], [1, 3]]],
    ['Z5', [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]],
  ];
  const NPIECE = PIECE_DEF.length;
  const ALL = (1 << NPIECE) - 1;
  const PIECE_NAME = PIECE_DEF.map(d => d[0]);
  const PIECE_SIZE = PIECE_DEF.map(d => d[1].length);
  const TOTAL_CELLS = PIECE_SIZE.reduce((a, b) => a + b, 0); // 89

  // 形の変換 t（0..7）: t&4 で x と y を入れ替え、t&1 で上下、t&2 で左右を裏返す（盤の対称と同じ並び）
  function tf(t, x, y) {
    if (t & 4) { const z = x; x = y; y = z; }
    if (t & 1) y = -y;
    if (t & 2) x = -x;
    return [x, y];
  }
  // 左上をそろえ、行（y）→ 列（x）の順に並べる
  function norm(cells) {
    let mx = Infinity, my = Infinity;
    for (const [x, y] of cells) { if (x < mx) mx = x; if (y < my) my = y; }
    return cells.map(([x, y]) => [x - mx, y - my]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
  const shapeKey = cells => cells.map(c => c[0] + ',' + c[1]).join(' ');

  // 向き: ピースごとに、8通りの変換で重ならない形だけを残す（合計 91）
  const ORI = [];             // { p, cells, w, h, rows, key }
  const PIECE_O0 = [], PIECE_ON = [];
  const KEY2ORI = new Map();
  for (let p = 0; p < NPIECE; p++) {
    PIECE_O0.push(ORI.length);
    const seen = new Set();
    for (let t = 0; t < 8; t++) {
      const cells = norm(PIECE_DEF[p][1].map(([x, y]) => tf(t, x, y)));
      const key = shapeKey(cells);
      if (seen.has(key)) continue;
      seen.add(key);
      let w = 0, h = 0;
      for (const [x, y] of cells) { if (x + 1 > w) w = x + 1; if (y + 1 > h) h = y + 1; }
      const rows = new Array(h).fill(0);
      for (const [x, y] of cells) rows[y] |= 1 << x;
      KEY2ORI.set(key, ORI.length);
      ORI.push({ p, cells, w, h, rows, key });
    }
    PIECE_ON.push(ORI.length - PIECE_O0[p]);
  }
  const NORI = ORI.length; // 91
  // 速く読むための平らな表
  const O_W = new Int8Array(NORI), O_H = new Int8Array(NORI), O_NC = new Int8Array(NORI), O_P = new Int8Array(NORI);
  const O_CX = new Int8Array(NORI * 5), O_CY = new Int8Array(NORI * 5), O_ROWS = new Int32Array(NORI * 5);
  ORI.forEach((o, i) => {
    O_W[i] = o.w; O_H[i] = o.h; O_NC[i] = o.cells.length; O_P[i] = o.p;
    o.cells.forEach(([x, y], k) => { O_CX[i * 5 + k] = x; O_CY[i * 5 + k] = y; });
    o.rows.forEach((r, k) => { O_ROWS[i * 5 + k] = r; });
  });
  // 形を変換したときの向き（ORI_TF[t*91 + o]）、画面の回転（右回り）と裏返し（左右）
  const ORI_TF = new Int16Array(8 * NORI);
  for (let t = 0; t < 8; t++) for (let o = 0; o < NORI; o++) ORI_TF[t * NORI + o] = KEY2ORI.get(shapeKey(norm(ORI[o].cells.map(([x, y]) => tf(t, x, y)))));
  const ORI_ROT = new Int16Array(NORI), ORI_ROTL = new Int16Array(NORI), ORI_FLIP = new Int16Array(NORI), ORI_FLIPV = new Int16Array(NORI);
  for (let o = 0; o < NORI; o++) {
    ORI_ROT[o] = KEY2ORI.get(shapeKey(norm(ORI[o].cells.map(([x, y]) => [-y, x]))));
    ORI_ROTL[o] = KEY2ORI.get(shapeKey(norm(ORI[o].cells.map(([x, y]) => [y, -x]))));
    ORI_FLIP[o] = KEY2ORI.get(shapeKey(norm(ORI[o].cells.map(([x, y]) => [-x, y]))));
    ORI_FLIPV[o] = KEY2ORI.get(shapeKey(norm(ORI[o].cells.map(([x, y]) => [x, -y]))));
  }

  // ------------------------------------------------------------------ ルールの種類
  const RULES = {
    classic: { key: 'classic', name: '4人', n: 20, nc: 4, owner: [0, 1, 2, 3], players: 4, starts: [[0, 0], [19, 0], [19, 19], [0, 19]] },
    team: { key: 'team', name: '2人・2色ずつ', n: 20, nc: 4, owner: [0, 1, 0, 1], players: 2, starts: [[0, 0], [19, 0], [19, 19], [0, 19]] },
    duo: { key: 'duo', name: '2人・14×14', n: 14, nc: 2, owner: [0, 1], players: 2, starts: [[4, 4], [9, 9]] },
  };
  const MODES = ['classic', 'team', 'duo'];

  // 盤の対称 s（0..7）: (x, y) → 移る先
  function symXY(s, n, x, y) {
    if (s & 4) { const z = x; x = y; y = z; }
    if (s & 1) y = n - 1 - y;
    if (s & 2) x = n - 1 - x;
    return [x, y];
  }

  // ------------------------------------------------------------------ 盤の大きさごとの置き方の表
  const TABLES = {};
  function tables(n) {
    if (TABLES[n]) return TABLES[n];
    const NN = n * n;
    let NP = 0;
    for (let o = 0; o < NORI; o++) NP += (n - O_W[o] + 1) * (n - O_H[o] + 1);
    const P_ORI = new Int16Array(NP), P_X = new Int8Array(NP), P_Y = new Int8Array(NP), P_PC = new Int8Array(NP);
    const PL = new Int32Array(NORI * NN).fill(-1);
    const POL = new Int32Array(NP);       // ネットの方策の番号 = 向き × NN + 「向きの最初のマス」の位置
    const C0 = new Int32Array(NP + 1);
    const CELLS = new Int16Array(NP * 5);
    let id = 0, ci = 0;
    for (let o = 0; o < NORI; o++) {
      const w = O_W[o], h = O_H[o], nc = O_NC[o];
      for (let y = 0; y + h <= n; y++) for (let x = 0; x + w <= n; x++) {
        P_ORI[id] = o; P_X[id] = x; P_Y[id] = y; P_PC[id] = O_P[o];
        PL[o * NN + y * n + x] = id;
        POL[id] = o * NN + (y + O_CY[o * 5]) * n + (x + O_CX[o * 5]);
        C0[id] = ci;
        for (let k = 0; k < nc; k++) CELLS[ci++] = (y + O_CY[o * 5 + k]) * n + x + O_CX[o * 5 + k];
        id++;
      }
    }
    C0[NP] = ci;
    const T = { n, NN, NP, P_ORI, P_X, P_Y, P_PC, PL, POL, C0, CELLS: CELLS.subarray(0, ci), STAMP: new Int32Array(NP), gen: 0, SYMS: [] };
    // 対称 s で移した置き方の番号（必要になったときに作る）
    T.sym = s => {
      if (T.SYMS[s]) return T.SYMS[s];
      const out = new Int32Array(NP);
      for (let p = 0; p < NP; p++) {
        const o = P_ORI[p], x = P_X[p], y = P_Y[p];
        const [a1, b1] = symXY(s, n, x, y), [a2, b2] = symXY(s, n, x + O_W[o] - 1, y + O_H[o] - 1);
        out[p] = PL[ORI_TF[s * NORI + o] * NN + Math.min(b1, b2) * n + Math.min(a1, a2)];
      }
      return (T.SYMS[s] = out);
    };
    TABLES[n] = T;
    return T;
  }

  // ------------------------------------------------------------------ 局面
  // 状態は1つの Int32Array（まるごと写して戻せるように）:
  //   [0, n)            全色の置いたマス（行ごとのビット）
  //   色 c ごとに3つ    自分のマス・自分のマスの辺の隣・自分のマスの角の隣（どれも行ごと）
  //   残り: ピースの残り（4色）、最後に置いたピース（4色、まだなら −1）、置けなくなった色のビット、手番、置いた数
  const OFS = n => ({ own: c => n * (1 + 3 * c), meta: 13 * n });
  class Position {
    constructor(mode = 'classic') {
      const R = RULES[mode];
      if (!R) throw new Error('ルールの種類が違います: ' + mode);
      this.mode = mode; this.R = R; this.n = R.n; this.nc = R.nc; this.T = tables(R.n);
      const n = this.n;
      this.META = 13 * n;
      this.SZ = 13 * n + 12;
      this.s = new Int32Array(this.SZ);
      this.stack = new Int32Array(this.SZ * 96);
      this.sp = 0;
      this.hist = [];
      this.buf = new Int32Array(8192);
      this.F = new Int32Array(n); this.A = new Int32Array(n);
      const s = this.s, M = this.META;
      for (let c = 0; c < 4; c++) { s[M + c] = c < this.nc ? ALL : 0; s[M + 4 + c] = -1; }
      s[M + 8] = 0;
      for (let c = this.nc; c < 4; c++) s[M + 8] |= 1 << c;
      s[M + 9] = 0; s[M + 10] = 0;
    }
    static fromMoves(mode, moves) {
      const p = new Position(mode);
      for (const m of moves) { if (!p.legalHas(m)) throw new Error('置けない手があります'); p.play(m); }
      return p;
    }
    clone() {
      const p = new Position(this.mode);
      p.s.set(this.s);
      p.hist = this.hist.slice();
      return p;
    }
    get turn() { return this.s[this.META + 9]; }
    set turn(c) { this.s[this.META + 9] = c; }
    get done() { return this.s[this.META + 8]; }
    set done(d) { this.s[this.META + 8] = d; }
    get ply() { return this.s[this.META + 10]; }
    rem(c) { return this.s[this.META + c]; }
    last(c) { return this.s[this.META + 4 + c]; }
    owner(c) { return this.R.owner[c]; }

    nextColor(c) {
      const d = this.s[this.META + 8], nc = this.nc;
      for (let i = 1; i <= nc; i++) { const k = (c + i) % nc; if (!(d & (1 << k))) return k; }
      return -1;
    }

    // 手番の色が pid を置く（合法かは確かめない）
    play(pid) {
      const s = this.s, n = this.n, T = this.T, M = this.META, c = s[M + 9];
      if (this.sp * this.SZ >= this.stack.length) { const st = new Int32Array(this.stack.length * 2); st.set(this.stack); this.stack = st; }
      this.stack.set(s, this.sp * this.SZ); this.sp++;
      const o = T.P_ORI[pid], x = T.P_X[pid], y = T.P_Y[pid], h = O_H[o];
      const OWN = n * (1 + 3 * c), ADJ = OWN + n, DIA = OWN + 2 * n, mask = (1 << n) - 1;
      for (let r = 0; r < h; r++) { const b = O_ROWS[o * 5 + r] << x; s[y + r] |= b; s[OWN + y + r] |= b; }
      const y0 = y > 0 ? y - 1 : 0, y1 = y + h < n ? y + h : n - 1;
      for (let yy = y0; yy <= y1; yy++) {
        const a = s[OWN + yy], up = yy > 0 ? s[OWN + yy - 1] : 0, dn = yy < n - 1 ? s[OWN + yy + 1] : 0;
        s[ADJ + yy] = ((a << 1) | (a >>> 1) | up | dn) & mask & ~a;
        s[DIA + yy] = ((up << 1) | (up >>> 1) | (dn << 1) | (dn >>> 1)) & mask;
      }
      const p = O_P[o];
      s[M + c] &= ~(1 << p); s[M + 4 + c] = p;
      s[M + 10]++;
      s[M + 9] = this.nextColor(c);
      this.hist.push(pid);
    }
    undo() {
      if (!this.sp) return;
      this.sp--;
      this.s.set(this.stack.subarray(this.sp * this.SZ, this.sp * this.SZ + this.SZ));
      this.hist.pop();
    }

    // 色 c の合法手を out に書いて数を返す（手番は変えない）
    gen(c, out = this.buf) {
      const s = this.s, n = this.n, T = this.T, M = this.META, rem = s[M + c];
      if (!rem) return 0;
      const OWN = n * (1 + 3 * c), ADJ = OWN + n, DIA = OWN + 2 * n, F = this.F, A = this.A;
      if (s[M + 4 + c] < 0) {
        // 最初の1手: 決められたマス（角など）を覆う
        for (let y = 0; y < n; y++) { F[y] = s[y]; A[y] = 0; }
        const [sx, sy] = this.R.starts[c];
        if (!(F[sy] & (1 << sx))) A[sy] = 1 << sx;
      } else {
        for (let y = 0; y < n; y++) { const f = s[y] | s[ADJ + y]; F[y] = f; A[y] = s[DIA + y] & ~f; }
      }
      const PL = T.PL, NN = T.NN, ST = T.STAMP, cap = out.length;
      const g = ++T.gen;
      let k = 0;
      for (let ay = 0; ay < n; ay++) {
        let a = A[ay];
        while (a) {
          const bit = a & -a, ax = 31 - Math.clz32(bit);
          a ^= bit;
          let r0 = rem;
          while (r0) {
            const pb = r0 & -r0, p = 31 - Math.clz32(pb);
            r0 ^= pb;
            const oe = PIECE_O0[p] + PIECE_ON[p];
            for (let o = PIECE_O0[p]; o < oe; o++) {
              const w = O_W[o], h = O_H[o], nc = O_NC[o], o5 = o * 5;
              for (let q = 0; q < nc; q++) {
                const px = ax - O_CX[o5 + q], py = ay - O_CY[o5 + q];
                if (px < 0 || py < 0 || px + w > n || py + h > n) continue;
                const pid = PL[o * NN + py * n + px];
                if (ST[pid] === g) continue;
                ST[pid] = g;
                let ok = 1;
                for (let r = 0; r < h; r++) if ((F[py + r] >>> px) & O_ROWS[o5 + r]) { ok = 0; break; }
                if (ok) { if (k < cap) out[k] = pid; k++; }
              }
            }
          }
        }
      }
      return Math.min(k, cap);
    }
    // 手番の色の合法手。置けない色はパス（以後ずっと置けない）にして次の色へ進む。全色が置けなければ 0（終局）
    legal(out = this.buf) {
      const s = this.s, M = this.META;
      for (;;) {
        const c = s[M + 9];
        if (c < 0) return 0;
        const k = this.gen(c, out);
        if (k) return k;
        s[M + 8] |= 1 << c;
        s[M + 9] = this.nextColor(c);
      }
    }
    legalList() { const k = this.legal(); return Array.from(this.buf.subarray(0, k)); }
    legalHas(pid) {
      const k = this.legal();
      for (let i = 0; i < k; i++) if (this.buf[i] === pid) return true;
      return false;
    }
    // 手番を決める（置けない色を飛ばす）。終局なら −1
    resolve() { this.legal(); return this.turn; }
    over() { return this.resolve() < 0; }

    // ---------------------------------------------------------------- 得点
    // 色ごと: 残ったマスの数だけ −1、全部置けたら +15、最後に置いたのが1マスなら さらに +5
    colorScore(c) {
      const r = this.rem(c);
      if (!r) return 15 + (this.last(c) === 0 ? 5 : 0);
      let v = 0;
      for (let p = 0; p < NPIECE; p++) if (r & (1 << p)) v -= PIECE_SIZE[p];
      return v;
    }
    scores() { const out = []; for (let c = 0; c < this.nc; c++) out.push(this.colorScore(c)); return out; }
    remCells(c) { const r = this.rem(c); let v = 0; for (let p = 0; p < NPIECE; p++) if (r & (1 << p)) v += PIECE_SIZE[p]; return v; }
    playerScores(sc = this.scores()) {
      const out = new Array(this.R.players).fill(0);
      for (let c = 0; c < this.nc; c++) out[this.R.owner[c]] += sc[c];
      return out;
    }
    // 順位（同点は同じ順位）と、順位から決める値（1位 +1 … 最下位 −1、同点は平均）。色ごとにも返す
    outcome(sc = this.scores()) {
      const ps = this.playerScores(sc), P = ps.length;
      const rank = ps.map(v => 1 + ps.filter(u => u > v).length);
      const util = ps.map(v => {
        const hi = ps.filter(u => u > v).length, eq = ps.filter(u => u === v).length;
        let t = 0;
        for (let k = hi; k < hi + eq; k++) t += 1 - 2 * k / (P - 1);
        return t / eq;
      });
      const cu = [];
      for (let c = 0; c < this.nc; c++) cu.push(util[this.R.owner[c]]);
      return { scores: sc, playerScores: ps, rank, util, colorUtil: cu };
    }

    // ---------------------------------------------------------------- 画面・記録のための便利なもの
    cellsOf(pid) { const T = this.T; return Array.from(T.CELLS.subarray(T.C0[pid], T.C0[pid + 1])); }
    // 盤のマスごとの色（空きは −1）
    board() {
      const n = this.n, b = new Int8Array(n * n).fill(-1);
      for (let c = 0; c < this.nc; c++) {
        const OWN = n * (1 + 3 * c);
        for (let y = 0; y < n; y++) { let r = this.s[OWN + y]; while (r) { const bit = r & -r; b[y * n + 31 - Math.clz32(bit)] = c; r ^= bit; } }
      }
      return b;
    }
    // 色 c が次に置ける角（最初の1手なら決められたマス）
    anchors(c) {
      const s = this.s, n = this.n, OWN = n * (1 + 3 * c), out = [];
      if (this.last(c) < 0) { const [x, y] = this.R.starts[c]; if (!(s[y] & (1 << x))) out.push(y * n + x); return out; }
      for (let y = 0; y < n; y++) {
        let a = s[OWN + 2 * n + y] & ~(s[y] | s[OWN + n + y]);
        while (a) { const bit = a & -a; out.push(y * n + 31 - Math.clz32(bit)); a ^= bit; }
      }
      return out;
    }
    // 置き方の番号 → { piece, ori, x, y }
    info(pid) { const T = this.T; return { piece: T.P_PC[pid], ori: T.P_ORI[pid], x: T.P_X[pid], y: T.P_Y[pid] }; }
    // 向き o を、左上が (x, y) になるように置く置き方（盤からはみ出すなら −1）
    placement(o, x, y) {
      const n = this.n;
      if (x < 0 || y < 0 || x + O_W[o] > n || y + O_H[o] > n) return -1;
      return this.T.PL[o * this.T.NN + y * n + x];
    }
    // マスの集まり（番号の配列）から置き方の番号を探す（なければ −1）
    findByCells(cells) {
      const n = this.n;
      if (!cells.length || cells.length > 5) return -1;
      const xy = cells.map(i => [i % n, (i / n) | 0]);
      let mx = Infinity, my = Infinity;
      for (const [x, y] of xy) { if (x < mx) mx = x; if (y < my) my = y; }
      const o = KEY2ORI.get(shapeKey(norm(xy)));
      return o == null ? -1 : this.placement(o, mx, my);
    }
  }

  // ------------------------------------------------------------------ ネットの入力（学習の train/net_*.py と同じ並び）
  // 手番の色を「自分」にして盤を回す（4色: 自分の角を左上へ。2人 14×14: 後手は 180° 回す）。aug=1 なら斜めに裏返す（2人 14×14 だけ）
  //   マスごとに1バイト: 下位3ビット = 置いた色（0 空き、1..4 = 自分・次・その次・その次の次）、ビット3..6 = その色が次に置ける角、ビット7 = 自分のマスの辺の隣（自分は置けない）
  //   そのあと 96 バイト: 残りのピース（相対の色ごとに21）、置けなくなった色（4）、味方の色（次・その次・その次の次の3）、ルールの種類（3）、置いた数、0
  const GLOBAL = 96;
  const inBytes = n => n * n + GLOBAL;
  function canonSym(pos, c, aug = 0) {
    if (pos.mode === 'duo') return c === 0 ? (aug ? 4 : 0) : (aug ? 7 : 3);
    return [0, 5, 3, 6][c];
  }
  function features(pos, out, off = 0, sym = canonSym(pos, pos.turn)) {
    const n = pos.n, NN = n * n, s = pos.s, M = pos.META, me = pos.turn < 0 ? 0 : pos.turn, nc = pos.nc;
    out.fill(0, off, off + NN + GLOBAL);
    const map = symMap(n, sym);
    for (let k = 0; k < nc; k++) {
      const c = (me + k) % nc, OWN = n * (1 + 3 * c), ADJ = OWN + n, DIA = OWN + 2 * n;
      const first = s[M + 4 + c] < 0 && !(s[M + 8] & (1 << c));
      for (let y = 0; y < n; y++) {
        let r = s[OWN + y];
        while (r) { const bit = r & -r; out[off + map[y * n + 31 - Math.clz32(bit)]] |= k + 1; r ^= bit; }
        let a = first ? 0 : s[DIA + y] & ~(s[y] | s[ADJ + y]);
        if (s[M + 8] & (1 << c)) a = 0;
        while (a) { const bit = a & -a; out[off + map[y * n + 31 - Math.clz32(bit)]] |= 8 << k; a ^= bit; }
        if (k === 0) { let f = s[ADJ + y] & ~s[y]; while (f) { const bit = f & -f; out[off + map[y * n + 31 - Math.clz32(bit)]] |= 128; f ^= bit; } }
      }
      if (first) { const [x, y] = pos.R.starts[c]; if (!(s[y] & (1 << x))) out[off + map[y * n + x]] |= 8 << k; }
    }
    const g = off + NN;
    for (let k = 0; k < 4; k++) {
      if (k >= nc) { out[g + 84 + k] = 1; continue; }
      const c = (me + k) % nc, r = s[M + c];
      for (let p = 0; p < NPIECE; p++) if (r & (1 << p)) out[g + k * 21 + p] = 1;
      if (s[M + 8] & (1 << c)) out[g + 84 + k] = 1;
      if (k > 0 && pos.R.owner[c] === pos.R.owner[me]) out[g + 87 + k] = 1;
    }
    out[g + 91 + MODES.indexOf(pos.mode)] = 1;
    out[g + 94] = Math.min(255, s[M + 10]);
    return out;
  }
  const SYMMAPS = {};
  function symMap(n, sym) {
    const key = n * 8 + sym;
    if (SYMMAPS[key]) return SYMMAPS[key];
    const m = new Int16Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const [a, b] = symXY(sym, n, x, y); m[y * n + x] = b * n + a; }
    return (SYMMAPS[key] = m);
  }
  // 置き方 pid の、対称 sym で回した盤でのネットの方策の番号
  const polIndex = (T, sym, pid) => T.POL[T.sym(sym)[pid]];

  // ------------------------------------------------------------------ 記録の文字
  const COLS = 'abcdefghijklmnopqrst';
  const cellName = (n, i) => COLS[i % n] + (((i / n) | 0) + 1);
  function parseCell(n, s) {
    const m = /^([a-t])(\d{1,2})$/.exec(String(s).trim());
    if (!m) return -1;
    const x = COLS.indexOf(m[1]), y = Number(m[2]) - 1;
    return x < n && y >= 0 && y < n ? y * n + x : -1;
  }

  return {
    PIECE_DEF, NPIECE, ALL, PIECE_NAME, PIECE_SIZE, TOTAL_CELLS, ORI, NORI, PIECE_O0, PIECE_ON, O_W, O_H, O_NC, O_P, O_CX, O_CY, O_ROWS,
    ORI_ROT, ORI_ROTL, ORI_FLIP, ORI_FLIPV, ORI_TF, RULES, MODES, symXY, tables, Position, features, canonSym, inBytes, GLOBAL, symMap, polIndex,
    cellName, parseCell, OFS,
  };
});
