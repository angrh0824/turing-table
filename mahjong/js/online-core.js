/* オンラインの4人卓の進め方（画面に依らない部分。ブラウザと Node のテストで同じものを使う）
 *
 * 部屋 r/mj-<卓のコード>/… の中の連絡（common/online.js の room の pub/sub）:
 *   state（保持）… 卓の公開の状態。ホスト（卓を作った人。いなくなったら次の人）だけが出す
 *   ctl          … 席に着く・離れる・AI補助・ヒント・生きている合図・次の局へ（全員 → ホスト）
 *   act          … 自分の番の行動・鳴きの返事・荒牌流局の聴牌（全員 → ホスト）
 *   mp           … メンタルポーカー: 公開の鍵・部分の鍵・局のあとの秘密の鍵と混ぜ方
 *   deck（保持） … 混ぜた山（段ごとに上書き。最後の段が山になる）
 *
 * 山はだれも知らない（js/mental.js）。各自は「見えている牌だけを知る局の写し」（mj-core の external モード）を持ち、ホストが手順を並べる。
 * 自分の牌はほかの全員の部分の鍵で開き、捨て牌・鳴き・和了で見せるときは自分の部分の鍵を出す。CPU の席の牌はホストの端末が開く。
 * 局が終わったら全員が秘密の鍵と混ぜ方を出して、山・見せた牌・手順のすべてをふつうのルールエンジンで確かめる。食い違えばその局は無効
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mj-core.js'), require('./mental.js'));
  else root.MJOnlineCore = factory(root.MJ, root.MJMental);
})(typeof self !== 'undefined' ? self : this, function (MJ, M) {
  'use strict';
  let LOST_MS = 40000, NEXT_MS = 12000, HB_MS = 8000;

  /* env: { room, pid, name, ai, now(), setTimeout, clearTimeout, store: {get,set}, makeAgent(level, rng), onChange(), log() } */
  function createTable(env, code, create) {
    // 時間の長さ（テストでは短く）
    if (env.times) { LOST_MS = env.times.lost || LOST_MS; NEXT_MS = env.times.next || NEXT_MS; HB_MS = env.times.hb || HB_MS; }
    const T = {
      code, pid: env.pid, st: null, isHost: false, rep: null, repUid: '', applied: 0,
      me: null,              // この局の自分の秘密: { no, x, h, deck, known: {pos:id}, perm, ss（混ぜ方） }
      shares: new Map(),     // `${no}:${pos}` → Map(pid → share)
      sentSh: new Set(),     // 出した部分の鍵 `${no}:${pos}:${to}`
      decks: new Map(),      // 段 → 山（受け取ったもの）
      keysSeen: new Map(), xsSeen: new Map(), shufSeen: new Map(),
      prompt: null,          // 画面への問い: { kind:'turn'|'react'|'tenpai', n }
      sentAct: null,         // 出した返事 `${no}:${n}:${kind}`
      auditRes: null, history: [], hs: null, lastState: 0, seenAt: new Map(), left: false,
    };
    const room = env.room;
    const now = () => env.now();
    const log = (...a) => { if (env.log) env.log(...a); };
    const dbg = (...a) => { if (env.debug && env.log) env.log(`${((now() % 1e6) / 1000).toFixed(1)}`, ...a); };
    const K = (no, pos) => `${no}:${pos}`;
    // その局の分だけを取り出す（キーは「局:…」）
    const roundMap = (m, no, keys) => { const o = new Map(); for (const k of keys) if (m.has(K(no, k))) o.set(k, m.get(K(no, k))); return o; };
    const mySeat = () => (T.st ? T.st.seats.findIndex(x => x && x.k === 'h' && x.pid === T.pid) : -1);
    const R = () => (T.st && T.st.R) || null;
    const isPart = (pid, Rr = R()) => !!(Rr && Rr.parts.includes(pid));
    const seatKind = s => (T.st.seats[s] && T.st.seats[s].k === 'h' && isPart(T.st.seats[s].pid) ? 'h' : 'c');
    const changed = () => { try { env.onChange && env.onChange(); } catch (e) { console.error(e); } };

    // ------------------------------------------------------------------ 受け取り
    // 中継から届いた状態（ホスト自身が出したものの折り返しは捨てる。ホストの手元の方が新しいことがあるため）
    function onState(st) {
      if (!st || st.v !== 1 || st.code !== T.code) return;
      if (T.st && T.isHost && st.host === T.pid) return;
      // ホストの代（引き継ぐたびに増える）が古い状態は捨てる。同じ代なら番号の古いものを捨てる
      const ep = st.ep || 0, myEp = T.st ? T.st.ep || 0 : 0;
      if (T.st && ep < myEp) return;
      if (T.st && ep === myEp && st.seq < T.st.seq) return; // 古い便り
      if (st.R) dbg('状態', st.seq, st.R.no, st.R.phase, st.R.steps.length, st.R.ask ? st.R.ask.kind + st.R.ask.n : '-');
      applyState(st);
    }
    // ひとつの段の失敗でほかが止まらないよう、段ごとに守る
    const guard = (name, fn) => { try { fn(); } catch (e) { log(name + ' で失敗', e && e.stack ? String(e.stack).split(/\r?\n/).slice(0, 3).join(' / ') : e); } };
    function applyState(st) {
      T.st = st; T.lastState = now();
      T.isHost = st.host === T.pid;
      guard('partUpdate', partUpdate);
      if (T.isHost) guard('hostEnsure', hostEnsure);
      changed();
    }
    function onMp(m) {
      if (!m || !T.st) return;
      const Rr = R();
      if (m.t === 'key' && Rr && m.uid === Rr.uid) { T.keysSeen.set(K(m.uid, m.pid), m.h); if (T.isHost) hostStep(); }
      else if (m.t === 'sh' && Rr && m.uid === Rr.uid && Array.isArray(m.list)) {
        for (const [pos, sh] of m.list) {
          if (!(pos >= 0 && pos < 136) || typeof sh !== 'string') continue;
          const k = K(m.uid, pos);
          if (!T.shares.has(k)) T.shares.set(k, new Map());
          try { T.shares.get(k).set(m.pid, M.fromB64(sh)); } catch (e) { /* 壊れた便り */ }
        }
        tryOpen();
        if (T.isHost) hostStep();
      } else if (m.t === 'x' && Rr && m.uid === Rr.uid) { T.xsSeen.set(K(m.uid, m.pid), m); if (T.isHost) guard('hostStep', hostStep); guard('partUpdate', partUpdate); }
    }
    function onDeck(m) {
      if (!m || !T.st) return;
      const Rr = R();
      if (!Rr || m.uid !== Rr.uid || !Array.isArray(m.deck)) return;
      try { T.decks.set(K(m.uid, m.stage), M.deckFromWire(m.deck)); } catch (e) { return; }
      partUpdate();
      if (T.isHost) hostStep();
    }
    function onCtl(m) { if (!m) return; if (m.pid) T.seenAt.set(m.pid, now()); if (T.isHost) hostCtl(m); }
    function onAct(m) { if (T.isHost && m) hostAct(m); }

    // ------------------------------------------------------------------ 参加者としての動き
    function secretKey(no) { return `on-${T.code}-${no}-${T.pid}`; }
    function loadMe(no) {
      if (T.me && T.me.uid === no) return T.me;
      const s = env.store.get(secretKey(no), null);
      if (s) {
        try {
          T.me = { uid: no, x: M.xFromHex(s.x), h: M.fromB64(s.h), known: s.known || {}, perm: s.perm || null, ss: s.ss || null, deckWire: s.deck || null, shuffled: !!s.perm };
          if (s.deck) T.me.deck = M.deckFromWire(s.deck);
          return T.me;
        } catch (e) { /* 作り直す */ }
      }
      return null;
    }
    function saveMe() {
      const me = T.me;
      if (!me) return;
      env.store.set(secretKey(me.uid), { x: M.xToHex(me.x), h: M.toB64(me.h), known: me.known, perm: me.perm, ss: me.ss, deck: me.deckWire || null });
    }
    function partUpdate() {
      const Rr = R();
      if (!Rr || !isPart(T.pid)) { buildRep(); return; }
      // 鍵
      if (!loadMe(Rr.uid)) {
        const k = M.keygen();
        T.me = { uid: Rr.uid, x: k.x, h: k.h, known: {} };
        saveMe();
      }
      if (Rr.phase === 'keys' && !(Rr.keys && Rr.keys[T.pid])) room.pub('mp', { t: 'key', no: Rr.no, uid: Rr.uid, pid: T.pid, h: M.toB64(T.me.h) });
      // 混ぜる番
      if (Rr.phase === 'deck' && Rr.parts[Rr.shuf] === T.pid && !T.me.shuffled) {
        const prev = Rr.shuf === 0 ? M.initialDeck() : T.decks.get(K(Rr.uid, Rr.shuf - 1));
        if (prev) {
          const H = M.jointKey(Rr.parts.map(p => M.fromB64(Rr.keys[p])));
          const r = reshuffleRecorded(prev, H);
          T.me.shuffled = true; T.me.perm = r.perm; T.me.ss = r.ss.map(M.toB64);
          saveMe();
          room.pub('deck/' + Rr.shuf, { no: Rr.no, uid: Rr.uid, stage: Rr.shuf, pid: T.pid, deck: M.deckToWire(r.deck) }, { retain: true });
        }
      }
      if ((Rr.phase === 'play' || Rr.phase === 'audit' || Rr.phase === 'done') && !T.me.deck) {
        const d = T.decks.get(K(Rr.uid, Rr.parts.length - 1));
        if (d) { T.me.deck = d; T.me.deckWire = M.deckToWire(d); saveMe(); }
      }
      guard('buildRep', buildRep);
      guard('sendShares', sendShares);
      guard('tryOpen', tryOpen);
      guard('decide', decide);
      // 局のあと: 秘密の鍵と混ぜ方を出す
      if ((Rr.phase === 'audit' || Rr.phase === 'done' || Rr.phase === 'void') && Rr.phase !== 'void' && !T.me.xSent) {
        T.me.xSent = true;
        room.pub('mp', { t: 'x', no: Rr.no, uid: Rr.uid, pid: T.pid, x: M.xToHex(T.me.x), perm: T.me.perm || null, ss: T.me.ss || null });
      }
      if (Rr.phase === 'audit' || Rr.phase === 'done') runAudit();
    }
    // 混ぜ方を覚えておく再暗号化（局のあとに出して、正しく混ぜたことを確かめてもらう）
    function reshuffleRecorded(deck, H) {
      const hExp = M.fixedBase(H);
      const n = deck.length, perm = [], ss = [];
      for (let i = 0; i < n; i++) perm.push(i);
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = M.randScalar();
        const [a, b] = deck[perm[i]];
        out.push([a * M.gExp(s) % M.P, b * hExp(s) % M.P]);
        ss.push(s);
      }
      return { deck: out, perm, ss };
    }
    function rand() { const u = new Uint32Array(1); (typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto).getRandomValues(u); return u[0] / 4294967296; }

    // 局の写しを作る・手順を足す
    function buildRep() {
      const Rr = R();
      if (!Rr || !['play', 'audit', 'done'].includes(Rr.phase)) { if (!Rr || Rr.phase === 'keys') { T.rep = null; T.repUid = ''; } return; }
      const me = mySeat();
      if (T.repUid !== Rr.uid || !T.rep) {
        const hidden = [0, 1, 2, 3].map(s => !(s === me || (T.isHost && seatKind(s) === 'c')));
        const wall = []; for (let i = 0; i < 136; i++) wall.push(1000 + i);
        T.rep = new MJ.Round({ rules: T.st.rules, wall, dealer: Rr.ky, roundWind: Rr.rw, kyoku: Rr.ky, honba: Rr.hb, kyotaku: Rr.kt, scores: Rr.scores, external: true, hidden });
        T.rep.scoresBefore = Rr.scores.slice(); T.rep.kyotakuStart = Rr.kt;
        T.rep.gameInfo = { roundIndex: Rr.rw * 4 + Rr.ky, last: T.st.rules.length === 'tonpu' ? 3 : 7, tonpu: T.st.rules.length === 'tonpu', firstDealer: 0 };
        T.repUid = Rr.uid; T.applied = 0;
        if (T.me && T.me.uid === Rr.uid) for (const pos in T.me.known) T.rep.reveal(+pos, T.me.known[pos]);
        for (const [pos, id] of Rr.pub || []) T.rep.reveal(pos, id);
      }
      const r = T.rep;
      while (T.applied < Rr.steps.length && r.phase !== 'end') {
        const st = Rr.steps[T.applied];
        for (const [pos, id] of st.rv || []) r.reveal(pos, id);
        try {
          if (st.k === 't') r.doTurn(st.a);
          else if (st.k === 'r') r.doReact(st.resp);
          else if (st.k === 'x') r.doExhaust(st.d);
        } catch (e) { log('写しに入れられない手順', e.message, JSON.stringify(st)); T.repBroken = true; break; }
        T.applied++;
      }
      for (const [pos, id] of Rr.pub || []) if (r.wall[pos] >= 1000) r.reveal(pos, id);
    }
    // 部分の鍵を配る: ほかの人が持っている牌（自分の分）→ その人へ。CPU の席の牌 → ホストへ。ドラ・裏ドラ → 全員へ
    function sendShares() {
      const Rr = R(), r = T.rep, me = T.me;
      if (!Rr || !r || !me || !me.deck || Rr.phase !== 'play') return;
      const my = mySeat();
      const by = new Map(); // to → [[pos, share]]
      const add = (to, pos) => {
        const key = `${Rr.uid}:${pos}:${to}`;
        if (T.sentSh.has(key)) return;
        T.sentSh.add(key);
        if (!by.has(to)) by.set(to, []);
        by.get(to).push([pos, M.toB64(M.share(me.deck[pos][0], me.x))]);
      };
      for (let s = 0; s < 4; s++) {
        if (s === my) continue;
        const ph = r.hands[s].filter(x => x >= 1000).map(x => x - 1000);
        const kind = seatKind(s);
        let to;
        if (kind === 'h') to = T.st.seats[s].pid;
        else { if (T.isHost) continue; to = Rr.parts[0]; } // CPU の席はホスト（parts[0]）が開く
        for (const pos of ph) add(to, pos);
      }
      // 暗槓の宣言中など、手から抜けた牌は見せる側が出す
      for (let i = 0; i < r.doraCount; i++) add('all', 126 + i);
      for (const pos of Rr.ura || []) add('all', pos);
      for (const [to, list] of by) room.pub('mp', { t: 'sh', no: Rr.no, uid: Rr.uid, pid: T.pid, to, list });
    }
    // 自分が開ける牌を開く（自分の手牌・ホストなら CPU の手牌・全員に開く牌）
    function tryOpen() {
      const Rr = R(), r = T.rep, me = T.me;
      if (!Rr || !r || !me || !me.deck) return;
      const my = mySeat();
      const others = Rr.parts.filter(p => p !== T.pid);
      let any = false;
      const openPos = (pos, need) => {
        if (me.known[pos] != null) return;
        const m = T.shares.get(K(Rr.uid, pos));
        if (!need.every(p => m && m.has(p))) return;
        const shs = need.map(p => m.get(p));
        if (isPart(T.pid)) shs.push(M.share(me.deck[pos][0], me.x));
        const id = M.open(me.deck[pos], shs);
        if (id < 0) { log('開けない牌', pos); return; }
        me.known[pos] = id; any = true;
        r.reveal(pos, id);
      };
      for (let s = 0; s < 4; s++) {
        const mine = s === my || (T.isHost && seatKind(s) === 'c');
        if (!mine) continue;
        for (const x of r.hands[s]) if (x >= 1000) openPos(x - 1000, others);
        if (r.pendingAnkan) for (const x of r.pendingAnkan) if (x >= 1000) openPos(x - 1000, others);
      }
      for (let i = 0; i < r.doraCount; i++) if (r.wall[126 + i] >= 1000) openPos(126 + i, others);
      for (const pos of Rr.ura || []) if (r.wall[pos] >= 1000) openPos(pos, others);
      if (any) { saveMe(); decide(); if (T.isHost) hostStep(); changed(); }
    }

    // 自分の番・返事・聴牌の宣言
    function decide() {
      const Rr = R(), r = T.rep;
      T.prompt = null;
      if (!Rr || !r || Rr.phase !== 'play' || T.applied !== Rr.steps.length) return;
      const my = mySeat(), ask = Rr.ask;
      if (my < 0 || !ask || ask.n !== Rr.steps.length || !ask.need.includes(T.pid)) return;
      const key = `${Rr.uid}:${ask.n}:${ask.kind}`;
      if (T.sentAct === key) return;
      if (ask.kind === 'turn' && r.phase === 'turn' && r.cur === my) {
        if (r.hands[my].some(x => x >= 1000)) return; // ツモの牌がまだ開いていない
        T.prompt = { kind: 'turn', n: ask.n, since: ask.at };
      } else if (ask.kind === 'react' && r.phase === 'react') {
        const o = r.react.options[my];
        if (!o || !o.length) { sendAct({ t: 'react', a: null }, key); return; }
        T.prompt = { kind: 'react', n: ask.n, since: ask.at };
      } else if (ask.kind === 'tenpai' && r.phase === 'exhaust') {
        const ten = r.waits[my].length > 0;
        sendAct({ t: 'tenpai', ten, rv: ten ? revealList(r.hands[my]) : [] }, key);
      }
    }
    function posOfId(id) { const me = T.me; for (const p in me.known) if (me.known[p] === id) return +p; return -1; }
    function revealList(ids) { return ids.map(id => { const pos = posOfId(id); return [pos, M.toB64(M.share(T.me.deck[pos][0], T.me.x))]; }); }
    function sendAct(body, key) {
      const Rr = R();
      T.sentAct = key || `${Rr.uid}:${Rr.ask.n}:${Rr.ask.kind}`;
      T.prompt = null;
      dbg('出す', body.t, Rr.ask.n, body.a ? JSON.stringify(body.a) : '');
      room.pub('act', Object.assign({ no: Rr.no, uid: Rr.uid, n: Rr.ask.n, pid: T.pid }, body));
      changed();
    }
    // 画面から: 自分の番の行動
    function turn(a) {
      const Rr = R(), r = T.rep, my = mySeat();
      if (!T.prompt || T.prompt.kind !== 'turn' || !r.isLegalTurn(a)) return false;
      let ids = [];
      if (a.t === 'discard' || a.t === 'kakan') ids = [a.tile];
      else if (a.t === 'ankan') ids = r.hands[my].filter(x => (x >> 2) === a.kind);
      else if (a.t === 'tsumo' || a.t === 'kyuushu') ids = r.hands[my].slice();
      sendAct({ t: 'turn', a, rv: revealList(ids) });
      void Rr;
      return true;
    }
    function react(a) {
      const r = T.rep, my = mySeat();
      if (!T.prompt || T.prompt.kind !== 'react') return false;
      if (a && !r.isLegalReact(my, a)) return false;
      let ids = [];
      if (a && (a.t === 'pon' || a.t === 'chi')) ids = a.use;
      else if (a && a.t === 'minkan') ids = r.hands[my].filter(x => (x >> 2) === (r.react.tile >> 2));
      else if (a && a.t === 'ron') ids = r.hands[my].slice();
      sendAct({ t: 'react', a: a || null, rv: revealList(ids) });
      return true;
    }

    // ------------------------------------------------------------------ 局のあとの確かめ（全員が自分で）
    function runAudit() {
      const Rr = R();
      if (!Rr || T.auditRes && T.auditRes.uid === Rr.uid) return;
      if (!Rr.parts.every(p => T.xsSeen.has(K(Rr.uid, p)))) return;
      const res = auditRound(Rr, roundMap(T.xsSeen, Rr.uid, Rr.parts), roundMap(T.decks, Rr.uid, [0, 1, 2, 3]), T.st.rules, T.rep && T.rep.result ? T.rep.result.scores : null);
      T.auditRes = Object.assign({ no: Rr.no, uid: Rr.uid }, res);
      if (res.ok && res.round) {
        // 見返し用に、全部が見える局として残す
        T.history.push({ roundWind: Rr.rw, kyoku: Rr.ky, honba: Rr.hb, kyotaku: Rr.kt, scoresBefore: Rr.scores, wall: res.wall, steps: res.round.steps, result: res.round.result });
      }
      changed();
    }

    // ------------------------------------------------------------------ ホスト
    function hs() {
      if (!T.hs) T.hs = { game: null, acts: new Map(), cpu: new Map(), timer: 0, pubTimer: 0, readyAt: 0, ready: new Set(), agents: [] };
      return T.hs;
    }
    function publish() {
      const H = hs();
      if (H.pubTimer) return;
      // 同じ処理の中の変更をまとめて1回で出す（タイマーではなくマイクロタスク: 画面が裏でも間引かれない）
      H.pubTimer = 1;
      Promise.resolve().then(() => {
        H.pubTimer = 0;
        if (T.left) return;
        T.st.seq = (T.st.seq || 0) + 1; T.st.t = now();
        room.pub('state', T.st, { retain: true });
        applyState(JSON.parse(JSON.stringify(T.st)));
      });
    }
    function hostEnsure() {
      const H = hs();
      if (!H.tick) H.tick = setIntervalSafe(() => hostStep(), 1000);
      if (!H.game && T.st.g && !T.st.lobby) {
        // 再読み込み・引き継ぎ: 途中の局は、受け取った部分の鍵がないので続けられない → やり直し
        if (T.st.R && ['keys', 'deck', 'play', 'audit'].includes(T.st.R.phase)) { T.st.R.phase = 'void'; T.st.R.why = 'host'; H.doneAt = now(); }
        // 引き継いだホスト: 状態から半荘を作り直す
        const g = new MJ.Game(T.st.rules, Math.floor(Math.random() * 2 ** 31));
        Object.assign(g, { scores: T.st.g.scores.slice(), roundWind: T.st.g.rw, kyoku: T.st.g.ky, honba: T.st.g.hb, kyotaku: T.st.g.kt, ended: T.st.g.ended, final: T.st.g.final });
        H.game = g;
      }
      hostStep();
    }
    function setIntervalSafe(fn, ms) { const loop = () => { try { fn(); } catch (e) { console.error(e); } H2.t = env.setTimeout(loop, ms); }; const H2 = {}; H2.t = env.setTimeout(loop, ms); return H2; }
    function seen(pid) { return pid === T.pid ? now() : (T.seenAt.get(pid) || 0); }
    function hostCtl(m) {
      const st = T.st;
      if (m.pid) T.seenAt.set(m.pid, now());
      if (m.t === 'join') {
        if (st.seats.some(x => x.k === 'h' && x.pid === m.pid)) { const s = st.seats.find(x => x.pid === m.pid); s.n = clean(m.name); s.ai = m.ai | 0; s.away = 0; publish(); return; }
        if ((st.wait || []).some(w => w.pid === m.pid)) return;
        const free = st.seats.findIndex(x => x.k === 'c');
        if (free < 0) return; // 満席（観戦）
        if (st.lobby) { st.seats[free] = { k: 'h', pid: m.pid, n: clean(m.name), ai: m.ai | 0, hi: 0 }; }
        else { st.wait = (st.wait || []).concat([{ pid: m.pid, n: clean(m.name), ai: m.ai | 0 }]); }
        publish();
      } else if (m.t === 'leave') {
        const i = st.seats.findIndex(x => x.k === 'h' && x.pid === m.pid);
        st.wait = (st.wait || []).filter(w => w.pid !== m.pid);
        if (i >= 0) {
          if (st.lobby || !isPart(m.pid)) st.seats[i] = { k: 'c', n: 'CPU', lv: st.cpu };
          else { st.seats[i].leaving = 1; if (R() && R().phase === 'play') voidRound('left'); }
        }
        publish();
      } else if (m.t === 'ai') { const s = st.seats.find(x => x.k === 'h' && x.pid === m.pid); if (s) { s.ai = m.ai | 0; publish(); } }
      else if (m.t === 'hint') { const s = st.seats.find(x => x.k === 'h' && x.pid === m.pid); if (s) { s.hi = (s.hi | 0) + 1; publish(); } }
      else if (m.t === 'ready') { hs().ready.add(m.pid); hostStep(); }
      else if (m.t === 'again') { if (st.g && st.g.ended) { hs().again = (hs().again || new Set()).add(m.pid); hostStep(); } }
    }
    const clean = s => String(s || 'ゲスト').replace(/[\u0000-\u001f]/g, '').slice(0, 16);
    function hostAct(m) {
      const Rr = R();
      if (m.pid) T.seenAt.set(m.pid, now());
      if (!Rr || m.uid !== Rr.uid || Rr.phase !== 'play' || !Rr.ask || m.n !== Rr.ask.n || !Rr.ask.need.includes(m.pid)) return;
      hs().acts.set(m.pid, m);
      dbg('受けた', m.pid, m.t, m.n);
      hostStep();
    }
    // 見せた牌を確かめる（ほかの全員の部分の鍵＋持ち主の部分の鍵で開く）
    function verifyReveal(Rr, ownerPid, rv) {
      const out = [];
      const deck = T.decks.get(K(Rr.uid, Rr.parts.length - 1));
      for (const it of rv || []) {
        if (!Array.isArray(it)) return null;
        const [pos, shB64] = it;
        if (!(pos >= 0 && pos < 136)) return null;
        let id = T.me && T.me.known[pos];
        if (id == null) {
          const m = T.shares.get(K(Rr.uid, pos)) || new Map();
          const need = Rr.parts.filter(p => p !== ownerPid && p !== T.pid);
          if (!need.every(p => m.has(p))) return 'wait';
          let own;
          try { own = M.fromB64(shB64); } catch (e) { return null; }
          const shs = need.map(p => m.get(p)).concat([own, M.share(deck[pos][0], T.me.x)]);
          id = M.open(deck[pos], shs);
          if (id < 0) return null;
        }
        out.push([pos, id]);
      }
      return out;
    }
    function voidRound(why) {
      const Rr = R();
      if (!Rr) return;
      Rr.phase = 'void'; Rr.why = why; Rr.ask = null;
      hs().doneAt = now();
      publish();
    }
    function hostStep() {
      if (!T.isHost || !T.st || T.left) return;
      const st = T.st, H = hs();
      if (st.lobby || !H.game) return;
      const Rr = R();
      const g = H.game;
      // 次の局（前の局が終わって、全員が「次へ」を押したか時間がたった）
      if (!Rr || Rr.phase === 'done' || Rr.phase === 'void') {
        if (g.ended) {
          const hum = st.seats.filter(x => x.k === 'h').map(x => x.pid);
          if (H.again && hum.every(p => H.again.has(p) || now() - seen(p) > LOST_MS)) { H.again = null; newGame(); }
          return;
        }
        const hum = st.seats.filter(x => x.k === 'h' && now() - seen(x.pid) < LOST_MS).map(x => x.pid);
        if (!Rr || now() - (H.doneAt || 0) > NEXT_MS || hum.every(p => H.ready.has(p))) startRound();
        return;
      }
      if (Rr.phase === 'keys') {
        if (Rr.parts.every(p => T.keysSeen.has(K(Rr.uid, p)))) { Rr.keys = {}; for (const p of Rr.parts) Rr.keys[p] = T.keysSeen.get(K(Rr.uid, p)); Rr.phase = 'deck'; Rr.shuf = 0; publish(); }
        else lostCheck(Rr.parts.filter(p => !T.keysSeen.has(K(Rr.uid, p))));
        return;
      }
      if (Rr.phase === 'deck') {
        if (T.decks.has(K(Rr.uid, Rr.shuf))) { Rr.shuf++; if (Rr.shuf >= Rr.parts.length) { Rr.phase = 'play'; Rr.ask = null; } publish(); }
        else lostCheck([Rr.parts[Rr.shuf]]);
        return;
      }
      if (Rr.phase === 'audit') {
        if (Rr.parts.every(p => T.xsSeen.has(K(Rr.uid, p)))) {
          const res = auditRound(Rr, roundMap(T.xsSeen, Rr.uid, Rr.parts), roundMap(T.decks, Rr.uid, [0, 1, 2, 3]), st.rules, T.rep && T.rep.result ? T.rep.result.scores : null);
          if (!res.ok) { log('検査で食い違い', res.why); voidRound('audit:' + res.why); return; }
          // 半荘に反映
          g.round = res.round; res.round.scoresBefore = Rr.scores;
          g.kyotaku = Rr.kt;
          g.finishRound();
          st.g = gameState(g, st.g.hist.concat([{ rw: Rr.rw, ky: Rr.ky, hb: Rr.hb, line: resultLine(res.round.result), d: res.round.scores.map((x, i) => x - Rr.scores[i]) }]));
          Rr.phase = 'done'; Rr.audit = 'ok'; Rr.ask = null;
          H.doneAt = now(); H.ready = new Set();
          publish();
        } else lostCheck(Rr.parts.filter(p => !T.xsSeen.has(K(Rr.uid, p))));
        return;
      }
      if (Rr.phase !== 'play') return;
      buildRep();
      const r = T.rep;
      if (!r || T.applied !== Rr.steps.length) return;
      if (T.repBroken) { voidRound('broken'); return; }
      if (r.phase === 'end') { Rr.phase = 'audit'; Rr.ask = null; Rr.res = resultLine(r.result); publish(); return; }
      // 公開する牌（ドラ表示牌）が開くまで待つ
      for (let i = 0; i < r.doraCount; i++) if (r.wall[126 + i] >= 1000) { lostCheck(Rr.parts); return; }
      const parts = Rr.parts;
      const pidAt = s => (seatKind(s) === 'h' ? st.seats[s].pid : null);
      const ask = (kind, need) => {
        if (Rr.ask && Rr.ask.n === Rr.steps.length && Rr.ask.kind === kind) return;
        Rr.ask = { n: Rr.steps.length, kind, need, at: now() };
        dbg('問う', kind, Rr.steps.length, need.join(','));
        H.acts = new Map(); H.cpu = new Map();
        publish();
      };
      if (r.phase === 'turn') {
        const s = r.cur;
        if (seatKind(s) === 'c') {
          if (r.hands[s].some(x => x >= 1000)) { lostCheck(parts.filter(p => p !== T.pid)); return; } // CPU の牌がまだ開いていない
          const a = agentFor(s).chooseTurn(r);
          let ids = [];
          if (a.t === 'discard' || a.t === 'kakan') ids = [a.tile];
          else if (a.t === 'ankan') ids = r.hands[s].filter(x => (x >> 2) === a.kind);
          else if (a.t === 'tsumo' || a.t === 'kyuushu') ids = r.hands[s].slice();
          const rv = ids.map(id => [T.rep.wall.indexOf(id), id]);
          if (a.t === 'tsumo' && r.riichi[s] && !uraReady(Rr, r)) return;
          pushStep({ k: 't', s, a, rv: rv.concat(a.t === 'tsumo' && r.riichi[s] ? uraRv(Rr, r) : []) });
          return;
        }
        const pid = pidAt(s);
        ask('turn', [pid]);
        const m = H.acts.get(pid);
        if (!m) { lostCheck([pid]); return; }
        if (m.t !== 'turn' || !m.a) { H.acts.delete(pid); return; }
        const rv = verifyReveal(Rr, pid, m.rv);
        if (rv === 'wait') return;
        if (!rv || !checkTurn(r, s, m.a, rv)) { log('おかしな手', JSON.stringify(m.a)); H.acts.delete(pid); return; }
        if (m.a.t === 'tsumo' && r.riichi[s] && !uraReady(Rr, r)) return;
        pushStep({ k: 't', s, a: m.a, rv: rv.concat(m.a.t === 'tsumo' && r.riichi[s] ? uraRv(Rr, r) : []) });
        return;
      }
      if (r.phase === 'react') {
        const from = r.react.from;
        const humans = [0, 1, 2, 3].filter(s => s !== from && seatKind(s) === 'h').map(pidAt);
        ask('react', humans);
        const resp = [null, null, null, null];
        let rv = [];
        for (let s = 0; s < 4; s++) {
          if (s === from) continue;
          if (seatKind(s) === 'c') {
            if (!H.cpu.has(s)) H.cpu.set(s, r.react.options[s] ? agentFor(s).chooseReact(r, s) : null);
            resp[s] = H.cpu.get(s);
            if (resp[s]) rv = rv.concat(idsForReact(r, s, resp[s]).map(id => [r.wall.indexOf(id), id]));
          } else {
            const m = H.acts.get(pidAt(s));
            if (!m) { lostCheck([pidAt(s)]); return; }
            if (!m.a) continue;
            const v = verifyReveal(Rr, pidAt(s), m.rv);
            if (v === 'wait') return;
            if (!v || !checkReact(r, s, m.a, v)) { resp[s] = null; continue; }
            resp[s] = m.a; rv = rv.concat(v);
          }
        }
        // ロンが立直の人なら裏ドラを開いてから
        const ronRiichi = resp.some((a, s) => a && a.t === 'ron' && r.riichi[s]);
        if (ronRiichi && !uraReady(Rr, r)) return;
        // 実際に成り立つ返事だけ（ロンがあれば鳴きは消える）を手順にする
        pushStep({ k: 'r', resp, rv: rv.concat(ronRiichi ? uraRv(Rr, r) : []) });
        return;
      }
      if (r.phase === 'exhaust') {
        const humans = [0, 1, 2, 3].filter(s => seatKind(s) === 'h').map(pidAt);
        ask('tenpai', humans);
        const d = [false, false, false, false];
        let rv = [];
        for (let s = 0; s < 4; s++) {
          if (seatKind(s) === 'c') { d[s] = r.waits[s].length > 0; if (d[s]) rv = rv.concat(r.hands[s].map(id => [r.wall.indexOf(id), id])); continue; }
          const m = H.acts.get(pidAt(s));
          if (!m) { lostCheck([pidAt(s)]); return; }
          if (m.ten) {
            const v = verifyReveal(Rr, pidAt(s), m.rv);
            if (v === 'wait') return;
            if (v && v.length === r.hands[s].length) { d[s] = true; rv = rv.concat(v); }
          }
        }
        pushStep({ k: 'x', d, rv });
      }
    }
    function idsForReact(r, s, a) {
      if (a.t === 'pon' || a.t === 'chi') return a.use;
      if (a.t === 'minkan') return r.hands[s].filter(x => (x >> 2) === (r.react.tile >> 2));
      if (a.t === 'ron') return r.hands[s].slice();
      return [];
    }
    // 人の行動を、見せた牌で確かめる（足りないところは局のあとの検査で）
    function checkTurn(r, s, a, rv) {
      const ids = new Set(rv.map(x => x[1]));
      if (a.t === 'discard') return rv.length === 1 && rv[0][1] === a.tile && (!r.riichi[s] || rv[0][0] === r.drawnPos);
      if (a.t === 'kakan') return rv.length === 1 && rv[0][1] === a.tile && r.melds[s].some(m => m.type === 'pon' && (m.tiles[0] >> 2) === (a.tile >> 2));
      if (a.t === 'ankan') return rv.length === 4 && [...ids].every(id => (id >> 2) === a.kind);
      if (a.t === 'tsumo' || a.t === 'kyuushu') {
        if (rv.length !== r.hands[s].length) return false;
        return true;
      }
      return false;
    }
    function checkReact(r, s, a, rv) {
      if (a.t === 'pon' || a.t === 'chi') return rv.length === 2 && a.use.every(id => rv.some(x => x[1] === id));
      if (a.t === 'minkan') return rv.length === 3 && rv.every(x => (x[1] >> 2) === (r.react.tile >> 2));
      if (a.t === 'ron') return rv.length === r.hands[s].length;
      return false;
    }
    function uraReady(Rr, r) {
      const want = []; for (let i = 0; i < r.doraCount; i++) want.push(131 + i);
      if (!Rr.ura || Rr.ura.join() !== want.join()) { Rr.ura = want; publish(); }
      return want.every(p => r.wall[p] < 1000);
    }
    function uraRv(Rr, r) { return (Rr.ura || []).map(p => [p, r.wall[p]]); }
    function pushStep(step) {
      const Rr = R();
      Rr.steps.push(step);
      dbg('手順', Rr.steps.length - 1, step.k);
      Rr.ask = null;
      hs().acts = new Map(); hs().cpu = new Map();
      // ドラ表示牌などの公開の牌も state に（遅れて来た人のため）
      const r = T.rep;
      Rr.pub = [];
      for (let i = 0; i < 10; i++) { const p = 126 + i; if (r && r.wall[p] < 1000 && (i < r.doraCount || (Rr.ura || []).includes(p))) Rr.pub.push([p, r.wall[p]]); }
      publish();
    }
    function agentFor(s) {
      const H = hs();
      if (!H.agents[s]) H.agents[s] = env.makeAgent(T.st.seats[s].lv || T.st.cpu);
      return H.agents[s];
    }
    function lostCheck(pids) {
      // 待っている人が長く黙っていたら、その局は無効（その人の牌はほかのだれも開けない）
      const H = hs();
      const Rr = R();
      const since = Math.max(Rr && Rr.ask ? Rr.ask.at || 0 : 0, H.phaseAt || 0);
      for (const p of pids) {
        if (!p || p === T.pid) continue;
        if (now() - seen(p) > LOST_MS && now() - since > LOST_MS / 2) {
          const i = T.st.seats.findIndex(x => x.k === 'h' && x.pid === p);
          if (i >= 0) T.st.seats[i].leaving = 1;
          voidRound('lost');
          return;
        }
      }
    }
    function gameState(g, hist) {
      return { scores: g.scores.slice(), rw: g.roundWind, ky: g.kyoku, hb: g.honba, kt: g.kyotaku, ended: g.ended, final: g.final || null, hist: hist || [] };
    }
    function resultLine(res) {
      if (res.type === 'agari') return res.wins.map(w => ({ s: w.seat, ts: w.tsumo ? 1 : 0, han: w.han, fu: w.fu, ym: w.yakuman, lim: w.limit, v: w.value }));
      return res.reason;
    }
    function startRound() {
      const st = T.st, H = hs(), g = H.game;
      // 席の入れ替え（抜けた人 → CPU、待っていた人 → 空いた CPU の席）
      st.seats = st.seats.map(x => (x.k === 'h' && (x.leaving || (x.pid !== T.pid && now() - seen(x.pid) > LOST_MS)) ? { k: 'c', n: 'CPU', lv: st.cpu } : x));
      for (const w of st.wait || []) { const i = st.seats.findIndex(x => x.k === 'c'); if (i >= 0) st.seats[i] = { k: 'h', pid: w.pid, n: w.n, ai: w.ai, hi: 0 }; }
      st.wait = [];
      const humans = st.seats.filter(x => x.k === 'h').map(x => x.pid);
      const parts = [T.pid].concat(humans.filter(p => p !== T.pid));
      const prev = R();
      st.R = { no: (prev ? prev.no : 0) + 1, uid: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), rw: g.roundWind, ky: g.kyoku, hb: g.honba, kt: g.kyotaku, scores: g.scores.slice(), parts, phase: 'keys', steps: [], pub: [], ask: null };
      H.phaseAt = now(); H.ready = new Set(); H.agents = [];
      T.auditRes = null; T.repBroken = false;
      publish();
    }
    function newGame() {
      const st = T.st, H = hs();
      // 席の順（起家）は毎回ランダム
      const seats = st.seats.slice();
      for (let i = 3; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = seats[i]; seats[i] = seats[j]; seats[j] = t; }
      st.seats = seats.map(x => (x.k === 'h' ? Object.assign({}, x, { hi: 0 }) : x));
      H.game = new MJ.Game(st.rules, Math.floor(rand() * 2 ** 31));
      st.g = gameState(H.game, []);
      st.lobby = false; st.R = null;
      T.history = [];
      publish();
      startRound();
    }

    // ------------------------------------------------------------------ 窓口
    room.sub('state', onState); room.sub('mp', onMp); room.sub('ctl', onCtl); room.sub('act', onAct);
    for (let i = 0; i < 4; i++) room.sub('deck/' + i, onDeck);
    if (create) {
      const seats = [{ k: 'h', pid: T.pid, n: clean(env.name), ai: env.ai | 0, hi: 0 }].concat([1, 2, 3].map(() => ({ k: 'c', n: 'CPU', lv: create.cpu })));
      T.st = { v: 1, code, host: T.pid, seq: 1, t: now(), rules: { length: create.length, aka: create.aka }, cpu: create.cpu, seats, lobby: true, g: null, R: null, wait: [] };
      T.isHost = true;
      publish();
    }
    const hb = setIntervalSafe(() => {
      if (T.left) return;
      room.pub('ctl', { t: 'hb', pid: T.pid });
      // 席がない（引き継ぎで外された・入りそびれた）なら、もう一度座りたいと伝える（次の局から）
      if (T.st && !T.isHost && mySeat() < 0 && !(T.st.wait || []).some(w => w.pid === T.pid)) room.pub('ctl', { t: 'join', pid: T.pid, name: env.name, ai: env.ai | 0 });
      if (T.isHost) hostStep(); else hostWatch();
    }, HB_MS);
    room.pub('ctl', { t: 'join', pid: T.pid, name: env.name, ai: env.ai | 0 });
    // ホストが黙ったら、席順で次の人が引き継ぐ（その局は無効にして、同じ局をやり直す）
    function hostWatch() {
      const st = T.st;
      if (!st || T.isHost || now() - Math.max(T.lastState, seen(st.host)) < LOST_MS) return;
      const hum = st.seats.filter(x => x.k === 'h' && x.pid !== st.host).map(x => x.pid);
      if (hum[0] !== T.pid) return;
      log('ホストを引き継ぎます');
      st.host = T.pid; st.seq = (st.seq || 0) + 1; st.ep = (st.ep || 0) + 1;
      const old = st.seats.findIndex(x => x.k === 'h' && x.pid !== T.pid && !hum.includes(x.pid));
      if (old >= 0) st.seats[old] = { k: 'c', n: 'CPU', lv: st.cpu };
      T.isHost = true;
      if (st.R && st.R.phase !== 'done') { st.R.phase = 'void'; st.R.why = 'host'; }
      hostEnsure();
      publish();
    }
    return {
      get st() { return T.st; }, get rep() { return T.rep; }, get isHost() { return T.isHost; }, get prompt() { return T.prompt; }, get audit() { return T.auditRes; }, get history() { return T.history; },
      seat: mySeat, turn, react,
      start() { if (T.isHost && T.st.lobby) { hs(); newGame(); hostEnsure(); } },
      ready() { room.pub('ctl', { t: 'ready', pid: T.pid }); if (T.isHost) { hs().ready.add(T.pid); hostStep(); } },
      again() { room.pub('ctl', { t: 'again', pid: T.pid }); if (T.isHost) { const H = hs(); H.again = (H.again || new Set()).add(T.pid); hostStep(); } },
      setAI(f) { room.pub('ctl', { t: 'ai', pid: T.pid, ai: f | 0 }); if (T.isHost) hostCtl({ t: 'ai', pid: T.pid, ai: f }); },
      hint() { room.pub('ctl', { t: 'hint', pid: T.pid }); if (T.isHost) hostCtl({ t: 'hint', pid: T.pid }); },
      leave() {
        room.pub('ctl', { t: 'leave', pid: T.pid });
        if (T.isHost) {
          // ホストが離れるときは、残っている人に引き継いでもらう（状態はそのまま）
          hostCtl({ t: 'leave', pid: T.pid });
        }
        T.left = true; env.clearTimeout(hb.t);
        if (T.hs && T.hs.tick) env.clearTimeout(T.hs.tick.t);
        room.unsub('state'); room.unsub('mp'); room.unsub('ctl'); room.unsub('act');
        for (let i = 0; i < 4; i++) room.unsub('deck/' + i);
      },
      debug: () => T,
    };
  }

  // 局のあとの確かめ: 山（全員の秘密の鍵で開く）・混ぜ方（各段が前の段の並べ替え＋再暗号化か）・見せた牌・手順（ふつうのルールエンジンで作り直して同じ結果か）
  function auditRound(Rr, xsSeen, decks, rules, repScores) {
    try {
      const xs = Rr.parts.map(p => M.xFromHex(xsSeen.get(p).x));
      const hs = Rr.parts.map(p => M.fromB64(Rr.keys[p]));
      const H = M.jointKey(hs);
      const hExp = M.fixedBase(H);
      // 混ぜ方
      let prev = M.initialDeck();
      for (let i = 0; i < Rr.parts.length; i++) {
        const d = decks.get(i), m = xsSeen.get(Rr.parts[i]);
        if (!d) return { ok: false, why: 'deck-missing' };
        if (!Array.isArray(m.perm) || !Array.isArray(m.ss) || m.perm.length !== 136 || m.ss.length !== 136) return { ok: false, why: 'perm-missing' };
        for (let j = 0; j < 136; j++) {
          const [a, b] = prev[m.perm[j]], s = M.fromB64(m.ss[j]);
          if (d[j][0] !== a * M.gExp(s) % M.P || d[j][1] !== b * hExp(s) % M.P) return { ok: false, why: 'shuffle', stage: i };
        }
        prev = d;
      }
      const au = M.audit(prev, xs, hs);
      if (!au.ok) return { ok: false, why: au.why };
      const wall = au.cards;
      for (const st of Rr.steps) for (const [pos, id] of st.rv || []) if (wall[pos] !== id) return { ok: false, why: 'reveal' };
      for (const [pos, id] of Rr.pub || []) if (wall[pos] !== id) return { ok: false, why: 'reveal' };
      const opts = { rules, wall, dealer: Rr.ky, roundWind: Rr.rw, kyoku: Rr.ky, honba: Rr.hb, kyotaku: Rr.kt, scores: Rr.scores };
      const r = MJ.replayRound(opts, Rr.steps.map(s => (s.k === 't' ? { k: 't', s: s.s, a: s.a } : s.k === 'r' ? { k: 'r', resp: s.resp } : { k: 'x', d: s.d })));
      if (r.phase !== 'end') return { ok: false, why: 'unfinished' };
      // 写しの結果（宣言どおりに計算したもの）と、全部が見える局の結果が同じか（聴牌を隠した・うその聴牌なども、ここで分かる）
      if (repScores && JSON.stringify(r.scores) !== JSON.stringify(repScores)) return { ok: false, why: 'result' };
      return { ok: true, wall, round: r };
    } catch (e) {
      return { ok: false, why: 'rule:' + e.message };
    }
  }

  return { createTable, auditRound };
});
