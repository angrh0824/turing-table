/* アマゾンズの AI: 自己対局で学んだ評価関数＋幅を絞った αβ 探索
 *
 * 評価関数（手番の側から見た「勝つ見込み」のロジット）
 *   空きマスごとに「自分と相手のアマゾンが女王の動きで何手で届くか」「王の動き（1マスずつ）で何手で届くか」を数え、
 *   その4つの組（それぞれ 1・2・3・4・5以上・届かない の6段階）ごとの点数を足す（6^4 = 1296 通り）。
 *   アマゾン1体ごとの「1手で行けるマスの数」（11段階）の点数も足す。点数の表は対局の進み具合（矢の本数）で
 *   8つの節に分け、そのあいだは直線でつなぐ。点数はすべて自己対局の勝ち負けから学ぶ（人が決めた値はない）
 * 探索
 *   1手目の候補をすべて評価で並べ、上位だけを深く読む（反復深化・PVS・置換表・キラー手）。
 *   読みの末端（残り1手）は全部の手を評価して最大を取る。途中の節点では評価で並べて上位の数手だけを読む
 */
function AmazonsAI(A) {
  'use strict';
  const { SQ, DIRS, Position } = A;
  const WIN = 1000, INF = 1e9;
  const QN = 6, NSQ = QN * QN * QN * QN;      // 空きマスの表: 1296
  const MBN = 11;                              // 動けるマスの数の段階
  const OFF_MM = NSQ, OFF_MO = NSQ + MBN, OFF_BIAS = NSQ + 2 * MBN, NF = OFF_BIAS + 1;
  const NODES = [0, 10, 20, 30, 40, 52, 66, 92]; // 節（矢の本数＝手数）
  const MAXPLY = 92;
  // 距離 → 段階（0..5）。255 は届かない
  const DB = new Uint8Array(256);
  for (let d = 0; d < 256; d++) DB[d] = d === 255 ? 5 : d >= 5 ? 4 : Math.max(0, d - 1);
  const MB = new Uint8Array(64);
  for (let m = 0; m < 64; m++) MB[m] = m <= 5 ? m : m <= 7 ? 6 : m <= 10 ? 7 : m <= 14 ? 8 : m <= 19 ? 9 : 10;

  // ---------------------------------------------------------------- 距離（作業用の配列は使い回す）
  const FA = new Int16Array(144), FB = new Int16Array(144);
  // 女王の動きで何手で届くか（複数の出発点から同時に広げる）
  function qdist(b, qs, d) {
    d.fill(255);
    let fr = FA, nx = FB, n = 0, dist = 0;
    for (let k = 0; k < 4; k++) { d[qs[k]] = 0; fr[n++] = qs[k]; }
    while (n) {
      dist++;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const p = fr[i];
        for (let e = 0; e < 8; e++) {
          const de = DIRS[e];
          for (let x = p + de; b[x] === 0; x += de) {
            const dx = d[x];
            if (dx > dist) { d[x] = dist; nx[m++] = x; } else if (dx < dist) break;
          }
        }
      }
      const t = fr; fr = nx; nx = t; n = m;
    }
  }
  // 王の動き（となりのマスへ1つずつ）で何手で届くか
  function kdist(b, qs, d) {
    d.fill(255);
    let fr = FA, nx = FB, n = 0, dist = 0;
    for (let k = 0; k < 4; k++) { d[qs[k]] = 0; fr[n++] = qs[k]; }
    while (n) {
      dist++;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const p = fr[i];
        for (let e = 0; e < 8; e++) { const x = p + DIRS[e]; if (b[x] === 0 && d[x] === 255) { d[x] = dist; nx[m++] = x; } }
      }
      const t = fr; fr = nx; nx = t; n = m;
    }
  }
  function mobility(b, p) {
    let c = 0;
    for (let e = 0; e < 8; e++) { const de = DIRS[e]; for (let x = p + de; b[x] === 0; x += de) c++; }
    return c;
  }

  // ---------------------------------------------------------------- 評価関数
  // w: { nodes: [8 個の Float32Array(NF)] } → 手数ごとの表（節のあいだを直線でつないだもの）を前もって作る
  function makeEval(w) {
    const tables = [];
    const nodeW = w && w.nodes ? w.nodes : null;
    for (let ply = 0; ply <= MAXPLY; ply++) {
      const T = new Float32Array(NF);
      if (nodeW) {
        let k = 0;
        while (k < NODES.length - 2 && ply >= NODES[k + 1]) k++;
        const t = Math.min(1, Math.max(0, (ply - NODES[k]) / (NODES[k + 1] - NODES[k])));
        const a = nodeW[k], c = nodeW[k + 1];
        for (let i = 0; i < NF; i++) T[i] = a[i] * (1 - t) + c[i] * t;
      }
      tables.push(T);
    }
    const DQm = new Uint8Array(144), DQo = new Uint8Array(144), DKm = new Uint8Array(144), DKo = new Uint8Array(144);
    function evaluate(pos) {
      const b = pos.b, s = pos.stm, qm = pos.q[s], qo = pos.q[s ^ 1];
      let tm = 0;
      const T = tables[pos.ply > MAXPLY ? MAXPLY : pos.ply];
      let v = T[OFF_BIAS];
      for (let k = 0; k < 4; k++) { const mo = mobility(b, qm[k]); tm += mo; v += T[OFF_MM + MB[mo]]; }
      if (tm === 0) return -WIN; // 手番の側が指せない = 負け
      for (let k = 0; k < 4; k++) v += T[OFF_MO + MB[mobility(b, qo[k])]];
      qdist(b, qm, DQm); qdist(b, qo, DQo); kdist(b, qm, DKm); kdist(b, qo, DKo);
      for (let i = 0; i < 100; i++) {
        const p = SQ[i];
        if (b[p] !== 0) continue;
        v += T[((DB[DQm[p]] * QN + DB[DQo[p]]) * QN + DB[DKm[p]]) * QN + DB[DKo[p]]];
      }
      return v;
    }
    return { evaluate, tables, empty: !nodeW, gen: w && w.gen || 0 };
  }

  // 学習用: 局面の特徴（表の添字ごとの個数）を idx・cnt に書き、数を返す。終局（手番が指せない）なら -1
  const XQm = new Uint8Array(144), XQo = new Uint8Array(144), XKm = new Uint8Array(144), XKo = new Uint8Array(144);
  const XC = new Uint16Array(NF), XU = new Int32Array(NF);
  function extract(pos, idx, cnt) {
    const b = pos.b, s = pos.stm, qm = pos.q[s], qo = pos.q[s ^ 1];
    let nu = 0, tm = 0;
    const add = i => { if (!XC[i]++) XU[nu++] = i; };
    for (let k = 0; k < 4; k++) { const mo = mobility(b, qm[k]); tm += mo; add(OFF_MM + MB[mo]); }
    if (tm === 0) { for (let j = 0; j < nu; j++) XC[XU[j]] = 0; return -1; }
    for (let k = 0; k < 4; k++) add(OFF_MO + MB[mobility(b, qo[k])]);
    add(OFF_BIAS);
    qdist(b, qm, XQm); qdist(b, qo, XQo); kdist(b, qm, XKm); kdist(b, qo, XKo);
    for (let i = 0; i < 100; i++) {
      const p = SQ[i];
      if (b[p] !== 0) continue;
      add(((DB[XQm[p]] * QN + DB[XQo[p]]) * QN + DB[XKm[p]]) * QN + DB[XKo[p]]);
    }
    for (let j = 0; j < nu; j++) { const i = XU[j]; idx[j] = i; cnt[j] = XC[i]; XC[i] = 0; }
    return nu;
  }

  // 盤の上の「陣地」: 空きマスごとに、どちらのアマゾンが先に届くか（女王の動きの手数で比べる。同じなら王の動きで比べる）
  // 戻り値: owner[100]（0 白・1 黒・-1 どちらとも言えない・-2 どちらも届かない）、margin[100]、白黒それぞれの数
  function territory(pos) {
    const b = pos.b, d = [new Uint8Array(144), new Uint8Array(144)], k = [new Uint8Array(144), new Uint8Array(144)];
    for (let s = 0; s < 2; s++) { qdist(b, pos.q[s], d[s]); kdist(b, pos.q[s], k[s]); }
    const owner = new Int8Array(100), margin = new Int8Array(100), sure100 = new Uint8Array(100), count = [0, 0], sure = [0, 0];
    const dist = [new Uint8Array(100), new Uint8Array(100)];
    let neutral = 0;
    for (let i = 0; i < 100; i++) {
      const p = SQ[i];
      dist[0][i] = d[0][p]; dist[1][i] = d[1][p];
      if (b[p] !== 0) { owner[i] = -3; continue; }
      const a = d[0][p], c = d[1][p];
      if (a === 255 && c === 255) { owner[i] = -2; continue; }
      let o;
      if (a < c) o = 0; else if (c < a) o = 1;
      else o = k[0][p] < k[1][p] ? 0 : k[1][p] < k[0][p] ? 1 : -1;
      owner[i] = o;
      margin[i] = Math.min(9, Math.abs((a === 255 ? 20 : a) - (c === 255 ? 20 : c)));
      if (o >= 0) { count[o]++; if ((o === 0 ? c : a) === 255) { sure[o]++; sure100[i] = 1; } } else neutral++;
    }
    return { owner, margin, sure100, dist, count, sure, neutral };
  }

  // ---------------------------------------------------------------- 探索
  const ABORT = { abort: true };
  const EXACT = 0, LOWER = 1, UPPER = 2;
  const EPS = 1e-4;
  // 読む幅: 根（1手目）と途中の節点（残りの深さごと）
  const ROOT_W = [0, 0, 32, 20, 14, 12, 10, 10, 10, 10];
  const INNER_W = [0, 0, 10, 7, 6, 5, 5, 5, 5, 5];
  // 2段の候補づくりの既定（測って決める。null なら使わない）
  let TWO_STAGE = null;
  let gseed = 12345;
  function grand() { // 正規乱数（再現できるように自前の乱数）
    gseed = (gseed * 1103515245 + 12345) & 0x7fffffff;
    const u = (gseed + 1) / 0x80000001;
    gseed = (gseed * 1103515245 + 12345) & 0x7fffffff;
    const v = (gseed + 1) / 0x80000001;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  class Searcher {
    constructor(ev, opt = {}) {
      this.ev = ev;
      const bits = opt.ttBits || 18, size = 1 << bits;
      this.mask = size - 1;
      this.tk1 = new Int32Array(size); this.tk2 = new Int32Array(size); this.tmv = new Int32Array(size);
      this.tsc = new Float32Array(size); this.tdp = new Int8Array(size); this.tfl = new Uint8Array(size);
      this.mbufs = []; this.sbufs = [];
      this.killer = new Int32Array(256);
      this.rootW = opt.rootW || ROOT_W; this.innerW = opt.innerW || INNER_W;
      this.rootMoves = new Int32Array(6000); this.rootSc = new Float64Array(6000);
      // 2段の候補づくり（{ M: 途中の節点で矢まで見るアマゾンの動きの数, Mf: 末端での数 }）。null なら全部の手を評価
      this.ts = opt.twoStage === undefined ? TWO_STAGE : opt.twoStage;
      this.amBuf = new Int32Array(512); this.asBuf = new Float32Array(512);
    }
    clearTT() { this.tk1.fill(0); this.tk2.fill(0); this.tmv.fill(0); this.tdp.fill(0); this.killer.fill(0); }
    mb(ply) { while (this.mbufs.length <= ply) { this.mbufs.push(new Int32Array(6000)); this.sbufs.push(new Float32Array(6000)); } return this.mbufs[ply]; }
    evalNode() {
      if ((++this.evals & 255) === 0 && (Date.now() > this.deadline || this.evals > this.maxEvals)) throw ABORT;
      return this.ev.evaluate(this.pos);
    }
    store(depth, score, move, flag, ply) {
      const pos = this.pos, h = pos.h1 & this.mask;
      if (this.tk1[h] === pos.h1 && this.tk2[h] === pos.h2 && this.tdp[h] > depth && flag !== EXACT) return;
      let s = score;
      if (s > WIN - 300) s += ply; else if (s < -WIN + 300) s -= ply;
      this.tk1[h] = pos.h1; this.tk2[h] = pos.h2; this.tmv[h] = move; this.tsc[h] = s; this.tdp[h] = depth; this.tfl[h] = flag;
    }
    // 2段で候補を作る: まずアマゾンの動きだけ（矢はまだ）を評価して上位 M 個を選び、そのそれぞれで矢の先を全部評価する。
    // moves・sc に子の手とその値（手番から見た値）を書き、数を返す。cut 以上の値が出たらそこで止める
    twoStage(M, moves, sc, cut) {
      const pos = this.pos, b = pos.b, s = pos.stm, pc = s + 1, q = pos.q[s], am = this.amBuf, as = this.asBuf;
      let na = 0;
      for (let k = 0; k < 4; k++) {
        const f = q[k];
        for (let d = 0; d < 8; d++) {
          const dt = DIRS[d];
          for (let t = f + dt; b[t] === 0; t += dt) {
            b[f] = 0; b[t] = pc; q[k] = t; pos.stm = s ^ 1; pos.ply++;
            const v = -this.evalNode();
            pos.ply--; pos.stm = s; q[k] = f; b[t] = 0; b[f] = pc;
            am[na] = f | (t << 8); as[na] = v; na++;
          }
        }
      }
      if (!na) return 0;
      const Mm = Math.min(M, na);
      let n = 0;
      for (let j = 0; j < Mm; j++) {
        let bi = j;
        for (let i = j + 1; i < na; i++) if (as[i] > as[bi]) bi = i;
        const ft = am[bi]; am[bi] = am[j]; am[j] = ft; const tv = as[bi]; as[bi] = as[j]; as[j] = tv;
        const f = ft & 255, t = ft >> 8;
        let k = 0;
        while (q[k] !== f) k++;
        b[f] = 0; b[t] = pc; q[k] = t;
        for (let e = 0; e < 8; e++) {
          const de = DIRS[e];
          for (let a = t + de; b[a] === 0; a += de) {
            b[a] = 3; pos.stm = s ^ 1; pos.ply++;
            const v = -this.evalNode();
            pos.ply--; pos.stm = s; b[a] = 0;
            moves[n] = ft | (a << 16); sc[n] = v; n++;
            if (v >= cut) { q[k] = f; b[t] = 0; b[f] = pc; return n; }
          }
        }
        q[k] = f; b[t] = 0; b[f] = pc;
      }
      return n;
    }    search(depth, alpha, beta, ply) {
      const pos = this.pos;
      this.nodes++;
      const h = pos.h1 & this.mask;
      let ttMove = 0;
      if (this.tk1[h] === pos.h1 && this.tk2[h] === pos.h2) {
        ttMove = this.tmv[h];
        if (this.tdp[h] >= depth) {
          let s = this.tsc[h];
          if (s > WIN - 300) s -= ply; else if (s < -WIN + 300) s += ply;
          const f = this.tfl[h];
          if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) return s;
        }
      }
      const moves = this.mb(ply), ts = this.ts;
      let n;
      if (ts) {
        n = this.twoStage(depth <= 1 ? ts.Mf : ts.M, moves, this.sbufs[ply], depth <= 1 ? beta : INF);
        if (n === 0) return -(WIN - ply);
      } else {
        n = pos.genMoves(moves);
        if (n === 0) return -(WIN - ply);
      }
      const a0 = alpha;
      let best = -INF, bm = 0;
      if (depth <= 1 && ts) {
        // 末端（2段）: 作った候補の中の最大
        const sc = this.sbufs[ply];
        for (let i = 0; i < n; i++) if (sc[i] > best) { best = sc[i]; bm = moves[i]; }
      } else if (depth <= 1) {
        // 末端: 全部の手を評価して最大。前に良かった手（置換表・キラー）を先に試して早く打ち切る
        const k0 = ttMove || this.killer[ply * 2], k1 = this.killer[ply * 2 + 1];
        for (const km of [k0, k1]) {
          if (!km || !pos.isLegal(km)) continue;
          pos.make(km); const v = -this.evalNode(); pos.unmake(km);
          if (v > best) { best = v; bm = km; if (v > alpha) { alpha = v; if (v >= beta) { this.store(1, best, bm, LOWER, ply); return best; } } }
        }
        for (let i = 0; i < n; i++) {
          const m = moves[i];
          pos.make(m); const v = -this.evalNode(); pos.unmake(m);
          if (v > best) { best = v; bm = m; if (v > alpha) { alpha = v; if (v >= beta) { this.addKiller(ply, m); break; } } }
        }
      } else {
        const sc = this.sbufs[ply];
        const k0 = this.killer[ply * 2], k1 = this.killer[ply * 2 + 1];
        if (ts) {
          // 2段で作った候補に、前に良かった手（置換表・キラー）が入っていなければ足す
          for (const km of [ttMove, k0, k1]) {
            if (!km) continue;
            let has = false;
            for (let i = 0; i < n; i++) if (moves[i] === km) { has = true; break; }
            if (!has && pos.isLegal(km)) { pos.make(km); sc[n] = -this.evalNode(); pos.unmake(km); moves[n++] = km; }
          }
        }
        for (let i = 0; i < n; i++) {
          const m = moves[i];
          let v;
          if (ts) v = sc[i];
          else { pos.make(m); v = -this.evalNode(); pos.unmake(m); }
          if (v >= WIN - 1) { this.store(depth, WIN - ply - 1, m, EXACT, ply); return WIN - ply - 1; } // 相手が指せなくなる手
          if (m === ttMove) v += 100; else if (m === k0 || m === k1) v += 50;
          sc[i] = v;
        }
        const K = Math.min(n, this.innerW[Math.min(depth, this.innerW.length - 1)]);
        for (let j = 0; j < K; j++) {
          let bi = j;
          for (let i = j + 1; i < n; i++) if (sc[i] > sc[bi]) bi = i;
          const m = moves[bi]; moves[bi] = moves[j]; moves[j] = m; const t = sc[bi]; sc[bi] = sc[j]; sc[j] = t;
          pos.make(m);
          let v;
          if (j === 0) v = -this.search(depth - 1, -beta, -alpha, ply + 1);
          else {
            v = -this.search(depth - 1, -alpha - EPS, -alpha, ply + 1);
            if (v > alpha && v < beta) v = -this.search(depth - 1, -beta, -alpha, ply + 1);
          }
          pos.unmake(m);
          if (v > best) { best = v; bm = m; if (v > alpha) { alpha = v; if (v >= beta) { this.addKiller(ply, m); break; } } }
        }
      }
      this.store(depth, best, bm, best >= beta ? LOWER : best > a0 ? EXACT : UPPER, ply);
      return best;
    }
    addKiller(ply, m) { if (this.killer[ply * 2] !== m) { this.killer[ply * 2 + 1] = this.killer[ply * 2]; this.killer[ply * 2] = m; } }
    pvFrom(pos0, first, maxLen = 12) {
      const pos = pos0.clone(), pv = [first];
      pos.make(first);
      const seen = new Set();
      while (pv.length < maxLen) {
        const h = pos.h1 & this.mask;
        if (this.tk1[h] !== pos.h1 || this.tk2[h] !== pos.h2) break;
        const m = this.tmv[h];
        if (!m || !pos.isLegal(m) || seen.has(pos.h1)) break;
        seen.add(pos.h1); pv.push(m); pos.make(m);
      }
      return pv;
    }
    // 考える: { timeMs, maxDepth, maxEvals, noise, onInfo, split: {i, n} } → { move, score, depth, pv, nodes, evals, time }
    think(pos0, o = {}) {
      const t0 = Date.now();
      const timeMs = o.timeMs || 1000;
      this.deadline = t0 + timeMs; this.maxEvals = o.maxEvals || Infinity;
      this.nodes = 0; this.evals = 0;
      if (o.seed != null) gseed = o.seed & 0x7fffffff;
      let pos = pos0.clone();
      this.pos = pos;
      const all = pos.legalMoves();
      if (!all.length) return { move: -1, score: -WIN, depth: 0, pv: [], nodes: 0, evals: 0, time: 0 };
      // 複数のワーカーで分けるときは、評価順で i, i+n, i+2n … 番目の候補を受け持つ
      const ev = this.ev;
      let cand = [];
      for (const m of all) { pos.make(m); const v = -ev.evaluate(pos); pos.unmake(m); cand.push({ m, s: v, st: v }); }
      this.evals += all.length;
      // noise: 値に足す揺らぎ（ロジット）。noiseRel: 候補の値の散らばり（標準偏差）に対する割合（学習で値の大きさが変わっても同じ弱さ）
      let noise = o.noise || 0;
      if (o.noiseRel) {
        const vs = cand.map(c => c.s).filter(v => Math.abs(v) < WIN - 300);
        const mu = vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length);
        noise = o.noiseRel * Math.sqrt(vs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, vs.length));
      }
      if (noise) for (const c of cand) if (Math.abs(c.s) < WIN - 300) c.s += noise * grand();
      cand.sort((a, b) => b.s - a.s);
      if (o.split && o.split.n > 1) cand = cand.filter((_, k) => k % o.split.n === o.split.i);
      if (!cand.length) return { move: -1, score: -INF, depth: 0, pv: [], nodes: 0, evals: this.evals, time: Date.now() - t0, legal: all.length }; // 受け持つ候補がない（候補よりワーカーが多い）
      const mk = (c, depth, score, extra) => Object.assign({ move: c.m, score, depth, pv: [c.m], nodes: this.nodes, evals: this.evals, time: Date.now() - t0, legal: all.length }, extra || {});
      let res = mk(cand[0], 1, cand[0].s);
      if (o.onInfo) o.onInfo(res);
      const maxDepth = Math.min(o.maxDepth || 60, 60);
      if (cand.length === 1 && !o.analyze && !o.split) return res;
      if (Math.abs(cand[0].s) >= WIN - 1) return res;
      for (let d = 2; d <= maxDepth; d++) {
        // 複数のワーカーで分けるときは、1つあたりの候補を減らして深く読む（全体では広く深く）
        const K = Math.min(cand.length, Math.max(4, Math.round(this.rootW[Math.min(d, this.rootW.length - 1)] * (o.split && o.split.n > 1 ? Math.min(1, 1.6 / o.split.n) : 1))));
        let alpha = -INF, bestC = null;
        const done = [];
        try {
          for (let j = 0; j < K; j++) {
            const c = cand[j];
            pos.make(c.m);
            let v;
            if (j === 0) v = -this.search(d - 1, -INF, INF, 1);
            else {
              v = -this.search(d - 1, -alpha - EPS, -alpha, 1);
              if (v > alpha) v = -this.search(d - 1, -INF, -alpha, 1);
            }
            pos.unmake(c.m);
            c.v = v; done.push(c);
            if (v > alpha) { alpha = v; bestC = c; }
          }
        } catch (e) {
          if (e !== ABORT) throw e;
          pos = pos0.clone(); this.pos = pos;
          // 途中で時間切れ: 読み終えた候補（最初は前の深さの最善手）の中で一番良いもの
          if (bestC) res = mk(bestC, d, alpha, { partial: true, pv: this.pvFrom(pos0, bestC.m) });
          break;
        }
        // 読んだ候補を値の順に、残りはそのまま後ろに
        const rest = cand.slice(K);
        done.sort((a, b) => b.v - a.v);
        cand = done.concat(rest);
        res = mk(bestC, d, alpha, { pv: this.pvFrom(pos0, bestC.m), top: done.slice(0, 5).map(c => ({ move: c.m, score: c.v })) });
        if (o.onInfo) o.onInfo(res);
        if (Math.abs(alpha) >= WIN - 300) break;
        const el = Date.now() - t0;
        if (el > timeMs * (o.analyze ? 0.6 : 0.3) || this.evals > this.maxEvals * 0.25) break;
      }
      res.nodes = this.nodes; res.evals = this.evals; res.time = Date.now() - t0;
      return res;
    }
  }

  // 評価値（ロジット）→ 手番の側の勝つ見込み
  const winRate = v => (v >= WIN - 300 ? 1 : v <= -WIN + 300 ? 0 : 1 / (1 + Math.exp(-v)));

  // 重みの読み書き: Int16 に量子化して base64（ブラウザと Node の両方）
  const QS = 4096;
  function b64enc(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s);
  }
  function b64dec(str) {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(str, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice(); }
    const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u;
  }
  function packWeights(nodes) {
    const q = new Int16Array(nodes.length * NF);
    nodes.forEach((w, k) => { for (let i = 0; i < NF; i++) q[k * NF + i] = Math.max(-32767, Math.min(32767, Math.round(w[i] * QS))); });
    return b64enc(new Uint8Array(q.buffer));
  }
  function unpackWeights(data, nNodes) {
    const u = b64dec(data), q = new Int16Array(u.buffer, u.byteOffset, u.byteLength >> 1), nodes = [];
    for (let k = 0; k < nNodes; k++) { const w = new Float32Array(NF); for (let i = 0; i < NF; i++) w[i] = q[k * NF + i] / QS; nodes.push(w); }
    return nodes;
  }
  // AMAZONS_WEIGHTS（js/weights.js）から評価関数を作る
  function evalFromWeights(W) {
    if (!W || !W.data) return makeEval(null);
    return makeEval({ nodes: unpackWeights(W.data, NODES.length), gen: W.gen });
  }

  Object.assign(A, {
    WIN, NF, NSQ, QN, MBN, OFF_MM, OFF_MO, OFF_BIAS, NODES, MAXPLY, DB, MB,
    qdist, kdist, mobility, makeEval, extract, territory, Searcher, winRate,
    packWeights, unpackWeights, evalFromWeights, ROOT_W, INNER_W,
    setTwoStage(v) { TWO_STAGE = v; },
  });
  return A;
}
if (typeof module === 'object' && module.exports) module.exports = AmazonsAI;
