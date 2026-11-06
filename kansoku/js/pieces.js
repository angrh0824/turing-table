/* 駒の絵: 五角形の駒と、駒に書く字（明朝体。index.html で駒の字だけの Web フォントを読み込む）
 *   KansokuPieces.koma(t, gote, opts) → 確定した駒の SVG（t は駒の種類 1..15。gote なら180度回す）
 *   KansokuPieces.qkoma(mask, promoted, gote, opts) → 量子駒（正体の決まっていない駒）の SVG。候補の字を並べる
 *     候補が4つまでは字を大きく並べる。5つ以上は「？」と候補の数（盤が大きいとき・長押しで大きく見るときは全部の字）
 *     王の候補なら赤い印。量子駒は縁が青緑で、木地に薄く青緑がかかる
 *   字の書体・太さは CSS の .koma-ch。字は KansokuPieces.CHARS（フォントの &text= と同じ）
 */
(function (root) {
  'use strict';
  const CH = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍'];
  const CHARS = '王玉飛角金銀桂香歩と杏圭全馬龍？';
  const SIZE = [0, 0.84, 0.87, 0.89, 0.92, 0.92, 0.96, 0.96, 1, 0.84, 0.87, 0.89, 0.92, 0.94, 0.96, 0.96];
  const SHAPE = 'M50 2.5 Q51.6 2.5 53 3.2 L79.5 14.2 Q82.6 15.6 83 19 L91.8 94 Q92.2 98 88.2 98 L11.8 98 Q7.8 98 8.2 94 L17 19 Q17.4 15.6 20.5 14.2 L47 3.2 Q48.4 2.5 50 2.5Z';
  const FONT = { size: 52, sizePromoted: 47, cy: 60, stretch: 1.1 };
  const GRAIN = '<path d="M22 22 Q50 30 78 20 M18 50 Q50 44 82 52 M14 80 Q50 74 86 82" fill="none" stroke="var(--koma-grain)" stroke-width="1.1" opacity=".55"/>';
  const cache = {};
  // 確定した駒（将棋と同じ）。opts: { king: '王' | '玉' }
  function koma(t, gote, opts = {}) {
    const ch = t === 8 ? (opts.king || (gote ? '王' : '玉')) : CH[t];
    const key = `k${t}|${gote ? 1 : 0}|${ch}`;
    if (cache[key]) return cache[key];
    const promoted = t > 8;
    const svg = `<svg class="koma-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="--ks:${SIZE[t] || 0.9}">
<g${gote ? ' transform="rotate(180 50 50)"' : ''}>
<path d="${SHAPE}" fill="url(#koma-wood)" stroke="var(--koma-edge)" stroke-width="1.6" stroke-linejoin="round"/>${GRAIN}
<text class="koma-ch${promoted ? ' nari' : ''}" transform="translate(50 ${FONT.cy}) scale(1 ${FONT.stretch})" text-anchor="middle" dominant-baseline="central" font-size="${promoted ? FONT.sizePromoted : FONT.size}" fill="${promoted ? 'var(--koma-red)' : 'var(--koma-ink)'}">${ch}</text>
</g></svg>`;
    cache[key] = svg;
    return svg;
  }

  // 候補の並べ方（字の中心と大きさ）。駒の肩より下の広いところに
  const LAYOUT = {
    1: { fs: 50, pts: [[50, 60]] },
    2: { fs: 34, pts: [[50, 44], [50, 76]] },
    3: { fs: 27, pts: [[37, 46], [63, 46], [50, 76]] },
    4: { fs: 27, pts: [[37, 46], [63, 46], [37, 76], [63, 76]] },
    6: { fs: 21, pts: [[37, 38], [63, 38], [37, 61], [63, 61], [37, 84], [63, 84]] },
    9: { fs: 17, pts: [[30, 40], [50, 40], [70, 40], [30, 61], [50, 61], [70, 61], [30, 82], [50, 82], [70, 82]] },
  };
  const layoutFor = n => LAYOUT[n <= 4 ? n : n <= 6 ? 6 : 9];
  // 量子駒。mask: 候補（種類 t をビット t-1）。promoted: 成っている（候補は成った字で）。opts: { king: '王' | '玉', detail: true }
  function qkoma(mask, promoted, gote, opts = {}) {
    const kingCh = opts.king || (gote ? '王' : '玉');
    const key = `q${mask}|${promoted ? 1 : 0}|${gote ? 1 : 0}|${kingCh}|${opts.detail ? 1 : 0}`;
    if (cache[key]) return cache[key];
    const types = [];
    for (const t of [8, 7, 6, 5, 4, 3, 2, 1]) if (mask & (1 << (t - 1))) types.push(t);
    const n = types.length, isKing = (mask & 128) !== 0;
    const ink = promoted ? 'var(--koma-red)' : 'var(--koma-ink)';
    let body = '';
    const glyphs = list => {
      const L = layoutFor(list.length);
      return list.map((t, i) => {
        const [x, y] = L.pts[i];
        const ch = t === 8 ? kingCh : CH[promoted ? t + 8 : t];
        const col = t === 8 ? 'var(--q-king)' : ink;
        return `<text class="koma-ch" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${L.fs}" fill="${col}">${ch}</text>`;
      }).join('');
    };
    if (n <= 4 || opts.detail) body = glyphs(types);
    else {
      // 候補が多いとき: 大きな「？」と候補の数。王の候補なら左上に赤い「玉」
      body = `<text class="koma-ch" x="50" y="58" text-anchor="middle" dominant-baseline="central" font-size="44" fill="var(--q-ink)" opacity=".78">？</text>`
        + `<text x="72" y="86" text-anchor="middle" dominant-baseline="central" font-size="17" font-weight="800" fill="var(--q-ink)" style="font-family:var(--font-body)">${n}</text>`
        + (isKing ? `<text class="koma-ch" x="30" y="85" text-anchor="middle" dominant-baseline="central" font-size="17" fill="var(--q-king)">${kingCh}</text>` : '');
    }
    const svg = `<svg class="koma-svg qk" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="--ks:${SIZE[13]}">
<g${gote ? ' transform="rotate(180 50 50)"' : ''}>
<path d="${SHAPE}" fill="url(#koma-wood)" stroke="var(--q-edge)" stroke-width="3" stroke-linejoin="round"/>
<path d="${SHAPE}" fill="url(#q-tint)" stroke="none"/>${GRAIN}
${body}
</g></svg>`;
    cache[key] = svg;
    return svg;
  }

  root.KansokuPieces = { koma, qkoma, CH, CHARS, SIZE, SHAPE, FONT };
})(typeof self !== 'undefined' ? self : this);
