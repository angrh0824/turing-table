/* オンラインの4人卓の画面まわり: 卓を作る・座る・招待リンク・始める・離れる、と卓の進み（js/online-core.js）を画面（js/app.js）につなぐ
 * 空いた席は CPU（ホストの端末が動かす）。途中から来た人は次の局から CPU の席を引き継ぐ。在席情報は common/online.js
 */
(function () {
  'use strict';
  const OC = window.MJOnlineCore;
  let app = null, NET = null, tc = null, code = null;
  const ONLINE_OK = !!(window.SSIHOnline && window.SSIHOnline.available && window.SSIHOnline.available() && OC && window.MJMental);
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/mahjong/';
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code5 = () => { let s = ''; for (let i = 0; i < 5; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
  const sess = {
    get(k, d) { try { const v = JSON.parse(sessionStorage.getItem('mahjong-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem('mahjong-' + k, JSON.stringify(v)); } catch (e) { /* 無視 */ } },
  };
  let PID = null, myName = '';
  const lobby = { len: 'hanchan', aka: 3, cpu: 'strong', msg: '' };
  let esc, $;
  let lastNo = -1, lastPhase = '', voidShown = -1, reactKey = '', afkTimer = 0, finalShown = false;

  window.MJOnline = {
    init(a) {
      app = a; esc = a.esc; $ = a.$;
      bind();
      PID = sess.get('pid', null);
      if (!PID) { PID = 'p' + Math.random().toString(36).slice(2, 12); sess.set('pid', PID); }
      myName = app.store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
      Object.assign(lobby, app.store.get('lobby', {}));
      if (ONLINE_OK) { net(); badge(); }
      const q = new URLSearchParams(location.search).get('table');
      const back = sess.get('online', null);
      if (q && ONLINE_OK) { pendingJoin = q.toUpperCase().slice(0, 8); history.replaceState(null, '', location.pathname); }
      else if (back && back.code && Date.now() - back.t < 60 * 60e3 && ONLINE_OK) pendingJoin = back.code;
      if (pendingJoin) { open(); tryJoin(); }
    },
    open,
    active: () => !!tc,
    drives: () => !!(tc && tc.st && !tc.st.lobby),
    schedule,
    leave: quiet => leave(quiet),
    tag, setAI(f) { if (NET) NET.setAI(f); if (tc) tc.setAI(f); },
    hint() { if (tc) tc.hint(); },
    next() { if (tc) tc.ready(); },
    again() { if (tc) { tc.again(); finalShown = false; } },
    sendTurn(a) { if (tc) tc.turn(a); app.render(); },
    sendReact(a) { if (tc) tc.react(a); app.S.pending = null; app.render(); },
    debug: () => ({ tc, NET, code }),
    auditLine,
  };
  function auditLine() {
    const el = document.getElementById('rs-audit');
    if (!el || !tc || !tc.st || !tc.st.R) return;
    const R = tc.st.R, a = tc.audit;
    if (R.phase === 'done' && a && a.ok) el.innerHTML = '<b style="color:var(--good)">検査 OK</b>: 山・混ぜ方・見せた牌・手順はすべて正しかった（点数を確定しました）';
    else if (R.phase === 'done') el.innerHTML = '<b style="color:var(--good)">ホストの検査 OK</b>（点数を確定しました）';
    else if (R.phase === 'void') el.innerHTML = '<b style="color:var(--bad)">この局は無効</b>になりました（点数は局の前に戻ります）';
    else el.textContent = '局のあとの検査をしています（山・混ぜ方・手順）…';
  }
  let pendingJoin = null;

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = window.SSIHOnline.create({
      game: 'mahjong',
      onStatus: () => { badge(); renderLobby(); if (NET.status === 'on') tryJoin(); try { if (localStorage.getItem('mahjong-debug')) console.log('[卓] つながり', NET.status, new Date().toISOString().slice(11, 19)); } catch (e) { /* 無視 */ } },
      onPresence: () => { badge(); renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(app.aiFlags());
    NET.connect();
    return NET;
  }
  function badge() {
    const b = document.getElementById('btn-online');
    if (!b) return;
    const st = NET ? NET.status : (ONLINE_OK ? 'off' : 'unavailable');
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null;
    const g = c && c.byGame.mahjong;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
    b.querySelector('.lbl').textContent = code ? `卓 ${code}` : 'オンライン';
  }
  // いまある卓（在席情報から、ホストの在席を卓ごとに）
  function tables() {
    if (!NET || NET.status !== 'on') return [];
    return NET.list().filter(p => p.g === 'mahjong' && p.c && p.r && p.r.host === 1).map(p => ({ code: p.c, host: p.n, h: p.r.h | 0, len: p.r.len, aka: p.r.aka, started: !!p.r.st }));
  }
  function open() {
    $('dlg-online').hidden = false;
    if (!ONLINE_OK) {
      $('on-body').innerHTML = `<p>オンラインの卓は、公開版（GitHub Pages）で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    net();
    renderLobby();
  }
  const ruleText = (len, aka) => `${len === 'tonpu' ? '東風戦' : '東南戦'}・赤${+aka ? 'あり' : 'なし'}`;
  const aiText = f => (f ? 'AI補助あり' : 'AI補助なし');
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off';
    const all = NET && st === 'on' ? NET.counts() : null;
    const g = all && all.byGame.mahjong || { wait: 0, play: 0 };
    const num = v => (st === 'on' ? v : '—');
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
    let html = `<div class="on-stats">
      <div class="stat"><b>${num(all && all.online)}</b><span>オンライン（全ゲーム）</span></div>
      <div class="stat"><b>${num(g.wait)}</b><span>麻雀の卓で待っている人</span></div>
      <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません' : 'つないでいます…'}</span></div>`;
    if (lobby.msg) html += `<p class="on-msg">${esc(lobby.msg)}</p>`;
    if (tc && tc.st) {
      const s = tc.st;
      const link = `${location.origin}${location.pathname}?table=${code}`;
      const my = tc.seat();
      html += `<div class="field"><span class="lab">卓 <span class="code">${esc(code)}</span>・${ruleText(s.rules.length, s.rules.aka)}・CPU ${esc((app.CPU[s.cpu] || {}).label || '')}${tc.isHost ? '（あなたがホスト）' : ''}</span>
        <div class="seats4">${s.seats.map((x, i) => `<div class="${x.k === 'h' && x.pid === PID ? 'me' : ''}"><span class="hint">${s.lobby ? `席${i + 1}` : ['東', '南', '西', '北'][(i - (s.g ? s.g.ky : 0) + 4) % 4]}</span><b>${x.k === 'h' ? esc(x.n) : 'CPU'}</b>${x.k === 'h' ? `<span class="aitag ${x.ai ? 'on' : 'off'}">${aiText(x.ai)}${x.hi ? `・ヒント${x.hi}` : ''}</span>` : ''}</div>`).join('')}</div>
        ${(s.wait || []).length ? `<span class="hint">次の局から座る人: ${s.wait.map(w => esc(w.n)).join('・')}</span>` : ''}
        ${my < 0 && !(s.wait || []).some(w => w.pid === PID) ? '<span class="hint">満席なので観戦しています</span>' : ''}
      </div>
      <div class="actions-row" style="justify-content:flex-start">
        ${tc.isHost && s.lobby ? '<button class="btn primary" data-act="start">この顔ぶれで始める（空いた席は CPU）</button>' : ''}
        ${s.lobby && !tc.isHost ? '<span class="hint">ホストが始めるのを待っています…</span>' : ''}
        <button class="btn small" data-act="copy">招待リンクをコピー</button>
        <button class="btn small" data-act="leave">卓を離れる</button>
      </div>
      <p class="hint on-note">友達にリンクを送ると、開いた人がこの卓に座ります（${esc(link)}）。途中から来た人は次の局から CPU の席を引き継ぎます。</p>`;
    } else {
      const list = tables();
      html += `<div class="field"><span class="lab">あなたの名前（ほかの人に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（ほかの人に表示されます）</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="aitag ${app.aiFlags() ? 'on' : 'off'}">${aiText(app.aiFlags())}</span><button class="btn small" data-act="ai">${app.aiFlags() ? 'オフにする' : 'オンにする'}</button></div></div>
      <div class="field"><span class="lab">いまある卓（${list.length}）</span><div class="on-list">${list.length ? list.map(t => `<div class="on-row"><b>${esc(t.host)}さんの卓 <span class="code" style="font-size:12px">${esc(t.code)}</span></b><span class="hint">${ruleText(t.len, t.aka)}・人 ${t.h}/4${t.started ? '・対局中' : ''}</span><button class="btn small primary" data-join="${esc(t.code)}">${t.h >= 4 ? '観戦' : '座る'}</button></div>`).join('') : '<p class="hint" style="margin:0">いま卓はありません。下の「卓を作る」で作れます。</p>'}</div></div>
      <div class="field"><span class="lab">卓を作る</span>${seg('len', [['tonpu', '東風戦'], ['hanchan', '東南戦']], lobby.len)}${seg('aka', [['3', '赤あり'], ['0', '赤なし']], lobby.aka)}${seg('cpu', Object.keys(app.CPU).map(k => [k, `CPU ${app.CPU[k].label}`]), lobby.cpu)}
        <div><button class="btn primary" data-act="create"${st === 'on' ? '' : ' disabled'}>卓を作る</button></div></div>
      <p class="hint on-note">山の並びはだれも（ホストも）知りません。参加した全員の暗号の鍵で山を混ぜ、自分の牌は自分にしか開けません（しくみは AI のページ・README）。CPU の席の牌はホストの端末が開きます。公開の中継サーバーを使うため、名前と行動はほかの人からも見える可能性があります。</p>`;
    }
    $('on-body').innerHTML = html;
  }
  function bind() {
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      const sg = b.closest('[data-seg]');
      if (sg) { lobby[sg.dataset.seg] = b.dataset.v; app.store.set('lobby', lobby); renderLobby(); return; }
      if (b.dataset.join) { join(b.dataset.join); return; }
      const act = b.dataset.act;
      if (act === 'create') create();
      else if (act === 'start') { if (tc) tc.start(); $('dlg-online').hidden = true; }
      else if (act === 'leave') { leave(); renderLobby(); }
      else if (act === 'ai') { const on = !app.aiFlags(); app.settings.showEval = on; app.settings.showWaits = on; app.store.set('settings', app.settings); NET.setAI(app.aiFlags()); renderLobby(); app.render(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?table=${code}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; app.store.set('name', myName); if (NET) NET.setName(myName); }
    });
  }
  // 卓の進行のタイマーは Web Worker で数える（画面が裏にあると、ブラウザが画面のタイマーを間引くため）
  const wtimer = (() => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['onmessage = e => setTimeout(() => postMessage(e.data), e.data.ms);'], { type: 'text/javascript' })));
      const cbs = new Map();
      let id = 0;
      w.onmessage = e => { const f = cbs.get(e.data.id); if (f) { cbs.delete(e.data.id); try { f(); } catch (err) { console.error(err); } } };
      return { set(f, ms) { const i = ++id; cbs.set(i, f); w.postMessage({ id: i, ms }); return i; }, clear(i) { cbs.delete(i); } };
    } catch (e) { return null; }
  })();
  function envFor() {
    return {
      room: NET.room('mj-' + code), pid: PID, name: myName, ai: app.aiFlags(),
      now: () => Date.now(),
      setTimeout: (f, ms) => (wtimer ? wtimer.set(f, ms) : setTimeout(f, ms)), clearTimeout: t => (wtimer ? wtimer.clear(t) : clearTimeout(t)),
      store: { get: (k, d) => sess.get(k, d), set: (k, v) => sess.set(k, v) },
      makeAgent: level => app.makeAgent(level),
      onChange: update, log: (...a) => console.log('[卓]', ...a), debug: (() => { try { return !!localStorage.getItem('mahjong-debug'); } catch (e) { return false; } })(),
    };
  }
  function create() {
    leave(true);
    code = code5();
    tc = OC.createTable(envFor(), code, { length: lobby.len, aka: +lobby.aka, cpu: lobby.cpu });
    enter();
  }
  function join(c) {
    leave(true);
    code = String(c).toUpperCase().slice(0, 8);
    tc = OC.createTable(envFor(), code, null);
    enter();
  }
  function tryJoin() {
    if (!pendingJoin || !NET || NET.status !== 'on' || tc) return;
    const c = pendingJoin; pendingJoin = null;
    join(c);
  }
  function enter() {
    sess.set('online', { code, t: Date.now() });
    app.setOnline({ code });
    lastNo = -1; finalShown = false;
    presence();
    badge(); renderLobby();
  }
  function leave(quiet) {
    if (!tc) return;
    tc.leave();
    tc = null; code = null;
    sess.set('online', null);
    app.setOnline(null);
    if (NET) NET.setPresence({ s: 'idle', c: '', m: '', r: null, rl: '' });
    if (!quiet) { app.S.game = null; app.S.round = null; app.render(); }
    badge();
  }
  function presence() {
    if (!NET || !tc || !tc.st) return;
    const s = tc.st, h = s.seats.filter(x => x.k === 'h').length;
    NET.setPresence({ s: h < 4 ? 'wait' : 'play', c: code, m: code, r: { h, len: s.rules.length, aka: s.rules.aka, host: tc.isHost ? 1 : 0, st: s.lobby ? 0 : 1 }, rl: `${h}/4人` });
  }

  // ------------------------------------------------------------------ 卓の状態 → 画面
  function tag(s) {
    if (!tc || !tc.st) return '';
    const x = tc.st.seats[s];
    if (!x) return '';
    if (x.k !== 'h') return `<span class="lvtag">CPU</span>`;
    return `<span class="aitag ${x.ai || x.hi ? 'on' : 'off'}" title="${aiText(x.ai)}${x.hi ? `・ヒント${x.hi}回` : ''}">${x.ai ? 'AI補助' : '補助なし'}${x.hi ? `・ヒ${x.hi}` : ''}</span>`;
  }
  let gameObj = null, wasLobby = true;
  function update() {
    if (!tc || !tc.st) return;
    const s = tc.st, S = app.S;
    presence(); badge();
    if (s.lobby) { wasLobby = true; if (!$('dlg-online').hidden) renderLobby(); return; }
    // 始まったらロビーを閉じる
    if (wasLobby) { wasLobby = false; $('dlg-online').hidden = true; $('dlg-new').hidden = true; $('dlg-final').hidden = true; }
    if (!$('dlg-online').hidden) renderLobby();
    auditLine();
    // 半荘の見た目用の Game（点数・局・記録）
    if (!gameObj || gameObj.code !== code) { gameObj = new window.MJ.Game(s.rules, 1); gameObj.code = code; }
    const g = s.g;
    Object.assign(gameObj, { rules: window.MJ.rulesOf(s.rules), scores: g.scores, roundWind: g.rw, kyoku: g.ky, honba: g.hb, kyotaku: g.kt, ended: g.ended, final: g.final, rounds: tc.history });
    S.game = gameObj;
    const my = tc.seat();
    S.me = my >= 0 ? my : 0;
    S.seats = [0, 1, 2, 3].map(i => (i === my ? 'human' : 'remote'));
    S.names = s.seats.map((x, i) => (i === my ? `${x.n}（あなた）` : x.k === 'h' ? x.n : 'CPU'));
    const R = s.R, r = tc.rep;
    if (r && (!S.round || S.round !== r)) { S.round = r; S.logPos = 0; S.resultShown = false; S.sel = -1; S.riichiMode = false; S.pending = null; reactKey = ''; S.notice = ''; }
    if (R && R.no !== lastNo) { lastNo = R.no; lastPhase = ''; }
    if (R && R.phase === 'void' && voidShown !== R.no) {
      voidShown = R.no;
      const why = { left: '参加者が抜けた', lost: 'つながらない人がいた', host: 'ホストが替わった', broken: '手順が合わない' }[R.why] || (String(R.why || '').startsWith('audit') ? '局のあとの検査で食い違いが見つかった（不正の可能性）' : R.why);
      app.callout && app.callout(-1, '無効');
      S.notice = `この局は無効になりました（${why}）。点数は局の前に戻して、同じ局をやり直します`;
      $('dlg-result').hidden = true;
    }
    if (g.ended && !finalShown && R && R.phase === 'done') { finalShown = true; setTimeout(() => { $('dlg-result').hidden = true; app.showFinal(); }, 2500); }
    app.afterChange();
  }
  function schedule() {
    const S = app.S, r = S.round;
    clearTimeout(afkTimer);
    if (!tc || !r || !tc.st) return;
    const p = tc.prompt, my = tc.seat();
    if (r.phase === 'end') {
      if (!S.resultShown) { S.resultShown = true; setTimeout(() => { if (S.round === r) app.showResult(); }, 900); }
      return;
    }
    if (!p) { if (S.pending) { S.pending = null; app.render(); } return; }
    const st = app.settings;
    if (p.kind === 'react') {
      const key = `${tc.st.R.no}:${p.n}`;
      const o = r.react.options[my] || [];
      const ron = o.find(a => a.t === 'ron');
      if (ron && st.autowin) { tc.react(ron); return; }
      if (!ron && st.nocall) { tc.react(null); return; }
      if (reactKey !== key) { reactKey = key; S.pending = { resp: [null, null, null, null], need: new Set([my]) }; app.render(); }
      afkTimer = setTimeout(() => { if (tc && tc.prompt && tc.prompt.kind === 'react') { tc.react(null); S.pending = null; app.render(); } }, 25000);
      return;
    }
    if (p.kind === 'turn') {
      const acts = r.turnActions();
      if (st.autowin && acts.some(a => a.t === 'tsumo')) { setTimeout(() => tc.turn({ t: 'tsumo' }), 300); return; }
      if (r.riichi[my] && !acts.some(a => a.t === 'tsumo' || a.t === 'ankan')) { setTimeout(() => tc.turn({ t: 'discard', tile: r.drawn, riichi: false }), 450); return; }
      // 長く何もしなければ、ツモ切り（鳴いたあとなら右端の牌）
      afkTimer = setTimeout(() => {
        if (!tc || !tc.prompt || tc.prompt.kind !== 'turn') return;
        const id = r.drawn >= 0 ? r.drawn : r.hands[my].find(x => r.canDiscard(x));
        tc.turn({ t: 'discard', tile: id, riichi: false });
      }, 30000);
    }
  }

})();
