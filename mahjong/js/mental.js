/* だれも山の並びを知らない配り方（メンタルポーカー）: 136枚の牌を ElGamal 暗号と「全員の鍵を掛け合わせた合同の鍵」で混ぜる
 *
 * しくみ（1局ごとに鍵を作り直す）:
 *   1. 参加する人（その局でつながっている人）がそれぞれ秘密の数 x を選び、公開の鍵 h = g^x を出す。合同の鍵 H = h1·h2·…
 *   2. 牌 i（0..135）を数 m_i = g^(i+1) で表し、参加者が順番に「全部を暗号のまま混ぜ直して（再暗号化）並べ替える」。
 *      暗号文は (a, b) = (g^r, m·H^r)。混ぜ直しは (a·g^s, b·H^s) で、中身を知らなくてもできる。全員が混ぜ終わると、だれも並びを知らない
 *   3. 牌を開くには全員の「部分の鍵」 a^x が要る。自分の牌（配牌・ツモ）は、ほかの人が部分の鍵を出し、自分の分だけ手元で掛けて開く → 自分にしか見えない
 *      捨て牌・鳴き・和了で牌を見せるときは、持ち主が自分の部分の鍵を出す → だれでも開ける。ドラ表示牌は全員が出す
 *   4. 局が終わったら全員が x を出し、山が136枚をちょうど1枚ずつ並べ替えたものだったか、局の手順がルールどおりだったかを全員で確かめる
 * 群は RFC 2409 の 1024 ビットの安全素数（p = 2q+1）。g = 2 は位数 q の部分群を作る（ホールデムと同じ）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MJMental = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const N = 136;
  const P = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF');
  const Q = (P - 1n) / 2n;
  const G = 2n;
  const BYTES = 128;

  function modpow(b, e) {
    let r = 1n;
    b %= P;
    while (e > 0n) { if (e & 1n) r = r * b % P; e >>= 1n; b = b * b % P; }
    return r;
  }
  // 逆数（拡張ユークリッドの互除法。累乗より速い）
  function inv(a) {
    let t = 0n, nt = 1n, r = P, nr = ((a % P) + P) % P;
    while (nr) { const q = r / nr; [t, nt] = [nt, t - q * nt]; [r, nr] = [nr, r - q * nr]; }
    return t < 0n ? t + P : t;
  }
  // まとめて逆数（Montgomery の方法: 逆数の計算は1回だけ）
  function invAll(xs) {
    const n = xs.length, pre = new Array(n);
    let acc = 1n;
    for (let i = 0; i < n; i++) { pre[i] = acc; acc = acc * xs[i] % P; }
    let ia = inv(acc);
    const out = new Array(n);
    for (let i = n - 1; i >= 0; i--) { out[i] = ia * pre[i] % P; ia = ia * xs[i] % P; }
    return out;
  }
  // 底が決まっているときの速い累乗（6ビットずつの表）
  function fixedBase(base, bits = 264) {
    const W = 6, rows = Math.ceil(bits / W), tbl = [];
    let b = base % P;
    for (let i = 0; i < rows; i++) {
      const row = [1n];
      for (let j = 1; j < 64; j++) row.push(row[j - 1] * b % P);
      tbl.push(row);
      for (let k = 0; k < W; k++) b = b * b % P;
    }
    return e => {
      let r = 1n, i = 0;
      while (e > 0n && i < rows) { const d = Number(e & 63n); if (d) r = r * tbl[i][d] % P; e >>= 6n; i++; }
      if (e > 0n) r = r * modpow(base, e << BigInt(W * rows)) % P;
      return r;
    };
  }
  const gExp = fixedBase(G);

  function randBytes(n) {
    const u = new Uint8Array(n);
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : (typeof require === 'function' ? require('crypto').webcrypto : null);
    c.getRandomValues(u);
    return u;
  }
  function randScalar() {
    let x = 0n;
    for (const v of randBytes(32)) x = (x << 8n) | BigInt(v);
    return x === 0n ? 1n : x;
  }
  function randInt(n) {
    const lim = Math.floor(4294967296 / n) * n;
    for (;;) { const u = randBytes(4); const v = ((u[0] << 24) | (u[1] << 16) | (u[2] << 8) | u[3]) >>> 0; if (v < lim) return v % n; }
  }

  // BigInt ↔ base64（128 バイト）
  function toB64(x) {
    let hex = x.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const bytes = new Uint8Array(BYTES);
    const off = BYTES - hex.length / 2;
    for (let i = 0; i < hex.length / 2; i++) bytes[off + i] = parseInt(hex.substr(i * 2, 2), 16);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
  }
  function fromB64(str) {
    if (typeof str !== 'string' || str.length > 200) throw new Error('数の形が違います');
    const s = typeof atob === 'function' ? atob(str) : Buffer.from(str, 'base64').toString('binary');
    let x = 0n;
    for (let i = 0; i < s.length; i++) x = (x << 8n) | BigInt(s.charCodeAt(i));
    if (x <= 0n || x >= P) throw new Error('範囲外の数です');
    return x;
  }
  // 秘密の数 x（256 ビット）は16進で保存する
  const xToHex = x => x.toString(16);
  const xFromHex = h => { if (typeof h !== 'string' || !/^[0-9a-f]{1,80}$/.test(h)) throw new Error('鍵の形が違います'); return BigInt('0x' + h); };

  // 牌の数: m_i = g^(i+1)
  let ENC = null, DEC = null;
  function tables() {
    if (ENC) return;
    ENC = []; DEC = new Map();
    for (let i = 0; i < N; i++) { const m = gExp(BigInt(i + 1)); ENC.push(m); DEC.set(m.toString(16), i); }
  }
  const decode = m => { tables(); const v = DEC.get(m.toString(16)); return v == null ? -1 : v; };

  function keygen() { const x = randScalar(); return { x, h: gExp(x) }; }
  function jointKey(hs) { let h = 1n; for (const x of hs) h = h * x % P; return h; }
  function initialDeck() { tables(); return ENC.map(m => [1n, m]); }
  // 混ぜ直して並べ替える
  function reshuffle(deck, H) {
    const hExp = fixedBase(H);
    const out = deck.map(([a, b]) => { const s = randScalar(); return [a * gExp(s) % P, b * hExp(s) % P]; });
    for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out;
  }
  const share = (a, x) => modpow(a, x);
  // 全員の部分の鍵で開く（牌の番号 0..135、だめなら -1）
  function open(card, shares) {
    let d = 1n;
    for (const s of shares) d = d * s % P;
    return decode(card[1] * inv(d) % P);
  }
  const deckToWire = deck => deck.map(([a, b]) => [toB64(a), toB64(b)]);
  function deckFromWire(w) {
    if (!Array.isArray(w) || w.length !== N) throw new Error('山の形が違います');
    return w.map(c => { if (!Array.isArray(c) || c.length !== 2) throw new Error('山の形が違います'); return [fromB64(c[0]), fromB64(c[1])]; });
  }
  // 局のあとの検査: 全員の x で山を全部開き、136枚がちょうど1枚ずつあるか（h = g^x も確かめる）
  function audit(deck, xs, hs) {
    for (let j = 0; j < xs.length; j++) if (hs && gExp(xs[j]) !== hs[j]) return { ok: false, bad: j, why: 'key' };
    let X = 0n;
    for (const x of xs) X += x;
    const ivs = invAll(deck.map(([a]) => modpow(a, X)));
    const cards = deck.map(([, b], i) => decode(b * ivs[i] % P));
    const seen = new Set(cards);
    if (cards.some(c => c < 0) || seen.size !== N) return { ok: false, why: 'deck', cards };
    return { ok: true, cards };
  }
  return { N, P, Q, G, modpow, gExp, fixedBase, randScalar, toB64, fromB64, xToHex, xFromHex, keygen, jointKey, initialDeck, reshuffle, share, open, decode, deckToWire, deckFromWire, audit };
});
