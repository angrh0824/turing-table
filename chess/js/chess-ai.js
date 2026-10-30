/* チェスの AI: αβ探索（PVS・反復深化・置換表・静止探索・Null Move・LMR・枝刈り）＋自己対局で学んだ評価（小さなニューラルネット）
 *
 *   const C = ChessCore({}); ChessAI(C);
 *   const net = C.loadNet(CHESS_WEIGHTS);          // 学習した重み（なければ null = 評価はいつも 0。何も知らない第0世代）
 *   const s = new C.Searcher(net, { ttBits: 20 });
 *   const r = s.think(pos, { timeMs: 1000 });       // → { move, score（手番から見た評価値）, depth, pv, nodes, time }
 *
 * 評価のネット（NNUE と同じ形）: 入力 = 「どちらから見るか」ごとに、駒の種類（味方/相手×6）×マス（64）＝768 の 0/1
 *   → 隠れ層 H（両方の視点で同じ重み。指すたびに差分で更新）→ 手番の側・相手の側を並べて 2H → 出力 1
 *   出力 × scale（400）が評価値。勝率 = 1 / (1 + e^(−評価値/400)) になるよう学習する
 *   人が作った評価（駒の価値・マスの表など）は入っていない。重みはすべて自己対局の結果から学ぶ
 */
