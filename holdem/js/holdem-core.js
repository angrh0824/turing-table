/* テキサスホールデム（ノーリミット）のルールエンジン。ブラウザと Node の両方で動く
 *
 * カード: 0..51。rank = c >> 2（0=2 … 12=A）、suit = c & 3（0=♠ 1=♥ 2=♦ 3=♣）
 * 役の強さ: evaluate() が返す整数（大きいほど強い）。上位4ビットが役の種類（0=ハイカード … 8=ストレートフラッシュ）、下位20ビットがキッカー
 *
 * 1ハンドの進行は「状態」オブジェクト（JSON にできる）を act / deal / show で進める:
 *   s = newHand({ stacks, button, sb, bb, ante })   … ブラインドを置いて、配る待ち（phase 'hole'）
 *   phase 'hole'  … 手札を配る: dealHole(s, holes)（オンラインでは自分の分以外 null のまま）
 *   phase 'bet'   … s.toAct の人が行動: act(s, {t:'f'|'c'|'r', to})。合法な範囲は legal(s)
 *   phase 'deal'  … 場のカードが s.need 枚いる: deal(s, cards)
 *   phase 'show'  … ショーダウン。残っている人（s.contenders）の手札がいる: show(s, holes)
 *   phase 'done'  … s.result に配当
 * 手元の対局では autoDeal(s, deck) が山札から配って進める
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HoldemCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const SUIT_MARK = ['♠', '♥', '♦', '♣'];
  const RANK_JA = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const CAT_NAMES = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ'];

  const rankOf = c => c >> 2;
  const suitOf = c => c & 3;
  const cardStr = c => RANKS[c >> 2] + SUITS[c & 3];
  const cardJa = c => SUIT_MARK[c & 3] + RANK_JA[c >> 2];
  function parseCard(t) {
    const r = RANKS.indexOf(t[0].toUpperCase()), s = SUITS.indexOf(t[1].toLowerCase());
    if (r < 0 || s < 0) throw new Error('カードが読めません: ' + t);
    return r * 4 + s;
  }
  const parseCards = str => str.trim().split(/\s+/).filter(Boolean).map(parseCard);

  // ------------------------------------------------------------------ 役の判定（13ビットのランクの集合を表で引く）
  const TOP = new Int8Array(8192), POP = new Uint8Array(8192), STRAIGHT = new Int8Array(8192);
  const TOP2 = new Int32Array(8192), TOP3 = new Int32Array(8192), TOP5 = new Int32Array(8192);
  (function build() {
    for (let m = 0; m < 8192; m++) {
      let top = -1, pop = 0;
      for (let r = 0; r < 13; r++) if (m & (1 << r)) { top = r; pop++; }
      TOP[m] = top; POP[m] = pop;
      let st = -1;
      for (let t = 12; t >= 4; t--) { const need = 31 << (t - 4); if ((m & need) === need) { st = t; break; } }
      if (st < 0 && (m & 0x100f) === 0x100f) st = 3; // A-2-3-4-5
      STRAIGHT[m] = st;
      let v = 0, k = 0, mm = m;
      const tops = [];
      while (mm && k < 5) { const t = 31 - Math.clz32(mm); tops.push(t); mm ^= 1 << t; k++; }
      for (let i = 0; i < 5; i++) v = (v << 4) | (tops[i] || 0);
      TOP5[m] = v;
      TOP3[m] = ((tops[0] || 0) << 8) | ((tops[1] || 0) << 4) | (tops[2] || 0);
      TOP2[m] = ((tops[0] || 0) << 4) | (tops[1] || 0);
    }
  })();

  // 4つのスートごとのランクの集合から役の強さ
  function evalMasks(s0, s1, s2, s3) {
    const fm = POP[s0] >= 5 ? s0 : POP[s1] >= 5 ? s1 : POP[s2] >= 5 ? s2 : POP[s3] >= 5 ? s3 : 0;
    if (fm) { const sf = STRAIGHT[fm]; if (sf >= 0) return 0x800000 | sf; }
    const all = s0 | s1 | s2 | s3;
    const m4 = s0 & s1 & s2 & s3;
    if (m4) { const q = TOP[m4]; return 0x700000 | (q << 4) | TOP[all ^ (1 << q)]; }
    const m3 = (s0 & s1 & s2) | (s0 & s1 & s3) | (s0 & s2 & s3) | (s1 & s2 & s3);
    const m2 = (s0 & s1) | (s0 & s2) | (s0 & s3) | (s1 & s2) | (s1 & s3) | (s2 & s3);
    if (m3) { const t = TOP[m3], rest = m2 ^ (1 << t); if (rest) return 0x600000 | (t << 4) | TOP[rest]; }
    if (fm) return 0x500000 | TOP5[fm];
    const st = STRAIGHT[all];
    if (st >= 0) return 0x400000 | st;
    if (m3) { const t = TOP[m3]; return 0x300000 | (t << 8) | TOP2[all ^ (1 << t)]; }
    if (m2) {
      const p1 = TOP[m2], r2 = m2 ^ (1 << p1);
      if (r2) { const p2 = TOP[r2]; return 0x200000 | (p1 << 8) | (p2 << 4) | TOP[all ^ (1 << p1) ^ (1 << p2)]; }
      return 0x100000 | (p1 << 12) | TOP3[all ^ (1 << p1)];
    }
    return TOP5[all];
  }
  // 5〜7枚のカード（配列）の役の強さ
  function evaluate(cards) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i], b = 1 << (c >> 2);
      switch (c & 3) { case 0: s0 |= b; break; case 1: s1 |= b; break; case 2: s2 |= b; break; default: s3 |= b; }
    }
    return evalMasks(s0, s1, s2, s3);
  }
  const handCat = v => v >> 20;
  const handName = v => CAT_NAMES[v >> 20];
  // 役を作っている5枚（画面で光らせる用。21通りを総当たり）
  function bestFive(cards) {
    let best = -1, pick = null;
    const n = cards.length, idx = [0, 1, 2, 3, 4];
    if (n < 5) return cards.slice();
    const rec = (start, depth) => {
      if (depth === 5) {
        const five = idx.map(i => cards[i]), v = evaluate(five);
        if (v > best) { best = v; pick = five; }
        return;
      }
      for (let i = start; i <= n - (5 - depth); i++) { idx[depth] = i; rec(i + 1, depth + 1); }
    };
    rec(0, 0);
    return pick;
  }
  // 役の説明（例:「ワンペア（K）」「フルハウス（Q と 7）」）
  function handLabel(v) {
    const cat = v >> 20, k = v & 0xfffff, r = i => RANK_JA[(k >> (16 - 4 * i)) & 15];
    switch (cat) {
      case 8: return (k & 15) === 12 ? 'ロイヤルストレートフラッシュ' : `ストレートフラッシュ（${RANK_JA[k & 15]}まで）`;
      case 7: return `フォーカード（${RANK_JA[(k >> 4) & 15]}）`;
      case 6: return `フルハウス（${RANK_JA[(k >> 4) & 15]}と${RANK_JA[k & 15]}）`;
      case 5: return `フラッシュ（${r(0)}ハイ）`;
      case 4: return `ストレート（${RANK_JA[k & 15]}まで）`;
      case 3: return `スリーカード（${RANK_JA[(k >> 8) & 15]}）`;
      case 2: return `ツーペア（${RANK_JA[(k >> 8) & 15]}と${RANK_JA[(k >> 4) & 15]}）`;
      case 1: return `ワンペア（${RANK_JA[(k >> 12) & 15]}）`;
      default: return `ハイカード（${r(0)}）`;
    }
  }

  // 手札の種類（169通り）: ペア = hi*13+hi、スーテッド = hi*13+lo、オフスート = lo*13+hi
  function handClass(a, b) {
    const ra = a >> 2, rb = b >> 2, hi = ra > rb ? ra : rb, lo = ra > rb ? rb : ra;
    if (hi === lo) return hi * 13 + hi;
    return (a & 3) === (b & 3) ? hi * 13 + lo : lo * 13 + hi;
  }
  function classLabel(k) {
    const r = (k / 13) | 0, c = k % 13;
    if (r === c) return RANKS[r] + RANKS[r];
    return r > c ? RANKS[r] + RANKS[c] + 's' : RANKS[c] + RANKS[r] + 'o';
  }

  // ------------------------------------------------------------------ 乱数（再現できる。xorshift128+ を 32 ビットで）
  function makeRng(seed) {
    // 状態は型付き配列に置く（ふつうの変数だと 2^30 を超える数のたびにメモリを取ってしまい、PC が混んでいると遅い）
    const st = new Int32Array(4);
    st[0] = (seed >>> 0) || 0x9e3779b9; st[1] = 0x243f6a88 ^ st[0]; st[2] = 0xb7e15162 | 0; st[3] = 0x12345678 ^ Math.imul(seed | 0, 31);
    const next = () => {
      const t = st[0] ^ (st[0] << 11);
      st[0] = st[1]; st[1] = st[2]; st[2] = st[3];
      st[3] = st[3] ^ (st[3] >>> 19) ^ (t ^ (t >>> 8));
      return st[3];
    };
    for (let i = 0; i < 16; i++) next();
    const r = () => (next() >>> 0) / 4294967296;
    r.int = n => (next() >>> 0) % n;
    r.u32 = () => next() >>> 0;
    return r;
  }
  function shuffledDeck(rng) {
    const d = [];
    for (let i = 0; i < 52; i++) d.push(i);
    for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }

  // ------------------------------------------------------------------ 1ハンドの進行
  // stacks: 参加する席のチップ（席順。0 の人は入れない）。button: ボタンの人（stacks の添字）
  function newHand(o) {
    const n = o.stacks.length;
    if (n < 2) throw new Error('2人以上いります');
    const s = {
      n, sb: o.sb, bb: o.bb, ante: o.ante || 0, button: o.button % n,
      start: o.stacks.slice(), stack: o.stacks.slice(),
      bet: new Array(n).fill(0), contrib: new Array(n).fill(0),
      folded: new Array(n).fill(false), allin: new Array(n).fill(false),
      acted: new Array(n).fill(false), seen: new Array(n).fill(-1),
      hole: new Array(n).fill(null), board: [],
      street: 0, phase: 'hole', need: 0, toAct: -1,
      curBet: 0, minRaise: o.bb, fullRaises: 0,
      raises: 0, callers: 0, lastAgg: -1, prevAgg: -1, aggCount: 0,
      sbSeat: -1, bbSeat: -1,
      log: [], result: null,
    };
    // アンティ
    if (s.ante > 0) for (let p = 0; p < n; p++) { const a = Math.min(s.ante, s.stack[p]); s.stack[p] -= a; s.contrib[p] += a; if (!s.stack[p]) s.allin[p] = true; logE(s, { p, t: 'ante', amt: a, st: 0 }); }
    // ブラインド（2人のときはボタンが SB）
    const sbSeat = n === 2 ? s.button : (s.button + 1) % n, bbSeat = (sbSeat + 1) % n;
    s.sbSeat = sbSeat; s.bbSeat = bbSeat;
    post(s, sbSeat, s.sb, 'sb');
    post(s, bbSeat, s.bb, 'bb');
    s.curBet = Math.max(s.bb, s.bet[sbSeat], s.bet[bbSeat]);
    return s;
  }
  function post(s, p, amt, t) {
    const a = Math.min(amt, s.stack[p]);
    s.stack[p] -= a; s.bet[p] += a; s.contrib[p] += a;
    if (!s.stack[p]) s.allin[p] = true;
    logE(s, { p, t, amt: a, to: s.bet[p], st: 0, allin: s.allin[p] });
  }
  // 手札を配る（holes[p] = [c, c] か、見えない分は null）
  function dealHole(s, holes) {
    if (s.phase !== 'hole') throw new Error('手札を配る場面ではありません');
    for (let p = 0; p < s.n; p++) s.hole[p] = holes && holes[p] ? holes[p].slice() : null;
    s.phase = 'bet';
    logE(s, { t: 'hole', st: 0 });
    startRound(s, s.n === 2 ? s.button : (s.bbSeat + 1) % s.n);
  }
  const live = s => { let k = 0; for (let p = 0; p < s.n; p++) if (!s.folded[p]) k++; return k; };
  const canActCount = s => { let k = 0; for (let p = 0; p < s.n; p++) if (!s.folded[p] && !s.allin[p]) k++; return k; };
  // その人がまだ行動しなければならないか
  function needsAct(s, p) {
    if (s.folded[p] || s.allin[p]) return false;
    // 自分以外に行動できる人がいなくて、オールインの人の額に足りていれば、もうすることはない
    let others = false, maxOther = 0;
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) { if (!s.allin[q]) others = true; if (s.bet[q] > maxOther) maxOther = s.bet[q]; }
    if (!others && s.bet[p] >= maxOther) return false;
    if (s.bet[p] < s.curBet) return true;
    if (s.acted[p]) return false;
    return others;
  }
  function nextNeeding(s, from) {
    for (let i = 0; i < s.n; i++) { const p = (from + i) % s.n; if (needsAct(s, p)) return p; }
    return -1;
  }
  function startRound(s, first) {
    const p = nextNeeding(s, first);
    if (p < 0) { endStreet(s); return; }
    s.toAct = p;
  }

  // 今の手番の人ができること
  function legal(s) {
    const p = s.toAct;
    if (s.phase !== 'bet' || p < 0) return null;
    let others = false, maxOther = 0;
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) { if (!s.allin[q]) others = true; if (s.bet[q] > maxOther) maxOther = s.bet[q]; }
    const target = others ? s.curBet : Math.min(s.curBet, maxOther);
    const toCall = Math.max(0, Math.min(target - s.bet[p], s.stack[p]));
    const maxTo = s.bet[p] + s.stack[p];
    const reopened = s.seen[p] < 0 || s.seen[p] < s.fullRaises;
    const canRaise = others && reopened && maxTo > s.curBet;
    let minTo = s.curBet + Math.max(s.minRaise, s.bb);
    if (s.curBet === 0) minTo = Math.min(s.bb, maxTo);
    if (minTo > maxTo) minTo = maxTo;
    return { p, toCall, canCheck: toCall === 0, canRaise, minTo, maxTo, curBet: s.curBet, pot: potTotal(s), stack: s.stack[p], bet: s.bet[p] };
  }
  function logE(s, e) { if (!s.nolog) s.log.push(e); }
  const potTotal = s => { let t = 0; for (let p = 0; p < s.n; p++) t += s.contrib[p]; return t; };

  // 行動する: {t:'f'} 降りる / {t:'c'} チェック・コール / {t:'r', to} ベット・レイズ（このラウンドの合計額 to まで）
  function act(s, a) {
    const L = legal(s);
    if (!L) throw new Error('行動できる場面ではありません');
    const p = L.p;
    let t = a.t;
    if (t === 'r' && !L.canRaise) t = 'c';
    if (t === 'f') {
      s.folded[p] = true;
      logE(s, { p, t: 'f', st: s.street });
    } else if (t === 'c') {
      const amt = L.toCall;
      putIn(s, p, amt);
      if (amt > 0) s.callers++;
      logE(s, { p, t: amt > 0 ? 'c' : 'x', amt, to: s.bet[p], st: s.street, allin: s.allin[p] });
    } else if (t === 'r') {
      let to = Math.round(+a.to);
      if (!(to >= L.minTo)) to = L.minTo;
      if (to > L.maxTo) to = L.maxTo;
      const prev = s.curBet;
      putIn(s, p, to - s.bet[p]);
      const size = to - prev;
      if (size >= s.minRaise || (prev === 0 && size >= s.bb)) { s.minRaise = Math.max(size, s.bb); s.fullRaises++; }
      if (to > prev) {
        s.curBet = to;
        for (let q = 0; q < s.n; q++) if (q !== p) s.acted[q] = false;
        s.raises++; s.aggCount++; s.callers = 0; s.lastAgg = p;
      }
      logE(s, { p, t: prev === 0 ? 'b' : 'r', amt: size, to, st: s.street, allin: s.allin[p] });
    } else throw new Error('知らない行動: ' + a.t);
    s.acted[p] = true; s.seen[p] = s.fullRaises;
    advance(s, p);
  }
  function putIn(s, p, amt) {
    s.stack[p] -= amt; s.bet[p] += amt; s.contrib[p] += amt;
    if (s.stack[p] <= 0) { s.stack[p] = 0; s.allin[p] = true; }
  }
  function advance(s, p) {
    if (live(s) === 1) { returnUncalled(s); finishFold(s); return; }
    const q = nextNeeding(s, (p + 1) % s.n);
    if (q < 0) endStreet(s); else s.toAct = q;
  }
  // だれも合わせていない分の賭けを返す
  function returnUncalled(s) {
    let hi = -1, top = -1, second = -1;
    for (let p = 0; p < s.n; p++) {
      if (s.bet[p] > top) { second = top; top = s.bet[p]; hi = p; } else if (s.bet[p] > second) second = s.bet[p];
    }
    if (hi >= 0 && top > second && second >= 0) {
      const back = top - second;
      s.bet[hi] -= back; s.contrib[hi] -= back; s.stack[hi] += back;
      if (s.stack[hi] > 0) s.allin[hi] = false;
      logE(s, { p: hi, t: 'return', amt: back, st: s.street });
    }
  }
  function endStreet(s) {
    returnUncalled(s);
    for (let p = 0; p < s.n; p++) { s.bet[p] = 0; s.acted[p] = false; s.seen[p] = -1; }
    s.prevAgg = s.lastAgg; s.lastAgg = -1;
    s.curBet = 0; s.minRaise = s.bb; s.fullRaises = 0; s.raises = 0; s.callers = 0;
    s.toAct = -1;
    s.street++;
    if (s.street >= 4) { s.phase = 'show'; s.contenders = []; for (let p = 0; p < s.n; p++) if (!s.folded[p]) s.contenders.push(p); return; }
    s.phase = 'deal'; s.need = s.street === 1 ? 3 : 1;
  }
  // 場のカードを出す
  function deal(s, cards) {
    if (s.phase !== 'deal' || cards.length !== s.need) throw new Error('場のカードを出す場面ではありません');
    for (const c of cards) s.board.push(c);
    logE(s, { t: 'deal', st: s.street, cards: cards.slice() });
    s.phase = 'bet'; s.need = 0;
    // 2人のときも含めて、ボタンの次の人から
    startRound(s, (s.button + 1) % s.n);
  }
  // 全員オールインなどで、もう賭けがないか（残りのカードを続けて出すだけ）
  const runout = s => canActCount(s) <= 1;

  function finishFold(s) {
    let w = -1;
    for (let p = 0; p < s.n; p++) if (!s.folded[p]) w = p;
    const pot = potTotal(s);
    const won = new Array(s.n).fill(0); won[w] = pot;
    for (let p = 0; p < s.n; p++) s.bet[p] = 0;
    s.stack[w] += pot;
    s.phase = 'done'; s.toAct = -1;
    s.result = { byFold: true, pots: [{ amt: pot, elig: [w], win: [w] }], won, net: s.stack.map((x, p) => x - s.start[p]), values: null, contenders: [w] };
    logE(s, { t: 'win', p: w, amt: pot, st: s.street });
  }
  // ショーダウン: holes[p] は残っている人の手札
  function show(s, holes) {
    if (s.phase !== 'show') throw new Error('ショーダウンの場面ではありません');
    if (holes) for (const p of s.contenders) if (holes[p]) s.hole[p] = holes[p].slice();
    const values = new Array(s.n).fill(-1);
    for (const p of s.contenders) {
      if (s.pre) { values[p] = s.pre[p]; continue; }
      if (!s.hole[p]) throw new Error('手札が分かりません');
      values[p] = evaluate(s.hole[p].concat(s.board));
    }
    const pots = sidePots(s);
    const won = new Array(s.n).fill(0);
    for (const pot of pots) {
      let best = -1;
      for (const p of pot.elig) if (values[p] > best) best = values[p];
      const ws = pot.elig.filter(p => values[p] === best);
      // 端数はボタンの左から近い人へ
      ws.sort((a, b) => ((a - s.button - 1 + s.n) % s.n) - ((b - s.button - 1 + s.n) % s.n));
      const share = Math.floor(pot.amt / ws.length);
      let rem = pot.amt - share * ws.length;
      for (const p of ws) { won[p] += share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; }
      pot.win = ws;
    }
    for (let p = 0; p < s.n; p++) s.stack[p] += won[p];
    s.phase = 'done'; s.toAct = -1;
    s.result = { byFold: false, pots, won, net: s.stack.map((x, p) => x - s.start[p]), values, contenders: s.contenders.slice() };
    logE(s, { t: 'show', st: 4 });
  }
  // サイドポット: 賭けた額の段ごとに分け、その段まで賭けて降りていない人がもらえる
  function sidePots(s) {
    const levels = [...new Set(s.contrib.filter(x => x > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amt = 0;
      for (let p = 0; p < s.n; p++) amt += Math.max(0, Math.min(s.contrib[p], lv) - prev);
      const elig = [];
      for (let p = 0; p < s.n; p++) if (!s.folded[p] && s.contrib[p] >= lv) elig.push(p);
      if (amt > 0) {
        if (elig.length) {
          const last = pots[pots.length - 1];
          if (last && last.elig.length === elig.length && last.elig.every((p, i) => p === elig[i])) last.amt += amt;
          else pots.push({ amt, elig });
        } else if (pots.length) pots[pots.length - 1].amt += amt;
      }
      prev = lv;
    }
    return pots;
  }

  // 手元の対局: 山札（deck）から必要なカードを配りながら、人の行動が要る場面かハンドの終わりまで進める
  function autoDeal(s, deck) {
    while (s.phase === 'hole' || s.phase === 'deal' || s.phase === 'show') autoStep(s, deck);
    return s.phase;
  }
  // 1段階だけ進める（演出のため。'hole' → 配る、'deal' → 1回出す、'show' → 開く）
  function autoStep(s, deck) {
    if (s.phase === 'hole') {
      const holes = [];
      for (let p = 0; p < s.n; p++) holes.push([deck[p], deck[p + s.n]]);
      dealHole(s, holes);
    } else if (s.phase === 'deal') {
      const k = 2 * s.n + s.board.length;
      deal(s, deck.slice(k, k + s.need));
    } else if (s.phase === 'show') show(s, null);
    return s.phase;
  }

  const clone = s => JSON.parse(JSON.stringify(s));
  // 学習用の速い複製（記録 log は持たない）
  function fastClone(s) {
    return {
      n: s.n, sb: s.sb, bb: s.bb, ante: s.ante, button: s.button, start: s.start, stack: s.stack.slice(), bet: s.bet.slice(), contrib: s.contrib.slice(),
      folded: s.folded.slice(), allin: s.allin.slice(), acted: s.acted.slice(), seen: s.seen.slice(), hole: s.hole, board: s.board.slice(),
      street: s.street, phase: s.phase, need: s.need, toAct: s.toAct, curBet: s.curBet, minRaise: s.minRaise, fullRaises: s.fullRaises,
      raises: s.raises, callers: s.callers, lastAgg: s.lastAgg, prevAgg: s.prevAgg, aggCount: s.aggCount, sbSeat: s.sbSeat, bbSeat: s.bbSeat,
      log: null, nolog: true, pre: s.pre, result: null, contenders: s.contenders,
    };
  }

  // ------------------------------------------------------------------ 卓（何ハンドも続ける）の小道具
  // ブラインドの段階（シットアンドゴー）。BB を基準に上げていく
  const BLIND_LEVELS = [
    [10, 20], [15, 30], [20, 40], [25, 50], [30, 60], [40, 80], [50, 100], [60, 120], [75, 150], [100, 200],
    [125, 250], [150, 300], [200, 400], [250, 500], [300, 600], [400, 800], [500, 1000], [600, 1200], [800, 1600], [1000, 2000],
    [1250, 2500], [1500, 3000], [2000, 4000], [2500, 5000], [3000, 6000], [4000, 8000], [5000, 10000],
  ];
  // 次のボタン: 前のボタンの左で、チップのある席
  function nextButton(stacks, prev) {
    const n = stacks.length;
    for (let i = 1; i <= n; i++) { const q = (prev + i) % n; if (stacks[q] > 0) return q; }
    return -1;
  }

  // 行動の日本語（ログ・情報の行用）
  function actionText(e, fmt) {
    fmt = fmt || (x => String(x));
    switch (e.t) {
      case 'f': return 'フォールド';
      case 'x': return 'チェック';
      case 'c': return e.allin ? `オールイン（コール ${fmt(e.amt)}）` : `コール ${fmt(e.amt)}`;
      case 'b': return e.allin ? `オールイン ${fmt(e.to)}` : `ベット ${fmt(e.to)}`;
      case 'r': return e.allin ? `オールイン ${fmt(e.to)}` : `レイズ ${fmt(e.to)}`;
      case 'sb': return `SB ${fmt(e.amt)}`;
      case 'bb': return `BB ${fmt(e.amt)}`;
      case 'ante': return `アンティ ${fmt(e.amt)}`;
      default: return '';
    }
  }
  const STREET_NAMES = ['プリフロップ', 'フロップ', 'ターン', 'リバー', 'ショーダウン'];

  return {
    RANKS, SUITS, SUIT_MARK, RANK_JA, CAT_NAMES, STREET_NAMES, BLIND_LEVELS,
    rankOf, suitOf, cardStr, cardJa, parseCard, parseCards,
    evaluate, evalMasks, handCat, handName, handLabel, bestFive, handClass, classLabel,
    makeRng, shuffledDeck,
    newHand, dealHole, legal, act, deal, show, sidePots, autoDeal, autoStep, potTotal, live, canActCount, runout, needsAct, clone, fastClone,
    nextButton, actionText,
    _tables: { TOP, POP, STRAIGHT, TOP5 },
  };
});
