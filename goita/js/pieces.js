/* ごいたの駒の絵: 将棋の駒と同じ五角形に、ごいたの字（し・香・馬・銀・金・角・飛・王）。伏せた駒は木地だけ
 *   GoitaPieces.koma(t, opts) → SVG の文字列（t = 0..7。opts.back = 伏せた駒、opts.rot = 180度回す）
 */
(function (root) {
  'use strict';
  const CH = ['し', '香', '馬', '銀', '金', '角', '飛', '王'];
  const CHARS = 'し香馬銀金角飛王';
  const SIZE = [0.86, 0.88, 0.88, 0.91, 0.91, 0.95, 0.95, 1];
  const SHAPE = 'M50 2.5 Q51.6 2.5 53 3.2 L79.5 14.2 Q82.6 15.6 83 19 L91.8 94 Q92.2 98 88.2 98 L11.8 98 Q7.8 98 8.2 94 L17 19 Q17.4 15.6 20.5 14.2 L47 3.2 Q48.4 2.5 50 2.5Z';
  const GRAIN = '<path d="M22 22 Q50 30 78 20 M18 50 Q50 44 82 52 M14 80 Q50 74 86 82" fill="none" stroke="var(--koma-grain)" stroke-width="1.1" opacity=".55"/>';
  const cache = {};
  function koma(t, opts = {}) {
    const key = `${t}|${opts.back ? 1 : 0}|${opts.rot ? 1 : 0}`;
    if (cache[key]) return cache[key];
    const back = !!opts.back;
    const svg = `<svg class="koma-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="--ks:${back ? 0.92 : SIZE[t] || 0.9}">
<g${opts.rot ? ' transform="rotate(180 50 50)"' : ''}>
<path d="${SHAPE}" fill="url(${back ? '#koma-back' : '#koma-wood'})" stroke="var(--koma-edge)" stroke-width="1.6" stroke-linejoin="round"/>${GRAIN}
${back ? '<path d="M30 40 L70 40 M34 60 L66 60 M38 80 L62 80" stroke="var(--koma-edge)" stroke-width="2" opacity=".25"/>' : `<text class="koma-ch${t === 7 ? ' ou' : ''}" transform="translate(50 60) scale(1 1.1)" text-anchor="middle" dominant-baseline="central" font-size="${t === 0 ? 56 : 52}" fill="${t === 7 ? 'var(--koma-red)' : 'var(--koma-ink)'}">${CH[t]}</text>`}
</g></svg>`;
    cache[key] = svg;
    return svg;
  }
  root.GoitaPieces = { koma, CH, CHARS, SIZE, SHAPE };
})(typeof self !== 'undefined' ? self : this);
