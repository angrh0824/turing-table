/* CPU の思考を画面と別のスレッドで（最強の探索は少し時間がかかるので、画面が止まらないように） */
/* global HoldemCore, HoldemAI */
importScripts('holdem-core.js', 'holdem-ai.js');
let table = null;
const seed = new Uint32Array(1);
crypto.getRandomValues(seed);
const rng = HoldemCore.makeRng(seed[0]);
onmessage = e => {
  const m = e.data;
  if (m.t === 'init') { table = m.table; return; }
  // 画面が裏にあっても遅れにくいタイマー（ワーカーのタイマーは間引かれにくい）
  if (m.t === 'timer') { setTimeout(() => postMessage({ id: m.id, timer: true }), m.ms); return; }
  if (m.t === 'decide') {
    try {
      const d = HoldemAI.decide(m.s, m.p, m.level, { table, rng, models: m.models || null });
      postMessage({ id: m.id, d });
    } catch (err) { postMessage({ id: m.id, err: String(err && err.message || err) }); }
  }
};
