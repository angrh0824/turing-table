/* 大富豪（大貧民）のルール: 札・出せる手の生成・場の進行・あがりと階級・ゲーム間のカード交換
 * ブラウザ・Web Worker・Node（学習とテスト）で同じものを使う
 *
 * 札の番号: 0..51 = マーク*13 + 強さ（0 = 3, 1 = 4, …, 8 = J, 9 = Q, 10 = K, 11 = A, 12 = 2）、52・53 = ジョーカー
 * マーク: 0 ♠ 1 ♥ 2 ♦ 3 ♣
 * 席: 0..3。手番は 0 → 1 → 2 → 3 → 0（画面では 自分 → 右 → 上 → 左）
 *
 * 手（move）: { k: 種類, cards: [札], n: 枚数, r: 強さ, s: マークの集合, jk: ジョーカーの枚数 }
 *   PASS  パス
 *   GROUP 同じ数の 1〜6 枚（単騎・ペア・3枚・4枚…）。r はその数（ジョーカーだけの手は 13 = いちばん強い。数しばり中は求められる数）
 *   SEQ   階段（同じマークで 3 枚以上の連番）。r はいちばん下の数、s はそのマーク
 *   PICK  札を1枚えらぶ（交換で渡す・7渡し・10捨て）
 *   XFER  決まりで札が移る（交換で貧民側が強い札を渡す）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DFCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PASS = 0, GROUP = 1, SEQ = 2, PICK = 3, XFER = 4;
  const NR = 13, JOKER = 52, NC = 54;
  const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const SUIT_NAMES = ['スペード', 'ハート', 'ダイヤ', 'クラブ'];
  const R3 = 0, R5 = 2, R7 = 4, R8 = 5, R10 = 7, RJ = 8, R2 = 12, TOP = 13;
  const SPADE3 = 0, DIA3 = 26;
  const RANK_TITLES = ['大富豪', '富豪', '貧民', '大貧民'];
  const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

  const rankOf = c => (c >= JOKER ? -1 : c % NR);
  const suitOf = c => (c >= JOKER ? -1 : (c / NR) | 0);
  const isJoker = c => c >= JOKER;
  const cardId = (suit, rank) => suit * NR + rank;
  const cardText = c => (c < 0 ? '？' : c >= JOKER ? 'JOKER' : SUITS[suitOf(c)] + RANKS[rankOf(c)]);

  // ------------------------------------------------------------------ ルール
  // basic: 基本のルール（ふつうはオン）、local: ローカルルール（設定で切り替え）
  const RULE_LIST = [
    { key: 'jokers', label: 'ジョーカー', type: 'num', opts: [[0, 'なし'], [1, '1枚'], [2, '2枚']], def: 1, group: 'basic', desc: 'どの札の代わりにもなる。1枚で出せばいちばん強い' },
    { key: 'rev', label: '革命', def: true, group: 'basic', desc: '同じ数を4枚以上出すと、強さの順が逆になる（もう一度で元に戻る）' },
    { key: 'eight', label: '8切り', def: true, group: 'basic', desc: '8を含む手を出すと場が流れ、出した人からまた出せる' },
    { key: 'lockSuit', label: 'しばり（マーク）', def: true, group: 'basic', desc: '同じマークが2回続くと、場が流れるまでそのマークしか出せない' },
    { key: 'lockNum', label: 'しばり（数・階段しばり）', def: true, group: 'basic', desc: 'ひとつ上の数が続くと、場が流れるまでひとつずつ上の数しか出せない' },
    { key: 'spade3', label: 'スペ3返し', def: true, group: 'basic', desc: 'ジョーカー1枚には♠3を1枚で返せる。場が流れる' },
    { key: 'miyako', label: '都落ち', def: true, group: 'basic', desc: '2回戦から、大富豪がいちばんにあがれないと大貧民に落ちる' },
    { key: 'exchange', label: 'カード交換', def: true, group: 'basic', desc: '2回戦から、大貧民→大富豪に強い札2枚、貧民→富豪に1枚。富豪側は好きな札を返す' },
    { key: 'jback', label: '11バック', def: false, group: 'local', desc: 'Jを含む手を出すと、場が流れるまで強さの順が逆になる' },
    { key: 'skip5', label: '5飛び', def: false, group: 'local', desc: '5を出すと、5の枚数だけ次の人を飛ばす' },
    { key: 'pass7', label: '7渡し', def: false, group: 'local', desc: '7を出すと、7の枚数だけ好きな札を次の人に渡す' },
    { key: 'discard10', label: '10捨て', def: false, group: 'local', desc: '10を出すと、10の枚数だけ好きな札を捨てられる（みんなに見える）' },
    { key: 'seqRev', label: '階段革命', def: false, group: 'local', desc: '5枚以上の階段でも革命になる' },
    { key: 'forbid', label: '禁止あがり', def: false, group: 'local', desc: 'ジョーカー・2（革命中は3）・8・♠3（返し）で最後にあがると大貧民になる' },
  ];
  const DEFAULT_RULES = {};
  for (const r of RULE_LIST) DEFAULT_RULES[r.key] = r.def;
  function normRules(r) {
    const o = Object.assign({}, DEFAULT_RULES);
    if (r) for (const x of RULE_LIST) if (r[x.key] !== undefined) o[x.key] = x.type === 'num' ? Math.max(0, Math.min(2, r[x.key] | 0)) : !!r[x.key];
    return o;
  }

  // ------------------------------------------------------------------ 乱数（種から同じ並びを作れる）
  function rng32(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(a, rnd) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // 山を作って配る（start の人から1枚ずつ。余りの1〜2枚は start に近い人が多く持つ）
  function deckCards(rules) { const d = []; for (let c = 0; c < 52; c++) d.push(c); for (let j = 0; j < rules.jokers; j++) d.push(JOKER + j); return d; }
  function deal(rules, rnd, start = 0) {
    const d = shuffle(deckCards(rules), rnd), hands = [[], [], [], []];
    d.forEach((c, i) => hands[(start + i) % 4].push(c));
    hands.forEach(sortHand);
    return hands;
  }

  // 並べる順: 弱い数から（3…2）、同じ数ならマーク順、ジョーカーは最後
  const sortKey = c => (c >= JOKER ? 1000 + c : rankOf(c) * 4 + suitOf(c));
  function sortHand(h) { return h.sort((a, b) => sortKey(a) - sortKey(b)); }
  // 交換で渡す「強い札」の順（いつもの強さ。ジョーカーがいちばん強い）
  const strongKey = c => (c >= JOKER ? 100 + c : rankOf(c) * 4 + (3 - suitOf(c)));
  function strongest(hand, k) { return hand.filter(c => c >= 0).sort((a, b) => strongKey(b) - strongKey(a)).slice(0, k); }

  // ------------------------------------------------------------------ 手を作る
  function handMasks(hand) {
    const m = new Uint8Array(NR); const jk = [];
    for (const c of hand) { if (c >= JOKER) jk.push(c); else if (c >= 0) m[c % NR] |= 1 << ((c / NR) | 0); }
    return { m, jk };
  }
  const suitCards = (r, sm) => { const out = []; for (let s = 0; s < 4; s++) if (sm & (1 << s)) out.push(s * NR + r); return out; };
  function mkGroup(r, sm, jks, rr) {
    const cards = suitCards(r, sm).concat(jks);
    return { k: GROUP, cards, n: cards.length, r: rr == null ? r : rr, s: sm, jk: jks.length };
  }
  // 同じ数の手（枚数 n だけ。n = 0 ならすべての枚数）
  function groupMoves(hm, n, out) {
    const { m, jk } = hm, J = jk.length;
    for (let r = 0; r < NR; r++) {
      const sm = m[r];
      if (!sm) continue;
      for (let sub = sm; sub; sub = (sub - 1) & sm) {
        const k = POP[sub];
        for (let j = 0; j <= J; j++) {
          if (n && k + j !== n) continue;
          out.push(mkGroup(r, sub, jk.slice(0, j)));
        }
      }
    }
    return out;
  }
  // 階段（同じマークの連番 3 枚以上。ジョーカーは抜けた所を埋めるほか、持っている札の代わりにも使える）
  function seqMoves(hm, n, suitLock, out) {
    const { m, jk } = hm, J = jk.length;
    for (let s = 0; s < 4; s++) {
      if (suitLock && !(suitLock & (1 << s))) continue;
      const bit = 1 << s;
      for (let st = 0; st + 3 <= NR; st++) {
        let missing = 0;
        for (let L = 1; st + L <= NR; L++) {
          if (!(m[st + L - 1] & bit)) missing++;
          if (missing > J || (n && L > n)) break;
          if (L < 3 || (n && L !== n)) continue;
          const real = [];
          for (let i = 0; i < L; i++) if (m[st + i] & bit) real.push(i);
          if (!real.length) continue;
          // ジョーカーの使い方: 抜けた所を埋める分 + 余ったジョーカーで持っている札の代わりにする
          for (let use = missing; use <= J; use++) {
            const extra = use - missing;
            if (real.length - extra < 1) break;
            const combos = extra === 0 ? [[]] : extra === 1 ? real.map(i => [i]) : pairs(real);
            for (const rep of combos) {
              const cards = [];
              for (const i of real) if (!rep.includes(i)) cards.push(s * NR + st + i);
              for (let j = 0; j < use; j++) cards.push(jk[j]);
              out.push({ k: SEQ, cards, n: L, r: st, s: bit, jk: use });
            }
          }
        }
      }
    }
    return out;
  }
  function pairs(a) { const o = []; for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) o.push([a[i], a[j]]); return o; }

  // 手に含まれる「数 r」の枚数（ジョーカーは代わりをしている数として数える。ジョーカーだけの手は数えない）
  function countRank(mv, r) {
    if (mv.k === GROUP) return mv.r === r ? mv.n : 0;
    if (mv.k === SEQ) return r >= mv.r && r < mv.r + mv.n ? 1 : 0;
    return 0;
  }
  const moveKey = mv => `${mv.k}:${mv.r}:${mv.n}:${mv.s}:${mv.cards.slice().sort((a, b) => a - b).join(',')}`;

  // ------------------------------------------------------------------ ゲーム（1回戦）
  /* opt: { hands: [[札]×4]（-1 = 見えない札）, prev: 前の回の階級 [席→0..3] か null, leader: 最初に出す人（省略で自動） } */
  class Game {
    constructor(rules, opt = {}) {
      this.rules = normRules(rules);
      this.hands = opt.hands ? opt.hands.map(h => h.slice()) : null;
      this.prev = opt.prev ? opt.prev.slice() : null;
      this.phase = 'play';
      this.turn = 0;
      this.field = null; this.fieldBy = -1; this.trick = [];
      this.lockSuit = 0; this.numLock = false;
      this.rev = false; this.back = false;
      this.passes = 0; this.lastBy = -1;
      this.passed = [false, false, false, false];
      this.pinfo = [0, 1, 2, 3].map(() => [-1, 0, -1, 0]); // パスしたときの場（1枚・ペア）のいちばん弱い強さとそのときの向き（AI の特徴）
      this.out = [false, false, false, false];
      this.rank = [-1, -1, -1, -1];
      this.order = [];               // あがった順（階級の決まった順）
      this.top = 0; this.bottom = 3;
      this.grave = [];               // 出た札・捨てた札（みんなに見える）
      this.played = [[], [], [], []];
      this.known = [0, 1, 2, 3].map(() => [[], [], [], []]); // known[見る人][持つ人] = 見る人が知っている、持つ人の手の札（交換・7渡しで渡したもの）
      this.pend = null;              // 札をえらぶ途中: { kind: 'give'|'give7'|'discard10', p, to, left, after }
      this.queue = [];               // 交換でえらぶ人の順
      this.log = [];                 // 起きたこと（手・決まりで移った札）
      this.events = [];              // 直前の手で起きた演出（革命・8切り…）
      this.miyakoDone = false;
      if (!this.hands) return;
      this.hands.forEach(sortHand);
      if (this.prev && this.rules.exchange) this.startExchange(opt.auto !== false);
      else this.startPlay(opt.leader);
    }

    clone() {
      const g = Object.create(Game.prototype);
      for (const k of Object.keys(this)) {
        const v = this[k];
        if (k === 'known') g.known = v.map(a => a.map(b => b.slice()));
        else if (k === 'pinfo') g.pinfo = v.map(a => a.slice());
        else if (k === 'hands' || k === 'played') g[k] = v ? v.map(a => a.slice()) : v;
        else if (k === 'log' || k === 'events') g[k] = v.slice();
        else if (k === 'trick' || k === 'grave' || k === 'order' || k === 'passed' || k === 'out' || k === 'rank' || k === 'queue') g[k] = v.slice();
        else if (k === 'pend') g.pend = v ? Object.assign({}, v, { after: v.after ? Object.assign({}, v.after) : null }) : null;
        else if (k === 'prev') g.prev = v ? v.slice() : v;
        else g[k] = v;
      }
      return g;
    }

    get actor() { return this.phase === 'done' ? -1 : this.pend ? this.pend.p : this.turn; }
    get dir() { return (this.rev !== this.back) ? -1 : 1; }
    active(p) { return !this.out[p]; }
    activeCount() { let n = 0; for (let p = 0; p < 4; p++) if (!this.out[p]) n++; return n; }
    nextActive(p) { for (let i = 1; i <= 4; i++) { const q = (p + i) % 4; if (!this.out[q]) return q; } return -1; }
    seatOfPrev(rk) { return this.prev ? this.prev.indexOf(rk) : -1; }

    // ---------------------------------------------------------------- 交換
    startExchange(auto) {
      this.phase = 'give';
      const dh = this.seatOfPrev(3), df = this.seatOfPrev(0), hm = this.seatOfPrev(2), fg = this.seatOfPrev(1);
      // 貧民側が強い札を渡す（決まり）。見えない手のとき（オンラインの写し）は外から xfer() で入れる
      if (auto) {
        this.xfer(dh, df, strongest(this.hands[dh], 2));
        this.xfer(hm, fg, strongest(this.hands[hm], 1));
      }
      this.queue = [{ p: df, to: dh, left: 2 }, { p: fg, to: hm, left: 1 }];
      this.nextPick();
    }
    xfer(from, to, cards) {
      for (const c of cards) { this.take(from, c); this.hands[to].push(c); }
      sortHand(this.hands[to]);
      // 受け取った人は自分の手で分かる。渡した人は、渡した札を相手が持っていると知る
      for (const c of cards) if (c >= 0) this.known[from][to].push(c);
      this.log.push({ k: XFER, p: from, to, cards: cards.slice() });
    }
    nextPick() {
      while (this.queue.length) {
        const q = this.queue.shift();
        if (q.p >= 0 && q.left > 0 && this.hands[q.p].length) { this.pend = { kind: 'give', p: q.p, to: q.to, left: Math.min(q.left, this.hands[q.p].length), after: null }; return; }
      }
      this.pend = null;
      this.startPlay();
    }
    startPlay(leader) {
      this.phase = 'play';
      if (leader != null && leader >= 0) this.turn = leader;
      else if (this.prev) this.turn = Math.max(0, this.seatOfPrev(3));
      else {
        // 1回戦は♦3を持っている人から（見えない手のときは外から leader を渡す）
        const p = this.hands.findIndex(h => h.includes(DIA3));
        this.turn = p >= 0 ? p : 0;
      }
    }

    // ---------------------------------------------------------------- 出せる手
    legal() {
      const p = this.actor;
      if (p < 0) return [];
      const hand = this.hands[p];
      if (this.pend) {
        const seen = new Set(), out = [];
        for (const c of hand) if (c >= 0 && !seen.has(c)) { seen.add(c); out.push({ k: PICK, cards: [c], n: 1, r: rankOf(c), s: 0, jk: 0 }); }
        return out;
      }
      const hm = handMasks(hand), out = [];
      const f = this.field;
      if (!f) {
        groupMoves(hm, 0, out);
        if (hm.jk.length >= 1) out.push(mkGroup(0, 0, hm.jk.slice(0, 1), TOP));
        if (hm.jk.length >= 2) out.push(mkGroup(0, 0, hm.jk.slice(0, 2), TOP));
        seqMoves(hm, 0, 0, out);
        return out;
      }
      const dir = this.dir;
      const val = r => (r === TOP ? 100 : dir > 0 ? r : NR - 1 - r);
      if (f.k === GROUP) {
        const need = this.numLock && f.r !== TOP ? f.r + dir : -1;
        const cand = groupMoves(hm, f.n, []);
        for (const mv of cand) {
          if (this.lockSuit && (mv.s & ~this.lockSuit)) continue;
          if (this.numLock && f.r !== TOP) { if (mv.r !== need) continue; }
          else if (val(mv.r) <= val(f.r)) continue;
          out.push(mv);
        }
        // ジョーカーだけの手（単騎・2枚）
        if (f.n <= 2 && hm.jk.length >= f.n) {
          if (this.numLock && f.r !== TOP) { if (need >= 0 && need < NR) out.push(mkGroup(0, 0, hm.jk.slice(0, f.n), need)); }
          else if (f.r !== TOP) out.push(mkGroup(0, 0, hm.jk.slice(0, f.n), TOP));
        }
        // スペ3返し: ジョーカー1枚に♠3を1枚で（しばりに関係なく出せる）
        if (this.rules.spade3 && f.n === 1 && f.jk === 1 && hand.includes(SPADE3)) {
          if (!out.some(mv => mv.n === 1 && mv.cards[0] === SPADE3)) out.push(mkGroup(R3, 1, []));
        }
      } else if (f.k === SEQ) {
        const cand = seqMoves(hm, f.n, this.lockSuit, []);
        for (const mv of cand) if (val(mv.r) > val(f.r)) out.push(mv);
      }
      out.push({ k: PASS, cards: [], n: 0, r: -1, s: 0, jk: 0 });
      return out;
    }

    // 受け取った手が出せるものか（見えない手でも、場と札の形だけで確かめる。持っているかは別に確かめる）
    isLegalShape(mv) {
      const p = this.actor;
      if (p < 0 || !mv) return false;
      if (this.pend) return mv.k === PICK && mv.cards.length === 1;
      if (mv.k === PASS) return !!this.field;
      const norm = normalizeMove(mv);
      if (!norm) return false;
      // 手の札だけを持っているとして出せる手を作り、同じ手があるか
      const tmp = Object.create(Game.prototype);
      Object.assign(tmp, this, { hands: this.hands.map((h, i) => (i === p ? norm.cards.slice() : h)), pend: null });
      const key = moveKey(norm);
      return tmp.legal().some(x => moveKey(x) === key);
    }

    // ---------------------------------------------------------------- 進める
    take(p, c) {
      const h = this.hands[p];
      if (c < 0) {
        // 見えない札が出ていく（オンラインの写し）: 知っていた札（渡した札）も、まだ残っているか分からなくなる
        let j = h.indexOf(-1);
        if (j < 0) j = h.length - 1;
        if (j < 0) throw new Error(`${p} の手札がありません`);
        h.splice(j, 1);
        if (h.some(x => x >= 0)) { for (let k = 0; k < h.length; k++) h[k] = -1; for (let v = 0; v < 4; v++) this.known[v][p] = []; }
        return;
      }
      let i = h.indexOf(c);
      if (i < 0) i = h.indexOf(-1);
      if (i < 0) throw new Error(`${p} は ${cardText(c)} を持っていません`);
      h.splice(i, 1);
      for (let v = 0; v < 4; v++) { const kn = this.known[v][p], j = kn.indexOf(c); if (j >= 0) kn.splice(j, 1); }
    }

    apply(mv) {
      const p = this.actor;
      if (p < 0) throw new Error('もう終わっています');
      this.events = [];
      this.log.push({ k: mv.k, p, cards: mv.cards.slice(), n: mv.n, r: mv.r, s: mv.s, jk: mv.jk });
      if (this.pend) return this.applyPick(p, mv);
      if (mv.k === PASS) {
        this.passes++; this.passed[p] = true;
        this.notePass(p);
        this.events.push({ t: 'pass', p });
        this.turn = this.nextActive(p);
        this.checkTrick();
        return;
      }
      const prev = this.field, dir0 = this.dir;
      for (const c of mv.cards) this.take(p, c);
      for (const c of mv.cards) { this.grave.push(c); this.played[p].push(c); }
      const sp3 = !!(prev && this.rules.spade3 && prev.k === GROUP && prev.n === 1 && prev.jk === 1 && mv.k === GROUP && mv.n === 1 && mv.cards[0] === SPADE3);
      // しばり
      if (prev && !sp3) {
        if (this.rules.lockSuit && !this.lockSuit && prev.k === mv.k) {
          const u = prev.s | mv.s, size = mv.k === GROUP ? mv.n : 1;
          if (POP[u] === size && u) { this.lockSuit = u; this.events.push({ t: 'lockSuit', s: u }); }
        }
        if (this.rules.lockNum && !this.numLock && mv.k === GROUP && prev.k === GROUP && prev.r !== TOP && mv.r !== TOP && mv.r === prev.r + dir0) {
          this.numLock = true; this.events.push({ t: 'lockNum' });
        }
      }
      const fmv = { k: mv.k, cards: mv.cards.slice(), n: mv.n, r: mv.r, s: mv.s, jk: mv.jk };
      this.field = fmv; this.fieldBy = p; this.lastBy = p; this.passes = 0;
      this.trick.push({ p, mv: fmv });
      this.passed = [false, false, false, false];
      this.events.push({ t: 'play', p });
      // 革命・11バック
      if (this.rules.rev && ((mv.k === GROUP && mv.n >= 4) || (this.rules.seqRev && mv.k === SEQ && mv.n >= 5))) { this.rev = !this.rev; this.events.push({ t: 'rev', on: this.rev }); }
      if (this.rules.jback && countRank(mv, RJ)) { this.back = !this.back; this.events.push({ t: 'jback', on: this.back }); }
      const cut = (this.rules.eight && countRank(mv, R8) > 0) || sp3;
      if (sp3) this.events.push({ t: 'sp3' });
      else if (cut) this.events.push({ t: 'eight' });
      // あがり
      if (!this.hands[p].length) {
        const strongR = dir0 > 0 ? R2 : R3;
        const bad = this.rules.forbid && (mv.jk > 0 || countRank(mv, strongR) > 0 || (this.rules.eight && countRank(mv, R8) > 0) || sp3);
        this.finish(p, bad);
      }
      const after = { p, cut, skip: this.rules.skip5 ? countRank(mv, R5) : 0 };
      if (this.phase === 'done') return;
      const k7 = this.rules.pass7 ? countRank(mv, R7) : 0, k10 = this.rules.discard10 ? countRank(mv, R10) : 0;
      after.k10 = k10;
      if (!this.out[p] && k7 > 0 && this.activeCount() >= 2) {
        this.pend = { kind: 'give7', p, to: this.nextActive(p), left: Math.min(k7, this.hands[p].length), after };
        this.events.push({ t: 'seven', p, to: this.pend.to, n: this.pend.left });
        return;
      }
      if (!this.out[p] && k10 > 0) {
        after.k10 = 0;
        this.pend = { kind: 'discard10', p, to: -1, left: Math.min(k10, this.hands[p].length), after };
        this.events.push({ t: 'ten', p, n: this.pend.left });
        return;
      }
      this.continueAfter(after);
    }

    applyPick(p, mv) {
      const pd = this.pend, c = mv.cards[0];
      if (pd.kind === 'give' || pd.kind === 'give7') {
        this.take(p, c);
        this.hands[pd.to].push(c); sortHand(this.hands[pd.to]);
        if (c >= 0) this.known[p][pd.to].push(c);
        this.events.push({ t: pd.kind, p, to: pd.to, c });
      } else {
        this.take(p, c);
        this.grave.push(c);
        this.events.push({ t: 'discard', p, c });
      }
      pd.left--;
      if (pd.kind === 'give') {
        if (pd.left <= 0 || !this.hands[p].length) { this.pend = null; this.nextPick(); }
        return;
      }
      if (!this.hands[p].length && !this.out[p]) this.finish(p, false);
      if (this.phase === 'done') { this.pend = null; return; }
      if (pd.left > 0 && this.hands[p].length) return;
      const after = pd.after;
      this.pend = null;
      if (pd.kind === 'give7' && after.k10 > 0 && !this.out[p] && this.hands[p].length) {
        const k10 = after.k10; after.k10 = 0;
        this.pend = { kind: 'discard10', p, to: -1, left: Math.min(k10, this.hands[p].length), after };
        this.events.push({ t: 'ten', p, n: this.pend.left });
        return;
      }
      this.continueAfter(after);
    }

    continueAfter(a) {
      const p = a.p;
      if (a.cut) { this.clearField(this.out[p] ? this.nextActive(p) : p); return; }
      // 5飛び: 飛ばした人はパスしたものとして数える（ほかの全員を飛ばすと場が流れる）
      let skip = a.skip || 0;
      const others = this.activeCount() - (this.out[p] ? 0 : 1);
      if (skip > others) skip = others;
      let q = this.nextActive(p);
      if (skip) this.events.push({ t: 'skip', n: skip });
      for (let i = 0; i < skip; i++) { this.passes++; this.passed[q] = true; this.events.push({ t: 'skipped', p: q }); q = this.nextActive(q); }
      this.turn = q;
      this.checkTrick();
    }

    // 最後に出した人以外がみんなパスしたら場が流れる（出した人があがっていれば、残っている全員のパスで）
    checkTrick() {
      if (this.phase === 'done' || !this.field) return;
      const A = this.activeCount(), lb = this.lastBy;
      const need = this.out[lb] ? A : A - 1;
      if (this.passes >= need) this.clearField(this.out[lb] ? this.nextActive(lb) : lb);
    }
    clearField(leader) {
      this.field = null; this.fieldBy = -1; this.trick = [];
      this.lockSuit = 0; this.numLock = false; this.back = false;
      this.passes = 0; this.passed = [false, false, false, false];
      this.events.push({ t: 'clear', leader });
      if (leader >= 0) this.turn = leader;
    }

    finish(p, bad) {
      if (this.out[p]) return;
      this.out[p] = true;
      let rk;
      if (bad) { rk = this.bottom--; this.events.push({ t: 'foul', p, rank: rk }); }
      else { rk = this.top++; this.events.push({ t: 'finish', p, rank: rk }); }
      this.rank[p] = rk; this.order.push(p);
      // 都落ち: 前の大富豪より先にだれかが大富豪になったら、前の大富豪は大貧民に
      if (rk === 0 && this.rules.miyako && this.prev && !this.miyakoDone) {
        this.miyakoDone = true;
        const df = this.seatOfPrev(0);
        if (df >= 0 && df !== p && !this.out[df]) {
          this.out[df] = true;
          const r2 = this.bottom--;
          this.rank[df] = r2; this.order.push(df);
          this.events.push({ t: 'miyako', p: df, rank: r2 });
          this.hands[df] = [];
        }
      }
      if (rk === 0) this.miyakoDone = true;
      if (this.activeCount() <= 1) {
        const last = this.out.indexOf(false);
        if (last >= 0) { this.out[last] = true; this.rank[last] = this.top++; this.order.push(last); this.events.push({ t: 'last', p: last, rank: this.rank[last] }); }
        this.phase = 'done'; this.pend = null;
        this.events.push({ t: 'end' });
      }
    }

    result() { return this.phase === 'done' ? this.rank.slice() : null; }

    // Worker との受け渡し・保存（ふつうのデータだけなので JSON にできる）
    toJSON() { const o = {}; for (const k of Object.keys(this)) o[k] = this[k]; return o; }
    static fromJSON(o) { const g = Object.create(Game.prototype); Object.assign(g, typeof o === 'string' ? JSON.parse(o) : JSON.parse(JSON.stringify(o))); return g; }

    // パスの記録: 1枚・ペアの場に出さなかったとき、その強さ（いまの向きでの弱さの順 0..12）のいちばん弱いもの
    notePass(p) {
      const f = this.field;
      if (!f || f.k !== GROUP || f.n > 2 || f.r === TOP) return;
      if (!this.pinfo) this.pinfo = [0, 1, 2, 3].map(() => [-1, 0, -1, 0]);
      const d = this.dir, v = d > 0 ? f.r : NR - 1 - f.r, i = (f.n - 1) * 2, a = this.pinfo[p];
      if (a[i] < 0 || a[i + 1] !== d || v < a[i]) { a[i] = v; a[i + 1] = d; }
    }

    // 手を出したら何が起きるか（進めずに。AI の特徴と画面の案内に使う）
    effects(mv) {
      const p = this.actor, r = this.rules, f = this.field, dir0 = this.dir;
      const e = { cut: false, sp3: false, rev: false, back: false, skip: 0, k7: 0, k10: 0, finish: false, foul: false, lockS: false, lockN: false, dirAfter: dir0 };
      if (!mv || mv.k === PASS || p < 0) return e;
      if (mv.k === PICK) { e.finish = this.hands[p].length === 1 && this.pend && this.pend.kind !== 'give'; return e; }
      e.sp3 = !!(f && r.spade3 && f.k === GROUP && f.n === 1 && f.jk === 1 && mv.k === GROUP && mv.n === 1 && mv.cards[0] === SPADE3);
      e.rev = r.rev && ((mv.k === GROUP && mv.n >= 4) || (r.seqRev && mv.k === SEQ && mv.n >= 5));
      e.back = r.jback && countRank(mv, RJ) > 0;
      e.cut = (r.eight && countRank(mv, R8) > 0) || e.sp3;
      e.skip = r.skip5 ? countRank(mv, R5) : 0;
      e.k7 = r.pass7 ? countRank(mv, R7) : 0;
      e.k10 = r.discard10 ? countRank(mv, R10) : 0;
      e.finish = this.hands[p].length - mv.cards.length === 0;
      if (e.finish && r.forbid) e.foul = mv.jk > 0 || countRank(mv, dir0 > 0 ? R2 : R3) > 0 || (r.eight && countRank(mv, R8) > 0) || e.sp3;
      if (f && !e.sp3) {
        e.lockS = r.lockSuit && !this.lockSuit && f.k === mv.k && !!(f.s | mv.s) && POP[f.s | mv.s] === (mv.k === GROUP ? mv.n : 1);
        e.lockN = r.lockNum && !this.numLock && mv.k === GROUP && f.k === GROUP && f.r !== TOP && mv.r !== TOP && mv.r === f.r + dir0;
      }
      let d = dir0;
      if (e.rev) d = -d;
      if (e.back) d = -d;
      e.dirAfter = d;
      return e;
    }
  }

  // 手の形を整える（ネットから来た手などを確かめるため）: 札の重なり・数の範囲を見て、k・n・r・s・jk を札から作り直す
  function normalizeMove(mv) {
    if (!mv || !Array.isArray(mv.cards)) return null;
    const cards = mv.cards.map(c => c | 0);
    if (!cards.length || cards.length > 13 || new Set(cards).size !== cards.length || cards.some(c => c < 0 || c >= NC)) return null;
    const jk = cards.filter(c => c >= JOKER).length;
    const real = cards.filter(c => c < JOKER);
    if (mv.k === GROUP) {
      const rs = new Set(real.map(rankOf));
      if (rs.size > 1) return null;
      const r = real.length ? rankOf(real[0]) : (mv.r | 0);
      if (!(r >= 0 && r <= TOP)) return null;
      let s = 0; for (const c of real) s |= 1 << suitOf(c);
      return { k: GROUP, cards, n: cards.length, r, s, jk };
    }
    if (mv.k === SEQ) {
      const r = mv.r | 0, n = cards.length;
      if (n < 3 || r < 0 || r + n > NR || !real.length) return null;
      const ss = new Set(real.map(suitOf));
      if (ss.size !== 1) return null;
      for (const c of real) if (rankOf(c) < r || rankOf(c) >= r + n) return null;
      if (new Set(real.map(rankOf)).size !== real.length) return null;
      return { k: SEQ, cards, n, r, s: 1 << suitOf(real[0]), jk };
    }
    return null;
  }

  // 手の言葉（記録・情報の行）
  function moveText(mv) {
    if (!mv) return '';
    if (mv.k === PASS) return 'パス';
    if (mv.k === PICK || mv.k === XFER) return mv.cards.map(cardText).join(' ');
    const real = mv.cards.filter(c => c < JOKER).sort((a, b) => sortKey(a) - sortKey(b)).map(cardText);
    const j = new Array(mv.jk || 0).fill('JOKER');
    if (mv.k === GROUP && !real.length) return mv.jk === 1 ? 'JOKER' : 'JOKER×2';
    if (mv.k === SEQ) return `${SUITS[Math.log2(mv.s)]}${RANKS[mv.r]}〜${RANKS[mv.r + mv.n - 1]}の階段${mv.jk ? `（JOKER${mv.jk > 1 ? '×2' : ''}込み）` : ''}`;
    return real.concat(j).join(' ');
  }
  const kindText = mv => (!mv ? '' : mv.k === SEQ ? `${mv.n}枚の階段` : mv.n === 1 ? '1枚' : mv.n === 2 ? 'ペア' : `${mv.n}枚`);

  return {
    PASS, GROUP, SEQ, PICK, XFER, NR, JOKER, NC, RANKS, SUITS, SUIT_NAMES, R3, R5, R7, R8, R10, RJ, R2, TOP, SPADE3, DIA3, RANK_TITLES, POP,
    RULE_LIST, DEFAULT_RULES, normRules, rng32, shuffle, deal, deckCards, sortHand, sortKey, strongest, strongKey,
    rankOf, suitOf, isJoker, cardId, cardText, handMasks, groupMoves, seqMoves, countRank, moveKey, normalizeMove, moveText, kindText,
    Game,
  };
});
