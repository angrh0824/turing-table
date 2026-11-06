/* うそつきダイス（南米に伝わる「ドゥード」の決まり）のルール: 宣言・ダウト・ぴったり・パリフィコ・脱落
 * ブラウザ・Node・Web Worker のどこでも動く（app.js は DudoCore.toString() でワーカーに渡す）
 *
 * 決まり（README と画面のルールにも同じことを書く）
 *  - 2〜6人。はじめは1人5個のサイコロ。ラウンドの始めに全員が振り、自分の目だけ見られる
 *  - 手番の人は「全員の目の中に、目 f が q 個以上ある」と宣言する。1の目はどの目としても数える（ワイルド。1を宣言したときは1だけ）
 *  - 次の人は、もっと大きい宣言をするか、「ダウト」か「ぴったり」をする
 *      大きい宣言: 個数を増やす（目は自由）か、同じ個数でもっと大きい目（2<3<4<5<6）
 *      1への切り替え: 個数は前の個数の半分（切り上げ）以上。1から別の目へ: 前の個数の2倍＋1以上
 *      ラウンドの最初の宣言で1は言えない（パリフィコのラウンドは別）
 *  - ダウト: 全員の目を開ける。宣言どおり（q 個以上）ならダウトした人が、足りなければ宣言した人がサイコロを1個失う
 *  - ぴったり: ちょうど q 個なら言った人がサイコロを1個取り戻す（5個まで）。違えば言った人が1個失う
 *  - サイコロを失った人（取り戻した人）が次のラウンドを始める。0個になった人は抜け、次の人が始める。最後に残った人の勝ち
 *  - パリフィコ: だれかのサイコロがはじめて1個になったら、次のラウンドはその人から始めるパリフィコ。1はワイルドにならず、
 *    最初の宣言の目のまま個数だけを上げる（最初の宣言は1でもよい）。2人だけになったら、パリフィコはもう起きない
 * 行動: 宣言 = q * 8 + f（f = 1..6）、ダウト = DOUBT、ぴったり = CALZA
 */
