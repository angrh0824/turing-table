/* 軍人将棋のオンライン対局の約束事（信頼できる審判なしで、隠した駒のまま公平に遊ぶ）
 *   GunjinNet(C) → { sha256, randHex, makeCommit, reveal, reconstruct, verifyEnd, fingerprint }
 *
 *  1. 配置の約束: 対局の前に、自分の23枚それぞれについて「場所 k・種類・秘密の乱数（salt）」の SHA-256 を相手に送る。
 *     乱数があるので、ハッシュから駒の種類はわからない。あとから配置を変えると、ハッシュが合わなくなる
 *  2. 戦い: 攻める側は指し手と一緒に攻める駒の「種類と乱数」を明かし、守る側はそれを受け取ったら守る駒を明かす
 *     （守る駒が軍旗なら、強さを決める真後ろの駒も）。両方の端末が約束と照らして確かめ、同じ表で勝ち負けを決める。
 *     画面に出すのは結果だけ（明かされた種類は端末の中だけで使い、画面には出さない）
 *  3. 相手の司令部に入るとき: 少佐以上なら種類を明かして勝ちを宣言する。明かさなければ占領にはならない
 *  4. 終局: 両方が全部の配置と乱数を公開し、すべての約束・すべての手の合法性・すべての判定を最初からやり直して確かめる
 *
 * 対局の状態は「自分の記録」と「相手の記録」だけから毎回同じように組み立てる（reconstruct）。
 * 記録 rec = { cm: 約束[23], mv: {手数n: {m, rv?}}, dr: {手数n: {rv, sup}}, rs: {n, why}|null, op: {setup, salts}|null }
 *   rv / sup = {k, ty, s}（陣地の中の順番・種類・乱数）
 */
