/* 花札こいこい: AI（見えている情報の特徴・ネットの推論・CPU）。ブラウザ・Web Worker・Node のどれでも動く
 *
 * 考え方（くわしくは README）
 *   ・ネットは「この局面でこの手を選んだら、最後に対局（何か月かの合計）に勝つ見込み」と「この月の得点差」を出す
 *   ・自己対局だけで学ぶ（DouZero 型の Deep Monte-Carlo: 実際に最後まで打った結果を目標に回帰）
 *   ・「勝負」した場合の勝つ見込みは計算で出せる（月の結果の分布から作った表 V を使う）
 *   ・最強は、見えていない札（相手の手札と山札）をいろいろに仮定して最後まで打ってみて、平均の一番よい手を選ぶ
 *
 * 局面の符号（学習の train/train.py と同じ並び。変えたら両方を直すこと）
 *   48枚の集合 ×6（各6バイト）: 自分の手札・場・自分の取り札・相手の取り札・見えていない札・めくって選んでいる札
 *   数のバイト ×NS: 下の SCAL を見る
 * 手の符号: 種類・出した札・取る札の集合・場に置く札・取ったあとの役の点
 */
(function (root) {
  'use strict';
  const K = root.KoikoiCore || (typeof require !== 'undefined' ? require('./koikoi-core.js') : null);
  const { PLAY, KOI, STOP, isPlay, isPick, playCard, playTarget, pickTarget, TYPE } = K;

  // ------------------------------------------------------------------ 符号
  const NSETS = 6;
  // 数のバイト（名前, 割る数）。lead は 128 を足して入れる
  const SCAL = [
    ['oppHand', 8], ['deck', 24], ['myScore', 10], ['oppScore', 10], ['myKoi', 3], ['oppKoi', 3],
    ['dealer', 1], ['phPlay', 1], ['phPick', 1], ['phKoi', 1], ['after', 12], ['lead', 30],
    ['rSake', 1], ['rSakeKasu', 1], ['rDouble7', 1], ['rKoiDouble', 1], ['rOyaken', 1],
    ['myDecided', 10], ['myL', 5], ['myTane', 9], ['myTan', 10], ['myKasu', 24], ['opL', 5], ['opTane', 9], ['opTan', 10], ['opKasu', 24],
    ['myStop', 10], ['oppStop', 10], ['oppDecided', 10],
  ];
  const NS = SCAL.length;
  const S_BYTES = NSETS * 6 + NS;
  const DS = NSETS * 48 + NS;            // 状態の特徴の次元
  const LEAD_IDX = SCAL.findIndex(s => s[0] === 'lead');
  const A_BYTES = 10;                    // 種類, 出した札(255=なし), 取る札の集合(6), 置く札(255=なし), 取ったあとの点
  const DA = 4 + 48 + 48 + 48 + 1;       // 手の特徴の次元
  const A_OFF_KIND = 0, A_OFF_PLAYED = 4, A_OFF_TAKE = 52, A_OFF_LEAVE = 100, A_OFF_SCORE = 148;

  function setBits(buf, off, cards) {
    for (const c of cards) if (c >= 0) buf[off + (c >> 3)] |= 1 << (c & 7);
  }
  const clampB = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // 勝負したときに入る点（倍まで込み）
  function stopPoints(r, p) {
    const s = r.score[p];
    if (!s) return 0;
    let m = 1;
    if (r.rules.double7 && s >= 7) m *= 2;
    if (r.rules.koiDouble && r.koi[p ^ 1] > 0) m *= 2;
    return s * m;
  }
  function typeCounts(has) {
    const n = [0, 0, 0, 0];
    for (let c = 0; c < 48; c++) if (has[c]) n[TYPE[c]]++;
    return n;
  }

  // ctx: { after: この月のあとに残る月数, lead: 自分から見た合計点の差 }
  function encodeState(r, p, ctx, out) {
    const b = out || new Uint8Array(S_BYTES);
    if (out) b.fill(0);
    const o = p ^ 1;
    setBits(b, 0, r.hands[p]);
    setBits(b, 6, r.field);
    setBits(b, 12, r.caps[p]);
    setBits(b, 18, r.caps[o]);
    // 見えていない札 = 48枚から 見えている札を除いたもの
    const seen = new Uint8Array(48);
    for (const c of r.hands[p]) seen[c] = 1;
    for (const c of r.field) seen[c] = 1;
    for (const c of r.caps[0]) seen[c] = 1;
    for (const c of r.caps[1]) seen[c] = 1;
    if (r.pending >= 0) seen[r.pending] = 1;
    for (let c = 0; c < 48; c++) if (!seen[c]) b[24 + (c >> 3)] |= 1 << (c & 7);
    if (r.pending >= 0) setBits(b, 30, [r.pending]);
    const my = typeCounts(r.has[p]), op = typeCounts(r.has[o]);
    const rl = r.rules, s = 36;
    const v = [
      r.hands[o].length, r.deck.length, clampB(r.score[p], 0, 60), clampB(r.score[o], 0, 60), clampB(r.koi[p], 0, 9), clampB(r.koi[o], 0, 9),
      r.dealer === p ? 1 : 0, r.phase === 'play' ? 1 : 0, r.phase === 'pick' ? 1 : 0, r.phase === 'koi' ? 1 : 0,
      clampB(ctx.after | 0, 0, 11), clampB(Math.round(ctx.lead) + 128, 0, 255),
      rl.sake ? 1 : 0, rl.sakeKasu ? 1 : 0, rl.double7 ? 1 : 0, rl.koiDouble ? 1 : 0, rl.oyaken ? 1 : 0,
      clampB(r.decided[p], 0, 60), my[0], my[1], my[2], my[3], op[0], op[1], op[2], op[3],
      clampB(stopPoints(r, p), 0, 200), clampB(stopPoints(r, o), 0, 200), clampB(r.decided[o], 0, 60),
    ];
    for (let i = 0; i < NS; i++) b[s + i] = v[i];
    return b;
  }

  // 手の符号。出す手は「取る札」をこの場で決める（めくる札は運なので含めない）
  function encodeAction(r, a, out) {
    const b = out || new Uint8Array(A_BYTES);
    if (out) b.fill(0);
    b[1] = 255; b[8] = 255;
    const p = r.turn;
    let take = null, c = -1;
    if (a === KOI) b[0] = 2;
    else if (a === STOP) b[0] = 3;
    else {
      if (isPlay(a)) { b[0] = 0; c = playCard(a); b[1] = c; }
      else { b[0] = 1; c = r.pending; }
      const f = isPlay(a) ? playTarget(a) : pickTarget(a);
      const ms = r.matches(c);
      if (!ms.length) b[8] = c;
      else {
        take = ms.length === 1 ? [ms[0]] : ms.length === 2 ? [f >= 0 ? f : ms[0]] : ms;
        take = take.concat([c]);
        setBits(b, 2, take);
      }
    }
    // 取ったあとの自分の役の点
    let sc = r.score[p];
    if (take) {
      const h = r.has[p];
      const add = take.filter(x => !h[x]);
      for (const x of add) h[x] = 1;
      sc = K.yakuTotal(h, r.rules);
      for (const x of add) h[x] = 0;
    }
    b[9] = clampB(sc, 0, 60);
    return b;
  }

  // 状態の特徴（密）: 集合は 0/1、数は割る数で割る（lead は 128 を引く）
  function stateFeatures(b, out) {
    const x = out || new Float32Array(DS);
    for (let s = 0; s < NSETS; s++) for (let c = 0; c < 48; c++) x[s * 48 + c] = (b[s * 6 + (c >> 3)] >> (c & 7)) & 1;
    for (let i = 0; i < NS; i++) {
      const raw = b[36 + i];
      x[NSETS * 48 + i] = (i === LEAD_IDX ? raw - 128 : raw) / SCAL[i][1];
    }
    return x;
  }
  // 手の特徴の 0 でない場所と値（ネットの1層目を足し算で作るため）
  function actionSparse(b) {
    const idx = [A_OFF_KIND + b[0]], val = [1];
    if (b[1] !== 255) { idx.push(A_OFF_PLAYED + b[1]); val.push(1); }
    for (let c = 0; c < 48; c++) if ((b[2 + (c >> 3)] >> (c & 7)) & 1) { idx.push(A_OFF_TAKE + c); val.push(1); }
    if (b[8] !== 255) { idx.push(A_OFF_LEAVE + b[8]); val.push(1); }
    idx.push(A_OFF_SCORE); val.push(b[9] / 10);
    return { idx, val };
  }
  function actionFeatures(b, out) {
    const x = out || new Float32Array(DA);
    x.fill(0);
    const s = actionSparse(b);
    for (let i = 0; i < s.idx.length; i++) x[s.idx[i]] = s.val[i];
    return x;
  }

  // ------------------------------------------------------------------ 勝つ見込みの表 V
  // V[r][L + LMAX][dm]: 残り r か月、自分の合計点の差 L、次の月の親が自分なら dm=1 のときに対局に勝つ見込み
  const LMAX = 120, VR = 13, VL = 2 * LMAX + 1;
  // dist: { dealer: [{d, p}], ko: [{d, p}] }（自分が親のとき・子のときの、自分から見た月の得点差の分布）
  function buildV(dist) {
    const V = new Float32Array(VR * VL * 2);
    const at = (r, L, dm) => r * VL * 2 + (L + LMAX) * 2 + dm;
    for (let L = -LMAX; L <= LMAX; L++) { const w = L > 0 ? 1 : L < 0 ? 0 : 0.5; V[at(0, L, 0)] = w; V[at(0, L, 1)] = w; }
    for (let r = 1; r < VR; r++) {
      for (let dm = 0; dm < 2; dm++) {
        const D = dm ? dist.dealer : dist.ko;
        for (let L = -LMAX; L <= LMAX; L++) {
          let s = 0;
          for (const { d, p } of D) {
            const L2 = clampB(L + d, -LMAX, LMAX);
            const dm2 = d > 0 ? 1 : d < 0 ? 0 : dm;
            s += p * V[at(r - 1, L2, dm2)];
          }
          V[at(r, L, dm)] = s;
        }
      }
    }
    return V;
  }
  // 最初の表（まだ自己対局の結果がないとき）: ざっくりした分布
  function defaultDist() {
    const mk = adv => {
      const out = [{ d: 0, p: 0.08 }];
      const pts = [[1, 0.2], [2, 0.12], [3, 0.1], [4, 0.08], [5, 0.16], [6, 0.1], [7, 0.04], [10, 0.08], [12, 0.04], [14, 0.03], [20, 0.03], [30, 0.02]];
      const tot = pts.reduce((s, x) => s + x[1], 0);
      for (const [d, p] of pts) { out.push({ d, p: (0.46 + adv) * p / tot }); out.push({ d: -d, p: (0.46 - adv) * p / tot }); }
      return out;
    };
    return { dealer: mk(0.03), ko: mk(-0.03) };
  }
  function vAt(V, r, L, dm) {
    r = clampB(r | 0, 0, VR - 1);
    L = clampB(Math.round(L), -LMAX, LMAX);
    return V[r * VL * 2 + (L + LMAX) * 2 + (dm ? 1 : 0)];
  }
  // この月の結果 d（自分から見た得点差）が出たあとの勝つ見込み
  function vAfter(V, ctx, d, wasDealer) {
    return vAt(V, ctx.after, ctx.lead + d, d > 0 ? 1 : d < 0 ? 0 : wasDealer ? 1 : 0);
  }

  // ------------------------------------------------------------------ ネット
  // 重み: { h1, h2, h3, W1s[DS*h1], W1a[DA*h1], b1, W2[h1*h2], b2, W3[h2*h3], b3, W4[h3*2], b4, V }
  //   W は「入力1つにつき1行」の並び（行を足し込むだけで1層目ができる）
  //   出力0 = 勝つ見込みの logit、出力1 = この月の得点差 / 10
  class Net {
    constructor(w) {
      this.h1 = w.h1; this.h2 = w.h2; this.h3 = w.h3;
      const f = a => (a instanceof Float32Array ? a : Float32Array.from(a));
      this.W1s = f(w.W1s); this.W1a = f(w.W1a); this.b1 = f(w.b1);
      this.W2 = f(w.W2); this.b2 = f(w.b2); this.W3 = f(w.W3); this.b3 = f(w.b3); this.W4 = f(w.W4); this.b4 = f(w.b4);
      this.V = w.V ? f(w.V) : buildV(defaultDist());
      this.gen = w.gen || 0;
      this.base = new Float32Array(this.h1);
      this.z1 = new Float32Array(this.h1); this.z2 = new Float32Array(this.h2); this.z3 = new Float32Array(this.h3);
      this.sx = new Float32Array(DS);
      this.aIdx = new Int32Array(64); this.aVal = new Float32Array(64);
      this.out = [0, 0];
      this.simd = null;
      const SIMD = root.KoikoiSIMD || (typeof require !== 'undefined' ? (() => { try { return require('./nn-simd.js'); } catch (e) { return null; } })() : null);
      if (SIMD && w.simd !== false && this.h1 % 4 === 0 && this.h2 % 4 === 0 && this.h3 % 4 === 0) this.initSimd(SIMD);
    }
    // WebAssembly のメモリに重みと作業用の配列を置く
    initSimd(SIMD) {
      const H1 = this.h1, H2 = this.h2, H3 = this.h3;
      const parts = [['W1s', DS * H1], ['W1a', DA * H1], ['W2', H1 * H2], ['W3', H2 * H3], ['base', H1], ['z1', H1], ['z2', H2], ['z3', H3]];
      let off = 0;
      const at = {};
      for (const [k, n] of parts) { at[k] = off; off += Math.ceil(n * 4 / 16) * 16; }
      const m = SIMD.create(off);
      if (!m) return;
      const buf = m.memory.buffer;
      const view = (k, n) => new Float32Array(buf, at[k], n);
      view('W1s', DS * H1).set(this.W1s); view('W1a', DA * H1).set(this.W1a); view('W2', H1 * H2).set(this.W2); view('W3', H2 * H3).set(this.W3);
      this.base = view('base', H1); this.z1 = view('z1', H1); this.z2 = view('z2', H2); this.z3 = view('z3', H3);
      this.simd = { axpy: m.axpy, layer: m.layer, at };
    }
    // 状態ぶんの1層目（行を足す）
    setState(sb) {
      const H = this.h1, base = this.base, W = this.W1s;
      base.set(this.b1);
      const x = stateFeatures(sb, this.sx);
      if (this.simd) {
        const { axpy, at } = this.simd;
        for (let i = 0; i < DS; i++) { const v = x[i]; if (v !== 0) axpy(at.W1s + i * H * 4, at.base, H, v); }
        return;
      }
      for (let i = 0; i < DS; i++) {
        const v = x[i];
        if (v === 0) continue;
        const o = i * H;
        if (v === 1) for (let j = 0; j < H; j++) base[j] += W[o + j];
        else for (let j = 0; j < H; j++) base[j] += v * W[o + j];
      }
    }
    // 手の特徴の 0 でない場所（配列を作らない版）
    actionNZ(b) {
      const idx = this.aIdx, val = this.aVal;
      let n = 0;
      idx[n] = A_OFF_KIND + b[0]; val[n++] = 1;
      if (b[1] !== 255) { idx[n] = A_OFF_PLAYED + b[1]; val[n++] = 1; }
      for (let k = 0; k < 6; k++) { let v = b[2 + k]; let c = k * 8; while (v) { if (v & 1) { idx[n] = A_OFF_TAKE + c; val[n++] = 1; } v >>= 1; c++; } }
      if (b[8] !== 255) { idx[n] = A_OFF_LEAVE + b[8]; val[n++] = 1; }
      idx[n] = A_OFF_SCORE; val[n++] = b[9] / 10;
      return n;
    }
    // setState のあと、手1つを評価: [勝つ見込み(0〜1), 得点差]（返す配列は使い回す）
    evalAction(ab) {
      const H1 = this.h1, H2 = this.h2, H3 = this.h3, z1 = this.z1, z2 = this.z2, z3 = this.z3, W1a = this.W1a;
      z1.set(this.base);
      const nz = this.actionNZ(ab), idx = this.aIdx, val = this.aVal;
      z2.set(this.b2);
      z3.set(this.b3);
      if (this.simd) {
        const { axpy, layer, at } = this.simd;
        for (let k = 0; k < nz; k++) if (val[k] !== 0) axpy(at.W1a + idx[k] * H1 * 4, at.z1, H1, val[k]);
        layer(at.z1, H1, at.W2, H2, at.z2);
        layer(at.z2, H2, at.W3, H3, at.z3);
      } else {
        for (let k = 0; k < nz; k++) {
          const o = idx[k] * H1, v = val[k];
          if (v === 0) continue;
          for (let j = 0; j < H1; j++) z1[j] += v * W1a[o + j];
        }
        const W2 = this.W2;
        for (let i = 0; i < H1; i++) {
          const v = z1[i];
          if (v <= 0) continue;
          const o = i * H2;
          for (let j = 0; j < H2; j++) z2[j] += v * W2[o + j];
        }
        const W3 = this.W3;
        for (let i = 0; i < H2; i++) {
          const v = z2[i];
          if (v <= 0) continue;
          const o = i * H3;
          for (let j = 0; j < H3; j++) z3[j] += v * W3[o + j];
        }
      }
      let o0 = this.b4[0], o1 = this.b4[1];
      const W4 = this.W4;
      for (let i = 0; i < H3; i++) { const v = z3[i]; if (v > 0) { o0 += v * W4[i * 2]; o1 += v * W4[i * 2 + 1]; } }
      return [1 / (1 + Math.exp(-o0)), o1 * 10];
    }
  }
  // 乱数で初期化したネット（第0世代）
  function randomWeights(h1, h2, h3, rng) {
    rng = rng || Math.random;
    const gauss = () => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const mat = (n, fanIn) => { const a = new Float32Array(n); const s = Math.sqrt(2 / fanIn); for (let i = 0; i < n; i++) a[i] = gauss() * s; return a; };
    return {
      h1, h2, h3, gen: 0,
      W1s: mat(DS * h1, 60), W1a: mat(DA * h1, 60), b1: new Float32Array(h1),
      W2: mat(h1 * h2, h1), b2: new Float32Array(h2), W3: mat(h2 * h3, h2), b3: new Float32Array(h3),
      W4: mat(h3 * 2, h3 * 50), b4: new Float32Array(2), V: buildV(defaultDist()),
    };
  }
  // 重みの読み込み: 量子化（int8・行ごとの倍率）を base64 で入れた形 → Float32Array
  function b64bytes(s) {
    if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function unpackWeights(pk) {
    const w = { h1: pk.h1, h2: pk.h2, h3: pk.h3, gen: pk.gen };
    for (const [name, m] of Object.entries(pk.mats)) {
      const q = new Int8Array(b64bytes(m.q).buffer), sc = new Float32Array(b64bytes(m.s).buffer);
      const rows = m.rows, cols = m.cols, a = new Float32Array(rows * cols);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) a[i * cols + j] = q[i * cols + j] * sc[i];
      w[name] = a;
    }
    for (const [name, v] of Object.entries(pk.vecs)) w[name] = new Float32Array(b64bytes(v).buffer);
    return w;
  }

  // ------------------------------------------------------------------ CPU（エージェント）
  // 共通: choose(round, ctx) → 手。ctx = { after, lead }（手番の人から見た値）
  // 見えていない札は見ない（encodeState と determinize だけが見えている情報を使う）

  const pickRandom = (arr, rng) => arr[Math.floor(rng() * arr.length)];

  // でたらめ
  function randomAgent(rng) {
    rng = rng || Math.random;
    return { name: 'でたらめ', choose: r => pickRandom(r.legal(), rng) };
  }

  // 目の前の得点だけ: 取ったあとの役の点が一番高い手 → 取る枚数の多い手。こいこいはせず必ず勝負
  function greedyAgent(rng) {
    rng = rng || Math.random;
    const ab = new Uint8Array(A_BYTES);
    return {
      name: '目の前の得点だけ',
      choose(r) {
        const lg = r.legal();
        if (r.phase === 'koi') return STOP;
        let best = -1e9, cand = [];
        for (const a of lg) {
          encodeAction(r, a, ab);
          let n = 0;
          for (let i = 2; i < 8; i++) { let v = ab[i]; while (v) { n += v & 1; v >>= 1; } }
          const s = ab[9] * 100 + n;
          if (s > best) { best = s; cand = [a]; } else if (s === best) cand.push(a);
        }
        return pickRandom(cand, rng);
      },
    };
  }

  // ネットで手ごとの見込みを出す: [{a, win, pts}]。勝負は表 V で正確に計算する
  function evaluate(net, r, ctx, sb, ab) {
    const p = r.turn, lg = r.legal();
    sb = encodeState(r, p, ctx, sb);
    net.setState(sb);
    const out = [];
    for (const a of lg) {
      if (a === STOP) {
        const d = stopPoints(r, p);
        out.push({ a, win: vAfter(net.V, ctx, d, true), pts: d, exact: true });
        continue;
      }
      const [win, pts] = net.evalAction(encodeAction(r, a, ab));
      out.push({ a, win, pts });
    }
    return out;
  }
  const score = e => e.win + 0.002 * e.pts; // 見込みが同じなら点の多い方

  // ネットの手: temp > 0 なら見込みに応じたゆらぎ（弱いCPU）、eps は学習の探索
  function netAgent(net, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random, temp = opts.temp || 0, eps = opts.eps || 0;
    const sb = new Uint8Array(S_BYTES), ab = new Uint8Array(A_BYTES);
    return {
      name: opts.name || 'ネット',
      choose(r, ctx) {
        const lg = r.legal();
        if (lg.length === 1) return lg[0];
        if (eps && rng() < eps) return pickRandom(lg, rng);
        const ev = evaluate(net, r, ctx, sb, ab);
        if (temp > 0) {
          const m = Math.max(...ev.map(score));
          const w = ev.map(e => Math.exp((score(e) - m) / temp));
          let t = rng() * w.reduce((s, x) => s + x, 0);
          for (let i = 0; i < ev.length; i++) { t -= w[i]; if (t <= 0) return ev[i].a; }
          return ev[ev.length - 1].a;
        }
        let best = ev[0];
        for (const e of ev) if (score(e) > score(best)) best = e;
        return best.a;
      },
    };
  }

  // 見えていない札（相手の手札と山札）を1通りに仮定した局面を作る
  function determinize(r, p, rng) {
    const w = r.clone();
    const o = p ^ 1;
    const seen = new Uint8Array(48);
    for (const c of r.hands[p]) seen[c] = 1;
    for (const c of r.field) seen[c] = 1;
    for (const c of r.caps[0]) seen[c] = 1;
    for (const c of r.caps[1]) seen[c] = 1;
    if (r.pending >= 0) seen[r.pending] = 1;
    const u = [];
    for (let c = 0; c < 48; c++) if (!seen[c]) u.push(c);
    for (let i = u.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = u[i]; u[i] = u[j]; u[j] = t; }
    const k = r.hands[o].length;
    w.hands[o] = u.slice(0, k);
    w.deck = u.slice(k);
    return w;
  }
  // 局面 w を最後まで打つ（両者ともネットの一番の手）。p から見た結果の勝つ見込み
  function rollout(net, w, p, ctxP, sb, ab) {
    const ctxs = [null, null];
    ctxs[p] = ctxP; ctxs[p ^ 1] = { after: ctxP.after, lead: -ctxP.lead };
    let guard = 0;
    while (w.phase !== 'end' && guard++ < 80) {
      const lg = w.legal();
      let a = lg[0];
      if (lg.length > 1) {
        const ev = evaluate(net, w, ctxs[w.turn], sb, ab);
        let best = ev[0];
        for (const e of ev) if (score(e) > score(best)) best = e;
        a = best.a;
      }
      w.step(a);
    }
    const res = w.result;
    const d = res.winner < 0 ? 0 : res.winner === p ? res.points : -res.points;
    return vAfter(net.V, ctxP, d, w.dealer === p);
  }

  // 読み（最強）: 見えていない札を何通りも仮定し、各手を打ってから最後までネットどうしで打つ。平均の勝つ見込みで選ぶ
  //   同じ仮定をすべての手に使う（くらべるときのぶれを減らす）。読みが少ないうちはネットの見込みも混ぜる
  function searchEval(net, r, ctx, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random, p = r.turn;
    const deadline = (opts.timeMs != null ? Date.now() + opts.timeMs : Infinity);
    const maxWorlds = opts.worlds || 1e9;
    const sb = new Uint8Array(S_BYTES), ab = new Uint8Array(A_BYTES);
    const ev = evaluate(net, r, ctx, sb, ab);
    const sum = ev.map(() => 0), sq = ev.map(() => 0);
    let n = 0;
    if (ev.length > 1) {
      while (n < maxWorlds && Date.now() < deadline) {
        const base = determinize(r, p, rng);
        for (let i = 0; i < ev.length; i++) {
          const e = ev[i];
          let v;
          if (e.exact) v = e.win;
          else {
            const w = base.clone();
            w.step(e.a);
            v = rollout(net, w, p, ctx, sb, ab);
          }
          sum[i] += v; sq[i] += v * v;
        }
        n++;
      }
    }
    const prior = opts.prior != null ? opts.prior : 3;
    return ev.map((e, i) => {
      const m = n ? sum[i] / n : e.win;
      const win = e.exact || n + prior === 0 ? e.win : (sum[i] + prior * e.win) / (n + prior);
      return { a: e.a, win, netWin: e.win, pts: e.pts, n, mean: m, sd: n > 1 ? Math.sqrt(Math.max(0, sq[i] / n - m * m)) : 0, exact: !!e.exact };
    });
  }
  // 1手先読み: 見えない札を何通りも仮定し、各手を打って山札をめくり（自分のつづきの判断はネット）、
  //   相手の番になった局面を「相手から見たネットの見込み」で評価する。最後まで打つより、ぶれがずっと小さい
  function lookaheadEval(net, r, ctx, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random, p = r.turn, o = p ^ 1;
    const deadline = (opts.timeMs != null ? Date.now() + opts.timeMs : Infinity);
    const maxWorlds = opts.worlds || 1e9;
    const sb = new Uint8Array(S_BYTES), ab = new Uint8Array(A_BYTES);
    const ctxO = { after: ctx.after, lead: -ctx.lead };
    const ev = evaluate(net, r, ctx, sb, ab);
    // こいこいか勝負か: 勝負は正確な値なので、片寄りのない「最後まで打つ読み」でくらべる（手が2つなので何千通りも読める）
    if (r.phase === 'koi') return searchEval(net, r, ctx, Object.assign({}, opts, { worlds: opts.worlds ? opts.worlds * 8 : undefined }));
    const sum = ev.map(() => 0), sq = ev.map(() => 0);
    let n = 0;
    const best = (x, c) => { const e2 = evaluate(net, x, c, sb, ab); let b = e2[0]; for (const e of e2) if (score(e) > score(b)) b = e; return b; };
    if (ev.length > 1) {
      while (n < maxWorlds && Date.now() < deadline) {
        const base = determinize(r, p, rng);
        for (let i = 0; i < ev.length; i++) {
          const e = ev[i];
          let v;
          if (e.exact) v = e.win;
          else {
            const x = base.clone();
            x.step(e.a);
            let guard = 0;
            while (x.phase !== 'end' && x.turn === p && guard++ < 6) { const lg = x.legal(); x.step(lg.length === 1 ? lg[0] : best(x, ctx).a); }
            if (x.phase === 'end') {
              const res = x.result, d = res.winner < 0 ? 0 : res.winner === p ? res.points : -res.points;
              v = vAfter(net.V, ctx, d, x.dealer === p);
            } else v = 1 - best(x, ctxO).win;
          }
          sum[i] += v; sq[i] += v * v;
        }
        n++;
      }
    }
    const prior = opts.prior != null ? opts.prior : 2;
    return ev.map((e, i) => {
      const m = n ? sum[i] / n : e.win;
      const win = e.exact || n + prior === 0 ? e.win : (sum[i] + prior * e.win) / (n + prior);
      return { a: e.a, win, netWin: e.win, pts: e.pts, n, mean: m, sd: n > 1 ? Math.sqrt(Math.max(0, sq[i] / n - m * m)) : 0, exact: !!e.exact };
    });
  }
  function lookaheadAgent(net, opts) {
    opts = opts || {};
    return {
      name: opts.name || '先読み',
      choose(r, ctx) {
        const lg = r.legal();
        if (lg.length === 1) return lg[0];
        const ev = lookaheadEval(net, r, ctx, opts);
        let best = ev[0];
        for (const e of ev) if (score(e) > score(best)) best = e;
        return best.a;
      },
    };
  }
  function searchAgent(net, opts) {
    opts = opts || {};
    return {
      name: opts.name || '読み',
      choose(r, ctx) {
        const lg = r.legal();
        if (lg.length === 1) return lg[0];
        const ev = searchEval(net, r, ctx, opts);
        let best = ev[0];
        for (const e of ev) if (score(e) > score(best)) best = e;
        return best.a;
      },
    };
  }

  const api = {
    S_BYTES, A_BYTES, DS, DA, NSETS, NS, SCAL, LEAD_IDX, LMAX, VR, VL,
    encodeState, encodeAction, stateFeatures, actionFeatures, actionSparse, stopPoints,
    buildV, defaultDist, vAt, vAfter, Net, randomWeights, unpackWeights, b64bytes,
    randomAgent, greedyAgent, netAgent, searchAgent, searchEval, lookaheadEval, lookaheadAgent, evaluate, determinize, rollout, score,
  };
  root.KoikoiAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
