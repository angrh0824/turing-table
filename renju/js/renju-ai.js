/* 連珠の AI: 線の形の表・脅威の追跡・四追い（VCF）・αβ探索・学習した評価と手の順番
 *
 * ・線の形: マスに石を置いたとき、その方向の前後5マスの並び（3^10 通り）から「五・四・三…」の形を表で引く
 *   （黒の連珠用＝ちょうど五、白・自由用＝五以上 の2つの表。三・四の定義はルールの定義を線の上でくり返して作る）
 * ・マスの形: 4方向の形の組（1365 通り）。評価と手の順番は、この組ごとの重み（自己対局で学習）の和
 * ・石を置くたびに、影響する 4方向×10マスだけ形を更新する。五・四・止められない四・三になるマスの一覧も更新
 * ・探索: 相手の四は必ず止める・止められない四があれば勝ち・相手に三があれば防ぐ手（＋自分の四）だけを読む、
 *   それ以外は手の順番の上位だけを読む αβ（PVS・置換表・反復深化）。読みの末端では四追い（VCF）で勝ちを探す
 */
function RenjuAI(R) {
  'use strict';
  const { N, W, SIZE, EMPTY, BLACK, WHITE, WALL, DIRS, P2I, I2P, CENTER } = R;
  const preciseForbidden = R.forbidden;

  // ------------------------------------------------------------------ 線の形の表
  const DEAD = 0, B1 = 1, F1 = 2, B2 = 3, F2 = 4, B3 = 5, F3 = 6, B4 = 7, F4 = 8, F44 = 9, F5 = 10, OL = 11, NP = 12;
  const PNAME = ['死', '止1', '活1', '止2', '活2', '止3', '活3', '四', '達四', '一直線の四四', '五', '長連'];
  const NK = 59049;
  const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683, 59049];
  const slotOf = o => (o < 0 ? o + 5 : o + 4); // 中心からのずれ −5〜−1, 1〜5 → 0〜9

  function buildLineTable(exact) {
    const T = new Int8Array(NK).fill(-1);
    function cls(key) {
      if (T[key] >= 0) return T[key];
      const ln = new Int8Array(11);
      let k = key;
      for (let s = 0; s < 10; s++) { ln[s < 5 ? s : s + 1] = k % 3; k = (k / 3) | 0; }
      ln[5] = 1;
      const run = () => { let a = 5, b = 5; while (a > 0 && ln[a - 1] === 1) a--; while (b < 10 && ln[b + 1] === 1) b++; return b - a + 1; };
      const r = run();
      let res;
      if (r >= 5) res = exact && r > 5 ? OL : F5;
      else {
        let a = 5, b = 5;
        while (a > 0 && ln[a - 1] !== 2) a--;
        while (b < 10 && ln[b + 1] !== 2) b++;
        if (b - a + 1 < 5) res = DEAD;
        else {
          let n5 = 0, o1 = 0, o2 = 0;
          for (let o = -4; o <= 4; o++) {
            if (!o || ln[o + 5] !== 0) continue;
            ln[o + 5] = 1;
            const rr = run();
            ln[o + 5] = 0;
            if (exact ? rr === 5 : rr >= 5) { if (n5 === 0) o1 = o; else if (n5 === 1) o2 = o; n5++; }
          }
          if (n5 >= 2) res = n5 === 2 && Math.abs(o2 - o1) === 5 ? F4 : F44;
          else if (n5 === 1) res = B4;
          else {
            let best = DEAD;
            for (let o = -4; o <= 4; o++) {
              if (!o || ln[o + 5] !== 0) continue;
              const sub = cls(key + POW3[slotOf(o)]);
              let m = DEAD;
              if (sub === F4 || (!exact && sub === F44)) m = F3;
              else if (sub === B4) m = B3;
              else if (sub === F3) m = F2;
              else if (sub === B3) m = B2;
              else if (sub === F2) m = F1;
              else if (sub === B2) m = B1;
              if (m > best) best = m;
            }
            res = best;
          }
        }
      }
      T[key] = res;
      return res;
    }
    for (let key = 0; key < NK; key++) cls(key);
    return Uint8Array.from(T);
  }
  const LINE_EXACT = buildLineTable(true), LINE_FREE = buildLineTable(false);

  // ------------------------------------------------------------------ マスの形（4方向の形の組）
  const COMBO = new Uint16Array(NP * NP * NP * NP);
  const COMBO_CODES = [];
  {
    const ids = new Map();
    for (let a = 0; a < NP; a++) for (let b = 0; b < NP; b++) for (let c = 0; c < NP; c++) for (let d = 0; d < NP; d++) {
      const s = [a, b, c, d].sort((x, y) => y - x), key = s.join(',');
      let id = ids.get(key);
      if (id === undefined) { id = COMBO_CODES.length; ids.set(key, id); COMBO_CODES.push(s); }
      COMBO[((a * NP + b) * NP + c) * NP + d] = id;
    }
  }
  const NCOMBO = COMBO_CODES.length; // 1365
  // 組の性質: 五・四の数・止められない四・三の数・禁手（確か / かもしれない）
  const FL_FIVE = 1, FL_FOUR = 2, FL_WIN = 4, FL_THREE = 8, FL_FSURE = 16, FL_FMAYBE = 32;
  function comboFlags(exact) {
    const F = new Uint8Array(NCOMBO);
    COMBO_CODES.forEach((s, id) => {
      const five = s.includes(F5), ol = s.includes(OL);
      const fours = s.filter(x => x === B4 || x === F4).length + 2 * s.filter(x => x === F44).length;
      const flex = s.includes(F4), f3 = s.filter(x => x === F3).length;
      let f = 0;
      if (five) f |= FL_FIVE;
      else if (exact) {
        if (ol || fours >= 2) f |= FL_FSURE;
        else {
          if (f3 >= 2) f |= FL_FMAYBE;
          if (fours) f |= FL_FOUR;
          if (flex) f |= FL_WIN;
          if (f3) f |= FL_THREE;
        }
      } else {
        if (fours) f |= FL_FOUR;
        if (flex || fours >= 2) f |= FL_WIN;
        if (f3) f |= FL_THREE;
      }
      F[id] = f;
    });
    return F;
  }
  const FLAGS_EXACT = comboFlags(true), FLAGS_FREE = comboFlags(false);
  const NPK = [NP * NP * NP, NP * NP, NP, 1]; // マスの形の番号 = Σ 方向 k の形 × NPK[k]

  // 盤の値（0 空き・1 黒・2 白・3 壁）をそのまま 4進数の桁にした並び（4^10 通り）から、黒と白の形をまとめて引く表
  //   値 = 黒の形 << 4 | 白の形
  const PAIRS = {};
  function pairTable(exactB) {
    const name = exactB ? 'exact' : 'free';
    if (PAIRS[name]) return PAIRS[name];
    const TB = exactB ? LINE_EXACT : LINE_FREE, TW = LINE_FREE;
    const DB = [0, 1, 2, 2], DW = [0, 2, 1, 2];
    const loB = new Int32Array(1024), loW = new Int32Array(1024), hiB = new Int32Array(1024), hiW = new Int32Array(1024);
    for (let k = 0; k < 1024; k++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let s = 0; s < 5; s++) { const v = (k >> (2 * s)) & 3; a += DB[v] * POW3[s]; b += DW[v] * POW3[s]; c += DB[v] * POW3[s + 5]; d += DW[v] * POW3[s + 5]; }
      loB[k] = a; loW[k] = b; hiB[k] = c; hiW[k] = d;
    }
    const P = new Uint8Array(1 << 20);
    for (let k = 0; k < 1 << 20; k++) {
      const lo = k & 1023, hi = k >> 10;
      P[k] = (TB[loB[lo] + hiB[hi]] << 4) | TW[loW[lo] + hiW[hi]];
    }
    return (PAIRS[name] = P);
  }

  // ------------------------------------------------------------------ ネットの評価（形の埋め込み。学習は train/nn.js）
  // マス・方向ごとに「前後4マスの並び（3^8 = 6561 通り）」と「線の形（12種 × 黒の連珠か）」の埋め込み（C 次元）を引き、
  // 4方向ぶん足したものをそのマスの黒・白それぞれの特徴 aB・aW とする。手番側を s、相手を o として
  //   h = [relu(s+bs), relu(o+bo), relu(s+o+bx)] を空きマスで合計（÷32）→ 小さな全結合（H）→ 勝つ見込み（logit）
  //   手の順番 = U・h（そのマス）＋ bu
  // 石を置くたびに並びの変わったマスに印をつけ、評価するときにそのマスだけ計算し直す
  const W8T = (() => {
    const DB = [0, 1, 2, 2], DW = [0, 2, 1, 2];
    const LB = new Uint16Array(256), HB = new Uint16Array(256), LW = new Uint16Array(256), HW = new Uint16Array(256);
    for (let k = 0; k < 256; k++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = 0; j < 4; j++) { const v = (k >> (2 * j)) & 3; a += DB[v] * POW3[j]; b += DB[v] * POW3[j + 4]; c += DW[v] * POW3[j]; d += DW[v] * POW3[j + 4]; }
      LB[k] = a; HB[k] = b; LW[k] = c; HW[k] = d;
    }
    return { LB, HB, LW, HW };
  })();
  // 4進数の並び（前後5マス）から、前後4マスの3進数の番号（黒から見た / 白から見た）
  const w8B = key => W8T.LB[(key >> 2) & 255] + W8T.HB[(key >> 10) & 255];
  const w8W = key => W8T.LW[(key >> 2) & 255] + W8T.HW[(key >> 10) & 255];
  const NN_POOL = 32, NN_SCALE = 400;
  function b64decode(str) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    const bin = atob(str), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // 保存した形（JSON）→ 探索で使う形（Float32Array）
  function prepareNN(raw) {
    if (!raw) return null;
    const f32 = a => (a instanceof Float32Array ? a : Float32Array.from(a));
    let E;
    if (typeof raw.E === 'string') { const q = new Int8Array(b64decode(raw.E).buffer); E = new Float32Array(q.length); for (let i = 0; i < q.length; i++) E[i] = q[i] * raw.Es; }
    else E = f32(raw.E);
    return { C: raw.C, H: raw.H, E, F: f32(raw.F), bs: f32(raw.bs), bo: f32(raw.bo), bx: f32(raw.bx), W1: f32(raw.W1), b1: f32(raw.b1), W2: f32(raw.W2), b2: +raw.b2, U: f32(raw.U), bu: +raw.bu, gen: raw.gen || 0 };
  }

  // ------------------------------------------------------------------ 重み（学習前の初期値。学習した重みは weights.js）
  // 評価: 手番側から見て、空きマスごとに「自分がそこに置いたときの形」と「相手がそこに置いたときの形」の重みを足す
  // 手の順番: 同じく自分の形（攻め）と相手の形（守り）の重み
  const BASE = [0, 1, 2, 3, 9, 6, 30, 24, 300, 300, 3000, 0];
  function initialTable(exact, role) {
    const t = new Float32Array(NCOMBO), FL = exact ? FLAGS_EXACT : FLAGS_FREE;
    COMBO_CODES.forEach((s, id) => {
      const f = FL[id];
      if (f & FL_FSURE) { t[id] = 0; return; }
      let v = s.reduce((a, x) => a + BASE[x], 0);
      const f3 = s.filter(x => x === F3).length, fours = s.filter(x => x === B4 || x === F4).length;
      if (fours && f3) v += 250;
      if (f3 >= 2) v += exact ? 0 : 150;
      if (fours >= 2) v += 250;
      if (role === 'evS') v *= 0.25;
      if (role === 'evO') v *= -0.2;
      if (role === 'poO') v *= 0.85;
      t[id] = Math.round(v);
    });
    return t;
  }
  function defaultWeights() {
    const set = (exB, exW) => ({
      b: { evS: initialTable(exB, 'evS'), evO: initialTable(exW, 'evO'), poS: initialTable(exB, 'poS'), poO: initialTable(exW, 'poO'), bias: 5 },
      w: { evS: initialTable(exW, 'evS'), evO: initialTable(exB, 'evO'), poS: initialTable(exW, 'poS'), poO: initialTable(exB, 'poO'), bias: 0 },
    });
    return { gen: 0, scale: 400, renju: set(true, false), free: set(false, false) };
  }
  // 重みを探索で使う形（整数の配列）に
  const MLP_OUT = 100;
  function prepareWeights(Wt) {
    const out = { scale: Wt.scale || 400 };
    for (const rule of ['renju', 'free']) {
      const src = Wt[rule] || defaultWeights()[rule];
      out[rule] = {};
      for (const side of ['b', 'w']) {
        const s = src[side], o = {};
        for (const k of ['evS', 'evO', 'poS', 'poO']) o[k] = Int32Array.from(s[k], x => Math.round(x));
        // 前後4マスの並び（6561 通り）ごとの重み（あれば）: 評価 ewS・ewO、手の順番 pwS・pwO
        for (const k of ['ewS', 'ewO', 'pwS', 'pwO']) o[k] = s[k] ? Int32Array.from(s[k], x => Math.round(x)) : null;
        // 手の順番: 直前の手（相手）・2手前（自分）からの距離（0〜7、7 は 7 以上）ごとの点（あれば）
        o.pd1 = s.pd1 ? Int32Array.from(s.pd1, x => Math.round(x)) : null; o.pd2 = s.pd2 ? Int32Array.from(s.pd2, x => Math.round(x)) : null;
        // 評価の小さなネット（あれば）: K 本の「形の組の重みの和」→ 隠れ H → 出力（×MLP_OUT を線形の評価に足す）
        const m = s.mlp;
        o.mK = m ? m.K : 0; o.mH = m ? m.H : 0;
        o.mS = m ? Float32Array.from(m.mS) : null; o.mO = m ? Float32Array.from(m.mO) : null;
        o.W1 = m ? Float32Array.from(m.W1) : null; o.b1 = m ? Float32Array.from(m.b1) : null; o.W2 = m ? Float32Array.from(m.W2) : null; o.b2 = m ? +m.b2 : 0;
        o.bias = Math.round(s.bias || 0);
        out[rule][side] = o;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 速い乱数・ハッシュ
  function xorshift(seed) {
    let s = seed | 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  }
  const ZR = xorshift(0x9e3779b9);
  const ZLO = [new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE)];
  const ZHI = [new Int32Array(SIZE), new Int32Array(SIZE), new Int32Array(SIZE)];
  for (const col of [BLACK, WHITE]) for (let i = 0; i < SIZE; i++) { ZLO[col][i] = ZR() | 0; ZHI[col][i] = ZR() | 0; }
  const ZS_LO = ZR() | 0, ZS_HI = ZR() | 0; // 手番だけ入れ替えたとき（相手の四追いを調べるとき）

  // 2つのマスの距離（縦横斜めの大きい方、7 以上は 7）
  const cheb = (a, b) => { const dx = Math.abs((a % W) - (b % W)), dy = Math.abs(((a / W) | 0) - ((b / W) | 0)); const d = dx > dy ? dx : dy; return d > 7 ? 7 : d; };
  const NB25 = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) NB25.push(dy * W + dx);

  class ISet {
    constructor() { this.list = new Int16Array(SIZE); this.pos = new Int16Array(SIZE).fill(-1); this.n = 0; }
    add(i) { if (this.pos[i] < 0) { this.pos[i] = this.n; this.list[this.n++] = i; } }
    del(i) { const p = this.pos[i]; if (p >= 0) { const last = this.list[--this.n]; this.list[p] = last; this.pos[last] = p; this.pos[i] = -1; } }
    has(i) { return this.pos[i] >= 0; }
  }

  // ------------------------------------------------------------------ 置換表（共有メモリでも使える。1項目 = 2つの Int32）
  //   [0] 照合用 = hashHi ^ data、[1] data = score(16bit) | move(9bit) | depth(5bit) | flag(2bit)
  const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  function makeTT(bits, shared) {
    const n = 1 << bits;
    const buf = shared ? new SharedArrayBuffer(n * 8) : new ArrayBuffer(n * 8);
    return { bits, mask: n - 1, a: new Int32Array(buf), buf };
  }

  const WIN = 30000, WIN_MIN = 29000, INF = 32000;
  const isWin = s => Math.abs(s) >= WIN_MIN;

  // ------------------------------------------------------------------ 盤と探索
  class Engine {
    // opts: { rule, weights（prepareWeights 済み）, tt, stopFlag（共有の Int32Array）, rand }
    constructor(opts = {}) {
      this.rule = opts.rule === 'free' ? 'free' : 'renju';
      this.exactB = this.rule === 'renju';
      this.TB = this.exactB ? LINE_EXACT : LINE_FREE;
      this.TW = LINE_FREE;
      this.FB = this.exactB ? FLAGS_EXACT : FLAGS_FREE;
      this.FW = FLAGS_FREE;
      this.setWeights(opts.weights || prepareWeights(defaultWeights()));
      this.tt = opts.tt || makeTT(20, false);
      this.stopFlag = opts.stopFlag || null;
      this.rand = opts.rand || Math.random;
      this.c = new Int8Array(SIZE).fill(WALL);
      for (let p = 0; p < N * N; p++) this.c[P2I[p]] = EMPTY;
      this.PT = pairTable(this.exactB);
      this.key = new Int32Array(SIZE * 4); this.pc = new Uint8Array(SIZE * 4);
      this.ckB = new Int32Array(SIZE); this.ckW = new Int32Array(SIZE);
      this.cbB = new Uint16Array(SIZE); this.cbW = new Uint16Array(SIZE);
      this.near = new Uint8Array(SIZE);
      this.cand = new ISet();
      this.S5 = [null, new ISet(), new ISet()];
      this.S4 = [null, new ISet(), new ISet()];
      this.SW = [null, new ISet(), new ISet()];
      this.S3 = [null, new ISet(), new ISet()];
      this.stack = new Int16Array(N * N + 1);
      this.ply0 = 0; this.nmoves = 0;
      this.side = BLACK;
      // ルールの違う局面が置換表で混ざらないように
      this.hlo = this.rule === 'free' ? 0x2545f491 : 0; this.hhi = this.rule === 'free' ? 0x6a09e667 : 0;
      this.sumB = 0; this.sumW = 0;
      this.history = new Int32Array(SIZE * 3);
      this.killers = new Int16Array(256 * 2);
      this.mark = new Int32Array(SIZE); this.markGen = 1;
      this.vcfTT = new Int32Array(1 << 16); this.vcfKey = new Int32Array(1 << 16);
      this.nodes = 0;
      // 探索で使う値（あとから足すと JIT が遅くなるので、すべてここで作る）
      this.lists = []; this.vlists = []; this.tlists = []; this.slists = [];
      for (let k = 0; k < 130; k++) { this.lists.push(new Int16Array(SIZE)); this.slists.push(new Int32Array(SIZE)); }
      for (let k = 0; k < 130; k++) { this.vlists.push(new Int16Array(SIZE)); this.tlists.push(new Int16Array(SIZE)); }
      this.vline = new Int16Array(512); this.vlen = 0; this.vwin = 0; this.vnodes = 0; this.vmax = 0;
      this.vctTT = new Int32Array(1 << 16); this.vctKey = new Int32Array(1 << 16); this.tnodes = 0; this.tmax = 0; this.vctMove = -1;
      this.pvt = new Int16Array(128 * 64); this.pvLen = new Uint8Array(128);
      this.stop = false; this.tick = 0; this.deadline = 0; this.maxNodes = 0; this.jobId = 0; this.selDepth = 0; this.rootBest = -1;
      this.qvcf = 400; this.qvcfDepth = 8; this.qthreat = 0; this.extUsed = 0;
      this.wBase = 8; this.wPV = 12; this.wMul = 2; this.wMax = 40; this.lmrD = 3; this.lmrK = 3; this.lmrK2 = 10; this.asp = 60; this.tSoft = 0.55;
      this.hNoise = 0; this.hSeed = 0x2545f491; // 複数スレッドの手伝い役: 手の順番に小さな揺らぎを入れて、主役と別の所を読む
      this.nA = null; this.nH = null; this.nPool = null; this.nIn = null; this.nK = null; this.nDirty = null; this.nDn = 0; this.nStamp = null; this.nGen = 1; this.nX = null;
      this.nn = null; this.nnEval = true; this.nnPol = true;
      this.initPatterns();
      if (opts.nn) this.setNN(opts.nn);
    }
    // ネットの評価を使う（null で線形の評価に戻す）
    setNN(net) {
      this.nn = net || null;
      if (!net) return;
      const C = net.C;
      this.nA = new Float32Array(SIZE * 2 * C);
      this.nH = new Float32Array(SIZE * 5 * C);
      this.nPool = new Float64Array(5 * C);
      this.nIn = new Uint8Array(SIZE);
      this.nK = new Int32Array(SIZE * 4).fill(-1);
      this.nDirty = new Int16Array(SIZE); this.nDn = 0; this.nStamp = new Int32Array(SIZE); this.nGen = 1;
      this.nX = new Float32Array(3 * C + 3);
      for (let i = 0; i < SIZE; i++) if (this.c[i] !== WALL) this.nMark(i);
      this.nSync();
    }
    nMark(j) { if (this.nStamp[j] !== this.nGen) { this.nStamp[j] = this.nGen; this.nDirty[this.nDn++] = j; } }
    // 印のついたマスの特徴を計算し直し、合計を更新する（1つのループで、古い値を引いて新しい値を足す）
    nSync() {
      if (!this.nDn) return;
      const net = this.nn, C = net.C, C2 = 2 * C, C3 = 3 * C, C4 = 4 * C, C5 = 5 * C, E = net.E, F = net.F, Hh = this.nH, P = this.nPool;
      const bs = net.bs, bo = net.bo, bx = net.bx, fbOff = this.exactB ? 0 : 12 * C, fwOff = 12 * C;
      const LB = W8T.LB, HB = W8T.HB, LW = W8T.LW, HW = W8T.HW, KEY = this.key, PC = this.pc, c = this.c, nIn = this.nIn;
      for (let q = 0; q < this.nDn; q++) {
        const j = this.nDirty[q], hb = j * C5;
        if (c[j] !== EMPTY) {
          if (nIn[j]) { for (let t = 0; t < C5; t++) P[t] -= Hh[hb + t]; nIn[j] = 0; }
          continue;
        }
        const x = j * 4, NK = this.nK;
        const k0 = KEY[x], k1 = KEY[x + 1], k2 = KEY[x + 2], k3 = KEY[x + 3];
        // 前に計算したときと並びが同じなら、そのまま（戻した手のあとに別の手を試したときによくある）
        if (nIn[j] && NK[x] === k0 && NK[x + 1] === k1 && NK[x + 2] === k2 && NK[x + 3] === k3) continue;
        NK[x] = k0; NK[x + 1] = k1; NK[x + 2] = k2; NK[x + 3] = k3;
        const p0 = PC[x], p1 = PC[x + 1], p2 = PC[x + 2], p3 = PC[x + 3];
        const e0 = (LB[(k0 >> 2) & 255] + HB[(k0 >> 10) & 255]) * C, e1 = (LB[(k1 >> 2) & 255] + HB[(k1 >> 10) & 255]) * C;
        const e2 = (LB[(k2 >> 2) & 255] + HB[(k2 >> 10) & 255]) * C, e3 = (LB[(k3 >> 2) & 255] + HB[(k3 >> 10) & 255]) * C;
        const g0 = (LW[(k0 >> 2) & 255] + HW[(k0 >> 10) & 255]) * C, g1 = (LW[(k1 >> 2) & 255] + HW[(k1 >> 10) & 255]) * C;
        const g2 = (LW[(k2 >> 2) & 255] + HW[(k2 >> 10) & 255]) * C, g3 = (LW[(k3 >> 2) & 255] + HW[(k3 >> 10) & 255]) * C;
        const f0 = fbOff + (p0 >> 4) * C, f1 = fbOff + (p1 >> 4) * C, f2 = fbOff + (p2 >> 4) * C, f3 = fbOff + (p3 >> 4) * C;
        const h0 = fwOff + (p0 & 15) * C, h1 = fwOff + (p1 & 15) * C, h2 = fwOff + (p2 & 15) * C, h3 = fwOff + (p3 & 15) * C;
        const was = nIn[j];
        for (let t = 0; t < C; t++) {
          const a = E[e0 + t] + E[e1 + t] + E[e2 + t] + E[e3 + t] + F[f0 + t] + F[f1 + t] + F[f2 + t] + F[f3 + t];
          const b = E[g0 + t] + E[g1 + t] + E[g2 + t] + E[g3 + t] + F[h0 + t] + F[h1 + t] + F[h2 + t] + F[h3 + t];
          let v1 = a + bs[t]; v1 = v1 > 0 ? v1 : 0;
          let v2 = b + bs[t]; v2 = v2 > 0 ? v2 : 0;
          let v3 = a + bo[t]; v3 = v3 > 0 ? v3 : 0;
          let v4 = b + bo[t]; v4 = v4 > 0 ? v4 : 0;
          let v5 = a + b + bx[t]; v5 = v5 > 0 ? v5 : 0;
          if (was) {
            P[t] += v1 - Hh[hb + t]; P[C + t] += v2 - Hh[hb + C + t]; P[C2 + t] += v3 - Hh[hb + C2 + t];
            P[C3 + t] += v4 - Hh[hb + C3 + t]; P[C4 + t] += v5 - Hh[hb + C4 + t];
          } else { P[t] += v1; P[C + t] += v2; P[C2 + t] += v3; P[C3 + t] += v4; P[C4 + t] += v5; }
          Hh[hb + t] = v1; Hh[hb + C + t] = v2; Hh[hb + C2 + t] = v3; Hh[hb + C3 + t] = v4; Hh[hb + C4 + t] = v5;
        }
        nIn[j] = 1;
      }
      this.nDn = 0; this.nGen++;
    }
    // 手番側から見た勝つ見込みの logit
    nnValue() {
      this.nSync();
      const net = this.nn, C = net.C, H = net.H, P = this.nPool, x = this.nX, black = this.side === BLACK;
      const s0 = black ? 0 : C, o0 = black ? 3 * C : 2 * C;
      for (let t = 0; t < C; t++) { x[t] = P[s0 + t] / NN_POOL; x[C + t] = P[o0 + t] / NN_POOL; x[2 * C + t] = P[4 * C + t] / NN_POOL; }
      x[3 * C] = black ? 1 : 0; x[3 * C + 1] = this.exactB ? 1 : 0; x[3 * C + 2] = this.nmoves / 225;
      const W1 = net.W1, b1 = net.b1, W2 = net.W2, n = 3 * C + 3;
      let v = net.b2;
      for (let u = 0; u < H; u++) { let z = b1[u]; const r = u * n; for (let t = 0; t < n; t++) z += W1[r + t] * x[t]; if (z > 0) v += W2[u] * z; }
      return v;
    }
    // マス i の手の順番の logit（nSync 済みであること）
    nnPolicy(i) {
      const net = this.nn, C = net.C, hb = i * 5 * C, Hh = this.nH, U = net.U, black = this.side === BLACK;
      const s0 = hb + (black ? 0 : C), o0 = hb + (black ? 3 * C : 2 * C), x0 = hb + 4 * C;
      let z = net.bu;
      for (let t = 0; t < C; t++) z += U[t] * Hh[s0 + t] + U[C + t] * Hh[o0 + t] + U[2 * C + t] * Hh[x0 + t];
      return z;
    }
    setWeights(Wp) {
      this.Wp = Wp;
      const r = Wp[this.rule];
      this.wb = r.b; this.ww = r.w;
      this.useW8E = !!(r.b.ewS && r.w.ewS && r.b.ewO && r.w.ewO);
      this.useW8P = !!(r.b.pwS && r.w.pwS && r.b.pwO && r.w.pwO);
      this.mK = r.b.mK && r.w.mK === r.b.mK && r.b.mH === r.w.mH ? r.b.mK : 0;
      this.chB = new Float64Array(Math.max(1, this.mK)); this.chW = new Float64Array(Math.max(1, this.mK));
      this.scale = Wp.scale;
      if (this.c) this.recomputeEval();
    }
    // 壁だけの盤から、全マスの線の形を作る
    initPatterns() {
      const c = this.c;
      for (let i = 0; i < SIZE; i++) {
        if (c[i] === WALL) continue;
        for (let k = 0; k < 4; k++) {
          const d = DIRS[k];
          let key = 0;
          for (let o = -5; o <= 5; o++) if (o) key += c[i + o * d] << (2 * slotOf(o));
          this.key[i * 4 + k] = key;
          this.pc[i * 4 + k] = this.PT[key];
        }
        this.refreshCell(i);
      }
      this.recomputeEval();
      for (let i = 0; i < SIZE; i++) if (c[i] === EMPTY) this.setMember(i);
    }
    // マスの形（4方向の組）を、各方向の形から作り直す
    refreshCell(i) {
      const b = i * 4, pc = this.pc;
      let ckb = 0, ckw = 0;
      for (let k = 0; k < 4; k++) { const v = pc[b + k]; ckb += (v >> 4) * NPK[k]; ckw += (v & 15) * NPK[k]; }
      this.ckB[i] = ckb; this.ckW[i] = ckw;
      this.cbB[i] = COMBO[ckb]; this.cbW[i] = COMBO[ckw];
    }
    recomputeEval() {
      let sb = 0, sw = 0;
      const wb = this.wb, ww = this.ww;
      for (let i = 0; i < SIZE; i++) {
        if (this.c[i] !== EMPTY) continue;
        sb += wb.evS[this.cbB[i]] + wb.evO[this.cbW[i]];
        sw += ww.evS[this.cbW[i]] + ww.evO[this.cbB[i]];
        if (this.useW8E) for (let k = 0; k < 4; k++) {
          const key = this.key[i * 4 + k], eb = w8B(key), ew = w8W(key);
          sb += wb.ewS[eb] + wb.ewO[ew]; sw += ww.ewS[ew] + ww.ewO[eb];
        }
      }
      this.sumB = sb; this.sumW = sw;
      if (this.mK) { this.chB.fill(0); this.chW.fill(0); for (let i = 0; i < SIZE; i++) if (this.c[i] === EMPTY) this.mCell(i, 1); }
    }
    setMember(i) {
      const fb = this.FB[this.cbB[i]], fw = this.FW[this.cbW[i]];
      const S5 = this.S5, S4 = this.S4, SW = this.SW, S3 = this.S3;
      if (fb & FL_FIVE) S5[1].add(i); else S5[1].del(i);
      if (fb & FL_FOUR) S4[1].add(i); else S4[1].del(i);
      if (fb & FL_WIN) SW[1].add(i); else SW[1].del(i);
      if (fb & FL_THREE) S3[1].add(i); else S3[1].del(i);
      if (fw & FL_FIVE) S5[2].add(i); else S5[2].del(i);
      if (fw & FL_FOUR) S4[2].add(i); else S4[2].del(i);
      if (fw & FL_WIN) SW[2].add(i); else SW[2].del(i);
      if (fw & FL_THREE) S3[2].add(i); else S3[2].del(i);
    }
    clearMember(i) {
      const S5 = this.S5, S4 = this.S4, SW = this.SW, S3 = this.S3;
      S5[1].del(i); S4[1].del(i); SW[1].del(i); S3[1].del(i);
      S5[2].del(i); S4[2].del(i); SW[2].del(i); S3[2].del(i);
    }
    // 性質が変わった一覧だけ更新する
    flagDiff(col, j, fo, fn) {
      const x = fo ^ fn;
      if (x & FL_FIVE) { if (fn & FL_FIVE) this.S5[col].add(j); else this.S5[col].del(j); }
      if (x & FL_FOUR) { if (fn & FL_FOUR) this.S4[col].add(j); else this.S4[col].del(j); }
      if (x & FL_WIN) { if (fn & FL_WIN) this.SW[col].add(j); else this.SW[col].del(j); }
      if (x & FL_THREE) { if (fn & FL_THREE) this.S3[col].add(j); else this.S3[col].del(j); }
    }
    // マス j の方向 k（x = j*4+k）の並びが d だけ変わった。石のあるマスは並びだけ覚えておく（空いたときに作り直す）
    updKey(j, x, d) {
      const okey = this.key[x], key = (this.key[x] = okey + d);
      if (this.nn) this.nMark(j);
      const empty = this.c[j] === EMPTY;
      if (this.useW8E && empty) {
        const LB = W8T.LB, HB = W8T.HB;
        const ob = LB[(okey >> 2) & 255] + HB[(okey >> 10) & 255], nb = LB[(key >> 2) & 255] + HB[(key >> 10) & 255];
        if (ob !== nb) {
          const LW = W8T.LW, HW = W8T.HW;
          const ow = LW[(okey >> 2) & 255] + HW[(okey >> 10) & 255], nw = LW[(key >> 2) & 255] + HW[(key >> 10) & 255];
          const wb = this.wb, ww = this.ww;
          this.sumB += wb.ewS[nb] - wb.ewS[ob] + wb.ewO[nw] - wb.ewO[ow];
          this.sumW += ww.ewS[nw] - ww.ewS[ow] + ww.ewO[nb] - ww.ewO[ob];
        }
      }
      const np = this.PT[key], op = this.pc[x];
      if (np === op) return;
      this.pc[x] = np;
      if (!empty) return;
      const m = NPK[x & 3];
      const ckb = (this.ckB[j] += ((np >> 4) - (op >> 4)) * m);
      const ckw = (this.ckW[j] += ((np & 15) - (op & 15)) * m);
      const nb = COMBO[ckb], nw = COMBO[ckw], ob = this.cbB[j], ow = this.cbW[j];
      if (nb === ob && nw === ow) return;
      this.cbB[j] = nb; this.cbW[j] = nw;
      const wb = this.wb, ww = this.ww;
      this.sumB += wb.evS[nb] - wb.evS[ob] + wb.evO[nw] - wb.evO[ow];
      this.sumW += ww.evS[nw] - ww.evS[ow] + ww.evO[nb] - ww.evO[ob];
      if (this.mK) {
        const K = this.mK, chB = this.chB, chW = this.chW, bS = wb.mS, bO = wb.mO, wS = ww.mS, wO = ww.mO;
        for (let k = 0, o = 0; k < K; k++, o += NCOMBO) {
          chB[k] += bS[o + nb] - bS[o + ob] + bO[o + nw] - bO[o + ow];
          chW[k] += wS[o + nw] - wS[o + ow] + wO[o + nb] - wO[o + ob];
        }
      }
      if (nb !== ob) { const fo = this.FB[ob], fn = this.FB[nb]; if (fo !== fn) this.flagDiff(1, j, fo, fn); }
      if (nw !== ow) { const fo = this.FW[ow], fn = this.FW[nw]; if (fo !== fn) this.flagDiff(2, j, fo, fn); }
    }
    // 石を置く（i は内部の番号）
    make(i) {
      const c = this.c, col = this.side;
      // このマスは空きでなくなる: 評価と脅威の一覧から外す
      const wb = this.wb, ww = this.ww;
      this.sumB -= wb.evS[this.cbB[i]] + wb.evO[this.cbW[i]];
      this.sumW -= ww.evS[this.cbW[i]] + ww.evO[this.cbB[i]];
      if (this.useW8E) this.w8Cell(i, -1);
      if (this.mK) this.mCell(i, -1);
      this.clearMember(i);
      c[i] = col;
      if (this.nn) this.nMark(i);
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k];
        for (let t = 1; t <= 5; t++) { const j = i + t * d; if (c[j] === WALL) break; this.updKey(j, j * 4 + k, col << (2 * (5 - t))); }
        for (let t = 1; t <= 5; t++) { const j = i - t * d; if (c[j] === WALL) break; this.updKey(j, j * 4 + k, col << (2 * (4 + t))); }
      }
      // 近くのマス（候補手）
      this.cand.del(i);
      const near = this.near, cand = this.cand;
      for (let a = 0; a < 25; a++) {
        const j = i + NB25[a];
        if (c[j] === WALL) continue;
        if (near[j]++ === 0 && c[j] === EMPTY) cand.add(j);
      }
      this.hlo ^= ZLO[col][i]; this.hhi ^= ZHI[col][i];
      this.stack[this.nmoves++] = i;
      this.side = 3 - col;
    }
    unmake() {
      const i = this.stack[--this.nmoves], c = this.c, col = c[i];
      this.side = col;
      this.hlo ^= ZLO[col][i]; this.hhi ^= ZHI[col][i];
      const near = this.near, cand = this.cand;
      for (let a = 0; a < 25; a++) {
        const j = i + NB25[a];
        if (c[j] === WALL) continue;
        if (--near[j] === 0) cand.del(j);
      }
      c[i] = EMPTY;
      if (this.nn) this.nMark(i);
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k];
        for (let t = 1; t <= 5; t++) { const j = i + t * d; if (c[j] === WALL) break; this.updKey(j, j * 4 + k, -(col << (2 * (5 - t)))); }
        for (let t = 1; t <= 5; t++) { const j = i - t * d; if (c[j] === WALL) break; this.updKey(j, j * 4 + k, -(col << (2 * (4 + t)))); }
      }
      if (near[i] > 0) cand.add(i);
      this.refreshCell(i);
      const wb = this.wb, ww = this.ww;
      this.sumB += wb.evS[this.cbB[i]] + wb.evO[this.cbW[i]];
      this.sumW += ww.evS[this.cbW[i]] + ww.evO[this.cbB[i]];
      if (this.useW8E) this.w8Cell(i, 1);
      if (this.mK) this.mCell(i, 1);
      this.setMember(i);
    }
    // マス i の「評価の小さなネット」の各チャンネルへの寄与を足す（s = 1）・引く（s = −1）
    mCell(i, s) {
      const K = this.mK, b = this.cbB[i], w = this.cbW[i], wb = this.wb, ww = this.ww;
      for (let k = 0, o = 0; k < K; k++, o += NCOMBO) {
        this.chB[k] += s * (wb.mS[o + b] + wb.mO[o + w]);
        this.chW[k] += s * (ww.mS[o + w] + ww.mO[o + b]);
      }
    }
    // マス i の「前後4マスの並び」の評価を足す（s = 1）・引く（s = −1）
    w8Cell(i, s) {
      const wb = this.wb, ww = this.ww;
      for (let k = 0; k < 4; k++) {
        const key = this.key[i * 4 + k], eb = w8B(key), ew = w8W(key);
        this.sumB += s * (wb.ewS[eb] + wb.ewO[ew]);
        this.sumW += s * (ww.ewS[ew] + ww.ewO[eb]);
      }
    }
    // 外向きの番号の手の列から局面を作る
    setMoves(moves) {
      while (this.nmoves) this.unmake();
      this.side = BLACK;
      for (const p of moves) this.make(P2I[p]);
      this.ply0 = moves.length;
    }

    // ---------------------------------------------------------------- 打てるか（黒の禁手）
    forbiddenB(i) {
      if (!this.exactB) return false;
      const f = this.FB[this.cbB[i]];
      if (f & FL_FIVE) return false;
      if (f & FL_FSURE) return true;
      if (f & FL_FMAYBE) return preciseForbidden(this.c, i) !== 0;
      return false;
    }
    legal(i, col) { return this.c[i] === EMPTY && (col !== BLACK || !this.forbiddenB(i)); }
    // col に「打てば止められない四」になる打てる点があるか（あればその点、なければ -1）
    winMove(col) {
      const s = this.SW[col];
      for (let k = 0; k < s.n; k++) { const i = s.list[k]; if (col !== BLACK || !this.forbiddenB(i)) return i; }
      return -1;
    }
    evaluate() {
      if (this.nn && this.nnEval) { const v = this.nnValue() * NN_SCALE; return v > 20000 ? 20000 : v < -20000 ? -20000 : Math.round(v); }
      const black = this.side === BLACK;
      let v = black ? this.sumB + this.wb.bias : this.sumW + this.ww.bias;
      if (this.mK) {
        const t = black ? this.wb : this.ww, ch = black ? this.chB : this.chW, K = this.mK, H = t.mH;
        let m = t.b2;
        for (let h = 0; h < H; h++) {
          let z = t.b1[h];
          for (let k = 0; k < K; k++) z += t.W1[h * K + k] * ch[k];
          if (z > 0) m += t.W2[h] * z;
        }
        v += Math.round(m * MLP_OUT);
      }
      return v;
    }
    // 手番側から見た、マス i の手の順番の点数
    policy(i) {
      if (this.nn && this.nnPol) return Math.round(this.nnPolicy(i) * 100);
      const black = this.side === BLACK, t = black ? this.wb : this.ww;
      let v = black ? t.poS[this.cbB[i]] + t.poO[this.cbW[i]] : t.poS[this.cbW[i]] + t.poO[this.cbB[i]];
      if (this.useW8P) for (let k = 0; k < 4; k++) {
        const key = this.key[i * 4 + k], eb = w8B(key), ew = w8W(key);
        v += black ? t.pwS[eb] + t.pwO[ew] : t.pwS[ew] + t.pwO[eb];
      }
      if (t.pd1 && this.nmoves) {
        v += t.pd1[cheb(i, this.stack[this.nmoves - 1])];
        if (this.nmoves > 1) v += t.pd2[cheb(i, this.stack[this.nmoves - 2])];
      }
      return v;
    }
    stopped() {
      if (this.stop) return true;
      if ((++this.tick & 255) === 0) {
        if (this.stopFlag && Atomics.load(this.stopFlag, 0) !== this.jobId) this.stop = true;
        else if (this.deadline && Date.now() > this.deadline) this.stop = true;
        else if (this.maxNodes && this.nodes > this.maxNodes) this.stop = true;
      }
      return this.stop;
    }

    // ---------------------------------------------------------------- 四追い（VCF）
    // 手番側が四を打ち続けて勝てるか。勝てるなら this.vline に手順（内部の番号）を残す
    vcf(depth, ply) {
      this.nodes++; this.vnodes++;
      const me = this.side, op = 3 - me;
      if (this.S5[me].n) { this.vline[ply] = this.S5[me].list[0]; this.vlen = ply + 1; this.vwin = ply + 1; return true; }
      if (depth <= 0 || this.vnodes > this.vmax) return false;
      let forced = -1;
      if (this.S5[op].n) {
        if (this.S5[op].n > 1) return false;
        forced = this.S5[op].list[0];
        if (!this.S4[me].has(forced) || !this.legal(forced, me)) return false;
      }
      // 失敗を覚えておく表
      const h = (this.hlo >>> 0) & 0xffff;
      if (this.vcfKey[h] === (this.hhi | 1) && this.vcfTT[h] >= depth) return false;
      const list = this.vList(ply);
      let n = 0;
      if (forced >= 0) list[n++] = forced;
      else { const s = this.S4[me]; for (let k = 0; k < s.n; k++) list[n++] = s.list[k]; }
      // 止められない四・四三を先に
      for (let a = 0; a < n; a++) {
        let best = a, bs = -1;
        for (let b = a; b < n; b++) { const sc = this.vcfOrder(list[b], me); if (sc > bs) { bs = sc; best = b; } }
        const t = list[a]; list[a] = list[best]; list[best] = t;
        const m = list[a];
        if (!this.legal(m, me)) continue;
        this.make(m);
        let win = false;
        const fv = this.S5[me];
        if (fv.n >= 2) { win = true; this.vlen = ply + 1; this.vwin = ply + 3; }
        else if (fv.n === 1) {
          const f = fv.list[0];
          if (op === BLACK && this.forbiddenB(f)) { win = true; this.vlen = ply + 1; this.vwin = ply + 3; }
          else {
            this.make(f);
            this.vline[ply + 1] = f;
            win = this.vcf(depth - 1, ply + 2);
            this.unmake();
          }
        }
        this.unmake();
        if (win) { this.vline[ply] = m; return true; }
        if (this.vnodes > this.vmax) return false;
      }
      this.vcfKey[h] = this.hhi | 1; this.vcfTT[h] = depth;
      return false;
    }
    vcfOrder(i, me) {
      const f = me === BLACK ? this.FB[this.cbB[i]] : this.FW[this.cbW[i]];
      return (f & FL_WIN ? 4 : 0) + (f & FL_THREE ? 2 : 0) + (this.near[i] > 1 ? 1 : 0);
    }
    tmpList(ply) {
      return this.lists[ply];
    }
    vList(ply) {
      return this.vlists[ply];
    }
    // 手番側が何もしなかったら相手に四追いがあるか（あれば this.vline に相手の手順）
    threatVCF(depth, vmax) {
      const me = this.side, op = 3 - me;
      if (!this.S4[op].n) return false;
      this.side = op; this.hlo ^= ZS_LO; this.hhi ^= ZS_HI;
      this.vnodes = 0; this.vmax = vmax;
      if (!this.vline) this.vline = new Int16Array(512);
      const r = this.vcf(depth, 0);
      this.side = me; this.hlo ^= ZS_LO; this.hhi ^= ZS_HI;
      return r;
    }
    // 三と四で攻め続けて勝てるか（VCT）。三には相手のすべての防ぎ（相手の四での反撃を含む）を読む
    vct(depth, ply) {
      this.nodes++; this.tnodes++;
      const me = this.side, op = 3 - me;
      if (this.S5[me].n) return true;
      if (this.tnodes > this.tmax) return false;
      // まず四追い
      if (this.S4[me].n) {
        const sv = this.vnodes, sm = this.vmax;
        this.vnodes = 0; this.vmax = 150;
        const r = this.vcf(10, 0);
        this.tnodes += this.vnodes;
        this.vnodes = sv; this.vmax = sm;
        if (r) { if (ply === 0) this.vctMove = this.vline[0]; return true; }
      }
      if (depth <= 0) return false;
      const h = ((this.hlo >>> 0) ^ 0x5bd1) & 0xffff;
      if (this.vctKey[h] === (this.hhi | 1) && this.vctTT[h] >= depth) return false;
      let forced = -1;
      if (this.S5[op].n) {
        if (this.S5[op].n > 1) return false;
        forced = this.S5[op].list[0];
        if (!this.legal(forced, me)) return false;
      }
      const list = this.tList(ply);
      let n = 0;
      if (forced >= 0) list[n++] = forced;
      else {
        let t = this.S4[me]; for (let k = 0; k < t.n; k++) list[n++] = t.list[k];
        t = this.S3[me]; for (let k = 0; k < t.n; k++) if (!this.S4[me].has(t.list[k])) list[n++] = t.list[k];
      }
      for (let a = 0; a < n; a++) {
        const m = list[a];
        if (!this.legal(m, me)) continue;
        this.make(m);
        let win = false;
        const fv = this.S5[me];
        if (fv.n >= 2) win = true;
        else if (fv.n === 1) {
          const f = fv.list[0];
          if (op === BLACK && this.forbiddenB(f)) win = true;
          else { this.make(f); win = this.vct(depth - 1, ply + 2); this.unmake(); }
        } else if (this.winMove(me) >= 0) {
          // 三: 相手の防ぎをすべて読む
          const dl = this.tList(ply + 1), ds = this.tmpScores(ply + 1);
          const g = this.genMoves(Math.min(ply + 1, 120), -1, dl, ds);
          win = g.n > 0;
          for (let b = 0; b < g.n && win; b++) {
            this.make(dl[b]);
            win = this.vct(depth - 1, ply + 2);
            this.unmake();
            if (this.tnodes > this.tmax) win = false;
          }
          if (!g.n) win = true;
        }
        this.unmake();
        if (win) { if (ply === 0) this.vctMove = m; return true; }
        if (this.tnodes > this.tmax) return false;
      }
      this.vctKey[h] = this.hhi | 1; this.vctTT[h] = depth;
      return false;
    }
    tList(ply) {
      return this.tlists[ply];
    }
    findVCT(depth = 8, tmax = 30000) {
      this.tnodes = 0; this.tmax = tmax; this.vctMove = -1;
      if (!this.vctTT) { this.vctTT = new Int32Array(1 << 16); this.vctKey = new Int32Array(1 << 16); }
      if (!this.pvLen) { this.pvt = new Int16Array(128 * 64); this.pvLen = new Uint8Array(128); }
      if (!this.vline) this.vline = new Int16Array(512);
      return this.vct(depth, 0) ? this.vctMove : -1;
    }
    // 手番側の四追いを調べる（vmax 局面まで）
    findVCF(depth = 20, vmax = 20000) {
      this.vnodes = 0; this.vmax = vmax; this.vline = this.vline || new Int16Array(512); this.vlen = 0;
      return this.vcf(depth, 0) ? Array.from(this.vline.slice(0, this.vlen)) : null;
    }

    // ---------------------------------------------------------------- 置換表
    ttProbe() {
      const tt = this.tt, x = ((this.hlo >>> 0) & tt.mask) * 2;
      const k = tt.a[x], d = tt.a[x + 1];
      if ((k ^ d) !== this.hhi) return 0;
      return d === 0 ? 0 : d;
    }
    ttStore(score, move, depth, flag) {
      const tt = this.tt, x = ((this.hlo >>> 0) & tt.mask) * 2;
      const old = tt.a[x + 1];
      if ((tt.a[x] ^ old) === this.hhi && ((old >>> 2) & 31) > depth && flag !== TT_EXACT) return;
      const d = ((score & 0xffff) << 16) | ((move & 511) << 7) | ((Math.max(0, Math.min(31, depth)) & 31) << 2) | flag;
      tt.a[x + 1] = d; tt.a[x] = this.hhi ^ d;
    }

    // ---------------------------------------------------------------- 候補手
    // 普通の局面: 石の近く（2マス以内）と、自分・相手の四・三になる点。手の順番の点数で並べる
    genMoves(ply, ttMove, list, scores) {
      const me = this.side, op = 3 - me, gen = ++this.markGen, mk = this.mark;
      if (this.nn && this.nnPol) this.nSync();
      let n = 0;
      const add = i => { if (mk[i] !== gen && this.c[i] === EMPTY) { mk[i] = gen; list[n++] = i; } };
      const oppWin = this.S5[op].n > 0 || this.winMove(op) >= 0;
      if (this.S5[op].n) {
        // 相手に四がある: 止めるしかない
        const s = this.S5[op]; for (let k = 0; k < s.n; k++) add(s.list[k]);
      } else if (oppWin) {
        // 相手に三がある: 自分の四か、相手の止められない四・四になる点を防ぐ手だけ
        let s = this.S4[me]; for (let k = 0; k < s.n; k++) add(s.list[k]);
        s = this.SW[op]; for (let k = 0; k < s.n; k++) add(s.list[k]);
        s = this.S4[op]; for (let k = 0; k < s.n; k++) add(s.list[k]);
      } else {
        const s = this.cand; for (let k = 0; k < s.n; k++) add(s.list[k]);
        for (const col of [me, op]) {
          let t = this.S4[col]; for (let k = 0; k < t.n; k++) add(t.list[k]);
          t = this.S3[col]; for (let k = 0; k < t.n; k++) add(t.list[k]);
        }
        if (!n) add(P2I[CENTER]);
      }
      const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1], hist = this.history;
      let m = 0;
      for (let a = 0; a < n; a++) {
        const i = list[a];
        if (me === BLACK && this.forbiddenB(i)) continue;
        let sc = this.policy(i) * 16 + (hist[me * SIZE + i] >> 4);
        if (this.hNoise) { let x = this.hSeed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.hSeed = x; sc += (x >>> 0) % this.hNoise; }
        if (i === ttMove) sc = 1 << 30; else if (i === k1) sc += 4000; else if (i === k2) sc += 2000;
        list[m] = i; scores[m] = sc; m++;
      }
      // 点数の高い順（挿入ソート。数十手なので十分速い）
      for (let a = 1; a < m; a++) {
        const i = list[a], s = scores[a];
        let b = a - 1;
        while (b >= 0 && scores[b] < s) { list[b + 1] = list[b]; scores[b + 1] = scores[b]; b--; }
        list[b + 1] = i; scores[b + 1] = s;
      }
      return { n: m, defend: oppWin };
    }

    // 読まずに、手の順番の上位 k 手から1つ選ぶ（「やさしい」用）
    randomTop(k) {
      const list = new Int16Array(SIZE), sc = new Int32Array(SIZE);
      if (!this.pvLen) { this.pvt = new Int16Array(128 * 64); this.pvLen = new Uint8Array(128); }
      const g = this.genMoves(0, -1, list, sc);
      if (!g.n) return -1;
      return I2P[list[Math.floor(this.rand() * Math.min(k, g.n))]];
    }

    // ---------------------------------------------------------------- αβ
    search(depth, alpha, beta, ply, pv) {
      this.nodes++;
      if (ply > this.selDepth) this.selDepth = ply;
      this.pvLen[ply] = 0;
      if (this.stopped()) return 0;
      const me = this.side, op = 3 - me;
      if (this.S5[me].n) { if (pv) { this.pvt[ply * 64] = this.S5[me].list[0]; this.pvLen[ply] = 1; } return WIN - ply - 1; }
      const o5 = this.S5[op];
      if (o5.n) {
        if (o5.n > 1) return -(WIN - ply - 2);
        const b = o5.list[0];
        if (!this.legal(b, me)) return -(WIN - ply - 2);
        if (ply >= 120) return this.evaluate();
        this.make(b);
        const v = -this.search(depth, -beta, -alpha, ply + 1, pv);
        this.unmake();
        if (pv && !this.stop) { this.pvt[ply * 64] = b; this.copyPV(ply); }
        return v;
      }
      if (this.winMove(me) >= 0) { if (pv) { this.pvt[ply * 64] = this.winMove(me); this.pvLen[ply] = 1; } return WIN - ply - 3; }
      if (this.nmoves >= N * N) return 0;
      if (depth <= 0 || ply >= 120) return this.quiesce(alpha, beta, ply);
      // 置換表
      const e = this.ttProbe();
      let ttMove = -1;
      if (e) {
        ttMove = (e >>> 7) & 511;
        const ed = (e >>> 2) & 31, flag = e & 3;
        let sc = e >> 16;
        if (sc >= WIN_MIN) sc -= ply; else if (sc <= -WIN_MIN) sc += ply;
        if (!pv && ed >= depth) {
          if (flag === TT_EXACT || (flag === TT_LOWER && sc >= beta) || (flag === TT_UPPER && sc <= alpha)) return sc;
        }
        if (this.c[ttMove] !== EMPTY) ttMove = -1;
      }
      const list = this.tmpList(ply), scores = this.tmpScores(ply);
      const g = this.genMoves(ply, ttMove, list, scores);
      if (!g.n) return g.defend ? -(WIN - ply - 4) : 0;
      // 普通の局面は上位だけ読む（深いほど広く）
      const width = g.defend ? g.n : Math.min(g.n, this.width(depth, pv));
      let best = -INF, bestMove = list[0], a0 = alpha;
      for (let k = 0; k < width; k++) {
        const m = list[k];
        this.make(m);
        let v;
        if (k === 0) v = -this.search(depth - 1, -beta, -alpha, ply + 1, pv);
        else {
          let red = 0;
          if (depth >= this.lmrD && k >= this.lmrK && !g.defend) red = k >= this.lmrK2 ? 2 : 1;
          v = -this.search(depth - 1 - red, -alpha - 1, -alpha, ply + 1, false);
          if (v > alpha && (red || (pv && v < beta))) v = -this.search(depth - 1, -beta, -alpha, ply + 1, pv);
        }
        this.unmake();
        if (this.stop) return 0;
        if (v > best) {
          best = v; bestMove = m;
          if (pv) { this.pvt[ply * 64] = m; this.copyPV(ply); }
          if (v > alpha) {
            alpha = v;
            if (v >= beta) {
              if (m !== this.killers[ply * 2]) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
              this.history[me * SIZE + m] += depth * depth;
              break;
            }
          }
        }
      }
      let st = best;
      if (st >= WIN_MIN) st += ply; else if (st <= -WIN_MIN) st -= ply;
      this.ttStore(st, bestMove, depth, best >= beta ? TT_LOWER : best > a0 ? TT_EXACT : TT_UPPER);
      return best;
    }
    width(depth, pv) { return Math.min(this.wMax, (pv ? this.wPV : this.wBase) + depth * this.wMul); }
    tmpScores(ply) {
      return this.slists[ply];
    }
    copyPV(ply) {
      const t = this.pvt, L = this.pvLen;
      const n = ply + 1 < 127 ? L[ply + 1] : 0;
      for (let k = 0; k < n && k < 62; k++) t[ply * 64 + 1 + k] = t[(ply + 1) * 64 + k];
      L[ply] = Math.min(63, n + 1);
      if (ply + 1 < 127) L[ply + 1] = 0;
    }
    quiesce(alpha, beta, ply) {
      if (this.pvLen) this.pvLen[ply] = 0;
      const me = this.side, op = 3 - me;
      // 四追いがあれば勝ち
      if (this.S4[me].n && this.qvcf) {
        this.vnodes = 0; this.vmax = this.qvcf;
        if (!this.vline) this.vline = new Int16Array(512);
        if (this.vcf(this.qvcfDepth, 0)) return WIN - ply - this.vwin;
      }
      // 相手に四追いがある: 打ち切らずに、その手順の点か自分の四で防ぐ手を1手読む（1本の道で2回まで）
      if (this.qthreat && this.extUsed < 2 && ply < 110 && this.S4[op].n && this.threatVCF(this.qvcfDepth, this.qthreat)) {
        const defs = this.vList(127), gen = ++this.markGen, mk = this.mark;
        let n = 0;
        for (let k = 0; k < this.vlen; k++) { const i = this.vline[k]; if (i >= 0 && this.c[i] === EMPTY && mk[i] !== gen) { mk[i] = gen; defs[n++] = i; } }
        const s4 = this.S4[me];
        for (let k = 0; k < s4.n; k++) { const i = s4.list[k]; if (mk[i] !== gen) { mk[i] = gen; defs[n++] = i; } }
        const mine = Array.from(defs.slice(0, n)).filter(i => this.legal(i, me));
        if (!mine.length) return -12000;
        this.extUsed++;
        let best = -INF;
        for (const m of mine) {
          this.make(m);
          const v = -this.search(0, -beta, -alpha, ply + 1, false);
          this.unmake();
          if (this.stop) { this.extUsed--; return 0; }
          if (v > best) { best = v; if (v > alpha) { alpha = v; if (v >= beta) break; } }
        }
        this.extUsed--;
        return best;
      }
      return this.evaluate();
    }

    // ---------------------------------------------------------------- 考える（外向き）
    // opts: { timeMs, maxDepth, maxNodes, noise（ルートの点数に足す揺らぎ）, onInfo, jobId, helper }
    think(opts = {}) {
      const t0 = Date.now();
      this.nodes = 0; this.tick = 0; this.stop = false; this.selDepth = 0;
      this.deadline = opts.timeMs ? t0 + opts.timeMs : 0;
      this.maxNodes = opts.maxNodes || 0;
      this.jobId = opts.jobId || 0;
      this.qvcf = opts.qvcf ?? 400; this.qvcfDepth = opts.qvcfDepth ?? 8; this.qthreat = opts.qthreat ?? 0; this.extUsed = 0;
      // ネットの使い方: 1 = 評価と手の順番、2 = 手の順番だけ、3 = 評価だけ
      const nm = opts.nnMode || 1; this.nnEval = nm !== 2; this.nnPol = nm !== 3;
      // 探索の幅・削減（調整用）
      this.wBase = opts.wBase ?? 8; this.wPV = opts.wPV ?? 12; this.wMul = opts.wMul ?? 2; this.wMax = opts.wMax ?? 40;
      this.hNoise = opts.helper ? (opts.hNoise ?? 1600) : 0;
      this.lmrD = opts.lmrD ?? 3; this.lmrK = opts.lmrK ?? 3; this.lmrK2 = opts.lmrK2 ?? 10; this.asp = opts.asp ?? 60; this.tSoft = opts.tSoft ?? 0.55;
      this.pvt = this.pvt || new Int16Array(128 * 64); this.pvLen = this.pvLen || new Uint8Array(128);
      this.history.fill(0); this.killers.fill(-1); this.rootBest = -1;
      const me = this.side, op = 3 - me;
      const done = (i, score, depth, pv, extra) => ({ move: i >= 0 ? I2P[i] : -1, score, depth, pv: pv.map(x => I2P[x]), nodes: this.nodes, time: Date.now() - t0, ...extra });
      // 1手目
      if (this.nmoves === 0 && opts.centerOnly !== false) return done(P2I[CENTER], 0, 0, [P2I[CENTER]], { forced: true });
      // すぐ勝てる・止めるしかない
      if (this.S5[me].n) return done(this.S5[me].list[0], WIN - 1, 1, [this.S5[me].list[0]], { forced: true });
      const o5 = this.S5[op];
      if (o5.n === 1 && this.legal(o5.list[0], me)) {
        // 止める手は1つだけ。形勢を知るために少しだけ読む
        const b = o5.list[0];
        if (!opts.analyze) return done(b, 0, 0, [b], { forced: true });
      }
      // 四追いで勝てるか
      const vn = opts.vcfNodes ?? 100000;
      const vc = vn > 0 ? this.findVCF(opts.vcfDepth || 30, vn) : null;
      if (vc && vc.length) return done(vc[0], WIN - this.vwin, vc.length, vc, { vcf: true });
      // 三と四で勝てるか（強い CPU・検討のとき）
      if (opts.vctNodes) {
        const m = this.findVCT(opts.vctDepth || 10, opts.vctNodes);
        if (m >= 0) return done(m, WIN - 40, 1, [m], { vct: true });
      }
      // 反復深化
      const list0 = new Int16Array(SIZE), sc0 = new Int32Array(SIZE);
      let best = { move: -1, score: 0, depth: 0, pv: [] };
      const maxDepth = opts.maxDepth || 30;
      let prevScore = 0;
      for (let depth = 1 + (opts.helper ? (opts.helper & 1) : 0); depth <= maxDepth; depth++) {
        let r;
        if (depth >= 4 && !isWin(prevScore)) {
          let lo = prevScore - this.asp, hi = prevScore + this.asp;
          for (;;) {
            r = this.root(depth, lo, hi, opts, list0, sc0);
            if (this.stop) break;
            if (r.score <= lo) lo = Math.max(-INF, lo - 240);
            else if (r.score >= hi) hi = Math.min(INF, hi + 240);
            else break;
            if (lo <= -INF + 1 && hi >= INF - 1) break;
          }
        } else r = this.root(depth, -INF, INF, opts, list0, sc0);
        if (this.stop && best.move >= 0) {
          // 途中で止まった深さは、最初の手を読み終えて前より良いときだけ使う
          if (r && r.complete1 && r.move >= 0 && r.score > best.score) best = Object.assign({}, r, { depth: depth - 1 });
          break;
        }
        if (r.move >= 0) best = Object.assign({}, r, { depth });
        prevScore = r.score;
        if (opts.onInfo) opts.onInfo(done(best.move, best.score, best.depth, best.pv, { sel: this.selDepth }));
        if (isWin(r.score) && depth >= 2) break;
        if (this.deadline && Date.now() - t0 > (opts.timeMs || 0) * this.tSoft) break;
        if (r.only) break;
      }
      if (best.move < 0) {
        // 打てる手が読みに出てこない（止める点が禁手で負けが決まっているときなど）: 打てる手ならどれでも
        const g = this.genMoves(0, -1, list0, sc0);
        let m = g.n ? list0[0] : -1;
        for (let k = 0; m < 0 && k < this.cand.n; k++) if (this.legal(this.cand.list[k], me)) m = this.cand.list[k];
        for (let p = 0; m < 0 && p < N * N; p++) if (this.legal(P2I[p], me)) m = P2I[p];
        best.move = m; best.pv = m >= 0 ? [m] : [];
        if (m >= 0 && !best.depth) best.score = this.S5[op].n ? -(WIN - 2) : best.score;
      }
      return done(best.move, best.score, best.depth, best.pv, { sel: this.selDepth });
    }
    root(depth, alpha, beta, opts, list, scores) {
      const g = this.genMoves(0, this.rootBest ?? -1, list, scores);
      if (!g.n) return { move: -1, score: -(WIN - 4), pv: [] };
      const n = g.defend ? g.n : Math.min(g.n, Math.max(this.width(depth, true) + 6, 16));
      let best = -INF, bestMove = -1, pv = [], complete1 = false;
      const noise = opts.noise || 0;
      for (let k = 0; k < n; k++) {
        const m = list[k];
        this.make(m);
        let v;
        if (k === 0) v = -this.search(depth - 1, -beta, -alpha, 1, true);
        else {
          v = -this.search(depth - 1, -alpha - 1, -alpha, 1, false);
          if (v > alpha && v < beta && !this.stop) v = -this.search(depth - 1, -beta, -alpha, 1, true);
        }
        this.unmake();
        if (this.stop) break;
        if (k === 0) complete1 = true;
        const vn = noise && !isWin(v) ? v + Math.round((this.rand() - 0.5) * 2 * noise) : v;
        if (vn > best) {
          best = vn; bestMove = m;
          pv = [m];
          const L = this.pvLen[1];
          for (let t = 0; t < L; t++) pv.push(this.pvt[64 + t]);
          if (vn > alpha) alpha = vn;
          if (vn >= beta) break;
        }
      }
      if (bestMove >= 0) this.rootBest = bestMove;
      return { move: bestMove, score: best, pv, complete1, only: g.n === 1 };
    }
  }

  // ------------------------------------------------------------------ 形勢（評価値 → 勝率）
  const winRate = (s, scale = 400) => (Math.abs(s) >= WIN_MIN ? (s > 0 ? 1 : 0) : 1 / (1 + Math.exp(-s / scale)));

  Object.assign(R, {
    RenjuAIVersion: 1,
    LINE_EXACT, LINE_FREE, COMBO, COMBO_CODES, NCOMBO, FLAGS_EXACT, FLAGS_FREE, PNAME, NP, POW3, slotOf,
    FL_FIVE, FL_FOUR, FL_WIN, FL_THREE, FL_FSURE, FL_FMAYBE,
    DEAD, B1, F1, B2, F2, B3, F3, B4, F4, F44, F5, OL,
    Engine, ISet, makeTT, defaultWeights, prepareWeights, prepareNN, MLP_OUT, cheb, w8B, w8W, NN_POOL, NN_SCALE, WIN, WIN_MIN, INF, isWin, winRate,
  });
  return R;
}
if (typeof module !== 'undefined' && module.exports) module.exports = RenjuAI;
