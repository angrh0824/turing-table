/* ごいた（石川県能登町に伝わる、将棋の駒で遊ぶ4人の札あそび）のルール
 * ブラウザ・Node・Web Worker のどこでも動く（app.js は GoitaCore.toString() でワーカーに渡す）
 *
 * 決まり（能登ごいた保存会の定めをまとめた説明にならう。README と画面の「遊び方」にも同じことを書く）
 *  - 4人。向かい合う2人が味方（席 0 と 2、席 1 と 3）。順番は反時計回り（席の番号の順）
 *  - 駒は32枚: し10（10点）・香4（20点）・馬4（20点）・銀4（30点）・金4（30点）・角2（40点）・飛2（40点）・王2（50点）。1人8枚
 *  - 親が手駒を1枚伏せて置き、1枚を表で出す（攻め）。次の人は、同じ駒を出して受けるか「なし」。受けた人が新しい親になり、新しい駒で攻める
 *  - 親以外の3人が「なし」なら、親は手駒から1枚伏せて、新しい駒で攻める
 *  - 王: 飛・角・金・銀・馬の攻めを王で受けられる（切る）。香・しは切れない。王の攻めはだれも受けられない（攻めた人がまた伏せて攻める）
 *    王で攻められるのは、王がもう1枚表で出ている（または自分で伏せた）とき・自分が王を2枚とも持っているとき・最後の上がりのときだけ
 *  - 手駒を最初に出し切った人の組がその手の勝ち。最後に出した駒の点が入る。残り2枚が同じ駒で、だれも受けずに一巡して
 *    伏せと攻めで出し切ったときは2倍（受けてからの上がりは、同じ駒でも2倍にならない）。上がった人が次の親。先に150点の組の勝ち
 *  - 配ったとき「し」が多い人がいたら:
 *      6枚以上（手役）: その組の勝ちで、6枚なら残り2枚が同じ駒ならその2倍・違えば高い方、7枚なら残り1枚の2倍、8枚なら100点。その人が次の親
 *      味方どうしで5枚ずつ: その組の対局の勝ち
 *      1人だけ5枚: その組が「このまま」か「配り直し」を決める（味方は希望だけを伝える）。配り直しても親は変わらない
 *      相手どうしで5枚ずつ: 両方の組が配り直しを望んだときだけ配り直す
 * 行動: なし = PASS（0）、受けて攻める = 1 + 受け*8 + 攻め、伏せて攻める = 100 + 伏せ*8 + 攻め（駒の種類は 0..7）
 */
