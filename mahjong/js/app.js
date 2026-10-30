/* 麻雀の画面: 卓の描画・手牌の操作（タップで浮き上がり、もう一度で切る）・鳴きと和了のボタン・CPU・AI補助・局の結果・記録と見返し・ルールと AI のページ */
(function () {
  'use strict';
  const MJ = window.MJ, AI = window.MJAI, TL = window.MJTiles;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  TL.inject();

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('mahjong-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mahjong-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  const settings = Object.assign({ showEval: true, showWaits: true, autowin: false, nocall: false, fast: false, sound: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.showWaits;
  let cfg = Object.assign({ cpu: 'normal', length: 'hanchan', aka: 3, seat: 'random' }, store.get('cfg', {}));

  // ------------------------------------------------------------------ 学んだネット
  let NET = null, NETINFO = null;
  try {
    if (window.MJ_WEIGHTS && !window.MJ_WEIGHTS_MISSING) { NET = new AI.Net(AI.unpackWeights(window.MJ_WEIGHTS)); NETINFO = window.MJ_WEIGHTS.meta || {}; }
  } catch (e) { console.error('ネットを読めませんでした', e); NET = null; }
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '自己対局で学んだ AI。よく迷います', temp: 0.005 },
    normal: { label: 'ふつう', stars: 2, desc: '牌効率だけで打ちます（鳴かない・守らない・聴牌したらすぐ立直）' },
    strong: { label: 'つよい', stars: 3, desc: '自己対局で学んだ AI の一番の手' },
    max: { label: '最強', stars: 4, desc: '学んだ AI の一番の手（いま一番強い版）' },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  // 最強: 測って強いと分かったときだけ、先読み（js/mj-ai.js の SearchAgent）を Web Worker で（画面が止まらないように）
  const VNET = (() => { try { return window.MJ_WEIGHTS ? AI.unpackV(window.MJ_WEIGHTS) : null; } catch (e) { return null; } })();
  const USE_SEARCH = !!(NET && VNET && window.MJ_STRENGTH && window.MJ_STRENGTH.maxSearch);
  if (USE_SEARCH) CPU.max.desc = '学んだ AI に先読みを足したもの（見えない牌を何通りも決めて、その局の最後まで打ってみる。1手最大2.5秒）';
  else CPU.max.desc = '学んだ AI の一番の手（先読みは、測ってつよいより強いと言えなかったので使っていない）';
  let searchWorker = null, searchId = 0;
  const searchWaits = new Map();
  function getSearchWorker() {
    if (searchWorker !== null) return searchWorker;
    try {
      const base = new URL('js/', location.href).href;
      const src = `importScripts(${JSON.stringify(base + 'mj-core.js')}, ${JSON.stringify(base + 'nn-simd.js')}, ${JSON.stringify(base + 'mj-ai.js')}, ${JSON.stringify(base + 'weights.js')});
        const net = new MJAI.Net(MJAI.unpackWeights(self.MJ_WEIGHTS)), vp = MJAI.unpackV(self.MJ_WEIGHTS);
        const ag = new MJAI.SearchAgent(net, vp, { samples: 12, ms: 2500 });
        onmessage = e => { const r = e.data.r; Object.setPrototypeOf(r, MJ.Round.prototype); let a = null; try { a = ag.chooseTurn(r); } catch (err) { a = null; } postMessage({ id: e.data.id, a }); };`;
      searchWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      searchWorker.onmessage = e => { const f = searchWaits.get(e.data.id); if (f) { searchWaits.delete(e.data.id); f(e.data.a); } };
      searchWorker.onerror = () => { searchWorker = false; searchWaits.forEach(f => f(null)); searchWaits.clear(); };
    } catch (e) { searchWorker = false; }
    return searchWorker;
  }
  class WorkerSearchAgent {
    constructor() { this.base = new AI.NetAgent(NET, { name: '最強' }); this.async = true; this.name = '最強'; }
    chooseReact(r, s) { return this.base.chooseReact(r, s); }
    chooseTurn(r) { return this.base.chooseTurn(r); }
    chooseTurnAsync(r) {
      const w = getSearchWorker();
      if (!w) return Promise.resolve(this.base.chooseTurn(r));
      const id = ++searchId;
      const c = r.clone(); c.log = []; c.steps = [];
      return new Promise(res => {
        searchWaits.set(id, a => res(a && r.isLegalTurn(a) ? a : this.base.chooseTurn(r)));
        try { w.postMessage({ id, r: c }); } catch (e) { searchWaits.delete(id); res(this.base.chooseTurn(r)); }
      });
    }
  }
  function makeAgent(level) {
    if (level === 'normal' || !NET) return new AI.EfficiencyAgent();
    if (level === 'max' && USE_SEARCH && typeof Worker !== 'undefined') return new WorkerSearchAgent();
    return new AI.NetAgent(NET, { temp: CPU[level].temp || 0, name: CPU[level].label });
  }

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    game: null, round: null, me: 0, seats: ['human', 'normal', 'normal', 'normal'], agents: [null, null, null, null],
    names: ['あなた', 'CPU', 'CPU', 'CPU'],
    sel: -1,             // 浮き上がらせている牌の id
    riichiMode: false,
    pending: null,       // 返事の集まり（鳴きの機会）: { resp: [..], need: Set(席) }
    timer: 0, logPos: 0, newDiscard: null, analysis: null, hintOn: null,
    view: null,          // 見返し: { ri: 局の番号（S.game.rounds の、-1 は今の局）, step }
    online: null,        // オンラインの卓（online-table.js が入れる）
    resultShown: false, callouts: [],
  };
  const live = () => S.view === null;
  const isCPU = s => !!CPU[S.seats[s]];
  const isHuman = s => S.seats[s] === 'human';
  const rel = s => (s - S.me + 4) % 4;
  const WIND = MJ.WIND_JA;

  // ------------------------------------------------------------------ 音（WebAudio で合成）
  let actx = null;
  function sound(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime;
      const noise = (len, freq, q, gain) => {
        const n = Math.floor(actx.sampleRate * len), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
        const src = actx.createBufferSource(); src.buffer = buf;
        const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
        const g = actx.createGain(); g.gain.value = gain;
        src.connect(bp).connect(g).connect(actx.destination); src.start(t);
      };
      const tone = (f0, f1, len, gain, type = 'sine', delay = 0) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t + delay); o.frequency.exponentialRampToValueAtTime(f1, t + delay + len);
        g.gain.setValueAtTime(gain, t + delay); g.gain.exponentialRampToValueAtTime(0.001, t + delay + len);
        o.connect(g).connect(actx.destination); o.start(t + delay); o.stop(t + delay + len + 0.02);
      };
      if (kind === 'discard') { noise(0.05, 2100, 2.5, 1.3); tone(420, 160, 0.06, 0.18); }
      else if (kind === 'draw') noise(0.03, 3200, 3, 0.35);
      else if (kind === 'call') { noise(0.06, 1500, 2, 1.4); tone(520, 700, 0.12, 0.12, 'triangle'); }
      else if (kind === 'riichi') { tone(660, 990, 0.18, 0.16, 'triangle'); tone(990, 1320, 0.22, 0.12, 'triangle', 0.12); }
      else if (kind === 'win') { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.32, 0.12, 'triangle', i * 0.09)); }
      else if (kind === 'turn') tone(880, 880, 0.08, 0.06);
      else if (kind === 'draw-game') tone(330, 220, 0.4, 0.1);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    if (S.online && window.MJOnline) window.MJOnline.leave(true);
    cfg = c; store.set('cfg', cfg);
    clearTimeout(S.timer);
    const me = cfg.seat === 'random' ? Math.floor(Math.random() * 4) : +cfg.seat;
    S.me = me;
    S.seats = [0, 1, 2, 3].map(s => (s === me ? 'human' : cfg.cpu));
    S.names = [0, 1, 2, 3].map(s => (s === me ? 'あなた' : `CPU（${CPU[cfg.cpu].label}）`));
    S.agents = S.seats.map(x => (CPU[x] ? makeAgent(x) : null));
    S.game = new MJ.Game({ length: cfg.length, aka: cfg.aka }, Math.floor(Math.random() * 2 ** 31));
    S.view = null;
    S.hints = 0;
    startRound();
  }
  function startRound() {
    S.round = S.game.newRound();
    S.logPos = 0; S.sel = -1; S.riichiMode = false; S.pending = null; S.resultShown = false; S.newDiscard = null; S.hintOn = null; S.notice = '';
    saveGame();
    afterChange(true);
  }
  // 局面が変わったあと: 出来事の演出・描き直し・次の行動
  function afterChange(fresh) {
    const r = S.round;
    if (fresh) S.logPos = 0;
    consumeLog(r, !fresh);
    S.analysis = null;
    render();
    saveGame();
    schedule();
  }
  function consumeLog(r, anim) {
    S.newDiscard = null;
    for (; S.logPos < r.log.length; S.logPos++) {
      const ev = r.log[S.logPos];
      if (!anim) continue;
      if (ev.e === 'discard') { S.newDiscard = ev.tile; sound('discard'); if (ev.riichi) callout(ev.s, 'リーチ'); }
      else if (ev.e === 'draw' && isHuman(ev.s)) sound('draw');
      else if (ev.e === 'call') { const name = { pon: 'ポン', chi: 'チー', minkan: 'カン', ankan: 'カン', kakan: 'カン' }[ev.type]; callout(ev.s, name); sound('call'); }
      else if (ev.e === 'riichi') sound('riichi');
      else if (ev.e === 'end') {
        const res = ev.result;
        if (res.type === 'agari') { for (const w of res.wins) callout(w.seat, w.tsumo ? 'ツモ' : 'ロン'); sound('win'); }
        else { callout(-1, { exhaust: '流局', nagashi: '流し満貫', kyuushu: '九種九牌', suufon: '四風連打', suucha: '四家立直', suukaikan: '四開槓', sancha: '三家和' }[res.reason] || '流局'); sound('draw-game'); }
      } else if (ev.e === 'kyuushu') callout(ev.s, '九種九牌');
    }
  }
  function callout(s, text) {
    if (reduceMotion) return;
    S.callouts.push({ s, text, t: Date.now() });
    renderCallouts();
  }
  function delay(kind) {
    const f = settings.fast ? 0.35 : 1;
    return Math.round(({ cpuTurn: 620, cpuReact: 380, auto: 450, end: 900 })[kind] * f);
  }

  // 「新しい対局」を開いている間は、裏の卓を進めない（CPU はツモ・打牌・鳴きをしない）。オンラインの卓はほかの人がいるので止めない
  const paused = () => !S.online && !$('dlg-new').hidden;
  function schedule() {
    clearTimeout(S.timer);
    const r = S.round;
    if (!r || !live()) return;
    if (S.online && window.MJOnline && window.MJOnline.drives()) { window.MJOnline.schedule(); return; }
    if (paused()) return;
    if (r.phase === 'end') {
      if (!S.resultShown) { S.resultShown = true; S.timer = setTimeout(showResult, delay('end')); }
      return;
    }
    if (r.phase === 'turn') {
      const s = r.cur;
      if (isCPU(s)) { S.timer = setTimeout(() => cpuTurn(s), delay('cpuTurn')); return; }
      if (isHuman(s)) {
        const acts = r.turnActions();
        if (settings.autowin && acts.some(a => a.t === 'tsumo')) { S.timer = setTimeout(() => humanTurn({ t: 'tsumo' }), delay('auto')); return; }
        // 立直のあとは、和了・暗槓ができないときは自動でツモ切り
        if (r.riichi[s] && !acts.some(a => a.t === 'tsumo' || a.t === 'ankan')) { S.timer = setTimeout(() => humanTurn({ t: 'discard', tile: r.drawn, riichi: false }), delay('auto')); return; }
        sound('turn');
      }
      return;
    }
    // 返事: CPU はすぐ決める、人は聞く
    if (!S.pending) {
      const resp = [null, null, null, null], need = new Set();
      for (let s = 0; s < 4; s++) {
        const o = r.react.options[s];
        if (!o) continue;
        if (isCPU(s)) resp[s] = S.agents[s].chooseReact(r, s);
        else if (isHuman(s)) {
          const ron = o.find(a => a.t === 'ron');
          if (ron && settings.autowin) resp[s] = ron;
          else if (!ron && settings.nocall) resp[s] = null;
          else need.add(s);
        }
      }
      S.pending = { resp, need };
    }
    if (!S.pending.need.size) {
      const resp = S.pending.resp;
      S.timer = setTimeout(() => { S.pending = null; r.doReact(resp); afterChange(); }, delay('cpuReact') * (resp.some(Boolean) ? 1 : 0.25));
      return;
    }
    render(); // 人の返事を待つ（ボタンを出す）
  }
  function cpuTurn(s) {
    const r = S.round;
    if (paused() || !live() || !r || r.phase !== 'turn' || r.cur !== s || !isCPU(s) || !S.agents[s]) return;
    const ag = S.agents[s];
    if (ag.async) {
      S.thinkingAsync = s;
      ag.chooseTurnAsync(r).then(a => {
        S.thinkingAsync = -1;
        // 考えている間に「新しい対局」が開いたら、その手は捨てる（閉じたら考え直す）
        if (paused() || !live() || S.round !== r || r.phase !== 'turn' || r.cur !== s) return;
        r.doTurn(a);
        afterChange();
      });
      return;
    }
    const a = ag.chooseTurn(r);
    r.doTurn(a);
    afterChange();
  }
  function humanTurn(a) {
    const r = S.round;
    if (!live() || r.phase !== 'turn' || !isHuman(r.cur)) return;
    if (!r.isLegalTurn(a)) return;
    clearTimeout(S.timer);
    S.sel = -1; S.riichiMode = false; S.hintOn = null;
    if (S.online && window.MJOnline && window.MJOnline.active()) { window.MJOnline.sendTurn(a); return; }
    r.doTurn(a);
    afterChange();
  }
  function humanReact(a) {
    const r = S.round;
    if (!live() || r.phase !== 'react' || !S.pending) return;
    const s = S.me;
    if (!S.pending.need.has(s)) return;
    if (a && !r.isLegalReact(s, a)) return;
    S.hintOn = null;
    if (S.online && window.MJOnline && window.MJOnline.active()) { S.pending.need.delete(s); window.MJOnline.sendReact(a); render(); return; }
    S.pending.resp[s] = a || null;
    S.pending.need.delete(s);
    schedule();
  }

  // ------------------------------------------------------------------ 保存と再読み込み
  function saveGame() {
    if (!S.game || S.online) return;
    const g = S.game;
    store.set('game', {
      v: 1, cfg, me: S.me, seats: S.seats, names: S.names, hints: S.hints || 0,
      g: { rules: g.rules, scores: g.scores, roundWind: g.roundWind, kyoku: g.kyoku, honba: g.honba, kyotaku: g.kyotaku, ended: g.ended, final: g.final || null, rounds: g.rounds },
      cur: S.round ? { wall: S.round.wall, steps: S.round.steps, scores: S.round.scoresBefore, kyotaku: S.round.kyotakuStart } : null,
    });
  }
  function loadGame(d) {
    const g = new MJ.Game(d.g.rules, Math.floor(Math.random() * 2 ** 31));
    Object.assign(g, { scores: d.g.scores, roundWind: d.g.roundWind, kyoku: d.g.kyoku, honba: d.g.honba, kyotaku: d.g.kyotaku, ended: d.g.ended, final: d.g.final, rounds: d.g.rounds || [] });
    S.game = g; S.me = d.me; S.seats = d.seats; S.names = d.names; S.hints = d.hints || 0;
    S.agents = S.seats.map(x => (CPU[x] ? makeAgent(x) : null));
    cfg = Object.assign(cfg, d.cfg);
    S.view = null;
    if (d.cur && !g.ended) {
      const scores = d.cur.scores;
      const opts = { rules: g.rules, wall: d.cur.wall, dealer: g.kyoku, roundWind: g.roundWind, kyoku: g.kyoku, honba: g.honba, kyotaku: d.cur.kyotaku != null ? d.cur.kyotaku : g.kyotaku, scores };
      const r = MJ.replayRound(opts, d.cur.steps);
      r.scoresBefore = scores.slice(); r.kyotakuStart = opts.kyotaku;
      r.gameInfo = { roundIndex: g.roundIndex, last: g.lastRoundIndex, tonpu: g.rules.length === 'tonpu', firstDealer: 0 };
      g.round = r; S.round = r;
      S.logPos = r.log.length; S.sel = -1; S.riichiMode = false; S.pending = null; S.resultShown = false;
      render(); schedule();
    } else {
      S.round = null;
      render();
      if (g.ended) showFinal();
    }
  }

  // ------------------------------------------------------------------ 大きさ（画面に合わせて卓・河・手牌を決める）
  let fitPending = 0;
  function fitSoon() { if (!fitPending) fitPending = requestAnimationFrame(() => { fitPending = 0; fit(); render(); }); }
  const GEO = { C: 6.05, gap: 0.16, river: 4.29, gap2: 0.24, hand: 1.02, margin: 0.22 };
  let lastLayout = '';
  function fit() {
    const main = document.querySelector('main');
    const W = main.clientWidth, H = main.clientHeight;
    const land = W > H * 1.15 && W >= 560;
    const play = $('view-play');
    play.classList.toggle('land', land); play.classList.toggle('port', !land);
    const g = GEO, down = g.C / 2 + g.gap + g.river + g.margin, up = g.C / 2 + g.gap + g.river + g.gap2 + g.hand + g.margin;
    const kW = 2 * up, kH = up + down;
    const r = S.round && (live() ? S.round : shownRound());
    const ms = r ? r.melds[S.me] : [];
    // 副露は手牌の 0.78 倍の牌で、横向きの牌（1.34 枚分）を含む。槓は1枚多い
    const meldUnits = ms.reduce((a, m) => a + 0.78 * (m.type === 'ankan' ? 4 : m.type === 'minkan' ? 4.34 : 3.34) + 0.18, 0);
    const handUnits = (14 - 3 * ms.length) * 1.04 + 0.36 + (ms.length ? 0.35 + meldUnits : 0);
    // 手牌も卓の上（手前側）なので、卓の縁（rt）と手牌の段の余白を引いて決める
    const rt = Math.round(Math.max(4, Math.min(9, Math.min(W, H) * 0.011)));
    let rw, hw;
    if (land) {
      hw = Math.min(60, (W - 16 - 2 * rt - 32) / handUnits, H * 0.13);
      const handH = hw * (0.3 + 1.34 + 0.09) + rt + 7;
      rw = Math.min(34, (H - 8 - handH - rt - 4) / kH, (W * 0.48) / kW);
    } else {
      rw = Math.min(30, (W - 4 - 2 * rt - 4) / kW, (H * 0.56) / kH);
      hw = Math.min(40, (W - 4 - 2 * rt - 4) / handUnits);
    }
    const root = document.documentElement.style;
    root.setProperty('--rt', rt + 'px');
    root.setProperty('--rw', rw.toFixed(2) + 'px');
    root.setProperty('--hw', hw.toFixed(2) + 'px');
    root.setProperty('--ow', (rw * 0.74).toFixed(2) + 'px');
    root.setProperty('--SW', (kW * rw).toFixed(1) + 'px');
    root.setProperty('--SH', (kH * rw).toFixed(1) + 'px');
    S.geo = { rw, hw, ow: rw * 0.74, SW: kW * rw, SH: kH * rw, cx: kW * rw / 2, cy: up * rw, land };
    lastLayout = land ? 'land' : 'port';
  }

  // ------------------------------------------------------------------ 描画
  const shownRound = () => {
    if (live()) return S.round;
    const v = S.view, g = S.game;
    const rec = v.ri >= 0 ? g.rounds[v.ri] : null;
    const base = rec || { wall: S.round.wall, steps: S.round.steps, roundWind: g.roundWind, kyoku: g.kyoku, honba: g.honba, kyotaku: S.round.kyotakuStart != null ? S.round.kyotakuStart : g.kyotaku, scoresBefore: S.round.scoresBefore };
    if (!v.cache || v.cache.step !== v.step || v.cache.ri !== v.ri) {
      const opts = { rules: g.rules, wall: base.wall, dealer: base.kyoku, roundWind: base.roundWind, kyoku: base.kyoku, honba: base.honba, kyotaku: base.kyotaku, scores: base.scoresBefore };
      const r = MJ.replayRound(opts, base.steps, v.step);
      r.gameInfo = { roundIndex: base.roundWind * 4 + base.kyoku, last: g.lastRoundIndex, tonpu: g.rules.length === 'tonpu', firstDealer: 0 };
      v.cache = { step: v.step, ri: v.ri, r };
    }
    return v.cache.r;
  };
  function render() {
    fit();
    const r = shownRound();
    renderTable(r);
    renderHand(r);
    renderPlayers(r);
    renderInfo(r);
    renderAssist(r);
    renderCalls(r);
    renderLog(r);
    renderControls();
  }
  const isRedId = id => !!(S.game && S.game.rules.aka > 0 && (id === 16 || id === 52 || id === 88));
  // 見えない牌（オンラインの写しの仮の番号 1000+）は裏で
  const tile = (id, cls = '', extra = '') => (id >= 1000 ? TL.backHTML(cls) : TL.tileHTML(id >> 2, isRedId(id), cls, extra));
  const tileK = (k, cls = '') => TL.tileHTML(k, false, cls);
  const sideTile = (id, cls = '') => `<span class="side">${tile(id, cls)}</span>`;
  function meldHTML(m, owner) {
    // 鳴いた牌は、鳴いた相手の方向に横向き（上家 = 左、対面 = 真ん中、下家 = 右）
    if (m.type === 'ankan') { const t = m.tiles; return `<span class="meld">${TL.backHTML()}${tile(t[1])}${tile(t[2])}${TL.backHTML()}</span>`; }
    const from = (m.from - owner + 4) % 4; // 1 下家 2 対面 3 上家
    const others = m.tiles.filter(x => x !== m.called && x !== m.added);
    const calledHTML = m.type === 'kakan' ? `<span class="side stack">${tile(m.called)}${tile(m.added)}</span>` : sideTile(m.called);
    let parts;
    if (m.type === 'chi') parts = [calledHTML, ...others.sort((a, b) => a - b).map(x => tile(x))];
    else {
      const o = others.slice(0, m.type === 'minkan' ? 3 : 2).map(x => tile(x));
      if (from === 3) parts = [calledHTML, ...o];
      else if (from === 2) parts = [o[0], calledHTML, ...o.slice(1)];
      else parts = [...o, calledHTML];
    }
    return `<span class="meld">${parts.join('')}</span>`;
  }
  function riverHTML(r, s) {
    const ds = r.discards[s];
    let html = '', row = '', n = 0, rows = 0;
    const flush = () => { html += `<div class="row">${row}</div>`; row = ''; rows++; };
    const riichiIdx = r.riichiAt[s];
    let sidePending = false;
    ds.forEach((d, i) => {
      const isNew = live() && d.tile === S.newDiscard && i === ds.length - 1;
      const cls = (d.called ? 'called ' : '') + (isNew ? 'new ' : '') + (i === ds.length - 1 && r.react && r.react.from === s && r.phase === 'react' ? 'last' : '');
      // 立直の宣言牌は横に（鳴かれたら次の牌を横に）
      const side = i === riichiIdx || (sidePending && !d.called);
      if (i === riichiIdx && d.called) sidePending = true; else if (side) sidePending = false;
      row += side ? sideTile(d.tile, cls) : tile(d.tile, cls);
      n++;
      if ((rows < 2 && n === 6)) { flush(); n = 0; }
    });
    if (row || !html) flush();
    return html;
  }
  function renderTable(r) {
    const G = S.geo, el = $('tbl');
    if (!r) { el.innerHTML = ''; return; }
    const rw = G.rw, cx = G.cx, cy = G.cy;
    const angle = [0, -90, 180, 90];
    const g = GEO;
    let html = '';
    for (let p = 0; p < 4; p++) {
      const s = (S.me + p) % 4;
      const a = angle[p];
      html += `<div class="layer" style="transform: translate(${cx}px, ${cy}px) rotate(${a}deg) translate(${-3.025 * rw}px, ${(g.C / 2 + g.gap) * rw}px)"><div class="river">${riverHTML(r, s)}</div></div>`;
      if (p > 0) {
        // 相手の手牌（裏）と副露。局の終わりに見せる手は表で
        const show = r.phase === 'end' && revealHand(r, s);
        const n = r.hands[s].length;
        const handTiles = show ? r.hands[s].slice().sort((x, y) => x - y).map(id => tile(id)).join('') : Array.from({ length: n }, () => TL.backHTML()).join('');
        const melds = r.melds[s].map(m => meldHTML(m, s)).join('');
        const dist = (g.C / 2 + g.gap + g.river + g.gap2) * rw;
        html += `<div class="layer" style="transform: translate(${cx}px, ${cy}px) rotate(${a}deg) translate(0, ${dist}px)"><div class="ohand" style="transform: translateX(-50%)"><span class="open-hand" style="display:flex;gap:1px">${handTiles}</span><span class="melds">${melds}</span></div></div>`;
      }
    }
    // 中央
    const live1 = r.phase !== 'end';
    const dora = [];
    for (let i = 0; i < 5; i++) dora.push(i < r.doraCount ? tile(r.wall[126 + i]) : TL.backHTML());
    let ps = '';
    for (let p = 0; p < 4; p++) {
      const s = (S.me + p) % 4, w = r.seatWind(s);
      const turn = live1 && ((r.phase === 'turn' && r.cur === s) || (r.phase === 'react' && r.react && r.react.from === s));
      ps += `<div class="ps p${p}${turn ? ' turn' : ''}"><span class="w${w === 0 ? ' dealer' : ''}">${WIND[w]}</span><span class="sc">${r.scores[s].toLocaleString()}</span>${r.riichi[s] && (r.pendingRiichi !== s) ? '<span class="stick"></span>' : ''}</div>`;
    }
    const left = r.liveLeft;
    html += `<div class="center" style="left:${cx}px;top:${cy}px">
      <div class="mid">
        <span class="rn">${WIND[r.roundWind]}${r.kyoku + 1}局</span>
        <span class="sub">${r.honba}本場・供託${r.kyotaku}</span>
        <span class="left">残り ${left}</span>
        <span class="dora" title="ドラ表示牌">${dora.join('')}</span>
      </div>${ps}</div>`;
    // 名前（縦長の画面では対局者の一覧がないので、卓の上に小さく）
    if (!G.land) {
      for (let p = 1; p < 4; p++) {
        const s = (S.me + p) % 4;
        const pos = [null, `right:${(0.3) * rw}px;top:${cy - 6.2 * rw}px`, `left:${cx + 5.4 * rw}px;top:${0.15 * rw}px`, `left:${(0.3) * rw}px;top:${cy - 6.2 * rw}px`][p];
        html += `<div class="seatname" style="${pos}">${esc(shortName(s))}${r.riichi[s] ? '<span class="riichi-tag">立直</span>' : ''}${thinking(s) ? '<span class="think"><i></i></span>' : ''}${onlineTag(s)}</div>`;
      }
    }
    html += `<div id="callouts"></div>`;
    el.innerHTML = html;
    renderCallouts();
  }
  function revealHand(r, s) {
    const res = r.result;
    if (!res) return false;
    if (res.type === 'agari') return res.wins.some(w => w.seat === s);
    return !!(res.tenpai && res.tenpai[s]) || res.reason === 'kyuushu' && res.seat === s;
  }
  function renderCallouts() {
    const box = document.getElementById('callouts');
    if (!box || !S.geo) return;
    const now = Date.now();
    S.callouts = S.callouts.filter(c => now - c.t < 1100);
    const G = S.geo, rw = G.rw;
    const pos = p => (p < 0 ? [G.cx, G.cy] : [[G.cx, G.cy + 4.6 * rw], [G.cx + 5.2 * rw, G.cy], [G.cx, G.cy - 4.6 * rw], [G.cx - 5.2 * rw, G.cy]][p]);
    box.innerHTML = S.callouts.map(c => { const [x, y] = pos(c.s < 0 ? -1 : rel(c.s)); return `<div class="callout" style="left:${x}px;top:${y}px;animation-delay:${-(now - c.t)}ms">${esc(c.text)}</div>`; }).join('');
    if (S.callouts.length) setTimeout(renderCallouts, 1150);
  }
  const REL_NAME = ['あなた', '下家', '対面', '上家'];
  const shortName = s => (S.online ? S.names[s] : s === S.me ? 'あなた' : REL_NAME[rel(s)]);
  const thinking = s => live() && !paused() && S.round && S.round.phase === 'turn' && S.round.cur === s && isCPU(s);
  const onlineTag = s => (S.online && window.MJOnline ? window.MJOnline.tag(s) : '');

  // 手牌
  function sortedHand(r, s) {
    const h = r.hands[s].slice();
    const drawn = r.cur === s && r.phase === 'turn' && r.drawn >= 0 && live() ? r.drawn : (S.view && r.cur === s && r.phase === 'turn' && r.drawn >= 0 ? r.drawn : -1);
    const rest = h.filter(x => x !== drawn).sort((a, b) => (a >> 2) - (b >> 2) || a - b);
    return { rest, drawn: drawn >= 0 && h.includes(drawn) ? drawn : -1 };
  }
  function renderHand(r) {
    const el = $('hand'), mel = $('mymelds');
    if (!r) { el.innerHTML = ''; mel.innerHTML = ''; return; }
    const s = S.me;
    const { rest, drawn } = sortedHand(r, s);
    const myTurn = live() && r.phase === 'turn' && r.cur === s && isHuman(s);
    const an = myTurn && (settings.showEval || S.hintOn) ? getAnalysis() : null;
    const showBars = !!an && settings.showEval;
    const riichiOK = S.riichiMode ? new Set(r.turnActions().filter(a => a.t === 'discard' && a.riichi).map(a => a.tile >> 2)) : null;
    const best = an ? bestDiscard(an) : null;
    // 牌ごとの評価（一番よい牌との差を棒の長さに）
    let qmin = 0, qmax = 0;
    if (an && an.hasQ) { const qs = an.cands.filter(c => c.a && c.a.t === 'discard' && !c.a.riichi).map(c => c.q); qmax = Math.max(...qs); qmin = Math.min(...qs); }
    const evFor = id => {
      if (!showBars) return '';
      const c = an.cands.find(x => x.a && x.a.t === 'discard' && !x.a.riichi && (x.a.tile >> 2) === (id >> 2) && r.isRed(x.a.tile) === r.isRed(id));
      if (!c) return '';
      if (an.hasQ) { const f = qmax - qmin > 1e-6 ? (c.q - qmin) / (qmax - qmin) : 1; return `<span class="ev"><i style="width:${(8 + 92 * f).toFixed(0)}%"></i></span>`; }
      const f = c.m.shanten <= an.minSh ? Math.min(1, (c.m.ukeire || 1) / Math.max(1, an.maxUke)) : 0.08;
      return `<span class="ev sh"><i style="width:${(8 + 92 * f).toFixed(0)}%"></i></span>`;
    };
    const btn = (id, isDrawn) => {
      const can = myTurn && r.canDiscard(id) && (!riichiOK || riichiOK.has(id >> 2));
      const isBest = best && best.tile >> 2 === id >> 2 && r.isRed(best.tile) === r.isRed(id) && (isDrawn || best.tile !== r.drawn || !rest.some(x => x === best.tile) ) && (S.hintOn || settings.showEval);
      const cls = ['ht', isDrawn ? 'drawn' : '', S.sel === id ? 'sel' : '', myTurn && !can ? 'off' : '', isBest && myTurn && !markedBest ? 'best' : ''].filter(Boolean).join(' ');
      if (isBest && myTurn) markedBest = true;
      return `<button class="${cls}" data-id="${id}"${can ? '' : ' disabled'} aria-label="${MJ.kindJa(id >> 2)}${r.isRed(id) ? '（赤）' : ''}">${tile(id)}${evFor(id)}</button>`;
    };
    let markedBest = false;
    // おすすめの印は「一番よい牌」の1枚だけ（同じ種類が複数あれば、ツモ切りならツモった牌に）
    const order = drawn >= 0 && best && best.tile === drawn ? [drawn] : [];
    void order;
    let html = rest.map(id => btn(id, false)).join('');
    if (drawn >= 0) html += btn(drawn, true);
    el.innerHTML = html;
    mel.innerHTML = r.melds[s].map(m => meldHTML(m, s)).join('');
  }
  function getAnalysis() {
    const r = S.round;
    if (!r || r.phase !== 'turn' || r.cur !== S.me) return null;
    if (S.analysis && S.analysis.key === r.steps.length) return S.analysis;
    const res = AI.analyzeTurn(r, S.me, NET);
    const ds = res.cands.filter(c => c.a && c.a.t === 'discard');
    const minSh = Math.min(...ds.map(c => c.m.shanten));
    const maxUke = Math.max(1, ...ds.filter(c => c.m.shanten === minSh).map(c => (c.m.shanten === 0 ? c.m.waits : c.m.ukeire)));
    S.analysis = Object.assign(res, { key: r.steps.length, hasQ: !!NET, minSh, maxUke });
    return S.analysis;
  }
  // 一番よい打牌（ネットがあれば値、なければ向聴数と受け入れ）
  function bestAction(an) {
    const cs = an.cands.filter(c => c.a);
    if (!cs.length) return null;
    if (an.hasQ) return cs.reduce((a, b) => (b.q > a.q ? b : a));
    const key = c => (c.a.t !== 'discard' ? -1e9 : -c.m.shanten * 1000 + (c.m.shanten === 0 ? c.m.waits * 2 + (c.m.hasYaku ? 1 : 0) : c.m.ukeire) + (c.a.riichi ? 0.5 : 0));
    return cs.reduce((a, b) => (key(b) > key(a) ? b : a));
  }
  function bestDiscard(an) { const b = bestAction(an); return b && b.a.t === 'discard' ? b.a : null; }

  // 対局者の一覧（横長のとき左に）
  function renderPlayers(r) {
    const el = $('players');
    if (!r) { el.innerHTML = ''; return; }
    const order = [0, 1, 2, 3].map(p => (S.me + p) % 4);
    const rank = [0, 1, 2, 3].sort((a, b) => (r.scores[b] - r.scores[a]) || (a - b));
    const relName = ['自分', '下家', '対面', '上家'];
    el.innerHTML = order.map((s, p) => {
      const w = r.seatWind(s);
      const turn = r.phase !== 'end' && ((r.phase === 'turn' && r.cur === s) || (r.phase === 'react' && r.react && r.react.from === s));
      const diff = r.scores[s] - r.scores[S.me];
      const lv = isCPU(s) ? `<span class="lvtag">${CPU[S.seats[s]].label}</span>` : '';
      return `<div class="pl${turn ? ' turn' : ''}"><span class="w${w === 0 ? ' dealer' : ''}">${WIND[w]}</span>
        <span class="nm"><span style="overflow:hidden;text-overflow:ellipsis">${esc(S.online ? S.names[s] : isHuman(s) ? 'あなた' : 'CPU')}</span>${lv}${r.riichi[s] ? '<span class="riichi-tag">立直</span>' : ''}${thinking(s) ? '<span class="seatname" style="position:static;color:var(--accent)"><span class="think"><i></i></span></span>' : ''}</span>
        <span class="sc">${r.scores[s].toLocaleString()}<small>${p ? (diff > 0 ? '+' : '') + diff.toLocaleString() : `${rank.indexOf(s) + 1}位`}</small></span>
        <span class="sub">${relName[p]}${p ? `・${rank.indexOf(s) + 1}位` : ''}${onlineTag(s)}</span></div>`;
    }).join('');
  }
  // 情報の行
  function renderInfo(r) {
    const bar = $('infobar'), txt = $('info-txt'), tools = $('info-tools');
    bar.className = 'card infobar';
    tools.innerHTML = '';
    if (!r) { txt.innerHTML = '「⋯」→ 新しい対局 で始めます'; return; }
    if (S.notice) { bar.classList.add('view'); txt.textContent = S.notice; return; }
    if (!live()) {
      bar.classList.add('view');
      const v = S.view;
      const name = v.ri >= 0 ? S.game.roundName(S.game.rounds[v.ri].roundWind, S.game.rounds[v.ri].kyoku, S.game.rounds[v.ri].honba) : '今の局';
      txt.innerHTML = `見返し中: ${esc(name)}（${v.step}手目）`;
      tools.innerHTML = '<button class="btn small" data-act="live">対局に戻る</button>';
      return;
    }
    const s = S.me;
    if (r.phase === 'end') { txt.innerHTML = `${esc(S.game.roundName(r.roundWind, r.kyoku, r.honba))} 終了`; return; }
    if (r.phase === 'turn' && r.cur === s && isHuman(s)) {
      bar.classList.add('turn');
      if (S.riichiMode) { txt.innerHTML = '<b>リーチ</b>: 切る牌を選んでください（もう一度「リーチ」で取り消し）'; return; }
      if (S.sel >= 0) { txt.innerHTML = selInfo(r, S.sel); return; }
      const drawn = r.drawn >= 0 ? `ツモ <span class="mini">${tile(r.drawn)}</span>` : '鳴いたので1枚切ってください';
      txt.innerHTML = `<b>あなたの番</b>　${drawn}${r.riichi[s] ? '（立直中）' : ''}`;
      return;
    }
    if (r.phase === 'react' && S.pending && S.pending.need.has(s)) {
      bar.classList.add('turn');
      txt.innerHTML = `${esc(shortName(r.react.from))}が <span class="mini">${tile(r.react.tile)}</span> を${r.react.kind === 'discard' ? '切りました' : '加槓しようとしています'}`;
      return;
    }
    if (r.phase === 'exhaust' || !(r.phase === 'turn' || r.react)) { txt.innerHTML = '流局: 聴牌の人が手牌を見せています…'; return; }
    const cur = r.phase === 'turn' ? r.cur : r.react.from;
    const last = r.discards.map((d, i) => [d[d.length - 1], i]).filter(x => x[0]).sort((a, b) => b[0].n - a[0].n)[0];
    txt.innerHTML = `${esc(shortName(cur))}の番${last ? `　直前: ${esc(shortName(last[1]))}が <span class="mini">${tile(last[0].tile)}</span>` : ''}`;
  }
  function selInfo(r, id) {
    const an = getAnalysis();
    const kname = MJ.kindJa(id >> 2);
    if (!an) return `${kname}を選んでいます（もう一度タップで切る）`;
    const c = an.cands.find(x => x.a && x.a.t === 'discard' && !x.a.riichi && (x.a.tile >> 2) === (id >> 2));
    if (!c) return `${kname}は切れません`;
    let s = `<b>${kname}</b>を切ると: ${metricText(c.m)}`;
    if (an.hasQ && settings.showEval) { const b = bestAction(an); s += `　評価 ${fmtQ(c.q - b.q)}${b === c ? '（一番）' : ''}`; }
    return s + '　<span class="hint">もう一度タップで切る</span>';
  }
  function metricText(m) {
    if (!m) return '';
    if (m.shanten < 0) return '和了';
    if (m.shanten === 0) return `聴牌（待ち ${m.waitKinds}種 ${m.waits}枚${m.furiten ? '・フリテン' : ''}${m.hasYaku ? '' : '・役なし'}）`;
    return `${m.shanten}向聴（受け入れ ${m.ukeire}枚）`;
  }
  const fmtQ = d => { const v = d * 50; return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1); };

  // AI補助
  function renderAssist(r) {
    const el = $('assist');
    el.classList.toggle('off', !aiOn() || !r || !live());
    if (!aiOn() || !r || !live()) { el.innerHTML = ''; return; }
    const s = S.me;
    let html = '';
    if (r.phase === 'turn' && r.cur === s && isHuman(s) && settings.showEval) {
      const an = getAnalysis();
      if (an) {
        const best = bestAction(an);
        let cs = an.cands.filter(c => c.a).slice();
        cs.sort((a, b) => (an.hasQ ? b.q - a.q : 0) || (a.m && b.m ? a.m.shanten - b.m.shanten || (b.m.shanten === 0 ? b.m.waits - a.m.waits : b.m.ukeire - a.m.ukeire) : 0));
        cs = cs.slice(0, 6);
        html += `<div class="row"><span class="lbl">${an.hasQ ? 'AI の評価' : '牌効率'}</span><div class="cands">${cs.map(c => {
          const t = c.a.t === 'discard' ? tile(c.a.tile) : '';
          const name = c.a.t === 'discard' ? (c.a.riichi ? '立直' : '') : { ankan: '暗槓', kakan: '加槓', kyuushu: '九種九牌' }[c.a.t] || '';
          const val = an.hasQ ? `<b>${c === best ? '一番' : fmtQ(c.q - best.q)}</b>` : '';
          const sub = c.m ? `<small>${c.m.shanten === 0 ? `聴牌${c.m.waits}枚` : c.m.shanten > 0 ? `${c.m.shanten}向聴${c.m.ukeire}枚` : ''}</small>` : '';
          return `<span class="cand${c === best ? ' best' : ''}" data-cand="${an.cands.indexOf(c)}">${t}${name ? `<small>${name}</small>` : ''}${val}${sub}</span>`;
        }).join('')}</div></div>`;
      }
    }
    if (settings.showWaits && r.phase !== 'end') {
      // 今の13枚の待ち（自分の番でないとき）
      if (!(r.phase === 'turn' && r.cur === s) && r.hands[s].length % 3 === 1) {
        const ws = AI.waitInfo(r, s);
        if (ws.length) html += `<div class="row"><span class="lbl">待ち</span><span class="waits">${ws.map(w => `<span>${tileK(w.kind)}×${w.left}</span>`).join('')}${r.isFuriten(s) ? '<span class="riichi-tag" style="background:var(--bad)">フリテン</span>' : ''}</span></div>`;
        else {
          const v = new AI.View().load(r, s);
          const sh = MJ.shanten(v.c, v.nm);
          html += `<div class="row"><span class="lbl">手</span><span>${sh > 0 ? `${sh}向聴` : sh === 0 ? '聴牌' : ''}</span></div>`;
        }
      }
      if (r.phase === 'react' && S.pending && S.pending.need.has(s) && settings.showEval) {
        const an = AI.analyzeReact(r, s, NET);
        if (an && an.cands.length > 1) {
          const best = NET ? an.cands.reduce((a, b) => (b.q > a.q ? b : a)) : null;
          html += `<div class="row"><span class="lbl">鳴き</span><div class="cands">${an.cands.map(c => {
            const name = c.a ? { pon: 'ポン', chi: 'チー', minkan: 'カン' }[c.a.t] : 'スキップ';
            const tiles = c.a && c.a.use ? c.a.use.map(x => tile(x)).join('') : '';
            return `<span class="cand${c === best ? ' best' : ''}">${tiles}<small>${name}</small>${NET ? `<b>${c === best ? '一番' : fmtQ(c.q - best.q)}</b>` : ''}<small>${metricText(c.m)}</small></span>`;
          }).join('')}</div></div>`;
        }
      }
    }
    el.innerHTML = html;
    el.classList.toggle('off', !html);
  }

  // 鳴き・和了のボタン
  function renderCalls(r) {
    const el = $('calls');
    if (!r || !live()) { el.innerHTML = ''; return; }
    const s = S.me;
    let html = '';
    const hintA = S.hintOn;
    const mark = a => (hintA && JSON.stringify(hintA) === JSON.stringify(a) ? ' hintmark' : '');
    if (r.phase === 'turn' && r.cur === s && isHuman(s)) {
      const acts = r.turnActions();
      if (acts.some(a => a.t === 'tsumo')) html += `<button class="callbtn win${mark({ t: 'tsumo' })}" data-call="tsumo">ツモ</button>`;
      if (acts.some(a => a.riichi) && !r.riichi[s]) html += `<button class="callbtn riichi${S.riichiMode ? ' on' : ''}${hintA && hintA.riichi ? ' hintmark' : ''}" data-call="riichi">リーチ</button>`;
      const kans = acts.filter(a => a.t === 'ankan' || a.t === 'kakan');
      kans.forEach((a, i) => { const k = a.t === 'ankan' ? a.kind : a.tile >> 2; html += `<button class="callbtn kan${mark(a)}" data-call="kan" data-i="${i}">カン<span class="tiles">${tileK(k)}</span></button>`; });
      if (acts.some(a => a.t === 'kyuushu')) html += `<button class="callbtn skip${mark({ t: 'kyuushu' })}" data-call="kyuushu">九種九牌</button>`;
      if (r.riichi[s] && (acts.some(a => a.t === 'tsumo') || kans.length)) html += `<button class="callbtn skip" data-call="tsumogiri">ツモ切り</button>`;
    } else if (r.phase === 'react' && S.pending && S.pending.need.has(s)) {
      const o = r.react.options[s];
      o.forEach((a, i) => {
        if (a.t === 'ron') html += `<button class="callbtn win${mark(a)}" data-react="${i}">ロン</button>`;
        else if (a.t === 'pon') html += `<button class="callbtn call${mark(a)}" data-react="${i}">ポン${o.filter(x => x.t === 'pon').length > 1 ? `<span class="tiles">${a.use.map(x => tile(x)).join('')}</span>` : ''}</button>`;
        else if (a.t === 'chi') html += `<button class="callbtn call${mark(a)}" data-react="${i}">チー<span class="tiles">${a.use.slice().sort((x, y) => x - y).map(x => tile(x)).join('')}</span></button>`;
        else if (a.t === 'minkan') html += `<button class="callbtn kan${mark(a)}" data-react="${i}">カン</button>`;
      });
      html += `<button class="callbtn skip${hintA === null && S.hintShownPass ? ' hintmark' : ''}" data-react="-1">スキップ</button>`;
    }
    el.innerHTML = html;
  }

  // この局の流れ（横長の左）
  function renderLog(r) {
    const el = $('log-list');
    if (!S.geo || !r) { el.innerHTML = ''; return; }
    const items = [];
    for (const ev of r.log) {
      if (ev.e === 'call') items.push(`<li class="${isHuman(ev.s) && !S.online ? 'me' : ''}"><span class="who">${esc(shortName(ev.s))}</span>${{ pon: 'ポン', chi: 'チー', minkan: '明槓', ankan: '暗槓', kakan: '加槓' }[ev.type]} ${tile(ev.called != null && ev.called >= 0 ? ev.called : ev.tiles[0])}</li>`);
      else if (ev.e === 'riichi') items.push(`<li class="big"><span class="who">${esc(shortName(ev.s))}</span>リーチ</li>`);
      else if (ev.e === 'dora') items.push(`<li><span class="who">新ドラ</span>${tile(ev.tile)}</li>`);
      else if (ev.e === 'end') items.push(`<li class="big">${esc(resultLine(ev.result))}</li>`);
    }
    el.innerHTML = items.slice(-12).join('') || '<li class="hint">鳴き・立直・ドラがここに出ます</li>';
    $('log-title').textContent = `${S.game ? S.game.roundName(r.roundWind, r.kyoku, r.honba) : 'この局'}`;
  }
  function resultLine(res) {
    if (res.type === 'agari') return res.wins.map(w => `${shortName(w.seat)} ${w.tsumo ? 'ツモ' : 'ロン'} ${w.yakuman ? w.limit : `${w.han}翻${w.fu}符${w.limit ? ' ' + w.limit : ''}`} ${w.value.toLocaleString()}`).join(' / ');
    return { exhaust: '流局', nagashi: '流し満貫', kyuushu: '九種九牌', suufon: '四風連打', suucha: '四家立直', suukaikan: '四開槓', sancha: '三家和' }[res.reason] || '流局';
  }
  function renderControls() {
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    const r = S.round;
    const myTurn = live() && r && ((r.phase === 'turn' && r.cur === S.me && isHuman(S.me)) || (r.phase === 'react' && S.pending && S.pending.need.has(S.me)));
    $('btn-hint').disabled = !myTurn;
  }

  // ------------------------------------------------------------------ 局の結果
  function showResult() {
    const r = S.round, res = r.result;
    const g = S.game;
    const name = g.roundName(r.roundWind, r.kyoku, r.honba);
    let html = '';
    const deltas = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) deltas[s] = r.scores[s] - r.scoresBefore[s];
    if (res.type === 'agari') {
      for (const w of res.wins) {
        const hand = w.hand.filter(x => x !== w.winTile || w.hand.indexOf(x) !== w.hand.lastIndexOf(x)).slice().sort((a, b) => (a >> 2) - (b >> 2) || a - b);
        const idx = hand.indexOf(w.winTile); if (idx >= 0) hand.splice(idx, 1);
        const who = shortName(w.seat), from = w.tsumo ? 'ツモ' : `ロン（${shortName(w.from)}から）`;
        html += `<h2 id="rs-title">${esc(who)}の和了 <small>${esc(name)}・${from}</small></h2>
          <div class="winhand">${hand.map(x => tile(x)).join('')}<span class="gap"></span>${tile(w.winTile, 'win')}<span class="gap"></span>${w.melds.map(m => meldHTML(m, w.seat)).join('<span class="gap"></span>')}</div>
          <div class="yakulist">${w.yaku.map(([n, h]) => `<div><span>${esc(n)}</span><b>${w.yakuman ? (h >= 13 ? '役満' : '') : `${h}翻`}</b></div>`).join('')}</div>
          <div class="pointline">${w.yakuman ? esc(w.limit) : `${w.han}翻 ${w.fu}符${w.limit ? ' ' + esc(w.limit) : ''}`}<span>${(w.value - w.sticks).toLocaleString()}点</span>${w.sticks ? `<small>＋供託 ${w.sticks.toLocaleString()}</small>` : ''}${w.pao >= 0 ? `<small>責任払い: ${esc(shortName(w.pao))}</small>` : ''}</div>
          <div class="doras"><span>ドラ表示牌 ${w.dora.map(x => tile(x)).join('')}</span>${w.ura.length ? `<span>裏ドラ表示牌 ${w.ura.map(x => tile(x)).join('')}</span>` : ''}</div>`;
      }
    } else {
      const reasons = { exhaust: '流局（荒牌）', nagashi: '流し満貫', kyuushu: '九種九牌（途中流局）', suufon: '四風連打（途中流局）', suucha: '四家立直（途中流局）', suukaikan: '四開槓（途中流局）', sancha: '三家和（途中流局）' };
      html += `<h2 id="rs-title">${reasons[res.reason] || '流局'} <small>${esc(name)}</small></h2>`;
      if (res.reason === 'exhaust' || res.reason === 'nagashi') {
        html += `<div class="tenpais">${[0, 1, 2, 3].map(p => (S.me + p) % 4).map(s => `<div class="tp"><b style="min-width:4.5em">${esc(shortName(s))}</b>${res.tenpai[s] ? `聴牌 ${r.hands[s].slice().sort((a, b) => a - b).map(x => tile(x)).join('')}` : '<span class="hint">ノーテン</span>'}</div>`).join('')}</div>`;
        if (res.nagashi && res.nagashi.length) html += `<p>流し満貫: ${res.nagashi.map(s => esc(shortName(s))).join('・')}</p>`;
      }
      html += `<p class="hint">${res.dealerKeeps ? '親の連荘（本場が積まれます）' : '親が流れます'}${r.kyotaku ? `・供託 ${r.kyotaku}本は次の局へ` : ''}</p>`;
    }
    html += `<div class="deltas">${[0, 1, 2, 3].map(p => (S.me + p) % 4).map(s => `<div class="${deltas[s] > 0 ? 'plus' : deltas[s] < 0 ? 'minus' : ''}${s === S.me ? ' me' : ''}"><span>${esc(shortName(s))}</span><b>${deltas[s] > 0 ? '+' : ''}${deltas[s].toLocaleString()}</b><span class="hint">${r.scores[s].toLocaleString()}</span></div>`).join('')}</div>`;
    if (S.online) html += '<p class="hint" id="rs-audit" style="margin:8px 0 0">局のあとの検査をしています（山・混ぜ方・手順）…</p>';
    $('rs-body').innerHTML = html;
    if (S.online && window.MJOnline) window.MJOnline.auditLine();
    const willEnd = predictEnd();
    $('rs-next').textContent = willEnd ? '結果を見る' : '次の局へ';
    $('dlg-result').hidden = false;
  }
  function predictEnd() {
    // 次へ進めたら終わるか（表示の文字のためだけ。実際の判定は finishRound）
    const g = S.game, r = S.round, res = r.result;
    if (g.rules.tobi && r.scores.some(x => x < 0)) return true;
    if (res.dealerKeeps) {
      if (g.isAllLast() && g.rules.agariYame && res.type === 'agari' && res.wins.some(w => w.seat === g.kyoku)) {
        const order = [0, 1, 2, 3].sort((a, b) => (r.scores[b] - r.scores[a]) || (a - b));
        return order[0] === g.kyoku;
      }
      return false;
    }
    return g.isAllLast();
  }
  function nextRound() {
    $('dlg-result').hidden = true;
    if (S.online && window.MJOnline && window.MJOnline.active()) { window.MJOnline.next(); return; }
    const g = S.game;
    if (!S.round || S.round.phase !== 'end') return;
    S.round.kyotakuStart = S.round.kyotakuStart != null ? S.round.kyotakuStart : g.kyotaku;
    const ended = g.finishRound();
    S.round = null;
    if (ended) { saveGame(); render(); showFinal(); return; }
    startRound();
  }
  function showFinal() {
    const g = S.game;
    if (!g.final) return;
    const fs = g.final.slice().sort((a, b) => a.rank - b.rank);
    const mine = g.final.find(f => f.seat === S.me);
    $('fn-sub').textContent = `${g.rules.length === 'tonpu' ? '東風戦' : '東南戦'}・${g.rounds.length}局`;
    $('fn-title').textContent = S.online ? '対局の結果' : mine ? `${mine.rank + 1}位` : '対局の結果';
    $('fn-ranks').innerHTML = fs.map(f => `<li class="${f.seat === S.me ? 'me' : ''}"><b>${f.rank + 1}位</b><span>${esc(S.online ? S.names[f.seat] : shortName(f.seat))}</span><span class="num">${f.score.toLocaleString()}</span><span class="pt ${f.point > 0 ? 'plus' : f.point < 0 ? 'minus' : ''}">${f.point > 0 ? '+' : ''}${f.point.toFixed(1)}</span></li>`).join('');
    $('dlg-final').hidden = false;
    if (!S.online && mine && !g.recorded) {
      g.recorded = true;
      const st = store.get('stats', { games: 0, ranks: [0, 0, 0, 0], points: 0 });
      st.games++; st.ranks[mine.rank]++; st.points += mine.point;
      store.set('stats', st);
    }
  }

  // ------------------------------------------------------------------ 記録と見返し
  function openHist() {
    const g = S.game;
    if (!g) return;
    const rows = g.rounds.map((rd, i) => {
      const my = rd.result.scores[S.me] - rd.scoresBefore[S.me];
      return `<button class="hrow${S.view && S.view.ri === i ? ' cur' : ''}" data-ri="${i}"><span class="no">${esc(g.roundName(rd.roundWind, rd.kyoku, rd.honba))}</span><span class="desc">${esc(resultLine(rd.result))}</span><span class="res ${my > 0 ? 'plus' : my < 0 ? 'minus' : ''}">${my > 0 ? '+' : ''}${my.toLocaleString()}</span></button>`;
    });
    if (S.round && !S.online) rows.push(`<button class="hrow${S.view && S.view.ri === -1 ? ' cur' : ''}" data-ri="-1"><span class="no">${esc(g.roundName())}</span><span class="desc">いまの局（${S.round.steps.length}手）</span><span class="res"></span></button>`);
    $('hist').innerHTML = rows.join('') || '<p class="hint">まだ終わった局はありません</p>';
    const st = store.get('stats', null);
    $('hist-sum').textContent = st && st.games ? `この端末の成績: ${st.games}戦・平均順位 ${((st.ranks[0] + 2 * st.ranks[1] + 3 * st.ranks[2] + 4 * st.ranks[3]) / st.games).toFixed(2)}・トップ率 ${(st.ranks[0] / st.games * 100).toFixed(0)}%` : '';
    const sh = $('sheet');
    // 見返している間は卓が見えるよう低く（テープと局の一覧の2行くらい）
    const h = S.view ? Math.min(150, window.innerHeight * 0.4) : Math.min(340, window.innerHeight * 0.65);
    sh.style.setProperty('--sheet-top', Math.round(window.innerHeight - h) + 'px');
    sh.classList.add('open');
    renderTape();
  }
  function closeHist() { $('sheet').classList.remove('open'); }
  function viewRound(ri, step) {
    const g = S.game;
    const rec = ri >= 0 ? g.rounds[ri] : null;
    const n = rec ? rec.steps.length : S.round ? S.round.steps.length : 0;
    clearTimeout(S.timer);
    S.view = { ri, step: Math.max(0, Math.min(n, step == null ? n : step)), n };
    S.sel = -1;
    render(); renderTape();
    $('navrow').hidden = false;
  }
  function backToLive() {
    S.view = null;
    $('navrow').hidden = true;
    render(); renderTape(); schedule();
  }
  function renderTape() {
    const el = $('tape');
    if (!S.view) { el.innerHTML = ''; $('navrow').hidden = true; return; }
    const g = S.game, v = S.view;
    const rec = v.ri >= 0 ? g.rounds[v.ri] : { steps: S.round.steps };
    // 手番の打牌だけをテープに（返事は「鳴き」のときだけ）
    let html = `<button data-step="0" class="${v.step === 0 ? 'cur' : ''}">配牌</button>`;
    rec.steps.forEach((st, i) => {
      let label = '';
      if (st.k === 't') {
        const a = st.a;
        const who = `<span class="who">${esc(shortName(st.s)).slice(0, 3)}</span>`;
        if (a.t === 'discard') label = `${who}${tile(a.tile)}${a.riichi ? '立直' : ''}`;
        else label = `${who}${{ tsumo: 'ツモ', ankan: '暗槓', kakan: '加槓', kyuushu: '九種' }[a.t]}`;
      } else {
        const idx = st.resp.findIndex(Boolean);
        if (idx < 0) return;
        label = `<span class="who">${esc(shortName(idx)).slice(0, 3)}</span>${{ ron: 'ロン', pon: 'ポン', chi: 'チー', minkan: 'カン' }[st.resp[idx].t]}`;
      }
      html += `<button data-step="${i + 1}" class="${v.step === i + 1 ? 'cur' : ''}">${label}</button>`;
    });
    el.innerHTML = html;
    const cur = el.querySelector('.cur');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ------------------------------------------------------------------ 新しい対局
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg); drawNew(); $('dlg-new').hidden = false;
    if (S.online) return;
    // 待っている CPU の手・局の結果の表示を止める（閉じたら止めたところから）
    clearTimeout(S.timer);
    if (S.round && S.round.phase === 'end' && $('dlg-result').hidden && $('dlg-final').hidden) S.resultShown = false;
    render();
  }
  // 「やめる」・背景・Esc・「オンラインの卓」で閉じたとき（「始める」は新しい対局を始める）
  function closeNew() {
    if ($('dlg-new').hidden) return;
    $('dlg-new').hidden = true;
    schedule();
  }
  function drawNew() {
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = NET ? CPU[draft.cpu].desc : `${CPU[draft.cpu].desc}（学習したネットがまだないので、いまはどの強さも牌効率で打ちます）`;
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    // 「オンラインの卓」を選ぶとすぐオンラインのパネルへ（上の丸いボタンと同じ）
    seg('ng-mode', [['cpu', 'CPU 3人と'], ['online', 'オンラインの卓']], 'cpu');
    seg('ng-len', [['tonpu', '東風戦（4局）'], ['hanchan', '東南戦（8局）']], draft.length);
    seg('ng-aka', [['3', 'あり（赤5を各1枚）'], ['0', 'なし']], draft.aka);
    seg('ng-seat', [['random', 'ランダム'], ['0', '東（起家）'], ['1', '南'], ['2', '西'], ['3', '北']], draft.seat);
  }

  // ------------------------------------------------------------------ ルールと AI のページ
  function docTabs(view, key) {
    const inner = view.querySelector('.doc-in');
    const cards = [...inner.querySelectorAll(':scope > .dcard')];
    if (cards.length < 2) return;
    const bar = document.createElement('div');
    bar.className = 'doctabs'; bar.setAttribute('role', 'tablist');
    bar.innerHTML = cards.map((c, i) => `<button role="tab" data-i="${i}">${esc(c.dataset.tab || i + 1)}</button>`).join('');
    inner.prepend(bar);
    const show = i => {
      cards.forEach((c, j) => { c.hidden = j !== i; });
      bar.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
      store.set('doctab-' + key, i);
      view.scrollTop = 0;
    };
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
    show(Math.min(store.get('doctab-' + key, 0), cards.length - 1));
  }
  const ex = str => MJ.parseTiles(str).map(id => TL.tileHTML(id >> 2, str.includes('0') && (id === 16 || id === 52 || id === 88), '')).join('');
  function renderRules() {
    const Y = [
      ['立直', '1翻（門前のみ）', '聴牌で1000点を出して宣言。以後は手を変えられない', ''],
      ['一発', '1翻', '立直から1巡以内（だれも鳴かない間）に和了', ''],
      ['門前清自摸和', '1翻（門前のみ）', '門前でツモ和了', ''],
      ['平和', '1翻（門前のみ）', '4面子がすべて順子・雀頭が役牌でない・両面待ち', '23m456m789p345s88s'],
      ['断幺九', '1翻（喰いタンあり）', '2〜8の数牌だけ', '234m567p345678s22p'],
      ['一盃口', '1翻（門前のみ）', '同じ順子が2つ', '112233m456p789s55s'],
      ['役牌', '1翻（1つごと）', '三元牌・自風・場風の刻子', '777z123m456p789s55s'],
      ['嶺上開花・槍槓・海底摸月・河底撈魚', '各1翻', '槓のあとの嶺上牌で和了・加槓の牌でロン・最後のツモで和了・最後の捨て牌でロン', ''],
      ['ダブル立直', '2翻', '最初の打牌で立直（だれも鳴いていない）', ''],
      ['七対子', '2翻（25符）', '7種類の対子（同じ牌4枚は2組にしない）', '1122m3344p5566s77z'],
      ['三色同順', '2翻（喰い1翻）', '3色で同じ数の順子', '123m123p123s456p99s'],
      ['一気通貫', '2翻（喰い1翻）', '同じ色の123・456・789', '123456789m234p55s'],
      ['混全帯幺九', '2翻（喰い1翻）', 'すべての面子と雀頭に么九牌（字牌を含む）', '123m789p111z99s789s'],
      ['対々和', '2翻', '4面子がすべて刻子', '111m999p555s333z44z'],
      ['三暗刻', '2翻', '暗刻が3つ（ロンで完成した刻子は明刻）', ''],
      ['三色同刻', '2翻', '3色で同じ数の刻子', '222m222p222s345m66p'],
      ['三槓子', '2翻', '槓子が3つ', ''],
      ['小三元', '2翻', '三元牌の2つが刻子・1つが雀頭', ''],
      ['混老頭', '2翻', '么九牌だけ', '111m999p11s222z333z'],
      ['混一色', '3翻（喰い2翻）', '1色の数牌と字牌だけ', '123456m789m111z22z'],
      ['純全帯幺九', '3翻（喰い2翻）', 'すべての面子と雀頭に1か9（字牌なし）', '123m789m123p789s11s'],
      ['二盃口', '3翻（門前のみ）', '一盃口が2つ', '223344m556677p88s'],
      ['清一色', '6翻（喰い5翻）', '1色の数牌だけ', '11123455678999m'],
      ['役満', '13翻', '国士無双・四暗刻・大三元・小四喜・大四喜・字一色・緑一色・清老頭・九蓮宝燈・四槓子・天和・地和（ダブル役満なし。複合はあり）', '19m19p19s1234567z1m'],
    ];
    $('view-rules').innerHTML = `<div class="doc-in">
      <div class="dcard" data-tab="あそびかた">
        <h3>リーチ麻雀（4人）</h3>
        <p>4人で、山から1枚ツモって1枚切るをくり返し、<b>4つの面子（順子 = 続きの3枚・刻子 = 同じ3枚）と雀頭（同じ2枚）</b>をそろえて和了ります。和了るには<b>役</b>が1つ以上必要です。</p>
        <div class="tilesrow">${ex('123m456p789s111z99s')}</div>
        <ul>
          <li>手牌をタップすると浮き上がり、もう一度タップで切ります。ポン・チー・カン・ロン・ツモ・リーチのボタンは、できるときだけ出ます</li>
          <li><b>ポン</b>: だれかの捨て牌で刻子を作る。<b>チー</b>: 上家（左の人）の捨て牌で順子を作る。<b>カン</b>: 同じ牌4枚。鳴くと「門前」でなくなり、使えない役があります</li>
          <li><b>立直</b>: 門前で聴牌したら、1000点を出して宣言できます（1翻。裏ドラ・一発のチャンス）。持ち点1000点以上・山の残り4枚以上のとき</li>
          <li><b>フリテン</b>: 自分の待ちの牌を自分で捨てている・待ちの牌を見逃した（次に自分が切るまで。立直中はこの局ずっと）ときはロンできません（ツモは和了れます）</li>
          <li>AI補助: 手牌の下の棒が「その牌を切ったときの評価」（長いほどよい）、緑の点がおすすめ。待ちと残り枚数も出ます</li>
        </ul>
      </div>
      <div class="dcard" data-tab="役">
        <h3>役（翻）</h3>
        <div class="yakus">${Y.map(([n, h, d, e]) => `<div class="y"><b>${n}</b><span class="h">${h}</span><small>${d}</small>${e ? `<span class="ex">${ex(e)}</span>` : ''}</div>`).join('')}</div>
        <p class="hint">ドラ（表示牌の次の牌）・赤ドラ・裏ドラ（立直して和了ったとき）は1枚ごとに1翻。ただし役ではないので、役がないと和了れません。</p>
      </div>
      <div class="dcard" data-tab="点数">
        <h3>点数の計算（符と翻）</h3>
        <ul>
          <li>基本点 = 符 × 2<sup>翻＋2</sup>。子のロンは4倍、親は6倍（100点単位に切り上げ）。ツモは子が親から2倍・子から1倍ずつ、親は全員から2倍ずつ</li>
          <li>5翻（または基本点2000以上）で満貫 8000、6〜7翻 跳満 12000、8〜10翻 倍満 16000、11〜12翻 三倍満 24000、13翻以上 数え役満 32000（子の点。親は1.5倍）。切り上げ満貫はなし</li>
          <li>符: 基本20符・門前ロン+10・ツモ+2（平和のツモは20符ちょうど）・刻子（中張牌 明刻2・暗刻4、么九牌 明刻4・暗刻8、槓子はその4倍）・役牌の雀頭+2（連風牌は+4）・嵌張・辺張・単騎+2。10符単位に切り上げ。鳴いて符がなければ30符。七対子は25符</li>
          <li>本場1本ごとに300点（ツモは1人100点ずつ）。供託の立直棒は和了った人へ（ダブロンは放銃者に近い人へ）</li>
        </ul>
        <div class="tbl"><table class="lv"><thead><tr><th>子</th><th class="r">1翻</th><th class="r">2翻</th><th class="r">3翻</th><th class="r">4翻</th></tr></thead><tbody>
          ${[30, 40, 50, 60, 70].map(fu => `<tr><td>${fu}符</td>${[1, 2, 3, 4].map(h => `<td class="r">${MJ.payOf(MJ.basicPoints(h, fu, 0), false, false).ron.toLocaleString()}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
      </div>
      <div class="dcard" data-tab="この卓のルール">
        <h3>採用したルール</h3>
        <div class="tbl"><table class="lv"><tbody>
          <tr><td>人数・長さ</td><td>4人。東風戦（東1〜4局）か東南戦（東1〜南4局）。西入なし</td></tr>
          <tr><td>持ち点</td><td>25000点持ち・30000点返し。ウマ 10-20（1位 +20・2位 +10・3位 −10・4位 −20）、オカ +20 は1位へ。同点は起家に近い方が上</td></tr>
          <tr><td>赤ドラ</td><td>あり（5萬・5筒・5索に各1枚）か なし を選べる</td></tr>
          <tr><td>喰いタン・後付け</td><td>あり（1翻縛り）</td></tr>
          <tr><td>立直</td><td>持ち点1000点以上・山の残り4枚以上。立直後の暗槓は、待ちも面子の形も変わらないときだけ。一発・裏ドラ・槓裏あり</td></tr>
          <tr><td>ドラ</td><td>槓ドラあり（暗槓はすぐ、明槓・加槓は嶺上牌の打牌のあとにめくる）</td></tr>
          <tr><td>喰い替え</td><td>なし（鳴いた牌と同じ牌・チーの筋の反対側は切れない）</td></tr>
          <tr><td>ダブロン</td><td>あり（三家和は流局）。供託は放銃者に近い人へ、本場はそれぞれへ</td></tr>
          <tr><td>役満</td><td>複合あり・ダブル役満なし・数え役満あり。大三元・大四喜の責任払いあり（ツモは全額、ロンは放銃者と半分ずつ）</td></tr>
          <tr><td>流局</td><td>荒牌流局（聴牌料 3000点。形式聴牌あり、純カラは聴牌にしない）・流し満貫・九種九牌・四風連打・四家立直・四開槓・三家和</td></tr>
          <tr><td>連荘</td><td>親の和了・親の聴牌・途中流局で連荘（本場+1）。子の和了で本場は0、親がノーテンの流局は親流れで本場+1</td></tr>
          <tr><td>終わり</td><td>持ち点が0点未満で飛び終了。オーラスで親が和了って1位なら和了り止め（聴牌止めなし）。残った供託は1位へ</td></tr>
          <tr><td>フリテン</td><td>見逃しは形の上で待ちに当たる牌を見逃したとき（役がなくても）。同巡内（次に自分が切るまで）・立直中はこの局ずっと</td></tr>
        </tbody></table></div>
        <p class="hint">ルールの細かいところ（符・役・流局・責任払いなど）は、自動のテストで確かめています（test/test-core.js・test/test-rules.js）。</p>
      </div></div>`;
    docTabs($('view-rules'), 'rules');
  }
  function renderAIPage() {
    const m = NETINFO || {};
    const st = window.MJ_STRENGTH || null;
    $('view-ai').innerHTML = `<div class="doc-in">
      <div class="dcard" data-tab="強さ">
        <h3>この AI の強さ</h3>
        ${NET ? `<div class="stat-row">
          <div class="stat"><b>${(m.games || 0).toLocaleString()}</b><span>自己対局の半荘</span></div>
          <div class="stat"><b>${((m.samples || 0) / 1e6).toFixed(0)}百万</b><span>学んだ手</span></div>
          <div class="stat"><b>第${m.gen || 0}世代</b><span>いまのネット</span></div>
        </div>` : '<p>まだ学習したネットが入っていません（いまはどの強さも「牌効率だけ」で打ちます）。</p>'}
        ${st ? st.html : '<p class="hint">強さの測定は README.md に記録しています。</p>'}
      </div>
      <div class="dcard" data-tab="しくみ">
        <h3>しくみ: 自己対局の強化学習（行動の値を TD(λ) で）</h3>
        <ul>
          <li><b>人の知識を使わない</b>: 人の牌譜・既存の麻雀 AI・人が作った評価の数値は一切使っていません。知っているのはルールだけで、強さは自分どうしで何十万局も打って（自己対局）身につけました</li>
          <li><b>見るもの</b>: 自分の手牌・全員の河と副露・見えていない牌の枚数・ドラ・立直や鳴きの状況・点数と順位と点差・局と残りの山。そこに、ルールから計算できること（その牌を切ったときの向聴数・受け入れの枚数・聴牌なら待ちの枚数と和了ったときの点・フリテン・相手ごとにルール上ロンされない牌）を足します</li>
          <li><b>学ぶもの</b>: 「この局面でこの行動（打牌・立直・ポン・チー・カン・見送り）をしたら、半荘の最後にどれだけの順位点になるか」の見込み。ネットは全結合 ${AI.S_BITS}＋${AI.A_BITS} → 256 → 128 → 64 → 2</li>
          <li><b>局の終わりの価値</b>: 局のあとの点数の状況から「この半荘の最終の順位点の見込み」を出す小さなネット（これも自己対局の半荘の結果から学ぶ）で、オーラスの点差の勝負どころも学びます</li>
          <li><b>学び方</b>: 局が終わったら、自分の手を後ろからたどり、「局の終わりの値」と「次の手番での一番よい手の見込み」を混ぜたものを、その手の目標にします（TD(λ)）。ときどき わざと違う手（でたらめな手や、立直か黙聴か・鳴くか見送るかを逆にした手）を試して、選ばなかった手の値も学びます</li>
          <li><b>強さの段</b>: やさしい = ネットの値にゆらぎ（温度 0.005: 値の差 ÷ 0.005 の exp に比例して選ぶ）、ふつう = 牌効率だけ（基準の AI）、つよい・最強 = ネットの一番の手。測った強さの順（「強さ」の表）。考える時間を延ばした5段目「超最強」は置いていません: 見えない牌を何通りも決めて先を読む方法を 16 → 64 通りに増やしても、つよい と互角（平均順位 2.51・2.49）で強くならなかったため</li>
          <li>ネットは 8 ビットに縮めてこのページに入っています（js/weights.js）。計算はすべてブラウザの中です</li>
        </ul>
      </div></div>`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ 操作
  function setSetting(k, v) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', showWaits: 'set-waits', autowin: 'set-autowin', nocall: 'set-nocall', fast: 'set-fast', sound: 'set-sound' }[k];
    if (box) $(box).checked = v;
    if ((k === 'showEval' || k === 'showWaits') && window.MJOnline) window.MJOnline.setAI(aiFlags());
    render();
  }
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.showWaits ? 2 : 0);
  function hint() {
    const r = S.round;
    if (!r || !live()) return;
    S.hints = (S.hints || 0) + 1;
    if (window.MJOnline && S.online) window.MJOnline.hint();
    if (r.phase === 'turn' && r.cur === S.me) {
      const an = getAnalysis();
      const b = an && bestAction(an);
      if (!b) return;
      S.hintOn = b.a;
      if (b.a.t === 'discard') S.sel = b.a.tile;
      if (b.a.riichi) S.riichiMode = true;
    } else if (r.phase === 'react' && S.pending && S.pending.need.has(S.me)) {
      const o = r.react.options[S.me];
      if (o.some(a => a.t === 'ron')) { S.hintOn = o.find(a => a.t === 'ron'); }
      else {
        const an = AI.analyzeReact(r, S.me, NET);
        let best = null;
        if (NET) best = an.cands.reduce((a, b) => (b.q > a.q ? b : a));
        else best = an.cands[0];
        S.hintOn = best.a; S.hintShownPass = !best.a;
      }
    }
    render();
  }
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') fitSoon();
    }));
    // 手牌: タップで浮き上がり、もう一度で切る
    $('hand').addEventListener('click', e => {
      const b = e.target.closest('.ht');
      if (!b || b.disabled) return;
      const id = Number(b.dataset.id), r = S.round;
      if (!live() || r.phase !== 'turn' || r.cur !== S.me) return;
      if (S.sel === id) {
        if (S.riichiMode) humanTurn({ t: 'discard', tile: id, riichi: true });
        else humanTurn({ t: 'discard', tile: id, riichi: false });
      } else { S.sel = id; render(); }
    });
    // マウスでは2回押さなくてもよいよう、ダブルクリックでもすぐ切る
    $('hand').addEventListener('dblclick', e => {
      const b = e.target.closest('.ht');
      if (!b || b.disabled) return;
      const id = Number(b.dataset.id);
      if (S.sel !== id) return;
    });
    $('calls').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const r = S.round;
      if (b.dataset.react != null) {
        const i = Number(b.dataset.react);
        humanReact(i < 0 ? null : r.react.options[S.me][i]);
        return;
      }
      const c = b.dataset.call;
      if (c === 'tsumo') humanTurn({ t: 'tsumo' });
      else if (c === 'riichi') { S.riichiMode = !S.riichiMode; if (S.riichiMode) { const ok = new Set(r.turnActions().filter(a => a.riichi).map(a => a.tile >> 2)); if (S.sel >= 0 && !ok.has(S.sel >> 2)) S.sel = -1; } render(); }
      else if (c === 'kan') { const kans = r.turnActions().filter(a => a.t === 'ankan' || a.t === 'kakan'); humanTurn(kans[Number(b.dataset.i)]); }
      else if (c === 'kyuushu') humanTurn({ t: 'kyuushu' });
      else if (c === 'tsumogiri') humanTurn({ t: 'discard', tile: r.drawn, riichi: false });
    });
    $('assist').addEventListener('click', e => {
      const c = e.target.closest('[data-cand]');
      if (!c || !S.analysis) return;
      const cd = S.analysis.cands[Number(c.dataset.cand)];
      if (cd && cd.a && cd.a.t === 'discard') { S.sel = cd.a.tile; S.riichiMode = !!cd.a.riichi; render(); }
    });
    $('infobar').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b && b.dataset.act === 'live') backToLive();
    });
    $('stage').addEventListener('click', () => { if (S.sel >= 0 && !S.riichiMode) { S.sel = -1; render(); } });
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); settings.showEval = on; settings.showWaits = on; store.set('settings', settings); $('set-eval').checked = on; $('set-waits').checked = on; if (window.MJOnline) window.MJOnline.setAI(aiFlags()); render(); });
    $('btn-hint').addEventListener('click', hint);
    $('btn-hist').addEventListener('click', () => { if ($('sheet').classList.contains('open')) closeHist(); else openHist(); });
    $('btn-menu').addEventListener('click', () => {
      const st = store.get('stats', null);
      $('mn-stats').textContent = st && st.games ? `この端末の成績: ${st.games}戦・平均順位 ${((st.ranks[0] + 2 * st.ranks[1] + 3 * st.ranks[2] + 4 * st.ranks[3]) / st.games).toFixed(2)}・平均 ${(st.points / st.games).toFixed(1)}pt` : '';
      $('dlg-menu').hidden = false;
    });
    $('dlg-menu').addEventListener('click', e => {
      if (e.target === $('dlg-menu')) { $('dlg-menu').hidden = true; return; }
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      const m = b.dataset.menu;
      $('dlg-menu').hidden = true;
      if (m === 'new') openNew();
      else if (m === 'hist') openHist();
      else if (m === 'online') { if (window.MJOnline) window.MJOnline.open(); }
      else if (m === 'leave') { if (S.online && window.MJOnline) window.MJOnline.leave(); clearTimeout(S.timer); S.game = null; S.round = null; store.set('game', null); render(); openNew(); }
    });
    $('sheet').addEventListener('click', e => {
      if (e.target.closest('[data-act="sheet-close"]')) { closeHist(); return; }
      const row = e.target.closest('.hrow');
      if (row) { viewRound(Number(row.dataset.ri), 0); openHist(); return; }
      const nb = e.target.closest('[data-nav]');
      if (nb && S.view) {
        const v = S.view, n = v.n;
        const nav = nb.dataset.nav;
        viewRound(v.ri, nav === 'first' ? 0 : nav === 'prev' ? v.step - 1 : nav === 'next' ? v.step + 1 : n);
        return;
      }
      const tb = e.target.closest('[data-step]');
      if (tb && S.view) viewRound(S.view.ri, Number(tb.dataset.step));
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards4 button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        // 今の対局は、オンラインで卓に着くまでそのまま
        if (id === 'ng-mode') { if (v === 'online') { closeNew(); if (window.MJOnline) window.MJOnline.open(); } return; }
        if (id === 'ng-cpu') draft.cpu = v; else if (id === 'ng-len') draft.length = v; else if (id === 'ng-aka') draft.aka = +v; else if (id === 'ng-seat') draft.seat = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) closeNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    $('rs-next').addEventListener('click', nextRound);
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) { openHist(); return; } viewRound(-1, 0); openHist(); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    $('fn-again').addEventListener('click', () => { $('dlg-final').hidden = true; if (S.online && window.MJOnline) window.MJOnline.again(); else startGame(cfg); });
    $('fn-new').addEventListener('click', () => { $('dlg-final').hidden = true; openNew(); });
    $('fn-hist').addEventListener('click', () => { $('dlg-final').hidden = true; openHist(); });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    document.addEventListener('click', e => { if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); } });
    [['set-eval', 'showEval'], ['set-waits', 'showWaits'], ['set-autowin', 'autowin'], ['set-nocall', 'nocall'], ['set-fast', 'fast'], ['set-sound', 'sound']].forEach(([id, k]) => {
      const el = $(id); el.checked = settings[k]; el.addEventListener('change', () => setSetting(k, el.checked));
    });
    $('btn-online').addEventListener('click', () => { if (window.MJOnline) window.MJOnline.open(); });
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    window.addEventListener('resize', fitSoon);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeNew(); ['dlg-menu', 'dlg-online'].forEach(id => { $(id).hidden = true; }); closeHist(); $('settings').hidden = true; if (S.sel >= 0) { S.sel = -1; S.riichiMode = false; render(); } return; }
      if (e.target.closest('input, textarea, .dialog') || $('view-play').hidden) return;
      if (S.view) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); viewRound(S.view.ri, S.view.step - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); viewRound(S.view.ri, S.view.step + 1); }
      }
    });
  }

  // オンラインの卓の部品（online-table.js）に渡すもの
  window.MJApp = {
    S, store, settings, aiFlags, render, afterChange, schedule, startRoundFrom: null, makeAgent, NET, CPU, showResult, showFinal, shortName, esc, tile, $,
    setOnline(o) { S.online = o; clearTimeout(S.timer); if (o) S.agents = [null, null, null, null]; },
    callout,
    // 動作確認用: 自分の席も CPU に打たせる（おまかせ）
    autoplay(level) { if (!S.game) return; S.seats[S.me] = level || 'human'; S.agents[S.me] = level ? makeAgent(level) : null; S.pending = null; schedule(); },
    fast(on) { settings.fast = !!on; },
    loadOnlineGame(state) { /* online-table.js が局を作って S.game / S.round に入れたあと呼ぶ */ S.view = null; S.sel = -1; S.riichiMode = false; S.pending = null; S.logPos = 0; fit(); render(); },
  };

  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  fit();
  if (window.MJOnline) window.MJOnline.init(window.MJApp);
  const saved = store.get('game', null);
  if (!(window.MJOnline && window.MJOnline.active()) && saved && saved.v === 1 && saved.g) {
    try { loadGame(saved); } catch (e) { console.error(e); startGame(cfg); }
  } else if (!(window.MJOnline && window.MJOnline.active())) {
    startGame(cfg);
    openNew();
  }
})();
