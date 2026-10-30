/* 麻雀の AI: 見えている情報の特徴・ネットの計算・CPU の打ち方（牌効率だけの基準の AI と、自己対局で学んだネットの AI）・AI補助の分析
 * ブラウザ（画面・Web Worker）と Node（自己対局の学習）で同じものを使う
 *
 * ネット（Deep Monte-Carlo）: 局面の特徴 S（0/1）と行動の特徴 A（0/1）から「その行動を選んだあとの価値」を出す
 *   t1 = relu(b1 + Σ_{i∈S} W1[i])          H1
 *   t2 = relu(b2 + W2ᵀ t1)                  H2      ← 局面だけで決まる（1回の判断で1回だけ計算）
 *   e  = ba + Σ_{j∈A} Wa[j]                 H2      ← 行動ごと
 *   z  = relu(t2 + e)
 *   h3 = relu(b3 + W3ᵀ z)                   H3
 *   out = b4 + W4ᵀ h3                       2: [対局の価値（最終の順位点の見込み ÷ 50）, この局の得点の増減 ÷ 12000]
 * 特徴には人の作った評価の数値は入れない。入れるのはルールから計算できること（見えている牌・向聴数・受け入れの枚数・和了ったときの点・フリテンの決まりで安全な牌）だけ
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mj-core.js'));
  else root.MJAI = factory(root.MJ);
})(typeof self !== 'undefined' ? self : this, function (MJ) {
  'use strict';
  const { NK, shanten, waitsOf, evaluateHand, doraOf, isYaochu, isDragon } = MJ;

  // ------------------------------------------------------------------ 特徴の並び
  function layout(segs) { const o = { size: 0 }; for (const [k, n] of segs) { o[k] = o.size; o.size += n; } return o; }
  const SL = layout([
    ['hand', 136], ['handRed', 3], ['disc', 4 * 136], ['meld', 4 * 136], ['safe', 3 * 34], ['recent', 4 * 34], ['tsumogiri', 4 * 6],
    ['unseen', 34 * 5], ['dora', 34 * 2], ['pstate', 4 * 20], ['round', 36], ['score', 4 * 10], ['rank', 16], ['diff', 3 * 14],
    ['phase', 4], ['shanten', 8], ['myDora', 5], ['yakuFlags', 4],
  ]);
  const AL = layout([
    ['type', 12], ['kind', 34], ['red', 1], ['tsumogiri', 1], ['local', 15], ['isDora', 1], ['shanten', 8], ['ukeire', 9],
    ['waits', 8], ['waitKinds', 3], ['furiten', 1], ['hasYaku', 1], ['ronVal', 8], ['tsumoVal', 8], ['doraAfter', 5], ['yakuFlags', 4],
    ['danger', 3 * 7], ['unseenK', 5],
  ]);
  const S_BITS = SL.size, A_BITS = AL.size;
  const S_BYTES = Math.ceil(S_BITS / 8), A_BYTES = Math.ceil(A_BITS / 8);
  const T = { discard: 0, riichi: 1, ankan: 2, kakan: 3, kyuushu: 4, pass: 5, chiL: 6, chiM: 7, chiH: 8, pon: 9, minkan: 10 };

  const bucket = (v, edges) => { let i = 0; while (i < edges.length && v > edges[i]) i++; return i; };
  const UKE_E = [0, 4, 8, 12, 16, 20, 28, 40];            // 9
  const WAIT_E = [0, 1, 2, 3, 4, 6, 8];                   // 8
  const VAL_E = [0, 400, 700, 1000, 1600, 2000, 3000];    // 8
  const SCORE_E = [-1, 8000, 16000, 24000, 32000, 40000, 48000, 56000, 64000]; // 10
  const DIFF_E = [-24000, -16000, -12000, -8000, -4000, -2000, 0, 2000, 4000, 8000, 12000, 16000, 24000]; // 14

  // ------------------------------------------------------------------ 見えている情報（席 s から）
  class View {
    constructor() {
      this.unseen = new Int8Array(NK);
      this.safe = [new Uint8Array(NK), new Uint8Array(NK), new Uint8Array(NK)];
      this.c = new Int8Array(NK);
      this.doraK = new Int8Array(NK);
      this.discK = new Uint8Array(NK);
    }
    // 局面から作る（r: Round、s: 席）
    load(r, s) {
      const u = this.unseen, c = this.c;
      u.fill(4); c.fill(0); this.doraK.fill(0); this.discK.fill(0);
      for (const id of r.hands[s]) { c[id >> 2]++; u[id >> 2]--; }
      for (let p = 0; p < 4; p++) {
        for (const d of r.discards[p]) { if (!d.called) u[d.tile >> 2]--; if (p === s) this.discK[d.tile >> 2] = 1; }
        for (const m of r.melds[p]) for (const id of m.tiles) u[id >> 2]--;
      }
      for (const id of r.doraIndicators()) u[id >> 2]--;
      for (let k = 0; k < NK; k++) if (u[k] < 0) u[k] = 0;
      for (const k of r.doraKinds()) this.doraK[k]++;
      // 相手ごとの安全な牌（フリテンの決まりでロンされない牌）: その人の捨て牌・立直のあとに出た牌・その人が最後に切ったあとに出た牌
      for (let i = 1; i < 4; i++) {
        const p = (s + i) % 4, sf = this.safe[i - 1];
        sf.fill(0);
        for (const d of r.discards[p]) sf[d.tile >> 2] = 1;
        const lastN = r.discards[p].length ? r.discards[p][r.discards[p].length - 1].n : -1;
        const since = r.riichi[p] ? Math.min(r.riichiN[p], lastN) : lastN;
        for (let q = 0; q < 4; q++) for (const d of r.discards[q]) if (d.n > since) sf[d.tile >> 2] = 1;
      }
      this.r = r; this.s = s;
      this.nm = r.melds[s].length;
      return this;
    }
  }

  // 手の形の役の手がかり（ルールの条件そのもの）: 役牌の刻子がある・全部が中張牌・1色（字牌は可）・門前
  function yakuFlags(r, s, c, extraMelds) {
    let yakuhai = false, simple = true;
    const suits = new Set();
    const sw = 27 + r.seatWind(s), rw = 27 + r.roundWind;
    const isY = k => k >= 31 || k === sw || k === rw;
    for (let k = 0; k < NK; k++) if (c[k]) {
      if (c[k] >= 3 && isY(k)) yakuhai = true;
      if (isYaochu(k)) simple = false;
      if (k < 27) suits.add(Math.floor(k / 9));
    }
    const melds = extraMelds ? r.melds[s].concat(extraMelds) : r.melds[s];
    let menzen = true;
    for (const m of melds) {
      const k = m.tiles[0] >> 2;
      if (m.type !== 'chi' && isY(k)) yakuhai = true;
      for (const id of m.tiles) { const kk = id >> 2; if (isYaochu(kk)) simple = false; if (kk < 27) suits.add(Math.floor(kk / 9)); }
      if (m.type !== 'ankan') menzen = false;
    }
    return [yakuhai, simple, suits.size <= 1, menzen];
  }

  // 13枚（＋副露）の手の形の値: 向聴数・受け入れ・聴牌なら待ちの枚数・フリテン・和了ったときの点
  //   hand: id の並び（13-3n 枚）、melds: 副露、riichi: 立直したときの点で数えるか
  function handMetrics(v, hand, c, melds, riichi, out) {
    const r = v.r, s = v.s, nm = melds.length;
    const sh = shanten(c, nm);
    out.shanten = sh; out.ukeire = 0; out.waits = 0; out.waitKinds = 0; out.furiten = false; out.hasYaku = false; out.ronVal = 0; out.tsumoVal = 0;
    if (sh > 0) { out.ukeire = MJ.ukeireCount(c, nm, sh, v.unseen); return out; }
    if (sh < 0) return out;
    const ws = waitsOf(c, nm);
    let nW = 0, ronSum = 0, tsSum = 0, yaku = false;
    const dora = r.doraKinds();
    for (const w of ws) {
      if (v.discK[w]) out.furiten = true;
      const n = v.unseen[w];
      nW += n;
      // 和了ったときの点（ドラ込み、裏ドラ・一発は数えない）。赤5の区別はしない
      const winId = w * 4 + 1;
      const base = { concealed: hand.concat([winId]), melds, winTile: winId, seatWind: r.seatWind(s), roundWind: r.roundWind, riichi: riichi ? 1 : 0, dora, ura: [], aka: r.rules.aka > 0, kuitan: r.rules.kuitan };
      const ron = evaluateHand(Object.assign({ tsumo: false }, base));
      const ts = evaluateHand(Object.assign({ tsumo: true }, base));
      if (ron) { yaku = true; ronSum += n * ron.basic; }
      if (ts) tsSum += n * ts.basic;
    }
    out.waits = nW; out.waitKinds = ws.length; out.hasYaku = yaku;
    out.ronVal = nW ? ronSum / nW : 0; out.tsumoVal = nW ? tsSum / nW : 0;
    return out;
  }
  function countDora(r, ids) {
    let n = 0;
    const dk = r.doraKinds();
    for (const id of ids) { for (const d of dk) if (d === (id >> 2)) n++; if (r.isRed(id)) n++; }
    return n;
  }

  // ------------------------------------------------------------------ 局面の特徴
  // 返り値: 立っている特徴の番号の数（idx に書く）。phase: 0 ツモのあと 1 鳴いたあと 2 打牌への返事 3 加槓への返事
  function encodeState(v, phase, idx) {
    const r = v.r, s = v.s;
    let n = 0;
    const set = i => { idx[n++] = i; };
    const c = v.c;
    for (let k = 0; k < NK; k++) for (let t = 0; t < c[k]; t++) set(SL.hand + k * 4 + t);
    for (const id of r.hands[s]) if (r.isRed(id)) set(SL.handRed + Math.floor(id / 36));
    const tmp = new Int8Array(NK);
    for (let i = 0; i < 4; i++) {
      const p = (s + i) % 4;
      tmp.fill(0);
      for (const d of r.discards[p]) tmp[d.tile >> 2]++;
      for (let k = 0; k < NK; k++) for (let t = 0; t < tmp[k] && t < 4; t++) set(SL.disc + i * 136 + k * 4 + t);
      tmp.fill(0);
      for (const m of r.melds[p]) for (const id of m.tiles) tmp[id >> 2]++;
      for (let k = 0; k < NK; k++) for (let t = 0; t < tmp[k] && t < 4; t++) set(SL.meld + i * 136 + k * 4 + t);
      const ds = r.discards[p], L = ds.length;
      const seen = new Uint8Array(NK);
      for (let j = Math.max(0, L - 6); j < L; j++) { const k = ds[j].tile >> 2; if (!seen[k]) { seen[k] = 1; set(SL.recent + i * 34 + k); } if (ds[j].tsumogiri) set(SL.tsumogiri + i * 6 + (L - 1 - j)); }
      // その人の状態
      const b = SL.pstate + i * 20;
      if (r.riichi[p]) set(b); if (r.riichi[p] === 2) set(b + 1);
      if (r.ippatsu[p]) set(b + 2);
      if (r.isMenzen(p)) set(b + 3);
      set(b + 4 + Math.min(4, r.melds[p].length));
      set(b + 9 + Math.min(5, Math.floor(L / 3)));
      if (r.riichi[p]) set(b + 15 + bucket(L - 1 - r.riichiAt[p], [0, 2, 5]));
      if (p === r.dealer) set(b + 19);
    }
    for (let i = 0; i < 3; i++) for (let k = 0; k < NK; k++) if (v.safe[i][k]) set(SL.safe + i * 34 + k);
    for (let k = 0; k < NK; k++) set(SL.unseen + k * 5 + v.unseen[k]);
    for (let k = 0; k < NK; k++) { if (v.doraK[k] >= 1) set(SL.dora + k * 2); if (v.doraK[k] >= 2) set(SL.dora + k * 2 + 1); }
    // 場
    const g = r.gameInfo || { roundIndex: r.roundWind * 4 + r.kyoku, last: 7, tonpu: false };
    const R = SL.round;
    set(R + Math.min(2, r.roundWind));
    set(R + 3 + r.kyoku);
    set(R + 7 + Math.min(3, r.honba));
    set(R + 11 + Math.min(3, r.kyotaku));
    set(R + 15 + Math.min(9, Math.ceil(r.liveLeft / 8)));
    if (g.roundIndex >= g.last) set(R + 25);
    set(R + 26 + Math.max(0, Math.min(8, g.last - g.roundIndex)));
    if (g.tonpu) set(R + 35);
    // 点数・順位・点差
    const sc = r.scores;
    const order = [0, 1, 2, 3].sort((a, b2) => (sc[b2] - sc[a]) || (((a - (g.firstDealer || 0) + 4) % 4) - ((b2 - (g.firstDealer || 0) + 4) % 4)));
    for (let i = 0; i < 4; i++) {
      const p = (s + i) % 4;
      set(SL.score + i * 10 + bucket(sc[p], SCORE_E));
      set(SL.rank + i * 4 + order.indexOf(p));
      if (i) set(SL.diff + (i - 1) * 14 + bucket(sc[s] - sc[p], DIFF_E));
    }
    set(SL.phase + phase);
    set(SL.shanten + Math.min(7, shanten(c, v.nm) + 1));
    set(SL.myDora + Math.min(4, countDora(r, r.hands[s].concat(...r.melds[s].map(m => m.tiles)))));
    const yf = yakuFlags(r, s, c);
    for (let i = 0; i < 4; i++) if (yf[i]) set(SL.yakuFlags + i);
    return n;
  }

  // ------------------------------------------------------------------ 行動の特徴
  // cand: { type: T の値, kind, red, tsumogiri, m: handMetrics の結果, doraAfter, yf: [4], local: kind の周りの自分の枚数 }
  function encodeAction(v, cand, idx) {
    let n = 0;
    const set = i => { idx[n++] = i; };
    set(AL.type + cand.type);
    const k = cand.kind;
    if (k >= 0) {
      set(AL.kind + k);
      if (cand.red) set(AL.red);
      if (cand.tsumogiri) set(AL.tsumogiri);
      // 自分の手のその牌の周り（同じ色の k-2..k+2）の枚数
      for (let o = -2; o <= 2; o++) {
        const kk = k + o;
        if (kk < 0 || kk >= NK || (k < 27 ? Math.floor(kk / 9) !== Math.floor(k / 9) : o !== 0)) continue;
        const cnt = v.c[kk];
        for (let t = 0; t < 3 && t < cnt; t++) set(AL.local + (o + 2) * 3 + t);
      }
      if (v.doraK[k]) set(AL.isDora);
      // 相手ごと: その牌が安全か・同じ色の近くの牌（k±1..3）が安全か
      for (let i = 0; i < 3; i++) {
        const sf = v.safe[i], b = AL.danger + i * 7;
        if (sf[k]) set(b);
        if (k < 27) {
          let j = 1;
          for (const o of [-3, -2, -1, 1, 2, 3]) {
            const kk = k + o;
            if (kk >= 0 && kk < 27 && Math.floor(kk / 9) === Math.floor(k / 9) && sf[kk]) set(b + j);
            j++;
          }
        }
      }
      set(AL.unseenK + v.unseen[k]);
    }
    const m = cand.m;
    if (m) {
      set(AL.shanten + Math.min(7, m.shanten + 1));
      if (m.shanten > 0) set(AL.ukeire + bucket(m.ukeire, UKE_E));
      if (m.shanten === 0) {
        set(AL.waits + bucket(m.waits, WAIT_E));
        set(AL.waitKinds + Math.min(2, Math.max(0, m.waitKinds - 1)));
        if (m.furiten) set(AL.furiten);
        if (m.hasYaku) set(AL.hasYaku);
        set(AL.ronVal + bucket(m.ronVal, VAL_E));
        set(AL.tsumoVal + bucket(m.tsumoVal, VAL_E));
      }
    }
    set(AL.doraAfter + Math.min(4, cand.doraAfter || 0));
    if (cand.yf) for (let i = 0; i < 4; i++) if (cand.yf[i]) set(AL.yakuFlags + i);
    return n;
  }

  // ------------------------------------------------------------------ 候補の行動を並べて、行動ごとの値を計算する
  // 手番: 打牌（種類と赤で1つ）・立直・暗槓・加槓・九種九牌。ツモ和了はいつもする（ここには入れない）
  function turnCandidates(v, acts) {
    const r = v.r, s = v.s, out = [];
    const hand = r.hands[s], c = v.c;
    const metricsByKey = new Map();
    const afterDiscard = (id, riichi) => {
      const key = (id >> 2) * 4 + (r.isRed(id) ? 2 : 0) + (riichi ? 1 : 0);
      if (metricsByKey.has(key)) return metricsByKey.get(key);
      const h2 = hand.slice(); h2.splice(h2.indexOf(id), 1);
      c[id >> 2]--;
      const m = handMetrics(v, h2, c, r.melds[s], riichi, {});
      const yf = yakuFlags(r, s, c);
      c[id >> 2]++;
      const res = { m, yf, doraAfter: countDora(r, h2.concat(...r.melds[s].map(x => x.tiles))) };
      metricsByKey.set(key, res);
      return res;
    };
    for (const a of acts) {
      if (a.t === 'tsumo') continue;
      if (a.t === 'discard') {
        const x = afterDiscard(a.tile, a.riichi);
        out.push({ a, type: a.riichi ? T.riichi : T.discard, kind: a.tile >> 2, red: r.isRed(a.tile), tsumogiri: a.tile === r.drawn, m: x.m, yf: x.yf, doraAfter: x.doraAfter });
      } else if (a.t === 'ankan' || a.t === 'kakan') {
        const k = a.t === 'ankan' ? a.kind : a.tile >> 2;
        const h2 = hand.filter(id => (id >> 2) !== k);
        const removed = hand.length - h2.length;
        c[k] -= removed;
        const melds = r.melds[s].filter(m => !(a.t === 'kakan' && m.type === 'pon' && (m.tiles[0] >> 2) === k)).concat([{ type: a.t, tiles: [k * 4, k * 4 + 1, k * 4 + 2, k * 4 + 3] }]);
        const m = handMetrics(v, h2, c, melds, !!r.riichi[s], {});
        c[k] += removed;
        out.push({ a, type: a.t === 'ankan' ? T.ankan : T.kakan, kind: k, m, doraAfter: countDora(r, hand) });
      } else if (a.t === 'kyuushu') out.push({ a, type: T.kyuushu, kind: -1 });
    }
    return out;
  }
  // 返事: 見送り・ポン・チー・明槓（ロンはいつもする）
  function reactCandidates(v, opts, tile) {
    const r = v.r, s = v.s, out = [];
    const hand = r.hands[s], c = v.c, k = tile >> 2;
    const pm = handMetrics(v, hand, c, r.melds[s], false, {});
    out.push({ a: null, type: T.pass, kind: k, m: pm, yf: yakuFlags(r, s, c), doraAfter: countDora(r, hand.concat(...r.melds[s].map(x => x.tiles))) });
    for (const a of opts) {
      if (a.t === 'ron') continue;
      let use, type;
      if (a.t === 'minkan') { use = hand.filter(id => (id >> 2) === k); type = T.minkan; }
      else {
        use = a.use;
        if (a.t === 'pon') type = T.pon;
        else { const ks = use.map(x => x >> 2); type = k < Math.min(...ks) ? T.chiL : k > Math.max(...ks) ? T.chiH : T.chiM; }
      }
      const h2 = hand.filter(id => !use.includes(id));
      for (const id of use) c[id >> 2]--;
      const meld = { type: a.t === 'minkan' ? 'minkan' : a.t, tiles: use.concat([tile]) };
      const melds = r.melds[s].concat([meld]);
      let best = null;
      if (a.t === 'minkan') best = handMetrics(v, h2, c, melds, false, {});
      else {
        // 鳴いたあとに切る牌のうち、向聴数が小さく受け入れが多いもの（喰い替えの牌は除く）
        const forb = r.kuikaeKinds(a.t, k, use.map(x => x >> 2));
        const tried = new Set();
        for (const id of h2) {
          const kk = id >> 2;
          if (forb.includes(kk) || tried.has(kk)) continue;
          tried.add(kk);
          const h3 = h2.slice(); h3.splice(h3.indexOf(id), 1);
          c[kk]--;
          const m = handMetrics(v, h3, c, melds, false, {});
          c[kk]++;
          if (!best || m.shanten < best.shanten || (m.shanten === best.shanten && (m.shanten > 0 ? m.ukeire > best.ukeire : (m.hasYaku && !best.hasYaku) || (m.hasYaku === best.hasYaku && m.waits > best.waits)))) best = m;
        }
      }
      const yf = yakuFlags(r, s, c, [meld]);
      for (const id of use) c[id >> 2]++;
      out.push({ a, type, kind: k, red: use.some(id => r.isRed(id)), m: best, yf, doraAfter: countDora(r, hand.concat(tile, ...r.melds[s].map(x => x.tiles))) });
    }
    return out;
  }

  // ------------------------------------------------------------------ ネット
  // WebAssembly SIMD の部品（js/nn-simd.js。なければ JS で計算）
  const SIMD = (() => {
    if (typeof MJSIMD !== 'undefined') return MJSIMD;
    try { return typeof require === 'function' ? require('./nn-simd.js') : null; } catch (e) { return null; }
  })();
  // 重みと作業の場所を SIMD のメモリの中に並べる（浮動小数の番号。4 の倍数にそろえる）
  function simdLayout(h1, h2, h3, extra) {
    const L = {};
    let off = 0;
    const alloc = (k, n) => { L[k] = off; off += Math.ceil(n / 4) * 4; };
    for (const [k, n] of paramSizes(h1, h2, h3)) alloc(k, n);
    for (const [k, n] of extra) alloc(k, n);
    L.size = off;
    return L;
  }
  class Net {
    // p: { h1, h2, h3, W1(S_BITS*h1), b1, W2(h1*h2), b2, Wa(A_BITS*h2), ba, W3(h2*h3), b3, W4(h3*2), b4 }（Float32Array。学習中は共有メモリのまま）
    // o.simd === false なら JS だけで計算。SIMD のときは重みを写して使うので、p が変わったら refresh() を呼ぶ
    constructor(p, o = {}) {
      this.p = p;
      this.h1 = p.h1; this.h2 = p.h2; this.h3 = p.h3;
      this.t1 = new Float32Array(p.h1); this.t2 = new Float32Array(p.h2); this.z = new Float32Array(p.h2); this.h3v = new Float32Array(p.h3);
      this.out = new Float32Array(2);
      this.k = null;
      if (o.simd !== false && SIMD && p.h1 % 4 === 0 && p.h2 % 4 === 0 && p.h3 % 4 === 0) {
        const L = simdLayout(p.h1, p.h2, p.h3, [['t1', p.h1], ['t2', p.h2], ['z', p.h2], ['h3', p.h3], ['idx', S_BITS]]);
        const k = SIMD.create(L.size * 4 + 64);
        if (k) {
          this.k = k; this.L = L; this.F = new Float32Array(k.memory.buffer); this.I = new Int32Array(k.memory.buffer);
          this.refresh();
        }
      }
    }
    refresh() { if (!this.k) return; for (const [k] of paramSizes(this.h1, this.h2, this.h3)) this.F.set(this.p[k], this.L[k]); }
    // 局面の部分（t2）
    trunk(sIdx, ns) {
      if (this.k) {
        const { F, I, L, k } = this, H1 = this.h1, H2 = this.h2;
        for (let q = 0; q < ns; q++) I[L.idx + q] = sIdx[q];
        F.copyWithin(L.t1, L.b1, L.b1 + H1);
        k.rows(L.idx * 4, ns, L.W1 * 4, H1, L.t1 * 4);
        for (let j = L.t1, e = L.t1 + H1; j < e; j++) if (F[j] < 0) F[j] = 0;
        F.copyWithin(L.t2, L.b2, L.b2 + H2);
        k.layer(L.t1 * 4, H1, L.W2 * 4, H2, L.t2 * 4);
        for (let j = L.t2, e = L.t2 + H2; j < e; j++) if (F[j] < 0) F[j] = 0;
        return;
      }
      const { W1, b1, W2, b2 } = this.p, H1 = this.h1, H2 = this.h2, t1 = this.t1, t2 = this.t2;
      t1.set(b1);
      for (let q = 0; q < ns; q++) { const o = sIdx[q] * H1; for (let j = 0; j < H1; j++) t1[j] += W1[o + j]; }
      for (let j = 0; j < H1; j++) if (t1[j] < 0) t1[j] = 0;
      t2.set(b2);
      for (let i = 0; i < H1; i++) { const x = t1[i]; if (!x) continue; const o = i * H2; for (let j = 0; j < H2; j++) t2[j] += x * W2[o + j]; }
      for (let j = 0; j < H2; j++) if (t2[j] < 0) t2[j] = 0;
    }
    // 行動の部分（trunk のあとで）。out[0] を返す
    head(aIdx, na) {
      if (this.k) {
        const { F, I, L, k } = this, H2 = this.h2, H3 = this.h3;
        for (let j = 0; j < H2; j++) F[L.z + j] = F[L.t2 + j] + F[L.ba + j];
        for (let q = 0; q < na; q++) I[L.idx + q] = aIdx[q];
        k.rows(L.idx * 4, na, L.Wa * 4, H2, L.z * 4);
        for (let j = L.z, e = L.z + H2; j < e; j++) if (F[j] < 0) F[j] = 0;
        F.copyWithin(L.h3, L.b3, L.b3 + H3);
        k.layer(L.z * 4, H2, L.W3 * 4, H3, L.h3 * 4);
        let o0 = F[L.b4], o1 = F[L.b4 + 1];
        for (let i = 0; i < H3; i++) { let x = F[L.h3 + i]; if (x < 0) x = 0; o0 += x * F[L.W4 + i * 2]; o1 += x * F[L.W4 + i * 2 + 1]; }
        this.out[0] = o0; this.out[1] = o1;
        return o0;
      }
      const { Wa, ba, W3, b3, W4, b4 } = this.p, H2 = this.h2, H3 = this.h3, z = this.z, h3 = this.h3v, t2 = this.t2;
      for (let j = 0; j < H2; j++) z[j] = t2[j] + ba[j];
      for (let q = 0; q < na; q++) { const o = aIdx[q] * H2; for (let j = 0; j < H2; j++) z[j] += Wa[o + j]; }
      for (let j = 0; j < H2; j++) if (z[j] < 0) z[j] = 0;
      h3.set(b3);
      for (let i = 0; i < H2; i++) { const x = z[i]; if (!x) continue; const o = i * H3; for (let j = 0; j < H3; j++) h3[j] += x * W3[o + j]; }
      let o0 = b4[0], o1 = b4[1];
      for (let i = 0; i < H3; i++) { let x = h3[i]; if (x < 0) x = 0; h3[i] = x; o0 += x * W4[i * 2]; o1 += x * W4[i * 2 + 1]; }
      this.out[0] = o0; this.out[1] = o1;
      return o0;
    }
  }
  function paramSizes(h1, h2, h3) {
    return [['W1', S_BITS * h1], ['b1', h1], ['W2', h1 * h2], ['b2', h2], ['Wa', A_BITS * h2], ['ba', h2], ['W3', h2 * h3], ['b3', h3], ['W4', h3 * 2], ['b4', 2]];
  }
  // 1つの Float32Array（共有メモリでもよい）を切り分けてネットの重みにする
  function viewParams(buf, h1, h2, h3, offset = 0) {
    const p = { h1, h2, h3 };
    let o = offset;
    for (const [k, n] of paramSizes(h1, h2, h3)) { p[k] = buf.subarray(o, o + n); o += n; }
    p.total = o - offset;
    return p;
  }
  function paramCount(h1, h2, h3) { return paramSizes(h1, h2, h3).reduce((a, x) => a + x[1], 0); }
  function initParams(p, rng) {
    const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rng(); return (u - 3) / Math.sqrt(0.5); };
    const fill = (W, fanIn, scale = 1) => { const sd = scale * Math.sqrt(2 / fanIn); for (let i = 0; i < W.length; i++) W[i] = g() * sd; };
    fill(p.W1, 260); fill(p.W2, p.h1); fill(p.Wa, 30, 0.5); fill(p.W3, p.h2); fill(p.W4, p.h3, 0.1);
    p.b1.fill(0); p.b2.fill(0); p.ba.fill(0); p.b3.fill(0); p.b4.fill(0);
  }

  // ------------------------------------------------------------------ CPU
  // 牌効率だけ（基準の AI）: 向聴数が一番小さく、受け入れの枚数が一番多い牌を切る。鳴かない・守らない・聴牌したらすぐ立直
  class EfficiencyAgent {
    constructor(rng) { this.rng = rng || Math.random; this.v = new View(); this.name = '牌効率だけ'; }
    chooseTurn(r) {
      const acts = r.turnActions();
      const ts = acts.find(a => a.t === 'tsumo');
      if (ts) return ts;
      const v = this.v.load(r, r.cur);
      let best = null, bestKey = null;
      for (const a of acts) {
        if (a.t !== 'discard') continue;
        const id = a.tile, k = id >> 2;
        v.c[k]--;
        const sh = shanten(v.c, v.nm);
        const uke = MJ.ukeireCount(v.c, v.nm, sh, v.unseen);
        v.c[k]++;
        const key = [sh, -uke, a.riichi ? 0 : 1, r.isRed(id) ? 1 : 0, this.rng()];
        if (!best || less(key, bestKey)) { best = a; bestKey = key; }
      }
      return best;
    }
    chooseReact(r, s) {
      const o = r.react.options[s];
      return (o && o.find(a => a.t === 'ron')) || null;
    }
  }
  function less(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; }

  // 学んだネットの AI。temp > 0 なら値の差に応じてゆらぐ（exp((q − 最大) / temp) に比例して選ぶ）
  class NetAgent {
    constructor(net, o = {}) {
      this.net = net; this.temp = o.temp || 0; this.eps = o.eps || 0; this.rng = o.rng || Math.random;
      this.epsType = o.epsType || 0; // 学習のとき: この割合で「一番よい手と違う種類（立直か黙聴か・鳴くか見送るか）」の一番よい手を試す
      this.v = new View();
      this.sIdx = new Uint16Array(S_BITS); this.aIdx = new Uint16Array(A_BITS);
      this.name = o.name || 'ネット';
      this.record = null; // 学習のとき: (席, sIdx, ns, aIdx, na, 選んだ候補, 一番よい候補, 候補の全部) を受け取る関数
    }
    evalCands(r, s, phase, cands) {
      const v = this.v;
      const ns = encodeState(v, phase, this.sIdx);
      this.ns = ns;
      this.net.trunk(this.sIdx, ns);
      for (const cd of cands) {
        const na = encodeAction(v, cd, this.aIdx);
        cd.q = this.net.head(this.aIdx, na);
        cd.q2 = this.net.out[1];
      }
      return ns;
    }
    pick(cands) {
      let best = cands[0];
      for (const c of cands) if (c.q > best.q) best = c;
      this.best = best; // 学習のとき: 選んだのが探索の手でも、この局面の値は一番よい候補の値
      if (cands.length === 1) return best;
      if (this.eps && this.rng() < this.eps) return cands[Math.floor(this.rng() * cands.length)];
      if (this.epsType && this.rng() < this.epsType) {
        const kind = t => (t === 0 ? 0 : t === 1 ? 1 : t <= 3 ? 2 : t === 4 ? 3 : t === 5 ? 4 : 5);
        let alt = null;
        for (const c of cands) if (kind(c.type) !== kind(best.type) && (!alt || c.q > alt.q)) alt = c;
        if (alt) return alt;
      }
      if (!this.temp) return best;
      let tot = 0;
      for (const c of cands) { c.w = Math.exp((c.q - best.q) / this.temp); tot += c.w; }
      let x = this.rng() * tot;
      for (const c of cands) { x -= c.w; if (x <= 0) return c; }
      return best;
    }
    chooseTurn(r) {
      const acts = r.turnActions();
      const ts = acts.find(a => a.t === 'tsumo');
      if (ts) return ts;
      const s = r.cur, v = this.v.load(r, s);
      const cands = turnCandidates(v, acts);
      if (cands.length === 1) return cands[0].a;
      const phase = r.drawn >= 0 ? 0 : 1;
      this.evalCands(r, s, phase, cands);
      const c = this.pick(cands);
      if (this.record) this.recordChoice(r, s, phase, c, cands);
      return c.a;
    }
    chooseReact(r, s) {
      const o = r.react.options[s];
      if (!o) return null;
      const ron = o.find(a => a.t === 'ron');
      if (ron) return ron;
      const v = this.v.load(r, s);
      const cands = reactCandidates(v, o, r.react.tile);
      if (cands.length === 1) return null;
      const phase = r.react.kind === 'discard' ? 2 : 3;
      this.evalCands(r, s, phase, cands);
      const c = this.pick(cands);
      if (this.record) this.recordChoice(r, s, phase, c, cands);
      return c.a;
    }
    recordChoice(r, s, phase, c, cands) {
      const na = encodeAction(this.v, c, this.aIdx);
      this.record(s, this.sIdx, this.ns, this.aIdx, na, c, this.best, cands);
    }
  }

  // AI補助: 手番の候補ごとの値（ネットがなければ牌効率の数字だけ）と、向聴数・受け入れ・待ち
  function analyzeTurn(r, s, net) {
    const v = new View().load(r, s);
    const acts = r.turnActions();
    const cands = turnCandidates(v, acts);
    if (net && cands.length) {
      const ag = new NetAgent(net);
      ag.v = v;
      ag.evalCands(r, s, r.drawn >= 0 ? 0 : 1, cands);
    }
    return { cands, tsumo: acts.some(a => a.t === 'tsumo'), unseen: v.unseen.slice() };
  }
  function analyzeReact(r, s, net) {
    const o = r.react && r.react.options[s];
    if (!o) return null;
    const v = new View().load(r, s);
    const cands = reactCandidates(v, o, r.react.tile);
    if (net) { const ag = new NetAgent(net); ag.v = v; ag.evalCands(r, s, r.react.kind === 'discard' ? 2 : 3, cands); }
    return { cands, ron: o.some(a => a.t === 'ron') };
  }
  // 13枚の手の待ちと残り枚数（画面の表示用）
  function waitInfo(r, s) {
    const v = new View().load(r, s);
    const ws = waitsOf(v.c, v.nm);
    return ws.map(k => ({ kind: k, left: v.unseen[k] }));
  }

  // ------------------------------------------------------------------ ネットの読み書き（学習した重みを int8 にしてブラウザへ）
  // 書き出しの形: { h1, h2, h3, layers: { name: { scale, data(base64 の int8) } }, meta }
  function quantize(p) {
    const out = { h1: p.h1, h2: p.h2, h3: p.h3, layers: {} };
    for (const [k] of paramSizes(p.h1, p.h2, p.h3)) {
      const a = p[k];
      // 行（出力の並び）ごとではなく層ごとの1つの倍率（W1 だけは行ごと: 特徴ごとに大きさが違うため）
      if (k === 'W1' || k === 'Wa') {
        const H = k === 'W1' ? p.h1 : p.h2, rows = a.length / H;
        const sc = new Float32Array(rows), q = new Int8Array(a.length);
        for (let i = 0; i < rows; i++) {
          let m = 0;
          for (let j = 0; j < H; j++) m = Math.max(m, Math.abs(a[i * H + j]));
          sc[i] = m / 127 || 1e-8;
          for (let j = 0; j < H; j++) q[i * H + j] = Math.round(a[i * H + j] / sc[i]);
        }
        out.layers[k] = { rowScale: Array.from(sc, x => +x.toPrecision(5)), q };
      } else if (k[0] === 'b') out.layers[k] = { f: Array.from(a, x => +x.toPrecision(6)) };
      else {
        let m = 0;
        for (const x of a) m = Math.max(m, Math.abs(x));
        const sc = m / 127 || 1e-8, q = new Int8Array(a.length);
        for (let i = 0; i < a.length; i++) q[i] = Math.round(a[i] / sc);
        out.layers[k] = { scale: sc, q };
      }
    }
    return out;
  }
  function dequantize(Q) {
    const p = viewParams(new Float32Array(paramCount(Q.h1, Q.h2, Q.h3)), Q.h1, Q.h2, Q.h3);
    for (const [k] of paramSizes(Q.h1, Q.h2, Q.h3)) {
      const L = Q.layers[k], a = p[k];
      if (L.f) a.set(L.f);
      else if (L.rowScale) { const H = a.length / L.rowScale.length; for (let i = 0; i < a.length; i++) a[i] = L.q[i] * L.rowScale[Math.floor(i / H)]; }
      else for (let i = 0; i < a.length; i++) a[i] = L.q[i] * L.scale;
    }
    return p;
  }

  // ------------------------------------------------------------------ 対局の価値のネット V（局の始めの点数の状況 → 最終の順位点の見込み ÷ 50）
  const VD = 27, VH = 64;
  function vSizes() { return [['W1', VD * VH], ['b1', VH], ['W2', VH * VH], ['b2', VH], ['W3', VH], ['b3', 1]]; }
  function vCount() { return vSizes().reduce((a, x) => a + x[1], 0); }
  function vView(buf) { const p = {}; let o = 0; for (const [k, n] of vSizes()) { p[k] = buf.subarray(o, o + n); o += n; } return p; }
  // 半荘の状況（局の始め）を席 s から見た特徴（g は MJ.Game）
  function vFeatures(g, s, out) {
    out.fill(0);
    const left = Math.max(0, Math.min(8, g.lastRoundIndex - g.roundIndex));
    out[left] = 1;
    out[9] = g.rules.length === 'tonpu' ? 1 : 0;
    out[10 + ((g.kyoku - s + 4) % 4)] = 1;
    out[14] = Math.min(5, g.honba) / 5;
    out[15] = Math.min(4, g.kyotaku) / 4;
    for (let i = 0; i < 4; i++) out[16 + i] = (g.scores[(s + i) % 4] - 25000) / 25000;
    out[20 + g.rankOf(s)] = 1;
    for (let i = 1; i < 4; i++) out[23 + i] = (g.scores[s] - g.scores[(s + i) % 4]) / 10000;
    return out;
  }
  function vForward(p, x, act) {
    const h1 = act ? act.h1 : new Float32Array(VH), h2 = act ? act.h2 : new Float32Array(VH);
    for (let j = 0; j < VH; j++) h1[j] = p.b1[j];
    for (let i = 0; i < VD; i++) { const v = x[i]; if (!v) continue; for (let j = 0; j < VH; j++) h1[j] += v * p.W1[i * VH + j]; }
    for (let j = 0; j < VH; j++) if (h1[j] < 0) h1[j] = 0;
    for (let j = 0; j < VH; j++) h2[j] = p.b2[j];
    for (let i = 0; i < VH; i++) { const v = h1[i]; if (!v) continue; for (let j = 0; j < VH; j++) h2[j] += v * p.W2[i * VH + j]; }
    let o = p.b3[0];
    for (let j = 0; j < VH; j++) { if (h2[j] < 0) h2[j] = 0; o += h2[j] * p.W3[j]; }
    return o;
  }
  // 局が終わったあとの、席 s から見た半荘の価値（終われば実際の順位点 ÷ 50、続くなら V）。r は終わった局、ctx は局の始めの半荘の状況
  function roundValue(r, s, ctx, vp, tmp) {
    const g = new MJ.Game(ctx.rules, 1);
    Object.assign(g, { scores: ctx.scores.slice(), roundWind: ctx.roundWind, kyoku: ctx.kyoku, honba: ctx.honba, kyotaku: ctx.kyotaku });
    g.round = r;
    r.scoresBefore = ctx.scores;
    g.finishRound();
    if (g.ended) return g.final[s].point / 50;
    if (!vp) { const order = g.rankOrder(), rk = order.indexOf(s), ru = g.rules; return ((g.scores[s] - ru.returnPoints) / 1000 + ru.uma[rk] + (rk === 0 ? (ru.returnPoints - ru.startPoints) * 4 / 1000 : 0)) / 50; }
    return vForward(vp, vFeatures(g, s, tmp || new Float32Array(VD)));
  }

  // ------------------------------------------------------------------ 先読み（最強の候補）: 見えない牌をでたらめに決めた「ありうる世界」で最後まで打ってみる
  // 見えない牌（相手の手牌・山・王牌の見えていない所）を、見えていない牌から配り直した写しを作る。立直した人は必ず聴牌（ルールでそう決まっているので）
  function determinize(r, s, rng) {
    const c = r.clone();
    const seen = new Uint8Array(136);
    for (const id of r.hands[s]) seen[id] = 1;
    for (let p = 0; p < 4; p++) { for (const d of r.discards[p]) seen[d.tile] = 1; for (const m of r.melds[p]) for (const id of m.tiles) seen[id] = 1; }
    for (let i = 0; i < r.doraCount; i++) seen[r.wall[126 + i]] = 1;
    const pool = [];
    for (let i = 0; i < 136; i++) if (!seen[i]) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    for (let p = 0; p < 4; p++) {
      if (p === s) continue;
      const n = r.hands[p].length;
      let hand = null;
      if (r.riichi[p] && r.melds[p].every(m => m.type === 'ankan')) hand = tenpaiFrom(pool, n, r.melds[p].length, rng, r.discards[p]);
      if (!hand) hand = pool.splice(0, n);
      c.hands[p] = hand;
      c.counts[p] = MJ.countsOf(hand);
      if (n % 3 === 1) c.waits[p] = MJ.waitsOf(c.counts[p], c.melds[p].length);
    }
    // 山: ツモれる所・嶺上・見えていないドラ表示牌と裏ドラ
    const fill = pos => { c.wall[pos] = pool.pop(); };
    for (let i = r.livePos; i < r.liveEnd; i++) fill(i);
    for (let i = MJ.DEAD + r.rinshanUsed; i < MJ.DEAD + 4; i++) fill(i);
    for (let i = 126 + r.doraCount; i < 136; i++) fill(i);
    c.external = false; c.hidden = [false, false, false, false];
    return c;
  }
  // 見えていない牌から、フリテンでない聴牌の手（n 枚）を組み立てる（だめなら null）
  function tenpaiFrom(pool, n, nMelds, rng, discards) {
    const dk = new Set(discards.map(d => d.tile >> 2));
    const sets = (n + 1 - 2) / 3;
    for (let tries = 0; tries < 30; tries++) {
      const cnt = new Int8Array(34);
      for (const id of pool) cnt[id >> 2]++;
      const kinds = [];
      let ok = true;
      for (let m = 0; m < sets && ok; m++) {
        let done = false;
        for (let t = 0; t < 20 && !done; t++) {
          const k = Math.floor(rng() * 34);
          if (k < 27 && k % 9 <= 6 && rng() < 0.6 && cnt[k] > 0 && cnt[k + 1] > 0 && cnt[k + 2] > 0) { cnt[k]--; cnt[k + 1]--; cnt[k + 2]--; kinds.push(k, k + 1, k + 2); done = true; }
          else if (cnt[k] >= 3) { cnt[k] -= 3; kinds.push(k, k, k); done = true; }
        }
        ok = done;
      }
      if (!ok) continue;
      let pk = -1;
      for (let t = 0; t < 20; t++) { const k = Math.floor(rng() * 34); if (cnt[k] >= 2) { pk = k; break; } }
      if (pk < 0) continue;
      kinds.push(pk, pk);
      kinds.splice(Math.floor(rng() * kinds.length), 1); // 1枚抜いて聴牌に
      const c = new Int8Array(34);
      for (const k of kinds) c[k]++;
      const ws = MJ.waitsOf(c, nMelds);
      if (!ws.length || ws.some(k => dk.has(k))) continue;
      // 牌を山の候補から取り出す
      const hand = [];
      for (const k of kinds) { const i = pool.findIndex(id => (id >> 2) === k); hand.push(pool[i]); pool.splice(i, 1); }
      return hand;
    }
    return null;
  }
  class SearchAgent {
    // vp: V のネットの重み（なければ「いま終わったときの順位点」）。o: { samples, k, margin, rng, ms（考える時間の上限） }
    constructor(net, vp, o = {}) {
      this.net = net; this.vp = vp; this.rng = o.rng || Math.random;
      this.samples = o.samples || 12; this.k = o.k || 3; this.margin = o.margin == null ? 0.03 : o.margin; this.ms = o.ms || 0;
      this.base = new NetAgent(net, { rng: this.rng });
      this.play = [0, 1, 2, 3].map(() => new NetAgent(net, { rng: this.rng }));
      this.name = o.name || '最強';
      this.tmp = new Float32Array(VD);
      this.stats = { searched: 0, changed: 0 };
    }
    chooseReact(r, s) { return this.base.chooseReact(r, s); }
    chooseTurn(r) {
      const acts = r.turnActions();
      const ts = acts.find(a => a.t === 'tsumo');
      if (ts) return ts;
      const s = r.cur, v = this.base.v.load(r, s);
      const cands = turnCandidates(v, acts);
      if (cands.length === 1) return cands[0].a;
      this.base.evalCands(r, s, r.drawn >= 0 ? 0 : 1, cands);
      cands.sort((a, b) => b.q - a.q);
      const top = cands.filter(c => c.q >= cands[0].q - this.margin).slice(0, this.k);
      if (top.length < 2) return cands[0].a;
      this.stats.searched++;
      const ctx = { rules: r.rules, scores: (r.scoresBefore || r.scores).slice(), roundWind: r.roundWind, kyoku: r.kyoku, honba: r.honba, kyotaku: r.kyotakuStart != null ? r.kyotakuStart : r.kyotaku };
      const t0 = Date.now();
      const sum = top.map(() => 0);
      let n = 0;
      for (let i = 0; i < this.samples; i++) {
        const w = determinize(r, s, this.rng);
        for (let j = 0; j < top.length; j++) {
          const c = w.clone();
          try { c.doTurn(top[j].a); playOut(c, this.play); sum[j] += roundValue(c, s, ctx, this.vp, this.tmp); } catch (e) { sum[j] += top[j].q; }
        }
        n++;
        if (this.ms && Date.now() - t0 > this.ms) break;
      }
      // 先読みの平均 ＋ ネットの値を少し（見積もりのぶれを均す）
      let best = 0, bv = -1e9;
      for (let j = 0; j < top.length; j++) { const val = sum[j] / n + 0.25 * top[j].q; if (val > bv) { bv = val; best = j; } }
      if (best !== 0) this.stats.changed++;
      return top[best].a;
    }
  }
  // 浅い先読み（最強の候補 その2）: 候補ごとに、見えない牌を決め直した世界で「自分の次の判断（手番・鳴きの返事）か局の終わり」まで
  // ネットどうしで進め、そこでのネットの一番よい値（局が終わっていれば局のあとの値）を平均する。最後まで打つ先読みよりずっと軽く、ぶれも小さい
  class LookaheadAgent {
    // o: { samples（ありうる世界の数）, k（くらべる候補の数）, margin（一番よい候補からこれ以内の値の候補だけ）, rng, ms（考える時間の上限） }
    constructor(net, vp, o = {}) {
      this.net = net; this.vp = vp; this.rng = o.rng || Math.random;
      this.samples = o.samples || 32; this.k = o.k || 4; this.margin = o.margin == null ? 0.05 : o.margin; this.ms = o.ms || 0;
      this.base = new NetAgent(net, { rng: this.rng });
      this.play = [0, 1, 2, 3].map(() => new NetAgent(net, { rng: this.rng }));
      this.eva = new NetAgent(net, { rng: this.rng });
      this.name = o.name || '最強';
      this.tmp = new Float32Array(VD);
      this.stats = { searched: 0, changed: 0 };
    }
    chooseReact(r, s) { return this.base.chooseReact(r, s); }
    chooseTurn(r) {
      const acts = r.turnActions();
      const ts = acts.find(a => a.t === 'tsumo');
      if (ts) return ts;
      const s = r.cur, v = this.base.v.load(r, s);
      const cands = turnCandidates(v, acts);
      if (cands.length === 1) return cands[0].a;
      this.base.evalCands(r, s, r.drawn >= 0 ? 0 : 1, cands);
      cands.sort((a, b) => b.q - a.q);
      const top = cands.filter(c => c.q >= cands[0].q - this.margin).slice(0, this.k);
      if (top.length < 2) return cands[0].a;
      this.stats.searched++;
      const ctx = { rules: r.rules, scores: (r.scoresBefore || r.scores).slice(), roundWind: r.roundWind, kyoku: r.kyoku, honba: r.honba, kyotaku: r.kyotakuStart != null ? r.kyotakuStart : r.kyotaku };
      const t0 = Date.now();
      const sum = top.map(() => 0);
      let n = 0;
      for (let i = 0; i < this.samples; i++) {
        const w = determinize(r, s, this.rng);
        for (let j = 0; j < top.length; j++) {
          const c = w.clone();
          try { c.doTurn(top[j].a); sum[j] += this.until(c, s, ctx); } catch (e) { sum[j] += top[j].q; }
        }
        n++;
        if (this.ms && Date.now() - t0 > this.ms) break;
      }
      let best = 0;
      for (let j = 1; j < top.length; j++) if (sum[j] > sum[best]) best = j;
      if (best !== 0) this.stats.changed++;
      return top[best].a;
    }
    // 自分の次の判断か局の終わりまで進めて、その時点の値
    until(c, s, ctx) {
      let guard = 0;
      while (c.phase !== 'end' && guard++ < 400) {
        if (c.phase === 'turn') {
          if (c.cur === s) {
            const acts = c.turnActions();
            const ts = acts.find(a => a.t === 'tsumo');
            if (ts) { c.doTurn(ts); continue; }
            const v = this.eva.v.load(c, s);
            const cands = turnCandidates(v, acts);
            this.eva.evalCands(c, s, c.drawn >= 0 ? 0 : 1, cands);
            let m = -1e9; for (const x of cands) if (x.q > m) m = x.q;
            return m;
          }
          c.doTurn(this.play[c.cur].chooseTurn(c));
        } else {
          const o = c.react.options;
          if (o[s] && !o[s].some(a => a.t === 'ron')) {
            const v = this.eva.v.load(c, s);
            const cands = reactCandidates(v, o[s], c.react.tile);
            this.eva.evalCands(c, s, c.react.kind === 'discard' ? 2 : 3, cands);
            let m = -1e9; for (const x of cands) if (x.q > m) m = x.q;
            return m;
          }
          const resp = [null, null, null, null];
          for (let p = 0; p < 4; p++) if (o[p]) resp[p] = this.play[p].chooseReact(c, p);
          c.doReact(resp);
        }
      }
      return roundValue(c, s, ctx, this.vp, this.tmp);
    }
  }
  function playOut(r, agents) {
    let guard = 0;
    while (r.phase !== 'end' && guard++ < 1000) {
      if (r.phase === 'turn') r.doTurn(agents[r.cur].chooseTurn(r));
      else { const resp = [null, null, null, null]; for (let p = 0; p < 4; p++) if (r.react.options[p]) resp[p] = agents[p].chooseReact(r, p); r.doReact(resp); }
    }
  }

  // ブラウザに入れる形（js/weights.js）: 8 ビットの整数を base64 で。W1・Wa は行ごとの倍率、ほかは層ごとの倍率、バイアスは 32 ビットのまま
  const b64enc = u8 => (typeof Buffer !== 'undefined' ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64') : btoa(Array.from(u8, c => String.fromCharCode(c)).join('')));
  const b64dec = s => {
    if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  function packWeights(p, meta, vbuf) {
    const Q = quantize(p), out = { h: [p.h1, p.h2, p.h3], sBits: S_BITS, aBits: A_BITS, meta: meta || {}, layers: {} };
    if (vbuf) out.v = b64enc(new Uint8Array(Float32Array.from(vbuf).buffer));
    for (const k in Q.layers) {
      const L = Q.layers[k];
      if (L.f) out.layers[k] = { f: b64enc(new Uint8Array(Float32Array.from(L.f).buffer)) };
      else if (L.rowScale) out.layers[k] = { q: b64enc(new Uint8Array(L.q.buffer)), rs: b64enc(new Uint8Array(Float32Array.from(L.rowScale).buffer)) };
      else out.layers[k] = { q: b64enc(new Uint8Array(L.q.buffer)), s: L.scale };
    }
    return out;
  }
  function unpackWeights(o) {
    if (o.sBits !== S_BITS || o.aBits !== A_BITS) throw new Error('ネットの特徴の数が違います（特徴を変えたら書き出し直す）');
    const [h1, h2, h3] = o.h;
    const p = viewParams(new Float32Array(paramCount(h1, h2, h3)), h1, h2, h3);
    const f32 = s => { const u = b64dec(s); return new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)); };
    const i8 = s => { const u = b64dec(s); return new Int8Array(u.buffer, u.byteOffset, u.byteLength); };
    for (const [k] of paramSizes(h1, h2, h3)) {
      const L = o.layers[k], a = p[k];
      if (L.f) a.set(f32(L.f));
      else if (L.rs) { const q = i8(L.q), rs = f32(L.rs), H = a.length / rs.length; for (let i = 0; i < a.length; i++) a[i] = q[i] * rs[(i / H) | 0]; }
      else { const q = i8(L.q); for (let i = 0; i < a.length; i++) a[i] = q[i] * L.s; }
    }
    return p;
  }

  function unpackV(o) {
    if (!o.v) return null;
    const u = b64dec(o.v), f = new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
    return f.length === vCount() ? vView(f) : null;
  }

  return {
    SL, AL, S_BITS, A_BITS, S_BYTES, A_BYTES, T, packWeights, unpackWeights, unpackV,
    VD, VH, vSizes, vCount, vView, vFeatures, vForward, roundValue, determinize, SearchAgent, LookaheadAgent, playOut,
    View, encodeState, encodeAction, handMetrics, turnCandidates, reactCandidates, yakuFlags,
    Net, paramSizes, viewParams, paramCount, initParams, quantize, dequantize, SIMD, simdLayout,
    EfficiencyAgent, NetAgent, analyzeTurn, analyzeReact, waitInfo,
  };
});
