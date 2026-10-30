/* オンラインのサイコロ: 両者が乱数を出し合い、どちらも目を操作できないようにする（コミット → 公開）
 *
 * 1. 局の始めに、各自が秘密の乱数 s（32バイト）から SHA-256 の鎖を作る: L[N] = s, L[i] = SHA256(L[i+1])
 *    いちばん上の L[0]（アンカー）だけを先に相手へ送る（= 鎖全体へのコミット。あとから値を変えられない）
 * 2. k 回目の振りでは、各自が L[k+1] を公開する。受け取った側は SHA256(L[k+1]) = L[k]（前に受け取った値）で本物か確かめる
 *    L[k+1] は L[k] からは計算できない（SHA-256 の逆は求められない）ので、相手は先の値を知りようがない
 * 3. 目 = SHA256(白の値 ‖ 黒の値 ‖ 局と回の番号) のバイトから、偏りなく 1〜6 を2つ（252 以上のバイトは捨てる）
 * 4. 振る順番: 振る側が「ダブルしないで振る」と決めて自分の値を送り、相手はそれを受けてから自分の値を返す
 *    → 振る側は相手の値を知らないので、目を知ってからダブルを決めることはできない。相手も自分の値は鎖で決まっているので選べない
 *    できる不正は「応答しない（止める）」ことだけで、それは画面に「応答がありません」と出る
 */
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const hex = buf => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const unhex = s => new Uint8Array((String(s).match(/[0-9a-f]{2}/g) || []).map(h => parseInt(h, 16)));
  const ok = () => !!(root.crypto && root.crypto.subtle);
  async function sha(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
  // 鎖を作る。返り値は 16進の配列 links[0..n]（links[0] がアンカー）
  async function makeChain(secretHex, n) {
    const links = new Array(n + 1);
    let cur = unhex(secretHex);
    links[n] = hex(cur);
    for (let i = n - 1; i >= 0; i--) { cur = await sha(cur); links[i] = hex(cur); }
    return links;
  }
  // 公開された値 v が、1つ前の値 prev（またはアンカー）につながっているか
  async function verify(prevHex, vHex) {
    if (!/^[0-9a-f]{64}$/.test(String(vHex || ''))) return false;
    return hex(await sha(unhex(vHex))) === prevHex;
  }
  async function diceFrom(whiteHex, blackHex, tag) {
    let h = await sha(enc.encode(`${whiteHex}|${blackHex}|${tag}`));
    const out = [];
    let k = 0;
    while (out.length < 2) {
      if (k >= h.length) { h = await sha(h); k = 0; }
      const v = h[k++];
      if (v < 252) out.push(1 + (v % 6));
    }
    return out;
  }
  const randomSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
  root.BGDice = { ok, makeChain, verify, diceFrom, randomSecret, CHAIN: 600 };
})(typeof self !== 'undefined' ? self : this);
