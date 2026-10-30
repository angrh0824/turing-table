/* 牌の絵柄（すべて自作の SVG）。<symbol id="mjt-K"> を1回だけ文書に入れ、牌は <svg><use href="#mjt-K"/></svg> で描く
 *   K = 0..33 の種類、赤5は "4r"・"13r"・"22r"
 * 面の座標は 0 0 48 64（牌の白い面の部分。縁と厚みは CSS）
 */
(function () {
  'use strict';
  const C = { ink: '#1b2133', red: '#c3262f', green: '#16794a', blue: '#1f4fa6', gold: '#b8892a' };
  const NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const FONT = "'Shippori Mincho B1','Hiragino Mincho ProN','Yu Mincho','Noto Serif JP',serif";

  // 萬子: 漢数字（上）と「萬」（下）
  function man(n, red) {
    const col = red ? C.red : C.ink;
    return `<text x="24" y="27" font-family="${FONT}" font-weight="800" font-size="25" text-anchor="middle" fill="${col}">${NUM[n - 1]}</text>`
      + `<text x="24" y="58" font-family="${FONT}" font-weight="800" font-size="27" text-anchor="middle" fill="${C.red}">萬</text>`;
  }
  // 筒子の丸（二重の輪＋中の点）
  function dot(x, y, r, col) {
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${col}" stroke-width="${(r * 0.32).toFixed(2)}"/>`
      + `<circle cx="${x}" cy="${y}" r="${(r * 0.42).toFixed(2)}" fill="${col}"/>`
      + `<circle cx="${x}" cy="${y}" r="${(r * 0.14).toFixed(2)}" fill="#fff" opacity=".85"/>`;
  }
  function pin(n, red) {
    const B = C.blue, R = C.red, G = C.green;
    const L = {
      1: [[24, 32, 17, R]],
      2: [[24, 17, 9.5, G], [24, 47, 9.5, B]],
      3: [[11, 13, 8, B], [24, 32, 8, R], [37, 51, 8, G]],
      4: [[13, 18, 8.5, B], [35, 18, 8.5, G], [13, 46, 8.5, G], [35, 46, 8.5, B]],
      5: [[12, 14, 7.5, B], [36, 14, 7.5, G], [24, 32, 7.5, R], [12, 50, 7.5, G], [36, 50, 7.5, B]],
      6: [[14, 12, 7, G], [34, 12, 7, G], [14, 34, 7, R], [34, 34, 7, R], [14, 53, 7, R], [34, 53, 7, R]],
      7: [[9, 9, 5.8, G], [24, 15, 5.8, G], [39, 21, 5.8, G], [14, 38, 6.4, R], [34, 38, 6.4, R], [14, 54, 6.4, R], [34, 54, 6.4, R]],
      8: [[14, 9, 6, B], [34, 9, 6, B], [14, 24, 6, B], [34, 24, 6, B], [14, 40, 6, B], [34, 40, 6, B], [14, 55, 6, B], [34, 55, 6, B]],
      9: [[9, 11, 6.2, B], [24, 11, 6.2, B], [39, 11, 6.2, B], [9, 32, 6.2, R], [24, 32, 6.2, R], [39, 32, 6.2, R], [9, 53, 6.2, G], [24, 53, 6.2, G], [39, 53, 6.2, G]],
    }[n];
    let s = L.map(([x, y, r, col]) => dot(x, y, r, red && n === 5 ? R : col)).join('');
    if (n === 1) s += `<circle cx="24" cy="32" r="21" fill="none" stroke="${C.green}" stroke-width="1.2" stroke-dasharray="2.2 2.2"/>`;
    return s;
  }
  // 索子の竹（節のある棒）
  function stick(x, y, h, col, rot = 0) {
    const w = 5.4;
    return `<g transform="translate(${x} ${y}) rotate(${rot})">`
      + `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="2.6" fill="${col}"/>`
      + `<rect x="${-w / 2 - 0.6}" y="-1" width="${w + 1.2}" height="2" rx="1" fill="${col}" stroke="#fff" stroke-width=".6"/>`
      + `<rect x="${-w / 2 - 0.6}" y="${-h / 2 + 0.2}" width="${w + 1.2}" height="1.6" rx=".8" fill="${col}"/>`
      + `<rect x="${-w / 2 - 0.6}" y="${h / 2 - 1.8}" width="${w + 1.2}" height="1.6" rx=".8" fill="${col}"/>`
      + `<line x1="0" y1="${-h / 2 + 3}" x2="0" y2="${h / 2 - 3}" stroke="#fff" stroke-width=".8" opacity=".55"/>`
      + `</g>`;
  }
  function sou(n, red) {
    const G = C.green, R = C.red, B = C.blue;
    if (n === 1) {
      // 一索は鳥（自作の小鳥）
      return `<g>`
        + `<path d="M10 50 C14 34 22 26 33 25 C40 24 44 19 42 13 C47 17 47 26 40 31 C34 36 26 38 22 46 Z" fill="${G}"/>`
        + `<path d="M12 50 C9 55 12 59 18 58 C17 55 19 52 22 50 Z" fill="${R}"/>`
        + `<path d="M22 46 C18 52 22 58 29 57 C26 53 27 49 30 46 Z" fill="${B}"/>`
        + `<circle cx="39" cy="17" r="5.2" fill="${R}"/><circle cx="40.2" cy="16" r="1.4" fill="#fff"/>`
        + `<path d="M43.5 18 L48 20 L43.5 21 Z" fill="${C.gold}"/>`
        + `<path d="M26 36 C30 30 36 30 38 33" fill="none" stroke="#fff" stroke-width="1.2" opacity=".7"/>`
        + `<path d="M24 58 L22 62 M28 58 L28 62" stroke="${C.ink}" stroke-width="1.4"/>`
        + `</g>`;
    }
    const H = 16, L = {
      2: [[24, 17, G], [24, 47, G]],
      3: [[24, 16, G], [14, 47, G], [34, 47, G]],
      4: [[14, 17, G], [34, 17, G], [14, 47, G], [34, 47, B]],
      5: [[12, 17, G], [36, 17, B], [24, 32, R], [12, 47, B], [36, 47, G]],
      6: [[10, 17, G], [24, 17, G], [38, 17, G], [10, 47, B], [24, 47, B], [38, 47, B]],
      7: [[24, 9, R], [10, 32, G], [24, 32, G], [38, 32, G], [10, 54, B], [24, 54, B], [38, 54, B]],
      9: [[10, 11, G], [24, 11, R], [38, 11, B], [10, 32, G], [24, 32, R], [38, 32, B], [10, 53, G], [24, 53, R], [38, 53, B]],
    };
    if (n === 8) {
      // 八索: 上下に M と W の形
      const t = [[8, 17, -14], [19, 17, 14], [29, 17, -14], [40, 17, 14], [8, 47, 14], [19, 47, -14], [29, 47, 14], [40, 47, -14]];
      return t.map(([x, y, a], i) => stick(x, y, H + 1, i < 4 ? G : B, a)).join('');
    }
    const h = n === 7 || n === 9 ? 13.5 : H + 2;
    return L[n].map(([x, y, col]) => stick(x, y, h, red && n === 5 ? R : col)).join('');
  }
  function honor(k) {
    const ch = ['東', '南', '西', '北', '', '發', '中'][k - 27];
    if (k === 31) return `<rect x="8" y="9" width="32" height="46" rx="3" fill="none" stroke="${C.blue}" stroke-width="2.6"/><rect x="12.5" y="13.5" width="23" height="37" rx="1.5" fill="none" stroke="${C.blue}" stroke-width="1"/>`;
    const col = k === 32 ? C.green : k === 33 ? C.red : C.ink;
    return `<text x="24" y="45" font-family="${FONT}" font-weight="800" font-size="36" text-anchor="middle" fill="${col}">${ch}</text>`;
  }
  function face(k, red) {
    if (k < 9) return man(k + 1, red);
    if (k < 18) return pin(k - 8, red);
    if (k < 27) return sou(k - 17, red);
    return honor(k);
  }
  let injected = false;
  function inject() {
    if (injected || typeof document === 'undefined') return;
    injected = true;
    let s = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>';
    for (let k = 0; k < 34; k++) s += `<symbol id="mjt-${k}" viewBox="0 0 48 64">${face(k, false)}</symbol>`;
    for (const k of [4, 13, 22]) s += `<symbol id="mjt-${k}r" viewBox="0 0 48 64">${face(k, true)}<circle cx="42" cy="6" r="2.4" fill="${C.red}"/></symbol>`;
    // 裏面の模様
    s += `<symbol id="mjt-back" viewBox="0 0 48 64"><rect width="48" height="64" fill="none"/>`
      + `<path d="M24 10 L36 32 L24 54 L12 32 Z" fill="none" stroke="rgba(255,230,170,.55)" stroke-width="1.4"/>`
      + `<circle cx="24" cy="32" r="5" fill="none" stroke="rgba(255,230,170,.55)" stroke-width="1.4"/></symbol>`;
    s += '</defs></svg>';
    const div = document.createElement('div');
    div.innerHTML = s;
    document.body.prepend(div.firstChild);
  }
  // 牌の HTML（id は牌そのもの、または kind と赤の指定）
  function tileHTML(k, red, cls = '', extra = '') {
    const sym = red ? `${k}r` : `${k}`;
    return `<span class="tile ${cls}" data-k="${k}"${extra}><svg viewBox="0 0 48 64" aria-hidden="true"><use href="#mjt-${sym}"/></svg></span>`;
  }
  function backHTML(cls = '') { return `<span class="tile back ${cls}"><svg viewBox="0 0 48 64" aria-hidden="true"><use href="#mjt-back"/></svg></span>`; }
  window.MJTiles = { inject, tileHTML, backHTML, face };
})();
