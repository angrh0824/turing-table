/* リーチ麻雀のルール（4人）: 牌・向聴数・和了の形・役・符・点数・1局の進行・半荘の進行
 * ブラウザ・Web Worker・Node で同じものを使う（AI の自己対局・画面・オンラインの確かめ）
 *
 * 牌の種類 kind 0..33: 0-8 萬子 1-9、9-17 筒子、18-26 索子、27 東 28 南 29 西 30 北 31 白 32 發 33 中
 * 牌そのもの id 0..135: kind = id >> 2。赤ドラありのときは 5萬・5筒・5索の1枚目（id 16・52・88）が赤
 * 山（wall）は 136 枚の id の並び。0..51 を配り（親から13枚ずつ）、52.. を順にツモる。122..135 が王牌
 *   嶺上牌 122..125、ドラ表示牌 126..130、裏ドラ表示牌 131..135。槓のたびにツモれる山が1枚ずつ減る
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MJ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ 牌
  const NK = 34;
  const RED_IDS = [16, 52, 88];
  const KIND_NAMES = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
    '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', 'E', 'S', 'W', 'N', 'P', 'F', 'C'];
  const HONOR_JA = ['東', '南', '西', '北', '白', '發', '中'];
  const NUM_JA = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SUIT_JA = ['萬', '筒', '索'];
  const WIND_JA = ['東', '南', '西', '北'];
  const kindOf = id => id >> 2;
  const suitOf = k => (k < 27 ? Math.floor(k / 9) : 3);
  const numOf = k => (k < 27 ? (k % 9) + 1 : 0);
  const isHonor = k => k >= 27;
  const isTerminal = k => k < 27 && (k % 9 === 0 || k % 9 === 8);
  const isYaochu = k => k >= 27 || k % 9 === 0 || k % 9 === 8;
  const isSimple = k => !isYaochu(k);
  const isDragon = k => k >= 31;
  const isWind = k => k >= 27 && k <= 30;
  const GREEN = new Set([19, 20, 21, 23, 25, 32]); // 2s 3s 4s 6s 8s 發
  const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  // ドラ表示牌の次の牌
  function doraOf(k) {
    if (k < 27) return k % 9 === 8 ? k - 8 : k + 1;
    if (k <= 30) return k === 30 ? 27 : k + 1;
    return k === 33 ? 31 : k + 1;
  }
  function kindJa(k) {
    if (k >= 27) return HONOR_JA[k - 27];
    return NUM_JA[k % 9] + SUIT_JA[Math.floor(k / 9)];
  }
  // 短い表記（画面の文字・記録用）: 5m・東 など
  function kindShort(k) { return k >= 27 ? HONOR_JA[k - 27] : `${numOf(k)}${'mps'[suitOf(k)]}`; }

  // 「123m456p0s11z」の形の文字列 → 牌の id の並び（テスト用。0 は赤5。z は 1-7 = 東南西北白發中）
  function parseTiles(str) {
    const out = [], used = new Map();
    let digits = [];
    for (const ch of str.replace(/\s+/g, '')) {
      if (/[0-9]/.test(ch)) { digits.push(+ch); continue; }
      const base = { m: 0, p: 9, s: 18, z: 27 }[ch];
      if (base == null) throw new Error('牌の表記が違います: ' + str);
      for (const d of digits) {
        const red = d === 0 && ch !== 'z';
        const k = base + (red ? 4 : d - 1);
        const n = used.get(k) || 0;
        // 赤は1枚目（copy 0）、ふつうの牌は 1..3 から使い、足りなければ 0
        let copy;
        if (red) copy = 0;
        else {
          const taken = used.get('c' + k) || new Set();
          copy = [1, 2, 3, 0].find(c => !taken.has(c));
        }
        const taken = used.get('c' + k) || new Set();
        if (taken.has(copy) || copy == null) throw new Error('同じ牌が5枚以上: ' + str);
        taken.add(copy); used.set('c' + k, taken); used.set(k, n + 1);
        out.push(k * 4 + copy);
      }
      digits = [];
    }
    return out;
  }
  const parseKinds = str => parseTiles(str).map(kindOf);

  function countsOf(ids) { const c = new Int8Array(NK); for (const id of ids) c[id >> 2]++; return c; }

  // ------------------------------------------------------------------ 向聴数
  // 数牌の1色（9種）または字牌（7種）の枚数の並びごとに、「面子 m 個・雀頭 p 個（0/1）を取ったとき、残りから作れる塔子の数の最大」を覚える
  // 表は「残りの枚数の並び」ごとに覚える動的計画法（先頭の牌から面子・雀頭・塔子・孤立牌のどれにするかを選ぶ）
  // 並びの番号（各牌の枚数を5進で）× 10 個の値を、平らな Int8Array に覚える（-2 = まだ計算していない）。数牌 5^9・字牌 5^7 通り
  const POW5 = [1, 5, 25, 125, 625, 3125, 15625, 78125, 390625];
  const TBL = [null, null]; // [字牌, 数牌]
  function tblOf(seq) {
    let a = TBL[seq ? 1 : 0];
    if (!a) { a = new Int8Array((seq ? 1953125 : 78125) * 10).fill(-2); a[0] = 0; for (let i = 1; i < 10; i++) a[i] = -1; TBL[seq ? 1 : 0] = a; }
    return a;
  }
  const dig = new Int8Array(9);
  function partOff(key, n, seq) {
    const A = tblOf(seq), o = key * 10;
    if (A[o] !== -2) return o;
    let x = key;
    for (let i = 0; i < n; i++) { dig[i] = x % 5; x = (x - dig[i]) / 5; }
    let i = 0;
    while (dig[i] === 0) i++;
    const a0 = dig[i], a1 = i + 1 < n ? dig[i + 1] : 0, a2 = i + 2 < n ? dig[i + 2] : 0;
    const res = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    const opt = (rk, dm, dt, dp) => {
      const so = partOff(rk, n, seq);
      for (let p = 0; p + dp < 2; p++) for (let m = 0; m + dm < 5; m++) {
        const v = A[so + p * 5 + m];
        if (v < 0) continue;
        const idx = (p + dp) * 5 + m + dm, nt = v + dt > 8 ? 8 : v + dt;
        if (res[idx] < nt) res[idx] = nt;
      }
    };
    const P = POW5;
    if (a0 >= 3) opt(key - 3 * P[i], 1, 0, 0);
    if (seq && i + 2 < n && a1 && a2) opt(key - P[i] - P[i + 1] - P[i + 2], 1, 0, 0);
    if (a0 >= 2) { opt(key - 2 * P[i], 0, 0, 1); opt(key - 2 * P[i], 0, 1, 0); }
    if (seq && i + 1 < n && a1) opt(key - P[i] - P[i + 1], 0, 1, 0);
    if (seq && i + 2 < n && a2) opt(key - P[i] - P[i + 2], 0, 1, 0);
    opt(key - P[i], 0, 0, 0);
    for (let k = 0; k < 10; k++) A[o + k] = res[k];
    return o;
  }
  const accA = new Int8Array(10), accB = new Int8Array(10);
  // ふつうの形の向聴数（-1 = 和了の形）。nMelds = 副露（と暗槓）の数
  function shantenNormal(c, nMelds) {
    let acc = accA, nxt = accB;
    acc.fill(-1); acc[0] = 0;
    for (let part = 0; part < 4; part++) {
      const seq = part < 3, off = seq ? part * 9 : 27, n = seq ? 9 : 7;
      let key = 0;
      for (let i = n - 1; i >= 0; i--) key = key * 5 + c[off + i];
      const A = tblOf(seq), to = partOff(key, n, seq);
      nxt.fill(-1);
      for (let p1 = 0; p1 < 2; p1++) for (let m1 = 0; m1 < 5; m1++) {
        const a = acc[p1 * 5 + m1];
        if (a < 0) continue;
        for (let p2 = 0; p2 + p1 < 2; p2++) for (let m2 = 0; m1 + m2 < 5; m2++) {
          const b = A[to + p2 * 5 + m2];
          if (b < 0) continue;
          const idx = (p1 + p2) * 5 + m1 + m2, v = a + b;
          if (nxt[idx] < v) nxt[idx] = v;
        }
      }
      const s = acc; acc = nxt; nxt = s;
    }
    const L = 4 - nMelds;
    let best = 8;
    for (let p = 0; p < 2; p++) for (let m = 0; m <= L; m++) {
      const t = acc[p * 5 + m];
      if (t < 0) continue;
      const v = 8 - 2 * (m + nMelds) - Math.min(t, L - m) - p;
      if (v < best) best = v;
    }
    return best;
  }
  function shantenChiitoi(c) {
    let pairs = 0, kinds = 0;
    for (let k = 0; k < NK; k++) { if (c[k] >= 1) kinds++; if (c[k] >= 2) pairs++; }
    return 6 - pairs + Math.max(0, 7 - kinds);
  }
  function shantenKokushi(c) {
    let kinds = 0, pair = 0;
    for (const k of YAOCHU) { if (c[k] >= 1) kinds++; if (c[k] >= 2) pair = 1; }
    return 13 - kinds - pair;
  }
  // 向聴数（3つの形の最小）。手牌が 13-3n 枚または 14-3n 枚
  function shanten(c, nMelds) {
    let s = shantenNormal(c, nMelds);
    if (nMelds === 0) { s = Math.min(s, shantenChiitoi(c), shantenKokushi(c)); }
    return s;
  }
  // 手の牌の近く（同じ色の ±2 と、その牌そのもの）。ふつうの形の向聴数を減らせるのは、この中の牌だけ
  const nearBuf = new Uint8Array(NK);
  function nearMask(c) {
    nearBuf.fill(0);
    for (let k = 0; k < NK; k++) {
      if (!c[k]) continue;
      if (k >= 27) { nearBuf[k] = 1; continue; }
      const b = k - (k % 9), lo = Math.max(b, k - 2), hi = Math.min(b + 8, k + 2);
      for (let j = lo; j <= hi; j++) nearBuf[j] = 1;
    }
    return nearBuf;
  }
  // 待ち（あと1枚で和了の形になる牌の種類）。手牌の中に4枚ある牌は待ちにしない
  function waitsOf(c, nMelds) {
    const out = [];
    const near = nearMask(c);
    for (let k = 0; k < NK; k++) {
      if (c[k] >= 4) continue;
      if (!near[k] && !(nMelds === 0 && isYaochu(k))) continue; // 遠い牌はふつうの形・七対子では和了にならない（国士だけ）
      c[k]++;
      if (shanten(c, nMelds) === -1) out.push(k);
      c[k]--;
    }
    return out;
  }
  // 牌 k を1枚足したときの向聴数が s0 より小さくなるか（近くにない牌は、七対子・国士の式だけで分かる）
  function improves(c, nMelds, k, s0, sN, near) {
    if (near[k]) { c[k]++; const s = shanten(c, nMelds); c[k]--; return s < s0; }
    if (nMelds) return false;
    // 近くにない牌（c[k] = 0）: ふつうの形は sN のまま
    c[k]++;
    const s = Math.min(sN, shantenChiitoi(c), shantenKokushi(c));
    c[k]--;
    return s < s0;
  }
  // 受け入れ（向聴数を1つ減らす牌の種類）。unseen[k] があればその枚数も数える
  function ukeire(c, nMelds, unseen) {
    const s0 = shanten(c, nMelds), sN = shantenNormal(c, nMelds);
    const near = nearMask(c).slice();
    const kinds = [];
    let n = 0;
    for (let k = 0; k < NK; k++) {
      if (c[k] >= 4) continue;
      if (improves(c, nMelds, k, s0, sN, near)) { kinds.push(k); n += unseen ? unseen[k] : 4 - c[k]; }
    }
    return { shanten: s0, kinds, count: n };
  }
  // 受け入れの枚数だけ（AI の特徴用。unseen[k] > 0 の牌だけ数える）
  function ukeireCount(c, nMelds, s0, unseen) {
    const sN = nMelds ? s0 : shantenNormal(c, nMelds);
    const near = nearMask(c).slice();
    let n = 0;
    for (let k = 0; k < NK; k++) {
      if (!unseen[k] || c[k] >= 4) continue;
      if (improves(c, nMelds, k, s0, sN, near)) n += unseen[k];
    }
    return n;
  }

  // ------------------------------------------------------------------ 和了の形の分解
  // 手牌（門前の部分）を雀頭1つ＋面子に分ける全通り: [{pair, sets:[[type, kind]]}]  type 's' 順子（kind が一番小さい牌）'k' 刻子
  function decompose(c) {
    const out = [];
    const sets = [];
    const a = Int8Array.from(c);
    const rec = (i) => {
      while (i < NK && a[i] === 0) i++;
      if (i >= NK) { out.push({ pair: pairKind, sets: sets.slice() }); return; }
      if (a[i] >= 3) { a[i] -= 3; sets.push(['k', i]); rec(i); sets.pop(); a[i] += 3; }
      if (i < 27 && i % 9 <= 6 && a[i + 1] && a[i + 2]) {
        a[i]--; a[i + 1]--; a[i + 2]--; sets.push(['s', i]); rec(i); sets.pop(); a[i]++; a[i + 1]++; a[i + 2]++;
      }
    };
    let pairKind = -1;
    for (let k = 0; k < NK; k++) {
      if (a[k] < 2) continue;
      a[k] -= 2; pairKind = k; rec(0); a[k] += 2;
    }
    return out;
  }

  // ------------------------------------------------------------------ 役と点数
  const YAKU = {
    riichi: ['立直', 1, 0], dRiichi: ['ダブル立直', 2, 0], ippatsu: ['一発', 1, 0], tsumo: ['門前清自摸和', 1, 0],
    pinfu: ['平和', 1, 0], tanyao: ['断幺九', 1, 1], iipeikou: ['一盃口', 1, 0], haitei: ['海底摸月', 1, 1], houtei: ['河底撈魚', 1, 1],
    rinshan: ['嶺上開花', 1, 1], chankan: ['槍槓', 1, 1], haku: ['役牌 白', 1, 1], hatsu: ['役牌 發', 1, 1], chun: ['役牌 中', 1, 1],
    seatWind: ['自風', 1, 1], roundWind: ['場風', 1, 1],
    chanta: ['混全帯幺九', 2, 1], ittsu: ['一気通貫', 2, 1], sanshoku: ['三色同順', 2, 1], sanshokuDoukou: ['三色同刻', 2, 2],
    toitoi: ['対々和', 2, 2], sanankou: ['三暗刻', 2, 2], sankantsu: ['三槓子', 2, 2], chiitoi: ['七対子', 2, 0],
    honroutou: ['混老頭', 2, 2], shousangen: ['小三元', 2, 2],
    honitsu: ['混一色', 3, 2], junchan: ['純全帯幺九', 3, 2], ryanpeikou: ['二盃口', 3, 0], chinitsu: ['清一色', 6, 5],
  };
  // 役満（数 = 役満の何倍か。ダブル役満はなし。複合はあり）
  const YAKUMAN = {
    kokushi: '国士無双', suuankou: '四暗刻', daisangen: '大三元', shousuushii: '小四喜', daisuushii: '大四喜', tsuuiisou: '字一色',
    ryuuiisou: '緑一色', chinroutou: '清老頭', chuuren: '九蓮宝燈', suukantsu: '四槓子', tenhou: '天和', chiihou: '地和',
  };
  const YAKU_LIST = Object.keys(YAKU).map(k => ({ key: k, name: YAKU[k][0], closed: YAKU[k][1], open: YAKU[k][2] }));
  const YAKUMAN_LIST = Object.keys(YAKUMAN).map(k => ({ key: k, name: YAKUMAN[k] }));

  const ceil100 = x => Math.ceil(x / 100) * 100;
  function basicPoints(han, fu, yakuman) {
    if (yakuman) return 8000 * yakuman;
    if (han >= 13) return 8000;
    if (han >= 11) return 6000;
    if (han >= 8) return 4000;
    if (han >= 6) return 3000;
    if (han >= 5) return 2000;
    return Math.min(2000, fu * Math.pow(2, han + 2));
  }
  function limitName(han, fu, yakuman) {
    if (yakuman) return yakuman > 1 ? `${['', '', 'ダブル', 'トリプル', '四倍', '五倍', '六倍'][Math.min(6, yakuman)]}役満` : '役満';
    if (han >= 13) return '数え役満';
    if (han >= 11) return '三倍満';
    if (han >= 8) return '倍満';
    if (han >= 6) return '跳満';
    if (han >= 5 || fu * Math.pow(2, han + 2) >= 2000) return '満貫';
    return '';
  }
  // 和了の点（場代・供託を除く）: ron → 放銃者が払う額、tsumo → [親の払い, 子の払い]
  function payOf(basic, dealer, tsumo) {
    if (tsumo) return dealer ? { all: ceil100(basic * 2) } : { dealer: ceil100(basic * 2), child: ceil100(basic) };
    return { ron: ceil100(basic * (dealer ? 6 : 4)) };
  }

  /* 和了の手を評価する（一番点の高い解釈）
   *   ctx: { concealed: id[]（和了牌を含む）, melds: [{type, tiles, called, from}], winTile: id, tsumo, seatWind, roundWind,
   *          riichi: 0|1|2, ippatsu, haitei, houtei, rinshan, chankan, tenhou, chiihou, dora: kind[]（ドラの牌）, ura: kind[], aka, kuitan }
   *   返り値: null（役なし・形でない）か { han, fu, yakuman, yaku:[[名前, 翻]], dora, aka, ura, basic, limit, form }
   */
  function evaluateHand(ctx) {
    const c = countsOf(ctx.concealed);
    const melds = ctx.melds || [];
    const nMelds = melds.length;
    const menzen = melds.every(m => m.type === 'ankan');
    const w = kindOf(ctx.winTile);
    const all = new Int8Array(NK);
    for (let k = 0; k < NK; k++) all[k] = c[k];
    for (const m of melds) for (const id of m.tiles) all[kindOf(id)]++;
    // ドラの数（役があるときだけ数える）
    const allIds = ctx.concealed.slice();
    for (const m of melds) allIds.push(...m.tiles);
    let dora = 0, ura = 0, aka = 0;
    for (const id of allIds) {
      const k = kindOf(id);
      for (const d of ctx.dora || []) if (d === k) dora++;
      if (ctx.riichi) for (const d of ctx.ura || []) if (d === k) ura++;
      if (ctx.aka && RED_IDS.includes(id)) aka++;
    }
    const results = [];
    const sw = 27 + ctx.seatWind, rw = 27 + ctx.roundWind;
    // 共通の役（形によらない）
    const baseYaku = [];
    if (ctx.riichi === 2) baseYaku.push('dRiichi'); else if (ctx.riichi) baseYaku.push('riichi');
    if (ctx.riichi && ctx.ippatsu) baseYaku.push('ippatsu');
    if (menzen && ctx.tsumo) baseYaku.push('tsumo');
    if (ctx.haitei && ctx.tsumo && !ctx.rinshan) baseYaku.push('haitei');
    if (ctx.houtei && !ctx.tsumo) baseYaku.push('houtei');
    if (ctx.rinshan && ctx.tsumo) baseYaku.push('rinshan');
    if (ctx.chankan) baseYaku.push('chankan');
    // 色・字・么九（全体の牌で決まる役）
    let suits = new Set(), honors = 0, yaochuOnly = true, simpleOnly = true, terminalsOnly = true, greenOnly = true;
    for (let k = 0; k < NK; k++) {
      if (!all[k]) continue;
      if (k >= 27) honors++; else suits.add(suitOf(k));
      if (!isYaochu(k)) yaochuOnly = false; else simpleOnly = false;
      if (!isTerminal(k)) terminalsOnly = false;
      if (!GREEN.has(k)) greenOnly = false;
    }
    const colorYaku = [];
    if (simpleOnly && (ctx.kuitan !== false || menzen)) colorYaku.push('tanyao');
    if (suits.size === 1 && honors === 0) colorYaku.push('chinitsu');
    else if (suits.size === 1 && honors > 0) colorYaku.push('honitsu');
    const yakumanCommon = [];
    if (ctx.tenhou) yakumanCommon.push('tenhou');
    if (ctx.chiihou) yakumanCommon.push('chiihou');
    if (suits.size === 0) yakumanCommon.push('tsuuiisou');
    if (greenOnly) yakumanCommon.push('ryuuiisou');
    if (terminalsOnly) yakumanCommon.push('chinroutou');

    const finish = (form, yakuKeys, fu, yakumanKeys) => {
      if (yakumanKeys.length) {
        const n = yakumanKeys.length;
        results.push({ form, han: 0, fu, yakuman: n, yaku: yakumanKeys.map(k => [YAKUMAN[k], 13]), yakuKeys: yakumanKeys, dora: 0, aka: 0, ura: 0, basic: basicPoints(0, fu, n), limit: limitName(0, fu, n) });
        return;
      }
      if (!yakuKeys.length) return;
      let han = 0;
      const yaku = [];
      for (const k of yakuKeys) {
        const h = menzen ? YAKU[k][1] : YAKU[k][2];
        if (!h) continue;
        han += h; yaku.push([YAKU[k][0], h]);
      }
      if (!yaku.length) return;
      const total = han + dora + ura + aka;
      if (dora) yaku.push(['ドラ', dora]);
      if (aka) yaku.push(['赤ドラ', aka]);
      if (ura) yaku.push(['裏ドラ', ura]);
      results.push({ form, han: total, fu, yakuman: 0, yaku, yakuKeys, dora, aka, ura, basic: basicPoints(total, fu, 0), limit: limitName(total, fu, 0) });
    };

    // 国士無双
    if (nMelds === 0 && shantenKokushi(c) === -1) {
      finish('kokushi', [], 0, ['kokushi'].concat(yakumanCommon.filter(k => k === 'tenhou' || k === 'chiihou')));
    }
    // 七対子
    if (nMelds === 0 && shantenChiitoi(c) === -1) {
      const yk = baseYaku.concat(colorYaku, ['chiitoi']);
      if (yaochuOnly) yk.push('honroutou');
      // 七対子の形で成り立つ役満: 字一色（天和・地和も）
      finish('chiitoi', yk, 25, yakumanCommon.filter(k => k === 'tsuuiisou' || k === 'tenhou' || k === 'chiihou'));
    }
    // ふつうの形
    if (shantenNormal(c, nMelds) === -1) {
      for (const d of decompose(c)) {
        // 和了牌がどの塊に入るか（ロンならその刻子は明刻扱い）
        const places = [];
        if (d.pair === w) places.push({ g: -1, wait: 'tanki' });
        d.sets.forEach(([t, k], i) => {
          if (t === 'k' && k === w) places.push({ g: i, wait: 'shanpon' });
          if (t === 's' && w >= k && w <= k + 2) {
            const n = numOf(k);
            let wait;
            if (w === k + 1) wait = 'kanchan';
            else if (w === k) wait = n === 7 ? 'penchan' : 'ryanmen';
            else wait = n === 1 ? 'penchan' : 'ryanmen';
            places.push({ g: i, wait });
          }
        });
        const seen = new Set();
        for (const pl of places) {
          const key = pl.g + pl.wait + (pl.g >= 0 ? d.sets[pl.g].join() : 'p');
          if (seen.has(key)) continue;
          seen.add(key);
          evalDecomp(d, pl);
        }
      }
    }

    function evalDecomp(d, pl) {
      // 面子の一覧: 門前の部分＋副露
      const S = d.sets.map(([t, k], i) => ({ t, k, open: false, kan: false, ronOpen: !ctx.tsumo && i === pl.g && t === 'k' }));
      for (const m of melds) {
        const k = kindOf(m.tiles[0]);
        if (m.type === 'chi') S.push({ t: 's', k: Math.min(...m.tiles.map(kindOf)), open: true, kan: false });
        else if (m.type === 'pon') S.push({ t: 'k', k, open: true, kan: false });
        else S.push({ t: 'k', k, open: m.type !== 'ankan', kan: true });
      }
      const pair = d.pair;
      const yk = baseYaku.concat(colorYaku);
      const ym = yakumanCommon.slice();
      const isYakuhai = k => k >= 31 || k === sw || k === rw;
      // 役牌
      for (const s of S) if (s.t === 'k') {
        if (s.k === 31) yk.push('haku'); if (s.k === 32) yk.push('hatsu'); if (s.k === 33) yk.push('chun');
        if (s.k === sw) yk.push('seatWind'); if (s.k === rw) yk.push('roundWind');
      }
      const shun = S.filter(s => s.t === 's'), kou = S.filter(s => s.t === 'k');
      // 平和
      const pairFu = (pair >= 31 ? 2 : 0) + (pair === sw ? 2 : 0) + (pair === rw ? 2 : 0);
      const pinfu = menzen && shun.length === 4 && pairFu === 0 && pl.wait === 'ryanmen';
      if (pinfu) yk.push('pinfu');
      // 一盃口・二盃口
      if (menzen) {
        const cnt = new Map();
        for (const s of shun) cnt.set(s.k, (cnt.get(s.k) || 0) + 1);
        let pk = 0;
        for (const v of cnt.values()) pk += Math.floor(v / 2);
        if (pk >= 2) yk.push('ryanpeikou'); else if (pk === 1) yk.push('iipeikou');
      }
      // 一気通貫・三色
      for (let s0 = 0; s0 < 3; s0++) {
        const b = s0 * 9;
        if ([0, 3, 6].every(o => shun.some(s => s.k === b + o))) yk.push('ittsu');
      }
      for (let n = 0; n < 7; n++) if ([0, 9, 18].every(o => shun.some(s => s.k === o + n))) { yk.push('sanshoku'); break; }
      for (let n = 0; n < 9; n++) if ([0, 9, 18].every(o => kou.some(s => s.k === o + n))) { yk.push('sanshokuDoukou'); break; }
      // 対々和・三暗刻・四暗刻・三槓子・四槓子
      if (kou.length === 4) yk.push('toitoi');
      const anko = kou.filter(s => !s.open && !s.ronOpen).length;
      if (anko === 4) ym.push('suuankou'); else if (anko === 3) yk.push('sanankou');
      const kans = kou.filter(s => s.kan).length;
      if (kans === 4) ym.push('suukantsu'); else if (kans === 3) yk.push('sankantsu');
      // 三元・四喜
      const dragonK = kou.filter(s => s.k >= 31).length, windK = kou.filter(s => s.k >= 27 && s.k <= 30).length;
      if (dragonK === 3) ym.push('daisangen');
      else if (dragonK === 2 && pair >= 31) yk.push('shousangen');
      if (windK === 4) ym.push('daisuushii');
      else if (windK === 3 && pair >= 27 && pair <= 30) ym.push('shousuushii');
      // 混老頭・全帯・純全帯
      if (yaochuOnly) yk.push('honroutou');
      else if (shun.length) {
        const grpYaochu = s => (s.t === 's' ? (numOf(s.k) === 1 || numOf(s.k) === 7) : isYaochu(s.k));
        if (S.every(grpYaochu) && isYaochu(pair)) yk.push(honors ? 'chanta' : 'junchan');
      }
      // 九蓮宝燈
      if (menzen && nMelds === 0 && suits.size === 1 && honors === 0) {
        const b = [...suits][0] * 9, need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
        if (need.every((v, i) => c[b + i] >= v)) ym.push('chuuren');
      }
      // 符
      let fu;
      if (pinfu) fu = ctx.tsumo ? 20 : 30;
      else {
        fu = 20;
        if (menzen && !ctx.tsumo) fu += 10;
        if (ctx.tsumo) fu += 2;
        for (const s of kou) {
          let f = isYaochu(s.k) ? 4 : 2;
          if (!s.open && !s.ronOpen) f *= 2;
          if (s.kan) f *= 4;
          fu += f;
        }
        fu += pairFu;
        if (pl.wait === 'kanchan' || pl.wait === 'penchan' || pl.wait === 'tanki') fu += 2;
        fu = Math.ceil(fu / 10) * 10;
        if (fu === 20 && !menzen) fu = 30;
      }
      finish('normal', yk, fu, ym);
    }

    if (!results.length) return null;
    results.sort((a, b) => (b.basic - a.basic) || (b.han - a.han) || (b.fu - a.fu));
    return results[0];
  }

  // ------------------------------------------------------------------ ルール
  const DEFAULT_RULES = {
    length: 'hanchan',   // 'tonpu' 東風戦 / 'hanchan' 東南戦
    aka: 3,              // 赤ドラの枚数（0 か 3）
    kuitan: true,        // 喰いタン
    startPoints: 25000, returnPoints: 30000,
    uma: [20, 10, -10, -20],
    tobi: true,          // だれかの持ち点が 0 未満で終わる
    agariYame: true,     // オーラスで親が和了って1位なら終わる
    nagashi: true,       // 流し満貫
    sanchaho: true,      // 三家和は流局
    pao: true,           // 大三元・大四喜の責任払い
  };
  function rulesOf(r) { return Object.assign({}, DEFAULT_RULES, r || {}); }

  // ------------------------------------------------------------------ 乱数（再現できるように種から）
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = 0x12345678;
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 16; i++) next();
    return next;
  }
  function shuffledWall(rng) {
    const w = [];
    for (let i = 0; i < 136; i++) w.push(i);
    for (let i = 135; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = w[i]; w[i] = w[j]; w[j] = t; }
    return w;
  }

  // ------------------------------------------------------------------ 1局
  const DEAD = 122;
  class Round {
    /* o: { rules, wall(136), dealer, roundWind(0東 1南 2西), kyoku(0..3), honba, kyotaku, scores[4] } */
    constructor(o) {
      this.rules = rulesOf(o.rules);
      this.wall = o.wall.slice();
      this.dealer = o.dealer; this.roundWind = o.roundWind || 0; this.kyoku = o.kyoku != null ? o.kyoku : o.dealer;
      this.honba = o.honba || 0; this.kyotaku = o.kyotaku || 0; this.kyotakuStart = this.kyotaku;
      this.scores = o.scores.slice();
      this.hands = [[], [], [], []];
      this.counts = [new Int8Array(NK), new Int8Array(NK), new Int8Array(NK), new Int8Array(NK)];
      this.melds = [[], [], [], []];
      this.discards = [[], [], [], []];     // {tile, tsumogiri, riichi, called, n（局の中で何番目の打牌か）}
      this.nDisc = 0;                       // 打牌の通し番号
      this.riichiN = [-1, -1, -1, -1];      // 立直の宣言牌の通し番号
      this.riichi = [0, 0, 0, 0];           // 1 立直 2 ダブル立直
      this.riichiAt = [-1, -1, -1, -1];     // 立直を宣言した捨て牌の番号（その人の河の何枚目）
      this.ippatsu = [false, false, false, false];
      this.furitenTemp = [false, false, false, false];
      this.furitenRiichi = [false, false, false, false];
      this.waits = [[], [], [], []];
      this.draws = [0, 0, 0, 0];            // その人がツモった回数
      this.noCalls = true;                  // まだだれも鳴いていない（暗槓も含む）
      this.pao = [-1, -1, -1, -1];          // 大三元・大四喜の責任払いの相手
      this.kanBy = [];                      // 槓した人の並び
      this.livePos = 52; this.liveEnd = DEAD;
      this.rinshanUsed = 0; this.doraCount = 1; this.pendingDora = 0;
      this.firstDiscards = [];              // 四風連打の判定用
      this.log = [];                        // 画面の演出用の出来事
      this.steps = [];                      // 再現用の記録（手番の行動と鳴きの返事）
      this.result = null;
      this.phase = 'turn';
      this.cur = this.dealer;
      this.drawn = -1;                      // 今ツモった牌（鳴いたあとは -1）
      this.afterKan = false;                // 嶺上牌をツモった直後
      this.kuikae = null;                   // 鳴いたあとに切れない牌の種類
      this.pendingRiichi = -1;
      this.react = null;
      // オンラインの写し（external）: 見えない牌は 1000+山の位置 の仮の番号。鳴きの返事・荒牌流局の聴牌は外（ホスト）から決まる
      this.external = !!o.external;
      this.hidden = o.hidden || [false, false, false, false];
      this.drawnPos = -1;
      // 配る（親から13枚ずつ）
      for (let i = 0; i < 4; i++) {
        const s = (this.dealer + i) % 4;
        for (let j = 0; j < 13; j++) this.addTile(s, this.wall[13 * i + j]);
      }
      for (let s = 0; s < 4; s++) this.waits[s] = waitsOf(this.counts[s], 0);
      this.log.push({ e: 'deal' });
      this.drawFor(this.dealer, false);
    }
    // ------------- 小さな部品
    addTile(s, id) { this.hands[s].push(id); this.counts[s][id >> 2]++; }
    removeTile(s, id) {
      const h = this.hands[s], i = h.indexOf(id);
      if (i < 0) throw new Error('手牌にない牌です');
      h.splice(i, 1); this.counts[s][id >> 2]--;
    }
    seatWind(s) { return (s - this.dealer + 4) % 4; }
    get liveLeft() { return this.liveEnd - this.livePos; }
    doraIndicators() { const o = []; for (let i = 0; i < this.doraCount; i++) o.push(this.wall[126 + i]); return o; }
    uraIndicators() { const o = []; for (let i = 0; i < this.doraCount; i++) o.push(this.wall[131 + i]); return o; }
    doraKinds() { return this.doraIndicators().map(id => doraOf(id >> 2)); }
    isMenzen(s) { return this.melds[s].every(m => m.type === 'ankan'); }
    // 自分の捨て牌（鳴かれた牌も含む）にある種類
    discardedKinds(s) { const set = new Set(); for (const d of this.discards[s]) set.add(d.tile >> 2); return set; }
    isFuriten(s) {
      if (this.furitenTemp[s] || this.furitenRiichi[s]) return true;
      const ds = this.discardedKinds(s);
      return this.waits[s].some(k => ds.has(k));
    }

    drawFor(s, rinshan) {
      let id, pos;
      if (rinshan) { pos = DEAD + this.rinshanUsed; id = this.wall[pos]; this.rinshanUsed++; this.liveEnd--; }
      else { pos = this.livePos++; id = this.wall[pos]; }
      this.addTile(s, id);
      this.draws[s]++;
      this.cur = s; this.drawn = id; this.drawnPos = pos; this.afterKan = !!rinshan; this.kuikae = null;
      this.phase = 'turn'; this.react = null;
      this.log.push({ e: 'draw', s, tile: id, pos, rinshan: !!rinshan });
    }
    // 見えなかった牌（山の位置 pos）が id だと分かった（オンラインの写し）
    reveal(pos, id) {
      const ph = 1000 + pos;
      this.wall[pos] = id;
      for (let p = 0; p < 4; p++) {
        const i = this.hands[p].indexOf(ph);
        if (i < 0) continue;
        this.hands[p][i] = id; this.counts[p][id >> 2]++;
        if (this.cur === p && this.drawn === ph) this.drawn = id;
        if (this.hands[p].length % 3 === 1 && !this.hands[p].some(x => x >= 1000)) this.waits[p] = waitsOf(this.counts[p], this.melds[p].length);
      }
      if (this.pendingAnkan) { const i = this.pendingAnkan.indexOf(ph); if (i >= 0) this.pendingAnkan[i] = id; }
    }
    // 局面の写し（先読み用。記録と出来事は持たない）
    clone() {
      const c = Object.create(Round.prototype);
      Object.assign(c, this);
      c.wall = this.wall.slice();
      c.hands = this.hands.map(h => h.slice());
      c.counts = this.counts.map(x => Int8Array.from(x));
      c.melds = this.melds.map(ms => ms.map(m => Object.assign({}, m, { tiles: m.tiles.slice() })));
      c.discards = this.discards.map(ds => ds.map(d => Object.assign({}, d)));
      for (const k of ['riichi', 'riichiAt', 'riichiN', 'ippatsu', 'furitenTemp', 'furitenRiichi', 'draws', 'pao', 'kanBy', 'firstDiscards', 'scores', 'hidden']) c[k] = this[k].slice();
      c.waits = this.waits.map(w => w.slice());
      c.pendingAnkan = this.pendingAnkan ? this.pendingAnkan.slice() : null;
      c.kuikae = this.kuikae ? this.kuikae.slice() : null;
      c.react = this.react ? { kind: this.react.kind, from: this.react.from, tile: this.react.tile, options: this.react.options.map(o => o && o.slice()) } : null;
      c.log = []; c.steps = []; c.result = null;
      return c;
    }
    // 山の位置 → いまその牌を持っている席（なければ -1）
    holderOf(pos) { const ph = 1000 + pos, id = this.wall[pos]; for (let p = 0; p < 4; p++) if (this.hands[p].includes(ph) || (id < 1000 && this.hands[p].includes(id))) return p; return -1; }

    // 和了を評価する（s の手牌に winTile が入っている状態で）
    evalWin(s, winTile, tsumo, extra = {}) {
      const r = this;
      const haitei = tsumo && !r.afterKan && r.livePos >= r.liveEnd;
      const houtei = !tsumo && r.livePos >= r.liveEnd && !extra.chankan;
      const first = r.noCalls && r.draws[s] === 1 && r.discards[s].length === 0;
      return evaluateHand({
        concealed: r.hands[s], melds: r.melds[s], winTile, tsumo,
        seatWind: r.seatWind(s), roundWind: r.roundWind,
        riichi: r.riichi[s], ippatsu: r.ippatsu[s], haitei, houtei, rinshan: tsumo && r.afterKan, chankan: !!extra.chankan,
        tenhou: tsumo && first && s === r.dealer, chiihou: tsumo && first && s !== r.dealer,
        dora: r.doraKinds(), ura: r.riichi[s] ? r.uraIndicators().map(id => doraOf(id >> 2)) : [], aka: r.rules.aka > 0, kuitan: r.rules.kuitan,
      });
    }
    isRed(id) { return this.rules.aka > 0 && (id === 16 || id === 52 || id === 88); }

    // ------------- 手番の行動
    turnActions() {
      if (this.phase !== 'turn') return [];
      const s = this.cur, out = [], c = this.counts[s], h = this.hands[s];
      const nm = this.melds[s].length;
      if (this.drawn >= 0) {
        if (shanten(c, nm) === -1 && this.evalWin(s, this.drawn, true)) out.push({ t: 'tsumo' });
        // 九種九牌
        if (this.noCalls && this.draws[s] === 1 && this.discards[s].length === 0) {
          let n = 0; for (const k of YAOCHU) if (c[k]) n++;
          if (n >= 9) out.push({ t: 'kyuushu' });
        }
        // 槓（ツモれる牌が残っていて、槓が4回未満）
        if (this.liveLeft > 0 && this.kanBy.length < 4) {
          for (let k = 0; k < NK; k++) {
            if (c[k] !== 4) continue;
            if (this.riichi[s] && !this.riichiAnkanOk(s, k)) continue;
            out.push({ t: 'ankan', kind: k });
          }
          if (!this.riichi[s]) for (const m of this.melds[s]) {
            if (m.type !== 'pon') continue;
            const k = m.tiles[0] >> 2;
            const id = h.find(x => (x >> 2) === k);
            if (id != null) out.push({ t: 'kakan', tile: id });
          }
        }
      }
      // 打牌（立直中はツモ切りだけ）
      if (this.riichi[s]) { out.push({ t: 'discard', tile: this.drawn, riichi: false }); return out; }
      const seen = new Set();
      const canRiichi = this.isMenzen(s) && this.scores[s] >= 1000 && this.liveLeft >= 4 && this.drawn >= 0;
      // 同じ種類・同じ赤の牌は1つにまとめる（ツモった牌があればそれを切る＝ツモ切り）
      const order = this.drawn >= 0 ? [this.drawn].concat(h.filter(x => x !== this.drawn)) : h;
      for (const id of order) {
        const k = id >> 2, key = k * 2 + (this.isRed(id) ? 1 : 0);
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.kuikae && this.kuikae.includes(k)) continue;
        out.push({ t: 'discard', tile: id, riichi: false });
        if (canRiichi) {
          c[k]--;
          const ok = shanten(c, nm) === 0 && waitsOf(c, nm).length > 0;
          c[k]++;
          if (ok) out.push({ t: 'discard', tile: id, riichi: true });
        }
      }
      return out;
    }
    // 立直のあとの暗槓: ツモった牌で槓し、待ちも面子の形も変わらないときだけ
    riichiAnkanOk(s, k) {
      if ((this.drawn >> 2) !== k) return false;
      const c = Int8Array.from(this.counts[s]), nm = this.melds[s].length;
      c[k]--; // 槓する前の13枚（立直の形）
      const before = waitsOf(c, nm);
      if (!before.length) return false;
      const c2 = Int8Array.from(this.counts[s]); c2[k] -= 4;
      const after = waitsOf(c2, nm + 1);
      if (after.length !== before.length || after.some((x, i) => x !== before[i])) return false;
      // どの待ちで和了っても、その牌が刻子として使われていること
      for (const wk of before) {
        c[wk]++;
        const ds = decompose(c);
        c[wk]--;
        if (ds.length === 0) return false; // 七対子・国士の形
        if (!ds.every(d => d.sets.some(([t, kk]) => t === 'k' && kk === k))) return false;
      }
      return true;
    }
    canDiscard(id) {
      if (this.phase !== 'turn') return false;
      const s = this.cur;
      if (!this.hands[s].includes(id)) return false;
      if (this.riichi[s]) return id === this.drawn;
      if (this.kuikae && this.kuikae.includes(id >> 2)) return false;
      return true;
    }

    doTurn(a) {
      if (this.phase !== 'turn') throw new Error('手番ではありません');
      const s = this.cur;
      if (!(this.external && this.hidden[s]) && !this.isLegalTurn(a)) throw new Error('その行動はできません: ' + JSON.stringify(a));
      this.steps.push({ k: 't', s, a });
      if (a.t === 'tsumo') return this.winTsumo(s);
      if (a.t === 'kyuushu') { this.log.push({ e: 'kyuushu', s }); return this.abort('kyuushu', { seat: s }); }
      if (a.t === 'ankan') return this.declareKan(s, 'ankan', a.kind);
      if (a.t === 'kakan') return this.declareKan(s, 'kakan', a.tile >> 2, a.tile);
      return this.discard(s, a.tile, !!a.riichi);
    }
    isLegalTurn(a) {
      if (!a) return false;
      if (a.t === 'discard') {
        if (!this.canDiscard(a.tile)) return false;
        if (a.riichi) return this.turnActions().some(x => x.t === 'discard' && x.riichi && (x.tile >> 2) === (a.tile >> 2));
        return true;
      }
      if (a.t === 'kakan') return this.turnActions().some(x => x.t === 'kakan' && x.tile === a.tile);
      if (a.t === 'ankan') return this.turnActions().some(x => x.t === 'ankan' && x.kind === a.kind);
      return this.turnActions().some(x => x.t === a.t);
    }

    discard(s, id, riichi) {
      this.removeTile(s, id);
      const tsumogiri = id === this.drawn;
      if (this.ippatsu[s]) this.ippatsu[s] = false; // 立直のあと1巡の間だけ
      const d = { tile: id, tsumogiri, riichi, called: false, n: this.nDisc++ };
      this.discards[s].push(d);
      this.furitenTemp[s] = false;
      if (riichi) {
        this.riichi[s] = this.noCalls && this.discards[s].length === 1 ? 2 : 1;
        this.riichiAt[s] = this.discards[s].length - 1;
        this.riichiN[s] = d.n;
        this.pendingRiichi = s;
      }
      this.waits[s] = waitsOf(this.counts[s], this.melds[s].length);
      if (this.noCalls && this.firstDiscards.length < 4) this.firstDiscards.push(id >> 2);
      this.drawn = -1; this.afterKan = false; this.kuikae = null;
      this.log.push({ e: 'discard', s, tile: id, tsumogiri, riichi });
      this.openReact('discard', s, id);
    }

    // ------------- 鳴き・ロンの返事
    openReact(kind, from, tile) {
      const opts = [null, null, null, null];
      const k = tile >> 2;
      let any = false;
      const last = this.livePos >= this.liveEnd;
      for (let i = 1; i < 4; i++) {
        const s = (from + i) % 4;
        const o = [];
        if (this.external && this.hidden[s]) continue;
        // ロン
        if (this.waits[s].includes(k) && !this.isFuriten(s)) {
          if (kind !== 'ankan' || this.isKokushiTenpai(s)) {
            this.addTile(s, tile);
            const ev = this.evalWin(s, tile, false, { chankan: kind !== 'discard' });
            this.removeTile(s, tile);
            if (ev && (kind !== 'ankan' || ev.yakuKeys.includes('kokushi'))) o.push({ t: 'ron' });
          }
        }
        if (kind === 'discard' && !last && !this.riichi[s]) {
          const c = this.counts[s], h = this.hands[s];
          const ids = h.filter(x => (x >> 2) === k);
          if (c[k] >= 2) {
            // 赤を使う・使わないの違いだけ別の選び方にする
            const reds = ids.filter(x => this.isRed(x)), plain = ids.filter(x => !this.isRed(x));
            const variants = [];
            if (plain.length >= 2) variants.push([plain[0], plain[1]]);
            if (reds.length && plain.length >= 1) variants.push([reds[0], plain[0]]);
            for (const v of variants) if (this.callLeavesDiscard(s, v, 'pon', k)) o.push({ t: 'pon', use: v });
          }
          if (c[k] >= 3 && this.kanBy.length < 4) o.push({ t: 'minkan' });
          if (i === 1 && k < 27) {
            const n = k % 9;
            for (const [a, b] of [[-2, -1], [-1, 1], [1, 2]]) {
              if (n + a < 0 || n + b > 8) continue;
              const ka = k + a, kb = k + b;
              if (!c[ka] || !c[kb]) continue;
              const ca = h.filter(x => (x >> 2) === ka), cb = h.filter(x => (x >> 2) === kb);
              const pick = arr => { const pl = arr.find(x => !this.isRed(x)); return pl != null ? pl : arr[0]; };
              const pickRed = arr => arr.find(x => this.isRed(x));
              const variants = [[pick(ca), pick(cb)]];
              if (pickRed(ca) != null && ca.some(x => !this.isRed(x))) variants.push([pickRed(ca), pick(cb)]);
              if (pickRed(cb) != null && cb.some(x => !this.isRed(x))) variants.push([pick(ca), pickRed(cb)]);
              for (const v of variants) if (this.callLeavesDiscard(s, v, 'chi', k)) o.push({ t: 'chi', use: v });
            }
          }
        }
        if (o.length) { opts[s] = o; any = true; }
      }
      this.react = { kind, from, tile, options: opts };
      this.phase = 'react';
      if (!any && !this.external) this.doReact([null, null, null, null], true);
    }
    isKokushiTenpai(s) { return this.melds[s].length === 0 && shantenKokushi(this.counts[s]) === 0; }
    // 鳴いたあとに切れる牌が残るか（喰い替えの禁止: 鳴いた牌と同じ種類・チーの筋の反対側は切れない）
    callLeavesDiscard(s, use, type, k) {
      const forb = this.kuikaeKinds(type, k, use.map(x => x >> 2));
      const c = this.counts[s];
      for (const id of use) c[id >> 2]--;
      let ok = false;
      for (let kk = 0; kk < NK; kk++) if (c[kk] > 0 && !forb.includes(kk)) { ok = true; break; }
      for (const id of use) c[id >> 2]++;
      return ok;
    }
    kuikaeKinds(type, k, useKinds) {
      const f = [k];
      if (type === 'chi') {
        const lo = Math.min(k, ...useKinds), hi = Math.max(k, ...useKinds);
        if (k === lo && numOf(hi) <= 8 && hi + 1 < 27 && numOf(hi) < 9) f.push(hi + 1);       // 34 に 2 を鳴いたら 5 は切れない
        if (k === hi && numOf(lo) >= 2) f.push(lo - 1);
      }
      return f;
    }
    isLegalReact(s, a) {
      if (!a) return true;
      const o = this.react && this.react.options[s];
      if (!o) return false;
      return o.some(x => x.t === a.t && (!x.use || (a.use && x.use.length === a.use.length && x.use.every((v, i) => v === a.use[i]))));
    }

    // responses[s]: 行動 か null（見送り）
    doReact(responses, auto) {
      if (this.phase !== 'react') throw new Error('鳴きの返事を待っていません');
      const R = this.react, from = R.from, tile = R.tile, k = tile >> 2;
      for (let s = 0; s < 4; s++) if (responses[s] && !(this.external && this.hidden[s]) && !this.isLegalReact(s, responses[s])) throw new Error('その鳴きはできません');
      if (!auto) this.steps.push({ k: 'r', resp: responses.map(x => x || null) });
      // 見逃したロン → フリテン（形の上で待ちに当たる牌を見逃したら。立直中ならこの局ずっと）
      //   暗槓の牌は国士無双でロンできた人だけ
      for (let i = 1; i < 4; i++) {
        const s = (from + i) % 4;
        const couldRon = !!(R.options[s] && R.options[s].some(x => x.t === 'ron'));
        const hit = R.kind === 'ankan' ? couldRon : this.waits[s].includes(k);
        if (hit && !(responses[s] && responses[s].t === 'ron')) {
          this.furitenTemp[s] = true;
          if (this.riichi[s]) this.furitenRiichi[s] = true;
        }
      }
      // ロン（放銃者から近い順）
      const rons = [];
      for (let i = 1; i < 4; i++) { const s = (from + i) % 4; if (responses[s] && responses[s].t === 'ron') rons.push(s); }
      if (rons.length) {
        if (rons.length === 3 && this.rules.sanchaho) return this.abort('sancha', { seats: rons });
        return this.winRon(rons, from, tile, R.kind);
      }
      // 立直の成立（宣言牌が通った）
      if (R.kind === 'discard' && this.pendingRiichi === from) {
        this.pendingRiichi = -1;
        this.scores[from] -= 1000; this.kyotaku++;
        this.ippatsu[from] = true;
        this.log.push({ e: 'riichi', s: from });
      }
      // 槓のあとの新ドラ（明槓・加槓は、嶺上牌をツモったあとの打牌が通ったとき）
      if (R.kind === 'discard' && this.pendingDora) {
        this.doraCount += this.pendingDora; this.pendingDora = 0;
        this.log.push({ e: 'dora', tile: this.wall[126 + this.doraCount - 1] });
      }
      if (R.kind === 'kakan' || R.kind === 'ankan') {
        // 槍槓がなかった → 槓を成立させて嶺上牌をツモる
        return this.finishKan(R.from, R.kind, k, tile);
      }
      // ポン・明槓・チー
      let caller = -1, act = null;
      for (let i = 1; i < 4; i++) { const s = (from + i) % 4; const a = responses[s]; if (a && (a.t === 'pon' || a.t === 'minkan')) { caller = s; act = a; } }
      if (caller < 0) { const s = (from + 1) % 4; const a = responses[s]; if (a && a.t === 'chi') { caller = s; act = a; } }
      if (caller >= 0) return this.call(caller, act, from, tile);
      return this.afterDiscardPassed(from);
    }

    afterDiscardPassed(from) {
      // 途中流局
      if (this.noCalls && this.firstDiscards.length === 4 && this.discards.every(d => d.length === 1)) {
        const f = this.firstDiscards;
        if (f[0] >= 27 && f[0] <= 30 && f.every(x => x === f[0])) return this.abort('suufon', {});
      }
      if (this.riichi.every(x => x)) return this.abort('suucha', {});
      if (this.kanBy.length === 4 && new Set(this.kanBy).size > 1) return this.abort('suukaikan', {});
      if (this.livePos >= this.liveEnd) {
        if (this.external) { this.phase = 'exhaust'; this.react = null; return; } // 聴牌の宣言を待つ（doExhaust）
        return this.exhaust();
      }
      this.drawFor((from + 1) % 4, false);
    }

    call(s, a, from, tile) {
      const k = tile >> 2;
      this.discards[from][this.discards[from].length - 1].called = true;
      this.noCalls = false;
      this.ippatsu = [false, false, false, false];
      let use;
      if (a.t === 'minkan') use = this.hands[s].filter(x => (x >> 2) === k).slice(0, 3);
      else use = a.use.slice();
      for (const id of use) this.removeTile(s, id);
      const type = a.t === 'minkan' ? 'minkan' : a.t;
      const tiles = use.concat([tile]);
      const meld = { type, tiles, called: tile, from };
      this.melds[s].push(meld);
      this.log.push({ e: 'call', s, type, tiles, from, called: tile });
      this.checkPao(s, k, from);
      if (type === 'minkan') {
        this.kanBy.push(s);
        this.pendingDora++;
        this.waits[s] = waitsOf(this.counts[s], this.melds[s].length);
        this.drawFor(s, true);
        return;
      }
      this.cur = s; this.drawn = -1; this.afterKan = false;
      this.kuikae = this.kuikaeKinds(type, k, use.map(x => x >> 2));
      this.phase = 'turn'; this.react = null;
    }
    checkPao(s, k, from) {
      if (!this.rules.pao) return;
      const ms = this.melds[s].filter(m => m.type !== 'chi');
      if (k >= 31 && ms.filter(m => (m.tiles[0] >> 2) >= 31).length === 3) this.pao[s] = from;
      if (k >= 27 && k <= 30 && ms.filter(m => { const kk = m.tiles[0] >> 2; return kk >= 27 && kk <= 30; }).length === 4) this.pao[s] = from;
    }

    declareKan(s, type, k, tile) {
      if (type === 'kakan') {
        // 槍槓の機会（ほかの人のロンを待つ）
        this.removeTile(s, tile);
        this.log.push({ e: 'kakan-declare', s, tile });
        this.openReact('kakan', s, tile);
        return;
      }
      // 暗槓: 国士無双だけ槍槓できる
      const ids = this.hands[s].filter(x => (x >> 2) === k);
      for (const id of ids) this.removeTile(s, id);
      this.pendingAnkan = ids;
      this.log.push({ e: 'ankan-declare', s, kind: k });
      this.openReact('ankan', s, ids[0]);
    }
    finishKan(s, type, k, tile) {
      this.noCalls = false;
      this.ippatsu = [false, false, false, false];
      if (type === 'kakan') {
        const m = this.melds[s].find(x => x.type === 'pon' && (x.tiles[0] >> 2) === k);
        m.type = 'kakan'; m.tiles.push(tile); m.added = tile;
        this.log.push({ e: 'call', s, type: 'kakan', tiles: m.tiles.slice(), from: m.from, called: m.called, added: tile });
        this.pendingDora++;
      } else {
        const ids = this.pendingAnkan; this.pendingAnkan = null;
        this.melds[s].push({ type: 'ankan', tiles: ids, called: -1, from: s });
        this.log.push({ e: 'call', s, type: 'ankan', tiles: ids, from: s });
        // 暗槓の新ドラはすぐめくる（その前に溜まっていた明槓の分も）
        this.doraCount += this.pendingDora + 1; this.pendingDora = 0;
        this.log.push({ e: 'dora', tile: this.wall[126 + this.doraCount - 1] });
      }
      this.kanBy.push(s);
      this.waits[s] = waitsOf(this.counts[s], this.melds[s].length);
      this.drawFor(s, true);
    }

    // ------------- 和了・流局
    winTsumo(s) {
      const ev = this.evalWin(s, this.drawn, true);
      const win = this.payWin(s, -1, ev, true);
      this.finish({ type: 'agari', wins: [win] });
    }
    winRon(seats, from, tile, kind) {
      const wins = [];
      if (kind === 'kakan') { /* 加槓の牌はまだ副露に入っていない（手から抜いたまま） */ }
      if (kind === 'ankan') { for (const id of this.pendingAnkan) if (id !== tile) this.addTile(from, id); this.pendingAnkan = null; }
      if (this.pendingRiichi === from) this.pendingRiichi = -1; // 立直の宣言牌で放銃 → 立直は不成立（供託なし）
      for (const s of seats) {
        this.addTile(s, tile);
        const ev = this.evalWin(s, tile, false, { chankan: kind !== 'discard' });
        wins.push({ s, ev });
      }
      // 供託は放銃者から近い人へ、本場は全員へ
      const out = wins.map((w, i) => this.payWin(w.s, from, w.ev, false, i === 0));
      this.finish({ type: 'agari', wins: out });
    }
    // 点の移動を計算して scores に反映する。返り値は画面・記録用の和了の情報
    payWin(s, from, ev, tsumo, getKyotaku = true) {
      const dealer = s === this.dealer;
      const deltas = [0, 0, 0, 0];
      const hb = this.honba;
      const paoFrom = this.pao[s];
      const paoYakuman = paoFrom >= 0 && ev.yakuman ? ev.yakuKeys.filter(k => k === 'daisangen' || k === 'daisuushii').length : 0;
      const restBasic = ev.basic - 8000 * paoYakuman;
      const paoBasic = 8000 * paoYakuman;
      const pay = (p, v) => { deltas[p] -= v; deltas[s] += v; };
      if (tsumo) {
        if (restBasic > 0) {
          const P = payOf(restBasic, dealer, true);
          for (let p = 0; p < 4; p++) if (p !== s) pay(p, (dealer ? P.all : p === this.dealer ? P.dealer : P.child));
        }
        if (paoBasic) pay(paoFrom, ceil100(paoBasic * (dealer ? 6 : 4)));
        if (paoBasic && restBasic <= 0) pay(paoFrom, hb * 300);
        else for (let p = 0; p < 4; p++) if (p !== s) pay(p, hb * 100);
      } else {
        if (restBasic > 0) pay(from, payOf(restBasic, dealer, false).ron);
        if (paoBasic) {
          const tot = ceil100(paoBasic * (dealer ? 6 : 4));
          if (paoFrom === from) pay(from, tot);
          else { pay(paoFrom, tot / 2); pay(from, tot / 2); }
        }
        pay(from, hb * 300);
      }
      let sticks = 0;
      if (getKyotaku && this.kyotaku) { sticks = this.kyotaku * 1000; deltas[s] += sticks; this.kyotaku = 0; }
      for (let p = 0; p < 4; p++) this.scores[p] += deltas[p];
      return {
        seat: s, from, tsumo, han: ev.han, fu: ev.fu, yakuman: ev.yakuman, yaku: ev.yaku, limit: ev.limit, basic: ev.basic,
        hand: this.hands[s].slice(), melds: this.melds[s].map(m => ({ type: m.type, tiles: m.tiles.slice(), from: m.from, called: m.called })),
        winTile: tsumo ? this.drawn : this.react.tile, deltas, sticks, pao: paoBasic ? paoFrom : -1,
        dora: this.doraIndicators(), ura: this.riichi[s] ? this.uraIndicators() : [],
        value: deltas[s],
      };
    }
    // オンラインの写しの荒牌流局: 見えない席の聴牌は宣言（手牌を見せた席だけ聴牌）
    doExhaust(declared) {
      if (this.phase !== 'exhaust') throw new Error('荒牌流局ではありません');
      this.steps.push({ k: 'x', d: declared.map(Boolean) });
      for (let s = 0; s < 4; s++) if (this.hidden[s]) this.waits[s] = declared[s] && !this.hands[s].some(x => x >= 1000) ? waitsOf(this.counts[s], this.melds[s].length) : [];
      this.exhaust();
    }
    exhaust() {
      // 流し満貫（捨て牌がすべて么九牌で、1枚も鳴かれていない）
      const nagashi = [];
      if (this.rules.nagashi) for (let s = 0; s < 4; s++) {
        const d = this.discards[s];
        if (d.length && d.every(x => isYaochu(x.tile >> 2) && !x.called)) nagashi.push(s);
      }
      const tenpai = [0, 1, 2, 3].map(s => this.waits[s].length > 0);
      const deltas = [0, 0, 0, 0];
      if (nagashi.length) {
        for (const s of nagashi) {
          const dealer = s === this.dealer, P = payOf(2000, dealer, true);
          for (let p = 0; p < 4; p++) if (p !== s) { const v = dealer ? P.all : p === this.dealer ? P.dealer : P.child; deltas[p] -= v; deltas[s] += v; }
        }
      } else {
        const n = tenpai.filter(Boolean).length;
        if (n > 0 && n < 4) for (let s = 0; s < 4; s++) deltas[s] += tenpai[s] ? 3000 / n : -3000 / (4 - n);
      }
      for (let p = 0; p < 4; p++) this.scores[p] += deltas[p];
      this.finish({ type: 'ryukyoku', reason: nagashi.length ? 'nagashi' : 'exhaust', tenpai, nagashi, deltas,
        hands: [0, 1, 2, 3].map(s => (tenpai[s] ? this.hands[s].slice() : null)) });
    }
    abort(reason, info) {
      this.finish(Object.assign({ type: 'ryukyoku', reason, tenpai: [false, false, false, false], deltas: [0, 0, 0, 0], abortive: true }, info));
    }
    finish(res) {
      // 親の連荘: 親の和了・流局で親が聴牌・途中流局
      const dealerWon = res.type === 'agari' && res.wins.some(w => w.seat === this.dealer);
      res.dealerKeeps = dealerWon || (res.type === 'ryukyoku' && (res.abortive || res.tenpai[this.dealer]));
      res.nonDealerWon = res.type === 'agari' && !dealerWon;
      res.scores = this.scores.slice();
      res.kyotaku = this.kyotaku;
      this.result = res;
      this.phase = 'end';
      this.react = null;
      this.log.push({ e: 'end', result: res });
    }
  }

  // ------------------------------------------------------------------ 半荘（東風戦・東南戦）
  class Game {
    constructor(rules, seed) {
      this.rules = rulesOf(rules);
      this.seed = seed >>> 0;
      this.rng = makeRng(this.seed);
      this.scores = [0, 1, 2, 3].map(() => this.rules.startPoints);
      this.roundWind = 0; this.kyoku = 0; this.honba = 0; this.kyotaku = 0;
      this.rounds = [];   // 済んだ局: { roundWind, kyoku, honba, kyotaku, scoresBefore, wall, steps, result }
      this.ended = false;
      this.round = null;
    }
    get lastRoundIndex() { return this.rules.length === 'tonpu' ? 3 : 7; }
    get roundIndex() { return this.roundWind * 4 + this.kyoku; }
    isAllLast() { return this.roundIndex >= this.lastRoundIndex; }
    roundName(rw = this.roundWind, ky = this.kyoku, hb = this.honba) { return `${WIND_JA[rw]}${ky + 1}局${hb ? ` ${hb}本場` : ''}`; }
    newRound(wall) {
      if (this.ended) throw new Error('対局は終わっています');
      const w = wall || shuffledWall(this.rng);
      this.round = new Round({ rules: this.rules, wall: w, dealer: this.kyoku, roundWind: this.roundWind, kyoku: this.kyoku, honba: this.honba, kyotaku: this.kyotaku, scores: this.scores });
      this.round.scoresBefore = this.scores.slice();
      this.round.gameInfo = { roundIndex: this.roundIndex, last: this.lastRoundIndex, tonpu: this.rules.length === 'tonpu', firstDealer: 0 };
      return this.round;
    }
    // 局の結果を反映して次の局へ（終わったら ended）
    finishRound() {
      const r = this.round, res = r.result;
      if (!res) throw new Error('局が終わっていません');
      this.rounds.push({ roundWind: this.roundWind, kyoku: this.kyoku, honba: this.honba, kyotaku: this.kyotaku, scoresBefore: r.scoresBefore, wall: r.wall, steps: r.steps, result: res });
      this.scores = r.scores.slice();
      this.kyotaku = r.kyotaku;
      const dealer = this.kyoku;
      let end = false;
      if (this.rules.tobi && this.scores.some(x => x < 0)) end = true;
      if (res.dealerKeeps) {
        this.honba++;
        // アガリ止め（オーラスで親が和了って1位）
        if (this.isAllLast() && this.rules.agariYame && res.type === 'agari' && res.wins.some(w => w.seat === dealer) && this.rankOf(dealer) === 0) end = true;
      } else {
        this.honba = res.type === 'ryukyoku' ? this.honba + 1 : 0;
        if (this.isAllLast()) end = true;
        else { this.kyoku++; if (this.kyoku === 4) { this.kyoku = 0; this.roundWind++; } }
      }
      this.round = null;
      if (end) this.end();
      return end;
    }
    rankOrder(scores = this.scores) {
      // 同点は起家（席0）に近い方が上
      return [0, 1, 2, 3].sort((a, b) => (scores[b] - scores[a]) || (a - b));
    }
    rankOf(s, scores) { return this.rankOrder(scores).indexOf(s); }
    end() {
      this.ended = true;
      const order = this.rankOrder();
      if (this.kyotaku) { this.scores[order[0]] += this.kyotaku * 1000; this.kyotaku = 0; }
      const ru = this.rules, oka = (ru.returnPoints - ru.startPoints) * 4 / 1000;
      this.final = [0, 1, 2, 3].map(s => {
        const rk = order.indexOf(s);
        const pt = (this.scores[s] - ru.returnPoints) / 1000 + ru.uma[rk] + (rk === 0 ? oka : 0);
        return { seat: s, rank: rk, score: this.scores[s], point: Math.round(pt * 10) / 10 };
      });
    }
  }
  // 局を記録から作り直す（見返し・再読み込み・オンラインの確かめ）
  function replayRound(o, steps, upto) {
    const r = new Round(o);
    const n = upto == null ? steps.length : upto;
    for (let i = 0; i < n && r.phase !== 'end'; i++) {
      const st = steps[i];
      // オンラインの記録には、全部見送りの返事や荒牌流局の宣言もある（ふつうの局では自動で進むので飛ばす）
      if (st.k === 'r' && r.phase !== 'react') { if (st.resp.some(Boolean)) throw new Error('記録が合いません'); continue; }
      if (st.k === 'x') { if (r.phase === 'exhaust') r.doExhaust(st.d); continue; }
      if (st.k === 't') r.doTurn(st.a); else r.doReact(st.resp);
    }
    return r;
  }

  return {
    NK, RED_IDS, KIND_NAMES, HONOR_JA, WIND_JA, YAOCHU, DEAD,
    kindOf, suitOf, numOf, isHonor, isTerminal, isYaochu, isSimple, isDragon, isWind, doraOf, kindJa, kindShort,
    parseTiles, parseKinds, countsOf,
    shanten, shantenNormal, shantenChiitoi, shantenKokushi, waitsOf, ukeire, ukeireCount, decompose,
    evaluateHand, basicPoints, payOf, limitName, YAKU, YAKUMAN, YAKU_LIST, YAKUMAN_LIST,
    DEFAULT_RULES, rulesOf, makeRng, shuffledWall, Round, Game, replayRound,
  };
});
