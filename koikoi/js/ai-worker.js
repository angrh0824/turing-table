/* CPU の思考（Web Worker）。見えていない札は -1 にした局面を受け取る
 *   { id, round: Round を複製したもの, ctx: {after, lead}, search: false / true（最後まで打つ読み）/ 'look'（1手先読み）, timeMs, seed }
 *   → { id, list: [{a, win, pts, n, mean, netWin, exact}] }
 */
'use strict';
importScripts('koikoi-core.js', 'nn-simd.js', 'koikoi-ai.js');
try { importScripts('weights.js'); } catch (e) { /* まだ学習したネットがない */ }
let net = null;
function getNet() {
  if (!net) {
    const W = self.KOIKOI_WEIGHTS ? KoikoiAI.unpackWeights(self.KOIKOI_WEIGHTS) : KoikoiAI.randomWeights(256, 128, 64, KoikoiCore.makeRng(1));
    net = new KoikoiAI.Net(W);
  }
  return net;
}
function rebuild(o) {
  const r = Object.assign(Object.create(KoikoiCore.Round.prototype), o);
  r.has = [Uint8Array.from(o.has[0]), Uint8Array.from(o.has[1])];
  return r;
}
self.onmessage = e => {
  const j = e.data;
  const r = rebuild(j.round);
  let list;
  if (j.search === 'look') list = KoikoiAI.lookaheadEval(getNet(), r, j.ctx, { timeMs: j.timeMs, rng: KoikoiCore.makeRng(j.seed), prior: 0 });
  else if (j.search) list = KoikoiAI.searchEval(getNet(), r, j.ctx, { timeMs: j.timeMs, rng: KoikoiCore.makeRng(j.seed), prior: 0 });
  else list = KoikoiAI.evaluate(getNet(), r, j.ctx);
  self.postMessage({ id: j.id, list, gen: getNet().gen });
};
