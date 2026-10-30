/* 大富豪 Webアプリ: 卓の画面・手札の操作・CPU（Web Worker）・AI補助・演出と音・記録と振り返り・ルールと AI のページ
 * オンラインの卓は js/online-table.js が DFApp を通して動かす
 */
(function () {
  'use strict';
  const D = DFCore, A = DFAI, C = DFCards, SND = DFSound, LV = DFLevels;
  const { PASS, GROUP, SEQ, PICK, XFER, JOKER } = D;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  C.install();

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('daifugo-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('daifugo-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  const settings = Object.assign({ sound: true, anim: true, fast: false, autopass: true, four: false, showProb: true, showBest: true, sortRev: false }, store.get('settings', {}));
  const aiOn = () => settings.showProb || settings.showBest;
  let cfg = Object.assign({ cpu: 'normal', games: 5 }, store.get('cfg', {}));
  cfg.rules = D.normRules(cfg.rules);
  const CPU = LV.LEVELS, CPU_KEYS = LV.KEYS;
  const POS = ['あなた', '右', '向かい', '左'];
  const TITLE = D.RANK_TITLES;
  const PTS = [3, 2, 1, 0];
  const HAS_NET = !!window.DF_WEIGHTS;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    online: null,          // オンラインの卓（online-table.js が入れる）: { send(mv), myHints, seatsInfo }
    me: 0,                 // 自分の席（画面ではいつも下）
    seats: [],             // [{ kind: 'human'|'cpu'|'remote', name, level, ai, hints }]
    rules: cfg.rules, games: cfg.games, round: 0, scores: [0, 0, 0, 0], history: [], prev: null,
    g: null, hands0: null, moves: [], snaps: [], recs: [],
    view: null, sel: new Set(), busy: false, timer: 0, thinking: -1,
    analysis: null, lastAnalysis: null, hint: null, got: [], reviewAll: false, bad: {}, revAn: {},
    pile: null, bubbles: {}, resultShown: false, cpuCfg: cfg.cpu, ended: false,
  };
  const live = () => S.view === null;
  const shownG = () => (live() ? S.g : S.snaps[S.view]);
  const pos = seat => (seat - S.me + 4) & 3;
  const seatName = seat => {
    const st = S.seats[seat];
    if (!st) return '';
    if (seat === S.me) return st.kind === 'cpu' ? '手前の CPU' : 'あなた';
    if (st.kind === 'remote') return `${esc(st.name)}さん`;
    return `${POS[pos(seat)]}<span class="sfx">の CPU</span>`;
  };
  const watching = () => !!(S.seats[S.me] && S.seats[S.me].kind === 'cpu');
  const shortName = seat => (seat === S.me ? (watching() ? '手前' : 'あなた') : S.seats[seat] && S.seats[seat].kind === 'remote' ? esc(S.seats[seat].name) : POS[pos(seat)]);
  const isHumanTurn = () => live() && S.g && S.g.phase !== 'done' && S.g.actor === S.me && !S.busy && S.seats[S.me] && S.seats[S.me].kind === 'human'
    && (!S.online || (S.online.canAct() && !S.g.hands[S.me].some(c => c < 0)));

  // ------------------------------------------------------------------ CPU と AI補助（Web Worker）
  const AI = {
    w: null, id: 0, cb: new Map(), failed: false,
    worker() {
      if (this.w || this.failed) return this.w;
      try {
        this.w = new Worker('js/ai-worker.js');
        this.w.onmessage = e => { const f = this.cb.get(e.data.id); if (f) { this.cb.delete(e.data.id); f(e.data); } };
        this.w.onerror = () => { this.failed = true; this.w = null; this.cb.forEach(f => f({ error: 'worker' })); this.cb.clear(); };
      } catch (e) { this.failed = true; this.w = null; }
      return this.w;
    },
    ask(msg) {
      return new Promise(res => {
        const w = this.worker();
        if (!w) { res(this.local(msg)); return; }
        const id = ++this.id;
        this.cb.set(id, d => res(d.error ? this.local(msg) : d));
        w.postMessage(Object.assign({ id }, msg));
      });
    },
    // Worker が使えないとき（file:// で開いたときなど）はこのページで考える
    net: null,
    local(msg) {
      if (!this.net && HAS_NET) this.net = A.makeNet(A.dequantize(window.DF_WEIGHTS));
      const g = D.Game.fromJSON(msg.game);
      if (msg.type === 'move') { const r = LV.choose(g, msg.level, this.net, Math.random); return { mv: r.mv }; }
      if (!this.net) return { res: null };
      return { res: A.evaluate(g, this.net).sort((a, b) => b.ev - a.ev) };
    },
  };

  // ------------------------------------------------------------------ 対局の始まり
  function newSeats(level, watch) {
    return [0, 1, 2, 3].map(i => (i === 0 && !watch ? { kind: 'human', name: 'あなた', ai: 0, hints: 0 } : { kind: 'cpu', name: POS[i], level, ai: 0, hints: 0 }));
  }
  function startMatch(c) {
    if (S.online && window.DFOnline) window.DFOnline.leave();
    cfg = c; store.set('cfg', cfg);
    S.online = null; S.me = 0;
    S.seats = newSeats(cfg.cpu, !!cfg.watch); S.cpuCfg = cfg.cpu;
    S.rules = D.normRules(cfg.rules); S.games = cfg.games;
    S.round = 0; S.scores = [0, 0, 0, 0]; S.history = []; S.prev = null; S.ended = false;
    startRound();
  }
  function randSeed() { const u = new Uint32Array(1); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(u) : (u[0] = Math.random() * 4294967296); return u[0]; }
  function startRound() {
    clearTimeout(S.timer);
    S.round++;
    const rnd = D.rng32(randSeed());
    const start = S.prev ? (S.prev.indexOf(3) + 1) & 3 : Math.floor(rnd() * 4);
    const hands = D.deal(S.rules, rnd, start);
    loadRound({ hands0: hands, moves: [], prev: S.prev });
    animateDeal();
  }
  // 配った手と手順から、その回を作り直す（再読み込み・保存から）
  function loadRound(r) {
    S.hands0 = r.hands0.map(h => h.slice());
    S.g = new D.Game(S.rules, { hands: S.hands0, prev: r.prev, leader: r.leader, auto: r.auto });
    S.moves = []; S.snaps = [S.g.clone()]; S.recs = [];
    S.view = null; S.sel = new Set(); S.analysis = null; S.lastAnalysis = null; S.hint = null; S.bad = {}; S.revAn = {}; S.reviewAll = false;
    S.resultShown = false; S.pile = null; S.thinking = -1;
    S.got = [];
    // 交換で決まりどおりに移った札（XFER）を記録に
    for (const e of S.g.log) if (e.k === XFER) { S.recs.push({ p: e.p, to: e.to, kind: 'xfer', cards: e.cards, snap: 0 }); if (e.to === S.me) S.got.push(...e.cards); }
    for (const mv of r.moves || []) applyQuiet(mv);
    if (S.online) S.online.got = S.got;
  }
  function applyQuiet(mv) {
    const g = S.g, p = g.actor, pendBefore = g.pend ? Object.assign({}, g.pend) : null;
    g.apply(mv);
    S.moves.push(mv);
    S.snaps.push(g.clone());
    pushRec(p, mv, pendBefore, g.events);
  }
  function pushRec(p, mv, pend, events) {
    const rec = { p, mv, kind: mv.k === PICK ? (pend ? pend.kind : 'pick') : mv.k === PASS ? 'pass' : 'play', to: pend ? pend.to : -1, cards: mv.cards.slice(), events: events.map(e => e.t), snap: S.snaps.length - 1 };
    S.recs.push(rec);
    if (rec.kind === 'give' && rec.to === S.me) S.got.push(...mv.cards);
  }

  function saveGame() {
    if (S.online) return;
    store.set('game', { v: 1, cfg, seats: S.seats, rules: S.rules, games: S.games, round: S.round, scores: S.scores, history: S.history, prev: S.prev, ended: S.ended,
      cur: { hands0: S.hands0, prev: S.snaps[0] ? S.snaps[0].prev : null, moves: S.moves } });
  }

  // ------------------------------------------------------------------ 進行
  function schedule() {
    clearTimeout(S.timer);
    const g = S.g;
    if (!g) return;
    S.thinking = -1;
    if (!live()) { renderAll(); return; }
    if (g.phase === 'done') { renderAll(); finishRound(); return; }
    const p = g.actor, st = S.seats[p];
    if (S.busy) return;
    if (st.kind === 'human' && p === S.me) {
      const L = g.legal();
      renderAll();
      if (!g.pend && settings.autopass && L.length === 1 && L[0].k === PASS) {
        S.timer = setTimeout(() => { if (isHumanTurn() && S.g === g) submit(L[0], true); }, settings.fast ? 450 : 900);
        return;
      }
      if (aiOn()) analyze();
      SND.play('turn');
      return;
    }
    if (S.online || st.kind === 'remote') { renderAll(); return; } // オンライン: ほかの人・CPU の手はホストから届く
    // CPU
    S.thinking = p;
    renderOpponents();
    const t0 = Date.now(), snap = S.moves.length;
    AI.ask({ type: 'move', game: g.toJSON(), level: st.level || 'normal' }).then(r => {
      if (S.g !== g || S.moves.length !== snap || !live()) return;
      const legal = g.legal();
      let mv = r && r.mv;
      if (!mv || !legal.some(x => D.moveKey(x) === D.moveKey(mv))) mv = A.chooseWeakest(g);
      let pace = settings.fast ? 220 : mv.k === PASS ? 520 : g.pend ? 380 : 820;
      if (g.out[S.me]) pace = Math.round(pace * 0.5);   // 自分があがったあとは早送り
      S.timer = setTimeout(() => { if (S.g === g && S.moves.length === snap && live()) submit(mv); }, Math.max(0, pace - (Date.now() - t0)));
    });
  }

  // 手を出す（オンラインならホストへ送る。ホストと1人のときはその場で）
  function submit(mv, auto) {
    if (S.online) { S.online.submit(mv); S.sel.clear(); renderAll(); return; } // 手はホストが並べてから、みんなの画面に届く
    applyMove(mv, { auto });
  }

  // 交換で決まりどおりに札が移る（オンライン: ホストの手順から）
  function applyXfer(from, to, cards) {
    const g = S.g;
    g.xfer(from, to, cards);
    S.moves.push({ k: XFER, from, to, cards });
    S.snaps.push(g.clone());
    S.recs.push({ p: from, to, kind: 'xfer', cards: cards.slice(), events: [], snap: S.snaps.length - 1 });
    if (to === S.me) S.got.push(...cards.filter(c => c >= 0));
    if (from === S.me && g.prev) toast(`${TITLE[g.prev[to]]}（${shortName(to)}）に強い札を渡しました: ${D.moveText({ k: PICK, cards })}`);
    else if (to === S.me && g.prev) toast(`${TITLE[g.prev[from]]}（${shortName(from)}）から ${D.moveText({ k: PICK, cards })} を受け取りました`);
    SND.play('give');
    renderAll();
  }
  // 手を進める（演出つき）
  function applyMove(mv, opt = {}) {
    const g = S.g, p = g.actor;
    clearTimeout(S.timer);
    S.thinking = -1;
    const trickBefore = g.trick.slice();
    const fly = settings.anim && !reduceMotion && opt.anim !== false ? flyFrom(p, mv) : null;
    const pendBefore = g.pend ? Object.assign({}, g.pend) : null;
    g.apply(mv);
    S.moves.push(mv);
    S.snaps.push(g.clone());
    pushRec(p, mv, pendBefore, g.events);
    if (p === S.me) { S.sel.clear(); S.hint = null; S.analysis = null; if (mv.k !== PICK) S.got = []; }
    const ev = g.events.slice();
    const cleared = ev.some(e => e.t === 'clear');
    if (mv.k === GROUP || mv.k === SEQ) S.pile = cleared ? trickBefore.concat([{ p, mv }]) : null;
    S.busy = true;
    const done = () => {
      renderAll();
      playEvents(p, mv, ev, pendBefore);
      saveGame();
      const wait = cleared ? (settings.fast ? 450 : 900) : ev.some(e => e.t === 'rev' || e.t === 'miyako') ? 700 : 60;
      setTimeout(() => {
        if (cleared) clearPileAnim(() => { S.pile = null; S.busy = false; renderAll(); schedule(); });
        else { S.busy = false; schedule(); }
      }, wait);
    };
    if (fly) fly.then(done); else done();
  }

  function finishRound() {
    if (S.resultShown) return;
    S.resultShown = true;
    if (S.online) { renderAll(); if (S.online.onRoundEnd) S.online.onRoundEnd(); return; } // 点数はホストの検査のあとで
    const g = S.g, rk = g.rank.slice();
    for (let s = 0; s < 4; s++) S.scores[s] += PTS[rk[s]];
    S.history.push({ rank: rk });
    S.prev = rk;
    if (S.games && S.round >= S.games) S.ended = true;
    saveGame();
    const meR = rk[S.me];
    if (!watching()) SND.play(meR <= 1 ? 'win' : 'lose', 0.2);
    setTimeout(showResult, settings.fast ? 300 : 900);
  }

  // ------------------------------------------------------------------ 人の操作（手札をえらぶ → 出す）
  const realOf = cards => cards.filter(c => c < JOKER).sort((a, b) => a - b);
  const jkOf = cards => cards.filter(c => c >= JOKER).length;
  const selKey = cards => realOf(cards).join(',') + '|' + jkOf(cards);
  function subsetOf(sel, mv) {
    const r = new Set(mv.cards.filter(c => c < JOKER));
    let j = 0;
    for (const c of sel) { if (c >= JOKER) j++; else if (!r.has(c)) return false; }
    return j <= mv.jk;
  }
  function legalNow() { return isHumanTurn() ? S.g.legal() : []; }
  function playsNow() { return legalNow().filter(m => m.k === GROUP || m.k === SEQ); }
  // いまの選び方と同じ札の組の手（階段でジョーカーの位置だけが違うときは複数）
  function exactMoves() {
    const sel = [...S.sel];
    if (!sel.length) return [];
    const k = selKey(sel);
    return playsNow().filter(m => selKey(m.cards) === k);
  }
  function pickMode() { return isHumanTurn() && !!S.g.pend; }
  function onCard(c) {
    hideChooser();
    if (!isHumanTurn()) { if (live() && S.g && S.g.phase !== 'done') { S.sel.has(c) ? S.sel.delete(c) : S.sel.add(c); renderHand(); renderInfo(); } return; }
    if (pickMode()) {
      const need = S.g.pend.left;
      if (S.sel.has(c)) S.sel.delete(c);
      else { if (S.sel.size >= need) { const first = S.sel.values().next().value; S.sel.delete(first); } S.sel.add(c); }
      renderHand(); renderControls(); renderInfo();
      return;
    }
    const plays = playsNow();
    if (S.sel.has(c)) { S.sel.delete(c); }
    else {
      const next = [...S.sel, c];
      if (plays.some(m => subsetOf(next, m))) S.sel.add(c);
      else if (plays.some(m => subsetOf([c], m))) S.sel = new Set([c]);   // ほかの組み合わせ: えらび直し
      else { nudge(c); return; }
      // 場に合わせて、ひと通りしかないなら残りもえらぶ（場がペアで、その数がちょうど2枚 など）
      if (S.g.field && S.sel.size === 1) {
        const cand = plays.filter(m => subsetOf([...S.sel], m));
        const keys = new Set(cand.map(m => selKey(m.cards)));
        if (keys.size === 1 && cand[0].cards.length > 1) S.sel = new Set(cand[0].cards.map(x => (x >= JOKER ? (S.g.hands[S.me].find(h => h >= JOKER && !S.sel.has(h)) || x) : x)));
      }
    }
    renderHand(); renderControls(); renderInfo();
  }
  function nudge(c) {
    const el = document.querySelector(`.hc[data-c="${c}"]`);
    if (!el || reduceMotion) return;
    el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 220 });
  }
  function onPlay() {
    if (!isHumanTurn()) return;
    if (pickMode()) {
      const need = S.g.pend.left;
      if (S.sel.size !== need) return;
      const cards = [...S.sel];
      S.sel.clear();
      const t0 = Date.now();
      const step = () => {
        if (!cards.length) return;
        // 前の札の動きが終わるのを待つ（オンラインでは、ホストが前の札を手順に入れて次の番が来るのを待つ）
        if (S.busy || (S.online && !isHumanTurn() && Date.now() - t0 < 15000)) { setTimeout(step, 100); return; }
        if (!isHumanTurn() || !S.g.pend) return;
        const c = cards.shift();
        const mv = S.g.legal().find(m => m.cards[0] === c);
        if (!mv) return;
        submit(mv);
        if (cards.length) setTimeout(step, settings.fast ? 120 : 260);
      };
      step();
      return;
    }
    const ms = exactMoves();
    if (!ms.length) return;
    if (ms.length === 1) { submit(ms[0]); return; }
    showChooser(ms);
  }
  function onPass() {
    if (!isHumanTurn() || pickMode()) return;
    const mv = S.g.legal().find(m => m.k === PASS);
    if (mv) submit(mv);
  }
  function showChooser(ms) {
    hideChooser();
    const box = document.createElement('div');
    box.className = 'choose'; box.id = 'chooser';
    box.innerHTML = `<div class="ttl">ジョーカーの使い方をえらんでください</div>` + ms.map((m, i) => `<button class="act" data-i="${i}">${esc(D.moveText(m))}</button>`).join('') + '<button class="quiet" data-i="-1">やめる</button>';
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); hideChooser(); const i = Number(b.dataset.i); if (i >= 0) submit(ms[i]); });
    document.body.appendChild(box);
    const r = $('btn-play').getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.left)) + 'px';
    box.style.top = Math.max(8, r.top - box.offsetHeight - 8) + 'px';
  }
  function hideChooser() { const c = $('chooser'); if (c) c.remove(); }

  // ------------------------------------------------------------------ AI補助
  let anId = 0;
  function analyze(force) {
    if (!HAS_NET || !isHumanTurn() || (!aiOn() && !force)) return;
    const g = S.g, n = S.moves.length, id = ++anId;
    AI.ask({ type: 'analyze', game: g.toJSON() }).then(r => {
      if (id !== anId || S.g !== g || S.moves.length !== n || !r || !r.res) return;
      S.analysis = { n, res: r.res };
      S.lastAnalysis = S.analysis;
      renderAI(); renderHand();
    });
  }
  function hint() {
    if (!isHumanTurn() || !HAS_NET) return;
    if (S.online && S.online.useHint) S.online.useHint();
    const g = S.g, n = S.moves.length;
    AI.ask({ type: 'analyze', game: g.toJSON() }).then(r => {
      if (S.g !== g || S.moves.length !== n || !r || !r.res || !r.res.length) return;
      S.hint = { n, res: r.res };
      const best = r.res[0].mv;
      toast(g.pend ? `ヒント: ${D.moveText({ k: PICK, cards: r.res.slice(0, g.pend.left).map(x => x.mv.cards[0]) })} を${g.pend.kind === 'discard10' ? '捨てる' : '渡す'}` : best.k === PASS ? 'ヒント: ここはパス' : `ヒント: ${D.moveText(best)} を出す（えらんでおきました）`);
      if (best.k !== PASS) {
        if (g.pend) S.sel = new Set(r.res.slice(0, g.pend.left).map(x => x.mv.cards[0]));
        else S.sel = new Set(best.cards);
      } else S.sel.clear();
      renderAll();
    });
  }

  // 振り返り: 終わった回の自分の判断を、学んだネットで見直して「？」を付ける
  async function reviewAnalysis() {
    if (!HAS_NET) return;
    const jobs = [];
    S.recs.forEach((r, i) => { if (r.p === S.me && r.kind !== 'xfer' && !S.revAn[i]) jobs.push(i); });
    for (const i of jobs) {
      const r = S.recs[i], before = S.snaps[r.snap - 1];
      if (!before) continue;
      const L = before.legal();
      if (L.length < 2) continue;
      const res = await AI.ask({ type: 'analyze', game: before.toJSON() });
      if (!res || !res.res) continue;
      const k = D.moveKey(r.mv), mine = res.res.find(x => D.moveKey(x.mv) === k);
      S.revAn[i] = { res: res.res, mine };
      const bestAr = A.avgRank(res.res[0].pr), mineAr = mine ? A.avgRank(mine.pr) : bestAr;
      if (mineAr - bestAr > 0.25) S.bad[i] = true;
      renderTape(); renderLog();
    }
  }

  // ------------------------------------------------------------------ 演出
  function cardHTML(c, cls = '') { return C.svg(c, cls); }
  function miniCards(cards) { return cards.map(c => `<span class="mc">${cardHTML(c)}</span>`).join(''); }
  function chips(cards) { return cards.map(c => C.chip(c)).join(''); }
  function flyFrom(p, mv) {
    if (!mv.cards.length) return null;
    const pile = $('pile').getBoundingClientRect();
    let srcs = [];
    if (p === S.me) srcs = mv.cards.map(c => { const el = document.querySelector(`.hc[data-c="${c}"]`); return el ? el.getBoundingClientRect() : null; });
    const opp = p === S.me ? null : document.querySelector(`#opp-${pos(p)} .backs`) || $(`opp-${pos(p)}`);
    const or = opp ? opp.getBoundingClientRect() : null;
    const fw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fw')) || 54;
    const isPick = mv.k === PICK;
    const pend = S.g.pend;
    let tr = { x: pile.left + pile.width / 2, y: pile.top + pile.height / 2 };
    if (isPick && pend && pend.to >= 0) {
      const t = pend.to === S.me ? $('hand') : document.querySelector(`#opp-${pos(pend.to)} .backs`) || $(`opp-${pos(pend.to)}`);
      if (t) { const r = t.getBoundingClientRect(); tr = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    }
    const showFace = !isPick || p === S.me || (pend && pend.to === S.me) || (pend && pend.kind === 'discard10');
    const n = mv.cards.length, w = fw;
    const anims = mv.cards.map((c, i) => {
      const el = document.createElement('div');
      el.className = 'fly';
      el.style.width = w + 'px';
      el.innerHTML = cardHTML(showFace ? c : -1);
      document.body.appendChild(el);
      const s = srcs[i] || or || pile;
      const sx = s.left + s.width / 2 - w / 2, sy = s.top + s.height / 2 - w * 0.7;
      const dx = tr.x - w / 2 + (i - (n - 1) / 2) * w * 0.58, dy = tr.y - w * 0.7;
      const scale0 = srcs[i] ? srcs[i].width / w : 0.5;
      const a = el.animate([
        { transform: `translate(${sx}px, ${sy}px) scale(${scale0})`, opacity: srcs[i] ? 1 : 0.6 },
        { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 },
      ], { duration: settings.fast ? 170 : 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
      return a.finished.then(() => el.remove(), () => el.remove());
    });
    return Promise.all(anims);
  }
  function clearPileAnim(cb) {
    const sets = document.querySelectorAll('#pile .play-set');
    if (!sets.length || !settings.anim || reduceMotion) { cb(); return; }
    SND.play('clear');
    let n = sets.length;
    sets.forEach((el, i) => {
      el.animate([{ transform: el.style.transform || 'none', opacity: 1 }, { transform: `${el.style.transform || ''} translateX(120%) rotate(12deg)`, opacity: 0 }], { duration: settings.fast ? 200 : 380, delay: i * 30, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' })
        .finished.then(() => { if (--n === 0) cb(); }, () => { if (--n === 0) cb(); });
    });
  }
  function stamp(text, small) {
    const el = $('stamp');
    el.textContent = text;
    el.className = 'stamp' + (small ? ' small' : '');
    void el.offsetWidth;
    el.classList.add('show');
  }
  function bubble(seat, text) {
    S.bubbles[seat] = { text, t: Date.now() };
    renderOpponents(); renderMeHead();
    setTimeout(() => { if (S.bubbles[seat] && Date.now() - S.bubbles[seat].t >= 1100) { delete S.bubbles[seat]; renderOpponents(); renderMeHead(); } }, 1200);
  }
  function playEvents(p, mv, ev, pend) {
    let stamped = false;
    const st = (t, small) => { if (!stamped || !small) { stamp(t, small); stamped = !small || stamped; } };
    if (mv.k === GROUP || mv.k === SEQ) SND.play('card');
    if (mv.k === PICK) SND.play('give');
    for (const e of ev) {
      if (e.t === 'pass') { SND.play('pass'); bubble(e.p, 'パス'); }
      else if (e.t === 'rev') { st(e.on ? '革命' : '革命返し'); SND.play('rev'); flash(); }
      else if (e.t === 'jback') { st('11バック', true); SND.play('skip'); }
      else if (e.t === 'eight') { st('8切り'); SND.play('eight'); }
      else if (e.t === 'sp3') { st('スペ3返し'); SND.play('eight'); }
      else if (e.t === 'lockSuit') { st('しばり', true); SND.play('lock'); }
      else if (e.t === 'lockNum') { st('階段しばり', true); SND.play('lock'); }
      else if (e.t === 'skip') { st(`${e.n}人とばし`, true); SND.play('skip'); }
      else if (e.t === 'skipped') bubble(e.p, 'とばし');
      else if (e.t === 'seven') { st('7渡し', true); }
      else if (e.t === 'ten') { st('10捨て', true); }
      else if (e.t === 'finish') { bubble(e.p, `あがり！${TITLE[e.rank]}`); SND.play('finish', 0.15); if (e.p === S.me) st(TITLE[e.rank]); }
      else if (e.t === 'foul') { bubble(e.p, '反則あがり'); st('反則あがり', true); SND.play('lose'); }
      else if (e.t === 'miyako') { bubble(e.p, '都落ち'); st('都落ち'); SND.play('miyako', 0.2); }
    }
    void pend;
  }
  function flash() {
    if (reduceMotion || !settings.anim) return;
    const f = document.createElement('div');
    f.className = 'flash';
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 800);
  }
  function animateDeal() {
    S.busy = true;
    renderAll();
    const finish = () => { S.busy = false; renderAll(); afterDeal(); };
    if (!settings.anim || reduceMotion) { finish(); return; }
    const pile = $('felt').getBoundingClientRect();
    const fw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fw')) || 54;
    const targets = [0, 1, 2, 3].map(s => {
      const el = s === S.me ? $('hand') : document.querySelector(`#opp-${pos(s)} .backs`) || $(`opp-${pos(s)}`);
      return el ? el.getBoundingClientRect() : pile;
    });
    const total = S.hands0.reduce((a, h) => a + h.length, 0);
    const start = S.prev ? (S.prev.indexOf(3) + 1) & 3 : 0;
    const gap = settings.fast ? 10 : 22;
    let pending = total;
    // 手札はいったん隠し、配り終わってから見せる
    $('hand').style.visibility = 'hidden';
    for (let i = 0; i < total; i++) {
      const s = (start + i) & 3, t = targets[s];
      const el = document.createElement('div');
      el.className = 'fly'; el.style.width = fw * 0.8 + 'px';
      el.innerHTML = cardHTML(-1);
      document.body.appendChild(el);
      const sx = pile.left + pile.width / 2 - fw * 0.4, sy = pile.top + pile.height / 2 - fw * 0.56;
      const dx = t.left + t.width / 2 - fw * 0.4 + (Math.random() - 0.5) * 12, dy = t.top + t.height / 2 - fw * 0.56;
      setTimeout(() => SND.play('deal'), i * gap);
      el.animate([{ transform: `translate(${sx}px, ${sy}px) rotate(0deg)`, opacity: 0 }, { transform: `translate(${sx}px, ${sy}px)`, opacity: 1, offset: 0.1 }, { transform: `translate(${dx}px, ${dy}px) rotate(${(Math.random() - 0.5) * 30}deg)`, opacity: 0.9 }],
        { duration: settings.fast ? 200 : 340, delay: i * gap, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' })
        .finished.then(() => { el.remove(); if (--pending === 0) { $('hand').style.visibility = ''; finish(); } }, () => { el.remove(); if (--pending === 0) { $('hand').style.visibility = ''; finish(); } });
    }
  }
  function afterDeal() {
    const g = S.g;
    // 交換で受け取った・渡した札を知らせる
    const x = S.recs.filter(r => r.kind === 'xfer');
    const mine = x.find(r => r.p === S.me), got = x.find(r => r.to === S.me);
    if (mine) toast(`${TITLE[g.prev[mine.to]]}（${shortName(mine.to)}）に強い札を渡しました: ${D.moveText({ k: PICK, cards: mine.cards })}`);
    else if (got) toast(`${TITLE[g.prev[got.p]]}（${shortName(got.p)}）から ${D.moveText({ k: PICK, cards: got.cards })} を受け取りました`);
    schedule();
  }
  let toastMsg = null;
  function toast(msg) { toastMsg = { msg, t: Date.now() }; renderInfo(); setTimeout(() => { if (toastMsg && Date.now() - toastMsg.t >= 3900) { toastMsg = null; renderInfo(); } }, 4000); }

  // ------------------------------------------------------------------ 描画
  function renderAll() {
    document.body.classList.toggle('ai-off', !aiOn());
    document.body.classList.toggle('four-color', !!settings.four);
    fit();
    renderOpponents(); renderField(); renderMeHead(); renderHand(); renderInfo(); renderAI(); renderControls(); renderTape(); renderLog(); renderScores(); renderSeen();
  }

  // 札の大きさを画面に合わせる
  function fit() {
    const hand = $('hand'), felt = $('felt');
    if (!hand || !hand.offsetParent) return;
    const W = hand.clientWidth || 340;
    const g = shownG(), n = g ? Math.max(10, g.hands[S.me].length) : 13;
    const land = window.matchMedia('(orientation: landscape) and (max-height: 599px)').matches;
    const maxH = land ? window.innerHeight * 0.2 : window.innerHeight * 0.15;
    const cw = Math.round(Math.max(36, Math.min(W / (1 + 0.38 * (n - 1)), maxH / 1.4, 96)));
    document.documentElement.style.setProperty('--cw', cw + 'px');
    const fr = felt.getBoundingClientRect();
    const fw = Math.round(Math.max(34, Math.min(fr.width / 6.2, (fr.height - 40) / 1.75, 92)));
    document.documentElement.style.setProperty('--fw', fw + 'px');
  }

  function rankBadge(g, seat) {
    if (!g.prev) return '';
    const r = g.prev[seat];
    return `<span class="rk r${r}">${TITLE[r]}</span>`;
  }
  function aiTagHTML(st) {
    if (!S.online || !st || st.kind === 'cpu') return '';
    const on = !!st.ai || !!st.hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${st.ai ? 'AI補助を出しています' : 'AI補助なし'}${st.hints ? `・ヒント${st.hints}回` : ''}">${st.ai ? 'AI補助あり' : 'AI補助なし'}${st.hints ? `・ヒント${st.hints}` : ''}</span>`;
  }
  function statusHTML(g, seat) {
    if (g.out[seat]) {
      const r = g.rank[seat];
      return `<span class="pl-st done">${g.order.indexOf(seat) >= 0 && r >= 0 ? `${r + 1}位 ${TITLE[r]}` : 'あがり'}</span>`;
    }
    if (live() && S.thinking === seat) return '<span class="pl-st think"><i></i>考え中</span>';
    if (live() && g.phase !== 'done' && g.actor === seat && S.seats[seat] && S.seats[seat].kind === 'remote') return '<span class="pl-st think"><i></i>考え中</span>';
    if (g.passed[seat] && g.field) return '<span class="pl-st pass">パス</span>';
    return '';
  }
  function backsHTML(n) {
    const k = Math.min(n, window.innerWidth < 560 ? 5 : 9);
    let s = '';
    for (let i = 0; i < k; i++) s += `<span class="bk" style="left:${i * 3.2}px">${cardHTML(-1)}</span>`;
    return `<div class="backs" style="width:${k ? 19 + (k - 1) * 3.2 : 0}px">${s}</div>`;
  }
  function renderOpponents() {
    const g = shownG();
    if (!g) return;
    for (let ps = 1; ps < 4; ps++) {
      const seat = (S.me + ps) & 3, el = $(`opp-${ps}`), st = S.seats[seat] || {};
      const turn = live() && g.phase !== 'done' && g.actor === seat;
      el.classList.toggle('turn', turn);
      el.classList.toggle('out', !!g.out[seat]);
      const n = g.hands[seat].length;
      const sub = st.kind === 'cpu' ? (CPU[st.level] ? CPU[st.level].label : '') : st.kind === 'remote' ? '' : '';
      const reveal = !live() && S.reviewAll && n ? `<div class="revealed">${chips(handOrder(g.hands[seat]))}</div>` : '';
      const b = S.bubbles[seat];
      el.innerHTML = `
        <div class="pl-head">${rankBadge(g, seat)}<span class="pl-name">${seatName(seat)}</span>${sub ? `<span class="pl-sub">${sub}</span>` : ''}${aiTagHTML(st)}</div>
        <div class="pl-body">${backsHTML(n)}<span class="cnt">${n}<small>枚</small></span>${statusHTML(g, seat)}</div>${reveal}
        ${b ? `<span class="bubble">${esc(b.text)}</span>` : ''}`;
    }
  }
  function renderMeHead() {
    const g = shownG();
    if (!g) return;
    const el = $('me'), head = $('me-head');
    el.classList.toggle('turn', live() && g.phase !== 'done' && g.actor === S.me);
    el.classList.toggle('out', !!g.out[S.me]);
    const b = S.bubbles[S.me];
    const st = S.seats[S.me] || {};
    head.innerHTML = `${rankBadge(g, S.me)}<span class="pl-name">${watching() ? `手前の CPU（${CPU[st.level] ? CPU[st.level].label : ''}・観戦中）` : 'あなた'}</span>${aiTagHTML(st)}${statusHTML(g, S.me)}<span class="score">${S.games ? `${S.round}/${S.games}回戦` : `${S.round}回戦`}・${S.scores[S.me]}点</span>${b ? `<span class="bubble" style="bottom:auto;top:-14px">${esc(b.text)}</span>` : ''}`;
  }

  function chipsHTML(g) {
    const ch = [];
    if (g.rev) ch.push('<span class="chip hot">革命中</span>');
    if (g.back) ch.push('<span class="chip hot">11バック</span>');
    if (g.lockSuit) { let s = ''; for (let i = 0; i < 4; i++) if (g.lockSuit & (1 << i)) s += C.suitIcon(i); ch.push(`<span class="chip lock">しばり ${s}</span>`); }
    if (g.numLock) ch.push('<span class="chip lock">階段しばり</span>');
    if (g.dir < 0 && !g.rev && !g.back) ch.push('<span class="chip hot">逆</span>');
    return ch.join('');
  }
  function renderField() {
    const g = shownG();
    if (!g) return;
    $('felt').classList.toggle('rev', g.dir < 0);
    $('chips').innerHTML = chipsHTML(g);
    const trick = live() && S.pile ? S.pile : g.trick;
    const pile = $('pile');
    if (!trick.length) {
      const lead = g.phase === 'done' ? '' : g.phase === 'give' ? 'カード交換' : g.actor >= 0 ? `${seatName(g.actor)}${g.actor === S.me ? 'から' : 'から出します'}` : '';
      pile.innerHTML = `<div class="empty">${S.online && S.online.waiting ? '始まるのを待っています' : g.phase === 'done' ? 'この回はおしまい' : g.phase === 'give' ? 'カードの交換中' : '場は空'}</div>`;
      $('leadtag').textContent = lead && g.phase === 'play' ? `親: ${seatName(g.actor).replace(/<[^>]+>/g, '')}` : '';
    } else {
      const shown = trick.slice(-3);
      const fw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fw')) || 54;
      pile.innerHTML = shown.map((t, i) => {
        const k = shown.length - 1 - i;
        const dx = -k * fw * 0.36, dy = -k * fw * 0.3, rot = (t.p * 7 % 9) - 4;
        return `<div class="play-set${k ? ' old' : ''}" style="transform:translate(${dx}px, ${dy}px) rotate(${k ? rot : 0}deg);z-index:${i + 1}">${t.mv.cards.map(c => `<div class="fc">${cardHTML(c)}</div>`).join('')}${k ? '' : `<span class="who">${seatName(t.p)}</span>`}</div>`;
      }).join('');
      $('leadtag').textContent = '';
    }
    $('roundtag').textContent = S.round ? `${S.games ? `第${S.round}回戦（${S.games}回）` : `第${S.round}回戦`}${S.online ? '・オンライン' : ''}` : S.online ? 'オンライン・始まる前' : '';
  }

  function handOrder(cards) {
    const a = cards.filter(c => c >= 0).slice().sort((x, y) => D.sortKey(x) - D.sortKey(y));
    return settings.sortRev ? a.reverse() : a;
  }
  function renderHand() {
    const g = shownG(), el = $('hand');
    if (!g) return;
    const cards = handOrder(g.hands[S.me]);
    const W = el.clientWidth || 340;
    const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 56;
    const n = cards.length;
    const step = n > 1 ? Math.min(cw * 1.04, (W - cw) / (n - 1)) : 0;
    const left0 = Math.max(0, (W - (cw + step * (n - 1))) / 2);
    const turn = isHumanTurn() && live();
    const plays = turn && !g.pend ? playsNow() : null;
    const sel = [...S.sel];
    const rec = new Set();
    const an = S.analysis && S.analysis.n === S.moves.length ? S.analysis : S.hint && S.hint.n === S.moves.length ? S.hint : null;
    if (an && (settings.showBest || S.hint) && an.res.length && turn) {
      if (g.pend) an.res.slice(0, g.pend.left).forEach(r => rec.add(r.mv.cards[0]));
      else if (an.res[0].mv.k !== PASS) an.res[0].mv.cards.forEach(c => rec.add(c));
    }
    const got = new Set(S.got);
    el.innerHTML = n ? cards.map((c, i) => {
      let cls = 'hc';
      if (S.sel.has(c)) cls += ' sel';
      if (plays && !S.sel.has(c)) {
        const can = plays.some(m => subsetOf(sel.concat([c]), m)) || plays.some(m => subsetOf([c], m));
        if (!can) cls += ' dim';
      }
      if (got.has(c) && live()) cls += ' got';
      if (rec.has(c)) cls += ' rec';
      return `<button class="${cls}" data-c="${c}" style="left:${(left0 + i * step).toFixed(1)}px;z-index:${i + 1}" aria-pressed="${S.sel.has(c)}" aria-label="${C.label(c)}${rec.has(c) ? '（おすすめ）' : ''}">${cardHTML(c)}${rec.has(c) ? '<i class="rd"></i>' : ''}</button>`;
    }).join('') : `<div class="emptyh">${g.out[S.me] ? `あがり（${TITLE[g.rank[S.me]]}）` : '手札なし'}</div>`;
  }

  // 情報の行
  function describeField(g) {
    const f = g.field;
    if (!f) return '';
    const locks = [];
    if (g.lockSuit) { let s = ''; for (let i = 0; i < 4; i++) if (g.lockSuit & (1 << i)) s += D.SUITS[i]; locks.push(`${s}しばり`); }
    if (g.numLock) locks.push('階段しばり');
    return `${D.kindText(f)}${locks.length ? `・${locks.join('・')}` : ''}${g.dir < 0 ? '・強さが逆' : ''}`;
  }
  function renderInfo() {
    const el = $('info'), g = shownG();
    if (!g) return;
    let html = '', tools = '', cls = 'info';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    if (S.online && S.online.waiting && live()) {
      cls += ' mine';
      html = `<span class="txt">${esc(S.online.waiting)}</span>`;
      tools = btn('online', 'オンライン');
    } else if (!live()) {
      cls += ' view';
      const r = S.recs[S.view - 1];
      html = `<span class="txt"><b>${S.view}手目</b> ${r ? recText(r) : '配ったところ'}</span>`;
      tools = (g.phase === 'done' || S.g.phase === 'done' ? btn('reveal', S.reviewAll ? '手札を隠す' : '全員の手札') : '') + btn('live', 'いまへ', ' primary');
    } else if (S.g.phase === 'done') {
      cls += ' result';
      const r = S.g.rank[S.me];
      html = `<span class="txt"><b>${watching() ? `${shortName(S.g.rank.indexOf(0))}が大富豪` : `あなたは${TITLE[r]}（${r + 1}位）`}</b>　${S.ended ? '対局おしまい' : ''}</span>`;
      tools = btn('review', '振り返る') + (S.online ? (S.online.isHost ? btn('next', '次の回へ', ' primary') : '') : btn(S.ended ? 'again' : 'next', S.ended ? 'もう一度' : '次の回へ', ' primary'));
    } else if (S.online && S.online.waiting) {
      cls += ' mine';
      html = `<span class="txt">${esc(S.online.waiting)}</span>`;
      tools = btn('online', 'オンライン');
    } else if (S.online && S.online.alert) {
      cls += ' alert';
      html = `<span class="txt">${esc(S.online.alert)}</span>`;
    } else if (toastMsg) {
      cls += ' mine';
      html = `<span class="txt">${esc(toastMsg.msg)}</span>`;
    } else if (isHumanTurn()) {
      cls += ' mine';
      if (g.pend) {
        const k = g.pend.left, verb = g.pend.kind === 'discard10' ? '捨てる' : '渡す';
        const to = g.pend.to >= 0 ? `${g.pend.kind === 'give' ? TITLE[g.prev[g.pend.to]] + '（' + shortName(g.pend.to) + '）' : shortName(g.pend.to)}に` : '';
        html = `<span class="txt"><b>${to}${verb}札を${k}枚</b>えらんでください（${S.sel.size}/${k}）</span>`;
      } else if (S.sel.size) {
        const ms = exactMoves();
        html = ms.length ? `<span class="txt">${chips(handOrder([...S.sel]))} <b>${D.kindText(ms[0])}</b>　「出す」で出します</span>` : `<span class="txt">${chips(handOrder([...S.sel]))} <span class="muted">あと何枚かえらんでください</span></span>`;
        tools = `<button class="ibtn" data-act="desel" aria-label="えらぶのをやめる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
      } else if (!g.field) html = '<span class="txt"><b>あなたが親です</b>　好きな札を出してください</span>';
      else {
        const can = g.legal().some(m => m.k !== PASS);
        html = `<span class="txt">${can ? `<b>${describeField(g)}</b>より強い札を出すか、パス` : '<b>出せる札がありません</b>　パスしてください'}</span>`;
      }
    } else if (g.phase === 'give') {
      html = `<span class="txt muted">${g.actor >= 0 ? `${TITLE[g.prev[g.actor]]}（${shortName(g.actor)}）が返す札をえらんでいます…` : 'カード交換'}</span>`;
    } else {
      const last = S.recs[S.recs.length - 1];
      html = `<span class="txt muted">${last ? recText(last) + '　' : ''}${g.actor >= 0 ? `${seatName(g.actor)}の番` : ''}</span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }
  function recText(r) {
    const who = shortName(r.p);
    if (r.kind === 'xfer') return `${who}→${shortName(r.to)}: ${r.p === S.me || r.to === S.me || (!live() && S.reviewAll) ? chips(r.cards) : `${r.cards.length}枚`}（交換）`;
    if (r.kind === 'give') return `${who}→${shortName(r.to)}: ${r.p === S.me || r.to === S.me || (!live() && S.reviewAll) ? chips(r.cards) : '1枚'}（交換）`;
    if (r.kind === 'give7') return `${who}→${shortName(r.to)}: ${r.p === S.me || r.to === S.me || (!live() && S.reviewAll) ? chips(r.cards) : '1枚'}（7渡し）`;
    if (r.kind === 'discard10') return `${who}: ${chips(r.cards)} を捨てた（10捨て）`;
    if (r.kind === 'pass') return `${who}: パス`;
    const tags = r.events.filter(t => ['rev', 'eight', 'sp3', 'jback', 'lockSuit', 'lockNum', 'miyako', 'finish', 'foul'].includes(t)).map(t => ({ rev: '革命', eight: '8切り', sp3: 'スペ3返し', jback: '11バック', lockSuit: 'しばり', lockNum: '階段しばり', miyako: '都落ち', finish: 'あがり', foul: '反則あがり' }[t]));
    return `${who}: ${chips(r.cards)}${tags.length ? ` <b>${tags.join('・')}</b>` : ''}`;
  }

  // AI補助の行
  function probHTML(pr) {
    return `<div class="probbar">${pr.map(x => `<i style="width:${(x * 100).toFixed(1)}%"></i>`).join('')}</div>
      <div class="probtxt"><span>大富豪 <b>${Math.round(pr[0] * 100)}%</b></span><span>富豪 <b>${Math.round(pr[1] * 100)}%</b></span><span>貧民 <b>${Math.round(pr[2] * 100)}%</b></span><span>大貧民 <b>${Math.round(pr[3] * 100)}%</b></span></div>`;
  }
  function mvShort(mv) { return mv.k === PASS ? 'パス' : chips(mv.cards); }
  function renderAI() {
    const el = $('aistrip');
    if (!el) return;
    let html = '';
    const g = S.g;
    if (!HAS_NET) html = '<span class="hint">AI補助は学習したネットが入ってから使えます</span><span></span>';
    else if (!live()) {
      const i = S.view - 1, a = S.revAn[i];
      if (a && a.res.length) {
        const best = a.res[0];
        html = `<div>${probHTML((a.mine || best).pr)}</div><span class="best">AI なら ${mvShort(best.mv)}</span>`;
      } else html = `<span class="hint">${S.recs[i] && S.recs[i].p === S.me ? (g.phase === 'done' ? '振り返りの読みを待っています…' : '回が終わると、あなたの判断を AI が見直します') : 'あなたの判断の場面で、AI の見直しが出ます'}</span><span></span>`;
    } else {
      const an = S.analysis && S.analysis.n === S.moves.length ? S.analysis : null;
      if (an && an.res.length) {
        const best = an.res[0];
        html = `<div>${settings.showProb ? probHTML(best.pr) : '<span class="hint">見込みは隠しています</span>'}</div><span class="best">${settings.showBest ? `おすすめ ${g.pend ? chips(an.res.slice(0, g.pend.left).map(r => r.mv.cards[0])) : mvShort(best.mv)}` : ''}</span>`;
      } else if (S.lastAnalysis && S.lastAnalysis.res.length && settings.showProb) {
        html = `<div style="opacity:.6">${probHTML(S.lastAnalysis.res[0].pr)}</div><span class="hint">前の番の見込み</span>`;
      } else html = `<span class="hint">${watching() ? '観戦中（AI補助は自分で打つときに使えます）' : isHumanTurn() ? '読んでいます…' : 'あなたの番で、順位の見込みとおすすめを出します'}</span><span></span>`;
    }
    el.innerHTML = html;
    // 右の欄（広い画面）・せり上がるパネルの「AI の読み」
    const det = $('aidetail');
    const an = live() ? (S.analysis && S.analysis.n === S.moves.length ? S.analysis : S.lastAnalysis) : S.revAn[S.view - 1];
    if (det && an && an.res && an.res.length) {
      const mineKey = !live() && S.revAn[S.view - 1] && S.revAn[S.view - 1].mine ? D.moveKey(S.revAn[S.view - 1].mine.mv) : null;
      det.innerHTML = `<ul class="cands">${an.res.slice(0, 8).map((r, i) => `<li class="${i === 0 ? 'top' : ''}"><span class="mv">${mvShort(r.mv)}${mineKey && D.moveKey(r.mv) === mineKey ? ' <b>（あなた）</b>' : ''}</span><span class="ar">${A.avgRank(r.pr).toFixed(2)}位</span><span class="minibar">${r.pr.map(x => `<i style="width:${(x * 100).toFixed(1)}%"></i>`).join('')}</span></li>`).join('')}</ul><p class="hint" style="margin:6px 0 0">数字は「その手を選んだときの平均の順位」の見込み（小さいほどよい）。棒は大富豪・富豪・貧民・大貧民になる見込み。</p>`;
      $('ai-info').textContent = live() ? 'いまの場面' : `${S.view}手目`;
    }
  }

  function renderControls() {
    const turn = isHumanTurn();
    const pm = pickMode();
    const pb = $('btn-play'), pa = $('btn-pass');
    if (pm) {
      const k = S.g.pend.left;
      pb.textContent = S.g.pend.kind === 'discard10' ? `捨てる（${S.sel.size}/${k}）` : `渡す（${S.sel.size}/${k}）`;
      pb.disabled = S.sel.size !== k;
      pa.disabled = true;
    } else {
      pb.textContent = '出す';
      pb.disabled = !turn || !exactMoves().length;
      pa.disabled = !turn || !S.g.field;
    }
    $('btn-hint').disabled = !turn || !HAS_NET;
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
  }

  // 記録のテープ（盤の下の横に流れる一覧）と右の記録
  function tapeLabel(r) {
    const who = `<span class="w">${shortName(r.p)}</span>`;
    if (r.kind === 'pass') return `${who}パス`;
    if (r.kind === 'xfer' || r.kind === 'give' || r.kind === 'give7') return `${who}→${shortName(r.to)}`;
    if (r.kind === 'discard10') return `${who}捨て`;
    return `${who}${chips(r.cards)}`;
  }
  function renderTape() {
    const el = $('tape');
    if (!el || !S.g) return;
    const cur = live() ? S.snaps.length - 1 : S.view;
    let html = `<button data-snap="0" class="${cur === 0 ? 'cur' : ''}">配り</button>`;
    S.recs.forEach((r, i) => {
      if (r.kind === 'xfer') return;
      const special = r.events.some(t => ['rev', 'eight', 'sp3', 'miyako', 'finish'].includes(t));
      html += `<button data-snap="${r.snap}" class="${cur === r.snap ? 'cur' : ''}${S.bad[i] ? ' bad' : ''}${special ? ' ev' : ''}">${tapeLabel(r)}${S.bad[i] ? '?' : ''}</button>`;
    });
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    const c = el.querySelector('.cur');
    if (c) el.scrollLeft = c.offsetLeft - el.clientWidth / 2 + c.offsetWidth / 2;
    const nav = $('navrow');
    nav.querySelector('[data-nav="first"]').disabled = cur === 0;
    nav.querySelector('[data-nav="prev"]').disabled = cur === 0;
    nav.querySelector('[data-nav="next"]').disabled = live();
    nav.querySelector('[data-nav="last"]').disabled = live();
  }
  function renderLog() {
    const el = $('loglist');
    if (!el || !S.g) return;
    const cur = live() ? S.snaps.length - 1 : S.view;
    el.innerHTML = `<li data-snap="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span class="who"></span>配ったところ</li>` + S.recs.map((r, i) => {
      const special = r.events && r.events.some(t => ['rev', 'eight', 'sp3', 'miyako', 'finish', 'foul'].includes(t));
      return `<li data-snap="${r.snap}" class="${cur === r.snap && r.kind !== 'xfer' ? 'cur' : ''}${special ? ' ev' : ''}${S.bad[i] ? ' bad' : ''}"><span class="no">${r.kind === 'xfer' ? '' : r.snap}</span><span class="who">${shortName(r.p)}</span>${recText(r).replace(/^[^:]*: /, '')}</li>`;
    }).join('');
    $('log-info').textContent = `${S.recs.length}手`;
    const c = el.querySelector('.cur');
    if (c && c.scrollIntoView) { const top = c.offsetTop, bottom = top + c.offsetHeight; if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 2; }
  }
  function renderScores() {
    const el = $('scores');
    if (!el) return;
    const rows = [0, 1, 2, 3].map(s => `<tr><td>${seatName(s)}</td>${S.history.map(h => `<td>${TITLE[h.rank[s]].replace('大', '大')}</td>`).join('')}<td class="n"><b>${S.scores[s]}</b></td></tr>`).join('');
    el.innerHTML = `<div class="tbl"><table class="scoretbl"><thead><tr><th></th>${S.history.map((_, i) => `<th>${i + 1}</th>`).join('')}<th class="n">点</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint" style="margin:6px 0 0">大富豪 3点・富豪 2点・貧民 1点・大貧民 0点。${S.games ? `${S.games}回戦で合計点のいちばん多い人の勝ち。` : ''}</p>`;
    $('score-info').textContent = S.games ? `${S.round}/${S.games}回戦` : `${S.round}回戦`;
  }

  // 出た札（みんなに見える札だけ: 出した札・10捨ての札）。自分の手札は青
  function renderSeen() {
    const el = $('seen'), g = shownG();
    if (!el || !g) return;
    const out = new Set(g.grave.filter(c => c >= 0)), mine = new Set(g.hands[S.me].filter(c => c >= 0));
    const cls = ['', 'r', 'd', 'c'];
    let html = '<span class="h"></span>' + D.RANKS.map(r => `<span class="h">${r}</span>`).join('');
    for (let su = 0; su < 4; su++) {
      html += `<span class="h ${cls[su]}">${D.SUITS[su]}</span>`;
      for (let r = 0; r < 13; r++) { const c = su * 13 + r; html += `<span class="${cls[su]}${out.has(c) ? ' out' : mine.has(c) ? ' mine' : ''}">${D.RANKS[r]}</span>`; }
    }
    const jkOut = g.grave.filter(c => c >= 52).length, jkMine = g.hands[S.me].filter(c => c >= 52).length;
    el.innerHTML = `<div class="seengrid">${html}</div><p class="hint" style="margin:6px 0 0">ジョーカー ${S.rules.jokers}枚のうち 出た ${jkOut}・あなた ${jkMine}。線を引いた札はもう出た札、青はあなたの手札。</p>`;
    const left = 52 + S.rules.jokers - g.grave.length - g.hands[S.me].length;
    $('seen-info').textContent = `ほかの人の手に ${Math.max(0, left)}枚`;
  }

  // ------------------------------------------------------------------ 振り返り
  function viewSnap(i) {
    hideChooser();
    if (i >= S.snaps.length - 1) { S.view = null; }
    else S.view = Math.max(0, i);
    S.sel.clear();
    renderAll();
    if (live()) schedule();
  }

  // ------------------------------------------------------------------ 結果
  function showResult() {
    const g = S.g, rk = g.rank;
    const order = [0, 1, 2, 3].sort((a, b) => rk[a] - rk[b]);
    const meR = rk[S.me];
    $('rs-sub').textContent = `${S.games ? `第${S.round}回戦（${S.games}回）` : `第${S.round}回戦`}${S.online ? '・オンライン' : ''}`;
    if (S.ended) {
      const tot = [0, 1, 2, 3].sort((a, b) => S.scores[b] - S.scores[a]);
      const top = S.scores[tot[0]], mine = S.scores[S.me];
      $('rs-title').textContent = mine === top ? (tot.filter(s => S.scores[s] === top).length > 1 ? '同点で1位' : 'あなたの優勝') : `あなたは${tot.findIndex(s => S.scores[s] === mine) + 1}位`;
      $('rs-list').innerHTML = tot.map(s => `<li class="${s === S.me ? 'me' : ''}"><span class="rk r${rk[s]}">${TITLE[rk[s]]}</span><span><b>${seatName(s)}</b></span><span class="pts">計 ${S.scores[s]}点</span></li>`).join('');
      $('rs-body').textContent = `${S.games}回戦の合計点（大富豪3・富豪2・貧民1・大貧民0）。`;
      $('rs-next').textContent = 'もう一度';
    } else {
      $('rs-title').textContent = watching() ? `${seatName(order[0]).replace(/<[^>]+>/g, '')}が大富豪` : `あなたは${TITLE[meR]}`;
      $('rs-list').innerHTML = order.map(s => {
        const evs = [];
        if (g.events && false) evs.push('');
        const miy = S.recs.some(r => r.events && r.events.includes('miyako')) && g.prev && g.prev[s] === 0 && rk[s] === 3;
        return `<li class="${s === S.me ? 'me' : ''}"><span class="rk r${rk[s]}">${TITLE[rk[s]]}</span><span><b>${seatName(s)}</b>${miy ? ' <span class="ev">都落ち</span>' : ''}</span><span class="pts">+${PTS[rk[s]]}点（計 ${S.scores[s]}）</span></li>`;
      }).join('');
      const opp = S.online ? 'オンラインの卓' : `CPU（${CPU[S.cpuCfg] ? CPU[S.cpuCfg].label : ''}）3人`;
      $('rs-body').textContent = `相手は${opp}。次の回は${S.rules.exchange ? 'カード交換から（大貧民⇄大富豪2枚、貧民⇄富豪1枚）' : '大貧民から'}始まります。`;
      $('rs-next').textContent = '次の回へ';
    }
    $('rs-next').hidden = !!(S.online && !S.online.isHost);
    $('dlg-result').hidden = false;
    $('rs-next').focus();
  }
  function nextRound() {
    $('dlg-result').hidden = true;
    if (S.online) { if (S.online.isHost && S.online.next) S.online.next(); return; }
    if (S.ended) { startMatch(cfg); return; }
    startRound();
  }

  // ------------------------------------------------------------------ 新しい対局
  let draft = null;
  function openNew() {
    draft = JSON.parse(JSON.stringify(cfg));
    drawNew();
    $('dlg-new').hidden = false;
    $('ng-start').focus();
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = (CPU[draft.cpu] ? CPU[draft.cpu].desc : '') + (HAS_NET ? '' : '（学習したネットがまだないので、どの強さも「弱い札から出す」打ち方です）');
    seg('ng-games', [[3, '3回戦'], [5, '5回戦'], [10, '10回戦'], [0, '制限なし']], draft.games);
    seg('ng-jokers', [[0, 'なし'], [1, '1枚'], [2, '2枚']], draft.rules.jokers);
    const sw = list => list.map(r => `<label class="switch" title="${esc(r.desc)}"><input type="checkbox" data-rule="${r.key}"${draft.rules[r.key] ? ' checked' : ''}> ${r.label}</label>`).join('');
    $('ng-basic').innerHTML = sw(D.RULE_LIST.filter(r => r.group === 'basic' && r.key !== 'jokers'));
    $('ng-local').innerHTML = sw(D.RULE_LIST.filter(r => r.group === 'local'));
    $('ng-watch').checked = !!draft.watch;
  }

  // ------------------------------------------------------------------ ルールと AI のページ
  function ex(cards, note) { return `<div class="ex">${miniCards(cards)}${note ? `<span class="hint">${note}</span>` : ''}</div>`; }
  const cid = (s, r) => s * 13 + D.RANKS.indexOf(r);
  function renderRules() {
    const R = D.RULE_LIST;
    const ruleRows = R.map(r => `<tr><td><b>${r.label}</b></td><td>${r.group === 'basic' ? '基本' : 'ローカル'}</td><td>${r.type === 'num' ? '1枚' : r.def ? 'あり' : 'なし'}</td><td>${esc(r.desc)}</td></tr>`).join('');
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>4人で、配られた札を<b>先にぜんぶ出し切った人</b>から順に「大富豪・富豪・貧民・大貧民」になります。</li>
          <li>場に出ている札より<b>強い札を、同じ枚数・同じ形</b>で出します。出せない・出したくないときは<b>パス</b>。</li>
          <li>自分以外の全員がパスすると<b>場が流れ</b>、最後に出した人（親）が好きな札から出せます。パスしても、次に番が回ってくればまた出せます。</li>
          <li>1回戦は♦3を持っている人から。2回戦からは大貧民から始め、その前に<b>カード交換</b>があります。</li>
          <li>何回戦か続けて、大富豪3点・富豪2点・貧民1点・大貧民0点の合計で競います。</li>
        </ul>
        <p class="hint">操作: 手札をタップしてえらび（もう一度で外す）、「出す」。出せない札はやんわり暗くなります。場がペアなどのときは、1枚えらぶと組の相手も自動でえらばれます。</p>
      </div>
      <div class="card" data-tab="強さと形">
        <h3>札の強さと出し方</h3>
        <p>弱い ← <b>3 4 5 6 7 8 9 10 J Q K A 2</b> → 強い。マークに強さはありません。ジョーカーはいちばん強く、どの札の代わりにもなります。</p>
        <p><b>1枚</b>（単騎）・<b>同じ数の2枚・3枚・4枚</b>（ペアなど）・<b>階段</b>（同じマークの連番3枚以上）。場と同じ形・同じ枚数で、より強いものだけ出せます。</p>
        ${ex([cid(1, '5'), cid(2, '5')], 'ペアには、より強いペア')}
        ${ex([cid(0, '9'), cid(0, '10'), JOKER, cid(0, 'Q')], '♠9〜Qの階段（ジョーカーがJの代わり）')}
        <p class="hint">2と3はつながりません（K・A・2 は階段になります）。</p>
      </div>
      <div class="card" data-tab="特別な札">
        <h3>特別な札と決まり</h3>
        <ul>
          <li><b>革命</b>: 同じ数を4枚以上（ジョーカー込み）出すと、強さの順が逆になります（3がいちばん強い）。もう一度で元に戻ります。</li>
          <li><b>8切り</b>: 8を含む手を出すと、その場で場が流れ、出した人がまた出せます。</li>
          <li><b>しばり</b>: 同じマークが2回続くと、場が流れるまでそのマークしか出せません。<b>階段しばり</b>: ひとつ上の数が続く（5→6 など）と、場が流れるまでひとつずつ上の数しか出せません。</li>
          <li><b>スペ3返し</b>: ジョーカー1枚には、♠3を1枚で返せます。場が流れ、返した人から。</li>
        </ul>
        ${ex([cid(0, '7'), cid(1, '7'), cid(2, '7'), cid(3, '7')], '革命！')}
        <div class="ex">${miniCards([JOKER])}<span class="arrow">→</span>${miniCards([cid(0, '3')])}<span class="hint">スペ3返し</span></div>
      </div>
      <div class="card" data-tab="交換・都落ち">
        <h3>カード交換と都落ち</h3>
        <ul>
          <li>2回戦から、配ったあとに交換します。<b>大貧民 → 大富豪に、いちばん強い札2枚</b>、<b>貧民 → 富豪に、いちばん強い札1枚</b>（決まりで自動）。</li>
          <li>受け取った大富豪は<b>好きな札2枚</b>を大貧民に、富豪は<b>好きな札1枚</b>を貧民に返します。</li>
          <li><b>都落ち</b>: 前の回の大富豪が、ほかの人に先にあがられて大富豪になれなかったら、その場で大貧民に落ちます（残りの札は使えません）。</li>
        </ul>
      </div>
      <div class="card" data-tab="ルールの一覧">
        <h3>ルールの一覧（「新しい対局」で切り替え）</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>ルール</th><th>種類</th><th>はじめ</th><th>中身</th></tr></thead><tbody>${ruleRows}</tbody></table></div>
      </div>
      <div class="card" data-tab="細かい決まり">
        <h3>細かい決まり（このゲームで決めたこと）</h3>
        <ul>
          <li>パスしても、場が流れる前にまた番が回ってくれば出せます。最後に出した人以外の全員が続けてパスしたら場が流れます。最後に出した人があがっていたら、残っている全員のパスで流れ、その次の人から。</li>
          <li>ジョーカー1枚はいちばん強い1枚（階段しばりの最中は、求められる数の代わり）。ジョーカー2枚のペアは、いちばん強いペア。</li>
          <li>しばりのマークはジョーカーが合わせます（♠5♥5 のあとに ♠7＋ジョーカー なら ♠♥しばり）。</li>
          <li>階段のなかの8・J・5・7・10 にも、8切り・11バック・5飛び・7渡し・10捨てが効きます。ジョーカーは代わりをしている数として数えます。</li>
          <li>5飛びで飛ばされた人はパスしたものとして数えます（全員を飛ばすと場が流れます）。</li>
          <li>7渡し・10捨てで最後の札を渡す・捨てると、そこであがり（禁止あがりにはなりません）。10捨ての札はみんなに見えます。</li>
          <li>禁止あがりは、最後の1手にジョーカー・2（革命中は3）・8・スペ3返しを含むとき。大貧民（すでに下が決まっていればその上）になります。</li>
          <li>交換で貧民側が渡す「いちばん強い札」は、いつもの強さの順（ジョーカー＞2＞A…）で選びます。</li>
        </ul>
      </div>`;
    docTabs($('view-rules'), 'rules');
  }
  function renderAIPage() {
    const st = window.DF_STRENGTH;
    const lvRows = CPU_KEYS.map(k => {
      const r = st && st.levels && st.levels[k];
      return `<tr><td><b>${CPU[k].label}</b></td><td>${esc(CPU[k].desc)}</td><td>${r ? `${r.mean.toFixed(2)} ± ${r.ci.toFixed(2)}位` : '—'}</td></tr>`;
    }).join('');
    const genRows = st && st.gens ? st.gens.map(r => `<tr><td>${esc(r.name)}</td><td>${r.vsWeak ? `${r.vsWeak.mean.toFixed(2)} ± ${r.vsWeak.ci.toFixed(2)}` : '—'}</td><td>${r.vsPrev ? `${r.vsPrev.mean.toFixed(2)} ± ${r.vsPrev.ci.toFixed(2)}（第${r.vsPrev.prev}世代に）` : '—'}</td></tr>`).join('') : '';
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        ${st ? `<div class="stat-row">
          <div class="stat"><b>${st.levels && st.levels.max ? st.levels.max.mean.toFixed(2) : '—'}</b><span>最強 1人 vs 基準 3人の平均順位（2.5 が互角）</span></div>
          <div class="stat"><b>${st.selfPlay ? st.selfPlay.toLocaleString() : '—'}</b><span>自己対局（局）</span></div>
          <div class="stat"><b>${st.gen != null ? st.gen : '—'}</b><span>学習の世代</span></div>
        </div>` : '<p>まだ測っていません。</p>'}
        <p class="hint">測り方: CPU 1人と「基準の AI（いちばん弱い札から出す）」3人で打ち、同じ配りで CPU を4つの席すべてに座らせて（デュプリケート）平均の順位を出します。1.0 なら毎回大富豪、2.5 が互角。± は 95% の幅。</p>
        <div class="tbl"><table class="lv"><thead><tr><th>CPU</th><th>打ち方</th><th>vs 基準3人</th></tr></thead><tbody>${lvRows}</tbody></table></div>
        ${st && st.vsHeur ? `<p class="hint" style="margin-top:8px">もうひとつの基準「組を崩さず、ジョーカー・2は最後に」（人が考えた素朴な打ち方）3人に対して、最強は平均 <b>${st.vsHeur.mean.toFixed(2)}</b> ± ${st.vsHeur.ci.toFixed(2)} 位。</p>` : ''}
        ${genRows ? `<p class="hint" style="margin-top:10px">世代ごと（1人 vs 3人の平均順位）</p><div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>vs 基準3人</th><th>vs 前の世代3人</th></tr></thead><tbody>${genRows}</tbody></table></div>` : ''}
        ${st && st.updated ? `<p class="hint">測った日: ${esc(st.updated)}</p>` : ''}
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>人が作った知識は使っていません</b>。既存の大富豪 AI・人の対局の記録・「この札は何点」といった評価の表は一切使わず、ルールだけを知った状態から、AI どうしで何百万局も打って強くなりました。</li>
          <li><b>学び方（Deep Monte-Carlo）</b>: 自己対局で実際に最後まで打ち、「この場面でこの手を選んだら、最後に何位になったか」を当てるようにネットを直します。何度もくり返すうちに、どの手が最後の順位につながるかを覚えます。</li>
          <li><b>見るもの</b>: 自分の手札・出た札（だれが何を出したか）・見えていない札・各自の残り枚数・場の札・しばり・革命・パスした人・階級・交換で渡した札など、自分に見えている情報だけ。相手の手札はのぞきません。</li>
          <li><b>手の特徴</b>: 出す札・出したあとに残る手・8切りや革命になるか・あがりになるか・見えていない札でこえられるか、などルールから分かる事実だけ。</li>
          <li><b>ネット</b>: 局面（740 個の 0/1）→ 384 → 192 と、手（254 個の 0/1）→ 192 を足して → 96 → 4（大富豪・富豪・貧民・大貧民になる見込み）。計算は自作の WebAssembly SIMD の小さな部品で、ブラウザでも1回の判断が1ミリ秒ほど。</li>
          <li><b>4段階</b>: やさしい・ふつう・つよいは、同じネットの見込みに「ゆらぎ」を入れて手を選びます（大きいほど迷う）。最強はいちばんよい手。見えない札を何通りも仮に配って最後まで打ってみる「読み」は、測って強くなるときだけ最強に使います。</li>
          <li><b>AI補助</b>の「見込み」と「おすすめ」は、最強と同じネットの値です。</li>
        </ul>
      </div>`;
    docTabs($('view-ai'), 'ai');
  }
  function docTabs(view, key) {
    const cards = [...view.querySelectorAll(':scope > .card')];
    if (cards.length < 2) return;
    const bar = document.createElement('div');
    bar.className = 'doctabs'; bar.setAttribute('role', 'tablist');
    bar.innerHTML = cards.map((c, i) => `<button role="tab" data-i="${i}">${esc(c.dataset.tab || i + 1)}</button>`).join('');
    view.prepend(bar);
    const show = i => {
      cards.forEach((c, j) => { c.hidden = j !== i; });
      bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
      store.set('doctab-' + key, i);
      view.scrollTop = 0;
    };
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
    show(Math.min(store.get('doctab-' + key, 0), cards.length - 1));
  }

  // ------------------------------------------------------------------ せり上がるパネル（狭い画面）
  const narrow = () => window.matchMedia('(max-width: 999px), (max-height: 599px)').matches;
  function openSheet(tab) {
    const side = $('side');
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return;
    const fr = $('felt').getBoundingClientRect(), h = window.innerHeight;
    side.style.setProperty('--sheet-top', Math.round(Math.min(h * 0.6, Math.max(h * 0.25, fr.top + 30))) + 'px');
    side.classList.add('open');
    renderLog(); renderScores(); renderAI(); renderSeen();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  function setSetting(k, v) {
    settings[k] = v; store.set('settings', settings);
    const box = { showProb: 'set-prob', showBest: 'set-best', sound: 'set-sound', anim: 'set-anim', fast: 'set-fast', autopass: 'set-autopass', four: 'set-four' }[k];
    if (box && $(box)) $(box).checked = v;
    SND.on = settings.sound;
    if ((k === 'showProb' || k === 'showBest') && S.online && S.online.setAI) S.online.setAI(aiOn() ? 1 : 0);
    if ((k === 'showProb' || k === 'showBest') && aiOn()) analyze();
    renderAll();
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') renderAll();
    }));
    $('hand').addEventListener('click', e => { const b = e.target.closest('.hc'); if (b) { SND.unlock(); onCard(Number(b.dataset.c)); } });
    $('btn-play').addEventListener('click', () => { SND.unlock(); onPlay(); });
    $('btn-pass').addEventListener('click', () => { SND.unlock(); onPass(); });
    $('btn-hint').addEventListener('click', hint);
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); settings.showProb = on; setSetting('showBest', on); });
    $('info').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'desel') { S.sel.clear(); renderAll(); }
      else if (act === 'live') viewSnap(S.snaps.length);
      else if (act === 'review') { $('dlg-result').hidden = true; viewSnap(0); reviewAnalysis(); }
      else if (act === 'reveal') { S.reviewAll = !S.reviewAll; renderAll(); }
      else if (act === 'next') nextRound();
      else if (act === 'again') startMatch(cfg);
      else if (act === 'online') $('btn-online').click();
    });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      e.stopPropagation();
      const cur = live() ? S.snaps.length - 1 : S.view;
      const nav = b.dataset.nav;
      if (nav === 'first') viewSnap(0);
      else if (nav === 'prev') viewSnap(cur - 1);
      else if (nav === 'next') viewSnap(cur + 1);
      else if (nav === 'last') viewSnap(S.snaps.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet('log'); }
      else if (b.dataset.snap != null) viewSnap(Number(b.dataset.snap));
    });
    $('loglist').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewSnap(Number(li.dataset.snap)); });
    $('aistrip').addEventListener('click', () => openSheet('ai'));
    $('aistrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ai'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
    });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !confirm('オンラインの卓を離れて、CPU との対局を始めますか？')) return;
      openNew();
    });
    $('btn-sort').addEventListener('click', () => setSetting('sortRev', !settings.sortRev));
    $('btn-sheet').addEventListener('click', () => openSheet('log'));
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('#chooser') && !e.target.closest('#btn-play')) hideChooser();
    });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    [['set-prob', 'showProb'], ['set-best', 'showBest'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-fast', 'fast'], ['set-autopass', 'autopass'], ['set-four', 'four']].forEach(([id, k]) => {
      const el = $(id); el.checked = !!settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-games') draft.games = Number(v);
        else if (id === 'ng-jokers') draft.rules.jokers = Number(v);
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) $('dlg-new').hidden = true;
    });
    $('dlg-new').addEventListener('change', e => { if (e.target.id === 'ng-watch') { draft.watch = e.target.checked; return; } const k = e.target.dataset && e.target.dataset.rule; if (k) draft.rules[k] = e.target.checked; });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startMatch(draft); });
    // 結果
    $('rs-next').addEventListener('click', nextRound);
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewSnap(0); reviewAnalysis(); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); hideChooser(); ['dlg-new', 'dlg-result', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel.size) { S.sel.clear(); renderAll(); } return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewSnap((live() ? S.snaps.length - 1 : S.view) - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); viewSnap((live() ? S.snaps.length - 1 : S.view) + 1); }
      else if (e.key === 'Enter' && isHumanTurn()) { e.preventDefault(); onPlay(); }
      else if ((e.key === 'p' || e.key === 'P') && isHumanTurn()) { e.preventDefault(); onPass(); }
    });
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderAll(); if ($('side').classList.contains('open')) openSheet($('side').dataset.tab); }, 60); });
  }

  // ------------------------------------------------------------------ オンラインの卓から使う部品
  window.DFApp = {
    S, D, A, store, settings, esc, aiOn, seatName, shortName,
    renderAll, schedule, applyMove, applyXfer, loadRound, applyQuiet, finishRound, showResult, toast, stamp, bubble, animateDeal, hideResult: () => { $('dlg-result').hidden = true; },
    get busy() { return S.busy; },
    // 卓を始める（オンライン）: seats・me・rules などを入れてから呼ぶ
    beginOnline(o) {
      clearTimeout(S.timer);
      S.online = o.online; S.me = o.me; S.seats = o.seats; S.rules = D.normRules(o.rules); S.games = o.games || 0;
      S.round = o.round || 0; S.scores = o.scores || [0, 0, 0, 0]; S.history = o.history || []; S.prev = o.prev || null; S.ended = false;
      $('dlg-result').hidden = true; $('dlg-new').hidden = true;
    },
    endOnline() { S.online = null; },
    // 始まる前の空の卓（オンラインでホストが始めるのを待つ間）
    emptyTable() {
      S.g = new D.Game(S.rules, { hands: [[], [], [], []], leader: 0 });
      S.g.phase = 'done'; S.g.rank = [-1, -1, -1, -1];
      S.snaps = [S.g.clone()]; S.recs = []; S.moves = []; S.view = null; S.resultShown = true; S.pile = null;
      S.analysis = null; S.lastAnalysis = null; S.hint = null; S.round = 0;
      renderAll();
    },
    startMatch, openNew, cfg: () => cfg, isHumanTurn,
    // 動作確認用: 自分の番を自動で打つ（でたらめな合法手）
    autoPlay(ms = 700) {
      clearInterval(this._auto);
      if (!ms) return;
      this._auto = setInterval(() => {
        try {
          if (!isHumanTurn()) return;
          const g = S.g, L = g.legal(), plays = L.filter(m => m.k !== PASS);
          const mv = g.pend ? L[Math.floor(Math.random() * L.length)] : plays.length && Math.random() < 0.75 ? plays[Math.floor(Math.random() * plays.length)] : L[L.length - 1];
          submit(mv);
        } catch (e) { console.log('autoPlay', e.message); }
      }, ms);
    },
  };

  // ------------------------------------------------------------------ はじめ
  SND.on = settings.sound;
  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderAll());
  const saved = store.get('game', null);
  const joining = /[?&]table=/.test(location.search);
  if (!joining && saved && saved.v === 1 && saved.cur && Array.isArray(saved.cur.hands0)) {
    try {
      cfg = Object.assign(cfg, saved.cfg || {});
      S.seats = saved.seats; S.rules = D.normRules(saved.rules); S.games = saved.games; S.round = saved.round; S.scores = saved.scores; S.history = saved.history || []; S.prev = saved.prev; S.ended = !!saved.ended;
      S.cpuCfg = cfg.cpu;
      loadRound({ hands0: saved.cur.hands0, prev: saved.cur.prev, moves: saved.cur.moves || [] });
      // 終わった回のあとで閉じていたら、結果のまま
      S.resultShown = S.g.phase === 'done';
      renderAll();
      schedule();
    } catch (e) { console.error(e); startMatch(cfg); openNew(); }
  } else if (!joining) {
    startMatch(cfg);
    openNew();
  } else {
    S.seats = newSeats(cfg.cpu);
    S.g = new D.Game(S.rules, { hands: D.deal(S.rules, D.rng32(1), 0) });
    S.snaps = [S.g.clone()]; S.recs = [];
    S.g.phase = 'done'; S.resultShown = true;
    renderAll();
  }
})();
