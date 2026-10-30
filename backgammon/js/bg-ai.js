/* バックギャモンの AI: 浅い読み（サイコロ21通りの期待値）・キューブの判断・マッチの勝率表（どれも自分で計算。人の作った表は使わない）
 *
 *   const E = new BGAI.Engine(weights)      weights = { H, w: Float32Array }
 *   E.evalPos(me, opp, ply)                 手番側（これから振る側）から見た5つの確率
 *   E.rankMoves(me, opp, d1, d2, opt)       合法手を評価の高い順に（opt.ply = 0..3、opt.metric = 点の数え方）
 *   E.cube(st, ply)                         キューブの判断（ダブルするか・受けるか）
 *
 * 用語: 「n手読み」は、動かしたあとの局面から相手（と自分）のサイコロ 21通りを n 回たどって平均する（各手番は1手読みの最善で動かす）。
 *   0手読み = 動かしたあとの局面をネットで評価するだけ
 */
(function (root, factory) {
  const BG = typeof module === 'object' && module.exports ? require('./bg-core.js') : root.BG;
  const NET = typeof module === 'object' && module.exports ? require('./bg-net.js') : root.BGNet;
  const AI = factory(BG, NET);
  if (typeof module === 'object' && module.exports) module.exports = AI;
  else root.BGAI = AI;
})(typeof self !== 'undefined' ? self : this, function (BG, NET) {
  'use strict';
  const ROLLS = BG.ROLLS;
  const { flip, equity } = NET;

  // 勝ち方の確率に分ける: [シングル勝ち, ギャモン勝ち, BG勝ち, シングル負け, ギャモン負け, BG負け]
  function split(p) {
    return [p[0] - p[1], p[1] - p[2], p[2], 1 - p[0] - p[3], p[3] - p[4], p[4]];
  }

  function Engine(weights, opt) {
    this.net = new NET.Net(weights.H, weights.w);
    this.opt = Object.assign({ prune1: 8, prune2: 4, inner: 2 }, opt || {});
    this.nodes = 0;
    this._p = new Float32Array(5); this._q = new Float32Array(5);
  }
  // 静的評価（手番側から）
  Engine.prototype.static = function (me, opp) {
    const p = new Float32Array(5);
    this.net.evaluate(me, opp, p);
    this.nodes++;
    return p;
  };
  // 動かしたあと（相手が振る番）の局面を、動かした側から見た確率に。上がりきって勝っていれば結果そのもの
  // pm・po = 動かす前の局面（手番側・相手）。あれば差分で速く評価する
  Engine.prototype.after = function (m, depth, pm, po) {
    if (BG.offCount(m.me) === 15) {
      const k = BG.winKind(m.me, m.opp);
      return new Float32Array([1, k >= 2 ? 1 : 0, k >= 3 ? 1 : 0, 0, 0]);
    }
    let v;
    if (depth > 0) v = this.evalPos(m.opp, m.me, depth);
    else if (pm) { v = new Float32Array(5); this.net.ensureBase(po, pm); this.net.evaluateFrom(m.opp, m.me, v); this.nodes++; }
    else v = this.static(m.opp, m.me);
    return flip(v, new Float32Array(5));
  };
  // 局面（me が振る番）の確率を、ply 回サイコロをたどって平均する
  Engine.prototype.evalPos = function (me, opp, ply) {
    if (ply <= 0) return this.static(me, opp);
    const acc = new Float32Array(5);
    const K = ply >= 2 ? this.opt.inner : 1;
    for (const [a, b, w] of ROLLS) {
      const L = BG.legalMoves(me, opp, a, b);
      let best;
      if (K === 1 || L.length === 1) {
        best = this.bestAt(L, 0, ply - 1, me, opp);
      } else {
        // 0手読みで上位 K 手に絞ってから深く
        const s = L.map(m => ({ m, v: this.after(m, 0, me, opp) })).sort((x, y) => equity(y.v) - equity(x.v)).slice(0, K);
        best = null;
        let be = -Infinity;
        for (const c of s) { const v = this.after(c.m, ply - 1); const e = equity(v); if (e > be) { be = e; best = v; } }
      }
      for (let k = 0; k < 5; k++) acc[k] += w * best[k];
    }
    return acc;
  };
  // 手の一覧から、0手読みで選んだ最善手を depth で評価した値（動かした側から）
  Engine.prototype.bestAt = function (L, selDepth, depth, pm, po) {
    let best = null, be = -Infinity, bm = null;
    for (const m of L) {
      const v = this.after(m, selDepth, pm, po);
      const e = equity(v);
      if (e > be) { be = e; best = v; bm = m; }
    }
    return depth === selDepth ? best : this.after(bm, depth);
  };

  // 合法手を並べる。opt: { ply: 0..3, metric: 確率 → 値（大きいほど良い。手番側から）, noise: 0手読みの値に足す揺らぎ, rnd, all: 1手しかなくても評価する }
  // 浅い読みで良い順に並べ、上位だけを1段ずつ深く読み直す（prune: 各段で残す手の数）
  // 返り値: [{ m, p:確率（動かした側から）, v:値, ply:読んだ深さ }]（深く読んだものから、同じ深さなら良い順）
  Engine.prototype.rankMoves = function (me, opp, d1, d2, opt) {
    opt = opt || {};
    const metric = opt.metric || equity, ply = opt.ply || 0;
    const L = BG.legalMoves(me, opp, d1, d2);
    if (L.length === 1 && !opt.all) return [{ m: L[0], p: null, v: 0, ply: 0 }];
    let list = L.map(m => { const p = this.after(m, 0, me, opp); return { m, p, v: metric(p), ply: 0 }; });
    if (opt.noise) { const r = opt.rnd || Math.random; for (const c of list) c.v += (r() + r() + r() - 1.5) * opt.noise; }
    list.sort((a, b) => b.v - a.v);
    const width = [0, opt.prune1 || this.opt.prune1, opt.prune2 || this.opt.prune2, opt.prune3 || 2];
    for (let d = 1; d <= ply; d++) {
      const n = Math.min(list.length, width[d]);
      for (let i = 0; i < n; i++) { const c = list[i]; c.p = this.after(c.m, d); c.v = metric(c.p); c.ply = d; }
      list = list.slice(0, n).sort((a, b) => b.v - a.v).concat(list.slice(n));
    }
    return list;
  };

  // ------------------------------------------------------------------ 点の数え方（マネー・マッチ）とマッチの勝率表
  // 勝率表は「ギャモン率」と「キューブの効き（x）」から自分で計算する（自己対局で測った値を使う）
  const PARAM = { gammon: 0.26, bg: 0.012, x: 0.7 };
  const metCache = new Map();
  // a, b: 自分・相手があと何点で勝ちか。cd = クロフォードの局はもう済んだか。返り値: 自分がマッチに勝つ確率（局の始まり、キューブは真ん中）
  function MET(a, b, cd) {
    if (a <= 0) return 1;
    if (b <= 0) return 0;
    if (a === 1 && b === 1) return 0.5;
    const k = `${a},${b},${cd ? 1 : 0},${PARAM.gammon},${PARAM.bg},${PARAM.x}`;
    if (metCache.has(k)) return metCache.get(k);
    let v;
    const g = PARAM.gammon, bgr = PARAM.bg;
    const r = [1 - g, g - bgr, bgr], s = r;
    if ((a === 1 || b === 1) && !cd) {
      // クロフォードの局: キューブなし
      const W = r[0] * MET(a - 1, b, true) + r[1] * MET(a - 2, b, true) + r[2] * MET(a - 3, b, true);
      const L = s[0] * MET(a, b - 1, true) + s[1] * MET(a, b - 2, true) + s[2] * MET(a, b - 3, true);
      v = 0.5 * W + 0.5 * L;
    } else {
      const sc = matchScorer(a, b, cd, r, s);
      v = cubeful(sc, 0.5, 1, -1);
      // すぐダブルしたほうが得な側（ポスト・クロフォードの負けている側など）は、最初の番でダブルする
      const nd = v;
      if (sc.canDouble(0, 1)) { const t = Math.min(cubeful(sc, 0.5, 2, 1), sc.win(1)); if (t > nd) v = t; }
      const f = flipScorer(sc);
      if (f.canDouble(0, 1)) { const t = Math.min(cubeful(f, 0.5, 2, 1), f.win(1)); if (t > 1 - nd) v = v === nd ? 1 - t : (v + 1 - t) / 2; }
    }
    metCache.set(k, v);
    return v;
  }
  // マッチの点の数え方（自分から見たマッチ勝率）。r・s = 勝ち・負けのうちシングル・ギャモン・BG の割合
  function matchScorer(a, b, cd, r, s) {
    // この局が終わったあとクロフォードはもう済んだか: 今がクロフォードかその後なら済み
    const nextCd = cd || a === 1 || b === 1;
    const win = k => MET(a - k, b, nextCd), lose = k => MET(a, b - k, nextCd);
    return {
      money: false, a, b, r, s, win, lose,
      canDouble: (who, c) => (who === 0 ? c < a : c < b) && !((a === 1 || b === 1) && !cd),
      W: c => r[0] * win(c) + r[1] * win(2 * c) + r[2] * win(3 * c),
      L: c => s[0] * lose(c) + s[1] * lose(2 * c) + s[2] * lose(3 * c),
    };
  }
  // マネーの点の数え方（自分から見た点）
  function moneyScorer(r, s, jacobyCentered) {
    return {
      money: true, r, s,
      win: k => k, lose: k => -k,
      canDouble: (who, c) => c < 64,
      W: c => c * (jacobyCentered && c === 1 ? 1 : r[0] + 2 * r[1] + 3 * r[2]),
      L: c => -c * (jacobyCentered && c === 1 ? 1 : s[0] + 2 * s[1] + 3 * s[2]),
    };
  }

  // キューブの効きを入れた値（Janowski の考え方を一般化: 「キューブが完全に生きている」場合の値と「死んでいる」場合の値を x で混ぜる）
  // sc: 点の数え方、p: 自分の勝つ確率、c: キューブの値、owner: -1 真ん中 / 0 自分 / 1 相手
  function dead(sc, p, c) { return p * sc.W(c) + (1 - p) * sc.L(c); }
  // 相手（who=1）または自分（who=0）が、キューブ 2c を受けて持ったときの「受けてよい最低の勝率」（受ける側から見た勝率）
  function takePoint(sc, who, c2) {
    // 受ける側から見た「持っているときの値」の直線と、パスの値が等しくなるところ
    const S = who === 0 ? sc : flipScorer(sc);
    const pass = S.lose(c2 / 2);
    const L = S.L(c2), Wc = S.W(c2);
    if (!S.canDouble(0, c2)) return ratio(pass - L, Wc - L); // 受けたあともう上げられない: 死んだキューブ
    const cp = cashPoint(S, c2);
    const cash = S.win(c2);
    return clamp01(cp * ratio(pass - L, cash - L));
  }
  // 自分がキューブ c を持っていて（または真ん中で）2c に上げたとき、相手がパスし始める自分の勝率
  function cashPoint(sc, c) { return 1 - takePoint(sc, 1, 2 * c); }
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ratio = (a, b) => (b > 1e-12 ? clamp01(a / b) : a > 0 ? 1 : 0);
  // 相手から見た数え方
  function flipScorer(sc) {
    if (sc._flip) return sc._flip;
    const f = {
      money: sc.money, a: sc.b, b: sc.a, r: sc.s, s: sc.r,
      win: k => (sc.money ? k : 1 - sc.lose(k)), lose: k => (sc.money ? -k : 1 - sc.win(k)),
      canDouble: (who, c) => sc.canDouble(who ^ 1, c),
      W: c => (sc.money ? -sc.L(c) : 1 - sc.L(c)), L: c => (sc.money ? -sc.W(c) : 1 - sc.W(c)),
    };
    f._flip = sc; sc._flip = f;
    return f;
  }
  function live(sc, p, c, owner) {
    // 自分のキャッシュ点（自分が上げると相手が降りる勝率）と、相手のキャッシュ点（自分の勝率で見て、これ以下だと降りる）
    const meCan = owner !== 1 && sc.canDouble(0, c);
    const oppCan = owner !== 0 && sc.canDouble(1, c);
    const hiP = meCan ? cashPoint(sc, c) : 1, hiV = meCan ? sc.win(c) : sc.W(c);
    const loP = oppCan ? 1 - cashPoint(flipScorer(sc), c) : 0, loV = oppCan ? sc.lose(c) : sc.L(c);
    if (p >= hiP) return hiV;
    if (p <= loP) return loV;
    return loV + (hiV - loV) * (p - loP) / (hiP - loP);
  }
  function cubeful(sc, p, c, owner) {
    const x = PARAM.x;
    return x * live(sc, p, c, owner) + (1 - x) * dead(sc, p, c);
  }

  // ------------------------------------------------------------------ 局面の値・キューブの判断
  // st: bg-core の対局の状態（手番側 = st.turn）。p: 手番側から見た5つの確率
  function scorerFor(st, p, side) {
    const sp = split(p);
    const w = sp[0] + sp[1] + sp[2], l = 1 - w;
    const r = w > 1e-6 ? [sp[0] / w, sp[1] / w, sp[2] / w] : [1, 0, 0];
    const s = l > 1e-6 ? [sp[3] / l, sp[4] / l, sp[5] / l] : [1, 0, 0];
    if (BG.isMoney(st.cfg)) return { sc: moneyScorer(r, s, st.cfg.jacoby && st.cube === 1 && st.owner === -1), w };
    const me = side, a = st.cfg.len - st.score[me], b = st.cfg.len - st.score[me ^ 1];
    // cd = クロフォードの局はもう済んだか（今がクロフォードの局なら「まだ」で、matchScorer がキューブなしにする）
    const cd = !st.crawford && (a === 1 || b === 1);
    return { sc: matchScorer(a, b, cd, r, s), w };
  }
  // キューブなしの値（手の選び方に使う）: マネーは点（×キューブ）、マッチはマッチの勝率
  function metricFor(st, side) {
    if (BG.isMoney(st.cfg)) return p => equity(p);
    return p => {
      const sp = split(p), me = side, a = st.cfg.len - st.score[me], b = st.cfg.len - st.score[me ^ 1];
      const cd = st.crawford || a === 1 || b === 1; // この局のあとは、クロフォードの局はもう済んでいる
      const c = st.cube;
      const win = k => MET(a - k, b, cd), lose = k => MET(a, b - k, cd);
      return sp[0] * win(c) + sp[1] * win(2 * c) + sp[2] * win(3 * c) + sp[3] * lose(c) + sp[4] * lose(2 * c) + sp[5] * lose(3 * c);
    };
  }
  // ダブルの判断。p は手番側（ダブルする側）から見た確率（振る前の局面の値）
  // 返り値: { nd, dt, dp: 値（マネーは今のキューブ1あたりの点、マッチはマッチ勝率）, double: bool, take: bool, beaver: bool, label }
  function cubeDecision(st, p, x) {
    if (x != null && x !== PARAM.x) { const keep = PARAM.x; PARAM.x = x; try { return cubeDecision(st, p); } finally { PARAM.x = keep; } }
    const side = st.turn;
    const { sc } = scorerFor(st, p, side);
    const pw = p[0], c = st.cube, owner = st.owner === -1 ? -1 : st.owner === side ? 0 : 1;
    const nd = cubeful(sc, pw, c, owner);
    // ダブルのあと（相手が 2c を持つ）は、ジャコビーは関係なくなる
    const sc2 = BG.isMoney(st.cfg) && st.cfg.jacoby ? scorerFor(Object.assign({}, st, { cube: 2, owner: side ^ 1 }), p, side).sc : sc;
    const dt = cubeful(sc2, pw, 2 * c, 1);
    const dp = sc.win(c);
    const take = dt < dp;
    const best = Math.min(dt, dp);
    const can = BG.canDouble(st);
    const dbl = can && best > nd;
    const beaver = BG.isMoney(st.cfg) && !!st.cfg.beaver && take && dt < 0 && c < 32;
    let label, short;
    if (!can) { label = 'キューブは使えない'; short = ''; }
    else if (dbl) { label = take ? 'ダブル／テイク' : 'ダブル／パス'; short = take ? 'ダブル' : 'ダブル（相手はパス）'; }
    else if (!take && nd >= dp) { label = '良すぎるのでダブルしない（ギャモンを狙う）'; short = 'ギャモン狙い（ダブルしない）'; }
    else { label = take ? 'まだダブルしない（ノーダブル）' : 'ノーダブル'; short = 'ノーダブル'; }
    const norm = v => (BG.isMoney(st.cfg) ? v / c : v);
    return { nd: norm(nd), dt: norm(dt), dp: norm(dp), double: dbl, take, beaver, label, short, money: BG.isMoney(st.cfg) };
  }

  // ------------------------------------------------------------------ CPU の強さ
  const LEVELS = {
    easy: { label: 'やさしい', ply: 0, noise: 0.25, cubePly: 0 },
    normal: { label: 'ふつう', ply: 0, noise: 0, cubePly: 0 },
    strong: { label: 'つよい', ply: 1, noise: 0, cubePly: 1 },
    max: { label: '最強', ply: 2, noise: 0, cubePly: 2 },
  };

  return { Engine, split, MET, PARAM, metCache, cubeful, cubeDecision, metricFor, scorerFor, moneyScorer, matchScorer, LEVELS };
});
