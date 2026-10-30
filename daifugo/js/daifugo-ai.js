/* 大富豪の AI: 見えている情報の特徴・ネットの計算・基準の打ち方・学んだ打ち方・AI補助の分析
 * ブラウザ・Web Worker・Node（学習・測定）で同じものを使う
 *
 * 学び方は Deep Monte-Carlo（自己対局で最後まで打った結果を目標に「この局面でこの手を選んだら最後に何位になるか」を当てる）。
 * ネット: 局面の特徴（0/1）→ 256 → 128、手の特徴（0/1）→ 128 を足して → 64 → 4（1位〜4位になる見込み）
 *   1層目と手の層は 0/1 の入力なので「立っている特徴の行を足すだけ」。局面の部分は1回の判断で1度だけ計算し、候補の手ごとに残りを計算する
 * 人が作った評価の数値は使わない。特徴はルールと見えている札から分かる事実だけ
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./daifugo-core.js'), require('./nn-simd.js'));
  else root.DFAI = factory(root.DFCore, root.DFSimd);
})(typeof self !== 'undefined' ? self : this, function (D, SIMD) {
  'use strict';
  const { PASS, GROUP, SEQ, PICK, NR, JOKER, TOP, R3, R2, SPADE3 } = D;
  const PTS = [1, 1 / 3, -1 / 3, -1];   // 1位〜4位の点（期待値をくらべる）

  // ------------------------------------------------------------------ 特徴の並び
  function makeLayout(list) { const o = {}; let n = 0; for (const [k, s] of list) { o[k] = n; n += s; } o.N = n; return o; }
  const SL = makeLayout([
    ['hand', 54], ['unseen', 54], ['played1', 54], ['played2', 54], ['played3', 54], ['known1', 54], ['known2', 54], ['known3', 54], ['field', 54],
    ['fkind', 3], ['fsize', 14], ['frank', 14], ['fby', 4], ['lock', 4], ['numlock', 1], ['rev', 1], ['back', 1], ['dir', 1], ['passes', 4], ['passed', 3],
    ['mycnt', 15], ['cnt1', 15], ['cnt2', 15], ['cnt3', 15], ['top', 4], ['bottom', 4],
    ['myprev', 5], ['prev1', 5], ['prev2', 5], ['prev3', 5], ['miyako', 1],
    ['rules', 16], ['phase', 5], ['left', 5], ['target', 4], ['bias', 1],
    // あとから足した特徴（学んだネットに 0 の行を足して続きから学ぶ）: 各相手がパスした1枚・ペアの場のいちばん弱い強さ（14 = なし）
    ['ps1', 14], ['pp1', 14], ['ps2', 14], ['pp2', 14], ['ps3', 14], ['pp3', 14],
  ]);
  const NS_V1 = 656;   // パスの記録を足す前の局面の特徴の数（古い重みを読むため）
  const AL = makeLayout([
    ['cards', 54], ['after', 54], ['astruct', 65], ['ajk', 3], ['kind', 4], ['size', 14], ['rank', 14], ['mjk', 3],
    ['cut', 1], ['rev', 1], ['back', 1], ['skip', 4], ['k7', 4], ['k10', 4], ['finish', 1], ['foul', 1], ['lockS', 1], ['lockN', 1],
    ['acnt', 15], ['unbeat', 1], ['stronger', 6], ['dirAfter', 1], ['abias', 1],
  ]);
  const NS = SL.N, NA = AL.N;
  // 中間層の大きさ（約330万局で伸びが止まったので 256/128/64 から広げた。古い重みは upgradeParams で広げて読む）
  const DIMS = { NS, NA, H1: 384, H2: 192, H3: 96, NO: 4 };
  const RULE_KEYS = ['rev', 'eight', 'lockSuit', 'lockNum', 'spade3', 'miyako', 'exchange', 'jback', 'skip5', 'pass7', 'discard10', 'seqRev', 'forbid'];
  const MAXS = 112, MAXA = 64;

  // 札の集合を特徴に（ジョーカーは1枚目 = 52、2枚目 = 53 にそろえる）
  function addCards(out, base, cards) {
    let j = 0;
    for (const c of cards) { if (c < 0) continue; if (c >= JOKER) out.push(base + 52 + Math.min(1, j++)); else out.push(base + c); }
  }
  const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function encodeState(g, p, out) {
    out.length = 0;
    const rel = q => (q - p + 4) & 3;
    const abs = k => (p + k) & 3;
    const hand = g.hands[p];
    addCards(out, SL.hand, hand);
    // 見えていない札 = 山の全部 − 自分の手 − 出た札
    const seen = new Uint8Array(54);
    let jkSeen = 0;
    const mark = c => { if (c < 0) return; if (c >= JOKER) jkSeen++; else seen[c] = 1; };
    hand.forEach(mark); g.grave.forEach(mark);
    for (let c = 0; c < 52; c++) if (!seen[c]) out.push(SL.unseen + c);
    for (let j = jkSeen; j < g.rules.jokers; j++) out.push(SL.unseen + 52 + Math.min(1, j));
    for (let k = 1; k < 4; k++) {
      const q = abs(k);
      addCards(out, SL['played' + k], g.played[q]);
      addCards(out, SL['known' + k], g.known[p][q]);
    }
    const f = g.field;
    if (f) {
      addCards(out, SL.field, f.cards);
      out.push(SL.fkind + (f.k === SEQ ? 2 : 1));
      out.push(SL.fsize + clampI(f.n, 0, 13));
      out.push(SL.frank + clampI(f.r, 0, 13));
      out.push(SL.fby + rel(g.fieldBy));
    } else out.push(SL.fkind);
    for (let s = 0; s < 4; s++) if (g.lockSuit & (1 << s)) out.push(SL.lock + s);
    if (g.numLock) out.push(SL.numlock);
    if (g.rev) out.push(SL.rev);
    if (g.back) out.push(SL.back);
    if (g.dir < 0) out.push(SL.dir);
    out.push(SL.passes + clampI(g.passes, 0, 3));
    for (let k = 1; k < 4; k++) if (g.passed[abs(k)]) out.push(SL.passed + k - 1);
    out.push(SL.mycnt + clampI(hand.length, 0, 14));
    for (let k = 1; k < 4; k++) out.push(SL['cnt' + k] + clampI(g.hands[abs(k)].length, 0, 14));
    out.push(SL.top + clampI(g.top, 0, 3));
    out.push(SL.bottom + clampI(g.bottom, 0, 3));
    const pv = q => (g.prev ? g.prev[q] + 1 : 0);
    out.push(SL.myprev + pv(p));
    for (let k = 1; k < 4; k++) out.push(SL['prev' + k] + pv(abs(k)));
    if (g.miyakoDone) out.push(SL.miyako);
    const r = g.rules;
    out.push(SL.rules + clampI(r.jokers, 0, 2));
    RULE_KEYS.forEach((k, i) => { if (r[k]) out.push(SL.rules + 3 + i); });
    const pd = g.pend;
    const ph = pd ? (pd.kind === 'give' ? 2 : pd.kind === 'give7' ? 3 : 4) : (f ? 1 : 0);
    out.push(SL.phase + ph);
    out.push(SL.left + (pd ? clampI(pd.left, 0, 4) : 0));
    out.push(SL.target + (pd && pd.to >= 0 ? rel(pd.to) : 0));
    out.push(SL.bias);
    for (let k = 1; k < 4; k++) {
      const a = g.pinfo ? g.pinfo[abs(k)] : null, d = g.dir;
      out.push(SL['ps' + k] + (a && a[0] >= 0 && a[1] === d ? a[0] : 13));
      out.push(SL['pp' + k] + (a && a[2] >= 0 && a[3] === d ? a[2] : 13));
    }
    if (out.length > MAXS) out.length = MAXS;
    return out;
  }

  // 見えていない札で、この手をこえる手が作れるか（しばりは考えない。だれが持っているかも分からないので「作れるか」だけ）
  function beatInfo(g, p, mv, eff) {
    if (mv.k === PASS || mv.k === PICK) return { unbeat: false, stronger: 0 };
    if (eff.cut) return { unbeat: true, stronger: 0 };
    const cnt = new Uint8Array(NR), suits = new Uint8Array(NR);
    let uj = g.rules.jokers;
    const seen = new Uint8Array(54);
    for (const c of g.hands[p]) if (c >= 0 && c < JOKER) seen[c] = 1; else if (c >= JOKER) uj--;
    for (const c of g.grave) if (c >= 0 && c < JOKER) seen[c] = 1; else if (c >= JOKER) uj--;
    uj = Math.max(0, uj);
    for (let c = 0; c < 52; c++) if (!seen[c]) { cnt[c % NR]++; suits[c % NR] |= 1 << ((c / NR) | 0); }
    const d = eff.dirAfter;
    const stronger = r2 => (mv.r === TOP ? false : d > 0 ? r2 > mv.r : r2 < mv.r);
    let n = 0;
    if (mv.k === GROUP) {
      if (mv.r === TOP) {
        const ok = g.rules.spade3 && mv.n === 1 && !seen[SPADE3] && !g.hands[p].includes(SPADE3);
        return { unbeat: !ok, stronger: ok ? 1 : 0 };
      }
      for (let r2 = 0; r2 < NR; r2++) if (stronger(r2) && cnt[r2] > 0 && cnt[r2] + uj >= mv.n) n++;
      const jtop = mv.n <= 2 && uj >= mv.n;
      return { unbeat: n === 0 && !jtop, stronger: n + (jtop ? 1 : 0) };
    }
    // 階段
    for (let s = 0; s < 4; s++) {
      for (let st = 0; st + mv.n <= NR; st++) {
        if (!stronger(st)) continue;
        let miss = 0, real = 0;
        for (let i = 0; i < mv.n; i++) if (suits[st + i] & (1 << s)) real++; else miss++;
        if (real && miss <= uj) n++;
      }
    }
    return { unbeat: n === 0, stronger: n };
  }

  // 手の特徴（g は手を出す前の局面、p は手を出す人）
  const _after = [];
  function encodeAction(g, p, mv, out, eff) {
    out.length = 0;
    eff = eff || g.effects(mv);
    addCards(out, AL.cards, mv.cards);
    // 出したあとの手
    const rm = mv.cards.slice();
    _after.length = 0;
    for (const c of g.hands[p]) { const i = rm.indexOf(c); if (i >= 0) rm.splice(i, 1); else _after.push(c); }
    addCards(out, AL.after, _after);
    const cnt = new Uint8Array(NR); let jk = 0;
    for (const c of _after) { if (c >= JOKER) jk++; else if (c >= 0) cnt[c % NR]++; }
    for (let r = 0; r < NR; r++) out.push(AL.astruct + r * 5 + cnt[r]);
    out.push(AL.ajk + clampI(jk, 0, 2));
    out.push(AL.kind + (mv.k === PASS ? 0 : mv.k === GROUP ? 1 : mv.k === SEQ ? 2 : 3));
    if (mv.k === GROUP || mv.k === SEQ) {
      out.push(AL.size + clampI(mv.n, 0, 13));
      out.push(AL.rank + clampI(mv.r, 0, 13));
      out.push(AL.mjk + clampI(mv.jk, 0, 2));
    } else if (mv.k === PICK) out.push(AL.rank + clampI(mv.cards[0] >= JOKER ? TOP : mv.cards[0] % NR, 0, 13));
    if (eff.cut) out.push(AL.cut);
    if (eff.rev) out.push(AL.rev);
    if (eff.back) out.push(AL.back);
    out.push(AL.skip + clampI(eff.skip, 0, 3));
    out.push(AL.k7 + clampI(eff.k7, 0, 3));
    out.push(AL.k10 + clampI(eff.k10, 0, 3));
    if (eff.finish) out.push(AL.finish);
    if (eff.foul) out.push(AL.foul);
    if (eff.lockS) out.push(AL.lockS);
    if (eff.lockN) out.push(AL.lockN);
    out.push(AL.acnt + clampI(_after.length, 0, 14));
    const bi = beatInfo(g, p, mv, eff);
    if (bi.unbeat) out.push(AL.unbeat);
    out.push(AL.stronger + (bi.stronger >= 7 ? 5 : bi.stronger >= 4 ? 4 : bi.stronger));
    if (eff.dirAfter < 0) out.push(AL.dirAfter);
    out.push(AL.abias);
    if (out.length > MAXA) out.length = MAXA;
    return out;
  }

  // ------------------------------------------------------------------ ネット
  // 重みの並び（Float32Array 1本）: W1[NS×H1] b1[H1] W2[H1×H2] b2[H2] WA[NA×H2] W3[H2×H3] b3[H3] W4[H3×NO] b4[NO]
  function paramLayout(d = DIMS) {
    const o = {}; let n = 0;
    const add = (k, s) => { o[k] = n; n += s; };
    add('W1', d.NS * d.H1); add('b1', d.H1); add('W2', d.H1 * d.H2); add('b2', d.H2); add('WA', d.NA * d.H2);
    add('W3', d.H2 * d.H3); add('b3', d.H3); add('W4', d.H3 * d.NO); add('b4', d.NO);
    o.N = n;
    return o;
  }
  const PL = paramLayout();
  // 古い並び（局面の特徴 nsOld 個）の重みを、いまの並びに広げる（足した特徴の行は 0 なので、出力は変わらない）
  // 古い並びの重みを、いまの並びに広げる（出力は変わらない）
  //   ・あとから足した局面の特徴の行は 0
  //   ・広げた中間層の新しい素子は「出ていく重み」を 0 にする（だから出力は同じ）。入ってくる重みは rnd があれば小さな乱数（学習を続けるとき。0 だと学べない）、なければ 0
  const OLD_LAYOUTS = [{ NS: NS_V1, H1: 256, H2: 128, H3: 64 }, { NS, H1: 256, H2: 128, H3: 64 }];
  function upgradeParams(w, rnd) {
    if (w.length === PL.N) return w;
    let od = null;
    for (const l of OLD_LAYOUTS) { const d = Object.assign({}, DIMS, l); if (paramLayout(d).N === w.length) { od = d; break; } }
    if (!od) return null;
    const old = paramLayout(od), out = new Float32Array(PL.N), d = DIMS;
    const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const ran = fan => (rnd ? gauss() * Math.sqrt(2 / fan) * 0.5 : 0);
    // 行列 k: 入力 rows×出力 cols → rows'×cols'。newIn: 新しい入力の行（新しい素子から出ていく）は 0、新しい出力の列（新しい素子へ入る）は乱数
    const mat = (k, rows, cols, rows2, cols2, fan) => {
      for (let i = 0; i < rows2; i++) for (let j = 0; j < cols2; j++) {
        let v = 0;
        if (i < rows && j < cols) v = w[old[k] + i * cols + j];
        else if (i < rows && j >= cols) v = ran(fan);   // 古い入力 → 新しい素子
        out[PL[k] + i * cols2 + j] = v;
      }
    };
    const vec = (k, n) => { for (let j = 0; j < n; j++) out[PL[k] + j] = w[old[k] + j]; };
    // W1 の行: 古い特徴の行だけ（足した特徴の行は 0 のまま。ただし新しい素子への列は乱数にしない＝足した特徴は 0）
    for (let i = 0; i < d.NS; i++) for (let j = 0; j < d.H1; j++) {
      let v = 0;
      if (i < od.NS && j < od.H1) v = w[old.W1 + i * od.H1 + j];
      else if (i < od.NS && j >= od.H1) v = ran(40);
      out[PL.W1 + i * d.H1 + j] = v;
    }
    vec('b1', od.H1);
    mat('W2', od.H1, od.H2, d.H1, d.H2, d.H1);
    vec('b2', od.H2);
    for (let i = 0; i < d.NA; i++) for (let j = 0; j < d.H2; j++) out[PL.WA + i * d.H2 + j] = j < od.H2 ? w[old.WA + i * od.H2 + j] : ran(30);
    mat('W3', od.H2, od.H3, d.H2, d.H3, d.H2);
    vec('b3', od.H3);
    mat('W4', od.H3, d.NO, d.H3, d.NO, d.H3);
    vec('b4', d.NO);
    return out;
  }

  function initParams(seed = 1) {
    const w = new Float32Array(PL.N), rnd = D.rng32(seed);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const fill = (k, n, fanIn) => { const s = Math.sqrt(2 / fanIn); for (let i = 0; i < n; i++) w[PL[k] + i] = gauss() * s; };
    fill('W1', DIMS.NS * DIMS.H1, 60); fill('W2', DIMS.H1 * DIMS.H2, DIMS.H1); fill('WA', DIMS.NA * DIMS.H2, 40);
    fill('W3', DIMS.H2 * DIMS.H3, DIMS.H2); fill('W4', DIMS.H3 * DIMS.NO, DIMS.H3);
    for (let i = 0; i < DIMS.H3 * DIMS.NO; i++) w[PL.W4 + i] *= 0.1;
    return w;
  }

  class Net {
    constructor(params) {
      this.w = params;
      const { H1, H2, H3, NO } = DIMS;
      this.h1 = new Float32Array(H1); this.h2 = new Float32Array(H2);
      this.z = new Float32Array(H2); this.h3 = new Float32Array(H3); this.out = new Float32Array(NO);
    }
    // 局面の部分（1回の判断で1度）
    state(sIdx) {
      const w = this.w, { H1, H2 } = DIMS, h1 = this.h1, h2 = this.h2;
      h1.set(w.subarray(PL.b1, PL.b1 + H1));
      for (let k = 0; k < sIdx.length; k++) { const o = PL.W1 + sIdx[k] * H1; for (let j = 0; j < H1; j++) h1[j] += w[o + j]; }
      h2.set(w.subarray(PL.b2, PL.b2 + H2));
      for (let i = 0; i < H1; i++) {
        const v = h1[i];
        if (v <= 0) { h1[i] = 0; continue; }
        const o = PL.W2 + i * H2;
        for (let j = 0; j < H2; j++) h2[j] += v * w[o + j];
      }
      return h2;
    }
    // 手ごと: 4つの見込み（logit）を out に
    action(aIdx) {
      const w = this.w, { H2, H3, NO } = DIMS, z = this.z, h3 = this.h3, out = this.out;
      z.set(this.h2);
      for (let k = 0; k < aIdx.length; k++) { const o = PL.WA + aIdx[k] * H2; for (let j = 0; j < H2; j++) z[j] += w[o + j]; }
      h3.set(w.subarray(PL.b3, PL.b3 + H3));
      for (let i = 0; i < H2; i++) {
        const v = z[i];
        if (v <= 0) continue;
        const o = PL.W3 + i * H3;
        for (let j = 0; j < H3; j++) h3[j] += v * w[o + j];
      }
      out.set(w.subarray(PL.b4, PL.b4 + NO));
      for (let i = 0; i < H3; i++) {
        const v = h3[i];
        if (v <= 0) continue;
        const o = PL.W4 + i * NO;
        for (let j = 0; j < NO; j++) out[j] += v * w[o + j];
      }
      return out;
    }
  }
  // 同じ計算を WebAssembly SIMD で（重みは部品のメモリに写す。共有の重みを使う学習では sync() で写し直す）
  class SimdNet {
    constructor(params, S) {
      const { H1, H2, H3 } = DIMS;
      this.S = S; this.w = params;
      this.F = new Float32Array(S.memory.buffer); this.I = new Int32Array(S.memory.buffer);
      this.o1 = PL.N; this.o2 = this.o1 + H1; this.oz = this.o2 + H2; this.o3 = this.oz + H2; this.oo = this.o3 + H3; this.oi = this.oo + 4;
      this.F.set(params, 0);
      this.out = this.F.subarray(this.oo, this.oo + 4);
    }
    sync(params) { this.F.set(params || this.w, 0); }
    state(sIdx) {
      const { H1, H2 } = DIMS, F = this.F;
      F.copyWithin(this.o1, PL.b1, PL.b1 + H1);
      this.I.set(sIdx, this.oi);
      this.S.addrows(PL.W1 * 4, this.oi * 4, sIdx.length, H1, this.o1 * 4);
      F.copyWithin(this.o2, PL.b2, PL.b2 + H2);
      this.S.layer(this.o1 * 4, H1, PL.W2 * 4, H2, this.o2 * 4);
      return F.subarray(this.o2, this.o2 + H2);
    }
    action(aIdx) {
      const { H2, H3, NO } = DIMS, F = this.F;
      F.copyWithin(this.oz, this.o2, this.o2 + H2);
      this.I.set(aIdx, this.oi);
      this.S.addrows(PL.WA * 4, this.oi * 4, aIdx.length, H2, this.oz * 4);
      F.copyWithin(this.o3, PL.b3, PL.b3 + H3);
      this.S.layer(this.oz * 4, H2, PL.W3 * 4, H3, this.o3 * 4);
      F.copyWithin(this.oo, PL.b4, PL.b4 + NO);
      this.S.layer(this.o3 * 4, H3, PL.W4 * 4, NO, this.oo * 4);
      return this.out;
    }
  }
  // 速い方のネットを作る（WebAssembly SIMD が使えなければ JS の計算）
  function makeNet(params) {
    const S = SIMD && SIMD.create((PL.N + 1024) * 4 + 4096);
    if (S) { try { return new SimdNet(params, S); } catch (e) { /* JS の計算で */ } }
    const n = new Net(params);
    n.sync = () => {};
    return n;
  }
  function softmax4(o, dst) {
    const m = Math.max(o[0], o[1], o[2], o[3]);
    let s = 0;
    for (let i = 0; i < 4; i++) { dst[i] = Math.exp(o[i] - m); s += dst[i]; }
    for (let i = 0; i < 4; i++) dst[i] /= s;
    return dst;
  }
  const evOf = pr => pr[0] * PTS[0] + pr[1] * PTS[1] + pr[2] * PTS[2] + pr[3] * PTS[3];
  const avgRank = pr => pr[0] * 1 + pr[1] * 2 + pr[2] * 3 + pr[3] * 4;

  // ------------------------------------------------------------------ 重みの読み書き（ブラウザ用は int8 に量子化して base64）
  function b64enc(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64dec(str) {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(str, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    const s = atob(str), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  // 行列は「入力1つぶんの行」ごとに尺度を持つ int8、バイアスは float32
  const MATS = [['W1', DIMS.NS, DIMS.H1], ['W2', DIMS.H1, DIMS.H2], ['WA', DIMS.NA, DIMS.H2], ['W3', DIMS.H2, DIMS.H3], ['W4', DIMS.H3, DIMS.NO]];
  const BIAS = [['b1', DIMS.H1], ['b2', DIMS.H2], ['b3', DIMS.H3], ['b4', DIMS.NO]];
  function quantize(w) {
    const q = new Int8Array(MATS.reduce((a, [, r, c]) => a + r * c, 0));
    const scales = [];
    let o = 0;
    for (const [k, rows, cols] of MATS) {
      for (let i = 0; i < rows; i++) {
        let m = 0;
        for (let j = 0; j < cols; j++) m = Math.max(m, Math.abs(w[PL[k] + i * cols + j]));
        const s = m / 127 || 1e-8;
        scales.push(s);
        for (let j = 0; j < cols; j++) q[o++] = Math.round(w[PL[k] + i * cols + j] / s);
      }
    }
    const bias = new Float32Array(BIAS.reduce((a, [, n]) => a + n, 0));
    let bo = 0;
    for (const [k, n] of BIAS) for (let i = 0; i < n; i++) bias[bo++] = w[PL[k] + i];
    return { q: b64enc(new Uint8Array(q.buffer)), s: b64enc(new Uint8Array(new Float32Array(scales).buffer)), b: b64enc(new Uint8Array(bias.buffer)) };
  }
  function dequantize(obj) {
    const w = new Float32Array(PL.N);
    const qb = b64dec(obj.q), q = new Int8Array(qb.buffer, qb.byteOffset, qb.byteLength);
    const sb = b64dec(obj.s), sc = new Float32Array(sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.byteLength));
    const bb = b64dec(obj.b), bias = new Float32Array(bb.buffer.slice(bb.byteOffset, bb.byteOffset + bb.byteLength));
    let o = 0, si = 0;
    for (const [k, rows, cols] of MATS) for (let i = 0; i < rows; i++) { const s = sc[si++]; for (let j = 0; j < cols; j++) w[PL[k] + i * cols + j] = q[o++] * s; }
    let bo = 0;
    for (const [k, n] of BIAS) for (let i = 0; i < n; i++) w[PL[k] + i] = bias[bo++];
    return w;
  }

  // ------------------------------------------------------------------ 打ち方
  const pick = (L, rnd) => L[Math.floor(rnd() * L.length)];
  function chooseRandom(g, rnd) { return pick(g.legal(), rnd); }

  // 基準の AI「弱い札から出す」: 出せるうちでいちばん弱い数の手（同じなら枚数の多い方・ジョーカーの少ない方）。出せなければパス。渡す・捨てるは弱い札から
  function weakVal(g, mv) {
    const d = g.dir;
    if (mv.k === PICK) { const c = mv.cards[0]; return c >= JOKER ? 100 : c % NR; }
    const r = mv.r === TOP ? 100 : d > 0 ? mv.r : NR - 1 - mv.r;
    return r * 100 - mv.n * 3 + mv.jk * 10;
  }
  function chooseWeakest(g) {
    const L = g.legal();
    let best = null, bv = Infinity;
    for (const mv of L) { if (mv.k === PASS) continue; const v = weakVal(g, mv); if (v < bv) { bv = v; best = mv; } }
    return best || L.find(m => m.k === PASS) || L[0];
  }

  const _s = [], _a = [], _pr = new Float32Array(4);
  // 学んだネットで、出せる手それぞれの見込みを出す: [{ mv, pr: [1位..4位], ev }]
  function evaluate(g, net, L) {
    const p = g.actor;
    L = L || g.legal();
    encodeState(g, p, _s);
    net.state(_s);
    const res = [];
    for (const mv of L) {
      encodeAction(g, p, mv, _a);
      const o = net.action(_a);
      softmax4(o, _pr);
      res.push({ mv, pr: [_pr[0], _pr[1], _pr[2], _pr[3]], ev: evOf(_pr) });
    }
    return res;
  }
  // temp: 0 = いちばんの手、> 0 = 見込みの差 ÷ temp の exp に比例して選ぶ（ゆらぎ）
  function chooseNet(g, net, opt = {}) {
    const L = g.legal();
    if (L.length === 1) return { mv: L[0], res: null };
    const res = evaluate(g, net, L);
    let bi = 0;
    for (let i = 1; i < res.length; i++) if (res[i].ev > res[bi].ev) bi = i;
    if (opt.temp > 0 && opt.rnd) {
      const m = res[bi].ev; let s = 0;
      const ws = res.map(r => { const x = Math.exp((r.ev - m) / opt.temp); s += x; return x; });
      let u = opt.rnd() * s;
      for (let i = 0; i < res.length; i++) { u -= ws[i]; if (u <= 0) return { mv: res[i].mv, res, best: bi }; }
    }
    return { mv: res[bi].mv, res, best: bi };
  }

  // ------------------------------------------------------------------ 見えない札を仮に配る（読みに使う）
  // p から見えている情報（自分の手・出た札・各自の枚数・知っている札）と食い違わないように、ほかの人の手をでたらめに決めた局面を作る
  function sampleWorld(g, p, rnd) {
    const w = g.clone();
    const pool = [];
    const seen = new Set(), seenJ = { n: 0 };
    const mark = c => { if (c >= JOKER) seenJ.n++; else if (c >= 0) seen.add(c); };
    g.hands[p].forEach(mark); g.grave.forEach(mark);
    const fixed = [[], [], [], []];
    for (let q = 0; q < 4; q++) if (q !== p) for (const c of g.known[p][q]) { fixed[q].push(c); mark(c); }
    for (let c = 0; c < 52; c++) if (!seen.has(c)) pool.push(c);
    for (let j = seenJ.n; j < g.rules.jokers; j++) pool.push(JOKER + j);
    D.shuffle(pool, rnd);
    // ジョーカーの番号の食い違い（52 と 53）を避けるため、手に残る番号で配り直す
    for (let q = 0; q < 4; q++) {
      if (q === p) continue;
      const need = g.hands[q].length - fixed[q].length;
      const h = fixed[q].slice();
      for (let i = 0; i < need && pool.length; i++) h.push(pool.pop());
      w.hands[q] = D.sortHand(h);
    }
    return w;
  }

  // ------------------------------------------------------------------ 読み（最強で、測って強くなったときだけ使う）
  // 見えない札を何通りも仮に配り、ネットの見込みが上位の手それぞれについて、最後までネットどうしで打ってみる。
  // 打ってみた結果の平均と、ネットの見込み（m0 局ぶんの重み）を合わせて選ぶ。opt: { k: 候補の数, d: 配りの数, timeMs, maxCards: 手札がこの枚数以下のときだけ読む, m0, rnd }
  function searchChoose(g, net, opt = {}) {
    const L = g.legal();
    if (L.length === 1) return { mv: L[0], res: null };
    const res = evaluate(g, net, L).sort((a, b) => b.ev - a.ev);
    const p = g.actor;
    if (opt.maxCards && g.hands[p].length > opt.maxCards) return { mv: res[0].mv, res, searched: 0 };
    const K = Math.min(opt.k || 4, res.length);
    if (K < 2 || res[0].ev - res[1].ev > (opt.margin || 0.5)) return { mv: res[0].mv, res, searched: 0 };
    const rnd = opt.rnd || Math.random, m0 = opt.m0 != null ? opt.m0 : 6;
    const sums = new Float64Array(K), deadline = opt.timeMs ? Date.now() + opt.timeMs : 0;
    let n = 0;
    const maxD = opt.d || 24;
    for (let d = 0; d < maxD; d++) {
      if (deadline && n >= 4 && Date.now() > deadline) break;
      const w = sampleWorld(g, p, rnd);
      for (let i = 0; i < K; i++) {
        const x = w.clone();
        x.apply(res[i].mv);
        let steps = 0;
        while (x.phase !== 'done' && steps++ < 500) x.apply(chooseNet(x, net, {}).mv);
        sums[i] += PTS[x.rank[p]] || 0;
      }
      n++;
    }
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < K; i++) {
      const v = (sums[i] + m0 * res[i].ev) / (n + m0);
      res[i].sv = v;
      if (v > bv) { bv = v; bi = i; }
    }
    return { mv: res[bi].mv, res, searched: n };
  }

  return {
    PTS, SL, AL, NS, NA, DIMS, PL, MAXS, MAXA, RULE_KEYS, searchChoose,
    encodeState, encodeAction, beatInfo, paramLayout, upgradeParams, initParams, Net, SimdNet, makeNet, softmax4, evOf, avgRank,
    quantize, dequantize, b64enc, b64dec,
    chooseRandom, chooseWeakest, weakVal, evaluate, chooseNet, sampleWorld,
  };
});
