/* ごいたの AI: 自己対局だけで学んだ「行動の値」（その手で自分の組が取る点・取られる点の見込み）で選ぶ。最強は先を読む
 * ブラウザ・Node・Web Worker のどこでも動く（GoitaCore(S) のあとに GoitaAI(S) を呼ぶ）
 *
 * 値 Q(局面, 行動) = 特徴ごとの重みの和。特徴: 行動のあとに手に残る駒の種類ごとの枚数・攻める駒の種類と、それを自分がまだ持つ数・
 *   まだ見えていないその駒の数（ほかの人が受けられそうか）・伏せる駒・王で切ったか・上がりと点・味方と相手の残りの枚数・
 *   受ける攻めの種類と、攻めたのが味方か相手か・何人「なし」と言ったか…
 *   重みは全部 0 から、自己対局の結果（その手で自分の組が取った点は +、取られた点は −）だけで学ぶ
 * 最強: 見えていない駒をほかの3人の手と伏せた駒に何通りも配り直し、有力な行動ごとに手の終わりまで学んだ方策で指し進めて比べる
 */
function GoitaAI(S) {
  'use strict';
  const { COUNT, VALUE, OU, PASS, isLead, isRecv, aFirst, aAtk, team, Hand } = S;
  const F = {};
  let nf = 0;
  const block = (name, n) => { F[name] = nf; nf += n; };
  block('kind', 5);       // 伏せて攻める・なし（味方の攻め）・なし（相手の攻め）・受ける（味方の攻め）・受ける（相手の攻め）
  block('comp', 8 * 5);   // 行動のあとに手に残る、種類ごとの枚数（0〜4）
  block('atk', 8);        // 攻める駒
  block('atkMine', 8 * 3);// 攻める駒 × それを自分がまだ持つ数（0・1・2以上）
  block('atkUnseen', 8 * 4); // 攻める駒 × まだ見えていないその駒の数（0・1・2・3以上）
  block('fd', 8);         // 伏せる駒
  block('cut', 2);        // 王で切った（味方の攻め・相手の攻め）
  block('recvX', 8 * 2);  // 受けた攻めの種類 × 味方か相手か
  block('passX', 8 * 2);  // なしと言った攻めの種類 × 味方か相手か
  block('passMine', 4 * 2); // なしと言ったとき、その攻めの駒を自分が持つ数 × 味方か相手か
  block('out', 11);       // 上がり（点 / 10）
  block('dbl', 1);        // 2倍の上がり
  block('left', 5);       // 行動のあとの手の枚数（0・2・4・6・8）/ 2
  block('szP', 5 * 3);    // 味方の残り枚数 × 行動の種類（伏せ・なし・受け）
  block('szO', 5 * 3);    // 相手の少ない方の残り枚数 × 行動の種類
  block('passes', 3 * 2); // ここまでの「なし」の数 × なし・受け
  block('ou', 3);         // 王が表に出ている × 行動の種類
  block('nextP', 2);      // なしのとき、次に受けるのが味方か
  block('atkPassO', 8 * 3); // 攻める駒 × その駒の攻めを「なし」で見送ったことのある相手の数（0・1・2）
  block('atkPassP', 8 * 2); // 攻める駒 × 味方がその駒の攻めを見送ったことがあるか
  block('recvPassP', 2);    // 受けるとき・なしのとき、味方が今の攻めをもう見送ったか
  const NF = nf;

  // p から見えている情報（見えていない駒の数など）
  function view(h, p) {
    const unseen = COUNT.slice();
    for (let t = 0; t < 8; t++) unseen[t] -= h.hands[p][t];
    for (let q = 0; q < 4; q++) for (const x of h.played[q]) if (!x.fd || q === p) unseen[x.t]--;
    return unseen;
  }
  // だれがどの駒の攻めを「なし」で見送ったか（passed[q] のビット t）。手の記録から作る（公開の情報）
  function passedOn(h) {
    const out = [0, 0, 0, 0];
    let atk = -1;
    for (const mv of h.moves) {
      if (mv.a === PASS) { if (atk >= 0) out[mv.p] |= 1 << atk; }
      else atk = aAtk(mv.a);
    }
    return out;
  }
  function features(h, p, a, unseen, out, passed) {
    let n = 0;
    passed = passed || passedOn(h);
    const hand = h.hands[p], partner = (p + 2) % 4, rel = h.attacker >= 0 && team(h.attacker) === team(p) ? 0 : 1;
    const szP = Math.min(4, h.size(partner) >> 1), szO = Math.min(4, Math.min(h.size((p + 1) % 4), h.size((p + 3) % 4)) >> 1);
    const after = Int8Array.from(hand);
    let k;
    const oppA = (p + 1) % 4, oppB = (p + 3) % 4;
    if (h.phase === 'respond' && ((passed[partner] >> h.atk) & 1) && h.attacker !== partner) out[n++] = F.recvPassP + (a === PASS ? 0 : 1);
    if (a === PASS) {
      k = 1;
      out[n++] = F.kind + 1 + rel;
      out[n++] = F.passX + h.atk * 2 + rel;
      out[n++] = F.passMine + Math.min(3, hand[h.atk]) * 2 + rel;
      out[n++] = F.passes + Math.min(2, h.passes) * 2;
      out[n++] = F.nextP + (team((p + 1) % 4) === team(h.attacker) ? 1 : 0);
    } else {
      const f = aFirst(a), t = aAtk(a);
      after[f]--; after[t]--;
      if (isLead(a)) { k = 0; out[n++] = F.kind; out[n++] = F.fd + f; }
      else {
        k = 2;
        out[n++] = F.kind + 3 + rel;
        out[n++] = F.recvX + h.atk * 2 + rel;
        if (f === OU) out[n++] = F.cut + rel;
        out[n++] = F.passes + Math.min(2, h.passes) * 2 + 1;
      }
      const left = after.reduce((s, v) => s + v, 0);
      out[n++] = F.atk + t;
      out[n++] = F.atkPassO + t * 3 + ((passed[oppA] >> t) & 1) + ((passed[oppB] >> t) & 1);
      out[n++] = F.atkPassP + t * 2 + ((passed[partner] >> t) & 1);
      out[n++] = F.atkMine + t * 3 + Math.min(2, after[t]);
      out[n++] = F.atkUnseen + t * 4 + Math.min(3, Math.max(0, unseen[t]));
      out[n++] = F.left + Math.min(4, left >> 1);
      if (!left) { out[n++] = F.out + Math.min(10, VALUE[t] * (isLead(a) && f === t ? 2 : 1) / 10); if (isLead(a) && f === t) out[n++] = F.dbl; }
    }
    for (let t = 0; t < 8; t++) out[n++] = F.comp + t * 5 + Math.min(4, after[t]);
    out[n++] = F.szP + szP * 3 + k;
    out[n++] = F.szO + szO * 3 + k;
    if (h.ouOut) out[n++] = F.ou + k;
    return n;
  }

  class Policy {
    constructor(W) {
      this.w = new Float64Array(NF);
      if (W && W.w) {
        if (typeof W.w === 'string') {
          const bin = atob(W.w), n = Math.min(NF, bin.length >> 1);
          for (let i = 0; i < n; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); this.w[i] = ((v << 16) >> 16) / 10000; }
        } else for (let i = 0; i < Math.min(NF, W.w.length); i++) this.w[i] = W.w[i];
      }
      this.gen = (W && W.gen) || 0;
      this.buf = new Int32Array(48);
    }
    values(h, p) {
      const unseen = view(h, p), passed = passedOn(h), out = [];
      for (const a of h.legal()) {
        const n = features(h, p, a, unseen, this.buf, passed);
        let v = 0;
        for (let i = 0; i < n; i++) v += this.w[this.buf[i]];
        out.push({ a, v });
      }
      return out;
    }
    choose(h, p, opts = {}) {
      const rnd = opts.rnd || Math.random, vs = this.values(h, p);
      if (!vs.length) return PASS;
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

  // p から見て、見えていない駒をほかの3人の手と伏せた駒に配り直した局面
  function sampleWorld(h, p, rnd) {
    const g = h.clone(), unseen = view(h, p), pool = [];
    for (let t = 0; t < 8; t++) for (let i = 0; i < unseen[t]; i++) pool.push(t);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
    let k = 0;
    for (let q = 0; q < 4; q++) {
      if (q === p) continue;
      const sz = h.size(q);
      g.hands[q] = new Int8Array(8);
      for (let i = 0; i < sz; i++) g.hands[q][pool[k++]]++;
    }
    for (let q = 0; q < 4; q++) {
      if (q === p) continue;
      let ou = false;
      g.played[q] = h.played[q].map(x => { if (!x.fd) return x; const t = pool[k++]; if (t === OU) ou = true; return { t, fd: true, role: x.role }; });
      g.fdOu[q] = ou;
    }
    return g;
  }
  // 最強: 有力な行動 top 個を、配り直した局面 samples 通りで手の終わりまで指し進めて比べる。戻り値 { a, est }
  function plan(pol, h, p, opts = {}) {
    const rnd = opts.rnd || Math.random, samples = opts.samples || 80, top = opts.top || 5;
    const vs = pol.values(h, p).sort((x, y) => y.v - x.v), cands = vs.slice(0, top);
    if (cands.length <= 1) return { a: cands.length ? cands[0].a : PASS, est: cands.map(c => ({ a: c.a, v: c.v, q: c.v })) };
    const sum = new Float64Array(cands.length);
    for (let s = 0; s < samples; s++) {
      const w0 = sampleWorld(h, p, rnd);
      for (let c = 0; c < cands.length; c++) {
        const g = w0.clone();
        g.act(cands[c].a);
        for (let guard = 0; !g.over && guard < 200; guard++) g.act(pol.choose(g, g.turn, { rnd }));
        sum[c] += g.over ? (team(g.winner) === team(p) ? g.points : -g.points) / 100 : 0;
      }
    }
    const est = cands.map((c, i) => ({ a: c.a, v: sum[i] / samples, q: c.v }));
    let best = est[0];
    for (const e of est) if (e.v > best.v) best = e;
    return { a: best.a, est };
  }
  // 「し」5枚の配り直し: このままの手の見込み（自分の組から見た点 / 100）。負なら配り直したい
  function keepValue(pol, hands, dealer, p, rnd, samples = 60) {
    let sum = 0;
    for (let s = 0; s < samples; s++) {
      const h = new Hand(dealer);
      h.hands = hands.map(x => Int8Array.from(x));
      const w = sampleWorld(h, p, rnd);
      for (let guard = 0; !w.over && guard < 200; guard++) w.act(pol.choose(w, w.turn, { rnd }));
      sum += w.over ? (team(w.winner) === team(p) ? w.points : -w.points) / 100 : 0;
    }
    return sum / samples;
  }

  Object.assign(S, { NF, F, view, passedOn, features, Policy, sampleWorld, plan, keepValue });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = GoitaAI;
