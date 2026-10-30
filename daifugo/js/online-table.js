/* オンラインの卓の画面まわり: ロビー（卓を作る・座る・招待リンク）、卓の進め方（js/online-core.js）と画面（js/app.js）のつなぎ
 * 共通のオンライン部品 ../common/online.js の汎用の部屋（room('df-<コード>')）を使う。招待リンクは ?table=コード
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const App = window.DFApp, D = window.DFCore, A = window.DFAI, LV = window.DFLevels;
  if (!App) return;
  const { S, esc } = App;
  const GAME = 'daifugo';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/daifugo/';
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available() && !!window.DFOnlineCore && !!window.DFMental;
  const store = App.store;
  const ss = {
    get(k, d) { try { const v = JSON.parse(sessionStorage.getItem('daifugo-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { sessionStorage.setItem('daifugo-' + k, JSON.stringify(v)); } catch (e) { /* 無視 */ } },
  };
  // 席の ID はタブごと（再読み込みしても同じ。別のタブは別の人）
  let pid = ss.get('pid', '') || ('t' + Math.random().toString(36).slice(2, 10));
  ss.set('pid', pid);
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let NET = null, TAB = null, tableCode = null;
  const lobby = { msg: '', cpu: (App.cfg().cpu || 'normal'), games: 5 };
  const aiFlag = () => (App.aiOn() ? 1 : 0);

  // ------------------------------------------------------------------ つなぐ
  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: GAME,
      onStatus: () => { renderBadge(); renderLobby(); if (TAB) render(); },
      onPresence: () => { renderBadge(); renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(aiFlag());
    NET.connect();
    return NET;
  }
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
        clear(i) { cbs.delete(i); w.postMessage({ c: 'x', id: i }); },
      };
    } catch (e) { return { setTimeout: (f, ms) => setTimeout(f, ms), setInterval: (f, ms) => setInterval(f, ms), clear: i => { clearTimeout(i); clearInterval(i); } }; }
  })();

  // CPU の席の手（ホストの端末で）: 学んだネットがあれば使う
  let cpuNet = null;
  function cpuMove(g, level) {
    if (!cpuNet && window.DF_WEIGHTS) { try { cpuNet = A.makeNet(A.dequantize(window.DF_WEIGHTS)); } catch (e) { cpuNet = null; } }
    // ホストの画面が止まらないよう、オンラインの CPU は読み（最強の search）を使わない
    return LV.choose(g, level || 'normal', cpuNet, Math.random, { search: null }).mv;
  }

  function openTable(code, create) {
    if (!net()) return;
    leaveTable(true);
    tableCode = code;
    ss.set('table', code);
    const env = {
      room: NET.room('df-' + code), pid, name: () => myName, ai: aiFlag, now: () => Date.now(),
      setTimeout: wt.setTimeout, clearTimeout: wt.clear, setInterval: wt.setInterval, clearInterval: wt.clear,
      store: { get: (k, d) => ss.get(k, d), set: (k, v) => ss.set(k, v) },
      cpuMove, onChange: () => schedule(), log: (...a) => console.log('[卓]', ...a),
    };
    TAB = DFOnlineCore.createTable(env, code);
    TAB.open(create || null);
    seen = { uid: '', fed: 0, phase: '', round: -1 };
    renderLobby();
  }
  function leaveTable(quiet) {
    if (!TAB) return;
    TAB.leave();
    TAB = null; tableCode = null; lastPres = '';
    ss.set('table', null);
    if (NET) NET.setPresence({ s: 'idle', c: '', m: '' });
    if (S.online) { App.endOnline(); if (!quiet) App.startMatch(App.cfg()); }
  }
  window.DFOnline = { leave: () => leaveTable(true), tab: () => TAB };

  // ------------------------------------------------------------------ 卓 → 画面
  let seen = { uid: '', fed: 0, phase: '', round: -1 };
  let pend = 0;
  function schedule() { if (!pend) pend = requestAnimationFrame(() => { pend = 0; render(); }); setTimeout(() => { if (pend) { cancelAnimationFrame(pend); pend = 0; render(); } }, 120); }
  const online = {
    get isHost() { return !!(TAB && TAB.isHost); },
    canAct() { return !!(TAB && TAB.prompt()); },
    submit(mv) { if (TAB && TAB.submit(mv)) App.renderAll(); else App.toast('いまは出せません（つなぎ直しています）'); },
    useHint() { if (TAB) TAB.ctl('hint'); },
    setAI(f) { if (TAB) TAB.ctl('ai', { ai: f }); if (NET) NET.setAI(f); },
    next() { if (TAB) TAB.next(); },
    onRoundEnd() { render(); },
    alert: '',
  };
  function seatsView(st) {
    const me = TAB.mySeat();
    return st.seats.map((x, i) => {
      if (i === me) return { kind: 'human', name: myName, ai: aiFlag(), hints: x.hints | 0 };
      if (x.k === 'h') return { kind: st.R && st.R.sp && st.R.sp[i] !== x.pid && st.phase === 'round' ? 'cpu' : 'remote', name: x.name, ai: x.ai | 0, hints: x.hints | 0, level: x.lvl || st.cfg.cpu, next: st.R && st.R.sp && st.R.sp[i] !== x.pid };
      return { kind: 'cpu', level: x.lvl || st.cfg.cpu, name: '' };
    });
  }
  function render() {
    renderBadge();
    if (!TAB) { renderLobby(); return; }
    const st = TAB.state;
    if (!st) { renderLobby(); return; }
    const me = TAB.mySeat();
    if (TAB.T.full) { lobby.msg = 'その卓は満席でした'; leaveTable(true); renderLobby(); return; }
    if (me >= 0) presence(st, me);
    renderLobby();
    if (me < 0) return;
    const R = st.R;
    online.alert = NET && NET.status !== 'on' ? 'あなたの通信が切れています（つなぎ直しています…）' : '';
    // 卓の席・点数を画面へ
    const rules = st.cfg.rules;
    const base = { online, me, seats: seatsView(st), rules, games: st.cfg.games || 0, round: R ? R.no : st.round, scores: (st.scores || [0, 0, 0, 0]).slice(), history: st.history || [], prev: st.prev };
    if (!S.online) { App.beginOnline(base); $('dlg-online').hidden = true; }
    S.seats = base.seats; S.me = me; S.games = base.games;
    online.waiting = st.phase === 'lobby' ? (TAB.isHost ? '人を待つか「オンライン」→「始める」' : 'ホストが始めるのを待っています') : '';
    if (st.phase === 'lobby') {
      if (seen.phase !== 'lobby') { seen.phase = 'lobby'; App.emptyTable(); showWaiting(st); }
      App.renderAll();
      return;
    }
    seen.phase = st.phase;
    // 回の写しを画面に（新しい回なら作り直す）
    if (R && TAB.rep && TAB.repUid === R.uid) {
      if (seen.uid !== R.uid) {
        seen.uid = R.uid; seen.fed = 0;
        S.round = R.no; S.prev = R.prev; S.rules = D.normRules(rules);
        S.scores = base.scores; S.history = base.history;
        App.hideResult();
        // 自分の席の札だけを知っている手（ホストでも CPU の席の札は画面に入れない）
        const h0 = TAB.repHands0.map((h, s) => (s === me ? h.slice() : h.map(() => -1)));
        App.loadRound({ hands0: h0, prev: R.prev, leader: R.leader, auto: false, moves: [] });
        const catchUp = TAB.mvs.length > 0;
        feed(true);
        if (!catchUp) App.animateDeal(); else { App.renderAll(); App.schedule(); }
      } else feed(false);
    }
    // 回が終わった（検査のあと）
    if ((st.phase === 'between' || st.phase === 'end') && seen.round !== (st.round * 100 + (st.void ? 1 : 0)) && (!R || R.phase === 'done' || R.phase === 'void')) {
      seen.round = st.round * 100 + (st.void ? 1 : 0);
      S.scores = (st.scores || [0, 0, 0, 0]).slice(); S.history = st.history || []; S.prev = st.prev;
      S.ended = st.phase === 'end';
      if (st.void) App.toast(st.void);
      else if (S.g && S.g.phase === 'done') { S.resultShown = true; setTimeout(App.showResult, 600); }
    }
    // 交換で強い札を渡す番（決まりなので自動で）
    const a = TAB.prompt();
    if (a && a.kind === 'x' && !xSent[`${R.uid}:${a.n}`]) {
      xSent[`${R.uid}:${a.n}`] = 1;
      setTimeout(() => { const g = TAB.rep; if (TAB.prompt()) TAB.submit({ k: D.XFER, cards: D.strongest(g.hands[a.seat], a.k) }); }, 700);
    }
    if (TAB.rejected) { App.toast(TAB.rejected); TAB.T.rejected = ''; }
    autoAct(a);
    App.renderAll();
    if (App.isHumanTurn()) App.schedule();
  }
  const xSent = {};
  // 卓の手順を、画面の写しに順に入れる（演出つき。追いつくときは演出なし）
  function feed(quiet) {
    const mvs = TAB.mvs, R = TAB.state.R, me = TAB.mySeat();
    while (seen.fed < mvs.length) {
      if (App.busy && !quiet) { setTimeout(render, 150); return; }
      const st = R.steps[seen.fed], mv0 = mvs[seen.fed];
      // 自分が渡す・受け取る以外の、見えない移動の札は伏せる（ホストでも CPU の札を画面に入れない）
      let mv = mv0;
      const from = st.t === 'x' ? st.from : st.s, to = st.t === 'x' ? st.to : st.to;
      if ((st.t === 'x' || (mv0.k === D.PICK && to >= 0)) && from !== me && to !== me) mv = Object.assign({}, mv0, { cards: mv0.cards.map(() => -1), r: -1 });
      seen.fed++;
      if (st.t === 'x') App.applyXfer(from, to, mv.cards);
      else if (quiet) App.applyQuiet(mv);
      else { App.applyMove(mv); if (seen.fed < mvs.length) { setTimeout(render, 200); return; } }
    }
  }
  // 長く何もしないと自動で（パスできればパス、親なら弱い札から）
  let autoTimer = 0, autoKey = '';
  function autoAct(a) {
    const key = a && TAB.state.R ? `${TAB.state.R.uid}:${a.n}` : '';
    if (key === autoKey) return;
    autoKey = key;
    clearTimeout(autoTimer);
    if (!a || a.kind === 'x') return;
    autoTimer = setTimeout(() => {
      if (!TAB || !TAB.prompt()) return;
      const g = TAB.rep, L = g.legal();
      const mv = L.find(m => m.k === D.PASS) || A.chooseWeakest(g);
      App.toast('時間切れのため自動で出しました');
      TAB.submit(mv);
    }, 45000);
  }
  let lastPres = '';
  function presence(st, me) {
    if (!NET) return;
    const humans = st.seats.filter(x => x.k === 'h').length;
    const free = st.seats.some(x => x.k === 'c');
    const o = { s: free ? 'wait' : 'play', c: tableCode, m: tableCode, r: { n: humans, host: TAB.isHost ? 1 : 0, cpu: st.cfg.cpu }, rl: `${humans}/4人・CPU ${(LV.LEVELS[st.cfg.cpu] || {}).label || ''}` };
    const k = JSON.stringify(o);
    if (k !== lastPres) { lastPres = k; NET.setPresence(o); }
  }
  function showWaiting(st) {
    App.toast(TAB.isHost ? '卓を作りました。ほかの人を待つか、「始める」で CPU と始めます' : 'ホストが始めるのを待っています');
    $('dlg-online').hidden = false;
    renderLobby();
  }

  // ------------------------------------------------------------------ ロビー
  function renderBadge() {
    const b = $('btn-online');
    if (!b) return;
    const st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    // つながっていれば「対戦」（狭い画面でも消さない）、つながっていなければ「オンライン」
    b.querySelector('.lbl').textContent = st === 'on' || st === 'connecting' ? '対戦' : 'オンライン';
    b.querySelector('.cnt').innerHTML = TAB ? `卓<small> ${esc(tableCode)}</small>` : c ? `${c.online}人<small>・待ち${g.wait}</small>` : st === 'connecting' ? '…' : '';
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
    const st = NET ? NET.status : 'off';
    const c = NET && st === 'on' ? NET.counts() : null;
    const g = c && (c.byGame[GAME] || { wait: 0, play: 0 });
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
    let html = `
      <div class="on-stats">
        <div class="stat"><b>${c ? c.online : '—'}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${g ? g.wait : '—'}</b><span>大富豪の空き席のある卓の人</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（ほかの人に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（ほかの人に表示されます）</span><div class="on-ai" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="aitag ${aiFlag() ? 'on' : 'off'}">${aiFlag() ? 'AI補助あり' : 'AI補助なし'}</span><button class="btn small" data-act="ai">${aiFlag() ? 'オフにする' : 'オンにする'}</button><span class="hint">見込み・おすすめを出しているか、ヒントの回数がほかの人にも見えます</span></div></div>`;
    if (TAB && TAB.state) {
      const s = TAB.state, me = TAB.mySeat();
      const link = `${location.origin}${location.pathname}?table=${tableCode}`;
      const sv = s.seats.map((x, i) => `<div class="st"><span class="hint">${['席1', '席2', '席3', '席4'][i]}${i === me ? '（あなた）' : ''}</span><b>${x.k === 'h' ? esc(x.name) : `CPU（${(LV.LEVELS[x.lvl] || {}).label || ''}）`}</b>${x.k === 'h' && i !== me ? `<span class="aitag ${x.ai || x.hints ? 'on' : 'off'}">${x.ai ? 'AI補助あり' : 'AI補助なし'}${x.hints ? `・ヒント${x.hints}` : ''}</span>` : ''}${x.pid === s.host ? ' <span class="hint">ホスト</span>' : ''}</div>`).join('');
      html += `<div class="field"><span class="lab">卓 <b class="code">${esc(tableCode)}</b>　${s.phase === 'lobby' ? '始める前' : s.phase === 'round' ? `第${s.R ? s.R.no : ''}回戦の途中` : '回の合間'}</span>
          <div class="seats">${sv}</div>
          <span class="hint">空いた席は CPU が打ちます。途中から来た人は次の回から CPU の席を引き継ぎます。</span></div>
        <div class="field"><span class="lab">招待</span><span class="hint" style="word-break:break-all">${esc(link)}</span><div><button class="btn small" data-act="copy">招待リンクをコピー</button></div></div>
        <div class="actions" style="justify-content:flex-start">${TAB.isHost && s.phase === 'lobby' ? '<button class="btn primary" data-act="start">始める</button>' : ''}<button class="btn" data-act="leave">卓を離れる</button></div>`;
    } else if (TAB) {
      html += `<p class="on-msg">卓 ${esc(tableCode)} に入っています…（見つからないときは、ホストがいなくなったのかもしれません）</p><div class="actions" style="justify-content:flex-start"><button class="btn" data-act="leave">やめる</button></div>`;
    } else {
      const ts = tables();
      const r = App.cfg().rules;
      const local = D.RULE_LIST.filter(x => x.group === 'local' && r[x.key]).map(x => x.label);
      html += `<div class="field"><span class="lab">いまある卓（${ts.length}）</span><div class="on-list">${ts.length ? ts.map(t => `<div class="on-row"><b>${esc(t.host || t.people[0])}さんの卓</b><span class="hint">${esc(t.rl || `${t.people.length}/4人`)}</span>${t.open ? `<button class="btn small primary" data-join="${esc(t.code)}">座る</button>` : '<span class="hint">満席</span>'}</div>`).join('') : '<p class="hint" style="margin:0">いまはありません。下で卓を作れます。</p>'}</div></div>
        <div class="field"><span class="lab">卓を作る（空いた席は CPU）</span>
          ${seg('cpu', LV.KEYS.map(k => [k, LV.LEVELS[k].label]), lobby.cpu)}
          ${seg('games', [[3, '3回戦'], [5, '5回戦'], [10, '10回戦'], [0, '制限なし']], lobby.games)}
          <span class="hint">ルール: ジョーカー${r.jokers}枚・${local.length ? `ローカルルール ${local.join('・')}` : '基本のルールだけ'}（「新しい対局」の設定と同じ）</span>
          <div><button class="btn primary" data-act="create"${st === 'on' ? '' : ' disabled'}>この設定で卓を作る</button></div></div>`;
    }
    html += `<p class="hint" style="margin:6px 0 0">配る札はメンタルポーカーで混ぜるので、ホストも含めてだれもほかの人の手札を知りません（CPU の席の札だけはホストの端末が開きます）。公開の中継サーバーを使うため、名前と出した札はほかの人からも見える可能性があります。</p>`;
    body.innerHTML = html;
  }
  function code4() { const A2 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += A2[Math.floor(Math.random() * A2.length)]; return s; }

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
    if (segEl) { lobby[segEl.dataset.seg] = segEl.dataset.seg === 'games' ? Number(b.dataset.v) : b.dataset.v; renderLobby(); return; }
    if (b.dataset.join) { lobby.msg = ''; openTable(b.dataset.join, null); return; }
    const act = b.dataset.act;
    if (act === 'ai') { const on = !App.aiOn(); App.settings.showProb = on; App.settings.showBest = on; store.set('settings', App.settings); online.setAI(on ? 1 : 0); App.renderAll(); renderLobby(); }
    else if (act === 'create') { const c = App.cfg(); openTable(code4(), { cfg: { rules: D.normRules(c.rules), games: lobby.games, cpu: lobby.cpu } }); }
    else if (act === 'start') { if (TAB) { TAB.startRound(); $('dlg-online').hidden = true; } }
    else if (act === 'leave') { leaveTable(false); renderLobby(); }
    else if (act === 'copy') {
      const link = `${location.origin}${location.pathname}?table=${tableCode}`;
      try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
    }
  });
  $('dlg-online').addEventListener('change', e => {
    if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); if (TAB) TAB.ctl('join', { name: myName, ai: aiFlag() }); }
  });

  // はじめ: 招待リンク・再読み込みで卓に戻る
  const q = new URLSearchParams(location.search).get('table');
  const back = ss.get('table', null);
  if (ONLINE_OK) {
    net();
    renderBadge();
    if (q) { history.replaceState(null, '', location.pathname); openTable(q.toUpperCase().slice(0, 8), null); openLobby(); }
    else if (back) openTable(back, null);
  } else if (q) openLobby();
  setInterval(() => { renderBadge(); if (TAB) render(); }, 5000);
})();
