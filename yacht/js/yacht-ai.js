/* ヨットの AI（ブラウザ: window.YachtAI、Node: require）
 * - 期待値の最善（つよい）: ルールだけから作った期待値の表（js/table.js）で、点の期待値が最大になるように打つ
 * - 勝率の最善（最強・2人以上）: 自己対局で学んだ小さなネット f（記入した直後の全員の点数表 → その人が1位になる確率）で、
 *   1手番の中の残し方と役の選び方を「勝つ確率の期待値」が最大になるように決める
 * - やさしい: その場で一番点の高い役を狙うだけ。ふつう: 期待値の最善に揺らぎを足したもの
 */
(function (root) {
  'use strict';
  const Y = (typeof module !== 'undefined' && module.exports) ? require('./yacht-core.js') : root.YachtCore;
  const { NCAT, ND, SC, DC } = Y;

  const LEVELS = {
    easy: { label: 'やさしい', stars: 1, desc: 'その場で一番点の高い役を狙います。ときどき迷います' },
    normal: { label: 'ふつう', stars: 2, desc: '期待値の計算で打ちますが、ときどき判断が揺れます' },
    strong: { label: 'つよい', stars: 3, desc: '最後の点数の期待値が最大になるように打ちます（1人なら理論上の最善）' },
    best: { label: '最強', stars: 4, desc: '自己対局で学んだ「勝つ確率」で打ちます。点差に応じて攻めと守りを変えます' },
  };
  const LEVEL_KEYS = Object.keys(LEVELS);

  // ------------------------------------------------------------ 勝つ確率
  // 土台: 各人の最後の点の分布（残りの役が ENDGAME 個以下なら①の打ち方での正確な分布、それより多ければ
  // 「いまの点＋残りの期待値」「残りの標準偏差」の正規分布を整数に分けたもの。どちらもルールから計算）から、自分が一番になる確率（同点は分ける）。
  // ネットは、その対数オッズに足す補正を自己対局で学ぶ（ネットがなければ土台だけ。全員が終盤なら土台だけ）
  const D_IN = 80;
  let NET = null;
  function Phi(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 + 0.5 * y : 0.5 - 0.5 * y;
  }
  // 1人の最後の点の分布 {off, a, cum}（a[i] = P(最後の点 = off + i)、cum[i] = P(< off + i)）。同じ点数表なら使い回す
  const PD = new Map();
  function playerDist(p) {
    const key = `${p.mask},${p.up},${p.raw}`;
    let D = PD.get(key);
    if (D) return D;
    const u = Math.min(63, p.up);
    let off, a;
    if (12 - Y.popcount(p.mask) <= OPT.ENDGAME) { off = p.raw; a = remDist(p.mask, u); }
    else {
      const mu = p.raw + Y.tableValue(p.mask, u), s = Math.max(0.5, Y.tableSD(p.mask, u));
      off = Math.floor(mu - 5 * s);
      a = new Float64Array(Math.ceil(mu + 5 * s) - off + 1);
      let prev = Phi((off - 0.5 - mu) / s), tot = 0;
      for (let i = 0; i < a.length; i++) { const c = Phi((off + i + 0.5 - mu) / s); a[i] = c - prev; prev = c; tot += a[i]; }
      for (let i = 0; i < a.length; i++) a[i] /= tot;
    }
    const cum = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) cum[i + 1] = cum[i] + a[i];
    D = { off, a, cum };
    if (PD.size > 20000) PD.clear();
    PD.set(key, D);
    return D;
  }
  function baseWin(ps) {
    const n = ps.length, D = ps.map(playerDist), a0 = D[0].a;
    let sum = 0;
    for (let i = 0; i < a0.length; i++) {
      if (a0[i] < 1e-12) continue;
      const x = D[0].off + i;
      let pr = 1;
      for (let j = 1; j < n && pr > 0; j++) {
        const Dj = D[j], k = x - Dj.off;
        pr *= k < 0 ? 0 : k >= Dj.a.length ? 1 : Dj.cum[k] + 0.5 * Dj.a[k];
      }
      sum += a0[i] * pr;
    }
    return sum;
  }
  function setNet(w) {
    if (!w) { NET = null; return; }
    const f = a => Float32Array.from(a);
    NET = { h1: w.b1.length, h2: w.b2.length, W1: f(w.W1), b1: f(w.b1), W2: f(w.W2), b2: f(w.b2), W3: f(w.W3), b3: w.b3[0], gen: w.gen || 0 };
    NET.a1 = new Float32Array(NET.h1); NET.a2 = new Float32Array(NET.h2);
  }
  const hasNet = () => !!NET;
  function forward(x) {
    const { h1, h2, W1, b1, W2, b2, W3, a1, a2 } = NET;
    for (let j = 0; j < h1; j++) {
      let s = b1[j];
      const o = j * D_IN;
      for (let i = 0; i < D_IN; i++) s += W1[o + i] * x[i];
      a1[j] = s > 0 ? s : 0;
    }
    for (let j = 0; j < h2; j++) {
      let s = b2[j];
      const o = j * h1;
      for (let i = 0; i < h1; i++) s += W2[o + i] * a1[i];
      a2[j] = s > 0 ? s : 0;
    }
    let s = NET.b3;
    for (let i = 0; i < h2; i++) s += W3[i] * a2[i];
    return s;
  }
  // 点数表の要約: {mask, up, raw}。並びは「自分、そのあと手番の来る順」
  // 入力（80）: 自分 17（埋めた役12・上段・ボーナス確定・残り手番・残りの期待値・標準偏差）、相手3人分 各20（いるか・同じもの・点差・z）、最大の点差・土台の確率・その対数オッズ
  const MU = [0, 0, 0, 0], SDV = [0, 0, 0, 0];
  function playerFeat(p, x, o, j) {
    const u = Math.min(63, p.up), E = Y.tableValue(p.mask, u), sd = Y.tableSD(p.mask, u);
    for (let c = 0; c < NCAT; c++) x[o + c] = (p.mask >> c) & 1;
    x[o + 12] = u / 63; x[o + 13] = p.up >= 63 ? 1 : 0; x[o + 14] = (12 - Y.popcount(p.mask)) / 12; x[o + 15] = E / 100; x[o + 16] = sd / 20;
    MU[j] = p.raw + E; SDV[j] = sd;
  }
  const clampLogit = p => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
  function features(ps, x) {
    x = x || new Float32Array(D_IN);
    x.fill(0);
    const n = ps.length;
    playerFeat(ps[0], x, 0, 0);
    let gmax = -1e9;
    for (let j = 1; j < 4; j++) {
      const o = 17 + (j - 1) * 20;
      if (j >= n) continue;
      x[o] = 1;
      playerFeat(ps[j], x, o + 1, j);
      const g = (MU[j] - MU[0]) / 40;
      x[o + 18] = g;
      x[o + 19] = Math.max(-8, Math.min(8, (MU[j] - MU[0]) / Math.sqrt(SDV[0] * SDV[0] + SDV[j] * SDV[j] + 1) / 3));
      if (g > gmax) gmax = g;
    }
    const pa = baseWin(ps);
    x[77] = n > 1 ? gmax : 0; x[78] = pa; x[79] = clampLogit(pa) / 4;
    return x;
  }
  // ------------------------------------------------------------ 終盤: 残りの点の正確な分布（①の打ち方で）
  // 残りの役が ENDGAME 個以下の人は、正規分布の代わりに正確な分布を使う（4 で 2人の勝ちが +0.3%、train/exp-endgame.js と README）
  const OPT = { ENDGAME: 4 };
  const DIST = new Map();
  function argKeep(S, K, d) {
    let b = S.leaf[d], bk = -1;
    for (let j = Y.subStart[d], e = Y.subStart[d + 1]; j < e; j++) { const k = Y.SUB[j]; if (K[k] > b) { b = K[k]; bk = k; } }
    return bk;
  }
  // 1手番で ①の打ち方をしたときの (役, 点) の確率
  function turnOutcomes(mask, u) {
    const S = Y.newSolve(), bc = new Int8Array(ND);
    Y.soloLeaf(mask, u, S.leaf, bc);
    Y.solveTurn(S);
    let p = new Float64Array(ND), q = new Float64Array(ND);
    const fin = new Float64Array(ND);
    for (let j = Y.trStart[Y.EMPTY], e = Y.trStart[Y.EMPTY + 1]; j < e; j++) p[Y.TR_TO[j]] += Y.TR_P[j];
    for (const K of [S.K1, S.K2]) {
      q.fill(0);
      for (let d = 0; d < ND; d++) {
        if (!p[d]) continue;
        const k = argKeep(S, K, d);
        if (k < 0) { fin[d] += p[d]; continue; }
        for (let j = Y.trStart[k], e = Y.trStart[k + 1]; j < e; j++) q[Y.TR_TO[j]] += p[d] * Y.TR_P[j];
      }
      const t = p; p = q; q = t;
    }
    for (let d = 0; d < ND; d++) fin[d] += p[d];
    const out = new Map();
    for (let d = 0; d < ND; d++) {
      if (!fin[d]) continue;
      const c = bc[d], key = c * 64 + SC[d * NCAT + c];
      out.set(key, (out.get(key) || 0) + fin[d]);
    }
    return out;
  }
  // 残りの点（ボーナス込み）の分布 a[x] = P(残り = x)
  function remDist(mask, u) {
    if (mask === Y.ALL) { const a = new Float64Array(u >= 63 ? Y.BONUS + 1 : 1); a[a.length - 1] = 1; return a; }
    const key = mask * 64 + u;
    let a = DIST.get(key);
    if (a) return a;
    const parts = [];
    let len = 1;
    for (const [k2, pr] of turnOutcomes(mask, u)) {
      const c = k2 >> 6, s = k2 & 63, d2 = remDist(mask | (1 << c), c < 6 ? Y.upAdd(u, s) : u);
      parts.push([s, pr, d2]);
      if (s + d2.length > len) len = s + d2.length;
    }
    a = new Float64Array(len);
    for (const [s, pr, d2] of parts) for (let i = 0; i < d2.length; i++) a[s + i] += pr * d2[i];
    DIST.set(key, a);
    return a;
  }
  // 終盤に入る直前の人（残り ENDGAME+1）が次の手番で使う分布を、手のすいているときに先に計算しておくための一覧
  const SCORESET = [...Array(NCAT)].map((_, c) => { const s = new Set(); for (let d = 0; d < ND; d++) s.add(SC[d * NCAT + c]); return [...s]; });
  function warmTasks(sheets) {
    const out = [], seen = new Set();
    for (const sh of sheets) {
      if (12 - Y.popcount(sh.mask) !== OPT.ENDGAME + 1) continue;
      const u = Math.min(63, sh.up);
      for (let c = 0; c < NCAT; c++) {
        if (sh.mask & (1 << c)) continue;
        for (const s of SCORESET[c]) {
          const m = sh.mask | (1 << c), u2 = c < 6 ? Y.upAdd(u, s) : u, k = m * 64 + u2;
          if (!seen.has(k) && !DIST.has(k)) { seen.add(k); out.push([m, u2]); }
        }
      }
    }
    return out;
  }

  // 全員が終わっていれば勝ち分そのもの、全員が終盤なら土台だけ（正確）、そうでなければ 土台（＋ネットの補正）
  const X = new Float32Array(D_IN);
  const allEnd = ps => ps.every(p => 12 - Y.popcount(p.mask) <= OPT.ENDGAME);
  function winValue(ps) {
    let done = true;
    for (const p of ps) if (p.mask !== Y.ALL) { done = false; break; }
    if (done) { const t = ps.map(p => p.raw + (p.up >= 63 ? Y.BONUS : 0)); return Y.shares(t)[0]; }
    if (allEnd(ps)) return baseWin(ps);
    const x = features(ps, X);
    if (!NET) return x[78];
    return 1 / (1 + Math.exp(-(x[79] * 4 + forward(x))));
  }
  const sumOf = sh => ({ mask: sh.mask, up: sh.up, raw: sh.raw });
  // 席 me から見た並び（自分、次の人、…）
  function ordered(sheets, me) {
    const n = sheets.length, out = [];
    for (let j = 0; j < n; j++) out.push(sumOf(sheets[(me + j) % n]));
    return out;
  }

  // ------------------------------------------------------------ 1手番の計画
  // kind: 'solo'（期待値）/ 'win'（勝率）。plan.S.leaf / K1 / K2 で残し方、catValue で役ごとの値
  function planSolo(sh) {
    const S = Y.newSolve(), u = Y.uOf(sh);
    Y.soloLeaf(sh.mask, u, S.leaf);
    Y.solveTurn(S);
    return {
      kind: 'solo', S, base: sh.raw, mask: sh.mask,
      catValue(c, s) { return s + Y.tableValue(sh.mask | (1 << c), c < 6 ? Y.upAdd(u, s) : u); },
    };
  }
  function planWin(sheets, me) {
    const ps = ordered(sheets, me), my = ps[0];
    const memo = new Map();
    const catValue = (c, s) => {
      const key = c * 64 + s;
      let v = memo.get(key);
      if (v === undefined) {
        ps[0] = { mask: my.mask | (1 << c), up: c < 6 ? my.up + s : my.up, raw: my.raw + s };
        v = winValue(ps);
        ps[0] = my;
        memo.set(key, v);
      }
      return v;
    };
    const S = Y.newSolve();
    for (let d = 0; d < ND; d++) {
      let b = -1;
      for (let c = 0; c < NCAT; c++) {
        if (my.mask & (1 << c)) continue;
        const v = catValue(c, SC[d * NCAT + c]);
        if (v > b) b = v;
      }
      S.leaf[d] = b;
    }
    Y.solveTurn(S);
    return { kind: 'win', S, catValue, mask: my.mask };
  }
  // level: 'easy' | 'normal' | 'strong' | 'best'
  function plan(sheets, me, level) {
    if (level === 'easy') return { kind: 'greedy', mask: sheets[me].mask };
    if (level === 'best' && sheets.length > 1) return planWin(sheets, me);
    return planSolo(sheets[me]);
  }

  // ------------------------------------------------------------ 決める
  function gauss(rnd) { let u = 0; while (!u) u = rnd(); const v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const NOISE = { normal: 1.6 }; // 1人の平均点が 約160 になる大きさ（train/tune-noise.js）
  // 振ったあと: 残す組（-1 なら止める）
  function decideKeep(P, d, rollsLeft, level, rnd) {
    if (P.kind === 'greedy') return greedyKeep(P, d, rnd);
    const S = P.S, K = rollsLeft >= 2 ? S.K1 : S.K2;
    const sig = NOISE[level] || 0;
    let best = -1, bv = S.leaf[d] + (sig ? sig * gauss(rnd) : 0);
    for (let j = Y.subStart[d], e = Y.subStart[d + 1]; j < e; j++) {
      const k = Y.SUB[j];
      const v = K[k] + (sig ? sig * gauss(rnd) : 0);
      if (v > bv) { bv = v; best = k; }
    }
    return best;
  }
  function catOptions(P, d) {
    const out = [];
    for (let c = 0; c < NCAT; c++) {
      if (P.mask & (1 << c)) continue;
      const s = SC[d * NCAT + c];
      out.push({ cat: c, pts: s, v: P.kind === 'greedy' ? greedyCatValue(c, s) : P.catValue(c, s) });
    }
    out.sort((a, b) => b.v - a.v);
    return out;
  }
  function decideCat(P, d, level, rnd) {
    const opts = catOptions(P, d);
    const sig = NOISE[level] || 0;
    if (!sig) return opts[0].cat;
    let best = opts[0].cat, bv = -1e9;
    for (const o of opts) { const v = o.v + sig * gauss(rnd); if (v > bv) { bv = v; best = o.cat; } }
    return best;
  }

  // ------------------------------------------------------------ やさしい（その場の点だけ）
  const ZERO_ORDER = [0, 11, 1, 7, 10, 9, 8, 2, 3, 4, 5, 6]; // 0点を入れるならこの順
  function greedyCatValue(c, s) { return s > 0 ? s + (c === Y.CHOICE ? -12 : 0) + (c < 6 && s >= 3 * (c + 1) ? 6 : 0) : -1 - ZERO_ORDER.indexOf(c) * 0.01; }
  function keepOfCounts(kc) {
    for (let k = 0; k < Y.NK; k++) { const x = Y.KC[k]; let ok = true; for (let i = 0; i < 6; i++) if (x[i] !== kc[i]) { ok = false; break; } if (ok) return k; }
    return -1;
  }
  function greedyKeep(P, d, rnd) {
    const c = DC[d], open = cat => !(P.mask & (1 << cat));
    const now = catOptions(P, d)[0];
    if (now.pts >= 30 && now.cat >= 8) return -1; // 大きな役ができていれば止める
    if (rnd() < 0.15) { // ときどき適当に残す
      const j = Y.subStart[d] + Math.floor(rnd() * (Y.subStart[d + 1] - Y.subStart[d]));
      return Y.SUB[j];
    }
    // 4つ並びが見えていてストレートが空いていれば並びを残す
    if (open(Y.LSTR) || open(Y.BSTR)) {
      for (const run of [[1, 2, 3, 4], [0, 1, 2, 3], [2, 3, 4, 5]]) {
        if (run.every(i => c[i] > 0)) { const kc = [0, 0, 0, 0, 0, 0]; run.forEach(i => { kc[i] = 1; }); return keepOfCounts(kc); }
      }
    }
    // いちばん多い目（同じなら大きい目）を残す
    let bf = 5;
    for (let i = 5; i >= 0; i--) if (c[i] > c[bf]) bf = i;
    const kc = [0, 0, 0, 0, 0, 0]; kc[bf] = c[bf];
    return c[bf] === 5 ? -1 : keepOfCounts(kc);
  }

  // ------------------------------------------------------------ AI補助: 残し方と役の値の一覧
  // 返す: { keeps: [{keep, v}], cats: [{cat, pts, v}] }（v は 期待の最終点 / 勝つ確率）
  function advise(P, d, rollsLeft) {
    const add = P.kind === 'solo' ? P.base : 0;
    const keeps = rollsLeft > 0 ? Y.keepOptions(P.S, d, rollsLeft).map(o => ({ keep: o.keep, v: o.v + add })) : [{ keep: -1, v: P.S.leaf[d] + add }];
    const cats = catOptions(P, d).map(o => ({ cat: o.cat, pts: o.pts, v: o.v + add }));
    return { keeps, cats };
  }
  // 手番の始め（まだ振っていない）の値
  const startValue = P => P.S.start + (P.kind === 'solo' ? P.base : 0);

  const api = {
    NOISE, OPT, remDist, baseWin, allEnd, warmTasks, LEVELS, LEVEL_KEYS, D_IN, setNet, hasNet, get netGen() { return NET ? NET.gen : 0; }, features, winValue, ordered, forward: x => forward(x),
    plan, planSolo, planWin, decideKeep, decideCat, catOptions, advise, startValue, gauss,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YachtAI = api;
})(typeof self !== 'undefined' ? self : this);
