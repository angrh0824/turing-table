/* 対局・検討用の木探索（PUCT。AlphaZero / KataGo と同じ形）。ブラウザの Web Worker の中で動かす
 *
 *   const s = new G.Search(net, { su: 0.05 });
 *   s.setRoot(board);            // 盤（Board）を渡す。前の木が使えれば使い回す
 *   s.think({ visits: 400, timeMs: 3000, onInfo })   // 1回ずつの評価を積み重ねる（少しずつ進める step も使える）
 *   s.result()                   // { move, visits, value, score, cands: [{move, n, q, v, s, p, pv}], own }
 *
 * 値は「その局面の手番の側から見た」勝ち確率−負け確率。目数もその側から見た差
 * 子の統計は「その手を打った側（親の手番）から見た値」で持つので、親はそのまま大きい方を選べばよい
 */
function GoSearch(G) {
  'use strict';
  const C_PUCT = 1.1, FPU = 0.25;

  class Node {
    constructor(move, prior) {
      this.move = move; this.p = prior;
      this.n = 0; this.w = 0; this.vs = 0; this.ss = 0; // 訪問・効用の合計・価値の合計・目数の合計（打った側から見て）
      this.moves = null; this.prior = null; this.kids = null;
      this.term = null; // 終局なら打った側から見た目数
    }
  }

  class Search {
    constructor(net, opts = {}) {
      this.net = net;
      this.su = opts.su ?? 0.05;
      this.rand = opts.rand || Math.random;
      this.maxPly = opts.maxPly || 0;
      this.root = null; this.board = null;
      this.own = null; this.ownN = 0;
    }
    utility(v, s, n) { return v + this.su * Math.tanh(s / (n <= 9 ? 8 : n <= 13 ? 12 : 18)); }

    // 盤を渡す。前の根から1〜2手進んだ局面なら、その部分の木を使い回す
    setRoot(board) {
      const b = board.clone();
      let reuse = null;
      if (this.root && this.board && this.board.n === b.n && this.board.komi === b.komi) {
        const old = this.board.moves, cur = b.moves;
        if (cur.length >= old.length && cur.length - old.length <= 2 && old.every((m, i) => m === cur[i]) && this.board.key() === this._keyAt(b, old.length)) {
          let nd = this.root;
          for (let i = old.length; i < cur.length && nd; i++) nd = nd.kids ? nd.kids[nd.moves.indexOf(cur[i])] || null : null;
          if (nd && nd.n > 0) reuse = nd;
        }
      }
      this.board = b;
      this.root = reuse || new Node(-1, 1);
      if (!reuse) { this.own = new Float32Array(b.n * b.n); this.ownN = 0; }
      else { this.own = new Float32Array(b.n * b.n); this.ownN = 0; } // 地の見込みは根からの評価だけで作り直す
      this.maxPly = this.maxPly || Math.round(b.n * b.n * 3);
      this.passFloor();
    }
    // 根で相手が直前にパスしていたら、パス（＝終局）も必ず読む（ネットがパスを低く見ていても、終局の値を確かめる）
    passFloor() {
      const r = this.root, b = this.board;
      if (!r.prior || !b.moves.length || b.moves[b.moves.length - 1] !== G.PASS) return;
      const k = r.moves.length - 1;
      if (r.moves[k] !== G.PASS || r.prior[k] >= 0.15) return;
      const keep = 0.85 / Math.max(1e-9, 1 - r.prior[k]);
      for (let i = 0; i < k; i++) r.prior[i] *= keep;
      r.prior[k] = 0.15;
    }
    _keyAt(b, k) { const c = b.clone(); while (c.moves.length > k) c.undo(); return c.key(); }

    // 葉を1つ評価して木に足す（1回のシミュレーション）
    step() {
      const b = this.board, path = [this.root];
      let node = this.root, depth = 0;
      while (node.kids && node.term === null) {
        const a = this.select(node);
        node = node.kids[a] || (node.kids[a] = new Node(node.moves[a], node.prior[a]));
        b.play(node.move); depth++;
        path.push(node);
        if (node.n === 0) break;
      }
      let u, v, s;
      if (node.term === null && (b.passes >= 2 || b.ply >= this.maxPly)) {
        // 終局（パスが2回）: 盤上の石と地をそのまま数える（死に石の判定は終局後に人と確かめる）
        const sc = b.score().score;
        node.term = b.toPlay === G.BLACK ? -sc : sc; // 打った側から見た目数
      }
      if (node.term !== null) {
        s = node.term; v = Math.sign(s); u = this.utility(v, s, b.n);
        // 打った側から見た値なので、そのまま
      } else {
        const out = this.net.run(b, Math.floor(this.rand() * 8));
        node.moves = out.moves; node.prior = out.policy; node.kids = new Array(out.moves.length).fill(null);
        if (node === this.root) this.passFloor();
        // ネットの値は手番の側（= 次に打つ側）から見たもの。打った側から見るには符号を変える
        v = -out.value; s = -out.score; u = this.utility(v, s, b.n);
        // 地の見込み（黒から見て）を足し込む
        const sign = b.toPlay === G.BLACK ? 1 : -1, own = this.own, o = out.own;
        if (own && own.length === o.length) { for (let i = 0; i < o.length; i++) own[i] += sign * o[i]; this.ownN++; }
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const nd = path[i];
        nd.n++; nd.w += u; nd.vs += v; nd.ss += s;
        u = -u; v = -v; s = -s;
      }
      for (; depth > 0; depth--) b.undo();
      return 1;
    }

    // PUCT: Q + c × P × √N / (1 + n)。まだ読んでいない手の Q は親の値から少し下げたもの（FPU）
    select(node) {
      const k = node.moves.length, kids = node.kids, pr = node.prior;
      const sq = Math.sqrt(Math.max(1, node.n));
      let seen = 0;
      for (let a = 0; a < k; a++) if (kids[a] && kids[a].n) seen += pr[a];
      const parentQ = node.n ? -node.w / node.n : 0; // node の統計は親から見たものなので、node の手番から見るには符号を変える
      const fpu = parentQ - FPU * Math.sqrt(seen);
      let best = 0, bs = -Infinity;
      for (let a = 0; a < k; a++) {
        const ch = kids[a];
        const q = ch && ch.n ? ch.w / ch.n : fpu;
        const sc = q + C_PUCT * pr[a] * sq / (1 + (ch ? ch.n : 0));
        if (sc > bs) { bs = sc; best = a; }
      }
      return best;
    }

    // 決めた回数か時間まで読む（同期。Worker の中で少しずつ呼ぶときは run を使う）
    think({ visits = 200, timeMs = 0 } = {}) {
      const t0 = Date.now();
      while (this.root.n < visits && !(timeMs && Date.now() - t0 > timeMs)) { this.step(); if (this.decided(visits)) break; }
      return this.result();
    }
    // これ以上読んでも一番の手が変わらないなら true
    decided(visits) {
      const r = this.root;
      if (!r.kids || r.n < 16) return false;
      let a = 0, b = 0;
      for (const ch of r.kids) if (ch) { if (ch.n > a) { b = a; a = ch.n; } else if (ch.n > b) b = ch.n; }
      return a - b > visits - r.n;
    }

    result(maxCands = 8) {
      const r = this.root, b = this.board;
      const cands = [];
      if (r.kids) {
        for (let i = 0; i < r.kids.length; i++) {
          const ch = r.kids[i];
          if (!ch || !ch.n) continue;
          cands.push({ move: ch.move, n: ch.n, q: ch.w / ch.n, v: ch.vs / ch.n, s: ch.ss / ch.n, p: r.prior[i], pv: this.pv(ch) });
        }
        cands.sort((x, y) => y.n - x.n || y.q - x.q);
      }
      const best = cands[0];
      const value = r.n ? -r.vs / r.n : 0, score = r.n ? -r.ss / r.n : 0; // 根の手番から見た値
      let own = null;
      if (this.ownN) { own = new Float32Array(this.own.length); for (let i = 0; i < own.length; i++) own[i] = this.own[i] / this.ownN; }
      return { move: best ? best.move : G.PASS, visits: r.n, value: best ? best.v : value, score: best ? best.s : score, rootValue: value, rootScore: score,
        cands: cands.slice(0, maxCands), allCands: cands, own, toPlay: b.toPlay, ply: b.ply, prior: r.prior ? Array.from(r.prior) : null, moves: r.moves ? Array.from(r.moves) : null };
    }
    pv(node, max = 10) {
      const out = [node.move];
      let nd = node;
      while (nd.kids && out.length < max) {
        let bi = -1, bn = 0;
        for (let i = 0; i < nd.kids.length; i++) { const c = nd.kids[i]; if (c && c.n > bn) { bn = c.n; bi = i; } }
        if (bi < 0) break;
        nd = nd.kids[bi];
        out.push(nd.move);
      }
      return out;
    }
  }

  // 方策だけで打つ（いちばん弱い CPU）。温度 temp で散らし、確率が minP より低い手は選ばない
  function policyMove(net, board, temp, rand, minP = 0.01) {
    const out = net.run(board, Math.floor(rand() * 8));
    const k = out.moves.length;
    let best = 0;
    for (let i = 1; i < k; i++) if (out.policy[i] > out.policy[best]) best = i;
    const w = new Float64Array(k);
    let s = 0;
    // パスは、それが一番の手か、相手が直前にパスしたときだけ（弱い段でも、序盤に気まぐれでパスして終局させない）
    const lastPass = board.moves.length && board.moves[board.moves.length - 1] === G.PASS;
    for (let i = 0; i < k; i++) {
      const p = out.policy[i], pass = out.moves[i] === G.PASS;
      w[i] = (p >= minP && (!pass || lastPass)) || i === best ? Math.pow(p, 1 / temp) : 0;
      s += w[i];
    }
    let r = rand() * s, pick = best;
    for (let i = 0; i < k; i++) { r -= w[i]; if (r <= 0) { pick = i; break; } }
    return { move: out.moves[pick], value: out.value, score: out.score, own: out.own, policy: out.policy, moves: out.moves };
  }

  G.Search = Search;
  G.policyMove = policyMove;
  return G;
}

if (typeof module !== 'undefined' && module.exports) module.exports = GoSearch;
