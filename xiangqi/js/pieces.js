/* シャンチーの駒の絵（すべて自作の SVG。100×100 の中に描く）: 丸い木の駒に、赤か黒の漢字を彫って墨を入れたもの
 *   XiangqiPieces.svg(color, type, cls) → <svg> の文字列（0 赤・1 黒、1 帥/將 〜 7 兵/卒）
 *   ページを開いたとき、木目のグラデーションと影を1つの見えない SVG にまとめて置く
 *   字は「Noto Serif TC」（Google Fonts。駒の字だけを読み込む）。読めないときは端末の明朝体
 */
(function () {
  'use strict';
  const CH = [['', '帥', '仕', '相', '傌', '俥', '炮', '兵'], ['', '將', '士', '象', '馬', '車', '砲', '卒']];
  const INK = ['#b3261e', '#211c18'];
  const FONT = "'Noto Serif TC', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', 'MingLiU', serif";
  const DEFS = `<svg class="sprite" aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden">
    <defs>
      <radialGradient id="xq-wood" cx="38%" cy="30%" r="78%">
        <stop offset="0" stop-color="#fbebc8"/><stop offset=".55" stop-color="#ecd09a"/><stop offset="1" stop-color="#d2a868"/>
      </radialGradient>
      <linearGradient id="xq-side" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#b98447"/><stop offset="1" stop-color="#7d5126"/>
      </linearGradient>
      <radialGradient id="xq-face" cx="50%" cy="45%" r="55%">
        <stop offset="0" stop-color="#fff6df" stop-opacity=".55"/><stop offset="1" stop-color="#fff6df" stop-opacity="0"/>
      </radialGradient>
      <pattern id="xq-grain" width="100" height="100" patternUnits="userSpaceOnUse">
        <path d="M-5 22 C20 14 40 30 62 20 S96 12 110 22 M-5 47 C18 40 44 55 66 45 S98 38 110 47 M-5 72 C24 64 42 80 64 70 S96 62 110 72" fill="none" stroke="#a87436" stroke-opacity=".16" stroke-width="1.4"/>
        <path d="M-5 34 C22 28 38 40 60 33 S94 26 110 34 M-5 59 C20 52 40 66 64 57 S98 52 110 59 M-5 85 C26 78 44 92 66 83" fill="none" stroke="#a87436" stroke-opacity=".10" stroke-width="1"/>
      </pattern>
    </defs></svg>`;
  function ensureDefs() {
    if (typeof document === 'undefined' || document.getElementById('xq-wood')) return;
    const box = document.createElement('div');
    box.innerHTML = DEFS;
    document.body.insertBefore(box.firstChild, document.body.firstChild);
  }
  if (typeof document !== 'undefined') {
    if (document.body) ensureDefs(); else document.addEventListener('DOMContentLoaded', ensureDefs);
  }
  // 駒の SVG。cls = 'piece'（盤の上）など
  function svg(color, type, cls = 'piece', title = '') {
    const ink = INK[color], ch = CH[color][type];
    return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"${title ? ` role="img" aria-label="${title}"` : ''}>`
      + '<ellipse cx="50" cy="55" rx="46" ry="44" fill="url(#xq-side)"/>'
      + '<circle cx="50" cy="50" r="45" fill="url(#xq-wood)" stroke="#6e4520" stroke-opacity=".55" stroke-width="1.2"/>'
      + '<circle cx="50" cy="50" r="45" fill="url(#xq-grain)"/>'
      + `<circle cx="50" cy="50" r="37" fill="none" stroke="${ink}" stroke-width="2.6" stroke-opacity=".88"/>`
      + '<circle cx="50" cy="50" r="34.5" fill="url(#xq-face)"/>'
      + `<text x="50" y="51" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-weight="700" font-size="47" fill="${ink}" style="paint-order:stroke" stroke="#fff3d6" stroke-width=".6" stroke-opacity=".5">${ch}</text>`
      + '</svg>';
  }
  const api = { svg, CH, INK, FONT, ensureDefs };
  if (typeof window !== 'undefined') window.XiangqiPieces = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
