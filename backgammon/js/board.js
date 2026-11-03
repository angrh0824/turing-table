/* バックギャモンの盤（自作の SVG）: 木の枠・革のポイント・駒・キューブ・ハイライト・動き（common/motion.js）
 *
 * 場所（slot）は下側の対局者から見た番号で表す:
 *   0..23 … 下側から見た (i+1) のポイント（0..5 が右下 = 下側のホーム）
 *   24 = 下側のバー（バーの上半分に置く。上側のホームに入る駒なので）、25 = 上側のバー（下半分）
 *   26 = 下側の上がり（右の受け皿の下半分）、27 = 上側の上がり（上半分）
 * mirror = true でホームを左側に（左右を反転。文字は反転しない）
 *
 * 層（下から）: 盤 → 直前の手の印 → 駒（駒の並びが変わったときだけ描き直す。つかんでいる駒が消えないように）
 *   → 操作の印（動かせる駒の輪・暗くする層・行き先・矢印）→ 当たり判定 → キューブ・札（押せる）→ 飛んでいる駒
 *   サイコロは盤の上に重ねた HTML の立方体（TTMotion.dice で転がす）
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const M = () => root.TTMotion;
  // 盤の寸法（viewBox の単位）
  const FT = 26, PW = 58, CD = 54, R = CD / 2, PH = 5 * CD, MG = 74;
  const LX = 26, BARX = LX + 6 * PW, BW = 56, RX = BARX + BW, RX2 = RX + 6 * PW, IFR = 24, TX = RX2 + IFR, TW = 64, OFR = 20;
  const W = TX + TW + OFR, H = FT + PH + MG + PH + FT, MID = H / 2;
  const SLAB = 16, DIE = 62;   // サイコロの一辺（スマホでも読める大きさに。5枚の山とは重ならない）

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  // 細かい粒のテクスチャ（canvas で作って模様に使う。フィルタより軽い）
  let grainURL = null;
  function grain() {
    if (grainURL) return grainURL;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 96;
      const g = c.getContext('2d'), d = g.createImageData(96, 96);
      let s = 1234567;
      for (let i = 0; i < d.data.length; i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const v = (s >> 8) & 255;
        d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 26;
      }
      g.putImageData(d, 0, 0);
      grainURL = c.toDataURL();
    } catch (e) { grainURL = ''; }
    return grainURL;
  }
  // 動き（motion.js がなければ一瞬で）。画面が描かれず requestAnimationFrame が止まっていても、少し待てば先へ進む
  function tween(ms, step) {
    if (!M()) { step(1); return Promise.resolve(); }
    let timer = 0;
    const late = new Promise(res => { timer = setTimeout(() => { step(1); res(); }, ms + 350); });
    return Promise.race([M().tween(ms, step).then(() => clearTimeout(timer)), late]);
  }

  function create(svg, opt) {
    opt = opt || {};
    const uid = 'bgb' + Math.random().toString(36).slice(2, 7);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    const defs = el('defs', null, svg);
    defs.innerHTML = `
      <linearGradient id="${uid}-wood" x1="0" y1="0" x2="1" y2="0.18">
        <stop offset="0" stop-color="var(--wood-a)"/><stop offset=".18" stop-color="var(--wood-b)"/><stop offset=".33" stop-color="var(--wood-a)"/>
        <stop offset=".52" stop-color="var(--wood-c)"/><stop offset=".7" stop-color="var(--wood-b)"/><stop offset=".86" stop-color="var(--wood-a)"/><stop offset="1" stop-color="var(--wood-c)"/>
      </linearGradient>
      <linearGradient id="${uid}-woodv" x1="0" y1="0" x2="0.15" y2="1">
        <stop offset="0" stop-color="var(--wood-b)"/><stop offset=".3" stop-color="var(--wood-a)"/><stop offset=".55" stop-color="var(--wood-c)"/><stop offset=".8" stop-color="var(--wood-a)"/><stop offset="1" stop-color="var(--wood-b)"/>
      </linearGradient>
      <radialGradient id="${uid}-felt" cx=".5" cy=".5" r=".75"><stop offset="0" stop-color="var(--field-a)"/><stop offset="1" stop-color="var(--field-b)"/></radialGradient>
      <linearGradient id="${uid}-ptA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--pt-a1)"/><stop offset="1" stop-color="var(--pt-a2)"/></linearGradient>
      <linearGradient id="${uid}-ptB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--pt-b1)"/><stop offset="1" stop-color="var(--pt-b2)"/></linearGradient>
      <radialGradient id="${uid}-cw" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="var(--ck-w1)"/><stop offset=".62" stop-color="var(--ck-w2)"/><stop offset="1" stop-color="var(--ck-w3)"/></radialGradient>
      <radialGradient id="${uid}-cb" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="var(--ck-b1)"/><stop offset=".62" stop-color="var(--ck-b2)"/><stop offset="1" stop-color="var(--ck-b3)"/></radialGradient>
      <linearGradient id="${uid}-cube" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbf6ea"/><stop offset="1" stop-color="#d9ccb0"/></linearGradient>
      ${grain() ? `<pattern id="${uid}-grain" width="96" height="96" patternUnits="userSpaceOnUse"><image href="${grain()}" width="96" height="96"/></pattern>` : ''}`;
    const gStatic = el('g', { class: 'bg-static' }, svg);
    const gUnder = el('g', { class: 'bg-under', 'pointer-events': 'none' }, svg);
    const gCk = el('g', { class: 'bg-ck' }, svg);
    const gUi = el('g', { class: 'bg-ui', 'pointer-events': 'none' }, svg);
    const gHit = el('g', { class: 'bg-hit' }, svg);
    const gTop = el('g', { class: 'bg-top' }, svg);
    const gFx = el('g', { class: 'bg-fx', 'pointer-events': 'none' }, svg);
    // サイコロの層（盤に重ねた HTML。大きさは盤の幅に合わせる）
    // （ルールのページの小さな図は DOM の外で描くので、サイコロの層は作らない）
    const wrap = svg.parentNode;
    const layer = wrap ? document.createElement('div') : null;
    let dieW = 0;
    const sizeDice = () => {
      if (!layer) return;
      const w = svg.getBoundingClientRect().width;
      if (w && Math.abs(w - dieW) > 0.5) { dieW = w; layer.style.setProperty('--tt-die-size', (w * DIE / W).toFixed(1) + 'px'); }
    };
    if (layer) {
      layer.className = 'bg-dice-layer';
      wrap.appendChild(layer);
      if (window.ResizeObserver) new ResizeObserver(sizeDice).observe(wrap); else window.addEventListener('resize', sizeDice);
    }
    let mirror = !!opt.mirror, numbers = opt.numbers !== false, numPersp = 0;
    const X = x => (mirror ? W - x : x);

    // ポイント i（下側から見た番号）の中心の x
    function ptX(i) {
      if (i < 6) return RX2 - (i + 0.5) * PW;
      if (i < 12) return BARX - (i - 6 + 0.5) * PW;
      if (i < 18) return LX + (i - 12 + 0.5) * PW;
      return RX + (i - 18 + 0.5) * PW;
    }
    // 場所 slot の k 枚目（0 = 端から1枚目）の中心
    function slotXY(slot, k) {
      if (slot < 24) {
        const kk = Math.min(k, 4), x = X(ptX(slot));
        return slot < 12 ? [x, H - FT - R - kk * CD] : [x, FT + R + kk * CD];
      }
      if (slot === 24) return [X(BARX + BW / 2), MID - R - 14 - Math.min(k, 3) * (CD - 6)];
      if (slot === 25) return [X(BARX + BW / 2), MID + R + 14 + Math.min(k, 3) * (CD - 6)];
      const x = X(TX + TW / 2);
      if (slot === 26) return [x, H - FT - SLAB / 2 - 2 - Math.min(k, 14) * SLAB];
      return [x, FT + SLAB / 2 + 2 + Math.min(k, 14) * SLAB];
    }

    function drawStatic() {
      gStatic.innerHTML = '';
      el('rect', { x: 0, y: 0, width: W, height: H, rx: 18, fill: `url(#${uid}-wood)` }, gStatic);
      if (grain()) el('rect', { x: 0, y: 0, width: W, height: H, rx: 18, fill: `url(#${uid}-grain)`, opacity: 0.9 }, gStatic);
      el('rect', { x: 3, y: 3, width: W - 6, height: H - 6, rx: 15, fill: 'none', stroke: 'rgba(255,240,210,.22)', 'stroke-width': 2 }, gStatic);
      for (const x0 of [LX, RX]) {
        const x = mirror ? W - x0 - 6 * PW : x0;
        el('rect', { x: x - 3, y: FT - 3, width: 6 * PW + 6, height: H - 2 * FT + 6, rx: 6, fill: 'rgba(0,0,0,.35)' }, gStatic);
        el('rect', { x, y: FT, width: 6 * PW, height: H - 2 * FT, rx: 4, fill: `url(#${uid}-felt)` }, gStatic);
        if (grain()) el('rect', { x, y: FT, width: 6 * PW, height: H - 2 * FT, rx: 4, fill: `url(#${uid}-grain)` }, gStatic);
        el('rect', { x: x + 5, y: FT + 5, width: 6 * PW - 10, height: H - 2 * FT - 10, rx: 3, fill: 'none', stroke: 'var(--stitch)', 'stroke-width': 1.6, 'stroke-dasharray': '5 4', opacity: 0.55 }, gStatic);
      }
      for (let i = 0; i < 24; i++) {
        const cx = X(ptX(i)), top = i >= 12, tip = PH - 6;
        const y0 = top ? FT : H - FT, y1 = top ? FT + tip : H - FT - tip;
        const d = `M${cx - PW / 2 + 3} ${y0} L${cx} ${y1} L${cx + PW / 2 - 3} ${y0} Z`;
        const alt = i % 2 === 0 ? 'A' : 'B';
        el('path', { d, fill: `url(#${uid}-pt${alt})` }, gStatic);
        const di = 5, d2 = `M${cx - PW / 2 + 3 + di} ${y0 + (top ? 2 : -2)} L${cx} ${y1 + (top ? -14 : 14)} L${cx + PW / 2 - 3 - di} ${y0 + (top ? 2 : -2)}`;
        el('path', { d: d2, fill: 'none', stroke: alt === 'A' ? 'var(--stitch-a)' : 'var(--stitch-b)', 'stroke-width': 1.4, 'stroke-dasharray': '4 3.5', opacity: 0.75 }, gStatic);
      }
      el('rect', { x: X(BARX + BW) - (mirror ? 0 : BW), y: 0, width: BW, height: H, fill: `url(#${uid}-woodv)` }, gStatic);
      el('rect', { x: mirror ? X(BARX + BW) : BARX, y: 0, width: 2, height: H, fill: 'rgba(0,0,0,.25)' }, gStatic);
      el('rect', { x: (mirror ? X(BARX + BW) : BARX) + BW - 2, y: 0, width: 2, height: H, fill: 'rgba(0,0,0,.25)' }, gStatic);
      const tx = mirror ? W - TX - TW : TX;
      for (const [y, h] of [[FT, PH], [H - FT - PH, PH]]) {
        el('rect', { x: tx, y, width: TW, height: h, rx: 6, fill: 'var(--tray)' }, gStatic);
        el('rect', { x: tx + 1, y: y + 1, width: TW - 2, height: h - 2, rx: 5, fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': 2 }, gStatic);
        el('rect', { x: tx + 5, y: y + 5, width: TW - 10, height: h - 10, rx: 3, fill: 'none', stroke: 'var(--stitch)', 'stroke-width': 1.3, 'stroke-dasharray': '4 3.5', opacity: 0.5 }, gStatic);
      }
      if (numbers) {
        const g = el('g', { class: 'ptnum' }, gStatic);
        for (let i = 0; i < 24; i++) {
          const n = numPersp === 0 ? i + 1 : 24 - i;
          const t = el('text', { x: X(ptX(i)), y: i < 12 ? H - 8 : 19, 'text-anchor': 'middle' }, g);
          t.textContent = n;
        }
      }
    }

    // 駒（木の挽き物: 同心円の溝と縁）
    function checker(parent, x, y, color, extra) {
      const g = el('g', Object.assign({ class: 'ck ck-' + color, transform: `translate(${x} ${y})` }, extra || {}), parent);
      el('circle', { r: R - 0.5, cy: 2.2, fill: 'rgba(0,0,0,.38)' }, g);
      el('circle', { r: R - 1, fill: `url(#${uid}-c${color})`, stroke: color === 'w' ? 'var(--ck-w-edge)' : 'var(--ck-b-edge)', 'stroke-width': 1.6 }, g);
      el('circle', { r: R * 0.74, fill: 'none', stroke: color === 'w' ? 'rgba(120,90,40,.32)' : 'rgba(255,200,170,.16)', 'stroke-width': 1.4 }, g);
      el('circle', { r: R * 0.5, fill: 'none', stroke: color === 'w' ? 'rgba(120,90,40,.22)' : 'rgba(255,200,170,.11)', 'stroke-width': 1.1 }, g);
      el('ellipse', { rx: R * 0.42, ry: R * 0.2, cx: -R * 0.22, cy: -R * 0.48, fill: 'rgba(255,255,255,.22)' }, g);
      return g;
    }
    function slab(parent, x, y, color) {
      const g = el('g', { transform: `translate(${x} ${y})` }, parent);
      el('rect', { x: -25, y: -SLAB / 2 + 1, width: 50, height: SLAB - 2, rx: 4, fill: color === 'w' ? 'var(--ck-w2)' : 'var(--ck-b2)', stroke: color === 'w' ? 'var(--ck-w-edge)' : 'var(--ck-b-edge)', 'stroke-width': 1.2 }, g);
      el('rect', { x: -21, y: -SLAB / 2 + 3, width: 42, height: 3, rx: 1.5, fill: 'rgba(255,255,255,.18)' }, g);
      return g;
    }
    function cube(parent, x, y, v, opts) {
      opts = opts || {};
      const s = 46;
      const g = el('g', { class: 'cube' + (opts.offer ? ' offer' : ''), transform: `translate(${x} ${y})` }, parent);
      el('rect', { x: -s / 2 + 1, y: -s / 2 + 3, width: s, height: s, rx: 8, fill: 'rgba(0,0,0,.35)' }, g);
      el('rect', { x: -s / 2, y: -s / 2, width: s, height: s, rx: 8, fill: `url(#${uid}-cube)`, stroke: '#8b7a58', 'stroke-width': 1.6 }, g);
      const t = el('text', { y: 8.5, 'text-anchor': 'middle', class: 'cubetxt' }, g);
      t.textContent = v === 1 ? '64' : String(v);
      return g;
    }

    let model = null, ckSig = '', tops = {}, counts = null, destEls = {};
    // 盤を描く（model は app.js が作る。説明は先頭のコメント）
    function render(m) {
      model = m;
      if ((m.mirror != null && !!m.mirror !== mirror) || (m.numbers != null && !!m.numbers !== numbers) || (m.numPersp != null && m.numPersp !== numPersp) || !gStatic.firstChild) {
        mirror = !!m.mirror; numbers = m.numbers !== false; numPersp = m.numPersp || 0;
        drawStatic(); drawHit(); ckSig = '';
      }
      const ui = m.ui || {};
      counts = slotCounts(m);
      const colorOf = slot => (slot === 24 || slot === 26 ? m.bottom.color : slot === 25 || slot === 27 ? m.top.color : counts.color[slot]);
      // 直前の手（元の場所と行き先をうっすら）
      gUnder.innerHTML = '';
      if (ui.last) for (const s of ui.last) markSlot(gUnder, s, 'lastmark');
      // 駒（並びが変わったときだけ描き直す）
      const sig = counts.n.join(',') + '|' + counts.color.join(',') + '|' + m.bottom.color + m.top.color + (mirror ? 'm' : '');
      if (sig !== ckSig) {
        ckSig = sig;
        gCk.innerHTML = '';
        tops = {};
        for (let s = 0; s < 26; s++) {
          const n = counts.n[s];
          if (!n) continue;
          const c = colorOf(s);
          const vis = Math.min(n, s >= 24 ? 4 : 5);
          for (let k = 0; k < vis; k++) {
            const [x, y] = slotXY(s, k);
            const g = checker(gCk, x, y, c, { 'data-slot': s });
            if (k === vis - 1) tops[s] = g;
          }
          // 5枚（バーは4枚）より多いときは、いちばん上の駒に枚数を（丸い札で読みやすく）
          if (n > vis) {
            const [x, y] = slotXY(s, vis - 1);
            const g = el('g', { class: 'cnt cnt-' + c, transform: `translate(${x} ${y})`, 'pointer-events': 'none' }, gCk);
            el('circle', { r: 15 }, g);
            const t = el('text', { y: 8, 'text-anchor': 'middle' }, g);
            t.textContent = n;
          }
        }
        for (const s of [26, 27]) {
          const n = counts.n[s], c = colorOf(s);
          for (let k = 0; k < n; k++) { const [x, y] = slotXY(s, k); slab(gCk, x, y, c); }
          if (n >= 10) {
            const [x, y] = slotXY(s, n - 1);
            const g = el('g', { class: 'cnt cnt-' + c + ' offcnt', transform: `translate(${x} ${y + (s === 26 ? -22 : 22)})`, 'pointer-events': 'none' }, gCk);
            el('circle', { r: 13 }, g);
            const t = el('text', { y: 7, 'text-anchor': 'middle' }, g);
            t.textContent = n;
          }
        }
      }
      // 操作の印
      gUi.innerHTML = '';
      destEls = {};
      if (ui.movable && !ui.dests) for (const s of ui.movable) ring(s, 'movring');
      if (ui.dests) {
        el('path', { d: dimPath(ui.dests.concat([ui.sel])), class: 'dimmer', 'fill-rule': 'evenodd' }, gUi);
        for (const s of ui.dests) destEls[s] = destMark(gUi, s, counts.n[s], !!(ui.hits && ui.hits.includes(s)));
        if (ui.sel != null) ring(ui.sel, 'selring');
      }
      if (ui.arrows && ui.arrows.length) drawArrows(gUi, ui.arrows, counts);
      // キューブ・説明の札（押せるので当たり判定より上）
      gTop.innerHTML = '';
      if (m.cube && m.cube.show) {
        if (m.cube.offer) {
          const ox = m.cube.offer === 'top' ? (LX + 3 * PW) : (RX + 3 * PW);
          cube(gTop, X(ox), MID, m.cube.value, { offer: true }).setAttribute('pointer-events', 'none');
        } else {
          const y = m.cube.pos === 'bottom' ? MID + 64 : m.cube.pos === 'top' ? MID - 64 : MID;
          const g = cube(gTop, X(TX + TW / 2), y, m.cube.value);
          if (m.cube.clickable) { g.classList.add('clickable'); g.setAttribute('data-act', 'cube'); } else g.setAttribute('pointer-events', 'none');
        }
      }
      if (m.banner) {
        const bx = m.banner.side === 'top' ? (LX + 3 * PW) : m.banner.side === 'bottom' ? (RX + 3 * PW) : (BARX + BW / 2);
        const g = el('g', { class: 'banner' + (m.banner.act ? ' clickable' : ''), 'data-act': m.banner.act || null, 'pointer-events': m.banner.act ? null : 'none' }, gTop);
        const w = Math.min(6 * PW - 12, Math.max(110, m.banner.text.length * 27 + 40));
        el('rect', { x: X(bx) - w / 2, y: MID - 26, width: w, height: 52, rx: 26 }, g);
        const t = el('text', { x: X(bx), y: MID + 10, 'text-anchor': 'middle' }, g);
        t.textContent = m.banner.text;
      }
      renderDice(m.dice || []);
    }
    function ring(s, cls) {
      const n = counts.n[s];
      if (!n || s >= 26) return;
      const [x, y] = slotXY(s, Math.min(n, s >= 24 ? 4 : 5) - 1);
      el('circle', { cx: x, cy: y, r: R + 1, class: cls }, gUi);
    }

    // ---- サイコロ（HTML の立方体。m.dice = [{ side:'bottom'|'top', vals, color, used, rolling, clickable }]）
    let dieEls = [], rollJobs = [];
    function renderDice(groups) {
      if (!layer) return;
      sizeDice();
      const want = [];
      groups.forEach((dg, gi) => {
        const cx = dg.side === 'top' ? (LX + 3 * PW) : (RX + 3 * PW);
        const n = dg.vals.length, gap = n > 2 ? 72 : 80;
        dg.vals.forEach((v, i) => want.push({ x: X(cx + (i - (n - 1) / 2) * gap), v, color: dg.color, used: dg.used && dg.used[i], click: dg.clickable, roll: dg.rolling && i < 2, extra: dg.rolling && i >= 2, key: gi + ':' + i }));
      });
      while (dieEls.length < want.length) {
        const d = document.createElement('span');
        d.className = 'bgdie';
        layer.appendChild(d);
        dieEls.push(d);
      }
      dieEls.forEach((d, i) => {
        const w = want[i];
        if (!w) { d.hidden = true; d._v = 0; return; }
        d.hidden = false;
        d.style.left = (w.x / W * 100) + '%';
        d.style.top = (MID / H * 100) + '%';
        d.classList.toggle('w', w.color === 'w');
        d.classList.toggle('b', w.color !== 'w');
        d.classList.toggle('used', !!w.used);
        d.classList.toggle('clickable', !!w.click);
        d.classList.toggle('extra', !!w.extra);
        if (w.click) d.setAttribute('data-act', 'dice'); else d.removeAttribute('data-act');
        d._roll = w.roll; d._extra = w.extra;
        if (d._v !== w.v || d._key !== w.key) {
          d._v = w.v; d._key = w.key;
          if (M()) M().dice(d, w.v, { roll: false }); else d.textContent = w.v;
        }
      });
    }
    // 転がす: render で rolling にしたサイコロを、その目まで転がす。ゾロ目は2個が止まってから残りの2個が出る
    function rollDice() {
      const mo = M();
      if (!mo) return Promise.resolve();
      const roll = dieEls.filter(d => !d.hidden && d._roll), extra = dieEls.filter(d => !d.hidden && d._extra);
      extra.forEach(d => { d.style.visibility = 'hidden'; });
      return Promise.all(roll.map(d => mo.dice(d, d._v))).then(() => {
        if (!extra.length) return;
        extra.forEach(d => { d.style.visibility = ''; mo.enter(d, { from: 0.4, ms: 220 }); });
        const r0 = roll[0].getBoundingClientRect(), r1 = extra[extra.length - 1].getBoundingClientRect();
        mo.float('ゾロ目（4回）', { left: r0.left, top: r0.top - r0.height * 0.9, width: r1.right - r0.left, height: r0.height }, { size: 15, color: '#ffe08a', ms: 1100 });
      });
    }

    function slotCounts(m) {
      const n = new Array(28).fill(0), color = new Array(24).fill(null);
      const b = m.bottom.arr, t = m.top.arr;
      for (let i = 0; i < 24; i++) {
        if (b[i] > 0) { n[i] = b[i]; color[i] = m.bottom.color; }
        if (t[23 - i] > 0) { n[i] = t[23 - i]; color[i] = m.top.color; }
      }
      n[24] = b[24]; n[25] = t[24];
      let sb = 0, st = 0;
      for (let i = 0; i < 25; i++) { sb += b[i]; st += t[i]; }
      n[26] = 15 - sb - ((m.flying && m.flying.bottom) || 0); n[27] = 15 - st - ((m.flying && m.flying.top) || 0); // 飛んでいる途中の駒は上がりに数えない
      return { n, color };
    }
    // 場所の当たり範囲
    function slotRect(s) {
      if (s < 24) { const cx = X(ptX(s)); return s < 12 ? [cx - PW / 2, MID + 4, PW, H - FT - MID - 4] : [cx - PW / 2, FT, PW, MID - 4 - FT]; }
      if (s === 24) return [X(BARX + BW / 2) - BW / 2, FT, BW, MID - FT];
      if (s === 25) return [X(BARX + BW / 2) - BW / 2, MID, BW, H - FT - MID];
      const tx = mirror ? W - TX - TW : TX;
      return s === 26 ? [tx, MID, TW, H - MID - FT] : [tx, FT, TW, MID - FT];
    }
    function drawHit() {
      gHit.innerHTML = '';
      for (let s = 0; s < 28; s++) {
        const [x, y, w, h] = slotRect(s);
        el('rect', { x, y, width: w, height: h, fill: 'transparent', 'data-slot': s, class: 'hitbox' }, gHit);
      }
    }
    function dimPath(keep) {
      let d = `M0 0H${W}V${H}H0Z`;
      for (const s of keep) {
        if (s == null) continue;
        const [x, y, w, h] = slotRect(s);
        d += `M${x} ${y}h${w}v${h}h${-w}Z`;
      }
      return d;
    }
    function markSlot(parent, s, cls) {
      if (s >= 26 || s < 0) return;
      const [x, y, w, h] = slotRect(s);
      el('rect', { x: x + 3, y: s < 24 ? (s < 12 ? y + h - 8 : y + 2) : y + 2, width: w - 6, height: s < 24 ? 6 : h - 4, rx: 3, class: cls }, parent);
    }
    function destMark(parent, s, n, hit) {
      const [x, y, w, h] = slotRect(s);
      const r = el('rect', { x: x + 2, y: y + 2, width: w - 4, height: h - 4, rx: 6, class: 'destglow' + (hit ? ' hit' : ''), 'data-slot': s }, parent);
      if (s >= 26) return r;
      const [cx, cy] = slotXY(s, hit ? 0 : n);
      el('circle', { cx, cy, r: R - 4, class: hit ? 'destring hit' : 'destring' }, parent);
      return r;
    }
    function drawArrows(parent, arrows, cnt) {
      const used = {};
      for (const a of arrows) {
        const kf = Math.max(0, (cnt.n[a.from] || 1) - 1 - (used['f' + a.from] || 0));
        used['f' + a.from] = (used['f' + a.from] || 0) + 1;
        const kt = (cnt.n[a.to] || 0) + (used['t' + a.to] || 0);
        used['t' + a.to] = (used['t' + a.to] || 0) + 1;
        const [x1, y1] = slotXY(a.from, kf), [x2, y2] = slotXY(a.to, a.to >= 26 ? cnt.n[a.to] : Math.min(kt, 4));
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 + (Math.abs(x2 - x1) < 10 ? 0 : (y1 < MID ? 40 : -40));
        el('path', { d: `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`, class: 'arrow' + (a.cls ? ' ' + a.cls : '') }, parent);
        el('circle', { cx: x2, cy: y2, r: 7, class: 'arrowhead' + (a.cls ? ' ' + a.cls : '') }, parent);
      }
    }

    // ---- 駒が動く（TTMotion.tween。山なりに飛ぶ。上がりは受け皿へ吸い込まれて薄い板になる）
    function fly(x1, y1, to, k2, color, ms) {
      const [x2, y2] = slotXY(to, k2);
      const g = checker(gFx, x1, y1, color);
      const dist = Math.hypot(x2 - x1, y2 - y1), lift = Math.min(70, 14 + dist * 0.12);
      const off = to >= 26;
      return tween(ms, t => {
        const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t - Math.sin(Math.PI * t) * lift;
        const s = 1 + Math.sin(Math.PI * t) * 0.08;
        g.setAttribute('transform', off && t > 0.6 ? `translate(${x} ${y}) scale(${s} ${s * (1 - (t - 0.6) / 0.4 * 0.7)})` : `translate(${x} ${y}) scale(${s})`);
      }).then(() => { g.remove(); });
    }
    // 1枚の駒を from の k1 枚目から to の k2 枚目へ
    function animate(from, k1, to, k2, color, ms) {
      if (from >= 26) return Promise.resolve();
      const [x1, y1] = slotXY(from, k1);
      return fly(x1, y1, to, k2, color, ms);
    }
    // つかんで離した場所（画面の座標の四角）から、to の k2 枚目へ吸い付く
    function animateFrom(rect, to, k2, color, ms) {
      const p = toSVG(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!p) return Promise.resolve();
      return fly(p.x, p.y, to, k2, color, ms);
    }
    function clearFx() { gFx.innerHTML = ''; }
    function toSVG(cx, cy) {
      const ctm = svg.getScreenCTM(); if (!ctm) return null;
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      return pt.matrixTransform(ctm.inverse());
    }
    // クリックされた場所（slot）・サイコロ・キューブ
    function hitTest(target) {
      const a = target.closest && target.closest('[data-act]');
      if (a) return { act: a.getAttribute('data-act') };
      const s = target.closest && target.closest('[data-slot]');
      if (s) return { slot: Number(s.getAttribute('data-slot')) };
      return null;
    }
    // 画面上の座標を場所に
    function slotAt(clientX, clientY) {
      const p = toSVG(clientX, clientY);
      if (!p) return null;
      for (let s = 0; s < 28; s++) { const [x, y, w, h] = slotRect(s); if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return s; }
      return null;
    }
    // 長押しで大きく見るための写し: 盤のうち slot（または 'cube'）の部分だけを切り出した SVG（px の大きさで）
    function zoomView(slot, pxW, pxH) {
      let vb;
      if (slot === 'cube') { const c = gTop.querySelector('.cube'); if (!c) return null; const b = c.getBBox(); vb = [b.x - 8, b.y - 8, b.width + 16, b.height + 16]; }
      else vb = slotRect(slot);
      const c = svg.cloneNode(true);
      c.removeAttribute('id');
      c.querySelectorAll('.bg-hit, .bg-fx, .bg-ui').forEach(n => n.remove());
      c.setAttribute('viewBox', vb.join(' '));
      c.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      Object.assign(c.style, { width: pxW + 'px', height: pxH + 'px', borderRadius: '6px', boxShadow: 'none' });
      return c;
    }
    const cubeEl = () => gTop.querySelector('.cube');
    drawStatic(); drawHit();
    return {
      render, animate, animateFrom, rollDice, clearFx, hitTest, slotAt, slotXY, zoomView, cubeEl,
      topChecker: s => tops[s] || null, destEl: s => destEls[s] || null,
      hitEl: s => gHit.querySelector(`[data-slot="${s}"]`),
      countAt: s => (counts ? counts.n[s] : 0),
      colorAt: s => (!model ? null : s === 24 || s === 26 ? model.bottom.color : s === 25 || s === 27 ? model.top.color : counts && counts.color[s]),
      get model() { return model; }, W, H, svg,
    };
  }

  root.BGBoard = { create, W, H };
})(typeof self !== 'undefined' ? self : this);
