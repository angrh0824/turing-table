/* オンラインの山札の混ぜ方（mental poker: SRA の可換暗号）
 *
 * ねらい: どちらの端末も山札の並びと相手の手札を知らない。それでいて、あとから「ごまかしがなかった」ことを確かめられる
 *
 *   札 c を数 m(c) = (c + 2)^2 mod P で表す（P は安全素数 P = 2Q + 1。平方にして位数 Q の部分群に入れる）
 *   鍵 e（1 < e < Q）で暗号化 E(x) = x^e mod P、復号 D(x) = x^(e^-1 mod Q) mod P。2人の鍵の順番を入れ替えても同じになる（可換）
 *
 *   ① 親: 48枚をすべて自分の鍵で暗号化して、並べ替えて送る
 *   ② 子: それをさらに自分の鍵で暗号化して、並べ替えて送る → 山札 D[0..47]（どちらも中身を知らない）
 *   ③ 配る: 相手の手札の場所には自分の鍵をはずした値（share）を送る。相手は自分の鍵をはずして札がわかる
 *            場の札・めくる札は、2人ともの share がそろったときにだれでもわかる
 *   ④ 月の終わりに2人とも鍵を見せ合い、①②の並べ替え・すべての share・出した札が正しかったかを確かめる
 *
 * P は RFC 2409 の 768 ビットの MODP 群の素数（安全素数）
 */
(function (root) {
  'use strict';
  const P = BigInt('0x' + 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF');
  const Q = (P - 1n) / 2n;
  const HEXLEN = 192;

  function modPow(b, e, m) {
    let r = 1n;
    b %= m;
    while (e > 0n) {
      if (e & 1n) r = r * b % m;
      b = b * b % m;
      e >>= 1n;
    }
    return r;
  }
  function modInv(a, m) {
    let [r0, r1] = [a % m, m], [s0, s1] = [1n, 0n];
    while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
    if (r0 !== 1n) throw new Error('not invertible');
    return ((s0 % m) + m) % m;
  }
  const rand = n => {
    const u = new Uint8Array(n);
    (root.crypto || require('crypto').webcrypto).getRandomValues(u);
    return u;
  };
  function randBig(bytes) { let x = 0n; for (const b of rand(bytes)) x = (x << 8n) | BigInt(b); return x; }
  const hex = x => x.toString(16).padStart(HEXLEN, '0');
  const big = h => {
    if (typeof h !== 'string' || !/^[0-9a-f]{1,200}$/.test(h)) throw new Error('bad number');
    const x = BigInt('0x' + h);
    if (x <= 1n || x >= P) throw new Error('out of range');
    return x;
  };
  const CODE = [];
  const CARD_OF = new Map();
  for (let c = 0; c < 48; c++) { const m = modPow(BigInt(c + 2), 2n, P); CODE.push(m); CARD_OF.set(hex(m), c); }

  // 鍵: { e, d }（16進の文字列で保存できる形も）
  function makeKey() {
    const e = 2n + randBig(104) % (Q - 3n);
    return { e, d: modInv(e, Q) };
  }
  const keyToHex = k => hex(k.e);
  const keyFromHex = h => { const e = BigInt('0x' + h); return { e, d: modInv(e, Q) }; };
  const enc = (x, k) => modPow(x, k.e, P);
  const dec = (x, k) => modPow(x, k.d, P);
  function shuffle(a) {
    const r = rand(a.length * 4);
    const dv = new DataView(r.buffer);
    for (let i = a.length - 1; i > 0; i--) {
      const j = dv.getUint32(i * 4) % (i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ① 親: 48枚を暗号化して並べ替える
  function step1(key) { return shuffle(CODE.map(m => hex(enc(m, key)))); }
  // ② 子: 受け取った48個をさらに暗号化して並べ替える
  function step2(deck, key) {
    if (!Array.isArray(deck) || deck.length !== 48) throw new Error('bad deck');
    const seen = new Set(deck);
    if (seen.size !== 48) throw new Error('duplicate');
    return shuffle(deck.map(h => hex(enc(big(h), key))));
  }
  // 自分の鍵をはずした値（相手やみんなに渡す）
  const share = (D, key) => hex(dec(big(D), key));
  // 相手の share から、自分の鍵をはずして札にする（札でなければ -1）
  function open(sh, key) { const c = CARD_OF.get(hex(dec(big(sh), key))); return c == null ? -1 : c; }
  // 相手の share が、相手の鍵で正しく作られたか（鍵を見せ合ったあと）
  const checkShare = (D, sh, keyE) => hex(modPow(big(sh), keyE, P)) === D;

  // ④ 鍵を見せ合ったあとの確かめ
  // ① が 48枚のちょうど1枚ずつを暗号化したものか
  function verifyStep1(deck, keyHex) {
    const k = keyFromHex(keyHex), cs = new Set();
    for (const h of deck) { const c = CARD_OF.get(hex(dec(big(h), k))); if (c == null) return false; cs.add(c); }
    return cs.size === 48;
  }
  // ② が ① をそのまま暗号化して並べ替えたものか
  function verifyStep2(inDeck, outDeck, keyHex) {
    const k = keyFromHex(keyHex);
    const a = inDeck.slice().sort(), b = outDeck.map(h => hex(dec(big(h), k))).sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  // 平方剰余か（部分群の外の値を混ぜるごまかしを見つける）
  const isQR = h => modPow(big(h), Q, P) === 1n;

  const api = { P, Q, makeKey, keyToHex, keyFromHex, step1, step2, share, open, checkShare, verifyStep1, verifyStep2, isQR, CARD_OF, hex, big, enc, dec };
  root.KoikoiMP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
