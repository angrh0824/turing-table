/* 囲碁のルール（中国ルール: 地＋盤上の石で数える・自殺手は禁止・スーパーコウ＝同じ盤面の再現は禁止）
 *
 *   const G = {}; GoCore(G);
 *   const b = new G.Board(9, { komi: 7 });  b.play(b.pt(4, 4));  b.play(G.PASS);
 *
 * 盤は周りに1マスの番兵（OFF）を付けた (n+2)×(n+2) の1次元配列。点 p = (y+1)*(n+2) + (x+1)
 *   x = 左から 0..n-1、y = 上から 0..n-1。パス = 0（番兵の角なので盤上の点と重ならない）
 * 同形反復: 盤面（石の並びだけ。手番は含めない）を2つの32ビットの Zobrist で表し、これまでの全盤面と比べる（positional superko）
 * Web Worker の中でも使えるように、外の変数に頼らない1つの関数にしている（app.js が toString して Worker を作る）
 */
function GoCore(G) {
  'use strict';
  const EMPTY = 0, BLACK = 1, WHITE = 2, OFF = 3, PASS = 0;
  const LETTERS = 'ABCDEFGHJKLMNOPQRST'; // I は使わない（囲碁の座標の習慣）

  // ------------------------------------------------------------------ Zobrist（決まった乱数。どの環境でも同じ値）
  const MAXM = 21, MAXA = MAXM * MAXM;
  const Z1 = new Int32Array(3 * MAXA), Z2 = new Int32Array(3 * MAXA);
  {
    let s = 0x2545F491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
    for (let i = 0; i < 3 * MAXA; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  }
  // 2つのハッシュを 53 ビットの数1つに（Map のキーにする）
  const keyOf = (h1, h2) => (h1 >>> 0) * 2097152 + (h2 & 0x1FFFFF);

  // 置き石の位置（標準の星。GTP の fixed_handicap と同じ順）
  function handicapPoints(n, h) {
    if (h < 2) return [];
    const d = n >= 13 ? 3 : 2, e = n - 1 - d, m = (n - 1) >> 1;
    const LL = [d, e], UR = [e, d], UL = [d, d], LR = [e, e], C = [m, m], ML = [d, m], MR = [e, m], MB = [m, e], MT = [m, d];
    const T = { 2: [LL, UR], 3: [LL, UR, UL], 4: [LL, UR, UL, LR], 5: [LL, UR, UL, LR, C], 6: [LL, UR, UL, LR, ML, MR],
      7: [LL, UR, UL, LR, ML, MR, C], 8: [LL, UR, UL, LR, ML, MR, MB, MT], 9: [LL, UR, UL, LR, ML, MR, MB, MT, C] };
    return (T[Math.min(9, h)] || []);
  }
  const maxHandicap = n => (n >= 13 ? 9 : 5);
  // 星の位置（盤の描画用）
  function starPoints(n) {
    if (n < 7) return [];
    const d = n >= 13 ? 3 : 2, e = n - 1 - d, m = (n - 1) >> 1;
    const pts = [[d, d], [e, d], [d, e], [e, e]];
    if (n % 2 === 1) pts.push([m, m]);
    if (n >= 15 && n % 2 === 1) pts.push([d, m], [e, m], [m, d], [m, e]);
    return pts;
  }

  class Board {
    // opts: { komi: 7, handicap: 0 }。置き石があれば白から打つ。中国ルールの置き碁では、白に置き石の数だけ目を足す
    constructor(n = 9, opts = {}) {
      this.n = n; this.M = n + 2; this.A = this.M * this.M;
      this.komi = opts.komi != null ? opts.komi : 7;
      this.handicap = opts.handicap || 0;
      this.bonus = this.handicap >= 2 ? this.handicap : 0; // 白への置き石の補い
      const A = this.A, M = this.M;
      this.c = new Uint8Array(A).fill(OFF);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.c[(y + 1) * M + x + 1] = EMPTY;
      this.points = new Int16Array(n * n);
      for (let i = 0; i < n * n; i++) this.points[i] = ((i / n) | 0) * M + 1 + M + (i % n);
      this.h1 = 0; this.h2 = 0;
      this.toPlay = BLACK;
      this.passes = 0;
      this.ply = 0;
      this.prisoners = [0, 0, 0]; // [_, 黒が取った石, 白が取った石]
      this.moves = [];            // 打った手（PASS を含む）
      this.setup = [];            // 置き石などの最初の石 [点, 色]
      // 作業用
      this.mark = new Int32Array(A); this.stamp = 1;
      this.stack = new Int16Array(A);
      this.undoCap = []; // 手ごとの取った石
      this.undoInfo = [];
      this.seen = new Map(); // 盤面のキー → 出てきた回数
      this.keys = [];
      if (this.handicap >= 2) {
        for (const [x, y] of handicapPoints(n, this.handicap)) this.place(this.pt(x, y), BLACK);
        this.toPlay = WHITE;
      }
      this.firstColor = this.toPlay;
      this.pushKey();
      // 解析（連・呼吸点）の結果
      this.cid = new Int16Array(A).fill(-1);
      this.clibs = new Int16Array(A); this.cx1 = new Int32Array(A); this.cx2 = new Int32Array(A); this.csize = new Int16Array(A);
      this.nchains = 0; this.analyzedAt = -1;
    }

    pt(x, y) { return (y + 1) * this.M + x + 1; }
    xy(p) { return [p % this.M - 1, ((p / this.M) | 0) - 1]; }
    index(p) { return p === PASS ? this.n * this.n : (((p / this.M) | 0) - 1) * this.n + (p % this.M - 1); } // ネットの方策の番号（パス = n*n）
    fromIndex(i) { return i >= this.n * this.n ? PASS : this.points[i]; }
    key() { return keyOf(this.h1, this.h2); }
    pushKey() { const k = this.key(); this.keys.push(k); this.seen.set(k, (this.seen.get(k) || 0) + 1); }
    popKey() { const k = this.keys.pop(); const v = this.seen.get(k) - 1; if (v) this.seen.set(k, v); else this.seen.delete(k); }

    // 最初の石を置く（置き石・SGF の AB/AW）。履歴は変えないので、置き終わったら resetHistory()
    place(p, color) {
      const old = this.c[p];
      if (old === BLACK || old === WHITE) { this.h1 ^= Z1[old * MAXA + p]; this.h2 ^= Z2[old * MAXA + p]; }
      this.c[p] = color;
      if (color === BLACK || color === WHITE) { this.h1 ^= Z1[color * MAXA + p]; this.h2 ^= Z2[color * MAXA + p]; }
      this.setup.push([p, color]);
      this.analyzedAt = -1;
    }
    resetHistory() { this.seen.clear(); this.keys = []; this.pushKey(); this.analyzedAt = -1; }

    clone() {
      const b = Object.create(Board.prototype);
      Object.assign(b, this);
      b.c = this.c.slice(); b.mark = new Int32Array(this.A); b.stamp = 1; b.stack = new Int16Array(this.A);
      b.prisoners = this.prisoners.slice(); b.moves = this.moves.slice(); b.setup = this.setup.slice();
      b.undoCap = this.undoCap.map(a => a.slice()); b.undoInfo = this.undoInfo.slice();
      b.seen = new Map(this.seen); b.keys = this.keys.slice();
      b.cid = this.cid.slice(); b.clibs = this.clibs.slice(); b.cx1 = this.cx1.slice(); b.cx2 = this.cx2.slice(); b.csize = this.csize.slice();
      return b;
    }

    // q の連に呼吸点があるか（見つけたらすぐ戻る）
    hasLiberty(q) {
      const c = this.c, col = c[q], M = this.M, mk = this.mark, st = this.stack;
      const s = ++this.stamp;
      let sp = 0;
      st[sp++] = q; mk[q] = s;
      while (sp) {
        const p = st[--sp];
        const n0 = p - 1, n1 = p + 1, n2 = p - M, n3 = p + M;
        const a = c[n0], b = c[n1], d = c[n2], e = c[n3];
        if (a === EMPTY || b === EMPTY || d === EMPTY || e === EMPTY) return true;
        if (a === col && mk[n0] !== s) { mk[n0] = s; st[sp++] = n0; }
        if (b === col && mk[n1] !== s) { mk[n1] = s; st[sp++] = n1; }
        if (d === col && mk[n2] !== s) { mk[n2] = s; st[sp++] = n2; }
        if (e === col && mk[n3] !== s) { mk[n3] = s; st[sp++] = n3; }
      }
      return false;
    }

    // q の連を取り除いて、取った点を out に足す
    removeChain(q, out) {
      const c = this.c, col = c[q], M = this.M, st = this.stack;
      let sp = 0, n = 0;
      st[sp++] = q; c[q] = EMPTY;
      const zo = col * MAXA;
      while (sp) {
        const p = st[--sp];
        out.push(p); n++;
        this.h1 ^= Z1[zo + p]; this.h2 ^= Z2[zo + p];
        if (c[p - 1] === col) { c[p - 1] = EMPTY; st[sp++] = p - 1; }
        if (c[p + 1] === col) { c[p + 1] = EMPTY; st[sp++] = p + 1; }
        if (c[p - M] === col) { c[p - M] = EMPTY; st[sp++] = p - M; }
        if (c[p + M] === col) { c[p + M] = EMPTY; st[sp++] = p + M; }
      }
      return n;
    }

    // 手を打つ（合法かは確かめない。確かめるのは isLegal / legalMoves）。取った石の数を返す
    play(p) {
      const col = this.toPlay, opp = 3 - col, c = this.c, M = this.M;
      const cap = [];
      this.undoInfo.push(this.passes, this.h1, this.h2, this.prisoners[col]);
      if (p === PASS) {
        this.passes++;
      } else {
        c[p] = col;
        this.h1 ^= Z1[col * MAXA + p]; this.h2 ^= Z2[col * MAXA + p];
        if (c[p - 1] === opp && !this.hasLiberty(p - 1)) this.removeChain(p - 1, cap);
        if (c[p + 1] === opp && !this.hasLiberty(p + 1)) this.removeChain(p + 1, cap);
        if (c[p - M] === opp && !this.hasLiberty(p - M)) this.removeChain(p - M, cap);
        if (c[p + M] === opp && !this.hasLiberty(p + M)) this.removeChain(p + M, cap);
        this.prisoners[col] += cap.length;
        this.passes = 0;
      }
      this.undoCap.push(cap);
      this.moves.push(p);
      this.toPlay = opp;
      this.ply++;
      if (p !== PASS) this.pushKey(); else this.keys.push(-1); // パスは盤面が変わらない（同形の判定に入れない）
      this.analyzedAt = -1;
      return cap.length;
    }

    undo() {
      if (!this.moves.length) return;
      const p = this.moves.pop(), cap = this.undoCap.pop();
      const col = 3 - this.toPlay, opp = this.toPlay, c = this.c;
      if (p !== PASS) {
        this.popKey();
        c[p] = EMPTY;
        for (let i = 0; i < cap.length; i++) c[cap[i]] = opp;
      } else this.keys.pop();
      const u = this.undoInfo;
      this.prisoners[col] = u.pop(); this.h2 = u.pop(); this.h1 = u.pop(); this.passes = u.pop();
      this.toPlay = col;
      this.ply--;
      this.analyzedAt = -1;
    }

    // ---------------------------------------------------------------- 連の解析（呼吸点の数・連のハッシュ）
    // cid[p] = 連の番号、clibs/csize/cx1/cx2[番号] = 呼吸点の数・石の数・石のハッシュの XOR。局面が変わるまで使い回す
    analyze() {
      if (this.analyzedAt === this.ply && this.analyzedKey === this.h1) return;
      const c = this.c, M = this.M, cid = this.cid, mk = this.mark, st = this.stack, pts = this.points;
      cid.fill(-1);
      let nc = 0;
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i], col = c[q];
        if ((col !== BLACK && col !== WHITE) || cid[q] >= 0) continue;
        const id = nc++, s = ++this.stamp, zo = col * MAXA;
        let sp = 0, libs = 0, size = 0, x1 = 0, x2 = 0;
        st[sp++] = q; cid[q] = id;
        while (sp) {
          const p = st[--sp];
          size++; x1 ^= Z1[zo + p]; x2 ^= Z2[zo + p];
          for (let k = 0; k < 4; k++) {
            const r = k === 0 ? p - 1 : k === 1 ? p + 1 : k === 2 ? p - M : p + M;
            const cr = c[r];
            if (cr === EMPTY) { if (mk[r] !== s) { mk[r] = s; libs++; } }
            else if (cr === col && cid[r] < 0) { cid[r] = id; st[sp++] = r; }
          }
        }
        this.clibs[id] = libs; this.csize[id] = size; this.cx1[id] = x1; this.cx2[id] = x2;
      }
      this.nchains = nc;
      this.analyzedAt = this.ply; this.analyzedKey = this.h1;
    }

    // 空き点 p に手番の側が打てるか: 0 = 打てる、1 = 石がある、2 = 自殺手、3 = 同形反復（コウ）。analyze() のあとで呼ぶ
    legality(p) {
      const c = this.c;
      if (c[p] !== EMPTY) return 1;
      const col = this.toPlay, opp = 3 - col, M = this.M, cid = this.cid;
      let h1 = this.h1 ^ Z1[col * MAXA + p], h2 = this.h2 ^ Z2[col * MAXA + p];
      let ok = false, capA = -1, capB = -1, capC = -1;
      for (let k = 0; k < 4; k++) {
        const r = k === 0 ? p - 1 : k === 1 ? p + 1 : k === 2 ? p - M : p + M;
        const cr = c[r];
        if (cr === EMPTY) ok = true;
        else if (cr === col) { if (this.clibs[cid[r]] >= 2) ok = true; }
        else if (cr === opp) {
          const id = cid[r];
          if (this.clibs[id] === 1 && id !== capA && id !== capB && id !== capC) {
            ok = true;
            h1 ^= this.cx1[id]; h2 ^= this.cx2[id];
            if (capA < 0) capA = id; else if (capB < 0) capB = id; else capC = id;
          }
        }
      }
      if (!ok) return 2;
      if (this.seen.has(keyOf(h1, h2))) return 3;
      return 0;
    }
    isLegal(p) { if (p === PASS) return true; if (p < 0 || p >= this.A || this.c[p] !== EMPTY) return false; this.analyze(); return this.legality(p) === 0; }

    // 合法手（PASS を含めるか選べる）を out（Int16Array など）に入れて数を返す。ban を渡すとコウで打てない点に 1 を立てる
    legalMoves(out, withPass = true, ban = null) {
      this.analyze();
      const pts = this.points, c = this.c;
      let k = 0;
      if (ban) ban.fill(0);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (c[p] !== EMPTY) continue;
        const r = this.legality(p);
        if (r === 0) out[k++] = p;
        else if (r === 3 && ban) ban[i] = 1;
      }
      if (withPass) out[k++] = PASS;
      return k;
    }
    legalList(withPass = true) { const out = new Int16Array(this.n * this.n + 1); const k = this.legalMoves(out, withPass); return Array.from(out.subarray(0, k)); }

    // ---------------------------------------------------------------- 終局と数え方（中国ルール＝地＋盤上の石）
    // dead: 死に石の点の集まり（Set）。死に石は取り除いてから、石と「片方の色だけに囲まれた空き」を数える
    // 戻り値: { black, white, score: 黒−白−コミ（正なら黒の勝ち）, owner: 点ごとの持ち主 (Int8Array n*n, 1=黒 2=白 0=どちらでもない) }
    score(dead) {
      const n = this.n, M = this.M, c = this.c.slice();
      if (dead) for (const p of dead) if (c[p] === BLACK || c[p] === WHITE) c[p] = EMPTY;
      const owner = new Int8Array(n * n);
      const mk = new Int32Array(this.A), st = new Int16Array(this.A);
      let black = 0, white = 0, s = 0;
      for (let i = 0; i < n * n; i++) {
        const q = this.points[i];
        if (c[q] === BLACK) { owner[i] = 1; black++; continue; }
        if (c[q] === WHITE) { owner[i] = 2; white++; continue; }
        if (mk[q]) continue;
        // 空きの領域をたどり、どの色に接しているかを調べる
        s++;
        let sp = 0, touch = 0;
        const region = [];
        st[sp++] = q; mk[q] = s;
        while (sp) {
          const p = st[--sp];
          region.push(p);
          for (let k = 0; k < 4; k++) {
            const r = k === 0 ? p - 1 : k === 1 ? p + 1 : k === 2 ? p - M : p + M;
            const cr = c[r];
            if (cr === EMPTY) { if (!mk[r]) { mk[r] = s; st[sp++] = r; } }
            else if (cr === BLACK) touch |= 1;
            else if (cr === WHITE) touch |= 2;
          }
        }
        const who = touch === 1 ? 1 : touch === 2 ? 2 : 0;
        for (const p of region) owner[this.index(p)] = who;
        if (who === 1) black += region.length; else if (who === 2) white += region.length;
      }
      return { black, white, score: black - white - this.komi - this.bonus, owner };
    }
    // 結果の文字（SGF の RE と同じ形: B+3.5 / W+R / 0 = 持碁）
    static resultText(score) { return score > 0 ? `B+${score}` : score < 0 ? `W+${-score}` : '0'; }

    // 点 p の連の石（Set）
    chainAt(p) {
      const col = this.c[p], out = new Set();
      if (col !== BLACK && col !== WHITE) return out;
      const st = [p];
      out.add(p);
      while (st.length) {
        const q = st.pop();
        for (const r of [q - 1, q + 1, q - this.M, q + this.M]) if (this.c[r] === col && !out.has(r)) { out.add(r); st.push(r); }
      }
      return out;
    }
    // 死に石の印を付け外しする単位: 相手の石に囲まれた範囲（同じ色の石と空き点でつながった範囲）の同じ色の石をまとめて。
    // 範囲が盤の1/3より広い（囲まれていない）ときは、その連だけ
    deadGroupAt(p) {
      const col = this.c[p], out = new Set();
      if (col !== BLACK && col !== WHITE) return out;
      const st = [p], seen = new Set([p]);
      while (st.length) {
        const q = st.pop();
        if (this.c[q] === col) out.add(q);
        for (const r of [q - 1, q + 1, q - this.M, q + this.M]) {
          if (seen.has(r)) continue;
          const cr = this.c[r];
          if (cr === col || cr === EMPTY) { seen.add(r); st.push(r); }
        }
      }
      return seen.size * 3 > this.n * this.n ? this.chainAt(p) : out;
    }

    // ---------------------------------------------------------------- 表記
    // 座標の文字（例 "E5"）。数字は下から 1
    name(p) {
      if (p === PASS) return 'パス';
      const [x, y] = this.xy(p);
      return LETTERS[x] + (this.n - y);
    }
    parseName(s) {
      s = String(s).trim().toUpperCase();
      if (/^(PASS|パス)$/i.test(s)) return PASS;
      const m = s.match(/^([A-HJ-T])(\d{1,2})$/);
      if (!m) return -1;
      const x = LETTERS.indexOf(m[1]), y = this.n - Number(m[2]);
      if (x < 0 || x >= this.n || y < 0 || y >= this.n) return -1;
      return this.pt(x, y);
    }
    colorAt(x, y) { return this.c[this.pt(x, y)]; }
  }

  // ------------------------------------------------------------------ ネットへの入力（学習の train/net.py の decode と並びを合わせること）
  // 手番の側から見た 1点1バイト ＋ 全体の4バイト:
  //   点: bit0-1 = 0 空き / 1 自分の石 / 2 相手の石、bit2-3 = 石の連の呼吸点 1 / 2 / 3以上、bit4 = コウ（同形反復）で打てない空き点、
  //       bit5-7 = 何手前に打たれた点か（1〜5。パスも1手と数える）
  //   全体: [0] 直前の手がパス、[1] その前の手がパス、[2] コミ（手番の側に足される目数。白番なら +コミ、黒番なら −コミ）×2 + 128、[3] 予備
  const IN_EXTRA = 4;
  const inBytes = n => n * n + IN_EXTRA;
  // ban: legalMoves(…, ban) で作ったコウの印（なければここで調べる）
  function features(b, out, o, ban) {
    b.analyze();
    const n = b.n, nn = n * n, col = b.toPlay, c = b.c, pts = b.points, cid = b.cid, clibs = b.clibs;
    for (let i = 0; i < nn; i++) {
      const p = pts[i], v = c[p];
      if (v === EMPTY) out[o + i] = (ban ? ban[i] : b.legality(p) === 3) ? 16 : 0;
      else {
        const L = clibs[cid[p]];
        out[o + i] = (v === col ? 1 : 2) | ((L >= 3 ? 3 : L) << 2);
      }
    }
    const mv = b.moves;
    for (let k = mv.length - 1, r = 1; k >= 0 && r <= 5; k--, r++) {
      const p = mv[k];
      if (p === PASS) continue;
      const i = b.index(p);
      if (!(out[o + i] >> 5)) out[o + i] |= r << 5;
    }
    out[o + nn] = mv.length >= 1 && mv[mv.length - 1] === PASS ? 1 : 0;
    out[o + nn + 1] = mv.length >= 2 && mv[mv.length - 2] === PASS ? 1 : 0;
    const k = (b.komi + b.bonus) * (col === WHITE ? 1 : -1); // 手番の側に有利な目数
    out[o + nn + 2] = Math.max(-127, Math.min(127, Math.round(k * 2))) + 128;
    out[o + nn + 3] = 0;
  }

  // ------------------------------------------------------------------ SGF
  const SGF_LET = 'abcdefghijklmnopqrstuvwxyz';
  function sgfPoint(b, p) { if (p === PASS) return ''; const [x, y] = b.xy(p); return SGF_LET[x] + SGF_LET[y]; }
  const sgfEsc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/]/g, '\\]');

  // info: { black, white, result: 'B+3' など, date, comment }
  function toSGF(b, info = {}) {
    let s = `(;GM[1]FF[4]CA[UTF-8]AP[TuringTable:1]SZ[${b.n}]RU[Chinese]KM[${b.komi}]`;
    if (b.handicap >= 2) s += `HA[${b.handicap}]`;
    if (info.black) s += `PB[${sgfEsc(info.black)}]`;
    if (info.white) s += `PW[${sgfEsc(info.white)}]`;
    if (info.date) s += `DT[${sgfEsc(info.date)}]`;
    if (info.result) s += `RE[${sgfEsc(info.result)}]`;
    if (info.comment) s += `GC[${sgfEsc(info.comment)}]`;
    const ab = b.setup.filter(([, c]) => c === BLACK).map(([p]) => p), aw = b.setup.filter(([, c]) => c === WHITE).map(([p]) => p);
    if (ab.length) s += 'AB' + ab.map(p => `[${sgfPoint(b, p)}]`).join('');
    if (aw.length) s += 'AW' + aw.map(p => `[${sgfPoint(b, p)}]`).join('');
    if (b.setup.length && b.handicap < 2) s += `PL[${b.firstColor === WHITE ? 'W' : 'B'}]`;
    let col = b.firstColor || (b.handicap >= 2 ? WHITE : BLACK);
    let line = '';
    for (const p of b.moves) {
      line += `;${col === BLACK ? 'B' : 'W'}[${sgfPoint(b, p)}]`;
      col = 3 - col;
    }
    return s + '\n' + line + ')\n';
  }

  // SGF の本筋（最初の変化）を読む。戻り値: { board（最後まで打った盤）, moves, info }
  function parseSGF(text) {
    const src = String(text);
    let i = src.indexOf('(');
    if (i < 0) throw new Error('SGF ではありません（「(;」が見つかりません）');
    const nodes = [];
    let depth = 0, cur = null, done = false;
    while (i < src.length && !done) {
      const ch = src[i];
      if (ch === '(') { depth++; if (depth > 1 && nodes.length) { /* 変化: 最初のものだけ読む */ } i++; continue; }
      if (ch === ')') { depth--; i++; if (nodes.length) done = true; continue; } // 最初の変化の終わりで打ち切る
      if (ch === ';') { cur = {}; nodes.push(cur); i++; continue; }
      if (/[A-Za-z]/.test(ch)) {
        let id = '';
        while (i < src.length && /[A-Za-z]/.test(src[i])) { if (/[A-Z]/.test(src[i])) id += src[i]; i++; }
        const vals = [];
        while (true) {
          while (i < src.length && /\s/.test(src[i])) i++;
          if (src[i] !== '[') break;
          i++;
          let v = '';
          while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; v += src[i]; i++; }
          i++;
          vals.push(v);
        }
        if (cur && id) (cur[id] = cur[id] || []).push(...vals);
        continue;
      }
      i++;
    }
    if (!nodes.length) throw new Error('SGF の中身がありません');
    const root = nodes[0];
    const n = root.SZ ? parseInt(root.SZ[0], 10) : 19;
    if (![9, 13, 19].includes(n) && !(n >= 5 && n <= 19)) throw new Error(`盤の大きさ ${root.SZ && root.SZ[0]} には対応していません`);
    const komi = root.KM ? Number(root.KM[0]) || 0 : 7;
    const ha = root.HA ? parseInt(root.HA[0], 10) || 0 : 0;
    const b = new Board(n, { komi });
    b.handicap = ha; b.bonus = ha >= 2 ? ha : 0;
    const pp = v => {
      if (v === '' || (v === 'tt' && n <= 19)) return PASS;
      const x = SGF_LET.indexOf(v[0]), y = SGF_LET.indexOf(v[1]);
      if (x < 0 || y < 0 || x >= n || y >= n) throw new Error(`座標 [${v}] が盤の外です`);
      return b.pt(x, y);
    };
    let setup = false;
    for (const nd of nodes) {
      for (const [prop, color] of [['AB', BLACK], ['AW', WHITE], ['AE', EMPTY]]) {
        if (!nd[prop]) continue;
        for (const v of nd[prop]) {
          // 範囲の書き方 aa:cc にも対応
          if (v.includes(':')) {
            const [a, z] = v.split(':').map(pp);
            const [x0, y0] = b.xy(a), [x1, y1] = b.xy(z);
            for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) b.place(b.pt(x, y), color);
          } else b.place(pp(v), color);
          setup = true;
        }
      }
      if (nd === root) break;
    }
    if (setup) b.resetHistory();
    let first = null;
    if (root.PL) first = /^w/i.test(root.PL[0]) ? WHITE : BLACK;
    const moves = [];
    for (const nd of nodes) {
      const mv = nd.B ? [BLACK, nd.B[0]] : nd.W ? [WHITE, nd.W[0]] : null;
      if (!mv) continue;
      const [col, v] = mv;
      if (first == null) first = col;
      if (!moves.length) { b.toPlay = col; b.firstColor = col; }
      if (col !== b.toPlay) {
        // 同じ色が続けて打っている棋譜は、間にパスを入れて読む
        moves.push(PASS); b.play(PASS);
      }
      const p = pp(v);
      if (p !== PASS && !b.isLegal(p)) throw new Error(`${moves.length + 1}手目 ${b.name(p)} は打てません（${b.c[p] !== EMPTY ? '石があります' : '自殺手か同形反復'}）`);
      b.play(p); moves.push(p);
    }
    if (!moves.length) { b.toPlay = first || (b.setup.some(([, c]) => c === BLACK) && ha >= 2 ? WHITE : BLACK); b.firstColor = b.toPlay; }
    const info = { black: root.PB ? root.PB[0] : '', white: root.PW ? root.PW[0] : '', result: root.RE ? root.RE[0] : '', komi, handicap: ha, size: n };
    return { board: b, moves, info };
  }

  Object.assign(G, { EMPTY, BLACK, WHITE, OFF, PASS, LETTERS, Board, handicapPoints, maxHandicap, starPoints, toSGF, parseSGF, keyOf, Z1, Z2, MAXA, IN_EXTRA, inBytes, features });
  return G;
}

if (typeof module !== 'undefined' && module.exports) module.exports = GoCore;
