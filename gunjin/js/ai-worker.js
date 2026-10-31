/* CPU と AI補助の計算（Web Worker）
 * 受け取るのは C.view() の { color, setup（その人の配置）, log（公開の記録）} だけ。相手の駒の正体はここへ来ない
 *   {id, cmd:'move', view, level}            → {id, move, v}
 *   {id, cmd:'analyze', view, K, marg}       → {id, v, moves, q, marg}
 */
importScripts('gunjin-core.js', 'gunjin-ai.js');
try { importScripts('weights.js'); } catch (e) { /* 重みがなければ学習前のネット */ }
const C = self.GunjinCore, AI = self.GunjinAI(C);
let net = null;
function getNet() {
  if (net) return net;
  if (self.GUNJIN_WEIGHTS) net = AI.Net.fromJSON(self.GUNJIN_WEIGHTS);
  else { net = new AI.Net(16); net.prior = null; }
  return net;
}
function cleanView(v) { return { color: v.color | 0, setup: Array.from(v.setup, x => x | 0), log: C.publicLog(v.log || []) }; }
self.onmessage = e => {
  const d = e.data;
  try {
    const v = cleanView(d.view), n = getNet();
    if (d.cmd === 'move') {
      const L = AI.LEVELS[d.level] || AI.LEVELS.normal;
      const ag = AI.Agent.fromView(n, v, { K: L.K, tau: L.tau });
      const r = ag.choose();
      self.postMessage({ id: d.id, move: r.move, v: r.th.v });
    } else if (d.cmd === 'analyze') {
      const ag = AI.Agent.fromView(n, v, { K: d.K || 48 });
      const th = ag.think(d.K || 48);
      const marg = d.marg ? ag.b.marginals(d.marg) : null;
      self.postMessage({ id: d.id, v: th.v, moves: th.moves, q: Array.from(th.q), marg: marg ? Array.from(marg) : null });
    }
  } catch (err) { self.postMessage({ id: d.id, error: String(err && err.message || err) }); }
};
