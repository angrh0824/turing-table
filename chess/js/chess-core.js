/* チェスのルール（0x88 の盤）
 *   指し手の生成・合法手・チェック・チェックメイト・引き分け（ステイルメイト・50手ルール・三回同形・駒不足）
 *   キャスリング・アンパッサン・昇格、SAN（代数表記）・UCI・FEN・PGN の書き出しと読み込み
 *
 *   const C = ChessCore({});
 *   const p = C.Position.start();       // または C.Position.fromFEN('...')
 *   p.legalMoves() → 指し手（整数）の配列 / p.san(m) / p.makeMove(m)（合法なら true）/ p.unmake() / p.result()
 *
 * 盤: 0x88（マス = 段×16 + 筋。a1 = 0, h1 = 7, a8 = 0x70）。駒 = 種類 | 色<<3（白 1〜6、黒 9〜14）
 * 指し手: from | to<<7 | 昇格の種類<<14 | 種別<<17（1 2マス進む・2 アンパッサン・3 キャスリング）| 取る<<20
 */
function ChessCore(C) {
  'use strict';
  const WHITE = 0, BLACK = 1;
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const F_DOUBLE = 1, F_EP = 2, F_CASTLE = 3;
  const N_OFF = [33, 31, 18, 14, -14, -18, -31, -33];
  const K_OFF = [1, 15, 16, 17, -1, -15, -16, -17];
  const B_DIR = [15, 17, -15, -17];
  const R_DIR = [1, 16, -1, -16];
  const FILES = 'abcdefgh';
  const LETTER = ' PNBRQK';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const mvFrom = m => m & 127, mvTo = m => (m >> 7) & 127, mvPromo = m => (m >> 14) & 7, mvFlag = m => (m >> 17) & 7, mvCap = m => (m >> 20) & 1;
  const mkMove = (from, to, promo, flag, cap) => from | (to << 7) | (promo << 14) | (flag << 17) | (cap << 20);
  const sq64 = s => ((s >> 4) << 3) | (s & 7);
  const sq88 = i => ((i >> 3) << 4) | (i & 7);
  const sqName = s => FILES[s & 7] + ((s >> 4) + 1);
  function parseSq(str) {
    if (typeof str !== 'string' || str.length !== 2) return -1;
    const f = FILES.indexOf(str[0]), r = str.charCodeAt(1) - 49;
    return f < 0 || r < 0 || r > 7 ? -1 : (r << 4) | f;
  }

  // キャスリングの権利: 1 = 白のキング側、2 = 白のクイーン側、4 = 黒のキング側、8 = 黒のクイーン側。駒が動いた・取られたマスで消える
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0x00] = 15 & ~2; CASTLE_MASK[0x04] = 15 & ~3; CASTLE_MASK[0x07] = 15 & ~1;
  CASTLE_MASK[0x70] = 15 & ~8; CASTLE_MASK[0x74] = 15 & ~12; CASTLE_MASK[0x77] = 15 & ~4;

  // ゾブリストの乱数（局面の指紋。32ビット×2）。決まった種から作るので、どこで作っても同じ
  let seed = 0x9e3779b9 | 0;
  const rnd32 = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZPL = new Int32Array(16 * 128), ZPH = new Int32Array(16 * 128);
  for (let i = 0; i < 16 * 128; i++) { ZPL[i] = rnd32(); ZPH[i] = rnd32(); }
  const ZCL = new Int32Array(16), ZCH = new Int32Array(16);
  for (let i = 0; i < 16; i++) { ZCL[i] = rnd32(); ZCH[i] = rnd32(); }
  const ZEL = new Int32Array(8), ZEH = new Int32Array(8);
  for (let i = 0; i < 8; i++) { ZEL[i] = rnd32(); ZEH[i] = rnd32(); }
  const ZSL = rnd32(), ZSH = rnd32();

  const SCRATCH = new Int32Array(256);
  // 2つのマスが縦・横・斜めの同じ線の上にあるか（0x88 の差 + 119 で引く）
  const ALIGNED = new Uint8Array(239);
  for (const d of [1, 15, 16, 17, -1, -15, -16, -17]) for (let k = 1; k < 8; k++) ALIGNED[d * k + 119] = 1;

  class Position {
    constructor() {
      this.b = new Int8Array(128);
      this.stm = WHITE; this.castle = 0; this.ep = -1; this.epH = 0; this.half = 0; this.full = 1;
      this.king = [0, 0];
      this.cnt = new Int8Array(16);
      this.hl = 0; this.hh = 0;
      this.ply = 0;
      this.cap = 64;
      this.alloc(64);
    }
    alloc(n) {
      const grow = (a, T) => { const x = new T(n); if (a) x.set(a.subarray(0, Math.min(a.length, n))); return x; };
      this.uMove = grow(this.uMove, Int32Array); this.uCap = grow(this.uCap, Int8Array); this.uCastle = grow(this.uCastle, Int8Array);
      this.uEp = grow(this.uEp, Int16Array); this.uEpH = grow(this.uEpH, Int8Array); this.uHalf = grow(this.uHalf, Int16Array);
      this.posHL = grow(this.posHL, Int32Array); this.posHH = grow(this.posHH, Int32Array);
      this.cap = n;
    }
    static start() { return Position.fromFEN(START_FEN); }

    // ---------------------------------------------------------------- FEN
    static fromFEN(fen) {
      const p = new Position();
      const parts = String(fen || '').trim().split(/\s+/);
      if (parts.length < 4) throw new Error('FEN の形が正しくありません（6つの欄が必要です）');
      const rows = parts[0].split('/');
      if (rows.length !== 8) throw new Error('FEN の盤面は8段が必要です');
      for (let r = 0; r < 8; r++) {
        let f = 0;
        for (const ch of rows[r]) {
          if (ch >= '1' && ch <= '8') { f += ch.charCodeAt(0) - 48; continue; }
          const t = 'pnbrqk'.indexOf(ch.toLowerCase()) + 1;
          if (!t || f > 7) throw new Error(`FEN の盤面に読めない文字「${ch}」があります`);
          const c = ch === ch.toLowerCase() ? BLACK : WHITE;
          p.b[((7 - r) << 4) | f] = t | (c << 3);
          f++;
        }
        if (f !== 8) throw new Error(`FEN の${8 - r}段目のマスの数が8ではありません`);
      }
      if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error('FEN の手番は w か b です');
      p.stm = parts[1] === 'w' ? WHITE : BLACK;
      let kings = [0, 0];
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) continue;
        const q = p.b[s];
        if (!q) continue;
        p.cnt[q]++;
        if ((q & 7) === KING) { kings[q >> 3]++; p.king[q >> 3] = s; }
        if ((q & 7) === PAWN && ((s >> 4) === 0 || (s >> 4) === 7)) throw new Error('ポーンが1段目か8段目にあります');
      }
      if (kings[0] !== 1 || kings[1] !== 1) throw new Error('キングは白黒1つずつ必要です');
      let cr = 0;
      if (parts[2] !== '-') for (const ch of parts[2]) {
        const i = 'KQkq'.indexOf(ch);
        if (i < 0) throw new Error('FEN のキャスリングの欄が正しくありません');
        cr |= 1 << i;
      }
      // 駒が元の位置にない権利は捨てる（矛盾した FEN でも遊べるように）
      if (p.b[0x04] !== KING || p.b[0x07] !== ROOK) cr &= ~1;
      if (p.b[0x04] !== KING || p.b[0x00] !== ROOK) cr &= ~2;
      if (p.b[0x74] !== (KING | 8) || p.b[0x77] !== (ROOK | 8)) cr &= ~4;
      if (p.b[0x74] !== (KING | 8) || p.b[0x70] !== (ROOK | 8)) cr &= ~8;
      p.castle = cr;
      p.ep = -1;
      if (parts[3] !== '-') {
        const e = parseSq(parts[3]);
        if (e < 0) throw new Error('FEN のアンパッサンの欄が正しくありません');
        // 直前に2マス進んだポーンがいるときだけ有効にする
        const pawnSq = p.stm === WHITE ? e - 16 : e + 16, them = p.stm ^ 1;
        if ((e >> 4) === (p.stm === WHITE ? 5 : 2) && p.b[pawnSq] === (PAWN | (them << 3)) && !p.b[e]) p.ep = e;
      }
      p.half = parts[4] != null ? Math.max(0, parseInt(parts[4], 10) || 0) : 0;
      p.full = parts[5] != null ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;
      if (p.isAttacked(p.king[p.stm ^ 1], p.stm)) throw new Error('手番でない側のキングがチェックされています');
      p.epH = p.ep >= 0 && p.epLegal(p.ep) ? 1 : 0;
      p.computeHash();
      p.posHL[0] = p.hl; p.posHH[0] = p.hh;
      return p;
    }
    fen() {
      let s = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const q = this.b[(r << 4) | f];
          if (!q) { empty++; continue; }
          if (empty) { s += empty; empty = 0; }
          const ch = 'pnbrqk'[(q & 7) - 1];
          s += (q >> 3) ? ch : ch.toUpperCase();
        }
        if (empty) s += empty;
        if (r) s += '/';
      }
      let cr = '';
      if (this.castle & 1) cr += 'K'; if (this.castle & 2) cr += 'Q'; if (this.castle & 4) cr += 'k'; if (this.castle & 8) cr += 'q';
      return `${s} ${this.stm ? 'b' : 'w'} ${cr || '-'} ${this.epH ? sqName(this.ep) : '-'} ${this.half} ${this.full}`;
    }
    computeHash() {
      let hl = 0, hh = 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) continue;
        const q = this.b[s];
        if (q) { hl ^= ZPL[(q << 7) | s]; hh ^= ZPH[(q << 7) | s]; }
      }
      hl ^= ZCL[this.castle]; hh ^= ZCH[this.castle];
      if (this.epH) { hl ^= ZEL[this.ep & 7]; hh ^= ZEH[this.ep & 7]; }
      if (this.stm) { hl ^= ZSL; hh ^= ZSH; }
      this.hl = hl; this.hh = hh;
    }
    clone() {
      const p = new Position();
      p.b.set(this.b); p.stm = this.stm; p.castle = this.castle; p.ep = this.ep; p.epH = this.epH; p.half = this.half; p.full = this.full;
      p.king = this.king.slice(); p.cnt.set(this.cnt); p.hl = this.hl; p.hh = this.hh;
      p.alloc(Math.max(64, this.cap));
      p.ply = this.ply;
      p.uMove.set(this.uMove); p.uCap.set(this.uCap); p.uCastle.set(this.uCastle); p.uEp.set(this.uEp); p.uEpH.set(this.uEpH); p.uHalf.set(this.uHalf);
      p.posHL.set(this.posHL); p.posHH.set(this.posHH);
      return p;
    }

    // ---------------------------------------------------------------- 利き
    // マス s を、色 by の駒が攻撃しているか
    isAttacked(s, by) {
      const b = this.b;
      let t;
      if (by === WHITE) {
        t = s - 15; if (!(t & 0x88) && b[t] === PAWN) return true;
        t = s - 17; if (!(t & 0x88) && b[t] === PAWN) return true;
      } else {
        t = s + 15; if (!(t & 0x88) && b[t] === (PAWN | 8)) return true;
        t = s + 17; if (!(t & 0x88) && b[t] === (PAWN | 8)) return true;
      }
      const c8 = by << 3, n = KNIGHT | c8, k = KING | c8, bi = BISHOP | c8, ro = ROOK | c8, qu = QUEEN | c8;
      for (let i = 0; i < 8; i++) { t = s + N_OFF[i]; if (!(t & 0x88) && b[t] === n) return true; }
      for (let i = 0; i < 8; i++) { t = s + K_OFF[i]; if (!(t & 0x88) && b[t] === k) return true; }
      for (let i = 0; i < 4; i++) {
        const d = B_DIR[i];
        for (t = s + d; !(t & 0x88); t += d) { const q = b[t]; if (q) { if (q === bi || q === qu) return true; break; } }
      }
      for (let i = 0; i < 4; i++) {
        const d = R_DIR[i];
        for (t = s + d; !(t & 0x88); t += d) { const q = b[t]; if (q) { if (q === ro || q === qu) return true; break; } }
      }
      return false;
    }
    inCheck() { return this.isAttacked(this.king[this.stm], this.stm ^ 1); }
    // マス s の駒が利いているマス（画面の利きの表示用。ピンや王の安全は考えない）
    attacksFrom(s) {
      const b = this.b, q = b[s], out = [];
      if (!q) return out;
      const c = q >> 3, t = q & 7;
      if (t === PAWN) { for (const d of c ? [-15, -17] : [15, 17]) { const u = s + d; if (!(u & 0x88)) out.push(u); } return out; }
      if (t === KNIGHT || t === KING) { for (const d of t === KNIGHT ? N_OFF : K_OFF) { const u = s + d; if (!(u & 0x88)) out.push(u); } return out; }
      const dirs = t === BISHOP ? B_DIR : t === ROOK ? R_DIR : B_DIR.concat(R_DIR);
      for (const d of dirs) for (let u = s + d; !(u & 0x88); u += d) { out.push(u); if (b[u]) break; }
      return out;
    }

    // ---------------------------------------------------------------- 指し手の生成（王の安全は確かめない）
    // out[n..] に書き、新しい n を返す。capsOnly: 取る手とクイーンへの昇格だけ（静止探索用）
    gen(out, n, capsOnly) {
      const b = this.b, us = this.stm, them = us ^ 1;
      const fwd = us ? -16 : 16, startR = us ? 6 : 1, promoR = us ? 0 : 7;
      for (let s = 0; s < 120; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (!p || (p >> 3) !== us) continue;
        const t = p & 7;
        if (t === PAWN) {
          let to = s + fwd;
          if (!b[to]) {
            if ((to >> 4) === promoR) {
              out[n++] = mkMove(s, to, QUEEN, 0, 0);
              if (!capsOnly) { out[n++] = mkMove(s, to, KNIGHT, 0, 0); out[n++] = mkMove(s, to, ROOK, 0, 0); out[n++] = mkMove(s, to, BISHOP, 0, 0); }
            } else if (!capsOnly) {
              out[n++] = mkMove(s, to, 0, 0, 0);
              if ((s >> 4) === startR && !b[to + fwd]) out[n++] = mkMove(s, to + fwd, 0, F_DOUBLE, 0);
            }
          }
          for (let k = -1; k <= 1; k += 2) {
            to = s + fwd + k;
            if (to & 0x88) continue;
            const q = b[to];
            if (q && (q >> 3) === them) {
              if ((to >> 4) === promoR) {
                out[n++] = mkMove(s, to, QUEEN, 0, 1);
                if (!capsOnly) { out[n++] = mkMove(s, to, KNIGHT, 0, 1); out[n++] = mkMove(s, to, ROOK, 0, 1); out[n++] = mkMove(s, to, BISHOP, 0, 1); }
              } else out[n++] = mkMove(s, to, 0, 0, 1);
            } else if (to === this.ep) out[n++] = mkMove(s, to, 0, F_EP, 1);
          }
        } else if (t === KNIGHT || t === KING) {
          const offs = t === KNIGHT ? N_OFF : K_OFF;
          for (let i = 0; i < 8; i++) {
            const to = s + offs[i];
            if (to & 0x88) continue;
            const q = b[to];
            if (!q) { if (!capsOnly) out[n++] = mkMove(s, to, 0, 0, 0); } else if ((q >> 3) === them) out[n++] = mkMove(s, to, 0, 0, 1);
          }
          if (t === KING && !capsOnly && this.castle) {
            if (us === WHITE) {
              if ((this.castle & 1) && !b[5] && !b[6] && !this.isAttacked(4, BLACK) && !this.isAttacked(5, BLACK)) out[n++] = mkMove(4, 6, 0, F_CASTLE, 0);
              if ((this.castle & 2) && !b[3] && !b[2] && !b[1] && !this.isAttacked(4, BLACK) && !this.isAttacked(3, BLACK)) out[n++] = mkMove(4, 2, 0, F_CASTLE, 0);
            } else {
              if ((this.castle & 4) && !b[0x75] && !b[0x76] && !this.isAttacked(0x74, WHITE) && !this.isAttacked(0x75, WHITE)) out[n++] = mkMove(0x74, 0x76, 0, F_CASTLE, 0);
              if ((this.castle & 8) && !b[0x73] && !b[0x72] && !b[0x71] && !this.isAttacked(0x74, WHITE) && !this.isAttacked(0x73, WHITE)) out[n++] = mkMove(0x74, 0x72, 0, F_CASTLE, 0);
            }
          }
        } else {
          const lo = t === ROOK ? 4 : 0, hi = t === BISHOP ? 4 : 8;
          for (let i = lo; i < hi; i++) {
            const d = i < 4 ? B_DIR[i] : R_DIR[i - 4];
            for (let to = s + d; !(to & 0x88); to += d) {
              const q = b[to];
              if (!q) { if (!capsOnly) out[n++] = mkMove(s, to, 0, 0, 0); continue; }
              if ((q >> 3) === them) out[n++] = mkMove(s, to, 0, 0, 1);
              break;
            }
          }
        }
      }
      return n;
    }

    // アンパッサンで取れるか（手番の側が、ep のマスへ取れて、自分のキングが取られない）
    epLegal(ep) {
      const b = this.b, us = this.stm, them = us ^ 1;
      const myPawn = PAWN | (us << 3), capSq = us === WHITE ? ep - 16 : ep + 16;
      const ks = this.king[us];
      for (const d of us === WHITE ? [-15, -17] : [15, 17]) {
        const from = ep + d;
        if ((from & 0x88) || b[from] !== myPawn) continue;
        const cp = b[capSq];
        b[from] = 0; b[capSq] = 0; b[ep] = myPawn;
        const bad = this.isAttacked(ks, them);
        b[from] = myPawn; b[capSq] = cp; b[ep] = 0;
        if (!bad) return true;
      }
      return false;
    }

    // ---------------------------------------------------------------- 指す・戻す
    make(m) {
      if (this.ply + 2 >= this.cap) this.alloc(this.cap * 2);
      const b = this.b, us = this.stm, ply = this.ply;
      const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
      const p = b[from];
      const capSq = flag === F_EP ? (us === WHITE ? to - 16 : to + 16) : to;
      const cap = b[capSq];
      this.uMove[ply] = m; this.uCap[ply] = cap; this.uCastle[ply] = this.castle; this.uEp[ply] = this.ep; this.uEpH[ply] = this.epH; this.uHalf[ply] = this.half;
      let hl = this.hl, hh = this.hh;
      if (this.epH) { hl ^= ZEL[this.ep & 7]; hh ^= ZEH[this.ep & 7]; }
      hl ^= ZCL[this.castle]; hh ^= ZCH[this.castle];
      b[from] = 0; hl ^= ZPL[(p << 7) | from]; hh ^= ZPH[(p << 7) | from];
      if (cap) { b[capSq] = 0; hl ^= ZPL[(cap << 7) | capSq]; hh ^= ZPH[(cap << 7) | capSq]; this.cnt[cap]--; }
      let np = p;
      if (promo) { np = promo | (us << 3); this.cnt[p]--; this.cnt[np]++; }
      b[to] = np; hl ^= ZPL[(np << 7) | to]; hh ^= ZPH[(np << 7) | to];
      if (flag === F_CASTLE) {
        let rf, rt;
        if (to === 6) { rf = 7; rt = 5; } else if (to === 2) { rf = 0; rt = 3; } else if (to === 0x76) { rf = 0x77; rt = 0x75; } else { rf = 0x70; rt = 0x73; }
        const r = b[rf];
        b[rf] = 0; b[rt] = r;
        hl ^= ZPL[(r << 7) | rf] ^ ZPL[(r << 7) | rt]; hh ^= ZPH[(r << 7) | rf] ^ ZPH[(r << 7) | rt];
      }
      if ((p & 7) === KING) this.king[us] = to;
      this.castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
      hl ^= ZCL[this.castle]; hh ^= ZCH[this.castle];
      this.half = (p & 7) === PAWN || cap ? 0 : this.half + 1;
      if (us === BLACK) this.full++;
      this.stm = us ^ 1; hl ^= ZSL; hh ^= ZSH;
      this.ep = -1; this.epH = 0;
      if (flag === F_DOUBLE) {
        this.ep = (from + to) >> 1;
        if (this.epLegal(this.ep)) { this.epH = 1; hl ^= ZEL[this.ep & 7]; hh ^= ZEH[this.ep & 7]; }
      }
      this.hl = hl; this.hh = hh;
      this.ply = ply + 1;
      this.posHL[ply + 1] = hl; this.posHH[ply + 1] = hh;
    }
    unmake() {
      const ply = --this.ply, b = this.b;
      const m = this.uMove[ply];
      const us = this.stm ^ 1;
      this.stm = us;
      if (m === 0) { // ヌルムーブ
        this.ep = this.uEp[ply]; this.epH = this.uEpH[ply]; this.half = this.uHalf[ply];
        this.hl = this.posHL[ply]; this.hh = this.posHH[ply];
        return;
      }
      const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7;
      const np = b[to];
      let p = np;
      if (promo) { p = PAWN | (us << 3); this.cnt[np]--; this.cnt[p]++; }
      b[from] = p; b[to] = 0;
      const cap = this.uCap[ply];
      if (cap) { const capSq = flag === F_EP ? (us === WHITE ? to - 16 : to + 16) : to; b[capSq] = cap; this.cnt[cap]++; }
      if (flag === F_CASTLE) {
        let rf, rt;
        if (to === 6) { rf = 7; rt = 5; } else if (to === 2) { rf = 0; rt = 3; } else if (to === 0x76) { rf = 0x77; rt = 0x75; } else { rf = 0x70; rt = 0x73; }
        b[rf] = b[rt]; b[rt] = 0;
      }
      if ((p & 7) === KING) this.king[us] = from;
      if (us === BLACK) this.full--;
      this.castle = this.uCastle[ply]; this.ep = this.uEp[ply]; this.epH = this.uEpH[ply]; this.half = this.uHalf[ply];
      this.hl = this.posHL[ply]; this.hh = this.posHH[ply];
    }
    // 指して、自分のキングが取られる形なら戻して false。
    // inCheck に「指す前にチェックされていない」(false) を渡すと、キング以外の駒がキングと同じ線の上にないときは確かめを省く（その駒が動いてもキングは新たに狙われない）
    makeMove(m, inCheck) {
      const us = this.stm, from = m & 127, ks = this.king[us];
      const quick = inCheck === false && (this.b[from] & 7) !== KING && ((m >> 17) & 7) !== F_EP && !ALIGNED[from - ks + 119];
      this.make(m);
      if (!quick && this.isAttacked(this.king[us], us ^ 1)) { this.unmake(); return false; }
      return true;
    }
    makeNull() {
      if (this.ply + 2 >= this.cap) this.alloc(this.cap * 2);
      const ply = this.ply;
      this.uMove[ply] = 0; this.uEp[ply] = this.ep; this.uEpH[ply] = this.epH; this.uHalf[ply] = this.half; this.uCastle[ply] = this.castle;
      let hl = this.hl, hh = this.hh;
      if (this.epH) { hl ^= ZEL[this.ep & 7]; hh ^= ZEH[this.ep & 7]; }
      this.ep = -1; this.epH = 0; this.half = 0; // 千日手を調べるときヌルムーブの向こうは見ない
      this.stm ^= 1; hl ^= ZSL; hh ^= ZSH;
      this.hl = hl; this.hh = hh;
      this.ply = ply + 1;
      this.posHL[ply + 1] = hl; this.posHH[ply + 1] = hh;
    }

    // ---------------------------------------------------------------- 合法手・終局
    legalMoves() {
      const buf = new Int32Array(256), n = this.gen(buf, 0, false), out = [];
      for (let i = 0; i < n; i++) if (this.makeMove(buf[i])) { this.unmake(); out.push(buf[i]); }
      return out;
    }
    hasLegal() {
      const buf = SCRATCH, n = this.gen(buf, 0, false);
      for (let i = 0; i < n; i++) if (this.makeMove(buf[i])) { this.unmake(); return true; }
      return false;
    }
    isLegal(m) { return this.legalMoves().includes(m); }
    // 盤の上の駒だけではどちらもチェックメイトできない（キングだけ・キング＋ナイト1つ・同じ色のマスのビショップだけ）
    insufficient() {
      const c = this.cnt;
      if (c[PAWN] || c[PAWN | 8] || c[ROOK] || c[ROOK | 8] || c[QUEEN] || c[QUEEN | 8]) return false;
      const n = c[KNIGHT] + c[KNIGHT | 8], bi = c[BISHOP] + c[BISHOP | 8];
      if (n + bi <= 1) return true;
      if (n) return false;
      let colors = 0;
      for (let s = 0; s < 120; s++) {
        if (s & 0x88) { s += 7; continue; }
        if ((this.b[s] & 7) === BISHOP) colors |= 1 << (((s >> 4) + (s & 7)) & 1);
      }
      return colors !== 3;
    }
    // 今の局面が（この Position が知っている範囲で）何回目か
    repetitions() {
      let n = 1;
      const hl = this.hl, hh = this.hh;
      for (let k = this.ply - 2, lim = Math.max(0, this.ply - this.half); k >= lim; k -= 2) if (this.posHL[k] === hl && this.posHH[k] === hh) n++;
      return n;
    }
    // 終局なら { winner: 0 白 / 1 黒 / -1 引き分け, reason: 'mate'|'stalemate'|'material'|'fifty'|'threefold' }、続くなら null
    result() {
      if (!this.hasLegal()) return this.inCheck() ? { winner: this.stm ^ 1, reason: 'mate' } : { winner: -1, reason: 'stalemate' };
      if (this.insufficient()) return { winner: -1, reason: 'material' };
      if (this.half >= 100) return { winner: -1, reason: 'fifty' };
      if (this.repetitions() >= 3) return { winner: -1, reason: 'threefold' };
      return null;
    }

    // ---------------------------------------------------------------- 表記
    pieceAt(s) { return this.b[s]; }
    san(m, legal) {
      const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 7, cap = (m >> 20) & 1;
      let s;
      if (flag === F_CASTLE) s = (to & 7) === 6 ? 'O-O' : 'O-O-O';
      else {
        const p = this.b[from], t = p & 7;
        if (t === PAWN) s = (cap ? FILES[from & 7] + 'x' : '') + sqName(to) + (promo ? '=' + LETTER[promo] : '');
        else {
          legal = legal || this.legalMoves();
          let amb = false, sameFile = false, sameRank = false;
          for (const o of legal) {
            const f2 = o & 127;
            if (o === m || ((o >> 7) & 127) !== to || f2 === from || this.b[f2] !== p) continue;
            amb = true;
            if ((f2 & 7) === (from & 7)) sameFile = true;
            if ((f2 >> 4) === (from >> 4)) sameRank = true;
          }
          let dis = '';
          if (amb) dis = !sameFile ? FILES[from & 7] : !sameRank ? String((from >> 4) + 1) : sqName(from);
          s = LETTER[t] + dis + (cap ? 'x' : '') + sqName(to);
        }
      }
      if (this.makeMove(m)) {
        if (this.inCheck()) s += this.hasLegal() ? '+' : '#';
        this.unmake();
      }
      return s;
    }
    uci(m) { return sqName(m & 127) + sqName((m >> 7) & 127) + ((m >> 14) & 7 ? ' pnbrqk'[(m >> 14) & 7] : ''); }
    moveFromUCI(str) {
      const t = String(str || '').trim().toLowerCase();
      if (!/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(t)) return 0;
      const from = parseSq(t.slice(0, 2)), to = parseSq(t.slice(2, 4)), pr = t[4] ? ' pnbrqk'.indexOf(t[4]) : 0;
      return this.legalMoves().find(m => (m & 127) === from && ((m >> 7) & 127) === to && ((m >> 14) & 7) === pr) || 0;
    }
    // SAN（「Nf3」「exd5」「e8=Q」「O-O」など。+ # ! ? は無視、0-0 も可、UCI の形も受け付ける）を指し手に。見つからなければ 0
    moveFromSAN(str) {
      let t = String(str || '').trim().replace(/[+#!?]+$/g, '').replace(/e\.p\.$/i, '').replace(/0/g, 'O');
      const legal = this.legalMoves();
      if (/^O-O(-O)?$/i.test(t)) {
        const long = t.length > 3;
        return legal.find(m => ((m >> 17) & 7) === F_CASTLE && ((((m >> 7) & 127) & 7) === (long ? 2 : 6))) || 0;
      }
      const u = this.moveFromUCI(t);
      if (u) return u;
      const mm = t.match(/^([NBRQK])?([a-h])?([1-8])?[x:]?([a-h][1-8])(?:=?([NBRQnbrq]))?$/);
      if (!mm) return 0;
      const type = mm[1] ? LETTER.indexOf(mm[1]) : PAWN, ff = mm[2] ? FILES.indexOf(mm[2]) : -1, fr = mm[3] ? Number(mm[3]) - 1 : -1;
      const to = parseSq(mm[4]), pr = mm[5] ? LETTER.indexOf(mm[5].toUpperCase()) : 0;
      const c = legal.filter(m => {
        const f = m & 127;
        if (((m >> 7) & 127) !== to || (this.b[f] & 7) !== type) return false;
        if (ff >= 0 && (f & 7) !== ff) return false;
        if (fr >= 0 && (f >> 4) !== fr) return false;
        const mp = (m >> 14) & 7;
        return pr ? mp === pr : (mp === 0 || mp === QUEEN);
      });
      return c.length === 1 ? c[0] : 0;
    }
  }

  // 開始局面と指し手（整数）の列から局面を作る（ワーカーに渡すときなど）
  Position.fromMoves = (fen, moves) => {
    const p = Position.fromFEN(fen || START_FEN);
    for (const m of moves || []) if (!p.makeMove(m)) throw new Error('合法でない手があります');
    return p;
  };

  // 合法手の数を深さ d まで数える（ルールの確かめ用）。quick = true なら探索と同じ省略をした確かめ方で
  function perftQuick(p, d) {
    if (d === 0) return 1;
    const buf = new Int32Array(256), n = p.gen(buf, 0, false), chk = p.inCheck();
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!p.makeMove(buf[i], chk)) continue;
      total += d === 1 ? 1 : perftQuick(p, d - 1);
      p.unmake();
    }
    return total;
  }
  function perft(p, d) {
    if (d === 0) return 1;
    const buf = new Int32Array(256), n = p.gen(buf, 0, false);
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!p.makeMove(buf[i])) continue;
      total += d === 1 ? 1 : perft(p, d - 1);
      p.unmake();
    }
    return total;
  }

  // ---------------------------------------------------------------- PGN
  const RESULT_TOKENS = ['1-0', '0-1', '1/2-1/2', '*'];
  // tags: { Event, Site, Date, Round, White, Black, Result, ... }、sans: SAN の配列、startFen: 開始局面（標準でなければ FEN の欄を書く）
  function toPGN({ tags = {}, sans = [], startFen = null, result = '*', firstFull = 1, blackFirst = false }) {
    const T = Object.assign({ Event: '?', Site: '?', Date: '????.??.??', Round: '?', White: '?', Black: '?' }, tags, { Result: result });
    if (startFen && startFen !== START_FEN) { T.SetUp = '1'; T.FEN = startFen; }
    const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
    const keys = order.concat(Object.keys(T).filter(k => !order.includes(k)));
    const head = keys.map(k => `[${k} "${String(T[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join('\n');
    const toks = [];
    let full = firstFull, white = !blackFirst;
    sans.forEach((s, i) => {
      if (white) toks.push(`${full}.`); else if (i === 0) toks.push(`${full}...`);
      toks.push(s);
      if (!white) full++;
      white = !white;
    });
    toks.push(result);
    const lines = [];
    let line = '';
    for (const t of toks) { if (line && line.length + 1 + t.length > 79) { lines.push(line); line = t; } else line = line ? line + ' ' + t : t; }
    if (line) lines.push(line);
    return head + '\n\n' + lines.join('\n') + '\n';
  }
  // PGN を読む（最初の1局。注釈 {} ; 、変化 ()、$数字 は読み飛ばす）。{ tags, startFen, moves, sans, result }。読めない手があれば Error
  function parsePGN(text) {
    const src = String(text || '').replace(/\r/g, '');
    const tags = {};
    const tagRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/;
    const lines = src.split('\n');
    let i = 0;
    while (i < lines.length && (tagRe.test(lines[i]) || !lines[i].trim())) {
      const mm = lines[i].match(tagRe);
      if (mm) tags[mm[1]] = mm[2].replace(/\\(.)/g, '$1');
      else if (Object.keys(tags).length && !lines[i].trim()) { i++; break; }
      i++;
    }
    let body = lines.slice(i).join('\n');
    // 次の対局の見出しが来たらそこまで
    const nextTag = body.search(/\n\s*\[\w+\s+"/);
    if (nextTag >= 0) body = body.slice(0, nextTag);
    body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
    let depth = 0, flat = '';
    for (const ch of body) { if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1); else if (!depth) flat += ch; }
    const startFen = tags.FEN || START_FEN;
    const p = Position.fromFEN(startFen);
    const moves = [], sans = [];
    let result = tags.Result && RESULT_TOKENS.includes(tags.Result) ? tags.Result : '*';
    for (let tok of flat.split(/\s+/)) {
      if (!tok) continue;
      if (RESULT_TOKENS.includes(tok)) { result = tok; break; }
      tok = tok.replace(/^\d+\.+/, '');
      if (!tok || /^\$\d+$/.test(tok) || /^\.+$/.test(tok) || /^[!?]+$/.test(tok)) continue;
      const m = p.moveFromSAN(tok);
      if (!m) throw new Error(`${Math.floor(moves.length / 2) + 1}手目の「${tok}」が指せません`);
      sans.push(p.san(m));
      p.makeMove(m);
      moves.push(m);
    }
    return { tags, startFen, moves, sans, result, position: p };
  }

  const PIECE_JA = ['', 'ポーン', 'ナイト', 'ビショップ', 'ルーク', 'クイーン', 'キング'];
  const REASON_JA = { mate: 'チェックメイト', stalemate: 'ステイルメイト', material: '駒不足', fifty: '50手ルール', threefold: '三回同形', resign: '投了', agree: '合意', disconnect: '相手の接続切れ' };

  Object.assign(C, {
    WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, F_DOUBLE, F_EP, F_CASTLE, START_FEN, FILES, LETTER, PIECE_JA, REASON_JA,
    N_OFF, K_OFF, B_DIR, R_DIR, CASTLE_MASK, ZPL, ZPH,
    mvFrom, mvTo, mvPromo, mvFlag, mvCap, mkMove, sq64, sq88, sqName, parseSq, Position, perft, perftQuick, toPGN, parsePGN,
  });
  return C;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ChessCore;
