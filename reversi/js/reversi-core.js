/* リバーシのルール（8×8。黒が先手。置けないときはパス、両方置けなければ終局。石の多い方の勝ち）
 *
 * マスの番号: 0..63 = 行×8 + 列（a1 = 0, h1 = 7, a8 = 56。列 a〜h が左から右、行 1〜8 が上から下）
 * 盤は「手番の側の石 P」と「相手の石 O」を 64 ビットで持つ。JS の整数は 32 ビットなので、
 * それぞれを lo（0..31 = 1〜4行目）と hi（32..63 = 5〜8行目）の2つに分けて扱う（ビットボード）。
 * 探索の中ではこの4つの整数（pl, ph, ol, oh）だけを渡し歩く。手を指すと P と O を入れ替える（手番が変わる）。
 */
function ReversiCore(R) {
  'use strict';
  R = R || {};
  const BLACK = 0, WHITE = 1, PASS = 64;
  const OUT = new Int32Array(2); // 結果を返す場所（lo, hi）

  function popcnt(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0F0F0F0F;
    return Math.imul(x, 0x01010101) >>> 24;
  }
  const popcnt64 = (l, h) => popcnt(l) + popcnt(h);

  // 置けるマス（OUT に返す）。8方向それぞれ「自分の石から相手の石が続き、その先が空き」を一度に調べる。
  // 横に動く方向は、端の列をまたいで隣の行へ回り込まないよう、間の相手の石を b〜g 列に限る（0x7E）
  function genMoves(pl, ph, ol, oh) {
    const el = ~(pl | ol), eh = ~(ph | oh);
    const il = ol & 0x7E7E7E7E, ih = oh & 0x7E7E7E7E;
    let ml = 0, mh = 0, tl, th, nl, nh;
    // 東（+1）・西（−1）は 32 ビットの中で完結する
    tl = il & (pl << 1); tl |= il & (tl << 1); tl |= il & (tl << 1); tl |= il & (tl << 1); tl |= il & (tl << 1); tl |= il & (tl << 1); ml |= el & (tl << 1);
    th = ih & (ph << 1); th |= ih & (th << 1); th |= ih & (th << 1); th |= ih & (th << 1); th |= ih & (th << 1); th |= ih & (th << 1); mh |= eh & (th << 1);
    tl = il & (pl >>> 1); tl |= il & (tl >>> 1); tl |= il & (tl >>> 1); tl |= il & (tl >>> 1); tl |= il & (tl >>> 1); tl |= il & (tl >>> 1); ml |= el & (tl >>> 1);
    th = ih & (ph >>> 1); th |= ih & (th >>> 1); th |= ih & (th >>> 1); th |= ih & (th >>> 1); th |= ih & (th >>> 1); th |= ih & (th >>> 1); mh |= eh & (th >>> 1);
    // 南（+8）
    tl = ol & (pl << 8); th = oh & ((ph << 8) | (pl >>> 24));
    for (let k = 0; k < 5; k++) { nl = tl << 8; nh = (th << 8) | (tl >>> 24); tl |= ol & nl; th |= oh & nh; }
    ml |= el & (tl << 8); mh |= eh & ((th << 8) | (tl >>> 24));
    // 北（−8）
    tl = ol & ((pl >>> 8) | (ph << 24)); th = oh & (ph >>> 8);
    for (let k = 0; k < 5; k++) { nl = (tl >>> 8) | (th << 24); nh = th >>> 8; tl |= ol & nl; th |= oh & nh; }
    ml |= el & ((tl >>> 8) | (th << 24)); mh |= eh & (th >>> 8);
    // 南東（+9）
    tl = il & (pl << 9); th = ih & ((ph << 9) | (pl >>> 23));
    for (let k = 0; k < 5; k++) { nl = tl << 9; nh = (th << 9) | (tl >>> 23); tl |= il & nl; th |= ih & nh; }
    ml |= el & (tl << 9); mh |= eh & ((th << 9) | (tl >>> 23));
    // 南西（+7）
    tl = il & (pl << 7); th = ih & ((ph << 7) | (pl >>> 25));
    for (let k = 0; k < 5; k++) { nl = tl << 7; nh = (th << 7) | (tl >>> 25); tl |= il & nl; th |= ih & nh; }
    ml |= el & (tl << 7); mh |= eh & ((th << 7) | (tl >>> 25));
    // 北東（−7）
    tl = il & ((pl >>> 7) | (ph << 25)); th = ih & (ph >>> 7);
    for (let k = 0; k < 5; k++) { nl = (tl >>> 7) | (th << 25); nh = th >>> 7; tl |= il & nl; th |= ih & nh; }
    ml |= el & ((tl >>> 7) | (th << 25)); mh |= eh & (th >>> 7);
    // 北西（−9）
    tl = il & ((pl >>> 9) | (ph << 23)); th = ih & (ph >>> 9);
    for (let k = 0; k < 5; k++) { nl = (tl >>> 9) | (th << 23); nh = th >>> 9; tl |= il & nl; th |= ih & nh; }
    ml |= el & ((tl >>> 9) | (th << 23)); mh |= eh & (th >>> 9);
    OUT[0] = ml; OUT[1] = mh;
  }

  // 各マスから8方向へ伸びる線（盤の端まで）と、マスのビット
  const SL = new Int32Array(64), SH = new Int32Array(64);
  for (let s = 0; s < 64; s++) { if (s < 32) SL[s] = 1 << s; else SH[s] = 1 << (s - 32); }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const RAY = new Int8Array(64 * 8 * 8).fill(-1), RAYN = new Uint8Array(64 * 8);
  for (let s = 0; s < 64; s++) {
    for (let d = 0; d < 8; d++) {
      let x = (s & 7) + DIRS[d][0], y = (s >> 3) + DIRS[d][1], n = 0;
      while (x >= 0 && x < 8 && y >= 0 && y < 8) { RAY[s * 64 + d * 8 + n++] = y * 8 + x; x += DIRS[d][0]; y += DIRS[d][1]; }
      RAYN[s * 8 + d] = n;
    }
  }

  // マス sq に置いたときに裏返る石（OUT に返す）。置けないマスなら 0
  function flips(pl, ph, ol, oh, sq) {
    let fl = 0, fh = 0;
    for (let d = 0; d < 8; d++) {
      const n = RAYN[sq * 8 + d];
      if (n < 2) continue;
      const b = sq * 64 + d * 8;
      let s = RAY[b];
      if (!((ol & SL[s]) | (oh & SH[s]))) continue;
      let tl = SL[s], th = SH[s];
      for (let k = 1; k < n; k++) {
        s = RAY[b + k];
        if ((ol & SL[s]) | (oh & SH[s])) { tl |= SL[s]; th |= SH[s]; continue; }
        if ((pl & SL[s]) | (ph & SH[s])) { fl |= tl; fh |= th; }
        break;
      }
    }
    OUT[0] = fl; OUT[1] = fh;
  }

  // 終局の石の差（手番の側から見て）。空きマスは勝った側のものとして数える（世界大会と同じ数え方）
  function finalDiff(pl, ph, ol, oh) {
    const p = popcnt(pl) + popcnt(ph), o = popcnt(ol) + popcnt(oh), e = 64 - p - o;
    const d = p - o;
    return d > 0 ? d + e : d < 0 ? d - e : 0;
  }

  // ビットの立っているマスを順に
  function squaresOf(l, h) {
    const out = [];
    for (let x = l; x; x &= x - 1) out.push(31 - Math.clz32(x & -x));
    for (let x = h; x; x &= x - 1) out.push(63 - Math.clz32(x & -x));
    return out;
  }

  const COLS = 'abcdefgh';
  const sqName = s => (s === PASS ? 'パス' : COLS[s & 7] + ((s >> 3) + 1));
  const parseSq = t => {
    const m = /^([a-h])([1-8])$/i.exec(String(t).trim());
    return m ? (Number(m[2]) - 1) * 8 + COLS.indexOf(m[1].toLowerCase()) : -1;
  };

  // ------------------------------------------------------------------ 対局の局面（画面・学習用。探索の中では使わない）
  class Position {
    constructor() {
      // 初期配置: d4・e5 が白、e4・d5 が黒
      this.b = [SL[28] | 0, SH[35] | 0]; // e4(28) d5(35)
      this.w = [SL[27] | 0, SH[36] | 0]; // d4(27) e5(36)
      this.stm = BLACK;
      this.ply = 0;
    }
    clone() {
      const p = Object.create(Position.prototype);
      p.b = this.b.slice(); p.w = this.w.slice(); p.stm = this.stm; p.ply = this.ply;
      return p;
    }
    static fromMoves(moves) {
      const p = new Position();
      for (const m of moves) p.make(m);
      return p;
    }
    // 手番の側を P、相手を O として [pl, ph, ol, oh]
    pov() { return this.stm === BLACK ? [this.b[0], this.b[1], this.w[0], this.w[1]] : [this.w[0], this.w[1], this.b[0], this.b[1]]; }
    at(s) { // 0 = 空き, 1 = 黒, 2 = 白
      if ((this.b[0] & SL[s]) | (this.b[1] & SH[s])) return 1;
      if ((this.w[0] & SL[s]) | (this.w[1] & SH[s])) return 2;
      return 0;
    }
    count(c) { const x = c === BLACK ? this.b : this.w; return popcnt(x[0]) + popcnt(x[1]); }
    empties() { return 64 - this.count(BLACK) - this.count(WHITE); }
    movesMask() { const [pl, ph, ol, oh] = this.pov(); genMoves(pl, ph, ol, oh); return [OUT[0], OUT[1]]; }
    // 指せる手: 置けるマスの一覧。置けるマスがなく相手は置けるなら [PASS]。両方置けなければ []（終局）
    legalMoves() {
      const [pl, ph, ol, oh] = this.pov();
      genMoves(pl, ph, ol, oh);
      if (OUT[0] | OUT[1]) return squaresOf(OUT[0], OUT[1]);
      genMoves(ol, oh, pl, ph);
      return (OUT[0] | OUT[1]) ? [PASS] : [];
    }
    isLegal(m) { return this.legalMoves().includes(m); }
    flipsOf(m) { // 置いたら裏返る石のマス
      if (m === PASS) return [];
      const [pl, ph, ol, oh] = this.pov();
      flips(pl, ph, ol, oh, m);
      return squaresOf(OUT[0], OUT[1]);
    }
    make(m) {
      if (m !== PASS) {
        const [pl, ph, ol, oh] = this.pov();
        flips(pl, ph, ol, oh, m);
        const fl = OUT[0], fh = OUT[1];
        if (!(fl | fh)) throw new Error('置けないマスです: ' + sqName(m));
        const me = this.stm === BLACK ? this.b : this.w, op = this.stm === BLACK ? this.w : this.b;
        me[0] |= fl | SL[m]; me[1] |= fh | SH[m];
        op[0] &= ~fl; op[1] &= ~fh;
      }
      this.stm ^= 1;
      this.ply++;
    }
    isOver() { return this.legalMoves().length === 0; }
    // 終局なら { black, white, winner: BLACK | WHITE | -1（引き分け） }、まだなら null
    result() {
      if (!this.isOver()) return null;
      const bc = this.count(BLACK), wc = this.count(WHITE);
      return { black: bc, white: wc, winner: bc > wc ? BLACK : wc > bc ? WHITE : -1 };
    }
    key() { return [this.b[0], this.b[1], this.w[0], this.w[1], this.stm].join(','); }
  }

  // 棋譜の文字列（f5d6c3… の形。パスは書かない）から手の列（パスを補う）へ
  function parseTranscript(text) {
    const toks = String(text).toLowerCase().match(/[a-h][1-8]/g) || [];
    const pos = new Position(), moves = [];
    for (const t of toks) {
      const s = parseSq(t);
      let legal = pos.legalMoves();
      if (legal.length === 1 && legal[0] === PASS) { pos.make(PASS); moves.push(PASS); legal = pos.legalMoves(); }
      if (!legal.includes(s)) throw new Error(`${moves.filter(m => m !== PASS).length + 1}手目「${t}」は置けません`);
      pos.make(s); moves.push(s);
    }
    const legal = pos.legalMoves();
    if (legal.length === 1 && legal[0] === PASS) { pos.make(PASS); moves.push(PASS); }
    return moves;
  }
  const transcript = moves => moves.filter(m => m !== PASS).map(sqName).join('');

  Object.assign(R, {
    BLACK, WHITE, PASS, OUT, SL, SH, RAY, RAYN, DIRS,
    popcnt, popcnt64, genMoves, flips, finalDiff, squaresOf, sqName, parseSq, Position, parseTranscript, transcript,
  });
  return R;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ReversiCore;
