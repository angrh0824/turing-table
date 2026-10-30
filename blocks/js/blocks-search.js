/* ブロック陣取りの CPU の読み（ブラウザの Web Worker と Node で同じものを使う）
 *
 *   const s = new BlocksSearch.Search(net, { seed });
 *   const r = s.run(pos, { timeMs: 2000, maxSims: 800, onInfo });   // 多人数の木探索（PUCT。各局面で手番の色が自分の値を大きくする）
 *   // → { move, sims, kids: [{ m, n, q, p }], util（色ごと）, score（色ごとの得点の見込み）, pv }
 *   BlocksSearch.policyMove(net, pos, rand)   // 読まずに方策だけで（いちばん弱い段）
 *   BlocksSearch.bigMove(pos, rand)           // 自作の基準: いちばん大きいピースの置き方からでたらめに（ネットがないとき）
 *
 * 値: 色ごとに「順位の値（1位 +1 … 最下位 −1）+ 0.1 × tanh(得点の差 / 10)」。順位の値と得点の見込みはネット（js/blocks-nn.js）、終局は本当の得点
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./blocks-core.js'));
  else root.BlocksSearch = factory(root.BlocksCore);
})(typeof self !== 'undefined' ? self : this, function (BC) {
  'use strict';
  const SU = 0.1, SCALE = 10, C_PUCT = 1.6, FPU = 0.25, KEEP = 64;

  function mulberry(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 色 c の得点の差（4人 = 自分 − ほかの平均、2色ずつ = 味方の合計 − 相手の合計、2人 = 自分 − 相手）
  function margin(pos, sc, c) {
    const nc = pos.nc, own = pos.R.owner;
    if (pos.mode === 'classic') { let o = 0; for (let k = 0; k < nc; k++) if (k !== c) o += sc[k]; return sc[c] - o / (nc - 1); }
    let me = 0, op = 0;
    for (let k = 0; k < nc; k++) { if (own[k] === own[c]) me += sc[k]; else op += sc[k]; }
    return me - op;
  }
  function utilOf(pos, u, s) {
    const nc = pos.nc, out = new Float64Array(nc);
    for (let c = 0; c < nc; c++) out[c] = u[c] + SU * Math.tanh(margin(pos, s, c) / SCALE);
    return out;
  }

  class Node {
    constructor(nc) { this.stm = -1; this.done = 0; this.n = 0; this.w = new Float64Array(nc); this.ws = new Float64Array(nc); this.moves = null; this.prior = null; this.kids = null; this.term = false; this.tu = null; this.ts = null; }
  }

  class Search {
    constructor(net, opts = {}) {
      this.net = net;
      this.rand = mulberry(opts.seed || 12345);
      this.buf = new Int32Array(8192);
      this.noise = opts.noise || 0; // 根の方策に混ぜるノイズ（最強で Worker ごとに読みを散らす）
    }
    // 葉を広げる: 合法手と方策・値。置けない色はパスにする
    expand(node, pos) {
      const k = pos.legal(this.buf);
      node.stm = pos.turn; node.done = pos.done;
      if (!k) {
        node.term = true;
        const oc = pos.outcome();
        node.ts = Float64Array.from(oc.scores);
        node.tu = utilOf(pos, oc.colorUtil, oc.scores);
        return { u: node.tu, s: node.ts };
      }
      const moves = Int32Array.from(this.buf.subarray(0, k));
      const r = this.net.evalPos(pos, moves, (this.rand() * 2) | 0);
      let order = null;
      if (k > KEEP && node !== this.root) {
        // 途中の局面は方策の上位だけを残す（読む手の数を絞り、記憶も節約する）
        order = Array.from({ length: k }, (_, i) => i).sort((a, b) => r.logp[b] - r.logp[a]).slice(0, KEEP);
      }
      const kk = order ? order.length : k;
      node.moves = new Int32Array(kk); node.prior = new Float32Array(kk); node.kids = new Array(kk).fill(null);
      let sum = 0;
      for (let i = 0; i < kk; i++) { const j = order ? order[i] : i; node.moves[i] = moves[j]; const p = Math.exp(r.logp[j]); node.prior[i] = p; sum += p; }
      for (let i = 0; i < kk; i++) node.prior[i] /= sum;
      return { u: utilOf(pos, r.u, r.s), s: r.s };
    }
    select(node) {
      const c = node.stm, kids = node.kids, pr = node.prior, k = pr.length;
      const sq = Math.sqrt(Math.max(1, node.n));
      // まだ読んでいない手の値: 親の値から、読んだ手の方策の重みに応じて少し下げる
      let seen = 0;
      for (let a = 0; a < k; a++) if (kids[a] && kids[a].n) seen += pr[a];
      const fpu = (node.n ? node.w[c] / node.n : 0) - FPU * Math.sqrt(seen);
      let best = 0, bs = -Infinity;
      for (let a = 0; a < k; a++) {
        const ch = kids[a], n = ch ? ch.n : 0;
        const q = n ? ch.w[c] / n : fpu;
        const v = q + C_PUCT * pr[a] * sq / (1 + n);
        if (v > bs) { bs = v; best = a; }
      }
      return best;
    }
    // 読みを始める（終局なら false）。そのあと step を何度か呼び、summary で結果
    begin(pos0) {
      const pos = this.pos = pos0.clone(), nc = pos.nc;
      this.t0 = Date.now(); this.sims = 0;
      this.root = new Node(nc);
      const r0 = this.expand(this.root, pos);
      this.root.n = 1;
      for (let c = 0; c < nc; c++) { this.root.w[c] = r0.u[c]; this.root.ws[c] = r0.s[c]; }
      if (this.root.term) return false;
      if (this.noise && this.root.prior.length > 1) {
        // 最強の Worker どうしで読みを散らすための小さなノイズ（同じ木を読まないように）
        const pr = this.root.prior;
        let s = 0;
        for (let a = 0; a < pr.length; a++) { pr[a] = pr[a] * (1 - this.noise) + this.noise * -Math.log(Math.max(1e-9, this.rand())) / pr.length; s += pr[a]; }
        for (let a = 0; a < pr.length; a++) pr[a] /= s;
      }
      this.path = [];
      return true;
    }
    // until（時刻）か maxSims まで読む。読み終わったら true
    step(until, maxSims) {
      const pos = this.pos, nc = pos.nc, path = this.path;
      if (this.root.moves.length === 1) return true;
      while (this.sims < maxSims) {
        path.length = 0;
        let node = this.root, depth = 0;
        path.push(node);
        let v;
        for (;;) {
          if (node.term) { v = { u: node.tu, s: node.ts }; break; }
          const a = this.select(node);
          pos.turn = node.stm; pos.done = node.done;
          pos.play(node.moves[a]); depth++;
          let ch = node.kids[a];
          if (!ch) { ch = node.kids[a] = new Node(nc); path.push(ch); v = this.expand(ch, pos); break; }
          path.push(ch);
          node = ch;
        }
        for (let i = 0; i < path.length; i++) { const nd = path[i]; nd.n++; for (let c = 0; c < nc; c++) { nd.w[c] += v.u[c]; nd.ws[c] += v.s[c]; } }
        for (; depth > 0; depth--) pos.undo();
        this.sims++;
        if (Date.now() >= until) return this.sims >= maxSims;
      }
      return true;
    }
    run(pos0, opts = {}) {
      const timeMs = opts.timeMs || 1000, maxSims = opts.maxSims || 1e9;
      if (!this.begin(pos0)) return null;
      const end = this.t0 + timeMs;
      for (;;) {
        const now = Date.now(), slice = Math.min(end, now + 250);
        const fin = this.step(slice, maxSims);
        if (fin || Date.now() >= end) break;
        if (opts.onInfo) opts.onInfo(this.summary(this.sims, Date.now() - this.t0));
      }
      return this.summary(this.sims, Date.now() - this.t0);
    }
    summary(sims, ms) {
      const root = this.root, nc = root.w.length, k = root.moves.length;
      const kids = [];
      for (let a = 0; a < k; a++) {
        const ch = root.kids[a];
        kids.push({ m: root.moves[a], n: ch ? ch.n : 0, q: ch && ch.n ? ch.w[root.stm] / ch.n : null, p: root.prior[a] });
      }
      kids.sort((x, y) => y.n - x.n || (y.q ?? -9) - (x.q ?? -9) || y.p - x.p);
      const util = new Float64Array(nc), score = new Float64Array(nc);
      for (let c = 0; c < nc; c++) { util[c] = root.w[c] / root.n; score[c] = root.ws[c] / root.n; }
      // 読み筋: いちばん多く読んだ手を順にたどる
      const pv = [];
      let nd = root;
      while (nd && nd.kids && pv.length < 8) {
        let b = -1, bn = 0;
        for (let a = 0; a < nd.kids.length; a++) { const ch = nd.kids[a]; if (ch && ch.n > bn) { bn = ch.n; b = a; } }
        if (b < 0 || bn < 2) break;
        pv.push(nd.moves[b]); nd = nd.kids[b];
      }
      return { move: kids[0].m, sims, ms, kids: kids.slice(0, 24), util: Array.from(util), score: Array.from(score), pv, stm: root.stm, moves: k };
    }
  }

  // 読まずに方策だけで打つ（温度 1。確率 3% 未満の手は選ばない）
  function policyMove(net, pos, rand = Math.random) {
    const buf = new Int32Array(8192), k = pos.legal(buf);
    if (!k) return -1;
    const moves = buf.subarray(0, k), r = net.evalPos(pos, moves, (rand() * 2) | 0);
    let best = 0;
    for (let i = 1; i < k; i++) if (r.logp[i] > r.logp[best]) best = i;
    let s = 0;
    const w = new Float64Array(k);
    for (let i = 0; i < k; i++) { const p = Math.exp(r.logp[i]); w[i] = p >= 0.03 || i === best ? p : 0; s += w[i]; }
    let x = rand() * s;
    for (let i = 0; i < k; i++) { x -= w[i]; if (x <= 0) return moves[i]; }
    return moves[best];
  }
  function bigMove(pos, rand = Math.random) {
    const buf = new Int32Array(8192), k = pos.legal(buf);
    if (!k) return -1;
    let mx = 0;
    for (let i = 0; i < k; i++) { const sz = BC.PIECE_SIZE[pos.T.P_PC[buf[i]]]; if (sz > mx) mx = sz; }
    const c = [];
    for (let i = 0; i < k; i++) if (BC.PIECE_SIZE[pos.T.P_PC[buf[i]]] === mx) c.push(buf[i]);
    return c[Math.floor(rand() * c.length)];
  }
  // 根で分けて読んだ結果（Worker ごと）を足し合わせる（root parallel）
  function merge(results) {
    const rs = results.filter(Boolean);
    if (!rs.length) return null;
    if (rs.length === 1) return rs[0];
    const by = new Map();
    let sims = 0;
    const nc = rs[0].util.length, util = new Array(nc).fill(0), score = new Array(nc).fill(0);
    for (const r of rs) {
      sims += r.sims;
      for (let c = 0; c < nc; c++) { util[c] += r.util[c] * r.sims; score[c] += r.score[c] * r.sims; }
      for (const k of r.kids) {
        const e = by.get(k.m) || { m: k.m, n: 0, qs: 0, p: k.p };
        e.n += k.n; if (k.q != null) e.qs += k.q * k.n;
        by.set(k.m, e);
      }
    }
    const kids = Array.from(by.values()).map(e => ({ m: e.m, n: e.n, q: e.n ? e.qs / e.n : null, p: e.p })).sort((a, b) => b.n - a.n || (b.q ?? -9) - (a.q ?? -9) || b.p - a.p);
    for (let c = 0; c < nc; c++) { util[c] /= Math.max(1, sims); score[c] /= Math.max(1, sims); }
    const best = rs.slice().sort((a, b) => b.sims - a.sims)[0];
    return { move: kids[0].m, sims, ms: Math.max(...rs.map(r => r.ms)), kids: kids.slice(0, 24), util, score, pv: kids[0].m === best.move ? best.pv : [kids[0].m], stm: rs[0].stm, moves: rs[0].moves };
  }

  return { Search, policyMove, bigMove, merge, margin, utilOf, mulberry };
});
