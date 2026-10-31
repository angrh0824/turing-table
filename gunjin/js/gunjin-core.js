/* 軍人将棋のルール: 盤（横6×縦8・突入口2つ・司令部）、駒（1人23枚）、動き、勝ち負けの判定、公開の記録
 *   ブラウザでは window.GunjinCore、Node では require('./gunjin-core.js')
 *
 * 盤のマス（cell）は c = y*6 + x（x: 0..5 左から、y: 0..7 上から。先手の陣地が下の y=4..7）
 * 司令部は奥の列の中央2マスを1つの場所として使う（先手 44+45 → 44、後手 2+3 → 2）。場所（node）は全部で46
 * 駒の番号 id: 先手 0..22・後手 23..45。id % 23 は「最初に置いた場所」（陣地の中の順番 k）
 * 記録（log）の1手は {f, t, r}: f から t へ。r = 0 戦いなし・1 攻めた側の勝ち・2 守った側の勝ち・3 相打ち
 *   公開されるのはこの記録と勝敗だけ。駒の正体は持ち主しか知らない（審判はコンピューター）
 */
(function (root) {
  'use strict';
  const W = 6, H = 8, NC = W * H, NP = 23, NT = 16;
  const BLACK = 0, WHITE = 1;
  // 駒の種類（0..8 は階級。数が小さいほど偉い）
  const TAISHO = 0, CHUJO = 1, SHOSHO = 2, TAISA = 3, CHUSA = 4, SHOSA = 5, TAII = 6, CHUI = 7, SHOI = 8;
  const HIKO = 9, TANK = 10, KIHEI = 11, KOHEI = 12, SPY = 13, JIRAI = 14, GUNKI = 15;
  const NAMES = ['大将', '中将', '少将', '大佐', '中佐', '少佐', '大尉', '中尉', '少尉', '飛行機', 'タンク', '騎兵', '工兵', 'スパイ', '地雷', '軍旗'];
  const COUNTS = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 1];
  const ALL = (1 << NT) - 1;
  const MOVABLE = ALL & ~(1 << JIRAI) & ~(1 << GUNKI);
  const HQ_OK = 0x3f;          // 司令部を占領できる駒（少佐以上）
  const QUIET_MAX = 100;       // 戦いのないまま 100手（各50手）続いたら引き分け
  const MAX_PLY = 500;         // 500手で引き分け
  const ENTRY_X = [1, 4];      // 突入口の列（左から2列目と5列目）
  const HQ = [44, 2];          // 司令部（先手・後手）
  const FWD = [0, 1];          // 前の向き（0 上・1 下）

  const NODE = new Int8Array(NC);
  for (let c = 0; c < NC; c++) NODE[c] = c;
  NODE[45] = 44; NODE[3] = 2;
  const NODES = [];
  for (let c = 0; c < NC; c++) if (NODE[c] === c) NODES.push(c);
  const NIDX = new Int8Array(NC).fill(-1);
  NODES.forEach((n, i) => { NIDX[n] = i; });
  NIDX[45] = NIDX[44]; NIDX[3] = NIDX[2];
  const ROT = new Int8Array(NC);  // 盤を180度回したときの場所
  for (let c = 0; c < NC; c++) ROT[c] = NODE[NC - 1 - c];
  const X = c => c % W, Y = c => (c / W) | 0;
  const campOf = n => (Y(n) >= 4 ? BLACK : WHITE);
  const owner = id => (id < NP ? BLACK : WHITE);

  // 陣地の中の順番 k（持ち主から見て、前の列の左から。最後が奥の列）
  const CAMP = [[], []];
  for (let y = 4; y < H; y++) for (let x = 0; x < W; x++) { const c = y * W + x; if (NODE[c] === c) CAMP[0].push(c); }
  CAMP[1] = CAMP[0].map(n => ROT[n]);
  const KOF = [new Int8Array(NC).fill(-1), new Int8Array(NC).fill(-1)];
  for (let k = 0; k < NP; k++) { KOF[0][CAMP[0][k]] = k; KOF[1][CAMP[1][k]] = k; }
  const ENTRY_K = [1, 4];             // 突入口のマス（地雷・軍旗は置けない）
  const BACK_K = [18, 19, 20, 21, 22]; // 奥の列（軍旗は置けない）
  const HQ_K = 20;

  // 向き d（0 上・1 下・2 左・3 右）に進む道（ray）。司令部は2マスを1つとして数える
  // wall: 突入口でないところで陣地の境を越える手前までの数（飛行機以外はそこで止まる）
  const DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0];
  const RAYS = [];
  for (const n of NODES) {
    const cells = n === 44 ? [44, 45] : n === 2 ? [2, 3] : [n];
    const list = [], seen = new Set();
    for (let d = 0; d < 4; d++) for (const c0 of cells) {
      let x = X(c0), y = Y(c0), wall = -1;
      const nodes = [];
      for (;;) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) break;
        const cross = d < 2 && ((y === 3 && ny === 4) || (y === 4 && ny === 3)) && !ENTRY_X.includes(x);
        const nn = NODE[ny * W + nx];
        x = nx; y = ny;
        if (nn === n || (nodes.length && nodes[nodes.length - 1] === nn)) continue;
        if (cross && wall < 0) wall = nodes.length;
        nodes.push(nn);
      }
      if (!nodes.length) continue;
      const key = d + ':' + nodes.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ d, n: nodes, wall: wall < 0 ? nodes.length : wall });
    }
    RAYS[n] = list;
  }
  const ADJ = new Uint8Array(NC * NC); // 隣り合う場所（道の最初の1マス）
  for (const n of NODES) for (const r of RAYS[n]) ADJ[n * NC + r.n[0]] = 1;

  // ------------------------------------------------------------------ 勝ち負けの表
  // fight(x, y): x が y と戦ったときの x から見た結果（1 勝ち・-1 負け・0 相打ち）。どちらから仕掛けても同じ
  const BEATS = [];
  {
    const set = (...a) => a.reduce((m, t) => m | (1 << t), 0);
    const lower = r => { let m = 0; for (let t = r + 1; t <= SHOI; t++) m |= 1 << t; return m; };
    BEATS[TAISHO] = lower(TAISHO) | set(HIKO, TANK, KIHEI, KOHEI);
    BEATS[CHUJO] = lower(CHUJO) | set(HIKO, TANK, KIHEI, KOHEI, SPY);
    BEATS[SHOSHO] = lower(SHOSHO) | set(HIKO, TANK, KIHEI, KOHEI, SPY);
    for (let r = TAISA; r <= SHOI; r++) BEATS[r] = lower(r) | set(KIHEI, KOHEI, SPY);
    BEATS[HIKO] = lower(SHOSHO) | set(TANK, KIHEI, KOHEI, SPY, JIRAI);
    BEATS[TANK] = lower(SHOSHO) | set(KIHEI, SPY);
    BEATS[KIHEI] = set(SPY, KOHEI);
    BEATS[KOHEI] = set(JIRAI, SPY, TANK);
    BEATS[SPY] = set(TAISHO);
    BEATS[JIRAI] = 0;
    BEATS[GUNKI] = 0;
  }
  function fight(x, y) {
    if (x === y) return 0;
    if (y === JIRAI) return (x === HIKO || x === KOHEI) ? 1 : 0;
    if (x === JIRAI) return (y === HIKO || y === KOHEI) ? -1 : 0;
    if (BEATS[x] & (1 << y)) return 1;
    if (BEATS[y] & (1 << x)) return -1;
    return 0;
  }
  const FIGHT = new Int8Array(NT * NT);
  for (let a = 0; a < NT; a++) for (let b = 0; b < NT; b++) FIGHT[a * NT + b] = fight(a, b);
  // 攻めた駒の種類 a、守る駒の種類 d（軍旗なら sup = 真後ろの味方の駒の種類、いなければ -1）→ 記録の r（1..3）
  function judge(a, d, sup) {
    let o;
    if (d === GUNKI) o = sup < 0 ? 1 : FIGHT[a * NT + sup];
    else o = FIGHT[a * NT + d];
    return o > 0 ? 1 : o < 0 ? 2 : 3;
  }

  // ------------------------------------------------------------------ 配置
  function validSetup(s) {
    if (!s || s.length !== NP) return false;
    const cnt = new Array(NT).fill(0);
    for (let k = 0; k < NP; k++) {
      const t = s[k];
      if (!(t >= 0 && t < NT)) return false;
      cnt[t]++;
      if (!placeOK(t, k)) return false;
    }
    for (let t = 0; t < NT; t++) if (cnt[t] !== COUNTS[t]) return false;
    return true;
  }
  function placeOK(t, k) {
    if ((t === JIRAI || t === GUNKI) && ENTRY_K.includes(k)) return false;
    if (t === GUNKI && k >= 18) return false;
    return true;
  }
  const PIECES = []; // 23枚の種類（数の分だけ並べたもの）
  for (let t = 0; t < NT; t++) for (let i = 0; i < COUNTS[t]; i++) PIECES.push(t);

  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function randomSetup(rng) {
    rng = rng || Math.random;
    for (;;) {
      const a = PIECES.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
      if (validSetup(a)) return a;
    }
  }

  // ------------------------------------------------------------------ 局面
  const MOVED = 1, WON = 2, FAR = 4;  // 動いた・戦って勝ち残った・2マス以上動いた
  class Pos {
    constructor() {
      this.sq = new Int8Array(NC).fill(-1);  // 場所 → 駒の番号
      this.type = new Int8Array(2 * NP).fill(-1); // 駒の番号 → 種類（知らない駒は -1）
      this.at = new Int8Array(2 * NP).fill(-1);   // 駒の番号 → 場所（取られたら -1）
      this.fl = new Uint8Array(2 * NP);
      this.stm = BLACK; this.ply = 0; this.quiet = 0;
    }
    // 配置から（知らない側は null → 種類は -1 のまま）
    static start(sb, sw) {
      const p = new Pos();
      const S = [sb, sw];
      for (let c = 0; c < 2; c++) for (let k = 0; k < NP; k++) {
        const id = c * NP + k, n = CAMP[c][k];
        p.sq[n] = id; p.at[id] = n;
        p.type[id] = S[c] ? S[c][k] : -1;
      }
      return p;
    }
    clone() {
      const p = new Pos();
      p.sq.set(this.sq); p.type.set(this.type); p.at.set(this.at); p.fl.set(this.fl);
      p.stm = this.stm; p.ply = this.ply; p.quiet = this.quiet;
      return p;
    }
    // 軍旗の真後ろの味方（いなければ -1）
    support(id) {
      const c = owner(id), n = this.at[id];
      const y = Y(n) + (c === BLACK ? 1 : -1);
      if (y < 0 || y >= H) return -1;
      const o = this.sq[NODE[y * W + X(n)]];
      return o >= 0 && owner(o) === c ? o : -1;
    }
    // 種類がわかっている局面で、f→t の戦いの結果（r）
    judgeAt(f, t) {
      const a = this.sq[f], d = this.sq[t];
      if (d < 0) return 0;
      const ta = this.type[a], td = this.type[d];
      if (ta < 0 || td < 0) return -1;
      if (td === GUNKI) { const s = this.support(d); return judge(ta, td, s < 0 ? -1 : this.type[s]); }
      return judge(ta, td, -1);
    }
    // 記録の1手を反映する（結果 r は審判が決めたもの）
    apply(f, t, r) {
      const a = this.sq[f], d = this.sq[t];
      this.fl[a] |= MOVED | (ADJ[f * NC + t] ? 0 : FAR);
      this.sq[f] = -1;
      if (r === 0 || r === 1) {
        if (r === 1) { this.at[d] = -1; this.fl[a] |= WON; }
        this.sq[t] = a; this.at[a] = t;
      } else if (r === 2) {
        this.at[a] = -1; this.fl[d] |= WON;
      } else {
        this.at[a] = -1; this.at[d] = -1; this.sq[t] = -1;
      }
      this.quiet = r ? 0 : this.quiet + 1;
      this.ply++;
      this.stm ^= 1;
    }
    // 種類がわかっている局面で指す（審判つき）。r を返す
    play(m) {
      const f = m >> 6, t = m & 63;
      const r = this.sq[t] >= 0 ? this.judgeAt(f, t) : 0;
      this.apply(f, t, r);
      return r;
    }
    // 探索用: 指して、戻すための情報を返す / 戻す
    make(m) {
      const f = m >> 6, t = m & 63, a = this.sq[f], d = this.sq[t];
      const u = (a + 1) | ((d + 1) << 6) | (this.fl[a] << 12) | ((d >= 0 ? this.fl[d] : 0) << 16) | (this.quiet << 20);
      this.apply(f, t, d >= 0 ? this.judgeAt(f, t) : 0);
      return u;
    }
    unmake(m, u) {
      const f = m >> 6, t = m & 63, a = (u & 63) - 1, d = ((u >> 6) & 63) - 1;
      this.sq[f] = a; this.at[a] = f; this.fl[a] = (u >> 12) & 15;
      if (d >= 0) { this.sq[t] = d; this.at[d] = t; this.fl[d] = (u >> 16) & 15; } else this.sq[t] = -1;
      this.quiet = u >>> 20; this.ply--; this.stm ^= 1;
    }
    // 指した直後の勝敗（種類がわかっている局面）: {winner, reason} か null。
    // checkMoves: 次の番の人に指せる手がなければ負け。false なら「動ける駒が残っているか」だけ見る（探索の末端用）
    end(checkMoves) {
      const mover = this.stm ^ 1;
      const hq = HQ[mover ^ 1], o = this.sq[hq];
      if (o >= 0 && owner(o) === mover && this.type[o] >= 0 && this.type[o] <= SHOSA) return { winner: mover, reason: 'hq' };
      if (checkMoves !== false) { if (!this.hasMove(this.stm)) return { winner: mover, reason: 'nomove' }; }
      else {
        let any = false;
        for (let k = 0, b = this.stm * NP; k < NP; k++) { const tt = this.type[b + k]; if (this.at[b + k] >= 0 && tt !== JIRAI && tt !== GUNKI) { any = true; break; } }
        if (!any) return { winner: mover, reason: 'nomove' };
      }
      if (this.quiet >= QUIET_MAX) return { winner: -1, reason: 'quiet' };
      if (this.ply >= MAX_PLY) return { winner: -1, reason: 'maxply' };
      return null;
    }
    hasMove(c) { const out = []; this.gen(c, out, true); return out.length > 0; }
    // 合法手（自分の駒の種類がわかっていること）。手は (f << 6) | t
    gen(c, out, one) {
      out = out || [];
      for (let k = 0; k < NP; k++) {
        const id = c * NP + k, n = this.at[id];
        if (n < 0) continue;
        this.genPiece(n, this.type[id], c, out);
        if (one && out.length) return out;
      }
      return out;
    }
    genPiece(n, t, c, out) {
      if (t < 0 || t === JIRAI || t === GUNKI) return out;
      const sq = this.sq;
      const free = x => { const o = sq[x]; return o < 0 || (o < NP ? BLACK : WHITE) !== c; };
      for (const ray of RAYS[n]) {
        const ns = ray.n;
        if (t === KOHEI) {
          for (let i = 0; i < ray.wall; i++) {
            const x = ns[i], o = sq[x];
            if (o < 0) out.push((n << 6) | x);
            else { if ((o < NP ? BLACK : WHITE) !== c) out.push((n << 6) | x); break; }
          }
        } else if (t === HIKO && ray.d < 2) {
          for (let i = 0; i < ns.length; i++) if (free(ns[i])) out.push((n << 6) | ns[i]);
        } else {
          if (ray.wall < 1) continue;
          const x = ns[0];
          if (free(x)) out.push((n << 6) | x);
          if ((t === TANK || t === KIHEI) && ray.d === FWD[c] && sq[x] < 0 && ray.wall > 1 && free(ns[1])) out.push((n << 6) | ns[1]);
        }
      }
      return out;
    }
    // f→t の動きができる駒の種類（盤の駒の並びだけで判断。正体の推定に使う）
    typesThatCan(f, t) {
      const a = this.sq[f];
      if (a < 0) return 0;
      const c = owner(a);
      let mask = 0;
      const test = (ty, bits) => { const o = []; this.genPiece(f, ty, c, o); if (o.includes((f << 6) | t)) mask |= bits; };
      test(TAISHO, (1 << 9) - 1 | (1 << SPY));
      test(TANK, (1 << TANK) | (1 << KIHEI));
      test(KOHEI, 1 << KOHEI);
      test(HIKO, 1 << HIKO);
      return mask;
    }
    alive(c) { let n = 0; for (let k = 0; k < NP; k++) if (this.at[c * NP + k] >= 0) n++; return n; }
  }

  // 記録から局面を作る（setups の知らない側は null）。upto 手目まで
  function replay(setups, log, upto) {
    const p = Pos.start(setups[0], setups[1]);
    const n = upto == null ? log.length : Math.min(upto, log.length);
    for (let i = 0; i < n; i++) p.apply(log[i].f, log[i].t, log[i].r);
    return p;
  }

  // ------------------------------------------------------------------ 対局（審判つき）
  // 両方の配置を知っている審判の役。オンラインでは使わない（それぞれの端末は自分の配置しか知らない）
  class Game {
    constructor(sb, sw) {
      this.setups = [sb.slice(), sw.slice()];
      this.pos = Pos.start(sb, sw);
      this.log = [];
      this.result = null;
    }
    legal() { return this.result ? [] : this.pos.gen(this.pos.stm); }
    play(m) {
      const f = m >> 6, t = m & 63;
      const r = this.pos.play(m);
      const ev = { f, t, r };
      this.log.push(ev);
      this.result = this.pos.end(true);
      return ev;
    }
    resign(c) { this.result = { winner: c ^ 1, reason: 'resign' }; }
    // その人に見せてよいもの（自分の配置と公開の記録）。AI にはこれだけを渡す
    viewFor(c) { return view(c, this.setups[c], this.log); }
  }
  // 公開の記録だけを取り出す（f・t・r 以外は捨てる）
  function publicLog(log) { return log.map(e => ({ f: e.f | 0, t: e.t | 0, r: e.r | 0 })); }
  function view(c, setup, log) { return { color: c, setup: Array.from(setup), log: publicLog(log) }; }

  // 動きの種類（正体の推定に使う）: 0 攻め・1 前へ・2 横へ・3 後ろへ
  function actionClass(pos, f, t) {
    if (pos.sq[t] >= 0) return 0;
    const c = owner(pos.sq[f]), dy = Y(t) - Y(f);
    if (!dy) return 2;
    return (c === BLACK ? dy < 0 : dy > 0) ? 1 : 3;
  }

  // ------------------------------------------------------------------ 表示用
  const COLS = 'ABCDEF';
  // 先手から見た座標（列 A–F、行 1–8 は先手の奥が1）。司令部は「司令部」
  function sqName(n) {
    if (n === 44) return '▲司令部';
    if (n === 2) return '△司令部';
    return COLS[X(n)] + (H - Y(n));
  }

  const API = {
    W, H, NC, NP, NT, BLACK, WHITE, NAMES, COUNTS, PIECES, ALL, MOVABLE, HQ_OK, QUIET_MAX, MAX_PLY, ENTRY_X, HQ, FWD,
    TAISHO, CHUJO, SHOSHO, TAISA, CHUSA, SHOSA, TAII, CHUI, SHOI, HIKO, TANK, KIHEI, KOHEI, SPY, JIRAI, GUNKI,
    NODE, NODES, NIDX, ROT, CAMP, KOF, ENTRY_K, BACK_K, HQ_K, RAYS, X, Y, campOf, owner,
    BEATS, FIGHT, fight, judge, validSetup, placeOK, randomSetup, makeRng,
    MOVED, WON, FAR, Pos, Game, replay, publicLog, view, sqName, actionClass,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.GunjinCore = API;
})(typeof self !== 'undefined' ? self : this);
