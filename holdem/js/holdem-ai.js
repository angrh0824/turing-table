/* テキサスホールデムの AI: 勝率（エクイティ）の計算・状況のまとめ方（学習と共通）・CPU の打ち方
 *
 * 学習（train/cfr.js）は、ここの「状況のまとめ方」で自己対局の CFR を回し、まとめた状況ごとの打ち方の表を作る。
 * 画面ではその表（js/weights.js）を引いて打つ。表は人間の棋譜やソルバーの結果を一切使わず、自己対局だけで作ったもの
 *
 * 状況のまとめ方（情報集合のキー）:
 *   プリフロップ: 手札の種類169 × 位置8 × このラウンドのレイズ回数4 × コールした人数3 × 有効スタック5 × 払う額の割合3
 *   フロップ以降: 通り3 × 手の強さ20（1人の相手への勝率10段階 × 伸びしろ2） × 後ろに残る人3 × 残っている人数3
 *                × このラウンドのレイズ回数4 × 払う額の割合4 × スタックとポットの比4 × 前の通りで誰が攻めたか3
 * 自分の行動は5つにまとめる: 0 フォールド / 1 チェック・コール / 2 小さいレイズ / 3 大きいレイズ / 4 オールイン
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./holdem-core.js'));
  else root.HoldemAI = factory(root.HoldemCore);
})(typeof self !== 'undefined' ? self : this, function (H) {
  'use strict';
  const { evalMasks } = H;

  // ------------------------------------------------------------------ 勝率（モンテカルロ）
  const DK = new Int8Array(52), USED = new Uint8Array(52);
  // hole: 自分の2枚、board: 場のカード、nOpp: 相手の人数（手札は分からないのででたらめに配る）
  // 戻り値: { eq: 勝率（引き分けは山分け）, win, tie, now: 今の場だけで相手1人に勝っている割合（相手1人のときだけ） }
  function equity(hole, board, nOpp, samples, rng, dead) {
    USED.fill(0);
    let B0 = 0, B1 = 0, B2 = 0, B3 = 0;
    for (const c of board) { USED[c] = 1; const b = 1 << (c >> 2); switch (c & 3) { case 0: B0 |= b; break; case 1: B1 |= b; break; case 2: B2 |= b; break; default: B3 |= b; } }
    let h0 = 0, h1 = 0, h2 = 0, h3 = 0;
    for (const c of hole) { USED[c] = 1; const b = 1 << (c >> 2); switch (c & 3) { case 0: h0 |= b; break; case 1: h1 |= b; break; case 2: h2 |= b; break; default: h3 |= b; } }
    if (dead) for (const c of dead) USED[c] = 1;
    let m = 0;
    for (let c = 0; c < 52; c++) if (!USED[c]) DK[m++] = c;
    const need = 5 - board.length, k = need + 2 * nOpp;
    const heroNow = board.length >= 3 ? evalMasks(B0 | h0, B1 | h1, B2 | h2, B3 | h3) : 0;
    let eq = 0, win = 0, tie = 0, nowWin = 0;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < k; j++) { const r = j + (rng.u32() % (m - j)); const t = DK[j]; DK[j] = DK[r]; DK[r] = t; }
      let b0 = B0, b1 = B1, b2 = B2, b3 = B3;
      for (let j = 0; j < need; j++) { const c = DK[j], b = 1 << (c >> 2); switch (c & 3) { case 0: b0 |= b; break; case 1: b1 |= b; break; case 2: b2 |= b; break; default: b3 |= b; } }
      const hv = evalMasks(b0 | h0, b1 | h1, b2 | h2, b3 | h3);
      let nBest = 0, beaten = false;
      for (let o = 0; o < nOpp; o++) {
        const c1 = DK[need + 2 * o], c2 = DK[need + 2 * o + 1];
        let o0 = b0, o1 = b1, o2 = b2, o3 = b3, n0 = B0, n1 = B1, n2 = B2, n3 = B3;
        let b = 1 << (c1 >> 2);
        switch (c1 & 3) { case 0: o0 |= b; n0 |= b; break; case 1: o1 |= b; n1 |= b; break; case 2: o2 |= b; n2 |= b; break; default: o3 |= b; n3 |= b; }
        b = 1 << (c2 >> 2);
        switch (c2 & 3) { case 0: o0 |= b; n0 |= b; break; case 1: o1 |= b; n1 |= b; break; case 2: o2 |= b; n2 |= b; break; default: o3 |= b; n3 |= b; }
        if (nOpp === 1 && heroNow) { const nv = evalMasks(n0, n1, n2, n3); nowWin += heroNow > nv ? 1 : heroNow === nv ? 0.5 : 0; }
        const ov = evalMasks(o0, o1, o2, o3);
        if (ov > hv) { beaten = true; break; }
        if (ov === hv) nBest++;
      }
      if (beaten) continue;
      if (nBest) { tie++; eq += 1 / (nBest + 1); } else { win++; eq += 1; }
    }
    return { eq: eq / samples, win: win / samples, tie: tie / samples, now: nowWin / samples };
  }

  // ------------------------------------------------------------------ 状況のまとめ方
  const POS8 = 8, PRE_SIZE = 169 * POS8 * 4 * 3 * 5 * 3;
  const CB = 20, POST_SIZE = 3 * CB * 3 * 3 * 4 * 4 * 4 * 3;
  const N_INFO = PRE_SIZE + POST_SIZE;
  const NA = 5;
  const E_EDGES = [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.83, 0.9, 0.95];
  // 手の強さの段階: 相手1人への勝率10段階 × 伸びしろ（今の強さより先の勝率がはっきり高い = ドロー）
  function cardBucket(hole, board, samples, rng) {
    const r = equity(hole, board, 1, samples, rng);
    let e = 0;
    while (e < E_EDGES.length && r.eq >= E_EDGES[e]) e++;
    const draw = board.length < 5 && r.eq - r.now >= 0.06 ? 1 : 0;
    return { cb: e * 2 + draw, eq: r.eq, now: r.now };
  }
  // プリフロップの位置: 0 BB / 1 SB / 2 ボタン / 3 CO / 4 HJ / 5 それより前 / 6 2人卓のボタン(SB) / 7 2人卓の BB
  function prePos(s, p) {
    if (s.n === 2) return p === s.button ? 6 : 7;
    if (p === s.bbSeat) return 0;
    if (p === s.sbSeat) return 1;
    if (p === s.button) return 2;
    const d = (s.button - p + s.n) % s.n;
    return 2 + Math.min(d, 3);
  }
  // 有効スタック（自分と、残っている相手の中で一番多い人の、少ない方。このラウンドに賭けた分も含む）
  function effChips(s, p) {
    let mx = 0;
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) mx = Math.max(mx, s.stack[q] + s.bet[q]);
    return Math.min(s.stack[p] + s.bet[p], mx);
  }
  function effBehind(s, p) {
    let mx = 0;
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) mx = Math.max(mx, s.stack[q]);
    return Math.min(s.stack[p], mx);
  }
  // 情報集合の番号。cb はプリフロップでは使わない（手札の種類を使う）
  function infoKey(s, p, cb, L) {
    L = L || H.legal(s);
    const pot = H.potTotal(s), toCall = L ? L.toCall : 0;
    const raises = Math.min(s.raises, 3);
    const odds = toCall > 0 ? toCall / (pot + toCall) : 0;
    if (s.street === 0) {
      const hc = H.handClass(s.hole[p][0], s.hole[p][1]);
      const callers = Math.min(s.callers, 2);
      const e = effChips(s, p) / s.bb;
      const stk = e < 10 ? 0 : e < 18 ? 1 : e < 35 ? 2 : e < 70 ? 3 : 4;
      // 境目は自分たちのレイズ額（ポットの0.5倍・1倍）がちょうど乗らないところに置く
      const ob = s.raises === 0 ? 0 : odds < 0.29 ? 0 : odds < 0.4 ? 1 : 2;
      return ((((hc * POS8 + prePos(s, p)) * 4 + raises) * 3 + callers) * 5 + stk) * 3 + ob;
    }
    // 後ろに残る人（このラウンドで自分より後に行動できる人）
    const ord = q => (q - s.button - 1 + s.n) % s.n;
    let after = 0, nLive = 0;
    for (let q = 0; q < s.n; q++) {
      if (s.folded[q]) continue;
      nLive++;
      if (q !== p && !s.allin[q] && ord(q) > ord(p)) after++;
    }
    const pos = Math.min(after, 2), nl = Math.min(nLive, 4) - 2;
    const ob = toCall <= 0 ? 0 : odds < 0.19 ? 1 : odds < 0.3 ? 2 : 3;
    const spr = effBehind(s, p) / Math.max(1, pot);
    const sb = spr < 1.5 ? 0 : spr < 4 ? 1 : spr < 10 ? 2 : 3;
    const init = s.prevAgg === p ? 1 : s.prevAgg < 0 ? 0 : 2;
    return PRE_SIZE + ((((((((s.street - 1) * CB + cb) * 3 + pos) * 3 + nl) * 4 + raises) * 4 + ob) * 4 + sb) * 3 + init);
  }
  // 情報集合の番号を読める形に（AI のページ・デバッグ用）
  function describeKey(idx) {
    if (idx < PRE_SIZE) {
      let k = idx;
      const ob = k % 3; k = (k / 3) | 0; const stk = k % 5; k = (k / 5) | 0; const callers = k % 3; k = (k / 3) | 0;
      const raises = k % 4; k = (k / 4) | 0; const pos = k % POS8; const hc = (k / POS8) | 0;
      return { street: 0, hand: H.classLabel(hc), pos, raises, callers, stk, ob };
    }
    let k = idx - PRE_SIZE;
    const init = k % 3; k = (k / 3) | 0; const spr = k % 4; k = (k / 4) | 0; const ob = k % 4; k = (k / 4) | 0;
    const raises = k % 4; k = (k / 4) | 0; const nl = k % 3; k = (k / 3) | 0; const pos = k % 3; k = (k / 3) | 0;
    const cb = k % CB; const street = ((k / CB) | 0) + 1;
    return { street, cb, pos, nLive: nl + 2, raises, ob, spr, init };
  }

  // ------------------------------------------------------------------ 行動のまとめ方
  const SIZES = [[0.5, 1.0], [0.4, 0.9]]; // プリフロップ / フロップ以降: レイズ後の額 = 今の額 + 割合 ×（ポット + 払う額）
  const RAISE_CAP = [4, 3];               // このラウンドのレイズがこの回数に達したら、小さい・大きいレイズは使わない（オールインだけ）
  // 使える行動: [{slot, a}]（a は act に渡す形）
  function abstractActions(s, L) {
    L = L || H.legal(s);
    const out = [];
    if (L.toCall > 0) out.push({ slot: 0, a: { t: 'f' } });
    out.push({ slot: 1, a: { t: 'c' } });
    if (L.canRaise) {
      const post = s.street > 0 ? 1 : 0;
      if (s.raises < RAISE_CAP[post]) {
        let lastTo = -1;
        for (let i = 0; i < 2; i++) {
          let to = Math.round(L.curBet + SIZES[post][i] * (L.pot + L.toCall));
          if (to < L.minTo) to = L.minTo;
          if (to >= L.maxTo || to <= lastTo) continue;
          out.push({ slot: 2 + i, a: { t: 'r', to } });
          lastTo = to;
        }
      }
      out.push({ slot: 4, a: { t: 'r', to: L.maxTo } });
    }
    return out;
  }

  // ------------------------------------------------------------------ 学習した表
  // table: Uint8Array（情報集合ごとに5つの行動の確率 × 255）。すべて 0 の情報集合は学習で一度も来なかったところ
  function tableProbs(table, idx, acts) {
    if (!table) return null;
    const o = idx * NA;
    let sum = 0;
    const pr = new Array(acts.length);
    for (let i = 0; i < acts.length; i++) { pr[i] = table[o + acts[i].slot]; sum += pr[i]; }
    if (sum <= 0) return null;
    for (let i = 0; i < acts.length; i++) pr[i] /= sum;
    return pr;
  }

  // ------------------------------------------------------------------ 決まった打ち方（基準の AI・表がないときの代わり）
  // 「手の強さだけ」: 残っている相手全員への勝率と、払う額の割合だけで決める
  function strengthPolicy(s, p, eq, acts, L) {
    const pot = L.pot, odds = L.toCall > 0 ? L.toCall / (pot + L.toCall) : 0;
    const pick = slot => { let best = null; for (const x of acts) if (x.slot === slot) best = x; return best; };
    const raise = pick(3) || pick(2) || pick(4);
    if (eq > 0.7 && raise && s.raises < 3) return raise;
    if (L.toCall === 0) return pick(1);
    if (eq > odds + 0.05) return pick(1);
    return pick(0) || pick(1);
  }

  // ------------------------------------------------------------------ CPU
  // level: 'easy' | 'normal' | 'strong' | 'max'。ctx: { table, rng }
  // 戻り値: { a: act に渡す行動, slot, probs: [{slot, a, p}]（おすすめの表示用）, eq, info }
  const LEVELS = {
    easy: { samples: 200, noise: 0, style: 'loose' },
    normal: { samples: 300, noise: 0.35, style: 'blend' },
    strong: { samples: 600, noise: 0, style: 'table' },
    max: { samples: 1500, noise: 0, style: 'search', rollouts: 160, rangeSamples: 16, rollSamples: 24 },
  };
  function nOpponents(s, p) { let k = 0; for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) k++; return k; }

  // 学習した打ち方の確率（おすすめにも使う）。表がないところでは「手の強さだけ」の打ち方を代わりに使う
  function recommend(s, p, ctx, samples) {
    const L = H.legal(s), acts = abstractActions(s, L), rng = ctx.rng;
    let cb = 0, bucket = null;
    if (s.street > 0) { bucket = cardBucket(s.hole[p], s.board, samples, rng); cb = bucket.cb; }
    const idx = infoKey(s, p, cb);
    let probs = tableProbs(ctx.table, idx, acts), fromTable = !!probs;
    const eqAll = equity(s.hole[p], s.board, nOpponents(s, p), samples, rng).eq;
    if (!probs) {
      const a = strengthPolicy(s, p, eqAll, acts, L);
      probs = acts.map(x => (x === a ? 1 : 0));
    }
    return { L, acts, probs, idx, fromTable, eq: eqAll, bucket };
  }
  function sample(probs, rng) {
    let x = rng(), i = 0;
    for (; i < probs.length - 1; i++) { x -= probs[i]; if (x < 0) break; }
    return i;
  }
  function decide(s, p, level, ctx) {
    const lv = LEVELS[level] || LEVELS.strong, rng = ctx.rng;
    if (lv.style === 'search' && ctx.table && s.log && s.log.length) return searchDecide(s, p, ctx, lv);
    const R = recommend(s, p, ctx, lv.samples);
    let probs = R.probs.slice();
    if (lv.style === 'loose') probs = loosePolicy(s, p, R, rng);
    else if (lv.noise > 0) {
      // ふつう: 学習した打ち方に、手の強さだけの打ち方とでたらめさを混ぜる
      const a = strengthPolicy(s, p, R.eq, R.acts, R.L);
      probs = probs.map((x, i) => (1 - lv.noise) * x + lv.noise * 0.7 * (R.acts[i] === a ? 1 : 0) + lv.noise * 0.3 / probs.length);
    }
    const i = sample(probs, rng);
    const act = Object.assign({}, R.acts[i].a);
    if (act.t === 'r') act.to = niceAmount(s, R.L, act.to, rng);
    return { a: act, slot: R.acts[i].slot, probs: R.acts.map((x, j) => ({ slot: x.slot, a: x.a, p: R.probs[j] })), eq: R.eq, fromTable: R.fromTable };
  }
  // やさしい: よくコールして、あまりレイズしない（強い手でもときどきコールで済ませる）
  function loosePolicy(s, p, R, rng) {
    const { acts, L } = R, eq = R.eq, n = nOpponents(s, p);
    const e1 = n > 1 ? Math.pow(eq, 1 / n) : eq; // 相手1人あたりに直したおおよその強さ
    const out = acts.map(() => 0);
    const at = slot => acts.findIndex(x => x.slot === slot);
    const fold = at(0), call = at(1), small = at(2) >= 0 ? at(2) : at(3) >= 0 ? at(3) : at(4);
    if (e1 > 0.8 && small >= 0 && rng() < 0.55) out[small] = 1;
    else if (L.toCall === 0) { if (small >= 0 && rng() < 0.08) out[small] = 1; else out[call] = 1; }
    else if (e1 > 0.38 || L.toCall <= L.pot * 0.15 || rng() < 0.15) out[call] = 1;
    else out[fold >= 0 ? fold : call] = 1;
    return out;
  }
  // レイズ額をきりのよい数に（小さいブラインドの倍数）。少しだけばらつかせる
  function niceAmount(s, L, to, rng) {
    if (to >= L.maxTo) return L.maxTo;
    const unit = Math.max(1, s.sb);
    let x = to * (0.94 + 0.12 * rng());
    x = Math.round(x / unit) * unit;
    if (x < L.minTo) x = L.minTo;
    if (x > L.maxTo) x = L.maxTo;
    if (L.maxTo - x < unit) x = L.maxTo;
    return x;
  }

  // ------------------------------------------------------------------ 最強: その場での探索
  // 1. 相手それぞれの手札の重み: これまでの行動を、学んだ打ち方がその手札でどれだけ取りそうかを掛け合わせる（ベイズの推定）
  // 2. 自分の行動ごとに、重みに合わせて相手の手札と残りの場のカードを配り、その後は全員が学んだ打ち方で最後まで打つ（ロールアウト）
  // 3. 平均の結果（チップ）が良い行動を選ぶ。差が小さいときは学んだ打ち方の割合に近くなるよう、事前の重みと混ぜる
  const ACT_T = { f: 1, x: 1, c: 1, b: 1, r: 1 };
  function slotOf(e, acts, L) {
    if (e.t === 'f') return acts.findIndex(x => x.slot === 0);
    if (e.t === 'x' || e.t === 'c') return acts.findIndex(x => x.slot === 1);
    let best = -1, bd = Infinity;
    for (let i = 0; i < acts.length; i++) {
      if (acts[i].slot < 2) continue;
      const d = Math.abs(Math.log(Math.max(1, acts[i].a.to - L.curBet)) - Math.log(Math.max(1, e.to - L.curBet)));
      if (d < bd) { bd = d; best = i; }
    }
    return best >= 0 ? best : acts.findIndex(x => x.slot === 1);
  }
  function inferRanges(s, p, ctx, lv) {
    const rng = ctx.rng, table = ctx.table;
    const dead = new Uint8Array(52);
    for (const c of s.hole[p]) dead[c] = 1;
    for (const c of s.board) dead[c] = 1;
    const combos = [];
    for (let a = 0; a < 52; a++) if (!dead[a]) for (let b = a + 1; b < 52; b++) if (!dead[b]) combos.push([a, b]);
    const W = {};
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) W[q] = new Float64Array(combos.length).fill(1);
    const r = H.newHand({ stacks: s.start, button: s.button, sb: s.sb, bb: s.bb, ante: s.ante });
    r.nolog = true;
    H.dealHole(r, new Array(s.n).fill(null));
    // 人の癖（ctx.models[q]）: ゆるく参加する人ほど、学んだ打ち方から外れた手も持っていると考える
    const epsOf = q => 0.04 + 0.25 * ((ctx.models && ctx.models[q] && ctx.models[q].loose) || 0);
    for (const e of s.log) {
      if (e.t === 'deal') { if (r.phase === 'deal') H.deal(r, e.cards); continue; }
      if (!ACT_T[e.t] || r.phase !== 'bet') continue;
      const q = e.p;
      if (W[q] && r.toAct === q) {
        const L = H.legal(r), acts = abstractActions(r, L), k = slotOf(e, acts, L);
        if (k >= 0 && acts.length > 1) {
          const w = W[q], EPSq = epsOf(q);
          // 人はあまりはったりをしない: 人の賭け・レイズ（フロップ以降）は、強い手の方へ寄せる
          const mdl = ctx.models && ctx.models[q];
          const honest = mdl && mdl.honest && r.street > 0 && acts[k].slot >= 2 ? mdl.honest : 0;
          const memo = new Map(); // 手札の種類（プリフロップ）か強さの段階ごとに、行動の確率は同じ
          for (let ci = 0; ci < combos.length; ci++) {
            if (w[ci] === 0) continue;
            const c = combos[ci];
            let key;
            if (r.street === 0) key = H.handClass(c[0], c[1]);
            else key = 1000 + cardBucket(c, r.board, lv.rangeSamples, rng).cb;
            let pa = memo.get(key);
            if (pa === undefined) {
              r.hole[q] = c;
              const idx = infoKey(r, q, key >= 1000 ? key - 1000 : 0, L);
              const pr = tableProbs(table, idx, acts);
              pa = pr ? pr[k] : 1 / acts.length;
              memo.set(key, pa);
            }
            w[ci] *= EPSq + (1 - EPSq) * pa;
            if (honest) { const e = ((key - 1000) >> 1) + 1; w[ci] *= (1 - honest) + honest * (e * e) / 100; }
          }
          r.hole[q] = null;
        }
      }
      H.act(r, e.t === 'f' ? { t: 'f' } : e.t === 'x' || e.t === 'c' ? { t: 'c' } : { t: 'r', to: e.to });
    }
    // 累積の重み（引くため）
    const cum = {};
    for (const q in W) { const w = W[q], c = new Float64Array(w.length); let t = 0; for (let i = 0; i < w.length; i++) { t += w[i]; c[i] = t; } cum[q] = c; }
    return { combos, W, cum };
  }
  function drawCombo(R, q, used, rng) {
    const c = R.cum[q], tot = c[c.length - 1];
    for (let tries = 0; tries < 60; tries++) {
      const x = rng() * tot;
      let lo = 0, hi = c.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < x) lo = mid + 1; else hi = mid; }
      const cb = R.combos[lo];
      if (!used[cb[0]] && !used[cb[1]]) return cb;
    }
    // 重いところが使えなければ、空いているカードからでたらめに
    const free = [];
    for (let k = 0; k < 52; k++) if (!used[k]) free.push(k);
    const a = free.splice(Math.floor(rng() * free.length), 1)[0], b = free[Math.floor(rng() * free.length)];
    return [a, b];
  }
  function searchDecide(s, p, ctx, lv) {
    const rng = ctx.rng;
    const base = recommend(s, p, ctx, lv.samples);
    const { L, acts } = base;
    const k = acts.length;
    const pick = i => { const act = Object.assign({}, acts[i].a); if (act.t === 'r') act.to = niceAmount(s, L, act.to, rng); return { a: act, slot: acts[i].slot, probs: acts.map((x, j) => ({ slot: x.slot, a: x.a, p: base.probs[j] })), eq: base.eq, fromTable: base.fromTable }; };
    if (k === 1) return pick(0);
    const R = inferRanges(s, p, ctx, lv);
    const ev = new Float64Array(k), dsum = new Float64Array(k), dsq = new Float64Array(k), vi = new Float64Array(k);
    const opps = Object.keys(R.W).map(Number);
    // 大きなポットほど回数を増やす（ポット 1.5BB で約130回、40BB 以上で400回）
    const potBB = (H.potTotal(s) + L.toCall) / s.bb;
    const n = Math.round(lv.rollouts * Math.min(2.5, Math.max(0.75, 0.75 + potBB / 20)));
    const used = new Uint8Array(52);
    const bp = base.probs;
    for (let t = 0; t < n; t++) {
      used.fill(0);
      for (const c of s.hole[p]) used[c] = 1;
      for (const c of s.board) used[c] = 1;
      const holes = s.hole.slice();
      for (const q of opps) { const cb = drawCombo(R, q, used, rng); holes[q] = cb; used[cb[0]] = used[cb[1]] = 1; }
      // 降りた人の手札は分からないので、空きとして扱う
      const board5 = s.board.slice();
      while (board5.length < 5) { let c; do { c = Math.floor(rng() * 52); } while (used[c]); used[c] = 1; board5.push(c); }
      const cache = new Int16Array(s.n * 4).fill(-1);
      let ref = 0;
      for (let i = 0; i < k; i++) { vi[i] = rolloutOnce(s, p, acts[i].a, holes, board5, ctx, lv, cache); ev[i] += vi[i]; ref += bp[i] * vi[i]; }
      // 同じ配りでの「学んだ打ち方の混ぜ方」との差（ばらつきの小さい比べ方）
      for (let i = 0; i < k; i++) { const d = vi[i] - ref; dsum[i] += d; dsq[i] += d * d; }
    }
    for (let i = 0; i < k; i++) ev[i] /= n;
    // 学んだ打ち方より良いと言えるのは、差の平均から標準誤差を引いても良いとき（見積もりのばらつきで振り回されないように）
    // π ∝（学んだ割合）× exp（控えめな差 ÷ τ）、τ はポットの1割
    const pot = H.potTotal(s) + L.toCall;
    const tau = Math.max(s.bb * 0.5, pot * 0.1);
    const score = new Float64Array(k);
    let best = -Infinity;
    for (let i = 0; i < k; i++) {
      const m = dsum[i] / n, se = Math.sqrt(Math.max(0, dsq[i] / n - m * m) / n);
      score[i] = m > 0 ? Math.max(0, m - se) : m + se > 0 ? 0 : m + se;
      best = Math.max(best, score[i]);
    }
    const pr = acts.map((x, i) => (0.95 * bp[i] + 0.05 / k) * Math.exp((score[i] - best) / tau));
    const tot = pr.reduce((a2, b2) => a2 + b2, 0);
    const probs = pr.map(x => x / tot);
    const out = pick(sample(probs, rng));
    out.search = { ev: Array.from(ev), score: Array.from(score), probs, tau, n };
    return out;
  }
  // 1回のロールアウト: 行動 a のあと、全員が学んだ打ち方で最後まで。戻り値は終わったときの自分のチップ
  function rolloutOnce(s0, p, a, holes, board5, ctx, lv, cache) {
    const s = H.fastClone(s0);
    s.hole = holes; s.pre = null;
    const rng = ctx.rng;
    H.act(s, a);
    for (let guard = 0; guard < 200; guard++) {
      if (s.phase === 'done') break;
      if (s.phase === 'deal') { H.deal(s, board5.slice(s.board.length, s.board.length + s.need)); continue; }
      if (s.phase === 'show') { H.show(s, null); continue; }
      const q = s.toAct, L = H.legal(s), acts = abstractActions(s, L);
      let cb = 0;
      if (s.street > 0) {
        const ck = q * 4 + s.street;
        cb = cache[ck];
        if (cb < 0) { cb = cardBucket(s.hole[q], s.board, lv.rollSamples, rng).cb; cache[ck] = cb; }
      }
      const pr = tableProbs(ctx.table, infoKey(s, q, cb, L), acts);
      // 人の癖: 賭けられたときに降りる割合を、その人の実際の割合に合わせて増減させる
      const mdl = ctx.models && ctx.models[q];
      if (pr && mdl && mdl.fold !== 1 && acts[0].slot === 0) {
        pr[0] *= mdl.fold;
        let tot = 0; for (const x of pr) tot += x;
        for (let j = 0; j < pr.length; j++) pr[j] /= tot;
      }
      let i;
      if (pr) i = sample(pr, rng);
      else { const x = strengthPolicy(s, q, equity(s.hole[q], s.board, 1, 40, rng).eq, acts, L); i = acts.indexOf(x); }
      H.act(s, acts[i].a);
    }
    return s.stack[p];
  }

  // 人の打ち方の癖をまとめる（少ないうちは平均に寄せる）。stats: { hands, vpip, faced, folded }
  //   loose: 0（ふつう）〜1（とてもゆるい）、fold: 賭けられたときに降りる割合の、ふつう（45%）に対する倍率
  function opponentModel(st) {
    if (!st || !st.hands) return null;
    const vpip = (st.vpip + 6 * 0.25) / (st.hands + 6);
    const foldRate = (st.folded + 8 * 0.45) / (st.faced + 8);
    return { loose: Math.max(0, Math.min(1, (vpip - 0.28) / 0.4)), fold: Math.max(0.4, Math.min(1.6, foldRate / 0.45)), honest: 0.5, vpip, foldRate };
  }

  return {
    searchDecide, inferRanges, opponentModel,
    equity, cardBucket, infoKey, describeKey, prePos, effChips, abstractActions, tableProbs, strengthPolicy, recommend, decide, niceAmount, sample,
    LEVELS, PRE_SIZE, POST_SIZE, N_INFO, NA, CB, SIZES, RAISE_CAP, E_EDGES,
  };
});
