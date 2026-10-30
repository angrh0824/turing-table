/* チェスの駒の絵（すべて自作の SVG。100×100 の中に描く）
 *   ChessPieces.svg(color, type, cls) → <svg> の文字列（0 白・1 黒、1 ポーン〜6 キング）
 *   ページを開いたとき、記号（<symbol>）とグラデーションを1つの見えない SVG にまとめて置く
 */
(function () {
  'use strict';
  // 共通の台座
  const BASE = '<path d="M21 89 C21 83.5 25 80.5 31 80.5 L69 80.5 C75 80.5 79 83.5 79 89 Z"/><path d="M28 80.5 C28 77.5 30.5 75.5 34 75.5 L66 75.5 C69.5 75.5 72 77.5 72 80.5 Z"/>';
  const SHAPES = {
    // ポーン: 丸い頭・襟・すそ広がりの胴
    1: '<path d="M43.5 51 C43.5 61 38 69 33 75.5 L67 75.5 C62 69 56.5 61 56.5 51 Z"/>'
      + '<path d="M38 50.5 C38 47.5 40.5 45.5 44 45.5 L56 45.5 C59.5 45.5 62 47.5 62 50.5 C62 52.5 60.5 54 58.5 54 L41.5 54 C39.5 54 38 52.5 38 50.5 Z"/>'
      + '<circle cx="50" cy="33" r="12.5"/>',
    // ナイト: 左を向いた馬の頭（たてがみ・目・鼻の穴）
    2: '<path d="M34 75.5 C35 68 38.5 62 45 57 C39 56.5 31.5 58.5 27 56.5 C22 54.5 19.5 50 21.5 45.5 C25 38 31 31.5 37.5 25.5 L39.5 13 L46 21 C48 18.5 51 17 54 17.5 C66 20 73.5 31.5 72.5 47.5 C71.8 58.5 68 66 67.5 75.5 Z"/>'
      + '<path class="d" d="M50.5 21.5 C60 24.5 66 33 66.5 44.5 M55.5 25.5 C59 28.5 61.5 33 62 38" fill="none"/>'
      + '<path class="d" d="M38.5 38.5 C33 44 29 49 26.5 52" fill="none" opacity=".55"/>'
      + '<circle class="e" cx="41" cy="32" r="2.8"/><circle class="e" cx="25.2" cy="49" r="1.5"/>',
    // ビショップ: しずく形の冠と切れ込み・上の玉
    3: '<path d="M43 56 C43 64.5 38 70.5 33.5 75.5 L66.5 75.5 C62 70.5 57 64.5 57 56 Z"/>'
      + '<path d="M35.5 55.5 C35.5 52 38.5 50.5 42 50.5 L58 50.5 C61.5 50.5 64.5 52 64.5 55.5 C64.5 57.5 62.5 58.5 60.5 58.5 L39.5 58.5 C37.5 58.5 35.5 57.5 35.5 55.5 Z"/>'
      + '<path d="M50 18.5 C61.5 27 66.5 37 62.5 44.5 C60.3 48.8 56 50.5 50 50.5 C44 50.5 39.7 48.8 37.5 44.5 C33.5 37 38.5 27 50 18.5 Z"/>'
      + '<circle cx="50" cy="14.5" r="4.6"/>'
      + '<path class="d" d="M55.5 28 L46 40.5" fill="none"/>',
    // ルーク: 胸壁のある塔
    4: '<path d="M34.5 75.5 L37.5 46 L62.5 46 L65.5 75.5 Z"/>'
      + '<rect x="31" y="40.5" width="38" height="7.5" rx="2.5"/>'
      + '<path d="M30 41 L30 20.5 L39.5 20.5 L39.5 27.5 L45.5 27.5 L45.5 20.5 L54.5 20.5 L54.5 27.5 L60.5 27.5 L60.5 20.5 L70 20.5 L70 41 Z"/>'
      + '<path class="d" d="M38 33.5 L62 33.5" fill="none" opacity=".5"/>',
    // クイーン: 五つの尖りと玉の冠
    5: '<path d="M41.5 52 C41.5 63 36.5 70.5 32 75.5 L68 75.5 C63.5 70.5 58.5 63 58.5 52 Z"/>'
      + '<path d="M34 51 C34 47.5 37 46 40.5 46 L59.5 46 C63 46 66 47.5 66 51 C66 53 64 54.5 61.5 54.5 L38.5 54.5 C36 54.5 34 53 34 51 Z"/>'
      + '<path d="M33.5 46.5 L24.5 23.5 L38 35.5 L40 16 L47 32.5 L50 12.5 L53 32.5 L60 16 L62 35.5 L75.5 23.5 L66.5 46.5 Z"/>'
      + '<circle cx="24.5" cy="21.5" r="3.7"/><circle cx="40" cy="13.6" r="3.7"/><circle cx="50" cy="10" r="3.7"/><circle cx="60" cy="13.6" r="3.7"/><circle cx="75.5" cy="21.5" r="3.7"/>',
    // キング: 丸みのある冠と十字
    6: '<path d="M41.5 52 C41.5 63 36.5 70.5 32 75.5 L68 75.5 C63.5 70.5 58.5 63 58.5 52 Z"/>'
      + '<path d="M34 51 C34 47.5 37 46 40.5 46 L59.5 46 C63 46 66 47.5 66 51 C66 53 64 54.5 61.5 54.5 L38.5 54.5 C36 54.5 34 53 34 51 Z"/>'
      + '<path d="M34.5 46.5 C27.5 40 26 29.5 35 26.5 C42 24.5 47.5 28.5 50 34 C52.5 28.5 58 24.5 65 26.5 C74 29.5 72.5 40 65.5 46.5 Z"/>'
      + '<path d="M47 5.5 L53 5.5 L53 11.5 L59 11.5 L59 17.5 L53 17.5 L53 29 L47 29 L47 17.5 L41 17.5 L41 11.5 L47 11.5 Z"/>'
      + '<path class="d" d="M50 34 L50 45" fill="none" opacity=".5"/>',
  };
  const NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
  const CODE = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
  function sprite() {
    let s = '<svg class="sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><defs>'
      + '<linearGradient id="pg-w" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#fffdf7"/><stop offset=".55" stop-color="#efe6d3"/><stop offset="1" stop-color="#cdbd9b"/></linearGradient>'
      + '<linearGradient id="pg-b" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#666b75"/><stop offset=".5" stop-color="#2a2d33"/><stop offset="1" stop-color="#0d0e11"/></linearGradient>';
    for (let c = 0; c < 2; c++) for (let t = 1; t <= 6; t++) {
      const fill = c ? 'url(#pg-b)' : 'url(#pg-w)', stroke = c ? '#08090a' : '#2c2721', det = c ? '#d8c391' : '#2c2721';
      // 細部（たてがみ・目・切れ込み）は、白い駒には濃い線、黒い駒には真鍮色の線
      const body = SHAPES[t].replace(/class="d"/g, `stroke="${det}" stroke-width="2.2"`).replace(/class="e"/g, `fill="${det}" stroke="none"`);
      s += `<symbol id="p-${c ? 'b' : 'w'}${CODE[t]}" viewBox="6 3 88 88"><g fill="${fill}" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">${BASE}${body}</g></symbol>`;
    }
    s += '</defs></svg>';
    return s;
  }
  function svg(color, type, cls = 'piece', title = '') {
    return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${title ? `<title>${title}</title>` : ''}<use href="#p-${color ? 'b' : 'w'}${CODE[type]}"/></svg>`;
  }
  if (typeof document !== 'undefined') {
    const put = () => { if (!document.getElementById('pg-w')) document.body.insertAdjacentHTML('afterbegin', sprite()); };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }
  const api = { sprite, svg, NAMES, CODE };
  if (typeof window !== 'undefined') window.ChessPieces = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