function DudoCore(S) {
  'use strict';
  const DOUBT = -1, CALZA = -2;
  const MAXD = 5;
  const bid = (q, f) => q * 8 + f, bq = a => a >> 3, bf = a => a & 7;

  // 乱数（xorshift）。種を渡すと同じ目が出る（テスト・自己対局・オンラインの検算に）
  function rng(seed) {
    let s = (seed >>> 0) || 0x9E3779B9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  class Game {
    // n: 人数（2〜6）。opts: { dice: 最初の個数（既定5）, calza: ぴったりあり（既定 true）, palifico: パリフィコあり（既定 true） }
    constructor(n, opts = {}) {
      this.n = n;
      this.calzaOn = opts.calza !== false;
      this.palificoOn = opts.palifico !== false;
      const d0 = opts.dice || MAXD;
      this.dice = new Array(n).fill(d0);      // 持っているサイコロの数
      this.hands = Array.from({ length: n }, () => []);  // 今のラウンドの目（小さい順）
      this.palUsed = new Array(n).fill(false); // パリフィコをもう使ったか
      this.out = [];                           // 抜けた順
      this.starter = 0;                        // 今のラウンドを始めた人
      this.turn = 0;                           // 手番
      this.bids = [];                          // 今のラウンドの宣言 [{ p, a }]
      this.palifico = -1;                      // パリフィコのラウンドなら、その人
      this.round = 0;
      this.last = null;                        // 直前のラウンドの結果
      this.over = false;
    }
    clone() {
      const g = new Game(this.n, { calza: this.calzaOn, palifico: this.palificoOn });
      g.dice = this.dice.slice(); g.hands = this.hands.map(h => h.slice()); g.palUsed = this.palUsed.slice(); g.out = this.out.slice();
      g.starter = this.starter; g.turn = this.turn; g.bids = this.bids.map(b => ({ p: b.p, a: b.a })); g.palifico = this.palifico;
      g.round = this.round; g.last = this.last; g.over = this.over;
      return g;
    }
    alive(p) { return this.dice[p] > 0; }
    aliveCount() { let k = 0; for (let p = 0; p < this.n; p++) if (this.dice[p] > 0) k++; return k; }
    total() { let t = 0; for (let p = 0; p < this.n; p++) t += this.dice[p]; return t; }
    nextAlive(p) { for (let i = 1; i <= this.n; i++) { const q = (p + i) % this.n; if (this.dice[q] > 0) return q; } return p; }
    wild() { return this.palifico < 0; }
    // ラウンドを始める（目を振る）。roll: (p, k) → k 個の目の配列（省略時は rnd で振る）
    startRound(rnd, roll) {
      for (let p = 0; p < this.n; p++) {
        const k = this.dice[p];
        const h = roll ? roll(p, k).slice() : Array.from({ length: k }, () => 1 + Math.floor(rnd() * 6));
        h.sort((a, b) => a - b);
        this.hands[p] = h;
      }
      this.bids = [];
      this.turn = this.starter;
      this.round++;
    }
    cur() { return this.bids.length ? this.bids[this.bids.length - 1].a : 0; }
    // 目 f の数（ワイルドなら1も数える）
    countAll(f) {
      let c = 0;
      for (let p = 0; p < this.n; p++) for (const v of this.hands[p]) if (v === f || (this.wild() && f !== 1 && v === 1)) c++;
      return c;
    }
    countIn(hand, f) { let c = 0; for (const v of hand) if (v === f || (this.wild() && f !== 1 && v === 1)) c++; return c; }
    // a は今の宣言より大きいか
    canBid(a) {
      const q = bq(a), f = bf(a), T = this.total();
      if (f < 1 || f > 6 || q < 1 || q > T) return false;
      const c = this.cur();
      if (!c) return this.palifico >= 0 || f !== 1;
      const cq = bq(c), cf = bf(c);
      if (this.palifico >= 0) return f === cf && q > cq;
      if (cf === 1 && f === 1) return q > cq;
      if (cf !== 1 && f === 1) return q >= Math.ceil(cq / 2);
      if (cf === 1 && f !== 1) return q >= cq * 2 + 1;
      return q > cq || (q === cq && f > cf);
    }
    // 手番の人が選べる行動（宣言は小さい順）
    legal() {
      const out = [], T = this.total();
      for (let q = 1; q <= T; q++) for (let f = 1; f <= 6; f++) { const a = bid(q, f); if (this.canBid(a)) out.push(a); }
      if (this.cur()) { out.push(DOUBT); if (this.calzaOn) out.push(CALZA); }
      return out;
    }
    // 次に言える一番小さい宣言（目 f で）。なければ 0
    minBid(f) {
      for (let q = 1; q <= this.total(); q++) if (this.canBid(bid(q, f))) return bid(q, f);
      return 0;
    }
    // 行動する。ラウンドが終わったら結果を返す（{ kind, caller, bidder, a, count, loser, gainer }）
    act(a) {
      if (this.over) throw new Error('終わっています');
      const p = this.turn;
      if (a > 0) {
        if (!this.canBid(a)) throw new Error('言えない宣言です');
        this.bids.push({ p, a });
        this.turn = this.nextAlive(p);
        return null;
      }
      const c = this.cur();
      if (!c) throw new Error('まだ宣言がありません');
      const bidder = this.bids[this.bids.length - 1].p, q = bq(c), f = bf(c), count = this.countAll(f);
      const r = { kind: a === DOUBT ? 'doubt' : 'calza', caller: p, bidder, a: c, count, loser: -1, gainer: -1, palifico: this.palifico, hands: this.hands.map(h => h.slice()), bids: this.bids.slice() };
      if (a === DOUBT) r.loser = count >= q ? p : bidder;
      else if (count === q) r.gainer = p;
      else r.loser = p;
      this.finishRound(r);
      return r;
    }
    finishRound(r) {
      const wasTwoPlus = this.aliveCount();
      this.palifico = -1;
      if (r.gainer >= 0) { this.dice[r.gainer] = Math.min(MAXD, this.dice[r.gainer] + 1); this.starter = r.gainer; }
      else {
        const L = r.loser;
        this.dice[L]--;
        if (this.dice[L] === 0) {
          this.out.push(L);
          r.eliminated = L;
          this.starter = this.nextAlive(L);
        } else {
          this.starter = L;
          // パリフィコ: はじめて1個になった（3人以上残っているとき）
          if (this.palificoOn && this.dice[L] === 1 && !this.palUsed[L] && wasTwoPlus > 2) { this.palUsed[L] = true; this.palifico = L; r.palNext = L; }
        }
      }
      if (this.aliveCount() <= 1) { this.over = true; r.winner = this.dice.findIndex(d => d > 0); }
      this.last = r;
      this.bids = [];
      this.turn = this.starter;
    }
    // 順位（1位から）。抜けた順の逆
    ranking() {
      const alive = []; for (let p = 0; p < this.n; p++) if (this.dice[p] > 0) alive.push(p);
      return alive.concat(this.out.slice().reverse());
    }
  }

  const FACE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const bidText = a => (a === DOUBT ? 'ダウト' : a === CALZA ? 'ぴったり' : `${bq(a)}個の${bf(a)}`);

  Object.assign(S, { DOUBT, CALZA, MAXD, bid, bq, bf, rng, Game, FACE, bidText });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = DudoCore;
