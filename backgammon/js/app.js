/* バックギャモン Webアプリ: 盤の操作・CPU（Web Worker）・AI補助（勝率・キューブ・おすすめの手）・振り返り・オンライン */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const WTS = window.BG_WEIGHTS;
  if (WTS && WTS.param) Object.assign(BGAI.PARAM, WTS.param);
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SIDE = ['白', '黒'], COLOR = ['w', 'b'];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
  const sgn = (v, d = 3) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '読まずに、ときどき迷いながら動かします', ply: 0, noise: 0.25, cubePly: 0 },
    normal: { label: 'ふつう', stars: 2, desc: '学習したネットの見立てだけで、すぐ動かします', ply: 0, noise: 0, cubePly: 0 },
    strong: { label: 'つよい', stars: 3, desc: '相手のサイコロ21通りを読んでから動かします', ply: 1, noise: 0, cubePly: 1 },
    max: { label: '最強', stars: 4, desc: '自分と相手のサイコロを2回先まで読みます（複数スレッド）', ply: 2, noise: 0, cubePly: 2 },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  // ?ns=名前 で保存場所を分けられる（同じブラウザの2つのタブで、別々の端末としてオンラインを試すため）
  const NSP = (new URLSearchParams(location.search).get('ns') || '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
  const PFX = 'bg-' + (NSP ? NSP + '-' : '');
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(PFX + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let draft = Object.assign({ mode: 'cpu', cpu: 'normal', cpuW: 'strong', cpuB: 'max', len: 5, cube: 'on' }, store.get('cfg', {}));
  const settings = Object.assign({ sound: true, anim: true, arrow: true, showEval: true, autoroll: true, autoconfirm: false, mirror: false, numbers: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.arrow;
  const animOn = () => settings.anim && !reduceMotion && !document.hidden; // 裏のタブではタイマーが間引かれるので動かさない

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    cfg: { len: 5, cube: true, jacoby: false, beaver: false }, mode: 'cpu', seats: ['human', 'normal'],
    games: [{ actions: [] }], starts: [], gi: 0, st: null,
    bottom: 0, pm: null, sel: null, dests: null, chooser: null, anim: null, rolling: null,
    view: null, busy: false, thinking: false, timer: 0, epoch: 0, hint: null, msg: '',
    evals: {}, errs: {}, resultShown: false, online: null,
  };
  const isCPU = s => !!CPU[S.seats[s]];
  const isHuman = s => S.seats[s] === 'human';
  const isRemote = s => S.seats[s] === 'remote';
  const actorOf = st => (st.phase === 'doubled' ? st.turn ^ 1 : st.turn);
  const live = () => !S.view;
  const diceList = d => (d[0] === d[1] ? [d[0], d[0], d[0], d[0]] : [d[0], d[1]]);
  const seatName = s => (isCPU(s) ? `CPU（${CPU[S.seats[s]].label}）` : isRemote(s) ? (S.online ? `${S.online.opp.name}さん` : '相手') : (S.mode === 'pvp' ? `${SIDE[s]}の人` : 'あなた'));
  const youSide = () => (S.mode === 'cpu' || S.online ? (isHuman(0) ? 0 : 1) : S.bottom);
  // 下側から見た場所（slot）と、手番側から見た番号の変換
  const slotOf = (side, i) => (i === 24 ? (side === S.bottom ? 24 : 25) : i < 0 ? (side === S.bottom ? 26 : 27) : (side === S.bottom ? i : 23 - i));
  function idxOf(side, slot) {
    if (slot === 24) return side === S.bottom ? 24 : null;
    if (slot === 25) return side === S.bottom ? null : 24;
    if (slot === 26) return side === S.bottom ? -1 : null;
    if (slot === 27) return side === S.bottom ? null : -1;
    return side === S.bottom ? slot : 23 - slot;
  }
  const ctxOf = st => ({ cfg: S.cfg, score: st.score.slice(), cube: st.cube, owner: st.owner, crawford: st.crawford, turn: st.turn, phase: 'turn', rollNow: false });

  function recompute() {
    S.starts = BG.matchStarts(S.cfg, S.games);
    S.st = BG.replay(S.cfg, S.starts[S.gi], S.games[S.gi].actions);
  }
  const matchScore = () => (S.st.phase === 'over' ? S.st.score : S.starts[S.gi].score);
  const matchDone = () => S.st.phase === 'over' && (S.cfg.single || BG.matchOver(S.cfg, S.st.score));

  // ------------------------------------------------------------------ 読みの手伝い（Web Worker）
  function Pool(name) { this.ws = []; this.id = 0; this.wait = new Map(); this.name = name; }
  Pool.prototype.worker = function (i) {
    while (this.ws.length <= i) {
      const w = new Worker('js/ai-worker.js');
      w.onmessage = e => { const m = e.data, r = this.wait.get(m.id); if (r) { this.wait.delete(m.id); r(m); } };
      w.onerror = e => { console.error(this.name, e.message); };
      this.ws.push(w);
    }
    return this.ws[i];
  };
  Pool.prototype.run = function (job, i) {
    const id = ++this.id;
    return new Promise(res => { this.wait.set(id, res); this.worker(i || 0).postMessage(Object.assign({ id }, job)); });
  };
  Pool.prototype.reset = function () {
    if (!this.wait.size) return;
    this.ws.forEach(w => w.terminate()); this.ws = [];
    this.wait.forEach(r => r({ type: 'cancel' })); this.wait.clear();
  };
  const CPUP = new Pool('cpu'), ANP = new Pool('analysis');
  const arr = a => Array.from(a);

  // ------------------------------------------------------------------ 音（WebAudio で合成。木の駒・革の盤・サイコロ）
  let actx = null;
  function snd(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime;
      const knock = (at, freq, q, gain, len) => {
        const n = Math.floor(actx.sampleRate * len), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
        const src = actx.createBufferSource(); src.buffer = buf;
        const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
        const g = actx.createGain(); g.gain.setValueAtTime(gain, at);
        src.connect(bp).connect(g).connect(actx.destination); src.start(at);
      };
      const tone = (at, f0, f1, gain, len) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + len);
        g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.001, at + len);
        o.connect(g).connect(actx.destination); o.start(at); o.stop(at + len + 0.02);
      };
      if (kind === 'move') { knock(t, 900, 2.4, 1.2, 0.05); tone(t, 180, 80, 0.3, 0.08); }
      else if (kind === 'hit') { knock(t, 1300, 2, 1.6, 0.05); knock(t + 0.05, 800, 2, 0.9, 0.05); tone(t, 240, 90, 0.35, 0.1); }
      else if (kind === 'off') { knock(t, 600, 1.5, 0.8, 0.09); }
      else if (kind === 'roll') { for (let i = 0; i < 7; i++) knock(t + i * 0.055 + Math.random() * 0.02, 2400 + Math.random() * 1200, 3, 0.45, 0.025); }
      else if (kind === 'land') { knock(t, 1900, 3, 1.0, 0.03); knock(t + 0.07, 2100, 3, 0.8, 0.03); }
      else if (kind === 'cube') { knock(t, 500, 1.6, 1.5, 0.07); tone(t, 140, 70, 0.4, 0.12); }
      else if (kind === 'win') { [523, 659, 784].forEach((f, i) => tone(t + i * 0.12, f, f * 0.99, 0.12, 0.3)); }
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ サイコロ（ひとりの対局・CPU 戦は端末の乱数。オンラインは online-bg.js の方式）
  function rollDie() {
    const a = new Uint8Array(1);
    for (;;) { crypto.getRandomValues(a); if (a[0] < 252) return 1 + (a[0] % 6); }
  }
  // 振るアニメーション（目をぱらぱら変えて止める）
  async function rollAnim(final, opening) {
    const groups = opening ? [{ side: 'bottom' }, { side: 'top' }] : [{ side: S.st.turn === S.bottom ? 'bottom' : 'top' }];
    snd('roll');
    if (animOn()) {
      const t0 = performance.now();
      while (performance.now() - t0 < 520) {
        S.rolling = groups.map(g => ({ side: g.side, vals: opening ? [1 + Math.floor(Math.random() * 6)] : [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)], rot: [Math.random() * 40 - 20, Math.random() * 40 - 20] }));
        renderBoard();
        await sleep(65);
      }
    }
    S.rolling = null;
    snd('land');
    void final;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 進行のための待ち。裏のタブではタイマーが大きく間引かれる（1分に1回まで）ので、見ていないときはすぐ進める
  const later = (fn, ms) => (document.hidden ? (Promise.resolve().then(fn), 0) : setTimeout(fn, ms));

  // ------------------------------------------------------------------ 対局の進行
  function newMatch(c) {
    leaveOnline();
    draft = c; store.set('cfg', draft);
    const cube = c.cube !== 'off';
    const cfg = { len: Number(c.len) || 0, cube, jacoby: !Number(c.len) && cube, beaver: c.cube === 'beaver' && !Number(c.len) };
    let seats;
    if (c.mode === 'pvp') seats = ['human', 'human'];
    else if (c.mode === 'watch') seats = [c.cpuW, c.cpuB];
    else seats = ['human', c.cpu];
    loadMatch({ cfg, mode: c.mode, seats, games: [{ actions: [] }], gi: 0, bottom: 0 });
  }
  function loadMatch(m) {
    S.epoch++; CPUP.reset(); ANP.reset(); clearTimeout(S.timer);
    S.cfg = m.cfg; S.mode = m.mode; S.seats = m.seats; S.games = m.games; S.gi = m.gi; S.bottom = m.bottom || 0;
    S.online = m.online || null;
    S.evals = m.evals || {}; S.errs = m.errs || {};
    S.pm = null; S.sel = null; S.dests = null; S.view = null; S.busy = false; S.thinking = false; S.anim = null; S.rolling = null; S.hint = null; S.msg = '';
    AN.cache.clear(); AN.running = null;
    hideChooser();
    recompute();
    S.resultShown = S.st.phase === 'over';
    save(); render(); schedule();
  }
  function save() {
    const online = S.online ? { mid: S.online.mid, mySide: S.online.mySide, opp: S.online.opp, myHints: S.online.myHints, secrets: S.online.secrets, reveals: S.online.reveals, anchors: S.online.anchors } : null;
    store.set('game', { cfg: S.cfg, mode: S.mode, seats: S.seats, games: S.games, gi: S.gi, bottom: S.bottom, evals: S.evals, errs: S.errs, online });
    if (S.online) saveOnline();
  }
  // 行動を1つ進める（確かめてから）
  function push(a) {
    const st2 = BG.cloneState(S.st);
    BG.act(st2, a);
    S.games[S.gi].actions.push(a);
    S.st = st2;
    if (st2.phase === 'over') S.starts = BG.matchStarts(S.cfg, S.games);
    S.hint = null;
    save();
  }
  // 次の局へ（マッチの途中・マネーの続き）
  function nextGame() {
    if (S.st.phase !== 'over' || matchDone()) return;
    if (S.online) { onlineNextGame(); return; }
    S.games.push({ actions: [] });
    S.gi = S.games.length - 1;
    S.view = null; S.resultShown = false;
    recompute(); save(); render(); schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    if (S.view || S.busy) { render(); return; }
    if (!S.online && !$('dlg-new').hidden) { render(); return; } // 新しい対局の設定中は進めない（オンラインは止めない）
    const st = S.st;
    if (st.phase === 'over') { onGameOver(); render(); return; }
    if (S.online) { onlineSchedule(); return; }
    if (st.phase === 'open') { const ep = S.epoch; S.timer = later(() => { if (ep === S.epoch) doRoll(true); }, S.games[S.gi].actions.length ? 700 : 450); render(); return; }
    const actor = actorOf(st);
    if (isCPU(actor)) { cpuAct(); return; }
    if (st.phase === 'turn') {
      if (settings.autoroll && (!BG.canDouble(st) || BG.mustRoll(st))) { const ep = S.epoch; S.timer = later(() => { if (ep === S.epoch && S.st.phase === 'turn') doRoll(false); }, 380); render(); return; }
      render(); analyzeNow(); return;
    }
    if (st.phase === 'move') { beginHumanMove(); return; }
    if (st.phase === 'doubled') { render(); analyzeNow(); return; }
  }

  async function doRoll(opening) {
    if (S.busy || S.view) return;
    const ep = S.epoch;
    S.busy = true;
    const d = [rollDie(), rollDie()];
    await rollAnim(d, opening);
    S.busy = false;
    if (ep !== S.epoch) return;
    push(opening ? { a: 'open', d } : { a: 'roll', d });
    if (opening && d[0] === d[1]) S.msg = `${d[0]} と ${d[1]} の同じ目なので振り直し`;
    else if (opening) S.msg = `${SIDE[0]} ${d[0]}・${SIDE[1]} ${d[1]} → ${seatName(S.st.turn)}（${SIDE[S.st.turn]}）が先手`;
    else S.msg = '';
    render(); schedule();
  }

  // 人の番: 動かせる手の一覧を作って待つ。1通りしかなければ自動で
  function beginHumanMove() {
    const st = S.st, side = st.turn;
    const legal = BG.legalMoves(st.b[side], st.b[side ^ 1], st.dice[0], st.dice[1]);
    S.pm = { side, legal, me: Int8Array.from(st.b[side]), opp: Int8Array.from(st.b[side ^ 1]), dice: diceList(st.dice), hops: [], need: legal[0].hops.length, forced: legal.length === 1 };
    clearSel();
    render();
    if (S.pm.forced) {
      const ep = S.epoch;
      S.timer = later(async () => {
        if (ep !== S.epoch || !S.pm) return;
        const hops = legal[0].hops;
        if (hops.length) await playRoute(hops.map(h => [h[0], h[1], h[2], null]), true);
        if (ep !== S.epoch || !S.pm) return;
        confirmMove();
      }, legal[0].hops.length ? 700 : 1500);
      return;
    }
    analyzeNow();
  }
  const pmComplete = () => S.pm && S.pm.hops.length >= S.pm.need;
  function nextHopsPM(pm, me, opp, dice, used) { return BG.nextHops(pm.legal, { me: me || pm.me, opp: opp || pm.opp, dice: dice || pm.dice, used: used == null ? pm.hops.length : used }); }
  function sourcesPM() { const s = new Set(); if (!S.pm || S.pm.forced) return s; for (const h of nextHopsPM(S.pm)) s.add(h.from); return s; }
  // 選んだ駒の行き先（1つの目・続けて2つ以上の目）。Map(行き先の番号 → 手順の一覧)
  function routesFrom(from) {
    const pm = S.pm, out = new Map();
    (function dfs(me, opp, dice, used, pos, route) {
      for (const h of nextHopsPM(pm, me, opp, dice, used)) {
        if (h.from !== pos) continue;
        const r2 = route.concat([[h.from, h.to, h.hit, h.die]]);
        if (!out.has(h.to)) out.set(h.to, []);
        out.get(h.to).push(r2);
        if (h.to >= 0 && dice.length > 1) {
          const m2 = Int8Array.from(me), o2 = Int8Array.from(opp);
          BG.applyHop(m2, o2, h.from, h.to);
          const rest = dice.slice(); rest.splice(rest.indexOf(h.die), 1);
          dfs(m2, o2, rest, used + 1, h.to, r2);
        }
      }
    })(pm.me, pm.opp, pm.dice, pm.hops.length, from, []);
    return out;
  }
  function select(from) {
    if (S.sel === from) { clearSel(); render(); return; }
    S.sel = from; S.dests = routesFrom(from);
    hideChooser();
    render();
  }
  function clearSel() { S.sel = null; S.dests = null; hideChooser(); }
  // 行き先を押した: 目の使い方が1通り（最短で、ヒットの仕方が同じ）ならすぐ、違うなら小さな選択
  function chooseDest(to) {
    const routes = S.dests.get(to);
    if (!routes) return;
    const minLen = Math.min(...routes.map(r => r.length));
    const short = routes.filter(r => r.length === minLen);
    const groups = new Map();
    for (const r of short) { const sig = r.map(h => (h[2] ? h[1] : '')).join(','); if (!groups.has(sig)) groups.set(sig, r); }
    if (groups.size === 1) { playRoute(short[0]); return; }
    showChooser(to, [...groups.values()]);
  }
  function routeText(r) {
    const dice = r.map(h => h[3]).join(' → ');
    const hits = r.filter(h => h[2]).map(h => BG.ptName(h[1]));
    return `${dice} の順${hits.length ? `（${hits.join('・')} でヒット）` : '（ヒットしない）'}`;
  }
  function showChooser(to, routes) {
    const c = $('chooser');
    c.innerHTML = `<div class="ttl">${esc(BG.ptName(S.sel))} → ${esc(BG.ptName(to))}：目の使い方</div>` +
      routes.map((r, i) => `<button data-r="${i}">${esc(routeText(r))}</button>`).join('') + '<button class="quiet" data-r="x">やめる</button>';
    c.hidden = false;
    S.chooser = routes;
    const wrap = $('board-wrap').getBoundingClientRect();
    const [x, y] = board.slotXY(slotOf(S.pm.side, to), 0);
    const px = x / board.W * wrap.width, py = y / board.H * wrap.height;
    c.style.left = Math.max(4, Math.min(wrap.width - c.offsetWidth - 4, px - c.offsetWidth / 2)) + 'px';
    c.style.top = Math.max(4, Math.min(wrap.height - c.offsetHeight - 4, py < wrap.height / 2 ? py + 20 : py - c.offsetHeight - 20)) + 'px';
  }
  function hideChooser() { const c = $('chooser'); if (c) c.hidden = true; S.chooser = null; }
  // 手順を1歩ずつ（アニメーションしながら）途中の局面に足す
  async function playRoute(route, forced) {
    const pm = S.pm, ep = S.epoch;
    if (!pm) return;
    S.busy = true; clearSel();
    for (const [f, t, , die] of route) {
      await animHop(pm.side, f, t, pm.me, pm.opp);
      if (ep !== S.epoch) return;
      const hit = BG.applyHop(pm.me, pm.opp, f, t);
      pm.hops.push([f, t, hit]);
      const d = die != null ? die : pm.dice.find(x => BG.hopTarget(pm.me, pm.opp, f, x) === t) || pm.dice[0];
      const j = pm.dice.indexOf(die != null ? die : d); pm.dice.splice(j >= 0 ? j : 0, 1);
      snd(hit ? 'hit' : t < 0 ? 'off' : 'move');
      renderBoard(); renderInfo();
    }
    S.busy = false;
    render();
    if (!forced && pmComplete() && settings.autoconfirm) setTimeout(() => { if (S.pm && pmComplete() && !S.busy) confirmMove(); }, 250);
  }
  function undoHop() {
    const pm = S.pm;
    if (!pm || !pm.hops.length || S.busy || pm.forced) return;
    const keep = pm.hops.slice(0, -1);
    const st = S.st;
    pm.me = Int8Array.from(st.b[pm.side]); pm.opp = Int8Array.from(st.b[pm.side ^ 1]); pm.dice = diceList(st.dice); pm.hops = [];
    const r = BG.checkHops(pm.me, pm.opp, st.dice, keep.map(h => [h[0], h[1]]));
    if (r) {
      pm.me = r.me; pm.opp = r.opp; pm.hops = r.hops;
      // 使った目を引く
      const left = diceList(st.dice), m0 = Int8Array.from(st.b[pm.side]), o0 = Int8Array.from(st.b[pm.side ^ 1]);
      for (const [f, t] of r.hops) { const j = left.findIndex(d => BG.hopTarget(m0, o0, f, d) === t); left.splice(j >= 0 ? j : 0, 1); BG.applyHop(m0, o0, f, t); }
      pm.dice = left;
    }
    clearSel(); snd('move'); render();
  }
  function confirmMove() {
    const pm = S.pm;
    if (!pm || !pmComplete() || S.busy) return;
    const hops = pm.hops.map(h => [h[0], h[1]]);
    const before = S.st, gi = S.gi, n = S.games[S.gi].actions.length;
    S.pm = null; clearSel();
    try { push({ a: 'move', h: hops }); } catch (e) { console.error(e); S.msg = 'その手は指せません'; beginHumanMove(); return; }
    recordHumanMove(before, gi, n, hops);
    if (S.online) onlineSendAct({ a: 'move', h: hops });
    render(); schedule();
  }

  // 1歩のアニメーション（動かす駒は元の場所から先に消して、山なりに飛ばす。ヒットした駒はバーへ）
  async function animHop(side, f, t, me, opp) {
    if (!animOn()) return;
    const m = Int8Array.from(me), o = Int8Array.from(opp);
    const k1 = Math.max(0, m[f] - 1);
    m[f]--;
    const hitting = t >= 0 && o[23 - t] === 1;
    S.anim = { side, me: m, opp: o, flying: true };
    renderBoard();
    const k2 = t < 0 ? 0 : hitting ? 0 : m[t];
    await board.animate(slotOf(side, f), k1, slotOf(side, t), k2, COLOR[side], 230);
    if (hitting) {
      m[t]++; o[23 - t] = 0;
      S.anim = { side, me: m, opp: o, flying: false, flyOpp: true };
      renderBoard();
      await board.animate(slotOf(side ^ 1, 23 - t), 0, slotOf(side ^ 1, 24), o[24], COLOR[side ^ 1], 200);
    }
    S.anim = null;
  }
  async function animateHops(side, hops) {
    const st = S.st, me = Int8Array.from(st.b[side]), opp = Int8Array.from(st.b[side ^ 1]);
    for (const [f, t] of hops) {
      await animHop(side, f, t, me, opp);
      const hit = BG.applyHop(me, opp, f, t);
      S.anim = { side, me, opp };
      snd(hit ? 'hit' : t < 0 ? 'off' : 'move');
      renderBoard();
      if (animOn()) await sleep(70);
    }
    S.anim = null;
  }

  // ------------------------------------------------------------------ CPU
  async function cpuAct() {
    const ep = S.epoch, st = S.st, actor = actorOf(st), lv = CPU[S.seats[actor]];
    S.thinking = true; render();
    const t0 = Date.now();
    const wait = async ms => { const d = ms - (Date.now() - t0); if (d > 0) await sleep(d); };
    if (st.phase === 'turn') {
      let dbl = false;
      if (BG.canDouble(st) && !BG.mustRoll(st)) {
        const r = await CPUP.run({ type: 'cube', me: arr(st.b[st.turn]), opp: arr(st.b[st.turn ^ 1]), ply: lv.cubePly, ctx: ctxOf(st) });
        if (ep !== S.epoch || r.type !== 'cube') return;
        dbl = !!r.dec.double;
        if (lv === CPU.easy) dbl = r.dec.double ? Math.random() < 0.7 : r.p[0] > 0.62 && Math.random() < 0.25;
      }
      await wait(dbl ? 600 : 250);
      if (ep !== S.epoch) return;
      S.thinking = false;
      if (dbl) { push({ a: 'double' }); snd('cube'); S.msg = ''; render(); schedule(); }
      else await doRoll(false);
    } else if (st.phase === 'move') {
      const legal = BG.legalMoves(st.b[st.turn], st.b[st.turn ^ 1], st.dice[0], st.dice[1]);
      let pick;
      if (legal.length === 1) { await wait(legal[0].hops.length ? 450 : 1100); pick = { hops: legal[0].hops, p: null }; }
      else {
        pick = await cpuChooseMove(st, lv, ep);
        if (ep !== S.epoch || !pick) return;
        await wait(500);
      }
      if (ep !== S.epoch) return;
      S.thinking = false;
      const gi = S.gi, n = S.games[S.gi].actions.length;
      await animateHops(st.turn, pick.hops);
      if (ep !== S.epoch) return;
      push({ a: 'move', h: pick.hops.map(h => [h[0], h[1]]) });
      if (pick.p) S.evals[`${gi}:${n + 1}`] = st.turn === 0 ? pick.p[0] : 1 - pick.p[0];
      save(); render(); schedule();
    } else if (st.phase === 'doubled') {
      const r = await CPUP.run({ type: 'cube', me: arr(st.b[st.turn]), opp: arr(st.b[st.turn ^ 1]), ply: lv.cubePly, ctx: ctxOf(st) });
      if (ep !== S.epoch || r.type !== 'cube') return;
      await wait(800);
      if (ep !== S.epoch) return;
      S.thinking = false;
      let take = r.dec.take;
      if (lv === CPU.easy) take = r.p[0] < 0.8 ? Math.random() < 0.85 : Math.random() < 0.3;
      const beaver = take && r.dec.beaver && BG.canBeaver(S.st);
      push({ a: beaver ? 'beaver' : take ? 'take' : 'pass' });
      snd('cube');
      S.msg = `${seatName(actor)}は${beaver ? 'ビーバー（すぐに2倍に返す）' : take ? 'テイク' : 'パス'}`;
      render(); schedule();
    }
  }
  async function cpuChooseMove(st, lv, ep) {
    const base = { me: arr(st.b[st.turn]), opp: arr(st.b[st.turn ^ 1]), d1: st.dice[0], d2: st.dice[1], ctx: ctxOf(st) };
    if (lv.ply < 2 || THREADS < 2) {
      const r = await CPUP.run(Object.assign({ type: 'moves', ply: lv.ply, noise: lv.noise, top: 4 }, base));
      return r.type === 'moves' ? r.list[0] : null;
    }
    // 最強: 1手読みで上位を選び、2手読みを複数のスレッドで手分けする
    const r1 = await CPUP.run(Object.assign({ type: 'moves', ply: 1, top: 6, prune1: 10 }, base));
    if (ep !== S.epoch || r1.type !== 'moves') return null;
    const top = r1.list[0].v, cands = r1.list.filter((c, i) => i < 5 && (i < 2 || top - c.v < (BG.isMoney(S.cfg) ? 0.16 : 0.03)));
    if (cands.length <= 1) return r1.list[0];
    const parts = Array.from({ length: Math.min(THREADS, cands.length) }, () => []);
    cands.forEach((c, i) => parts[i % parts.length].push(c.key));
    const rs = await Promise.all(parts.map((keys, i) => CPUP.run(Object.assign({ type: 'evalMoves', keys, ply: 2 }, base), i)));
    if (ep !== S.epoch || rs.some(r => r.type !== 'evalMoves')) return null;
    let best = null;
    for (const r of rs) for (const c of r.list) if (!best || c.v > best.v) best = c;
    return best;
  }

  // ------------------------------------------------------------------ 人の操作: ダブル・振る・テイク・パス・待った・投了
  function humanCanAct() { return live() && !S.busy && S.st && S.st.phase !== 'over' && isHuman(actorOf(S.st)); }
  function offerDouble() {
    if (!humanCanAct() || S.st.phase !== 'turn' || !BG.canDouble(S.st) || BG.mustRoll(S.st)) return;
    push({ a: 'double' }); snd('cube');
    if (S.online) onlineSendAct({ a: 'double' });
    S.msg = ''; render(); schedule();
  }
  function humanRoll() {
    if (!humanCanAct() || S.st.phase !== 'turn') return;
    if (S.online) { onlineRoll(); return; }
    doRoll(false);
  }
  function respond(kind) {
    if (!humanCanAct() || S.st.phase !== 'doubled') return;
    if (kind === 'beaver' && !BG.canBeaver(S.st)) return;
    push({ a: kind }); snd('cube');
    if (S.online) onlineSendAct({ a: kind });
    S.msg = ''; render(); schedule();
  }
  // 待った: 人が最後に動かす前（サイコロはそのまま）に戻す
  function undo() {
    if (S.online || S.view || S.busy) return;
    if (S.pm && S.pm.hops.length) { undoHop(); return; }
    const acts = S.games[S.gi].actions;
    let k = -1;
    for (let i = acts.length - 1; i >= 0; i--) {
      const st = BG.replay(S.cfg, S.starts[S.gi], acts, i);
      const who = acts[i].a === 'take' || acts[i].a === 'pass' || acts[i].a === 'beaver' ? st.turn ^ 1 : st.turn;
      if (isHuman(who) && ['move', 'double', 'take', 'pass', 'beaver'].includes(acts[i].a)) { k = i; break; }
    }
    if (k < 0) return;
    S.epoch++; CPUP.reset(); clearTimeout(S.timer);
    acts.length = k;
    S.pm = null; clearSel(); S.anim = null; S.thinking = false; S.busy = false; S.msg = '一手戻しました（サイコロはそのまま）';
    for (const key of Object.keys(S.evals)) { const [g, n] = key.split(':').map(Number); if (g === S.gi && n > k) delete S.evals[key]; }
    dropAnalysisAfter(S.gi, k);
    recompute(); S.resultShown = false; save(); render(); schedule();
  }

  // ------------------------------------------------------------------ 終局
  function onGameOver() {
    const st = S.st;
    if (S.resultShown) return;
    S.resultShown = true;
    const you = youSide(), won = st.winner === you;
    if (S.mode !== 'watch' && won) snd('win');
    // 観戦はマッチが終わるまで自動で次の局へ
    if (S.mode === 'watch' && !matchDone()) { const ep = S.epoch; setTimeout(() => { if (S.st === st && live() && ep === S.epoch) nextGame(); }, 2600); return; }
    setTimeout(() => { if (S.st === st && live()) showResult(); }, 700);
  }
  function kindText(st) { return st.reason === 'pass' ? 'パス' : st.reason === 'resign' ? `投了（${['', 'シングル', 'ギャモン', 'バックギャモン'][st.kind]}）` : st.kind === 3 ? 'バックギャモン' : st.kind === 2 ? 'ギャモン' : 'シングル'; }
  function showResult() {
    const st = S.st, done = matchDone(), you = youSide();
    const winner = seatName(st.winner);
    const sc = st.score;
    $('rs-sub').textContent = BG.isMoney(S.cfg) ? (S.cfg.single ? 'マネーゲーム（1局）' : `マネーゲーム 第${S.gi + 1}局`) : `${S.cfg.len}点マッチ 第${S.gi + 1}局`;
    let title;
    if (S.mode === 'cpu' || S.online) title = done && !BG.isMoney(S.cfg) ? (sc[you] >= S.cfg.len ? 'マッチの勝ち' : 'マッチの負け') : (st.winner === you ? '勝ち' : '負け');
    else title = `${SIDE[st.winner]}の勝ち`;
    $('rs-title').textContent = title;
    $('rs-body').innerHTML = `${esc(winner)}が<b>${esc(kindText(st))}</b>で <b>${st.points}点</b>（キューブ ${st.cube}）。<br>` +
      (BG.isMoney(S.cfg) ? `通算: ${SIDE[0]} ${sc[0]} − ${SIDE[1]} ${sc[1]}` : `スコア: ${SIDE[0]} ${sc[0]} − ${SIDE[1]} ${sc[1]}（${S.cfg.len}点先取）${done ? '' : '。次の局へ進めます'}`);
    $('rs-again').textContent = done ? 'もう一局' : '次の局へ';
    $('dlg-result').hidden = false;
  }

  // ------------------------------------------------------------------ 投了
  let resignKind = 1;
  function openResign() {
    const st = S.st;
    if (!st || st.phase === 'over' || S.view) return;
    const you = S.mode === 'pvp' ? actorOf(st) : youSide();
    if (!isHuman(you)) return;
    $('rg-kind').innerHTML = [1, 2, 3].map(v => `<button data-v="${v}" aria-pressed="${v === resignKind}">${['', 'シングル', 'ギャモン', 'バックギャモン'][v]}（${BG.gamePoints(st, v)}点）</button>`).join('');
    $('rg-msg').textContent = '';
    $('dlg-resign').hidden = false;
    $('dlg-resign').dataset.side = you;
  }
  async function doResign() {
    const st = S.st, you = Number($('dlg-resign').dataset.side), opp = you ^ 1, v = resignKind;
    if (S.online) { onlineOfferResign(v); $('dlg-resign').hidden = true; return; }
    if (isCPU(opp)) {
      // CPU は、受けたほうが得なら受ける（今の局面の見立てと比べる）
      $('rg-msg').textContent = 'CPU が考えています…';
      const roll = st.phase === 'doubled' || st.phase === 'turn' || st.phase === 'open' ? st.turn : st.turn;
      const r = await ANP.run({ type: 'cube', me: arr(st.b[roll]), opp: arr(st.b[roll ^ 1]), ply: 1, ctx: ctxOf(st) });
      if (r.type !== 'cube') return;
      const p = roll === opp ? r.p : BGNet.flip(r.p, new Float32Array(5));
      const metric = BGAI.metricFor(ctxOf(Object.assign({}, st, { turn: opp })), opp);
      const playOn = metric(p);
      const sp = new Float32Array([1, v >= 2 ? 1 : 0, v >= 3 ? 1 : 0, 0, 0]);
      const accept = metric(sp) >= playOn - 1e-3;
      if (!accept) { $('rg-msg').textContent = 'CPU は断りました（続けたほうが多く取れると見ています）'; return; }
    }
    $('dlg-resign').hidden = true;
    S.epoch++; CPUP.reset(); clearTimeout(S.timer); S.pm = null; clearSel(); S.busy = false; S.thinking = false;
    push({ a: 'resign', s: you, v });
    render(); schedule();
  }

  // ------------------------------------------------------------------ AI補助（形勢・キューブ・おすすめの手）とヒント
  const AN = { cache: new Map(), cur: null, running: null };
  // 局面が変わった（待った・指し直し）ところより先の読み・印は捨てる
  function dropAnalysisAfter(gi, n) {
    for (const key of [...AN.cache.keys()]) { const [g, k] = key.split(':').map(Number); if (g > gi || (g === gi && k >= n)) AN.cache.delete(key); }
    for (const tbl of [S.evals, S.errs]) for (const key of Object.keys(tbl)) { const [g, k] = key.split(':').map(Number); if (g > gi || (g === gi && k > n)) delete tbl[key]; }
  }
  // いま見ている局面（生きている局面か、見返し中の局面）
  function shownState() {
    if (live()) return { st: S.st, gi: S.gi, n: S.games[S.gi].actions.length };
    const { gi, n } = S.view;
    return { st: BG.replay(S.cfg, S.starts[gi], S.games[gi].actions, n), gi, n };
  }
  function anaKey(gi, n) { return `${gi}:${n}`; }
  async function analyzeNow(force, deep) {
    if (!force && !settings.showEval && !settings.arrow) return;
    const { st, gi, n } = shownState();
    if (!st || st.phase === 'over' || st.phase === 'open') { renderSide(); return; }
    if (live() && isCPU(actorOf(st)) && !force) { renderSide(); return; }
    if (live() && S.online && isRemote(actorOf(st)) && !force) { renderSide(); return; }
    const key = anaKey(gi, n), have = AN.cache.get(key);
    const want = deep ? 2 : 1;
    if (have && have.ply >= want) { renderAll(); return; }
    if (AN.running === key + ':' + want) return;
    AN.running = key + ':' + want;
    const r = await analyze(st, want);
    AN.running = null;
    if (!r) return;
    const prev = AN.cache.get(key);
    if (!prev || prev.ply <= r.ply) AN.cache.set(key, r);
    renderAll();
    // 1手読みが出たら、手が空いているうちに2手読みで確かめる
    if (want === 1 && settings.showEval) { const s2 = shownState(); if (anaKey(s2.gi, s2.n) === key) analyzeNow(force, true); }
  }
  async function analyze(st, ply) {
    if (st.phase === 'move') {
      const r = await ANP.run({ type: 'moves', me: arr(st.b[st.turn]), opp: arr(st.b[st.turn ^ 1]), d1: st.dice[0], d2: st.dice[1], ply, ctx: ctxOf(st), top: 8, all: true, prune1: 8, prune2: 4 });
      if (r.type !== 'moves') return null;
      return { kind: 'moves', ply, side: st.turn, list: r.list, n: r.n, nodes: r.nodes, ms: r.ms };
    }
    const r = await ANP.run({ type: 'cube', me: arr(st.b[st.turn]), opp: arr(st.b[st.turn ^ 1]), ply, ctx: ctxOf(st) });
    if (r.type !== 'cube') return null;
    return { kind: 'cube', ply, side: st.turn, p: r.p, dec: r.dec, nodes: r.nodes, ms: r.ms };
  }
  // 人の手の良し悪し（AI補助が出ているときだけ。解析がまだなら後で）
  async function recordHumanMove(before, gi, n, hops) {
    const key = anaKey(gi, n);
    let a = AN.cache.get(key);
    const side = before.turn;
    if (!a && !settings.showEval) return;
    if (!a) { a = await analyze(before, 1); if (!a) return; AN.cache.set(key, a); }
    const m2 = BG.checkHops(before.b[side], before.b[side ^ 1], before.dice, hops);
    if (!m2) return;
    const k = BG.key(m2.me, m2.opp);
    let mine = a.list.find(c => c.key === k);
    if (!mine || mine.ply < a.list[0].ply) {
      const r = await ANP.run({ type: 'evalMoves', me: arr(before.b[side]), opp: arr(before.b[side ^ 1]), d1: before.dice[0], d2: before.dice[1], keys: [k], ply: a.list[0].ply, ctx: ctxOf(before) });
      if (r.type !== 'evalMoves' || !r.list.length) return;
      mine = r.list[0];
    }
    S.errs[anaKey(gi, n + 1)] = Math.max(0, a.list[0].v - mine.v);
    S.evals[anaKey(gi, n + 1)] = side === 0 ? mine.p[0] : 1 - mine.p[0];
    save(); renderTape(); renderKifu(); renderGraph();
  }
  // この対局をまとめて分析（棋譜の悪手の印・グラフ）
  let analyzingAll = false;
  async function analyzeAll() {
    if (analyzingAll) return;
    analyzingAll = true;
    const btn = $('btn-analyze');
    const jobs = [];
    for (let gi = 0; gi <= S.gi; gi++) {
      const acts = S.games[gi].actions;
      for (let n = 0; n < acts.length; n++) if (acts[n].a === 'move' && S.errs[anaKey(gi, n + 1)] == null) jobs.push([gi, n]);
    }
    let done = 0;
    for (const [gi, n] of jobs) {
      btn.textContent = `分析中… ${done}/${jobs.length}`;
      const before = BG.replay(S.cfg, S.starts[gi], S.games[gi].actions, n);
      if (before.phase !== 'move') { done++; continue; }
      const L = BG.legalMoves(before.b[before.turn], before.b[before.turn ^ 1], before.dice[0], before.dice[1]);
      if (L.length > 1) {
        AN.cache.delete(anaKey(gi, n));
        const a = await analyze(before, 1);
        if (a) { AN.cache.set(anaKey(gi, n), a); await recordHumanMove(before, gi, n, S.games[gi].actions[n].h); }
      } else S.errs[anaKey(gi, n + 1)] = 0;
      done++;
    }
    btn.textContent = 'この対局を分析';
    analyzingAll = false;
    save(); renderAll();
  }
  function hint() {
    if (!humanCanAct()) return;
    if (S.online) { S.online.myHints++; NET && NET.send({ t: 'hint' }); save(); }
    const { gi, n } = shownState();
    S.hint = anaKey(gi, n);
    analyzeNow(true).then(() => renderAll());
    renderAll();
  }

  // ------------------------------------------------------------------ 描画
  let board = null;
  function boardModel() {
    const { st, gi, n } = shownState();
    const bottom = S.bottom, top = bottom ^ 1;
    let bArr = st.b[bottom], tArr = st.b[top];
    const ov = S.anim || (live() && S.pm ? { side: S.pm.side, me: S.pm.me, opp: S.pm.opp } : null);
    if (ov && live()) { if (ov.side === bottom) { bArr = ov.me; tArr = ov.opp; } else { tArr = ov.me; bArr = ov.opp; } }
    const m = { mirror: settings.mirror, numbers: settings.numbers, numPersp: 0, bottom: { arr: bArr, color: COLOR[bottom] }, top: { arr: tArr, color: COLOR[top] }, ui: {}, dice: [], cube: null, banner: null };
    if (S.anim && S.anim.flying) m.flying = { [S.anim.side === bottom ? 'bottom' : 'top']: 1 };
    const sideName = s => (s === bottom ? 'bottom' : 'top');
    // サイコロ
    if (live() && S.rolling) {
      m.dice = S.rolling.map(g => ({ side: g.side, vals: g.vals, color: g.side === 'bottom' ? COLOR[bottom] : COLOR[top], rot: g.rot, rolling: true }));
    } else if (st.phase === 'move' && st.dice) {
      const vals = diceList(st.dice);
      let used = vals.map(() => false);
      if (live() && S.pm) {
        if (st.dice[0] === st.dice[1]) used = vals.map((_, i) => i < 4 - S.pm.dice.length);
        else used = vals.map(v => !S.pm.dice.includes(v));
        if (S.pm.need === 0) used = vals.map(() => true);
      }
      m.dice = [{ side: sideName(st.turn), vals, color: COLOR[st.turn], used, clickable: live() && pmComplete() && isHuman(st.turn) }];
    } else if (st.phase === 'open' || (st.phase === 'move' && !st.dice)) {
      // 振り分けの前: 直前の同じ目を見せる
      const acts = S.games[gi].actions.slice(0, n), last = acts[acts.length - 1];
      if (last && last.a === 'open') m.dice = [{ side: 'bottom', vals: [last.d[bottom]], color: COLOR[bottom] }, { side: 'top', vals: [last.d[top]], color: COLOR[top] }];
    } else if (!live()) {
      // 見返し: 直前の手のサイコロ
      const acts = S.games[gi].actions, last = acts[n - 1];
      if (last && last.a === 'move') { const pst = BG.replay(S.cfg, S.starts[gi], acts, n - 1); if (pst.dice) m.dice = [{ side: sideName(pst.turn), vals: diceList(pst.dice), color: COLOR[pst.turn], used: diceList(pst.dice).map(() => true) }]; }
    }
    // キューブ
    if (S.cfg.cube) {
      const offer = st.phase === 'doubled';
      m.cube = { show: true, value: offer ? st.cube * 2 : st.cube, pos: st.owner === -1 ? 'center' : sideName(st.owner), offer: offer ? sideName(st.turn ^ 1) : null,
        clickable: live() && !S.busy && st.phase === 'turn' && isHuman(st.turn) && BG.canDouble(st) && !BG.mustRoll(st) && !(S.online && S.online.rolling) };
    }
    // 操作の印
    if (live() && S.pm && !S.pm.forced && !S.busy && isHuman(S.pm.side)) {
      m.ui.movable = [...sourcesPM()].map(i => slotOf(S.pm.side, i));
      if (S.sel != null && S.dests) {
        m.ui.sel = slotOf(S.pm.side, S.sel);
        m.ui.dests = [...S.dests.keys()].map(t => slotOf(S.pm.side, t));
        m.ui.hits = [...S.dests.entries()].filter(([, rs]) => rs.some(r => r[r.length - 1][2])).map(([t]) => slotOf(S.pm.side, t));
      }
    }
    // 直前の手（見返し中は、その手を矢印で）
    const lastMv = lastMove(gi, n);
    if (lastMv && !(live() && S.pm && S.pm.hops.length)) m.ui.last = lastMv.hops.flatMap(h => [slotOf(lastMv.side, h[0]), slotOf(lastMv.side, h[1])]).filter(s => s < 26);
    // おすすめの手
    const a = AN.cache.get(anaKey(gi, n));
    const wantArrow = (settings.arrow || S.hint === anaKey(gi, n)) && a && a.kind === 'moves' && a.list.length && st.phase === 'move' && !(live() && S.pm && (S.pm.hops.length || S.sel != null));
    if (wantArrow && (!live() || !isCPU(st.turn))) m.ui.arrows = a.list[0].hops.map(h => ({ from: slotOf(a.side, h[0]), to: slotOf(a.side, h[1]) }));
    if (!live() && lastMv) m.ui.arrows = (m.ui.arrows || []).concat(lastMv.hops.map(h => ({ from: slotOf(lastMv.side, h[0]), to: slotOf(lastMv.side, h[1]), cls: 'last' })));
    // 振るボタン（自動で振らないとき）
    if (live() && !S.busy && !S.rolling && st.phase === 'turn' && isHuman(st.turn) && !(S.online && S.online.rolling) && (!settings.autoroll || (BG.canDouble(st) && !BG.mustRoll(st))))
      m.banner = { side: sideName(st.turn), text: 'タップして振る', act: 'roll' };
    if (live() && S.online && S.online.rolling) m.banner = { side: sideName(st.turn), text: '相手の乱数を待っています…' };
    return m;
  }
  function lastMove(gi, n) {
    const acts = S.games[gi].actions;
    for (let i = n - 1; i >= 0; i--) {
      if (acts[i].a === 'move') { const pst = BG.replay(S.cfg, S.starts[gi], acts, i); const r = BG.checkHops(pst.b[pst.turn], pst.b[pst.turn ^ 1], pst.dice, acts[i].h); return r ? { side: pst.turn, hops: r.hops, dice: pst.dice } : null; }
      if (acts[i].a === 'roll' || acts[i].a === 'open') continue;
      return null;
    }
    return null;
  }
  function renderBoard() { if (board) board.render(boardModel()); }

  function renderPlayers() {
    const { st } = shownState();
    const sc = st.phase === 'over' ? st.score : S.starts[shownState().gi].score;
    for (const [id, side] of [['player-top', S.bottom ^ 1], ['player-bottom', S.bottom]]) {
      const el = $(id);
      const b = st.b[side];
      const pipc = BG.pip(b), off = BG.offCount(b);
      const toMove = live() && st.phase !== 'over' && actorOf(st) === side;
      el.classList.toggle('turn', toMove);
      let right = '';
      if (S.cfg.cube && st.owner === side) right += `<span class="cubemini" title="キューブを持っている">${st.cube}</span>`;
      if (S.online && isRemote(side)) right += aiTagHTML(S.online.opp.ai, S.online.opp.hints);
      if (S.online && isHuman(side)) right += aiTagHTML(aiFlags(), S.online.myHints);
      if (toMove && S.thinking && isCPU(side)) right += '<span class="think"><i></i>考え中</span>';
      if (toMove && S.online && isRemote(side)) right += S.online.oppPresent === false ? '<span class="think" style="color:var(--bad)">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      right += `<span class="score" title="${BG.isMoney(S.cfg) ? '通算の点' : '得点'}">${sc[side]}</span>`;
      const sub = `ピップ ${pipc}${off ? `・上がり ${off}` : ''}${b[24] ? `・バー ${b[24]}` : ''}`;
      el.innerHTML = `<span class="chip ${COLOR[side]}"></span><div class="who"><span class="name">${esc(seatName(side))}</span><span class="sub">${sub}</span></div><div class="right">${right}</div>`;
    }
  }

  // ヒントを押した局面なら、おすすめを情報の行に（AI補助を隠していても見えるように）
  function hintText() {
    const { gi, n, st } = shownState();
    if (!live() || S.hint !== anaKey(gi, n)) return '';
    const a = AN.cache.get(S.hint);
    if (!a) return 'ヒント: 読んでいます…';
    if (a.kind === 'moves') return 'ヒント: ' + BG.moveText(a.list[0].hops);
    if (!a.dec) return '';
    if (st.phase === 'doubled') return 'ヒント: ' + (a.dec.take ? (a.dec.beaver && BG.canBeaver(st) ? 'ビーバー' : 'テイク') : 'パス');
    return 'ヒント: ' + (BG.canDouble(st) && !BG.mustRoll(st) ? (a.dec.double ? 'ダブル' : 'ダブルしないで振る') : '振る');
  }
  function renderInfo() {
    const el = $('info');
    el.className = 'info';
    const ht = hintText();
    const set = (cls, txt, tools) => { if (cls) el.classList.add(cls); el.innerHTML = `<span class="txt">${ht ? `<b style="color:var(--good)">${esc(ht)}</b>　` : ''}${txt}</span>${tools ? `<span class="tools">${tools}</span>` : ''}`; };
    if (!live()) {
      const { st, gi, n } = shownState();
      const e = entryAt(gi, n);
      set('view', `見返し中: 第${gi + 1}局 ${e ? esc(e.label) : '始まり'}`, `<button class="btn small" data-act="live">最新へ</button>${!S.online && S.mode !== 'watch' && st.phase !== 'over' ? '<button class="btn small" data-act="branch">ここから</button>' : ''}`);
      return;
    }
    const st = S.st;
    if (!st) return;
    const actor = actorOf(st);
    if (S.rolling || (S.busy && !S.pm)) { set('', S.msg ? esc(S.msg) : 'サイコロを振っています…'); return; }
    if (st.phase === 'over') {
      const done = matchDone();
      set('result', `<b>${esc(seatName(st.winner))}の勝ち</b>（${esc(kindText(st))}・${st.points}点）${done && !BG.isMoney(S.cfg) ? `　マッチ終了 ${st.score[0]}−${st.score[1]}` : ''}`,
        done ? `<button class="btn small primary" data-act="again">もう一局</button>` : `<button class="btn small primary" data-act="next">次の局へ</button>`);
      return;
    }
    if (st.phase === 'open') { set('', S.msg ? esc(S.msg) : '振り分け: 1個ずつ振って、大きい目のほうが先手'); return; }
    const craw = st.crawford ? '<span class="muted">（クロフォード: キューブなし）</span> ' : '';
    if (isCPU(actor) || (S.online && isRemote(actor))) {
      const who = esc(seatName(actor));
      if (st.phase === 'doubled') set('act', `${esc(seatName(st.turn))}がダブル（キューブ ${st.cube * 2}）。${who}が考えています…`);
      else set('', S.msg ? esc(S.msg) : `${craw}${who}の番${S.online && S.online.oppPresent === false ? '（接続が切れています。戻るのを待っています）' : ''}`);
      return;
    }
    const you = S.mode === 'pvp' ? `${SIDE[actor]}の番` : 'あなたの番';
    if (st.phase === 'doubled') {
      set('alert', `${esc(seatName(st.turn))}がダブル（キューブを ${st.cube * 2} に）`,
        `<button class="btn small primary" data-act="take">テイク</button><button class="btn small bad" data-act="pass">パス</button>${BG.canBeaver(st) ? '<button class="btn small" data-act="beaver">ビーバー</button>' : ''}`);
      return;
    }
    if (st.phase === 'turn') {
      if (S.online && S.online.rolling) { set('act', '振っています（相手の乱数を待っています）…'); return; }
      const canD = BG.canDouble(st) && !BG.mustRoll(st);
      set('act', `${S.msg ? esc(S.msg) + '　' : ''}${craw}${you}: ${canD ? 'ダブルするか、振るか' : '振ってください'}`, `${canD ? '<button class="btn small" data-act="double">ダブル</button>' : ''}<button class="btn small primary" data-act="roll">振る</button>`);
      return;
    }
    if (st.phase === 'move' && S.pm) {
      const pm = S.pm, d = st.dice;
      if (pm.forced) { set('act', pm.need ? `${d[0]}-${d[1]}: 動かせる手は1つだけ（自動で動かします）` : `${d[0]}-${d[1]}: 動かせる駒がありません`); return; }
      let txt;
      if (pmComplete()) txt = `${d[0]}-${d[1]}: ${esc(BG.moveText(pm.hops))}${settings.autoconfirm ? '' : ' — これで確定しますか？'}`;
      else if (S.sel != null) txt = `${esc(BG.ptName(S.sel))} の駒 → 光っている行き先をタップ`;
      else txt = `${S.msg ? esc(S.msg) + '　' : ''}${d[0]}-${d[1]}: 動かす駒をタップ${pm.hops.length ? `（${esc(BG.moveText(pm.hops))}）` : ''}`;
      set('act', txt, `${pm.hops.length ? '<button class="btn small" data-act="undohop">戻す</button>' : ''}${pmComplete() ? '<button class="btn small primary" data-act="confirm">確定</button>' : ''}`);
      return;
    }
    set('', esc(S.msg || ''));
  }

  // 棋譜の項目: 動かした手とキューブの行動。{gi, n（その行動のあとの行動数）, label, side}
  function entries() {
    const out = [];
    for (let gi = 0; gi <= S.gi && gi < S.games.length; gi++) {
      const acts = S.games[gi].actions;
      let st = BG.newGameState(S.cfg, S.starts[gi]);
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i], before = st;
        st = BG.cloneState(st);
        try { BG.act(st, a); } catch (e) { break; }
        let label = null, side = before.turn;
        if (a.a === 'move') label = `${before.dice[0]}${before.dice[1]} ${BG.moveText(st.last.hops)}`;
        else if (a.a === 'double') label = `ダブル→${before.cube * 2}`;
        else if (a.a === 'take' || a.a === 'pass' || a.a === 'beaver') { side = before.turn ^ 1; label = { take: 'テイク', pass: 'パス', beaver: 'ビーバー' }[a.a]; }
        else if (a.a === 'resign') { side = a.s; label = `投了（${['', 'シングル', 'ギャモン', 'BG'][a.v]}）`; }
        if (label) out.push({ gi, n: i + 1, label, side, dice: a.a === 'move' ? before.dice : null, mv: a.a === 'move' ? BG.moveText(st.last.hops) : null, over: st.phase === 'over' });
      }
    }
    return out;
  }
  function entryAt(gi, n) { return entries().find(e => e.gi === gi && e.n === n) || null; }
  function errMark(gi, n) {
    const e = S.errs[anaKey(gi, n)];
    if (e == null) return '';
    const big = BG.isMoney(S.cfg) ? [0.04, 0.08, 0.16] : [0.008, 0.016, 0.032];
    return e >= big[2] ? '??' : e >= big[1] ? '?' : e >= big[0] ? '?!' : '';
  }
  function renderTape() {
    const tape = $('tape');
    const es = entries();
    const cur = live() ? null : S.view;
    let html = '', lastG = -1;
    for (const e of es) {
      if (e.gi !== lastG) { if (S.games.length > 1 || e.gi > 0) html += `<span class="sep">第${e.gi + 1}局</span>`; lastG = e.gi; }
      const isCur = cur && cur.gi === e.gi && cur.n === e.n;
      const mark = errMark(e.gi, e.n);
      html += `<button data-g="${e.gi}" data-n="${e.n}" class="${isCur ? 'cur' : ''}${mark === '?' || mark === '??' ? ' bad' : ''}"><span class="dot chip ${COLOR[e.side]}"></span>${e.dice ? `<span class="dice-t">${e.dice[0]}${e.dice[1]}</span>${esc(e.mv)}` : esc(e.label)}${mark ? ` <b>${mark}</b>` : ''}</button>`;
    }
    tape.innerHTML = html || '<span class="sep">まだ手はありません</span>';
    const c = tape.querySelector('.cur') || (live() ? tape.lastElementChild : null);
    if (c) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const nav = $('navrow');
    nav.querySelector('[data-nav="last"]').disabled = live();
    nav.querySelector('[data-nav="next"]').disabled = live();
    nav.querySelector('[data-nav="prev"]').disabled = !es.length || (!live() && es.indexOf(es.find(e => e.gi === S.view.gi && e.n === S.view.n)) === 0);
    nav.querySelector('[data-nav="first"]').disabled = !es.length;
  }
  function renderKifu() {
    const ol = $('kifu');
    const es = entries();
    let html = '', lastG = -1, no = 0;
    for (const e of es) {
      if (e.gi !== lastG) { const s = S.starts[e.gi] ? S.starts[e.gi].score : [0, 0]; html += `<li class="gh">第${e.gi + 1}局（${SIDE[0]} ${s[0]} − ${SIDE[1]} ${s[1]}）${S.starts[e.gi] && S.starts[e.gi].crawford ? '・クロフォード' : ''}</li>`; lastG = e.gi; no = 0; }
      no++;
      const isCur = !live() && S.view.gi === e.gi && S.view.n === e.n;
      const er = S.errs[anaKey(e.gi, e.n)], mark = errMark(e.gi, e.n);
      html += `<li data-g="${e.gi}" data-n="${e.n}" class="${isCur ? 'cur' : ''}"><span class="no">${no}</span><span class="dot chip ${COLOR[e.side]}"></span><span>${e.dice ? `<span class="muted">${e.dice[0]}-${e.dice[1]}</span> ${esc(e.mv)}` : esc(e.label)}</span><span class="ev${mark === '?' || mark === '??' ? ' bad' : ''}">${er != null && er > 0.0005 ? (BG.isMoney(S.cfg) ? '−' + er.toFixed(3) : '−' + (er * 100).toFixed(1) + '%') + (mark ? ' ' + mark : '') : er != null ? '◎' : ''}</span></li>`;
    }
    ol.innerHTML = html || '<li class="gh">まだ手はありません</li>';
    const c = ol.querySelector('.cur');
    if (c) c.scrollIntoView({ block: 'nearest' });
    else if (live()) ol.scrollTop = ol.scrollHeight;
    $('kifu-info').textContent = BG.isMoney(S.cfg) ? (S.cfg.single ? 'マネー1局' : 'マネーゲーム') : `${S.cfg.len}点マッチ`;
  }
  function renderGraph() {
    const svg = $('graph');
    const es = entries().filter(e => e.dice);
    const you = youSide();
    $('graph-who').textContent = S.mode === 'cpu' || S.online ? 'あなたの勝率' : `${SIDE[S.bottom]}の勝率`;
    const who = S.mode === 'cpu' || S.online ? you : S.bottom;
    const n = Math.max(es.length, 20);
    const pts = [];
    es.forEach((e, i) => { const v = S.evals[anaKey(e.gi, e.n)]; if (v != null) pts.push([i, who === 0 ? v : 1 - v]); });
    const X = i => (i + 0.5) / n * 300, Y = v => 116 - v * 112;
    let html = `<line class="axis" x1="0" y1="116" x2="300" y2="116"/><line class="mid" x1="0" y1="${Y(0.5)}" x2="300" y2="${Y(0.5)}"/>`;
    let lastG = -1;
    es.forEach((e, i) => { if (e.gi !== lastG) { if (i) html += `<line class="gsep" x1="${X(i - 0.5)}" y1="0" x2="${X(i - 0.5)}" y2="116"/>`; lastG = e.gi; } });
    if (pts.length) {
      const line = pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
      html += `<polygon class="area" points="${X(pts[0][0]).toFixed(1)},${Y(0.5)} ${line} ${X(pts[pts.length - 1][0]).toFixed(1)},${Y(0.5)}"/><polyline class="line" points="${line}"/>`;
    }
    if (!live()) { const idx = es.findIndex(e => e.gi === S.view.gi && e.n === S.view.n); if (idx >= 0) html += `<line class="now" x1="${X(idx)}" y1="0" x2="${X(idx)}" y2="116"/>`; }
    html += `<text x="2" y="9">100%</text><text x="2" y="${Y(0.5) - 2}">50%</text>`;
    svg.innerHTML = html;
    svg.dataset.n = n;
  }
  function renderEvalCard() {
    const el = $('evcard');
    const { st, gi, n } = shownState();
    const a = AN.cache.get(anaKey(gi, n));
    const you = S.mode === 'cpu' || S.online ? youSide() : S.bottom;
    if (!st || st.phase === 'over' || st.phase === 'open') { el.innerHTML = `<h2>形勢</h2><p class="hint" style="margin:0">${st && st.phase === 'over' ? 'この局は終わりました。棋譜を見返すと、その局面の形勢が出ます。' : '振り分けのあとに形勢を出します。'}</p>`; setStrip(null); return; }
    if (!a) { el.innerHTML = `<h2>形勢</h2><p class="hint" style="margin:0">${settings.showEval ? (live() && isCPU(actorOf(st)) ? '相手の番です。あなたの番になったら読みます。' : '読んでいます…') : '形勢は隠しています。'}</p>`; setStrip(null); return; }
    // 確率（振る前の局面なら手番側、動かす局面なら最善手のあと）を「you」から見て
    let p, label;
    if (a.kind === 'cube') { p = a.p; label = '振る前'; }
    else { p = a.list[0].p; label = '最善手のあと'; }
    const pv = a.side === you ? p : BGNet.flip(p, new Float32Array(5));
    const sp = BGAI.split(pv);
    const eq = BGNet.equity(pv);
    const whoTxt = S.mode === 'cpu' || S.online ? 'あなた' : SIDE[you];
    let html = `<h2>形勢<span class="grow">${whoTxt}から見て・${label}・${a.ply}手読み</span></h2>
      <div class="wpct"><span class="v">${pct(pv[0])}</span><span class="lbl">${whoTxt}の勝率</span><span class="lbl" style="margin-left:auto">期待値 ${sgn(eq)}</span></div>
      <div class="wbar"><div class="b" style="width:${(you === 0 ? pv[0] : 1 - pv[0]) * 100}%"></div></div>
      <div class="probs"><span class="h"></span><span class="h">シングル</span><span class="h">ギャモン</span><span class="h">BG</span>
        <span>勝ち</span><span>${pct(sp[0])}</span><span>${pct(sp[1])}</span><span>${pct(sp[2])}</span>
        <span>負け</span><span>${pct(sp[3])}</span><span>${pct(sp[4])}</span><span>${pct(sp[5])}</span></div>`;
    if (a.kind === 'cube' && S.cfg.cube && a.dec) {
      const d = a.dec, roller = a.side;
      const unit = d.money ? '' : '%';
      const f = v => (d.money ? sgn(v) : (v * 100).toFixed(1) + unit);
      const can = BG.canDouble(st) && !BG.mustRoll(st);
      html += `<div class="cubebox"><b>キューブ（${esc(seatName(roller))}）: ${esc(st.phase === 'doubled' ? (d.take ? (d.beaver ? 'ビーバー（受けて2倍に返す）' : 'テイク（受ける）') : 'パス（降りる）') + ' がよい' : can ? d.label : 'いまは使えない')}</b><br>
        <span class="eqs">ノーダブル ${f(d.nd)}・ダブル／テイク ${f(d.dt)}・ダブル／パス ${f(d.dp)}${d.money ? '（1点あたり、キューブの効きを含む）' : '（マッチの勝率）'}</span></div>`;
    }
    if (a.kind === 'moves') {
      const best = a.list[0];
      const f = v => (BG.isMoney(S.cfg) ? sgn(v) : (v * 100).toFixed(1) + '%');
      html += `<ol class="cands">${a.list.slice(0, 6).map((c, i) => `<li class="${i === 0 ? 'best' : ''}" data-cand="${i}"><span>${i + 1}</span><span>${esc(BG.moveText(c.hops))}</span><span>${f(c.v)}</span><span class="d">${i ? (BG.isMoney(S.cfg) ? '−' + (best.v - c.v).toFixed(3) : '−' + ((best.v - c.v) * 100).toFixed(1) + '%') : `${c.ply}手読み`}</span></li>`).join('')}</ol>`;
    }
    html += `<div class="meta">${a.nodes.toLocaleString()} 局面を評価・${a.ms} ms${a.kind === 'moves' ? `・合法手 ${a.n}` : ''}</div>`;
    el.innerHTML = html;
    setStrip({ pv, you, best: a.kind === 'moves' ? BG.moveText(a.list[0].hops) : (a.dec && S.cfg.cube && st.phase === 'doubled' ? (a.dec.take ? (a.dec.beaver ? 'ビーバー' : 'テイク') : 'パス') : a.dec && S.cfg.cube && BG.canDouble(st) && !BG.mustRoll(st) ? a.dec.short : ''), eq });
  }
  function setStrip(o) {
    if (!o) { $('evs-num').textContent = '—'; $('evs-best').textContent = ''; $('evs-b').style.width = '50%'; return; }
    $('evs-b').style.width = ((o.you === 0 ? o.pv[0] : 1 - o.pv[0]) * 100) + '%';
    $('evs-num').innerHTML = `${pct(o.pv[0])}<small>${S.mode === 'cpu' || S.online ? 'あなた' : SIDE[o.you]}</small>`;
    $('evs-best').textContent = o.best ? (S.hint || settings.arrow ? 'おすすめ: ' + o.best : '') : '';
  }
  function renderSide() { renderEvalCard(); renderKifu(); renderGraph(); }
  function renderControls() {
    $('btn-undo').disabled = !!S.online || S.mode === 'watch' || !!S.view;
    $('btn-hint').disabled = !humanCanAct();
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    document.body.classList.toggle('eval-off', !settings.showEval);
    $('btn-resign').disabled = !S.st || S.st.phase === 'over' || S.mode === 'watch';
  }
  function render() {
    if (!S.st) return;
    renderBoard(); renderPlayers(); renderInfo(); renderTape(); renderControls();
    if (settings.showEval || $('side').classList.contains('open') || layoutMode === 'wide') renderSide();
  }
  const renderAll = render;

  // 見返し
  function viewAt(gi, n) {
    if (gi === S.gi && n >= S.games[S.gi].actions.length) { S.view = null; }
    else S.view = { gi, n };
    S.pm && clearSel();
    render(); analyzeNow();
    if (live()) schedule();
  }
  function step(dir) {
    const es = entries();
    if (!es.length) return;
    let idx = live() ? es.length : es.findIndex(e => e.gi === S.view.gi && e.n === S.view.n);
    idx += dir;
    if (idx >= es.length) { viewAt(S.gi, S.games[S.gi].actions.length); return; }
    if (idx < 0) idx = 0;
    viewAt(es[idx].gi, es[idx].n);
  }
  // 見返している局面から指し直す（CPU 戦・ふたり）
  function branch() {
    if (live() || S.online) return;
    const { gi, n } = S.view;
    S.epoch++; CPUP.reset(); clearTimeout(S.timer);
    S.games.length = gi + 1; S.games[gi].actions.length = n; S.gi = gi;
    dropAnalysisAfter(gi, n);
    S.view = null; S.pm = null; clearSel(); S.busy = false; S.thinking = false;
    recompute(); S.resultShown = S.st.phase === 'over'; save(); render(); schedule();
  }

  // ------------------------------------------------------------------ 入力
  function onBoardClick(ev) {
    const t = board.hitTest(ev.target);
    if (t && t.act) {
      if (t.act === 'roll') { humanRoll(); return; }
      if (t.act === 'cube') { offerDouble(); return; }
      if (t.act === 'dice') { if (pmComplete()) confirmMove(); return; }
    }
    if (!live() || S.busy || !S.pm || S.pm.forced || !isHuman(S.pm.side)) {
      if (live() && S.st && S.st.phase === 'turn' && isHuman(S.st.turn) && !S.busy) { /* 盤を押しても振らない（誤操作を避ける） */ }
      return;
    }
    const slot = board.slotAt(ev.clientX, ev.clientY);
    if (slot == null) { clearSel(); render(); return; }
    const side = S.pm.side;
    const idx = idxOf(side, slot);
    if (S.sel != null && S.dests && idx != null && S.dests.has(idx)) { chooseDest(idx); return; }
    const srcs = sourcesPM();
    if (idx != null && srcs.has(idx)) { select(idx); return; }
    // 動かせない駒を押したら理由を出す
    if (idx != null && idx >= 0 && S.pm.me[idx] > 0) S.msg = S.pm.me[24] > 0 ? 'バーの駒を先に入れます' : pmComplete() ? 'もう全部の目を使いました（確定か戻す）' : 'その駒は今の目では動かせません';
    else S.msg = '';
    clearSel(); render();
    S.msg = '';
  }
  function bind() {
    $('board').addEventListener('click', onBoardClick);
    $('chooser').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !S.chooser) return;
      const r = b.dataset.r === 'x' ? null : S.chooser[Number(b.dataset.r)];
      hideChooser();
      if (r) playRoute(r); else { clearSel(); render(); }
    });
    $('info').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'roll') humanRoll();
      else if (a === 'double') offerDouble();
      else if (a === 'take' || a === 'pass' || a === 'beaver') respond(a);
      else if (a === 'confirm') confirmMove();
      else if (a === 'undohop') undoHop();
      else if (a === 'next') nextGame();
      else if (a === 'again') again();
      else if (a === 'live') viewAt(S.gi, S.games[S.gi].actions.length);
      else if (a === 'branch') branch();
    });
    document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const nav = b.dataset.nav;
      if (nav === 'first') { const es = entries(); const f = es.find(x => x.gi === (live() ? S.gi : S.view.gi)) || es[0]; if (f) viewAt(f.gi, Math.max(0, f.n - 1)); }
      else if (nav === 'prev') step(-1);
      else if (nav === 'next') step(1);
      else if (nav === 'last') viewAt(S.gi, S.games[S.gi].actions.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet(settings.showEval ? 'ev' : 'kifu'); }
      else if (b.dataset.g != null) viewAt(Number(b.dataset.g), Number(b.dataset.n));
    });
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'ev' : 'kifu'));
    $('btn-flip').addEventListener('click', () => { S.bottom ^= 1; clearSel(); save(); render(); });
    $('btn-resign').addEventListener('click', openResign);
    $('rg-kind').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; resignKind = Number(b.dataset.v); $('rg-kind').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    $('rg-cancel').addEventListener('click', () => { $('dlg-resign').hidden = true; });
    $('rg-ok').addEventListener('click', doResign);
    $('btn-new').addEventListener('click', () => {
      if (S.online && S.st.phase !== 'over' && !confirm('オンライン対局の途中です。新しい対局を始めると投了（この局をバックギャモンの点で負け）になります。よろしいですか？')) return;
      if (S.online && S.st.phase !== 'over') onlineForfeit();
      openNew();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-hint').addEventListener('click', hint);
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    [['set-eval', 'showEval'], ['set-arrow', 'arrow'], ['set-autoroll', 'autoroll'], ['set-autoconfirm', 'autoconfirm'], ['set-mirror', 'mirror'], ['set-numbers', 'numbers'], ['set-sound', 'sound'], ['set-anim', 'anim']].forEach(([id, k]) => {
      const el = $(id); el.checked = settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    $('evstrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ev'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]'); if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
      if (e.target.closest('[data-act="show-eval"]')) setSetting('showEval', true);
    });
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li[data-g]'); if (li) viewAt(Number(li.dataset.g), Number(li.dataset.n)); });
    $('graph').addEventListener('click', e => {
      const es = entries().filter(x => x.dice);
      if (!es.length) return;
      const r = $('graph').getBoundingClientRect(), n = Number($('graph').dataset.n || 20);
      const i = Math.max(0, Math.min(es.length - 1, Math.floor((e.clientX - r.left) / r.width * n)));
      viewAt(es[i].gi, es[i].n);
    });
    $('btn-analyze').addEventListener('click', analyzeAll);
    $('btn-copy').addEventListener('click', () => {
      const text = kifuText(), msg = $('copy-msg');
      const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.rows = 6; ta.style.width = '100%'; msg.innerHTML = ''; msg.appendChild(ta); ta.select(); };
      try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); }, fallback); } catch (err) { fallback(); }
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        // オンライン対戦: すぐこのダイアログを閉じてオンラインのパネルへ（今の対局はオンラインで始まるまでそのまま）
        if (id === 'ng-mode' && v === 'online') { $('dlg-new').hidden = true; schedule(); openOnline(); return; }
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-len') draft.len = Number(v);
        else if (id === 'ng-cube') draft.cube = v;
        drawNew(); return;
      }
      if (e.target === $('dlg-new')) { $('dlg-new').hidden = true; schedule(); }
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; schedule(); });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; newMatch(Object.assign({}, draft)); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (matchDone()) again(); else nextGame(); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; const es = entries().filter(e => e.gi === S.gi); if (es.length) viewAt(S.gi, es[0].n); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { const wasNew = !$('dlg-new').hidden; closeSheet(); hideChooser(); ['dlg-new', 'dlg-result', 'dlg-online', 'dlg-resign'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel != null) { clearSel(); render(); } if (wasNew) schedule(); return; }
      if (e.target.closest('input, textarea, .dialog') || $('view-play').hidden) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'End') { e.preventDefault(); viewAt(S.gi, S.games[S.gi].actions.length); }
      if (e.key === ' ' || e.key === 'Enter') { if (pmComplete()) { e.preventDefault(); confirmMove(); } else if (humanCanAct() && S.st.phase === 'turn') { e.preventDefault(); humanRoll(); } }
      if (e.key === 'Backspace' && S.pm && S.pm.hops.length) { e.preventDefault(); undoHop(); }
    });
    window.addEventListener('resize', () => { layout(); if ($('side').classList.contains('open')) placeSheet(); });
  }
  function again() {
    if (S.online) { requestRematch(); return; }
    const c = Object.assign({}, draft);
    if (S.mode === 'cpu') { // 同じ設定で（色はそのまま）
      loadMatch({ cfg: S.cfg, mode: S.mode, seats: S.seats, games: [{ actions: [] }], gi: 0, bottom: S.bottom });
      return;
    }
    newMatch(c);
  }
  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', arrow: 'set-arrow', autoroll: 'set-autoroll', autoconfirm: 'set-autoconfirm', mirror: 'set-mirror', numbers: 'set-numbers', sound: 'set-sound', anim: 'set-anim' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if ((k === 'showEval' || k === 'arrow') && NET) NET.setAI(aiFlags());
    if (k === 'showEval' || k === 'arrow') analyzeNow();
    if (k === 'autoroll' && v && live() && !S.busy && S.st.phase === 'turn' && isHuman(S.st.turn)) schedule();
    layout(); render();
  }
  function kifuText() {
    const lines = [`バックギャモン 棋譜（${BG.isMoney(S.cfg) ? 'マネーゲーム' : S.cfg.len + '点マッチ'}${S.cfg.cube ? '' : '・キューブなし'}） 白: ${seatName(0)} / 黒: ${seatName(1)}`];
    let lastG = -1, no = 0;
    for (const e of entries()) {
      if (e.gi !== lastG) { const s = S.starts[e.gi].score; lines.push('', `第${e.gi + 1}局（白 ${s[0]} − 黒 ${s[1]}）${S.starts[e.gi].crawford ? ' クロフォード' : ''}`); lastG = e.gi; no = 0; }
      no++;
      lines.push(`${String(no).padStart(3)}. ${SIDE[e.side]} ${e.dice ? `${e.dice[0]}-${e.dice[1]}: ${e.mv}` : e.label}`);
    }
    const st = S.st;
    if (st.phase === 'over') lines.push(`${SIDE[st.winner]}の勝ち（${kindText(st)}・${st.points}点）`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ 新しい対局のダイアログ
  function openNew() { drawNew(); $('dlg-new').hidden = false; }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(val)}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPU と対局'], ['pvp', 'ふたりで（1台）'], ['watch', 'CPU どうしを観戦'], ['online', 'オンライン対戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, '白: ' + CPU[k].label]), draft.cpuW);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, '黒: ' + CPU[k].label]), draft.cpuB);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
    seg('ng-len', [[0, 'マネーゲーム'], [3, '3点マッチ'], [5, '5点マッチ'], [7, '7点マッチ']], draft.len);
    $('ng-len-hint').textContent = Number(draft.len) ? `先に ${draft.len} 点取ったほうが勝ち。あと1点の側が出た次の1局はキューブなし（クロフォード）` : '1局ごとに点を精算して続けます（キューブを上げていないギャモンは1点＝ジャコビー・ルール）';
    seg('ng-cube', Number(draft.len) ? [['on', 'あり'], ['off', 'なし']] : [['on', 'あり'], ['beaver', 'あり（ビーバーも）'], ['off', 'なし']], draft.cube === 'beaver' && Number(draft.len) ? 'on' : draft.cube);
    $('ng-cube-hint').textContent = draft.cube === 'off' ? 'キューブを使わず、1局の勝ち（1〜3点）だけを競います' : '自分の番で振る前に「ダブル」で賭け点を2倍にできます。相手は受ける（テイク）か降りる（パス）か';
  }

  // ------------------------------------------------------------------ タブ（ルール・AI）
  function showTab(tab) {
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('view-play').hidden = tab !== 'play'; $('view-rules').hidden = tab !== 'rules'; $('view-ai').hidden = tab !== 'ai';
    $('main').classList.toggle('doc-scroll', tab !== 'play');
    if (tab === 'rules') renderRules();
    if (tab === 'ai') renderAIPage();
    if (tab === 'play') { layout(); render(); }
  }
  let rulesTab = 'basic', aiTab = 'how';
  function docTabs(items, cur, attr) { return `<div class="doctabs" role="tablist">${items.map(([k, l]) => `<button role="tab" data-${attr}="${k}" aria-selected="${k === cur}">${l}</button>`).join('')}</div>`; }
  // 小さな盤の図（ルールの説明用）
  function miniBoard(setup, opts) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'board-svg');
    const b = BGBoard.create(svg, { mirror: settings.mirror });
    const bot = setup.bottom || BG.initial(), top = setup.top || BG.initial();
    b.render(Object.assign({ mirror: settings.mirror, numbers: true, bottom: { arr: bot, color: 'w' }, top: { arr: top, color: 'b' }, ui: {}, dice: setup.dice || [], cube: setup.cube || null }, opts || {}));
    return svg.outerHTML;
  }
  function renderRules() {
    const el = $('view-rules');
    const T = [['basic', 'はじめに'], ['move', '動かし方'], ['hit', 'ヒットとバー'], ['off', 'ベアオフ'], ['win', '勝ちの点'], ['cube', 'キューブ'], ['match', 'マッチ'], ['ui', '操作']];
    let body = '';
    if (rulesTab === 'basic') body = `<div class="card fig">${miniBoard({}, { ui: { arrows: [{ from: 23, to: 12 }, { from: 11, to: 6 }, { from: 5, to: 0 }] } })}<div>
      <h3>15枚の駒を、先にぜんぶ上げたほうが勝ち</h3>
      <p>白（下側・あなた）と黒が、2個のサイコロで出た目のぶんだけ駒を進めます。白は右上の <b>24</b> から左回りに進み、右下の <b>1〜6</b>（自分のホーム）に全部入れてから盤の外へ上げます（ベアオフ）。黒は逆向きに同じことをします。</p>
      <p>図の番号は白から見たポイントの番号です。最初の並びは 24 に2枚・13 に5枚・8 に3枚・6 に5枚（黒も自分から見て同じ）。</p>
      <p>最初は1個ずつ振り、大きい目を出したほうが、その2つの目で先に動かします。</p></div></div>`;
    else if (rulesTab === 'move') body = `<div class="card"><h3>出た2つの目で、1枚または2枚を動かす</h3><ul>
      <li>2つの目は別々の駒に使っても、1枚の駒に続けて使ってもかまいません（6-4 なら 6 と 4、または1枚を 10）。続けて使うときは、途中で止まる場所にも置ける必要があります</li>
      <li><b>ゾロ目</b>（同じ目）は4回動かせます（3-3 なら 3 を4回）</li>
      <li>相手の駒が <b>2枚以上</b>ある場所には止まれません（ふさがっている）。1枚だけなら止まれて、その駒を叩けます（ヒット）</li>
      <li><b>使える目はできるだけ使う</b>決まりです。両方使える動かし方があるなら、必ず両方使います。どちらか片方しか使えないときは、大きいほうを使えるなら大きいほう</li>
      <li>動かせる手がまったくないときは、その番は休みです</li></ul></div>`;
    else if (rulesTab === 'hit') body = `<div class="card fig">${miniBoard({ bottom: Object.assign(BG.initial(), {}), top: (() => { const a = BG.initial(); a[23] = 1; a[24] = 1; return a; })() })}<div><h3>ヒットされた駒は、バーからやり直し</h3><ul>
      <li>1枚だけの駒（ブロット）に相手が止まると、その駒は盤の真ん中の <b>バー</b> に置かれます</li>
      <li>バーに駒がある間は、ほかの駒は動かせません。まずバーの駒を、相手のホーム（白なら 19〜24）に入れます（エンター）。目が 3 なら 22 へ</li>
      <li>入れる先が全部ふさがっていたら、その番は休み（締め出し）</li></ul></div></div>`;
    else if (rulesTab === 'off') body = `<div class="card"><h3>全部ホームに入ったら、上げられる（ベアオフ）</h3><ul>
      <li>15枚すべてが自分のホーム（白なら 1〜6）に入ったら、目の数のポイントから駒を盤の外へ上げられます（6 なら 6 のポイントから）</li>
      <li>目より大きいポイントに駒がないときは、目より小さいポイントのいちばん奥の駒を上げられます（6 のポイントより奥に駒がなく 5 にあれば、6 の目で 5 から）</li>
      <li>上げている途中でヒットされたら、その駒がホームに戻るまで上げられません</li></ul></div>`;
    else if (rulesTab === 'win') body = `<div class="card"><h3>勝ちの点: シングル・ギャモン・バックギャモン</h3><ul>
      <li><b>シングル</b>（1倍）: 相手が1枚でも上げていた</li>
      <li><b>ギャモン</b>（2倍）: 相手が1枚も上げていなかった</li>
      <li><b>バックギャモン</b>（3倍）: さらに、相手の駒がバーか、勝った側のホームに残っていた</li>
      <li>点 = この倍率 × キューブの値。マネーゲームの「ジャコビー・ルール」では、キューブを一度も上げていない局のギャモン・バックギャモンは1倍です（早くダブルする理由になる）</li>
      <li>投了もできます（払う点を選ぶ。相手はもっと取れそうなら断れます）</li></ul></div>`;
    else if (rulesTab === 'cube') body = `<div class="card"><h3>ダブリングキューブ: 賭け点を2倍に</h3><ul>
      <li>自分の番で<b>サイコロを振る前</b>に「ダブル」と言うと、相手は <b>テイク</b>（受けて2倍で続ける）か <b>パス</b>（降りて、今の点を払って負け）を選びます</li>
      <li>テイクした側がキューブを持ち、次に上げられるのはその人だけ（2 → 4 → 8 …）。最初は真ん中にあり、どちらも上げられます（盤では「64」の面で真ん中）</li>
      <li><b>ビーバー</b>（マネーゲームで「ビーバーも」を選んだとき）: ダブルされた側が、受けてすぐに自分が持つキューブを2倍にする（キューブは4倍、持ち主はビーバーした側）</li>
      <li>目安: 相手が受けてよいのはおおよそ勝率 20〜25% 以上のとき。AI補助の形勢パネルに、この局面での判断（ノーダブル・ダブル／テイク・ダブル／パスの値）が出ます</li></ul></div>`;
    else if (rulesTab === 'match') body = `<div class="card"><h3>マッチ（3・5・7点）とクロフォード</h3><ul>
      <li>何局か続けて、先に決めた点（例えば5点）に届いたほうが勝ち。点の差によって、ギャモンやキューブの価値が変わります</li>
      <li><b>クロフォード・ルール</b>: どちらかが「あと1点」になった直後の1局だけはキューブを使えません。その次の局からはまた使えます（負けている側はすぐダブルするのがふつう）</li>
      <li>マッチのキューブの判断は、自分たちで計算したマッチの勝率表（自己対局で測ったギャモン率から）で行います</li></ul></div>`;
    else if (rulesTab === 'ui') body = `<div class="card"><h3>画面の操作</h3><ul>
      <li>自分の番: 盤の「タップして振る」か下の「振る」。ダブルするときは右のキューブか「ダブル」</li>
      <li>動かす駒をタップ → 行き先が光り、ほかはやんわり暗くなる → 行き先をタップで動きます。目を続けて使う先も光ります。途中でヒットするかどうかで違いが出るときだけ、小さな選択が出ます</li>
      <li>動かし終えたら「確定」（サイコロを押しても確定）。「戻す」で1歩ずつ戻せます。設定で「自動で確定」もできます</li>
      <li>棋譜テープ（⏮ ◀ ▶ ⏭）で振り返り。「この対局を分析」で悪手（? や ??）に印が付きます。「待った」は CPU 戦とふたりのときだけ</li>
      <li>「AI補助」で勝率・ギャモン率・キューブの判断・おすすめの手（矢印）をまとめて出し入れ。オンラインでは相手にも表示されます</li></ul></div>`;
    el.innerHTML = docTabs(T, rulesTab, 'rt') + body;
    el.querySelector('.doctabs').addEventListener('click', e => { const b = e.target.closest('[data-rt]'); if (b) { rulesTab = b.dataset.rt; renderRules(); } });
  }
  function renderAIPage() {
    const el = $('view-ai');
    const T = [['how', 'しくみ'], ['str', '強さの記録'], ['cube', 'キューブ'], ['dice', 'サイコロの公正さ']];
    const info = window.BG_STRENGTH;
    const w = WTS || {};
    let body = '';
    if (aiTab === 'how') body = `<div class="card"><h3>自己対局だけで学んだネット（TD-Gammon の系統）</h3>
      <p>この AI は、既存のバックギャモンのソフト（GNU Backgammon・eXtreme Gammon など）、人の棋譜、人が作った評価式（pubeval など）を一切使っていません。知っているのはルールだけで、強さはすべて自分どうしの対局から得ています。</p>
      <ul><li><b>評価ネット</b>: 局面（各ポイントの駒の数・バー・上がり）を入れると、手番側の「勝ち・ギャモン勝ち・バックギャモン勝ち・ギャモン負け・バックギャモン負け」の確率を出す小さなニューラルネット（入力196 → 中間${w.H || 128} → 出力5）</li>
      <li><b>学び方</b>: 何も知らない状態から自己対局を繰り返し、TD(λ) で「次の局面の見立て」と「最後の結果」に近づくよう少しずつ直す（累計 ${w.games ? Number(w.games).toLocaleString() : '—'} 局、第${w.gen != null ? w.gen : '—'}世代）</li>
      <li><b>読み</b>: 動かしたあとの局面について、相手（と自分）のサイコロ21通りを全部たどり、それぞれ最善の手で動かした結果の平均をとる（やさしい・ふつう = 読まない、つよい = 1回先、最強 = 2回先。良さそうな手に絞って深く読む）</li>
      <li><b>キューブ</b>: ネットの勝率とギャモン率から、キューブの効き（完全に生きているキューブと死んだキューブの間）を見積もって、ダブル・テイクを決める</li></ul></div>`;
    else if (aiTab === 'str') body = `<div class="card"><h3>強さの記録（自己対局の世代ごと）</h3>${info && info.html ? info.html : '<p class="hint">測定の結果は README と train/ にあります（学習が進むと更新）。</p>'}
      <p class="hint">対戦は「サイコロを揃えた」組（同じ目の列で先後を入れ替えて2局）で、キューブなしのマネー（ギャモン2点・バックギャモン3点）。点/局 は1局あたりの平均の得点。基準は自作のものだけ: ランダム（合法手から無作為）、先へ進めるだけ（後ろの駒から前へ）、学習前の第0世代、第1世代（自己対局25万局。Elo はこれを 0 として直接対戦させた値。第0世代にはどの世代も全勝して差が測れないため）。学習は続いていて、世代が増えるとこの表と CPU のネットが更新されます。</p></div>`;
    else if (aiTab === 'cube') body = `<div class="card"><h3>キューブとマッチの勝率表も自前</h3><ul>
      <li>ダブル・テイクの判断は、ネットの「勝ち・ギャモン」の確率から、キューブが「完全に生きている（いつでも最適に上げ下げできる）」場合と「死んでいる（もう動かない）」場合の値を出し、その間をキューブの効き x（${(BGAI.PARAM.x).toFixed(2)}）で混ぜて決めます</li>
      <li>マッチの勝率表（あと何点で勝つか同士の勝率）は、人の作った表を使わず、自己対局で測ったギャモン率 ${pct(BGAI.PARAM.gammon)}・バックギャモン率 ${pct(BGAI.PARAM.bg, 2)} と同じキューブの考え方から、点の少ないほうから順に計算しています</li>
      </ul><h3 style="margin-top:8px">マッチの勝率表（行 = 自分があと何点、列 = 相手があと何点。局の始め）</h3>
      <div class="tbl"><table class="lv"><tr><th></th>${[1, 2, 3, 4, 5, 6, 7].map(b => `<th>${b}</th>`).join('')}</tr>${[1, 2, 3, 4, 5, 6, 7].map(a => `<tr><th>${a}</th>${[1, 2, 3, 4, 5, 6, 7].map(b => `<td>${(BGAI.MET(a, b, false) * 100).toFixed(0)}</td>`).join('')}</tr>`).join('')}</table></div>
      <p class="hint">あと1点どうし以外で「あと1点」があるのはクロフォードの局（キューブなし）。単位は %</p></div>`;
    else if (aiTab === 'dice') body = `<div class="card"><h3>オンラインのサイコロは、どちらも操作できない</h3><ul>
      <li>局の始めに、2人がそれぞれ秘密の乱数から SHA-256 の鎖を作り、鎖のいちばん上（アンカー）だけを相手に送ります。これで、あとから自分の乱数を変えられなくなります（コミット）</li>
      <li>振るたびに、2人が鎖を1つずつさかのぼった値を公開します。受け取った側は、その値の SHA-256 が前の値と一致するかで本物か確かめます。先の値は前の値からは計算できないので、相手の次の乱数は誰にも分かりません</li>
      <li>目は「白の値・黒の値・番号」をまとめて SHA-256 にかけた結果から、偏りなく 1〜6 を2つ取り出します</li>
      <li>振る側は「ダブルしないで振る」と決めてから自分の値を送り、相手はそれを受けて自分の値を返します。だから振る側は目を知ってからダブルを決められず、相手も自分の値を選べません。できる不正は「返事をしない」ことだけで、画面に出ます</li></ul></div>`;
    el.innerHTML = docTabs(T, aiTab, 'at') + body;
    el.querySelector('.doctabs').addEventListener('click', e => { const b = e.target.closest('[data-at]'); if (b) { aiTab = b.dataset.at; renderAIPage(); } });
  }

  // ------------------------------------------------------------------ 画面の配置（ページはスクロールさせず、盤の大きさを画面に合わせる）
  let layoutMode = 'port';
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const mode = vh < 540 && vw > vh * 1.2 ? 'land' : vw >= 980 && vh >= 560 ? 'wide' : 'port';
    if (mode !== layoutMode) { closeSheet(); layoutMode = mode; }
    document.body.classList.remove('lay-port', 'lay-land', 'lay-wide');
    document.body.classList.add('lay-' + mode);
    const ratio = BGBoard.W / BGBoard.H;
    const main = $('main'), col = $('board-col');
    if ($('view-play').hidden) return;
    const mh = main.clientHeight - 8;
    if (mode === 'land') {
      const bw = Math.min(Math.floor(mh * ratio), Math.max(300, col.clientWidth - 272));
      col.style.setProperty('--board-w', bw + 'px');
    } else {
      const others = ['player-top', 'player-bottom'].map(id => $(id).offsetHeight).reduce((a, b) => a + b, 0) + document.querySelector('.boardfoot').offsetHeight + document.querySelector('.controls').offsetHeight + 6 * 6 + 4;
      const bw = Math.max(260, Math.min(col.clientWidth, Math.floor((mh - others) * ratio), 980));
      col.style.setProperty('--board-w', bw + 'px');
    }
  }
  function placeSheet() {
    if (layoutMode !== 'port') return;
    const fr = $('board').getBoundingClientRect(), h = window.innerHeight;
    $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.62, Math.max(h * 0.3, fr.bottom + 6))) + 'px');
  }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && (tab === 'ev' || tab === 'graph')) tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (layoutMode === 'wide') return;
    placeSheet();
    side.classList.add('open');
    renderSide();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  // ------------------------------------------------------------------ オンライン対戦（../common/online.js）
  // 公開版（GitHub Pages）や自分のサーバーでだけ使う。サイコロは online-bg.js の方式（両者の乱数のコミットと公開）
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available() && window.BGDice && BGDice.ok();
  const GAME = 'backgammon';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/backgammon/';
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { len: 5, msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.arrow ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? 'おすすめの手' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }
  const lenText = len => (Number(len) ? `${len}点マッチ` : 'マネー1局');
  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: GAME,
      onStatus: st => { renderOnlineBadge(); renderLobby(); if (S.online) { if (st === 'on') onlineResync(); renderInfo(); renderPlayers(); } },
      onPresence: () => { renderOnlineBadge(); renderLobby(); tryRoom(); },
      onMatch: g => startOnline(g),
      onRemote: m => onRemote(m),
      onOppPresence: p => { if (S.online) { S.online.oppPresent = p; renderInfo(); renderPlayers(); if (p) onlineResync(); } },
      onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
    });
    NET.setName(myName); NET.setAI(aiFlags()); NET.connect();
    // 届かなかった連絡の出し直し（返事待ちのときだけ）
    setInterval(() => { if (S.online) onlineTick(); }, 4000);
    return NET;
  }
  // オンラインの対局の状態（S.online）: { mid, mySide, opp:{name, ai, hints}, myHints, oppPresent, myRe, oppRe,
  //   secrets: {gi: 自分の秘密}, anchors: {gi: [白, 黒]}, reveals: {gi: [[白…], [黒…]]}, chains: {gi: 自分の鎖}（保存しない）, rolling, resignOffer, oppResign }
  function startOnline(g) {
    ['dlg-online', 'dlg-new', 'dlg-result', 'dlg-resign'].forEach(id => { $(id).hidden = true; });
    const r = g.r || {};
    const len = [0, 3, 5, 7].includes(Number(r.len)) ? Number(r.len) : 5;
    const mySide = g.myColor ? 1 : 0;
    const cfg = { len, cube: true, jacoby: false, beaver: false, single: !len };
    const online = { mid: g.mid, mySide, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, myRe: false, oppRe: false, secrets: {}, anchors: {}, reveals: {}, chains: {} };
    const seats = mySide === 0 ? ['human', 'remote'] : ['remote', 'human'];
    loadMatch({ cfg, mode: 'online', seats, games: [{ actions: [] }], gi: 0, bottom: mySide, online });
    snd('cube');
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    S.online = null;
  }
  // 自分の鎖（局ごと）。秘密は保存してあるので、再読み込みしても同じ鎖を作り直せる
  async function myChain(gi) {
    const o = S.online;
    if (o.chains[gi]) return o.chains[gi];
    if (!o.secrets[gi]) { o.secrets[gi] = BGDice.randomSecret(); save(); }
    const c = await BGDice.makeChain(o.secrets[gi], BGDice.CHAIN);
    o.chains[gi] = c;
    return c;
  }
  async function sendAnchor(gi) {
    const o = S.online; if (!o) return;
    const c = await myChain(gi);
    if (!o.anchors[gi]) o.anchors[gi] = [null, null];
    o.anchors[gi][o.mySide] = c[0];
    NET.send({ t: 'anc', gi, a: c[0] });
    save();
  }
  // k 回目の自分の公開値
  async function myReveal(gi, k) { const c = await myChain(gi); return c[k + 1]; }
  const revs = (gi, side) => { const o = S.online; if (!o.reveals[gi]) o.reveals[gi] = [[], []]; return o.reveals[gi][side]; };
  // 相手の公開値を確かめて入れる（順番どおり。前の値かアンカーにつながること）
  async function acceptReveal(gi, k, v) {
    const o = S.online, opp = o.mySide ^ 1, list = revs(gi, opp);
    if (list[k]) return list[k] === v;
    if (k !== list.length) return false;
    const anc = o.anchors[gi] && o.anchors[gi][opp];
    if (!anc) return false;
    const prev = k === 0 ? anc : list[k - 1];
    if (!(await BGDice.verify(prev, v))) { console.warn('相手の公開値が鎖につながらない', gi, k); return false; }
    if (list[k]) return list[k] === v;
    list[k] = v; save();
    return true;
  }
  // その局で今までに使った「振り」の回数（振り分けの振り直しも数える）
  const rollsUsed = gi => S.games[gi].actions.filter(a => a.a === 'open' || a.a === 'roll').length;
  // 両方の値がそろった振りを行動に（順番どおり）
  async function settleRolls() {
    const o = S.online; if (!o) return;
    const gi = S.gi, k = rollsUsed(gi);
    const w = revs(gi, 0)[k], b = revs(gi, 1)[k];
    if (!w || !b) return;
    const st = S.st;
    if (!(st.phase === 'open' || st.phase === 'turn')) return;
    if (st.phase === 'turn' && !o.rollAsked && !(o.rollReq && o.rollReq.k === k)) return; // 振る側が振ると決めたときだけ
    const d = await BGDice.diceFrom(w, b, `${o.mid}:${gi}:${k}`);
    if (S.gi !== gi || rollsUsed(gi) !== k) return;
    const opening = st.phase === 'open';
    o.rolling = false; o.rollAsked = false; o.rollReq = null;
    S.busy = true;
    await rollAnim(d, opening);
    S.busy = false;
    if (S.gi !== gi || rollsUsed(gi) !== k) return;
    push(opening ? { a: 'open', d } : { a: 'roll', d });
    if (opening && d[0] === d[1]) S.msg = `${d[0]} と ${d[1]} の同じ目なので振り直し`;
    else if (opening) S.msg = `${SIDE[0]} ${d[0]}・${SIDE[1]} ${d[1]} → ${seatName(S.st.turn)}（${SIDE[S.st.turn]}）が先手`;
    else S.msg = '';
    render(); schedule();
  }
  function onlineSchedule() {
    const o = S.online, st = S.st;
    render();
    if (st.phase === 'open') {
      // 振り分け: アンカーがそろったら、両方が自動で公開値を出す
      (async () => {
        const gi = S.gi;
        if (!o.anchors[gi] || !o.anchors[gi][o.mySide]) await sendAnchor(gi);
        const k = rollsUsed(gi);
        if (o.anchors[gi] && o.anchors[gi][0] && o.anchors[gi][1]) {
          const v = await myReveal(gi, k);
          if (!revs(gi, o.mySide)[k]) { revs(gi, o.mySide)[k] = v; save(); }
          NET.send({ t: 'rv', gi, k, v });
          settleRolls();
        }
      })();
      return;
    }
    const actor = actorOf(st);
    if (isHuman(actor)) {
      if (st.phase === 'turn' && settings.autoroll && (!BG.canDouble(st) || BG.mustRoll(st)) && !o.rolling) { S.timer = later(() => { if (S.online && S.st.phase === 'turn' && isHuman(S.st.turn)) onlineRoll(); }, 380); return; }
      if (st.phase === 'move') { beginHumanMove(); return; }
      analyzeNow();
    }
  }
  // 自分が振る: 自分の公開値を送る（= ダブルしないで振ると決めた合図）。相手の値が届いたら目が決まる
  async function onlineRoll() {
    const o = S.online, st = S.st;
    if (!o || st.phase !== 'turn' || !isHuman(st.turn) || o.rolling) return;
    o.rolling = true; o.rollAsked = true;
    const gi = S.gi, k = rollsUsed(gi);
    const v = await myReveal(gi, k);
    revs(gi, o.mySide)[k] = v; save();
    NET.send({ t: 'roll', gi, k, v });
    render();
    settleRolls();
  }
  function onlineSendAct(a) {
    const o = S.online; if (!o) return;
    NET.send({ t: 'act', gi: S.gi, n: S.games[S.gi].actions.length, a });
  }
  function onlineNextGame() {
    const o = S.online;
    if (!o || S.st.phase !== 'over' || matchDone()) return;
    if (S.games.length === S.gi + 1) S.games.push({ actions: [] });
    S.gi = S.games.length - 1;
    S.view = null; S.resultShown = false;
    recompute(); save(); sendAnchor(S.gi); render(); schedule();
  }
  // 保持の状態（再読み込み・取りこぼしで追いつく）。common/online.js の saveState は t を時刻で上書きするので、k:'st' で見分ける
  function saveOnline() {
    const o = S.online; if (!o || !NET) return;
    NET.saveState({ k: 'st', v: 1, games: S.games, anchors: o.anchors, reveals: o.reveals, r: S.st.phase === 'over' ? 1 : 0 });
  }
  function onlineResync() {
    const o = S.online; if (!o || !NET) return;
    NET.send({ t: 'sync', gi: S.gi, n: S.games[S.gi].actions.length });
    saveOnline();
  }
  // 返事待ちの連絡を出し直す
  function onlineTick() {
    const o = S.online; if (!o || !NET || NET.status !== 'on') return;
    const gi = S.gi, k = rollsUsed(gi);
    if (S.st.phase === 'open' || o.rolling) { const v = revs(gi, o.mySide)[k]; if (v) NET.send({ t: o.rolling ? 'roll' : 'rv', gi, k, v }); }
    if (o.anchors[gi] && o.anchors[gi][o.mySide] && !(o.anchors[gi][o.mySide ^ 1])) NET.send({ t: 'anc', gi, a: o.anchors[gi][o.mySide] });
  }
  async function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    const opp = o.mySide ^ 1;
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      onlineResync(); save(); renderPlayers(); renderInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; save(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; save(); renderPlayers(); }
    else if (msg.t === 'anc' && typeof msg.a === 'string' && /^[0-9a-f]{64}$/.test(msg.a)) {
      const gi = msg.gi | 0;
      if (!o.anchors[gi]) o.anchors[gi] = [null, null];
      if (!o.anchors[gi][opp]) { o.anchors[gi][opp] = msg.a; save(); }
      if (!o.anchors[gi][o.mySide] && gi === S.gi) await sendAnchor(gi);
      if (gi === S.gi && S.st.phase === 'open') onlineSchedule();
    } else if (msg.t === 'rv' || msg.t === 'roll') {
      const gi = msg.gi | 0, k = msg.k | 0;
      if (gi !== S.gi) return;
      if (!(await acceptReveal(gi, k, String(msg.v || '')))) return;
      if (msg.t === 'roll') {
        // 相手が振ると決めた: 相手の番で振る前なら、自分の値を返す
        if (S.st.phase === 'turn' && isRemote(S.st.turn) && rollsUsed(gi) === k) {
          o.rollReq = { k };
          const v = await myReveal(gi, k);
          revs(gi, o.mySide)[k] = v; save();
          NET.send({ t: 'rv', gi, k, v });
        } else if (rollsUsed(gi) > k) { const v = revs(gi, o.mySide)[k]; if (v) NET.send({ t: 'rv', gi, k, v }); }
      }
      settleRolls();
    } else if (msg.t === 'act' && msg.a && typeof msg.a === 'object') {
      const gi = msg.gi | 0, n = msg.n | 0;
      if (gi !== S.gi || n !== S.games[gi].actions.length) return;
      const a = sanitizeAct(msg.a);
      if (!a || ['open', 'roll'].includes(a.a)) return;
      const st = S.st, actor = a.a === 'resign' ? a.s : actorOf(st);
      if (actor !== opp && !(a.a === 'resign' && a.s === o.mySide && o.resignOffer === a.v)) return;
      try {
        const before = st;
        if (a.a === 'move') { S.busy = true; await animateHops(st.turn, a.h); S.busy = false; }
        if (S.games[gi].actions.length !== n) return;
        push(a);
        if (a.a === 'double' || a.a === 'take' || a.a === 'pass') snd('cube');
        if (a.a === 'resign') o.resignOffer = null;
        void before;
      } catch (e) { S.busy = false; console.warn('相手の行動を受け付けられない', e.message); return; }
      S.msg = a.a === 'take' ? `${o.opp.name}さんはテイク` : a.a === 'pass' ? `${o.opp.name}さんはパス` : '';
      render(); schedule();
    } else if (msg.t === 'sync') {
      saveOnline();
    } else if (msg.t === 'state' || (msg.k === 'st' && Array.isArray(msg.games))) {
      mergeState(msg);
    } else if (msg.t === 'rsg?') {
      // 相手の投了の申し出
      const v = Math.max(1, Math.min(3, msg.v | 0));
      o.oppResign = v; render(); askResign(v);
    } else if (msg.t === 'rsg!') {
      if (!o.resignOffer) return;
      if (msg.ok) {
        const a = { a: 'resign', s: o.mySide, v: o.resignOffer };
        // 受けた側が行動として送ってくるので、ここでは待つ
        void a;
      } else { S.msg = `${o.opp.name}さんは投了を断りました`; o.resignOffer = null; render(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderInfo(); }
    else if (msg.t === 'rego' && typeof msg.gid === 'string') {
      NET.start({ mid: msg.gid.slice(0, 20), myColor: msg.oc ? 1 : 0, r: { len: S.cfg.len }, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  function sanitizeAct(a) {
    const k = String(a.a || '');
    if (k === 'move') { if (!Array.isArray(a.h) || a.h.length > 4) return null; return { a: 'move', h: a.h.map(h => [h[0] | 0, h[1] | 0]) }; }
    if (['double', 'take', 'pass', 'beaver'].includes(k)) return { a: k };
    if (k === 'resign') return { a: 'resign', s: a.s | 0, v: Math.max(1, Math.min(3, a.v | 0)) };
    return null;
  }
  // 保持の状態との突き合わせ: アンカー・公開値（鎖で確かめて）・行動（合法か確かめて）を足りない分だけ取り込む
  async function mergeState(msg) {
    const o = S.online; if (!o || !Array.isArray(msg.games)) return;
    const opp = o.mySide ^ 1;
    if (msg.anchors) for (const gi in msg.anchors) { const a = msg.anchors[gi]; if (Array.isArray(a) && typeof a[opp] === 'string' && /^[0-9a-f]{64}$/.test(a[opp])) { if (!o.anchors[gi]) o.anchors[gi] = [null, null]; if (!o.anchors[gi][opp]) o.anchors[gi][opp] = a[opp]; } }
    if (msg.reveals) for (const gi in msg.reveals) { const r = msg.reveals[gi]; if (Array.isArray(r) && Array.isArray(r[opp])) for (let k = revs(gi, opp).length; k < r[opp].length; k++) { if (!(await acceptReveal(Number(gi), k, String(r[opp][k])))) break; } }
    // 行動: 今の局までの食い違いがないか見て、足りない分を順に
    let changed = false;
    for (let gi = 0; gi < msg.games.length && gi < 60; gi++) {
      const rg = msg.games[gi]; if (!rg || !Array.isArray(rg.actions)) break;
      if (!S.games[gi]) { if (gi === S.games.length && S.st.phase === 'over' && !matchDone()) { S.games.push({ actions: [] }); S.gi = gi; recompute(); } else break; }
      const mine = S.games[gi].actions;
      for (let i = 0; i < Math.min(mine.length, rg.actions.length); i++) if (JSON.stringify(mine[i]) !== JSON.stringify(rg.actions[i])) return; // 食い違うものは使わない
      if (gi !== S.gi) continue;
      for (let i = mine.length; i < rg.actions.length; i++) {
        const ra = rg.actions[i];
        let a;
        if (ra.a === 'open' || ra.a === 'roll') {
          // 目は公開値から自分で計算する
          const k = rollsUsed(gi), w = revs(gi, 0)[k], b = revs(gi, 1)[k];
          if (!w || !b) break;
          const d = await BGDice.diceFrom(w, b, `${o.mid}:${gi}:${k}`);
          if (!Array.isArray(ra.d) || ra.d[0] !== d[0] || ra.d[1] !== d[1]) break;
          a = { a: ra.a, d };
        } else a = sanitizeAct(ra);
        if (!a) break;
        try { push(a); changed = true; } catch (e) { break; }
      }
    }
    if (changed) { o.rolling = false; o.rollAsked = false; S.pm = null; clearSel(); render(); schedule(); }
  }
  // 投了（オンライン）: 申し出 → 相手が受けたら、相手が行動として送ってくる
  function onlineOfferResign(v) {
    const o = S.online; if (!o) return;
    o.resignOffer = v;
    NET.send({ t: 'rsg?', v });
    S.msg = `投了（${['', 'シングル', 'ギャモン', 'バックギャモン'][v]}）を申し出ました。相手の返事を待っています`;
    render();
  }
  function askResign(v) {
    const o = S.online; if (!o) return;
    const pts = BG.gamePoints(S.st, v);
    const ok = confirm(`${o.opp.name}さんが投了を申し出ています（${['', 'シングル', 'ギャモン', 'バックギャモン'][v]}・${pts}点）。受けますか？`);
    if (!S.online || S.st.phase === 'over') return;
    NET.send({ t: 'rsg!', ok: ok ? 1 : 0 });
    if (ok) { const a = { a: 'resign', s: o.mySide ^ 1, v }; try { push(a); onlineSendAct(a); } catch (e) { /* 終局済み */ } }
    o.oppResign = null;
    render(); schedule();
  }
  // 途中でやめる（新しい対局を始めるとき）: バックギャモンの点で投了
  function onlineForfeit() {
    const o = S.online; if (!o || S.st.phase === 'over') return;
    try { const a = { a: 'resign', s: o.mySide, v: 3 }; NET.send({ t: 'act', gi: S.gi, n: S.games[S.gi].actions.length, a }); } catch (e) { /* 無視 */ }
    leaveOnline();
  }
  // もう一局: 両方が希望したら、ID の小さい方が新しい対局を作る（色は交代）
  function requestRematch() {
    const o = S.online; if (!o || !NET) return;
    o.myRe = true;
    NET.send({ t: 're' });
    maybeRematch();
    S.msg = '相手の返事を待っています（もう一局）';
    renderInfo();
  }
  function maybeRematch() {
    const o = S.online;
    if (!o || !o.myRe || !o.oppRe || !NET || !NET.game) return;
    const oppId = NET.game.oppId;
    if (oppId && NET.id > oppId) return;
    const gid = Math.random().toString(36).slice(2, 12);
    NET.send({ t: 'rego', gid, oc: o.mySide });
    NET.start({ mid: gid, myColor: o.mySide ^ 1, r: { len: S.cfg.len }, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.g === GAME && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null;
    const q = new URLSearchParams(location.search); q.delete('room');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
    lobby.msg = `${p.n}さんに申し込みました…`;
    NET.challenge(p.id);
    renderLobby();
  }
  function openOnline() {
    if (!ONLINE_OK) {
      lobby.msg = '';
      $('dlg-online').hidden = false;
      $('on-body').innerHTML = `<p>オンライン対戦は、公開版（GitHub Pages）で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    net();
    $('dlg-online').hidden = false;
    renderLobby();
  }
  function renderOnlineBadge() {
    const b = $('btn-online'); if (!b) return;
    const st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    // 「対戦」の文字は狭い画面でも必ず出す（数字だけだとオンライン対戦の入口と分からないため）。つながっていないときは「オンライン」
    b.querySelector('.lbl').textContent = st === 'on' || st === 'connecting' ? '対戦' : 'オンライン';
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g.wait}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', all = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const c = all && Object.assign({ online: all.online }, all.byGame[GAME] ? { wait: all.byGame[GAME].wait, play: all.byGame[GAME].play } : { wait: 0, play: 0 });
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === GAME) : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    const inGame = S.online && S.st.phase !== 'over';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(c && c.wait)}</b><span>バックギャモンの対戦待ち</span></div>
        <div class="stat"><b>${num(c && c.play)}</b><span>対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・おすすめの手を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b><span class="hint">${esc(lenText(p.r && p.r.len))}</span>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}"${inGame ? ' disabled' : ''}>対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「この形式で待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span><b>${esc(lenText(me.r && me.r.len))}</b>で待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `<div class="seg" data-seg="len">${[[0, 'マネー1局'], [3, '3点'], [5, '5点'], [7, '7点マッチ']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${lobby.len === v}">${l}</button>`).join('')}</div>
             <div>${inGame ? '<span class="hint">対局の途中は待てません（終わってから）</span>' : `<button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>この形式で待つ</button>`}</div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。サイコロは2人の乱数を合わせて決めるので、どちらも操作できません（AI のページに説明）。</p>`;
  }
  function bindOnline() {
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const segEl = b.closest('[data-seg]');
      if (segEl) { lobby.len = Number(b.dataset.v); renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { if (S.online && S.st.phase === 'over') leaveOnline(); lobby.msg = ''; NET.wait({ len: lobby.len }, lenText(lobby.len)); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); }
    });
  }

  // ------------------------------------------------------------------ はじまり
  board = BGBoard.create($('board'), { mirror: settings.mirror, numbers: settings.numbers });
  bind(); bindOnline();
  layout();
  if (!WTS) { $('info').innerHTML = '<span class="txt">AI のデータ（js/weights.js）が読み込めませんでした</span>'; }
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  let restored = false;
  if (saved && saved.cfg && Array.isArray(saved.games) && saved.games.length) {
    try {
      // オンライン対局は、続きができる場所（つながる・終わっていない）でだけ戻す
      if (saved.online && !ONLINE_OK) { saved.online = null; saved.mode = 'pvp'; saved.seats = ['human', 'human']; }
      if (saved.online) saved.online = Object.assign({ myHints: 0, secrets: {}, anchors: {}, reveals: {} }, saved.online, { chains: {}, oppPresent: true, myRe: false, oppRe: false, rolling: false });
      loadMatch(saved);
      if (S.online && NET) {
        if (S.st.phase === 'over' && matchDone()) { S.online = null; S.seats = S.seats.map(x => (x === 'remote' ? 'human' : x)); S.mode = 'pvp'; save(); render(); }
        else NET.rejoin({ mid: S.online.mid, myColor: S.online.mySide, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } });
      }
      restored = true;
    } catch (e) { console.error(e); }
  }
  if (!restored) { drawNew(); $('dlg-new').hidden = false; newMatch(Object.assign({}, draft)); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); render(); });
  // 確かめ用（テストの自動操作）。人の操作と同じ関数を通す
  window.__bg = {
    S, CPUP, ANP, AN, render, layout, push, entries, newMatch, setSetting, settings, get board() { return board; },
    test: {
      roll: humanRoll, double: offerDouble, respond, confirm: confirmMove, again, nextGame,
      playRandom() {
        if (!S.pm || S.busy || S.pm.forced) return false;
        const m = S.pm.legal[Math.floor(Math.random() * S.pm.legal.length)];
        S.pm.me = Int8Array.from(m.me); S.pm.opp = Int8Array.from(m.opp); S.pm.hops = m.hops.map(h => h.slice()); S.pm.dice = [];
        confirmMove();
        return true;
      },
    },
  };
})();
