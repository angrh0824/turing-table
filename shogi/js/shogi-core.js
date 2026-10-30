/* 将棋のルール: 盤・指し手の生成（合法手）・千日手・入玉宣言（27点法）・駒落ち・棋譜（KIF）
 * ブラウザ・Node・Web Worker のどこでも動く（app.js は ShogiCore.toString() でワーカーに渡す）
 *
 * マス: sq = y*9 + x（x = 0 が 9筋・x = 8 が 1筋、y = 0 が一段目）。先手（▲）は下から上へ進む
 * 駒: 種類 t（1 歩 2 香 3 桂 4 銀 5 金 6 角 7 飛 8 玉、成ると +8: 9 と 10 成香 11 成桂 12 成銀 14 馬 15 龍）| 手番 c << 4
 * 指し手: to | from << 7 | 成り << 14。打つ手は from = 81 + 種類。入玉宣言は DECLARE（1 << 15）
 */
function ShogiCore(S) {
  'use strict';
  const BLACK = 0, WHITE = 1;
  const FU = 1, KY = 2, KE = 3, GI = 4, KI = 5, KA = 6, HI = 7, OU = 8, TO = 9, NY = 10, NK = 11, NG = 12, UM = 14, RY = 15;
  const DECLARE = 1 << 15;
  const MAX_GAME_PLY = 512;            // これを超えたら引き分け（手数制限）
  const MAXPLY = 1400;                 // 局面の履歴の長さ（対局＋探索）
  const mvTo = m => m & 127, mvFrom = m => (m >> 7) & 127, mvPromo = m => (m >> 14) & 1;
  const isDrop = m => ((m >> 7) & 127) > 80;
  const mvDrop = m => ((m >> 7) & 127) - 81;
  const mkMove = (from, to, promo) => to | (from << 7) | (promo << 14);
  const mkDrop = (t, to) => to | ((81 + t) << 7);
  const canPromoteType = t => t <= 7 && t !== KI;
  const unpromote = t => (t > 8 ? t - 8 : t);
  const isBig = t => t === KA || t === HI || t === UM || t === RY;
  const inZone = (c, y) => (c === BLACK ? y <= 2 : y >= 6);
  // 行き所のない駒: 歩・香は最後の段、桂は最後の2段に「成らずに」行けない・打てない
  const deadSq = (c, t, y) => (t === FU || t === KY ? (c === BLACK ? y === 0 : y === 8) : t === KE ? (c === BLACK ? y <= 1 : y >= 7) : false);

  // ------------------------------------------------------------------ 盤の表
  // 方向: 0 上 1 右上 2 右 3 右下 4 下 5 左下 6 左 7 左上（先手から見た盤で。上 = 一段目の方）
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
  // 桂の行き先: KNT[(c*81+sq)*2 + i]（なければ -1）
  const KNT = new Int8Array(2 * 81 * 2).fill(-1);
  for (let c = 0; c < 2; c++) for (let sq = 0; sq < 81; sq++) {
    const x = sq % 9, y = (sq / 9) | 0, ny = c === BLACK ? y - 2 : y + 2;
    if (ny < 0 || ny > 8) continue;
    if (x > 0) KNT[(c * 81 + sq) * 2] = ny * 9 + x - 1;
    if (x < 8) KNT[(c * 81 + sq) * 2 + 1] = ny * 9 + x + 1;
  }
  // 駒ごとの動き（8方向のビット）: STEP = 1マス、SLIDE = どこまでも。駒の番号 p = t | c << 4 で引く
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

  // ------------------------------------------------------------------ 局面の番号（Zobrist。全スレッドで同じになるよう種は固定）
  function rng(seed) {
    return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) | 0; };
  }
  const R = rng(20261024);
  const ZP1 = new Int32Array(32 * 81), ZP2 = new Int32Array(32 * 81);
  for (let i = 0; i < 32 * 81; i++) { ZP1[i] = R(); ZP2[i] = R(); }
  const ZH1 = new Int32Array(16 * 19), ZH2 = new Int32Array(16 * 19);
  for (let i = 0; i < 16 * 19; i++) if (i % 19) { ZH1[i] = R(); ZH2[i] = R(); }
  const ZS1 = R() | 1, ZS2 = R();

  // ------------------------------------------------------------------ 駒落ち（上手 = 後手の側が駒を落として先に指す）
  const HANDICAPS = {
    hirate: { name: '平手', remove: [] },
    kyo: { name: '香落ち', remove: [8] },
    kaku: { name: '角落ち', remove: [16] },
    hisha: { name: '飛車落ち', remove: [10] },
    hikyo: { name: '飛香落ち', remove: [10, 8] },
    nimai: { name: '二枚落ち', remove: [10, 16] },
    yonmai: { name: '四枚落ち', remove: [10, 16, 0, 8] },
    rokumai: { name: '六枚落ち', remove: [10, 16, 0, 8, 1, 7] },
  };
  const HANDICAP_KEYS = Object.keys(HANDICAPS);
  const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
  const SFEN_T = { P: FU, L: KY, N: KE, S: GI, G: KI, B: KA, R: HI, K: OU };
  const SFEN_C = ['', 'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K'];

  // ------------------------------------------------------------------ 局面
  class Position {
    constructor() {
      this.board = new Int8Array(81);
      this.hand = new Int8Array(16);   // hand[c*8 + t]（t = 1..7）
      this.king = new Int8Array([-1, -1]);
      this.stm = BLACK;
      this.ply = 0;
      this.mvS = new Int32Array(MAXPLY);       // ply 番目に指した手
      this.capS = new Int8Array(MAXPLY);       // 取った駒
      this.pcS = new Int8Array(MAXPLY);        // 動かした駒（動かす前）
      this.k1S = new Int32Array(MAXPLY + 1);   // ply 番目の局面の番号
      this.k2S = new Int32Array(MAXPLY + 1);
      this.chkS = new Uint8Array(MAXPLY + 1);  // ply 番目の局面で手番の側が王手されているか
      this.startStm = BLACK;
      this.handicap = 'hirate';
      this.bonus = [0, 0];                     // 入玉宣言の点数に足す分（駒落ちの上手が落とした駒）
      this.declared = -1;
      this.buf = new Int32Array(1024);         // 打ち歩詰めの確かめに使う作業用
      this.m1buf = new Int32Array(1024);       // 1手詰めの候補
      this.m1near = new Uint8Array(81);
      this.m1att = new Int32Array(16);
    }

    static fromSFEN(sfen) {
      const p = new Position();
      const [bd, side, hand] = sfen.trim().split(/\s+/);
      let y = 0, x = 0, promo = false;
      for (const ch of bd) {
        if (ch === '/') { y++; x = 0; continue; }
        if (ch === '+') { promo = true; continue; }
        if (/[1-9]/.test(ch)) { x += +ch; continue; }
        const t0 = SFEN_T[ch.toUpperCase()];
        if (!t0) throw new Error('SFEN の駒が読めません: ' + ch);
        const c = ch === ch.toUpperCase() ? BLACK : WHITE, t = promo ? t0 + 8 : t0;
        p.board[y * 9 + x] = t | (c << 4);
        if (t === OU) p.king[c] = y * 9 + x;
        x++; promo = false;
      }
      p.stm = side === 'w' ? WHITE : BLACK;
      if (hand && hand !== '-') {
        let n = 0;
        for (const ch of hand) {
          if (/[0-9]/.test(ch)) { n = n * 10 + +ch; continue; }
          const t = SFEN_T[ch.toUpperCase()], c = ch === ch.toUpperCase() ? BLACK : WHITE;
          p.hand[c * 8 + t] += n || 1; n = 0;
        }
      }
      p.startStm = p.stm;
      p.rehash();
      return p;
    }
    static initial(hc) {
      const p = Position.fromSFEN(START_SFEN), H = HANDICAPS[hc] || HANDICAPS.hirate;
      p.handicap = HANDICAPS[hc] ? hc : 'hirate';
      for (const sq of H.remove) { p.bonus[WHITE] += isBig(p.board[sq] & 15) ? 5 : 1; p.board[sq] = 0; }
      if (H.remove.length) p.stm = WHITE;
      p.startStm = p.stm;
      p.rehash();
      return p;
    }
    static fromMoves(hc, moves) {
      const p = Position.initial(hc);
      for (const m of moves) p.make(m);
      return p;
    }
    rehash() {
      let h1 = 0, h2 = 0;
      for (let sq = 0; sq < 81; sq++) { const q = this.board[sq]; if (q) { h1 ^= ZP1[q * 81 + sq]; h2 ^= ZP2[q * 81 + sq]; } }
      for (let i = 0; i < 16; i++) { h1 ^= ZH1[i * 19 + this.hand[i]]; h2 ^= ZH2[i * 19 + this.hand[i]]; }
      if (this.stm) { h1 ^= ZS1; h2 ^= ZS2; }
      this.ply = 0;
      this.k1S[0] = h1; this.k2S[0] = h2;
      this.chkS[0] = this.king[this.stm] >= 0 && this.attacked(this.king[this.stm], this.stm ^ 1) ? 1 : 0;
    }
    toSFEN() {
      let s = '';
      for (let y = 0; y < 9; y++) {
        let e = 0;
        for (let x = 0; x < 9; x++) {
          const q = this.board[y * 9 + x];
          if (!q) { e++; continue; }
          if (e) { s += e; e = 0; }
          const t = q & 15, ch = SFEN_C[unpromote(t)];
          s += (t > 8 ? '+' : '') + (q >> 4 ? ch.toLowerCase() : ch);
        }
        if (e) s += e;
        if (y < 8) s += '/';
      }
      let h = '';
      for (const c of [BLACK, WHITE]) for (const t of [HI, KA, KI, GI, KE, KY, FU]) {
        const n = this.hand[c * 8 + t];
        if (n) h += (n > 1 ? n : '') + (c ? SFEN_C[t].toLowerCase() : SFEN_C[t]);
      }
      return `${s} ${this.stm ? 'w' : 'b'} ${h || '-'} 1`;
    }
    clone() {
      const p = Position.fromSFEN(this.toSFEN());
      p.handicap = this.handicap; p.bonus = this.bonus.slice(); p.startStm = this.startStm;
      return p;
    }
    // ふつうの対局の局面を、最初の局面から指し直して作る（千日手の判定に履歴が要るため）
    replay() {
      const moves = Array.from(this.mvS.subarray(0, this.ply));
      const p = Position.initial(this.handicap);
      for (const m of moves) p.make(m);
      return p;
    }

    // 局面の番号（32ビット2つ）。番号は k1S・k2S にだけ持つ（オブジェクトの数値の欄に入れると V8 の最適化が外れやすい）
    get h1() { return this.k1S[this.ply]; }
    get h2() { return this.k2S[this.ply]; }
    handCount(c, t) { return this.hand[c * 8 + t]; }
    inCheck() { return this.chkS[this.ply] === 1; }

    // ---------------------------------------------------------------- 指す・戻す
    make(m) {
      const i = this.ply, c = this.stm, b = this.board;
      this.mvS[i] = m;
      if (m === DECLARE) {
        this.capS[i] = 0; this.pcS[i] = 0; this.declared = c;
        this.k1S[i + 1] = this.k1S[i]; this.k2S[i + 1] = this.k2S[i]; this.chkS[i + 1] = 0; this.ply = i + 1;
        return;
      }
      const to = m & 127, from = (m >> 7) & 127;
      let h1 = this.k1S[i], h2 = this.k2S[i];
      if (from > 80) {
        const t = from - 81, p = t | (c << 4), hi = c * 8 + t, n = this.hand[hi];
        h1 ^= ZH1[hi * 19 + n] ^ ZH1[hi * 19 + n - 1]; h2 ^= ZH2[hi * 19 + n] ^ ZH2[hi * 19 + n - 1];
        this.hand[hi] = n - 1;
        b[to] = p; h1 ^= ZP1[p * 81 + to]; h2 ^= ZP2[p * 81 + to];
        this.capS[i] = 0; this.pcS[i] = p;
      } else {
        const p = b[from], cap = b[to];
        this.pcS[i] = p; this.capS[i] = cap;
        if (cap) {
          const hi = c * 8 + unpromote(cap & 15), n = this.hand[hi];
          h1 ^= ZP1[cap * 81 + to] ^ ZH1[hi * 19 + n] ^ ZH1[hi * 19 + n + 1];
          h2 ^= ZP2[cap * 81 + to] ^ ZH2[hi * 19 + n] ^ ZH2[hi * 19 + n + 1];
          this.hand[hi] = n + 1;
        }
        const np = (m >> 14) & 1 ? p + 8 : p;
        b[from] = 0; b[to] = np;
        h1 ^= ZP1[p * 81 + from] ^ ZP1[np * 81 + to]; h2 ^= ZP2[p * 81 + from] ^ ZP2[np * 81 + to];
        if ((p & 15) === OU) this.king[c] = to;
      }
      this.stm = c ^ 1; this.ply = i + 1;
      this.k1S[i + 1] = h1 ^ ZS1; this.k2S[i + 1] = h2 ^ ZS2;
      const k = this.king[c ^ 1];
      this.chkS[i + 1] = k >= 0 && this.attacked(k, c) ? 1 : 0;
    }
    unmake() {
      const i = --this.ply, m = this.mvS[i];
      if (m === DECLARE) { this.declared = -1; return; }
      const c = this.stm ^ 1, b = this.board;
      this.stm = c;
      const to = m & 127, from = (m >> 7) & 127;
      if (from > 80) { b[to] = 0; this.hand[c * 8 + from - 81]++; }
      else {
        const p = this.pcS[i], cap = this.capS[i];
        b[from] = p; b[to] = cap;
        if (cap) this.hand[c * 8 + unpromote(cap & 15)]--;
        if ((p & 15) === OU) this.king[c] = from;
      }
    }
    // 探索のパス（Null Move）。王手されていないときだけ使う
    makeNull() {
      const i = this.ply;
      this.mvS[i] = 0; this.capS[i] = 0; this.pcS[i] = 0;
      this.k1S[i + 1] = this.k1S[i] ^ ZS1; this.k2S[i + 1] = this.k2S[i] ^ ZS2; this.chkS[i + 1] = 0;
      this.stm ^= 1; this.ply = i + 1;
    }
    unmakeNull() { this.ply--; this.stm ^= 1; }

    // ---------------------------------------------------------------- 利き
    // マス sq に by の駒が利いているか
    attacked(sq, by) {
      const b = this.board;
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base], bit = 1 << ((d + 4) & 7);
        for (let k = 0; k < len; k++) {
          const p = b[RAY[base * 8 + k]];
          if (!p) continue;
          if ((p >> 4) === by && ((SLIDE[p] & bit) || (k === 0 && (STEP[p] & bit)))) return true;
          break;
        }
      }
      // 桂: by の桂が sq に跳べる位置（相手の向きで逆にたどる）
      const kn = KE | (by << 4), o = ((by ^ 1) * 81 + sq) * 2;
      if (KNT[o] >= 0 && b[KNT[o]] === kn) return true;
      if (KNT[o + 1] >= 0 && b[KNT[o + 1]] === kn) return true;
      return false;
    }
    // sq に利いている by の駒のマスを out に（探索の取り合いの見積もりや画面に使う）
    attackers(sq, by, out) {
      const b = this.board;
      let n = 0;
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base], bit = 1 << ((d + 4) & 7);
        for (let k = 0; k < len; k++) {
          const s2 = RAY[base * 8 + k], p = b[s2];
          if (!p) continue;
          if ((p >> 4) === by && ((SLIDE[p] & bit) || (k === 0 && (STEP[p] & bit)))) out[n++] = s2;
          break;
        }
      }
      const kn = KE | (by << 4), o = ((by ^ 1) * 81 + sq) * 2;
      if (KNT[o] >= 0 && b[KNT[o]] === kn) out[n++] = KNT[o];
      if (KNT[o + 1] >= 0 && b[KNT[o + 1]] === kn) out[n++] = KNT[o + 1];
      return n;
    }
    // ある駒が利いているマス（王の安全は考えない。画面の「利き」の表示用）
    reach(sq) {
      const p = this.board[sq], out = [];
      if (!p) return out;
      const c = p >> 4, st = STEP[p], sl = SLIDE[p];
      for (let d = 0; d < 8; d++) {
        const base = sq * 8 + d, len = RAYLEN[base];
        if (sl & (1 << d)) { for (let k = 0; k < len; k++) { const s2 = RAY[base * 8 + k]; out.push(s2); if (this.board[s2]) break; } }
        else if ((st & (1 << d)) && len) out.push(RAY[base * 8]);
      }
      if ((p & 15) === KE) for (let i = 0; i < 2; i++) { const s2 = KNT[(c * 81 + sq) * 2 + i]; if (s2 >= 0) out.push(s2); }
      return out;
    }

    // ---------------------------------------------------------------- 指し手の生成
    // 盤上の駒の手（captures: 1 = 取る手だけ・0 = 取らない手だけ・2 = 両方）。all = 成れるのに成らない歩・角・飛・二段目の香も出す
    genBoard(out, n, captures, all) {
      const b = this.board, c = this.stm;
      for (let from = 0; from < 81; from++) {
        const p = b[from];
        if (!p || (p >> 4) !== c) continue;
        const t = p & 15, st = STEP[p], sl = SLIDE[p], fy = (from / 9) | 0;
        const prom = canPromoteType(t), fz = prom && inZone(c, fy);
        for (let d = 0; d < 8; d++) {
          const base = from * 8 + d, len = RAYLEN[base];
          if (!len) continue;
          const lim = (sl >> d) & 1 ? len : (st >> d) & 1 ? 1 : 0;
          for (let k = 0; k < lim; k++) {
            const to = RAY[base * 8 + k], q = b[to];
            if (q && (q >> 4) === c) break;
            if (captures === 2 || (captures === 1) === !!q) n = this.addMove(out, n, from, to, c, t, fz, all);
            if (q) break;
          }
        }
        if (t === KE) {
          for (let i = 0; i < 2; i++) {
            const to = KNT[(c * 81 + from) * 2 + i];
            if (to < 0) continue;
            const q = b[to];
            if (q && (q >> 4) === c) continue;
            if (captures === 2 || (captures === 1) === !!q) n = this.addMove(out, n, from, to, c, t, fz, all);
          }
        }
      }
      return n;
    }
    addMove(out, n, from, to, c, t, fz, all) {
      if (!canPromoteType(t)) { out[n++] = mkMove(from, to, 0); return n; }
      const ty = (to / 9) | 0;
      if (fz || inZone(c, ty)) {
        out[n++] = mkMove(from, to, 1);
        if (!deadSq(c, t, ty) && (all || !(t === FU || t === KA || t === HI || (t === KY && (c === BLACK ? ty === 1 : ty === 7))))) out[n++] = mkMove(from, to, 0);
      } else out[n++] = mkMove(from, to, 0);
      return n;
    }
    // 打つ手（二歩・行き所のない駒・打ち歩詰めを除く）
    genDrops(out, n) {
      const c = this.stm, b = this.board, hb = c * 8;
      let any = 0;
      for (let t = 1; t <= 7; t++) if (this.hand[hb + t]) any |= 1 << t;
      if (!any) return n;
      let pawnFiles = 0;
      if (any & (1 << FU)) for (let sq = 0; sq < 81; sq++) if (b[sq] === (FU | (c << 4))) pawnFiles |= 1 << (sq % 9);
      const ek = this.king[c ^ 1], pawnCheckSq = ek >= 0 ? ek + (c === BLACK ? 9 : -9) : -1;
      for (let to = 0; to < 81; to++) {
        if (b[to]) continue;
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
    // 歩を to に打つと詰むか（打ち歩詰め）。歩の王手は打つ手では防げないので、相手の盤上の駒の手だけ調べる
    isUchifuzume(to) {
      const c = this.stm;
      this.make(mkDrop(FU, to));
      const buf = this.buf, start = 512;
      const n = this.genBoard(buf, start, 2, false);
      let mate = true;
      for (let i = start; i < n && mate; i++) {
        this.make(buf[i]);
        if (!this.attacked(this.king[c ^ 1], c)) mate = false;
        this.unmake();
      }
      this.unmake();
      return mate;
    }
    // 指せる手をすべて（成る・成らないの両方を含む）。画面・棋譜・perft 用
    legalMoves() {
      const buf = new Int32Array(1024);
      let n = this.genBoard(buf, 0, 2, true);
      n = this.genDrops(buf, n);
      const out = [], c = this.stm;
      for (let i = 0; i < n; i++) {
        this.make(buf[i]);
        if (!this.attacked(this.king[c], c ^ 1)) out.push(buf[i]);
        this.unmake();
      }
      return out;
    }
    hasLegalMove() {
      const buf = new Int32Array(1024), c = this.stm;
      let n = this.genBoard(buf, 0, 2, false);
      n = this.genDrops(buf, n);
      for (let i = 0; i < n; i++) {
        this.make(buf[i]);
        const ok = !this.attacked(this.king[c], c ^ 1);
        this.unmake();
        if (ok) return true;
      }
      return false;
    }
    isLegal(m) {
      if (m === DECLARE) return this.canDeclare();
      return this.legalMoves().includes(m);
    }
    // 1手詰め（玉の近く・桂の位置への手と、香・角・飛の筋への打ちだけを調べる。見つかった詰みは正しいが、全部は見つけない）
    // 手番の側が王手されていないときに呼ぶ。詰ます手（なければ 0）
    mate1() {
      const c = this.stm, ek = this.king[c ^ 1], b = this.board;
      if (ek < 0) return 0;
      const near = this.m1near;
      near.fill(0);
      for (let d = 0; d < 8; d++) { const base = ek * 8 + d, len = RAYLEN[base]; for (let k = 0; k < len; k++) { const s2 = RAY[base * 8 + k]; near[s2] |= k === 0 ? 1 : 2; if (b[s2]) break; } }
      for (let i = 0; i < 2; i++) { const s2 = KNT[((c ^ 1) * 81 + ek) * 2 + i]; if (s2 >= 0) near[s2] |= 4; }
      const buf = this.m1buf, start = 0;
      let n = start;
      // 打つ手（歩は打ち歩詰めなので除く）
      const hb = c * 8;
      for (let s2 = 0; s2 < 81; s2++) {
        if (!near[s2] || b[s2]) continue;
        const y = (s2 / 9) | 0;
        for (let t = 2; t <= 7; t++) {
          if (!this.hand[hb + t] || deadSq(c, t, y)) continue;
          if (t === KE ? !(near[s2] & 4) : (t === KY || t === KA || t === HI) ? !(near[s2] & 3) : !(near[s2] & 1)) continue;
          buf[n++] = mkDrop(t, s2);
        }
      }
      // 盤の駒が玉の隣・桂の位置へ動く手（そのマスに利いている駒から作る。玉は王手をかけられない）
      const att = this.m1att;
      for (let s2 = 0; s2 < 81; s2++) {
        if (!(near[s2] & 5)) continue;
        const q = b[s2];
        if (q && (q >> 4) === c) continue;
        const na = this.attackers(s2, c, att), ty = (s2 / 9) | 0;
        for (let j = 0; j < na; j++) {
          const f = att[j], t = b[f] & 15;
          if (t === OU) continue;
          if (canPromoteType(t) && (inZone(c, ty) || inZone(c, (f / 9) | 0))) {
            buf[n++] = mkMove(f, s2, 1);
            if (!deadSq(c, t, ty)) buf[n++] = mkMove(f, s2, 0);
          } else buf[n++] = mkMove(f, s2, 0);
        }
      }
      for (let i = start; i < n; i++) {
        const m = buf[i];
        this.make(m);
        let mate = false;
        if (this.chkS[this.ply] && !this.attacked(this.king[c], c ^ 1)) mate = !this.kingEscapes() && !this.hasLegalMove();
        this.unmake();
        if (mate) return m;
      }
      return 0;
    }
    // 手番の玉が隣へ逃げられるか（王手の回避のうち、まず玉の移動だけを安く調べる）
    kingEscapes() {
      const c = this.stm, k = this.king[c], b = this.board;
      for (let d = 0; d < 8; d++) {
        if (!RAYLEN[k * 8 + d]) continue;
        const s2 = RAY[(k * 8 + d) * 8], q = b[s2];
        if (q && (q >> 4) === c) continue;
        this.make(mkMove(k, s2, 0));
        const ok = !this.attacked(s2, c ^ 1);
        this.unmake();
        if (ok) return true;
      }
      return false;
    }
    perft(d) {
      if (d === 0) return 1;
      const ms = this.legalMoves();
      if (d === 1) return ms.length;
      let n = 0;
      for (const m of ms) { this.make(m); n += this.perft(d - 1); this.unmake(); }
      return n;
    }

    // ---------------------------------------------------------------- 終局
    // 入玉宣言（27点法）: 手番の側の玉が敵陣・王手されていない・敵陣に玉以外10枚以上・点数（大駒5点・小駒1点、敵陣の駒と持ち駒）が
    // 先に指した側は28点以上、あとの側は27点以上。駒落ちでは上手が落とした駒も上手の点数に入れる
    declareInfo(c) {
      const k = this.king[c], b = this.board;
      let cnt = 0, pts = this.bonus[c];
      for (let sq = 0; sq < 81; sq++) {
        const p = b[sq];
        if (!p || (p >> 4) !== c || (p & 15) === OU || !inZone(c, (sq / 9) | 0)) continue;
        cnt++; pts += isBig(p & 15) ? 5 : 1;
      }
      for (let t = 1; t <= 7; t++) pts += this.hand[c * 8 + t] * (t === KA || t === HI ? 5 : 1);
      const need = c === this.startStm ? 28 : 27;
      const kingIn = k >= 0 && inZone(c, (k / 9) | 0);
      return { kingIn, count: cnt, points: pts, need, ok: kingIn && cnt >= 10 && pts >= need };
    }
    canDeclare() {
      if (this.declared >= 0 || this.chkS[this.ply]) return false;
      return this.declareInfo(this.stm).ok;
    }
    // 千日手: 同じ局面（盤・持ち駒・手番）が4回。その間ずっと一方が王手をかけていたら、かけていた側の負け
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
      if (this.declared >= 0) return { winner: this.declared, reason: '入玉宣言' };
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
      return m && m !== DECLARE ? m & 127 : -1;
    }
    // 画面用の表記（▲７六歩・△同角成・▲５八金右・▲５五角打）。指す前の局面で呼ぶ
    moveText(m) {
      const c = this.stm, mark = c ? '△' : '▲';
      if (m === DECLARE) return mark + '入玉宣言';
      const to = mvTo(m), from = mvFrom(m), drop = isDrop(m);
      const t = drop ? mvDrop(m) : this.board[from] & 15;
      let s = mark + (this.lastTo() === to ? '同' : sqName(to)) + NAME[t];
      if (drop) {
        if (this.legalMoves().some(x => !isDrop(x) && mvTo(x) === to && this.board[mvFrom(x)] === (t | (c << 4)))) s += '打';
        return s;
      }
      s += this.relText(m);
      if (mvPromo(m)) s += '成';
      else if (canPromoteType(t) && (inZone(c, (from / 9) | 0) || inZone(c, (to / 9) | 0))) s += '不成';
      return s;
    }
    // 同じ駒が2枚以上その場所へ行けるときの「上・引・寄・右・左・直」
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
      const rx = f => (c === BLACK ? f % 9 : 8 - (f % 9)); // 大きいほど指す側から見て右
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
    // KIF の指し手（７六歩(77)・同　角成(88)・５五角打・１三桂不成(25)）。指す前の局面で呼ぶ
    kifText(m) {
      if (m === DECLARE) return '入玉勝ち';
      const c = this.stm, to = mvTo(m), from = mvFrom(m), drop = isDrop(m);
      const t = drop ? mvDrop(m) : this.board[from] & 15, nm = KIF_NAME[t];
      let s = this.lastTo() === to ? (nm.length === 1 ? '同　' : '同') : sqName(to);
      s += nm;
      if (drop) return s + '打';
      if (mvPromo(m)) s += '成';
      else if (canPromoteType(t) && (inZone(c, (from / 9) | 0) || inZone(c, (to / 9) | 0))) s += '不成';
      return s + `(${9 - (from % 9)}${((from / 9) | 0) + 1})`;
    }
  }

  const FW = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const KN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const NAME = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '成香', '成桂', '成銀', '', '馬', '龍'];
  const KIF_NAME = NAME;
  const GLYPH = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍']; // 駒に書く1文字
  const sqName = sq => FW[9 - (sq % 9)] + KN[((sq / 9) | 0) + 1];

  // ------------------------------------------------------------------ 棋譜（KIF）
  const pad = (s, n) => (' '.repeat(n) + s).slice(-n);
  // game = { handicap, moves, names: [先手（下手）, 後手（上手）], result: {winner, reason}, date }
  function toKIF(game) {
    const hc = HANDICAPS[game.handicap] ? game.handicap : 'hirate', handi = hc !== 'hirate';
    const d = game.date ? new Date(game.date) : new Date();
    const z = n => String(n).padStart(2, '0');
    const lines = ['# ---- チューリング・テーブル 将棋 棋譜ファイル ----',
      `開始日時：${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`,
      `手合割：${HANDICAPS[hc].name}`,
      `${handi ? '下手' : '先手'}：${(game.names && game.names[0]) || ''}`,
      `${handi ? '上手' : '後手'}：${(game.names && game.names[1]) || ''}`,
      '手数----指手---------消費時間--'];
    const p = Position.initial(hc);
    let n = 0;
    for (const m of game.moves) {
      if (m === DECLARE) break;
      n++;
      lines.push(`${pad(n, 4)} ${p.kifText(m)}`);
      p.make(m);
    }
    const r = game.result;
    if (r) {
      const term = /投了/.test(r.reason) ? '投了' : /入玉宣言/.test(r.reason) ? '入玉勝ち' : /連続王手/.test(r.reason) ? '反則負け' : /千日手/.test(r.reason) ? '千日手'
        : /手数制限|持将棋/.test(r.reason) ? '持将棋' : /詰み|指せる手/.test(r.reason) ? '詰み' : /切れ/.test(r.reason) ? '切れ負け' : '中断';
      lines.push(`${pad(n + 1, 4)} ${term}`);
      const sideName = w => (handi ? (w === WHITE ? '上手' : '下手') : (w === WHITE ? '後手' : '先手'));
      if (r.winner === -1) lines.push(`まで${n}手で${term === '千日手' ? '千日手' : '持将棋'}`);
      else if (term === '反則負け') lines.push(`まで${n}手で${sideName(r.winner ^ 1)}の反則負け`);
      else if (term === '入玉勝ち') lines.push(`まで${n}手で入玉宣言により${sideName(r.winner)}の勝ち`);
      else lines.push(`まで${n}手で${sideName(r.winner)}の勝ち`);
    }
    return lines.join('\n') + '\n';
  }

  const ZEN = '０１２３４５６７８９', KAN = '〇一二三四五六七八九';
  const digit = ch => { let i = ZEN.indexOf(ch); if (i > 0) return i; i = KAN.indexOf(ch); if (i > 0) return i; return /[1-9]/.test(ch) ? +ch : 0; };
  const PIECE_RE = '(成香|成桂|成銀|[歩香桂銀金角飛玉王と杏圭全馬龍竜])';
  const PIECE_T = { '歩': FU, '香': KY, '桂': KE, '銀': GI, '金': KI, '角': KA, '飛': HI, '玉': OU, '王': OU, 'と': TO, '成香': NY, '杏': NY, '成桂': NK, '圭': NK, '成銀': NG, '全': NG, '馬': UM, '龍': RY, '竜': RY };
  // KIF（と KI2 の大部分）を読む。返り値 { handicap, moves, names, result }
  function parseKIF(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    let hc = 'hirate';
    const names = ['', ''];
    const p0 = { v: null };
    let pos = null, result = null;
    const moves = [];
    const ensure = () => { if (!pos) pos = Position.initial(hc); return pos; };
    const re = new RegExp(`^(?:([１-９1-9])([一二三四五六七八九１-９1-9])|同[\\s　]*)${PIECE_RE}(右|左|直|上|引|寄|行|入)*(成|不成|生|打)?(?:\\((\\d)(\\d)\\))?`);
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('*') || line.startsWith('&')) continue;
      let m = line.match(/^手合割[：:]\s*(.+)$/);
      if (m) {
        const nm = m[1].trim();
        const key = HANDICAP_KEYS.find(k => HANDICAPS[k].name === nm || (k === 'hisha' && nm === '飛落ち'));
        if (!key) throw new Error(`手合割「${nm}」には対応していません`);
        hc = key; continue;
      }
      m = line.match(/^(先手|下手)[：:]\s*(.*)$/); if (m) { names[0] = m[2].trim(); continue; }
      m = line.match(/^(後手|上手)[：:]\s*(.*)$/); if (m) { names[1] = m[2].trim(); continue; }
      if (/^[^\d▲△☗☖]*[：:]/.test(line) && !/^\d/.test(line)) continue; // そのほかの見出し
      // 指し手の行: 「  12 ７六歩(77)   ( 0:01/00:00:03)」、KI2 の「▲７六歩 △３四歩」
      let body = line;
      const num = line.match(/^(\d+)\s+(.*)$/);
      const tokens = [];
      if (num) tokens.push(num[2]);
      else if (/^[▲△☗☖]/.test(line)) { for (const tk of line.split(/(?=[▲△☗☖])/)) tokens.push(tk.trim()); }
      else continue;
      for (let tk of tokens) {
        body = tk.replace(/^[▲△☗☖]/, '').replace(/\s*\(\s*\d+:\d+\/[\d:]*\)\s*$/, '').trim();
        const p = ensure();
        if (/^(投了|詰み|切れ負け|反則勝ち|反則負け|入玉勝ち|千日手|持将棋|中断|宣言勝ち|TORYO)/.test(body)) {
          if (/^投了/.test(body)) result = { winner: p.stm ^ 1, reason: `${p.stm ? '△' : '▲'}の投了` };
          else if (/^詰み/.test(body)) result = { winner: p.stm ^ 1, reason: '詰み' };
          else if (/^(入玉勝ち|宣言勝ち)/.test(body)) { if (p.canDeclare()) { moves.push(DECLARE); p.make(DECLARE); } result = { winner: p.stm, reason: '入玉宣言' }; }
          else if (/^千日手/.test(body)) result = p.repetition() || { winner: -1, reason: '千日手' };
          else if (/^持将棋/.test(body)) result = { winner: -1, reason: '持将棋' };
          else if (/^反則負け/.test(body)) result = { winner: p.stm, reason: '反則' };
          else if (/^反則勝ち/.test(body)) result = { winner: p.stm ^ 1, reason: '反則' };
          else if (/^切れ負け/.test(body)) result = { winner: p.stm ^ 1, reason: '時間切れ' };
          break;
        }
        const mm = body.match(re);
        if (!mm) throw new Error(`${moves.length + 1}手目「${body}」が読めません`);
        const to = mm[1] ? (digit(mm[2]) - 1) * 9 + (9 - digit(mm[1])) : p.lastTo();
        if (to < 0) throw new Error(`${moves.length + 1}手目「${body}」: 「同」の前の手がありません`);
        const t = PIECE_T[mm[3]], fl = mm[5] || '', from = mm[6] ? (+mm[7] - 1) * 9 + (9 - +mm[6]) : -1;
        const rel = (body.match(/(右|左|直|上|引|寄)+/) || [''])[0];
        let cand = p.legalMoves().filter(x => {
          if (mvTo(x) !== to) return false;
          if (isDrop(x)) return mvDrop(x) === t && (fl === '打' || from < 0);
          if ((p.board[mvFrom(x)] & 15) !== t) return false;
          if (from >= 0 && mvFrom(x) !== from) return false;
          if (fl === '打') return false;
          return fl === '成' ? mvPromo(x) === 1 : mvPromo(x) === 0;
        });
        if (cand.length > 1 && cand.some(isDrop) && fl !== '打') cand = cand.filter(x => !isDrop(x));
        if (cand.length > 1 && rel) cand = cand.filter(x => p.relText(x) === rel);
        if (cand.length !== 1) throw new Error(`${moves.length + 1}手目「${body}」が${cand.length ? 'どの駒の手か決められません' : '指せない手です'}`);
        moves.push(cand[0]);
        p.make(cand[0]);
      }
      if (result) break;
    }
    void p0;
    return { handicap: hc, moves, names, result };
  }

  Object.assign(S, {
    BLACK, WHITE, FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, UM, RY, DECLARE, MAX_GAME_PLY, MAXPLY,
    mvTo, mvFrom, mvPromo, isDrop, mvDrop, mkMove, mkDrop, canPromoteType, unpromote, isBig, inZone, deadSq,
    DX, DY, RAY, RAYLEN, KNT, STEP, SLIDE, ZP1, ZP2, ZH1, ZH2, ZS1, ZS2,
    HANDICAPS, HANDICAP_KEYS, START_SFEN, Position, NAME, GLYPH, FW, KN, sqName, toKIF, parseKIF,
  });
  return S;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ShogiCore;