(function (root) {
  'use strict';
  function GunjinNet(C) {
    const { NP, BLACK, HQ, SHOSA, GUNKI, MOVABLE } = C;

    // ---------------------------------------------------------------- SHA-256（同期。文字列は UTF-8）
    const K256 = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    function utf8(s) { return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, 'utf8')); }
    function sha256(str) {
      const msg = utf8(str), l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, b = new Uint8Array(nb);
      b.set(msg); b[l] = 0x80;
      const bits = l * 8;
      b[nb - 4] = bits >>> 24; b[nb - 3] = (bits >>> 16) & 255; b[nb - 2] = (bits >>> 8) & 255; b[nb - 1] = bits & 255;
      b[nb - 8] = Math.floor(l / 0x20000000) & 255;
      const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      const w = new Uint32Array(64);
      const rotr = (x, n) => (x >>> n) | (x << (32 - n));
      for (let o = 0; o < nb; o += 64) {
        for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
        for (let i = 16; i < 64; i++) {
          const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
          const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
          const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
          hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
        }
        h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
      }
      let out = '';
      for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
      return out;
    }
    function randHex(n) {
      const a = new Uint8Array(n);
      const cr = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : null;
      if (cr) cr.getRandomValues(a); else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
      return Array.from(a, x => x.toString(16).padStart(2, '0')).join('');
    }
    const HEX = /^[0-9a-f]{64}$/, SALT = /^[0-9a-f]{32}$/;
    const commitOne = (mid, color, k, ty, s) => sha256(`gj1|${mid}|${color}|${k}|${ty}|${s}`);
    function makeCommit(mid, color, setup) {
      const salts = setup.map(() => randHex(16));
      return { salts, cs: setup.map((ty, k) => commitOne(mid, color, k, ty, salts[k])) };
    }
    const reveal = (setup, salts, k) => ({ k, ty: setup[k], s: salts[k] });
    const fingerprint = cs => (Array.isArray(cs) && cs.length === NP ? sha256(cs.join('')).slice(0, 8) : '');
    function checkReveal(mid, color, cm, rv, k) {
      if (!rv || (rv.k | 0) !== k || !(rv.ty >= 0 && rv.ty < C.NT) || typeof rv.s !== 'string' || !SALT.test(rv.s)) return false;
      return !!cm && commitOne(mid, color, k, rv.ty | 0, rv.s) === cm[k];
    }
    const validCm = cm => Array.isArray(cm) && cm.length === NP && cm.every(x => typeof x === 'string' && HEX.test(x));

    // ---------------------------------------------------------------- 状態を組み立てる
    // ctx = { mid, me, setup（自分の配置）, rec: [先手の記録, 後手の記録] }
    // 返り値: { pos, log, need, end, err, known: {k: 種類}（明かされた相手の駒。画面には出さない）, mask（相手の駒ごとの、動きから見てありえる種類） }
    //   need = { kind: 'move'|'reveal'|'commit', who, n }（だれの何を待っているか）
    function reconstruct(ctx) {
      const { mid, me, setup, rec } = ctx, op = me ^ 1;
      const out = { pos: null, log: [], need: null, end: null, err: null, known: {}, mask: new Uint16Array(NP).fill(C.ALL) };
      for (const c of [BLACK, 1]) if (!validCm(rec[c] && rec[c].cm)) { out.need = { kind: 'commit', who: c }; return out; }
      const setups = [null, null]; setups[me] = setup;
      const pos = out.pos = C.Pos.start(setups[0], setups[1]);
      const typeOf = (c, k, rv) => (c === me ? setup[k] : rv.ty | 0);
      for (let n = 1; ; n++) {
        const mover = pos.stm, R = rec[mover], D = rec[mover ^ 1];
        // 投了（相手の番に投了してもよい）。同じ手数で両方なら手番の側を先に見る
        const rsBy = [mover, mover ^ 1].find(c => rec[c].rs && (rec[c].rs.n | 0) === n);
        if (rsBy != null) { out.end = { winner: rsBy ^ 1, reason: rec[rsBy].rs.why === 'nomove' ? 'nomove' : 'resign' }; break; }
        const mv = R.mv && R.mv[n];
        if (!mv) { out.need = { kind: 'move', who: mover, n }; break; }
        const m = mv.m | 0, f = m >> 6, t = m & 63;
        const a = f < C.NC ? pos.sq[f] : -1;
        if (a < 0 || C.owner(a) !== mover || t >= C.NC || C.NODE[t] !== t) { out.err = `${n}手目: ありえない手`; break; }
        const ka = a % NP, can = pos.typesThatCan(f, t) & MOVABLE;
        if (!can) { out.err = `${n}手目: 動かせない手`; break; }
        if (mover === op) out.mask[ka] &= can;
        const d = pos.sq[t];
        let r = 0, aty = -1;
        const needRv = d >= 0 || (t === HQ[mover ^ 1] && mv.rv);
        if (needRv) {
          if (!checkReveal(mid, mover, R.cm, mv.rv, ka)) { out.err = `${n}手目: 攻めた駒の明かし方が約束と合いません`; break; }
          aty = typeOf(mover, ka, mv.rv);
          if (!(can >> aty & 1)) { out.err = `${n}手目: その駒はその動きができません`; break; }
          if (mover === op) { out.known[ka] = aty; out.mask[ka] &= 1 << aty; }
        }
        if (d >= 0) {
          if (C.owner(d) === mover) { out.err = `${n}手目: 自分の駒への動き`; break; }
          const dr = D.dr && D.dr[n], kd = d % NP;
          if (!dr) { out.need = { kind: 'reveal', who: mover ^ 1, n }; break; }
          if (!checkReveal(mid, mover ^ 1, D.cm, dr.rv, kd)) { out.err = `${n}手目: 守った駒の明かし方が約束と合いません`; break; }
          const dty = typeOf(mover ^ 1, kd, dr.rv);
          let sty = -1;
          if (dty === GUNKI) {
            const s = pos.support(d);
            if (s >= 0) {
              if (!checkReveal(mid, mover ^ 1, D.cm, dr.sup, s % NP)) { out.err = `${n}手目: 軍旗の後ろの駒の明かし方が約束と合いません`; break; }
              sty = typeOf(mover ^ 1, s % NP, dr.sup);
              if ((mover ^ 1) === op) { out.known[s % NP] = sty; out.mask[s % NP] &= 1 << sty; }
            }
          }
          if ((mover ^ 1) === op) { out.known[kd] = dty; out.mask[kd] &= 1 << dty; }
          r = C.judge(aty, dty, sty);
        }
        pos.apply(f, t, r);
        out.log.push({ f, t, r });
        // 司令部の占領（明かして宣言したときだけ）
        const o = pos.sq[HQ[mover ^ 1]];
        if (o === a && aty >= 0 && aty <= SHOSA) { out.end = { winner: mover, reason: 'hq' }; break; }
        if (o === a && mover === op && aty < 0) out.mask[ka] &= ~C.HQ_OK;
        if (pos.quiet >= C.QUIET_MAX) { out.end = { winner: -1, reason: 'quiet' }; break; }
        if (pos.ply >= C.MAX_PLY) { out.end = { winner: -1, reason: 'maxply' }; break; }
      }
      return out;
    }

    // ---------------------------------------------------------------- 終局の確かめ
    // 両方の公開した配置で、約束・明かした駒・すべての手と判定・勝敗をやり直す。{ ok, msg, setups }
    function verifyEnd(ctx, st) {
      const { mid, rec } = ctx;
      const setups = [null, null];
      for (const c of [0, 1]) {
        const o = rec[c].op;
        if (!o || !Array.isArray(o.setup) || !Array.isArray(o.salts)) return { ok: null, msg: '相手の配置の公開を待っています' };
        const s = o.setup.map(x => x | 0);
        if (!C.validSetup(s)) return { ok: false, msg: `${c === 0 ? '先手' : '後手'}の公開した配置がルールに合いません` };
        for (let k = 0; k < NP; k++) if (typeof o.salts[k] !== 'string' || commitOne(mid, c, k, s[k], o.salts[k]) !== rec[c].cm[k]) return { ok: false, msg: `${c === 0 ? '先手' : '後手'}の配置が最初の約束（ハッシュ）と合いません` };
        setups[c] = s;
      }
      const g = new C.Game(setups[0], setups[1]);
      for (let i = 0; i < st.log.length; i++) {
        const e = st.log[i], m = (e.f << 6) | e.t;
        if (g.result) return { ok: false, msg: `${i + 1}手目: その前に勝負がついていたはずです`, setups };
        if (!g.legal().includes(m)) return { ok: false, msg: `${i + 1}手目が、本当の駒では指せない手でした`, setups };
        const ev = g.play(m);
        if (ev.r !== e.r) return { ok: false, msg: `${i + 1}手目の勝ち負けの判定が食い違っています`, setups };
      }
      const end = st.end;
      if (end && (end.reason === 'hq' || end.reason === 'quiet' || end.reason === 'maxply')) {
        if (!g.result || g.result.winner !== end.winner) return { ok: false, msg: '勝敗の判定が食い違っています', setups };
      } else if (g.result && !(end && end.reason === 'nomove' && g.result.reason === 'nomove' && g.result.winner === end.winner)) return { ok: false, msg: '記録の途中で勝負がついていたはずです', setups };
      return { ok: true, msg: '両方の配置は最初の約束どおりで、すべての手と勝ち負けの判定が正しいことを確かめました', setups };
    }

    return { sha256, randHex, commitOne, makeCommit, reveal, fingerprint, checkReveal, validCm, reconstruct, verifyEnd };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = GunjinNet;
  else root.GunjinNet = GunjinNet;
})(typeof self !== 'undefined' ? self : this);
