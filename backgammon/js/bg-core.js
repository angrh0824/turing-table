/* バックギャモンのルール（盤・合法手・対局の進行・キューブ・マッチ・棋譜の表記）。ブラウザ・Web Worker・Node で共通
 *
 * 盤は手番側から見た2本の配列 me / opp（どちらも Int8Array(25)）で表す。
 *   i = 0..23 … 自分から見た (i+1) のポイント（0 = 1のポイント、23 = 24のポイント）。駒は 23 → 0 の向きに進み、0 の先で上がる
 *   i = 24    … バーにいる駒の数。上がった駒の数は 15 − 合計
 *   自分の i と相手の 23−i が同じ場所
 * 手（hop）は [from, to]。from = 24 はバー、to = −1 は上がり（ベアオフ）
 */
(function (root, factory) {
  const BG = factory();
  if (typeof module === 'object' && module.exports) module.exports = BG;
  else root.BG = BG;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CHECKERS = 15, BAR = 24, OFF = -1;

  function initial() { const a = new Int8Array(25); a[23] = 2; a[12] = 5; a[7] = 3; a[5] = 5; return a; }
  const offCount = a => { let s = 0; for (let i = 0; i < 25; i++) s += a[i]; return CHECKERS - s; };
  const pip = a => { let s = 25 * a[24]; for (let i = 0; i < 24; i++) s += (i + 1) * a[i]; return s; };
  function allHome(a) { if (a[24]) return false; for (let i = 6; i < 24; i++) if (a[i]) return false; return true; }
  // 接触があるか（どちらかの駒が、まだ相手の駒の向こう側にいる）
  function contact(me, opp) {
    if (me[24] || opp[24]) return true;
    let myBack = -1; for (let i = 23; i >= 0; i--) if (me[i]) { myBack = i; break; }
    let oppBack = -1; for (let i = 23; i >= 0; i--) if (opp[i]) { oppBack = i; break; }
    return myBack >= 0 && oppBack >= 0 && myBack + oppBack >= 23;
  }
  // 局面のキー（Zobrist ハッシュ。53ビットの数。合法手の重複をまとめるのに使う）
  const ZA = new Int32Array(50 * 16), ZB = new Int32Array(50 * 16);
  (function () { let s = 0x5eed1234; const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s | 0; }; for (let i = 0; i < ZA.length; i++) { ZA[i] = r(); ZB[i] = r(); } })();
  const mix = (a, b) => (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
  function key(me, opp) {
    let a = 0, b = 0;
    for (let i = 0; i < 25; i++) {
      const c = me[i]; if (c > 0) { const k = i * 16 + c; a ^= ZA[k]; b ^= ZB[k]; }
      const d = opp[i]; if (d > 0) { const k = (25 + i) * 16 + d; a ^= ZA[k]; b ^= ZB[k]; }
    }
    return mix(a, b);
  }

  // 1つの駒を目 d で動かした先。動かせなければ −2（バーに駒があるのにほかを動かす・ふさがれている・まだ上がれない）
  function hopTarget(me, opp, from, d) {
    if (me[from] <= 0) return -2;
    if (me[BAR] > 0 && from !== BAR) return -2;
    const to = from - d;
    if (to >= 0) return opp[23 - to] >= 2 ? -2 : to;
    if (!allHome(me)) return -2;
    if (to === -1) return OFF;
    for (let i = from + 1; i < 6; i++) if (me[i]) return -2; // 大きい目で上がれるのは、それより奥に駒がないときだけ
    return OFF;
  }
  // 動かす（ヒットしたら 1 を返す）。undoHop で戻せる
  function applyHop(me, opp, from, to) {
    me[from]--;
    if (to < 0) return 0;
    me[to]++;
    if (opp[23 - to] === 1) { opp[23 - to] = 0; opp[BAR]++; return 1; }
    return 0;
  }
  function undoHop(me, opp, from, to, hit) {
    me[from]++;
    if (to < 0) return;
    me[to]--;
    if (hit) { opp[23 - to] = 1; opp[BAR]--; }
  }

  // 合法手の全部（動かしたあとの局面が同じものは1つにまとめる）。
  // 規則: 使える目はできるだけ多く使う（ゾロ目は4回）。2つの目のどちらか一方しか使えないときは、大きいほうを使えるなら大きいほう。
  // 返り値: [{ hops: [[from,to,hit],…], me, opp, key }]。どれも動かせないときは hops が空の1件
  // （速さのため、局面のハッシュを1歩ごとに差分で更新し、上がれるかどうかは「いちばん奥の駒」で判断する。hopTarget と同じ決まり）
  function legalMoves(me0, opp0, d1, d2) {
    const me = Int8Array.from(me0), opp = Int8Array.from(opp0);
    const orders = d1 === d2 ? [[d1, d1, d1, d1]] : [[d1, d2], [d2, d1]];
    let best = 0, res = new Map(), firstDie = new Map();
    const path = [];
    const seen = [null, new Set(), new Set(), new Set(), new Set()];
    let ha = 0, hb = 0;
    for (let i = 0; i < 25; i++) {
      const c = me[i]; if (c > 0) { const k = i * 16 + c; ha ^= ZA[k]; hb ^= ZB[k]; }
      const d = opp[i]; if (d > 0) { const k = (25 + i) * 16 + d; ha ^= ZA[k]; hb ^= ZB[k]; }
    }
    const setMe = (i, v) => { const o = me[i]; if (o > 0) { const k = i * 16 + o; ha ^= ZA[k]; hb ^= ZB[k]; } if (v > 0) { const k = i * 16 + v; ha ^= ZA[k]; hb ^= ZB[k]; } me[i] = v; };
    const setOpp = (i, v) => { const o = opp[i]; if (o > 0) { const k = (25 + i) * 16 + o; ha ^= ZA[k]; hb ^= ZB[k]; } if (v > 0) { const k = (25 + i) * 16 + v; ha ^= ZA[k]; hb ^= ZB[k]; } opp[i] = v; };
    function record(k, ds) {
      if (k < best) return;
      if (k > best) { best = k; res = new Map(); firstDie = new Map(); }
      const kk = mix(ha, hb);
      if (k === 1) firstDie.set(kk, (firstDie.get(kk) || 0) | (1 << ds[0])); // 1つだけ使う手は、どの目で作れる局面か
      if (res.has(kk)) return;
      const hops = [];
      for (let i = 0; i < path.length; i += 3) hops.push([path[i], path[i + 1], path[i + 2]]);
      res.set(kk, { hops, me: Int8Array.from(me), opp: Int8Array.from(opp), key: kk });
    }
    function rec(ds, k) {
      let moved = false;
      if (k < ds.length) {
        const d = ds[k];
        let hi = -1;
        for (let i = 24; i >= 0; i--) if (me[i] > 0) { hi = i; break; }
        const lo = me[BAR] > 0 ? BAR : 0;
        for (let f = hi; f >= lo; f--) {
          if (me[f] <= 0) continue;
          const t = f - d;
          if (t >= 0) { if (opp[23 - t] >= 2) continue; }
          else if (hi >= 6 || (t < -1 && f !== hi)) continue;
          // 動かす
          setMe(f, me[f] - 1);
          let hit = 0;
          if (t >= 0) { setMe(t, me[t] + 1); if (opp[23 - t] === 1) { setOpp(23 - t, 0); setOpp(BAR, opp[BAR] + 1); hit = 1; } }
          path.push(f, t < 0 ? OFF : t, hit);
          const kk = mix(ha, hb);
          if (!seen[k + 1].has(kk)) { seen[k + 1].add(kk); rec(ds, k + 1); }
          path.length -= 3;
          if (t >= 0) { if (hit) { setOpp(BAR, opp[BAR] - 1); setOpp(23 - t, 1); } setMe(t, me[t] - 1); }
          setMe(f, me[f] + 1);
          moved = true;
        }
      }
      if (!moved) record(k, ds);
    }
    for (const ds of orders) { for (let i = 1; i < seen.length; i++) seen[i].clear(); rec(ds, 0); }
    let out = [...res.values()];
    if (d1 !== d2 && best === 1) {
      const hi = Math.max(d1, d2), big = out.filter(m => (firstDie.get(m.key) || 0) & (1 << hi));
      if (big.length) out = big;
    }
    return out;
  }

  // 1つずつ動かす画面のための「今の途中の局面から、次に動かしてよい1歩」の一覧。
  // legal = legalMoves の結果、cur = { me, opp, dice: 残りの目, used: もう動かした歩数 }。返り値 [{ from, to, die, hit }]
  function nextHops(legal, cur) {
    const keys = new Set(legal.map(m => m.key));
    const need = legal.length ? legal[0].hops.length : 0;
    const out = [];
    if (!cur.dice.length || (cur.used || 0) >= need) return out;
    const me = cur.me, opp = cur.opp;
    const tried = new Set();
    for (const d of cur.dice) {
      if (tried.has(d)) continue;
      tried.add(d);
      const rest = cur.dice.slice(); rest.splice(rest.indexOf(d), 1);
      for (let f = 24; f >= 0; f--) {
        if (me[f] <= 0) continue;
        const t = hopTarget(me, opp, f, d);
        if (t === -2) continue;
        const m2 = Int8Array.from(me), o2 = Int8Array.from(opp);
        const hit = applyHop(m2, o2, f, t);
        if (reaches(m2, o2, rest, keys, need - (cur.used || 0) - 1)) out.push({ from: f, to: t, die: d, hit });
      }
    }
    return out;
  }
  // 局面から残りの目でちょうど left 回動かして、合法手の局面（keys）のどれかに着けるか
  function reaches(me, opp, dice, keys, left) {
    if (left < 0) return false;
    if (left === 0) return keys.has(key(me, opp));
    const tried = new Set();
    for (let j = 0; j < dice.length; j++) {
      const d = dice[j];
      if (tried.has(d)) continue;
      tried.add(d);
      const rest = dice.slice(0, j).concat(dice.slice(j + 1));
      for (let f = 24; f >= 0; f--) {
        if (me[f] <= 0) continue;
        const t = hopTarget(me, opp, f, d);
        if (t === -2) continue;
        const hit = applyHop(me, opp, f, t);
        const ok = reaches(me, opp, rest, keys, left - 1);
        undoHop(me, opp, f, t, hit);
        if (ok) return true;
      }
    }
    return false;
  }

  // 手順 hops（[[from,to],…]）が、目 dice のどれかを1つずつ使った1歩の列として成り立つか。成り立てば { me, opp, hops:[[from,to,hit],…] }
  function checkHops(me0, opp0, dice, hops) {
    const left = dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : dice.slice();
    const me = Int8Array.from(me0), opp = Int8Array.from(opp0), done = [];
    function rec(i) {
      if (i === hops.length) return true;
      const [f, t] = hops[i];
      if (!(f >= 0 && f <= 24 && t >= -1 && t <= 23)) return false;
      const tried = new Set();
      for (let j = 0; j < left.length; j++) {
        const d = left[j];
        if (tried.has(d) || hopTarget(me, opp, f, d) !== t) continue;
        tried.add(d);
        left.splice(j, 1);
        const hit = applyHop(me, opp, f, t);
        done.push([f, t, hit]);
        if (rec(i + 1)) return true;
        done.pop(); undoHop(me, opp, f, t, hit); left.splice(j, 0, d);
      }
      return false;
    }
    return rec(0) ? { me, opp, hops: done } : null;
  }

  // 終局の種類（手番側が最後の駒を上げた直後に呼ぶ）: 1 = シングル、2 = ギャモン、3 = バックギャモン
  function winKind(winner, loser) {
    if (offCount(loser) > 0) return 1;
    if (loser[BAR] > 0) return 3;
    for (let i = 18; i < 24; i++) if (loser[i] > 0) return 3; // 勝った側のホーム（相手から見て 19〜24）に残っている
    return 2;
  }

  // ------------------------------------------------------------------ 棋譜の表記（手番側から見たポイント番号。例 24/18 13/9* bar/22 6/off）
  const ptName = i => (i === BAR ? 'bar' : i < 0 ? 'off' : String(i + 1));
  function moveText(hops) {
    if (!hops || !hops.length) return '（動かせない）';
    // 同じ駒の続けての動きはつなげる（24/18/13 → 24/13、途中でヒットしたら 24/18*/13）
    const chains = [];
    for (const h of hops) {
      const [f, t, hit] = h;
      const c = chains.find(c => c.to === f && c.to >= 0);
      if (c) { c.mid.push({ p: f, hit: c.lastHit }); c.to = t; c.lastHit = hit; }
      else chains.push({ from: f, to: t, mid: [], lastHit: hit });
    }
    chains.sort((a, b) => b.from - a.from || b.to - a.to); // 奥（番号の大きい）から
    const parts = chains.map(c => {
      let s = ptName(c.from);
      for (const m of c.mid) if (m.hit) s += '/' + ptName(m.p) + '*';
      return s + '/' + ptName(c.to) + (c.lastHit ? '*' : '');
    });
    // 同じものは (2) のようにまとめる
    const order = [], cnt = new Map();
    for (const p of parts) { if (!cnt.has(p)) { cnt.set(p, 0); order.push(p); } cnt.set(p, cnt.get(p) + 1); }
    return order.map(p => (cnt.get(p) > 1 ? `${p}(${cnt.get(p)})` : p)).join(' ');
  }

  // ------------------------------------------------------------------ 対局の進行（1局）
  // 設定 cfg: { len: 0（マネーゲーム）| 3 | 5 | 7 …, cube: true/false, jacoby: true/false（マネーのみ）, beaver: true/false（マネーのみ） }
  // 1局の記録は行動の列。replay で今の状態に戻せる（画面・オンラインの確かめ・保存・振り返りで共通）
  //   {a:'open', d:[白の目, 黒の目]}  最初の1回。同じ目なら振り直し（同じ行動をもう一度）
  //   {a:'roll', d:[x, y]}           手番側が振った
  //   {a:'move', h:[[from,to],…]}   動かした（手番側から見た番号。動かせないときは空）
  //   {a:'double'} {a:'take'} {a:'beaver'} {a:'pass'}
  //   {a:'resign', s:投了した側, v:1|2|3}
  // 局の始まりの情報 start: { score:[白,黒], crawford: bool }
  function newGameState(cfg, start) {
    const b = [initial(), initial()];
    return {
      cfg, b, turn: -1, phase: 'open', dice: null, cube: 1, owner: -1, crawford: !!(start && start.crawford),
      score: start ? start.score.slice() : [0, 0], winner: -1, points: 0, kind: 0, reason: '', n: 0,
    };
  }
  const isMoney = cfg => !cfg.len;
  function needs(st, side) { return isMoney(st.cfg) ? Infinity : st.cfg.len - st.score[side]; }
  function canDouble(st) {
    if (st.phase !== 'turn' || !st.cfg.cube || st.crawford) return false;
    if (st.owner !== -1 && st.owner !== st.turn) return false;
    if (isMoney(st.cfg)) return st.cube < 64;
    return st.cube < needs(st, st.turn); // もう勝てば足りる点なら、上げても意味がない（死んだキューブ）
  }
  const canBeaver = st => st.phase === 'doubled' && isMoney(st.cfg) && !!st.cfg.beaver && st.cube < 32;
  // 終局の点（キューブ × 種類。ジャコビー・ルールではキューブを一度も上げていなければギャモンも1倍）
  function gamePoints(st, kind) {
    const mult = isMoney(st.cfg) && st.cfg.jacoby && st.cube === 1 ? 1 : kind;
    return st.cube * mult;
  }
  function endGame(st, winner, points, kind, reason) {
    st.phase = 'over'; st.winner = winner; st.points = points; st.kind = kind; st.reason = reason; st.dice = null;
    st.score[winner] += points;
  }
  // 1つの行動を進める。おかしな行動なら例外（オンラインで届いた行動の確かめにも使う）
  function act(st, a) {
    const fail = msg => { throw new Error(msg); };
    if (st.phase === 'over') fail('終局しています');
    if (a.a === 'open') {
      if (st.phase !== 'open') fail('最初の振り分けではありません');
      const [x, y] = a.d || [];
      if (!(x >= 1 && x <= 6 && y >= 1 && y <= 6)) fail('目がおかしい');
      if (x === y) return st; // 振り直し
      st.turn = x > y ? 0 : 1; st.dice = [x, y]; st.phase = 'move';
    } else if (a.a === 'roll') {
      if (st.phase !== 'turn') fail('振る番ではありません');
      const [x, y] = a.d || [];
      if (!(x >= 1 && x <= 6 && y >= 1 && y <= 6)) fail('目がおかしい');
      st.dice = [x, y]; st.phase = 'move';
    } else if (a.a === 'move') {
      if (st.phase !== 'move') fail('動かす番ではありません');
      const me = st.b[st.turn], opp = st.b[st.turn ^ 1];
      const legal = legalMoves(me, opp, st.dice[0], st.dice[1]);
      const hops = a.h || [];
      if (!Array.isArray(hops) || hops.length > 4) fail('手の形がおかしい');
      const done = checkHops(me, opp, st.dice, hops.map(h => [h[0] | 0, h[1] | 0]));
      if (!done) fail('その目では動かせません');
      const m2 = done.me, o2 = done.opp, kk = key(m2, o2);
      if (!legal.some(m => m.key === kk)) fail('合法手ではありません（使える目はできるだけ使う決まり）');
      st.last = { side: st.turn, dice: st.dice.slice(), hops: done.hops };
      st.b[st.turn] = m2; st.b[st.turn ^ 1] = o2; st.dice = null;
      if (offCount(m2) === CHECKERS) {
        const kind = winKind(m2, o2);
        endGame(st, st.turn, gamePoints(st, kind), kind, kind === 3 ? 'backgammon' : kind === 2 ? 'gammon' : 'single');
      } else { st.turn ^= 1; st.phase = 'turn'; st.n++; }
    } else if (a.a === 'double') {
      if (!canDouble(st)) fail('ダブルできません');
      st.phase = 'doubled';
    } else if (a.a === 'take') {
      if (st.phase !== 'doubled') fail('ダブルされていません');
      st.cube *= 2; st.owner = st.turn ^ 1; st.phase = 'turn'; st.rollNow = true;
    } else if (a.a === 'beaver') {
      if (!canBeaver(st)) fail('ビーバーできません');
      st.cube *= 4; st.owner = st.turn ^ 1; st.phase = 'turn'; st.rollNow = true;
    } else if (a.a === 'pass') {
      if (st.phase !== 'doubled') fail('ダブルされていません');
      endGame(st, st.turn, st.cube, 1, 'pass');
    } else if (a.a === 'resign') {
      const s = a.s | 0, v = Math.max(1, Math.min(3, a.v | 0));
      if (s !== 0 && s !== 1) fail('投了する側がおかしい');
      endGame(st, s ^ 1, gamePoints(st, v), v, 'resign');
    } else fail('知らない行動です');
    if (a.a !== 'take' && a.a !== 'beaver' && a.a !== 'double') st.rollNow = false;
    return st;
  }
  // キューブを受けたあとはダブルした側がすぐ振る（もう一度ダブルはできない）
  const mustRoll = st => st.phase === 'turn' && !!st.rollNow;
  function replay(cfg, start, actions, upto) {
    const st = newGameState(cfg, start);
    const n = upto == null ? actions.length : upto;
    for (let i = 0; i < n; i++) act(st, actions[i]);
    return st;
  }
  function cloneState(st) {
    return Object.assign({}, st, { b: [Int8Array.from(st.b[0]), Int8Array.from(st.b[1])], score: st.score.slice(), dice: st.dice ? st.dice.slice() : null });
  }

  // ------------------------------------------------------------------ マッチ（複数の局）
  // 各局の始まりの点とクロフォードを順に決める。games = [{ actions }]。返り値 [{score, crawford}]（最後の要素は次の局の始まり）
  function matchStarts(cfg, games) {
    const out = [];
    let score = [0, 0], crawDone = false;
    for (let g = 0; g <= games.length; g++) {
      let crawford = false;
      if (!isMoney(cfg) && !crawDone && (score[0] === cfg.len - 1 || score[1] === cfg.len - 1)) { crawford = true; crawDone = true; }
      out.push({ score: score.slice(), crawford });
      if (g === games.length) break;
      const st = replay(cfg, out[g], games[g].actions);
      if (st.phase !== 'over') break;
      score = st.score.slice();
    }
    return out;
  }
  const matchOver = (cfg, score) => !isMoney(cfg) && (score[0] >= cfg.len || score[1] >= cfg.len);

  // ------------------------------------------------------------------ 乱数（学習・テスト用。画面のサイコロは crypto を使う）
  function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    next.die = () => 1 + Math.floor(next() * 6);
    return next;
  }
  // 21通りの出目（ゾロ目は 1/36、ほかは 2/36）
  const ROLLS = [];
  for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) ROLLS.push([a, b, a === b ? 1 / 36 : 2 / 36]);

  return {
    CHECKERS, BAR, OFF, ROLLS,
    initial, offCount, pip, allHome, contact, key, hopTarget, applyHop, undoHop,
    legalMoves, nextHops, checkHops, winKind, ptName, moveText,
    newGameState, isMoney, needs, canDouble, canBeaver, gamePoints, act, replay, cloneState, mustRoll,
    matchStarts, matchOver, rng,
  };
});
