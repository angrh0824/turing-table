/* オンラインの卓（最大4人。空いた席は CPU）。共通の ../common/online.js の汎用の部屋 room('yt-<コード>') を使う。招待リンクは ?table=コード
 *
 * 進め方: 卓を作った人（ホスト）の端末が卓の状態を持ち、保持メッセージ state で配る。ほかの人は行動（振る・残す・記入）を act で送る
 * サイコロの公正さ: 座った人はみな、秘密の値 s から作ったハッシュの鎖 h_i = SHA256(h_(i-1)) の端 h_2000 を最初に公開する（約束）。
 *   k 回目に振るときは、振る人 A と、もう1人 B（A がホストでなければホスト、A がホストか CPU ならほかの人）が鎖の値 h_(2000-k) を明かし、
 *   目は SHA256("yt:卓:k:Aの値:Bの値") から決める。明かす値は前もって約束済みなので選べず、相手の値は振るまで分からないので、
 *   だれも目を操れず、前もって知ることもできない。受け取った人はみな、値が鎖につながるかと目が合うかを確かめる（合わなければ表示）
 *   人がホスト1人だけ（ほかは CPU）のときはホストの端末の乱数。B が6秒答えないときはホストの値だけで振り、そのことを表示する
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const App = window.YachtApp, Y = window.YachtCore, AI = window.YachtAI;
  if (!App) return;
  const { esc, store } = App;
  const GAME = 'yacht';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/yacht/';
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available() && !!(window.crypto && crypto.getRandomValues);
  const N = 2000; // 鎖の長さ（1つの卓で振れる回数の上限）
  const LV = AI.LEVELS;
  const ss = {
    get(k, d) { try { const v = JSON.parse(sessionStorage.getItem('yacht-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem('yacht-' + k, JSON.stringify(v)); } catch (e) { /* 無視 */ } },
  };
  // 席の ID はタブごと（再読み込みしても同じ。別のタブは別の人）
  const pid = ss.get('pid', '') || ('t' + Math.random().toString(36).slice(2, 10));
  ss.set('pid', pid);
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let NET = null, ROOM = null, code = null, st = null;
  let hostSeen = 0, joinTimer = 0, alertMsg = '', lastRvK = 0, myPendK = 0;
  const cosigned = new Set(), ver = {}, lastSeen = {};
  const lobby = { msg: '', n: 4, cpu: 'strong' };
  const aiFlag = () => (App.aiOn() ? 1 : 0);
  const isHost = () => !!(st && st.host === pid);
  const mySeat = () => (st ? st.seats.findIndex(x => x.k === 'h' && x.pid === pid) : -1);

  // Worker のタイマー（画面が裏にあってもホストの進行が止まらないように）
  const wt = (() => {
    try {
      const src = 'const t={};onmessage=e=>{const d=e.data;if(d.c==="s"){t[d.id]=setTimeout(()=>postMessage(d.id),d.ms)}else if(d.c==="i"){t[d.id]=setInterval(()=>postMessage(d.id),d.ms)}else{clearTimeout(t[d.id]);clearInterval(t[d.id]);delete t[d.id]}}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const cbs = new Map(); let id = 0;
      w.onmessage = e => { const f = cbs.get(e.data); if (f) { if (f.once) cbs.delete(e.data); f.fn(); } };
      return {
        setTimeout(fn, ms) { const i = ++id; cbs.set(i, { fn, once: true }); w.postMessage({ c: 's', id: i, ms }); return i; },
        setInterval(fn, ms) { const i = ++id; cbs.set(i, { fn, once: false }); w.postMessage({ c: 'i', id: i, ms }); return i; },
        clear(i) { if (!i) return; cbs.delete(i); w.postMessage({ c: 'x', id: i }); },
      };
    } catch (e) { return { setTimeout: (f, ms) => setTimeout(f, ms), setInterval: (f, ms) => setInterval(f, ms), clear: i => { clearTimeout(i); clearInterval(i); } }; }
  })();

  // ------------------------------------------------------------------ ハッシュの鎖
  let chain = null;
  function myChain() {
    if (chain && chain.code === code) return chain;
    let sec = ss.get('sec-' + code, '');
    if (!sec) { const b = new Uint8Array(32); crypto.getRandomValues(b); sec = Y.hex(b); ss.set('sec-' + code, sec); }
    const arr = new Array(N + 1);
    let x = Y.unhex(sec); arr[0] = sec;
    for (let i = 1; i <= N; i++) { x = Y.sha256(x); arr[i] = Y.hex(x); }
    chain = { code, arr, anchor: arr[N] };
    return chain;
  }
  const reveal = k => (k >= 1 && k < N ? myChain().arr[N - k] : '');
  // p の k 回目の値 v が、前に確かめた値（はじめは約束の端）につながるか
  function checkReveal(p, k, v, anchor) {
    const r = ver[p] || (ver[p] = { k: 0, v: anchor });
    if (!r.v || !v || k <= r.k || k - r.k > N) return false;
    let x = Y.unhex(v);
    for (let i = r.k; i < k; i++) x = Y.sha256(x);
    if (Y.hex(x) !== r.v) return false;
    ver[p] = { k, v };
    return true;
  }
  const rollSeed = (k, a, b) => `yt:${code}:${k}:${a}:${b || ''}`;

  // ------------------------------------------------------------------ つなぐ
  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: GAME,
      onStatus: () => { renderBadge(); renderLobby(); if (st) toApp(); },
      onPresence: () => { renderBadge(); renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(aiFlag());
    NET.connect();
    return NET;
  }
  function openTable(c, create) {
    if (!net()) return;
    leave(true, true);
    code = c; st = null; alertMsg = ''; lastRvK = 0; myPendK = 0;
    ss.set('table', code);
    myChain();
    ROOM = NET.room('yt-' + code);
    ROOM.sub('state', onState);
    ROOM.sub('ctl', onCtl);
    ROOM.sub('act', onAct);
    if (create) {
      st = { v: 1, ver: 0, code, host: pid, phase: 'lobby', n: create.n, cpu: create.cpu, seats: [seatMe()], watch: [], g: null, k: 0, rv: null, req: null, pend: -1, gameNo: 0 };
      pubWhenReady();
    }
    // 座れるまで「座りたい」を出し直す（つながる前の便りは捨てられるため）
    clearInterval(joinTimer);
    joinTimer = setInterval(() => {
      if (!code) return;
      if (st && (mySeat() >= 0 || st.watch.some(w => w.pid === pid))) return;
      ctl({ t: 'join', name: myName, ai: aiFlag(), cm: myChain().anchor });
    }, 2000);
    renderLobby();
  }
  const seatMe = () => ({ k: 'h', pid, name: myName, ai: aiFlag(), hints: 0, cm: myChain().anchor, on: 1 });
  function pubWhenReady() {
    if (NET && NET.status === 'on') pub();
    else setTimeout(pubWhenReady, 300);
  }
  function ctl(m) { if (!ROOM) return; m.pid = pid; if (isHost()) hostCtl(m); else ROOM.pub('ctl', m); }
  function sendAct(m) { if (!ROOM) return; m.pid = pid; if (isHost()) hostAct(m); else ROOM.pub('act', m); }
  function leave(quiet, keepDlg) {
    if (!code) return;
    if (st && ROOM) {
      const others = st.seats.filter(x => x.k === 'h' && x.pid !== pid && x.on);
      if (isHost()) {
        if (others.length) { // 次の人にホストを渡す
          vacate(pid);
          st.host = others[0].pid; st.req = null;
          pub();
        } else ROOM.pub('state', null, { retain: true }); // だれもいなくなる卓は消す
      } else ROOM.pub('ctl', { t: 'leave', pid });
      ROOM.unsub('state'); ROOM.unsub('ctl'); ROOM.unsub('act');
    }
    clearInterval(joinTimer);
    wt.clear(cpuTimer); cpuTimer = 0; wt.clear(reqTimer); reqTimer = 0;
    code = null; st = null; ROOM = null; chain = null; lastPres = '';
    ss.set('table', null);
    if (NET) NET.setPresence({ s: 'idle', c: '', m: '' });
    if (App.S && App.S.online) App.endOnline();
    if (!quiet) lobby.msg = '卓を離れました';
    if (!keepDlg) renderLobby();
  }
  window.YachtOnline = { openLobby, leave: q => { leave(!!q); renderLobby(); }, get state() { return st; } };

  // ------------------------------------------------------------------ ホスト
  function pub() {
    if (!ROOM) return;
    st.ver++; st.ts = Date.now();
    ROOM.pub('state', st, { retain: true });
    hostSeen = Date.now();
    toApp();
  }
  function vacate(p) {
    const i = st.seats.findIndex(x => x.k === 'h' && x.pid === p);
    if (i < 0) { st.watch = st.watch.filter(w => w.pid !== p); return; }
    if (st.phase === 'lobby') st.seats.splice(i, 1);
    else st.seats[i] = { k: 'c', lvl: st.cpu, was: st.seats[i].name };
  }
  function hostCtl(m) {
    if (!m || !m.pid) return;
    lastSeen[m.pid] = Date.now();
    const i = st.seats.findIndex(x => x.k === 'h' && x.pid === m.pid);
    if (m.t === 'join') {
      const name = String(m.name || 'ゲスト').slice(0, 16), cm = /^[0-9a-f]{64}$/.test(m.cm || '') ? m.cm : '';
      if (i >= 0) { Object.assign(st.seats[i], { name, ai: m.ai | 0, on: 1 }); pub(); return; }
      if (!cm) return;
      if (st.phase === 'lobby') { if (st.seats.length < st.n) st.seats.push({ k: 'h', pid: m.pid, name, ai: m.ai | 0, hints: 0, cm, on: 1 }); else st.watch.push({ pid: m.pid, name, cm }); }
      else if (st.phase === 'over') {
        const c = st.seats.findIndex(x => x.k === 'c');
        if (c >= 0) st.seats[c] = { k: 'h', pid: m.pid, name, ai: m.ai | 0, hints: 0, cm, on: 1 };
        else if (!st.watch.some(w => w.pid === m.pid)) st.watch.push({ pid: m.pid, name, cm });
      } else if (!st.watch.some(w => w.pid === m.pid)) st.watch.push({ pid: m.pid, name, cm });
      pub();
    } else if (m.t === 'leave') { vacate(m.pid); pub(); }
    else if (i >= 0 && m.t === 'ai') { st.seats[i].ai = m.ai | 0; pub(); }
    else if (i >= 0 && m.t === 'hint') { st.seats[i].hints = (st.seats[i].hints | 0) + 1; pub(); }
    else if (i >= 0 && m.t === 'ping' && !st.seats[i].on) { st.seats[i].on = 1; pub(); }
  }
  function hostAct(m) {
    const g = st.g;
    if (!m || st.phase !== 'play' || !g || g.over) return;
    lastSeen[m.pid] = Date.now();
    const s = st.seats.findIndex(x => x.k === 'h' && x.pid === m.pid);
    if (m.t === 'cosign') {
      if (st.req && m.k === st.req.k && st.req.cos === s && checkReveal(m.pid, m.k, m.v, st.seats[s].cm)) finalize(st.req.hold, m.k, st.req.a, { p: m.pid, v: m.v }, 'pair');
      return;
    }
    if (s < 0 || s !== g.cur) return;
    turnSeen = Date.now();
    if (m.t === 'hold') { if (Y.canHold(g)) { g.hold = m.mask & 31; pub(); } }
    else if (m.t === 'score') { if (Y.canScore(g, m.cat)) { Y.applyScore(g, m.cat); afterScore(); } }
    else if (m.t === 'roll') {
      if (!Y.canRoll(g) || st.req || m.k !== st.k + 1) return;
      if (m.pid === pid) { hostRoll(m.hold); return; }
      if (!checkReveal(m.pid, m.k, m.v, st.seats[s].cm)) { App.toast(`${st.seats[s].name}さんの値が約束と合いません`); return; }
      finalize(m.hold, m.k, { p: m.pid, v: m.v }, { p: pid, v: reveal(m.k) }, 'pair');
    }
  }
  // ホストが振る（ホスト自身か CPU の席）: ほかの人に値を明かしてもらってから
  let reqTimer = 0;
  function hostRoll(hold) {
    if (st.req || !Y.canRoll(st.g)) return;
    const k = st.k + 1, a = { p: pid, v: reveal(k) };
    const cos = st.seats.findIndex(x => x.k === 'h' && x.pid !== pid && x.on);
    if (cos < 0) { finalize(hold, k, a, null, 'own'); return; }
    st.req = { k, hold, a, cos };
    pub();
    wt.clear(reqTimer);
    reqTimer = wt.setTimeout(() => { reqTimer = 0; if (st && st.req && st.req.k === k) finalize(hold, k, a, null, 'alone'); }, 6000);
  }
  function finalize(hold, k, a, b, mode) {
    const g = st.g;
    wt.clear(reqTimer); reqTimer = 0;
    if (g.rolls > 0) g.hold = hold & 31;
    let fresh;
    if (mode === 'own') { const r = new Uint8Array(16); crypto.getRandomValues(r); fresh = Y.diceFromHash('own:' + Y.hex(r)); }
    else fresh = Y.diceFromHash(rollSeed(k, a.v, b && b.v));
    const first = g.rolls === 0;
    Y.applyRoll(g, fresh);
    st.k = k; st.req = null;
    st.rv = { k, a, b, mode, first, hold: g.hold, dice: g.dice.slice() };
    if (b && b.p === pid) ver[pid] = { k, v: b.v };
    if (a.p === pid) ver[pid] = { k, v: a.v };
    pub();
  }
  function afterScore() {
    st.pend = -1; cpu = null;
    if (st.g.over) st.phase = 'over';
    pub();
  }
  function hostStart() {
    if (!isHost() || st.phase !== 'lobby') return;
    while (st.seats.length < st.n) st.seats.push({ k: 'c', lvl: st.cpu });
    // 順番はランダム
    for (let i = st.seats.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [st.seats[i], st.seats[j]] = [st.seats[j], st.seats[i]]; }
    st.g = Y.newGame(st.n); st.phase = 'play'; st.pend = -1; st.req = null; st.gameNo = 1;
    turnSeen = Date.now();
    pub();
  }
  function hostAgain() {
    if (!isHost() || st.phase !== 'over') return;
    // 見ていた人を CPU の席に座らせ、1番目の人を最後に回す
    for (const w of st.watch.splice(0)) { const c = st.seats.findIndex(x => x.k === 'c'); if (c >= 0) st.seats[c] = { k: 'h', pid: w.pid, name: w.name, ai: 0, hints: 0, cm: w.cm, on: 1 }; }
    st.seats.push(st.seats.shift());
    st.g = Y.newGame(st.n); st.phase = 'play'; st.pend = -1; st.req = null; st.rv = null; st.gameNo++;
    st.seats.forEach(x => { if (x.k === 'h') x.hints = 0; });
    turnSeen = Date.now();
    pub();
  }
  // CPU の席（と、つながりが切れた人・長く動かない人の代わり）をホストが打つ
  let cpuTimer = 0, cpu = null, turnSeen = 0, turnKey = '';
  function hostTick() {
    if (!isHost() || !st || st.phase !== 'play' || !st.g || st.g.over || st.req || cpuTimer) return;
    const g = st.g, s = st.seats[g.cur];
    const key = `${st.gameNo}:${g.round}:${g.cur}`;
    if (key !== turnKey) { turnKey = key; turnSeen = Date.now(); }
    const idle = Date.now() - turnSeen;
    const auto = s.k === 'c' || (s.k === 'h' && s.pid !== pid && ((!s.on && idle > 10000) || idle > 120000));
    if (!auto) return;
    const C = cpu && cpu.key === key ? cpu : null;
    const delay = !C ? 650 : C.stage === 'write' ? 700 : C.stage === 'roll' ? 520 : 450;
    cpuTimer = wt.setTimeout(() => { cpuTimer = 0; cpuStep(); }, delay);
  }
  function cpuStep() {
    if (!isHost() || !st || st.phase !== 'play' || st.req) return;
    const g = st.g, seat = g.cur, s = st.seats[seat];
    const lvl = s.k === 'c' ? s.lvl : 'strong';
    const key = `${st.gameNo}:${g.round}:${seat}`;
    if (!cpu || cpu.key !== key) {
      if (s.k === 'h') App.toast(`${s.name}さんの番を自動で進めます`);
      cpu = { key, plan: AI.plan(g.sheets, seat, lvl), rnd: Y.rng((Math.random() * 4294967296) >>> 0), stage: g.rolls === 0 ? 'roll' : 'decide' };
    }
    const C = cpu;
    if (C.stage === 'roll') { C.stage = 'decide'; hostRoll(g.hold); return; }
    const d = Y.dIndex(g.dice);
    if (C.stage === 'decide') {
      if (g.rolls < 3) {
        const k = AI.decideKeep(C.plan, d, 3 - g.rolls, lvl, C.rnd);
        if (k >= 0) { g.hold = Y.holdMaskFor(g.dice, k, g.hold); C.stage = 'roll'; pub(); return; }
      }
      st.pend = AI.decideCat(C.plan, d, lvl, C.rnd); C.stage = 'write'; pub(); return;
    }
    if (Y.canScore(g, st.pend)) Y.applyScore(g, st.pend);
    afterScore();
  }
  // つながりの見張り（ホスト: 人の席の on/off。ほか: ホストがいなくなったら次の人が引き継ぐ）
  function watchdog() {
    if (!st || !code) return;
    const now = Date.now();
    if (isHost()) {
      let ch = false;
      st.seats.forEach(x => {
        if (x.k !== 'h' || x.pid === pid) return;
        const on = now - (lastSeen[x.pid] || hostSeen0) < 25000 ? 1 : 0;
        if (on !== x.on) { x.on = on; ch = true; }
      });
      if (ch) pub(); else hostTick();
    } else if (mySeat() >= 0 && now - hostSeen > 25000) {
      const next = st.seats.find(x => x.k === 'h' && x.pid !== st.host && x.on);
      if (next && next.pid === pid) {
        App.toast('ホストがいなくなったので、あなたが卓を引き継ぎました');
        const old = st.host;
        st.host = pid; st.req = null;
        const i = st.seats.findIndex(x => x.k === 'h' && x.pid === old);
        if (i >= 0) st.seats[i].on = 0;
        st.seats.forEach(x => { if (x.k === 'h') lastSeen[x.pid] = now; });
        hostSeen0 = now;
        pub();
      }
    }
  }
  let hostSeen0 = Date.now();

  // ------------------------------------------------------------------ 受け取る
  function onState(m) {
    if (!code) return;
    if (!m) { if (st && !isHost()) { lobby.msg = '卓がなくなりました'; leave(true); } return; }
    if (NET && m.from === NET.id) return;
    if (m.code !== code || !Array.isArray(m.seats)) return;
    if (st && m.ver <= st.ver) return;
    const wasHost = isHost();
    delete m.from;
    st = m;
    hostSeen = Date.now();
    if (isHost() && !wasHost) { hostSeen0 = Date.now(); st.seats.forEach(x => { if (x.k === 'h') lastSeen[x.pid] = hostSeen0; }); }
    verifyRoll();
    // 頼まれたら自分の値を明かす
    if (st.req && st.req.cos === mySeat() && !cosigned.has(st.req.k)) { cosigned.add(st.req.k); ROOM.pub('act', { t: 'cosign', pid, k: st.req.k, v: reveal(st.req.k) }); }
    toApp();
  }
  function onCtl(m) { if (m && isHost() && m.pid !== pid) hostCtl(m); else if (m && st && m.pid === st.host) hostSeen = Date.now(); }
  function onAct(m) { if (m && isHost() && m.pid !== pid) hostAct(m); }
  // 受け取った目を確かめる
  function verifyRoll() {
    const rv = st.rv;
    if (!rv || rv.k <= lastRvK) return;
    lastRvK = rv.k;
    if (rv.mode === 'own') return;
    const anchor = p => { const x = st.seats.find(z => z.pid === p) || st.watch.find(z => z.pid === p); return x ? x.cm : ''; };
    let ok = true;
    for (const r of [rv.a, rv.b]) if (r && r.p !== pid && !checkReveal(r.p, rv.k, r.v, anchor(r.p))) ok = false;
    const fresh = Y.diceFromHash(rollSeed(rv.k, rv.a.v, rv.b && rv.b.v));
    const rolled = rv.first ? 31 : 31 & ~rv.hold;
    for (let i = 0; i < 5; i++) if ((rolled >> i) & 1 && rv.dice[i] !== fresh[i]) ok = false;
    if (!ok) alertMsg = 'サイコロの検査が合いません（ホストの改ざんか、通信の乱れ）';
  }

  // ------------------------------------------------------------------ 卓 → 画面
  const online = {
    get me() { return mySeat(); },
    canAct() { return !!(NET && NET.status === 'on' && st && st.phase === 'play' && !st.req && st.g && mySeat() === st.g.cur && myPendK !== st.k + 1); },
    act(a) {
      if (!st || !st.g) return;
      if (a.t === 'roll') {
        const k = st.k + 1;
        myPendK = k;
        sendAct({ t: 'roll', hold: a.hold & 31, k, v: reveal(k) });
        setTimeout(() => { if (myPendK === k) { myPendK = 0; App.renderAll(); } }, 8000);
        App.renderAll();
      } else if (a.t === 'hold') sendAct({ t: 'hold', mask: a.mask & 31 });
      else if (a.t === 'score') sendAct({ t: 'score', cat: a.cat });
    },
    present(i) { const x = st && st.seats[i]; return !x || x.k !== 'h' || !!x.on; },
    useHint() { ctl({ t: 'hint' }); },
    setAI(f) { ctl({ t: 'ai', ai: f }); if (NET) NET.setAI(f); renderLobby(); },
    again() { hostAgain(); },
    get isHost() { return isHost(); },
    get alert() { return NET && NET.status !== 'on' ? 'あなたの通信が切れています（つなぎ直しています…）' : alertMsg; },
    resultNote() {
      const o = st ? st.seats.filter(x => x.k === 'h' && x.pid !== pid) : [];
      return o.map(x => `${x.name}さん: ${x.ai ? 'AI補助あり' : 'AI補助なし'}${x.hints ? `・ヒント${x.hints}回` : ''}`).join(' / ');
    },
  };
  function seatsView() {
    const me = mySeat();
    let k = 0;
    return st.seats.map((x, i) => (x.k === 'h'
      ? { kind: i === me ? 'me' : 'remote', name: i === me ? 'あなた' : x.name, ai: x.ai | 0, hints: x.hints | 0 }
      : { kind: 'cpu', level: x.lvl, name: `CPU${++k}` }));
  }
  function toApp() {
    renderBadge();
    if (!st) { renderLobby(); return; }
    presence();
    if (st.phase === 'lobby' || !st.g) { renderLobby(); return; }
    if (mySeat() < 0 && !st.watch.some(w => w.pid === pid)) { renderLobby(); return; }
    const g = Object.assign({}, st.g, { pend: st.pend });
    if (myPendK && st.k >= myPendK) myPendK = 0;
    if (!App.S || !App.S.online) { App.beginOnline(seatsView(), g, online); $('dlg-online').hidden = true; }
    else App.updateOnline(seatsView(), g);
    renderLobby();
    hostTick();
  }
  let lastPres = '';
  function presence() {
    if (!NET || !st) return;
    const me = mySeat();
    const humans = st.seats.filter(x => x.k === 'h').length;
    const free = st.phase === 'lobby' ? st.seats.length < st.n : st.phase === 'over' && st.seats.some(x => x.k === 'c');
    const o = me < 0 && !st.watch.some(w => w.pid === pid) ? { s: 'idle', c: '', m: '' }
      : { s: free ? 'wait' : 'play', c: code, m: code, r: { n: st.n, h: humans, host: isHost() ? 1 : 0 }, rl: `${humans}/${st.n}人・CPU ${(LV[st.cpu] || {}).label || ''}` };
    const k = JSON.stringify(o);
    if (k !== lastPres) { lastPres = k; NET.setPresence(o); }
  }

  // ------------------------------------------------------------------ ロビー
  function renderBadge() {
    const b = $('btn-online');
    if (!b) return;
    const s = NET ? NET.status : 'off';
    b.dataset.st = s;
    const c = NET && s === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    // つながっていれば「対戦」（狭い画面でも消さない）、つながっていなければ「オンライン」
    b.querySelector('.lbl').textContent = s === 'on' || s === 'connecting' ? '対戦' : 'オンライン';
    b.querySelector('.cnt').innerHTML = code ? `卓<small> ${esc(code)}</small>` : c ? `${c.online}人<small>・待ち${g.wait}</small>` : s === 'connecting' ? '…' : '';
  }
  function tables() {
    if (!NET || NET.status !== 'on') return [];
    const by = new Map();
    for (const p of NET.list()) {
      if (p.g !== GAME || !p.c || (p.s !== 'wait' && p.s !== 'play')) continue;
      const t = by.get(p.c) || { code: p.c, people: [], host: '', open: false, rl: '' };
      t.people.push(p.n);
      if (p.r && p.r.host) { t.host = p.n; t.rl = p.rl || ''; }
      if (p.s === 'wait') t.open = true;
      by.set(p.c, t);
    }
    return [...by.values()];
  }
  function renderLobby() {
    if ($('dlg-online').hidden) return;
    const body = $('on-body');
    if (!ONLINE_OK) {
      body.innerHTML = `<p>オンラインの卓は、公開版で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    const s = NET ? NET.status : 'off';
    const c = NET && s === 'on' ? NET.counts() : null;
    const g = c && (c.byGame[GAME] || { wait: 0, play: 0 });
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
    let h = `<div class="on-stats">
        <div class="stat"><b>${c ? c.online : '—'}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${g ? g.wait : '—'}</b><span>ヨットの空き席のある卓の人</span></div>
        <span class="on-conn" data-st="${s}">${s === 'on' ? '● つながっています' : s === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span></div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（ほかの人に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（ほかの人に表示されます）</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="aitag ${aiFlag() ? 'on' : 'off'}">${aiFlag() ? 'AI補助あり' : 'AI補助なし'}</span><button class="btn small" data-act="ai">${aiFlag() ? 'オフにする' : 'オンにする'}</button><span class="hint">勝つ確率・おすすめを出しているか、ヒントの回数がほかの人にも見えます</span></div></div>`;
    if (code && st) {
      const me = mySeat();
      const link = `${location.origin}${location.pathname}?table=${code}`;
      const sv = st.seats.map((x, i) => `<div class="st"><span class="hint">${i + 1}番${i === me ? '（あなた）' : ''}</span><b>${x.k === 'h' ? esc(x.name) : `CPU（${esc((LV[x.lvl] || {}).label || '')}）`}</b>${x.k === 'h' && i !== me ? `<span class="aitag ${x.ai || x.hints ? 'on' : 'off'}">${x.ai ? 'AI補助あり' : 'AI補助なし'}${x.hints ? `・ヒント${x.hints}` : ''}</span>${x.on ? '' : '<span class="hint">通信が切れています</span>'}` : ''}${x.pid && x.pid === st.host ? ' <span class="hint">ホスト</span>' : ''}</div>`).join('');
      const empty = st.phase === 'lobby' ? Math.max(0, st.n - st.seats.length) : 0;
      h += `<div class="field"><span class="lab">卓 <b class="code">${esc(code)}</b>　${st.n}人・${st.phase === 'lobby' ? '始める前' : st.phase === 'play' ? `第${Math.min(12, st.g.round + 1)}回` : '終わり'}</span>
          <div class="seats">${sv}${empty ? `<div class="st"><span class="hint">空き ${empty}席（始めると CPU ${esc((LV[st.cpu] || {}).label || '')}）</span></div>` : ''}</div>
          ${st.watch.length ? `<span class="hint">観戦: ${st.watch.map(w => esc(w.name)).join('・')}（次の対局から空いた席へ）</span>` : ''}
          <span class="hint">サイコロは、2人が前もって約束した値を明かし合って決めるので、ホストも含めてだれも目を操れません。</span></div>
        <div class="field"><span class="lab">招待</span><span class="hint" style="word-break:break-all">${esc(link)}</span><div><button class="btn small" data-act="copy">招待リンクをコピー</button></div></div>
        <div class="actions" style="justify-content:flex-start">${isHost() && st.phase === 'lobby' ? '<button class="btn primary" data-act="start">始める</button>' : ''}${isHost() && st.phase === 'over' ? '<button class="btn primary" data-act="again">もう一局</button>' : ''}<button class="btn" data-act="leave">卓を離れる</button></div>`;
      if (st.phase === 'lobby') h += `<p class="hint" style="margin:8px 0 0">${isHost() ? 'ほかの人を待つか、「始める」で空いた席を CPU にして始めます。' : 'ホストが始めるのを待っています。'}</p>`;
    } else if (code) {
      h += `<p class="on-msg">卓 ${esc(code)} に入っています…（見つからないときは、ホストがいなくなったのかもしれません）</p><div class="actions" style="justify-content:flex-start"><button class="btn" data-act="leave">やめる</button></div>`;
    } else {
      const ts = tables();
      h += `<div class="field"><span class="lab">いまある卓（${ts.length}）</span><div class="on-list">${ts.length ? ts.map(t => `<div class="on-row"><b>${esc(t.host || t.people[0])}さんの卓</b><span class="hint">${esc(t.rl || `${t.people.length}人`)}</span>${t.open ? `<button class="btn small primary" data-join="${esc(t.code)}">座る</button>` : `<button class="btn small" data-join="${esc(t.code)}">観戦</button>`}</div>`).join('') : '<p class="hint" style="margin:0">いまはありません。下で卓を作れます。</p>'}</div></div>
        <div class="field"><span class="lab">卓を作る（空いた席は CPU）</span>
          ${seg('n', [[2, '2人'], [3, '3人'], [4, '4人']], lobby.n)}
          ${seg('cpu', AI.LEVEL_KEYS.map(k => [k, LV[k].label]), lobby.cpu)}
          <div><button class="btn primary" data-act="create"${s === 'on' ? '' : ' disabled'}>この設定で卓を作る</button></div></div>`;
    }
    h += '<p class="hint" style="margin:6px 0 0">公開の中継サーバーを使うため、名前と点数はほかの人からも見える可能性があります。</p>';
    body.innerHTML = h;
  }
  const code4 = () => { const A2 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += A2[Math.floor(Math.random() * A2.length)]; return s; };
  function openLobby() {
    $('dlg-online').hidden = false;
    if (ONLINE_OK) net();
    renderLobby();
  }
  $('btn-online').addEventListener('click', openLobby);
  $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
  $('dlg-online').addEventListener('click', e => {
    if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
    const b = e.target.closest('button');
    if (!b) return;
    const segEl = b.closest('[data-seg]');
    if (segEl) { lobby[segEl.dataset.seg] = segEl.dataset.seg === 'n' ? Number(b.dataset.v) : b.dataset.v; renderLobby(); return; }
    if (b.dataset.join) { lobby.msg = ''; openTable(b.dataset.join, null); return; }
    const act = b.dataset.act;
    if (act === 'ai') { App.settings.ai = !App.settings.ai; store.set('settings', App.settings); online.setAI(aiFlag()); App.renderAll(); }
    else if (act === 'create') { lobby.msg = ''; openTable(code4(), { n: lobby.n, cpu: lobby.cpu }); }
    else if (act === 'start') { hostStart(); }
    else if (act === 'again') { hostAgain(); }
    else if (act === 'leave') { leave(false); }
    else if (act === 'copy') {
      const link = `${location.origin}${location.pathname}?table=${code}`;
      try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }, () => { lobby.msg = link; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
    }
  });
  $('dlg-online').addEventListener('change', e => {
    if (e.target.id === 'on-name') {
      myName = e.target.value.trim().slice(0, 16) || myName;
      store.set('name', myName);
      if (NET) NET.setName(myName);
      if (code) ctl({ t: 'join', name: myName, ai: aiFlag(), cm: myChain().anchor });
    }
  });

  // はじめ: 招待リンク・再読み込みで卓に戻る
  const q = new URLSearchParams(location.search).get('table');
  const back = ss.get('table', null);
  if (ONLINE_OK) {
    net();
    renderBadge();
    if (q) { history.replaceState(null, '', location.pathname); openTable(q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8), null); openLobby(); }
    else if (back) openTable(back, null);
  } else if (q) openLobby();
  // 生きている合図（ホストも出す。ほかの人はこれでホストがいるかを見る）
  setInterval(() => { renderBadge(); if (code && ROOM) { if (isHost()) ROOM.pub('ctl', { t: 'ping', pid }); else ctl({ t: 'ping' }); } }, 8000);
  wt.setInterval(watchdog, 4000);
})();
