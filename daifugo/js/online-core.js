/* オンラインの4人卓の進め方（画面に依らない部分。ブラウザと Node のテストで同じものを使う）
 *
 * 部屋 r/df-<卓のコード>/… の中の連絡（common/online.js の room の pub/sub）:
 *   state（保持）… 卓の公開の状態。ホスト（卓を作った人。いなくなったら次の人）だけが出す
 *   ctl          … 座る・離れる・AI補助・ヒント・生きている合図（全員 → ホスト）、手のお断り（ホスト → 全員）
 *   act          … 自分の番の行動（全員 → ホスト）
 *   mp           … メンタルポーカー: 公開の鍵・部分の鍵・隠した部分の鍵（渡す札）・♦3 の名乗り・回のあとの秘密の鍵と混ぜ方
 *   deck/<段>（保持）… 混ぜた山（段ごと。最後の段が山になる）
 *
 * 山はだれも知らない（js/mental.js）。札の「位置」i（0..N-1）は配りで席 (start + i) % 4 のものになる。
 * 各位置には「出していない部分の鍵」がちょうど1人分ある（はじめの持ち主の人。CPU の席ならホスト）。持っている人だけがそれを知り、
 *   ・場に出す・捨てる → その部分の鍵をみんなに出す（だれでも開ける）
 *   ・交換・7渡しで渡す → 渡す相手（CPU の席ならホスト）との共通の鍵で隠して送る（相手だけが開ける）
 * ホストが手順（steps）を並べ、各自は「自分に見えている札だけの写し」（DFCore.Game、見えない札は -1）に手順を入れていく。
 * 回が終わったら全員が秘密の鍵と混ぜ方を出し、山・開いた札・手順のすべてをふつうのルールエンジンで確かめる。食い違えばその回は無効
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./daifugo-core.js'), require('./mental.js'));
  else root.DFOnlineCore = factory(root.DFCore, root.DFMental);
})(typeof self !== 'undefined' ? self : this, function (D, M) {
  'use strict';
  const { PASS, GROUP, SEQ, PICK } = D;

  /* env: { room, pid, name, ai(), now(), setTimeout, clearTimeout, store: {get,set}, cpuMove(g, level) → mv, onChange(), onStep(), log(), times: {lost, hb, keys, shuffle} } */
  function createTable(env, code) {
    const TM = Object.assign({ lost: 45000, hb: 8000, phase: 30000, cpu: 700, act: 40000 }, env.times || {});
    const T = {
      code, pid: env.pid, st: null, isHost: false, left: false,
      me: null,               // この回の自分の秘密: { uid, x, h, perm, ss, shuffled, sharesOut }
      decks: new Map(),       // `${uid}:${段}` → 山
      pub: new Map(),         // `${uid}:${位置}` → Map(pid → 部分の鍵)
      priv: new Map(),        // `${uid}:${位置}` → 出していない部分の鍵（自分が知っているもの）
      cardOf: new Map(),      // `${uid}:${位置}` → 札（自分が開けたもの）
      keysSeen: new Map(), xsSeen: new Map(), d3: new Map(),
      seenAt: new Map(), lastState: 0,
      rep: null, repUid: '', applied: 0, holder: null, // 写し・入れた手順の数・各位置の今の持ち主
      pendingActs: [], sentAct: '', missing: new Set(), audit: null, rejected: '', timer: 0, hbTimer: 0, cpuTimer: 0,
    };
    const room = env.room, now = () => env.now();
    const log = (...a) => { if (env.log) env.log(...a); };
    const K = (uid, p) => `${uid}:${p}`;
    const R = () => (T.st && T.st.R) || null;
    const changed = () => { try { env.onChange && env.onChange(); } catch (e) { console.error(e); } };
    const guard = (name, fn) => { try { fn(); } catch (e) { log(name + ' で失敗', e && e.stack ? String(e.stack).split(/\r?\n/).slice(0, 4).join(' / ') : e); } };
    const mySeat = () => (T.st ? T.st.seats.findIndex(s => s && s.k === 'h' && s.pid === T.pid) : -1);
    const isPart = (pid, Rr = R()) => !!(Rr && Rr.parts.includes(pid));
    const seatPid = (s, Rr = R()) => (Rr ? Rr.sp[s] || '' : '');           // その回でその席を打つ人（'' = CPU）
    const ownerSeat = (pos, Rr = R()) => (Rr.start + pos) % 4;               // 配りでの持ち主
    const withholder = (pos, Rr = R()) => seatPid(ownerSeat(pos, Rr), Rr) || Rr.host; // 出していない部分の鍵の人
    const knower = (seat, Rr = R()) => seatPid(seat, Rr) || Rr.host;        // その席の札を知っている人

    // ------------------------------------------------------------------ 受け取り
    function onState(st) {
      if (!st || st.v !== 1 || st.code !== T.code || T.left) return;
      if (T.st && T.isHost && st.host === T.pid) return;   // 自分の折り返しは捨てる（手元の方が新しいことがある）
      const ep = st.ep || 0, myEp = T.st ? T.st.ep || 0 : 0;
      if (T.st && ep < myEp) return;
      if (T.st && ep === myEp && st.seq <= T.st.seq && st.host === T.st.host) return;
      applyState(st);
    }
    function applyState(st) {
      T.st = st; T.lastState = now();
      T.isHost = st.host === T.pid;
      for (const x of st.seats) if (x && x.k === 'h' && x.pid !== T.pid && !T.seenAt.has(x.pid)) T.seenAt.set(x.pid, now());
      if (!T.isHost && mySeat() < 0 && !T.full && now() - (T.joinAt || 0) > 2000) { T.joinAt = now(); room.pub('ctl', { t: 'join', pid: T.pid, name: env.name(), ai: env.ai() | 0 }); }
      guard('part', partUpdate);
      if (T.isHost) guard('host', hostStep);
      changed();
    }
    function onMp(m) {
      if (!m || !T.st) return;
      const Rr = R();
      if (!Rr || m.uid !== Rr.uid) return;
      if (m.t === 'key') { T.keysSeen.set(K(m.uid, m.pid), m.h); }
      else if (m.t === 'sh' && Array.isArray(m.list)) {
        for (const [pos, sh] of m.list) {
          if (!(pos >= 0 && pos < Rr.n) || typeof sh !== 'string' || typeof m.pid !== 'string') continue;
          const k = K(m.uid, pos);
          if (!T.pub.has(k)) T.pub.set(k, new Map());
          try { T.pub.get(k).set(m.pid, M.fromB64(sh)); } catch (e) { /* 壊れた便り */ }
        }
      } else if (m.t === 'esh' && m.to === T.pid && Array.isArray(m.list)) {
        // 自分あての隠した部分の鍵: 送った人との共通の鍵で戻す
        const hFrom = keyOf(m.from);
        if (hFrom && T.me && T.me.uid === Rr.uid) {
          const Kd = M.dhKey(hFrom, T.me.x);
          for (const [pos, c] of m.list) { try { T.priv.set(K(m.uid, pos), M.unseal(M.fromB64(c), Kd)); } catch (e) { /* 壊れた便り */ } }
          saveMe();
        }
      } else if (m.t === 'd3' && m.pos >= 0) { T.d3.set(m.uid, m.pos); }
      else if (m.t === 'x' && typeof m.pid === 'string') { T.xsSeen.set(K(m.uid, m.pid), m); }
      guard('part', partUpdate);
      if (T.isHost) guard('host', hostStep);
      changed();
    }
    function onDeck(m) {
      if (!m || !T.st) return;
      const Rr = R();
      if (!Rr || m.uid !== Rr.uid || !Array.isArray(m.deck)) return;
      try { T.decks.set(K(m.uid, m.stage), M.deckFromWire(m.deck, Rr.n)); } catch (e) { return; }
      guard('part', partUpdate);
      if (T.isHost) guard('host', hostStep);
      changed();
    }
    function onCtl(m) {
      if (!m) return;
      if (m.pid) T.seenAt.set(m.pid, now());
      if (m.t === 'rej' && m.to === T.pid) { T.rejected = m.why || 'その手は受け付けられませんでした'; T.sentAct = ''; changed(); return; }
      if (m.t === 'full' && m.to === T.pid) { T.full = true; changed(); return; }
      if (m.t === 'need' && m.pid !== T.pid) { guard('need', () => onNeed(m)); return; }
      if (T.isHost) guard('hostCtl', () => hostCtl(m));
    }
    function onAct(m) { if (T.isHost && m) { T.pendingActs.push(m); guard('host', hostStep); } }

    // ------------------------------------------------------------------ 鍵・部分の鍵
    const keyOf = pid => { const Rr = R(); const k = Rr && ((Rr.keys && Rr.keys[pid]) || T.keysSeen.get(K(Rr.uid, pid))); try { return k ? M.fromB64(k) : null; } catch (e) { return null; } };
    const secretKey = uid => `df-on-${T.code}-${uid}-${T.pid}`;
    function loadMe(uid) {
      if (T.me && T.me.uid === uid) return T.me;
      const s = env.store.get(secretKey(uid), null);
      if (s) {
        try {
          T.me = { uid, x: M.xFromHex(s.x), h: M.fromB64(s.h), perm: s.perm || null, ss: s.ss || null, shuffled: !!s.perm, sharesOut: !!s.so };
          for (const [pos, v] of s.priv || []) T.priv.set(K(uid, pos), M.fromB64(v));
          for (const [pos, c] of s.cards || []) T.cardOf.set(K(uid, pos), c);
          return T.me;
        } catch (e) { /* 作り直す */ }
      }
      return null;
    }
    function saveMe() {
      const me = T.me;
      if (!me) return;
      const priv = [], cards = [];
      T.priv.forEach((v, k) => { const [u, pos] = k.split(':'); if (u === me.uid) priv.push([Number(pos), M.toB64(v)]); });
      T.cardOf.forEach((c, k) => { const [u, pos] = k.split(':'); if (u === me.uid) cards.push([Number(pos), c]); });
      env.store.set(secretKey(me.uid), { x: M.xToHex(me.x), h: M.toB64(me.h), perm: me.perm, ss: me.ss, so: me.sharesOut, priv, cards });
    }
    const finalDeck = (Rr = R()) => (Rr ? T.decks.get(K(Rr.uid, Rr.parts.length - 1)) : null);
    // 部分の鍵の値（自分のものは計算する）
    function shareOf(pos, pid, Rr = R()) {
      const deck = finalDeck(Rr);
      if (!deck) return null;
      if (pid === T.pid && T.me && T.me.uid === Rr.uid) return M.share(deck[pos][0], T.me.x);
      if (pid === withholder(pos, Rr)) { const v = T.priv.get(K(Rr.uid, pos)); if (v) return v; }
      const pm = T.pub.get(K(Rr.uid, pos));
      return pm && pm.get(pid) || null;
    }
    // 開けるなら札を返す（開けなければ -1）
    function openPos(pos, Rr = R()) {
      const k = K(Rr.uid, pos);
      if (T.cardOf.has(k)) return T.cardOf.get(k);
      const deck = finalDeck(Rr);
      if (!deck) return -1;
      const shs = [];
      for (const pid of Rr.parts) { const s = shareOf(pos, pid, Rr); if (!s) return -1; shs.push(s); }
      const c = M.open(deck[pos], shs);
      if (c >= 0) { T.cardOf.set(k, c); T.cardsDirty = true; }
      return c;
    }
    const isPublic = (pos, Rr = R()) => { const pm = T.pub.get(K(Rr.uid, pos)); return !!(pm && pm.has(withholder(pos, Rr))); };

    // ------------------------------------------------------------------ 参加者としての動き
    function partUpdate() {
      const Rr = R();
      if (!Rr) return;
      if (isPart(T.pid)) {
        if (!loadMe(Rr.uid)) { const k = M.keygen(); T.me = { uid: Rr.uid, x: k.x, h: k.h, perm: null, ss: null, shuffled: false, sharesOut: false }; saveMe(); }
        if (Rr.phase === 'keys' && !(Rr.keys && Rr.keys[T.pid]) && !T.keysSeen.has(K(Rr.uid, T.pid) + ':sent')) {
          room.pub('mp', { t: 'key', uid: Rr.uid, pid: T.pid, h: M.toB64(T.me.h) });
          T.keysSeen.set(K(Rr.uid, T.pid) + ':sent', 1);
          T.keysSeen.set(K(Rr.uid, T.pid), M.toB64(T.me.h));
        }
        // 混ぜる番
        if (Rr.phase === 'deck' && Rr.parts[Rr.shuf] === T.pid && !T.me.shuffled) {
          const prev = Rr.shuf === 0 ? M.initialDeck(D.deckCards(D.normRules(T.st.cfg.rules))) : T.decks.get(K(Rr.uid, Rr.shuf - 1));
          if (prev) {
            const H = M.jointKey(Rr.parts.map(p => M.fromB64(Rr.keys[p])));
            const r = M.reshuffle(prev, H);
            T.me.shuffled = true; T.me.perm = r.perm; T.me.ss = r.ss.map(M.toB64);
            saveMe();
            T.decks.set(K(Rr.uid, Rr.shuf), r.deck);
            room.pub('deck/' + Rr.shuf, { uid: Rr.uid, stage: Rr.shuf, pid: T.pid, deck: M.deckToWire(r.deck) }, { retain: true });
          }
        }
        // 部分の鍵を出す（自分が出していない部分の鍵の人である位置以外）
        const deck = finalDeck(Rr);
        if (deck && ['shares', 'play', 'audit'].includes(Rr.phase) && !T.me.sharesOut) {
          const list = [];
          for (let pos = 0; pos < Rr.n; pos++) if (withholder(pos, Rr) !== T.pid) list.push([pos, M.toB64(M.share(deck[pos][0], T.me.x))]);
          room.pub('mp', { t: 'sh', uid: Rr.uid, pid: T.pid, list });
          T.me.sharesOut = true; saveMe();
        }
        // 1回戦: ♦3 を持っていたら名乗る（その札をみんなに見せる）
        if (deck && Rr.phase === 'shares' && Rr.needD3 && !T.d3.has(Rr.uid)) {
          const s = mySeat();
          for (let pos = 0; pos < Rr.n; pos++) if (ownerSeat(pos, Rr) === s && seatPid(s, Rr) === T.pid && openPos(pos, Rr) === D.DIA3) revealPositions([pos], 'd3');
        }
        // 回のあと: 秘密の鍵と混ぜ方を出す
        if (Rr.phase === 'audit' && !T.xsSeen.has(K(Rr.uid, T.pid) + ':sent')) {
          const xm = { t: 'x', uid: Rr.uid, pid: T.pid, x: M.xToHex(T.me.x), perm: T.me.perm, ss: T.me.ss };
          room.pub('mp', xm);
          T.xsSeen.set(K(Rr.uid, T.pid) + ':sent', 1);
          T.xsSeen.set(K(Rr.uid, T.pid), xm);
        }
      }
      if (['play', 'audit', 'done'].includes(Rr.phase)) syncReplica();
      if (Rr.phase === 'audit' || Rr.phase === 'done') checkAudit();
    }

    // 位置の札をみんなに見せる（出していない部分の鍵を出す）
    function revealPositions(list, why) {
      const Rr = R(), byPid = new Map();
      for (const pos of list) {
        const wh = withholder(pos, Rr), v = shareOf(pos, wh, Rr);
        if (!v) continue;
        if (!byPid.has(wh)) byPid.set(wh, []);
        byPid.get(wh).push([pos, M.toB64(v)]);
        const pm = T.pub.get(K(Rr.uid, pos)) || new Map(); pm.set(wh, v); T.pub.set(K(Rr.uid, pos), pm);
      }
      byPid.forEach((l, wh) => room.pub('mp', { t: 'sh', uid: Rr.uid, pid: wh, list: l, why }));
      if (why === 'd3') { room.pub('mp', { t: 'd3', uid: Rr.uid, pos: list[0] }); T.d3.set(Rr.uid, list[0]); }
    }
    // 位置の出していない部分の鍵を、席 toSeat の札を知る人に隠して送る
    function sealTo(list, toSeat) { sealToPid(list, knower(toSeat, R())); }
    function sealToPid(list, to) {
      const Rr = R();
      if (to === T.pid || !T.me) return;
      const hTo = keyOf(to);
      if (!hTo) return;
      const Kd = M.dhKey(hTo, T.me.x), out = [];
      for (const pos of list) { const v = shareOf(pos, withholder(pos, Rr), Rr); if (v) out.push([pos, M.toB64(M.seal(v, Kd))]); }
      room.pub('mp', { t: 'esh', uid: Rr.uid, from: T.pid, to, list: out });
    }

    // ------------------------------------------------------------------ 写し（自分に見えている札だけ）
    function dealPositions(seat, Rr = R()) { const o = []; for (let p = 0; p < Rr.n; p++) if (ownerSeat(p, Rr) === seat) o.push(p); return o; }
    // 自分（ホストなら CPU の席も）の手が全部開けたか
    function myCardsKnown(Rr = R()) {
      const s = mySeat();
      let ok = true;
      for (let pos = 0; pos < Rr.n; pos++) {
        const ow = ownerSeat(pos, Rr);
        const mine = (s >= 0 && ow === s && seatPid(s, Rr) === T.pid) || (T.isHost && !seatPid(ow, Rr) && Rr.host === T.pid);
        if (mine && openPos(pos, Rr) < 0) { ok = false; if (finalDeck(Rr)) T.missing.add(pos); }
      }
      return ok;
    }
    // 再読み込みのあいだに届かなかった部分の鍵を、ほかの人にもう一度出してもらう
    function onNeed(m) {
      const Rr = R();
      if (!Rr || m.uid !== Rr.uid || !Array.isArray(m.pos) || !isPart(T.pid) || !T.me || !finalDeck(Rr)) return;
      const pub = [], seal = [];
      for (const pos of m.pos) {
        if (!(pos >= 0 && pos < Rr.n)) continue;
        const wh = withholder(pos, Rr);
        if (wh !== T.pid) pub.push([pos, M.toB64(M.share(finalDeck(Rr)[pos][0], T.me.x))]);
        // 出していない部分の鍵は、その札をいま持っている席の人にだけ
        const holder = T.holder && T.repUid === Rr.uid ? T.holder[pos] : ownerSeat(pos, Rr);
        if (holder >= 0 && knower(holder, Rr) === m.pid && shareOf(pos, wh, Rr)) seal.push(pos);
      }
      if (pub.length) room.pub('mp', { t: 'sh', uid: Rr.uid, pid: T.pid, list: pub });
      if (seal.length) sealToPid(seal, m.pid);
    }
    function buildReplica() {
      const Rr = R();
      if (!finalDeck(Rr) || !myCardsKnown(Rr)) return false;
      if (Rr.needD3 && Rr.leader == null) return false;
      const hands = [[], [], [], []];
      T.holder = new Array(Rr.n);
      for (let pos = 0; pos < Rr.n; pos++) {
        const s = ownerSeat(pos, Rr);
        T.holder[pos] = s;
        hands[s].push(knowsSeat(s, Rr) ? openPos(pos, Rr) : -1);
      }
      T.rep = new D.Game(D.normRules(T.st.cfg.rules), { hands, prev: Rr.prev, leader: Rr.leader, auto: false });
      T.repHands0 = hands.map(h => h.slice());
      T.repUid = Rr.uid; T.applied = 0; T.mvs = [];
      return true;
    }
    const knowsSeat = (s, Rr = R()) => knower(s, Rr) === T.pid;
    // 手順を写しに入れる（開けない札があれば、その手順の前で待つ）
    function syncReplica() {
      const Rr = R();
      if (T.repUid !== Rr.uid) { T.rep = null; if (!buildReplica()) return; changed(); }
      while (T.applied < Rr.steps.length) {
        const st = Rr.steps[T.applied], mv = stepMove(st, Rr);
        if (!mv) return;
        if (st.t === 'x') T.rep.xfer(st.from, st.to, mv.cards);
        else T.rep.apply(mv);
        for (const pos of st.pos || []) T.holder[pos] = st.t === 'x' || (mv.k === PICK && st.to >= 0) ? st.to : -1;
        T.applied++;
        T.mvs.push(mv);
        if (env.onStep) env.onStep(st, mv);
      }
      if (T.cardsDirty && T.me) { T.cardsDirty = false; saveMe(); }
    }
    // 手順 → 写しに入れる手（札を開けないときは null。見えない札は -1）
    function stepMove(st, Rr = R()) {
      if (st.t === 'x' || (st.k === PICK && st.to >= 0)) {
        const vis = knower(st.from != null ? st.from : st.s, Rr) === T.pid || knower(st.to, Rr) === T.pid;
        const cards = [];
        for (const pos of st.pos) { if (vis) { const c = openPos(pos, Rr); if (c < 0) { T.missing.add(pos); return null; } cards.push(c); } else cards.push(-1); }
        return st.t === 'x' ? { k: D.XFER, cards } : { k: PICK, cards, n: 1, r: cards[0] >= 0 && cards[0] < 52 ? cards[0] % 13 : -1, s: 0, jk: 0 };
      }
      if (st.k === PASS) return { k: PASS, cards: [], n: 0, r: -1, s: 0, jk: 0 };
      const cards = [];
      // みんなに見せた札はホストが手順に書く（再読み込みのあと部分の鍵がなくても進める。食い違いは回のあとの検査で見つかる）
      for (let i = 0; i < st.pos.length; i++) {
        const k = K(Rr.uid, st.pos[i]);
        let c = T.cardOf.has(k) ? T.cardOf.get(k) : -1;
        if (c < 0 && isPublic(st.pos[i], Rr)) c = openPos(st.pos[i], Rr);
        if (c < 0 && Array.isArray(st.c)) c = st.c[i] | 0;
        if (c < 0) return null;
        if (Array.isArray(st.c) && st.c[i] !== c) { log('見せた札が手順と違う', st.pos[i]); T.mismatch = true; }
        cards.push(c);
      }
      if (st.k === PICK) return { k: PICK, cards, n: 1, r: cards[0] < 52 ? cards[0] % 13 : -1, s: 0, jk: 0 };
      return D.normalizeMove({ k: st.k, cards, r: st.r });
    }

    // いま自分が答える問い（画面が使う）
    function prompt() {
      const Rr = R();
      if (!Rr || Rr.phase !== 'play' || !Rr.ask || !T.rep || T.applied !== Rr.steps.length) return null;
      const a = Rr.ask;
      if (seatPid(a.seat, Rr) !== T.pid) return null;
      if (T.sentAct === `${Rr.uid}:${a.n}`) return null;
      if (!myCardsKnown(Rr) || T.rep.hands[a.seat].some(c => c < 0)) return null;
      return a;
    }
    // 自分の手を送る（mv は写しの legal() の手。xfer は交換で強い札を渡す）
    function submit(mv) {
      const Rr = R(), a = prompt();
      if (!a) return false;
      const s = a.seat;
      const pos = [];
      const used = new Set();
      for (const c of mv.cards) {
        let found = -1;
        for (let p = 0; p < Rr.n; p++) if (!used.has(p) && T.holder[p] === s && openPos(p, Rr) === c) { found = p; break; }
        if (found < 0) return false;
        used.add(found); pos.push(found);
      }
      if (a.kind === 'x') sealTo(pos, a.to);
      else if (mv.k === PICK && T.rep.pend && T.rep.pend.to >= 0) sealTo(pos, T.rep.pend.to);
      else if (mv.k !== PASS) revealPositions(pos);
      T.sentAct = `${Rr.uid}:${a.n}`;
      T.rejected = '';
      const am = { uid: Rr.uid, n: a.n, pid: T.pid, s, k: a.kind === 'x' ? 'x' : mv.k, pos, r: mv.r };
      room.pub('act', am);
      // ホストは自分の便りの折り返しを待たずに進める（折り返しは番号が古いので捨てられる）
      if (T.isHost) { T.pendingActs.push(am); guard('host', hostStep); }
      changed();
      return true;
    }

    // ------------------------------------------------------------------ 回のあとの検査（だれでも）
    function checkAudit() {
      const Rr = R();
      if (!Rr || T.audit && T.audit.uid === Rr.uid) return;
      const xs = [], hs = [];
      for (const pid of Rr.parts) {
        const m = T.xsSeen.get(K(Rr.uid, pid));
        if (!m) return;
        try { xs.push(M.xFromHex(m.x)); hs.push(M.fromB64(Rr.keys[pid])); } catch (e) { T.audit = { uid: Rr.uid, ok: false, why: `${pid} の鍵の形` }; return; }
      }
      T.audit = Object.assign({ uid: Rr.uid }, runAudit(Rr, xs, hs));
      if (!T.audit.ok) log('検査で食い違い', T.audit.why);
      if (T.isHost) hostStep();
      changed();
    }
    function runAudit(Rr, xs, hs) {
      const rules = D.normRules(T.st.cfg.rules), cards0 = D.deckCards(rules);
      // 各段の混ぜ方
      const H = M.jointKey(hs);
      let prev = M.initialDeck(cards0);
      for (let i = 0; i < Rr.parts.length; i++) {
        const m = T.xsSeen.get(K(Rr.uid, Rr.parts[i])), d = T.decks.get(K(Rr.uid, i));
        if (!d) return { ok: false, why: `山の${i + 1}段目がない` };
        let ss;
        try { ss = (m.ss || []).map(M.fromB64); } catch (e) { return { ok: false, why: `${i + 1}段目の混ぜ方の形` }; }
        if (!M.checkShuffle(prev, d, H, m.perm, ss)) return { ok: false, why: `${i + 1}段目の混ぜ方が正しくない`, bad: Rr.parts[i] };
        prev = d;
      }
      const a = M.audit(prev, xs, hs, cards0);
      if (!a.ok) return { ok: false, why: a.why === 'key' ? '秘密の鍵が公開の鍵と合わない' : '山の札がそろっていない' };
      const cardAt = a.cards;
      // 見せた札・手順をふつうのルールエンジンで打ち直す
      const hands = [[], [], [], []];
      for (let pos = 0; pos < Rr.n; pos++) hands[ownerSeat(pos, Rr)].push(cardAt[pos]);
      const g = new D.Game(rules, { hands, prev: Rr.prev, auto: false, leader: Rr.leader });
      const holder = []; for (let pos = 0; pos < Rr.n; pos++) holder[pos] = ownerSeat(pos, Rr);
      let xi = 0;
      for (const st of Rr.steps) {
        const cs = (st.pos || []).map(p => cardAt[p]);
        for (const p of st.pos || []) if (holder[p] !== (st.t === 'x' ? st.from : st.s)) return { ok: false, why: '持っていない札を出した' };
        if (st.t === 'x') {
          const want = D.strongest(g.hands[st.from], st.pos.length).sort((p, q) => p - q).join();
          if (want !== cs.slice().sort((p, q) => p - q).join() && strongVals(want) !== strongVals(cs.slice().sort((p, q) => p - q).join())) return { ok: false, why: '交換でいちばん強い札を渡していない' };
          g.xfer(st.from, st.to, cs);
          for (const p of st.pos) holder[p] = st.to;
          xi++;
          continue;
        }
        if (g.actor !== st.s) return { ok: false, why: '手番が違う' };
        let mv;
        if (st.k === PASS) mv = { k: PASS, cards: [], n: 0, r: -1, s: 0, jk: 0 };
        else if (st.k === PICK) mv = { k: PICK, cards: cs, n: 1, r: D.rankOf(cs[0]), s: 0, jk: 0 };
        else mv = D.normalizeMove({ k: st.k, cards: cs, r: st.r });
        const key = mv && D.moveKey(mv);
        if (!mv || !g.legal().some(x => D.moveKey(x) === key)) { log('検査: ルールに合わない手', Rr.steps.indexOf(st), JSON.stringify(st), JSON.stringify(mv), 'actor', g.actor, 'pend', JSON.stringify(g.pend), 'field', JSON.stringify(g.field), 'hand', JSON.stringify(g.hands[st.s])); return { ok: false, why: 'ルールに合わない手があった' }; }
        const toSeat = st.k === PICK && g.pend && g.pend.to >= 0 ? g.pend.to : -1;
        g.apply(mv);
        for (const p of st.pos || []) holder[p] = toSeat;
      }
      void xi;
      if (g.phase !== 'done' || (Rr.result && g.rank.join() !== Rr.result.join())) return { ok: false, why: '結果が合わない' };
      return { ok: true, rank: g.rank.slice() };
    }
    // 同じ強さの札（マーク違い）なら交換の札として同じに扱う
    function strongVals(csv) { return csv.split(',').map(Number).map(c => (c >= 52 ? 'J' : String(c % 13))).sort().join(); }

    // ------------------------------------------------------------------ ホストの仕事
    function publish() {
      if (!T.isHost || T.left) return;
      T.st.seq = (T.st.seq || 0) + 1;
      T.st.t = now();
      // 中継から自分の便りが戻る前にほかの便りを出せるよう、少しあとで出す
      const snap = JSON.parse(JSON.stringify(T.st));
      Promise.resolve().then(() => { room.pub('state', snap, { retain: true }); changed(); });
    }
    function hostCtl(m) {
      const st = T.st;
      if (!st) return;
      const s = st.seats.findIndex(x => x && x.k === 'h' && x.pid === m.pid);
      if (m.t === 'join' && typeof m.pid === 'string') {
        if (s >= 0) { st.seats[s].name = clean(m.name); st.seats[s].ai = m.ai | 0; publish(); return; }
        const free = st.seats.findIndex(x => x.k === 'c');
        if (free < 0) { room.pub('ctl', { t: 'full', to: m.pid }); return; }
        st.seats[free] = { k: 'h', pid: m.pid, name: clean(m.name), ai: m.ai | 0, hints: 0, lvl: st.seats[free].lvl };
        publish();
      } else if (m.t === 'leave' && s >= 0) {
        st.seats[s] = { k: 'c', lvl: st.cfg.cpu };
        if (isPart(m.pid)) voidRound(`${clean(m.name || 'ゲスト')}さんが離れたので、この回は配り直します`);
        publish();
      } else if (m.t === 'ai' && s >= 0) { st.seats[s].ai = m.ai | 0; publish(); }
      else if (m.t === 'hint' && s >= 0) { st.seats[s].hints = (st.seats[s].hints | 0) + 1; publish(); }
      else if (m.t === 'next' && st.phase === 'between' && m.pid === st.host) startRound();
    }
    const clean = n => String(n || 'ゲスト').replace(/[\u0000-\u001f]/g, '').slice(0, 16) || 'ゲスト';
    function rid() { const A = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * A.length)]; return s; }

    function startRound() {
      const st = T.st;
      const alive = pid => pid === T.pid || now() - (T.seenAt.get(pid) || 0) < TM.lost;
      const sp = st.seats.map(x => (x.k === 'h' && alive(x.pid) ? x.pid : ''));
      const parts = [T.pid].concat(sp.filter(p => p && p !== T.pid));
      const rules = D.normRules(st.cfg.rules);
      const n = 52 + rules.jokers;
      const prev = st.prev || null;
      const start = prev ? (prev.indexOf(3) + 1) & 3 : Math.floor(Math.random() * 4);
      st.R = { uid: rid(), no: (st.round || 0) + 1, parts, sp, host: T.pid, keys: {}, shuf: 0, phase: 'keys', n, start, prev, needD3: !prev, leader: null, steps: [], ask: null, at: now() };
      st.phase = 'round';
      st.void = ''; st.voidAt = 0;
      T.audit = null;
      publish();
      hostStep();
    }
    function voidRound(msg) {
      const st = T.st;
      if (!st.R || st.phase !== 'round') return;
      st.R.phase = 'void';
      st.void = msg;
      st.phase = 'between';
      st.voidAt = now();
    }
    function hostStep() {
      const st = T.st, Rr = R();
      if (!st || !T.isHost || !Rr || st.phase !== 'round') return;
      if (!T.inPart) { T.inPart = true; guard('part', partUpdate); T.inPart = false; }
      let dirty = false;
      const tooLong = now() - (Rr.at || 0) > TM.phase;
      if (Rr.phase === 'keys') {
        for (const p of Rr.parts) { const k = T.keysSeen.get(K(Rr.uid, p)); if (k && !Rr.keys[p]) { Rr.keys[p] = k; dirty = true; } }
        if (Rr.parts.every(p => Rr.keys[p])) { Rr.phase = 'deck'; Rr.shuf = 0; Rr.at = now(); dirty = true; }
        else if (tooLong) { startRound(); return; }
      }
      if (Rr.phase === 'deck') {
        while (Rr.shuf < Rr.parts.length && T.decks.has(K(Rr.uid, Rr.shuf))) { Rr.shuf++; Rr.at = now(); dirty = true; }
        if (Rr.shuf >= Rr.parts.length) { Rr.phase = 'shares'; Rr.at = now(); dirty = true; }
        else if (tooLong) { const who = Rr.parts[Rr.shuf]; markGone(who); startRound(); return; }
      }
      if (dirty) { publish(); guard('part', partUpdate); }
      if (Rr.phase === 'shares') {
        if (Rr.needD3 && Rr.leader == null) {
          // ♦3: CPU の席ならホストが知っている。人なら名乗りを待つ
          for (let pos = 0; pos < Rr.n; pos++) {
            const ow = ownerSeat(pos, Rr);
            if (!seatPid(ow, Rr) && openPos(pos, Rr) === D.DIA3) { Rr.leader = ow; revealPositions([pos], 'd3'); }
          }
          if (Rr.leader == null && T.d3.has(Rr.uid)) { const pos = T.d3.get(Rr.uid); if (openPos(pos, Rr) === D.DIA3) Rr.leader = ownerSeat(pos, Rr); }
          if (Rr.leader == null) { if (tooLong) startRound(); return; }
        }
        if (!buildReplica()) { if (tooLong) startRound(); return; }
        Rr.phase = 'play'; Rr.at = now();
        setAsk();
        publish();
      }
      if (Rr.phase === 'play') {
        syncReplica();
        // 人の手
        while (T.pendingActs.length) {
          const m = T.pendingActs[0];
          const res = hostAct(m);
          if (res === 'wait') break;
          T.pendingActs.shift();
        }
        // CPU の手
        const a = Rr.ask;
        if (a && !seatPid(a.seat, Rr) && !T.cpuTimer) {
          T.cpuTimer = env.setTimeout(() => { T.cpuTimer = 0; guard('cpu', cpuTurn); }, TM.cpu);
        }
      }
      if (Rr.phase === 'audit') {
        if (T.audit && T.audit.uid === Rr.uid) {
          if (T.audit.ok) {
            Rr.phase = 'done';
            const pts = [3, 2, 1, 0];
            st.scores = st.scores || [0, 0, 0, 0];
            for (let s = 0; s < 4; s++) st.scores[s] += pts[Rr.result[s]];
            st.history = (st.history || []).concat([{ rank: Rr.result }]);
            st.prev = Rr.result.slice();
            st.round = Rr.no;
            st.phase = st.cfg.games && st.round >= st.cfg.games ? 'end' : 'between';
          } else {
            Rr.phase = 'void';
            st.void = `回のあとの検査で食い違いが見つかったので、この回は無効です（${T.audit.why}）`;
            st.phase = 'between'; st.voidAt = now();
          }
          publish();
        } else if (tooLong) {
          // 秘密の鍵を出さない人がいる → 無効
          Rr.phase = 'void'; st.void = '回のあとの検査に必要な鍵がそろわなかったので、この回は無効です'; st.phase = 'between'; st.voidAt = now(); publish();
        }
      }
    }
    function markGone(pid) { T.seenAt.set(pid, 0); }
    function setAsk() {
      const Rr = R(), g = T.rep;
      if (g.phase === 'done') { Rr.ask = null; Rr.phase = 'audit'; Rr.result = g.rank.slice(); Rr.at = now(); return; }
      // 交換: まず貧民側が強い札を渡す（決まり）
      if (g.prev && g.rules.exchange) {
        const xs = Rr.steps.filter(s => s.t === 'x').length;
        const dh = g.prev.indexOf(3), df = g.prev.indexOf(0), hm = g.prev.indexOf(2), fg = g.prev.indexOf(1);
        if (xs === 0) { Rr.ask = { seat: dh, kind: 'x', k: 2, to: df, n: Rr.steps.length }; return; }
        if (xs === 1) { Rr.ask = { seat: hm, kind: 'x', k: 1, to: fg, n: Rr.steps.length }; return; }
      }
      Rr.ask = { seat: g.actor, kind: g.pend ? 'pick' : 'play', n: Rr.steps.length, at: now() };
    }
    function addStep(step) {
      const Rr = R();
      Rr.steps.push(step);
      syncReplica();
      setAsk();
      Rr.at = now();
      publish();
    }
    // 人から届いた手（'wait' = 札がまだ開けない）
    function hostAct(m) {
      const Rr = R(), a = Rr.ask;
      if (!a || m.uid !== Rr.uid || m.n !== a.n || seatPid(a.seat, Rr) !== m.pid || m.s !== a.seat || !Array.isArray(m.pos)) return 'drop';
      const pos = m.pos.map(x => x | 0);
      if (new Set(pos).size !== pos.length || pos.some(p => !(p >= 0 && p < Rr.n) || T.holder[p] !== a.seat)) return reject(m, '持っていない札です');
      const g = T.rep;
      if (a.kind === 'x') {
        if (m.k !== 'x' || pos.length !== a.k) return reject(m, '枚数が違います');
        if (knower(a.to, Rr) === T.pid && pos.some(p => openPos(p, Rr) < 0)) return 'wait';
        addStep({ t: 'x', from: a.seat, to: a.to, pos });
        return 'ok';
      }
      if (m.k === PASS) {
        if (!g.field || g.pend) return reject(m, 'いまはパスできません');
        addStep({ t: 'm', s: a.seat, k: PASS, pos: [] });
        return 'ok';
      }
      if (g.pend) {
        if (m.k !== PICK || pos.length !== 1) return reject(m, '札を1枚えらんでください');
        if (g.pend.kind === 'discard10') { const c = openPos(pos[0], Rr); if (c < 0) return 'wait'; addStep({ t: 'm', s: a.seat, k: PICK, pos, to: -1, c: [c] }); return 'ok'; }
        if ((knower(a.seat, Rr) === T.pid || knower(g.pend.to, Rr) === T.pid) && openPos(pos[0], Rr) < 0) return 'wait';
        addStep({ t: 'm', s: a.seat, k: PICK, pos, to: g.pend.to });
        return 'ok';
      }
      if (m.k !== GROUP && m.k !== SEQ) return reject(m, '手の形が違います');
      const cards = [];
      for (const p of pos) { const c = openPos(p, Rr); if (c < 0) return 'wait'; cards.push(c); }
      const mv = D.normalizeMove({ k: m.k, cards, r: m.r | 0 });
      if (!mv || !g.isLegalShape(mv)) return reject(m, 'その手は出せません');
      addStep({ t: 'm', s: a.seat, k: m.k, pos, r: mv.r, c: cards });
      return 'ok';
    }
    function reject(m, why) { room.pub('ctl', { t: 'rej', to: m.pid, why }); return 'drop'; }
    function cpuTurn() {
      const Rr = R(), st = T.st;
      if (!T.isHost || !Rr || Rr.phase !== 'play' || !Rr.ask) return;
      const a = Rr.ask;
      if (seatPid(a.seat, Rr)) return;
      const g = T.rep, lvl = (st.seats[a.seat] && st.seats[a.seat].lvl) || st.cfg.cpu || 'normal';
      const posOf = c => { for (let p = 0; p < Rr.n; p++) if (T.holder[p] === a.seat && openPos(p, Rr) === c) return p; return -1; };
      if (a.kind === 'x') {
        const cs = D.strongest(g.hands[a.seat], a.k), pos = cs.map(posOf);
        sealTo(pos, a.to);
        addStep({ t: 'x', from: a.seat, to: a.to, pos });
        return;
      }
      const mv = env.cpuMove(g, lvl);
      const pos = mv.cards.map(posOf);
      if (mv.k === PICK && g.pend && g.pend.to >= 0) { sealTo(pos, g.pend.to); addStep({ t: 'm', s: a.seat, k: PICK, pos, to: g.pend.to }); return; }
      if (mv.k !== PASS) revealPositions(pos);
      const step = { t: 'm', s: a.seat, k: mv.k, pos, r: mv.r };
      if (mv.k !== PASS) step.c = mv.cards.slice();
      if (mv.k === PICK) step.to = -1;
      addStep(step);
    }

    // ------------------------------------------------------------------ 時計（生きている合図・つながらない人・ホストの引き継ぎ）
    function tick() {
      if (T.left) return;
      room.pub('ctl', { t: 'hb', pid: T.pid });
      const st = T.st;
      // 開けない札があれば、部分の鍵をもう一度出してもらう
      if (T.missing.size && st && st.R) { room.pub('ctl', { t: 'need', pid: T.pid, uid: st.R.uid, pos: [...T.missing].slice(0, 60) }); T.missing.clear(); }
      // まだ席がなければ、座りたいともう一度伝える（つながる前に出した便りは届かないため）
      if (!T.isHost && (!st || mySeat() < 0) && !T.full) room.pub('ctl', { t: 'join', pid: T.pid, name: env.name(), ai: env.ai() | 0 });
      if (!st) return;
      if (T.isHost) {
        const Rr = R();
        // 回の途中の参加者が黙った → その回は配り直し（その人の席は次の回から CPU）
        if (Rr && st.phase === 'round') {
          const gone = Rr.parts.find(p => p !== T.pid && now() - (T.seenAt.get(p) || 0) > TM.lost);
          if (gone) { const s = st.seats.findIndex(x => x.k === 'h' && x.pid === gone); voidRound(`${s >= 0 ? clean(st.seats[s].name) : 'だれか'}さんの通信が切れたので、この回は配り直します`); publish(); return; }
        }
        // 長く黙っている人は席を CPU に
        let ch = false;
        st.seats.forEach((x, i) => { if (x.k === 'h' && x.pid !== T.pid && now() - (T.seenAt.get(x.pid) || now()) > TM.lost * 3) { st.seats[i] = { k: 'c', lvl: st.cfg.cpu }; ch = true; } });
        if (ch) publish();
        else if (now() - st.t > TM.hb * 2) publish();
        // 無効になった回は少し待って配り直す
        if (st.phase === 'between' && st.void && now() - (st.voidAt || 0) > 3000) { startRound(); return; }
        hostStep();
      } else if (now() - T.lastState > TM.lost) {
        // ホストが黙った → 席順で次の人が引き継ぐ（その回は配り直し）
        const order = st.seats.filter(x => x.k === 'h' && x.pid !== st.host).map(x => x.pid);
        const alive = order.filter(p => p === T.pid || now() - (T.seenAt.get(p) || 0) < TM.lost);
        if (alive[0] === T.pid) {
          const old = st.host;
          st.seats = st.seats.map(x => (x.k === 'h' && x.pid === old ? { k: 'c', lvl: st.cfg.cpu } : x));
          st.host = T.pid; st.ep = (st.ep || 0) + 1; T.isHost = true;
          if (st.phase === 'round') { st.R.phase = 'void'; st.phase = 'between'; st.void = 'ホストの通信が切れたので、引き継いで配り直します'; st.voidAt = now(); }
          log('ホストを引き継ぎました');
          publish();
          changed();
        }
      }
    }

    // ------------------------------------------------------------------ はじめ・おわり
    const subs = [['state', onState], ['ctl', onCtl], ['act', onAct], ['mp', onMp]];
    function open(create) {
      subs.forEach(([s, f]) => room.sub(s, f));
      for (let i = 0; i < 8; i++) room.sub('deck/' + i, onDeck);
      if (create) {
        T.st = { v: 1, code, ep: 0, seq: 0, host: T.pid, t: now(), cfg: create.cfg, seats: [{ k: 'h', pid: T.pid, name: clean(env.name()), ai: env.ai() | 0, hints: 0 }, { k: 'c', lvl: create.cfg.cpu }, { k: 'c', lvl: create.cfg.cpu }, { k: 'c', lvl: create.cfg.cpu }], round: 0, scores: [0, 0, 0, 0], history: [], prev: null, phase: 'lobby', R: null };
        T.isHost = true;
        publish();
      } else room.pub('ctl', { t: 'join', pid: T.pid, name: env.name(), ai: env.ai() | 0 });
      T.hbTimer = env.setInterval(tick, TM.hb);
      changed();
    }
    function leave() {
      if (T.left) return;
      room.pub('ctl', { t: 'leave', pid: T.pid, name: env.name() });
      if (T.isHost && T.st) {
        // ほかに人がいれば、次の人に任せる（その回は配り直し）。いなければ卓を閉じる
        const others = T.st.seats.filter(x => x.k === 'h' && x.pid !== T.pid);
        if (others.length) {
          const st = T.st;
          st.seats = st.seats.map(x => (x.k === 'h' && x.pid === T.pid ? { k: 'c', lvl: st.cfg.cpu } : x));
          st.host = others[0].pid; st.ep = (st.ep || 0) + 1;
          if (st.phase === 'round') { st.R.phase = 'void'; st.phase = 'between'; st.void = 'ホストが離れたので、引き継いで配り直します'; st.voidAt = now(); }
          st.seq++; st.t = now();
          room.pub('state', st, { retain: true });
        } else room.pub('state', null, { retain: true });
      }
      T.left = true;
      env.clearInterval(T.hbTimer);
      if (T.cpuTimer) env.clearTimeout(T.cpuTimer);
      subs.forEach(([s, f]) => room.unsub(s, f));
      for (let i = 0; i < 8; i++) room.unsub('deck/' + i, onDeck);
    }
    function ctl(t, extra) { const m = Object.assign({ t, pid: T.pid }, extra || {}); room.pub('ctl', m); if (T.isHost) hostCtl(m); }

    return {
      T, open, leave, submit, prompt, ctl, mySeat, startRound: () => { if (T.isHost && T.st && (T.st.phase === 'lobby' || T.st.phase === 'between')) startRound(); },
      next: () => {
        if (!T.isHost || !T.st) return;
        if (T.st.phase === 'end') { Object.assign(T.st, { scores: [0, 0, 0, 0], history: [], prev: null, round: 0 }); startRound(); }   // 対局が終わったら点数を戻してもう一度
        else if (T.st.phase === 'between') startRound();
      },
      setCfg(cfg) { if (T.isHost && T.st && T.st.phase === 'lobby') { T.st.cfg = cfg; T.st.seats.forEach(x => { if (x.k === 'c') x.lvl = cfg.cpu; }); publish(); } },
      get state() { return T.st; }, get isHost() { return T.isHost; }, get rep() { return T.rep; }, get repHands0() { return T.repHands0; },
      get applied() { return T.applied; }, get mvs() { return T.mvs || []; }, get repUid() { return T.repUid; }, get audit() { return T.audit; }, get rejected() { return T.rejected; },
      // テスト用
      _runAudit: runAudit,
    };
  }
  return { createTable };
});
