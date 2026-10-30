/* 花札の絵柄（すべて自作の SVG）。和モダン: 平たい色の面・少ない色数・金の細い線
 *
 *   document.body.insertAdjacentHTML('afterbegin', KoikoiCards.sprite());  // 48枚と裏面の <symbol> を1回だけ入れる
 *   el.innerHTML = KoikoiCards.svg(id, { tag: true });                    // 1枚（tag = 左上に月・右下に種類の小さな印）
 *
 * 座標は 60×96。札の番号は koikoi-core.js と同じ（月 = id >> 2、月の中は格の高い順）
 */
(function (root) {
  'use strict';
  const W = 60, H = 96;
  const C = {
    paper: '#f6f0e3', paper2: '#efe6d2', ink: '#1f1b18', gold: '#c8a046', gold2: '#e4c574', goldDk: '#9a7428',
    red: '#cf3a2a', redDk: '#9f271c', vermil: '#e0582f', pink: '#f4bccb', pink2: '#e892a8', plum: '#c73552', plumDk: '#8e1f37',
    green: '#2e5a47', green2: '#4b8562', green3: '#8bb879', moss: '#8a9a3c', brown: '#6c4a31', brownDk: '#43301f',
    indigo: '#203559', indigo2: '#355584', night: '#1c2233', purple: '#7754a6', purple2: '#a585cf', lilac: '#cdb8e8',
    yellow: '#e8b636', orange: '#e17a2c', white: '#fdfaf3', sky: '#d4452d', cream: '#f7e7bf', grey: '#8d8a84',
  };
  const n2 = v => Math.round(v * 100) / 100;
  const P = (x, y) => `${n2(x)},${n2(y)}`;
  const rad = d => d * Math.PI / 180;
  const pol = (cx, cy, r, deg) => [cx + Math.cos(rad(deg)) * r, cy + Math.sin(rad(deg)) * r];
  const circle = (cx, cy, r, fill, ex = '') => `<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}" fill="${fill}"${ex ? ' ' + ex : ''}/>`;
  const ell = (cx, cy, rx, ry, fill, deg = 0, ex = '') => `<ellipse cx="${n2(cx)}" cy="${n2(cy)}" rx="${n2(rx)}" ry="${n2(ry)}" fill="${fill}"${deg ? ` transform="rotate(${n2(deg)} ${n2(cx)} ${n2(cy)})"` : ''}${ex ? ' ' + ex : ''}/>`;
  const path = (d, fill, ex = '') => `<path d="${d}" fill="${fill}"${ex ? ' ' + ex : ''}/>`;
  const line = (d, stroke, w, ex = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${ex ? ' ' + ex : ''}/>`;
  const g = (inner, tf = '') => `<g${tf ? ` transform="${tf}"` : ''}>${inner}</g>`;

  // ------------------------------------------------------------------ 花・葉の部品
  function plumFlower(cx, cy, r, col, deg = 0) {
    let s = '';
    for (let k = 0; k < 5; k++) { const [x, y] = pol(cx, cy, r * 0.5, deg + k * 72 - 90); s += circle(x, y, r * 0.52, col); }
    s += circle(cx, cy, r * 0.3, '#f3cf62');
    for (let k = 0; k < 5; k++) { const [x, y] = pol(cx, cy, r * 0.26, deg + k * 72 - 54); s += circle(x, y, r * 0.07, C.plumDk); }
    return s;
  }
  function sakura(cx, cy, r, col, deg = 0, core = C.plumDk) {
    const pet = `M0,0 C${P(-r * 0.5, -r * 0.2)} ${P(-r * 0.58, -r * 0.82)} ${P(-r * 0.2, -r)} L0,${n2(-r * 0.82)} L${P(r * 0.2, -r)} C${P(r * 0.58, -r * 0.82)} ${P(r * 0.5, -r * 0.2)} 0,0Z`;
    let s = '';
    for (let k = 0; k < 5; k++) s += `<path d="${pet}" fill="${col}" transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(deg + k * 72)})"/>`;
    s += circle(cx, cy, r * 0.16, core);
    return s;
  }
  function leaf(x, y, len, w, deg, fill, vein) {
    const d = `M0,0 C${P(len * 0.3, -w)} ${P(len * 0.7, -w)} ${P(len, 0)} C${P(len * 0.7, w)} ${P(len * 0.3, w)} 0,0Z`;
    return `<g transform="translate(${n2(x)} ${n2(y)}) rotate(${n2(deg)})"><path d="${d}" fill="${fill}"/>${vein ? `<path d="M${P(len * 0.08, 0)} L${P(len * 0.9, 0)}" stroke="${vein}" stroke-width="0.5" fill="none"/>` : ''}</g>`;
  }
  function maple(cx, cy, R, deg, fill) {
    // 7つの裂片（真ん中が一番長い）
    const lobes = [[-90, 1], [-90 - 40, 0.9], [-90 + 40, 0.9], [-90 - 82, 0.66], [-90 + 82, 0.66], [-90 - 122, 0.42], [-90 + 122, 0.42]];
    lobes.sort((a, b) => a[0] - b[0]);
    let d = '';
    lobes.forEach(([a, l], i) => {
      const [tx, ty] = pol(0, 0, R * l, a);
      const [lx, ly] = pol(0, 0, R * l * 0.55, a - 13);
      const [rx, ry] = pol(0, 0, R * l * 0.55, a + 13);
      const [vx, vy] = pol(0, 0, R * 0.3, a + 20);
      d += `${i ? 'L' : 'M'}${P(lx, ly)} L${P(tx, ty)} L${P(rx, ry)} ${i < lobes.length - 1 ? `L${P(vx, vy)}` : ''}`;
    });
    d += `L0,${n2(R * 0.25)}Z`;
    return `<g transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(deg)})"><path d="${d}" fill="${fill}"/><path d="M0,${n2(R * 0.25)} L0,${n2(R * 0.55)}" stroke="${fill}" stroke-width="0.8"/></g>`;
  }
  function chrys(cx, cy, r, outer, inner) {
    let s = '';
    for (let k = 0; k < 18; k++) s += ell(...pol(cx, cy, r * 0.62, k * 20), r * 0.36, r * 0.13, outer, k * 20);
    for (let k = 0; k < 12; k++) s += ell(...pol(cx, cy, r * 0.36, k * 30 + 15), r * 0.26, r * 0.11, inner, k * 30 + 15);
    s += circle(cx, cy, r * 0.2, '#b8641d');
    return s;
  }
  function peony(cx, cy, r) {
    let s = '';
    for (let k = 0; k < 8; k++) s += circle(...pol(cx, cy, r * 0.6, k * 45 + 10), r * 0.45, k % 2 ? C.plum : '#d8486a');
    for (let k = 0; k < 6; k++) s += circle(...pol(cx, cy, r * 0.33, k * 60 + 30), r * 0.34, '#ef7f98');
    s += circle(cx, cy, r * 0.3, '#f6aebf');
    s += circle(cx, cy, r * 0.12, '#f3cf62');
    return s;
  }
  function pineFan(cx, cy, r, dark, light) {
    let s = path(`M${P(cx - r, cy)} A${n2(r)} ${n2(r)} 0 0 1 ${P(cx + r, cy)}Z`, dark);
    for (let k = 1; k < 8; k++) { const [x, y] = pol(cx, cy, r * 0.88, 180 + k * 22.5); s += line(`M${P(cx, cy)} L${P(x, y)}`, light, 0.55); }
    return s;
  }
  function wisteria(x, y, len, sway) {
    let s = '';
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), w = 4.2 * (1 - t * 0.7);
      const cx = x + Math.sin(t * 2.4) * sway, cy = y + t * len;
      s += ell(cx - w * 0.35, cy, w * 0.55, 1.7, i % 2 ? C.purple : C.purple2, -10);
      s += ell(cx + w * 0.35, cy + 0.9, w * 0.55, 1.7, i % 2 ? C.purple2 : C.lilac, 10);
    }
    return s;
  }
  function iris(cx, cy, r) {
    let s = '';
    s += ell(cx - r * 0.55, cy + r * 0.2, r * 0.62, r * 0.3, C.indigo2, 35);
    s += ell(cx + r * 0.55, cy + r * 0.2, r * 0.62, r * 0.3, C.indigo2, -35);
    s += ell(cx, cy + r * 0.55, r * 0.28, r * 0.6, C.purple, 0);
    s += ell(cx - r * 0.18, cy - r * 0.45, r * 0.18, r * 0.55, C.purple2, -12);
    s += ell(cx + r * 0.18, cy - r * 0.45, r * 0.18, r * 0.55, C.purple2, 12);
    s += ell(cx - r * 0.5, cy + r * 0.28, r * 0.18, r * 0.07, C.yellow, 35);
    s += ell(cx + r * 0.5, cy + r * 0.28, r * 0.18, r * 0.07, C.yellow, -35);
    return s;
  }
  function blade(x, y, h, lean, w, fill) {
    return path(`M${P(x - w, y)} C${P(x - w * 0.6 + lean * 0.4, y - h * 0.5)} ${P(x + lean * 0.8, y - h * 0.85)} ${P(x + lean, y - h)} C${P(x + lean * 0.7 + w * 0.3, y - h * 0.8)} ${P(x + w * 0.6 + lean * 0.3, y - h * 0.4)} ${P(x + w, y)}Z`, fill);
  }
  function grass(x, y, h, lean, col, w = 0.7) {
    return line(`M${P(x, y)} Q${P(x + lean * 0.3, y - h * 0.6)} ${P(x + lean, y - h)}`, col, w);
  }
  function cloverStem(x0, y0, x1, y1, bend, leafCol, flowerCol, n, flip) {
    let s = line(`M${P(x0, y0)} Q${P((x0 + x1) / 2 + bend, (y0 + y1) / 2 - Math.abs(bend))} ${P(x1, y1)}`, C.brown, 0.7);
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1), u = 1 - t;
      const mx = (x0 + x1) / 2 + bend, my = (y0 + y1) / 2 - Math.abs(bend);
      const x = u * u * x0 + 2 * u * t * mx + t * t * x1, y = u * u * y0 + 2 * u * t * my + t * t * y1;
      s += ell(x - 1.6, y - 0.6, 1.6, 0.85, leafCol, flip ? 25 : -25);
      s += ell(x + 1.6, y - 0.6, 1.6, 0.85, leafCol, flip ? -25 : 25);
      if (i % 2 === 0) s += circle(x, y - 1.6, 0.95, flowerCol);
    }
    return s;
  }
  function willowStrand(x, y, len, sway, col) {
    return line(`M${P(x, y)} C${P(x + sway, y + len * 0.35)} ${P(x - sway * 0.4, y + len * 0.7)} ${P(x + sway * 0.6, y + len)}`, col, 1.5, 'stroke-dasharray="2.2 0.9"');
  }
  function paulowniaLeaf(cx, cy, r, deg, fill, vein) {
    const d = `M0,${n2(r * 0.95)} C${P(-r * 1.15, r * 0.35)} ${P(-r * 0.85, -r * 0.95)} 0,${n2(-r * 0.55)} C${P(r * 0.85, -r * 0.95)} ${P(r * 1.15, r * 0.35)} 0,${n2(r * 0.95)}Z`;
    let v = `<path d="M0,${n2(r * 0.9)} L0,${n2(-r * 0.5)}" stroke="${vein}" stroke-width="0.6"/>`;
    for (const s of [-1, 1]) v += `<path d="M0,${n2(r * 0.2)} L${P(s * r * 0.55, -r * 0.2)} M0,${n2(r * 0.55)} L${P(s * r * 0.6, r * 0.25)}" stroke="${vein}" stroke-width="0.45"/>`;
    return `<g transform="translate(${n2(cx)} ${n2(cy)}) rotate(${n2(deg)})"><path d="${d}" fill="${fill}"/>${v}</g>`;
  }
  function paulowniaSpike(x, y, h) {
    let s = line(`M${P(x, y)} L${P(x, y - h)}`, C.green, 0.8);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), yy = y - h * 0.15 - t * h * 0.85, w = 2.8 * (1 - t * 0.55);
      s += ell(x - w * 0.5, yy, w * 0.55, 1.2, C.purple, -20);
      s += ell(x + w * 0.5, yy - 0.5, w * 0.55, 1.2, C.purple2, 20);
    }
    s += circle(x, y - h - 0.6, 0.9, C.lilac);
    return s;
  }

  // ------------------------------------------------------------------ 生き物・もの
  function crane(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    return g(
      // 尾の黒い羽（後ろに垂れる）
      path('M-9,3 C-15,3 -20,8 -23,15 C-19,13 -15,12.5 -11,11 C-14,14 -15,17 -15,20 C-11,16 -7,12 -5,8Z', C.ink) +
      // 胴（白）と翼の線
      path('M-11,4 C-13,-4 -5,-10 5,-9 C11,-8.5 14,-4 13,1 C11,6 2,9 -6,8 C-9,7.5 -10.5,6 -11,4Z', C.white) +
      line('M-7,-3 C-1,-6 6,-5 10,-1', '#d9d2c2', 0.7) + line('M-6,1 C0,-1 5,0 8,3', '#d9d2c2', 0.5) +
      // 首（黒）・首の後ろの白・頭
      line('M10,-5 C13,-12 11,-22 15.5,-30', C.ink, 3) +
      line('M9,-6 C11.5,-12 10,-20 13.6,-27', C.white, 1.1) +
      circle(16.2, -31.2, 2.5, C.white) + path('M16.6,-33.6 C15.2,-33.6 14.4,-32.8 14.6,-31.6 L18,-31.8 C18.2,-33 17.6,-33.6 16.6,-33.6Z', C.red) +
      path('M17.8,-31.8 C18.3,-30.6 18,-29.2 16.8,-28.8 L15.4,-29.4 C16.6,-30 17.2,-30.8 17.8,-31.8Z', C.ink) +
      path('M18.4,-31.6 L25.5,-30.2 L18.4,-30.2Z', C.goldDk) + circle(17.1, -31.3, 0.45, C.ink) +
      // 脚
      line('M1,8 L-0.5,25 M5,8 L6.5,25', C.ink, 0.95) + line('M-0.5,25 L-3.5,26.2 M-0.5,25 L1.5,26.4 M6.5,25 L9.5,26.2 M6.5,25 L4.5,26.4', C.ink, 0.6), t);
  }
  function bird(x, y, s, body, belly, flip) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${flip ? -n2(s) : n2(s)} ${n2(s)})`;
    return g(
      path('M-8,2 L-14,6 L-12,1Z', body) +
      ell(-1, 0, 7.5, 4.6, body, -12) + ell(0, 2.2, 5, 2.4, belly, -10) +
      circle(5.5, -3, 3.4, body) + path('M8.4,-3.6 L11.6,-2.6 L8.4,-1.8Z', C.goldDk) + circle(6.6, -3.6, 0.6, C.ink) +
      path('M-5,-2 C-2,-5 2,-4 3,-1 C0,0 -3,0 -5,-2Z', belly, 'opacity=".55"') +
      line('M-1,4.5 L-2,7.5 M1.5,4.5 L1,7.5', C.brownDk, 0.6), t);
  }
  function flyingBird(x, y, s, col, belly, deg = 0) {
    const t = `translate(${n2(x)} ${n2(y)}) rotate(${n2(deg)}) scale(${n2(s)})`;
    return g(
      path('M-2,0 C-6,-6 -12,-9 -18,-9 C-13,-6 -9,-2 -6,1Z', col) +
      path('M1,0 C4,-7 10,-12 17,-13 C12,-8 8,-3 5,1Z', col) +
      ell(0, 1.2, 7, 2.3, col) + ell(0.5, 2, 4.5, 1.2, belly) +
      circle(7, 0.2, 2, col) + path('M8.8,-0.2 L11.4,0.6 L8.8,1.2Z', C.goldDk) +
      path('M-6,1 L-12,3.5 L-11,0.6 L-12,-1.8Z', col), t);
  }
  function goose(x, y, s, col) {
    return g(path('M0,0 C-3,-2.6 -6,-3.4 -9,-3 C-6,-1.6 -3,0 -1,1.4 C-3,1.6 -5,2.6 -6,3.4 C-3,3 0,2 1.4,0.8 C3,0.6 4.6,0 6,-0.6 C4,-1 2,-0.8 0,0Z', col), `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`);
  }
  function butterfly(x, y, s, wing1, wing2, deg) {
    const t = `translate(${n2(x)} ${n2(y)}) rotate(${n2(deg)}) scale(${n2(s)})`;
    return g(
      ell(-4.2, -3, 4.6, 3.4, wing1, -30) + ell(4.2, -3, 4.6, 3.4, wing1, 30) +
      ell(-3, 3, 3, 2.4, wing2, 30) + ell(3, 3, 3, 2.4, wing2, -30) +
      circle(-4.8, -3.6, 1.1, C.cream) + circle(4.8, -3.6, 1.1, C.cream) +
      ell(0, 0, 0.9, 5, C.ink) + line('M0,-4.5 C-1,-7 -2,-8 -3,-8.6 M0,-4.5 C1,-7 2,-8 3,-8.6', C.ink, 0.45), t);
  }
  function boar(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    return g(
      path('M-15,2 C-16,-6 -10,-12 -1,-12 C7,-12 13,-8 16,-3 L20,-1 C21,1 20,3 18,3 L14,4 C12,7 8,8 2,8 C-6,8 -13,7 -15,2Z', '#5a3b26') +
      path('M-12,4 C-6,7 4,7 10,5 C6,8 -6,9 -12,4Z', '#7a5235') +
      path('M-8,-11 L-6,-14 L-3,-12 L0,-14.5 L2,-12 L5,-14 L7,-11.5Z', '#3f281a') +
      line('M-11,6 L-13,12 M-6,7 L-6,12.5 M6,7 L7.5,12.5 M11,6 L13,11.5', '#3f281a', 1.6) +
      circle(12.8, -4.5, 0.75, C.ink) + path('M10,-8 L12,-11 L13,-7.5Z', '#3f281a') +
      path('M17.5,1.2 C18.8,0.4 19.6,-0.6 19.9,-2.2', 'none', `stroke="${C.white}" stroke-width="0.9" stroke-linecap="round"`) +
      line('M-15,0 C-18,-1 -19,-4 -18,-6', '#3f281a', 0.8), t);
  }
  function deer(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    return g(
      path('M-12,0 C-12,-6 -6,-8 2,-8 C7,-8 10,-7 11,-5 C12,-10 14,-15 16,-17 C18,-16 18.5,-14 18,-12 L21,-10.5 C21.5,-9 20,-8 18.5,-8.3 C16,-6 14,-2 12,1 C10,4 4,5 -3,5 C-8,5 -12,4 -12,0Z', '#9a5a2e') +
      path('M-10,2 C-4,5 6,5 11,2 C8,5 -4,6 -10,2Z', C.cream) +
      line('M-9,3 L-10,14 M-5,4 L-5,14.5 M6,4 L7,14.5 M10,2 L12.5,13.5', '#6f3d1c', 1.1) +
      line('M16.5,-17 C15,-21 13,-23 11,-24 M15.5,-20 C17,-22 18,-23 20,-23.5 M17,-16.5 C19,-19 21,-20 23,-20', '#6f3d1c', 0.8) +
      path('M14.5,-16 L12.5,-18.5 L15.5,-17.5Z', '#7a4320') + circle(17.6, -12.2, 0.6, C.ink) +
      [[-6, -4], [-2, -6], [2, -4], [-8, -1], [5, -6], [0, -1.5]].map(([a, b]) => circle(a, b, 0.65, C.cream)).join('') +
      line('M-12,-1 C-14,-2 -14.5,-3.5 -14,-4.5', '#6f3d1c', 1), t);
  }
  function swallow(x, y, s, deg) {
    const t = `translate(${n2(x)} ${n2(y)}) rotate(${n2(deg)}) scale(${n2(s)})`;
    return g(
      path('M0,0 C-5,-4 -11,-10 -16,-11 C-12,-6 -7,-1 -3,2Z', C.indigo) +
      path('M2,0 C6,-3 13,-6 18,-5 C13,-2 8,1 4,3Z', C.indigo) +
      ell(0, 2, 6.5, 2.4, C.indigo, 8) + ell(1, 3, 4, 1.2, C.white, 8) +
      circle(6, 1.2, 2, C.indigo) + circle(7, 2.4, 0.9, C.red) + path('M7.8,0.8 L10,1.6 L7.8,2Z', C.ink) +
      path('M-5,3 L-14,9 L-6,4.5 L-13,12 L-3,4Z', C.indigo), t);
  }
  function sakeCup(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    return g(
      ell(0, 5.5, 6.5, 2.2, C.redDk) + path('M-6,5 L-5,7.5 L5,7.5 L6,5Z', C.redDk) +
      path('M-14,-4 C-13,4 -7,7 0,7 C7,7 13,4 14,-4Z', C.red) +
      ell(0, -4, 14, 3.4, '#e9604a') + ell(0, -4, 12, 2.4, C.redDk) +
      path('M-14,-4 C-13,4 -7,7 0,7 C7,7 13,4 14,-4', 'none', `stroke="${C.gold}" stroke-width="0.6"`) +
      `<text x="0" y="3.6" text-anchor="middle" font-size="7.5" font-family="'Shippori Mincho B1','Yu Mincho',serif" font-weight="800" fill="${C.gold2}">寿</text>`, t);
  }
  function bridge(y) {
    let s = '';
    const pts = [[4, y + 6], [22, y], [38, y + 7], [56, y + 1]];
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      s += path(`M${P(x0, y0)} L${P(x1, y1)} L${P(x1, y1 + 3.2)} L${P(x0, y0 + 3.2)}Z`, i % 2 ? '#8b6440' : '#a37a50');
      for (let k = 1; k < 6; k++) { const t = k / 6; s += line(`M${P(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)} l0,3.2`, C.brownDk, 0.35); }
      s += line(`M${P(x0 + 2, y0 + 3.2)} l0,5 M${P(x1 - 2, y1 + 3.2)} l0,5`, C.brownDk, 0.9);
    }
    return s;
  }
  function curtain(y) {
    let s = '';
    // 幕: 上が波打つ赤い布。白い紋と金の綱
    let top = `M2,${n2(y + 3)}`;
    for (let i = 0; i < 6; i++) top += ` Q${P(2 + i * 9.33 + 4.66, y - 2)} ${P(2 + (i + 1) * 9.33, y + 3)}`;
    s += path(`${top} L58,${n2(y + 26)} Q30,${n2(y + 31)} 2,${n2(y + 26)}Z`, C.red);
    for (let i = 1; i < 6; i++) s += line(`M${P(2 + i * 9.33, y + 3)} Q${P(2 + i * 9.33 + 1, y + 16)} ${P(2 + i * 9.33, y + 27.5)}`, C.redDk, 0.6);
    for (const cx of [13, 30, 47]) {
      s += circle(cx, y + 14, 4.3, C.white);
      s += sakura(cx, y + 14, 3.4, C.red, 0, C.white);
    }
    s += line(`M2,${n2(y + 4)} Q30,${n2(y + 10)} 58,${n2(y + 4)}`, C.gold, 1.1);
    s += path(`M2,${n2(y + 26)} Q30,${n2(y + 31)} 58,${n2(y + 26)} L58,${n2(y + 28.5)} Q30,${n2(y + 33.5)} 2,${n2(y + 28.5)}Z`, C.gold);
    return s;
  }
  function phoenix(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    const tail = [[C.red, -6], [C.gold, 4], [C.green2, 14], [C.purple, 24]].map(([c, a], i) =>
      line(`M-2,4 C${P(-10 - i * 2, 10 + i * 3)} ${P(-20 + a * 0.2, 6 + i * 6)} ${P(-26 + i * 2, 18 + i * 7)}`, c, 2.2 - i * 0.2)).join('');
    const eyes = [[-26, 18], [-24, 25], [-22, 32], [-20, 39]].map(([a, b]) => circle(a, b, 1.6, C.gold2) + circle(a, b, 0.7, C.indigo)).join('');
    return g(
      tail + eyes +
      path('M0,-2 C-6,-12 -2,-22 8,-26 C4,-19 6,-12 10,-8Z', C.vermil) +
      path('M2,-2 C2,-12 10,-20 20,-20 C14,-15 12,-9 12,-4Z', C.gold) +
      path('M4,-1 C6,-9 13,-13 19,-12 C15,-8 12,-4 10,0Z', C.green2) +
      ell(2, 2, 7, 4.6, C.red, -20) +
      line('M6,-1 C9,-6 10,-10 12,-12', C.red, 2.4) + circle(12.6, -12.8, 2.2, C.red) +
      path('M14.4,-13.4 L17.4,-12.4 L14.4,-11.6Z', C.gold) + circle(13.2, -13.4, 0.5, C.ink) +
      line('M11.5,-14.5 C11,-17 12,-18.5 13.5,-19 M12.5,-14.6 C13.5,-16.6 15,-17.4 16.4,-17.2', C.gold, 0.6), t);
  }
  function rainMan(x, y, s) {
    const t = `translate(${n2(x)} ${n2(y)}) scale(${n2(s)})`;
    return g(
      // 傘
      path('M-16,-8 C-12,-18 6,-22 14,-14 C8,-13 -6,-11 -16,-8Z', C.yellow) +
      line('M-16,-8 C-9,-10 4,-13 14,-14', C.goldDk, 0.6) +
      line('M-1,-17.5 L4,6', C.brownDk, 0.7) +
      // 人
      path('M-6,-9 C-8,-2 -9,8 -11,14 L5,14 C3,6 2,-2 1,-8Z', C.indigo) +
      path('M-6,-9 C-4,-3 -3,6 -4,14 L-2,14 C-1,6 -1,-2 1,-8Z', C.indigo2) +
      line('M-8,0 L2,-1 M-9,6 L3,5', C.gold, 0.5) +
      circle(-2.4, -11, 2.6, '#f0d7b8') + path('M-5,-12 C-4,-15 0,-15 0.4,-12.2Z', C.ink) +
      path('M-11,14 L5,14 L5,15.5 L-11,15.5Z', C.ink) +
      // 蛙
      ell(-17, 15, 3.2, 2.2, C.green2) + circle(-15.6, 13.4, 1.1, C.green2) + circle(-15.4, 13.2, 0.45, C.ink) +
      line('M-20,16 L-22,14.5 M-14.5,16.5 L-13,15', C.green2, 0.8), t);
  }
  function thunder() {
    let s = path('M0,0 H60 V58 C45,52 30,64 0,56Z', C.night);
    s += path('M30,2 L22,22 L30,22 L20,46 L38,18 L29,18 L37,2Z', C.yellow);
    for (const [cx, cy] of [[11, 14], [49, 30], [12, 40]]) {
      s += circle(cx, cy, 5.2, C.red) + circle(cx, cy, 4.2, C.redDk);
      for (let k = 0; k < 3; k++) { const [a, b] = pol(cx, cy, 1.8, k * 120); s += circle(a, b, 1.5, C.gold); }
    }
    return s;
  }
  function ribbon(x, y, deg, col, text) {
    const w = 9.5, h = 40;
    let s = path(`M0,0 L${w},0 L${w},${h} L${n2(w * 0.5)},${h - 3} L0,${h}Z`, col);
    s += path(`M0.8,0.8 L${n2(w - 0.8)},0.8 L${n2(w - 0.8)},${h - 1.2} L${n2(w * 0.5)},${h - 3.8} L0.8,${h - 1.2}Z`, 'none', `stroke="${col === C.indigo ? C.gold2 : C.gold}" stroke-width="0.4" opacity=".8"`);
    if (text) {
      const fs = text.length > 4 ? 5.6 : 6.2;
      [...text].forEach((ch, i) => { s += `<text x="${n2(w / 2)}" y="${n2(7 + i * (fs + 0.9))}" text-anchor="middle" font-size="${fs}" font-family="'Shippori Mincho B1','Yu Mincho',serif" font-weight="800" fill="${C.ink}">${ch}</text>`; });
    }
    return g(s, `translate(${n2(x)} ${n2(y)}) rotate(${n2(deg)})`);
  }

  // ------------------------------------------------------------------ 月ごとの植物（v = 札の番号の下2ビット。カスは左右の向きを変える）
  const mirror = inner => g(inner, `translate(${W} 0) scale(-1 1)`);
  const PLANT = [
    // 一月 松
    (v, kind) => {
      let s = '';
      const trunk = line('M8,96 C14,80 10,68 20,58 C28,50 38,52 46,44', C.brown, 3.4) + line('M20,58 C16,52 14,46 10,42', C.brown, 2);
      s += trunk;
      s += pineFan(14, 44, 10, C.green, C.green3) + pineFan(30, 58, 12, C.green2, C.green3) + pineFan(48, 46, 11, C.green, C.green3);
      s += pineFan(40, 74, 13, C.green, C.green3) + pineFan(18, 80, 10, C.green2, C.green3);
      if (kind === 'kasu') s += pineFan(28, 30, 9, C.green2, C.green3) + pineFan(46, 24, 7, C.green, C.green3);
      return v === 3 ? mirror(s) : s;
    },
    // 二月 梅
    (v, kind) => {
      let s = line('M6,92 L18,72 L14,60 L28,44 L26,32 L40,20', C.brownDk, 2.6) + line('M18,72 L34,66 L46,54 M28,44 L44,40 L52,30 M14,60 L6,50', C.brownDk, 1.6);
      const fl = [[24, 38, 5], [40, 21, 4.4], [44, 40, 4.6], [33, 65, 5], [47, 54, 4.2], [9, 51, 4], [52, 30, 3.6], [18, 74, 4]];
      fl.forEach(([x, y, r], i) => { s += plumFlower(x, y, r, i % 3 === 0 ? C.plum : i % 3 === 1 ? '#e05a76' : C.pink2, i * 17); });
      s += circle(36, 30, 1.6, C.plum) + circle(12, 62, 1.4, C.plum) + circle(50, 46, 1.3, '#e05a76');
      return v === 3 ? mirror(s) : s;
    },
    // 三月 桜
    (v, kind) => {
      let s = '';
      const cl = [[14, 12, 13, C.pink], [44, 10, 14, C.pink], [30, 26, 14, '#f8d3dc'], [8, 36, 9, C.pink], [52, 36, 10, '#f8d3dc']];
      cl.forEach(([x, y, r, c]) => { s += circle(x, y, r, c); });
      const fl = [[12, 10], [26, 16], [40, 8], [50, 22], [20, 30], [36, 30], [8, 38], [54, 38], [30, 4], [46, 34]];
      fl.forEach(([x, y], i) => { s += sakura(x, y, 4.4, i % 2 ? C.pink2 : '#ef7f98', i * 23); });
      if (kind === 'kasu') {
        [[12, 74], [46, 82], [20, 90], [50, 64], [8, 58]].forEach(([x, y], i) => { s += ell(x, y, 1.8, 1, C.pink2, i * 50); });
        s += line('M30,96 C28,80 34,66 30,52', C.brownDk, 2.4);
        [[22, 62], [38, 70], [26, 82], [40, 54]].forEach(([x, y], i) => { s += sakura(x, y, 4, i % 2 ? C.pink2 : C.pink, i * 31); });
      }
      return v === 3 ? mirror(s) : s;
    },
    // 四月 藤
    (v, kind) => {
      let s = path('M0,0 H60 V8 C40,14 20,6 0,10Z', C.green);
      s += leaf(6, 9, 13, 3, 70, C.green2, C.green) + leaf(52, 8, 12, 3, 110, C.green2, C.green) + leaf(30, 9, 11, 2.6, 95, C.green2, C.green);
      s += path('M0,88 C18,83 38,91 60,86 V96 H0Z', '#e3e8cf');
      [[10, 80], [22, 86], [40, 78], [50, 88], [33, 90]].forEach(([x, y], i) => { s += ell(x, y, 1.6, 0.9, i % 2 ? C.purple2 : C.lilac, i * 40); });
      s += wisteria(14, 12, 44, 2.5) + wisteria(30, 10, 54, -2) + wisteria(46, 12, 40, 3);
      if (kind === 'kasu') s += wisteria(22, 14, 30, 1.5) + wisteria(38, 12, 34, -1.5);
      return v === 3 ? mirror(s) : s;
    },
    // 五月 菖蒲
    (v, kind) => {
      let s = '';
      [[10, 96, 52, 4, 2.4], [20, 96, 66, -3, 2.2], [36, 96, 60, 5, 2.4], [48, 96, 48, -4, 2.2], [28, 96, 40, 8, 1.8], [54, 96, 36, 6, 1.8]].forEach(([x, y, h, l, w], i) => { s += blade(x, y, h, l, w, i % 2 ? C.green2 : C.green); });
      s += iris(20, 30, 8) + iris(40, 40, 7.5);
      if (kind === 'kasu') s += iris(30, 18, 6);
      return v === 3 ? mirror(s) : s;
    },
    // 六月 牡丹
    (v, kind) => {
      let s = '';
      [[10, 70, 16, -60], [48, 74, 16, -120], [20, 84, 15, -40], [40, 86, 15, -140], [30, 76, 14, -90]].forEach(([x, y, l, d], i) => { s += leaf(x, y, l, 4.5, d, i % 2 ? C.green2 : C.green, C.green3); });
      s += peony(30, 50, 15);
      if (kind === 'kasu') s += peony(14, 24, 8) + peony(46, 22, 7);
      return v === 3 ? mirror(s) : s;
    },
    // 七月 萩（下に土手）
    (v, kind) => {
      let s = path('M0,90 C14,84 30,86 44,88 C50,89 56,87 60,86 V96 H0Z', '#e6dcc2');
      s += cloverStem(6, 96, 48, 22, -10, C.green2, '#b03a78', 7, false);
      s += cloverStem(54, 96, 14, 32, 12, C.green, '#c95a92', 6, true);
      s += cloverStem(30, 96, 34, 50, 6, C.green2, '#b03a78', 4, false);
      if (kind === 'kasu') s += cloverStem(10, 60, 50, 6, -8, C.green, '#c95a92', 5, true);
      return v === 3 ? mirror(s) : s;
    },
    // 八月 芒（丘とすすき）。カスは丘を高くして、穂を風になびかせる
    (v, kind) => {
      const hi = kind === 'kasu' ? -14 : 0;
      let s = '';
      if (kind === 'kasu') s += path('M0,0 H60 V40 H0Z', '#f1e3c4');
      s += path(`M0,96 V${52 + hi} C14,${38 + hi} 30,${34 + hi} 44,${40 + hi} C52,${43 + hi} 57,${48 + hi} 60,${52 + hi} V96Z`, C.night);
      for (let i = 0; i < 12; i++) {
        const x = 4 + i * 4.8, base = 92 - (i % 3) * 3;
        s += grass(x, base, 30 + (i % 4) * 7 - hi, (i % 2 ? 6 : -4), i % 3 ? C.cream : C.gold2, 0.6);
      }
      if (kind === 'kasu') {
        for (let i = 0; i < 6; i++) {
          const x = 8 + i * 9, y = 30 + hi + (i % 2) * 6;
          s += line(`M${P(x, y + 14)} Q${P(x + 2, y + 5)} ${P(x + 7, y)}`, C.gold2, 0.7);
          for (let k = 0; k < 4; k++) s += ell(x + 4 + k * 1.3, y + 2.4 - k * 1, 1.9, 0.65, '#a9874e', -35);
        }
      }
      return v === 3 ? mirror(s) : s;
    },
    // 九月 菊
    (v, kind) => {
      let s = '';
      [[12, 80, 14, -70], [46, 82, 14, -110], [28, 88, 12, -90], [18, 64, 12, -30], [44, 66, 12, -150]].forEach(([x, y, l, d], i) => { s += leaf(x, y, l, 4, d, i % 2 ? C.green2 : C.green, C.green3); });
      s += line('M30,96 L30,60 M30,70 L18,56 M30,66 L44,50', C.green, 1.2);
      s += chrys(30, 52, 13, C.yellow, C.orange) + chrys(14, 34, 9, '#f0cf62', C.yellow) + chrys(46, 30, 9.5, C.yellow, C.orange);
      if (kind === 'kasu') s += chrys(30, 16, 8, '#f0cf62', C.orange);
      return v === 3 ? mirror(s) : s;
    },
    // 十月 紅葉
    (v, kind) => {
      let s = line('M2,30 C14,32 22,24 34,26 C44,28 50,20 58,18 M20,28 C24,40 22,52 30,62 M44,24 C46,36 52,44 50,56', C.brownDk, 1.4);
      const lv = [[10, 22, 8, -20, C.red], [24, 14, 9, 10, C.vermil], [40, 18, 8.5, -10, C.red], [54, 10, 7, 20, C.orange], [22, 44, 8, 30, C.red], [34, 58, 9, -25, C.vermil], [50, 46, 8, 15, C.red], [14, 60, 7, -40, C.orange], [46, 66, 7, 40, C.yellow]];
      lv.forEach(([x, y, r, d, c]) => { s += maple(x, y, r, d, c); });
      if (kind === 'kasu') s += maple(26, 80, 7, 10, C.red) + maple(42, 86, 6, -20, C.vermil);
      return v === 3 ? mirror(s) : s;
    },
    // 十一月 柳（下に小川）
    (v, kind) => {
      let s = path('M0,82 C16,79 36,85 60,80 V96 H0Z', '#d6e6ee', 'opacity=".9"');
      for (let k = 0; k < 3; k++) s += line(`M${P(4 + k * 3, 86 + k * 3.2)} q6,-2.2 12,0 t12,0 t12,0 t12,0`, '#8fb6cc', 0.7);
      s += line('M0,4 C18,2 32,8 60,2', C.brownDk, 1.2);
      [[6, 4, 50, 4], [14, 5, 66, -3], [24, 5, 58, 5], [34, 6, 72, -4], [44, 5, 56, 3], [54, 3, 62, -5]].forEach(([x, y, l, w]) => { s += willowStrand(x, y, l, w, C.green2); });
      return v === 3 ? mirror(s) : s;
    },
    // 十二月 桐
    (v, kind) => {
      let s = '';
      if (v === 2) s += path('M0,64 H60 V96 H0Z', C.yellow); // 色のついた桐のカス
      s += paulowniaLeaf(14, 78, 13, -25, C.green, C.green3) + paulowniaLeaf(46, 78, 13, 25, C.green, C.green3) + paulowniaLeaf(30, 72, 15, 0, C.green2, C.green3);
      s += paulowniaSpike(30, 58, 26) + paulowniaSpike(18, 62, 18) + paulowniaSpike(42, 62, 18);
      return v === 3 ? mirror(s) : s;
    },
  ];

  // ------------------------------------------------------------------ 1枚の絵
  const RED_TEXT = { 1: 'あかよろし', 5: 'あかよろし', 9: 'みよしの' };
  function art(id) {
    const m = id >> 2, v = id & 3;
    const T = root.KoikoiCore ? root.KoikoiCore.TYPE[id] : [0, 1, 2, 3][v];
    const kind = ['light', 'tane', 'tan', 'kasu'][T];
    let bg = '', s = '';
    switch (id) {
      case 0: // 松に鶴
        bg = circle(40, 24, 15, C.sky);
        s = PLANT[0](0, kind) + crane(26, 50, 1.05);
        break;
      case 8: // 桜に幕
        s = PLANT[2](0, kind) + curtain(54);
        break;
      case 28: // 芒に月
        bg = path('M0,0 H60 V60 H0Z', C.sky);
        s = circle(30, 30, 17, C.cream) + circle(30, 30, 17, 'none', `stroke="${C.gold2}" stroke-width=".6"`) + PLANT[7](0, kind);
        break;
      case 40: // 柳に小野道風
        bg = path('M0,0 H60 V96 H0Z', '#2b3448');
        s = PLANT[10](0, kind);
        for (let i = 0; i < 14; i++) s += line(`M${n2(i * 5 - 6)},${n2(10 + (i % 3) * 8)} l-6,14`, '#9fb4d0', 0.4, 'opacity=".7"');
        s += rainMan(36, 62, 1.15) + path('M0,84 H60 V96 H0Z', '#3a6b4a') + line('M0,84 C20,82 40,86 60,83', '#5b8a5c', 1.2);
        break;
      case 44: // 桐に鳳凰
        s = PLANT[11](0, kind) + phoenix(34, 30, 0.95);
        break;
      case 4: s = PLANT[1](0, kind) + bird(30, 50, 0.95, C.moss, '#c8cf7a', false); break;          // 梅に鶯
      case 12: s = PLANT[3](0, kind) + circle(44, 70, 7.5, C.yellow) + circle(47, 68, 6.6, C.paper) + flyingBird(26, 76, 0.95, '#3d3a3f', '#c9c2b2', -14); break; // 藤に不如帰
      case 16: s = PLANT[4](0, kind) + bridge(76); break;                                        // 菖蒲に八橋
      case 20: s = PLANT[5](0, kind) + butterfly(16, 22, 1, C.indigo2, C.purple2, -20) + butterfly(44, 26, 0.85, C.yellow, C.orange, 15); break; // 牡丹に蝶
      case 24: s = PLANT[6](0, kind) + boar(30, 70, 0.95); break;                                // 萩に猪
      case 29: // 芒に雁
        bg = path('M0,0 H60 V58 H0Z', '#efd9a8');
        s = PLANT[7](1, kind) + goose(16, 22, 1.1, C.ink) + goose(30, 16, 1.2, C.ink) + goose(44, 24, 1.05, C.ink);
        break;
      case 32: s = PLANT[8](0, kind) + sakeCup(30, 80, 1); break;                                // 菊に盃
      case 36: s = PLANT[9](0, kind) + deer(26, 76, 0.95); break;                                // 紅葉に鹿
      case 41: // 柳に燕
        s = PLANT[10](1, kind) + swallow(30, 58, 1.15, -18) + path('M0,88 H60 V96 H0Z', '#5f8f5a');
        break;
      case 43: // 柳のカス（雷）
        s = thunder() + PLANT[10](3, kind);
        break;
      default:
        if (T === 2) { // タン
          const col = [21, 33, 37].includes(id) ? C.indigo : C.red;
          s = PLANT[m](v, kind) + ribbon(25, 14, -10, col, RED_TEXT[id] || '');
        } else s = PLANT[m](v, kind);
    }
    const frame = T === 0 ? C.gold : C.paper2;
    return `<rect x="0" y="0" width="${W}" height="${H}" rx="4.5" fill="${C.paper}"/>${bg ? `<clipPath id="kc-cl${id}"><rect width="${W}" height="${H}" rx="4.5"/></clipPath><g clip-path="url(#kc-cl${id})">${bg}${s}</g>` : `<g clip-path="url(#kc-clip)">${s}</g>`}` +
      `<rect x="1.4" y="1.4" width="${W - 2.8}" height="${H - 2.8}" rx="3.4" fill="none" stroke="${frame}" stroke-width="${T === 0 ? 1.1 : 0.8}"/>`;
  }
  function back() {
    let s = `<rect width="${W}" height="${H}" rx="4.5" fill="#7a1f1a"/>`;
    // 青海波（金の細い線）
    let waves = '';
    for (let row = 0; row < 14; row++) {
      for (let col = -1; col < 8; col++) {
        const cx = col * 9 + (row % 2 ? 4.5 : 0), cy = row * 7.5;
        for (const r of [4.4, 3.1, 1.8]) waves += `<path d="M${P(cx - r, cy)} A${r} ${r} 0 0 1 ${P(cx + r, cy)}" fill="none" stroke="#c8a046" stroke-width=".35" opacity=".55"/>`;
      }
    }
    s += `<g clip-path="url(#kc-clip)">${waves}</g>`;
    s += `<rect x="5" y="5" width="${W - 10}" height="${H - 10}" rx="2.5" fill="none" stroke="#e4c574" stroke-width=".7"/>`;
    s += circle(30, 48, 9.5, '#7a1f1a') + circle(30, 48, 9.5, 'none', 'stroke="#e4c574" stroke-width=".8"');
    s += sakura(30, 48, 7, '#e4c574', 0, '#7a1f1a');
    return s;
  }

  // 左上の月の印・右下の種類の印（初めての人向け。設定で消せる）
  const TAG = ['光', '種', '短', ''];
  const TAGCOL = ['#b8861f', '#c4402c', '#2f4f86', ''];
  function tag(id) {
    const m = id >> 2, T = root.KoikoiCore ? root.KoikoiCore.TYPE[id] : 3;
    const mk = (root.KoikoiCore ? root.KoikoiCore.MONTHS[m] : '') || '';
    let s = `<g class="kc-tag"><rect x="2.6" y="2.6" width="${mk.length > 1 ? 15 : 9.6}" height="9.6" rx="2.2" fill="${C.white}" opacity=".92"/>` +
      `<text x="${mk.length > 1 ? 10.1 : 7.4}" y="10.3" text-anchor="middle" font-size="${mk.length > 1 ? 6 : 7}" font-family="'Shippori Mincho B1','Yu Mincho',serif" font-weight="800" fill="${C.ink}">${mk}</text>`;
    if (TAG[T]) s += `<circle cx="51.6" cy="87.4" r="5.6" fill="${TAGCOL[T]}"/><text x="51.6" y="90" text-anchor="middle" font-size="7" font-family="'Shippori Mincho B1','Yu Mincho',serif" font-weight="800" fill="#fff">${TAG[T]}</text>`;
    return s + '</g>';
  }

  let spriteCache = '';
  function sprite() {
    if (spriteCache) return spriteCache;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs><clipPath id="kc-clip"><rect width="${W}" height="${H}" rx="4.5"/></clipPath>`;
    for (let id = 0; id < 48; id++) s += `<symbol id="kc-${id}" viewBox="0 0 ${W} ${H}">${art(id)}</symbol>`;
    s += `<symbol id="kc-back" viewBox="0 0 ${W} ${H}">${back()}</symbol>`;
    s += '</defs></svg>';
    spriteCache = s;
    return s;
  }
  // 1枚（<svg> の文字列）。id < 0 なら裏
  function svg(id, opts) {
    opts = opts || {};
    const ref = id < 0 ? 'kc-back' : `kc-${id}`;
    return `<svg class="kc" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false"><use href="#${ref}"/>${opts.tag && id >= 0 ? tag(id) : ''}</svg>`;
  }

  const api = { W, H, sprite, svg, art, tag, COLORS: C };
  root.KoikoiCards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
