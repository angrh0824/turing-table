/* CPU と AI補助の読み（Web Worker）。画面を止めないように、読みはすべてここで行う
 *   {type:'moves', id, me, opp, d1, d2, ply, ctx, noise, top, all}  → 合法手を良い順に（ctx は点の数え方を決める対局の状態）
 *   {type:'evalMoves', id, me, opp, d1, d2, keys, ply, ctx}       → 指定した手だけを深く読む（最強で手分けするとき）
 *   {type:'cube', id, me, opp, ply, ctx}                          → 振る前の局面の確率とキューブの判断
 */
'use strict';
importScripts('bg-core.js', 'bg-net.js', 'bg-ai.js', 'weights.js');
let E = null;
function engine() {
  if (E) return E;
  const W = self.BG_WEIGHTS;
  if (W.param) Object.assign(BGAI.PARAM, W.param);
  E = new BGAI.Engine({ H: W.H, w: BGNet.fromB64(W.w) });
  return E;
}
const pack = c => ({ hops: c.m.hops, key: c.m.key, p: c.p ? Array.from(c.p) : null, v: c.v, ply: c.ply });
self.onmessage = e => {
  const j = e.data, E = engine();
  const me = Int8Array.from(j.me), opp = Int8Array.from(j.opp);
  E.nodes = 0;
  const t0 = Date.now();
  try {
    if (j.type === 'moves') {
      const metric = BGAI.metricFor(j.ctx, j.ctx.turn);
      const list = E.rankMoves(me, opp, j.d1, j.d2, { ply: j.ply, metric, noise: j.noise, all: j.all, prune1: j.prune1, prune2: j.prune2 });
      self.postMessage({ id: j.id, type: 'moves', list: list.slice(0, j.top || 10).map(pack), n: list.length, nodes: E.nodes, ms: Date.now() - t0 });
    } else if (j.type === 'evalMoves') {
      const metric = BGAI.metricFor(j.ctx, j.ctx.turn);
      const L = BG.legalMoves(me, opp, j.d1, j.d2), out = [];
      for (const k of j.keys) {
        const m = L.find(x => x.key === k);
        if (!m) continue;
        const p = E.after(m, j.ply);
        out.push({ hops: m.hops, key: m.key, p: Array.from(p), v: metric(p), ply: j.ply });
      }
      self.postMessage({ id: j.id, type: 'evalMoves', list: out, nodes: E.nodes, ms: Date.now() - t0 });
    } else if (j.type === 'cube') {
      const p = E.evalPos(me, opp, j.ply);
      const dec = BGAI.cubeDecision(j.ctx, p);
      self.postMessage({ id: j.id, type: 'cube', p: Array.from(p), dec, nodes: E.nodes, ms: Date.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ id: j.id, type: 'error', error: String(err && err.stack || err) });
  }
};