function ChessAI(C) {
  'use strict';
  const { Position, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, F_EP, F_CASTLE } = C;
  const MATE = 30000, MATE_BOUND = 29000, INF = 32000, NONE = -32700;
  const MAXPLY = 100;
  const B_DIR = C.B_DIR, R_DIR = C.R_DIR, N_OFF = C.N_OFF, K_OFF = C.K_OFF;
  const sq64 = s => ((s >> 4) << 3) | (s & 7);
  const winRate = s => 1 / (1 + Math.exp(-s / 400));
  const isMate = s => Math.abs(s) >= MATE_BOUND;

  // ------------------------------------------------------------------ ネットの重み（weights.js の base64 を読む）
  function b64(s) {
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') { const b = Buffer.from(s, 'base64'); const u = new Uint8Array(b.length); u.set(b); return u; }
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function loadNet(w) {
    const n = w && (w.net || w);
    if (!n || !n.w1) return null;
    if (n.W1) return n; // すでに読んだもの（ワーカーへ渡したもの）
    const KB = n.KB || 1;
    const net = {
      H: n.H, KB, mirror: n.mirror ? 1 : 0, OB: n.OB || 1, act: n.act === 'screlu' ? 1 : 0,
      QA: n.QA || 255, QB: n.QB || 64, scale: n.scale || 400,
      kbMap: new Int8Array(n.kbMap || new Array(64).fill(0)),
      W1: new Int16Array(b64(n.w1).buffer), B1: new Int16Array(b64(n.b1).buffer),
      W2: new Int16Array(b64(n.w2).buffer), B2: new Int32Array(b64(n.b2).buffer),
    };
    if (net.W1.length !== KB * 768 * net.H || net.W2.length !== net.OB * 2 * net.H) throw new Error('重みの大きさが合いません');
    return net;
  }
  // 浮動小数のネット（学習用）を、整数のネットにする
  function quantize(f) {
    const QA = f.QA || 255, QB = f.QB || 64, H = f.H;
    const r = (x, q, lim) => Math.max(-lim, Math.min(lim, Math.round(x * q)));
    const W1 = new Int16Array(f.W1.length), B1 = new Int16Array(H), W2 = new Int16Array(f.W2.length), B2 = new Int32Array(f.B2.length);
    for (let i = 0; i < W1.length; i++) W1[i] = r(f.W1[i], QA, 32767);
    for (let i = 0; i < H; i++) B1[i] = r(f.B1[i], QA, 32767);
    for (let i = 0; i < W2.length; i++) W2[i] = r(f.W2[i], QB, 32767);
    for (let i = 0; i < B2.length; i++) B2[i] = Math.round(f.B2[i] * QA * QB);
    return { H, KB: f.KB || 1, mirror: f.mirror ? 1 : 0, OB: f.OB || 1, act: f.act === 'screlu' || f.act === 1 ? 1 : 0, QA, QB, scale: f.scale || 400, kbMap: new Int8Array(f.kbMap || new Array(64).fill(0)), W1, B1, W2, B2 };
  }
  // 視点 c から見たキングの位置で決まる「左右の鏡映」と「キングの区分」
  function kingFlip(net, c, ksq88) {
    let k = sq64(ksq88);
    if (c) k ^= 56;
    const flip = net.mirror && (k & 7) < 4 ? 7 : 0;
    return [flip, net.KB > 1 ? net.kbMap[k ^ flip] : 0];
  }
  // 入力の番号（視点 c、駒 p、マス s88）
  function featIndex(net, c, p, s88, flip, bucket) {
    const s = sq64(s88) ^ (c ? 56 : 0) ^ flip;
    return ((bucket * 12 + ((p >> 3) === c ? 0 : 6) + (p & 7) - 1) << 6) + s;
  }
  // 出力の区分（盤の駒の数で分ける）
  function outBucket(net, pos) {
    if (net.OB <= 1) return 0;
    const c = pos.cnt;
    let n = 0;
    for (let i = 1; i < 15; i++) n += c[i];
    return Math.min(net.OB - 1, ((n - 2) * net.OB / 31) | 0);
  }

  // ------------------------------------------------------------------ 置換表（ワーカーどうしで共有できる）
  // 1件 = 32ビット×4: [鍵 ^ 中身, 手 | 種類<<21 | 世代<<23, 評価値 | 深さ<<16, 静的評価]
  function makeTT(bits, shared) {
    const n = (1 << bits) * 4;
    return shared && typeof SharedArrayBuffer !== 'undefined' ? new Int32Array(new SharedArrayBuffer(n * 4)) : new Int32Array(n);
  }
  const B_EXACT = 3, B_LOWER = 2, B_UPPER = 1;

  // 駒の価値（取る手の並べ替え・SEE 用）。学習したネットから測った値を weights.js に入れておく。なければ全部同じ
  const DEFAULT_VALUES = [0, 100, 100, 100, 100, 100, 10000];

  // LMR の減らし方（手の順番と深さで）
  const LMR = [];
  for (let d = 0; d < 64; d++) { LMR.push(new Int8Array(64)); for (let m = 1; m < 64; m++) LMR[d][m] = d && m ? Math.floor(0.75 + Math.log(d) * Math.log(m) / 2.25) : 0; }

  // ------------------------------------------------------------------ WebAssembly SIMD の小さな計算部品（評価の足し引きと出力）
  // 16ビット×8 をまとめて計算する。命令の並びをここで組み立てる（外から持ってきたバイナリは使わない）。使えない環境では JavaScript で計算する
  let simdMod;
  function simdKernel() {
    if (simdMod !== undefined) return simdMod;
    simdMod = null;
    try {
      if (typeof WebAssembly === 'undefined') return null;
      const u = n => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
      const sl = n => { const o = []; for (;;) { const b = n & 127; n >>= 7; if ((n === 0 && !(b & 64)) || (n === -1 && (b & 64))) { o.push(b); return o; } o.push(b | 128); } };
      const vec = items => [...u(items.length), ...[].concat(...items)];
      const name = t => [t.length, ...Array.from(t, c => c.charCodeAt(0))];
      const sect = (id, b) => [id, ...u(b.length), ...b];
      const I32 = 0x7f, V128 = 0x7b;
      const get = i => [0x20, ...u(i)], set = i => [0x21, ...u(i)], add = [0x6a];
      const op = n => [0xfd, ...u(n)];
      const LOAD = [0xfd, 0x00, 0x00, 0x00], STORE = [0xfd, 0x0b, 0x00, 0x00];
      const ADD16 = op(142), SUB16 = op(145), MIN16 = op(150), MAX16 = op(152), SPLAT16 = op(16), ADD32 = op(174), DOT = op(186), LANE32 = op(27);
      const at = (b, i) => [...get(b), ...get(i), ...add];
      // for (i = 0; i < n; i += 16) body
      const loop = (i, n, body) => [0x02, 0x40, 0x03, 0x40, ...get(i), ...get(n), 0x4f, 0x0d, 0x01, ...body, ...get(i), 0x41, ...sl(16), ...add, ...set(i), 0x0c, 0x00, 0x0b, 0x0b];
      const fn = (locals, code) => { const b = [...vec(locals), ...code, 0x0b]; return [...u(b.length), ...b]; };
      // u2(d, s, a1, s1, n): d = s + a1 − s1 ／ u3: − s2 も ／ u4: + a2 − s2 も（キャスリング）
      const u2 = fn([[1, I32]], loop(5, 4, [...at(0, 5), ...at(1, 5), ...LOAD, ...at(2, 5), ...LOAD, ...ADD16, ...at(3, 5), ...LOAD, ...SUB16, ...STORE]));
      const u3 = fn([[1, I32]], loop(6, 5, [...at(0, 6), ...at(1, 6), ...LOAD, ...at(2, 6), ...LOAD, ...ADD16, ...at(3, 6), ...LOAD, ...SUB16, ...at(4, 6), ...LOAD, ...SUB16, ...STORE]));
      const u4 = fn([[1, I32]], loop(7, 6, [...at(0, 7), ...at(1, 7), ...LOAD, ...at(2, 7), ...LOAD, ...ADD16, ...at(3, 7), ...LOAD, ...SUB16, ...at(4, 7), ...LOAD, ...ADD16, ...at(5, 7), ...LOAD, ...SUB16, ...STORE]));
      // ev(o1, o2, w, n, qa): Σ clamp(acc1, 0, qa)·w[i] + Σ clamp(acc2, 0, qa)·w[n + i]（32ビットで足す）
      const half = (o, wAddr) => [...get(6), ...at(o, 5), ...LOAD, ...get(8), ...MAX16, ...get(7), ...MIN16, ...wAddr, ...LOAD, ...DOT, ...ADD32, ...set(6)];
      const ev = fn([[1, I32], [3, V128]], [...get(4), ...SPLAT16, ...set(7),
        ...loop(5, 3, [...half(0, at(2, 5)), ...half(1, [...get(2), ...get(3), ...add, ...get(5), ...add])]),
        ...get(6), ...LANE32, 0, ...get(6), ...LANE32, 1, ...add, ...get(6), ...LANE32, 2, ...add, ...get(6), ...LANE32, 3, ...add]);
      const ft = (np, res) => [0x60, ...vec(new Array(np).fill([I32])), ...vec(res ? [[I32]] : [])];
      const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0,
        ...sect(1, vec([ft(5, 0), ft(6, 0), ft(7, 0), ft(5, 1)])),
        ...sect(2, vec([[...name('e'), ...name('m'), 0x02, 0x00, ...u(1)]])),
        ...sect(3, vec([[0], [1], [2], [3]])),
        ...sect(7, vec([[...name('u2'), 0x00, 0], [...name('u3'), 0x00, 1], [...name('u4'), 0x00, 2], [...name('ev'), 0x00, 3]])),
        ...sect(10, vec([u2, u3, u4, ev]))]);
      if (!WebAssembly.validate(bytes)) return null;
      simdMod = new WebAssembly.Module(bytes);
    } catch (e) { simdMod = null; }
    return simdMod;
  }

  class Searcher {
    constructor(net, opts = {}) {
      this.net = net || null;
      this.H = this.net ? this.net.H : 0;
      this.tt = opts.sharedTT || makeTT(opts.ttBits || 20, false);
      this.ttMask = (this.tt.length >> 2) - 1;
      this.stopFlag = opts.stopFlag ? new Int32Array(opts.stopFlag) : null;
      this.helper = opts.helper || 0;
      this.values = Int32Array.from(opts.values || DEFAULT_VALUES);
      this.age = 0;
      this.noise = 0; this.salt = 0;
      // 枝刈りの幅（評価値の単位）。学習したポーンの価値に比例させる（世代が進んで評価の目盛りが変わっても同じ意味になるように。
      // 第12世代で、ポーン 210 のとき 2.1 倍にすると、同じ局面数で Elo +41±23）。lmpBase は手の数なのでそのまま
      const sc = Math.max(0.5, Math.min(4, (this.values[PAWN] || 100) / 100));
      const base = { rfp: 80, fut: 90, futBase: 80, seeCap: 90, seeQuiet: 60, nmpDiv: 200, aspiration: 22, delta: 160 };
      this.P = Object.assign({ lmpBase: 3, lmrBase: 0.75, lmrDiv: 2.25, nmpR: 3, nmpD: 3 }, opts.params || Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * sc)])));
      // LMR の減らし方の表（既定の値なら共通の表を使う）
      this.lmr = this.P.lmrBase === 0.75 && this.P.lmrDiv === 2.25 ? LMR : LMR.map((row, d) => row.map((_, m) => (d && m ? Math.floor(this.P.lmrBase + Math.log(d) * Math.log(m) / this.P.lmrDiv) : 0)));
      const H = this.H;
      this.acc = new Int32Array((MAXPLY + 2) * 2 * Math.max(1, H));
      this.wk = null; this.accOff = 0; this.w2Off = 0;
      const mod = this.net && !this.net.act && H % 8 === 0 && opts.simd !== false ? simdKernel() : null;
      if (mod) {
        // WebAssembly のメモリ: [入力の重み W1][各手数の層（16ビット）][出力の重み W2]
        const net = this.net, accLen = (MAXPLY + 2) * 2 * H, al = x => (x + 15) & ~15;
        const accOff = al(net.W1.length * 2), w2Off = al(accOff + accLen * 2), total = w2Off + net.W2.length * 2 + 16;
        const mem = new WebAssembly.Memory({ initial: Math.ceil(total / 65536) });
        const inst = new WebAssembly.Instance(mod, { e: { m: mem } });
        new Int16Array(mem.buffer, 0, net.W1.length).set(net.W1);
        new Int16Array(mem.buffer, w2Off, net.W2.length).set(net.W2);
        this.acc = new Int16Array(mem.buffer, accOff, accLen);
        this.wk = inst.exports; this.accOff = accOff; this.w2Off = w2Off;
      }
      this.kFlip = new Int8Array((MAXPLY + 2) * 2); this.kBucket = new Int8Array((MAXPLY + 2) * 2);
      this.rec = new Int32Array((MAXPLY + 2) * 9); this.dirty = new Uint8Array(MAXPLY + 2); // 差分の記録と「まだ作っていない」印
      this.moves = new Int32Array(MAXPLY * 256); this.scores = new Int32Array(MAXPLY * 256);
      this.killers = new Int32Array(MAXPLY * 2);
      this.hist = new Int32Array(2 * 64 * 64);
      this.counter = new Int32Array(16 * 64);
      this.evalStack = new Int32Array(MAXPLY + 2);
      this.moveStack = new Int32Array(MAXPLY + 2);
      this.nullOk = new Uint8Array(MAXPLY + 2);
      this.pv = new Int32Array(MAXPLY * MAXPLY); this.pvLen = new Int32Array(MAXPLY);
      this.quiets = new Int32Array(MAXPLY * 64);
      this.nodes = 0; this.stop = false;
      // 探索中に使う値（形が途中で変わると遅くなるので、ここで全部作っておく）
      this.pos = null; this.jobId = 0; this.maxNodes = Infinity; this.hardEnd = 0;
      this.rootDepth = 0; this.rootBest = 0; this.rootScore = 0;
      this.tMove = 0; this.tBound = 0; this.tScore = 0; this.tDepth = 0; this.tEval = 0;
      this.seeGain = new Int32Array(40); this.seeRem = new Int32Array(40);
    }
    clearTT() { this.tt.fill(0); this.hist.fill(0); this.counter.fill(0); }

    // -------------------------------------------------------------- 評価
    refresh(ply, c) {
      const net = this.net, H = this.H, A = this.acc, W = net.W1, B = net.B1, b = this.pos.b;
      const o = (ply * 2 + c) * H;
      const [flip, bucket] = kingFlip(net, c, this.pos.king[c]);
      this.kFlip[ply * 2 + c] = flip; this.kBucket[ply * 2 + c] = bucket;
      if (ply === 0) this.dirty[0] = 0;
      for (let i = 0; i < H; i++) A[o + i] = B[i];
      for (let s = 0; s < 120; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (!p) continue;
        const r = featIndex(net, c, p, s, flip, bucket) * H;
        for (let i = 0; i < H; i++) A[o + i] += W[r + i];
      }
    }
    // 指したあと（pos は指したあとの局面）に ply+1 の層を「あとで作る」ための記録を残す（評価するときにまとめて足し引きする）
    accMove(ply, m) {
      if (!this.net) return;
      const net = this.net, pos = this.pos, R = this.rec, o = ply * 9;
      const mover = pos.stm ^ 1, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
      const moved = pos.b[to];
      R[o] = moved; R[o + 1] = promo ? (PAWN | (mover << 3)) : moved; R[o + 2] = from; R[o + 3] = to;
      R[o + 4] = pos.uCap[pos.ply - 1]; R[o + 5] = flag === F_EP ? (mover === WHITE ? to - 16 : to + 16) : to;
      R[o + 6] = 0;
      if (flag === F_CASTLE) { let rf, rt; if (to === 6) { rf = 7; rt = 5; } else if (to === 2) { rf = 0; rt = 3; } else if (to === 0x76) { rf = 0x77; rt = 0x75; } else { rf = 0x70; rt = 0x73; } R[o + 6] = pos.b[rt]; R[o + 7] = rf; R[o + 8] = rt; }
      const np = ply + 1;
      this.kFlip[np * 2] = this.kFlip[ply * 2]; this.kFlip[np * 2 + 1] = this.kFlip[ply * 2 + 1];
      this.kBucket[np * 2] = this.kBucket[ply * 2]; this.kBucket[np * 2 + 1] = this.kBucket[ply * 2 + 1];
      this.dirty[np] = 1;
      // キングが動いて重みの区分・鏡映が変わる形のネットなら、その視点はここで数え直す（あとからは盤が違うので作れない）
      if ((moved & 7) === KING && (net.KB > 1 || net.mirror)) {
        const [fl, bk] = kingFlip(net, mover, to);
        if (fl !== this.kFlip[ply * 2 + mover] || bk !== this.kBucket[ply * 2 + mover]) {
          this.resolve(ply);
          this.applyRec(ply, mover ^ 1);
          this.refresh(np, mover);
          this.dirty[np] = 0;
        }
      }
    }
    accCopy(ply) { // ヌルムーブ: 駒は動かない
      if (!this.net) return;
      const o = ply * 9;
      this.rec[o] = 0; // 0 = 動きなし
      this.kFlip[ply * 2 + 2] = this.kFlip[ply * 2]; this.kFlip[ply * 2 + 3] = this.kFlip[ply * 2 + 1];
      this.kBucket[ply * 2 + 2] = this.kBucket[ply * 2]; this.kBucket[ply * 2 + 3] = this.kBucket[ply * 2 + 1];
      this.dirty[ply + 1] = 1;
    }
    // ply の層が「あとで作る」になっていれば、作ってある祖先から順に足し引きして作る
    resolve(ply) {
      if (!this.dirty[ply]) return;
      let a = ply;
      while (this.dirty[a]) a--;
      for (let k = a; k < ply; k++) { this.applyRec(k, 0); this.applyRec(k, 1); this.dirty[k + 1] = 0; }
    }
    // 記録（ply → ply+1 の駒の動き）を視点 c の層に当てる
    applyRec(ply, c) {
      const net = this.net, H = this.H, A = this.acc, W = net.W1, R = this.rec, o = ply * 9;
      const so = (ply * 2 + c) * H, d = ((ply + 1) * 2 + c) * H;
      const moved = R[o];
      if (!moved) { for (let i = 0; i < H; i++) A[d + i] = A[so + i]; return; }
      const flip = this.kFlip[ply * 2 + c], bucket = this.kBucket[ply * 2 + c];
      const a1 = featIndex(net, c, moved, R[o + 3], flip, bucket) * H, s1 = featIndex(net, c, R[o + 1], R[o + 2], flip, bucket) * H;
      const rook = R[o + 6], cap = R[o + 4];
      const wk = this.wk;
      if (wk) { // バイトの位置で渡す
        const H2 = H * 2, dB = this.accOff + d * 2, sB = this.accOff + so * 2;
        if (rook) wk.u4(dB, sB, a1 * 2, s1 * 2, featIndex(net, c, rook, R[o + 8], flip, bucket) * H2, featIndex(net, c, rook, R[o + 7], flip, bucket) * H2, H2);
        else if (cap) wk.u3(dB, sB, a1 * 2, s1 * 2, featIndex(net, c, cap, R[o + 5], flip, bucket) * H2, H2);
        else wk.u2(dB, sB, a1 * 2, s1 * 2, H2);
        return;
      }
      if (rook) {
        const a2 = featIndex(net, c, rook, R[o + 8], flip, bucket) * H, s2 = featIndex(net, c, rook, R[o + 7], flip, bucket) * H;
        for (let i = 0; i < H; i++) A[d + i] = A[so + i] + W[a1 + i] - W[s1 + i] + W[a2 + i] - W[s2 + i];
      } else if (cap) {
        const s2 = featIndex(net, c, cap, R[o + 5], flip, bucket) * H;
        for (let i = 0; i < H; i++) A[d + i] = A[so + i] + W[a1 + i] - W[s1 + i] - W[s2 + i];
      } else {
        for (let i = 0; i < H; i++) A[d + i] = A[so + i] + W[a1 + i] - W[s1 + i];
      }
    }
    evaluate(ply) {
      const pos = this.pos;
      let v = 0;
      if (this.net) {
        if (this.dirty[ply]) this.resolve(ply);
        const net = this.net, H = this.H, A = this.acc, W2 = net.W2, QA = net.QA;
        const o1 = (ply * 2 + pos.stm) * H, o2 = (ply * 2 + (pos.stm ^ 1)) * H;
        const ob = net.OB > 1 ? outBucket(net, pos) : 0, w = ob * 2 * H;
        let sum = 0;
        if (this.wk) sum = this.wk.ev(this.accOff + o1 * 2, this.accOff + o2 * 2, this.w2Off + w * 2, H * 2, QA);
        else if (net.act) {
          for (let i = 0; i < H; i++) {
            let x = A[o1 + i]; x = x < 0 ? 0 : x > QA ? QA : x; sum += x * x * W2[w + i];
            let y = A[o2 + i]; y = y < 0 ? 0 : y > QA ? QA : y; sum += y * y * W2[w + H + i];
          }
          sum /= QA;
        } else {
          for (let i = 0; i < H; i++) {
            let x = A[o1 + i]; x = x < 0 ? 0 : x > QA ? QA : x; sum += x * W2[w + i];
            let y = A[o2 + i]; y = y < 0 ? 0 : y > QA ? QA : y; sum += y * W2[w + H + i];
          }
        }
        v = ((sum + net.B2[ob]) * net.scale / (QA * net.QB)) | 0;
        // 50手ルールに近づくほど 0（引き分け）に寄せる
        if (pos.half > 20) v = (v * (120 - pos.half) / 100) | 0;
      }
      if (this.noise) v += ((Math.imul(pos.hl ^ this.salt, 0x9E3779B1) >>> 0) % (2 * this.noise + 1)) - this.noise;
      return v > MATE_BOUND - 1 ? MATE_BOUND - 1 : v < 1 - MATE_BOUND ? 1 - MATE_BOUND : v;
    }
    // 局面の静的な評価（手番から見た値）。画面・学習用
    staticEval(pos) {
      this.pos = pos;
      if (!this.net) return 0;
      this.refresh(0, 0); this.refresh(0, 1);
      const n = this.noise; this.noise = 0;
      const v = this.evaluate(0);
      this.noise = n;
      return v;
    }

    // -------------------------------------------------------------- SEE（その升での取り合いの損得。駒の価値は学習から測ったもの）
    lva(sq, side, b) { // side の駒で sq に利いている一番安い駒のマス。なければ -1
      const V = this.values, c8 = side << 3;
      let best = -1, bv = 1e9, t;
      if (side === WHITE) {
        t = sq - 15; if (!(t & 0x88) && b[t] === PAWN) return t;
        t = sq - 17; if (!(t & 0x88) && b[t] === PAWN) return t;
      } else {
        t = sq + 15; if (!(t & 0x88) && b[t] === (PAWN | 8)) return t;
        t = sq + 17; if (!(t & 0x88) && b[t] === (PAWN | 8)) return t;
      }
      for (let i = 0; i < 8; i++) { t = sq + N_OFF[i]; if (!(t & 0x88) && b[t] === (KNIGHT | c8)) { if (V[KNIGHT] < bv) { bv = V[KNIGHT]; best = t; } break; } }
      for (let i = 0; i < 4; i++) {
        const d = B_DIR[i];
        for (t = sq + d; !(t & 0x88); t += d) { const q = b[t]; if (q) { if ((q >> 3) === side && ((q & 7) === BISHOP || (q & 7) === QUEEN) && V[q & 7] < bv) { bv = V[q & 7]; best = t; } break; } }
      }
      for (let i = 0; i < 4; i++) {
        const d = R_DIR[i];
        for (t = sq + d; !(t & 0x88); t += d) { const q = b[t]; if (q) { if ((q >> 3) === side && ((q & 7) === ROOK || (q & 7) === QUEEN) && V[q & 7] < bv) { bv = V[q & 7]; best = t; } break; } }
      }
      if (best >= 0) return best;
      for (let i = 0; i < 8; i++) { t = sq + K_OFF[i]; if (!(t & 0x88) && b[t] === (KING | c8)) return t; }
      return -1;
    }
    see(m) {
      const pos = this.pos, b = pos.b, V = this.values;
      const from = m & 127, to = (m >> 7) & 127, flag = (m >> 17) & 7, promo = (m >> 14) & 7;
      const gain = this.seeGain, removed = this.seeRem;
      let nr = 0;
      const us = pos.stm;
      let victim = flag === F_EP ? V[PAWN] : V[b[to] & 7];
      gain[0] = victim + (promo ? V[promo] - V[PAWN] : 0);
      let occ = promo ? V[promo] : V[b[from] & 7];
      removed[nr++] = (from << 8) | (b[from] & 255); b[from] = 0;
      if (flag === F_EP) { const cs = us === WHITE ? to - 16 : to + 16; removed[nr++] = (cs << 8) | (b[cs] & 255); b[cs] = 0; }
      const toPiece = b[to]; b[to] = 0;
      let side = us ^ 1, d = 0;
      for (;;) {
        const s = this.lva(to, side, b);
        if (s < 0) break;
        d++;
        gain[d] = occ - gain[d - 1];
        if (Math.max(-gain[d - 1], gain[d]) < 0) break;
        occ = V[b[s] & 7];
        removed[nr++] = (s << 8) | (b[s] & 255); b[s] = 0;
        side ^= 1;
        if (d >= 38) break;
      }
      while (--d > 0) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
      b[to] = toPiece;
      for (let i = nr - 1; i >= 0; i--) { const r = removed[i]; b[r >> 8] = (r << 24) >> 24; }
      return gain[0];
    }

    // -------------------------------------------------------------- 置換表
    ttProbe() {
      const pos = this.pos, i = (pos.hl & this.ttMask) << 2, T = this.tt;
      const e0 = T[i], e1 = T[i + 1], e2 = T[i + 2], e3 = T[i + 3];
      if ((e0 ^ e1 ^ e2 ^ e3) !== pos.hh || (e1 === 0 && e2 === 0)) return false;
      this.tMove = e1 & 0x1fffff; this.tBound = (e1 >> 21) & 3;
      this.tScore = (e2 << 16) >> 16; this.tDepth = ((e2 >> 16) & 255) - 2; this.tEval = e3;
      return true;
    }
    ttStore(move, score, depth, bound, ev, ply) {
      const pos = this.pos, i = (pos.hl & this.ttMask) << 2, T = this.tt;
      const e0 = T[i], e1 = T[i + 1], e2 = T[i + 2], e3 = T[i + 3];
      const same = (e0 ^ e1 ^ e2 ^ e3) === pos.hh;
      if (same) {
        if (!move) move = e1 & 0x1fffff;
        if (bound !== B_EXACT && depth + 2 < ((e2 >> 16) & 255) - 2 && ((e1 >> 23) & 7) === (this.age & 7)) return;
      } else if (e1 !== 0 && ((e1 >> 23) & 7) === (this.age & 7) && ((e2 >> 16) & 255) - 2 > depth + 3 && bound !== B_EXACT) return;
      if (score >= MATE_BOUND) score += ply; else if (score <= -MATE_BOUND) score -= ply;
      const n1 = (move & 0x1fffff) | (bound << 21) | ((this.age & 7) << 23);
      const n2 = (score & 0xffff) | (((depth + 2) & 255) << 16);
      const n3 = ev | 0;
      T[i + 1] = n1; T[i + 2] = n2; T[i + 3] = n3; T[i] = pos.hh ^ n1 ^ n2 ^ n3;
    }

    // -------------------------------------------------------------- 探索
    checkStop() {
      if (this.stopFlag && Atomics.load(this.stopFlag, 0) !== this.jobId) { this.stop = true; return; }
      if (this.helper) return;
      if (this.nodes >= this.maxNodes) { this.stop = true; return; }
      if (Date.now() >= this.hardEnd) this.stop = true;
    }
    isRep() {
      const p = this.pos, hl = p.hl, hh = p.hh, lim = p.ply - p.half;
      for (let k = p.ply - 4; k >= lim; k -= 2) if (p.posHL[k] === hl && p.posHH[k] === hh) return true;
      return false;
    }
    nonPawn(c) {
      const n = this.pos.cnt, c8 = c << 3;
      return n[KNIGHT | c8] + n[BISHOP | c8] + n[ROOK | c8] + n[QUEEN | c8] > 0;
    }
    scoreMoves(base, n, ply, ttMove, qs) {
      const pos = this.pos, b = pos.b, V = this.values, M = this.moves, S = this.scores;
      const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
      let cm = 0;
      if (!qs && ply > 0) { const pm = this.moveStack[ply - 1]; if (pm) { const pt = (pm >> 7) & 127; cm = this.counter[((b[pt] & 15) << 6) | sq64(pt)]; } }
      const hb = pos.stm << 12;
      for (let i = base; i < n; i++) {
        const m = M[i];
        if (m === ttMove) { S[i] = 30000000; continue; }
        const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7;
        if ((m >> 20) & 1) {
          const victim = ((m >> 17) & 7) === F_EP ? V[PAWN] : V[b[to] & 7];
          const mvv = victim * 16 - V[b[from] & 7] + (promo ? V[promo] : 0);
          S[i] = qs ? mvv : (this.see(m) >= 0 ? 20000000 + mvv : -20000000 + mvv);
        } else if (promo) S[i] = promo === QUEEN ? 19000000 : -30000000 + promo;
        else if (m === k1) S[i] = 18000000;
        else if (m === k2) S[i] = 17900000;
        else if (m === cm) S[i] = 17800000;
        else S[i] = this.hist[hb | (sq64(from) << 6) | sq64(to)];
      }
    }
    pick(i, n) {
      const M = this.moves, S = this.scores;
      let bi = i, bs = S[i];
      for (let j = i + 1; j < n; j++) if (S[j] > bs) { bs = S[j]; bi = j; }
      if (bi !== i) { const tm = M[i]; M[i] = M[bi]; M[bi] = tm; const ts = S[i]; S[i] = S[bi]; S[bi] = ts; }
      return M[i];
    }
    histUpdate(m, bonus) {
      const i = (this.pos.stm << 12) | (sq64(m & 127) << 6) | sq64((m >> 7) & 127);
      this.hist[i] += bonus - ((this.hist[i] * Math.abs(bonus)) >> 14);
    }

    // 静止探索: 取る手（と昇格）だけを読む。王手されていれば逃げる手も読むが、静かな逃げ方は2つまで・深いところでは読まない
    qsearch(alpha, beta, ply, qd = 0) {
      const pos = this.pos;
      this.pvLen[ply] = ply;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stop) return 0;
      if (ply >= MAXPLY - 1) return this.evaluate(ply);
      const inCheck = qd < 6 && pos.inCheck();
      // 評価を何も知らない（ネットなし）ときは、取り合いを読んでも意味がないので、王手からの逃げ（詰みの確認）だけ
      if (!this.net && !inCheck) return this.evaluate(ply);
      const pvNode = beta - alpha > 1;
      let ttMove = 0, ev = NONE;
      if (this.ttProbe()) {
        ttMove = this.tMove;
        let ts = this.tScore;
        if (ts >= MATE_BOUND) ts -= ply; else if (ts <= -MATE_BOUND) ts += ply;
        if (!pvNode && (this.tBound === B_EXACT || (this.tBound === B_LOWER && ts >= beta) || (this.tBound === B_UPPER && ts <= alpha))) return ts;
        ev = this.tEval;
      }
      let best, stand = 0;
      if (inCheck) best = -MATE + ply;
      else {
        stand = ev !== NONE && !this.noise ? ev : this.evaluate(ply);
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
      }
      const base = ply * 256;
      const n = pos.gen(this.moves, base, !inCheck);
      this.scoreMoves(base, n, ply, ttMove, true);
      const V = this.values;
      let legal = 0, bestMove = 0, quietEv = 0;
      const origAlpha = alpha;
      for (let i = base; i < n; i++) {
        const m = this.pick(i, n);
        if (!inCheck) {
          const promo = (m >> 14) & 7;
          if (!promo && stand + V[pos.b[(m >> 7) & 127] & 7] + this.P.delta <= alpha && ((m >> 17) & 7) !== F_EP) continue;
          if (this.see(m) < 0) continue;
        } else if (best > -MATE_BOUND && !((m >> 20) & 1) && quietEv >= 2) continue;
        if (!pos.makeMove(m, qd < 6 ? inCheck : undefined)) continue; // 深いところでは王手かどうかを調べていないので、省かずに確かめる
        legal++;
        if (inCheck && !((m >> 20) & 1)) quietEv++;
        this.accMove(ply, m);
        this.moveStack[ply] = m;
        const s = -this.qsearch(-beta, -alpha, ply + 1, qd + 1);
        pos.unmake();
        if (this.stop) return 0;
        if (s > best) {
          best = s;
          if (s > alpha) {
            alpha = s; bestMove = m;
            if (s >= beta) break;
          }
        }
      }
      if (inCheck && !legal) return -MATE + ply;
      this.ttStore(bestMove, best, -1, best >= beta ? B_LOWER : best > origAlpha ? B_EXACT : B_UPPER, inCheck ? 0 : stand, ply);
      return best;
    }

    search(alpha, beta, depth, ply, cutNode) {
      const pos = this.pos;
      const pvNode = beta - alpha > 1, root = ply === 0;
      this.pvLen[ply] = ply;
      if (!root) {
        if (pos.half >= 100 || this.isRep() || pos.insufficient()) return 0;
        alpha = Math.max(alpha, -MATE + ply); beta = Math.min(beta, MATE - ply - 1);
        if (alpha >= beta) return alpha;
      }
      if (depth <= 0) return this.qsearch(alpha, beta, ply);
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stop) return 0;
      if (ply >= MAXPLY - 2) return this.evaluate(ply);
      const inCheck = pos.inCheck();
      let ttMove = 0, ttHit = false, ttScore = 0, ttBound = 0, ttDepth = -9, ev = NONE;
      if (this.ttProbe()) {
        ttHit = true; ttMove = this.tMove; ttBound = this.tBound; ttDepth = this.tDepth;
        ttScore = this.tScore;
        if (ttScore >= MATE_BOUND) ttScore -= ply; else if (ttScore <= -MATE_BOUND) ttScore += ply;
        if (!pvNode && ttDepth >= depth && (ttBound === B_EXACT || (ttBound === B_LOWER && ttScore >= beta) || (ttBound === B_UPPER && ttScore <= alpha))) {
          if (ttMove && ttScore >= beta && !((ttMove >> 20) & 1) && !((ttMove >> 14) & 7)) this.addKiller(ply, ttMove);
          return ttScore;
        }
        if (!this.noise) ev = this.tEval;
      }
      let sev = 0;
      if (inCheck) ev = NONE;
      else {
        if (ev === NONE) ev = this.evaluate(ply);
        sev = ev;
        // 置換表の値が、静的評価より確かな向きならそちらを使う
        if (ttHit && ((ttBound === B_LOWER && ttScore > ev) || (ttBound === B_UPPER && ttScore < ev) || ttBound === B_EXACT) && !isMate(ttScore)) ev = ttScore;
      }
      this.evalStack[ply] = ev;
      const improving = !inCheck && ply >= 2 && this.evalStack[ply - 2] !== NONE && ev > this.evalStack[ply - 2] ? 1 : 0;
      this.killers[(ply + 1) * 2] = 0; this.killers[(ply + 1) * 2 + 1] = 0;

      if (!pvNode && !inCheck) {
        // 静的評価がβを十分に超えていれば読まずに返す
        if (depth <= 8 && ev - this.P.rfp * (depth - improving) >= beta && ev < MATE_BOUND && beta > -MATE_BOUND) return ev;
        // Null Move: 1手パスしても相手が追いつけないなら、ここは読まなくてよい
        if (depth >= 3 && ev >= beta && this.nullOk[ply] && this.nonPawn(pos.stm) && beta > -MATE_BOUND) {
          const R = this.P.nmpR + ((depth / this.P.nmpD) | 0) + Math.min(3, ((ev - beta) / this.P.nmpDiv) | 0);
          pos.makeNull(); this.accCopy(ply); this.moveStack[ply] = 0; this.nullOk[ply + 1] = 0;
          const s = -this.search(-beta, -beta + 1, depth - 1 - R, ply + 1, !cutNode);
          pos.unmake();
          if (this.stop) return 0;
          if (s >= beta) return s >= MATE_BOUND ? beta : s;
        }
      }
      // 置換表に手がないときは浅くする
      if (!ttMove && depth >= 4 && (pvNode || cutNode)) depth--;

      const base = ply * 256;
      const n = pos.gen(this.moves, base, false);
      this.scoreMoves(base, n, ply, ttMove, false);
      let best = -INF, bestMove = 0, legal = 0, nq = 0;
      const origAlpha = alpha, qb = ply * 64;
      const lmpLimit = (this.P.lmpBase + depth * depth) / (2 - improving);
      const futile = !inCheck && depth <= 8 && ev + this.P.futBase + this.P.fut * depth <= alpha;
      for (let i = base; i < n; i++) {
        const m = this.pick(i, n);
        const cap = (m >> 20) & 1, promo = (m >> 14) & 7, quiet = !cap && !promo;
        const prunable = !root && !inCheck && best > -MATE_BOUND;
        if (prunable && quiet && depth <= 8 && (nq >= lmpLimit || futile)) {
          // 遅い静かな手・見込みのない静かな手は、王手でなければ読まない
          if (!pos.makeMove(m, inCheck)) continue;
          legal++;
          const gc = pos.inCheck();
          pos.unmake();
          if (!gc) continue;
          legal--;
        }
        if (prunable && cap && depth <= 6 && this.scores[i] < 0 && this.see(m) < -this.P.seeCap * depth) continue;
        if (!pos.makeMove(m, inCheck)) continue;
        legal++;
        this.accMove(ply, m);
        this.moveStack[ply] = m; this.nullOk[ply + 1] = 1;
        const givesCheck = pos.inCheck();
        const ext = givesCheck && ply < 2 * this.rootDepth ? 1 : 0;
        const nd = depth - 1 + ext;
        let s;
        if (legal === 1) s = -this.search(-beta, -alpha, nd, ply + 1, false);
        else {
          let r = 0;
          if (depth >= 3 && legal > 1 + (pvNode ? 1 : 0) && (quiet || this.scores[i] < 0)) {
            r = this.lmr[Math.min(depth, 63)][Math.min(legal, 63)];
            if (!pvNode) r++;
            if (improving) r--;
            if (cutNode) r++;
            if (givesCheck) r--;
            if (quiet && this.scores[i] >= 17800000) r--;
            else if (quiet) r -= (this.scores[i] / 6000) | 0;
            if (r < 0) r = 0;
            if (r > nd - 1) r = Math.max(0, nd - 1);
          }
          s = -this.search(-alpha - 1, -alpha, nd - r, ply + 1, true);
          if (s > alpha && r > 0) s = -this.search(-alpha - 1, -alpha, nd, ply + 1, !cutNode);
          if (s > alpha && s < beta) s = -this.search(-beta, -alpha, nd, ply + 1, false);
        }
        pos.unmake();
        if (this.stop) return 0;
        if (s > best) {
          best = s;
          if (s > alpha) {
            alpha = s; bestMove = m;
            const pvb = ply * MAXPLY, cb = (ply + 1) * MAXPLY;
            this.pv[pvb + ply] = m;
            const len = this.pvLen[ply + 1];
            for (let k = ply + 1; k < len; k++) this.pv[pvb + k] = this.pv[cb + k];
            this.pvLen[ply] = Math.max(ply + 1, len);
            if (root) { this.rootBest = m; this.rootScore = s; }
            if (s >= beta) {
              if (quiet) {
                this.addKiller(ply, m);
                const bonus = Math.min(depth * depth * 16, 1600);
                this.histUpdate(m, bonus);
                for (let k = 0; k < nq; k++) this.histUpdate(this.quiets[qb + k], -bonus);
                if (ply > 0) { const pm = this.moveStack[ply - 1]; if (pm) { const pt = (pm >> 7) & 127; this.counter[((pos.b[pt] & 15) << 6) | sq64(pt)] = m; } }
              }
              break;
            }
          }
        }
        if (quiet && nq < 64) this.quiets[qb + nq++] = m;
      }
      if (!legal) return inCheck ? -MATE + ply : 0;
      this.ttStore(bestMove, best, depth, best >= beta ? B_LOWER : best > origAlpha ? B_EXACT : B_UPPER, sev, ply);
      return best;
    }
    addKiller(ply, m) {
      const k = ply * 2;
      if (this.killers[k] !== m) { this.killers[k + 1] = this.killers[k]; this.killers[k] = m; }
    }

    // 考える。opts: timeMs（持ち時間）、maxDepth、maxNodes、analyze（時間いっぱい読む）、jobId、onInfo(info)
    think(rootPos, opts = {}) {
      const t0 = Date.now();
      this.pos = rootPos.clone();
      this.nodes = 0; this.stop = false;
      this.jobId = opts.jobId || 0;
      this.maxNodes = opts.maxNodes || Infinity;
      const timeMs = opts.timeMs == null ? 1000 : opts.timeMs;
      this.hardEnd = t0 + timeMs;
      const soft = opts.analyze ? timeMs : timeMs * 0.55;
      const maxDepth = Math.min(opts.maxDepth || 99, MAXPLY - 4);
      this.age = (this.age + 1) & 7;
      this.killers.fill(0);
      for (let i = 0; i < this.hist.length; i++) this.hist[i] = this.hist[i] >> 1;
      if (this.net) { this.refresh(0, 0); this.refresh(0, 1); }
      this.nullOk[0] = 1; this.moveStack.fill(0);
      const legal = this.pos.legalMoves();
      const result = { move: legal[0] || 0, score: 0, depth: 0, pv: legal[0] ? [legal[0]] : [], nodes: 0, time: 0 };
      if (!legal.length) { result.score = this.pos.inCheck() ? -MATE : 0; result.move = 0; result.pv = []; return result; }
      let prev = 0;
      const start = 1 + (this.helper ? (this.helper & 1) : 0);
      for (let d = start; d <= maxDepth; d++) {
        this.rootDepth = d;
        this.rootBest = 0;
        let s, alpha = -INF, beta = INF, w = this.P.aspiration;
        if (d >= 5 && !isMate(prev)) { alpha = Math.max(-INF, prev - w); beta = Math.min(INF, prev + w); }
        for (;;) {
          s = this.search(alpha, beta, d, 0, false);
          if (this.stop) break;
          if (s <= alpha) { beta = (alpha + beta) >> 1; alpha = Math.max(-INF, s - w); w *= 2; }
          else if (s >= beta) { beta = Math.min(INF, s + w); w *= 2; }
          else break;
          if (w > 1500) { alpha = -INF; beta = INF; }
        }
        if (this.stop) {
          // 途中で止まった深さでも、前の深さより良い手が見つかっていればそれを使う
          if (this.rootBest && this.rootBest !== result.move && this.rootScore > prev && d > start) {
            result.move = this.rootBest; result.score = this.rootScore; result.pv = [this.rootBest];
          }
          break;
        }
        prev = s;
        result.move = this.pv[0] || this.rootBest || result.move; result.score = s; result.depth = d;
        result.pv = Array.from(this.pv.subarray(0, Math.max(1, this.pvLen[0])));
        result.nodes = this.nodes; result.time = Date.now() - t0;
        if (opts.onInfo) opts.onInfo(Object.assign({}, result));
        if (this.helper) continue;
        if (Date.now() - t0 >= soft || this.nodes >= this.maxNodes) break;
        if (!opts.analyze && isMate(s) && d >= 2 * (MATE - Math.abs(s)) + 2) break;
        if (!opts.analyze && legal.length === 1 && d >= 6) break;
      }
      result.nodes = this.nodes; result.time = Date.now() - t0;
      return result;
    }
  }

  Object.assign(C, { MATE, MATE_BOUND, INF, MAXPLY, winRate, isMate, loadNet, quantize, kingFlip, featIndex, outBucket, makeTT, Searcher, DEFAULT_VALUES, simdKernel });
  return C;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ChessAI;
