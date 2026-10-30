/* 連珠（五目並べ）のルール: 盤・勝ち・黒の禁手（三三・四四・長連）・棋譜の書き方・珠型
 *
 * 盤は 15×15。内部では周りに 5 マスずつ「壁」を置いた 25 行 × 20 列の一次元の配列で持つ（端の判定がいらない）。
 *   内部の番号 i = (y + 5) * 20 + x   （x, y は 0〜14、y = 0 が上の行）
 *   外向きの番号 p = y * 15 + x       （画面・棋譜・通信はこちら）
 * 棋譜の書き方は連珠の慣習どおり、列は左から a〜o、行は下から 1〜15（天元 = h8）。
 *
 * 禁手の判定（連珠の国際ルールの定義どおり）:
 *   ・五（ちょうど5つ）ができれば、同時に三三・四四・長連ができていても勝ち（五が優先）
 *   ・長連: 6つ以上並ぶ
 *   ・四四: 1手で四が2つ以上できる（同じ線の上の「●・●●●・●」のような形も四が2つ）
 *   ・三三: 1手で三が2つ以上できる。ここでの「三」は、あと1手で達四（両端どちらでも五になる四）にできる形で、
 *           しかもその1手自体が禁手でないもの（本当の三）。その1手が禁手かどうかは同じ判定をくり返して確かめる
 *   ・四と三が同時（四三）は禁手ではない。四三三は三三を含むので禁手
 * 白には禁手がなく、五以上（長連も）で勝ち。「自由」ルールでは黒白とも禁手なしで五以上で勝ち。
 */
