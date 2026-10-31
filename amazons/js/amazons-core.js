/* アマゾンズのルール（10×10・各4体）
 * 盤は周りに壁を付けた 12×12 の配列（添字 p = (行+1)*12 + 列+1。行0 = 1段目 = 白の側、列0 = a筋）
 * 手は1つの整数: 動かすアマゾンのマス | 行き先<<8 | 矢のマス<<16（どれも 12×12 の添字）
 * ブラウザ（Web Worker にも文字列で渡す）と Node（学習）の両方で使う */
function AmazonsCore(A) {
  'use strict';
  const N = 10, W = 12, SZ = 144;
  const EMPTY = 0, WQ = 1, BQ = 2, ARROW = 3, WALL = 4;
  const WHITE = 0, BLACK = 1;
  const DIRS = [1, -1, W, -W, W + 1, -W - 1, W - 1, -W + 1];
  const P = (r, c) => (r + 1) * W + c + 1;
  const rowOf = p => ((p / W) | 0) - 1, colOf = p => (p % W) - 1;
  const SQ = new Int16Array(100);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) SQ[r * N + c] = P(r, c);
  const idx100 = p => rowOf(p) * N + colOf(p);
  const mv = (f, t, a) => f | (t << 8) | (a << 16);
  const mFrom = m => m & 255, mTo = m => (m >> 8) & 255, mArrow = m => (m >> 16) & 255;
  // はじめの並び: 白 a4 d1 g1 j4、黒 a7 d10 g10 j7。白が先に指す
  const START = [[P(3, 0), P(0, 3), P(0, 6), P(3, 9)], [P(6, 0), P(9, 3), P(9, 6), P(6, 9)]];

  // 同じ局面を見分けるための乱数（32ビット2つ）。決まった種から作るので、どこで作っても同じ値
  let seed = 0x9e3779b9;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) | 0; };
  const Z1 = new Int32Array(SZ * 4), Z2 = new Int32Array(SZ * 4);
  for (let i = 0; i < SZ * 4; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  const ZS1 = rnd(), ZS2 = rnd();

  class Position {
    constructor() {
      this.b = new Uint8Array(SZ);
      this.q = [new Int16Array(4), new Int16Array(4)];
      this.stm = WHITE; this.ply = 0; this.h1 = 0; this.h2 = 0;
      for (let p = 0; p < SZ; p++) this.b[p] = WALL;
      for (let i = 0; i < 100; i++) this.b[SQ[i]] = EMPTY;
      for (let s = 0; s < 2; s++) for (let k = 0; k < 4; k++) { const p = START[s][k]; this.q[s][k] = p; this.b[p] = s + 1; this.h1 ^= Z1[p * 4 + s + 1]; this.h2 ^= Z2[p * 4 + s + 1]; }
    }
    clone() {
      const o = Object.create(Position.prototype);
      o.b = this.b.slice(); o.q = [this.q[0].slice(), this.q[1].slice()];
      o.stm = this.stm; o.ply = this.ply; o.h1 = this.h1; o.h2 = this.h2;
      return o;
    }
    // 100マスの番号（行*10+列）で中身を返す: 0 空き・1 白・2 黒・3 矢
    at(i) { return this.b[SQ[i]]; }
    make(m) {
      const f = m & 255, t = (m >> 8) & 255, a = (m >> 16) & 255, s = this.stm, pc = s + 1, b = this.b, q = this.q[s];
      b[f] = EMPTY; b[t] = pc; b[a] = ARROW;
      for (let k = 0; k < 4; k++) if (q[k] === f) { q[k] = t; break; }
      this.h1 ^= Z1[f * 4 + pc] ^ Z1[t * 4 + pc] ^ Z1[a * 4 + ARROW] ^ ZS1;
      this.h2 ^= Z2[f * 4 + pc] ^ Z2[t * 4 + pc] ^ Z2[a * 4 + ARROW] ^ ZS2;
      this.stm = s ^ 1; this.ply++;
    }
    unmake(m) {
      const f = m & 255, t = (m >> 8) & 255, a = (m >> 16) & 255, s = this.stm ^ 1, pc = s + 1, b = this.b, q = this.q[s];
      b[a] = EMPTY; b[t] = EMPTY; b[f] = pc;
      for (let k = 0; k < 4; k++) if (q[k] === t) { q[k] = f; break; }
      this.h1 ^= Z1[f * 4 + pc] ^ Z1[t * 4 + pc] ^ Z1[a * 4 + ARROW] ^ ZS1;
      this.h2 ^= Z2[f * 4 + pc] ^ Z2[t * 4 + pc] ^ Z2[a * 4 + ARROW] ^ ZS2;
      this.stm = s; this.ply--;
    }
    // 合法手をすべて out に書き、数を返す（out は十分に大きい配列）
    genMoves(out) {
      const b = this.b, q = this.q[this.stm];
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const f = q[k];
        b[f] = EMPTY; // 動いたあとは元のマスにも矢を放てる
        for (let d = 0; d < 8; d++) {
          const dt = DIRS[d];
          for (let t = f + dt; b[t] === EMPTY; t += dt) {
            const ft = f | (t << 8);
            for (let e = 0; e < 8; e++) {
              const de = DIRS[e];
              for (let a = t + de; b[a] === EMPTY; a += de) out[n++] = ft | (a << 16);
            }
          }
        }
        b[f] = this.stm + 1;
      }
      return n;
    }
    legalMoves() { const out = []; this.genMoves(out); return out; }
    // その側が1手でも指せるか（となりに空きマスがあれば、動いて元のマスに矢を放てる）
    canMove(s) {
      const b = this.b, q = this.q[s];
      for (let k = 0; k < 4; k++) { const f = q[k]; for (let d = 0; d < 8; d++) if (b[f + DIRS[d]] === EMPTY) return true; }
      return false;
    }
    isOver() { return !this.canMove(this.stm); }
    // 終局なら { winner, loser }（指せなくなった側の負け）
    result() { return this.canMove(this.stm) ? null : { winner: this.stm ^ 1, loser: this.stm }; }
    isLegal(m) {
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 0) return false;
      const f = m & 255, t = (m >> 8) & 255, a = (m >> 16) & 255;
      if (m >>> 24) return false;
      if (f >= SZ || t >= SZ || a >= SZ || this.b[f] !== this.stm + 1) return false;
      if (!clearLine(this.b, f, t)) return false;
      this.b[f] = EMPTY;
      const ok = clearLine(this.b, t, a);
      this.b[f] = this.stm + 1;
      return ok;
    }
    // マス f のアマゾンが行けるマス（100マスの番号）
    reachFrom(p) {
      const out = [], b = this.b;
      for (let d = 0; d < 8; d++) for (let t = p + DIRS[d]; b[t] === EMPTY; t += DIRS[d]) out.push(t);
      return out;
    }
    static fromMoves(moves) { const p = new Position(); for (const m of moves) p.make(m); return p; }
  }

  // x から y まで、女王の動き（縦横斜め）で、途中と y が空いているか
  function clearLine(b, x, y) {
    if (x === y) return false;
    const dr = rowOf(y) - rowOf(x), dc = colOf(y) - colOf(x);
    if (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc)) return false;
    const st = Math.sign(dr) * W + Math.sign(dc);
    for (let p = x + st; ; p += st) { if (b[p] !== EMPTY) return false; if (p === y) return true; }
  }

  // 表記: a〜j の筋と 1〜10 の段。手は「d1-d7/g7」（動かす前-動いた先/矢）
  const FILES = 'abcdefghij';
  const sqName = p => FILES[colOf(p)] + (rowOf(p) + 1);
  const moveName = m => `${sqName(mFrom(m))}-${sqName(mTo(m))}/${sqName(mArrow(m))}`;
  const parseSq = s => { const r = /^([a-j])(10|[1-9])$/.exec(String(s).trim().toLowerCase()); return r ? P(Number(r[2]) - 1, FILES.indexOf(r[1])) : -1; };
  const MOVE_RE = /([a-j])(10|[1-9])\s*[-x×]?\s*([a-j])(10|[1-9])\s*[\/(,]?\s*([a-j])(10|[1-9])\)?/gi;
  function parseMoves(text) {
    const out = [], p = new Position();
    const src = String(text).toLowerCase().replace(/\b\d+\s*\.(?!\d)/g, ' ');
    let r;
    MOVE_RE.lastIndex = 0;
    while ((r = MOVE_RE.exec(src))) {
      const m = mv(P(Number(r[2]) - 1, FILES.indexOf(r[1])), P(Number(r[4]) - 1, FILES.indexOf(r[3])), P(Number(r[6]) - 1, FILES.indexOf(r[5])));
      if (!p.isLegal(m)) throw new Error(`${out.length + 1}手目 ${r[0].trim()} は指せない手です`);
      p.make(m); out.push(m);
    }
    return out;
  }
  function transcript(moves) {
    const parts = [];
    for (let i = 0; i < moves.length; i += 2) parts.push(`${i / 2 + 1}. ${moveName(moves[i])}${i + 1 < moves.length ? ' ' + moveName(moves[i + 1]) : ''}`);
    return parts.join('\n');
  }
  // オンラインなどで送る形（100マスの番号 f*10000 + t*100 + a）と内部の形の変換
  const toWire = m => idx100(mFrom(m)) * 10000 + idx100(mTo(m)) * 100 + idx100(mArrow(m));
  const fromWire = x => { x = Number(x); if (!Number.isInteger(x) || x < 0 || x > 999999) return -1; return mv(SQ[(x / 10000) | 0], SQ[((x / 100) | 0) % 100], SQ[x % 100]); };

  Object.assign(A, {
    N, W, SZ, EMPTY, WQ, BQ, ARROW, WALL, WHITE, BLACK, DIRS, SQ, START, Z1, Z2, ZS1, ZS2,
    P, rowOf, colOf, idx100, mv, mFrom, mTo, mArrow, Position, clearLine,
    sqName, moveName, parseSq, parseMoves, transcript, toWire, fromWire,
  });
  return A;
}
if (typeof module === 'object' && module.exports) module.exports = AmazonsCore;
