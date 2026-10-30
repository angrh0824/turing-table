/* 花札こいこい: ルール（札・役・1か月の進行）。ブラウザ・Web Worker・Node のどれでも動く
 *
 * 札の番号 0〜47: 月 = id >> 2（0=一月 松 … 11=十二月 桐）。月の中は「格の高い順」
 *   光 0 松に鶴 / 8 桜に幕 / 28 芒に月 / 40 柳に小野道風（雨）/ 44 桐に鳳凰
 *   タネ 4 梅に鶯 / 12 藤に不如帰 / 16 菖蒲に八橋 / 20 牡丹に蝶 / 24 萩に猪 / 29 芒に雁 / 32 菊に盃 / 36 紅葉に鹿 / 41 柳に燕
 *   タン 赤短 1 5 9 / 青短 21 33 37 / 短冊 13 17 25 42
 *   カス それ以外（柳は 43 の1枚、桐は 45 46 47 の3枚）
 *
 * 手（行動）は整数:
 *   出す   PLAY(c, f) = c | ((f + 1) << 6)   c=手札の札、f=取る場の札（候補が2枚のときだけ。ほかは -1）
 *   めくった札で取る札を選ぶ  PICK(f) = 4096 + f
 *   こいこい KOI = 5000 / 勝負 STOP = 5001
 */
