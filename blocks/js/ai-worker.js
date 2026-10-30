/* CPU の思考の Web Worker。'think' で局面（ルールと手の記録）を受け取り、読み筋の途中経過（info）と結果（done）を返す
 *   { type: 'think', id, mode, moves, kind: 'search'|'policy'|'big', timeMs, maxSims, seed, noise }
 *   { type: 'stop' }  … 読みをやめる（読みは細かく区切って進めるので、新しい依頼や stop はすぐ届く）
 */
/* global importScripts, BlocksCore, BlocksNN, BlocksSearch, BLOCKS_WEIGHTS, BLOCKS_WASM_B64 */
importScripts('blocks-core.js', 'blocks-nn.js', 'blocks-wasm.js', 'blocks-search.js');
try { importScripts('weights.js'); } catch (e) { /* ネットがなければ自作の基準で打つ */ }
let net = null, cur = 0;
function getNet() {
  if (!net && typeof BLOCKS_WEIGHTS !== 'undefined') {
    try { net = new BlocksNN.Net(BLOCKS_WEIGHTS, BLOCKS_WASM_B64); } catch (e) { net = null; }
  }
  return net;
}
self.onmessage = e => {
  const j = e.data;
  if (!j) return;
  if (j.type === 'stop') { cur = 0; return; }
  if (j.type !== 'think') return;
  cur = j.id;
  let pos;
  try { pos = BlocksCore.Position.fromMoves(j.mode, j.moves); } catch (err) { self.postMessage({ id: j.id, type: 'done', result: null, error: String(err) }); return; }
  const nn = getNet();
  const rand = BlocksSearch.mulberry(j.seed || 1);
  if (!nn || j.kind === 'big') { self.postMessage({ id: j.id, type: 'done', result: { move: BlocksSearch.bigMove(pos, rand), sims: 0 } }); return; }
  if (j.kind === 'policy') { self.postMessage({ id: j.id, type: 'done', result: { move: BlocksSearch.policyMove(nn, pos, rand), sims: 0 } }); return; }
  const s = new BlocksSearch.Search(nn, { seed: j.seed, noise: j.noise || 0 });
  if (!s.begin(pos)) { self.postMessage({ id: j.id, type: 'done', result: null }); return; }
  const end = s.t0 + (j.timeMs || 1000), maxSims = j.maxSims || 1e9;
  let lastInfo = Date.now();
  const slice = () => {
    if (cur !== j.id) return; // 新しい依頼が来たか、止められた
    const fin = s.step(Math.min(end, Date.now() + 40), maxSims);
    const now = Date.now();
    if (fin || now >= end) { cur = 0; self.postMessage({ id: j.id, type: 'done', result: s.summary(s.sims, now - s.t0) }); return; }
    if (now - lastInfo > 250) { lastInfo = now; self.postMessage({ id: j.id, type: 'info', info: s.summary(s.sims, now - s.t0) }); }
    setTimeout(slice, 0);
  };
  slice();
};
