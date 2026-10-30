/* リバーシの AI: パターン評価（自己対局で学んだ重み）＋ αβ探索（PVS・置換表・手の並べ替え）＋ 終盤の完全読み
 *
 * 評価値の単位は「石1つ = 100」。正なら手番の側が最後にそれだけ多く石を持つ見込み。
 * 評価関数: 盤の辺・隅・斜め・行の形（パターン）ごとに、その形の並び（空き・自分・相手の 3^n 通り）の点数を足し合わせる。
 *   点数の表は人が決めたものではなく、自己対局の結果から学習する（train/train.js）。表は対局の進み具合（石の数）で段階に分ける。
 * 探索: 反復深化の PVS（主変化探索）。置換表は Web Worker どうしで共有できる（Lazy SMP）。
 * 終盤: 残りの空きが少なければ最後まで読み切って、石の差を正確に求める（速く相手の手を減らす手から読む）。
 */
function ReversiAI(R) {
  'use strict';
  const { OUT, SL, SH, popcnt, genMoves, flips, PASS } = R;
  const SC = 100;           // 石1つ
  const INF = 1 << 20;
  const MAXPLY = 80;

  // ------------------------------------------------------------------ パターン
  // 座標は [列, 行]（0..7）。隅 a1 を基準にした形を書き、盤の8通りの対称（回転・裏返し）で全部の置き場所を作る
  const line = (f, n) => Array.from({ length: n }, (_, i) => f(i));
  const PATTERN_DEFS = [
    ['hor2', line(i => [i, 1], 8)],
    ['hor3', line(i => [i, 2], 8)],
    ['hor4', line(i => [i, 3], 8)],
    ['diag8', line(i => [i, i], 8)],
    ['diag7', line(i => [i + 1, i], 7)],
    ['diag6', line(i => [i + 2, i], 6)],
    ['diag5', line(i => [i + 3, i], 5)],
    ['diag4', line(i => [i + 4, i], 4)],
    ['edge', [...line(i => [i, 0], 8), [1, 1], [6, 1]]],
    ['corner3', [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]],
    ['corner25', [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]],
  ];
  const SYMS = [
    (x, y) => [x, y], (x, y) => [7 - x, y], (x, y) => [x, 7 - y], (x, y) => [7 - x, 7 - y],
    (x, y) => [y, x], (x, y) => [7 - y, x], (x, y) => [y, 7 - x], (x, y) => [7 - y, 7 - x],
  ];
  const POW3 = [1]; for (let i = 1; i <= 12; i++) POW3.push(POW3[i - 1] * 3);
  const TYPES = PATTERN_DEFS.map(([name, cells]) => ({ name, n: cells.length, size: POW3[cells.length], sq: cells.map(([x, y]) => y * 8 + x) }));
  const INST = []; // { type, sq: [マス…] }
  TYPES.forEach((t, ti) => {
    const seen = new Set();
    for (const g of SYMS) {
      const sq = PATTERN_DEFS[ti][1].map(([x, y]) => { const [a, b] = g(x, y); return b * 8 + a; });
      const key = sq.slice().sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      INST.push({ type: ti, sq });
    }
  });
  const NI = INST.length; // 46
  // 段階ごとの表の並び: [各パターンの 3^n 通り…][石の数ごとの定数 65][盤全体の特徴 4×MOBK]
  // 盤全体の特徴（第13世代から）: 手番の側の打てる手の数・相手の打てる手の数・手番の側の「次に打てるかもしれない空き」
  // （相手の石に接している空きマス）の数・相手のその数。それぞれ数ごとに点数を持つ（0〜MOBK−1、それ以上はまとめる）
  const MOBK = 40, NMOB = 4;
  const TYPE_OFF = [];
  let tableSize = 0;
  for (const t of TYPES) { TYPE_OFF.push(tableSize); tableSize += t.size; }
  const BIAS_OFF = tableSize; tableSize += 65;
  const MOB_OFF = tableSize; tableSize += NMOB * MOBK;
  const STAGE_SIZE = tableSize;
  const NF = NI + 1 + NMOB; // 1つの局面の特徴の数（学習用）
  const INST_OFF = new Int32Array(NI);
  INST.forEach((it, i) => { INST_OFF[i] = TYPE_OFF[it.type]; });
  // マスごとに「どのパターンの何桁目か」
  const FS = new Int32Array(65), FI = [], FP = [];
  for (let s = 0; s < 64; s++) {
    FS[s] = FI.length;
    INST.forEach((it, i) => { const k = it.sq.indexOf(s); if (k >= 0) { FI.push(i); FP.push(POW3[k]); } });
  }
  FS[64] = FI.length;
  const FIa = Int32Array.from(FI), FPa = Int32Array.from(FP), FP2 = Int32Array.from(FP, x => 2 * x);

  // 形の中での対称（例: 辺は左右の裏返しで同じ形）。学習では対称な並びを同じ重みにまとめる（canon）
  function typeCanon(ti) {
    const t = TYPES[ti], S = t.sq, perms = [];
    for (const g of SYMS) {
      const img = S.map(s => { const [a, b] = g(s & 7, s >> 3); return b * 8 + a; });
      if (img.slice().sort((a, b) => a - b).join(',') !== S.slice().sort((a, b) => a - b).join(',')) continue;
      perms.push(img.map(s => S.indexOf(s)));
    }
    const canon = new Int32Array(t.size);
    const dig = new Int32Array(t.n);
    for (let idx = 0; idx < t.size; idx++) {
      let x = idx;
      for (let k = 0; k < t.n; k++) { dig[k] = x % 3; x = (x / 3) | 0; }
      let best = idx;
      for (const p of perms) { let v = 0; for (let k = 0; k < t.n; k++) v += dig[k] * POW3[p[k]]; if (v < best) best = v; }
      canon[idx] = best;
    }
    return canon;
  }
  let CANON = null; // [type] → Int32Array（必要になったときに作る）
  const canonTables = () => CANON || (CANON = TYPES.map((_, i) => typeCanon(i)));

  // 局面の特徴: 46 個のパターンの並びの番号（idx）。P = 1, O = 2 の3進数
  const IDX = new Int32Array(NI);
  function patternIndex(pl, ph, ol, oh, idx) {
    idx.fill(0);
    for (let x = pl; x; x &= x - 1) { const s = 31 - Math.clz32(x & -x); for (let j = FS[s], e = FS[s + 1]; j < e; j++) idx[FIa[j]] += FPa[j]; }
    for (let x = ph; x; x &= x - 1) { const s = 63 - Math.clz32(x & -x); for (let j = FS[s], e = FS[s + 1]; j < e; j++) idx[FIa[j]] += FPa[j]; }
    for (let x = ol; x; x &= x - 1) { const s = 31 - Math.clz32(x & -x); for (let j = FS[s], e = FS[s + 1]; j < e; j++) idx[FIa[j]] += FP2[j]; }
    for (let x = oh; x; x &= x - 1) { const s = 63 - Math.clz32(x & -x); for (let j = FS[s], e = FS[s + 1]; j < e; j++) idx[FIa[j]] += FP2[j]; }
  }

  // ------------------------------------------------------------------ 重み
  // 重みの形式（js/weights.js の REVERSI_WEIGHTS）:
  //   { v: 1, stageOf: [石の数 → 段階], nStage, data: base64（段階ごと・パターンごとの対称をまとめた値。int16, 単位 1/100 石）, gen, … }
  // 学習していない（空の）重みでは評価はいつも 0 になり、探索は終盤の読み切りだけで指す
  function defaultStageOf() { const a = []; for (let d = 0; d <= 64; d++) a.push(Math.max(0, Math.min(14, ((d - 4) / 4) | 0))); return a; }
  function canonSizes() { const c = canonTables(); return TYPES.map((t, i) => { let n = 0; for (let k = 0; k < t.size; k++) if (c[i][k] === k) n++; return n; }); }
  // 対称をまとめた番号（学習用）: 種類 ti の並び idx → 0..canonSize-1
  let CIDX = null;
  function canonIndexTables() {
    if (CIDX) return CIDX;
    const c = canonTables();
    CIDX = TYPES.map((t, i) => {
      const m = new Int32Array(t.size), id = new Int32Array(t.size).fill(-1);
      let n = 0;
      for (let k = 0; k < t.size; k++) { if (c[i][k] === k) id[k] = n++; }
      for (let k = 0; k < t.size; k++) m[k] = id[c[i][k]];
      return m;
    });
    return CIDX;
  }
  // 対称をまとめた重みベクトル（1段階分）の長さと各パターンの先頭
  let CL = null;
  function compactLayout() {
    if (CL) return CL;
    const sizes = canonSizes(), off = [];
    let n = 0;
    for (const s of sizes) { off.push(n); n += s; }
    const bias = n; n += 65;
    const mob = n; n += NMOB * MOBK;
    return (CL = { sizes, off, bias, mob, size: n, sizeV1: mob });
  }
  const b64enc = u8 => { if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64'); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const b64dec = s => { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64')); const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  // 圧縮: int16 の列を「0 の連続は (0, 個数)」「それ以外は zigzag の可変長整数」で
  function packI16(a) {
    const out = [];
    const varint = v => { while (v > 127) { out.push((v & 127) | 128); v >>>= 7; } out.push(v); };
    for (let i = 0; i < a.length;) {
      if (a[i] === 0) { let j = i; while (j < a.length && a[j] === 0) j++; out.push(0); varint(j - i); i = j; }
      else { const v = a[i]; varint(v > 0 ? v * 2 : -v * 2 - 1); i++; }
    }
    return b64enc(Uint8Array.from(out));
  }
  function unpackI16(s, n) {
    const u = b64dec(s), a = new Int16Array(n);
    let p = 0, i = 0;
    const varint = () => { let v = 0, sh = 0, b; do { b = u[p++]; v |= (b & 127) << sh; sh += 7; } while (b & 128); return v >>> 0; };
    while (p < u.length && i < n) {
      if (u[p] === 0) { p++; i += varint(); }
      else { const z = varint(); a[i++] = z & 1 ? -((z + 1) >>> 1) : z >>> 1; }
    }
    return a;
  }
  // 学習の重み（段階ごとの compact な Float64Array）→ 公開用の形式
  // q: 値の刻み（1 = 1/100 石。公開用は刻みを粗くしてファイルを小さくする）
  function encodeWeights(stages, meta, q = 1) {
    const L = compactLayout(), all = new Int16Array(stages.length * L.size);
    stages.forEach((w, s) => { for (let i = 0; i < L.size; i++) all[s * L.size + i] = Math.max(-32767, Math.min(32767, Math.round(w[i] / q))); });
    return Object.assign({}, meta, { v: 2, nStage: stages.length, q, data: packI16(all) });
  }
  // v1（第12世代まで）は盤全体の特徴がない。読むときは、その分を 0 として足す
  function decodeCompact(wt) {
    const L = compactLayout();
    const nStage = wt && wt.nStage ? wt.nStage : 15, q = (wt && wt.q) || 1;
    const per = wt && wt.data && (wt.v || 1) < 2 ? L.sizeV1 : L.size;
    const all = wt && wt.data ? unpackI16(wt.data, nStage * per) : new Int16Array(nStage * per);
    return { L, nStage, stages: Array.from({ length: nStage }, (_, s) => { const w = new Float64Array(L.size); for (let i = 0; i < per; i++) w[i] = all[s * per + i] * q; return w; }) };
  }
  // 探索で使う形（段階ごとに全部の並びを展開した表）
  function makeEval(wt) {
    const stageOf = (wt && wt.stageOf) || defaultStageOf();
    const { L, nStage, stages } = decodeCompact(wt);
    const ci = canonIndexTables();
    const T = new Int16Array(nStage * STAGE_SIZE);
    for (let s = 0; s < nStage; s++) {
      const w = stages[s], base = s * STAGE_SIZE;
      TYPES.forEach((t, ti) => { const m = ci[ti], o = L.off[ti], to = base + TYPE_OFF[ti]; for (let k = 0; k < t.size; k++) T[to + k] = w[o + m[k]]; });
      for (let d = 0; d < 65; d++) T[base + BIAS_OFF + d] = w[L.bias + d];
      for (let k = 0; k < NMOB * MOBK; k++) T[base + MOB_OFF + k] = w[L.mob + k];
    }
    const SB = new Int32Array(65);
    for (let d = 0; d <= 64; d++) SB[d] = Math.min(nStage - 1, stageOf[d]) * STAGE_SIZE;
    let mob = false;
    for (let s2 = 0; s2 < nStage && !mob; s2++) for (let k = 0; k < NMOB * MOBK; k++) if (T[s2 * STAGE_SIZE + MOB_OFF + k]) { mob = true; break; }
    return { T, SB, empty: !(wt && wt.data), mob, mpc: makeMPC(wt && wt.mpc) };
  }
  // ProbCut の表: 深さ d の読みの値 ≒ a × 深さ ds の読みの値 + b（ずれの標準偏差 s）。石の数の組ごと・深さごと。自己対局の局面で測る（train/mpc.js）
  function makeMPC(m) {
    if (!m || !m.ds) return null;
    const G = m.a.length, A = new Float64Array(G * 64), B = new Float64Array(G * 64), Sg = new Float64Array(G * 64);
    for (let g = 0; g < G; g++) for (let d = 0; d < 64; d++) {
      A[g * 64 + d] = (m.a[g] && m.a[g][d]) || 1; B[g * 64 + d] = (m.b[g] && m.b[g][d]) || 0; Sg[g * 64 + d] = (m.s[g] && m.s[g][d]) || 0;
    }
    const GI = new Int32Array(65);
    for (let d = 0; d <= 64; d++) { let g = 0; while (g + 1 < G && d >= m.groups[g + 1]) g++; GI[d] = g; }
    return { ds: Int32Array.from({ length: 64 }, (_, d) => (m.ds[d] == null ? -1 : m.ds[d])), A, B, S: Sg, GI };
  }
  // ProbCut の浅い読みの深さ（同じ偶奇で、だいたい半分）
  const mpcShallow = d => { if (d < 3) return -1; let s = Math.round(d / 2); if ((s & 1) !== (d & 1)) s--; return Math.max(1, s); };

  // 盤全体の特徴（MOB に4つの数を入れる）。となりのマス（8方向）は、横に動く方向で隣の行へ回り込まないように切る
  const MOB = new Int32Array(NMOB);
  const nbL = (l, h) => ((l << 1) & 0xFEFEFEFE) | ((l >>> 1) & 0x7F7F7F7F) | (l << 8) | (l >>> 8) | (h << 24)
    | ((l << 9) & 0xFEFEFEFE) | ((l << 7) & 0x7F7F7F7F) | (((l >>> 7) | (h << 25)) & 0xFEFEFEFE) | (((l >>> 9) | (h << 23)) & 0x7F7F7F7F);
  const nbH = (l, h) => ((h << 1) & 0xFEFEFEFE) | ((h >>> 1) & 0x7F7F7F7F) | (h << 8) | (l >>> 24) | (h >>> 8)
    | (((h << 9) | (l >>> 23)) & 0xFEFEFEFE) | (((h << 7) | (l >>> 25)) & 0x7F7F7F7F) | ((h >>> 7) & 0xFEFEFEFE) | ((h >>> 9) & 0x7F7F7F7F);
  function mobFeatures(pl, ph, ol, oh) {
    genMoves(pl, ph, ol, oh); const mp = popcnt(OUT[0]) + popcnt(OUT[1]);
    genMoves(ol, oh, pl, ph); const mo = popcnt(OUT[0]) + popcnt(OUT[1]);
    const el = ~(pl | ol), eh = ~(ph | oh);
    const pp = popcnt(el & nbL(ol, oh)) + popcnt(eh & nbH(ol, oh)), po = popcnt(el & nbL(pl, ph)) + popcnt(eh & nbH(pl, ph));
    MOB[0] = mp < MOBK ? mp : MOBK - 1; MOB[1] = mo < MOBK ? mo : MOBK - 1;
    MOB[2] = pp < MOBK ? pp : MOBK - 1; MOB[3] = po < MOBK ? po : MOBK - 1;
  }
  function mobScore(base, pl, ph, ol, oh) {
    mobFeatures(pl, ph, ol, oh);
    const o = base + MOB_OFF;
    return ET[o + MOB[0]] + ET[o + MOBK + MOB[1]] + ET[o + 2 * MOBK + MOB[2]] + ET[o + 3 * MOBK + MOB[3]];
  }

  // 評価値（手番の側から見て。石1つ = 100）
  let ET = null, ESB = null, EMOB = false; // 今の探索で使う表（EMOB = 盤全体の特徴の点数があるか）
  function evaluate(pl, ph, ol, oh) {
    const discs = popcnt(pl) + popcnt(ph) + popcnt(ol) + popcnt(oh);
    patternIndex(pl, ph, ol, oh, IDX);
    const base = ESB[discs];
    let v = ET[base + BIAS_OFF + discs];
    for (let i = 0; i < NI; i++) v += ET[base + INST_OFF[i] + IDX[i]];
    if (EMOB) v += mobScore(base, pl, ph, ol, oh);
    return v;
  }
  function evaluateWith(ev, pl, ph, ol, oh) { const t = ET, s = ESB, m = EMOB; ET = ev.T; ESB = ev.SB; EMOB = !!ev.mob; const v = evaluate(pl, ph, ol, oh); ET = t; ESB = s; EMOB = m; return v; }

  // 学習用: 局面の特徴（対称をまとめた番号）を out に。戻り値は石の数
  let CF = null, CBIAS = 0, CMOB = 0; // 並びの番号 → 対称をまとめた番号（全パターンを1つの表に）
  function compactFeatures(pl, ph, ol, oh, out) {
    if (!CF) {
      const L = compactLayout(), ci = canonIndexTables();
      CF = new Int32Array(BIAS_OFF);
      TYPES.forEach((t, ti) => { for (let k = 0; k < t.size; k++) CF[TYPE_OFF[ti] + k] = L.off[ti] + ci[ti][k]; });
      CBIAS = L.bias; CMOB = L.mob;
    }
    patternIndex(pl, ph, ol, oh, IDX);
    for (let i = 0; i < NI; i++) out[i] = CF[INST_OFF[i] + IDX[i]];
    const discs = popcnt(pl) + popcnt(ph) + popcnt(ol) + popcnt(oh);
    out[NI] = CBIAS + discs;
    mobFeatures(pl, ph, ol, oh);
    for (let k = 0; k < NMOB; k++) out[NI + 1 + k] = CMOB + k * MOBK + MOB[k];
    return discs;
  }

  // ------------------------------------------------------------------ 置換表（Web Worker どうしで共有できる）
  // 1件 = 4つの int32: [鍵1, 鍵2^中身^値, 中身(手 7bit | 深さ 7bit | 種類 2bit | 世代 8bit), 値]。書きかけを読んでも鍵の照合で捨てられる
  function makeTT(bits, shared) {
    const n = 4 << bits;
    return new Int32Array(shared ? new SharedArrayBuffer(n * 4) : new ArrayBuffer(n * 4));
  }
  const LOWER = 1, UPPER = 2, EXACT = 3;
  let TT = null, TMASK = 0, TAGE = 0;
  const hash1 = (pl, ph, ol, oh) => {
    let h = Math.imul(pl ^ 0x6b43a9b5, 0x9E3779B1) ^ Math.imul((ph + 0x2545F491) | 0, 0x85EBCA77);
    h ^= Math.imul(ol ^ 0x1b873593, 0xC2B2AE3D) ^ Math.imul((oh + 0x7FEB352D) | 0, 0x27D4EB2F);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h;
  };
  const hash2 = (pl, ph, ol, oh) => {
    let h = Math.imul(ph ^ 0x3C6EF372, 0x165667B1) ^ Math.imul((pl + 0x61C88647) | 0, 0x9E3779B1);
    h ^= Math.imul(oh ^ 0x5851F42D, 0x846CA68B) ^ Math.imul((ol + 0x14057B7E) | 0, 0xCC9E2D51);
    h ^= h >>> 16; h = Math.imul(h, 0x85EBCA6B); h ^= h >>> 13;
    return h;
  };
  // 見つかれば TT の位置（4の倍数）、なければ −1
  let PK1 = 0, PK2 = 0;
  function ttProbe(pl, ph, ol, oh) {
    PK1 = hash1(pl, ph, ol, oh); PK2 = hash2(pl, ph, ol, oh);
    const b = (PK1 & TMASK) << 2;
    for (let k = 0; k < 2; k++) {
      const e = b ^ (k << 2);
      if (TT[e] === PK1 && (TT[e + 1] ^ TT[e + 2] ^ TT[e + 3]) === PK2) return e;
    }
    return -1;
  }
  function ttStore(k1, k2, move, depth, flag, score) {
    const b = (k1 & TMASK) << 2;
    let e = b;
    const e2 = b ^ 4;
    if (TT[e] !== k1) {
      if (TT[e2] === k1) e = e2;
      else {
        // 古い世代のもの・浅いものから置き換える
        const d1 = TT[e + 2], d2 = TT[e2 + 2];
        const s1 = (((d1 >>> 16) & 255) === TAGE ? 256 : 0) + ((d1 >>> 7) & 127), s2 = (((d2 >>> 16) & 255) === TAGE ? 256 : 0) + ((d2 >>> 7) & 127);
        if (s2 < s1) e = e2;
      }
    }
    const data = (move & 127) | ((depth & 127) << 7) | (flag << 14) | (TAGE << 16);
    TT[e] = k1; TT[e + 2] = data; TT[e + 3] = score; TT[e + 1] = k2 ^ data ^ score;
  }

  // ------------------------------------------------------------------ 探索
  let nodes = 0, stop = false, deadline = 0, maxNodes = 0, stopFlag = null, jobId = 0, noise = 0, rng = 1;
  let MPC = null, MPC_T = 0; // 今の探索の ProbCut の表と、どれだけ大胆に切るか（ずれの何倍の外なら切るか。0 で使わない）
  const MV = new Int32Array(MAXPLY * 40), MS = new Int32Array(MAXPLY * 40);
  const CORNER_L = 0x00000081, CORNER_H = 0x81000000 | 0;
  const rand = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  function checkStop() {
    if (stop) return true;
    if ((maxNodes && nodes >= maxNodes) || (deadline && Date.now() >= deadline) || (stopFlag && Atomics.load(stopFlag, 0) !== jobId)) stop = true;
    return stop;
  }

  // 手の一覧を MV[ply*40 …] に。戻り値は手の数
  function listMoves(ml, mh, ply) {
    let n = 0, o = ply * 40;
    for (let x = ml; x; x &= x - 1) MV[o + n++] = 31 - Math.clz32(x & -x);
    for (let x = mh; x; x &= x - 1) MV[o + n++] = 63 - Math.clz32(x & -x);
    return n;
  }
  function sortMoves(o, n) { // MS の大きい順（挿入ソート）
    for (let i = 1; i < n; i++) {
      const m = MV[o + i], s = MS[o + i];
      let j = i - 1;
      while (j >= 0 && MS[o + j] < s) { MV[o + j + 1] = MV[o + j]; MS[o + j + 1] = MS[o + j]; j--; }
      MV[o + j + 1] = m; MS[o + j + 1] = s;
    }
  }

  // 中盤の探索では、パターンの並びの番号を1手ごとの差分で更新する（毎回数え直すより速い）。
  // IX[ply*92 …]: 0..45 = 手番の側を1・相手を2とした番号、46..91 = 手番の側を2・相手を1とした番号（相手から見た番号）
  const IX = new Int32Array((MAXPLY + 2) * 92), TMP = new Int32Array(46);
  function setIdx(pl, ph, ol, oh, ply) {
    const o = ply * 92;
    patternIndex(pl, ph, ol, oh, IDX);
    for (let i = 0; i < NI; i++) IX[o + i] = IDX[i];
    patternIndex(ol, oh, pl, ph, IDX);
    for (let i = 0; i < NI; i++) IX[o + 46 + i] = IDX[i];
  }
  // ply の局面でマス s に置き、(fl, fh) が返ったときの子の番号を ply+1 に
  function childIdx(ply, s, fl, fh) {
    const src = ply * 92, dst = src + 92;
    for (let i = 0; i < 46; i++) { IX[dst + i] = IX[src + 46 + i]; IX[dst + 46 + i] = IX[src + i]; }
    for (let j = FS[s], e = FS[s + 1]; j < e; j++) { const k = FIa[j], w = FPa[j]; IX[dst + k] += w + w; IX[dst + 46 + k] += w; }
    for (let x = fl; x; x &= x - 1) { const q = 31 - Math.clz32(x & -x); for (let j = FS[q], e = FS[q + 1]; j < e; j++) { const k = FIa[j], w = FPa[j]; IX[dst + k] += w; IX[dst + 46 + k] -= w; } }
    for (let x = fh; x; x &= x - 1) { const q = 63 - Math.clz32(x & -x); for (let j = FS[q], e = FS[q + 1]; j < e; j++) { const k = FIa[j], w = FPa[j]; IX[dst + k] += w; IX[dst + 46 + k] -= w; } }
  }
  function passIdx(ply) {
    const src = ply * 92, dst = src + 92;
    for (let i = 0; i < 46; i++) { IX[dst + i] = IX[src + 46 + i]; IX[dst + 46 + i] = IX[src + i]; }
  }
  function evalIdx(ply, discs, pl, ph, ol, oh) {
    const base = ESB[discs], o = ply * 92;
    let v = ET[base + BIAS_OFF + discs];
    for (let i = 0; i < NI; i++) v += ET[base + INST_OFF[i] + IX[o + i]];
    if (EMOB) v += mobScore(base, pl, ph, ol, oh);
    return v;
  }
  function leafEval(ply, discs, pl, ph, ol, oh) {
    let v = evalIdx(ply, discs, pl, ph, ol, oh);
    if (noise) v += Math.round((rand() - 0.5) * noise);
    return v > 6300 ? 6300 : v < -6300 ? -6300 : v;
  }

  // 中盤の探索（PVS）。depth は残りの深さ。パスは深さを使わない
  function mid(pl, ph, ol, oh, alpha, beta, depth, ply, passed) {
    nodes++;
    if ((nodes & 1023) === 0 && checkStop()) return 0;
    if (stop) return 0;
    const empties = 64 - popcnt(pl) - popcnt(ph) - popcnt(ol) - popcnt(oh);
    if (depth >= empties) {
      const a = Math.floor(alpha / SC), b = Math.ceil(beta / SC);
      return solve(pl, ph, ol, oh, a, b, empties, ply, passed) * SC;
    }
    if (depth <= 0) return leafEval(ply, 64 - empties, pl, ph, ol, oh);
    let ttMove = -1;
    const te = ttProbe(pl, ph, ol, oh);
    const k1 = PK1, k2 = PK2;
    if (te >= 0) {
      const d = TT[te + 2], td = (d >>> 7) & 127, fl = (d >>> 14) & 3, sc = TT[te + 3];
      ttMove = d & 127;
      if (td >= depth) {
        if (fl === EXACT) return sc;
        if (fl === LOWER && sc >= beta) return sc;
        if (fl === UPPER && sc <= alpha) return sc;
      }
    }
    genMoves(pl, ph, ol, oh);
    const ml = OUT[0], mh = OUT[1];
    if (!(ml | mh)) {
      if (passed) return R.finalDiff(pl, ph, ol, oh) * SC;
      genMoves(ol, oh, pl, ph);
      if (!(OUT[0] | OUT[1])) return R.finalDiff(pl, ph, ol, oh) * SC;
      passIdx(ply);
      return -mid(ol, oh, pl, ph, -beta, -alpha, depth, ply + 1, true);
    }
    // ProbCut: 浅い読みで、深く読んでも窓の外になるのがほぼ確実なら、深くは読まない（窓の幅が1のところだけ）
    if (MPC_T > 0 && beta - alpha === 1 && depth >= 3) {
      const ds = MPC.ds[depth];
      if (ds > 0) {
        const k = MPC.GI[64 - empties] * 64 + depth, a = MPC.A[k], b = MPC.B[k], sg = MPC.S[k] * MPC_T;
        if (sg > 0 && a > 0.2) {
          const hb = Math.ceil((beta + sg - b) / a);
          if (hb < 6400) { const v = mid(pl, ph, ol, oh, hb - 1, hb, ds, ply, passed); if (stop) return 0; if (v >= hb) return beta; }
          const lb = Math.floor((alpha - sg - b) / a);
          if (lb > -6400) { const v = mid(pl, ph, ol, oh, lb, lb + 1, ds, ply, passed); if (stop) return 0; if (v <= lb) return alpha; }
        }
      }
    }
    const o = ply * 40, n = listMoves(ml, mh, ply);
    // 残り1手: 子は末端なので、子の番号を作ってすぐ評価する（置換表の手を先に）
    if (depth === 1) {
      for (let i = 1; i < n; i++) if (MV[o + i] === ttMove) { MV[o + i] = MV[o]; MV[o] = ttMove; break; }
      const src = ply * 92 + 46, cd = 65 - empties, base = ESB[cd];
      let best = -INF, bestMove = MV[o];
      for (let i = 0; i < n; i++) {
        const s = MV[o + i];
        flips(pl, ph, ol, oh, s);
        const fl = OUT[0], fh = OUT[1];
        nodes++;
        for (let k = 0; k < 46; k++) TMP[k] = IX[src + k];
        for (let j = FS[s], e = FS[s + 1]; j < e; j++) TMP[FIa[j]] += FPa[j] + FPa[j];
        for (let x = fl; x; x &= x - 1) { const q = 31 - Math.clz32(x & -x); for (let j = FS[q], e = FS[q + 1]; j < e; j++) TMP[FIa[j]] += FPa[j]; }
        for (let x = fh; x; x &= x - 1) { const q = 63 - Math.clz32(x & -x); for (let j = FS[q], e = FS[q + 1]; j < e; j++) TMP[FIa[j]] += FPa[j]; }
        let v = ET[base + BIAS_OFF + cd];
        for (let k = 0; k < NI; k++) v += ET[base + INST_OFF[k] + TMP[k]];
        if (EMOB) v += mobScore(base, ol & ~fl, oh & ~fh, pl | fl | SL[s], ph | fh | SH[s]);
        if (noise) v += Math.round((rand() - 0.5) * noise);
        v = -(v > 6300 ? 6300 : v < -6300 ? -6300 : v);
        if (v > best) { best = v; bestMove = s; if (v >= beta) break; }
      }
      if ((nodes & 1023) < n && checkStop()) return 0;
      ttStore(k1, k2, bestMove, 1, best >= beta ? LOWER : best > alpha ? EXACT : UPPER, best);
      return best;
    }
    // 並べ替え: 置換表の手 → 浅い評価（深いところ）または相手の打てる手の少なさ
    for (let i = 0; i < n; i++) {
      const s = MV[o + i];
      if (s === ttMove) { MS[o + i] = 1 << 28; continue; }
      flips(pl, ph, ol, oh, s);
      const fl = OUT[0], fh = OUT[1];
      const cpl = ol & ~fl, cph = oh & ~fh, col = pl | fl | SL[s], coh = ph | fh | SH[s];
      genMoves(cpl, cph, col, coh);
      const mob = popcnt(OUT[0]) + popcnt(OUT[1]) + popcnt(OUT[0] & CORNER_L) + popcnt(OUT[1] & CORNER_H);
      if (depth >= 3) { childIdx(ply, s, fl, fh); MS[o + i] = -evalIdx(ply + 1, 65 - empties, cpl, cph, col, coh) - mob * 60; }
      else MS[o + i] = -mob * 100 + ((SL[s] & CORNER_L) | (SH[s] & CORNER_H) ? 500 : 0);
    }
    sortMoves(o, n);
    let best = -INF, bestMove = MV[o], a = alpha;
    for (let i = 0; i < n; i++) {
      const s = MV[o + i];
      flips(pl, ph, ol, oh, s);
      const fl = OUT[0], fh = OUT[1];
      const cpl = ol & ~fl, cph = oh & ~fh, col = pl | fl | SL[s], coh = ph | fh | SH[s];
      childIdx(ply, s, fl, fh);
      let v;
      if (i === 0) v = -mid(cpl, cph, col, coh, -beta, -a, depth - 1, ply + 1, false);
      else {
        v = -mid(cpl, cph, col, coh, -a - 1, -a, depth - 1, ply + 1, false);
        if (v > a && v < beta && !stop) { childIdx(ply, s, fl, fh); v = -mid(cpl, cph, col, coh, -beta, -a, depth - 1, ply + 1, false); }
      }
      if (stop) return 0;
      if (v > best) { best = v; bestMove = s; if (v > a) { a = v; if (a >= beta) break; } }
    }
    ttStore(k1, k2, bestMove, depth, best >= beta ? LOWER : best > alpha ? EXACT : UPPER, best);
    return best;
  }

  // 終盤の読み切り（単位は石。手番の側から見た最終の石の差）
  const QUAD_L = [0x0F0F0F0F, 0xF0F0F0F0 | 0, 0, 0], QUAD_H = [0, 0, 0x0F0F0F0F, 0xF0F0F0F0 | 0];
  function lastMove(pl, ph, ol, oh) {
    const el = ~(pl | ol), eh = ~(ph | oh);
    const s = el ? 31 - Math.clz32(el & -el) : 63 - Math.clz32(eh & -eh);
    const p = popcnt(pl) + popcnt(ph), q = 63 - p; // 相手の石の数（空きは1つ）
    nodes++;
    flips(pl, ph, ol, oh, s);
    let f = popcnt(OUT[0]) + popcnt(OUT[1]);
    if (f) return (p + 1 + f) - (q - f);
    flips(ol, oh, pl, ph, s);
    f = popcnt(OUT[0]) + popcnt(OUT[1]);
    if (f) return (p - f) - (q + 1 + f);
    const d = p - q;
    return d > 0 ? d + 1 : d < 0 ? d - 1 : 0;
  }
  // 空きが少ないところ（6以下）: 手の一覧を作らず、空きマスに順に置いてみる。空きが奇数個の区画（4分割）から
  const SQ = new Int32Array(MAXPLY * 8);
  function solveSmall(pl, ph, ol, oh, alpha, beta, empties, ply, passed) {
    if (empties === 1) return lastMove(pl, ph, ol, oh);
    nodes++;
    const el = ~(pl | ol), eh = ~(ph | oh), o = ply * 8;
    const odd = (popcnt(el & 0x0F0F0F0F) & 1) | ((popcnt(el & 0xF0F0F0F0) & 1) << 1) | ((popcnt(eh & 0x0F0F0F0F) & 1) << 2) | ((popcnt(eh & 0xF0F0F0F0) & 1) << 3);
    let n = 0;
    for (let want = 1; want >= 0; want--) {
      for (let x = el; x; x &= x - 1) { const s = 31 - Math.clz32(x & -x); if (((odd >> ((s & 7) >> 2)) & 1) === want) SQ[o + n++] = s; }
      for (let x = eh; x; x &= x - 1) { const s = 63 - Math.clz32(x & -x); if (((odd >> (2 + ((s & 7) >> 2))) & 1) === want) SQ[o + n++] = s; }
    }
    let best = -INF, a = alpha;
    for (let i = 0; i < n; i++) {
      const s = SQ[o + i];
      flips(pl, ph, ol, oh, s);
      const fl = OUT[0], fh = OUT[1];
      if (!(fl | fh)) continue;
      const v = -solveSmall(ol & ~fl, oh & ~fh, pl | fl | SL[s], ph | fh | SH[s], -beta, -a, empties - 1, ply + 1, false);
      if (v > best) { best = v; if (v > a) { a = v; if (a >= beta) return best; } }
    }
    if (best === -INF) {
      if (passed) return R.finalDiff(pl, ph, ol, oh);
      return -solveSmall(ol, oh, pl, ph, -beta, -alpha, empties, ply + 1, true);
    }
    return best;
  }
  // 確定石（もう裏返らない石）: 辺の上で裏返らない石（8マスの辺のすべての並びについて最初に調べた表）と、
  // 縦・横・斜めの4本の線がすべて埋まっている石。相手の確定石が多ければ、こちらの石差の上限が決まる
  const EDGE_ST = new Uint8Array(65536);
  {
    const memo = new Int16Array(65536).fill(-1);
    const flip1 = (p, o, x) => { // 1列の上で x に p 側が置いたときに返る o の石
      let f = 0;
      for (const d of [1, -1]) {
        let t = 0, y = x + d;
        while (y >= 0 && y < 8 && (o >> y) & 1) { t |= 1 << y; y += d; }
        if (y >= 0 && y < 8 && (p >> y) & 1) f |= t;
      }
      return f;
    };
    const st = (p, o) => {
      const k = p * 256 + o;
      if (memo[k] >= 0) return memo[k];
      let r = p;
      const e = ~(p | o) & 255;
      for (let x = 0; x < 8 && r; x++) {
        if (!((e >> x) & 1)) continue;
        let f = flip1(p, o, x);
        r &= st(p | f | (1 << x), o & ~f); // 自分が置く（石は増えるだけ）
        f = flip1(o, p, x);
        r &= st(p & ~f, o | f | (1 << x)) & ~f; // 相手が置く（返された石は確定でない）
      }
      memo[k] = r;
      return r;
    };
    for (let p = 0; p < 256; p++) for (let o = 0; o < 256; o++) if (!(p & o)) EDGE_ST[p * 256 + o] = st(p, o);
  }
  const colA = (l, h) => (l & 1) | ((l >>> 7) & 2) | ((l >>> 14) & 4) | ((l >>> 21) & 8) | ((h << 4) & 16) | ((h >>> 3) & 32) | ((h >>> 10) & 64) | ((h >>> 17) & 128);
  const colH = (l, h) => ((l >>> 7) & 1) | ((l >>> 14) & 2) | ((l >>> 21) & 4) | ((l >>> 28) & 8) | (((h >>> 7) & 1) << 4) | (((h >>> 15) & 1) << 5) | (((h >>> 23) & 1) << 6) | (((h >>> 31) & 1) << 7);
  const COLBIT_L = [0x00000001, 0x00000100, 0x00010000, 0x01000000], DIAG_L = [], DIAG_H = [];
  for (let k = 0; k < 30; k++) { // 斜めの線（↘ 15本・↙ 15本）
    let l = 0, h = 0;
    for (let s = 0; s < 64; s++) {
      const x = s & 7, y = s >> 3;
      if ((k < 15 && x - y === k - 7) || (k >= 15 && x + y === k - 15)) { if (s < 32) l |= 1 << s; else h |= 1 << (s - 32); }
    }
    DIAG_L.push(l); DIAG_H.push(h);
  }
  function stableCount(xl, xh, yl, yh) {
    const fl = xl | yl, fh = xh | yh;
    let sl = 0, sh = 0;
    // 辺
    let t = EDGE_ST[((xl & 255) << 8) | (yl & 255)]; sl |= t;
    t = EDGE_ST[(((xh >>> 24) & 255) << 8) | ((yh >>> 24) & 255)]; sh |= t << 24;
    t = EDGE_ST[(colA(xl, xh) << 8) | colA(yl, yh)];
    for (let r = 0; r < 4; r++) { if ((t >> r) & 1) sl |= COLBIT_L[r]; if ((t >> (r + 4)) & 1) sh |= COLBIT_L[r]; }
    t = EDGE_ST[(colH(xl, xh) << 8) | colH(yl, yh)];
    for (let r = 0; r < 4; r++) { if ((t >> r) & 1) sl |= COLBIT_L[r] << 7; if ((t >> (r + 4)) & 1) sh |= COLBIT_L[r] << 7; }
    // 4本の線が埋まっている石
    let hl = 0, hh = 0;
    for (let r = 0; r < 4; r++) { if (((fl >>> (r * 8)) & 255) === 255) hl |= 255 << (r * 8); if (((fh >>> (r * 8)) & 255) === 255) hh |= 255 << (r * 8); }
    let v = fl & fh; v &= v >>> 16; v &= v >>> 8; v &= 255; // どの行でも埋まっている列
    const vl = v * 0x01010101, vh = vl;
    let dl9 = 0, dh9 = 0, dl7 = 0, dh7 = 0;
    for (let k = 0; k < 15; k++) if ((fl & DIAG_L[k]) === DIAG_L[k] && (fh & DIAG_H[k]) === DIAG_H[k]) { dl9 |= DIAG_L[k]; dh9 |= DIAG_H[k]; }
    for (let k = 15; k < 30; k++) if ((fl & DIAG_L[k]) === DIAG_L[k] && (fh & DIAG_H[k]) === DIAG_H[k]) { dl7 |= DIAG_L[k]; dh7 |= DIAG_H[k]; }
    sl |= xl & hl & vl & dl9 & dl7; sh |= xh & hh & vh & dh9 & dh7;
    return popcnt(sl & xl) + popcnt(sh & xh);
  }
  // 読み切りの並べ替え: 空きが ORDER_EVAL 以上なら評価関数も使い（相手の手1つ = ORDER_MOB、評価値は 2^ORDER_EVS で割る）、
  // ORDER_SEARCH 以上なら評価関数の代わりに浅い読み（深さ ORDER_DEPTH）の値を使う
  let ORDER_EVAL = 12, ORDER_MOB = 40, ORDER_EVS = 3, ORDER_SEARCH = 99, ORDER_DEPTH = 2;
  function solve(pl, ph, ol, oh, alpha, beta, empties, ply, passed) {
    if (empties <= 6) return solveSmall(pl, ph, ol, oh, alpha, beta, empties, ply, passed);
    nodes++;
    if ((nodes & 4095) === 0 && checkStop()) return 0;
    if (stop) return 0;
    if (empties === 0) return popcnt(pl) + popcnt(ph) - popcnt(ol) - popcnt(oh);
    // 確定石: 相手の確定石を除いた全部を取っても alpha に届かなければ、読むまでもない
    if (alpha >= 64 - 2 * (popcnt(ol) + popcnt(oh)) && empties >= 8) {
      const mx = 64 - 2 * stableCount(ol, oh, pl, ph);
      if (mx <= alpha) return mx;
    }
    let ttMove = -1, te = -1, k1 = 0, k2 = 0;
    const useTT = empties >= 7;
    if (useTT) {
      te = ttProbe(pl, ph, ol, oh); k1 = PK1; k2 = PK2;
      if (te >= 0) {
        const d = TT[te + 2], td = (d >>> 7) & 127, fl = (d >>> 14) & 3, sc = TT[te + 3];
        ttMove = d & 127;
        if (td >= empties) {
          const v = sc / SC;
          if (fl === EXACT) return v;
          if (fl === LOWER && v >= beta) return v;
          if (fl === UPPER && v <= alpha) return v;
        }
      }
    }
    genMoves(pl, ph, ol, oh);
    const ml = OUT[0], mh = OUT[1];
    if (!(ml | mh)) {
      if (passed) return R.finalDiff(pl, ph, ol, oh);
      genMoves(ol, oh, pl, ph);
      if (!(OUT[0] | OUT[1])) return R.finalDiff(pl, ph, ol, oh);
      return -solve(ol, oh, pl, ph, -beta, -alpha, empties, ply + 1, true);
    }
    const o = ply * 40, n = listMoves(ml, mh, ply);
    if (n > 1) {
      if (empties >= 8) {
        // 速さ優先: 相手の打てる手が少なくなる手から（隅は2つ分に数える）。空きが多いところでは評価関数の値も足す
        const useEval = empties >= ORDER_EVAL;
        for (let i = 0; i < n; i++) {
          const s = MV[o + i];
          if (s === ttMove) { MS[o + i] = 1 << 28; continue; }
          flips(pl, ph, ol, oh, s);
          const fl = OUT[0], fh = OUT[1];
          const cpl = ol & ~fl, cph = oh & ~fh, col = pl | fl | SL[s], coh = ph | fh | SH[s];
          genMoves(cpl, cph, col, coh);
          const mob = popcnt(OUT[0]) + popcnt(OUT[1]) + popcnt(OUT[0] & CORNER_L) + popcnt(OUT[1] & CORNER_H);
          MS[o + i] = useEval
            ? -mob * ORDER_MOB - ((empties >= ORDER_SEARCH ? (setIdx(cpl, cph, col, coh, ply + 1), mid(cpl, cph, col, coh, -INF, INF, ORDER_DEPTH, ply + 1, false)) : evaluate(cpl, cph, col, coh)) >> ORDER_EVS)
            : -mob * 16 + ((SL[s] & CORNER_L) | (SH[s] & CORNER_H) ? 8 : 0);
        }
      } else {
        // 空きの少ないところ: 空きが奇数個の区画（4分割）の手から
        const el = ~(pl | ol), eh = ~(ph | oh);
        for (let i = 0; i < n; i++) {
          const s = MV[o + i], q = ((s >> 5) << 1) | ((s & 7) >> 2);
          MS[o + i] = ((popcnt(el & QUAD_L[q]) + popcnt(eh & QUAD_H[q])) & 1) * 4 + ((SL[s] & CORNER_L) | (SH[s] & CORNER_H) ? 2 : 0);
        }
      }
      sortMoves(o, n);
    }
    let best = -INF, bestMove = MV[o], a = alpha;
    for (let i = 0; i < n; i++) {
      const s = MV[o + i];
      flips(pl, ph, ol, oh, s);
      const fl = OUT[0], fh = OUT[1];
      const cpl = ol & ~fl, cph = oh & ~fh, col = pl | fl | SL[s], coh = ph | fh | SH[s];
      let v;
      if (i === 0) v = -solve(cpl, cph, col, coh, -beta, -a, empties - 1, ply + 1, false);
      else {
        v = -solve(cpl, cph, col, coh, -a - 1, -a, empties - 1, ply + 1, false);
        if (v > a && v < beta && !stop) v = -solve(cpl, cph, col, coh, -beta, -a, empties - 1, ply + 1, false);
      }
      if (stop) return 0;
      if (v > best) { best = v; bestMove = s; if (v > a) { a = v; if (a >= beta) break; } }
    }
    if (useTT) ttStore(k1, k2, bestMove, empties, best >= beta ? LOWER : best > alpha ? EXACT : UPPER, best * SC);
    return best;
  }

  // 読み筋（置換表の手をたどる）
  function extractPV(pl, ph, ol, oh, first, maxLen) {
    const pv = [first];
    let a = [pl, ph, ol, oh];
    const play = (s, b) => { if (s === PASS) return [b[2], b[3], b[0], b[1]]; flips(b[0], b[1], b[2], b[3], s); const fl = OUT[0], fh = OUT[1]; return [b[2] & ~fl, b[3] & ~fh, b[0] | fl | SL[s], b[1] | fh | SH[s]]; };
    a = play(first, a);
    const seen = new Set();
    while (pv.length < maxLen) {
      genMoves(a[0], a[1], a[2], a[3]);
      if (!(OUT[0] | OUT[1])) {
        genMoves(a[2], a[3], a[0], a[1]);
        if (!(OUT[0] | OUT[1])) break;
        pv.push(PASS); a = play(PASS, a); continue;
      }
      const ml = OUT[0], mh = OUT[1];
      const e = ttProbe(a[0], a[1], a[2], a[3]);
      if (e < 0) break;
      const s = TT[e + 2] & 127;
      if (s >= 64 || !((ml & SL[s]) | (mh & SH[s]))) break;
      const key = a.join(',');
      if (seen.has(key)) break;
      seen.add(key);
      pv.push(s); a = play(s, a);
    }
    return pv;
  }

  // ------------------------------------------------------------------ 思考
  // think(局面, { timeMs, maxDepth, maxNodes, solveAt, analyze, multi, noise, onInfo })
  //   局面は Position か [pl, ph, ol, oh]（手番の側から見て）
  //   戻り値 { move, score（手番の側から見て。石=100）, depth, exact, pv, nodes, time, scores: [{move, score}]（multi のとき全部の手） }
  class Searcher {
    constructor(weights, opts = {}) {
      this.ev = weights && weights.T ? weights : makeEval(weights);
      this.tt = opts.sharedTT || makeTT(opts.ttBits || 20, false);
      this.stopFlag = opts.stopFlag ? new Int32Array(opts.stopFlag) : null;
      this.helper = opts.helper || 0;
      this.age = 0;
      this.noise = 0;
      this.mpc = opts.mpc != null ? opts.mpc : 0; // ProbCut の大胆さ（表があるときだけ効く。0 = 使わない）
    }
    clearTT() { this.tt.fill(0); }
    think(pos, opts = {}) {
      const b = Array.isArray(pos) ? pos : pos.pov();
      const [pl, ph, ol, oh] = b;
      ET = this.ev.T; ESB = this.ev.SB; EMOB = !!this.ev.mob; TT = this.tt; TMASK = (this.tt.length >> 2) - 1;
      MPC = this.ev.mpc; MPC_T = MPC ? (opts.mpc != null ? opts.mpc : this.mpc) : 0;
      this.age = (this.age + 1) & 255; TAGE = this.age;
      nodes = 0; stop = false; noise = (opts.noise != null ? opts.noise : this.noise) | 0;
      rng = ((opts.seed != null ? opts.seed : (Math.random() * 4294967296)) | 0) || 1;
      stopFlag = this.stopFlag; jobId = opts.jobId | 0;
      const t0 = Date.now(), timeMs = opts.timeMs || 0;
      deadline = timeMs ? t0 + (opts.analyze ? timeMs : Math.round(timeMs * 1.6)) : 0; // 対局では読み終わりを待つ余裕を少し持たせる
      maxNodes = opts.maxNodes || 0;
      const maxDepth = Math.min(60, opts.maxDepth || 60);
      const empties = 64 - popcnt(pl) - popcnt(ph) - popcnt(ol) - popcnt(oh);
      const solveAt = opts.solveAt != null ? opts.solveAt : 18;
      const multi = !!opts.multi;
      genMoves(pl, ph, ol, oh);
      const roots = R.squaresOf(OUT[0], OUT[1]);
      const res = { move: roots.length ? roots[0] : PASS, score: 0, depth: 0, exact: false, pv: [], nodes: 0, time: 0, scores: null };
      if (!roots.length) {
        genMoves(ol, oh, pl, ph);
        res.move = (OUT[0] | OUT[1]) ? PASS : -1;
        res.score = R.finalDiff(pl, ph, ol, oh) * SC; res.exact = !(OUT[0] | OUT[1]);
        return res;
      }
      const child = s => { flips(pl, ph, ol, oh, s); const fl = OUT[0], fh = OUT[1]; return [ol & ~fl, oh & ~fh, pl | fl | SL[s], ph | fh | SH[s], fl, fh]; };
      const kids = roots.map(child);
      setIdx(pl, ph, ol, oh, 0);
      // 根の並び: 前の深さでの値の順
      let order = roots.map((s, i) => ({ s, c: kids[i], v: 0 }));
      const report = () => {
        res.nodes = nodes; res.time = Date.now() - t0;
        if (opts.onInfo) opts.onInfo(Object.assign({}, res, { pv: res.pv.slice(), scores: res.scores ? res.scores.slice() : null }));
      };
      const finishScores = () => (multi ? order.map(x => ({ move: x.s, score: x.v })) : null);
      // 1つの深さで根を読む。exact = 読み切り、wld = 勝ち負けだけの読み切り。戻り値 false = 途中で止まった
      const rootIter = (d, exact, wld) => {
        let best = -INF, bestS = order[0].s;
        const vals = [];
        for (let i = 0; i < order.length; i++) {
          const x = order[i], [a0, a1, a2, a3, f0, f1] = x.c;
          if (!exact) childIdx(0, x.s, f0, f1);
          let v;
          if (wld) {
            // 勝ち（+）・引き分け（0）・負け（−）だけを知る狭い窓。勝つ手が見つかればそこで終わり
            v = -solve(a0, a1, a2, a3, -1, 1, empties - 1, 1, false) * SC;
            if (stop) return false;
            x.v = v;
            if (v > best) { best = v; bestS = x.s; }
            if (best > 0) break;
            continue;
          }
          if (exact) {
            const e = empties - 1;
            const lo = multi ? -64 : Math.max(-64, Math.floor(best / SC)), hi = 64;
            if (i === 0 && !multi && res.depth > 0) {
              // 最初の手は、中盤の読みの値のまわりの狭い窓で読み、外れたら広げる
              const est = Math.max(-64, Math.min(64, Math.round(-res.score / SC)));
              let w = 3, l = Math.max(-64, est - w), u = Math.min(64, est + w);
              for (;;) {
                const t = solve(a0, a1, a2, a3, l, u, e, 1, false);
                if (stop) break;
                if (t <= l && l > -64) { l = Math.max(-64, l - (w *= 3)); continue; }
                if (t >= u && u < 64) { u = Math.min(64, u + (w *= 3)); continue; }
                v = -t * SC;
                break;
              }
            } else if (i === 0 || multi) v = -solve(a0, a1, a2, a3, -hi, -lo, e, 1, false) * SC;
            else {
              v = -solve(a0, a1, a2, a3, -lo - 1, -lo, e, 1, false) * SC;
              if (v > best && !stop) v = -solve(a0, a1, a2, a3, -hi, -lo, e, 1, false) * SC;
            }
          } else if (i === 0 || multi) v = -mid(a0, a1, a2, a3, -INF, INF, d - 1, 1, false);
          else {
            v = -mid(a0, a1, a2, a3, -best - 1, -best, d - 1, 1, false);
            if (v > best && !stop) { childIdx(0, x.s, f0, f1); v = -mid(a0, a1, a2, a3, -INF, -best, d - 1, 1, false); }
          }
          if (stop) {
            // 途中で止まっても、最初の手を読み終えて、それより良い手が見つかっていれば使う
            if (i > 0 && !multi && best > -INF) { res.move = bestS; res.score = best; }
            return false;
          }
          x.v = v; vals.push(v);
          if (v > best) { best = v; bestS = x.s; }
        }
        if (wld) {
          // 石差は分からないので、中盤の読みの値を勝ち負けに合う向きに直して使う
          const sg = best > 0 ? 1 : best < 0 ? -1 : 0;
          res.move = bestS; res.wld = sg; res.exact = false;
          res.score = sg === 0 ? 0 : sg * Math.max(SC, sg * res.score);
          res.pv = extractPV(pl, ph, ol, oh, bestS, 24);
          return true;
        }
        // 値の大きい順に並べ直す（次の深さの並び）
        order.sort((p, q) => q.v - p.v);
        res.move = bestS; res.score = best; res.depth = d; res.exact = exact;
        res.pv = extractPV(pl, ph, ol, oh, bestS, 24);
        res.scores = finishScores();
        return true;
      };
      // 弱い CPU（揺らぎあり）は読み切りをしない。wldAt: 空きがこれ以下なら、石差までは無理でも勝ち負けだけ読み切る
      const wldAt = opts.wldAt != null ? opts.wldAt : solveAt;
      const canSolve = !noise && empties <= solveAt, canWLD = !noise && !multi && !canSolve && empties <= wldAt;
      if (canSolve && empties <= 12) {
        rootIter(empties, true);
      } else {
        const start = 1 + (this.helper & 1);
        for (let d = start; d <= maxDepth && d < empties; d++) {
          if (!rootIter(d, false)) break;
          report();
          if (timeMs && !opts.analyze && !this.helper && Date.now() - t0 > timeMs * 0.45) break;
          if (opts.maxNodes && nodes > opts.maxNodes * 0.5 && !opts.analyze) break;
          // 読み切りに移る（中盤の読みも少しはしておく: 読み切りが時間内に終わらなかったときに使う）
          if ((canSolve || canWLD) && (d >= Math.min(empties - 1, 10) || (timeMs && Date.now() - t0 > timeMs * 0.3))) break;
        }
        if ((canSolve || canWLD) && !stop) {
          // 残りの時間で読み切りを試す（終わらなければ中盤の読みの手を使う）
          const keep = { move: res.move, score: res.score, depth: res.depth, pv: res.pv, scores: res.scores };
          if (!rootIter(empties, canSolve, canWLD)) Object.assign(res, keep, { exact: false, wld: undefined });
        }
      }
      report();
      return res;
    }
  }

  // 学習・対局用: 重みだけ持って指す
  const winRate = score => 1 / (1 + Math.exp(-score / (SC * 5.5)));

  Object.assign(R, {
    SC, INF, TYPES, INST, NI, NF, MOBK, NMOB, STAGE_SIZE, PATTERN_DEFS,
    makeEval, evaluateWith, compactLayout, compactFeatures, canonIndexTables, encodeWeights, decodeCompact, defaultStageOf, packI16, unpackI16,
    makeTT, Searcher, winRate, mpcShallow, makeMPC, stableCount,
    setOrder(o) { if (o.evalAt != null) ORDER_EVAL = o.evalAt; if (o.mob != null) ORDER_MOB = o.mob; if (o.evs != null) ORDER_EVS = o.evs; if (o.searchAt != null) ORDER_SEARCH = o.searchAt; if (o.depth != null) ORDER_DEPTH = o.depth; },
  });
  return R;
}
if (typeof module !== 'undefined' && module.exports) module.exports = ReversiAI;
