/* オンラインの卓（2〜4人。空いた席は CPU）。common/online.js の汎用の部屋（room）を使う
 *
 * 部屋 r/bk-<卓のコード>/…:
 *   state（保持）… 卓の状態。ホスト（卓を作った人。いなくなったら席の順で次の人）だけが出す
 *                  { v, code, host, ep（ホストの代）, seq, mode, cpu, seats: [{k:'h', pid, n, ai, hi} | {k:'c', was?}], lobby, moves, game }
 *   ctl          … 座る・離れる・AI補助・ヒント・生きている合図・もう一局（全員 → ホスト）
 *   act          … 自分の手 { pid, g（何局目）, n（何手目）, m（置き方の番号）}（全員 → ホスト。ホストが合法か確かめて足す）
 *
 * 完全情報のゲームなので、隠すものはない。途中から来た人は、空いている CPU の席をすぐ引き継ぐ。
 * 通信が切れた人の席は CPU が代わりに打ち、戻ってきたら返す。再読み込みしても同じ席に戻る（タブごとの ID を sessionStorage に）
 */
(function () {
  'use strict';
  const app = window.BlocksApp;
  if (!app) return;
  const { $, esc, B } = app;
  const ONLINE_OK = !!(window.SSIHOnline && window.SSIHOnline.available && window.SSIHOnline.available());
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/blocks/';
  const GAME = 'blocks';
  const LOST_MS = 40000, HB_MS = 8000;
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code5 = () => { let s = ''; for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
  const sess = {
    get(k, d) { try { const v = JSON.parse(sessionStorage.getItem('blocks-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem('blocks-' + k, JSON.stringify(v)); } catch (e) { /* 無視 */ } },
  };
  let PID = sess.get('pid', null);
  if (!PID) { PID = 'p' + Math.random().toString(36).slice(2, 12); sess.set('pid', PID); }
  let myName = app.store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  const lobby = Object.assign({ mode: 'classic', cpu: 'normal', msg: '' }, app.store.get('lobby', {}));
  lobby.msg = '';
  let NET = null, T = null, pendingJoin = null, pendingMove = null;
  const clean = s => String(s || 'ゲスト').replace(/[\u0000-\u001f]/g, '').slice(0, 16);

  // 卓の進行のタイマーは Web Worker で数える（画面が裏にあると、ブラウザが画面のタイマーを間引くため）
  const wtimer = (() => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['onmessage = e => setTimeout(() => postMessage(e.data), e.data.ms);'], { type: 'text/javascript' })));
      const cbs = new Map();
      let id = 0;
      w.onmessage = e => { const f = cbs.get(e.data.id); if (f) { cbs.delete(e.data.id); try { f(); } catch (err) { console.error(err); } } };
      return { set(f, ms) { const i = ++id; cbs.set(i, f); w.postMessage({ id: i, ms }); return i; }, clear(i) { cbs.delete(i); } };
    } catch (e) { return { set: (f, ms) => setTimeout(f, ms), clear: i => clearTimeout(i) }; }
  })();
  function every(fn, ms) { const h = { on: true }; const loop = () => { if (!h.on) return; try { fn(); } catch (e) { console.error(e); } h.t = wtimer.set(loop, ms); }; h.t = wtimer.set(loop, ms); return h; }

  // ------------------------------------------------------------------ 卓
  function makeTable(code, create) {
    const room = NET.room('bk-' + code);
    const t = { code, room, st: null, isHost: false, seen: new Map(), lastState: 0, left: false, pubQ: false };
    const now = () => Date.now();
    const seen = pid => (pid === PID ? now() : t.seen.get(pid) || 0);
    const mySeat = () => (t.st ? t.st.seats.findIndex(x => x.k === 'h' && x.pid === PID) : -1);
    t.mySeat = mySeat;
    function publish() {
      if (t.pubQ) return;
      t.pubQ = true;
      // 同じ処理の中の変更をまとめて1回で出す（タイマーではなくマイクロタスク: 画面が裏でも間引かれない）
      Promise.resolve().then(() => {
        t.pubQ = false;
        if (t.left || !t.isHost) return;
        t.st.seq = (t.st.seq || 0) + 1; t.st.t = now();
        room.pub('state', t.st, { retain: true });
        apply(JSON.parse(JSON.stringify(t.st)));
      });
    }
    function apply(st) {
      t.st = st; t.lastState = now();
      t.isHost = st.host === PID;
      update();
    }
    function onState(st) {
      if (!st || st.v !== 1 || st.code !== code) return;
      if (t.st && t.isHost && st.host === PID) return; // 自分が出した状態の折り返し（手元の方が新しいことがある）
      const ep = st.ep || 0, myEp = t.st ? t.st.ep || 0 : 0;
      if (t.st && (ep < myEp || (ep === myEp && st.seq < t.st.seq))) return;
      if (t.st && t.isHost && st.host !== PID && ep >= myEp) t.isHost = false;
      apply(st);
    }
    // ---------------------------------------------------------------- ホストの仕事
    function hostCtl(m) {
      const st = t.st;
      if (!st || !m || !m.pid) return;
      t.seen.set(m.pid, now());
      if (m.t === 'join') {
        const i = st.seats.findIndex(x => x.k === 'h' && x.pid === m.pid);
        if (i >= 0) { const s = st.seats[i]; s.n = clean(m.name); s.ai = m.ai | 0; publish(); return; }
        // 通信が切れて CPU に代わってもらっていた席に戻る → なければ空いている CPU の席に座る（途中からでもすぐ）
        let f = st.seats.findIndex(x => x.k === 'c' && x.was === m.pid);
        if (f < 0) f = st.seats.findIndex(x => x.k === 'c' && !x.was);
        if (f < 0) f = st.seats.findIndex(x => x.k === 'c' && x.was && now() - seen(x.was) > LOST_MS);
        if (f < 0) return; // 満席（観戦）
        st.seats[f] = { k: 'h', pid: m.pid, n: clean(m.name), ai: m.ai | 0, hi: 0 };
        publish();
      } else if (m.t === 'leave') {
        const i = st.seats.findIndex(x => x.k === 'h' && x.pid === m.pid);
        if (i >= 0) { st.seats[i] = { k: 'c' }; publish(); }
      } else if (m.t === 'ai') { const s = st.seats.find(x => x.k === 'h' && x.pid === m.pid); if (s) { s.ai = m.ai | 0; publish(); } }
      else if (m.t === 'hint') { const s = st.seats.find(x => x.k === 'h' && x.pid === m.pid); if (s) { s.hi = (s.hi | 0) + 1; publish(); } }
      else if (m.t === 'start') { if (st.lobby && st.seats.some(x => x.k === 'h' && x.pid === m.pid)) { st.lobby = false; publish(); } }
      else if (m.t === 'again') { if (ended() && st.seats.some(x => x.k === 'h' && x.pid === m.pid)) newGame(); }
    }
    function hostAct(m) {
      const st = t.st;
      if (!st || !m || st.lobby || m.g !== st.game || (m.n | 0) !== st.moves.length) return;
      const pos = B.Position.fromMoves(st.mode, st.moves);
      const k = pos.legal();
      if (!k) return;
      const p = pos.R.owner[pos.turn], seat = st.seats[p];
      // その色の席の人か、CPU の席ならホスト自身（ホストの画面の CPU が打つ）
      const ok = (seat.k === 'h' && seat.pid === m.pid) || (seat.k === 'c' && m.pid === PID);
      if (!ok || !pos.legalHas(m.m | 0)) return;
      st.moves.push(m.m | 0);
      publish();
    }
    const ended = () => { const st = t.st; if (!st || st.lobby) return false; return B.Position.fromMoves(st.mode, st.moves).over(); };
    function newGame() {
      const st = t.st;
      // 席を1つずらす（毎局ちがう色を受け持つ）
      st.seats = st.seats.slice(1).concat(st.seats.slice(0, 1)).map(x => (x.k === 'h' ? Object.assign({}, x, { hi: 0 }) : { k: 'c' }));
      st.moves = []; st.game = (st.game | 0) + 1; st.lobby = false;
      publish();
    }
    function hostTick() {
      const st = t.st;
      if (!st || !t.isHost) return;
      // 長く黙っている人の席は CPU が代わりに打つ（戻ってきたら返す）
      let ch = false;
      st.seats.forEach((x, i) => { if (x.k === 'h' && x.pid !== PID && now() - seen(x.pid) > LOST_MS) { st.seats[i] = { k: 'c', was: x.pid, n: x.n }; ch = true; } });
      if (ch) publish();
    }
    // ホストが黙ったら、席の順で次の人が引き継ぐ
    function hostWatch() {
      const st = t.st;
      if (!st || t.isHost || now() - Math.max(t.lastState, seen(st.host)) < LOST_MS) return;
      const hum = st.seats.filter(x => x.k === 'h' && x.pid !== st.host && (x.pid === PID || now() - seen(x.pid) < LOST_MS)).map(x => x.pid);
      if (hum[0] !== PID) return;
      const old = st.seats.findIndex(x => x.k === 'h' && x.pid === st.host);
      if (old >= 0) st.seats[old] = { k: 'c', was: st.host, n: st.seats[old].n };
      st.host = PID; st.ep = (st.ep || 0) + 1;
      t.isHost = true;
      publish();
    }
    // 自分が出した連絡の折り返しは捨てる（ホストは自分の連絡をその場で処理しているので、2回数えないように）
    function onCtl(m) { if (!m || !m.pid || m.pid === PID) return; t.seen.set(m.pid, now()); if (t.isHost) hostCtl(m); }
    function onAct(m) { if (!m || !m.pid || m.pid === PID) return; t.seen.set(m.pid, now()); if (t.isHost) hostAct(m); }
    room.sub('state', onState); room.sub('ctl', onCtl); room.sub('act', onAct);
    if (create) {
      const P = B.RULES[create.mode].players;
      t.st = { v: 1, code, host: PID, ep: 0, seq: 0, mode: create.mode, cpu: create.cpu, seats: [{ k: 'h', pid: PID, n: clean(myName), ai: app.aiFlags(), hi: 0 }].concat(Array.from({ length: P - 1 }, () => ({ k: 'c' }))), lobby: true, moves: [], game: 1 };
      t.isHost = true;
      publish();
    }
    const send = (sub, body) => room.pub(sub, Object.assign({ pid: PID }, body));
    const hb = every(() => {
      if (t.left) return;
      send('ctl', { t: 'hb' });
      // 席がない（満席だった・外された）なら、もう一度座りたいと伝える
      if (t.st && mySeat() < 0) send('ctl', { t: 'join', name: myName, ai: app.aiFlags() });
      if (t.isHost) hostTick(); else hostWatch();
      update();
    }, HB_MS);
    send('ctl', { t: 'join', name: myName, ai: app.aiFlags() });
    Object.assign(t, {
      move(n, m) {
        const body = { t: 'mv', g: t.st.game, n, m };
        if (t.isHost) hostAct(Object.assign({ pid: PID }, body)); else send('act', body);
      },
      setAI(f) { send('ctl', { t: 'ai', ai: f | 0 }); if (t.isHost) hostCtl({ t: 'ai', pid: PID, ai: f }); },
      hint() { send('ctl', { t: 'hint' }); if (t.isHost) hostCtl({ t: 'hint', pid: PID }); },
      start() { send('ctl', { t: 'start' }); if (t.isHost) hostCtl({ t: 'start', pid: PID }); },
      again() { send('ctl', { t: 'again' }); if (t.isHost) hostCtl({ t: 'again', pid: PID }); },
      leave() {
        send('ctl', { t: 'leave' });
        if (t.isHost && t.st) {
          // ホストが離れるときは、残っている人に引き継いでもらう
          const i = t.st.seats.findIndex(x => x.k === 'h' && x.pid === PID);
          if (i >= 0) t.st.seats[i] = { k: 'c' };
          const next = t.st.seats.find(x => x.k === 'h' && now() - seen(x.pid) < LOST_MS);
          if (next) { t.st.host = next.pid; t.st.ep = (t.st.ep || 0) + 1; t.st.seq++; room.pub('state', t.st, { retain: true }); }
          else room.pub('state', null, { retain: true }); // 最後の人: 卓を消す
        }
        t.left = true; hb.on = false;
        room.unsub('state'); room.unsub('ctl'); room.unsub('act');
      },
      lost: pid => now() - seen(pid) > LOST_MS,
    });
    return t;
  }

  // ------------------------------------------------------------------ 卓の状態 → 画面
  let lastKey = '';
  function update() {
    if (!T || !T.st) return;
    const st = T.st, my = T.mySeat();
    presence(); badge();
    if (!$('dlg-online').hidden) renderLobby();
    if (st.lobby) return;
    if (!$('dlg-online').hidden && lastKey.startsWith('lobby')) $('dlg-online').hidden = true;
    const seats = st.seats.map((x, i) => {
      if (x.k === 'h' && x.pid === PID) return { k: 'human', ai: x.ai, hi: x.hi };
      if (x.k === 'h') return { k: 'remote', name: x.n, ai: x.ai, hi: x.hi, lost: T.lost(x.pid) };
      return T.isHost ? { k: 'cpu', lv: st.cpu, name: 'CPU' } : { k: 'remote', name: x.was ? `CPU（${x.n || ''}の代わり）` : 'CPU', cpu: true };
    });
    lastKey = `game:${st.game}`;
    // 送った手がまだ入っていなければ、ときどき送り直す（中継で落ちたときのため）
    if (pendingMove) {
      if (pendingMove.g !== st.game || st.moves.length > pendingMove.n) pendingMove = null;
      else if (st.moves.length === pendingMove.n && Date.now() - pendingMove.t > 5000) { pendingMove.t = Date.now(); T.move(pendingMove.n, pendingMove.m); }
    }
    app.syncOnline({ mode: st.mode, seats, moves: st.moves.slice(), online: { code: st.code, host: T.isHost, seat: my, game: st.game }, resultShown: false });
  }
  function presence() {
    if (!NET || !T || !T.st) return;
    const st = T.st, h = st.seats.filter(x => x.k === 'h').length, P = st.seats.length;
    NET.setPresence({ s: h < P ? 'wait' : 'play', c: T.code, m: T.code, r: { mode: st.mode, h, n: P, host: T.isHost ? 1 : 0, st: st.lobby ? 0 : 1 }, rl: `${h}/${P}人` });
  }

  // ------------------------------------------------------------------ ロビー
  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = window.SSIHOnline.create({
      game: GAME,
      onStatus: () => { badge(); renderLobby(); if (NET.status === 'on') tryJoin(); app.render(); },
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
    const c = NET && st === 'on' ? NET.counts() : null, g = c && c.byGame[GAME];
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
    b.querySelector('.lbl').textContent = T ? `卓 ${T.code}` : 'オンライン';
  }
  function tables() {
    if (!NET || NET.status !== 'on') return [];
    return NET.list().filter(p => p.g === GAME && p.c && p.r && p.r.host === 1).map(p => ({ code: p.c, host: p.n, h: p.r.h | 0, n: p.r.n | 0, mode: p.r.mode, started: !!p.r.st }));
  }
  const modeName = m => app.MODE_NAME[m] || '？';
  const aiTag = (f, hi) => `<span class="aitag ${f || hi ? 'on' : 'off'}">${f ? 'AI補助あり' : 'AI補助なし'}${hi ? `・ヒント${hi}` : ''}</span>`;
  function open() {
    $('dlg-online').hidden = false;
    if (!ONLINE_OK) {
      $('on-body').innerHTML = `<p>オンラインの卓は、公開版（GitHub Pages）で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    net();
    renderLobby();
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off';
    const all = NET && st === 'on' ? NET.counts() : null, g = (all && all.byGame[GAME]) || { wait: 0, play: 0 };
    const num = v => (st === 'on' ? v : '—');
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
    let html = `<div class="on-stats">
      <div class="stat"><b>${num(all && all.online)}</b><span>オンライン（全体）</span></div>
      <div class="stat"><b>${num(g.wait)}</b><span>卓で待っている人</span></div>
      <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません' : 'つないでいます…'}</span></div>`;
    if (lobby.msg) html += `<p class="on-msg">${esc(lobby.msg)}</p>`;
    if (T && T.st) {
      const s = T.st, my = T.mySeat(), link = `${location.origin}${location.pathname}?table=${T.code}`;
      const pos = B.Position.fromMoves(s.mode, s.moves);
      const colorsOf = p => { const cs = []; for (let c = 0; c < pos.nc; c++) if (pos.R.owner[c] === p) cs.push(c); return cs; };
      html += `<div class="field"><span class="lab">卓 <span class="code">${esc(T.code)}</span>・${modeName(s.mode)}・CPU ${esc((app.CPU[s.cpu] || {}).label || '')}${T.isHost ? '（あなたがホスト）' : ''}</span>
        <div class="seats">${s.seats.map((x, i) => `<div class="${x.k === 'h' && x.pid === PID ? 'me' : ''}"><span class="hint">${colorsOf(i).map(c => `<span style="color:${app.colorHex(c)}">■</span>${app.PAL[app.palOf(s.mode, c)].name}`).join('＋')}</span><b>${x.k === 'h' ? esc(x.n) : x.was ? 'CPU（代わり）' : 'CPU'}</b>${x.k === 'h' ? aiTag(x.ai, x.hi) : ''}</div>`).join('')}</div>
        ${my < 0 ? '<span class="hint">満席なので観戦しています（空いたら座ります）</span>' : ''}</div>
        <div class="row-actions" style="margin:0 0 10px">
          ${s.lobby && my >= 0 ? '<button class="btn primary" data-act="start">この顔ぶれで始める（空いた席は CPU）</button>' : ''}
          ${!s.lobby ? '<button class="btn primary" data-act="close">対局を見る</button>' : ''}
          <button class="btn small" data-act="copy">招待リンクをコピー</button>
          <button class="btn small" data-act="leave">卓を離れる</button></div>
        <p class="hint on-note">友達にリンクを送ると、開いた人がこの卓の空いた席（CPU の席）にすぐ座ります（${esc(link)}）。通信が切れた人の席は CPU が代わりに打ち、戻ってきたら返します。</p>`;
    } else {
      const list = tables();
      html += `<div class="field"><span class="lab">あなたの名前（ほかの人に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（ほかの人に表示されます）</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${aiTag(app.aiFlags(), 0)}<button class="btn small" data-act="ai">${app.aiFlags() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・おすすめの一手を出しているか、ヒントを何回使ったかがほかの人に見えます</span></div></div>
      <div class="field"><span class="lab">いまある卓（${list.length}）</span><div class="on-list">${list.length ? list.map(t => `<div class="on-row"><b>${esc(t.host)}さんの卓 <span class="code" style="font-size:12px">${esc(t.code)}</span></b><span class="hint">${modeName(t.mode)}・人 ${t.h}/${t.n}${t.started ? '・対局中' : ''}</span><button class="btn small primary" data-join="${esc(t.code)}">${t.h >= t.n ? '観戦' : '座る'}</button></div>`).join('') : '<p class="hint" style="margin:0">いま卓はありません。下の「卓を作る」で作れます。</p>'}</div></div>
      <div class="field"><span class="lab">卓を作る</span>${seg('mode', [['classic', '4人（20×20）'], ['team', '2人・2色ずつ'], ['duo', '2人（14×14）']], lobby.mode)}${seg('cpu', app.CPU_KEYS.map(k => [k, `CPU ${app.CPU[k].label}`]), lobby.cpu)}
        <div><button class="btn primary" data-act="create"${st === 'on' ? '' : ' disabled'}>卓を作る</button></div></div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と置いた手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。空いた席の CPU は、ホストの端末が打ちます。</p>`;
    }
    $('on-body').innerHTML = html;
  }
  function bind() {
    $('btn-online').addEventListener('click', open);
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      const sg = b.closest('[data-seg]');
      if (sg) { lobby[sg.dataset.seg] = b.dataset.v; app.store.set('lobby', { mode: lobby.mode, cpu: lobby.cpu }); renderLobby(); return; }
      if (b.dataset.join) { join(b.dataset.join); return; }
      const act = b.dataset.act;
      if (act === 'create') create();
      else if (act === 'start') { if (T) T.start(); $('dlg-online').hidden = true; }
      else if (act === 'close') $('dlg-online').hidden = true;
      else if (act === 'leave') { leave(); renderLobby(); }
      else if (act === 'ai') { const on = !app.aiFlags(); app.settings.showEval = on; app.settings.best = on; app.store.set('settings', app.settings); setAI(app.aiFlags()); renderLobby(); app.render(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?table=${T.code}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = clean(e.target.value.trim()) || myName; app.store.set('name', myName); if (NET) NET.setName(myName); }
    });
  }
  function create() {
    leave(true);
    T = makeTable(code5(), { mode: lobby.mode, cpu: lobby.cpu });
    enter();
  }
  function join(c) {
    leave(true);
    T = makeTable(String(c).toUpperCase().slice(0, 8), null);
    enter();
    lobby.msg = '卓に入りました。ホストの返事を待っています…';
  }
  function tryJoin() {
    if (!pendingJoin || !NET || NET.status !== 'on' || T) return;
    const c = pendingJoin; pendingJoin = null;
    join(c);
  }
  function enter() {
    sess.set('online', { code: T.code, t: Date.now() });
    lastKey = 'lobby';
    presence(); badge(); renderLobby();
  }
  function leave(quiet) {
    if (!T) return;
    T.leave();
    T = null;
    sess.set('online', null);
    if (NET) NET.setPresence({ s: 'idle', c: '', m: '', r: null, rl: '' });
    if (!quiet) app.leaveOnline();
    badge();
  }
  function setAI(f) { if (NET) NET.setAI(f); if (T) T.setAI(f); }

  window.BKOnline = {
    open, leave: q => { leave(q); },
    sendMove(n, m) { if (T && T.st && !T.st.lobby) { pendingMove = T.isHost ? null : { n, m, g: T.st.game, t: Date.now() }; T.move(n, m); } },
    changed() { /* 画面が変わったとき（今は何もしない） */ },
    hint() { if (T) T.hint(); },
    again() { if (T) T.again(); },
    setAI,
    // 情報の行に出す注意（自分の通信が切れている・相手が切れている）
    alert() {
      if (!T || !T.st || T.st.lobby) return '';
      if (NET && NET.status !== 'on') return 'あなたの通信が切れています（つなぎ直しています…）';
      const pos = app.S.pos, c = pos ? pos.turn : -1;
      if (c < 0) return '';
      const seat = T.st.seats[pos.R.owner[c]];
      if (seat && seat.k === 'h' && seat.pid !== PID && T.lost(seat.pid)) return `${esc(seat.n)}さんの通信が切れています（まもなく CPU が代わりに打ちます）`;
      return '';
    },
    debug: () => ({ T, NET, PID }),
  };

  bind();
  if (ONLINE_OK) { net(); badge(); }
  const q = new URLSearchParams(location.search).get('table');
  const back = sess.get('online', null);
  if (q && ONLINE_OK) { pendingJoin = q.toUpperCase().slice(0, 8); history.replaceState(null, '', location.pathname); }
  else if (back && back.code && Date.now() - back.t < 3 * 3600e3 && ONLINE_OK) pendingJoin = back.code;
  if (pendingJoin) { open(); tryJoin(); }
})();
