/* ヨット: ルールと、1手番の中の最善（サイコロの残し方）を求める計算
 * ブラウザ（window.YachtCore）と Node（require）の両方で使う
 *
 * 役（12）: 0〜5 = 1〜6の目、6 チョイス、7 フォーカード、8 フルハウス、9 リトル・ストレート、10 ビッグ・ストレート、11 ヨット
 * 上段（1〜6の目）の合計が 63 以上で +35（ボーナス）
 *
 * サイコロ5個の目の組（並べ方は区別しない）は 252 通り。残す組（0〜5個）は 462 通り
 * 1手番の計算: 振り終えたあとの値 leaf[組] から、2回目・3回目の振り直しで何を残すかを後ろから決める
 */
(function (root) {
  'use strict';
  const NCAT = 12;
  const CHOICE = 6, FOUR = 7, FULL = 8, LSTR = 9, BSTR = 10, YACHT = 11;
  const BONUS_AT = 63, BONUS = 35;
  const ALL = (1 << NCAT) - 1;
  const NU = 64; // 上段の合計（63 で打ち止め）
  const CATS = [
    { name: '1の目', short: '1', desc: '1の目の数の合計' },
    { name: '2の目', short: '2', desc: '2の目の数の合計' },
    { name: '3の目', short: '3', desc: '3の目の数の合計' },
    { name: '4の目', short: '4', desc: '4の目の数の合計' },
    { name: '5の目', short: '5', desc: '5の目の数の合計' },
    { name: '6の目', short: '6', desc: '6の目の数の合計' },
    { name: 'チョイス', short: 'C', desc: '5個の目の合計（何でもよい）' },
    { name: 'フォーカード', short: '4K', desc: '同じ目が4個以上 → その4個の合計' },
    { name: 'フルハウス', short: 'FH', desc: '同じ目3個＋別の同じ目2個 → 5個の合計' },
    { name: 'リトル・ストレート', short: 'LS', desc: '1・2・3・4・5 → 30点' },
    { name: 'ビッグ・ストレート', short: 'BS', desc: '2・3・4・5・6 → 30点' },
    { name: 'ヨット', short: 'Y', desc: '5個とも同じ目 → 50点' },
  ];

  // ------------------------------------------------------------ 目の組
  const KEY = c => c[0] + 6 * c[1] + 36 * c[2] + 216 * c[3] + 1296 * c[4] + 7776 * c[5];
  const keepOfKey = new Int16Array(46656).fill(-1);
  const KC = []; // 残す組 → 目ごとの個数
  const KN = []; // 残す組 → 個数
  const byN = [[], [], [], [], [], []];
  (function enumerate() {
    const c = [0, 0, 0, 0, 0, 0];
    const rec = (i, left, n) => {
      if (i === 5) { c[5] = left; const k = KC.length; KC.push(c.slice()); KN.push(n); keepOfKey[KEY(c)] = k; byN[n].push(k); return; }
      for (let x = 0; x <= left; x++) { c[i] = x; rec(i + 1, left - x, n); }
    };
    for (let n = 0; n <= 5; n++) rec(0, n, n);
  })();
  const NK = KC.length; // 462
  const DK = byN[5]; // 5個の組（252）の、残す組としての番号
  const ND = DK.length;
  const dOfKeep = new Int16Array(NK).fill(-1);
  DK.forEach((k, d) => { dOfKeep[k] = d; });
  const DC = DK.map(k => KC[k]);
  const DSUM = DC.map(c => c.reduce((s, x, i) => s + x * (i + 1), 0));
  const fact = [1, 1, 2, 6, 24, 120];

  // 残す組 k から振り直したときの行き先と確率
  const trStart = new Int32Array(NK + 1);
  const trTo = [], trP = [];
  for (let k = 0; k < NK; k++) {
    trStart[k] = trTo.length;
    const m = 5 - KN[k];
    for (const r of byN[m]) {
      const rc = KC[r];
      let p = fact[m];
      for (let i = 0; i < 6; i++) p /= fact[rc[i]];
      p /= Math.pow(6, m);
      const sum = KC[k].map((x, i) => x + rc[i]);
      trTo.push(dOfKeep[keepOfKey[KEY(sum)]]); trP.push(p);
    }
  }
  trStart[NK] = trTo.length;
  const TR_TO = Int16Array.from(trTo), TR_P = Float64Array.from(trP);
  const EMPTY = keepOfKey[0];
  // 5個の組 d から残せる組（重なりなし）
  const subStart = new Int32Array(ND + 1);
  const subs = [];
  for (let d = 0; d < ND; d++) {
    subStart[d] = subs.length;
    const c = DC[d], s = [0, 0, 0, 0, 0, 0];
    const rec = i => {
      if (i === 6) { const k = keepOfKey[KEY(s)]; if (KN[k] < 5) subs.push(k); return; }
      for (let x = 0; x <= c[i]; x++) { s[i] = x; rec(i + 1); }
    };
    rec(0);
  }
  subStart[ND] = subs.length;
  const SUB = Int16Array.from(subs);

  // ------------------------------------------------------------ 点数
  function scoreCounts(cat, c, sum) {
    if (cat < 6) return c[cat] * (cat + 1);
    switch (cat) {
      case CHOICE: return sum;
      case FOUR: for (let i = 0; i < 6; i++) if (c[i] >= 4) return 4 * (i + 1); return 0;
      case FULL: { let t = false, w = false; for (let i = 0; i < 6; i++) { if (c[i] === 3) t = true; else if (c[i] === 2) w = true; } return t && w ? sum : 0; }
      case LSTR: return c[0] && c[1] && c[2] && c[3] && c[4] ? 30 : 0;
      case BSTR: return c[1] && c[2] && c[3] && c[4] && c[5] ? 30 : 0;
      case YACHT: for (let i = 0; i < 6; i++) if (c[i] === 5) return 50; return 0;
    }
    return 0;
  }
  const SC = new Uint8Array(ND * NCAT);
  for (let d = 0; d < ND; d++) for (let c = 0; c < NCAT; c++) SC[d * NCAT + c] = scoreCounts(c, DC[d], DSUM[d]);
  const countsOf = dice => { const c = [0, 0, 0, 0, 0, 0]; for (const v of dice) c[v - 1]++; return c; };
  const dIndex = dice => dOfKeep[keepOfKey[KEY(countsOf(dice))]];
  const score = (cat, dice) => SC[dIndex(dice) * NCAT + cat];

  // ------------------------------------------------------------ 1手番の計算
  // leaf[d]: 振り終えて役を選ぶときの値。返すもの: V2/V1（振ったあと、残り1回/2回のときの値）・K2/K1（残す組の値）・start
  function newSolve() { return { leaf: new Float64Array(ND), V2: new Float64Array(ND), V1: new Float64Array(ND), K2: new Float64Array(NK), K1: new Float64Array(NK), start: 0 }; }
  function keepValues(V, K) {
    for (let k = 0; k < NK; k++) {
      let s = 0;
      for (let j = trStart[k], e = trStart[k + 1]; j < e; j++) s += TR_P[j] * V[TR_TO[j]];
      K[k] = s;
    }
  }
  function rollValues(leaf, K, V) {
    for (let d = 0; d < ND; d++) {
      let b = leaf[d];
      for (let j = subStart[d], e = subStart[d + 1]; j < e; j++) { const v = K[SUB[j]]; if (v > b) b = v; }
      V[d] = b;
    }
  }
  function solveTurn(S) {
    keepValues(S.leaf, S.K2);
    rollValues(S.leaf, S.K2, S.V2);
    keepValues(S.V2, S.K1);
    rollValues(S.leaf, S.K1, S.V1);
    let s = 0;
    for (let j = trStart[EMPTY], e = trStart[EMPTY + 1]; j < e; j++) s += TR_P[j] * S.V1[TR_TO[j]];
    S.start = s;
    return S;
  }
  // 振ったあと（rollsLeft = 振り直せる回数 1 or 2）に、どれを残すか・止めるかの値の一覧（よい順）
  function keepOptions(S, d, rollsLeft) {
    const K = rollsLeft >= 2 ? S.K1 : S.K2;
    const out = [{ keep: -1, v: S.leaf[d] }];
    for (let j = subStart[d], e = subStart[d + 1]; j < e; j++) out.push({ keep: SUB[j], v: K[SUB[j]] });
    out.sort((a, b) => b.v - a.v);
    return out;
  }
  // 実際のサイコロ（位置つき）で、残す組 k に合う位置の印（前から残していたものを優先）
  function holdMaskFor(dice, k, prevHold) {
    const need = KC[k].slice();
    let mask = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 5; i++) {
        if (mask & (1 << i)) continue;
        const held = prevHold ? (prevHold >> i) & 1 : 0;
        if (pass === 0 && !held) continue;
        const f = dice[i] - 1;
        if (need[f] > 0) { need[f]--; mask |= 1 << i; }
      }
    }
    return mask;
  }
  const keepOfMask = (dice, mask) => { const c = [0, 0, 0, 0, 0, 0]; for (let i = 0; i < 5; i++) if (mask & (1 << i)) c[dice[i] - 1]++; return keepOfKey[KEY(c)]; };
  const keepFaces = k => { const out = []; KC[k].forEach((n, i) => { for (let j = 0; j < n; j++) out.push(i + 1); }); return out; };

  // ------------------------------------------------------------ 1人のときの最善（期待値の表）
  // V[mask*64+u]: 埋めた役 mask・上段の合計 u（63 で打ち止め）から、残りで取れる点の期待値（ボーナスを含む）
  let VT = null;
  const upAdd = (u, add) => (u + add >= BONUS_AT ? BONUS_AT : u + add);
  // 上段の埋め方ごとに、ありうる上段の合計
  const REACH = (() => {
    const out = [];
    for (let m = 0; m < 64; m++) {
      let set = new Uint8Array(NU); set[0] = 1;
      for (let f = 0; f < 6; f++) {
        if (!(m & (1 << f))) continue;
        const nx = new Uint8Array(NU);
        for (let u = 0; u < NU; u++) if (set[u]) for (let n = 0; n <= 5; n++) nx[upAdd(u, n * (f + 1))] = 1;
        set = nx;
      }
      const list = [];
      for (let u = 0; u < NU; u++) if (set[u]) list.push(u);
      out.push(list);
    }
    return out;
  })();
  function tableSize() { let n = 0; for (let F = 0; F < 4096; F++) n += REACH[F & 63].length; return n; }
  // SDT: 同じ打ち方での残りの点の標準偏差（勝つ確率の見積もりに使う）
  let SDT = null;
  function setTable(v, sd) { VT = v; if (sd) SDT = sd; }
  function b64bytes(b64) {
    if (typeof atob === 'function') { const s = atob(b64), bin = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i); return bin; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function loadTable(b64, sd64) {
    const bin = b64bytes(b64);
    const q = new Uint16Array(bin.buffer, bin.byteOffset, bin.length >> 1);
    const v = new Float32Array(4096 * NU);
    let i = 0;
    for (let F = 0; F < 4096; F++) for (const u of REACH[F & 63]) v[F * NU + u] = q[i++] / 100;
    VT = v;
    if (sd64) {
      const qs = b64bytes(sd64), s = new Float32Array(4096 * NU);
      i = 0;
      for (let F = 0; F < 4096; F++) for (const u of REACH[F & 63]) s[F * NU + u] = qs[i++] / 5;
      SDT = s;
    }
    return v;
  }
  const tableValue = (mask, u) => (mask === ALL ? (u >= BONUS_AT ? BONUS : 0) : VT[mask * NU + u]);
  const tableSD = (mask, u) => (mask === ALL || !SDT ? 0 : SDT[mask * NU + u]);
  // 1人の最善の leaf: 役を選んだ点＋その先の期待値
  function soloLeaf(mask, u, leaf, bestCat) {
    for (let d = 0; d < ND; d++) {
      let b = -1, bc = -1;
      for (let c = 0; c < NCAT; c++) {
        if (mask & (1 << c)) continue;
        const s = SC[d * NCAT + c];
        const v = s + tableValue(mask | (1 << c), c < 6 ? upAdd(u, s) : u);
        if (v > b) { b = v; bc = c; }
      }
      leaf[d] = b;
      if (bestCat) bestCat[d] = bc;
    }
    return leaf;
  }

  // ------------------------------------------------------------ 対局の状態
  // 1人の点数表: sc[c] = 点（未記入は -1）。mask・u（上段の合計、打ち止めなし）・raw（役の合計）
  function newSheet() { return { sc: new Array(NCAT).fill(-1), mask: 0, up: 0, raw: 0 }; }
  function writeSheet(sh, cat, pts) {
    if (sh.mask & (1 << cat)) throw new Error('もう記入した役です');
    sh.sc[cat] = pts; sh.mask |= 1 << cat; sh.raw += pts;
    if (cat < 6) sh.up += pts;
  }
  const bonusOf = sh => (sh.up >= BONUS_AT ? BONUS : 0);
  const totalOf = sh => sh.raw + bonusOf(sh);
  const uOf = sh => Math.min(BONUS_AT, sh.up);
  const filled = sh => popcount(sh.mask);
  function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
  // 終わったときの勝ち分（同点は分ける）: 返り値は各席の取り分（合計 1）
  function shares(totals) {
    const mx = Math.max(...totals);
    const w = totals.filter(t => t === mx).length;
    return totals.map(t => (t === mx ? 1 / w : 0));
  }

  // 小さな乱数（xorshift128+ 相当の 32bit 版）。seed から同じ目の並びを作る
  function rng(seed) {
    let a = seed >>> 0 || 1, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
    const next = () => { const t = b << 9; let r = a * 5; r = ((r << 7) | (r >>> 25)) * 9; c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21); return (r >>> 0) / 4294967296; };
    for (let i = 0; i < 12; i++) next();
    return next;
  }
  // 決まった目: (対局の種, 席, 手番, 何回目) → 5個の目。残していない位置にだけ使う（待ったをしても目は変わらない）
  function hash32(a, b, c, d) {
    let h = (a ^ 0x5bd1e995) >>> 0;
    for (const x of [b, c, d]) { h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; }
    return h >>> 0;
  }
  function seededRoll(seed, seat, turn, rollNo) {
    const r = rng(hash32(seed, seat + 1, turn + 1, rollNo + 1));
    return [0, 0, 0, 0, 0].map(() => 1 + Math.floor(r() * 6));
  }

  // ------------------------------------------------------------ 対局の進行（画面とオンラインの卓で共通。JSON にそのまま書ける）
  // g = { n, sheets, round(0〜11), cur(手番の席), dice[5]（0 = まだ振っていない）, hold（残す位置の印）, rolls（この手番で振った回数）, log, over }
  function newGame(n) { return { n, sheets: [...Array(n)].map(newSheet), round: 0, cur: 0, dice: [0, 0, 0, 0, 0], hold: 0, rolls: 0, log: [], over: false }; }
  const canRoll = g => !g.over && g.rolls < 3;
  const canHold = g => !g.over && g.rolls >= 1 && g.rolls < 3;
  const canScore = (g, cat) => !g.over && g.rolls >= 1 && cat >= 0 && cat < NCAT && !(g.sheets[g.cur].mask & (1 << cat));
  // fresh: 新しい5個の目（残していない位置にだけ使う）。返り値: 振り直した位置の印
  function applyRoll(g, fresh) {
    if (!canRoll(g)) throw new Error('もう振れません');
    const held = g.rolls === 0 ? 0 : g.hold;
    for (let i = 0; i < 5; i++) if (!(held & (1 << i))) g.dice[i] = fresh[i];
    g.hold = held; g.rolls++;
    return 31 & ~held;
  }
  function applyHold(g, mask) { if (!canHold(g)) throw new Error('いまは残せません'); g.hold = mask & 31; }
  function applyScore(g, cat) {
    if (!canScore(g, cat)) throw new Error('そこには記入できません');
    const pts = score(cat, g.dice);
    writeSheet(g.sheets[g.cur], cat, pts);
    g.log.push({ r: g.round, s: g.cur, d: g.dice.slice(), c: cat, p: pts });
    g.cur++;
    if (g.cur >= g.n) { g.cur = 0; g.round++; }
    g.dice = [0, 0, 0, 0, 0]; g.hold = 0; g.rolls = 0;
    if (g.round >= NCAT) g.over = true;
    return pts;
  }
  // 順位（同点は同じ順位）
  function ranks(g) { const t = g.sheets.map(totalOf); return t.map(x => 1 + t.filter(y => y > x).length); }

  // ------------------------------------------------------------ SHA-256（オンラインのサイコロの公正さ: ハッシュの鎖で前もって約束した値を順に明かす）
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const W64 = new Uint32Array(64);
  function sha256(msg) {
    const l = msg.length, nb = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(nb); m.set(msg); m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(nb - 4, (l * 8) >>> 0); dv.setUint32(nb - 8, Math.floor(l / 536870912));
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    const w = W64;
    for (let o = 0; o < nb; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        w[i] = (w[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    const out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
    return out;
  }
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => Uint8Array.from((s.match(/../g) || []).map(x => parseInt(x, 16)));
  const utf8 = s => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, 'utf8')));
  // 卓のサイコロ: 2人が明かした値と、何回目かから5個の目（偏りのないよう 252 未満のバイトだけ使う）
  function diceFromHash(seedText) {
    const out = [];
    let h = sha256(utf8(seedText));
    for (;;) {
      for (const b of h) { if (b < 252) { out.push(1 + (b % 6)); if (out.length === 5) return out; } }
      h = sha256(h);
    }
  }

  const api = {
    newGame, canRoll, canHold, canScore, applyRoll, applyHold, applyScore, ranks, sha256, hex, unhex, utf8, diceFromHash,
    NCAT, CHOICE, FOUR, FULL, LSTR, BSTR, YACHT, BONUS_AT, BONUS, ALL, NU, CATS,
    NK, ND, KC, KN, DC, DSUM, SC, dIndex, countsOf, score, scoreCounts, keepOfMask, keepFaces, holdMaskFor,
    newSolve, solveTurn, keepOptions, keepValues, rollValues, subStart, SUB, TR_TO, TR_P, trStart, EMPTY,
    REACH, tableSize, setTable, loadTable, tableValue, tableSD, soloLeaf, upAdd,
    get table() { return VT; },
    newSheet, writeSheet, bonusOf, totalOf, uOf, filled, popcount, shares, rng, hash32, seededRoll,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YachtCore = api;
})(typeof self !== 'undefined' ? self : this);
