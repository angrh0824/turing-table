/* 量子観測将棋のルール: 盤・正体の決まっていない駒（量子駒）の候補の絞り込み・観測・指し手の生成・千日手・棋譜
 * ブラウザ・Node・Web Worker のどこでも動く（app.js は KansokuCore.toString() でワーカーに渡す）
 *
 * マス: sq = y*9 + x（x = 0 が 9筋・x = 8 が 1筋、y = 0 が一段目）。先手（▲）は下から上へ進む
 * 駒: 種類 t | 手番 c << 4。t は将棋と同じ（1 歩 2 香 3 桂 4 銀 5 金 6 角 7 飛 8 玉、成ると +8）、13 = 量子駒（正体が決まっていない駒）
 *   量子駒の候補は qs[sq]（種類 t をビット t-1 で表す。玉は 128）、成っているかは qp[sq]
 * 指し手: to | from << 7 | 成り << 14 | 観測 << 15（量子駒を取る手で、取った側が決める正体 1..7）。打つ手は from = 81 + 種類
 *
 * 決まり（README と画面のルールにも同じことを書く）
 *  - 並びは平手の将棋と同じ。どの駒も最初は8種類すべての候補を持つ（各側に 玉1 飛1 角1 金2 銀2 桂2 香2 歩9）
 *  - 量子駒は候補のどれかの動きで動ける。動かすと、その動きができる種類だけが候補に残る
 *  - 各側の量子駒の候補は、まだ正体の決まっていない駒の数（残り）と割り当てが必ず合うように絞る（ホールの定理で、合わなくなる候補を全部消す）
 *  - 候補が1つになった駒は正体が決まる（確定）
 *  - 敵陣に入る・出る・中で動くときに成れる。成ると金・玉は候補から外れる。成らずに行き所のなくなる種類（最後の段の歩・香、最後の2段の桂）も外れる
 *  - 量子駒を取ると、取った側がその正体を決める（候補のうち玉以外）。決めた駒を持ち駒にする。決まった分だけ相手の残りの候補も絞られる
 *  - 王手と詰みは玉が確定してから。確定した玉は取れず、王手を放っておく手は指せない。相手の確定した玉を詰ませたら勝ち
 *  - 量子駒の利きは、候補のどれか1つでも届くマス
 *  - 二歩は確定した歩だけで数える。打ち歩詰め・千日手（連続王手は王手をかけた側の負け）・手数制限は将棋と同じ
 */
