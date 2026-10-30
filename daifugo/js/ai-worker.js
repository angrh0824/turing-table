/* CPU の思考と AI補助の分析（Web Worker）
 *   { id, type: 'move', game, level }   → { id, mv, res }   CPU の手
 *   { id, type: 'analyze', game }        → { id, res }       出せる手ごとの見込み（よい順）
 */
importScripts('daifugo-core.js', 'nn-simd.js', 'daifugo-ai.js');
let net = null;
try { importScripts('weights.js'); } catch (e) { /* 学習したネットがなければ基準の打ち方 */ }
try { importScripts('strength.js'); } catch (e) { /* 強さの記録がなければ読みなし */ }
importScripts('levels.js');
if (self.DF_WEIGHTS) { try { net = DFAI.makeNet(DFAI.dequantize(self.DF_WEIGHTS)); } catch (e) { net = null; } }

self.onmessage = e => {
  const j = e.data;
  try {
    const g = DFCore.Game.fromJSON(j.game);
    if (j.type === 'move') {
      const r = DFLevels.choose(g, j.level, net, Math.random);
      self.postMessage({ id: j.id, mv: r.mv, res: r.res ? slim(r.res) : null });
    } else if (j.type === 'analyze') {
      if (!net) { self.postMessage({ id: j.id, res: null }); return; }
      const res = DFAI.evaluate(g, net).sort((a, b) => b.ev - a.ev);
      self.postMessage({ id: j.id, res: slim(res) });
    }
  } catch (err) {
    self.postMessage({ id: j.id, error: String(err && err.message || err) });
  }
};
const slim = res => res.map(r => ({ mv: r.mv, pr: r.pr, ev: r.ev }));
