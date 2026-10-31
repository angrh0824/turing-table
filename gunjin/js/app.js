/* 軍人将棋 Webアプリ: 配置・対局（審判はコンピューター）・CPU（Web Worker）・AI補助・オンライン（約束と明かし合い） */
(function () {
  'use strict';
  const C = window.GunjinCore, AI = window.GunjinAI(C), PR = window.GunjinNet(C);
  const { NP, NT, BLACK, WHITE, NAMES, HQ, SHOSA, GUNKI } = C;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const SIDE = ['先手', '後手'], MARK = ['▲', '△'];
  const SHORT = ['大将', '中将', '少将', '大佐', '中佐', '少佐', '大尉', '中尉', '少尉', '飛行', 'タンク', '騎兵', '工兵', 'スパイ', '地雷', '軍旗'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const W8 = window.GUNJIN_WEIGHTS || null;
  const NETW = W8 ? AI.Net.fromJSON(W8) : null; // 配置のおすすめ（学んだ好み）に使う

  // ------------------------------------------------------------------ CPU の強さ（README に測った差）
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '読みが浅く、迷いながら指します。配置もばらばら', ms: 500 },
    normal: { label: 'ふつう', stars: 2, desc: '相手の駒を少しだけ推理して指します', ms: 600 },
    strong: { label: 'つよい', stars: 3, desc: '相手の駒の正体を6通り推理して、よい手を選びます', ms: 700 },
    max: { label: '最強', stars: 4, desc: '48通り推理して全力で選びます。配置も学んだ形', ms: 800 },
  };
  const STR = window.GUNJIN_STRENGTH || null;
  if (STR && STR.ultra && STR.ultra.ok) CPU.ultra = { label: '超最強', stars: 5, desc: '最強と同じ AI で、推理する組み合わせを3倍に増やします', ms: 300 };
  const CPU_KEYS = Object.keys(CPU);

  // ------------------------------------------------------------------ 設定
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('gunjin-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('gunjin-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong' }, store.get('cfg', {}));
  const settings = Object.assign({ showEval: true, guess: true, arrow: true, sound: true, anim: true, marks: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.arrow;

  // ------------------------------------------------------------------ 状態
  const S = {
    mode: 'cpu', seats: ['human', 'normal'],
    phase: 'setup',          // setup（配置）| play | over
    setups: [null, null],    // ローカルの対局: 両方の配置（審判が使う。画面には見てよい側だけ出す）
    drafting: -1, draft: null, swapSel: -1,
    game: null, log: [], result: null,
    view: null, sel: -1, targets: new Map(), inspect: -1,
    flip: false, curtain: null, pvpViewer: 0, // 目隠し（ふたりで交代のとき）: 表示する文・いま駒を見ている人
    info: null, evals: [], hint: -1, hintPly: -1,
    thinking: false, timer: 0, resultShown: false,
    online: null,
  };
  const live = () => S.view === null;
  const isCPU = c => !!CPU[S.seats[c]];
  const isHuman = c => S.seats[c] === 'human';
  const isRemote = c => S.seats[c] === 'remote';
  const stm = () => S.log.length % 2;  // 先手から交互
  const humanColor = () => (S.mode === 'online' ? S.online.me : isHuman(BLACK) && !isHuman(WHITE) ? BLACK : isHuman(WHITE) && !isHuman(BLACK) ? WHITE : -1);
  // その局面で、見てよい側の配置（相手の駒は種類 -1 = 裏）
  function trueSetup(c) {
    if (S.mode === 'online') { const o = S.online; return c === o.me ? o.setup : o.oppSetup; }
    return S.setups[c];
  }
  // 見ている人: 0/1 = その色の駒だけ表、-1 = 両方表（観戦・終局後）、-2 = 全部裏（目隠し中）
  function viewer() {
    if (S.curtain) return -2;
    if (S.phase === 'over' && (S.mode !== 'online' || S.online.oppSetup)) return -1;
    if (S.mode === 'watch') return -1;
    if (S.mode === 'online') return S.online.me;
    if (S.mode === 'pvp') return S.phase === 'setup' ? S.drafting : S.pvpViewer; // 指した人の番が終わっても、目隠しが出るまでは指した人の駒だけ
    return humanColor();
  }
  function visSetups() {
    const v = viewer(), s = [null, null];
    for (const c of [BLACK, WHITE]) {
      if (S.phase === 'setup' && c === S.drafting && S.draft) { if (v === c || v === -1) s[c] = S.draft; continue; }
      if (v === -1 || v === c) s[c] = trueSetup(c) || null;
    }
    return s;
  }
  function dispPos() { return C.replay(visSetups(), S.log, live() ? S.log.length : S.view); }
  // 自分の配置と公開の記録だけ（AI に渡すのはこれだけ）
  function viewOf(c) { const s = trueSetup(c); return s ? C.view(c, s, S.log.slice(0, live() ? S.log.length : S.view)) : null; }

  // ------------------------------------------------------------------ AI（Web Worker）
  const AIW = {
    w: null, seq: 0, epoch: 0, cbs: new Map(),
    worker() {
      if (this.w) return this.w;
      try {
        this.w = new Worker('js/ai-worker.js');
        this.w.onmessage = e => { const cb = this.cbs.get(e.data.id); this.cbs.delete(e.data.id); if (cb && cb.epoch === this.epoch) cb.fn(e.data); };
      } catch (e) { this.w = null; }
      return this.w;
    },
    ask(msg, fn) {
      const w = this.worker();
      if (!w) return;
      const id = ++this.seq;
      this.cbs.set(id, { fn, epoch: this.epoch });
      w.postMessage(Object.assign({ id }, msg));
    },
    cancel() { this.epoch++; },
  };

  // ------------------------------------------------------------------ 音（Web Audio で合成）
  let actx = null;
  function sfx(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime, len = kind === 'battle' ? 0.16 : 0.06;
      const buf = actx.createBuffer(1, Math.floor(actx.sampleRate * len), actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, kind === 'battle' ? 2.2 : 4);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'battle' ? 420 : kind === 'win' ? 1600 : 1150; bp.Q.value = kind === 'battle' ? 1.2 : 3.5;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'battle' ? 0.9 : 0.55, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      src.connect(bp); bp.connect(g); g.connect(actx.destination); src.start(t0);
      if (kind === 'battle') { const o = actx.createOscillator(), og = actx.createGain(); o.frequency.setValueAtTime(130, t0); o.frequency.exponentialRampToValueAtTime(60, t0 + 0.2); og.gain.setValueAtTime(0.35, t0); og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22); o.connect(og); og.connect(actx.destination); o.start(t0); o.stop(t0 + 0.24); }
    } catch (e) { /* 音が出せなくても動く */ }
  }

  // ------------------------------------------------------------------ 配置のひな形（人が並べるときの手助け。AI はこれを使わない）
  const T = C;
  const PRESETS = {
    attack: [T.KOHEI, T.TANK, T.SHOSA, T.TAII, T.TANK, T.CHUI, T.SHOI, T.CHUJO, T.JIRAI, T.TAISA, T.SHOSHO, T.KIHEI, T.CHUI, T.CHUSA, T.GUNKI, T.KOHEI, T.TAII, T.SHOI, T.HIKO, T.SPY, T.TAISHO, T.JIRAI, T.HIKO],
    defense: [T.JIRAI, T.TAII, T.SHOI, T.JIRAI, T.CHUI, T.KIHEI, T.KOHEI, T.TANK, T.SHOSA, T.CHUSA, T.TANK, T.SHOI, T.CHUI, T.TAISA, T.GUNKI, T.SHOSHO, T.KOHEI, T.TAII, T.SPY, T.HIKO, T.TAISHO, T.HIKO, T.CHUJO],
  };
  function suggestSetup(sigma) { return NETW ? AI.sampleSetup(NETW.setup, sigma, Math.random) : C.randomSetup(); }
  function cpuSetup(level) { const s = { easy: 4, normal: 2, strong: 1, max: 1 }[level] || 1; return suggestSetup(s); }

  // ------------------------------------------------------------------ 対局の始め方
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    AIW.cancel(); clearTimeout(S.timer);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuB, cfg.cpuW];
    else {
      const h = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = h === BLACK ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    S.mode = cfg.mode === 'pvp' || cfg.mode === 'watch' ? cfg.mode : 'cpu';
    S.seats = seats; S.log = []; S.result = null; S.resultShown = false; S.view = null; S.evals = []; S.info = null; S.hint = -1;
    S.setups = [null, null]; S.game = null; S.sel = -1; S.inspect = -1; S.swapSel = -1; S.curtain = null;
    for (const c2 of [BLACK, WHITE]) if (isCPU(c2)) S.setups[c2] = cpuSetup(seats[c2]);
    S.flip = S.mode === 'cpu' && seats[WHITE] === 'human';
    const first = [BLACK, WHITE].find(c2 => isHuman(c2));
    if (first == null) beginPlay();
    else beginSetup(first);
  }
  function beginSetup(c) {
    S.phase = 'setup'; S.drafting = c; S.swapSel = -1;
    S.draft = (store.get('last', null) && C.validSetup(store.get('last', null))) ? store.get('last', null).slice() : suggestSetup(0.7);
    if (S.mode === 'pvp') { S.curtain = `${MARK[c]}${SIDE[c]}の配置です。${SIDE[c ^ 1]}の人は見ないでください`; S.flip = c === WHITE; }
    afterChange();
  }
  function finishSetup() {
    if (S.phase !== 'setup' || !C.validSetup(S.draft)) return;
    const c = S.drafting;
    store.set('last', S.draft);
    if (S.mode === 'online') { onlineCommit(); return; }
    S.setups[c] = S.draft.slice();
    S.draft = null; S.drafting = -1;
    const next = [BLACK, WHITE].find(x => isHuman(x) && !S.setups[x]);
    if (next != null) { beginSetup(next); return; }
    beginPlay();
  }
  function beginPlay() {
    S.game = new C.Game(S.setups[BLACK], S.setups[WHITE]);
    S.phase = 'play'; S.drafting = -1; S.draft = null;
    if (S.mode === 'pvp') { S.curtain = `${MARK[0]}${SIDE[0]}の番です`; S.flip = false; }
    sfx('move');
    afterChange();
  }
  function rebuildGame(n) {
    const g = new C.Game(S.setups[BLACK], S.setups[WHITE]);
    for (let i = 0; i < n; i++) g.play((S.log[i].f << 6) | S.log[i].t);
    S.game = g; S.log = g.log; S.result = null; S.resultShown = false;
    if (S.evals.length > n + 1) S.evals.length = n + 1;
  }

  function saveGame() {
    if (S.mode === 'online') {
      const o = S.online;
      store.set('game', { mode: 'online', online: { mid: o.mid, me: o.me, opp: o.opp, myHints: o.myHints, setup: o.setup, salts: o.salts, rec: o.rec }, draft: S.draft, flip: S.flip });
      return;
    }
    store.set('game', { mode: S.mode, seats: S.seats, setups: S.setups, phase: S.phase, drafting: S.drafting, draft: S.draft, moves: S.log.map(e => (e.f << 6) | e.t), result: S.result, flip: S.flip, evals: S.evals });
  }
  function loadGame(g) {
    S.mode = g.mode; S.seats = g.seats; S.setups = g.setups; S.flip = !!g.flip; S.evals = g.evals || [];
    S.log = []; S.result = null; S.view = null; S.curtain = null;
    if (g.phase === 'setup') { S.phase = 'setup'; S.drafting = g.drafting; S.draft = g.draft; if (S.mode === 'pvp') S.curtain = `${MARK[g.drafting]}${SIDE[g.drafting]}の配置です`; afterChange(); return; }
    S.game = new C.Game(S.setups[0], S.setups[1]);
    for (const m of g.moves) S.game.play(m);
    S.log = S.game.log; S.phase = 'play';
    if (g.result) S.result = g.result;
    S.resultShown = !!S.result;
    if (S.mode === 'pvp' && !S.result) S.curtain = `${MARK[stm()]}${SIDE[stm()]}の番です`;
    afterChange();
  }

  // ------------------------------------------------------------------ 指す
  function legalNow() {
    if (S.phase !== 'play' || S.result || !live()) return [];
    if (S.mode === 'online') { const st = S.online.st; return st && st.need && st.need.kind === 'move' && st.need.who === S.online.me ? st.pos.gen(S.online.me) : []; }
    return S.game.legal();
  }
  const humanTurn = () => live() && S.phase === 'play' && !S.result && !S.curtain && isHuman(stm()) && (S.mode !== 'pvp' || S.pvpViewer === stm()) && (S.mode !== 'online' || legalNow().length > 0);
  let lastEventSeen = 0;
  function play(m) {
    if (S.mode === 'online') { onlineMove(m); return; }
    const ev = S.game.play(m);
    S.log = S.game.log;
    if (S.game.result) S.result = S.game.result;
    afterChange();
    if (S.mode === 'pvp' && !S.result) { const who = stm(); setTimeout(() => { if (S.mode === 'pvp' && stm() === who && !S.result) { S.curtain = `${MARK[who]}${SIDE[who]}の番です`; render(); } }, ev.r ? 1500 : 700); }
  }
  function afterChange() {
    S.sel = -1; S.targets = new Map(); S.inspect = -1;
    if (S.phase === 'play' && S.result) S.phase = 'over';
    if (S.mode !== 'online' && S.game && !S.result) { const ms = S.game.legal(); if (!ms.length) S.result = S.game.result || { winner: stm() ^ 1, reason: 'nomove' }; }
    if (S.result) S.phase = S.phase === 'setup' ? 'setup' : 'over';
    if (S.hintPly !== S.log.length) S.hint = -1;
    saveGame();
    const newEv = S.log.length > lastEventSeen && live() ? S.log[S.log.length - 1] : null;
    const from = newEv ? nodeRect(newEv.f) : null;
    lastEventSeen = S.log.length;
    render();
    if (newEv) presentEvent(newEv, from);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, newEv && newEv.r ? 1300 : 500); }
    schedule();
  }

  // 「新しい対局」を開いている間は裏の対局を進めない
  const choosing = () => !$('dlg-new').hidden;
  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (choosing()) { AIW.cancel(); return; }
    if (S.phase !== 'play' || S.result || !live() || S.curtain) { analyze(); return; }
    const c = stm();
    if (isRemote(c)) { analyze(); return; }
    if (!isCPU(c)) { analyze(); return; }
    AIW.cancel();
    const ply = S.log.length, t0 = Date.now(), lv = S.seats[c];
    S.thinking = true; renderPlayers();
    AIW.ask({ cmd: 'move', view: viewOf(c), level: lv }, r => {
      S.thinking = false;
      if (r.error || r.move == null || r.move < 0) { renderPlayers(); return; }
      const wait = Math.max(0, CPU[lv].ms - (Date.now() - t0));
      S.timer = setTimeout(() => { if (live() && S.log.length === ply && !S.result && !choosing() && S.phase === 'play') play(r.move); }, wait);
    });
  }
  // AI補助: 見ている人の立場で、勝率・候補手・相手の駒の推定
  function analyze() {
    const c = assistColor();
    if (c < 0 || !aiOn() || S.phase === 'setup' || S.curtain || (S.phase === 'over' && live())) { renderEval(); return; }
    const v = viewOf(c);
    if (!v) return;
    const ply = live() ? S.log.length : S.view;
    AIW.ask({ cmd: 'analyze', view: v, K: 48, marg: settings.showEval ? 300 : 0 }, r => {
      if (r.error) return;
      const cur = live() ? S.log.length : S.view;
      if (cur !== ply) return;
      const cands = r.moves.map((m, i) => ({ m, q: r.q[i] })).sort((a, b) => b.q - a.q);
      const stmNow = ply % 2;
      S.info = { ply, color: c, v: stmNow === c ? r.v : (cands.length ? r.v : r.v), win: (1 + (stmNow === c ? r.v : -r.v)) / 2, cands: stmNow === c ? cands : [], marg: r.marg };
      if (stmNow === c && cands.length) S.info.win = (1 + cands[0].q) / 2;
      S.evals[ply] = S.info.win;
      renderEval(); renderBoard(); renderArrows(); renderGraph(); renderEst();
    });
  }
  // AI補助を出す立場（人が1人ならその人、ふたりで交代なら今の番の人、観戦なら先手）
  function assistColor() {
    if (S.mode === 'online') return S.online.me;
    if (S.mode === 'watch') return BLACK;
    if (S.mode === 'pvp') return S.curtain ? -1 : S.phase === 'setup' ? S.drafting : S.pvpViewer;
    return humanColor();
  }

  // ------------------------------------------------------------------ 入力
  function onSquare(n) {
    hideMenus();
    if (S.curtain) return;
    if (S.phase === 'setup') { onSetupSquare(n); return; }
    if (!live()) return;
    const pos = dispPos();
    if (S.sel >= 0 && S.targets.has(n)) { const m = S.targets.get(n); S.sel = -1; S.targets = new Map(); play(m); return; }
    const id = pos.sq[n];
    if (id >= 0 && humanTurn() && C.owner(id) === stm()) {
      if (S.sel === n) { clearSel(); return; }
      const ms = legalNow().filter(m => (m >> 6) === n);
      S.sel = n; S.inspect = -1; S.targets = new Map(ms.map(m => [m & 63, m]));
      renderBoard(); renderSqInfo(); return;
    }
    if (id >= 0) { S.sel = -1; S.targets = new Map(); S.inspect = S.inspect === n ? -1 : n; renderBoard(); renderSqInfo(); return; }
    clearSel();
  }
  function clearSel() { S.sel = -1; S.targets = new Map(); S.inspect = -1; renderBoard(); renderSqInfo(); }
  // 配置: 2つの駒をタップして入れ替え
  function canSwap(a, b) {
    const c = S.drafting, ka = C.KOF[c][a], kb = C.KOF[c][b];
    if (ka < 0 || kb < 0) return false;
    return C.placeOK(S.draft[ka], kb) && C.placeOK(S.draft[kb], ka);
  }
  function onSetupSquare(n) {
    const c = S.drafting;
    if (c < 0 || !S.draft || (S.mode === 'online' && S.online.rec[S.online.me].cm)) return;
    const k = C.KOF[c][n];
    if (k < 0) { S.swapSel = -1; S.inspect = dispPos().sq[n] >= 0 ? n : -1; renderBoard(); renderSqInfo(); return; }
    if (S.swapSel < 0) { S.swapSel = n; S.inspect = -1; renderBoard(); renderSqInfo(); return; }
    if (S.swapSel === n) { S.swapSel = -1; renderBoard(); renderSqInfo(); return; }
    doSwap(S.swapSel, n);
  }
  let setupMsg = '';
  function doSwap(a, b) {
    const c = S.drafting, ka = C.KOF[c][a], kb = C.KOF[c][b];
    if (!canSwap(a, b)) {
      const bad = !C.placeOK(S.draft[ka], kb) ? S.draft[ka] : S.draft[kb];
      setupMsg = bad === GUNKI ? '軍旗は突入口と一番奥の列には置けません' : '地雷は突入口には置けません';
      S.swapSel = -1; renderBoard(); renderSqInfo(); return;
    }
    const t = S.draft[ka]; S.draft[ka] = S.draft[kb]; S.draft[kb] = t;
    setupMsg = ''; S.swapSel = -1; sfx('move'); saveGame(); renderBoard(); renderSqInfo();
  }
  function applyPreset(p) {
    if (S.phase !== 'setup' || (S.mode === 'online' && S.online.rec[S.online.me].cm)) return;
    const s = p === 'ai' ? suggestSetup(0.7) : p === 'random' ? C.randomSetup() : p === 'last' ? store.get('last', null) : PRESETS[p];
    if (!s || !C.validSetup(s)) return;
    S.draft = s.slice(); S.swapSel = -1; setupMsg = ''; sfx('move'); saveGame(); render();
  }

  // ------------------------------------------------------------------ 描画
  let gridBuilt = false;
  const nodeEl = new Map();
  function buildGrid() {
    const g = $('grid');
    g.innerHTML = '<div class="river"><div class="bridge" style="left:calc(100%/6*1)"></div><div class="bridge" style="left:calc(100%/6*4)"></div></div>';
    for (const n of C.NODES) {
      const b = document.createElement('button');
      b.className = 'sq'; b.type = 'button'; b.dataset.n = n;
      g.appendChild(b); nodeEl.set(n, b);
    }
    gridBuilt = true;
  }
  function placeNodes() {
    for (const [n, b] of nodeEl) {
      let x = C.X(n), y = C.Y(n);
      if (S.flip) { x = 5 - x; y = 7 - y; }
      const hq = n === 44 || n === 2;
      if (hq) x = 2;
      b.style.gridColumn = `${x + 1} / span ${hq ? 2 : 1}`;
      b.style.gridRow = String(y < 4 ? y + 1 : y + 2);
    }
    $('coords-top').innerHTML = [0, 1, 2, 3, 4, 5].map(i => `<span>${'ABCDEF'[S.flip ? 5 - i : i]}</span>`).join('');
    $('coords-right').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map(i => `<span>${S.flip ? i + 1 : 8 - i}</span>`).join('').replace(/(<span>[^<]*<\/span>){4}/, m => m + '<span></span>');
  }
  const SHAPE = 'M50 3 Q52 3 54 3.8 L81 15 Q84.5 16.6 85 20 L93.5 101 Q94 106 89 106 L11 106 Q6 106 6.5 101 L15 20 Q15.5 16.6 19 15 L46 3.8 Q48 3 50 3Z';
  // 駒の絵。type < 0 なら裏（字なし）
  function pieceSVG(type, side, down) {
    const fill = side === BLACK ? 'url(#g-b)' : 'url(#g-w)', edge = side === BLACK ? 'var(--pc-b-edge)' : 'var(--pc-w-edge)', ink = side === BLACK ? 'var(--pc-b-ink)' : 'var(--pc-w-ink)';
    let inner = '';
    if (type >= 0) {
      const ch = [...NAMES[type]], fs = ch.length > 2 ? 25 : 33, ys = ch.length > 2 ? [41, 66, 91] : [50, 84];
      inner = ch.map((x, i) => `<text class="ch" x="50" y="${ys[i]}" font-size="${fs}" fill="${ink}">${x}</text>`).join('');
    } else {
      inner = `<circle cx="50" cy="62" r="19" fill="none" stroke="${ink}" stroke-width="2.4" opacity=".55"/><path d="M50 47 l4.4 9.2 10.1 1.3 -7.4 7 1.9 10 -9-4.9 -9 4.9 1.9-10 -7.4-7 10.1-1.3z" fill="${ink}" opacity=".55"/>`;
    }
    return `<svg viewBox="0 0 100 110" aria-hidden="true" focusable="false"><g${down ? ' transform="rotate(180 50 55)"' : ''}><path d="${SHAPE}" fill="${fill}" stroke="${edge}" stroke-width="2" stroke-linejoin="round"/><path d="M22 28 Q50 35 78 26 M16 64 Q50 58 84 66" fill="none" stroke="${edge}" stroke-width="1" opacity=".25"/>${inner}</g></svg>`;
  }
  const bottomColor = () => (S.flip ? WHITE : BLACK);
  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    document.body.classList.toggle('setup-phase', S.phase === 'setup');
    renderPlayers(); renderBoard(); renderSqInfo(); renderControls(); renderTape(); renderEval(); renderGraph(); renderEst(); renderKifu(); renderArrows();
    fitBoardSoon();
  }
  function renderBoard() {
    if (!gridBuilt) buildGrid();
    placeNodes();
    const pos = dispPos(), v = viewer(), bot = bottomColor();
    const last = S.log.length && (live() ? S.log.length : S.view) > 0 ? S.log[(live() ? S.log.length : S.view) - 1] : null;
    const marg = S.info && settings.showEval && settings.guess && S.info.ply === (live() ? S.log.length : S.view) ? S.info.marg : null;
    const ac = assistColor();
    const settingUp = S.phase === 'setup' && S.drafting >= 0 && !(S.mode === 'online' && S.online.rec[S.online.me].cm);
    for (const [n, b] of nodeEl) {
      const id = pos.sq[n];
      const cls = ['sq'];
      if (C.X(n) === 1 && (C.Y(n) === 3 || C.Y(n) === 4) || C.X(n) === 4 && (C.Y(n) === 3 || C.Y(n) === 4)) cls.push('entry');
      if (n === 44 || n === 2) cls.push('hq');
      if (last && last.f === n) cls.push('from');
      if (last && last.t === n) cls.push('last');
      if (S.sel === n || S.swapSel === n) cls.push('selected');
      if (S.inspect === n) cls.push('inspect');
      b.className = cls.join(' ');
      let html = (n === 44 || n === 2) ? '<span class="hqlab">司令部</span>' : '';
      let label = C.sqName(n);
      if (id >= 0) {
        const side = C.owner(id), ty = pos.type[id], down = side !== bot;
        let extra = '';
        if (ty < 0) {
          label += ` ${SIDE[side]}の駒`;
          if (settings.marks) { const fl = pos.fl[id]; if (fl & C.MOVED) extra += '<i class="pm mv"></i>'; if (fl & C.WON) extra += '<i class="pm won"></i>'; }
          if (marg && side === (ac ^ 1)) {
            const j = id % NP; let bt = 0, bp = 0;
            for (let t = 0; t < NT; t++) if (marg[j * NT + t] > bp) { bp = marg[j * NT + t]; bt = t; }
            if (bp >= 0.3) extra += `<span class="guess">${SHORT[bt]}<small>${Math.round(bp * 100)}%</small></span>`;
          }
        } else label += ` ${SIDE[side]}の${NAMES[ty]}`;
        const rev = ty >= 0 && v === -1 && S.phase === 'over' && humanColor() >= 0 && side !== humanColor();
        html += `<span class="pc side-${side ? 'w' : 'b'}${rev ? ' revealed' : ''}">${pieceSVG(ty, side, down)}${extra}</span>`;
      }
      // 行き先の印・暗くする
      if (S.sel >= 0) {
        if (S.targets.has(n)) html += `<span class="mark ${id >= 0 ? 'cap' : 'move'}"></span>`;
        else if (n !== S.sel) html += '<span class="mark dim"></span>';
      } else if (settingUp && S.swapSel >= 0 && n !== S.swapSel) {
        if (C.KOF[S.drafting][n] >= 0) { if (!canSwap(S.swapSel, n)) html += '<span class="mark dim"></span>'; else html += '<span class="mark swap"></span>'; }
        else html += '<span class="mark dim"></span>';
      } else if (settingUp && C.KOF[S.drafting][n] < 0) html += '<span class="mark dim"></span>';
      if (S.hint >= 0 && live() && S.hintPly === S.log.length && ((S.hint >> 6) === n || (S.hint & 63) === n)) html += '<span class="mark hint"></span>';
      if (S.mode === 'online' && S.online.pend && S.online.pend.t === n) html += '<span class="mark pend"></span>';
      if (b._html !== html) { b.innerHTML = html; b._html = html; }
      b.setAttribute('aria-label', label);
    }
    $('curtain').hidden = !S.curtain;
    if (S.curtain) $('curtain').innerHTML = `<div><b>${esc(S.curtain)}</b>準備ができたらタップしてください</div>`;
  }
  function nodeRect(n) { const b = nodeEl.get(n); return b ? b.getBoundingClientRect() : null; }

  function renderPlayers() {
    const pos = C.replay([trueSetup(0) && viewer() !== -2 && (viewer() === 0 || viewer() === -1) ? trueSetup(0) : null, trueSetup(1) && viewer() !== -2 && (viewer() === 1 || viewer() === -1) ? trueSetup(1) : null], S.log, live() ? S.log.length : S.view);
    const card = (el, c) => {
      const name = seatName(c);
      const turn = S.phase === 'play' && !S.result && stm() === c && live();
      el.classList.toggle('turn', turn);
      const alive = pos.alive(c);
      // 失った駒: 自分の駒（見てよいもの）だけ種類を出す
      let lost = '';
      const st = pos.type[c * NP] >= 0 || (pos.type.slice(c * NP, c * NP + NP).some(x => x >= 0));
      if (st) { const L = []; for (let k = 0; k < NP; k++) { const id = c * NP + k; if (pos.at[id] < 0 && pos.type[id] >= 0) L.push(pos.type[id]); } L.sort((a, b) => a - b); lost = L.map(t => `<span class="mini ${c ? 'w' : 'b'} x" title="${NAMES[t]}">${SHORT[t].slice(0, 2)}</span>`).join(''); }
      const think = S.thinking && stm() === c ? '<span class="think"><i></i>考え中</span>' : '';
      const on = S.mode === 'online' && c !== S.online.me ? aiTagHTML(S.online.opp.ai, S.online.opp.hints) + (S.online.oppPresent === false && !S.result ? '<span class="aitag on" title="相手の接続が切れています">切断中</span>' : '') : S.mode === 'online' ? aiTagHTML(aiFlags(), S.online.myHints) : '';
      el.innerHTML = `<span class="mk ${c ? 'w' : 'b'}">${MARK[c]}</span><span class="name">${name}</span>${on}${think}<span class="st"><span class="lost">${lost}</span><span>残り <b>${alive}</b></span></span>`;
    };
    card($('player-top'), bottomColor() ^ 1);
    card($('player-bottom'), bottomColor());
  }
  function seatName(c) {
    if (S.mode === 'online') return c === S.online.me ? `${esc(myName)}（あなた）` : `${esc(S.online.opp.name)}さん`;
    if (isCPU(c)) return `CPU（${CPU[S.seats[c]].label}）`;
    if (S.mode === 'pvp') return `${SIDE[c]}`;
    return S.mode === 'watch' ? SIDE[c] : 'あなた';
  }

  function moveText(e, i) {
    const mover = i % 2, r = ['', '勝', '負', '相打'][e.r];
    return { t: `${MARK[mover]}${C.sqName(e.f).replace(/^[▲△]/, '')}→${C.sqName(e.t).replace(/^[▲△]/, '')}`, r };
  }
  // 直前の戦いの説明（見ている人の立場で。相手の駒の種類は言わない）
  function describe(e, i) {
    const p = C.replay(visSetups(), S.log, i), a = p.sq[e.f], d = p.sq[e.t], mover = C.owner(a), v = viewer();
    const ta = p.type[a], td = d >= 0 ? p.type[d] : -1;
    const nm = (t, c) => (t >= 0 ? NAMES[t] : `${SIDE[c]}の駒`);
    if (!e.r) {
      if (e.t === HQ[mover ^ 1]) return `${MARK[mover]}${nm(ta, mover)}が相手の司令部に入りました（少佐以上ではないので占領になりません）`;
      return `${MARK[mover]}${nm(ta, mover)}が ${C.sqName(e.t)} へ`;
    }
    if (v === mover) return `${NAMES[ta]}で攻撃 → ${['', '勝ち（相手の駒を取りました）', `負け（${NAMES[ta]}を失いました）`, '相打ち（両方とも取り除かれました）'][e.r]}`;
    if (v === (mover ^ 1)) return `相手の駒があなたの${NAMES[td]}を攻撃 → ${['', `${NAMES[td]}が取られました`, `${NAMES[td]}の勝ち`, '相打ち（両方とも取り除かれました）'][e.r]}`;
    return `${MARK[mover]}${nm(ta, mover)} × ${MARK[mover ^ 1]}${nm(td, mover ^ 1)} → ${['', `${MARK[mover]}の勝ち`, `${MARK[mover ^ 1]}の勝ち`, '相打ち'][e.r]}`;
  }
  const REASON = {
    hq: w => `${SIDE[w]}が相手の司令部を占領しました`, nomove: w => `${SIDE[w ^ 1]}に動かせる駒がなくなりました`, resign: w => `${SIDE[w ^ 1]}が投了しました`,
    quiet: () => `戦いのないまま${C.QUIET_MAX}手が過ぎたので引き分け`, maxply: () => `${C.MAX_PLY}手に達したので引き分け`, invalid: w => `${SIDE[w ^ 1]}の記録が約束と合いませんでした`,
  };
  function renderSqInfo() {
    const el = $('sqinfo');
    let cls = '', txt = '', tools = '';
    const btn = (act, label, p) => `<button class="btn small${p ? ' primary' : ''}" data-act="${act}">${label}</button>`;
    if (S.phase === 'setup') {
      cls = 'setup';
      const o = S.online;
      if (S.mode === 'online' && o.rec[o.me].cm) txt = `配置を約束しました（指紋 ${PR.fingerprint(o.rec[o.me].cm)}）。${o.rec[o.me ^ 1].cm ? '' : '相手の配置を待っています…'}`;
      else if (setupMsg) { cls = 'alert'; txt = setupMsg; }
      else if (S.swapSel >= 0) { const k = C.KOF[S.drafting][S.swapSel]; txt = `${NAMES[S.draft[k]]}を選びました。入れ替える駒をタップ`; }
      else if (S.inspect >= 0) txt = '相手の陣地です（相手の駒は見えません）';
      else txt = `${S.mode === 'pvp' ? MARK[S.drafting] + SIDE[S.drafting] + '：' : ''}配置: 2つの駒をタップ（ドラッグでも）で入れ替え`;
      if (!(S.mode === 'online' && o.rec[o.me].cm)) tools = btn('setup-done', '配置完了', true);
    } else if (!live()) {
      cls = 'view';
      txt = `${S.view}手目の局面を見ています`;
      tools = btn('live', '最新へ');
    } else if (S.result) {
      cls = 'result';
      const r = S.result, hc = humanColor();
      txt = r.winner < 0 ? `引き分け — ${REASON[r.reason] ? REASON[r.reason](r.winner) : ''}` : `${hc >= 0 ? (r.winner === hc ? 'あなたの勝ち' : 'あなたの負け') : SIDE[r.winner] + 'の勝ち'} — ${REASON[r.reason] ? REASON[r.reason](r.winner) : ''}`;
      tools = btn('again', 'もう一局', true);
    } else if (S.sel >= 0) {
      const p = dispPos(), t = p.type[p.sq[S.sel]];
      txt = `${NAMES[t]} — ${MOVE_TEXT[t]}`;
    } else if (S.inspect >= 0) {
      const p = dispPos(), id = p.sq[S.inspect];
      if (id >= 0 && p.type[id] >= 0) txt = `${SIDE[C.owner(id)]}の${NAMES[p.type[id]]} — ${MOVE_TEXT[p.type[id]]}`;
      else if (id >= 0) {
        const fl = p.fl[id], facts = [];
        if (fl & C.MOVED) facts.push('動いた（地雷・軍旗ではない）');
        if (fl & C.WON) facts.push('戦って勝ち残った');
        const marg = S.info && settings.showEval && S.info.ply === (live() ? S.log.length : S.view) ? S.info.marg : null;
        if (marg) {
          const j = id % NP, L = [];
          for (let t = 0; t < NT; t++) if (marg[j * NT + t] >= 0.05) L.push([t, marg[j * NT + t]]);
          L.sort((a, b) => b[1] - a[1]);
          txt = `<span class="gs">${L.slice(0, 4).map(([t, p2]) => `<span><b>${SHORT[t]}</b> ${Math.round(p2 * 100)}%</span>`).join('')}</span>`;
        } else txt = `相手の駒 — ${facts.length ? facts.join('・') : 'まだ動いていない'}`;
      }
    } else if (S.mode === 'online' && S.online.err) { cls = 'alert'; txt = S.online.err; }
    else if (S.mode === 'online' && S.online.st && S.online.st.need && S.online.st.need.kind === 'reveal') txt = '審判中…（相手の端末の返事を待っています）';
    else if (S.log.length) {
      const e = S.log[S.log.length - 1];
      txt = describe(e, S.log.length - 1);
      if (e.r) cls = '';
      if (S.mode === 'online' && S.online.oppPresent === false) { cls = 'alert'; txt = '相手の接続が切れています（戻ってくるのを待っています）'; }
      else if (humanTurn()) txt = `あなたの番 — ${txt}`;
    } else txt = humanTurn() ? 'あなたの番です（先手）。前の駒で相手を攻めるか、飛行機で飛び込みます' : isCPU(stm()) ? 'CPU の番です' : S.mode === 'online' ? '相手の番です' : '';
    el.className = 'sqinfo' + (cls ? ' ' + cls : '');
    el.innerHTML = `<span class="txt">${txt}</span><span class="tools">${tools}</span>`;
  }
  const MOVE_TEXT = [];
  for (let t = 0; t <= C.SHOI; t++) MOVE_TEXT[t] = '縦横に1マス';
  MOVE_TEXT[C.HIKO] = '縦にどこまでも（駒を飛び越える）・横に1マス';
  MOVE_TEXT[C.TANK] = MOVE_TEXT[C.KIHEI] = '縦横に1マス・前へ2マス';
  MOVE_TEXT[C.KOHEI] = '縦横にどこまでも（飛び越えない）';
  MOVE_TEXT[C.SPY] = '縦横に1マス';
  MOVE_TEXT[C.JIRAI] = MOVE_TEXT[C.GUNKI] = '動けない';

  function renderControls() {
    const el = $('controls');
    const b = (id, label, cls, attrs) => `<button class="btn${cls ? ' ' + cls : ''}" data-act="${id}"${attrs || ''}>${label}</button>`;
    let html;
    const setupLocked = S.mode === 'online' && S.online && S.online.rec[S.online.me].cm;
    if (S.phase === 'setup') {
      html = b('new', '新しい対局', setupLocked ? 'primary' : '') + b('preset-ai', 'AIのおすすめ', '', setupLocked ? ' disabled' : '') + b('preset-random', 'ランダム', 'wide', setupLocked ? ' disabled' : '') +
        `<div class="more-wrap">${b('more', '⋯', '', ' aria-label="そのほかの並べ方" aria-expanded="false"')}<div class="menu" id="menu-more" hidden role="menu">` +
        `<button data-act="preset-attack" role="menuitem">攻めの形</button><button data-act="preset-defense" role="menuitem">守りの形</button><button data-act="preset-random" role="menuitem">ランダム</button><button data-act="preset-last" role="menuitem"${store.get('last', null) ? '' : ' disabled'}>前回の配置</button></div></div>`;
    } else {
      const canUndo = S.mode === 'cpu' && S.log.length > 0 && !(S.mode === 'online');
      html = b('new', '新しい対局', 'primary') + (S.mode === 'cpu' ? b('undo', '待った', '', canUndo ? '' : ' disabled') : '') + b('hint', 'ヒント', '', humanTurn() ? '' : ' disabled') +
        `<button class="btn aibtn" data-act="ai" aria-pressed="${aiOn()}" title="形勢（勝率）・相手の駒の推定・最善手の矢印をまとめて出し入れ"><span class="led"></span>AI補助</button>` +
        `<div class="more-wrap">${b('more', '⋯', '', ' aria-label="そのほかの操作" aria-expanded="false"')}<div class="menu" id="menu-more" hidden role="menu">` +
        `<button data-act="flip" role="menuitem">盤を反転</button><button data-act="resign" role="menuitem"${S.phase === 'play' && !S.result && humanColor() >= 0 || S.mode === 'pvp' && S.phase === 'play' ? '' : ' disabled'}>投了する</button><button data-act="panel" role="menuitem">形勢・相手の駒・棋譜</button></div></div>`;
    }
    el.innerHTML = html;
  }
  function renderTape() {
    const el = $('tape');
    const cur = live() ? S.log.length : S.view;
    el.innerHTML = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span>開始</button>` + S.log.map((e, i) => { const x = moveText(e, i); return `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span>${x.t}${x.r ? `<span class="r">${x.r}</span>` : ''}</button>`; }).join('');
    const c = el.querySelector('.cur');
    if (c) el.scrollLeft = c.offsetLeft - el.clientWidth / 2 + c.clientWidth / 2;
    document.querySelectorAll('.navrow [data-nav]').forEach(bt => {
      const k = bt.dataset.nav;
      if (k === 'first' || k === 'prev') bt.disabled = cur === 0;
      if (k === 'next' || k === 'last') bt.disabled = live();
    });
  }
  function renderKifu() {
    const cur = live() ? S.log.length : S.view;
    $('kifu').innerHTML = S.log.map((e, i) => { const x = moveText(e, i); return `<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span>${x.t}</span><span class="r">${x.r}</span></li>`; }).join('');
    $('kifu-info').textContent = `${S.log.length}手`;
    $('viewing').hidden = live();
    if (!live()) $('viewing-text').textContent = `${S.view}手目を表示中`;
  }
  function renderEval() {
    const I = S.info, cur = live() ? S.log.length : S.view;
    const ok = I && I.ply === cur && aiOn();
    const win = ok ? I.win : null;
    $('ev-num').textContent = win == null ? '—' : `${Math.round(win * 100)}%`;
    $('ev-label').textContent = win == null ? (aiOn() ? '' : 'AI補助はオフです') : `${assistColor() >= 0 ? (assistColor() === humanColor() || S.mode === 'pvp' ? 'あなた' : SIDE[assistColor()]) : ''}の勝率`;
    $('ev-who').textContent = assistColor() >= 0 ? `${MARK[assistColor()]}${SIDE[assistColor()]}から見て` : '';
    $('wr-b').style.width = `${win == null ? 50 : win * 100}%`;
    $('evs-b').style.width = `${win == null ? 50 : win * 100}%`;
    $('evs-num').textContent = win == null ? '—' : `${Math.round(win * 100)}%`;
    const best = ok && I.cands.length ? I.cands[0] : null;
    $('evs-best').textContent = best && settings.arrow ? `最善 ${moveText({ f: best.m >> 6, t: best.m & 63, r: 0 }, cur).t}` : '';
    $('cands').innerHTML = ok && settings.arrow ? I.cands.slice(0, 4).map((c2, i) => `<li><span>${i ? '' : '<b>最善</b>'}</span><span>${moveText({ f: c2.m >> 6, t: c2.m & 63, r: 0 }, cur).t}</span><span>${Math.round((1 + c2.q) * 50)}%</span></li>`).join('') : '';
    $('ev-meta').textContent = ok ? '相手の駒の正体を48通り推理して、学習した評価で読みました' : '';
  }
  function renderGraph() {
    const g = $('graph'), n = S.log.length, pts = [];
    for (let i = 0; i <= n; i++) if (S.evals[i] != null) pts.push([i, S.evals[i]]);
    $('graph-who').textContent = assistColor() >= 0 ? `${SIDE[assistColor()]}の勝率` : '';
    if (pts.length < 2) { g.innerHTML = '<line class="mid" x1="0" y1="55" x2="300" y2="55"/>'; return; }
    const X = i => (i / Math.max(1, n)) * 300, Y = p => 105 - p * 100;
    const line = pts.map(([i, p], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p).toFixed(1)}`).join(' ');
    const cur = live() ? n : S.view;
    g.innerHTML = `<path class="area" d="${line} L${X(pts[pts.length - 1][0]).toFixed(1)} 105 L${X(pts[0][0]).toFixed(1)} 105Z"/><line class="mid" x1="0" y1="55" x2="300" y2="55"/><path class="line" d="${line}"/><line class="now" x1="${X(cur)}" y1="0" x2="${X(cur)}" y2="110"/>`;
  }
  // 相手の駒の内訳: 最初の数・取られたとわかっている数・推定で残っている数
  function renderEst() {
    const el = $('est'), ac = assistColor();
    if (ac < 0 || S.phase === 'setup') { el.innerHTML = '<p class="hint">対局が始まると出ます</p>'; return; }
    const op = ac ^ 1, pos = C.replay([ac === 0 ? trueSetup(0) : null, ac === 1 ? trueSetup(1) : null], S.log, live() ? S.log.length : S.view);
    const marg = S.info && S.info.ply === (live() ? S.log.length : S.view) ? S.info.marg : null;
    const aliveExp = new Float64Array(NT);
    let deadN = 0;
    for (let k = 0; k < NP; k++) { const id = op * NP + k; if (pos.at[id] < 0) deadN++; else if (marg) for (let t = 0; t < NT; t++) aliveExp[t] += marg[k * NT + t]; }
    $('est-who').textContent = `残り ${NP - deadN}枚`;
    el.innerHTML = `<table class="est"><thead><tr><th>駒</th><th>最初</th><th>残りの見込み</th></tr></thead><tbody>${NAMES.map((nm, t) => `<tr><td>${nm}</td><td>${C.COUNTS[t]}</td><td>${marg ? `<span class="bar" style="width:${Math.round(aliveExp[t] / C.COUNTS[t] * 40)}px"></span>${aliveExp[t].toFixed(1)}` : '—'}</td></tr>`).join('')}</tbody></table><p class="hint" style="margin:6px 0 0">${marg ? 'AI が、公開された動きと戦いの結果だけから推理した数です（相手の駒は見ていません）' : 'AI補助をオンにすると推定が出ます'}</p>`;
  }
  function renderArrows() {
    const svg = $('arrows');
    const I = S.info, cur = live() ? S.log.length : S.view;
    let m = -1;
    if (S.hint >= 0 && S.hintPly === S.log.length && live()) m = S.hint;
    else if (settings.arrow && I && I.ply === cur && I.cands.length && live() && humanTurn()) m = I.cands[0].m;
    if (m < 0 || S.phase !== 'play') { svg.innerHTML = ''; return; }
    const fr = $('board-frame').getBoundingClientRect(), a = nodeRect(m >> 6), b = nodeRect(m & 63);
    if (!a || !b) return;
    const ax = a.left + a.width / 2 - fr.left, ay = a.top + a.height / 2 - fr.top, bx = b.left + b.width / 2 - fr.left, by = b.top + b.height / 2 - fr.top;
    const ang = Math.atan2(by - ay, bx - ax), len = Math.hypot(bx - ax, by - ay) - 10, w = Math.max(4, a.width * 0.1);
    svg.setAttribute('viewBox', `0 0 ${fr.width} ${fr.height}`);
    svg.innerHTML = `<g transform="translate(${ax} ${ay}) rotate(${ang * 180 / Math.PI})"><rect class="ar" x="0" y="${-w / 2}" width="${Math.max(0, len - w * 2)}" height="${w}" rx="${w / 2}"/><path class="ar" d="M${len} 0 L${len - w * 2.6} ${-w * 1.7} L${len - w * 2.6} ${w * 1.7}Z"/></g>`;
  }

  // 戦いの判定（はんこ）と駒の動き
  function presentEvent(e, fromRect) {
    if (e.r) sfx('battle'); else sfx('move');
    const to = nodeRect(e.t), wrap = $('board-wrap').getBoundingClientRect();
    if (settings.anim && !reduceMotion && fromRect && (e.r === 0 || e.r === 1)) {
      const b = nodeEl.get(e.t), pc = b && b.querySelector('.pc');
      if (pc) {
        const r = pc.getBoundingClientRect();
        const dx = (fromRect.left + fromRect.width / 2) - (r.left + r.width / 2), dy = (fromRect.top + fromRect.height / 2) - (r.top + r.height / 2);
        b.classList.add('moving');
        pc.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => b.classList.remove('moving');
      }
    }
    if (!e.r || !to) return;
    const v = viewer(), mover = (S.log.length - 1) % 2;
    let txt, cls;
    if (v === mover) { txt = ['', '勝', '負', '相打'][e.r]; cls = ['', '', 'lose', 'tie'][e.r]; }
    else if (v === (mover ^ 1)) { txt = ['', '負', '勝', '相打'][e.r]; cls = ['', 'lose', '', 'tie'][e.r]; }
    else { txt = e.r === 3 ? '相打' : `${MARK[e.r === 1 ? mover : mover ^ 1]}勝`; cls = e.r === 3 ? 'tie' : ''; }
    const s = document.createElement('div');
    s.className = 'stamp' + (cls ? ' ' + cls : '');
    s.textContent = txt;
    s.style.left = `${to.left + to.width / 2 - wrap.left}px`; s.style.top = `${to.top + to.height / 2 - wrap.top}px`;
    $('board-wrap').appendChild(s);
    setTimeout(() => s.remove(), 1700);
  }

  // 盤の大きさ: 盤・情報の行・手番の札・ボタンが画面の高さに収まるように
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  function fitBoard() {
    const col = document.querySelector('.board-col'), wrap = $('board-wrap'), frame = $('board-frame');
    if (!col || !col.offsetParent) return;
    const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
    let other = 0, n = 0;
    const side = window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches; // 横向きのスマホでは盤の横に並ぶ
    if (!side) for (const el of col.children) { if (el === wrap || getComputedStyle(el).display === 'none') continue; other += el.getBoundingClientRect().height; n++; }
    const top = col.getBoundingClientRect().top + window.scrollY;
    const fcs = getComputedStyle(frame), padV = parseFloat(fcs.paddingTop) + parseFloat(fcs.paddingBottom), padH = parseFloat(fcs.paddingLeft) + parseFloat(fcs.paddingRight);
    const avail = window.innerHeight - top - other - gap * n - 12;
    const gridW = (avail - padV - 4) * 6 / 8.46;
    const w = Math.round(Math.max(240, Math.min(560, gridW + padH + 4)));
    if (document.documentElement.style.getPropertyValue('--board-w') !== w + 'px') { document.documentElement.style.setProperty('--board-w', w + 'px'); renderArrows(); }
  }

  // ------------------------------------------------------------------ 配置のドラッグ
  let drag = null;
  function bindDrag() {
    const g = $('grid');
    g.addEventListener('pointerdown', e => {
      const b = e.target.closest('.sq');
      if (!b || S.phase !== 'setup' || S.drafting < 0 || S.curtain || (S.mode === 'online' && S.online.rec[S.online.me].cm)) return;
      const n = +b.dataset.n;
      if (C.KOF[S.drafting][n] < 0) return;
      drag = { n, x: e.clientX, y: e.clientY, on: false, ghost: null, id: e.pointerId };
    });
    window.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) {
        drag.on = true;
        const pc = nodeEl.get(drag.n).querySelector('.pc');
        if (pc) { const r = pc.getBoundingClientRect(); const gh = pc.cloneNode(true); gh.classList.add('drag-ghost'); gh.style.width = r.width + 'px'; gh.style.height = r.height + 'px'; document.body.appendChild(gh); drag.ghost = gh; }
        S.swapSel = drag.n; renderBoard();
      }
      if (drag.on && drag.ghost) { drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px'; }
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (d.ghost) d.ghost.remove();
      if (!d.on) return;
      d.cancelClick = true; suppressClick = Date.now();
      const el = document.elementFromPoint(e.clientX, e.clientY), b = el && el.closest && el.closest('.sq');
      const n = b ? +b.dataset.n : -1;
      if (n >= 0 && n !== d.n && C.KOF[S.drafting][n] >= 0) doSwap(d.n, n);
      else { S.swapSel = -1; renderBoard(); renderSqInfo(); }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', e => { if (drag && drag.ghost) drag.ghost.remove(); drag = null; });
  }
  let suppressClick = 0;

  // ------------------------------------------------------------------ 操作
  function viewPly(p) {
    p = Math.max(0, Math.min(S.log.length, p));
    S.view = p >= S.log.length ? null : p;
    S.sel = -1; S.inspect = -1;
    render(); schedule();
  }
  function undo() {
    if (S.mode !== 'cpu' || !S.log.length) return;
    AIW.cancel(); clearTimeout(S.timer);
    const h = humanColor();
    let n = S.log.length - 1;
    while (n > 0 && n % 2 !== h) n--;
    if (n % 2 !== h) return;
    rebuildGame(n);
    S.view = null; S.phase = 'play'; lastEventSeen = S.log.length;
    afterChange();
  }
  function resign() {
    if (S.phase !== 'play' || S.result) return;
    if (S.mode === 'online') { onlineResign(); return; }
    const c = S.mode === 'pvp' ? stm() : humanColor();
    if (c < 0) return;
    S.result = { winner: c ^ 1, reason: 'resign' };
    afterChange();
  }
  function hint() {
    if (!humanTurn()) return;
    const c = stm(), ply = S.log.length;
    if (S.mode === 'online') { S.online.myHints++; NET && NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
    AIW.ask({ cmd: 'analyze', view: viewOf(c), K: 48, marg: 0 }, r => {
      if (r.error || S.log.length !== ply || !r.moves.length) return;
      let bi = 0; r.q.forEach((q, i) => { if (q > r.q[bi]) bi = i; });
      S.hint = r.moves[bi]; S.hintPly = ply;
      renderBoard(); renderArrows();
      $('sqinfo').querySelector('.txt').textContent = `ヒント: ${moveText({ f: S.hint >> 6, t: S.hint & 63, r: 0 }, ply).t}`;
    });
  }
  function showResult() {
    const r = S.result;
    if (!r) return;
    const hc = humanColor();
    let title = r.winner < 0 ? '引き分け' : `${SIDE[r.winner]}の勝ち`;
    if (hc >= 0 && r.winner >= 0) title = r.winner === hc ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${S.log.length}手${S.mode === 'online' ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.mode === 'online' ? `相手は ${S.online.opp.name} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : S.mode === 'cpu' ? `相手は CPU（${CPU[S.seats[hc ^ 1]].label}）でした。` : '';
    $('rs-body').textContent = `${REASON[r.reason] ? REASON[r.reason](r.winner) : ''}。${opp}「盤を見返す」で両方の配置を確かめられます。`;
    renderVerify();
    $('rs-again').textContent = S.mode === 'online' ? 'もう一局（先後交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }
  function renderVerify() {
    const el = $('rs-verify');
    if (S.mode !== 'online') { el.hidden = true; return; }
    const v = S.online.verify;
    el.hidden = false;
    el.className = 'verify' + (v && v.ok === true ? ' ok' : v && v.ok === false ? ' ng' : '');
    el.textContent = !v || v.ok == null ? '検証: 相手の配置の公開を待っています…' : v.ok ? `✓ 検証済み: ${v.msg}` : `✗ 検証できませんでした: ${v.msg}`;
  }

  // ------------------------------------------------------------------ 新しい対局
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    schedule();
    $('ng-start').focus();
  }
  function closeNew() { $('dlg-new').hidden = true; schedule(); }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで（交代で）'], ['watch', 'CPUどうしを観戦'], ['online', 'オンライン対戦']], draft.mode);
    $('ng-mode-hint').textContent = draft.mode === 'pvp' ? '1台の端末を交代で使います。番が変わるたびに目隠しが出ます' : draft.mode === 'watch' ? '観戦では両方の駒が見えます' : '';
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(CPU_KEYS.length - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small><i class="tm">${['すぐ', '1秒', '1秒', '1秒', '数秒'][CPU[k].stars - 1]}</i></button>`).join('');
    $('ng-cpu').style.gridTemplateColumns = window.matchMedia('(max-width: 560px)').matches ? `repeat(${CPU_KEYS.length}, minmax(0, 1fr))` : '';
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['black', '先手（先に指す）'], ['white', '後手'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  function docTabs(view, key, tabs, render1) {
    const cur = store.get(key, tabs[0][0]);
    const k = tabs.some(t => t[0] === cur) ? cur : tabs[0][0];
    $(view).innerHTML = `<div class="doctabs" role="tablist">${tabs.map(([id, l]) => `<button role="tab" data-doc="${id}" aria-selected="${id === k}">${l}</button>`).join('')}</div><div id="${view}-body">${render1(k)}</div>`;
    $(view).querySelectorAll('[data-doc]').forEach(b => b.addEventListener('click', () => { store.set(key, b.dataset.doc); docTabs(view, key, tabs, render1); }));
  }
  function miniBoard() {
    // 盤の図（先手の陣地が下）
    const cell = 30, W = cell * 6, rv = cell * 0.46, H = cell * 8 + rv;
    let s = `<svg class="minimap" viewBox="-4 -4 ${W + 8} ${H + 8}" role="img" aria-label="盤の図"><rect x="0" y="0" width="${W}" height="${H}" fill="var(--map)" stroke="var(--map-line)" stroke-width="2"/>`;
    const yOf = y => (y < 4 ? y * cell : y * cell + rv);
    s += `<rect x="0" y="${4 * cell}" width="${W}" height="${rv}" fill="var(--river)"/>`;
    for (const x of C.ENTRY_X) s += `<rect x="${x * cell + 6}" y="${4 * cell - 2}" width="${cell - 12}" height="${rv + 4}" fill="var(--bridge)"/>`;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 6; x++) {
      if ((y === 0 || y === 7) && (x === 2 || x === 3)) continue;
      const ent = C.ENTRY_X.includes(x) && (y === 3 || y === 4);
      s += `<rect x="${x * cell}" y="${yOf(y)}" width="${cell}" height="${cell}" fill="${ent ? 'color-mix(in srgb, var(--bridge) 22%, var(--map))' : 'none'}" stroke="var(--map-line)" stroke-width=".6"/>`;
    }
    for (const y of [0, 7]) s += `<rect x="${2 * cell + 2}" y="${yOf(y) + 2}" width="${cell * 2 - 4}" height="${cell - 4}" fill="var(--hq)" stroke="var(--hq-line)" stroke-width="1.5"/><text x="${3 * cell}" y="${yOf(y) + cell / 2 + 4}" text-anchor="middle" font-size="11" font-weight="900" fill="var(--hq-line)" style="font-family:var(--font-koma)">司令部</text>`;
    s += `<text x="${W / 2}" y="${2 * cell}" text-anchor="middle" font-size="12" fill="var(--muted)">後手の陣地</text><text x="${W / 2}" y="${yOf(6) - 4}" text-anchor="middle" font-size="12" fill="var(--muted)">先手の陣地</text>`;
    return s + '</svg>';
  }
  function battleTable() {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    let h = '<div class="tbl"><table class="btable"><thead><tr><th></th>' + order.map(t => `<th>${NAMES[t]}</th>`).join('') + '</tr></thead><tbody>';
    for (const a of order.filter(t => t !== C.JIRAI)) {
      h += `<tr><th>${NAMES[a]}</th>` + order.map(d => { const o = C.fight(a, d); return o > 0 ? '<td class="w">勝</td>' : o < 0 ? '<td class="l">負</td>' : '<td class="t">相</td>'; }).join('') + '</tr>';
    }
    return h + '</tbody></table></div><div class="legend"><span style="--c:color-mix(in srgb, var(--good) 30%, transparent)">左の駒の勝ち</span><span style="--c:color-mix(in srgb, var(--bad) 18%, transparent)">左の駒の負け</span><span style="--c:color-mix(in srgb, var(--gold) 26%, transparent)">相打ち（両方取り除く）</span></div>';
  }
  const PIECE_NOTE = ['いちばん偉い。スパイにだけ負ける', '大将の次', '将官（大将・中将・少将）は飛行機とタンクにも勝つ', '佐官', '佐官', '佐官。少佐以上なら司令部を占領できる', '尉官', '尉官', '尉官', '将官にだけ負ける。地雷にも勝つ', '将官・飛行機・工兵に負ける', 'スパイと工兵にだけ勝つ', '地雷・スパイ・タンクに勝つ', '大将にだけ勝つ（どちらから攻めても）', '飛行機と工兵以外とは相打ち', '真後ろの味方の駒と同じ強さ'];
  function renderRules() {
    docTabs('view-rules', 'doc-rules', [['about', 'あらまし'], ['board', '盤と配置'], ['pieces', '駒と動き'], ['table', '勝ち負け表'], ['special', '特別なルール'], ['end', '勝ち方'], ['fair', 'オンライン']], k => {
      if (k === 'about') return `<div class="card"><h3>軍人将棋とは</h3><p>明治のころから遊ばれてきた、日本の昔ながらの盤上遊戯です。おたがいに自分の駒の正体（階級）を相手に隠したまま並べ、ぶつかったときだけ<b>審判</b>がこっそり比べて「勝ち・負け・相打ち」だけを告げます。相手の駒が何なのかは、動き方と戦いの結果から推理するしかありません。</p><p>このゲームでは<b>コンピューターが審判</b>です。相手の駒は裏向きに表示され、画面のどこにも種類は出ません。</p><p>作り手ごとに細かいルールが違うので、ここでは広く遊ばれている<b>1人23枚</b>の形を選び、細かいところを下のタブのとおりに決めました。</p></div>
        <div class="card"><h3>流れ</h3><ol><li>配置: 自分の陣地（手前4列・司令部は2マスで1か所）に23枚を並べます。陣地はちょうど埋まります</li><li>先手から交互に、駒を1つ動かします。相手の駒がいるマスへ動くと戦い（攻撃）になります</li><li>相手の司令部を<b>少佐以上</b>の駒で占領するか、相手の動ける駒をなくすと勝ちです</li></ol></div>`;
      if (k === 'board') return `<div class="card"><h3>盤</h3><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">${miniBoard()}<ul style="flex:1;min-width:220px"><li>横6列×縦8段。手前の4段が自分の陣地、向こうの4段が相手の陣地です</li><li>一番奥の段の真ん中2マスは<b>司令部</b>。2マスで1か所として数え、駒は1枚だけ入れます（陣地は全部で23か所）</li><li>陣地の境には川があり、渡れるのは左から2列目と5列目の<b>突入口</b>（橋）だけ。飛行機だけはどこでも越えられます</li><li>座標は先手から見て、列が左から A〜F、段が手前から 1〜8 です</li></ul></div></div>
        <div class="card"><h3>配置のきまり</h3><ul><li>23枚すべてを自分の陣地に1枚ずつ置きます</li><li><b>地雷</b>と<b>軍旗</b>は突入口のマス（最前列の2列目と5列目）に置けません</li><li><b>軍旗</b>は一番奥の段（司令部を含む）にも置けません</li><li>配置の画面では、2つの駒をタップ（またはドラッグ）して入れ替えます。「AIのおすすめ」は、AI が自己対局で学んだ並べ方です</li></ul></div>`;
      if (k === 'pieces') return `<div class="card"><h3>駒（1人23枚）と動き</h3><div class="pgrid">${NAMES.map((nm, t) => `<div class="pcard"><span class="pc">${pieceSVG(t, BLACK, false)}</span><b>${nm} ×${C.COUNTS[t]}</b><small>${MOVE_TEXT[t]}。${PIECE_NOTE[t]}</small></div>`).join('')}</div></div>
        <div class="card"><h3>動きの細かいところ</h3><ul><li>どの駒も、ななめには動けません。味方の駒のいるマスへは行けません</li><li>タンクと騎兵の「前へ2マス」は、途中のマスが空いているときだけ（飛び越えない）</li><li>工兵は縦横に何マスでも進めますが、駒を飛び越えられず、川は突入口でしか渡れません</li><li>飛行機は縦（前後）なら何マスでも、駒を飛び越え、川もどこでも越えられます。横は1マス</li><li>司令部の駒は、司令部の2マスのどちらからでも隣へ出られます</li></ul></div>`;
      if (k === 'table') return `<div class="card"><h3>勝ち負け表</h3><p class="hint">左の列の駒が、上の段の駒と戦ったときの結果です。どちらから攻めても同じです（地雷は動けないので守るだけ）。同じ種類どうしは相打ち。軍旗は真後ろの味方の駒と同じ強さになります。</p>${battleTable()}</div>`;
      if (k === 'special') return `<div class="card"><h3>特別なルール</h3><ul>
        <li><b>スパイ</b>: 大将にだけ勝ちます（スパイから攻めても、大将から攻められても）。ほかの駒にはすべて負けます。スパイどうしは相打ち</li>
        <li><b>地雷</b>: 動けません。攻めてきた駒とは<b>相打ち</b>（両方取り除く）。ただし<b>飛行機と工兵</b>は地雷に勝ちます</li>
        <li><b>工兵</b>: 地雷・スパイ・タンクに勝ちます。縦横にどこまでも進める道具役</li>
        <li><b>飛行機</b>: 将官（大将・中将・少将）にだけ負けます。タンクにも地雷にも勝ちます</li>
        <li><b>タンク</b>: 将官・飛行機・工兵に負け、地雷とは相打ち。佐官・尉官・騎兵・スパイに勝ちます</li>
        <li><b>騎兵</b>: スパイと工兵にだけ勝ちます</li>
        <li><b>軍旗</b>: 動けません。攻められたときは、<b>真後ろ（自分の陣地の奥の向き）に隣り合う味方の駒</b>と同じ強さで戦います。軍旗が負けたら軍旗だけが取られ、後ろの駒は残ります。真後ろが空いている・相手の駒のときは何にでも負けます。真後ろが地雷なら、攻めた駒と軍旗が相打ち（地雷は残る）</li>
        <li><b>司令部</b>: 相手の司令部に<b>少佐以上</b>（大将・中将・少将・大佐・中佐・少佐）の駒が入れば、その場で勝ち。ほかの駒も入れますが、占領にはなりません</li>
        <li>取られた駒は盤から取り除かれ、二度と使えません（将棋のように持ち駒にはなりません）</li></ul></div>`;
      if (k === 'end') return `<div class="card"><h3>勝ち方・引き分け</h3><ul><li>相手の司令部を少佐以上の駒で占領したら勝ち</li><li>自分の番に、動かせる手が1つもなければ負け（動ける駒が全部取られたときなど）</li><li>投了したら負け</li><li>戦いのないまま${C.QUIET_MAX}手（おたがい${C.QUIET_MAX / 2}手ずつ）が過ぎたら引き分け</li><li>全部で${C.MAX_PLY}手に達したら引き分け</li></ul><p class="hint">対局が終わると、両方の配置が表になります。</p></div>`;
      return `<div class="card"><h3>オンラインでの公平さ（審判がいなくても、ごまかせない仕組み）</h3><ol>
        <li>対局の前に、それぞれが自分の23枚について「場所・種類・秘密の乱数」から作った<b>ハッシュ（SHA-256）</b>を相手に送ります。乱数が入っているので、ハッシュから種類はわかりませんが、あとで配置を変えるとハッシュが合わなくなります</li>
        <li>戦いのときは、ぶつかった2枚（守る駒が軍旗なら、その後ろの1枚も）だけを、おたがいの端末に明かします。両方の端末がハッシュと照らし合わせて同じ表で判定し、画面には結果だけを出します</li>
        <li>終局したら、両方が全部の配置と乱数を公開し、すべての約束・すべての手の合法性・すべての判定を最初からやり直して確かめ、結果を表示します</li></ol>
        <p class="hint">明かされた2枚の種類は端末の中には届きます（画面には出しません）。公開の中継サーバーを使うため、名前と指し手はほかの人からも見える可能性があります。</p></div>`;
    });
  }
  function renderAIPage() {
    const st = STR;
    docTabs('view-ai', 'doc-ai', [['how', 'しくみ'], ['str', '強さの記録'], ['lv', 'CPUの強さ']], k => {
      if (k === 'how') return `<div class="card"><h3>見えるものだけで推理する AI</h3><p>この AI は、人の棋譜も、人が決めた駒の価値の表も使っていません。ルールだけを教わり、<b>自分どうしの対局（自己対局）</b>だけで強くなりました。</p><ol>
        <li><b>正体の推理</b>: 相手の駒がどこからどこへ動いたか（動いた駒は地雷・軍旗ではない、2マス進めばタンク・騎兵・工兵・飛行機…）と、戦いの結果（勝ち・負け・相打ち）だけから、ルールと矛盾しない「相手の23枚の正体の組み合わせ」を何通りも引きます（マルコフ連鎖モンテカルロ法）。どこに何を置きがちかの見込みは、AI 自身の配置のくせ（自己対局で学んだもの）を使います</li>
        <li><b>評価</b>: 全部の駒の正体がわかった局面の「どちらがどれだけ有利か」を、小さなニューラルネット（入力 1538・中間 64）が答えます。自己対局の勝ち負けから TD(λ) 法で学びました</li>
        <li><b>指し手</b>: 引いた組み合わせごとに、指せる手を全部試してネットで評価し、平均がいちばん高い手を選びます。攻めた結果が正体しだいで変わる手も、こうして「期待値」で比べます</li>
        <li><b>配置</b>: 「どの駒をどこに置くか」の好みの表を、自己対局の勝ち負けから少しずつ直して学びます。並べるときは好みに揺らぎを足して、23枚をハンガリー法で割り当てます</li></ol>
        <p><b>のぞき見はしません</b>: CPU には「自分の配置」と「公開の記録（動きと勝ち負け）」だけを渡します（<code>C.view()</code>）。相手の配置を入れ替えても AI の答えが変わらないことをテストで確かめています。</p></div>`;
      if (k === 'str') {
        if (!st) return '<div class="card"><h3>強さの記録</h3><p>測定中です。</p></div>';
        return `<div class="card"><h3>強さの記録</h3><div class="stat-row">${(st.headline || []).map(h => `<div class="stat"><b>${esc(h.v)}</b><span>${esc(h.l)}</span></div>`).join('')}</div><p class="hint">${esc(st.note || '')}</p></div>
          <div class="card"><h3>世代ごと</h3><div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>累計 Elo</th><th>前の世代に</th><th>対ルール</th><th>対ランダム</th></tr></thead><tbody>${(st.gens || []).map(g => `<tr><td>${g.gen}</td><td>${g.elo >= 0 ? '+' : ''}${g.elo} ±${g.err}</td><td>${esc(g.prev || '')}</td><td>${esc(g.rule || '')}</td><td>${esc(g.rand || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
      }
      return `<div class="card"><h3>CPUの強さ</h3><p>4段階とも同じ AI（同じ評価のネット）で、推理する組み合わせの数と、わざと揺らす大きさだけを変えています。</p><div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>推理する組み合わせ</th><th>揺らぎ</th><th>配置</th>${st && st.levels ? '<th>測った差</th>' : ''}</tr></thead><tbody>${CPU_KEYS.map(k2 => { const L = AI.LEVELS[k2]; const m = st && st.levels && st.levels[k2]; return `<tr><td>${CPU[k2].label}</td><td>${L.K}通り</td><td>${L.tau ? '大' .repeat(L.tau > 0.1 ? 1 : 0) + (L.tau > 0.1 ? 'きい' : '少し') : 'なし'}</td><td>${L.sigma > 2 ? 'ばらばら' : L.sigma > 1 ? 'やや学んだ形' : '学んだ形'}</td>${st && st.levels ? `<td>${m ? esc(m) : ''}</td>` : ''}</tr>`; }).join('')}</tbody></table></div><p class="hint">${STR && STR.ultra ? esc(STR.ultra.text) + '。' + (STR.ultra.ok ? 'はっきり強くなると測れたので「超最強」を置いています。' : 'はっきりとは強くならなかったので「超最強」は置いていません。') : '「超最強」（推理の数を増やした段）は、強くなると測れたときだけ置きます。'}</p></div>`;
    });
  }

  // ------------------------------------------------------------------ イベント
  function hideMenus() { const m = $('menu-more'); if (m) m.hidden = true; }
  function bind() {
    $('grid').addEventListener('click', e => { if (Date.now() - suppressClick < 300) return; const b = e.target.closest('.sq'); if (b) onSquare(+b.dataset.n); });
    bindDrag();
    $('curtain').addEventListener('click', () => { S.curtain = null; if (S.mode === 'pvp') { S.pvpViewer = stm(); S.flip = (S.phase === 'setup' ? S.drafting : stm()) === WHITE; } render(); schedule(); });
    $('controls').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (a === 'more') { const m = $('menu-more'); m.hidden = !m.hidden; b.setAttribute('aria-expanded', String(!m.hidden)); e.stopPropagation(); return; }
      hideMenus();
      if (a === 'new') openNew();
      else if (a === 'undo') undo();
      else if (a === 'hint') hint();
      else if (a === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); }
      else if (a === 'flip') { S.flip = !S.flip; render(); }
      else if (a === 'resign') { if (confirm('投了しますか？')) resign(); }
      else if (a === 'panel') openSheet('ev');
      else if (a.startsWith('preset-')) applyPreset(a.slice(7));
    });
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'setup-done') finishSetup();
      else if (b.dataset.act === 'live') viewPly(S.log.length);
      else if (b.dataset.act === 'again') again();
    });
    document.addEventListener('click', e => { if (!e.target.closest('.more-wrap')) hideMenus(); if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); } });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('[data-nav]');
      if (b) {
        const k = b.dataset.nav, cur = live() ? S.log.length : S.view;
        if (k === 'first') viewPly(0); else if (k === 'prev') viewPly(cur - 1); else if (k === 'next') viewPly(cur + 1); else if (k === 'last') viewPly(S.log.length); else if (k === 'sheet') openSheet('ev');
        return;
      }
      const t = e.target.closest('[data-ply]');
      if (t) viewPly(+t.dataset.ply);
    });
    $('kifu').addEventListener('click', e => { const t = e.target.closest('[data-ply]'); if (t) viewPly(+t.dataset.ply); });
    $('btn-live').addEventListener('click', () => viewPly(S.log.length));
    $('graph').addEventListener('click', e => { const r = $('graph').getBoundingClientRect(); viewPly(Math.round((e.clientX - r.left) / r.width * S.log.length)); });
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    document.querySelectorAll('.sheet-tabs button').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.st)));
    document.querySelector('[data-act="sheet-close"]').addEventListener('click', closeSheet);
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      const t = b.dataset.tab;
      $('view-play').hidden = t !== 'play'; $('view-rules').hidden = t !== 'rules'; $('view-ai').hidden = t !== 'ai';
      if (t === 'rules') renderRules(); if (t === 'ai') renderAIPage(); if (t === 'play') fitBoardSoon();
      closeSheet();
    }));
    $('btn-settings').addEventListener('click', e => { const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); e.stopPropagation(); });
    $('settings').addEventListener('click', e => e.stopPropagation());
    const sw = { 'set-eval': 'showEval', 'set-guess': 'guess', 'set-arrow': 'arrow', 'set-sound': 'sound', 'set-anim': 'anim', 'set-marks': 'marks' };
    for (const [id, k] of Object.entries(sw)) { $(id).checked = !!settings[k]; $(id).addEventListener('change', () => setSetting(k, $(id).checked)); }
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      if (e.target === $('dlg-new')) { closeNew(); return; }
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const id = b.parentElement.id, v = b.dataset.v;
      if (id === 'ng-mode' && v === 'online') { $('dlg-new').hidden = true; schedule(); openOnline(); return; }
      if (id === 'ng-mode') draft.mode = v; else if (id === 'ng-cpu') draft.cpu = v; else if (id === 'ng-side') draft.side = v; else if (id === 'ng-cpu-b') draft.cpuB = v; else if (id === 'ng-cpu-w') draft.cpuW = v;
      drawNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    // 終局
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; again(); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    // オンライン
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込んでいます…'; NET.challenge(b.dataset.ch); renderLobby(); }
      else if (b.dataset.act === 'wait') { NET.wait({ v: 1 }, '標準ルール（23枚）'); renderLobby(); }
      else if (b.dataset.act === 'unwait') { NET.unwait(); renderLobby(); }
      else if (b.dataset.act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); renderLobby(); }
      else if (b.dataset.act === 'copy') { const link = `${location.origin}${location.pathname}?room=${NET.me.c}`; try { navigator.clipboard.writeText(link); lobby.msg = '招待リンクをコピーしました'; } catch (err) { lobby.msg = link; } renderLobby(); }
    });
    $('dlg-online').addEventListener('change', e => { if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); renderPlayers(); } });
    window.addEventListener('resize', () => { fitBoardSoon(); renderArrows(); if ($('side').classList.contains('open')) placeSheet(); });
    document.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') { if (!$('dlg-new').hidden) closeNew(); else { $('dlg-result').hidden = true; $('dlg-online').hidden = true; closeSheet(); clearSel(); } }
      else if (e.key === 'ArrowLeft' && $('dlg-new').hidden) viewPly((live() ? S.log.length : S.view) - 1);
      else if (e.key === 'ArrowRight' && $('dlg-new').hidden) viewPly((live() ? S.log.length : S.view) + 1);
    });
  }
  function again() {
    if (S.mode === 'online') { requestRematch(); return; }
    const c = Object.assign({}, cfg);
    if (c.mode === 'cpu' && c.side !== 'random') c.side = humanColor() === BLACK ? 'white' : 'black';
    startGame(c);
  }
  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', guess: 'set-guess', arrow: 'set-arrow', sound: 'set-sound', anim: 'set-anim', marks: 'set-marks' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if ((k === 'showEval' || k === 'arrow') && NET) NET.setAI(aiFlags());
    render(); analyze();
  }
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function placeSheet() { const fr = $('board-frame').getBoundingClientRect(), h = window.innerHeight; $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.62, Math.max(h * 0.3, fr.bottom + 6))) + 'px'); }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && tab !== 'kifu') tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return;
    placeSheet(); side.classList.add('open');
    renderKifu(); renderGraph(); renderEst();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  // ------------------------------------------------------------------ オンライン対戦
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available();
  const GAME = 'gunjin';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/gunjin/';
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.arrow ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢・推定' : '', f & 2 ? '最善手の矢印' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) { const on = !!f || !!hints; return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`; }
  const emptyRec = () => ({ cm: null, mv: {}, dr: {}, rs: null, op: null });

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: GAME,
      onStatus: () => { renderOnlineBadge(); renderLobby(); if (S.mode === 'online') { renderSqInfo(); renderPlayers(); } },
      onPresence: () => { renderOnlineBadge(); renderLobby(); tryRoom(); },
      onMatch: g => startOnline(g),
      onRemote: m => onRemote(m),
      onOppPresence: p => { if (S.mode === 'online') { S.online.oppPresent = p; renderSqInfo(); renderPlayers(); } },
      onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
    });
    NET.setName(myName); NET.setAI(aiFlags()); NET.connect();
    return NET;
  }
  function startOnline(g) {
    $('dlg-online').hidden = true; $('dlg-result').hidden = true;
    AIW.cancel(); clearTimeout(S.timer);
    const me = g.myColor ? WHITE : BLACK;
    S.online = { mid: g.mid, me, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, myRe: false, oppRe: false, setup: null, salts: null, rec: [emptyRec(), emptyRec()], st: null, verify: null, oppSetup: null, err: '' };
    S.mode = 'online'; S.seats = me === BLACK ? ['human', 'remote'] : ['remote', 'human'];
    S.log = []; S.result = null; S.resultShown = false; S.view = null; S.evals = []; S.info = null; S.hint = -1; S.curtain = null; S.game = null;
    S.flip = me === WHITE; lastEventSeen = 0;
    beginSetup(me);
    sfx('move');
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    if (S.mode === 'online') { S.online = null; S.mode = 'cpu'; }
  }
  function myRec() { return S.online.rec[S.online.me]; }
  function pushRec() {
    if (!NET) return;
    NET.send({ t: 'rec', rec: myRec() });
    NET.saveState({ rec: myRec() });
    saveGame();
  }
  function onlineCommit() {
    const o = S.online;
    if (myRec().cm) return;
    o.setup = S.draft.slice();
    const c = PR.makeCommit(o.mid, o.me, o.setup);
    o.salts = c.salts; myRec().cm = c.cs;
    pushRec();
    onlineSync();
  }
  // 相手の記録を取り込む（増えるだけ。書き換えは受け付けない）
  function mergeRec(dst, src) {
    if (!src || typeof src !== 'object') return;
    const rv = x => (x && typeof x === 'object' ? { k: x.k | 0, ty: x.ty | 0, s: String(x.s || '').slice(0, 32) } : null);
    if (!dst.cm && PR.validCm(src.cm)) dst.cm = src.cm.slice();
    if (src.mv && typeof src.mv === 'object') for (const n of Object.keys(src.mv).slice(0, 600)) if (!dst.mv[n] && src.mv[n]) { const v = { m: src.mv[n].m | 0 }; if (src.mv[n].rv) v.rv = rv(src.mv[n].rv); dst.mv[n] = v; }
    if (src.dr && typeof src.dr === 'object') for (const n of Object.keys(src.dr).slice(0, 600)) if (!dst.dr[n] && src.dr[n]) dst.dr[n] = { rv: rv(src.dr[n].rv), sup: rv(src.dr[n].sup) };
    if (!dst.rs && src.rs) dst.rs = { n: src.rs.n | 0, why: src.rs.why === 'nomove' ? 'nomove' : 'resign' };
    if (!dst.op && src.op && Array.isArray(src.op.setup) && Array.isArray(src.op.salts)) dst.op = { setup: src.op.setup.slice(0, NP).map(x => x | 0), salts: src.op.salts.slice(0, NP).map(x => String(x).slice(0, 32)) };
  }
  // 両方の記録から対局を組み立て直し、自分のやること（明かす・公開する）をする
  function onlineSync() {
    const o = S.online;
    if (!o || !o.setup) { render(); return; }
    let st;
    for (let guard = 0; guard < 6; guard++) {
      st = PR.reconstruct({ mid: o.mid, me: o.me, setup: o.setup, rec: o.rec });
      if (st.need && st.need.kind === 'reveal' && st.need.who === o.me) {
        const om = o.rec[o.me ^ 1].mv[st.need.n].m, d = st.pos.sq[om & 63], k = d % NP;
        const dr = { rv: PR.reveal(o.setup, o.salts, k), sup: null };
        if (o.setup[k] === GUNKI) { const s = st.pos.support(d); if (s >= 0) dr.sup = PR.reveal(o.setup, o.salts, s % NP); }
        myRec().dr[st.need.n] = dr; pushRec(); continue;
      }
      if (st.need && st.need.kind === 'move' && st.need.who === o.me && !st.pos.gen(o.me).length && !myRec().rs) { myRec().rs = { n: st.need.n, why: 'nomove' }; pushRec(); continue; }
      if ((st.end || st.err) && !myRec().op) { myRec().op = { setup: o.setup.slice(), salts: o.salts.slice() }; pushRec(); continue; }
      break;
    }
    o.st = st;
    o.err = st.err ? `相手の記録が約束と合いません（${st.err}）` : '';
    o.pend = st.need && st.need.kind === 'reveal' ? { t: o.rec[st.need.who ^ 1].mv[st.need.n].m & 63 } : null;
    S.log = st.log;
    if (st.need && st.need.kind === 'commit') S.phase = 'setup';
    else if (S.phase === 'setup') { S.phase = 'play'; S.drafting = -1; S.draft = null; }
    if (st.err && !S.result) S.result = { winner: o.me, reason: 'invalid' };
    if (st.end && !S.result) S.result = st.end;
    if (S.result && o.rec[o.me ^ 1].op) {
      o.verify = PR.verifyEnd({ mid: o.mid, rec: o.rec }, st);
      if (o.verify.setups) o.oppSetup = o.verify.setups[o.me ^ 1];
      if (!$('dlg-result').hidden) renderVerify();
    }
    afterChange();
  }
  function onlineMove(m) {
    const o = S.online, st = o.st;
    if (!st || !st.need || st.need.kind !== 'move' || st.need.who !== o.me) return;
    const f = m >> 6, t = m & 63, a = st.pos.sq[f], k = a % NP;
    const mv = { m };
    if (st.pos.sq[t] >= 0 || (t === HQ[o.me ^ 1] && o.setup[k] <= SHOSA)) mv.rv = PR.reveal(o.setup, o.salts, k);
    myRec().mv[st.need.n] = mv;
    pushRec();
    onlineSync();
  }
  function onlineResign() {
    const o = S.online;
    if (!o.st || myRec().rs) return;
    myRec().rs = { n: o.st.log.length + 1, why: 'resign' };
    pushRec(); onlineSync();
  }
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    if (msg.t === 'hi') { if (msg.n) o.opp.name = String(msg.n).slice(0, 16); o.opp.ai = msg.ai | 0; if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() }); if (myRec().cm) pushRec(); saveGame(); renderPlayers(); }
    else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.rec) { mergeRec(o.rec[o.me ^ 1], msg.rec); onlineSync(); } // 'rec' と保持の状態（common/online.js では t が時刻で上書きされるので中身で見分ける）
    else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.gid === 'string') NET.start({ mid: msg.gid.slice(0, 20), myColor: msg.oc ? 1 : 0, r: { v: 1 }, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
  }
  function requestRematch() { const o = S.online; if (!o || !NET) return; o.myRe = true; NET.send({ t: 're' }); maybeRematch(); renderSqInfo(); $('sqinfo').querySelector('.txt').textContent = 'もう一局を申し込みました（相手の返事を待っています）'; }
  function maybeRematch() {
    const o = S.online;
    if (!o || !o.myRe || !o.oppRe || !NET || !NET.game) return;
    const oppId = NET.game.oppId;
    if (oppId && NET.id > oppId) return;
    const gid = Math.random().toString(36).slice(2, 12);
    NET.send({ t: 'rego', gid, oc: o.me });
    NET.start({ mid: gid, myColor: o.me ^ 1, r: { v: 1 }, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.g === GAME && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null; history.replaceState(null, '', location.pathname);
    lobby.msg = `${p.n}さんに申し込みました…`; NET.challenge(p.id); renderLobby();
  }
  function openOnline() {
    if (!ONLINE_OK) { $('dlg-online').hidden = false; $('on-body').innerHTML = `<p>オンライン対戦は、公開版で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`; return; }
    net(); $('dlg-online').hidden = false; renderLobby();
  }
  function renderOnlineBadge() {
    const b = $('btn-online'), st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・軍人将棋の待ち${g.wait}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', all = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const c = all && Object.assign({ online: all.online }, all.byGame[GAME] || { wait: 0, play: 0 });
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === GAME) : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats"><div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div><div class="stat"><b>${num(c && c.wait)}</b><span>軍人将棋の対戦待ち</span></div><div class="stat"><b>${num(c && c.play)}</b><span>軍人将棋の対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span></div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span><div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・相手の駒の推定・最善手を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span><div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('') : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span>部屋コード <b class="code">${esc(me.c)}</b> で待っています…</span><span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span><span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `<div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>待つ（標準ルール・23枚）</button></div>`}</div>
      <p class="hint on-note">配置は最初にハッシュで約束し、戦った駒だけを明かし合い、終局後に全部を確かめます（遊び方の「オンライン」）。公開の中継サーバーを使うため、名前と指し手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // ------------------------------------------------------------------ はじめ
  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBoardSoon());
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  try {
    if (saved && saved.mode === 'online' && saved.online && ONLINE_OK && saved.online.setup !== undefined) {
      const so = saved.online;
      S.online = Object.assign({ oppPresent: true, myRe: false, oppRe: false, st: null, verify: null, oppSetup: null, err: '', myHints: 0 }, so);
      S.mode = 'online'; S.seats = so.me === BLACK ? ['human', 'remote'] : ['remote', 'human']; S.flip = !!saved.flip;
      if (!so.setup) { S.phase = 'setup'; S.drafting = so.me; S.draft = saved.draft || suggestSetup(0.7); }
      NET.rejoin({ mid: so.mid, myColor: so.me, opp: { id: '', name: so.opp.name, ai: so.opp.ai } });
      if (so.setup) { S.phase = 'setup'; onlineSync(); } else afterChange();
      if (S.result) S.resultShown = true;
    } else if (saved && saved.mode && saved.mode !== 'online' && Array.isArray(saved.setups) && Array.isArray(saved.moves)) loadGame(saved);
    else { $('dlg-new').hidden = false; startGame(Object.assign({}, cfg, { mode: cfg.mode === 'online' ? 'cpu' : cfg.mode })); openNew(); }
  } catch (e) { console.error(e); startGame(Object.assign({}, cfg, { mode: 'cpu' })); openNew(); }
})();
