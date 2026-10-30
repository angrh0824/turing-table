/* CPU の4段階（ブラウザの Worker と Node の測定で同じものを使う。測った強さと遊ぶ強さがずれないように）
 *   temp: 見込みの差 ÷ temp の exp に比例して手を選ぶ（ゆらぎ）。0 ならいちばんの手
 *   search: 見えない札を仮に配って最後まで打ってみる読み（最強だけ。測って強くなったときだけ使う）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./daifugo-core.js'), require('./daifugo-ai.js'));
  else root.DFLevels = factory(root.DFCore, root.DFAI);
})(typeof self !== 'undefined' ? self : this, function (D, A) {
  'use strict';
  const LEVELS = {
    easy: { label: 'やさしい', stars: 1, temp: 0.12, desc: '学んだ見込みに大きなゆらぎ。ときどき大胆な手を打ちます' },
    normal: { label: 'ふつう', stars: 2, temp: 0.06, desc: '学んだ見込みに少しゆらぎ' },
    strong: { label: 'つよい', stars: 3, temp: 0.02, desc: '学んだ見込みに、ほんの少しゆらぎ' },
    max: { label: '最強', stars: 4, temp: 0, desc: 'いちばん長く学んだネットの、いちばんよい手' },
  };
  const KEYS = ['easy', 'normal', 'strong', 'max'];
  // 最強の読み: 測った結果（js/strength.js の maxSearch）で使うかを決める
  const ST = (typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : {}).DF_STRENGTH;
  if (ST && ST.maxSearch) { LEVELS.max.search = ST.maxSearch; LEVELS.max.desc = 'いちばんよい手。終盤は見えない札を仮に配って最後まで打ってみる読みつき'; }
  function choose(g, level, net, rnd, over) {
    const L = Object.assign({}, LEVELS[level] || LEVELS.normal, over || {});
    if (!net) return { mv: A.chooseWeakest(g), res: null };
    if (L.search) return A.searchChoose(g, net, Object.assign({ rnd }, L.search));
    return A.chooseNet(g, net, { temp: L.temp, rnd });
  }
  return { LEVELS, KEYS, choose };
});
