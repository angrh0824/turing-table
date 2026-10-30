/* だれも山の並びを知らない配り方（メンタルポーカー）: 52〜54枚の札を ElGamal 暗号と「全員の鍵を掛け合わせた合同の鍵」で混ぜる
 *
 * しくみ（1回戦ごとに鍵を作り直す）:
 *   1. 参加する人（その回の始めにつながっている人間）がそれぞれ秘密の数 x を選び、公開の鍵 h = g^x を出す。合同の鍵 H = h1·h2·…
 *   2. 札 i を数 m_i = g^(i+1) で表し、参加者が順番に「全部を暗号のまま混ぜ直して（再暗号化）並べ替える」。
 *      暗号文は (a, b) = (g^r, m·H^r)。混ぜ直しは (a·g^s, b·H^s) で、中身を知らなくてもできる。全員が混ぜ終わると、だれも並びを知らない
 *   3. 札を開くには全員の「部分の鍵」 a^x が要る。自分の手札は、ほかの全員が部分の鍵を出し、自分の分だけ手元で掛けて開く → 自分にしか見えない
 *      場に出すときは、持ち主が残りの部分の鍵を出す → だれでも開ける
 *   4. 交換・7渡しで札を渡すときは、残りの部分の鍵を「渡す相手との共通の鍵」 K = (相手の h)^(自分の x) = g^(x·y) で隠して送る → 相手だけが開ける
 *   5. 回が終わったら全員が x と「混ぜ方」（並べ替えと再暗号化の乱数）を出し、山の各段・開いた札・手順をみんなで確かめる
 * 群は RFC 2409 の 1024 ビットの安全素数（p = 2q+1）。g = 2 は位数 q の部分群を作る
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DFMental = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
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
  function inv(a) {
    let t = 0n, nt = 1n, r = P, nr = ((a % P) + P) % P;
    while (nr) { const q = r / nr; [t, nt] = [nt, t - q * nt]; [r, nr] = [nr, r - q * nr]; }
    return t < 0n ? t + P : t;
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
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require('crypto').webcrypto;
    c.getRandomValues(u);
    return u;
  }
  function randScalar() {
    let x = 0n;
    for (const v of randBytes(32)) x = (x << 8n) | BigInt(v);
    x %= Q;
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
  const xToHex = x => x.toString(16);
  const xFromHex = h => { if (typeof h !== 'string' || !/^[0-9a-f]{1,80}$/.test(h)) throw new Error('鍵の形が違います'); return BigInt('0x' + h); };

  // 札の数: m_i = g^(i+1)（i = 札の番号 0..53）
  let ENC = null, DEC = null;
  function tables() {
    if (ENC) return;
    ENC = []; DEC = new Map();
    for (let i = 0; i < 54; i++) { const m = gExp(BigInt(i + 1)); ENC.push(m); DEC.set(m.toString(16), i); }
  }
  const decode = m => { tables(); const v = DEC.get(m.toString(16)); return v == null ? -1 : v; };

  function keygen() { const x = randScalar(); return { x, h: gExp(x) }; }
  function jointKey(hs) { let h = 1n; for (const x of hs) h = h * x % P; return h; }
  // はじめの山（札の番号の並び cards のとおり。暗号の乱数は 0 = まだ混ぜていない）
  function initialDeck(cards) { tables(); return cards.map(c => [1n, ENC[c]]); }
  // 混ぜ直して並べ替える（あとで確かめられるよう、並べ替えと乱数も返す）: out[i] = 再暗号化(deck[perm[i]], ss[i])
  function reshuffle(deck, H) {
    const hExp = fixedBase(H), n = deck.length;
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = randInt(i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    const ss = [], out = [];
    for (let i = 0; i < n; i++) {
      const s = randScalar(), [a, b] = deck[perm[i]];
      ss.push(s);
      out.push([a * gExp(s) % P, b * hExp(s) % P]);
    }
    return { deck: out, perm, ss };
  }
  // 段の確かめ: next が prev を perm・ss のとおりに混ぜ直したものか
  function checkShuffle(prev, next, H, perm, ss) {
    const n = prev.length;
    if (!Array.isArray(perm) || perm.length !== n || !Array.isArray(ss) || ss.length !== n || next.length !== n) return false;
    if (new Set(perm).size !== n || perm.some(i => !(i >= 0 && i < n))) return false;
    const hExp = fixedBase(H);
    for (let i = 0; i < n; i++) {
      const s = ss[i], [a, b] = prev[perm[i]];
      if (a * gExp(s) % P !== next[i][0] || b * hExp(s) % P !== next[i][1]) return false;
    }
    return true;
  }
  const share = (a, x) => modpow(a, x);
  // 全員の部分の鍵で開く（札の番号、だめなら -1）
  function open(ct, shares) {
    let d = 1n;
    for (const s of shares) d = d * s % P;
    return decode(ct[1] * inv(d) % P);
  }
  // 2人の間だけの鍵（相手の公開の鍵 h と自分の秘密 x から）で部分の鍵を隠す・戻す
  const dhKey = (hOther, xMine) => modpow(hOther, xMine);
  const seal = (sh, K) => sh * K % P;
  const unseal = (c, K) => c * inv(K) % P;
  const deckToWire = deck => deck.map(([a, b]) => [toB64(a), toB64(b)]);
  function deckFromWire(w, n) {
    if (!Array.isArray(w) || w.length !== n) throw new Error('山の形が違います');
    return w.map(c => { if (!Array.isArray(c) || c.length !== 2) throw new Error('山の形が違います'); return [fromB64(c[0]), fromB64(c[1])]; });
  }
  // 回のあとの検査: 全員の x で山を全部開き、札がちょうど1枚ずつあるか（h = g^x も確かめる）
  function audit(deck, xs, hs, cardList) {
    for (let j = 0; j < xs.length; j++) if (hs && gExp(xs[j]) !== hs[j]) return { ok: false, bad: j, why: 'key' };
    let X = 0n;
    for (const x of xs) X += x;
    const cards = deck.map(([a, b]) => decode(b * inv(modpow(a, X)) % P));
    const want = cardList.slice().sort((p, q) => p - q).join(), got = cards.slice().sort((p, q) => p - q).join();
    if (cards.some(c => c < 0) || want !== got) return { ok: false, why: 'deck', cards };
    return { ok: true, cards };
  }
  return { P, Q, G, modpow, inv, gExp, fixedBase, randScalar, toB64, fromB64, xToHex, xFromHex, keygen, jointKey, initialDeck, reshuffle, checkShuffle, share, open, decode, dhKey, seal, unseal, deckToWire, deckFromWire, audit };
});
