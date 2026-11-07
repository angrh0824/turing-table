/* 量子観測将棋の AI: 自己対局で学んだ線形の評価 ＋ αβ探索
 * ブラウザ・Node・Web Worker のどこでも動く（KansokuCore(S) のあとに KansokuAI(S) を呼ぶ）
 *
 * 評価: 局面を特徴（持ち駒・確定した駒の種類と段・量子駒の残り・王の候補の数・確定した玉のまわり・取られそうな駒…）にして、
 *   特徴ごとの重みを足す（手番の側の特徴 − 相手の特徴）。重みはすべて自己対局の勝ち負けだけから学ぶ（最初の世代は全部 0）
 * 探索: 反復深化・PVS・置換表・静止探索（取る手）・Null Move・LMR・千日手
 * 2026-11-07: 取った量子駒は候補のまま持ち駒になるルールに（量子の持ち駒・取って打った駒の特徴を足し、学習は第0世代から）
 */
function KansokuAI(S) {
  'use strict';
  const { Position, BLACK, WHITE, FU, KY, KE, GI, KI, KA, HI, OU, QU, MAXPLY, RAY, RAYLEN, KNT, STEP, SLIDE, USTEP, USLIDE, UKNIGHT,
    ALLPROMO, CAPS, OUBIT, QO, QN, QH, QHCAP, bitOf, unpromote, lowType } = S;
  const MATE = 30000, MATE_IN_MAX = MATE - 1000, WIN_REP = 25000, INF = 32000, NOREP = 99999;
  const isMate = s => Math.abs(s) >= MATE_IN_MAX;
  const EVAL_SCALE = 1000; // 勝率 = 1 / (1 + e^(−評価値/1000))（重みは勝率のロジットを学ぶ。評価値はその1000倍）
  const winRate = s => (isMate(s) ? (s > 0 ? 1 : 0) : 1 / (1 + Math.exp(-s / EVAL_SCALE)));

  // ------------------------------------------------------------------ 特徴
  // どちらの側にも同じ番号の特徴を数え、評価 = Σ 重み ×（手番の側 − 相手）＋ 手番の重み
  const DCODES = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15];   // 確定した駒（玉以外）: 歩香桂銀金角飛 と 成香 成桂 成銀 馬 龍
  const DIDX = new Int8Array(16).fill(-1);
  DCODES.forEach((t, i) => { DIDX[t] = i; });
  const F = {};
  let nf = 0;
  const block = (name, n) => { F[name] = nf; nf += n; };
  block('hand', 7);        // 持ち駒の枚数（歩..飛）
  block('hand1', 7);       // 持ち駒がある（1枚目の価値の上乗せ）
  block('handK', 7);       // 持ち駒の枚数 × 相手の玉が確定している
  block('det', 13);        // 確定した盤の駒の枚数
  block('pool', 7);        // 量子駒に残っている種類の数（正体はまだ決まっていないが、これだけは持っている）
  block('kcand', 6);       // 玉が未確定: 王の候補の駒の数（1・2・3・4-5・6-8・9以上）
  block('krank', 9);       // 確定した玉の段（0 = 敵陣の奥、8 = 自陣の一番下）
  block('kguard', 9);      // 確定した玉の隣の味方の駒の数
  block('kpress', 9);      // 確定した玉の隣（と玉のマス）のうち相手が利いているマスの数
  block('qrank', 9);       // 量子駒の段
  block('qprom', 1);       // 成った量子駒
  block('qcand', 8);       // 候補に種類 t を含む量子駒の数
  block('psq', 13 * 9);    // 確定した駒 × 段
  block('qhang', 1);       // 相手に利かれていて味方の利きのない量子駒
  block('qatt', 1);        // 相手に利かれている量子駒
  block('dhang', 1);       // 相手に利かれていて味方の利きのない確定した駒（玉以外）
  block('kcAtt', 1);       // 相手に利かれている王の候補の駒
  block('qhand', 1);       // 量子の持ち駒（候補のまま持っている駒）の数
  block('qhcand', 7);      // 候補に種類 t を含む量子の持ち駒の数（歩..飛）
  block('qhandK', 1);      // 量子の持ち駒の数 × 相手の玉が確定している
  block('qfor', 1);        // 盤の量子駒のうち、もとは相手の駒（取って打った駒）
  const NFS = nf;          // 片側の特徴の数
  const TEMPO = NFS;       // 手番の重み
  const NF = NFS + 1;
  const KC_BUCKET = [0, 0, 1, 2, 3, 3, 4, 4, 4];  // 王の候補の数 → 区分（9以上は 5）

  // 利きの数のマップ（量子駒は候補のどれかが届くマス）
  function attackMap(pos, c, out) {
    out.fill(0);
    const s = pos.s;
    for (let sq = 0; sq < 81; sq++) {
      const p = s[sq];
      if (!p || (p >> 4) !== c) continue;
      let st, sl, kn;
      if ((p & 15) === QU) { const key = (c * 2 + s[162 + sq]) * 256 + s[81 + sq]; st = USTEP[key]; sl = USLIDE[key]; kn = UKNIGHT[key]; }
      else { st = STEP[p]; sl = SLIDE[p]; kn = (p & 15) === KE; }
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base];
        if (!len) continue;
        if ((sl >> d) & 1) { for (let k = 0; k < len; k++) { const s2 = RAY[base * 8 + k]; out[s2]++; if (s[s2]) break; } }
        else if ((st >> d) & 1) out[RAY[base * 8]]++;
      }
      if (kn) for (let i = 0; i < 2; i++) { const s2 = KNT[(c * 81 + sq) * 2 + i]; if (s2 >= 0) out[s2]++; }
    }
  }

  // 局面の特徴を (番号, 値) の組で書き出す（手番の側を +、相手を −）。戻り値は組の数
  const AM = [new Uint8Array(81), new Uint8Array(81)];
  const ACC = new Float64Array(NF);
  function extract(pos, idx, val) {
    const s = pos.s, stm = pos.stm;
    attackMap(pos, BLACK, AM[0]);
    attackMap(pos, WHITE, AM[1]);
    ACC.fill(0);
    for (let c = 0; c < 2; c++) {
      const sg = c === stm ? 1 : -1, mine = AM[c], theirs = AM[c ^ 1];
      const ekDet = s[277 + (c ^ 1)] !== 255;
      for (let t = 1; t <= 7; t++) {
        const n = s[243 + c * 8 + t];
        if (!n) continue;
        ACC[F.hand + t - 1] += sg * n;
        ACC[F.hand1 + t - 1] += sg;
        if (ekDet) ACC[F.handK + t - 1] += sg * n;
      }
      for (let t = 1; t <= 7; t++) { const n = s[259 + c * 9 + t]; if (n) ACC[F.pool + t - 1] += sg * n; }
      const qn = s[QN + c];
      if (qn) {
        ACC[F.qhand] += sg * qn;
        if (ekDet) ACC[F.qhandK] += sg * qn;
        for (let i = 0, b = QH + c * QHCAP; i < qn; i++) { const m = s[b + i]; for (let t = 1; t <= 7; t++) if (m & bitOf(t)) ACC[F.qhcand + t - 1] += sg; }
      }
      let kc = 0;
      const k = s[277 + c];
      for (let sq = 0; sq < 81; sq++) {
        const p = s[sq];
        if (!p || (p >> 4) !== c) continue;
        const t = p & 15, y = (sq / 9) | 0, r = c === BLACK ? y : 8 - y;
        if (t === QU) {
          const m = s[81 + sq];
          ACC[F.qrank + r] += sg;
          if (s[162 + sq]) ACC[F.qprom] += sg;
          for (let tt = 1; tt <= 8; tt++) if (m & bitOf(tt)) ACC[F.qcand + tt - 1] += sg;
          if (theirs[sq]) { ACC[F.qatt] += sg; if (!mine[sq]) ACC[F.qhang] += sg; if (m & OUBIT) ACC[F.kcAtt] += sg; }
          if (m & OUBIT) kc++;
          if (s[QO + sq] !== c) ACC[F.qfor] += sg;
        } else if (t !== OU) {
          const di = DIDX[t];
          ACC[F.det + di] += sg;
          ACC[F.psq + di * 9 + r] += sg;
          if (theirs[sq] && !mine[sq]) ACC[F.dhang] += sg;
        }
      }
      if (k === 255) ACC[F.kcand + (kc >= 9 ? 5 : KC_BUCKET[kc])] += sg;
      else {
        const ky = (k / 9) | 0, kr = c === BLACK ? ky : 8 - ky;
        ACC[F.krank + kr] += sg;
        let guard = 0, press = theirs[k] ? 1 : 0;
        for (let d = 0; d < 8; d++) {
          if (!RAYLEN[k * 8 + d]) continue;
          const s2 = RAY[(k * 8 + d) * 8], q = s[s2];
          if (q && (q >> 4) === c) guard++;
          if (theirs[s2]) press++;
        }
        ACC[F.kguard + guard] += sg;
        ACC[F.kpress + (press > 8 ? 8 : press)] += sg;
      }
    }
    let n = 0;
    for (let i = 0; i < NFS; i++) if (ACC[i] !== 0) { idx[n] = i; val[n++] = ACC[i]; }
    idx[n] = TEMPO; val[n++] = 1;
    return n;
  }

  // ------------------------------------------------------------------ 重み
  class Weights {
    constructor(W) {
      this.w = new Float64Array(NF);
      if (W && W.w) for (let i = 0; i < Math.min(NF, W.w.length); i++) this.w[i] = W.w[i];
      this.gen = (W && W.gen) || 0;
      this.zero = this.w.every(v => v === 0);
      // 手の並べ替え・静止探索の見積もり（SEE）に使う駒の価値（評価値の単位）。学んだ重みから作り、評価と同じ値にそろえる
      //   確定した駒: その段の価値（det + psq。段は持ち主から見た向き）・量子駒: qrank（段）+ qcand（候補ごと）+ qprom
      //   （det と psq は足すと同じになる組がいくつもあるので、det だけでは駒の価値にならない）
      const w = this.w, E = EVAL_SCALE;
      this.handV = new Int32Array(8); this.poolV = new Int32Array(9);
      for (let t = 1; t <= 7; t++) { this.handV[t] = Math.round((w[F.hand + t - 1] + w[F.hand1 + t - 1] * 0.5) * E); this.poolV[t] = Math.round(w[F.pool + t - 1] * E); }
      this.detRV = new Int32Array(16 * 9);
      for (const t of DCODES) for (let r = 0; r < 9; r++) this.detRV[t * 9 + r] = Math.round((w[F.det + DIDX[t]] + w[F.psq + DIDX[t] * 9 + r]) * E);
      this.qrankV = new Int32Array(9);
      for (let r = 0; r < 9; r++) this.qrankV[r] = Math.round(w[F.qrank + r] * E);
      this.qpromV = Math.round(w[F.qprom] * E);
      this.qcandSum = new Int32Array(256);   // 候補の組（8ビット）ごとの qcand の合計
      for (let m = 1; m < 256; m++) { let v = 0; for (let t = 1; t <= 8; t++) if (m & bitOf(t)) v += w[F.qcand + t - 1]; this.qcandSum[m] = Math.round(v * E); }
      // 量子の持ち駒1枚の価値（候補の組 7ビットごと: qhand + 候補ごとの qhcand）と、取って打った駒の上乗せ
      this.qhV = new Int32Array(128);
      for (let m = 1; m < 128; m++) { let v = w[F.qhand]; for (let t = 1; t <= 7; t++) if (m & bitOf(t)) v += w[F.qhcand + t - 1]; this.qhV[m] = Math.round(v * E); }
      this.qforV = Math.round(w[F.qfor] * E);
      // 評価の大きさの目安（持ち駒の価値の平均 ÷ 200。確定した7種類と、候補が全部ある量子の持ち駒）。
      // 枝刈りの幅・評価のゆらぎ・序盤を散らす温度をこれに合わせる
      // （学び直すと評価の大きさが変わる。幅を固定のままにすると、同じ形の評価でも読み方が変わって弱くなる）
      let hm = this.qhV[127];
      for (let t = 1; t <= 7; t++) hm += this.handV[t];
      this.k = Math.min(4, Math.max(0.25, hm / 8 / 200));
    }
  }
  const FIDX = new Int32Array(NF + 8), FVAL = new Float64Array(NF + 8);
  function evaluate(pos, W) {
    if (W.zero) return 0;
    const n = extract(pos, FIDX, FVAL), w = W.w;
    let v = 0;
    for (let i = 0; i < n; i++) v += w[FIDX[i]] * FVAL[i];
    v = Math.round(v * EVAL_SCALE);
    return v > MATE_IN_MAX - 1 ? MATE_IN_MAX - 1 : v < 1 - MATE_IN_MAX ? 1 - MATE_IN_MAX : v;
  }

  // ------------------------------------------------------------------ 置換表
  // 1件 = 4つの int32: [k1 ^ a ^ b, k2, a = 手18bit|深さ+16 6bit|種類2bit|世代6bit, b = 評価値16bit|静的評価16bit]
  // shared = true なら SharedArrayBuffer（複数の Web Worker で同じ表を使う Lazy SMP）
  function makeTT(bits, shared) { const bytes = (1 << bits) * 16; return shared && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes); }
  const BOUND_UPPER = 1, BOUND_LOWER = 2, BOUND_EXACT = 3;
  const MOVE_MASK = (1 << 18) - 1;

  const MAXSP = 64, MAXMOVES = 4096;   // 量子の持ち駒を打つ手が多い局面もあるので、1手の手の数は広めに
  const HROW = 128;                    // 手の履歴の from の数（量子の持ち駒を打つ手の from は 89..120）
  const LMR = [];
  for (let d = 0; d < 48; d++) { LMR.push(new Int8Array(MAXMOVES)); for (let i = 1; i < MAXMOVES; i++) LMR[d][i] = d < 3 || i < 3 ? 0 : Math.min(d - 1, Math.floor(0.7 + Math.log(d) * Math.log(i) / 2.0)); }

  class Searcher {
    constructor(W, opts = {}) {
      this.W = W instanceof Weights ? W : new Weights(W);
      const buf = opts.sharedTT || makeTT(opts.ttBits || 18);
      this.tt = new Int32Array(buf);
      this.helper = opts.helper || 0;   // 補助のワーカー（Lazy SMP）: 読み始める深さと根の手の順を少し変えて、違う枝を読む
      this.ttMask = ((this.tt.length >> 2) - 1) & ~1;
      this.moves = new Int32Array(MAXSP * MAXMOVES);
      this.mscore = new Int32Array(MAXSP * MAXMOVES);
      this.killers = new Int32Array(MAXSP * 2);
      this.hist = new Int32Array(2 * HROW * 81);
      this.pvT = new Int32Array(MAXSP * MAXSP);
      this.pvLen = new Int32Array(MAXSP);
      this.evS = new Int32Array(MAXSP);
      this.tried = new Int32Array(MAXSP * 64);
      this.tb = new Int32Array(2);
      this.seeG = new Int32Array(40); this.seeA0 = new Int32Array(24); this.seeA1 = new Int32Array(24);
      this.noise = 0; this.salt = 0; this.age = 0;
      this.nodes = 0; this.stopped = false;
      this.pos = null; this.nodeLimit = 0; this.rootDepth = 1;
      this.deadline = Date.now() + 0.5;
      this.stopFlag = opts.stopFlag ? new Int32Array(opts.stopFlag) : null;
      this.jobId = 0;
    }
    setWeights(W) { this.W = W instanceof Weights ? W : new Weights(W); this.clearTT(); }
    clearTT() { this.tt.fill(0); this.hist.fill(0); }

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
      let i;
      if (tt[base + 1] === k2 && (tt[base] ^ tt[base + 2] ^ tt[base + 3]) === k1) i = base;
      else if (tt[base + 5] === k2 && (tt[base + 4] ^ tt[base + 6] ^ tt[base + 7]) === k1) i = base + 4;
      else {
        const d0 = (tt[base + 2] >>> 18) & 63, d1 = (tt[base + 6] >>> 18) & 63;
        const a0 = (tt[base + 2] >>> 26) & 63, a1 = (tt[base + 6] >>> 26) & 63, age = this.age & 63;
        const s0 = d0 - (a0 === age ? 0 : 64), s1 = d1 - (a1 === age ? 0 : 64);
        i = s0 <= s1 ? base : base + 4;
      }
      if (!move && tt[i + 1] === k2) move = tt[i + 2] & MOVE_MASK;
      const dd = Math.max(0, Math.min(63, depth + 16));
      const a = (move & MOVE_MASK) | (dd << 18) | (bound << 24) | ((this.age & 63) << 26);
      const b = (score & 0xFFFF) | (ev << 16);
      tt[i + 2] = a; tt[i + 3] = b; tt[i + 1] = k2; tt[i] = k1 ^ a ^ b;
    }

    checkStop() {
      if (this.stopFlag && Atomics.load(this.stopFlag, 0) !== this.jobId) this.stopped = true;
      else if (this.nodeLimit && this.nodes >= this.nodeLimit) this.stopped = true;
      else if (Date.now() >= this.deadline) this.stopped = true;
    }
    evaluate() {
      let v = evaluate(this.pos, this.W);
      if (this.noise) {
        const nz = Math.max(1, Math.round(this.noise * this.W.k));
        let h = Math.imul(this.pos.h1 ^ this.salt, 0x9E3779B1) ^ this.pos.h2;
        h = Math.imul(h ^ (h >>> 15), 0x85EBCA77);
        v += ((h >>> 8) % (2 * nz + 1)) - nz;
      }
      return v;
    }
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
    makeLegal(m) {
      const pos = this.pos;
      pos.make(m);
      if (!pos.legalAfter()) { pos.unmake(); return false; }
      return true;
    }
    // 駒の価値（評価値の単位）: 持ち主 c の駒をマス sq に置いたとき、相手が取ると相手の評価がどれだけ上がるか
    //   = 盤から消える価値（評価と同じ値）＋ 取った側の持ち駒の価値（量子駒は、玉の候補を外した候補のまま量子の持ち駒になる）
    // 確定した駒（code は成りを含む種類）
    detVal(code, c, sq) {
      const y = (sq / 9) | 0, W = this.W;
      return Math.max(0, W.detRV[code * 9 + (c === BLACK ? y : 8 - y)] + W.handV[unpromote(code)]);
    }
    // 量子駒（候補 mask・成っているか prom・持ち主 c・もとの持ち主 o）
    quVal(mask, prom, c, sq, o) {
      const y = (sq / 9) | 0, W = this.W;
      return Math.max(0, W.qcandSum[mask] + W.qrankV[c === BLACK ? y : 8 - y] + (prom ? W.qpromV : 0) + (o !== c ? W.qforV : 0) + this.handGain(mask, o === c));
    }
    // 量子駒（候補 mask）を取った側が持ち駒として得る価値。候補が1つになれば確定した持ち駒（もとの持ち主の残りからも1枚減る）
    handGain(mask, fromVictim) {
      const W = this.W, m = mask & 127;
      if (m & (m - 1)) return W.qhV[m];
      const t = lowType(m);
      return W.handV[t] + (fromVictim ? W.poolV[t] : -W.poolV[t]);
    }
    // 取る手の得の見積もり
    capGain(m) {
      const s = this.pos.s, to = m & 127, q = s[to];
      if (!q) return 0;
      const t = q & 15, c = q >> 4;
      if (t === QU) return this.quVal(s[81 + to], s[162 + to], c, to, s[QO + to]);
      return this.detVal(t, c, to);
    }
    // マス sq の駒を相手が取ったときに相手が得る価値（確定した玉は取れないので一番高く）。at を渡すと、その駒がマス at に移ったときの価値
    pieceV(sq, at = sq) {
      const s = this.pos.s, p = s[sq], t = p & 15;
      if (t === OU) return 30000;
      if (t === QU) return this.quVal(s[81 + sq], s[162 + sq], p >> 4, at, s[QO + sq]);
      return this.detVal(t, p >> 4, at);
    }
    moverV(from) { const v = this.pieceV(from); return (this.pos.s[from] & 15) === QU && (this.pos.s[81 + from] & OUBIT) ? v + Math.round(200 * this.W.k) : v; }
    // 指したあとの動かした駒の価値（行った先の段で。量子駒は絞られたあとの候補で）
    valAfter(m) {
      const pos = this.pos, s = pos.s, from = (m >> 7) & 127, to = m & 127, p = s[from], t = p & 15, c = p >> 4, promo = (m >> 14) & 1;
      if (t === OU) return 30000;
      if (t === QU) {
        const nm = pos.narrowed(m), prom = promo || pos.qp[from];
        if (nm & (nm - 1)) return this.quVal(nm, prom, c, to, s[QO + from]);
        const tt = lowType(nm);
        return tt === OU ? 30000 : this.detVal(prom ? tt + 8 : tt, c, to);
      }
      return this.detVal(promo ? t + 8 : t, c, to);
    }
    // 取り合いの見積もり（SEE）: その手で始まる取り合いを、両方が一番安い駒から取り返すとして読んだ得
    see(m) {
      const pos = this.pos, to = m & 127, from = (m >> 7) & 127, c = pos.stm, g = this.seeG, a0 = this.seeA0, a1 = this.seeA1;
      g[0] = this.capGain(m);
      let onSq = this.valAfter(m);
      let n0 = pos.attackers(to, c, a0);
      const n1 = pos.attackers(to, c ^ 1, a1);
      for (let i = 0; i < n0; i++) if (a0[i] === from) { a0[i] = a0[--n0]; break; }
      let d = 0, side = c ^ 1, left0 = n0, left1 = n1;
      for (;;) {
        const arr = side === c ? a0 : a1, n = side === c ? n0 : n1;
        let bi = -1, bv = INF;
        for (let i = 0; i < n; i++) { if (arr[i] < 0) continue; const v = this.pieceV(arr[i]); if (v < bv) { bv = v; bi = i; } }
        if (bi < 0) break;
        if (bv >= 30000 && (side === c ? left1 : left0) > 0) break;  // 玉は利かれているマスへは取りに行けない
        arr[bi] = -1;
        if (side === c) left0--; else left1--;
        d++;
        g[d] = onSq - g[d - 1];
        if (Math.max(-g[d - 1], g[d]) < 0) break;
        onSq = bv;
        side ^= 1;
        if (d >= 30) break;
      }
      for (; d > 0; d--) g[d - 1] = -Math.max(-g[d - 1], g[d]);
      return g[0];
    }
    scoreMoves(base, n, ttMove, sp) {
      const pos = this.pos, s = pos.s, c = pos.stm, k0 = this.killers[sp * 2], k1 = this.killers[sp * 2 + 1];
      const hb = c * HROW * 81;
      for (let i = base; i < base + n; i++) {
        const m = this.moves[i];
        if (m === ttMove) { this.mscore[i] = 1 << 30; continue; }
        const to = m & 127, from = (m >> 7) & 127;
        let sc;
        if (from <= 80 && s[to]) sc = (1 << 28) + this.capGain(m) * 8 - (this.moverV(from) >> 3) + ((m >> 14) & 1 ? 64 : 0);
        else if ((m >> 14) & 1) sc = (1 << 27) + 100;
        else if (m === k0) sc = (1 << 26) + 2;
        else if (m === k1) sc = (1 << 26) + 1;
        else sc = this.hist[hb + from * 81 + to];
        this.mscore[i] = sc;
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
      const idx = c * HROW * 81 + ((m >> 7) & 127) * 81 + (m & 127), h = this.hist;
      h[idx] += bonus - (h[idx] * Math.abs(bonus)) / 16384;
    }

    // ---------------------------------------------------------------- 静止探索（取る手だけ。王手されていれば全部）
    // 量子駒は候補が多いと遠くまで利くので、序盤から盤じゅうで取り合いが起きる。順番違いの同じ局面は置換表でまとめ、
    // 3手目（qd = 2）からは直前に動いたマスでの取り返しだけを読む
    qsearch(alpha, beta, sp, qd) {
      alpha |= 0; beta |= 0;
      const pos = this.pos;
      this.pvLen[sp] = sp;
      if ((++this.nodes & 1023) === 0) this.checkStop();
      if (this.stopped) return 0;
      const inCheck = pos.chkS[pos.ply] === 1;
      if (sp >= MAXSP - 2 || qd > 14) return inCheck ? 0 : this.evaluate();
      if (inCheck) { const r = this.repScore(); if (r !== NOREP) return r; }
      else if (this.W.zero) return 0;  // 重みがまだない世代は取り合いを読まない（評価がいつも 0）
      const alpha0 = alpha;
      let ttEval = -INF;
      if (this.probe()) {
        const a = this.tb[0], bv = this.tb[1], td = ((a >>> 18) & 63) - 16, bound = (a >>> 24) & 3;
        let ts = (bv << 16) >> 16;
        if (ts >= MATE_IN_MAX) ts -= sp; else if (ts <= -MATE_IN_MAX) ts += sp;
        if (td >= -1 && (bound === BOUND_EXACT || (bound === BOUND_LOWER && ts >= beta) || (bound === BOUND_UPPER && ts <= alpha))) return ts;
        ttEval = bv >> 16;
      }
      let best, stand = -INF;
      const base = sp * MAXMOVES;
      let n;
      if (inCheck) {
        best = -MATE + sp;
        n = pos.genBoard(this.moves, base, 0) - base;
        n = pos.genDrops(this.moves, base + n) - base;
      } else {
        stand = ttEval > -INF && ttEval !== 0 ? ttEval : this.evaluate();
        if (stand >= beta) { if (ttEval === -INF) this.store(0, -1, BOUND_LOWER, stand, stand, sp); return stand; }
        if (stand > alpha) alpha = stand;
        best = stand;
        if (qd > 10) return stand;
        n = pos.genBoard(this.moves, base, CAPS) - base;
      }
      this.scoreMoves(base, n, 0, sp);
      let legal = 0, bestMove = 0;
      const last = qd >= 2 ? pos.lastTo() : -1;
      for (let i = base; i < base + n; i++) {
        const m = this.pick(i, base + n);
        if (!inCheck) {
          if (last >= 0 && (m & 127) !== last) continue;
          // 取っても届かない手・損な取り合い（SEE が負）は読まない。2手目からは得になる取り合いだけ
          if (stand + this.capGain(m) + 300 * this.W.k < alpha && !((m >> 14) & 1)) continue;
          const sv = this.see(m);
          if (sv < 0 || (qd >= 1 && sv <= 0)) continue;
        }
        if (!this.makeLegal(m)) continue;
        legal++;
        const v = 0 - this.qsearch(0 - beta, 0 - alpha, sp + 1, qd + 1);
        pos.unmake();
        if (this.stopped) return 0;
        if (v > best) {
          best = v;
          if (v > alpha) {
            alpha = v; bestMove = m;
            this.pvT[sp * MAXSP + sp] = m;
            for (let j = sp + 1; j < this.pvLen[sp + 1]; j++) this.pvT[sp * MAXSP + j] = this.pvT[(sp + 1) * MAXSP + j];
            this.pvLen[sp] = this.pvLen[sp + 1];
            if (v >= beta) break;
          }
        }
      }
      if (inCheck && !legal) return -MATE + sp;
      this.store(bestMove, -1, best >= beta ? BOUND_LOWER : best > alpha0 ? BOUND_EXACT : BOUND_UPPER, best, inCheck ? 0 : stand, sp);
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
      let ttMove = 0, ttEval = -INF;
      if (this.probe()) {
        const a = this.tb[0], bv = this.tb[1];
        ttMove = a & MOVE_MASK;
        const td = ((a >>> 18) & 63) - 16, bound = (a >>> 24) & 3;
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
      if (!pvNode && !inCheck && !isMate(beta) && !this.W.zero) {
        if (depth <= 5 && ev - (improving ? 100 : 140) * depth * this.W.k >= beta) return ev;
        if (nullOk && depth >= 3 && ev >= beta) {
          const R = 3 + (depth >> 2);
          pos.makeNull();
          const v = 0 - this.search(depth - 1 - R, 0 - beta, 1 - beta, sp + 1, false);
          pos.unmakeNull();
          if (this.stopped) return 0;
          if (v >= beta) return isMate(v) ? beta : v;
        }
      }
      if (pvNode && !ttMove && depth >= 6) {
        this.search(depth - 2, alpha, beta, sp, true);
        if (this.stopped) return 0;
        if (this.probe()) ttMove = this.tb[0] & MOVE_MASK;
      }
      const base = sp * MAXMOVES;
      let n = pos.genBoard(this.moves, base, 0, null) - base;
      n = pos.genDrops(this.moves, base + n) - base;
      this.scoreMoves(base, n, ttMove, sp);
      const c = pos.stm, s = pos.s;
      let best = -INF, bestMove = 0, legal = 0, quiets = 0;
      const alpha0 = alpha, tried = this.tried;
      let nTried = 0;
      for (let i = base; i < base + n; i++) {
        const m = this.pick(i, base + n);
        const to = m & 127, from = (m >> 7) & 127;
        const cap = from <= 80 && s[to] !== 0, promo = (m >> 14) & 1;
        const quiet = !cap && !promo;
        if (!pvNode && !inCheck && legal > 0 && quiet && best > -MATE_IN_MAX) {
          if (depth <= 4 && quiets >= (improving ? 8 : 5) + depth * depth * 3) break;
          if (depth <= 3 && !this.W.zero && ev + (160 * depth + 80) * this.W.k <= alpha) break;
        }
        if (!this.makeLegal(m)) continue;
        legal++;
        if (quiet) { quiets++; if (nTried < 64) tried[sp * 64 + nTried++] = m; }
        const gives = pos.chkS[pos.ply] === 1;
        let ext = 0;
        if (gives && sp < this.rootDepth * 2 && !pos.attacked(to, pos.stm)) ext = 1;
        const nd = depth - 1 + ext;
        let v;
        if (legal === 1) v = 0 - this.search(nd, 0 - beta, 0 - alpha, sp + 1, true);
        else {
          let r = 0;
          if (depth >= 3 && quiet && !inCheck && !gives) {
            r = LMR[Math.min(depth, 47)][Math.min(legal, MAXMOVES - 1)];
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
      if (!legal) return -MATE + sp;
      this.store(bestMove, depth, best >= beta ? BOUND_LOWER : best > alpha0 ? BOUND_EXACT : BOUND_UPPER, best, inCheck ? 0 : ev, sp);
      return best;
    }

    // 合法手ごとの浅い評価（指したあとの静的評価 ＋ 取る手は取り合いの見積もり）。自己対局の序盤を散らす・やさしい CPU に使う
    // 序盤は取り合いの読みが重いので、静止探索は使わない
    rootMoveScores(pos) {
      this.pos = pos; this.nodes = 0; this.stopped = false; this.nodeLimit = 0;
      this.deadline = Date.now() + 1e12;
      const out = [], buf = new Int32Array(16384);
      let n = pos.genBoard(buf, 0, 0, null);
      n = pos.genDrops(buf, n);
      for (let i = 0; i < n; i++) {
        const m = buf[i], cap = ((m >> 7) & 127) <= 80 && pos.s[m & 127] !== 0;
        const sv = cap ? this.see(m) - this.capGain(m) : 0;   // 取ったあとの取り返し分（静的評価は取った分を含む）
        if (!this.makeLegal(m)) continue;
        const v = 0 - this.evaluate() + (sv < 0 ? sv : 0);
        pos.unmake();
        out.push({ m, v });
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
      const res = { move: 0, score: 0, depth: 0, pv: [], nodes: 0, time: 0 };
      const root = [];
      {
        const buf = new Int32Array(16384);
        let n = pos.genBoard(buf, 0, 0, null);
        n = pos.genDrops(buf, n);
        for (let i = 0; i < n; i++) if (this.makeLegal(buf[i])) { pos.unmake(); root.push(buf[i]); }
      }
      if (!root.length) { res.score = -MATE; return res; }
      // 取る手を先に（最初の深さの並び）
      this.pos = pos;
      root.sort((a, b) => this.capGain(b) - this.capGain(a));
      res.move = root[0];
      if (root.length === 1 && !opts.analyze) { res.depth = 1; res.pv = [root[0]]; return res; }
      const maxDepth = opts.maxDepth || 40;
      let prev = 0;
      for (let d = 1 + (this.helper & 1); d <= maxDepth; d++) {
        this.rootDepth = d;
        let delta = 80, alpha = -INF, beta = INF;
        if (d >= 4 && !isMate(prev)) { alpha = prev - delta; beta = prev + delta; }
        let score;
        for (;;) {
          score = this.searchRoot(root, d, alpha, beta);
          if (this.stopped) break;
          if (score <= alpha) { alpha = Math.max(-INF, score - delta); delta *= 2; }
          else if (score >= beta) { beta = Math.min(INF, score + delta); delta *= 2; }
          else break;
          if (delta > 3000) { alpha = -INF; beta = INF; }
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
        if (opts.timeMs && !opts.analyze && Date.now() - t0 > opts.timeMs * 0.5) break;
      }
      res.nodes = this.nodes; res.time = Date.now() - t0;
      return res;
    }
    searchRoot(root, depth, alpha, beta) {
      const pos = this.pos, s = pos.s;
      this.pvLen[0] = 0;
      let best = -INF, bestI = 0;
      for (let i = 0; i < root.length; i++) {
        const m = root[i];
        const cap = ((m >> 7) & 127) <= 80 && s[m & 127] !== 0;
        this.makeLegal(m);
        const gives = pos.chkS[pos.ply] === 1;
        const nd = depth - 1 + (gives && !pos.attacked(m & 127, pos.stm) ? 1 : 0);
        let v;
        if (i === 0) v = 0 - this.search(nd, 0 - beta, 0 - alpha, 1, true);
        else {
          const quiet = !cap && !((m >> 14) & 1);
          const r = depth >= 4 && quiet && !gives && i >= 6 ? (i >= 30 && depth >= 6 ? 2 : 1) : 0;
          v = 0 - this.search(nd - r, -1 - alpha, 0 - alpha, 1, true);
          if (v > alpha && r) v = 0 - this.search(nd, -1 - alpha, 0 - alpha, 1, true);
          if (v > alpha && v < beta) v = 0 - this.search(nd, 0 - beta, 0 - alpha, 1, true);
        }
        pos.unmake();
        if (this.stopped) break;
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
      if (bestI > 0) { const m = root.splice(bestI, 1)[0]; root.unshift(m); }
      if (this.helper && root.length > 2) { const k = 1 + ((this.helper * 7 + depth) % (root.length - 1)); const m = root.splice(k, 1)[0]; root.splice(1, 0, m); }
      this.store(root[0], depth, best >= beta ? BOUND_LOWER : BOUND_EXACT, best, 0, 0);
      return best;
    }
  }

  Object.assign(S, { MATE, MATE_IN_MAX, WIN_REP, INF, isMate, winRate, EVAL_SCALE, NF, NFS, TEMPO, F, extract, attackMap, evaluate, Weights, Searcher, makeTT });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = KansokuAI;
