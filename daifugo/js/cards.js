/* トランプの絵柄（すべて自作の SVG）: マーク・数札の並び・絵札（J・Q・K の人物）・ジョーカー・裏面
 *   DFCards.install()        … 部品（<symbol>）を文書に1度だけ入れる
 *   DFCards.svg(c)           … 札 c（0..53）の SVG の文字列。c < 0 で裏面
 * 札の大きさは 100×140 の座標で描き、CSS の幅に合わせて伸び縮みする
 */
(function (root) {
  'use strict';
  const NR = 13;
  const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  const SUIT_NAMES = ['スペード', 'ハート', 'ダイヤ', 'クラブ'];
  const RED = 'var(--card-red, #c62736)', BLK = 'var(--card-black, #1b1e27)';
  const suitColor = s => (s === 1 || s === 2 ? RED : BLK);
  // 4色（♦を青・♣を緑）にする設定のときに CSS の変数で切り替える
  const suitFill = s => (s === 0 ? 'var(--card-s0, #1b1e27)' : s === 1 ? 'var(--card-s1, #c62736)' : s === 2 ? 'var(--card-s2, #c62736)' : 'var(--card-s3, #1b1e27)');

  // マーク（0..100 の箱）
  const SUIT_PATH = [
    // ♠
    'M50 4C61 19 95 39 95 62C95 77 84 86 71 86C63 86 57 82 53 76C54 85 58 92 66 97H34C42 92 46 85 47 76C43 82 37 86 29 86C16 86 5 77 5 62C5 39 39 19 50 4Z',
    // ♥
    'M50 93C41 82 5 60 5 32C5 16 16 6 29 6C39 6 46 12 50 21C54 12 61 6 71 6C84 6 95 16 95 32C95 60 59 82 50 93Z',
    // ♦
    'M50 3C60 18 74 35 90 50C74 65 60 82 50 97C40 82 26 65 10 50C26 35 40 18 50 3Z',
    // ♣
    'M50 6A20 20 0 0 1 66 38A20 20 0 1 1 55 72C56 83 59 91 67 97H33C41 91 44 83 45 72A20 20 0 1 1 34 38A20 20 0 0 1 50 6Z',
  ];

  // 数札のマークの位置（[x, y, 逆さ]）。中央の枠は x 22..78・y 18..122
  const L = 31, C = 50, Rr = 69;
  const PIPS = {
    1: [[C, 70, 0, 2.6]],
    2: [[C, 30, 0], [C, 110, 1]],
    3: [[C, 30, 0], [C, 70, 0], [C, 110, 1]],
    4: [[L, 30, 0], [Rr, 30, 0], [L, 110, 1], [Rr, 110, 1]],
    5: [[L, 30, 0], [Rr, 30, 0], [C, 70, 0], [L, 110, 1], [Rr, 110, 1]],
    6: [[L, 30, 0], [Rr, 30, 0], [L, 70, 0], [Rr, 70, 0], [L, 110, 1], [Rr, 110, 1]],
    7: [[L, 30, 0], [Rr, 30, 0], [C, 50, 0], [L, 70, 0], [Rr, 70, 0], [L, 110, 1], [Rr, 110, 1]],
    8: [[L, 30, 0], [Rr, 30, 0], [C, 50, 0], [L, 70, 0], [Rr, 70, 0], [C, 90, 1], [L, 110, 1], [Rr, 110, 1]],
    9: [[L, 30, 0], [Rr, 30, 0], [L, 56.7, 0], [Rr, 56.7, 0], [C, 70, 0], [L, 83.3, 1], [Rr, 83.3, 1], [L, 110, 1], [Rr, 110, 1]],
    10: [[L, 30, 0], [Rr, 30, 0], [C, 43.3, 0], [L, 56.7, 0], [Rr, 56.7, 0], [L, 83.3, 1], [Rr, 83.3, 1], [C, 96.7, 1], [L, 110, 1], [Rr, 110, 1]],
  };
  const PIP_N = { 0: 3, 1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10, 11: 1, 12: 2 };

  // 絵札の人物（上半分。0..64 × 0..53 の箱。下半分は逆さに写す）
  const SKIN = '#f2d6b3', GOLD = '#d7a23b', GOLD_D = '#9c6e1d', INK = '#2a2420';
  function robe(s) { return s === 1 || s === 2 ? '#b8232f' : '#25407f'; }
  function robe2(s) { return s === 1 || s === 2 ? '#25407f' : '#b8232f'; }
  function kingSym(s) {
    const r = robe(s), r2 = robe2(s);
    return `
      <path d="M4 53C6 40 17 33 32 33S58 40 60 53Z" fill="${r}"/>
      <path d="M12 46C17 39 25 36.5 32 36.5S47 39 52 46L50.5 49C45.5 43 39 40.5 32 40.5S18.5 43 13.5 49Z" fill="#fbf7ee"/>
      <g fill="${INK}"><circle cx="18" cy="44.6" r=".9"/><circle cx="24" cy="41" r=".9"/><circle cx="32" cy="39.6" r=".9"/><circle cx="40" cy="41" r=".9"/><circle cx="46" cy="44.6" r=".9"/></g>
      <path d="M27 41L32 52L37 41Z" fill="${GOLD}"/>
      <path d="M17 53L22 44L27 53Z" fill="${r2}" opacity=".85"/><path d="M37 53L42 44L47 53Z" fill="${r2}" opacity=".85"/>
      <rect x="28.5" y="26" width="7" height="8" fill="${SKIN}"/>
      <ellipse cx="32" cy="21" rx="8.6" ry="9.6" fill="${SKIN}"/>
      <path d="M23.4 21C23.4 31 27.5 37 32 37S40.6 31 40.6 21C38 25.5 35.4 26.5 32 26.5S26 25.5 23.4 21Z" fill="#6b4524"/>
      <path d="M27.6 25.4C29.5 24 31 24.6 32 25.3C33 24.6 34.5 24 36.4 25.4C34.6 26.4 33 26 32 25.7C31 26 29.4 26.4 27.6 25.4Z" fill="#4a2e16"/>
      <circle cx="28.6" cy="19.6" r="1.1" fill="${INK}"/><circle cx="35.4" cy="19.6" r="1.1" fill="${INK}"/>
      <path d="M27 16.6Q28.6 15.6 30.2 16.4M33.8 16.4Q35.4 15.6 37 16.6" stroke="${INK}" stroke-width=".8" fill="none" stroke-linecap="round"/>
      <path d="M21 14L21.6 3.5L26.4 9L32 1.5L37.6 9L42.4 3.5L43 14Z" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".8" stroke-linejoin="round"/>
      <rect x="21" y="11.6" width="22" height="3" fill="${GOLD_D}"/>
      <circle cx="32" cy="8.2" r="1.7" fill="#c62736"/><circle cx="26.2" cy="10.3" r="1.2" fill="#2b5fb4"/><circle cx="37.8" cy="10.3" r="1.2" fill="#2b5fb4"/>
      <path d="M52 52L56.5 17" stroke="${GOLD_D}" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="56.8" cy="14.5" r="3.4" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".8"/><path d="M56.8 9.6V11.4M55.9 10.5H57.7" stroke="${GOLD_D}" stroke-width=".9"/>`;
  }
  function queenSym(s) {
    const r = robe(s), r2 = robe2(s);
    return `
      <path d="M7 53C9 41 19 34.5 32 34.5S55 41 57 53Z" fill="${r}"/>
      <path d="M14 53C16 45 23 41 32 41S48 45 50 53Z" fill="${r2}" opacity=".9"/>
      <path d="M14 44Q17 41 20 43Q23 39.5 26 41.5Q29 38.5 32 40.5Q35 38.5 38 41.5Q41 39.5 44 43Q47 41 50 44Q46 48 32 47.5Q18 48 14 44Z" fill="#fbf7ee"/>
      <path d="M21 25C19 13 24 6.5 32 6.5S45 13 43 25C44 33 42.5 39 40 41.5H24C21.5 39 20 33 21 25Z" fill="#7a4a22"/>
      <rect x="28.6" y="27" width="6.8" height="8" fill="${SKIN}"/>
      <ellipse cx="32" cy="21.5" rx="8" ry="9.3" fill="${SKIN}"/>
      <path d="M24 18C26 12 30 11 32 13C34 11 38 12 40 18C37 15.5 34.5 15 32 16C29.5 15 27 15.5 24 18Z" fill="#7a4a22"/>
      <circle cx="28.8" cy="21" r="1" fill="${INK}"/><circle cx="35.2" cy="21" r="1" fill="${INK}"/>
      <path d="M27.3 18.6Q28.8 17.8 30.2 18.4M33.8 18.4Q35.2 17.8 36.7 18.6" stroke="${INK}" stroke-width=".7" fill="none" stroke-linecap="round"/>
      <path d="M30 26.2Q32 27.6 34 26.2" stroke="#c0392b" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <circle cx="27" cy="24.4" r="1.6" fill="#e8a49a" opacity=".6"/><circle cx="37" cy="24.4" r="1.6" fill="#e8a49a" opacity=".6"/>
      <path d="M22.5 13.5Q32 2 41.5 13.5L39.6 15.4Q32 7.4 24.4 15.4Z" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".7"/>
      <circle cx="32" cy="5.2" r="1.8" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".6"/><circle cx="26.6" cy="8.4" r="1.3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".6"/><circle cx="37.4" cy="8.4" r="1.3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".6"/>
      <circle cx="32" cy="9.6" r="1.2" fill="#c62736"/>
      <path d="M51 52V31" stroke="#3d7a3f" stroke-width="1.5"/><path d="M51 42Q56 39 57 34Q52 35 51 40Z" fill="#3d7a3f"/>
      <g transform="translate(51 27)"><circle r="2.2" cx="0" cy="-3" fill="#d84a5c"/><circle r="2.2" cx="2.9" cy="-.9" fill="#d84a5c"/><circle r="2.2" cx="1.8" cy="2.4" fill="#d84a5c"/><circle r="2.2" cx="-1.8" cy="2.4" fill="#d84a5c"/><circle r="2.2" cx="-2.9" cy="-.9" fill="#d84a5c"/><circle r="1.6" fill="${GOLD}"/></g>`;
  }
  function jackSym(s) {
    const r = robe(s), r2 = robe2(s);
    return `
      <path d="M7 53C9 42 19 35.5 32 35.5S55 42 57 53Z" fill="${r}"/>
      <path d="M18 53V39.5M25 53V37M32 53V36M39 53V37M46 53V39.5" stroke="${r2}" stroke-width="3" opacity=".8"/>
      <path d="M17 41Q32 33 47 41L45.5 44Q32 37.5 18.5 44Z" fill="${GOLD}"/>
      <rect x="28.6" y="28" width="6.8" height="8" fill="${SKIN}"/>
      <ellipse cx="32" cy="23.5" rx="8" ry="9" fill="${SKIN}"/>
      <path d="M24 24C22.6 30 24 33 25.6 33.6C25 29 25.6 26 26.4 24ZM40 24C41.4 30 40 33 38.4 33.6C39 29 38.4 26 37.6 24Z" fill="#a9682c"/>
      <circle cx="28.8" cy="23" r="1" fill="${INK}"/><circle cx="35.2" cy="23" r="1" fill="${INK}"/>
      <path d="M29.6 28.2Q32 29.4 34.4 28.2" stroke="${INK}" stroke-width=".8" fill="none" stroke-linecap="round"/>
      <path d="M19.5 19C19 9 27 5.5 34 6.5S46 11 46 17.5L44 20C39 16.5 27 16 21.5 21Z" fill="${r2}"/>
      <path d="M20.5 19.6Q32 13.8 45 19.2L44 21Q32 16 21.8 21.6Z" fill="${GOLD}"/>
      <path d="M43 12C47 6 53 3 60 2.5C56 6 52 9 46 14Z" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".6"/>
      <path d="M45 12.6L57.6 3.6" stroke="${GOLD_D}" stroke-width=".6"/>
      <path d="M8 52V12" stroke="#6b4524" stroke-width="1.8"/>
      <path d="M8 8L12.5 14L8 22L3.5 14Z" fill="#c9ced8" stroke="#5c6470" stroke-width=".7"/>`;
  }
  function jokerSym(red) {
    const a = red ? '#c62736' : '#25407f', b = red ? '#d7a23b' : '#1b1e27', c = red ? '#25407f' : '#c62736';
    return `
      <path d="M14 112C16 92 27 83 42 83S68 92 70 112Z" fill="${a}"/>
      <path d="M42 83L32 112M42 83L52 112" stroke="${b}" stroke-width="3"/>
      <path d="M22 86L27 92L32 85L37 92L42 85L47 92L52 85L57 92L62 86L60 94H24Z" fill="#fbf7ee" stroke="${b}" stroke-width=".8"/>
      <ellipse cx="42" cy="66" rx="13" ry="15" fill="#fbf7ee" stroke="${b}" stroke-width=".8"/>
      <circle cx="36.6" cy="63" r="1.6" fill="${INK}"/><circle cx="47.4" cy="63" r="1.6" fill="${INK}"/>
      <path d="M34.6 59.4L38.6 60.4M49.4 59.4L45.4 60.4" stroke="${INK}" stroke-width="1" stroke-linecap="round"/>
      <path d="M35 70Q42 77 49 70" stroke="#c62736" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <circle cx="33" cy="69" r="2.2" fill="#e57a7a" opacity=".55"/><circle cx="51" cy="69" r="2.2" fill="#e57a7a" opacity=".55"/>
      <circle cx="42" cy="66.6" r="1.8" fill="#c62736"/>
      <path d="M28 57C22 46 12 42 4 44C11 38 22 38 32 49Z" fill="${a}" stroke="${b}" stroke-width=".8"/>
      <path d="M56 57C62 46 72 42 80 44C73 38 62 38 52 49Z" fill="${c}" stroke="${b}" stroke-width=".8"/>
      <path d="M31 53C30 38 36 26 42 20C48 26 54 38 53 53Z" fill="${b === '#1b1e27' ? '#c62736' : '#d7a23b'}" stroke="${b}" stroke-width=".8"/>
      <path d="M28 57Q42 47 56 57L54 60Q42 52 30 60Z" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".6"/>
      <circle cx="4" cy="44" r="3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".7"/><circle cx="80" cy="44" r="3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".7"/><circle cx="42" cy="19" r="3" fill="${GOLD}" stroke="${GOLD_D}" stroke-width=".7"/>`;
  }

  // 部品を文書に入れる
  let installed = false;
  function defsMarkup() {
    let s = '';
    for (let i = 0; i < 4; i++) s += `<symbol id="dfs${i}" viewBox="0 0 100 100"><path d="${SUIT_PATH[i]}" fill="${suitFill(i)}"/></symbol>`;
    for (let i = 0; i < 4; i++) {
      s += `<symbol id="dfK${i}" viewBox="0 0 64 53">${kingSym(i)}</symbol>`;
      s += `<symbol id="dfQ${i}" viewBox="0 0 64 53">${queenSym(i)}</symbol>`;
      s += `<symbol id="dfJ${i}" viewBox="0 0 64 53">${jackSym(i)}</symbol>`;
    }
    s += `<symbol id="dfjk0" viewBox="0 0 84 114">${jokerSym(true)}</symbol><symbol id="dfjk1" viewBox="0 0 84 114">${jokerSym(false)}</symbol>`;
    // 裏面: 藍の地に金の格子と、真ん中に4つのマークの紋
    s += `<pattern id="dfbp" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="var(--back-a, #1d2a57)"/><path d="M0 4H8M4 0V8" stroke="var(--back-b, #c9a24a)" stroke-width=".55" opacity=".55"/><circle cx="4" cy="4" r=".9" fill="var(--back-b, #c9a24a)" opacity=".8"/></pattern>`;
    s += `<symbol id="dfback" viewBox="0 0 100 140"><rect x="0" y="0" width="100" height="140" rx="7" fill="var(--back-a, #1d2a57)"/><rect x="5" y="5" width="90" height="130" rx="4.5" fill="url(#dfbp)" stroke="var(--back-b, #c9a24a)" stroke-width="1.2"/>`
      + `<circle cx="50" cy="70" r="19" fill="var(--back-a, #1d2a57)" stroke="var(--back-b, #c9a24a)" stroke-width="1.4"/><circle cx="50" cy="70" r="15.5" fill="none" stroke="var(--back-b, #c9a24a)" stroke-width=".6"/>`
      + [0, 1, 2, 3].map(i => { const ang = (i * 90 - 45) * Math.PI / 180, x = 50 + Math.cos(ang) * 8 - 4.5, y = 70 + Math.sin(ang) * 8 - 4.5; return `<path transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(.09)" d="${SUIT_PATH[i]}" fill="var(--back-b, #c9a24a)"/>`; }).join('')
      + `</symbol>`;
    return s;
  }
  function install(doc) {
    doc = doc || document;
    if (installed || !doc || !doc.body) return;
    installed = true;
    const box = doc.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${defsMarkup()}</defs></svg>`;
    doc.body.prepend(box);
  }

  const use = (id, x, y, w, h, rot) => `<use href="#${id}" x="${x}" y="${y}" width="${w}" height="${h}"${rot ? ` transform="rotate(180 ${x + w / 2} ${y + h / 2})"` : ''}/>`;
  function corner(c) {
    const s = (c / NR) | 0, r = c % NR, col = suitFill(s), t = RANKS[r];
    const fs = t === '10' ? 19 : 22, ls = t === '10' ? -1.6 : 0;
    const one = `<text x="11" y="25" text-anchor="middle" font-size="${fs}" letter-spacing="${ls}" fill="${col}" class="cidx">${t}</text>${use('dfs' + s, 4.5, 29, 13, 13)}`;
    return `<g>${one}</g><g transform="rotate(180 50 70)">${one}</g>`;
  }
  function faceInner(c) {
    if (c >= 52) {
      const red = c === 52;
      const col = red ? RED : BLK;
      const letters = 'JOKER'.split('').map((ch, i) => `<text x="10.5" y="${18 + i * 11}" text-anchor="middle" font-size="10.5" fill="${col}" class="cidx jk">${ch}</text>`).join('');
      return `<rect x="0" y="0" width="100" height="140" rx="7" class="cface"/>${letters}<g transform="rotate(180 50 70)">${letters}</g>${use('dfjk' + (red ? 0 : 1), 13, 13, 74, 114)}`;
    }
    const s = (c / NR) | 0, r = c % NR;
    let body = '';
    if (r >= 8 && r <= 10) {
      const k = r === 8 ? 'J' : r === 9 ? 'Q' : 'K';
      body = `<rect x="18" y="17" width="64" height="106" rx="2" fill="var(--court-bg, #f6efdf)" stroke="${suitColor(s)}" stroke-width="1"/>`
        + use(`df${k}${s}`, 18, 17, 64, 53) + use(`df${k}${s}`, 18, 70, 64, 53, true)
        + `<path d="M18 70H82" stroke="${suitColor(s)}" stroke-width=".6" opacity=".5"/>`;
    } else {
      const n = PIP_N[r];
      for (const [x, y, rot, big] of PIPS[n]) {
        const sz = big ? 16 * big : 17;
        body += use('dfs' + s, x - sz / 2, y - sz / 2, sz, sz, rot);
      }
    }
    return `<rect x="0" y="0" width="100" height="140" rx="7" class="cface"/>${corner(c)}${body}`;
  }
  function svg(c, cls = '') {
    if (c == null || c < 0) return `<svg class="csvg back ${cls}" viewBox="0 0 100 140" aria-hidden="true"><use href="#dfback" width="100" height="140"/></svg>`;
    return `<svg class="csvg ${cls}" viewBox="0 0 100 140" role="img" aria-label="${label(c)}">${faceInner(c)}</svg>`;
  }
  function label(c) {
    if (c >= 52) return 'ジョーカー';
    return `${SUIT_NAMES[(c / NR) | 0]}の${RANKS[c % NR]}`;
  }
  // マークだけの小さな SVG（情報の行・しばりの表示に）
  function suitIcon(s, cls = '') { return `<svg class="sicon ${cls}" viewBox="0 0 100 100" aria-hidden="true"><path d="${SUIT_PATH[s]}" fill="${suitFill(s)}"/></svg>`; }

  // 文字だけの小さな札（記録・情報の行に。小さくても読める）
  const SUITS = ['♠', '♥', '♦', '♣'];
  function chip(c) {
    if (c == null || c < 0) return '<span class="cc bk">？</span>';
    if (c >= 52) return `<span class="cc jk">JK</span>`;
    const s = (c / NR) | 0;
    return `<span class="cc s${s}">${SUITS[s]}${RANKS[c % NR]}</span>`;
  }
  root.DFCards = { install, svg, label, suitIcon, chip, SUIT_PATH, defsMarkup };
})(typeof self !== 'undefined' ? self : this);
