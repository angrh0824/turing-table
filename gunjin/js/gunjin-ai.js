/* 軍人将棋の AI（自作。強さは自己対局で学んだものだけ）
 *   GunjinAI(C) → { Net, Belief, Agent, RuleAgent, RandomAgent, sampleSetup, LEVELS, ... }
 *
 * 考え方:
 *   1. 正体の推定（Belief）: 自分に見えるもの（自分の配置・公開の記録 = どの駒がどこへ動いたか・戦いの結果）だけから、
 *      相手の23枚の正体の組み合わせを、ルールと矛盾しないように何通りも引く（MCMC）。最初の置き方の見込みは、
 *      AI 自身が自己対局で学んだ配置の分布（prior）を使う
 *   2. 評価（Net）: 盤の全部の駒の正体がわかった局面の「手番側の期待得点」(-1..1) を返す小さなニューラルネット。
 *      自己対局の結果から TD(λ) で学ぶ（train/train.js）。人が決めた駒の価値の表などは使わない
 *   3. 指し手: 引いた正体の組み合わせごとに、指せる手を全部試してネットで評価し、平均の高い手を選ぶ
 *   4. 配置: 種類×場所の好みの表（自己対局で学ぶ）にゆらぎを足し、ハンガリー法で23枚を並べる
 *
 * AI に渡すのは C.view() の { color, setup（自分の配置）, log（公開の記録）} だけ（相手の駒の正体は渡らない）
 */
