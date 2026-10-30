/* シャンチー（中国将棋・象棋）のルール
 *   指し手の生成・合法手・将軍（王手）・将死・困毙（指せる手がない＝負け）・王の対面の禁止（飛将）
 *   繰り返し（同じ局面の3回目: ずっと王手をかけ続けた側の負け＝長将、それ以外は引き分け。アジアルールを簡略化）
 *   60回合ルール（両者で120手、駒を取らなければ引き分け）・双方に攻める駒（車・馬・炮・兵）がなければ引き分け
 *   棋譜: 中国式の表記（炮二平五・馬８進７）と座標（h2e2）、FEN 風の局面の書き出しと読み込み
 *
 *   const C = XiangqiCore({});
 *   const p = C.Position.start();           // または C.Position.fromFEN('...')
 *   p.legalMoves() → 指し手（整数）の配列 / p.chinese(m) / p.iccs(m) / p.makeMove(m)（合法なら true）/ p.unmake() / p.result()
 *
 * 盤: 16×14 の配列（マス = (段+2)×16 + 筋）。筋 0〜8 は赤から見て左から（a〜i）、段 0〜9 は赤の陣の奥から。盤の外は OFF
 * 駒 = 種類 | 色<<3（赤 1〜7、黒 9〜15）。種類: 1 帥/將 2 仕/士 3 相/象 4 傌/馬 5 俥/車 6 炮/砲 7 兵/卒
 * 指し手: from | to<<8 | 取る<<16
 */