(function (root) {
  'use strict';
  const LIGHT = 0, TANE = 1, TAN = 2, KASU = 3;
  const MONTHS = ['松', '梅', '桜', '藤', '菖蒲', '牡丹', '萩', '芒', '菊', '紅葉', '柳', '桐'];
  const MONTH_NUM = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  const TYPE_NAME = ['光', 'タネ', 'タン', 'カス'];
  const TYPE = new Int8Array(48).fill(KASU);
  [0, 8, 28, 40, 44].forEach(c => { TYPE[c] = LIGHT; });
  [4, 12, 16, 20, 24, 29, 32, 36, 41].forEach(c => { TYPE[c] = TANE; });
  [1, 5, 9, 13, 17, 21, 25, 33, 37, 42].forEach(c => { TYPE[c] = TAN; });
  const NAME = [];
  const SPECIAL = { 0: '松に鶴', 8: '桜に幕', 28: '芒に月', 40: '柳に小野道風', 44: '桐に鳳凰', 4: '梅に鶯', 12: '藤に不如帰', 16: '菖蒲に八橋', 20: '牡丹に蝶', 24: '萩に猪', 29: '芒に雁', 32: '菊に盃', 36: '紅葉に鹿', 41: '柳に燕', 1: '松に赤短', 5: '梅に赤短', 9: '桜に赤短', 21: '牡丹に青短', 33: '菊に青短', 37: '紅葉に青短', 13: '藤に短冊', 17: '菖蒲に短冊', 25: '萩に短冊', 42: '柳に短冊' };
  for (let c = 0; c < 48; c++) NAME[c] = SPECIAL[c] || `${MONTHS[c >> 2]}のカス`;
  const month = c => c >> 2;
  const type = c => TYPE[c];
  // 札の格（同じ月で並べるとき・親決めの同じ月どうし）
  const rank = c => c & 3;

  const PLAY = (c, f) => c | ((f + 1) << 6);
  const PICK = f => 4096 + f;
  const KOI = 5000, STOP = 5001;
  const isPlay = a => a < 4096;
  const isPick = a => a >= 4096 && a < 5000;
  const playCard = a => a & 63;
  const playTarget = a => (a >> 6) - 1;
  const pickTarget = a => a - 4096;

  // ルールの既定値（一般によく遊ばれているもの。迷うものは設定で切り替える）
  const DEFAULT_RULES = {
    months: 12,       // 何か月（12・6・3）
    sake: true,       // 花見で一杯・月見で一杯
    sakeKasu: true,   // 菊に盃をカスにも数える
    double7: true,    // 7点以上で得点2倍
    koiDouble: true,  // 相手がこいこいしたあとに上がると得点2倍
    teshi: true,      // 手四・くっつき（配られた手札で6点）
    oyaken: false,    // 親権: 札が尽きて役がないとき親の勝ち（1点）。なしなら引き分け
  };
  const RULE_KEYS = ['sake', 'sakeKasu', 'double7', 'koiDouble', 'teshi', 'oyaken'];
  const normRules = r => {
    const o = Object.assign({}, DEFAULT_RULES, r || {});
    o.months = [3, 6, 12].includes(+o.months) ? +o.months : 12;
    RULE_KEYS.forEach(k => { o[k] = !!o[k]; });
    return o;
  };

  // ------------------------------------------------------------------ 役
  const YAKU = {
    goko: { name: '五光', base: 10 },
    shiko: { name: '四光', base: 8 },
    ameshiko: { name: '雨四光', base: 7 },
    sanko: { name: '三光', base: 5 },
    hanami: { name: '花見で一杯', base: 5 },
    tsukimi: { name: '月見で一杯', base: 5 },
    isc: { name: '猪鹿蝶', base: 5 },
    akaao: { name: '赤短・青短の重複', base: 10 },
    akatan: { name: '赤短', base: 5 },
    aotan: { name: '青短', base: 5 },
    tane: { name: 'タネ', base: 1 },
    tan: { name: 'タン', base: 1 },
    kasu: { name: 'カス', base: 1 },
    teshi: { name: '手四', base: 6 },
    kuttsuki: { name: 'くっつき', base: 6 },
    oyaken: { name: '親権', base: 1 },
  };
  const YAKU_ORDER = ['goko', 'shiko', 'ameshiko', 'sanko', 'hanami', 'tsukimi', 'isc', 'akaao', 'akatan', 'aotan', 'tane', 'tan', 'kasu'];

  // 取った札（has: 長さ48の 0/1）から役の一覧と合計
  function yakuOf(has, rules) {
    const list = [];
    const lights = has[0] + has[8] + has[28] + has[40] + has[44], rain = has[40];
    if (lights === 5) list.push(['goko', 10]);
    else if (lights === 4) list.push(rain ? ['ameshiko', 7] : ['shiko', 8]);
    else if (lights === 3 && !rain) list.push(['sanko', 5]);
    if (rules.sake && has[32]) {
      if (has[8]) list.push(['hanami', 5]);
      if (has[28]) list.push(['tsukimi', 5]);
    }
    if (has[20] && has[24] && has[36]) list.push(['isc', 5]);
    const aka = has[1] && has[5] && has[9], ao = has[21] && has[33] && has[37];
    if (aka && ao) list.push(['akaao', 10]);
    else if (aka) list.push(['akatan', 5]);
    else if (ao) list.push(['aotan', 5]);
    let nTane = 0, nTan = 0, nKasu = 0;
    for (let c = 0; c < 48; c++) {
      if (!has[c]) continue;
      const t = TYPE[c];
      if (t === TANE) nTane++; else if (t === TAN) nTan++; else if (t === KASU) nKasu++;
    }
    if (rules.sakeKasu && has[32]) nKasu++;
    if (nTane >= 5) list.push(['tane', nTane - 4]);
    if (nTan >= 5) list.push(['tan', nTan - 4]);
    if (nKasu >= 10) list.push(['kasu', nKasu - 9]);
    let total = 0;
    for (const y of list) total += y[1];
    return { list, total };
  }
  // 合計だけ（AI の中で何度も呼ぶので軽く）
  function yakuTotal(has, rules) { return yakuOf(has, rules).total; }

  // 配られた手札の手四・くっつき
  function handYaku(hand) {
    const cnt = new Int8Array(12);
    for (const c of hand) cnt[c >> 2]++;
    let pairs = 0;
    for (let m = 0; m < 12; m++) {
      if (cnt[m] === 4) return 'teshi';
      if (cnt[m] === 2) pairs++;
    }
    return pairs === 4 ? 'kuttsuki' : null;
  }
  // 場に配られた札の配り直し（同じ月4枚、または2枚ずつ4組）
  function fieldVoid(field) {
    const cnt = new Int8Array(12);
    for (const c of field) cnt[c >> 2]++;
    let pairs = 0;
    for (let m = 0; m < 12; m++) { if (cnt[m] === 4) return true; if (cnt[m] === 2) pairs++; }
    return pairs === 4;
  }

  // ------------------------------------------------------------------ 乱数（学習で再現できるように種を指定できる）
  function makeRng(seed) {
    if (seed == null) return Math.random;
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function shuffled(rng) {
    const d = [];
    for (let i = 0; i < 48; i++) d.push(i);
    for (let i = 47; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }

  // ------------------------------------------------------------------ 1か月（1局）
  // phase: 'play'（手札から出す）/ 'pick'（めくった札で取る札を選ぶ）/ 'koi'（こいこいか勝負か）/ 'end'
  // 山札は deck の末尾からめくる。オンラインでは見えていない札を -1 にしておき、めくる前に setTop で教える
  class Round {
    constructor(opts) {
      opts = opts || {};
      this.rules = normRules(opts.rules);
      this.dealer = opts.dealer | 0;
      this.hands = [[], []];
      this.field = [];
      this.deck = [];
      this.caps = [[], []];
      this.has = [new Uint8Array(48), new Uint8Array(48)];
      this.turn = this.dealer;
      this.phase = 'play';
      this.pending = -1;     // めくって取る札を選んでいる札
      this.koi = [0, 0];     // こいこいした回数
      this.score = [0, 0];   // 今の役の合計（素点）
      this.decided = [0, 0]; // 最後にこいこい/勝負を決めたときの素点（増えたら次の判断）
      this.result = null;    // { winner: 0|1|-1, points, base, mult, yaku: [[key, pts]], reason }
      this.log = [];         // { p, k:'play'|'draw'|'koi'|'stop', c, took:[...] }
      this.plays = 0;        // 出した回数（両者の合計）
      this.handCheck = opts.handCheck !== false; // 配ったときに手四・くっつきを調べる（オンラインでは各自が名乗る）
      if (opts.deal) this.deal(opts.deal);
    }

    // 配る: deal = 48枚の並び（[0..7]=子の手札, [8..15]=場, [16..23]=親の手札, 残り=山札で末尾から引く）
    // 配られた時点で場が流れるなら false（配り直し）
    deal(order) {
      const ko = this.dealer ^ 1;
      this.hands[ko] = order.slice(0, 8);
      this.field = order.slice(8, 16);
      this.hands[this.dealer] = order.slice(16, 24);
      this.deck = order.slice(24);
      if (this.field.every(c => c >= 0) && fieldVoid(this.field)) return false;
      if (this.rules.teshi && this.handCheck) {
        for (const p of [this.dealer, ko]) {
          if (this.hands[p].some(c => c < 0)) continue;
          const y = handYaku(this.hands[p]);
          if (y) { this.finish(p, [[y, 6]], 6, 1, y === 'teshi' ? '手四' : 'くっつき'); return true; }
        }
      }
      return true;
    }
    // 自分の手札に手四・くっつきがあると名乗る（オンライン: 札を見せて終わる）
    declareHand(p, cards) {
      const y = handYaku(cards);
      if (!y || !this.rules.teshi) return false;
      this.hands[p] = cards.slice();
      this.finish(p, [[y, 6]], 6, 1, y === 'teshi' ? '手四' : 'くっつき');
      return true;
    }

    matches(c) { const m = c >> 2; return this.field.filter(f => f >= 0 && (f >> 2) === m); }

    // 今の手番の合法手
    legal() {
      const out = [];
      if (this.phase === 'play') {
        for (const c of this.hands[this.turn]) {
          if (c < 0) continue;
          const ms = this.matches(c);
          if (ms.length === 2) { out.push(PLAY(c, ms[0])); out.push(PLAY(c, ms[1])); } else out.push(PLAY(c, -1));
        }
      } else if (this.phase === 'pick') {
        for (const f of this.matches(this.pending)) out.push(PICK(f));
      } else if (this.phase === 'koi') {
        if (this.canKoi()) out.push(KOI);
        out.push(STOP);
      }
      return out;
    }
    // こいこいできるか（自分にもう手番が来ないなら勝負しかない）
    canKoi() { return this.hands[this.turn].length > 0 || this.hands[this.turn ^ 1].length > 0; }
    isLegal(a) { return this.legal().includes(a); }

    // 山札の一番上（次にめくる札）。オンラインで見えていないときは -1
    top() { return this.deck.length ? this.deck[this.deck.length - 1] : -2; }
    setTop(c) { this.deck[this.deck.length - 1] = c; }

    // 札 c を場に出して取る（f は2枚のうちどちらを取るか）。取った札の一覧
    capture(p, c, f) {
      const ms = this.matches(c);
      let took;
      if (ms.length === 0) { this.field.push(c); return []; }
      if (ms.length === 1) took = [ms[0]];
      else if (ms.length === 2) took = [f >= 0 && ms.includes(f) ? f : ms[0]];
      else took = ms;
      this.field = this.field.filter(x => !took.includes(x));
      took.push(c);
      for (const x of took) { this.caps[p].push(x); this.has[p][x] = 1; }
      return took;
    }

    step(a) {
      if (this.phase === 'end') throw new Error('round is over');
      const p = this.turn;
      if (this.phase === 'play') {
        if (!isPlay(a)) throw new Error('bad action');
        const c = playCard(a), f = playTarget(a);
        const hi = this.hands[p].indexOf(c);
        if (hi < 0) {
          // オンラインの相手の手札は見えていない（-1）ので、そのうち1枚を出した札にする
          const u = this.hands[p].indexOf(-1);
          if (u < 0) throw new Error('card not in hand');
          this.hands[p].splice(u, 1);
        } else this.hands[p].splice(hi, 1);
        const took = this.capture(p, c, f);
        this.log.push({ p, k: 'play', c, took });
        this.plays++;
        return this.draw();
      }
      if (this.phase === 'pick') {
        if (!isPick(a)) throw new Error('bad action');
        const c = this.pending;
        this.pending = -1;
        const took = this.capture(p, c, pickTarget(a));
        this.log.push({ p, k: 'draw', c, took });
        return this.afterTurn();
      }
      if (this.phase === 'koi') {
        if (a === KOI && this.canKoi()) {
          this.koi[p]++;
          this.decided[p] = this.score[p];
          this.log.push({ p, k: 'koi' });
          return this.nextTurn();
        }
        this.log.push({ p, k: 'stop' });
        return this.stop(p);
      }
    }
    // 山札をめくる
    draw() {
      const c = this.deck.pop();
      if (c == null || c < 0) throw new Error('top card unknown');
      if (this.matches(c).length === 2) { this.pending = c; this.phase = 'pick'; return this; }
      const took = this.capture(this.turn, c, -1);
      this.log.push({ p: this.turn, k: 'draw', c, took });
      return this.afterTurn();
    }
    afterTurn() {
      const p = this.turn;
      const y = yakuOf(this.has[p], this.rules);
      this.score[p] = y.total;
      if (y.total > this.decided[p]) {
        this.phase = 'koi';
        if (!this.canKoi()) { this.log.push({ p, k: 'stop' }); return this.stop(p); } // 最後の手番は勝負だけ
        return this;
      }
      return this.nextTurn();
    }
    nextTurn() {
      this.turn ^= 1;
      if (!this.hands[this.turn].length) {
        // 両者の手札がなくなった: 役なしで流れる（親権ありなら親の勝ち）
        if (this.rules.oyaken) return this.finish(this.dealer, [['oyaken', 1]], 1, 1, '親権');
        return this.finish(-1, [], 0, 1, '流れ');
      }
      this.phase = 'play';
      return this;
    }
    // 勝負: 役の合計に倍をかける
    stop(p) {
      const y = yakuOf(this.has[p], this.rules);
      let mult = 1;
      if (this.rules.double7 && y.total >= 7) mult *= 2;
      if (this.rules.koiDouble && this.koi[p ^ 1] > 0) mult *= 2;
      return this.finish(p, y.list, y.total, mult, '勝負');
    }
    finish(winner, yaku, base, mult, reason) {
      this.phase = 'end';
      this.result = { winner, points: winner < 0 ? 0 : base * mult, base, mult, yaku, reason };
      return this;
    }
    // 次の親: 勝った人。流れたら親のまま
    nextDealer() { return this.result && this.result.winner >= 0 ? this.result.winner : this.dealer; }

    clone() {
      const r = Object.create(Round.prototype);
      r.rules = this.rules; r.dealer = this.dealer;
      r.hands = [this.hands[0].slice(), this.hands[1].slice()];
      r.field = this.field.slice(); r.deck = this.deck.slice();
      r.caps = [this.caps[0].slice(), this.caps[1].slice()];
      r.has = [this.has[0].slice(), this.has[1].slice()];
      r.turn = this.turn; r.phase = this.phase; r.pending = this.pending;
      r.koi = this.koi.slice(); r.score = this.score.slice(); r.decided = this.decided.slice();
      r.result = this.result; r.log = this.log.slice(); r.plays = this.plays;
      return r;
    }
  }

  // 新しい1か月を配る（配り直しの条件に当たれば配り直す）
  function newRound(rules, dealer, rng) {
    rng = rng || Math.random;
    for (;;) {
      const r = new Round({ rules, dealer });
      if (r.deal(shuffled(rng))) return r;
    }
  }

  // ------------------------------------------------------------------ 対局（何か月か）
  class Match {
    constructor(opts) {
      opts = opts || {};
      this.rules = normRules(opts.rules);
      this.rng = opts.rng || Math.random;
      this.months = this.rules.months;
      this.totals = [0, 0];
      this.history = []; // { dealer, winner, points, yaku, reason }
      this.firstDealer = opts.dealer != null ? opts.dealer : (this.rng() < 0.5 ? 0 : 1);
      this.dealer = this.firstDealer;
      this.round = null;
    }
    get monthIndex() { return this.history.length; }      // 0 から
    get over() { return this.history.length >= this.months; }
    startRound(order) {
      // order を渡すのはオンライン（見えない札は -1）。手四・くっつきは各自が名乗る
      if (order) { const r = new Round({ rules: this.rules, dealer: this.dealer, handCheck: false }); if (!r.deal(order)) return null; this.round = r; }
      else this.round = newRound(this.rules, this.dealer, this.rng);
      return this.round;
    }
    // 1か月が終わったら呼ぶ
    endRound() {
      const r = this.round, res = r.result;
      if (res.winner >= 0) this.totals[res.winner] += res.points;
      this.history.push({ dealer: r.dealer, winner: res.winner, points: res.points, base: res.base, mult: res.mult, yaku: res.yaku, reason: res.reason });
      this.dealer = r.nextDealer();
    }
    winner() { return this.totals[0] > this.totals[1] ? 0 : this.totals[1] > this.totals[0] ? 1 : -1; }
  }

  // 手の文字（記録・情報の行）
  function actionText(r, a) {
    if (a === KOI) return 'こいこい';
    if (a === STOP) return '勝負';
    if (isPick(a)) return `${NAME[pickTarget(a)]}を取る`;
    const c = playCard(a), f = playTarget(a);
    return f >= 0 ? `${NAME[c]}で${NAME[f]}を取る` : NAME[c];
  }

  const api = {
    LIGHT, TANE, TAN, KASU, MONTHS, MONTH_NUM, TYPE_NAME, TYPE, NAME, YAKU, YAKU_ORDER, DEFAULT_RULES, RULE_KEYS,
    month, type, rank, PLAY, PICK, KOI, STOP, isPlay, isPick, playCard, playTarget, pickTarget,
    normRules, yakuOf, yakuTotal, handYaku, fieldVoid, makeRng, shuffled, Round, Match, newRound, actionText,
  };
  root.KoikoiCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
