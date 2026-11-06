/* うそつきダイスの AI: 自己対局だけで学んだ「行動の値」（そのラウンドで自分のサイコロが減る・増える見込み）で選ぶ
 * ブラウザ・Node・Web Worker のどこでも動く（DudoCore(S) のあとに DudoAI(S) を呼ぶ）
 *
 * 値 Q(局面, 行動) = 特徴ごとの重みの和。行動ごと（宣言・ダウト・ぴったり）に別の特徴を使う
 *   特徴: 「足りない数」（宣言の個数 − 自分の手の中の数）と「見えないサイコロの数」の組（表引き）・宣言の上げ幅・目を変えたか・
 *         ほかの人がその目を何回言ったか・直前の人がその目を前にも言ったか・人数・自分と相手のサイコロの数・宣言の回数…
 *   重みは全部 0 から、自己対局の結果（そのラウンドで自分のサイコロが減ったら −1、増えたら +1）だけで学ぶ（モンテカルロの値の学習）
 *   確率の計算（二項分布）は AI補助の表示にだけ使い、AI の判断には入れていない
 */
function DudoAI(S) {
  'use strict';
  const { DOUBT, CALZA, bid, bq, bf } = S;
  const NMIN = -4, NMAX = 16, NN = NMAX - NMIN + 1, UMAX = 29, NU = 2 * NN * (UMAX + 1);
  const clampN = v => (v < NMIN ? NMIN : v > NMAX ? NMAX : v) - NMIN;
  const clampU = v => (v > UMAX ? UMAX : v < 0 ? 0 : v);
  // 特徴の番号
  const F = {};
  let nf = 0;
  const block = (name, n) => { F[name] = nf; nf += n; };
  // 宣言
  block('bNU', NU); block('bN', 2 * NN); block('bJump', 5); block('bOpen', 1); block('bSame', 1); block('bChange', 1); block('bToOne', 1); block('bFromOne', 1);
  block('bHist', 4); block('bMine', 3); block('bNext', 5); block('bAlive', 5); block('bMyD', 5); block('bBias', 1); block('bRound', 8);
  // ダウト
  block('dNU', NU); block('dN', 2 * NN); block('dHist', 4); block('dLastSame', 1); block('dJump', 5); block('dChange', 1); block('dLastD', 5); block('dNB', 8); block('dAlive', 5); block('dMyD', 5); block('dBias', 1);
  // ぴったり
  block('cNU', NU); block('cN', 2 * NN); block('cHist', 4); block('cNB', 8); block('cAlive', 5); block('cMyD', 5); block('cBias', 1);
  const NF = nf;

  // 手番の人の見えている情報をまとめる（目ごとの自分の数・ほかの人／自分がその目を言った回数）
  function context(g, p) {
    const hand = g.hands[p], wild = g.wild();
    const mine = new Int8Array(7), raw = new Int8Array(7);
    for (const v of hand) raw[v]++;
    for (let f = 1; f <= 6; f++) mine[f] = raw[f] + (wild && f !== 1 ? raw[1] : 0);
    const othersOn = new Int8Array(7), mineOn = new Int8Array(7);
    for (const b of g.bids) { const f = bf(b.a); if (b.p === p) mineOn[f]++; else othersOn[f]++; }
    const T = g.total(), U = T - hand.length;
    const last = g.bids.length ? g.bids[g.bids.length - 1] : null, prev = g.bids.length > 1 ? g.bids[g.bids.length - 2] : null;
    let lastSame = 0;
    if (last) for (let i = 0; i < g.bids.length - 1; i++) if (g.bids[i].p === last.p && bf(g.bids[i].a) === bf(last.a)) { lastSame = 1; break; }
    return { p, wild, mine, othersOn, mineOn, T, U, last, prev, lastSame, alive: g.aliveCount(), myD: hand.length, next: g.nextAlive(p), nb: g.bids.length, round: g.round };
  }
  const kind = (ctx, f) => (ctx.wild && f !== 1 ? 0 : 1);   // 0: 1もワイルドで数える目、1: 1の目・パリフィコ
  const min4 = v => (v > 3 ? 3 : v);

  // 行動 a の特徴（値はすべて 1）を out に。戻り値は数
  function features(g, ctx, a, out) {
    let n = 0;
    const cur = ctx.last ? ctx.last.a : 0;
    if (a > 0) {
      const q = bq(a), f = bf(a), k = kind(ctx, f), need = q - ctx.mine[f];
      out[n++] = F.bNU + (k * NN + clampN(need)) * (UMAX + 1) + clampU(ctx.U);
      out[n++] = F.bN + k * NN + clampN(need);
      if (!cur) out[n++] = F.bOpen;
      else {
        const cq = bq(cur), cf = bf(cur);
        const jump = f === 1 && cf !== 1 ? q - Math.ceil(cq / 2) : cf === 1 && f !== 1 ? q - (cq * 2 + 1) : q - cq;
        out[n++] = F.bJump + (jump < 0 ? 0 : jump > 4 ? 4 : jump);
        if (f === cf) out[n++] = F.bSame; else out[n++] = F.bChange;
        if (f === 1 && cf !== 1) out[n++] = F.bToOne;
        if (cf === 1 && f !== 1) out[n++] = F.bFromOne;
      }
      out[n++] = F.bHist + min4(ctx.othersOn[f]);
      out[n++] = F.bMine + (ctx.mineOn[f] > 2 ? 2 : ctx.mineOn[f]);
      out[n++] = F.bNext + Math.min(5, g.dice[ctx.next]) - 1;
      out[n++] = F.bAlive + ctx.alive - 2;
      out[n++] = F.bMyD + ctx.myD - 1;
      out[n++] = F.bRound + Math.min(7, ctx.nb);
      out[n++] = F.bBias;
      return n;
    }
    const q = bq(cur), f = bf(cur), k = kind(ctx, f), need = q - ctx.mine[f];
    if (a === DOUBT) {
      out[n++] = F.dNU + (k * NN + clampN(need)) * (UMAX + 1) + clampU(ctx.U);
      out[n++] = F.dN + k * NN + clampN(need);
      out[n++] = F.dHist + min4(Math.max(0, ctx.othersOn[f] - 1));
      if (ctx.lastSame) out[n++] = F.dLastSame;
      if (ctx.prev) {
        const pq = bq(ctx.prev.a), pf = bf(ctx.prev.a);
        const jump = f === 1 && pf !== 1 ? q - Math.ceil(pq / 2) : pf === 1 && f !== 1 ? q - (pq * 2 + 1) : q - pq;
        out[n++] = F.dJump + (jump < 0 ? 0 : jump > 4 ? 4 : jump);
        if (f !== pf) out[n++] = F.dChange;
      }
      out[n++] = F.dLastD + Math.min(5, g.dice[ctx.last.p]) - 1;
      out[n++] = F.dNB + Math.min(7, ctx.nb - 1);
      out[n++] = F.dAlive + ctx.alive - 2;
      out[n++] = F.dMyD + ctx.myD - 1;
      out[n++] = F.dBias;
      return n;
    }
    out[n++] = F.cNU + (k * NN + clampN(need)) * (UMAX + 1) + clampU(ctx.U);
    out[n++] = F.cN + k * NN + clampN(need);
    out[n++] = F.cHist + min4(Math.max(0, ctx.othersOn[f] - 1));
    out[n++] = F.cNB + Math.min(7, ctx.nb - 1);
    out[n++] = F.cAlive + ctx.alive - 2;
    out[n++] = F.cMyD + ctx.myD - 1;
    out[n++] = F.cBias;
    return n;
  }

  class Policy {
    constructor(W) {
      this.w = new Float64Array(NF);
      if (W && W.w) {
        if (typeof W.w === 'string') {   // 重みの保存: 1万倍して Int16 にした base64
          const bin = atob(W.w), n = Math.min(NF, bin.length >> 1);
          for (let i = 0; i < n; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); this.w[i] = ((v << 16) >> 16) / 10000; }
        } else for (let i = 0; i < Math.min(NF, W.w.length); i++) this.w[i] = W.w[i];
      }
      this.gen = (W && W.gen) || 0;
      this.buf = new Int32Array(32);
    }
    value(g, ctx, a) {
      const n = features(g, ctx, a, this.buf);
      let v = 0;
      for (let i = 0; i < n; i++) v += this.w[this.buf[i]];
      return v;
    }
    // 行動ごとの値。[{ a, v }]
    values(g, p) {
      const ctx = context(g, p), out = [];
      for (const a of g.legal()) out.push({ a, v: this.value(g, ctx, a) });
      return out;
    }
    // 行動を選ぶ。opts: { temp（0 なら一番よいもの）, eps（でたらめに選ぶ割合）, rnd }
    choose(g, p, opts = {}) {
      const rnd = opts.rnd || Math.random, vs = this.values(g, p);
      if (!vs.length) return 0;
      if (opts.eps && rnd() < opts.eps) return vs[(rnd() * vs.length) | 0].a;
      if (opts.temp) {
        const mx = Math.max(...vs.map(x => x.v)), ws = vs.map(x => Math.exp((x.v - mx) / opts.temp));
        let r = rnd() * ws.reduce((s, x) => s + x, 0);
        for (let i = 0; i < vs.length; i++) { r -= ws[i]; if (r <= 0) return vs[i].a; }
        return vs[vs.length - 1].a;
      }
      let best = vs[0];
      for (const x of vs) if (x.v > best.v + 1e-12 || (Math.abs(x.v - best.v) <= 1e-12 && rnd() < 0.5)) best = x;
      return best.a;
    }
  }

  // 読む CPU（最強）: 相手の目を「その人がこのラウンドに言った宣言の起こりやすさ」（学んだ値の softmax）で重み付けして何通りも引き、
  // 値の高い候補の行動ごとに、ラウンドの終わりまで学んだ方策で指し進めて、自分のサイコロが減る・増える見込みを比べる
  // opts: { samples, top, temp（相手のらしさの温度）, rnd }。戻り値 { a, est: [{ a, v, q }] }
  function plan(pol, g, p, opts = {}) {
    const rnd = opts.rnd || Math.random, samples = opts.samples || 120, top = opts.top || 6, temp = opts.temp || 0.08;
    const vs = pol.values(g, p).sort((x, y) => y.v - x.v);
    const cands = vs.slice(0, top);
    if (cands.length <= 1) return { a: cands.length ? cands[0].a : 0, est: cands.map(c => ({ a: c.a, v: c.v, q: c.v })) };
    const sum = new Float64Array(cands.length);
    let wsum = 0;
    const roll = k => { const h = []; for (let i = 0; i < k; i++) h.push(1 + Math.floor(rnd() * 6)); return h.sort((x, y) => x - y); };
    for (let s = 0; s < samples; s++) {
      const h = g.clone();
      for (let q = 0; q < h.n; q++) if (q !== p && h.dice[q] > 0) h.hands[q] = roll(h.dice[q]);
      // 重み: このラウンドのほかの人の宣言を、引いた目で言う見込み（log で足す）
      let lw = 0;
      if (h.bids.length) {
        const t = h.clone(), all = h.bids;
        t.bids = []; t.turn = all[0].p;
        for (const b of all) {
          if (b.p !== p) {
            const ctx = context(t, b.p), legal = t.legal();
            let mx = -1e9;
            const vals = legal.map(a => { const v = pol.value(t, ctx, a); if (v > mx) mx = v; return v; });
            let z = 0, mine = -1e9;
            for (let i = 0; i < legal.length; i++) { z += Math.exp((vals[i] - mx) / temp); if (legal[i] === b.a) mine = vals[i]; }
            lw += (mine - mx) / temp - Math.log(z);
          }
          t.bids.push({ p: b.p, a: b.a }); t.turn = t.nextAlive(b.p);
        }
      }
      const w = Math.exp(Math.max(-30, lw));
      wsum += w;
      for (let c = 0; c < cands.length; c++) {
        const r = h.clone();
        let res = r.act(cands[c].a);
        for (let guard = 0; !res && guard < 60; guard++) res = r.act(pol.choose(r, r.turn, { rnd }));
        const y = !res ? 0 : res.loser === p ? -1 : res.gainer === p ? 1 : 0;
        sum[c] += w * y;
      }
    }
    const est = cands.map((c, i) => ({ a: c.a, v: wsum > 0 ? sum[i] / wsum : c.v, q: c.v }));
    let best = est[0];
    for (const e of est) if (e.v > best.v) best = e;
    return { a: best.a, est };
  }

  // AI補助の表示用: 宣言が本当である確率（自分の目は分かっていて、ほかの目はでたらめとして）
  function truthProb(g, p, a) {
    const q = bq(a), f = bf(a), mine = g.countIn(g.hands[p], f), U = g.total() - g.hands[p].length;
    const pr = g.wild() && f !== 1 ? 1 / 3 : 1 / 6, need = q - mine;
    if (need <= 0) return { atLeast: 1, exactly: need === 0 ? Math.pow(1 - pr, U) : 0 };
    if (need > U) return { atLeast: 0, exactly: 0 };
    let c = 1, atLeast = 0, exactly = 0;
    for (let k = 0; k <= U; k++) {
      const pk = c * Math.pow(pr, k) * Math.pow(1 - pr, U - k);
      if (k >= need) atLeast += pk;
      if (k === need) exactly = pk;
      c = c * (U - k) / (k + 1);
    }
    return { atLeast, exactly };
  }

  Object.assign(S, { NF, F, context, features, Policy, plan, truthProb });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = DudoAI;