function GoitaCore(S) {
  'use strict';
  const SHI = 0, KYO = 1, UMA = 2, GIN = 3, KIN = 4, KAKU = 5, HISHA = 6, OU = 7;
  const COUNT = [10, 4, 4, 4, 4, 2, 2, 2];
  const VALUE = [10, 20, 20, 30, 30, 40, 40, 50];
  const GLYPH = ['し', '香', '馬', '銀', '金', '角', '飛', '王'];
  const NAME = ['し', '香', '馬', '銀', '金', '角', '飛', '王'];
  const PASS = 0;
  const recvAct = (r, t) => 1 + r * 8 + t, leadAct = (f, t) => 100 + f * 8 + t;
  const isLead = a => a >= 100, isRecv = a => a >= 1 && a < 100;
  const aFirst = a => (isLead(a) ? ((a - 100) >> 3) : ((a - 1) >> 3)), aAtk = a => (isLead(a) ? ((a - 100) & 7) : ((a - 1) & 7));
  const team = p => p & 1;
  const canCut = x => x === UMA || x === GIN || x === KIN || x === KAKU || x === HISHA;   // 王で受けられる攻め

  function rng(seed) {
    let s = (seed >>> 0) || 0x9E3779B9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  class Hand {
    // 1つの手（配ってから上がりまで）。hands: 席ごとの種類の枚数（Int8Array(8)）
    constructor(dealer) {
      this.dealer = dealer;
      this.hands = [0, 1, 2, 3].map(() => new Int8Array(8));
      this.played = [[], [], [], []];     // 席ごとに出した駒 { t, fd: 伏せ, role: 'fd' | 'recv' | 'atk' }
      this.turn = dealer;
      this.phase = 'lead';                 // 'lead' = 伏せて攻める番、'respond' = 受けるか「なし」の番
      this.attacker = -1; this.atk = -1; this.passes = 0;
      this.ouOut = false;                  // 王が表で出たか
      this.fdOu = [false, false, false, false];   // 自分で王を伏せたか
      this.over = false; this.winner = -1; this.points = 0; this.doubled = false; this.last = -1;
      this.moves = [];                     // [{ p, a }]
    }
    clone() {
      const h = new Hand(this.dealer);
      h.hands = this.hands.map(x => Int8Array.from(x)); h.played = this.played.map(x => x.slice());
      h.turn = this.turn; h.phase = this.phase; h.attacker = this.attacker; h.atk = this.atk; h.passes = this.passes;
      h.ouOut = this.ouOut; h.fdOu = this.fdOu.slice(); h.over = this.over; h.winner = this.winner; h.points = this.points; h.doubled = this.doubled; h.last = this.last;
      h.moves = this.moves.slice();
      return h;
    }
    size(p) { let n = 0; for (let t = 0; t < 8; t++) n += this.hands[p][t]; return n; }
    // 王で攻めてよいか（attackPieces: 攻めの前に手に残る枚数。攻めが最後の1枚なら上がり）
    ouAttackOk(p, handBefore, left) {
      return this.ouOut || this.fdOu[p] || handBefore[OU] >= 2 || left === 1;
    }
    legal() {
      const p = this.turn, h = this.hands[p], out = [];
      if (this.over) return out;
      if (this.phase === 'lead') {
        const n = this.size(p);
        for (let f = 0; f < 8; f++) {
          if (!h[f]) continue;
          for (let t = 0; t < 8; t++) {
            if (!h[t] || (f === t && h[t] < 2)) continue;
            if (t === OU) {
              const fdOuNow = this.fdOu[p] || f === OU;
              if (!(this.ouOut || fdOuNow || h[OU] >= 2 || n === 2)) continue;
            }
            out.push(leadAct(f, t));
          }
        }
        return out;
      }
      out.push(PASS);
      const x = this.atk;
      if (x === OU) return out;
      const n = this.size(p);
      for (const r of (canCut(x) ? [x, OU] : [x])) {
        if (!h[r]) continue;
        for (let t = 0; t < 8; t++) {
          if (!h[t] || (r === t && h[t] < 2)) continue;
          if (t === OU) {
            const revealed = this.ouOut || r === OU;
            if (!(revealed || this.fdOu[p] || h[OU] >= 2 || n === 2)) continue;
          }
          out.push(recvAct(r, t));
        }
      }
      return out;
    }
    act(a) {
      if (this.over) throw new Error('この手は終わっています');
      const p = this.turn, h = this.hands[p];
      this.moves.push({ p, a });
      if (a === PASS) {
        if (this.phase !== 'respond') throw new Error('なしは受ける番だけ');
        this.passes++;
        if (this.passes >= 3) { this.turn = this.attacker; this.phase = 'lead'; this.passes = 0; }
        else this.turn = (p + 1) % 4;
        return;
      }
      const f = aFirst(a), t = aAtk(a);
      if (isLead(a)) {
        if (this.phase !== 'lead') throw new Error('伏せて攻める番ではありません');
        h[f]--; h[t]--;
        if (h[f] < 0 || h[t] < 0) throw new Error('持っていない駒です');
        this.played[p].push({ t: f, fd: true, role: 'fd' }, { t, fd: false, role: 'atk' });
        if (f === OU) this.fdOu[p] = true;
        if (this.size(p) === 0) return this.finish(p, t, f === t);
      } else {
        if (this.phase !== 'respond') throw new Error('受ける番ではありません');
        h[f]--; h[t]--;
        if (h[f] < 0 || h[t] < 0) throw new Error('持っていない駒です');
        this.played[p].push({ t: f, fd: false, role: 'recv' }, { t, fd: false, role: 'atk' });
        if (f === OU) this.ouOut = true;
        if (this.size(p) === 0) return this.finish(p, t, false);
      }
      if (t === OU) this.ouOut = true;
      this.attacker = p; this.atk = t; this.passes = 0;
      // 王の攻めはだれも受けられない: 攻めた人がまた伏せて攻める
      if (t === OU) { this.turn = p; this.phase = 'lead'; }
      else { this.turn = (p + 1) % 4; this.phase = 'respond'; }
    }
    finish(p, t, doubled) {
      this.over = true; this.winner = p; this.last = t; this.doubled = doubled;
      this.points = VALUE[t] * (doubled ? 2 : 1);
      this.attacker = p; this.atk = t;
    }
  }

  // 配る（32枚を混ぜて8枚ずつ）。deal(rnd) → 席ごとの枚数
  function deal(rnd) {
    const all = [];
    for (let t = 0; t < 8; t++) for (let i = 0; i < COUNT[t]; i++) all.push(t);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = all[i]; all[i] = all[j]; all[j] = x; }
    const hands = [0, 1, 2, 3].map(() => new Int8Array(8));
    for (let i = 0; i < 32; i++) hands[i >> 3][all[i]]++;
    return hands;
  }
  // 配ったときの「し」の役: { kind: 'yaku' | 'win' | 'five' | 'fivefive' | null, p, q, points }
  //  yaku = 6枚以上（p の組がその手の勝ち・points）、win = 味方どうしで5枚ずつ（p の組の対局の勝ち）、
  //  five = 1人だけ5枚（p）、fivefive = 相手どうしで5枚ずつ（p と q）
  function shiCheck(hands) {
    const shi = hands.map(h => h[SHI]);
    for (let p = 0; p < 4; p++) {
      if (shi[p] >= 6) {
        const rest = [];
        for (let t = 1; t < 8; t++) for (let i = 0; i < hands[p][t]; i++) rest.push(t);
        let points;
        if (shi[p] === 8) points = 100;
        else if (shi[p] === 7) points = VALUE[rest[0]] * 2;
        else points = rest[0] === rest[1] ? VALUE[rest[0]] * 2 : Math.max(VALUE[rest[0]], VALUE[rest[1]]);
        return { kind: 'yaku', p, points, shi: shi[p] };
      }
    }
    const five = [0, 1, 2, 3].filter(p => shi[p] === 5);
    if (five.length === 2) return team(five[0]) === team(five[1]) ? { kind: 'win', p: five[0], q: five[1] } : { kind: 'fivefive', p: five[0], q: five[1] };
    if (five.length === 1) return { kind: 'five', p: five[0] };
    return null;
  }

  // 対局（150点先取）
  class Match {
    constructor(opts = {}) {
      this.target = opts.target || 150;
      this.scores = [0, 0];
      this.dealer = opts.dealer != null ? opts.dealer : 0;
      this.hand = null;
      this.handNo = 0;
      this.over = false; this.winTeam = -1;
      this.history = [];   // 手ごとの結果
    }
    // 次の手を配る。roll を渡せば配り方を決められる（テスト用）
    newHand(rnd, hands) {
      const h = new Hand(this.dealer);
      h.hands = hands ? hands.map(x => Int8Array.from(x)) : deal(rnd);
      this.hand = h;
      this.handNo++;
      h.shi = shiCheck(h.hands);
      return h;
    }
    // 手の結果を点に（上がり・手役）
    score(team0, points, kind, p) {
      this.scores[team0] += points;
      this.history.push({ no: this.handNo, team: team0, points, kind, p, dealer: this.dealer });
      if (this.scores[team0] >= this.target) { this.over = true; this.winTeam = team0; }
      this.dealer = p;
    }
    // 上がった手を記録
    settle() {
      const h = this.hand;
      if (!h || !h.over) return null;
      this.score(team(h.winner), h.points, h.doubled ? 'double' : 'out', h.winner);
      return this.history[this.history.length - 1];
    }
    // 手役で決まった手
    settleYaku() {
      const s = this.hand.shi;
      this.hand.over = true; this.hand.winner = s.p; this.hand.points = s.points;
      this.score(team(s.p), s.points, 'yaku', s.p);
      return this.history[this.history.length - 1];
    }
    // 味方どうしで5枚ずつ: 対局の勝ち
    settleWin() {
      const s = this.hand.shi;
      this.over = true; this.winTeam = team(s.p);
      this.history.push({ no: this.handNo, team: team(s.p), points: 0, kind: 'fivefive-win', p: s.p, dealer: this.dealer });
    }
  }

  Object.assign(S, { SHI, KYO, UMA, GIN, KIN, KAKU, HISHA, OU, COUNT, VALUE, GLYPH, NAME, PASS, recvAct, leadAct, isLead, isRecv, aFirst, aAtk, team, canCut, rng, Hand, Match, deal, shiCheck });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = GoitaCore;