function RenjuCore(R) {
  'use strict';
  const N = 15, PAD = 5, W = 20, H = N + 2 * PAD, SIZE = H * W;
  const EMPTY = 0, BLACK = 1, WHITE = 2, WALL = 3;
  const DIRS = [1, W, W + 1, W - 1]; // 横・縦・右下がり・左下がり
  const CENTER = 7 * N + 7;
  const COLS = 'abcdefghijklmno';
  const toI = p => (((p / N) | 0) + PAD) * W + (p % N);
  const toP = i => ((i / W) | 0) * N - PAD * N + (i % W);
  const I2P = new Int16Array(SIZE).fill(-1), P2I = new Int16Array(N * N);
  for (let p = 0; p < N * N; p++) { P2I[p] = toI(p); I2P[toI(p)] = p; }
  const ptName = p => COLS[p % N] + (N - ((p / N) | 0));
  function parsePt(s) {
    const m = /^\s*([a-oA-O])\s*(\d{1,2})\s*$/.exec(String(s));
    if (!m) return -1;
    const x = COLS.indexOf(m[1].toLowerCase()), r = Number(m[2]);
    if (r < 1 || r > N) return -1;
    return (N - r) * N + x;
  }

  // 禁手の種類（0 = 禁手でない）
  const NOT_FORBIDDEN = 0, F33 = 1, F44 = 2, FLONG = 3;
  const FORBID_NAME = ['', '三三', '四四', '長連'];

  // ------------------------------------------------------------------ 線の上の形（c は盤の配列。i には col の石が置いてある前提）
  // i を通る d 方向に col の石がいくつ続くか
  function runLen(c, i, d, col) {
    let n = 1, j = i + d;
    while (c[j] === col) { n++; j += d; }
    j = i - d;
    while (c[j] === col) { n++; j -= d; }
    return n;
  }
  // i に置いた col の石で五ができたか（exact: ちょうど5つで五。連珠の黒）
  function makesFive(c, i, col, exact) {
    for (let k = 0; k < 4; k++) {
      const r = runLen(c, i, DIRS[k], col);
      if (exact ? r === 5 : r >= 5) return true;
    }
    return false;
  }
  // d 方向で、i の石を含む四がいくつあるか（0, 1, 2）。
  // 空き点 q に置くと i を含む五になるとき、q は四の「五になる点」。2点あって間隔がちょうど5なら達四（四は1つ）、それ以外なら四が2つ
  function foursInLine(c, i, d, col, exact) {
    let k1 = 0, cnt = 0;
    for (let k = -4; k <= 4; k++) {
      if (!k) continue;
      const q = i + k * d;
      if (c[q] !== EMPTY) continue;
      // q と i の間がすべて col の石なら、q に置いた石の並びは i を含む
      let ok = true;
      const s = k > 0 ? 1 : -1;
      for (let t = s; t !== k; t += s) if (c[i + t * d] !== col) { ok = false; break; }
      if (!ok) continue;
      c[q] = col;
      const r = runLen(c, q, d, col);
      c[q] = EMPTY;
      if (exact ? r === 5 : r >= 5) {
        if (cnt === 0) { k1 = k; cnt = 1; } else { return Math.abs(k - k1) === 5 ? 1 : 2; }
      }
    }
    return cnt;
  }
  // q に石を置いた直後、d 方向に i と q を含む達四（「・●●●●・」で両端どちらでも五）ができているか
  function straightFour(c, i, q, d, col, exact) {
    let lo = q, hi = q;
    while (c[lo - d] === col) lo -= d;
    while (c[hi + d] === col) hi += d;
    if ((hi - lo) / d !== 3) return false;           // ちょうど4つ
    if ((i - lo) / d < 0 || (hi - i) / d < 0) return false; // i を含む
    const a = lo - d, b = hi + d;
    if (c[a] !== EMPTY || c[b] !== EMPTY) return false;
    if (exact && (c[a - d] === col || c[b + d] === col)) return false; // 端に置くと長連になるなら五にならない
    return true;
  }
  // d 方向に、i の石を含む本当の三があるか（黒の連珠なら、達四にする点が禁手でないこと）
  function threeInLine(c, i, d, col, exact) {
    for (let k = -4; k <= 4; k++) {
      if (!k) continue;
      const q = i + k * d;
      if (c[q] !== EMPTY) continue;
      c[q] = col;
      let ok = straightFour(c, i, q, d, col, exact);
      if (ok && exact) ok = forbiddenAt(c, q) === NOT_FORBIDDEN;
      c[q] = EMPTY;
      if (ok) return true;
    }
    return false;
  }
  // i に黒石を置いた（置いてある）とき、それが禁手か。0 / F33 / F44 / FLONG
  function forbiddenAt(c, i) {
    let over = false;
    for (let k = 0; k < 4; k++) {
      const r = runLen(c, i, DIRS[k], BLACK);
      if (r === 5) return NOT_FORBIDDEN; // 五が優先
      if (r > 5) over = true;
    }
    if (over) return FLONG;
    let fours = 0, fourMask = 0;
    for (let k = 0; k < 4; k++) {
      const f = foursInLine(c, i, DIRS[k], BLACK, true);
      if (f) { fours += f; fourMask |= 1 << k; }
    }
    if (fours >= 2) return F44;
    let threes = 0;
    for (let k = 0; k < 4; k++) {
      if (fourMask & (1 << k)) continue;
      if (threeInLine(c, i, DIRS[k], BLACK, true) && ++threes >= 2) return F33;
    }
    return NOT_FORBIDDEN;
  }
  // 空き点 i に黒を置くと禁手か（盤は元に戻す）
  function forbidden(c, i) {
    if (c[i] !== EMPTY) return NOT_FORBIDDEN;
    c[i] = BLACK;
    const r = forbiddenAt(c, i);
    c[i] = EMPTY;
    return r;
  }
  // 禁手かもしれない点だけを速く見分ける（違うと分かれば false。true なら forbidden() で確かめる）
  // 三三は2方向にそれぞれ2つ以上、四四・長連は1方向に4つ以上（または2方向に3つ以上）の黒が近くに要る
  function maybeForbidden(c, i) {
    let two = 0;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k];
      let n = 0;
      for (let t = 1; t <= 4; t++) { const v = c[i + t * d]; if (v === BLACK) n++; else if (v !== EMPTY) break; }
      for (let t = 1; t <= 4; t++) { const v = c[i - t * d]; if (v === BLACK) n++; else if (v !== EMPTY) break; }
      if (n >= 4) return true;
      if (n >= 2 && ++two >= 2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ 対局
  const RULES = {
    renju: { name: '連珠', desc: '黒に三三・四四・長連の禁手。白は五以上で勝ち', exactBlack: true },
    free: { name: '自由', desc: '禁手なし。黒白とも五以上で勝ち', exactBlack: false },
  };
  const OPENINGS = {
    tengen: { name: '天元から', desc: '1手目は盤の中央（天元）' },
    shukei: { name: '珠型', desc: '3手目までを26通りの珠型からくじ引き' },
    any: { name: '自由に', desc: '1手目からどこでも' },
  };

  class Game {
    // opts: { rule: 'renju' | 'free', opening: 'tengen' | 'shukei' | 'any' }
    constructor(opts = {}) {
      this.rule = RULES[opts.rule] ? opts.rule : 'renju';
      this.opening = OPENINGS[opts.opening] ? opts.opening : 'tengen';
      this.c = new Int8Array(SIZE).fill(WALL);
      for (let p = 0; p < N * N; p++) this.c[P2I[p]] = EMPTY;
      this.moves = [];
      this.stm = BLACK;
      this.result = null;
      this.fcache = null; // 黒の禁手点の一覧（局面が変わったら作り直す）
    }
    static fromMoves(opts, moves) {
      const g = new Game(opts);
      for (const p of moves) { if (!g.isLegal(p)) throw new Error(`${g.moves.length + 1}手目 ${ptName(p)} は打てません`); g.play(p); }
      return g;
    }
    get exact() { return this.rule === 'renju' && this.stm === BLACK; }
    at(p) { return this.c[P2I[p]]; }
    // 1手目を天元に限るか
    centerOnly() { return this.opening !== 'any' && this.moves.length === 0; }
    forbiddenKind(p) {
      if (this.rule !== 'renju' || this.stm !== BLACK) return NOT_FORBIDDEN;
      const i = P2I[p];
      if (this.c[i] !== EMPTY || !maybeForbidden(this.c, i)) return NOT_FORBIDDEN;
      return forbidden(this.c, i);
    }
    // 黒番の禁手点（p → 種類）
    forbiddenPoints() {
      if (this.fcache) return this.fcache;
      const m = new Map();
      if (this.rule === 'renju' && this.stm === BLACK && !this.result) {
        for (let p = 0; p < N * N; p++) { const f = this.forbiddenKind(p); if (f) m.set(p, f); }
      }
      return (this.fcache = m);
    }
    isLegal(p) {
      if (this.result || !(p >= 0 && p < N * N) || this.c[P2I[p]] !== EMPTY) return false;
      if (this.centerOnly() && p !== CENTER) return false;
      return !this.forbiddenPoints().has(p);
    }
    legalMoves() {
      const out = [];
      for (let p = 0; p < N * N; p++) if (this.isLegal(p)) out.push(p);
      return out;
    }
    play(p) {
      const i = P2I[p], col = this.stm;
      this.c[i] = col;
      this.moves.push(p);
      this.fcache = null;
      if (makesFive(this.c, i, col, this.rule === 'renju' && col === BLACK)) this.result = { winner: col, reason: '五' };
      else if (this.moves.length === N * N) this.result = { winner: 0, reason: '盤が埋まった' };
      this.stm = 3 - col;
      if (!this.result && this.legalMoves().length === 0) this.result = { winner: 0, reason: '打てる点がない' };
      return this.result;
    }
    undo() {
      if (!this.moves.length) return;
      const p = this.moves.pop();
      this.c[P2I[p]] = EMPTY;
      this.stm = 3 - this.stm;
      this.result = null;
      this.fcache = null;
    }
    // 盤の上の脅威（col の側）:
    //   five: そこに置くと五になる点（= いま四がある）
    //   four: そこに置くと達四（止められない四）になる点（= いま三がある）。黒の連珠では禁手の点は除く
    threats(col) {
      const c = this.c, ex = this.rule === 'renju' && col === BLACK, five = [], four = [];
      for (let p = 0; p < N * N; p++) {
        const i = P2I[p];
        if (c[i] !== EMPTY) continue;
        c[i] = col;
        if (makesFive(c, i, col, ex)) five.push(p);
        else {
          let f = false;
          for (let k = 0; k < 4 && !f; k++) f = straightFour(c, i, i, DIRS[k], col, ex);
          // 黒は、達四にする点が禁手（四四・四三三など）なら脅威ではない
          if (f && (!ex || forbiddenAt(c, i) === NOT_FORBIDDEN)) four.push(p);
        }
        c[i] = EMPTY;
      }
      return { five, four };
    }
    // 盤の上に並んでいる四・三（表示用）: [{ col, kind: 4 | 3, dir, stones: [p…], points: [p…（五・達四になる点）] }]
    lines() {
      const out = new Map(), c = this.c;
      for (const col of [BLACK, WHITE]) {
        const t = this.threats(col), ex = this.rule === 'renju' && col === BLACK;
        for (const [kind, pts] of [[4, t.five], [3, t.four]]) for (const q of pts) {
          const iq = P2I[q];
          c[iq] = col;
          for (let k = 0; k < 4; k++) {
            const d = DIRS[k];
            if (kind === 4) { const r = runLen(c, iq, d, col); if (!(ex ? r === 5 : r >= 5)) continue; }
            else if (!straightFour(c, iq, iq, d, col, ex)) continue;
            let lo = iq, hi = iq;
            while (c[lo - d] === col) lo -= d;
            while (c[hi + d] === col) hi += d;
            const stones = [];
            for (let j = lo; j <= hi; j += d) if (j !== iq) stones.push(I2P[j]);
            const key = `${col}:${k}:${stones.join(',')}`;
            if (!out.has(key)) out.set(key, { col, kind, dir: k, stones, points: [] });
            const e = out.get(key);
            if (!e.points.includes(q)) e.points.push(q);
          }
          c[iq] = EMPTY;
        }
      }
      return [...out.values()];
    }
  }
  const stoneDist = (a, b) => Math.max(Math.abs((a % N) - (b % N)), Math.abs(((a / N) | 0) - ((b / N) | 0)));

  // ------------------------------------------------------------------ 珠型（1手目 天元、2手目はその隣、3手目は中央の 5×5）
  // 盤の対称（回転・裏返し）で同じになるものを除くと、直接打ち（2手目が縦横の隣）13 通り・間接打ち（斜めの隣）13 通りの 26 通り
  const SYM = [
    (x, y) => [x, y], (x, y) => [-y, x], (x, y) => [-x, -y], (x, y) => [y, -x],
    (x, y) => [-x, y], (x, y) => [y, x], (x, y) => [x, -y], (x, y) => [-y, -x],
  ];
  const P = (x, y) => (7 - y) * N + (7 + x); // 天元を原点、上を +y にした座標 → p
  function shukeiList() {
    const out = [];
    for (const [kind, second] of [['直接', [0, 1]], ['間接', [1, 1]]]) {
      const seen = new Set();
      for (let y = 2; y >= -2; y--) for (let x = -2; x <= 2; x++) {
        if ((x === 0 && y === 0) || (x === second[0] && y === second[1])) continue;
        // 2手目を動かさない対称で、3手目を一番小さい代表に
        const keys = SYM.map(f => { const a = f(...second); return a[0] === second[0] && a[1] === second[1] ? f(x, y).join(',') : null; }).filter(Boolean);
        const rep = keys.sort()[0];
        if (seen.has(rep)) continue;
        seen.add(rep);
        out.push({ kind, no: seen.size, moves: [P(0, 0), P(...second), P(x, y)] });
      }
    }
    return out;
  }
  const SHUKEI = shukeiList();
  // 珠型を盤の対称でランダムに回して返す
  function randomShukei(rand = Math.random) {
    const s = SHUKEI[Math.floor(rand() * SHUKEI.length)];
    const f = SYM[Math.floor(rand() * 8)];
    return { name: `${s.kind}打ち${s.no}`, moves: s.moves.map(p => { const [x, y] = f((p % N) - 7, 7 - ((p / N) | 0)); return P(x, y); }) };
  }

  Object.assign(R, {
    N, PAD, W, SIZE, EMPTY, BLACK, WHITE, WALL, DIRS, CENTER, COLS, P2I, I2P, toI, toP,
    ptName, parsePt, runLen, makesFive, foursInLine, straightFour, threeInLine, forbiddenAt, forbidden, maybeForbidden,
    NOT_FORBIDDEN, F33, F44, FLONG, FORBID_NAME, RULES, OPENINGS, Game, SHUKEI, randomShukei, SYM, stoneDist,
  });
  return R;
}
if (typeof module !== 'undefined' && module.exports) module.exports = RenjuCore;