function KansokuCore(S) {
  'use strict';
  const BLACK = 0, WHITE = 1;
  const FU = 1, KY = 2, KE = 3, GI = 4, KI = 5, KA = 6, HI = 7, OU = 8, TO = 9, NY = 10, NK = 11, NG = 12, QU = 13, UM = 14, RY = 15;
  const bitOf = t => 1 << (t - 1);
  const ALLSET = 255, OUBIT = 128, KEBIT = 4, KIBIT = 16;
  const PROMSET = 0b01101111;                    // 成れる種類: 歩 香 桂 銀 角 飛
  const ALWAYS_PROMOTE = 0b01100001;             // 成らない理由のない種類: 歩 角 飛
  const START_COUNT = [0, 9, 2, 2, 2, 2, 1, 1, 1];
  const MAX_GAME_PLY = 512;            // これを超えたら引き分け（手数制限）
  const MAXPLY = 1400;                 // 局面の履歴の長さ（対局＋探索）
  const ALLPROMO = 2, CAPS = 1;        // 指し手の生成のフラグ: 意味のない不成も出す / 取る手だけ
  const mvTo = m => m & 127, mvFrom = m => (m >> 7) & 127, mvPromo = m => (m >> 14) & 1, mvMeas = m => (m >> 15) & 7;
  const isDrop = m => ((m >> 7) & 127) > 80;
  const mvDrop = m => ((m >> 7) & 127) - 81;
  const mkMove = (from, to, promo, meas) => to | (from << 7) | (promo << 14) | (meas << 15);
  const mkDrop = (t, to) => to | ((81 + t) << 7);
  const canPromoteType = t => t <= 7 && t !== KI;
  const unpromote = t => (t > 8 && t !== QU ? t - 8 : t);
  const inZone = (c, y) => (c === BLACK ? y <= 2 : y >= 6);
  const deadSq = (c, t, y) => (t === FU || t === KY ? (c === BLACK ? y === 0 : y === 8) : t === KE ? (c === BLACK ? y <= 1 : y >= 7) : false);
  const popcnt = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };
  const lowType = m => 32 - Math.clz32(m & -m);   // いちばん小さい種類（ビット → 種類番号）
  const typesOf = m => { const out = []; for (let t = 1; t <= 8; t++) if (m & bitOf(t)) out.push(t); return out; };

  // ------------------------------------------------------------------ 盤の表（将棋と同じ）
  // 方向: 0 上 1 右上 2 右 3 右下 4 下 5 左下 6 左 7 左上（先手から見た盤で。上 = 一段目の方、右 = 1筋の方）
  const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];
  const RAY = new Int8Array(81 * 8 * 8), RAYLEN = new Int8Array(81 * 8);
  for (let sq = 0; sq < 81; sq++) {
    const x = sq % 9, y = (sq / 9) | 0;
    for (let d = 0; d < 8; d++) {
      let n = 0;
      for (let k = 1; k < 9; k++) {
        const nx = x + DX[d] * k, ny = y + DY[d] * k;
        if (nx < 0 || nx > 8 || ny < 0 || ny > 8) break;
        RAY[(sq * 8 + d) * 8 + n++] = ny * 9 + nx;
      }
      RAYLEN[sq * 8 + d] = n;
    }
  }
  // (dy, dx) の符号 → 方向
  const DIR = new Int8Array(9).fill(-1);
  for (let d = 0; d < 8; d++) DIR[(DY[d] + 1) * 3 + DX[d] + 1] = d;
  const KNT = new Int8Array(2 * 81 * 2).fill(-1);
  for (let c = 0; c < 2; c++) for (let sq = 0; sq < 81; sq++) {
    const x = sq % 9, y = (sq / 9) | 0, ny = c === BLACK ? y - 2 : y + 2;
    if (ny < 0 || ny > 8) continue;
    if (x > 0) KNT[(c * 81 + sq) * 2] = ny * 9 + x - 1;
    if (x < 8) KNT[(c * 81 + sq) * 2 + 1] = ny * 9 + x + 1;
  }
  const STEP = new Uint8Array(32), SLIDE = new Uint8Array(32);
  {
    const bits = ds => ds.reduce((a, d) => a | (1 << d), 0);
    const GOLD = [0, 1, 7, 2, 6, 4], DIAG = [1, 3, 5, 7], ORTH = [0, 2, 4, 6], ALL = [0, 1, 2, 3, 4, 5, 6, 7];
    const def = { [FU]: [[0], []], [KY]: [[], [0]], [KE]: [[], []], [GI]: [[0, 1, 7, 3, 5], []], [KI]: [GOLD, []], [KA]: [[], DIAG], [HI]: [[], ORTH], [OU]: [ALL, []],
      [TO]: [GOLD, []], [NY]: [GOLD, []], [NK]: [GOLD, []], [NG]: [GOLD, []], [UM]: [ORTH, DIAG], [RY]: [DIAG, ORTH] };
    for (const t in def) {
      const [st, sl] = def[t];
      STEP[t] = bits(st); SLIDE[t] = bits(sl);
      STEP[16 + +t] = bits(st.map(d => (d + 4) & 7)); SLIDE[16 + +t] = bits(sl.map(d => (d + 4) & 7));
    }
  }
  // 量子駒の動き: 候補のどれか1つでもできる動き。USTEP/USLIDE[(c*2 + 成)*256 + 候補]
  const USTEP = new Uint8Array(4 * 256), USLIDE = new Uint8Array(4 * 256), UKNIGHT = new Uint8Array(4 * 256);
  // その動きができる種類: TMN = 隣へ1マス、TMF = 2マス以上の滑り。[(c*2 + 成)*8 + 方向]
  const TMN = new Uint8Array(32), TMF = new Uint8Array(32);
  const codeOf = (t, promo) => (promo ? t + 8 : t);
  for (let c = 0; c < 2; c++) for (let P = 0; P < 2; P++) {
    for (let t = 1; t <= 8; t++) {
      if (P && !(PROMSET & bitOf(t))) continue;
      const code = codeOf(t, P) | (c << 4);
      for (let d = 0; d < 8; d++) {
        if (((STEP[code] | SLIDE[code]) >> d) & 1) TMN[(c * 2 + P) * 8 + d] |= bitOf(t);
        if ((SLIDE[code] >> d) & 1) TMF[(c * 2 + P) * 8 + d] |= bitOf(t);
      }
    }
    for (let m = 0; m < 256; m++) {
      let st = 0, sl = 0;
      for (let t = 1; t <= 8; t++) {
        if (!(m & bitOf(t)) || (P && !(PROMSET & bitOf(t)))) continue;
        const code = codeOf(t, P) | (c << 4);
        st |= STEP[code]; sl |= SLIDE[code];
      }
      const k = (c * 2 + P) * 256 + m;
      USTEP[k] = st; USLIDE[k] = sl; UKNIGHT[k] = !P && (m & KEBIT) ? 1 : 0;
    }
  }
  // 成らずに止まれない種類: DEAD[c*9 + 段]
  const DEAD = new Uint8Array(18);
  for (let c = 0; c < 2; c++) for (let y = 0; y < 9; y++) for (const t of [FU, KY, KE]) if (deadSq(c, t, y)) DEAD[c * 9 + y] |= bitOf(t);

  // ------------------------------------------------------------------ 局面の番号（Zobrist。全スレッドで同じになるよう種は固定）
  function rng(seed) {
    return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) | 0; };
  }
  const R = rng(20261106);
  const mkZ = n => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = R(); return a; };
  const ZP1 = mkZ(32 * 81), ZP2 = mkZ(32 * 81);          // 確定した駒
  const ZQ1 = mkZ(4 * 81), ZQ2 = mkZ(4 * 81);            // 量子駒（手番・成り）
  const ZM1 = mkZ(81 * 256), ZM2 = mkZ(81 * 256);        // 量子駒の候補
  const ZH1 = mkZ(16 * 20), ZH2 = mkZ(16 * 20);          // 持ち駒
  const ZL1 = mkZ(18 * 10), ZL2 = mkZ(18 * 10);          // 残り（正体の決まっていない種類の数）
  const ZS1 = R() | 1, ZS2 = R();

  // ------------------------------------------------------------------ 局面
  // 状態はひとつの Uint8Array に並べる（指すたびに丸ごと写して、戻すときは写しを戻す）
  const QS = 81, QP = 162, HD = 243, PL = 259, KG = 277, NST = 280;
  const NONE = 255;
  const START_SQ = (() => {
    const out = [];
    for (const [y, xs] of [[0, [0, 1, 2, 3, 4, 5, 6, 7, 8]], [1, [1, 7]], [2, [0, 1, 2, 3, 4, 5, 6, 7, 8]]]) for (const x of xs) out.push([y * 9 + x, WHITE]);
    for (const [y, xs] of [[6, [0, 1, 2, 3, 4, 5, 6, 7, 8]], [7, [1, 7]], [8, [0, 1, 2, 3, 4, 5, 6, 7, 8]]]) for (const x of xs) out.push([y * 9 + x, BLACK]);
    return out;
  })();

  class Position {
    constructor() {
      const s = this.s = new Uint8Array(NST);
      this.board = s.subarray(0, 81);
      this.qs = s.subarray(QS, QS + 81);
      this.qp = s.subarray(QP, QP + 81);
      this.hand = s.subarray(HD, HD + 16);    // hand[c*8 + t]（t = 1..7）
      this.pool = s.subarray(PL, PL + 18);    // pool[c*9 + t]（t = 1..8）: c の量子駒にまだ割り当てていない種類の数
      this.kingA = s.subarray(KG, KG + 2);    // 確定した玉のマス（まだなら 255）
      this.kingA.fill(NONE);
      this.stk = new Uint8Array(NST * (MAXPLY + 1));
      this.stm = BLACK;
      this.startStm = BLACK;
      this.ply = 0;
      this.mvS = new Int32Array(MAXPLY);
      this.k1S = new Int32Array(MAXPLY + 1);
      this.k2S = new Int32Array(MAXPLY + 1);
      this.chkS = new Uint8Array(MAXPLY + 1);
      // 候補の絞り込みの作業用
      this.wHist = new Int32Array(256); this.wCnt = new Int32Array(256); this.wPool = new Int32Array(256);
      this.wTight = new Int32Array(256); this.wSq = new Int32Array(81); this.wR = new Int16Array(256);
      this.buf = new Int32Array(16384);
    }
    static initial() {
      const p = new Position();
      for (const [sq, c] of START_SQ) { p.board[sq] = QU | (c << 4); p.qs[sq] = ALLSET; }
      for (let c = 0; c < 2; c++) for (let t = 1; t <= 8; t++) p.pool[c * 9 + t] = START_COUNT[t];
      p.rehash();
      return p;
    }
    // 将棋の画面と同じ呼び方（fromMoves(手合割, 手)）でも呼べる。量子観測将棋に手合割はない
    static fromMoves(a, b) {
      const moves = Array.isArray(a) ? a : (b || []);
      const p = Position.initial();
      for (const m of moves) p.make(m);
      return p;
    }
    clone() {
      const p = new Position();
      p.s.set(this.s); p.stm = this.stm; p.startStm = this.startStm;
      p.rehash();
      return p;
    }
    // 状態を文字列に（ワーカーとのやりとり・テスト用。履歴は持たない）
    toKey() { return this.stm + ':' + Array.from(this.s, v => v.toString(16).padStart(2, '0')).join(''); }
    static fromKey(k) {
      const p = new Position(), [stm, hex] = k.split(':');
      for (let i = 0; i < NST; i++) p.s[i] = parseInt(hex.substr(i * 2, 2), 16);
      p.stm = +stm; p.startStm = p.stm;
      p.rehash();
      return p;
    }
    replay() {
      const moves = Array.from(this.mvS.subarray(0, this.ply));
      return Position.fromMoves(moves);
    }

    get h1() { return this.k1S[this.ply]; }
    get h2() { return this.k2S[this.ply]; }
    king(c) { const k = this.kingA[c]; return k === NONE ? -1 : k; }
    handCount(c, t) { return this.hand[c * 8 + t]; }
    inCheck() { return this.chkS[this.ply] === 1; }
    isQ(sq) { return (this.board[sq] & 15) === QU; }
    // 盤の駒の候補（確定した駒は1種類だけのビット）
    setOf(sq) { const p = this.board[sq]; if (!p) return 0; const t = p & 15; return t === QU ? this.qs[sq] : bitOf(unpromote(t)); }
    // c の王の候補の駒のマス
    kingCands(c) {
      const k = this.kingA[c];
      if (k !== NONE) return [k];
      const out = [];
      for (let sq = 0; sq < 81; sq++) { const p = this.board[sq]; if ((p & 15) === QU && (p >> 4) === c && (this.qs[sq] & OUBIT)) out.push(sq); }
      return out;
    }

    hashNow() {
      const s = this.s;
      let h1 = 0, h2 = 0;
      for (let sq = 0; sq < 81; sq++) {
        const p = s[sq];
        if (!p) continue;
        if ((p & 15) === QU) {
          const z = ((p >> 4) * 2 + s[QP + sq]) * 81 + sq, zm = sq * 256 + s[QS + sq];
          h1 ^= ZQ1[z] ^ ZM1[zm]; h2 ^= ZQ2[z] ^ ZM2[zm];
        } else { h1 ^= ZP1[p * 81 + sq]; h2 ^= ZP2[p * 81 + sq]; }
      }
      for (let i = 0; i < 16; i++) { const n = s[HD + i]; if (n) { h1 ^= ZH1[i * 20 + n]; h2 ^= ZH2[i * 20 + n]; } }
      for (let i = 0; i < 18; i++) { const n = s[PL + i]; if (n) { h1 ^= ZL1[i * 10 + n]; h2 ^= ZL2[i * 10 + n]; } }
      if (this.stm) { h1 ^= ZS1; h2 ^= ZS2; }
      this.k1S[this.ply] = h1; this.k2S[this.ply] = h2;
    }
    rehash() {
      this.ply = 0;
      this.hashNow();
      const k = this.kingA[this.stm];
      this.chkS[0] = k !== NONE && this.attacked(k, this.stm ^ 1) ? 1 : 0;
    }

    // ---------------------------------------------------------------- 候補の絞り込み
    // c の量子駒の候補から、残り（pool）との割り当てがどうやっても合わない種類を消す。
    // ホールの定理: 割り当てが合う ⇔ どの種類の組 U でも「候補が U の中に収まる駒の数 ≦ U の残りの数」。
    // 駒 p を種類 t にできない ⇔ 等号の U（ぎりぎりの組）で、t を含み、p の候補が U に収まらないものがある
    propagate(c) {
      const s = this.s, hist = this.wHist, cnt = this.wCnt, pu = this.wPool, tight = this.wTight, sqs = this.wSq, rc = this.wR;
      hist.fill(0);
      let nq = 0;
      const code = QU | (c << 4);
      for (let sq = 0; sq < 81; sq++) if (s[sq] === code) { hist[s[QS + sq]]++; sqs[nq++] = sq; }
      if (!nq) return;
      cnt.set(hist);
      for (let b = 1; b < 256; b <<= 1) for (let U = 0; U < 256; U++) if (U & b) cnt[U] += cnt[U ^ b];
      const pb = PL + c * 9;
      pu[0] = 0;
      for (let U = 1; U < 256; U++) pu[U] = pu[U & (U - 1)] + s[pb + lowType(U)];
      let nt = 0;
      for (let U = 1; U < 255; U++) {
        if (cnt[U] === pu[U]) tight[nt++] = U;
        else if (cnt[U] > pu[U]) throw new Error('量子駒の割り当てが合いません');
      }
      rc.fill(-1);
      for (let i = 0; i < nq; i++) {
        const sq = sqs[i], m = s[QS + sq];
        let r = rc[m];
        if (r < 0) {
          r = 0;
          for (let j = 0; j < nt; j++) { const U = tight[j]; if (m & ~U) r |= U; }
          rc[m] = r;
        }
        const nm = m & ~r;
        if (nm === m) continue;
        if (!nm) throw new Error('候補がなくなりました');
        s[QS + sq] = nm;
      }
      // 候補が1つになった駒は確定させる
      for (let i = 0; i < nq; i++) {
        const sq = sqs[i], m = s[QS + sq];
        if (m & (m - 1)) continue;
        const t = lowType(m);
        s[sq] = codeOf(t, s[QP + sq]) | (c << 4);
        s[QS + sq] = 0; s[QP + sq] = 0;
        s[pb + t]--;
        if (t === OU) s[KG + c] = sq;
      }
    }

    // from → to の動きができる種類（量子駒の絞り込みに使う。滑る道の途中が空いているかは呼ぶ側で確かめてある）
    moveMask(c, P, from, to) {
      const fx = from % 9, fy = (from / 9) | 0, dx = to % 9 - fx, dy = ((to / 9) | 0) - fy;
      if ((dx === 1 || dx === -1) && dy === (c === BLACK ? -2 : 2)) return P ? 0 : KEBIT;
      const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
      if (ax && ay && ax !== ay) return 0;
      const d = DIR[(Math.sign(dy) + 1) * 3 + Math.sign(dx) + 1];
      return ((ax > 1 || ay > 1) ? TMF : TMN)[(c * 2 + P) * 8 + d];
    }
    // 動いたあとの候補（指す前の局面で）
    narrowed(m) {
      const from = mvFrom(m), to = mvTo(m), c = this.stm, P = this.qp[from];
      let nm = this.qs[from] & this.moveMask(c, P, from, to);
      if (mvPromo(m)) nm &= PROMSET; else if (!P) nm &= ~DEAD[c * 9 + ((to / 9) | 0)];
      return nm;
    }

    // ---------------------------------------------------------------- 指す・戻す
    make(m) {
      const i = this.ply, c = this.stm, s = this.s;
      this.stk.set(s, i * NST);
      this.mvS[i] = m;
      const to = m & 127, from = (m >> 7) & 127;
      if (from > 80) {
        const t = from - 81;
        s[HD + c * 8 + t]--;
        s[to] = t | (c << 4);
      } else {
        const p = s[from], cap = s[to];
        let propOpp = false, propSelf = false;
        if (cap) {
          if ((cap & 15) === QU) {
            const T = (m >> 15) & 7;
            s[PL + (c ^ 1) * 9 + T]--; s[HD + c * 8 + T]++;
            s[QS + to] = 0; s[QP + to] = 0;
            propOpp = true;
          } else s[HD + c * 8 + unpromote(cap & 15)]++;
        }
        const promo = (m >> 14) & 1;
        if ((p & 15) === QU) {
          const mask = s[QS + from], P = s[QP + from];
          let nm = mask & this.moveMask(c, P, from, to);
          if (promo) nm &= PROMSET; else if (!P) nm &= ~DEAD[c * 9 + ((to / 9) | 0)];
          s[from] = 0; s[QS + from] = 0; s[QP + from] = 0;
          s[to] = p; s[QS + to] = nm; s[QP + to] = P | promo;
          if (nm !== mask) propSelf = true;
        } else {
          s[from] = 0;
          s[to] = promo ? p + 8 : p;
          if ((p & 15) === OU) s[KG + c] = to;
        }
        if (propOpp) this.propagate(c ^ 1);
        if (propSelf) this.propagate(c);
      }
      this.stm = c ^ 1; this.ply = i + 1;
      this.hashNow();
      const k = s[KG + (c ^ 1)];
      this.chkS[i + 1] = k !== NONE && this.attacked(k, c) ? 1 : 0;
    }
    unmake() {
      const i = --this.ply;
      this.s.set(this.stk.subarray(i * NST, i * NST + NST));
      this.stm ^= 1;
    }
    // 探索のパス（Null Move）。王手されていないときだけ使う
    makeNull() {
      const i = this.ply;
      this.stk.set(this.s, i * NST);
      this.mvS[i] = 0;
      this.k1S[i + 1] = this.k1S[i] ^ ZS1; this.k2S[i + 1] = this.k2S[i] ^ ZS2; this.chkS[i + 1] = 0;
      this.stm ^= 1; this.ply = i + 1;
    }
    unmakeNull() { this.ply--; this.stm ^= 1; }
    // 直前に指した側の確定した玉が取られる形になっていないか（make の後に呼ぶ）
    legalAfter() {
      const c = this.stm ^ 1, k = this.s[KG + c];
      return k === NONE || !this.attacked(k, this.stm);
    }

    // ---------------------------------------------------------------- 利き
    // マス sq に by の駒が利いているか（量子駒は候補のどれかが届けば利いている）
    attacked(sq, by) {
      const s = this.s;
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base], bd = 1 << ((d + 4) & 7);
        for (let k = 0; k < len; k++) {
          const s2 = RAY[base * 8 + k], p = s[s2];
          if (!p) continue;
          if ((p >> 4) === by) {
            let st, sl;
            if ((p & 15) === QU) { const key = (by * 2 + s[QP + s2]) * 256 + s[QS + s2]; st = USTEP[key]; sl = USLIDE[key]; }
            else { st = STEP[p]; sl = SLIDE[p]; }
            if ((sl & bd) || (k === 0 && (st & bd))) return true;
          }
          break;
        }
      }
      const o = ((by ^ 1) * 81 + sq) * 2;
      for (let i = 0; i < 2; i++) {
        const s2 = KNT[o + i];
        if (s2 < 0) continue;
        const p = s[s2];
        if (!p || (p >> 4) !== by) continue;
        if ((p & 15) === KE) return true;
        if ((p & 15) === QU && !s[QP + s2] && (s[QS + s2] & KEBIT)) return true;
      }
      return false;
    }
    // sq に利いている by の駒のマスを out に
    attackers(sq, by, out) {
      const s = this.s;
      let n = 0;
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base], bd = 1 << ((d + 4) & 7);
        for (let k = 0; k < len; k++) {
          const s2 = RAY[base * 8 + k], p = s[s2];
          if (!p) continue;
          if ((p >> 4) === by) {
            let st, sl;
            if ((p & 15) === QU) { const key = (by * 2 + s[QP + s2]) * 256 + s[QS + s2]; st = USTEP[key]; sl = USLIDE[key]; }
            else { st = STEP[p]; sl = SLIDE[p]; }
            if ((sl & bd) || (k === 0 && (st & bd))) out[n++] = s2;
          }
          break;
        }
      }
      const o = ((by ^ 1) * 81 + sq) * 2;
      for (let i = 0; i < 2; i++) {
        const s2 = KNT[o + i];
        if (s2 < 0) continue;
        const p = s[s2];
        if (!p || (p >> 4) !== by) continue;
        if ((p & 15) === KE || ((p & 15) === QU && !s[QP + s2] && (s[QS + s2] & KEBIT))) out[n++] = s2;
      }
      return n;
    }
    // 駒が動けるマス（玉の安全は考えない。画面の「利き」の表示用）
    reach(sq) {
      const s = this.s, p = s[sq], out = [];
      if (!p) return out;
      const c = p >> 4;
      let st, sl, kn;
      if ((p & 15) === QU) { const key = (c * 2 + s[QP + sq]) * 256 + s[QS + sq]; st = USTEP[key]; sl = USLIDE[key]; kn = UKNIGHT[key]; }
      else { st = STEP[p]; sl = SLIDE[p]; kn = (p & 15) === KE; }
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base];
        if (sl & (1 << d)) { for (let k = 0; k < len; k++) { const s2 = RAY[base * 8 + k]; out.push(s2); if (s[s2]) break; } }
        else if ((st & (1 << d)) && len) out.push(RAY[base * 8]);
      }
      if (kn) for (let i = 0; i < 2; i++) { const s2 = KNT[(c * 81 + sq) * 2 + i]; if (s2 >= 0) out.push(s2); }
      return out;
    }

    // ---------------------------------------------------------------- 指し手の生成
    // 盤上の駒の手。flags: CAPS = 取る手だけ、ALLPROMO = 成れるのに成らない歩・角・飛も出す。
    // meas: 量子駒を取るときの正体の選び方（null = 選べるものすべて、配列 = その順で最初に選べる1つだけ）
    genBoard(out, n, flags, meas) {
      const s = this.s, c = this.stm, caps = flags & CAPS;
      for (let from = 0; from < 81; from++) {
        const p = s[from];
        if (!p || (p >> 4) !== c) continue;
        const t = p & 15, fy = (from / 9) | 0, fz = inZone(c, fy);
        if (t === QU) {
          const mask = s[QS + from], P = s[QP + from], key = (c * 2 + P) * 256 + mask, st = USTEP[key], sl = USLIDE[key], tb = (c * 2 + P) * 8;
          for (let d = 0; d < 8; d++) {
            const base = from * 8 + d, len = RAYLEN[base];
            if (!len) continue;
            const lim = (sl >> d) & 1 ? len : (st >> d) & 1 ? 1 : 0;
            for (let k = 0; k < lim; k++) {
              const to = RAY[base * 8 + k], q = s[to];
              if (q && (q >> 4) === c) break;
              if (q || !caps) {
                const nm = mask & (k ? TMF[tb + d] : TMN[tb + d]);
                if (nm) n = this.addQ(out, n, from, to, nm, P, fz, q, flags, meas);
              }
              if (q) break;
            }
          }
          if (UKNIGHT[key]) for (let i = 0; i < 2; i++) {
            const to = KNT[(c * 81 + from) * 2 + i];
            if (to < 0) continue;
            const q = s[to];
            if (q && (q >> 4) === c) continue;
            if (q || !caps) n = this.addQ(out, n, from, to, KEBIT, 0, fz, q, flags, meas);
          }
          continue;
        }
        const st = STEP[p], sl = SLIDE[p];
        for (let d = 0; d < 8; d++) {
          const base = from * 8 + d, len = RAYLEN[base];
          if (!len) continue;
          const lim = (sl >> d) & 1 ? len : (st >> d) & 1 ? 1 : 0;
          for (let k = 0; k < lim; k++) {
            const to = RAY[base * 8 + k], q = s[to];
            if (q && (q >> 4) === c) break;
            if (q || !caps) n = this.addD(out, n, from, to, t, fz, q, flags, meas);
            if (q) break;
          }
        }
        if (t === KE) for (let i = 0; i < 2; i++) {
          const to = KNT[(c * 81 + from) * 2 + i];
          if (to < 0) continue;
          const q = s[to];
          if (q && (q >> 4) === c) continue;
          if (q || !caps) n = this.addD(out, n, from, to, t, fz, q, flags, meas);
        }
      }
      return n;
    }
    // 取る駒が量子駒なら、正体の選び方ごとに手を作る
    measChoices(to, meas) {
      const q = this.s[to];
      if (!q || (q & 15) !== QU) return 0;
      const ms = this.s[QS + to] & ~OUBIT;
      if (!meas) return ms;
      for (let i = 0; i < meas.length; i++) if (ms & bitOf(meas[i])) return bitOf(meas[i]);
      return ms & -ms;
    }
    addD(out, n, from, to, t, fz, q, flags, meas) {
      if (q && (q & 15) === OU) return n;
      const c = this.stm, ty = (to / 9) | 0;
      const pr = canPromoteType(t) && (fz || inZone(c, ty));
      const np = pr ? !deadSq(c, t, ty) && ((flags & ALLPROMO) || !(ALWAYS_PROMOTE & bitOf(t))) : true;
      let ms = this.measChoices(to, meas);
      do {
        const T = ms ? lowType(ms) : 0;
        if (pr) out[n++] = mkMove(from, to, 1, T);
        if (np) out[n++] = mkMove(from, to, 0, T);
        ms &= ms - 1;
      } while (ms);
      return n;
    }
    addQ(out, n, from, to, nm, P, fz, q, flags, meas) {
      if (q && (q & 15) === OU) return n;
      const c = this.stm, ty = (to / 9) | 0;
      let pr = false, np = true;
      if (!P && (fz || inZone(c, ty))) {
        pr = (nm & PROMSET) !== 0;
        const keep = nm & ~DEAD[c * 9 + ty];
        np = keep !== 0 && ((flags & ALLPROMO) || (keep & ~ALWAYS_PROMOTE) !== 0);
      }
      let ms = this.measChoices(to, meas);
      do {
        const T = ms ? lowType(ms) : 0;
        if (pr) out[n++] = mkMove(from, to, 1, T);
        if (np) out[n++] = mkMove(from, to, 0, T);
        ms &= ms - 1;
      } while (ms);
      return n;
    }
    // 打つ手（行き所のない駒・二歩（確定した歩だけ）・打ち歩詰めを除く）
    genDrops(out, n) {
      const s = this.s, c = this.stm, hb = HD + c * 8;
      let any = 0;
      for (let t = 1; t <= 7; t++) if (s[hb + t]) any |= 1 << t;
      if (!any) return n;
      let pawnFiles = 0;
      if (any & (1 << FU)) for (let sq = 0; sq < 81; sq++) if (s[sq] === (FU | (c << 4))) pawnFiles |= 1 << (sq % 9);
      const ek = s[KG + (c ^ 1)], pawnCheckSq = ek !== NONE ? ek + (c === BLACK ? 9 : -9) : -1;
      for (let to = 0; to < 81; to++) {
        if (s[to]) continue;
        const y = (to / 9) | 0;
        for (let t = 1; t <= 7; t++) {
          if (!((any >> t) & 1) || deadSq(c, t, y)) continue;
          if (t === FU) {
            if ((pawnFiles >> (to % 9)) & 1) continue;
            if (to === pawnCheckSq && this.isUchifuzume(to)) continue;
          }
          out[n++] = mkDrop(t, to);
        }
      }
      return n;
    }
    // 歩を to に打つと詰むか（打ち歩詰め）
    isUchifuzume(to) {
      this.make(mkDrop(FU, to));
      const mate = !this.hasLegalMove();
      this.unmake();
      return mate;
    }
    // 指せる手をすべて（意味のない不成も、正体の選び方もすべて）。画面・棋譜・テスト用
    legalMoves() {
      const buf = this.buf;
      let n = this.genBoard(buf, 0, ALLPROMO, null);
      n = this.genDrops(buf, n);
      const out = [];
      for (let i = 0; i < n; i++) {
        const m = buf[i];
        this.make(m);
        if (this.legalAfter()) out.push(m);
        this.unmake();
      }
      return out;
    }
    hasLegalMove() {
      const buf = new Int32Array(16384);
      let n = this.genBoard(buf, 0, 0, null);
      n = this.genDrops(buf, n);
      for (let i = 0; i < n; i++) {
        this.make(buf[i]);
        const ok = this.legalAfter();
        this.unmake();
        if (ok) return true;
      }
      return false;
    }
    isLegal(m) { return this.legalMoves().includes(m); }
    perft(d) {
      if (d === 0) return 1;
      const ms = this.legalMoves();
      if (d === 1) return ms.length;
      let n = 0;
      for (const m of ms) { this.make(m); n += this.perft(d - 1); this.unmake(); }
      return n;
    }

    // ---------------------------------------------------------------- 終局
    // 千日手: 同じ局面（盤・候補・持ち駒・残り・手番）が4回。その間ずっと一方が王手をかけていたら、かけていた側の負け
    repetition() {
      const i = this.ply, k1 = this.k1S[i], k2 = this.k2S[i], occ = [i];
      for (let j = i - 2; j >= 0; j -= 2) {
        if (this.mvS[j] === 0 && j < i) break;
        if (this.k1S[j] === k1 && this.k2S[j] === k2) occ.push(j);
      }
      if (occ.length < 4) return null;
      const first = occ[3];
      const mover = j => this.startStm ^ (j & 1);
      for (const X of [BLACK, WHITE]) {
        let any = false, all = true;
        for (let j = first; j < i; j++) if (mover(j) === X) { any = true; if (!this.chkS[j + 1]) { all = false; break; } }
        if (any && all) return { winner: X ^ 1, reason: '連続王手の千日手' };
      }
      return { winner: -1, reason: '千日手' };
    }
    result() {
      if (!this.hasLegalMove()) return { winner: this.stm ^ 1, reason: this.inCheck() ? '詰み' : '指せる手がない' };
      const r = this.repetition();
      if (r) return r;
      if (this.ply >= MAX_GAME_PLY) return { winner: -1, reason: `手数制限（${MAX_GAME_PLY}手）` };
      return null;
    }

    // ---------------------------------------------------------------- 表記
    lastTo() {
      if (!this.ply) return -1;
      const m = this.mvS[this.ply - 1];
      return m ? m & 127 : -1;
    }
    // 画面用の表記（▲７六量・△同角成・▲２二角＝飛（取った量子駒を飛と観測）・▲５五角打）。指す前の局面で呼ぶ
    moveText(m) {
      const c = this.stm, mark = c ? '△' : '▲';
      const to = mvTo(m), from = mvFrom(m), drop = isDrop(m);
      const t = drop ? mvDrop(m) : this.board[from] & 15;
      let s = mark + (this.lastTo() === to ? '同' : sqName(to)) + NAME[t];
      if (drop) {
        if (this.legalMoves().some(x => !isDrop(x) && mvTo(x) === to && this.board[mvFrom(x)] === (t | (c << 4)))) s += '打';
        return s;
      }
      if (t !== QU) s += this.relText(m);
      else s += `(${9 - (from % 9)}${((from / 9) | 0) + 1})`;
      if (mvPromo(m)) s += '成';
      else if (this.promoAsked(m)) s += '不成';
      if (mvMeas(m)) s += '＝' + NAME[mvMeas(m)];
      return s;
    }
    // その手で成る・成らないを選べたか
    promoAsked(m) {
      if (isDrop(m)) return false;
      const c = this.stm, from = mvFrom(m), to = mvTo(m), p = this.board[from], t = p & 15;
      if (!(inZone(c, (from / 9) | 0) || inZone(c, (to / 9) | 0))) return false;
      if (t === QU) return !this.qp[from] && (this.qs[from] & this.moveMask(c, 0, from, to) & PROMSET) !== 0;
      return canPromoteType(t);
    }
    // 同じ確定した駒が2枚以上その場所へ行けるときの「上・引・寄・右・左・直」
    relText(m) {
      const to = mvTo(m), from = mvFrom(m), p = this.board[from], c = p >> 4, t = p & 15;
      const others = [];
      for (const x of this.legalMoves()) {
        const f = mvFrom(x);
        if (!isDrop(x) && mvTo(x) === to && f !== from && this.board[f] === p && !others.includes(f)) others.push(f);
      }
      if (!others.length) return '';
      const ty = (to / 9) | 0;
      const dirOf = f => { const dy = (((f / 9) | 0) - ty) * (c === BLACK ? 1 : -1); return dy > 0 ? '上' : dy < 0 ? '引' : '寄'; };
      const rx = f => (c === BLACK ? f % 9 : 8 - (f % 9));
      const mine = dirOf(from);
      if (others.every(f => dirOf(f) !== mine)) return mine;
      const dh = t === UM || t === RY;
      const posOf = list => {
        if (!dh && from % 9 === to % 9 && mine === '上') return '直';
        if (list.every(f => rx(f) < rx(from))) return '右';
        if (list.every(f => rx(f) > rx(from))) return '左';
        return '';
      };
      const pos = posOf(others);
      if (pos) return pos;
      const same = others.filter(f => dirOf(f) === mine), pos2 = posOf(same);
      return pos2 === '直' ? '直' : pos2 + mine;
    }
    // 棋譜ファイルの指し手（７六量(77)・同　角成(88)＝飛・５五角打）。指す前の局面で呼ぶ
    kifText(m) {
      const c = this.stm, to = mvTo(m), from = mvFrom(m), drop = isDrop(m);
      const t = drop ? mvDrop(m) : this.board[from] & 15, nm = NAME[t];
      let s = this.lastTo() === to ? (nm.length === 1 ? '同　' : '同') : sqName(to);
      s += nm;
      if (drop) return s + '打';
      if (mvPromo(m)) s += '成';
      else if (this.promoAsked(m)) s += '不成';
      s += `(${9 - (from % 9)}${((from / 9) | 0) + 1})`;
      if (mvMeas(m)) s += '＝' + NAME[mvMeas(m)];
      void c;
      return s;
    }
  }

  const FW = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const NAME = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '成香', '成桂', '成銀', '量', '馬', '龍'];
  const GLYPH = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍']; // 駒に書く1文字
  const sqName = sq => FW[9 - (sq % 9)] + KN[((sq / 9) | 0) + 1];

  // ------------------------------------------------------------------ 棋譜（KIF に似た独自の形式）
  // game = { moves, names: [先手, 後手], result: {winner, reason}, date }
  function toKIF(game) {
    const d = game.date ? new Date(game.date) : new Date();
    const z = n => String(n).padStart(2, '0');
    const lines = ['# ---- チューリング・テーブル 量子観測将棋 棋譜ファイル ----',
      '# 量子観測将棋はチューリング・テーブルの自作の将棋です（量は正体の決まっていない駒、＝のあとは取った駒の観測）',
      `開始日時：${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`,
      '手合割：量子観測将棋',
      `先手：${(game.names && game.names[0]) || ''}`, `後手：${(game.names && game.names[1]) || ''}`,
      '手数----指手---------消費時間--'];
    const p = Position.initial();
    game.moves.forEach((m, i) => { lines.push(`${String(i + 1).padStart(4)} ${p.kifText(m)}`); p.make(m); });
    const r = game.result;
    if (r) {
      const n = game.moves.length + 1;
      const word = r.reason === '投了' ? '投了' : r.reason === '詰み' ? '詰み' : /千日手/.test(r.reason) ? '千日手' : r.reason === '時間切れ' ? '切れ負け' : '中断';
      lines.push(`${String(n).padStart(4)} ${word}`);
      lines.push(r.winner < 0 ? `まで${n - 1}手で${r.reason}` : `まで${n - 1}手で${r.winner === BLACK ? '先手' : '後手'}の勝ち`);
    }
    return lines.join('\n') + '\n';
  }
  // 棋譜ファイルを読む（この形式の「(77)」の元のマスと「＝」の観測で手を決める）
  function parseKIF(text) {
    const p = Position.initial(), moves = [];
    const digit = ch => '１２３４５６７８９'.indexOf(ch) + 1 || +ch;
    const kanji = ch => '一二三四五六七八九'.indexOf(ch) + 1 || +ch;
    const PT = {}; NAME.forEach((nm, t) => { if (nm) PT[nm] = t; });
    let result = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const mm = line.match(/^(\d+)\s+(.*)$/);
      if (!mm) continue;
      const body = mm[2].trim();
      if (/^(投了|詰み|千日手|切れ負け|中断)/.test(body)) {
        if (/^投了/.test(body)) result = { winner: p.stm ^ 1, reason: '投了' };
        break;
      }
      const m2 = body.match(/^(?:([１-９1-9])([一二三四五六七八九1-9])|同\s*)(成香|成桂|成銀|[歩香桂銀金角飛玉と馬龍量])(成|不成|打)?(?:\((\d)(\d)\))?(?:＝([歩香桂銀金角飛]))?/);
      if (!m2) throw new Error(`${moves.length + 1}手目「${body}」が読めません`);
      const to = m2[1] ? (kanji(m2[2]) - 1) * 9 + (9 - digit(m2[1])) : p.lastTo();
      if (to < 0) throw new Error(`${moves.length + 1}手目「${body}」: 「同」の前の手がありません`);
      const fl = m2[4] || '';
      let m;
      if (fl === '打') m = mkDrop(PT[m2[3]], to);
      else {
        if (!m2[5]) throw new Error(`${moves.length + 1}手目「${body}」: 元のマスがありません`);
        const from = (+m2[6] - 1) * 9 + (9 - +m2[5]);
        m = mkMove(from, to, fl === '成' ? 1 : 0, m2[7] ? PT[m2[7]] : 0);
      }
      if (!p.legalMoves().includes(m)) throw new Error(`${moves.length + 1}手目「${body}」は指せない手です`);
      moves.push(m);
      p.make(m);
    }
    return { moves, result };
  }

  Object.assign(S, {
    BLACK, WHITE, FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, QU, UM, RY, MAX_GAME_PLY, MAXPLY, ALLPROMO, CAPS,
    ALLSET, OUBIT, KEBIT, KIBIT, PROMSET, START_COUNT, NONE, NST,
    mvTo, mvFrom, mvPromo, mvMeas, isDrop, mvDrop, mkMove, mkDrop, canPromoteType, unpromote, inZone, deadSq, bitOf, popcnt, lowType, typesOf, codeOf,
    DX, DY, RAY, RAYLEN, KNT, STEP, SLIDE, USTEP, USLIDE, UKNIGHT, TMN, TMF, DEAD,
    Position, NAME, GLYPH, FW, KN, sqName, toKIF, parseKIF,
  });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = KansokuCore;