(function (root) {
  'use strict';
  function GunjinAI(C) {
    const { NP, NT, BLACK, WHITE, NIDX, ROT, NODES, COUNTS, PIECES, ALL, MOVABLE, HQ, GUNKI, JIRAI, SHOSA, TAISHO, CHUJO, SHOSHO, HIKO, TANK, KOHEI, SPY, MOVED, WON } = C;
    const NN = NODES.length;             // 46
    const NF_PS = 2 * NT * NN;           // 駒×場所（自分と相手）
    const NF_EX = 2 * NT * 2;            // 動いたことのある駒・勝ち残った駒の数（正体が見当をつけられやすい駒）
    const NF = NF_PS + NF_EX + 2;        // ＋戦いのない手数・手数

    // ------------------------------------------------------------------ 評価のネット
    class Net {
      constructor(H) {
        this.H = H || 64; this.nf = NF;
        this.w1 = new Float32Array(NF * this.H); this.b1 = new Float32Array(this.H);
        this.w2 = new Float32Array(this.H); this.b2 = 0;
        this.acc = new Float32Array(this.H);
        this.setup = new Float32Array(NT * NP); // 配置の好み（種類×場所）
        this.prior = null;                      // 相手の配置の見込み P(種類 | 場所)（自分の配置の分布から）
        this.beh = null;                        // 動きの種類ごとの、駒の種類の出やすさの比（自己対局から。4×NT）
        this.gen = 0;
      }
      randomize(rng, s) { for (let i = 0; i < this.w1.length; i++) this.w1[i] = (rng() * 2 - 1) * s; for (let i = 0; i < this.H; i++) this.w2[i] = (rng() * 2 - 1) * s; }
      // 手番側から見た特徴（index と値）。n を返す
      feats(pos, idx, val) {
        const P = pos.stm;
        let n = 0;
        for (let id = 0; id < 2 * NP; id++) {
          const sq = pos.at[id];
          if (sq < 0) continue;
          const t = pos.type[id], side = (id < NP ? BLACK : WHITE) === P ? 0 : 1, st = side * NT + t;
          idx[n] = st * NN + (P === BLACK ? NIDX[sq] : NIDX[ROT[sq]]); val[n++] = 1;
          const fl = pos.fl[id];
          if (fl & MOVED) { idx[n] = NF_PS + st * 2; val[n++] = 1; }
          if (fl & WON) { idx[n] = NF_PS + st * 2 + 1; val[n++] = 1; }
        }
        idx[n] = NF_PS + NF_EX; val[n++] = pos.quiet / C.QUIET_MAX;
        idx[n] = NF_PS + NF_EX + 1; val[n++] = pos.ply / C.MAX_PLY;
        return n;
      }
      // 手番側の期待得点（-1..1）。駒の種類は全部わかっていること
      value(pos) {
        const H = this.H, acc = this.acc, w1 = this.w1, P = pos.stm;
        acc.set(this.b1);
        const add = (f, v) => { const o = f * H; if (v === 1) for (let h = 0; h < H; h++) acc[h] += w1[o + h]; else for (let h = 0; h < H; h++) acc[h] += v * w1[o + h]; };
        for (let id = 0; id < 2 * NP; id++) {
          const sq = pos.at[id];
          if (sq < 0) continue;
          const t = pos.type[id], st = ((id < NP ? BLACK : WHITE) === P ? 0 : NT) + t;
          add(st * NN + (P === BLACK ? NIDX[sq] : NIDX[ROT[sq]]), 1);
          const fl = pos.fl[id];
          if (fl & MOVED) add(NF_PS + st * 2, 1);
          if (fl & WON) add(NF_PS + st * 2 + 1, 1);
        }
        add(NF_PS + NF_EX, pos.quiet / C.QUIET_MAX);
        add(NF_PS + NF_EX + 1, pos.ply / C.MAX_PLY);
        let o = this.b2;
        const w2 = this.w2;
        for (let h = 0; h < H; h++) if (acc[h] > 0) o += w2[h] * acc[h];
        return Math.tanh(o);
      }
      toJSON() {
        return { v: 1, gen: this.gen, H: this.H, nf: this.nf, w1: Array.from(this.w1), b1: Array.from(this.b1), w2: Array.from(this.w2), b2: this.b2, setup: Array.from(this.setup), prior: this.prior ? Array.from(this.prior) : null, beh: this.beh ? Array.from(this.beh) : null };
      }
      static fromJSON(o) {
        const n = new Net(o.H);
        n.gen = o.gen | 0;
        if (typeof o.w1 === 'string') { // 公開用: int8 に量子化して base64
          const bin = typeof atob === 'function' ? atob(o.w1) : Buffer.from(o.w1, 'base64').toString('binary');
          for (let i = 0; i < n.w1.length; i++) { let b = bin.charCodeAt(i); if (b > 127) b -= 256; n.w1[i] = b * o.s1; }
        } else n.w1.set(o.w1);
        n.b1.set(o.b1); n.w2.set(o.w2); n.b2 = o.b2;
        if (o.setup) n.setup.set(o.setup);
        if (o.prior) n.prior = Float32Array.from(o.prior);
        if (o.beh) n.beh = Float32Array.from(o.beh);
        return n;
      }
      // 公開用（weights.js）に小さくする
      pack(extra) {
        let mx = 0;
        for (let i = 0; i < this.w1.length; i++) mx = Math.max(mx, Math.abs(this.w1[i]));
        const s1 = mx / 127 || 1e-6;
        let bin = '';
        for (let i = 0; i < this.w1.length; i++) { let q = Math.round(this.w1[i] / s1); if (q < 0) q += 256; bin += String.fromCharCode(q); }
        const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
        const r4 = a => Array.from(a, x => Math.round(x * 1e4) / 1e4);
        return Object.assign({ v: 1, gen: this.gen, H: this.H, nf: this.nf, s1, w1: b64, b1: r4(this.b1), w2: r4(this.w2), b2: Math.round(this.b2 * 1e4) / 1e4, setup: r4(this.setup), prior: this.prior ? r4(this.prior) : null, beh: this.beh ? r4(this.beh) : null }, extra || {});
      }
    }

    // ------------------------------------------------------------------ 配置（学んだ好み＋ゆらぎ → ハンガリー法）
    // 最小のコストの割り当て（n×n、a[i][j]）。p[j] = 行 i（1始まり）
    function hungarian(a, n) {
      const INF = 1e18, u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
      for (let i = 1; i <= n; i++) {
        p[0] = i; let j0 = 0;
        const minv = new Float64Array(n + 1).fill(INF), used = new Uint8Array(n + 1);
        do {
          used[j0] = 1;
          const i0 = p[j0]; let delta = INF, j1 = 0;
          for (let j = 1; j <= n; j++) if (!used[j]) {
            const cur = a[(i0 - 1) * n + (j - 1)] - u[i0] - v[j];
            if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
            if (minv[j] < delta) { delta = minv[j]; j1 = j; }
          }
          for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
          j0 = j1;
        } while (p[j0] !== 0);
        do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
      }
      return p;
    }
    const gumbel = rng => -Math.log(-Math.log(rng() * 0.999999 + 1e-7));
    // logits: 種類×場所（NT×NP）。sigma: ゆらぎの大きさ（大きいほどばらばら）
    function sampleSetup(logits, sigma, rng) {
      rng = rng || Math.random;
      const n = NP, a = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        const t = PIECES[i];
        for (let k = 0; k < n; k++) a[i * n + k] = C.placeOK(t, k) ? -((logits ? logits[t * NP + k] : 0) + sigma * gumbel(rng)) : 1e9;
      }
      const p = hungarian(a, n), s = new Array(n);
      for (let j = 1; j <= n; j++) s[j - 1] = PIECES[p[j] - 1];
      return s;
    }
    // 配置の分布の周辺（P(種類 | 場所)）を数える
    function setupMarginals(logits, sigma, N, rng) {
      const m = new Float32Array(NT * NP);
      for (let i = 0; i < N; i++) { const s = sampleSetup(logits, sigma, rng); for (let k = 0; k < NP; k++) m[s[k] * NP + k] += 1 / N; }
      return m;
    }

    // ------------------------------------------------------------------ 正体の推定
    class Belief {
      // color: 自分の色、setup: 自分の配置、prior: P(種類|場所)（NT×NP）か null
      constructor(color, setup, prior, rng, beh) {
        this.me = color; this.op = color ^ 1; this.base = this.op * NP;
        this.pos = C.Pos.start(color === BLACK ? setup : null, color === WHITE ? setup : null);
        this.mask = new Uint16Array(NP).fill(ALL);
        for (let k = 0; k < NP; k++) for (let t = 0; t < NT; t++) if (!C.placeOK(t, k)) this.mask[k] &= ~(1 << t);
        this.coup = [];  // 軍旗かもしれない駒への攻め: {j, my, r, s}（s = そのとき真後ろにいた相手の駒）
        this.w = new Float64Array(NP * NT);
        for (let k = 0; k < NP; k++) for (let t = 0; t < NT; t++) this.w[k * NT + t] = 0.5 * (prior ? prior[t * NP + k] : COUNTS[t] / NP) + 0.5 * COUNTS[t] / NP + 1e-4;
        this.rng = rng || Math.random;
        this.beh = beh || null;
        this.asg = null;
      }
      static fromView(v, prior, rng, beh) {
        const b = new Belief(v.color, v.setup, prior, rng, beh);
        for (const e of v.log) b.observe(e);
        return b;
      }
      // 公開の記録の1手を見る（自分の手も相手の手も）
      observe(ev) {
        const pos = this.pos, f = ev.f, t = ev.t, r = ev.r;
        const a = pos.sq[f], d = pos.sq[t];
        if (a < 0) return;
        const B = this.base;
        if ((a < NP ? BLACK : WHITE) === this.op) {
          const j = a - B;
          this.mask[j] &= pos.typesThatCan(f, t) & MOVABLE;
          if (this.beh) { // 動き方から見た、種類の出やすさ（学んだもの）
            const ac = C.actionClass(pos, f, t);
            let mx = 0;
            for (let e = 0; e < NT; e++) { this.w[j * NT + e] *= this.beh[ac * NT + e]; mx = Math.max(mx, this.w[j * NT + e]); }
            if (mx > 0) for (let e = 0; e < NT; e++) this.w[j * NT + e] = Math.max(this.w[j * NT + e] / mx, 1e-9);
          }
          if (d >= 0) { // 相手が自分の駒を攻めた
            const myT = pos.type[d];
            let sup = -1;
            if (myT === GUNKI) { const s = pos.support(d); sup = s < 0 ? -1 : pos.type[s]; }
            let ok = 0;
            for (let e = 0; e < NT; e++) if (C.judge(e, myT, sup) === r) ok |= 1 << e;
            this.mask[j] &= ok;
          }
        } else if (d >= 0) { // 自分が相手の駒を攻めた
          const j = d - B, myT = pos.type[a];
          let ok = 0;
          for (let e = 0; e < NT; e++) if (e !== GUNKI && C.judge(myT, e, -1) === r) ok |= 1 << e;
          const s = pos.support(d);
          if (s < 0) { if (r === 1) ok |= 1 << GUNKI; }
          else {
            const sj = s - B;
            let can = false;
            for (let e = 0; e < NT; e++) if (e !== GUNKI && (this.mask[sj] >> e & 1) && C.judge(myT, GUNKI, e) === r) can = true;
            if (can) { ok |= 1 << GUNKI; this.coup.push({ j, my: myT, r, s: sj }); }
          }
          this.mask[j] &= ok;
        }
        pos.apply(f, t, r);
        // 相手の駒が自分の司令部に入っても終わらなかった → 少佐以上ではない
        const o = pos.sq[HQ[this.me]];
        if (!ev.end && o >= 0 && (o < NP ? BLACK : WHITE) === this.op) this.mask[o - B] &= ~C.HQ_OK;
        if (this.asg && !this.valid(this.asg)) this.asg = null;
      }
      valid(asg) {
        for (let j = 0; j < NP; j++) if (!(this.mask[j] >> asg[j] & 1)) return false;
        return this.viol(asg) === 0;
      }
      viol(asg) {
        let v = 0;
        for (const c of this.coup) if (asg[c.j] === GUNKI && C.judge(c.my, GUNKI, asg[c.s]) !== c.r) v++;
        return v;
      }
      // ルールに合う割り当てを1つ作る（二部マッチング）。だめなら false
      init() {
        const rng = this.rng, slotOf = new Int8Array(NP).fill(-1), tokOf = new Int8Array(NP).fill(-1);
        const order = Array.from({ length: NP }, (_, i) => i);
        for (let i = NP - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const x = order[i]; order[i] = order[j]; order[j] = x; }
        const slots = order.slice();
        const tryTok = (j, seen) => {
          for (const s of slots) {
            if (seen[s] || !(this.mask[j] >> PIECES[s] & 1)) continue;
            seen[s] = 1;
            if (tokOf[s] < 0 || tryTok(tokOf[s], seen)) { tokOf[s] = j; slotOf[j] = s; return true; }
          }
          return false;
        };
        for (const j of order) if (!tryTok(j, new Uint8Array(NP))) return false;
        const asg = new Int8Array(NP);
        for (let j = 0; j < NP; j++) asg[j] = PIECES[slotOf[j]];
        this.asg = asg;
        return true;
      }
      // 軍旗の条件まで満たす割り当てを作る（マッチングを何度かやり直し、だめなら入れ替えで直す）
      initFull() {
        for (let i = 0; i < 40; i++) { if (!this.init()) return false; if (!this.viol(this.asg)) return true; }
        for (let i = 0; i < 300 && this.viol(this.asg); i++) this.sweep();
        return true;
      }
      sweep() {
        const asg = this.asg, w = this.w, mask = this.mask, rng = this.rng, hasC = this.coup.length > 0;
        for (let it = 0; it < NP; it++) {
          const i = Math.floor(rng() * NP), j = Math.floor(rng() * NP);
          const ti = asg[i], tj = asg[j];
          if (ti === tj || !(mask[i] >> tj & 1) || !(mask[j] >> ti & 1)) continue;
          let ratio = (w[i * NT + tj] * w[j * NT + ti]) / (w[i * NT + ti] * w[j * NT + tj]);
          if (hasC) {
            const v0 = this.viol(asg);
            asg[i] = tj; asg[j] = ti;
            const v1 = this.viol(asg);
            asg[i] = ti; asg[j] = tj;
            if (v1 !== v0) ratio *= Math.pow(1e-3, v1 - v0);
          }
          if (ratio >= 1 || rng() < ratio) { asg[i] = tj; asg[j] = ti; }
          if (!hasC) continue;
          // 3つの駒で回す（軍旗とその後ろの駒の条件があるとき、入れ替えだけでは動けないことがある）
          const k = Math.floor(rng() * NP), a = asg[i], b = asg[j], c = asg[k];
          if (i === k || j === k || i === j || a === b || b === c || a === c || !(mask[i] >> c & 1) || !(mask[j] >> a & 1) || !(mask[k] >> b & 1)) continue;
          let rr = (w[i * NT + c] * w[j * NT + a] * w[k * NT + b]) / (w[i * NT + a] * w[j * NT + b] * w[k * NT + c]);
          const u0 = this.viol(asg);
          asg[i] = c; asg[j] = a; asg[k] = b;
          const u1 = this.viol(asg);
          if (u1 !== u0) rr *= Math.pow(1e-3, u1 - u0);
          if (!(rr >= 1 || rng() < rr)) { asg[i] = a; asg[j] = b; asg[k] = c; }
        }
      }
      // 正体の組み合わせを K 通り（Int8Array(NP) の配列）
      sample(K, burn, gap) {
        if ((!this.asg || this.viol(this.asg)) && !this.initFull()) return [];
        for (let i = 0; i < (burn == null ? 6 : burn); i++) this.sweep();
        const out = [];
        for (let k = 0; k < K; k++) { for (let i = 0; i < (gap || 2); i++) this.sweep(); if (this.viol(this.asg) === 0) out.push(this.asg.slice()); }
        if (!out.length && this.initFull() && !this.viol(this.asg)) out.push(this.asg.slice());
        return out;
      }
      // 相手の駒ごとの正体の見込み（NP×NT の確率）
      marginals(N) {
        const m = new Float32Array(NP * NT);
        const ss = this.sample(N || 300, 10, 1);
        for (const s of ss) for (let j = 0; j < NP; j++) m[j * NT + s[j]] += 1 / ss.length;
        return m;
      }
      // 引いた正体で埋めた局面
      fill(s) { const p = this.pos.clone(); for (let j = 0; j < NP; j++) p.type[this.base + j] = s[j]; return p; }
    }

    // ------------------------------------------------------------------ 指し手（正体を引いて1手読み＋ネットの評価）
    const LEVELS = {
      easy: { K: 2, tau: 0.3, sigma: 4 },
      normal: { K: 4, tau: 0.06, sigma: 2 },
      strong: { K: 6, tau: 0.015, sigma: 1 },
      max: { K: 48, tau: 0, sigma: 1 },
      ultra: { K: 144, tau: 0, sigma: 1 }, // 超最強（推理の数を増やすと強くなると測れたときだけ画面に出す）
    };
    // det の局面で手番側が m を指した後の、指した側から見た値
    function afterValue(net, det, m) {
      const me = det.stm;
      const u = det.make(m);
      const e = det.end(false);
      const v = e ? (e.winner === me ? 1 : e.winner < 0 ? 0 : -1) : -net.value(det);
      det.unmake(m, u);
      return v;
    }
    class Agent {
      constructor(net, color, setup, opts) {
        this.net = net; this.color = color; this.setup = setup;
        this.o = Object.assign({ K: 16, tau: 0, eps: 0 }, opts || {});
        this.rng = this.o.rng || Math.random;
        this.b = new Belief(color, setup, net.prior, this.rng, net.beh);
      }
      static fromView(net, v, opts) { const a = new Agent(net, v.color, v.setup, opts); for (const e of v.log) a.observe(e); return a; }
      observe(ev) { this.b.observe(ev); }
      // 候補手ごとの値（平均）と、今の局面の値
      think(K) {
        const pos = this.b.pos, mine = pos.stm === this.color, moves = mine ? pos.gen(this.color) : [];
        const q = new Float64Array(moves.length);
        let v0 = 0;
        if (mine && !moves.length) return { moves, q, v: -1, n: 0 };
        const ss = this.b.sample(K || this.o.K);
        if (!ss.length) return { moves, q, v: 0, n: 0 };
        for (const s of ss) {
          const det = this.b.fill(s);
          v0 += this.net.value(det);
          for (let i = 0; i < moves.length; i++) q[i] += afterValue(this.net, det, moves[i]);
        }
        for (let i = 0; i < moves.length; i++) q[i] /= ss.length;
        return { moves, q, v: v0 / ss.length, n: ss.length };
      }
      choose() {
        const th = this.think();
        return { move: pick(th, this.o.tau, this.o.eps, this.rng), th };
      }
    }
    function pick(th, tau, eps, rng) {
      const { moves, q } = th;
      if (!moves.length) return -1;
      if (eps && rng() < eps) return moves[Math.floor(rng() * moves.length)];
      let best = -Infinity;
      for (let i = 0; i < q.length; i++) if (q[i] > best) best = q[i];
      if (!tau) {
        const c = [];
        for (let i = 0; i < q.length; i++) if (q[i] >= best - 1e-9) c.push(moves[i]);
        return c[Math.floor(rng() * c.length)];
      }
      let sum = 0;
      const p = new Float64Array(q.length);
      for (let i = 0; i < q.length; i++) { p[i] = Math.exp((q[i] - best) / tau); sum += p[i]; }
      let x = rng() * sum;
      for (let i = 0; i < q.length; i++) { x -= p[i]; if (x <= 0) return moves[i]; }
      return moves[moves.length - 1];
    }

    // ------------------------------------------------------------------ 比べるための基準（測定用）
    class RandomAgent {
      constructor(color, setup, rng) { this.color = color; this.rng = rng || Math.random; this.pos = C.Pos.start(color === BLACK ? setup : null, color === WHITE ? setup : null); }
      observe(ev) { this.pos.apply(ev.f, ev.t, ev.r); }
      choose() { const ms = this.pos.gen(this.color); return { move: ms.length ? ms[Math.floor(this.rng() * ms.length)] : -1 }; }
    }
    // 簡単な決まりで指す: 司令部に入れるなら入る・強い駒で攻める・弱い駒では攻めない・佐官以上は司令部へ近づく
    class RuleAgent extends RandomAgent {
      choose() {
        const pos = this.pos, c = this.color, ms = pos.gen(c), hq = HQ[c ^ 1];
        if (!ms.length) return { move: -1 };
        const dist = n => Math.abs(C.X(n) - 2.5) * 0.5 + Math.abs(C.Y(n) - C.Y(hq));
        let best = -Infinity, bm = ms[0];
        for (const m of ms) {
          const f = m >> 6, t = m & 63, ta = pos.type[pos.sq[f]];
          let s = this.rng() * 0.5;
          if (t === hq && ta <= SHOSA) s += 100;
          if (pos.sq[t] >= 0) {
            if (ta <= SHOSHO || ta === HIKO) s += 3;
            else if (ta === TANK) s += 2;
            else if (ta <= SHOSA) s += 1;
            else if (ta === KOHEI) s += 0.3;
            else if (ta === SPY) s -= 2;
            else s -= 1;
          } else if (ta <= SHOSA && ta !== TAISHO) s += (dist(f) - dist(t)) * 0.6;
          else s += (dist(f) - dist(t)) * 0.15;
          if (s > best) { best = s; bm = m; }
        }
        return { move: bm };
      }
    }

    return { NF, NF_PS, NF_EX, Net, Belief, Agent, RandomAgent, RuleAgent, LEVELS, sampleSetup, setupMarginals, hungarian, pick, afterValue };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = GunjinAI;
  else root.GunjinAI = GunjinAI;
})(typeof self !== 'undefined' ? self : this);
