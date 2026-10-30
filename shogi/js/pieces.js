/* 駒の絵: 五角形の駒と、駒に書く字（明朝体。index.html で駒の字だけの Web フォントを読み込む）
 *   ShogiPieces.koma(t, gote, opts) → SVG の文字列（t は駒の種類 1..15。gote なら180度回す）
 *   字の書体・太さは CSS の .koma-ch（--font-koma・--koma-weight）。字は ShogiPieces.CHARS（フォントの &text= と同じ）
 */
(function (root) {
  'use strict';
  // 駒の種類 → 字・大きさ（実物の駒のように、玉が一番大きく歩が一番小さい）
  const CH = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍'];
  const CHARS = '王玉飛角金銀桂香歩と杏圭全馬龍';
  const SIZE = [0, 0.84, 0.87, 0.89, 0.92, 0.92, 0.96, 0.96, 1, 0.84, 0.87, 0.89, 0.92, 0, 0.96, 0.96];
  // 五角形の駒（100×100 の箱）
  const SHAPE = 'M50 2.5 Q51.6 2.5 53 3.2 L79.5 14.2 Q82.6 15.6 83 19 L91.8 94 Q92.2 98 88.2 98 L11.8 98 Q7.8 98 8.2 94 L17 19 Q17.4 15.6 20.5 14.2 L47 3.2 Q48.4 2.5 50 2.5Z';
  // 字の置き方: 駒の肩より下の広いところの中央に、実物の駒の字のように少し縦長に（成駒は少し小さく）
  const FONT = { size: 52, sizePromoted: 47, cy: 60, stretch: 1.1 };
  const komaCache = {};
  // 木目のグラデーションはページに1つだけ置いた <linearGradient id="koma-wood"> を使う（index.html）
  // opts: { king: '王' | '玉' }
  function koma(t, gote, opts = {}) {
    const ch = t === 8 ? (opts.king || (gote ? '王' : '玉')) : CH[t];
    const key = `${t}|${gote ? 1 : 0}|${ch}`;
    if (komaCache[key]) return komaCache[key];
    const promoted = t > 8;
    const s = SIZE[t] || 0.9;
    const svg = `<svg class="koma-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style="--ks:${s}">
<g${gote ? ' transform="rotate(180 50 50)"' : ''}>
<path d="${SHAPE}" fill="url(#koma-wood)" stroke="var(--koma-edge)" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M22 22 Q50 30 78 20 M18 50 Q50 44 82 52 M14 80 Q50 74 86 82" fill="none" stroke="var(--koma-grain)" stroke-width="1.1" opacity=".55"/>
<text class="koma-ch${promoted ? ' nari' : ''}" transform="translate(50 ${FONT.cy}) scale(1 ${FONT.stretch})" text-anchor="middle" dominant-baseline="central" font-size="${promoted ? FONT.sizePromoted : FONT.size}" fill="${promoted ? 'var(--koma-red)' : 'var(--koma-ink)'}">${ch}</text>
</g></svg>`;
    komaCache[key] = svg;
    return svg;
  }

  root.ShogiPieces = { koma, CH, CHARS, SIZE, SHAPE, FONT };
})(typeof self !== 'undefined' ? self : this);
