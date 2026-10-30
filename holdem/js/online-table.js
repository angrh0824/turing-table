/* オンラインの多人数の卓（common/online.js の汎用の部屋を使う）
 *
 * 部屋 r/<卓のコード>/… の中の連絡:
 *   state（保持）… 卓の公開の状態。ホスト（卓を作った人。いなくなったら次の人）だけが出す
 *   ctl        … 席に着く・離席・AI補助の変更・ヒント・生きている合図（全員 → ホスト）
 *   act        … 自分の番の行動（全員 → ホスト。ホストが合法か確かめて反映）
 *   mp         … だれも山札を知らない配り方（js/mental.js）の鍵・混ぜた山札・部分の鍵
 * 公開の状態には「行動の並び」と「開いた場のカード」だけを入れ、各自が同じルールエンジンで再現する。手札は各自の手元だけ
 * 空いた席は CPU（ホストの端末が動かす）。途中から来た人は CPU の席を（そのチップごと）次のハンドから引き継ぐ。抜けた人の席は CPU が代わりに打つ
 */
(function () {
  'use strict';
  const M = window.HoldemMental;
  let app = null, H = null, A = null, NET = null;
  const ONLINE_OK = !!(window.SSIHOnline && window.SSIHOnline.available && window.SSIHOnline.available() && M);
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/holdem/';
  const TURN_MS = 30000, PHASE_MS = 15000, NEXT_MS = 3800;
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code5 = () => { let s = ''; for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const $ = id => document.getElementById(id);

  // 自分（再読み込みしても同じ席に戻れるよう、このタブに覚える ID。タブごとに別の人として座れる）
  let PID = null, myName = '';
  const sess = {
    get(k, d) { try { const v = JSON.parse(sessionStorage.getItem('holdem-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem('holdem-' + k, JSON.stringify(v)); } catch (e) { /* 無視 */ } },
  };
  const O = { code: null, room: null, st: null, isHost: false, lobbyMsg: '', joining: null, lastStateAt: 0, beat: 0 };
  const lobby = { n: 6, cpu: 'strong', mode: 'sng', stack: 100 };

  // ------------------------------------------------------------------ 窓口
  window.HoldemOnline = {
    init(a) {
      app = a; H = a.H; A = a.A;
      PID = sess.get('pid', null);
      if (!PID) { PID = 'p' + Math.random().toString(36).slice(2, 12); sess.set('pid', PID); }
      myName = app.store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
      Object.assign(lobby, app.store.get('lobby', {}));
      if (ONLINE_OK) { net(); badge(); }
      const q = new URLSearchParams(location.search).get('table');
      if (q && ONLINE_OK) { O.joining = q.toUpperCase().slice(0, 8); history.replaceState(null, '', location.pathname); }
      // 前にいた卓に戻る
      const back = sess.get('online', null);
      if (!O.joining && back && back.code && Date.now() - back.t < 30 * 60e3 && ONLINE_OK) O.joining = back.code;
      if (O.joining) { open(); tryJoin(); }
      setInterval(tick, 1000);
    },
    open, active: () => !!O.code, leave: () => leave(true),
    setAI(f) { if (O.code) ctl({ t: 'ai', ai: f }); },
    hint() { if (O.code) ctl({ t: 'hint' }); },
    get code() { return O.code; },
    debug: () => ({ O, part, HS, disp, PID }),
  };

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = window.SSIHOnline.create({
      game: 'holdem',
      onStatus: () => { badge(); renderLobby(); if (NET.status === 'on') tryJoin(); },
      onPresence: () => { badge(); renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(app.aiFlags());
    NET.connect();
    return NET;
  }
  function badge() {
    const b = $('btn-online');
    if (!b) return;
    const st = NET ? NET.status : (ONLINE_OK ? 'off' : 'unavailable');
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null;
    const g = c && c.byGame.holdem;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
    if (O.code) b.querySelector('.lbl').textContent = `卓 ${O.code}`;
    else b.querySelector('.lbl').textContent = 'オンライン';
  }
  // いまある卓（在席情報を卓のコードでまとめる）
  function tables() {
    if (!NET || NET.status !== 'on') return [];
    const by = new Map();
    for (const p of NET.list()) {
      if (p.g !== 'holdem') continue;
      const c = p.c || p.m;
      if (!c) continue;
      const t = by.get(c) || { code: c, people: [], info: null };
      t.people.push(p);
      if (p.r && (!t.info || p.r.host)) t.info = p.r;
      by.set(c, t);
    }
    return [...by.values()];
  }

  // ------------------------------------------------------------------ ロビー
  function open() {
    if (!ONLINE_OK) {
      $('on-body').innerHTML = `<p>オンラインの卓は、公開版（GitHub Pages）で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      $('dlg-online').hidden = false;
      return;
    }
    net();
    $('dlg-online').hidden = false;
    renderLobby();
  }
  function renderLobby() {
    if (!$('dlg-online') || $('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', c = NET ? NET.counts() : null, g = c && c.byGame.holdem;
    const num = v => (st === 'on' && c ? v : '—');
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
    const ts = tables().filter(t => t.code !== O.code);
    const aiTxt = f => (f ? 'AI補助あり' : 'AI補助なし');
    let body = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン</span></div>
        <div class="stat"><b>${num(g ? g.wait : 0)}</b><span>空き席のある卓に</span></div>
        <div class="stat"><b>${num(g ? g.play : 0)}</b><span>満席の卓に</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${O.lobbyMsg ? `<p class="on-msg">${esc(O.lobbyMsg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（卓で表示）</span><input class="text" id="on-name" maxlength="12" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（ほかの人の画面の、あなたの席に表示されます）</span>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="aitag ${app.aiFlags() ? 'on' : 'off'}" style="background:var(--surface-2);color:var(--ink)">${aiTxt(app.aiFlags())}</span><button class="btn small" data-act="ai">${app.aiFlags() ? 'オフにする' : 'オンにする'}</button></div></div>`;
    if (O.code) {
      const link = `${location.origin}${location.pathname}?table=${O.code}`;
      const humans = O.st ? O.st.seats.filter(x => x.kind === 'human').length : 0;
      body += `<div class="field"><span class="lab">いまの卓</span>
        <div class="on-row"><b>卓 <span class="code">${esc(O.code)}</span>・${humans}人${O.isHost ? '（あなたがホスト）' : ''}</b><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="leave">卓を離れる</button></div>
        <span class="hint">リンクを開いた人は、CPU の席を引き継いで次のハンドから座れます（${esc(link)}）</span></div>`;
    } else {
      body += `<div class="field"><span class="lab">空き席のある卓（${ts.length}）</span><div class="on-list">${ts.length ? ts.map(t => {
        const i = t.info || {};
        const host = t.people.find(p => p.r && p.r.host) || t.people[0];
        return `<div class="on-row"><b>${esc(host ? host.n : '')} の卓 <span class="hint">${t.people.length}人/${i.n || '?'}席・${i.mode === 'cash' ? 'キャッシュ' : 'シットアンドゴー'}${i.bb ? '・BB ' + i.bb : ''}</span></b><span class="hint">${t.people.map(p => aiTxt(p.ai)).filter((x, k, a) => a.indexOf(x) === k).join('・')}</span><button class="btn small primary" data-join="${esc(t.code)}">座る</button></div>`;
      }).join('') : '<p class="hint" style="margin:0">いまオンラインの卓はありません。卓を作ると、ほかの人が座れるようになります（空いた席は CPU）。</p>'}</div><!--note--></div>
      <div class="field"><span class="lab">卓を作る</span>
        ${seg('n', [2, 3, 4, 5, 6].map(n => [n, n + '席']), lobby.n)}
        ${seg('cpu', Object.entries(app.CPU).map(([k, v]) => [k, 'CPU ' + v.label]), lobby.cpu)}
        ${seg('mode', [['sng', 'シットアンドゴー'], ['cash', 'キャッシュ']], lobby.mode)}
        ${seg('stack', [50, 100, 200].map(n => [n, n + 'BB']), lobby.stack)}
        <div><button class="btn primary" data-act="create"${st === 'on' ? '' : ' disabled'}>卓を作る</button></div></div>`;
    }
    const note = `<p class="hint on-note" style="margin:6px 0 0">配り方: 全員が暗号の鍵を出し合って山札を順に混ぜるので、だれも（ホストも）山札を知りません。ハンドの後に全員の鍵で山札を検査します（このため、降りた人の手札もハンドの後には分かります）。公開の中継サーバーを使うので、名前と行動はほかの人からも見える可能性があります。</p>`;
    // 説明は左の列（卓の一覧の下）に
    body = body.replace('<!--note-->', note);
    if (!body.includes('on-note')) body += note;
    $('on-body').innerHTML = body;
  }
  document.addEventListener('click', e => {
    const box = e.target.closest('#on-body');
    if (!box) return;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v != null && b.parentElement.dataset.seg) {
      const k = b.parentElement.dataset.seg;
      lobby[k] = k === 'n' || k === 'stack' ? +b.dataset.v : b.dataset.v;
      app.store.set('lobby', lobby);
      renderLobby();
    } else if (b.dataset.join) { saveName(); O.joining = b.dataset.join; O.lobbyMsg = '卓につないでいます…'; renderLobby(); tryJoin(); }
    else if (b.dataset.act === 'create') { saveName(); createTable(); }
    else if (b.dataset.act === 'leave') leave(false);
    else if (b.dataset.act === 'copy') { const link = `${location.origin}${location.pathname}?table=${O.code}`; navigator.clipboard && navigator.clipboard.writeText(link).then(() => { O.lobbyMsg = '招待リンクをコピーしました'; renderLobby(); }); }
    else if (b.dataset.act === 'ai') { const on = !app.aiFlags(); app.settings.eq = on; app.settings.rec = on; app.store.set('settings', app.settings); if (NET) NET.setAI(app.aiFlags()); ctl({ t: 'ai', ai: app.aiFlags() }); app.render(); renderLobby(); }
  });
  document.addEventListener('change', e => { if (e.target.id === 'on-name') saveName(); });
  function saveName() {
    const el = $('on-name');
    if (!el) return;
    myName = (el.value || '').trim().slice(0, 12) || myName;
    app.store.set('name', myName);
    if (NET) NET.setName(myName);
  }

  // ------------------------------------------------------------------ 部屋につなぐ
  function enterRoom(code) {
    if (O.room) leaveRoom();
    O.code = code;
    O.room = NET.room('hd-' + code);
    O.room.sub('state', onStateMsg);
    O.room.sub('ctl', onCtl);
    O.room.sub('act', onAct);
    O.room.sub('mp', onMp);
    sess.set('online', { code, t: Date.now() });
    // 手元の卓を止めて、オンラインの卓を表示
    app.bumpEpoch();
    app.T.online = true;
    app.S = null;
    app.resetHand();
    disp.handNo = -1;
    $('dlg-result').hidden = true;
  }
  function leaveRoom() {
    if (!O.room) return;
    for (const s of ['state', 'ctl', 'act', 'mp']) O.room.unsub(s);
    O.room = null;
  }
  function tryJoin() {
    if (!O.joining || !NET || NET.status !== 'on') return;
    const code = O.joining;
    O.joining = null;
    enterRoom(code);
    O.isHost = false;
    O.lastStateAt = 0;
    ctl({ t: 'join', name: myName, ai: app.aiFlags(), hints: app.myHints() });
    // 状態が来なければ、その卓はもうない
    setTimeout(() => {
      if (O.code === code && !O.st) { O.lobbyMsg = `卓 ${code} は見つかりませんでした（もう閉じたかもしれません）`; leave(true); open(); }
    }, 9000);
    renderLobby();
  }
  function createTable() {
    const code = code5();
    enterRoom(code);
    O.isHost = true;
    const n = lobby.n, stack = lobby.stack * 20;
    const names = app.NAMES.slice().sort(() => Math.random() - 0.5);
    const seats = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) seats.push({ kind: 'human', pid: PID, name: myName, stack, ai: app.aiFlags(), hints: 0, av: myName.slice(0, 1) });
      else seats.push({ kind: 'cpu', name: names[i - 1][1], av: names[i - 1][0], level: lobby.cpu, stack });
    }
    O.st = { v: 1, code, host: PID, rev: 0, cfg: { n, cpu: lobby.cpu, mode: lobby.mode, stack }, seats, button: Math.floor(Math.random() * n), level: 0, handNo: 0, hand: null, msg: '' };
    hostInit();
    $('dlg-online').hidden = true;
    O.lobbyMsg = '';
    hostPublish();
    setTimeout(() => hostNextHand(), 1200);
  }
  function leave(quiet) {
    if (!O.code) return;
    ctl({ t: 'leave' });
    if (O.isHost && O.st) {
      // 次の人にホストを渡す（いなければ卓を閉じる）
      const next = O.st.seats.find(x => x.kind === 'human' && x.pid !== PID && !x.gone);
      const seat = O.st.seats.find(x => x.pid === PID);
      if (seat) { seat.kind = 'cpu'; seat.level = O.st.cfg.cpu; seat.name = seat.name + '（CPU）'; delete seat.pid; }
      if (next) { O.st.host = next.pid; O.st.hand = null; O.st.msg = 'ホストが交代しました'; hostPublish(); }
      else O.room.pub('state', null, { retain: true }); // 保持していた状態を消す
    }
    clearTimers();
    leaveRoom();
    O.code = null; O.st = null; O.isHost = false;
    sess.set('online', null);
    if (NET) NET.setPresence({ s: 'idle', c: '', m: '', r: null, rl: '' });
    app.T.online = false;
    app.clearHumanWait();
    badge();
    if (!quiet) { renderLobby(); app.newLocalGame(); }
  }
  const ctl = body => { if (O.room) O.room.pub('ctl', Object.assign({ pid: PID }, body)); if (O.isHost) hostCtl(Object.assign({ pid: PID, from: NET.id }, body)); };
  const sendMp = body => { const m = Object.assign({ pid: PID, from: NET.id }, body); if (O.room) O.room.pub('mp', Object.assign({ pid: PID }, body)); if (O.isHost) hostMp(m); partMp(m); };

  // ------------------------------------------------------------------ 受け取り
  function onStateMsg(st) {
    if (!st) { if (O.code && !O.isHost) { O.lobbyMsg = '卓が閉じられました'; leave(true); open(); } return; }
    if (typeof st !== 'object' || !Array.isArray(st.seats) || st.code !== O.code) return;
    if (O.isHost && st.host === PID) return; // 自分の出したもの
    if (O.st && st.rev < O.st.rev && st.host === O.st.host) return;
    O.st = sanitizeState(st);
    O.lastStateAt = Date.now();
    // ホストを渡された
    if (st.host === PID && !O.isHost) { O.isHost = true; hostInit(); hostTakeOver(); }
    if (st.host !== PID && O.isHost) { O.isHost = false; clearTimers(); }
    onState();
  }
  function onCtl(m) {
    if (!m || m.from === NET.id) return;
    if (O.st && m.pid === O.st.host) O.hostSeen = Date.now();
    if (O.isHost) hostCtl(m);
  }
  function onAct(m) { if (!m || m.from === NET.id) return; if (O.isHost) hostAct(m); }
  function onMp(m) { if (!m || m.from === NET.id) return; if (O.isHost) hostMp(m); partMp(m); }
  // ネットから来た状態の名前などを丸める
  function sanitizeState(st) {
    st.seats = st.seats.slice(0, 6).map(x => ({
      kind: x.kind === 'human' ? 'human' : 'cpu', pid: typeof x.pid === 'string' ? x.pid.slice(0, 20) : undefined,
      name: String(x.name || '').slice(0, 14), av: String(x.av || '').slice(0, 2), level: app.CPU[x.level] ? x.level : 'strong',
      stack: Math.max(0, +x.stack | 0), ai: x.ai | 0, hints: x.hints | 0, away: !!x.away, out: !!x.out, place: x.place | 0, gone: !!x.gone, pending: x.pending ? { pid: String(x.pending.pid).slice(0, 20), name: String(x.pending.name || '').slice(0, 14) } : null,
    }));
    return st;
  }

  // ------------------------------------------------------------------ 表示（ホストも含めて全員）
  const disp = { handNo: -1, applied: 0, busy: false, again: false, finished: -1 };
  function onState() {
    const st = O.st;
    if (!st) return;
    // 在席の情報
    const humans = st.seats.filter(x => x.kind === 'human').length;
    const joinable = st.seats.some(x => x.kind === 'cpu' && !x.pending);
    if (NET) NET.setPresence({ s: joinable ? 'wait' : 'play', c: st.code, m: st.code, r: { n: st.seats.length, h: humans, mode: st.cfg.mode, bb: st.hand ? st.hand.bb : 20, host: O.isHost ? 1 : 0 }, rl: `${humans}/${st.seats.length}人` });
    badge();
    renderLobby();
    partOnState(st);
    syncDisplay();
  }
  // 卓の席を画面用に
  function seatsForApp(st) {
    return st.seats.map(x => ({
      name: x.name, av: x.av || x.name.slice(0, 1), kind: x.kind === 'human' ? (x.pid === PID ? 'me' : 'remote') : 'cpu',
      level: x.level, stack: x.stack, out: x.out, place: x.place, away: x.away || x.gone, ai: x.ai, hints: x.hints,
    }));
  }
  // 公開の状態に合わせて、手元のエンジンを1手ずつ進めながら演出する
  async function syncDisplay() {
    if (disp.busy) { disp.again = true; return; }
    disp.busy = true;
    try {
      do {
        disp.again = false;
        await syncOnce();
      } while (disp.again && O.st);
    } catch (e) { if (!e || !e.cancel) console.error(e); }
    disp.busy = false;
  }
  async function syncOnce() {
    const st = O.st, T = app.T, D = app.D;
    if (!st) return;
    T.online = true;
    T.seats = seatsForApp(st);
    const mine = st.seats.findIndex(x => x.pid === PID);
    T.mySeat = mine >= 0 ? mine : 0;
    T.button = st.button; T.handNo = st.handNo;
    T.mode = st.cfg.mode;
    const hand = st.hand;
    // 前のハンドの終わりを見逃していたら（画面が裏にあったときなど）、演出なしで済ませて履歴に残す
    if (hand && disp.handNo >= 0 && disp.handNo !== hand.no && disp.finished !== disp.handNo && app.S && app.S.online && st.prev && st.prev.no === disp.handNo) quickFinish(st.prev);
    const before = !hand || hand.phase === 'keys' || hand.phase === 'shuffle' || hand.phase === 'deal' || (hand.phase === 'void' && disp.handNo !== hand.no);
    if (before) {
      // 配る前（または配る前に無効になったハンド）
      if (!hand || disp.handNo !== hand.no) { app.S = null; app.resetHand(); }
      T.onlineStatus = st.msg ? esc(st.msg) : !hand ? '次のハンドを待っています…' : hand.phase === 'void' ? `#${hand.no} は無効になりました（${esc(hand.voidWhy || '')}）` : hand.phase === 'keys' ? `#${hand.no} 鍵を出し合っています…` : hand.phase === 'shuffle' ? `#${hand.no} 山札を順に混ぜています（${hand.stage + 1}/${hand.parts.length}人目）` : `#${hand.no} 手札を配っています…`;
      T.deadline = 0;
      app.render();
      return;
    }
    const meSeat = st.seats.find(x => x.pid === PID);
    T.onlineStatus = meSeat && meSeat.away ? '離席中です（CPU が代わりに降ります）。画面に触れると席に戻ります' : '';
    // 残り時間はホストとの時計のずれを避けて、受け取った時刻から数える
    T.deadline = hand.deadline ? Date.now() + Math.max(0, hand.deadline - (st.t || Date.now())) : 0;
    // 新しいハンド（前のハンドの終わりを見逃していたら、演出なしで済ませて履歴に残す）
    if (disp.handNo !== hand.no) {
      app.resetHand();
      const s = H.newHand({ stacks: hand.start, button: 0, sb: hand.sb, bb: hand.bb });
      const p = hand.map.indexOf(mine);
      const holes = hand.map.map(() => null);
      if (p >= 0 && part.myHole && part.handNo === hand.no) holes[p] = part.myHole;
      H.dealHole(s, holes);
      app.S = { s, map: hand.map.slice(), deck: null, rec: { no: hand.no, map: hand.map.slice(), names: hand.map.map(i => st.seats[i].name), mySeat: T.mySeat, button: 0, sb: hand.sb, bb: hand.bb, start: hand.start.slice(), holes: holes.map(h => h && h.slice()), board: [], acts: [], result: null, net: 0, t: Date.now() }, online: true };
      D.bets = s.bet.slice();
      for (const q of [s.sbSeat, s.bbSeat]) { const e = s.log.find(x => x.p === q && (x.t === 'sb' || x.t === 'bb')); if (e) D.tags[hand.map[q]] = { cls: '', text: `${e.t.toUpperCase()} ${app.fmt(e.amt, hand.bb)}` }; }
      disp.handNo = hand.no; disp.applied = 0; disp.finished = -1;
      T.bb = hand.bb; T.sb = hand.sb;
      await app.animDeal();
    }
    const S = app.S, s = S.s;
    // 自分の手札が後から開いた
    const myP = hand.map.indexOf(mine);
    if (myP >= 0 && !s.hole[myP] && part.myHole && part.handNo === hand.no) { s.hole[myP] = part.myHole; S.rec.holes[myP] = part.myHole.slice(); }
    // 行動と場のカードを順に
    for (let guard = 0; guard < 200; guard++) {
      if (s.phase === 'bet' && disp.applied < hand.acts.length) {
        const x = hand.acts[disp.applied];
        if (x.p !== s.toAct) { console.warn('行動の順番が合いません'); disp.applied = hand.acts.length; break; }
        await applyShown(x);
        disp.applied++;
      } else if (s.phase === 'deal' && hand.board.length > s.board.length) {
        await endRoundShown();
        const before = s.board.length;
        H.deal(s, hand.board.slice(before, before + s.need));
        S.rec.board = s.board.slice();
        D.street = s.street;
        D.tags = app.keepTags();
        await app.animBoard(s.board.length - before);
      } else if (s.phase === 'show' && hand.revealed && s.contenders.every(q => hand.revealed[q])) {
        await endRoundShown();
        const holes = s.hole.map((h, q) => hand.revealed[q] || h);
        H.show(s, holes);
        for (const q of s.result.contenders) { D.revealed[q] = true; D.tags[hand.map[q]] = { cls: '', text: H.handName(s.result.values[q]), pop: true }; }
        app.SFX.flip();
        app.render();
        await app.sleep(700);
      } else break;
    }
    // ハンドの途中で無効になった
    if (hand.phase === 'void' && s.phase !== 'done' && disp.finished !== hand.no) {
      disp.finished = hand.no;
      D.banner = `このハンドは無効（${hand.voidWhy || ''}）`;
      D.lastLine = esc(D.banner);
    }
    // ハンドの終わり（検査が済んだら）
    if (s.phase === 'done' && disp.finished !== hand.no && (hand.phase === 'done' || hand.phase === 'void')) {
      disp.finished = hand.no;
      await endRoundShown();
      await finishShown(hand);
    }
    // 自分の番
    const myTurn = hand.phase === 'bet' && s.phase === 'bet' && myP >= 0 && s.toAct === myP && hand.toAct === myP && disp.applied === hand.acts.length;
    if (myTurn) {
      const k = hand.acts.length, no = hand.no;
      app.setHumanWait(a => { app.clearHumanWait(); O.room.pub('act', { pid: PID, no, k, a }); if (O.isHost) hostAct({ pid: PID, from: NET.id, no, k, a }); });
      app.SFX.turn();
    } else app.clearHumanWait();
    app.render();
  }
  async function applyShown(x) {
    const S = app.S, s = S.s, D = app.D, i = S.map[x.p];
    const before = s.bet[x.p], street = s.street;
    H.act(s, x.a);
    const e = [...s.log].reverse().find(y => y.p === x.p && ['f', 'x', 'c', 'b', 'r'].includes(y.t));
    S.rec.acts.push({ p: x.p, a: x.a });
    const txt = H.actionText(e, v => app.fmt(v));
    D.lastLine = `${esc(app.T.seats[i].name)}: ${esc(txt)}`;
    const cls = e.t === 'f' ? 'f' : e.allin ? 'a' : e.t === 'r' ? 'r' : e.t === 'b' ? 'b' : '';
    D.tags[i] = { cls, text: e.allin ? 'オールイン' : e.t === 'f' ? 'フォールド' : e.t === 'x' ? 'チェック' : e.t === 'c' ? 'コール' : e.t === 'b' ? `ベット ${app.fmt(e.to)}` : `レイズ ${app.fmt(e.to)}`, pop: true };
    if (e.t === 'f') app.SFX.fold(); else if (e.t === 'x') app.SFX.check();
    const put = (street === s.street ? s.bet[x.p] : (e.to || before + (e.amt || 0))) - before;
    if (put > 0) { await app.animBet(i, put); D.bets[x.p] = before + put; }
    app.render();
    await app.sleep(120);
  }
  async function endRoundShown() {
    const S = app.S, s = S.s, D = app.D;
    for (const e of s.log.slice(S.logSeen || 0)) if (e.t === 'return') D.bets[e.p] = Math.max(0, (D.bets[e.p] || 0) - e.amt);
    S.logSeen = s.log.length;
    await app.animCollect();
  }
  async function finishShown(hand) {
    const S = app.S, s = S.s, D = app.D, T = app.T, res = s.result;
    if (!res) return;
    if (hand.phase === 'void') {
      D.banner = `このハンドは無効（${hand.voidWhy || '検査できませんでした'}）`;
      D.lastLine = esc(D.banner);
      app.render();
      return;
    }
    if (!res.byFold) {
      let best = -1;
      for (const q of res.contenders) if (res.won[q] > 0 && res.values[q] > best) best = res.values[q];
      const wp = res.contenders.find(q => res.values[q] === best);
      D.winCards = new Set(H.bestFive(s.hole[wp].concat(s.board)));
    }
    const winners = [];
    for (let q = 0; q < s.n; q++) if (res.won[q] > 0) winners.push(q);
    for (const q of winners) D.tags[S.map[q]] = { cls: 'w', text: `+${app.fmt(res.won[q])}`, pop: true };
    D.banner = `${winners.map(q => T.seats[S.map[q]].name).join('・')} の勝ち${res.byFold ? '' : `（${H.handLabel(res.values[winners[0]])}）`}`;
    const me = S.map.indexOf(T.mySeat), mine = O.st.seats[T.mySeat] && O.st.seats[T.mySeat].pid === PID;
    const myNet = me >= 0 && mine ? res.net[me] : 0;
    D.lastLine = (me >= 0 && mine ? (myNet > 0 ? `あなたの勝ち <b>+${app.fmt(myNet)}</b>　` : myNet < 0 ? `このハンドは ${app.fmt(myNet)}　` : '') : '') + esc(D.banner) + (hand.verified ? '　<small>（山札の検査 OK）</small>' : '');
    await app.animAward();
    if (myNet > 0) app.SFX.win();
    recordHand(hand, myNet);
    app.render();
  }
  function quickFinish(hand) {
    const S = app.S, s = S.s;
    try {
      for (let guard = 0; guard < 300; guard++) {
        if (s.phase === 'bet' && disp.applied < hand.acts.length) { H.act(s, hand.acts[disp.applied].a); S.rec.acts.push(hand.acts[disp.applied]); disp.applied++; }
        else if (s.phase === 'deal' && hand.board.length > s.board.length) H.deal(s, hand.board.slice(s.board.length, s.board.length + s.need));
        else if (s.phase === 'show' && hand.revealed && s.contenders.every(q => hand.revealed[q])) H.show(s, s.hole.map((h, q) => hand.revealed[q] || h));
        else break;
      }
    } catch (e) { return; }
    disp.finished = hand.no;
    if (s.phase !== 'done' || hand.phase !== 'done' || !s.result) return;
    const res = s.result, T = app.T;
    const winners = [];
    for (let q = 0; q < s.n; q++) if (res.won[q] > 0) winners.push(q);
    app.D.banner = '';
    S.rec.desc = `${winners.map(q => T.seats[S.map[q]] ? T.seats[S.map[q]].name : '').join('・')} の勝ち${res.byFold ? '' : `（${H.handLabel(res.values[winners[0]])}）`}`;
    const me = S.map.indexOf(T.mySeat), mine = O.st.seats[T.mySeat] && O.st.seats[T.mySeat].pid === PID;
    recordHand(hand, me >= 0 && mine ? res.net[me] : 0, true);
  }
  function recordHand(hand, myNet, quiet) {
    const S = app.S, s = S.s, D = app.D, T = app.T, res = s.result;
    const me = S.map.indexOf(T.mySeat), mine = O.st.seats[T.mySeat] && O.st.seats[T.mySeat].pid === PID;
    S.rec.result = { won: res.won, net: res.net, values: res.values, contenders: res.contenders, byFold: res.byFold };
    S.rec.board = s.board.slice();
    S.rec.net = myNet;
    S.rec.myHole = me >= 0 && mine ? s.hole[me] : null;
    if (!quiet) S.rec.desc = D.banner;
    // 見返し用に、検査で分かった全員の手札も入れる
    if (part.audit && part.audit.no === hand.no) S.rec.holes = hand.map.map((_, q) => [part.audit.cards[q], part.audit.cards[q + hand.map.length]]);
    else S.rec.holes = s.hole.map(h => (h ? h.slice() : null));
    app.pushHistory(S.rec);
  }

  // ------------------------------------------------------------------ 参加者（全員）: 鍵・混ぜる・部分の鍵・検査
  let part = { handNo: -1 };
  // ハンドごとの秘密の鍵。再読み込みしても同じハンドに戻れるよう、このタブに覚えておく
  function resetPart(no) {
    let k = null;
    const saved = sess.get('mpkey', null);
    if (saved && saved.no === no && saved.code === O.code) { try { const x = M.fromB64(saved.x); k = { x, h: M.gExp(x) }; } catch (e) { k = null; } }
    const restored = !!k;
    if (!k) { k = M.keygen(); sess.set('mpkey', { no, code: O.code, x: M.toB64(k.x) }); }
    part = { handNo: no, k, decks: {}, wires: {}, shares: {}, sent: {}, myHole: null, audit: null, restored };
  }
  function partOnState(st) {
    const hand = st.hand;
    if (!hand || !Array.isArray(hand.parts) || !hand.parts.includes(PID)) return;
    if (part.handNo !== hand.no) resetPart(hand.no);
    const n = hand.map.length, me = PID;
    // 再読み込みで戻ってきたら、見逃した混ぜた山札と、自分の手札の部分の鍵を出し直してもらう
    if (part.restored && !part.sent.resync && hand.phase !== 'keys') {
      part.sent.resync = 1;
      const mine = st.seats.findIndex(x => x.pid === PID), p = hand.map.indexOf(mine);
      sendMp({ t: 'need', no: hand.no, i: hand.parts.length - 1 });
      if (p >= 0) sendMp({ t: 'needShares', no: hand.no, pos: [p, p + n] });
    }
    if (hand.phase === 'keys' && !part.sent.key) { part.sent.key = 1; sendMp({ t: 'key', no: hand.no, h: M.toB64(part.k.h) }); }
    if (hand.phase === 'shuffle' && hand.parts[hand.stage] === me && part.sent.stage !== hand.stage) {
      const prev = hand.stage === 0 ? M.initialDeck() : part.decks[hand.stage - 1];
      if (!prev) { sendMp({ t: 'need', no: hand.no, i: hand.stage - 1 }); return; }
      part.sent.stage = hand.stage;
      const Hk = M.jointKey(hand.parts.map(id => M.fromB64(hand.keys[id])));
      setTimeout(() => {
        const d = M.reshuffle(prev, Hk);
        sendMp({ t: 'stage', no: hand.no, i: hand.stage, deck: M.deckToWire(d) });
      }, 30);
    }
    const final = part.decks[hand.parts.length - 1];
    const past = ['deal', 'bet', 'board', 'show', 'audit', 'done', 'void'].includes(hand.phase);
    if (past && !final) { if (!part.sent.needFinal) { part.sent.needFinal = 1; sendMp({ t: 'need', no: hand.no, i: hand.parts.length - 1 }); } return; }
    if (past && !part.sent.hole) {
      // ほかの人の手札の位置に、自分の部分の鍵を出す
      const pos = [];
      for (let p = 0; p < n; p++) if (hand.owners[p] !== me) pos.push(p, p + n);
      part.sent.hole = 1;
      sendShares('hole', pos, hand);
    }
    if (hand.phase === 'board' && Array.isArray(hand.need)) {
      const key = 'b' + hand.need.join(',');
      if (!part.sent[key]) { part.sent[key] = 1; sendShares('board', hand.need, hand); }
    }
    if (hand.phase === 'show' && Array.isArray(hand.contenders) && !part.sent.show) {
      const pos = [];
      for (const p of hand.contenders) if (hand.owners[p] === me) pos.push(p, p + n);
      part.sent.show = 1;
      if (pos.length) sendShares('show', pos, hand);
    }
    if ((hand.phase === 'audit' || hand.phase === 'done') && !part.sent.reveal) { part.sent.reveal = 1; sendMp({ t: 'reveal', no: hand.no, x: M.toB64(part.k.x) }); }
    tryOpenMine(hand);
    if ((hand.phase === 'done' || hand.phase === 'void') && hand.xs && !part.audit) {
      try {
        const xs = hand.parts.map(id => M.fromB64(hand.xs[id]));
        const r = M.audit(final, xs);
        if (r.ok) part.audit = { no: hand.no, cards: r.cards };
      } catch (e) { /* 検査できない */ }
    }
  }
  function sendShares(ph, pos, hand) {
    const final = part.decks[hand.parts.length - 1];
    const s = pos.map(k => M.toB64(M.share(final[k][0], part.k.x)));
    sendMp({ t: 'share', no: hand.no, ph, pos, s });
  }
  function partMp(m) {
    const st = O.st, hand = st && st.hand;
    if (!hand || m.no !== hand.no || part.handNo !== hand.no) return;
    try {
      if (m.t === 'stage' && hand.parts[m.i] === m.pid) {
        part.wires[m.i] = m.deck;
        part.decks[m.i] = M.deckFromWire(m.deck);
        partOnState(st);
      } else if (m.t === 'share' && Array.isArray(m.pos) && Array.isArray(m.s) && hand.parts.includes(m.pid)) {
        for (let j = 0; j < m.pos.length && j < 60; j++) {
          const k = m.pos[j] | 0;
          (part.shares[k] || (part.shares[k] = {}))[m.pid] = M.fromB64(m.s[j]);
        }
        tryOpenMine(hand);
      }
    } catch (e) { console.warn('メンタルポーカーの連絡を読めません', e); }
  }
  // 自分の手札を開く（ほかの全員の部分の鍵がそろったら）
  function tryOpenMine(hand) {
    if (part.myHole) return;
    const final = part.decks[hand.parts.length - 1];
    if (!final) return;
    const mine = O.st.seats.findIndex(x => x.pid === PID);
    const p = hand.map.indexOf(mine), n = hand.map.length;
    if (p < 0 || hand.owners[p] !== PID) return;
    const cards = [];
    for (const k of [p, p + n]) {
      const got = part.shares[k] || {};
      const others = hand.parts.filter(id => id !== PID);
      if (!others.every(id => got[id])) return;
      const c = M.open(final[k], others.map(id => got[id]).concat([M.share(final[k][0], part.k.x)]));
      if (c < 0) { sendMp({ t: 'bad', no: hand.no, k }); return; }
      cards.push(c);
    }
    part.myHole = cards;
    syncDisplay();
  }

  // ------------------------------------------------------------------ ホスト: 卓の進行
  let HS = null; // ホストだけが持つ: { s: エンジン, decks, wires, shares, cpuHole, xs, timers }
  function hostInit() { HS = { s: null, decks: {}, wires: {}, shares: {}, cpuHole: {}, xs: {}, sent: {}, seen: {}, timer: 0, cpuTimer: 0 }; }
  // ホストの進行のタイマー（画面が裏にあっても止まりにくいよう、ワーカーで数える）
  const later = (fn, ms) => app.wTimeout(fn, ms);
  const stop = h => { if (typeof h === 'function') h(); };
  function clearTimers() { if (HS) { stop(HS.timer); stop(HS.cpuTimer); stop(HS.nextTimer); } }
  function hostPublish() {
    if (!O.isHost || !O.st) return;
    O.st.rev = (O.st.rev || 0) + 1;
    O.st.t = Date.now();
    if (O.room) O.room.pub('state', O.st, { retain: true });
    onState();
  }
  // ホストを引き継いだ: 途中のハンドは無効にして次へ（チップはハンドの前のまま）
  function hostTakeOver() {
    const st = O.st;
    if (st.hand && st.hand.phase !== 'done' && st.hand.phase !== 'void') { st.hand = null; st.msg = 'ホストが交代しました。次のハンドから続けます'; }
    hostPublish();
    clearTimers();
    HS.nextTimer = later(hostNextHand, 1500);
  }
  function present(seat) { return seat.kind === 'human' && !seat.gone && (seat.pid === PID || (HS.seen[seat.pid] && Date.now() - HS.seen[seat.pid] < 25000)); }
  function hostNextHand() {
    const st = O.st;
    if (!O.isHost || !st) return;
    clearTimers();
    st.msg = '';
    // 引き継ぎ待ちの人を座らせる（その席のチップがなくなっていたら、チップのある別の CPU の席へ）・いなくなった人を離席に
    for (const x of st.seats) {
      if (!x.pending) continue;
      let seat = x;
      if (seat.stack <= 0 && st.cfg.mode === 'sng') seat = st.seats.find(y => y.kind === 'cpu' && !y.pending && y.stack > 0) || null;
      const pd = x.pending;
      x.pending = null;
      if (!seat || seat.kind !== 'cpu') continue;
      if (seat.stack <= 0) seat.stack = st.cfg.stack;
      Object.assign(seat, { kind: 'human', pid: pd.pid, name: pd.name, av: pd.name.slice(0, 1), ai: pd.ai | 0, hints: 0, away: false, gone: false, out: false, place: 0 });
    }
    for (const x of st.seats) if (x.kind === 'human' && x.pid !== PID && !present(x)) x.away = true;
    // キャッシュでは CPU（と飛んだ人）のチップを補充
    if (st.cfg.mode === 'cash') for (const x of st.seats) if (x.stack < 20 * 10) { if (x.kind === 'cpu') x.stack = st.cfg.stack; else if (x.stack <= 0) x.stack = st.cfg.stack; }
    const alive = st.seats.filter(x => x.stack > 0);
    if (alive.length < 2) {
      // シットアンドゴーの終わり: 少し待って全員のチップを戻してもう一度
      const w = alive[0];
      st.msg = `${w ? w.name : ''} の優勝！ もう一度始めます`;
      if (w) w.place = 1;
      hostPublish();
      HS.nextTimer = later(() => { for (const x of st.seats) { x.stack = st.cfg.stack; x.out = false; x.place = 0; } st.handNo = 0; st.level = 0; hostNextHand(); }, 8000);
      return;
    }
    // 前のハンド（表示が遅れていた人が履歴に残せるように）
    st.prev = st.hand && (st.hand.phase === 'done' || st.hand.phase === 'void') ? st.hand : null;
    st.handNo++;
    if (st.cfg.mode === 'sng') st.level = Math.floor((st.handNo - 1) / 10);
    const lv = st.cfg.mode === 'sng' ? H.BLIND_LEVELS[Math.min(st.level, H.BLIND_LEVELS.length - 1)] : [10, 20];
    const stacks = st.seats.map(x => x.stack);
    st.button = H.nextButton(stacks, st.button);
    const n = st.seats.length;
    const map = [];
    for (let j = 0; j < n; j++) { const i = (st.button + j) % n; if (stacks[i] > 0) map.push(i); }
    // 参加者: いまつながっている人（ホストは必ず）。それ以外の席の手札はホストが開く
    const parts = [PID];
    for (const i of map) { const x = st.seats[i]; if (x.kind === 'human' && x.pid !== PID && present(x) && !parts.includes(x.pid)) parts.push(x.pid); }
    const owners = map.map(i => { const x = st.seats[i]; return x.kind === 'human' && parts.includes(x.pid) ? x.pid : PID; });
    const s = H.newHand({ stacks: map.map(i => st.seats[i].stack), button: 0, sb: lv[0], bb: lv[1] });
    HS.s = s; HS.decks = {}; HS.wires = {}; HS.shares = {}; HS.cpuHole = {}; HS.xs = {}; HS.sent = {};
    st.hand = { no: st.handNo, map, start: s.start.slice(), sb: lv[0], bb: lv[1], acts: [], board: [], phase: 'keys', parts, owners, keys: {}, stage: 0, toAct: -1, deadline: 0, revealed: {}, need: null, contenders: null, xs: null };
    hostPublish();
    phaseTimer();
  }
  // 段階ごとの時間切れ（応答しない人がいたらハンドを無効にして、その人を離席に）
  function phaseTimer() {
    stop(HS.timer);
    const hand = O.st.hand;
    if (!hand) return;
    const ph = hand.phase, no = hand.no;
    if (ph === 'bet' || ph === 'done' || ph === 'void') return;
    HS.timer = later(() => {
      const h2 = O.st && O.st.hand;
      if (!h2 || h2.no !== no || h2.phase !== ph) return;
      const late = lateParts(h2);
      for (const pid of late) { const x = O.st.seats.find(y => y.pid === pid); if (x) x.away = true; }
      voidHand(`応答がない人がいました（${late.map(pid => (O.st.seats.find(y => y.pid === pid) || {}).name).join('・') || '?'}）`);
    }, PHASE_MS);
  }
  function lateParts(hand) {
    if (hand.phase === 'keys') return hand.parts.filter(id => !hand.keys[id]);
    if (hand.phase === 'shuffle') return [hand.parts[hand.stage]];
    if (hand.phase === 'deal') return hand.parts.filter(id => !HS.sent['hole:' + id]);
    if (hand.phase === 'board') return hand.parts.filter(id => !hand.need.every(k => HS.shares[k] && HS.shares[k][id]));
    if (hand.phase === 'show') return hand.contenders.map(p => hand.owners[p]).filter(id => !hand.contenders.every(p => hand.owners[p] !== id || (HS.shares[p] && HS.shares[p][id])));
    if (hand.phase === 'audit') return hand.parts.filter(id => !HS.xs[id]);
    return [];
  }
  function voidHand(why) {
    const hand = O.st.hand;
    if (!hand) return;
    hand.phase = 'void'; hand.voidWhy = why;
    O.st.msg = '';
    hostPublish();
    stop(HS.timer); stop(HS.cpuTimer);
    HS.nextTimer = later(hostNextHand, NEXT_MS);
  }
  function hostCtl(m) {
    const st = O.st;
    if (!st || typeof m.pid !== 'string') return;
    HS.seen[m.pid] = Date.now();
    const seat = st.seats.find(x => x.pid === m.pid);
    if (m.t === 'join') {
      const name = String(m.name || 'ゲスト').slice(0, 12);
      if (seat) { seat.name = name; seat.ai = m.ai | 0; seat.away = false; seat.gone = false; hostPublish(); return; }
      if (st.seats.some(x => x.pending && x.pending.pid === m.pid)) return;
      // CPU の席を引き継ぐ（チップのある席を優先）
      const cands = st.seats.map((x, i) => ({ x, i })).filter(o => o.x.kind === 'cpu' && !o.x.pending).sort((a, b) => (b.x.stack > 0) - (a.x.stack > 0));
      if (!cands.length) return; // 満席: 観戦
      cands[0].x.pending = { pid: m.pid, name, ai: m.ai | 0 };
      st.msg = `${name} が次のハンドから座ります`;
      hostPublish();
      if (!st.hand || st.hand.phase === 'done' || st.hand.phase === 'void') { stop(HS.nextTimer); HS.nextTimer = later(hostNextHand, 1500); }
    } else if (m.t === 'leave') {
      if (seat) { seat.gone = true; seat.away = true; seat.kind = 'cpu'; seat.level = st.cfg.cpu; seat.name = seat.name + '（CPU）'; delete seat.pid; hostPublish(); }
      for (const x of st.seats) if (x.pending && x.pending.pid === m.pid) x.pending = null;
    } else if (m.t === 'ai') { if (seat) { seat.ai = m.ai | 0; hostPublish(); } }
    else if (m.t === 'hint') { if (seat) { seat.hints = (seat.hints | 0) + 1; hostPublish(); } }
    else if (m.t === 'away') { if (seat) { seat.away = !!m.on; hostPublish(); } }
    else if (m.t === 'back') { if (seat && seat.away) { seat.away = false; hostPublish(); } }
  }
  function hostAct(m) {
    const st = O.st, hand = st && st.hand, s = HS && HS.s;
    if (!hand || hand.phase !== 'bet' || !s || s.phase !== 'bet' || m.no !== hand.no || (m.k | 0) !== hand.acts.length) return;
    const p = s.toAct, seat = st.seats[hand.map[p]];
    if (!seat || seat.pid !== m.pid) return;
    const a = m.a || {};
    if (!['f', 'c', 'r'].includes(a.t)) return;
    HS.timeouts = HS.timeouts || {};
    HS.timeouts[m.pid] = 0;
    seat.away = false;
    hostApply(p, a.t === 'r' ? { t: 'r', to: +a.to | 0 } : { t: a.t });
  }
  function hostApply(p, a) {
    const st = O.st, hand = st.hand, s = HS.s;
    stop(HS.timer); stop(HS.cpuTimer);
    H.act(s, a);
    const e = [...s.log].reverse().find(y => y.p === p && ['f', 'x', 'c', 'b', 'r'].includes(y.t));
    hand.acts.push({ p, a: e.t === 'f' ? { t: 'f' } : e.t === 'x' || e.t === 'c' ? { t: 'c' } : { t: 'r', to: e.to } });
    hostAdvance();
  }
  // エンジンの場面に合わせて、次に何を待つか決める
  function hostAdvance() {
    const st = O.st, hand = st.hand, s = HS.s;
    const n = hand.map.length;
    if (s.phase === 'bet') {
      hand.phase = 'bet';
      const p = s.toAct, seat = st.seats[hand.map[p]];
      hand.toAct = p;
      const human = seat.kind === 'human' && hand.owners[p] === seat.pid && !seat.away;
      hand.deadline = human ? Date.now() + TURN_MS : 0;
      hostPublish();
      if (human) {
        HS.timer = later(() => {
          if (O.st.hand !== hand || hand.acts.length === undefined || HS.s.toAct !== p || hand.phase !== 'bet') return;
          HS.timeouts = HS.timeouts || {};
          HS.timeouts[seat.pid] = (HS.timeouts[seat.pid] || 0) + 1;
          if (HS.timeouts[seat.pid] >= 2) seat.away = true;
          hostApply(p, H.legal(s).canCheck ? { t: 'c' } : { t: 'f' });
        }, TURN_MS + 800);
      } else {
        // CPU（離席中の人も CPU が代わりに打つ）
        const think = seat.kind === 'cpu' ? 500 + Math.random() * 900 : 600;
        HS.cpuTimer = later(async () => {
          if (O.st.hand !== hand || HS.s.toAct !== p || HS.s.phase !== 'bet') return;
          const hs2 = HS.s;
          if (!hs2.hole[p] && HS.cpuHole[p]) hs2.hole[p] = HS.cpuHole[p];
          let a;
          const k = hand.acts.length;
          if (hs2.hole[p]) a = (await app.decideAsync(hs2, p, seat.kind === 'cpu' ? seat.level : st.cfg.cpu, hostModels(hand))).a;
          else a = H.legal(hs2).canCheck ? { t: 'c' } : { t: 'f' };
          if (O.st.hand !== hand || HS.s !== hs2 || hand.acts.length !== k || hs2.toAct !== p) return;
          hostApply(p, a);
        }, think);
      }
    } else if (s.phase === 'deal') {
      hand.phase = 'board';
      hand.toAct = -1; hand.deadline = 0;
      const k0 = 2 * n + s.board.length;
      hand.need = Array.from({ length: s.need }, (_, j) => k0 + j);
      hostPublish();
      phaseTimer();
      hostCheckBoard();
    } else if (s.phase === 'show') {
      hand.phase = 'show';
      hand.toAct = -1; hand.deadline = 0;
      hand.contenders = s.contenders.slice();
      hostPublish();
      phaseTimer();
      hostCheckShow();
    } else if (s.phase === 'done') {
      hostToAudit();
    }
  }
  function hostToAudit() {
    const hand = O.st.hand;
    hand.phase = 'audit';
    hand.toAct = -1; hand.deadline = 0;
    hostPublish();
    phaseTimer();
    hostCheckAudit();
  }
  function hostMp(m) {
    const st = O.st, hand = st && st.hand;
    if (!hand || m.no !== hand.no || !hand.parts.includes(m.pid)) return;
    HS.seen[m.pid] = Date.now();
    try {
      if (m.t === 'key' && hand.phase === 'keys') {
        M.fromB64(m.h);
        hand.keys[m.pid] = m.h;
        if (hand.parts.every(id => hand.keys[id])) { hand.phase = 'shuffle'; hand.stage = 0; hostPublish(); phaseTimer(); }
      } else if (m.t === 'stage' && hand.phase === 'shuffle' && hand.parts[hand.stage] === m.pid && m.i === hand.stage) {
        HS.decks[m.i] = M.deckFromWire(m.deck);
        HS.wires[m.i] = m.deck;
        hand.stage++;
        if (hand.stage >= hand.parts.length) { hand.phase = 'deal'; }
        hostPublish(); phaseTimer();
        if (hand.phase === 'deal') hostCheckDeal();
      } else if (m.t === 'need' && HS.wires[m.i]) {
        O.room.pub('mp', { pid: hand.parts[m.i], no: hand.no, t: 'stage', i: m.i, deck: HS.wires[m.i] });
      } else if (m.t === 'needShares' && Array.isArray(m.pos)) {
        for (const k of m.pos.slice(0, 4)) {
          const got = HS.shares[k | 0] || {};
          for (const pid in got) O.room.pub('mp', { pid, no: hand.no, t: 'share', ph: 'resend', pos: [k | 0], s: [M.toB64(got[pid])] });
        }
      } else if (m.t === 'share' && Array.isArray(m.pos) && Array.isArray(m.s)) {
        for (let j = 0; j < m.pos.length && j < 60; j++) {
          const k = m.pos[j] | 0;
          (HS.shares[k] || (HS.shares[k] = {}))[m.pid] = M.fromB64(m.s[j]);
        }
        if (m.ph === 'hole') HS.sent['hole:' + m.pid] = 1;
        if (hand.phase === 'deal') hostCheckDeal();
        else if (hand.phase === 'board') hostCheckBoard();
        else if (hand.phase === 'show') hostCheckShow();
      } else if (m.t === 'reveal') {
        const x = M.fromB64(m.x);
        if (M.gExp(x) !== M.fromB64(hand.keys[m.pid])) { voidHand(`${nameOfPid(m.pid)} の鍵が合いません`); return; }
        HS.xs[m.pid] = m.x;
        hostCheckAudit();
      } else if (m.t === 'bad') {
        voidHand(`${nameOfPid(m.pid)} の手札が開けませんでした`);
      }
    } catch (e) { console.warn('ホスト: 連絡を読めません', e); }
  }
  // 人の打ち方の癖（最強の CPU が読みに使う）
  function hostLearn(hand, s) {
    HS.stats = HS.stats || {};
    hand.map.forEach((i, p) => {
      const x = O.st.seats[i];
      if (x.kind !== 'human' || !x.pid) return;
      const h = HS.stats[x.pid] || (HS.stats[x.pid] = { hands: 0, vpip: 0, faced: 0, folded: 0 });
      h.hands++;
      let v = false;
      for (const e of s.log) {
        if (e.p !== p) continue;
        if (e.st === 0 && (e.t === 'c' || e.t === 'r' || e.t === 'b')) v = true;
        if (e.st > 0 && (e.t === 'f' || e.t === 'c' || e.t === 'r')) { h.faced++; if (e.t === 'f') h.folded++; }
      }
      if (v) h.vpip++;
    });
  }
  function hostModels(hand) {
    if (!HS.stats) return null;
    const out = {};
    hand.map.forEach((i, p) => { const x = O.st.seats[i]; const m = x.kind === 'human' && x.pid ? A.opponentModel(HS.stats[x.pid]) : null; if (m) out[p] = m; });
    return out;
  }
  const nameOfPid = pid => (O.st.seats.find(x => x.pid === pid) || {}).name || '?';
  const finalDeck = () => HS.decks[O.st.hand.parts.length - 1];
  // 全員が手札の部分の鍵を出したら、CPU の席の手札を開いて賭けを始める
  function hostCheckDeal() {
    const hand = O.st.hand;
    if (hand.phase !== 'deal' || !finalDeck()) return;
    if (!hand.parts.every(id => HS.sent['hole:' + id])) return;
    const n = hand.map.length, deck = finalDeck();
    for (let p = 0; p < n; p++) {
      if (hand.owners[p] !== PID) continue;
      const cs = [];
      for (const k of [p, p + n]) {
        const got = HS.shares[k] || {};
        const others = hand.parts.filter(id => id !== PID);
        const c = M.open(deck[k], others.map(id => got[id]).concat([M.share(deck[k][0], part.k.x)]));
        if (c < 0) { voidHand('手札が開けませんでした'); return; }
        cs.push(c);
      }
      HS.cpuHole[p] = cs;
      HS.s.hole[p] = cs;
    }
    H.dealHole(HS.s, HS.s.hole.map((h, p) => HS.cpuHole[p] || null));
    hostAdvance();
  }
  function openPositions(pos) {
    const hand = O.st.hand, deck = finalDeck(), out = [];
    for (const k of pos) {
      const got = HS.shares[k] || {};
      if (!hand.parts.every(id => got[id])) return null;
      const c = M.open(deck[k], hand.parts.map(id => got[id]));
      if (c < 0) return -1;
      out.push(c);
    }
    return out;
  }
  function hostCheckBoard() {
    const hand = O.st.hand;
    if (hand.phase !== 'board') return;
    const cs = openPositions(hand.need);
    if (cs === null) return;
    if (cs === -1) { voidHand('場のカードが開けませんでした'); return; }
    stop(HS.timer);
    H.deal(HS.s, cs);
    hand.board = HS.s.board.slice();
    hand.need = null;
    // オールインで賭けがなければ、少し間をあけて次のカードへ
    if (HS.s.phase === 'deal' || (HS.s.phase === 'show')) { hostPublish(); HS.cpuTimer = later(hostAdvance, 900); }
    else hostAdvance();
  }
  function hostCheckShow() {
    const hand = O.st.hand;
    if (hand.phase !== 'show') return;
    const n = hand.map.length;
    const pos = [];
    for (const p of hand.contenders) pos.push(p, p + n);
    const cs = openPositions(pos);
    if (cs === null) return;
    if (cs === -1) { voidHand('ショーダウンの手札が開けませんでした'); return; }
    stop(HS.timer);
    hand.contenders.forEach((p, j) => { hand.revealed[p] = [cs[2 * j], cs[2 * j + 1]]; });
    H.show(HS.s, HS.s.hole.map((h, p) => hand.revealed[p] || h));
    hostToAudit();
  }
  // 検査: 全員の鍵で山札を開き、52枚がそろっていて、場のカードとショーダウンの手札が山札どおりか
  function hostCheckAudit() {
    const st = O.st, hand = st.hand;
    if (hand.phase !== 'audit' || !hand.parts.every(id => HS.xs[id])) return;
    stop(HS.timer);
    const xs = hand.parts.map(id => M.fromB64(HS.xs[id]));
    const r = M.audit(finalDeck(), xs);
    const n = hand.map.length;
    let ok = r.ok;
    if (ok) hand.board.forEach((c, j) => { if (r.cards[2 * n + j] !== c) ok = false; });
    if (ok) for (const p in hand.revealed) { const q = +p; if (hand.revealed[p][0] !== r.cards[q] || hand.revealed[p][1] !== r.cards[q + n]) ok = false; }
    hand.xs = Object.assign({}, HS.xs);
    if (!ok) { voidHand('山札の検査で食い違いが見つかりました'); return; }
    hand.verified = true;
    // チップを確定
    const s = HS.s;
    for (let p = 0; p < n; p++) st.seats[hand.map[p]].stack = s.stack[p];
    if (st.cfg.mode === 'sng') {
      const left = st.seats.filter(x => x.stack > 0).length;
      const busted = hand.map.filter(i => st.seats[i].stack <= 0 && !st.seats[i].out);
      busted.forEach((i, j) => { st.seats[i].out = true; st.seats[i].place = left + busted.length - j; });
    }
    hand.phase = 'done';
    hostLearn(hand, s);
    hostPublish();
    HS.nextTimer = later(hostNextHand, NEXT_MS + (s.result && !s.result.byFold ? 1500 : 0));
  }

  // 離席中に画面に触れたら席に戻る
  function backFromAway() {
    if (!O.code || !O.st) return;
    const seat = O.st.seats.find(x => x.pid === PID);
    if (!seat || !seat.away) return;
    seat.away = false;
    ctl({ t: 'back' });
  }
  document.addEventListener('pointerdown', backFromAway, true);
  document.addEventListener('keydown', backFromAway, true);

  // ------------------------------------------------------------------ 毎秒: 生きている合図・ホストの見張り・残り時間
  function tick() {
    if (!O.code || !NET || NET.status !== 'on') return;
    if (Date.now() - O.beat > 8000) { O.beat = Date.now(); if (O.room) O.room.pub('ctl', { pid: PID, t: 'beat' }); if (O.isHost) HS.seen[PID] = Date.now(); }
    // ホストが黙ったら、席順で次の人が引き継ぐ
    if (!O.isHost && O.st && Date.now() - Math.max(O.lastStateAt, O.hostSeen || 0) > 30000) {
      const humans = O.st.seats.filter(x => x.kind === 'human' && x.pid !== O.st.host && !x.gone && !x.away);
      if (humans.length && humans[0].pid === PID) { O.isHost = true; hostInit(); O.st.host = PID; hostTakeOver(); }
    }
    if (app.T.online && app.T.deadline) app.render();
  }
})();