function XiangqiCore(C) {
  'use strict';
  const RED = 0, BLACK = 1;
  const KING = 1, ADVISOR = 2, ELEPHANT = 3, HORSE = 4, ROOK = 5, CANNON = 6, PAWN = 7;
  const OFF = 32;
  const NSQ = 224;
  const FILES = 'abcdefghi';
  const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
  const LIMIT = 120; // 60回合（両者で120手）駒を取らなければ引き分け

  const sqOf = (f, r) => ((r + 2) << 4) | f;
  const fileOf = s => s & 15, rankOf = s => (s >> 4) - 2;
  const sq90 = s => rankOf(s) * 9 + fileOf(s);
  const fromSq90 = i => sqOf(i % 9, (i / 9) | 0);
  const sqName = s => FILES[fileOf(s)] + rankOf(s);
  function parseSq(str) {
    if (typeof str !== 'string' || str.length !== 2) return -1;
    const f = FILES.indexOf(str[0].toLowerCase()), r = str.charCodeAt(1) - 48;
    return f < 0 || r < 0 || r > 9 ? -1 : sqOf(f, r);
  }
  const mvFrom = m => m & 255, mvTo = m => (m >> 8) & 255, mvCap = m => (m >> 16) & 1;
  const mkMove = (from, to, cap) => from | (to << 8) | (cap << 16);

  const ON = new Uint8Array(NSQ), SQS = [];
  for (let r = 0; r < 10; r++) for (let f = 0; f < 9; f++) { ON[sqOf(f, r)] = 1; SQS.push(sqOf(f, r)); }
  // 九宮（帥・仕が動ける範囲）と、自分の陣（相・象は河を越えない）
  const PALACE = [new Uint8Array(NSQ), new Uint8Array(NSQ)], HALF = [new Uint8Array(NSQ), new Uint8Array(NSQ)];
  for (const s of SQS) {
    const f = fileOf(s), r = rankOf(s);
    if (f >= 3 && f <= 5 && r <= 2) PALACE[RED][s] = 1;
    if (f >= 3 && f <= 5 && r >= 7) PALACE[BLACK][s] = 1;
    HALF[r <= 4 ? RED : BLACK][s] = 1;
  }
  const ORTH = [16, -16, 1, -1], DIAG = [17, 15, -15, -17];
  const HORSE_L = [[16, 33], [16, 31], [-16, -31], [-16, -33], [1, 18], [1, -14], [-1, 14], [-1, -18]]; // 馬: [足, 行き先]
  const ELEPH_L = [[17, 34], [15, 30], [-15, -30], [-17, -34]];                                       // 相: [目, 行き先]
  const HORSE_ATK = [[17, 18, 33], [15, 14, 31], [-15, -14, -31], [-17, -18, -33]];                     // マス s を狙う馬: [足（s の斜め隣）, 馬の位置, 馬の位置]
  const FWD = [16, -16]; // 兵の前

  // 置ける場所（FEN を読むとき・ランダムな局面を作るときの確かめ）
  function placeOk(t, c, s) {
    if (!ON[s]) return false;
    const f = fileOf(s), rr = c ? 9 - rankOf(s) : rankOf(s);
    switch (t) {
      case KING: return !!PALACE[c][s];
      case ADVISOR: return !!PALACE[c][s] && ((f + rr) & 1) === 1;
      case ELEPHANT: return rr <= 4 && !(rr & 1) && !(f & 1) && (((f >> 1) + (rr >> 1)) & 1) === 1;
      case PAWN: return rr >= 3 && (rr >= 5 || !(f & 1));
      default: return true;
    }
  }
  const MAX_COUNT = [0, 1, 2, 2, 2, 2, 2, 5];

  // ゾブリストの乱数（局面の指紋。32ビット×2）。決まった種から作るので、どこで作っても同じ
  let seed = 0x5a17c3e1 | 0;
  const rnd32 = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const ZPL = new Int32Array(16 * 256), ZPH = new Int32Array(16 * 256);
  for (let i = 0; i < 16 * 256; i++) { ZPL[i] = rnd32(); ZPH[i] = rnd32(); }
  const ZSL = rnd32(), ZSH = rnd32();
  const SCRATCH = new Int32Array(256);

  class Position {
    constructor() {
      this.b = new Int8Array(NSQ).fill(OFF);
      for (const s of SQS) this.b[s] = 0;
      this.stm = RED; this.half = 0; this.full = 1;
      this.king = [0, 0];
      this.cnt = new Int8Array(16);
      this.hl = 0; this.hh = 0;
      this.ply = 0;
      this.cap = 0;
      this.alloc(128);
      this.chk[0] = -1;
    }
    alloc(n) {
      const grow = (a, T) => { const x = new T(n); if (a) x.set(a.subarray(0, Math.min(a.length, n))); return x; };
      this.uMove = grow(this.uMove, Int32Array); this.uCap = grow(this.uCap, Int8Array); this.uHalf = grow(this.uHalf, Int16Array);
      this.posHL = grow(this.posHL, Int32Array); this.posHH = grow(this.posHH, Int32Array);
      this.chk = grow(this.chk, Int8Array); // その局面で手番の側が王手されているか（-1 = まだ調べていない）
      this.cap = n;
    }
    static start() { return Position.fromFEN(START_FEN); }

    // ---------------------------------------------------------------- FEN（rnbakabnr/9/1c5c1/… w - - 0 1。大文字が赤、1段目が黒の陣の奥）
    static fromFEN(fen) {
      const p = new Position();
      const parts = String(fen || '').trim().split(/\s+/);
      if (parts.length < 2) throw new Error('FEN の形が正しくありません（盤面と手番が必要です）');
      const rows = parts[0].split('/');
      if (rows.length !== 10) throw new Error('FEN の盤面は10段が必要です');
      for (let i = 0; i < 10; i++) {
        const r = 9 - i;
        let f = 0;
        for (const ch of rows[i]) {
          if (ch >= '1' && ch <= '9') { f += ch.charCodeAt(0) - 48; continue; }
          const lo = ch.toLowerCase();
          const t = 'kabnrcp'.indexOf(lo) + 1 || (lo === 'e' ? ELEPHANT : lo === 'h' ? HORSE : 0);
          if (!t || f > 8) throw new Error(`FEN の盤面に読めない文字「${ch}」があります`);
          const c = ch === lo ? BLACK : RED;
          p.b[sqOf(f, r)] = t | (c << 3);
          f++;
        }
        if (f !== 9) throw new Error(`FEN の上から${i + 1}段目のマスの数が9ではありません`);
      }
      const sd = (parts[1] || '').toLowerCase();
      if (sd !== 'w' && sd !== 'r' && sd !== 'b') throw new Error('FEN の手番は w（赤）か b（黒）です');
      p.stm = sd === 'b' ? BLACK : RED;
      for (const s of SQS) {
        const q = p.b[s];
        if (!q) continue;
        const t = q & 7, c = q >> 3;
        if (!placeOk(t, c, s)) throw new Error(`${c ? '黒' : '赤'}の${PIECE_NAME[c][t]}が置けない場所（${sqName(s)}）にあります`);
        p.cnt[q]++;
        if (t === KING) p.king[c] = s;
      }
      for (let c = 0; c < 2; c++) for (let t = 1; t <= 7; t++) {
        const n = p.cnt[t | (c << 3)];
        if (t === KING && n !== 1) throw new Error('帥と將は1つずつ必要です');
        if (n > MAX_COUNT[t]) throw new Error(`${c ? '黒' : '赤'}の${PIECE_NAME[c][t]}が多すぎます`);
      }
      const num = x => (/^\d+$/.test(x || '') ? parseInt(x, 10) : NaN);
      const h = num(parts[4]), fu = num(parts[5]);
      p.half = h >= 0 ? Math.min(h, 1000) : 0;
      p.full = fu >= 1 ? fu : 1;
      if (p.kingAttacked(p.stm ^ 1)) throw new Error('手番でない側の王が取られる形です（王手がかかったまま、または王が向かい合っています）');
      p.computeHash();
      p.posHL[0] = p.hl; p.posHH[0] = p.hh; p.chk[0] = -1;
      return p;
    }
    fen() {
      let s = '';
      for (let r = 9; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 9; f++) {
          const q = this.b[sqOf(f, r)];
          if (!q) { empty++; continue; }
          if (empty) { s += empty; empty = 0; }
          const ch = 'kabnrcp'[(q & 7) - 1];
          s += (q >> 3) ? ch : ch.toUpperCase();
        }
        if (empty) s += empty;
        if (r) s += '/';
      }
      return `${s} ${this.stm ? 'b' : 'w'} - - ${this.half} ${this.full}`;
    }
    computeHash() {
      let hl = 0, hh = 0;
      for (const s of SQS) { const q = this.b[s]; if (q) { hl ^= ZPL[(q << 8) | s]; hh ^= ZPH[(q << 8) | s]; } }
      if (this.stm) { hl ^= ZSL; hh ^= ZSH; }
      this.hl = hl; this.hh = hh;
    }
    clone() {
      const p = new Position();
      p.b.set(this.b); p.stm = this.stm; p.half = this.half; p.full = this.full;
      p.king = this.king.slice(); p.cnt.set(this.cnt); p.hl = this.hl; p.hh = this.hh;
      p.alloc(Math.max(128, this.cap));
      p.ply = this.ply;
      p.uMove.set(this.uMove); p.uCap.set(this.uCap); p.uHalf.set(this.uHalf);
      p.posHL.set(this.posHL); p.posHH.set(this.posHH); p.chk.set(this.chk);
      return p;
    }

    // ---------------------------------------------------------------- 王の安全
    // 色 c の王が相手に取られる形か（車・炮・馬・兵の利きと、王どうしの向かい合い）。士・相・帥は河を越えないので相手の九宮には届かない
    kingAttacked(c) {
      const b = this.b, k = this.king[c], t8 = (c ^ 1) << 3;
      const R = ROOK | t8, CN = CANNON | t8, H = HORSE | t8, P = PAWN | t8, K = KING | t8;
      for (let i = 0; i < 4; i++) {
        const d = ORTH[i];
        let s = k + d;
        while (b[s] === 0) s += d;
        const q = b[s];
        if (q === R || (q === K && i < 2)) return true; // 縦の線で王どうしが向かい合うのも禁止
        if (q === OFF) continue;
        s += d;
        while (b[s] === 0) s += d;
        if (b[s] === CN) return true;
      }
      for (let i = 0; i < 4; i++) {
        const a = HORSE_ATK[i];
        if (b[k + a[0]] === 0 && (b[k + a[1]] === H || b[k + a[2]] === H)) return true;
      }
      if (b[k - FWD[c ^ 1]] === P || b[k + 1] === P || b[k - 1] === P) return true; // 九宮は自分の陣なので、横の兵は河を越えている
      return false;
    }
    inCheck() {
      const v = this.chk[this.ply];
      if (v >= 0) return v === 1;
      const r = this.kingAttacked(this.stm);
      this.chk[this.ply] = r ? 1 : 0;
      return r;
    }

    // マス s の駒が動ける・取れる（守っている）マス（画面の利きの表示用。王の安全は考えない）
    attacksFrom(s) {
      const b = this.b, q = b[s], out = [];
      if (!q || q === OFF) return out;
      const c = q >> 3, t = q & 7;
      const add = u => { if (ON[u]) out.push(u); };
      if (t === KING) { for (const d of ORTH) if (PALACE[c][s + d]) out.push(s + d); }
      else if (t === ADVISOR) { for (const d of DIAG) if (PALACE[c][s + d]) out.push(s + d); }
      else if (t === ELEPHANT) { for (const [e, d] of ELEPH_L) if (HALF[c][s + d] && b[s + e] === 0) out.push(s + d); }
      else if (t === HORSE) { for (const [l, d] of HORSE_L) if (b[s + l] === 0) add(s + d); }
      else if (t === ROOK) { for (const d of ORTH) for (let u = s + d; b[u] !== OFF; u += d) { out.push(u); if (b[u]) break; } }
      else if (t === CANNON) {
        for (const d of ORTH) {
          let u = s + d;
          while (b[u] === 0) { out.push(u); u += d; }
          if (b[u] === OFF) continue;
          u += d;
          while (b[u] === 0) u += d;
          if (b[u] !== OFF) out.push(u);
        }
      } else {
        add(s + FWD[c]);
        if (HALF[c ^ 1][s]) { add(s + 1); add(s - 1); }
      }
      return out;
    }

    // ---------------------------------------------------------------- 指し手の生成（王の安全は確かめない）
    // out[n..] に書き、新しい n を返す。capsOnly: 取る手だけ（静止探索用）
    gen(out, n, capsOnly) {
      const b = this.b, us = this.stm, them = us ^ 1;
      const pal = PALACE[us], half = HALF[us];
      for (let i = 0; i < 90; i++) {
        const s = SQS[i], p = b[s];
        if (!p || (p >> 3) !== us) continue;
        switch (p & 7) {
          case KING:
            for (let k = 0; k < 4; k++) {
              const to = s + ORTH[k];
              if (!pal[to]) continue;
              const q = b[to];
              if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if ((q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          case ADVISOR:
            for (let k = 0; k < 4; k++) {
              const to = s + DIAG[k];
              if (!pal[to]) continue;
              const q = b[to];
              if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if ((q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          case ELEPHANT:
            for (let k = 0; k < 4; k++) {
              const to = s + ELEPH_L[k][1];
              if (!half[to] || b[s + ELEPH_L[k][0]] !== 0) continue;
              const q = b[to];
              if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if ((q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          case HORSE:
            for (let k = 0; k < 8; k++) {
              const to = s + HORSE_L[k][1];
              if (b[s + HORSE_L[k][0]] !== 0) continue;
              const q = b[to];
              if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if (q !== OFF && (q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          case ROOK:
            for (let k = 0; k < 4; k++) {
              const d = ORTH[k];
              let to = s + d;
              for (; b[to] === 0; to += d) if (!capsOnly) out[n++] = to << 8 | s;
              const q = b[to];
              if (q !== OFF && (q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          case CANNON:
            for (let k = 0; k < 4; k++) {
              const d = ORTH[k];
              let to = s + d;
              for (; b[to] === 0; to += d) if (!capsOnly) out[n++] = to << 8 | s;
              if (b[to] === OFF) continue;
              for (to += d; b[to] === 0; to += d);
              const q = b[to];
              if (q !== OFF && (q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            }
            break;
          default: { // 兵: 前に1つ。河を越えたら横にも
            let to = s + FWD[us], q = b[to];
            if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if (q !== OFF && (q >> 3) === them) out[n++] = s | (to << 8) | 65536;
            if (!half[s]) {
              for (let k = -1; k <= 1; k += 2) {
                to = s + k; q = b[to];
                if (!q) { if (!capsOnly) out[n++] = to << 8 | s; } else if (q !== OFF && (q >> 3) === them) out[n++] = s | (to << 8) | 65536;
              }
            }
          }
        }
      }
      return n;
    }

    // ---------------------------------------------------------------- 指す・戻す
    make(m) {
      if (this.ply + 2 >= this.cap) this.alloc(this.cap * 2);
      const b = this.b, us = this.stm, ply = this.ply;
      const from = m & 255, to = (m >> 8) & 255;
      const p = b[from], cap = b[to];
      this.uMove[ply] = m; this.uCap[ply] = cap; this.uHalf[ply] = this.half;
      let hl = this.hl ^ ZPL[(p << 8) | from] ^ ZPL[(p << 8) | to] ^ ZSL, hh = this.hh ^ ZPH[(p << 8) | from] ^ ZPH[(p << 8) | to] ^ ZSH;
      if (cap) { hl ^= ZPL[(cap << 8) | to]; hh ^= ZPH[(cap << 8) | to]; this.cnt[cap]--; this.half = 0; } else this.half++;
      b[from] = 0; b[to] = p;
      if ((p & 7) === KING) this.king[us] = to;
      if (us === BLACK) this.full++;
      this.stm = us ^ 1;
      this.hl = hl; this.hh = hh;
      this.ply = ply + 1;
      this.posHL[ply + 1] = hl; this.posHH[ply + 1] = hh; this.chk[ply + 1] = -1;
    }
    unmake() {
      const ply = --this.ply, b = this.b;
      const m = this.uMove[ply];
      const us = this.stm ^ 1;
      this.stm = us;
      this.half = this.uHalf[ply];
      this.hl = this.posHL[ply]; this.hh = this.posHH[ply];
      if (m === 0) return; // ヌルムーブ
      const from = m & 255, to = (m >> 8) & 255, p = b[to], cap = this.uCap[ply];
      b[from] = p; b[to] = cap;
      if (cap) this.cnt[cap]++;
      if ((p & 7) === KING) this.king[us] = from;
      if (us === BLACK) this.full--;
    }
    // 指して、自分の王が取られる形なら戻して false。
    // inCheck に「指す前に王手されていない」(false) を渡すと、動かす駒が王でなく、元のマスが王と同じ筋・段にも王の斜め隣（馬の足）にもなく、
    // 行き先が王と同じ筋・段にない（炮の台にならない）ときは確かめを省く（その手で王が新たに狙われることはない）
    makeMove(m, inCheck) {
      const us = this.stm, from = m & 255, to = (m >> 8) & 255, k = this.king[us];
      let quick = false;
      if (inCheck === false && (this.b[from] & 7) !== KING) {
        const fd = (from & 15) - (k & 15), rd = (from >> 4) - (k >> 4);
        quick = fd !== 0 && rd !== 0 && !(fd * fd === 1 && rd * rd === 1) && (to & 15) !== (k & 15) && (to >> 4) !== (k >> 4);
      }
      this.make(m);
      if (!quick && this.kingAttacked(us)) { this.unmake(); return false; }
      return true;
    }
    makeNull() {
      if (this.ply + 2 >= this.cap) this.alloc(this.cap * 2);
      const ply = this.ply;
      this.uMove[ply] = 0; this.uHalf[ply] = this.half; this.uCap[ply] = 0;
      this.half = 0; // 繰り返しを調べるときヌルムーブの向こうは見ない
      this.stm ^= 1; this.hl ^= ZSL; this.hh ^= ZSH;
      this.ply = ply + 1;
      this.posHL[ply + 1] = this.hl; this.posHH[ply + 1] = this.hh; this.chk[ply + 1] = 0;
    }
    // 指して、王手かどうかも記録する（対局の進行用。繰り返しの判定に使う）
    play(m) {
      if (!this.makeMove(m)) return false;
      this.inCheck();
      return true;
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
    // 双方とも攻める駒（車・馬・炮・兵）がない
    noAttackers() {
      const c = this.cnt;
      for (let t = HORSE; t <= PAWN; t++) if (c[t] || c[t | 8]) return false;
      return true;
    }
    // ply k より後の局面の「王手されているか」を、まだ調べていなければ戻して指し直しながら調べる
    ensureChk(k) {
      let need = false;
      for (let j = k + 1; j <= this.ply; j++) if (this.chk[j] < 0) { need = true; break; }
      if (!need) return;
      const moves = [], top = this.ply;
      while (this.ply > k) { moves.push(this.uMove[this.ply - 1]); this.unmake(); }
      for (let i = moves.length - 1; i >= 0; i--) { const m = moves[i]; if (m) this.make(m); else this.makeNull(); this.inCheck(); }
      if (this.ply !== top) throw new Error('ensureChk');
    }
    // ply k の局面から今の局面までの手で、ずっと王手をかけ続けた側（長将）。0 赤 / 1 黒 / -1 なし・両方
    perpetual(k) {
      this.ensureChk(k);
      let last = true, mine = true; // last = 直前に指した側、mine = 手番の側
      for (let j = this.ply; j > k; j -= 2) if (this.chk[j] !== 1) { last = false; break; }
      for (let j = this.ply - 1; j > k; j -= 2) if (this.chk[j] !== 1) { mine = false; break; }
      if (last && !mine) return this.stm ^ 1;
      if (mine && !last) return this.stm;
      return -1;
    }
    // 今の局面が（この Position が知っている範囲で）何回目か、と最初に現れた手数
    repetitions() {
      let n = 1, first = this.ply;
      const hl = this.hl, hh = this.hh;
      for (let k = this.ply - 2, lim = Math.max(0, this.ply - this.half); k >= lim; k -= 2) if (this.posHL[k] === hl && this.posHH[k] === hh) { n++; first = k; }
      return { n, first };
    }
    // 終局なら { winner: 0 赤 / 1 黒 / -1 引き分け, reason }、続くなら null
    //   reason: 'mate' 将死 / 'stalemate' 困毙 / 'perpetual' 長将 / 'repetition' 同形三回 / 'limit' 60回合 / 'material' 攻める駒なし
    result() {
      if (!this.hasLegal()) return { winner: this.stm ^ 1, reason: this.inCheck() ? 'mate' : 'stalemate' };
      this.inCheck();
      const rep = this.repetitions();
      if (rep.n >= 3) {
        const pc = this.perpetual(rep.first);
        return pc >= 0 ? { winner: pc ^ 1, reason: 'perpetual' } : { winner: -1, reason: 'repetition' };
      }
      if (this.half >= LIMIT) return { winner: -1, reason: 'limit' };
      if (this.noAttackers()) return { winner: -1, reason: 'material' };
      return null;
    }

    // ---------------------------------------------------------------- 表記
    pieceAt(s) { return this.b[s]; }
    iccs(m) { return sqName(m & 255) + sqName((m >> 8) & 255); }
    moveFromICCS(str) {
      const t = String(str || '').trim().toLowerCase().replace(/[-x:]/g, '');
      if (!/^[a-i][0-9][a-i][0-9]$/.test(t)) return 0;
      const from = parseSq(t.slice(0, 2)), to = parseSq(t.slice(2, 4));
      return this.legalMoves().find(m => (m & 255) === from && ((m >> 8) & 255) === to) || 0;
    }
    // 中国式の表記: [駒][元の筋][進・退・平][行き先の筋 or 進んだ段の数]。赤の筋は右から 一〜九、黒の筋は（黒から見て）右から １〜９
    // 同じ筋に同じ駒が2つ以上あるときは 前・後（3つなら 前・中・後、4つ以上は 一二三…）で区別する（仕・相は進退で決まるので区別しない）
    chinese(m) {
      const b = this.b, from = m & 255, to = (m >> 8) & 255, p = b[from], c = p >> 3, t = p & 7;
      const ff = fileOf(from), fr = rankOf(from), tf = fileOf(to), tr = rankOf(to);
      const sg = c === RED ? 1 : -1, dr = (tr - fr) * sg;
      let tail;
      if (dr === 0) tail = '平' + numStr(c, fileNo(c, tf));
      else tail = (dr > 0 ? '進' : '退') + numStr(c, t === ADVISOR || t === ELEPHANT || t === HORSE ? fileNo(c, tf) : Math.abs(dr));
      const same = [];
      if (t !== ADVISOR && t !== ELEPHANT) for (let r = 0; r < 10; r++) if (b[sqOf(ff, r)] === p) same.push(r);
      if (same.length <= 1) return PIECE_NAME[c][t] + numStr(c, fileNo(c, ff)) + tail;
      same.sort((x, y) => (y - x) * sg); // 前（相手の陣に近い方）から
      const idx = same.indexOf(fr), n = same.length;
      const ord = n === 2 ? ['前', '後'][idx] : n === 3 ? ['前', '中', '後'][idx] : numStr(c, idx + 1);
      let multi = false; // 兵が2つ以上ある筋がほかにもあれば、駒の名前の代わりに筋の数字
      if (t === PAWN) for (let f2 = 0; f2 < 9 && !multi; f2++) {
        if (f2 === ff) continue;
        let k = 0;
        for (let r = 0; r < 10; r++) if (b[sqOf(f2, r)] === p) k++;
        if (k >= 2) multi = true;
      }
      return ord + (multi ? numStr(c, fileNo(c, ff)) : PIECE_NAME[c][t]) + tail;
    }
    // 中国式（簡体字・繁体字・日本の字・全角/半角の数字・WXF の英字 C2.5 なども）を指し手に。見つからなければ 0
    moveFromChinese(str) {
      const key = normChinese(str);
      if (!key || key.length < 4) return 0;
      const hit = this.legalMoves().filter(m => normChinese(this.chinese(m)) === key);
      return hit.length === 1 ? hit[0] : 0;
    }
    // 座標か中国式のどちらでも
    moveFromText(str) { return this.moveFromICCS(str) || this.moveFromChinese(str); }
  }

  const PIECE_NAME = [['', '帥', '仕', '相', '傌', '俥', '炮', '兵'], ['', '將', '士', '象', '馬', '車', '砲', '卒']];
  const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const FW_NUM = ['', '１', '２', '３', '４', '５', '６', '７', '８', '９'];
  const numStr = (c, n) => (c === RED ? CN_NUM[n] : FW_NUM[n]);
  const fileNo = (c, f) => (c === RED ? 9 - f : f + 1);
  // 表記のゆれを1つの形にそろえる（駒は色によらず K A E H R C P、進 + 退 - 平 =、前 f 中 m 後 b、数字は半角）
  const NORM = {
    帥: 'K', 帅: 'K', 將: 'K', 将: 'K', 仕: 'A', 士: 'A', 相: 'E', 象: 'E', 傌: 'H', 馬: 'H', 马: 'H', 俥: 'R', 車: 'R', 车: 'R', 炮: 'C', 砲: 'C', 兵: 'P', 卒: 'P',
    進: '+', 进: '+', 退: '-', 平: '=', 前: 'f', 中: 'm', 後: 'b', 后: 'b',
  };
  function normChinese(str) {
    let s = '';
    for (const ch of String(str || '').trim()) {
      if (NORM[ch]) { s += NORM[ch]; continue; }
      const cn = CN_NUM.indexOf(ch), fw = FW_NUM.indexOf(ch);
      if (cn > 0) { s += cn; continue; }
      if (fw > 0) { s += fw; continue; }
      if (/[1-9]/.test(ch)) { s += ch; continue; }
      const u = ch.toUpperCase();
      if ('KAEHRCP'.includes(u)) { s += u; continue; }
      if (u === 'B') { s += 'E'; continue; }   // WXF: B = 象
      if (u === 'N') { s += 'H'; continue; }   // WXF: N = 馬
      if (ch === '.') { s += '='; continue; }  // WXF: . = 平
      if (ch === '+' || ch === '-' || ch === '=') { s += ch; continue; }
      if (/\s/.test(ch)) continue;
      return ''; // 読めない文字
    }
    return s;
  }

  // 開始局面と指し手（整数）の列から局面を作る（ワーカーに渡すときなど）。王手の記録もつける
  Position.fromMoves = (fen, moves) => {
    const p = Position.fromFEN(fen || START_FEN);
    p.inCheck();
    for (const m of moves || []) if (!p.play(m)) throw new Error('合法でない手があります');
    return p;
  };

  // 合法手の数を深さ d まで数える（ルールの確かめ用）。perftQuick は探索と同じ省略をした確かめ方で
  function perftQuick(p, d) {
    if (d === 0) return 1;
    const buf = new Int32Array(256), n = p.gen(buf, 0, false), chk = p.kingAttacked(p.stm);
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

  // ---------------------------------------------------------------- 棋譜（PGN 風。[Format "Chinese"] の中国式、または座標 h2e2）
  const RESULT_TOKENS = ['1-0', '0-1', '1/2-1/2', '*'];
  function toPGN({ tags = {}, moves = [], startFen = null, result = '*', format = 'Chinese', firstFull = 1, blackFirst = false }) {
    const T = Object.assign({ Game: 'Chinese Chess', Event: '?', Site: '?', Date: '????.??.??', Red: '?', Black: '?' }, tags, { Result: result, Format: format === 'ICCS' ? 'ICCS' : 'Chinese' });
    if (startFen && startFen !== START_FEN) T.FEN = startFen;
    const order = ['Game', 'Event', 'Site', 'Date', 'Red', 'Black', 'Result'];
    const keys = order.concat(Object.keys(T).filter(k => !order.includes(k)));
    const head = keys.map(k => `[${k} "${String(T[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join('\n');
    const lines = [];
    let full = firstFull, red = !blackFirst, line = '';
    for (const s of moves) {
      if (red) line = `${full}. ${s}`;
      else { line = line ? `${line} ${s}` : `${full}. … ${s}`; lines.push(line); line = ''; full++; }
      red = !red;
    }
    if (line) lines.push(line);
    lines.push(result);
    return head + '\n\n' + lines.join('\n') + '\n';
  }
  // 棋譜を読む（最初の1局。注釈 {} ; 、変化 () は読み飛ばす）。{ tags, startFen, moves, texts, result, position }。読めない手があれば Error
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
    const nextTag = body.search(/\n\s*\[\w+\s+"/);
    if (nextTag >= 0) body = body.slice(0, nextTag);
    body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
    let depth = 0, flat = '';
    for (const ch of body) { if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1); else if (!depth) flat += ch; }
    const startFen = tags.FEN || START_FEN;
    const p = Position.fromFEN(startFen);
    p.inCheck();
    const moves = [], texts = [];
    let result = tags.Result && RESULT_TOKENS.includes(tags.Result) ? tags.Result : '*';
    for (let tok of flat.split(/[\s,，、]+/)) {
      if (!tok) continue;
      if (RESULT_TOKENS.includes(tok)) { result = tok; break; }
      tok = tok.replace(/^\d+\.+/, '').replace(/^[…]+/, '');
      if (!tok || /^\.+$/.test(tok) || /^[!?]+$/.test(tok) || tok === '…') continue;
      const m = p.moveFromText(tok);
      if (!m) throw new Error(`${moves.length + 1}手目の「${tok}」が指せません`);
      texts.push(p.chinese(m));
      p.play(m);
      moves.push(m);
    }
    return { tags, startFen, moves, texts, result, position: p };
  }

  const PIECE_JA = ['', '帥・將', '仕・士', '相・象', '傌・馬', '俥・車', '炮・砲', '兵・卒'];
  const REASON_JA = { mate: '将死（詰み）', stalemate: '困毙（指せる手がない）', perpetual: '長将（王手の繰り返し）', repetition: '同形三回', limit: '60回合ルール', material: '攻める駒がない', resign: '投了', agree: '合意', disconnect: '相手の接続切れ' };

  Object.assign(C, {
    RED, BLACK, KING, ADVISOR, ELEPHANT, HORSE, ROOK, CANNON, PAWN, OFF, NSQ, FILES, START_FEN, LIMIT,
    PIECE_NAME, PIECE_JA, REASON_JA, CN_NUM, FW_NUM, ORTH, DIAG, HORSE_L, ELEPH_L, HORSE_ATK, FWD, ON, SQS, PALACE, HALF, ZPL, ZPH,
    sqOf, fileOf, rankOf, sq90, fromSq90, sqName, parseSq, mvFrom, mvTo, mvCap, mkMove, placeOk, MAX_COUNT, numStr, fileNo, normChinese,
    Position, perft, perftQuick, toPGN, parsePGN,
  });
  return C;
}
if (typeof module !== 'undefined' && module.exports) module.exports = XiangqiCore;
