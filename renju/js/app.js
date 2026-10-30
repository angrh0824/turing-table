/* 連珠 Webアプリ: 盤（SVG）・CPU（Web Worker）・形勢と脅威の表示・オンライン対戦 */
(function () {
  'use strict';
  const R = {};
  RenjuCore(R);
  RenjuAI(R);
  const WRAW = (typeof RENJU_WEIGHTS !== 'undefined' && RENJU_WEIGHTS) ? RENJU_WEIGHTS : R.defaultWeights();
  const WP = R.prepareWeights(WRAW);
  // ネットの評価（学習済みのものがあれば。js/nn-weights.js）
  const NNRAW = (typeof RENJU_NN !== 'undefined' && RENJU_NN) ? RENJU_NN : null;
  const NNP = NNRAW ? R.prepareNN(NNRAW) : null;
  const NN_MODE = 2; // ネットを使うときは手の順番だけ（評価に使うと遅くなって弱い。README の測定）
  const { N, BLACK, WHITE, CENTER, ptName } = R;
  const $ = id => document.getElementById(id);
  const SIDE = ['', '黒', '白'];
  const MARK = ['', '●', '○'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'すぐ打ちます。ときどき甘い手も', time: 300, depth: 3, noise: 40, vcfNodes: 0, qvcf: 0, randomTop: 0.15 },
    normal: { label: 'ふつう', stars: 2, desc: '少し先まで読み、四追いも見ます', time: 1000, depth: 10, noise: 5, vcfNodes: 15000, qvcf: 200 },
    strong: { label: 'つよい', stars: 3, desc: '1手2秒。学習した評価で深く読みます', time: 2000 },
    max: { label: '最強', stars: 4, desc: '1手8秒。複数のスレッドで全力で読みます', time: 8000, parallel: true },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 6000, HINT_MS = 2500;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('renju-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('renju-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong', rule: 'renju', opening: 'tengen' }, store.get('cfg', {}));
  if (!R.RULES[cfg.rule]) cfg.rule = 'renju';
  if (!R.OPENINGS[cfg.opening]) cfg.opening = 'tengen';
  // AI補助: showEval = 形勢、best = 最善手の印、threat = 四・三の表示
  const settings = Object.assign({ sound: true, num: false, analyze: true, showEval: true, best: true, threat: true, confirm: 'auto' }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.best || settings.threat;
  const confirmOn = () => settings.confirm === 'always' || (settings.confirm === 'auto' && pointerType !== 'mouse');

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    rule: 'renju', opening: 'tengen', seats: [null, 'human', 'normal'],
    game: null, evals: [], view: null, vgame: null,
    info: null, cpuInfo: null, timer: 0, thinking: false, resultShown: false,
    online: null,   // { mid, myColor, opp: {name, ai, hints}, myHints, oppPresent, lostAt, myRe, oppRe }
    pending: -1,    // 仮置きしている点（タッチで確かめるとき）
    hover: -1,      // マウスを乗せている点
    cursor: -1,     // キーボードの印
    shukei: '',     // 珠型の名前
    lastAnim: -1,
  };
  const live = () => S.view === null;
  const shownGame = () => (live() ? S.game : S.vgame);
  const shownPly = () => (live() ? S.game.moves.length : S.view);
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (S.seats[3 - c] !== 'human' ? 'あなた' : '人間'));
  const gameOpts = () => ({ rule: S.rule, opening: S.opening });

  // ------------------------------------------------------------------ CPU（Web Worker）
  function workerMain() {
    const R = {};
    RenjuCore(R);
    RenjuAI(R);
    let weights = null, nn = null, tt = null, flag = null, helper = 0;
    const eng = {};
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') {
        weights = j.weights; nn = j.nn || null; helper = j.helper || 0;
        if (j.tt) tt = { bits: j.ttBits, mask: (1 << j.ttBits) - 1, a: new Int32Array(j.tt) };
        if (j.flag) flag = new Int32Array(j.flag);
        return;
      }
      const useNN = !!(j.nn && nn), ek = j.rule + (useNN ? ':nn' : '');
      let en = eng[ek];
      if (!en) en = eng[ek] = new R.Engine({ rule: j.rule, weights, nn: useNN ? nn : null, tt: tt || undefined, stopFlag: flag });
      en.setMoves(j.moves);
      // やさしい: ときどき読まずに、手の順番の上位から選ぶ（相手の四は必ず止める）
      if (j.randomTop && !helper && Math.random() < j.randomTop && j.moves.length >= 3 && !en.S5[3 - en.side].n && !en.S5[en.side].n) {
        self.postMessage({ id: j.id, type: 'done', helper, info: { move: en.randomTop(5), score: 0, depth: 0, pv: [], nodes: 0, time: 0 } });
        return;
      }
      const onInfo = helper ? null : info => self.postMessage({ id: j.id, type: 'info', info });
      const r = en.think({ timeMs: j.timeMs, maxDepth: j.maxDepth, noise: j.noise, analyze: j.analyze, jobId: j.id, helper, onInfo, centerOnly: j.centerOnly, vcfNodes: j.vcfNodes, qvcf: j.qvcf, nnMode: j.nnMode });
      self.postMessage({ id: j.id, type: 'done', helper, info: r });
    };
  }
  // 共有メモリが使えるとき（COOP/COEP 付きのサーバーで開いたとき）は、複数のワーカーが置換表を共有して読む（Lazy SMP）
  const SMP = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const THREADS = SMP ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const TT_BITS = 21;
  const AI = {
    pool: [], id: 0, busy: false, fallback: null,
    tt: SMP ? R.makeTT(TT_BITS, true) : null,
    flag: SMP ? new SharedArrayBuffer(4) : null,
    make(i) {
      try {
        const src = RenjuCore.toString() + '\n' + RenjuAI.toString() + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', weights: WP, nn: NNP, tt: this.tt ? this.tt.buf : null, ttBits: TT_BITS, flag: this.flag, helper: i });
        return w;
      } catch (e) { return null; }
    },
    ensure(n) {
      while (this.pool.length < n) { const w = this.make(this.pool.length); if (!w) break; this.pool.push(w); }
      return this.pool.length;
    },
    start(job, onInfo, onDone) {
      this.cancel();
      const id = ++this.id;
      this.busy = true;
      const n = this.ensure(job.parallel ? THREADS : 1);
      const finish = r => { if (id !== this.id) return; this.busy = false; onDone(r); };
      if (!n) {
        // Worker が使えない環境: 画面の側で短く読む
        setTimeout(() => {
          if (id !== this.id) return;
          if (!this.fallback || this.fallback.rule !== job.rule) this.fallback = new R.Engine({ rule: job.rule, weights: WP, nn: NNP });
          this.fallback.setMoves(job.moves);
          finish(this.fallback.think(Object.assign({}, job, { timeMs: Math.min(job.timeMs, 1500) })));
        }, 30);
        return;
      }
      if (this.flag) Atomics.store(new Int32Array(this.flag), 0, id);
      const msg = Object.assign({ type: 'think', id }, job);
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.id !== this.id || i !== 0) return;
          if (m.type === 'info') { if (onInfo) onInfo(m.info); return; }
          if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -id);
          finish(m.info);
        };
        w.postMessage(msg);
      });
    },
    cancel() {
      if (this.busy) {
        if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -this.id);
        else { this.pool.forEach(w => w.terminate()); this.pool = []; }
      }
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 石の音（WebAudio で合成）
  let actx = null;
  function clack(strong) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, len = 0.05, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 7);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = strong ? 2300 : 2900; bp.Q.value = 1.6;
      const g = actx.createGain(); g.gain.setValueAtTime(strong ? 1.7 : 1.25, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.frequency.setValueAtTime(strong ? 210 : 260, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.06);
      og.gain.setValueAtTime(0.28, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.08);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    let seats;
    if (cfg.mode === 'pvp') seats = [null, 'human', 'human'];
    else if (cfg.mode === 'watch') seats = [null, cfg.cpuB, cfg.cpuW];
    else {
      const human = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = human === BLACK ? [null, 'human', cfg.cpu] : [null, cfg.cpu, 'human'];
    }
    let moves = [], shukei = '';
    if (cfg.opening === 'shukei') { const s = R.randomShukei(); moves = s.moves; shukei = s.name; }
    loadGame({ rule: cfg.rule, opening: cfg.opening, seats, moves, shukei });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.rule = g.rule; S.opening = g.opening; S.seats = g.seats; S.online = g.online || null; S.shukei = g.shukei || '';
    S.game = new R.Game({ rule: g.rule, opening: g.opening });
    for (const p of g.moves) { if (!S.game.isLegal(p)) break; S.game.play(p); }
    if (g.result && !S.game.result) S.game.result = g.result;
    S.evals = g.evals ? g.evals.slice() : [];
    S.view = null; S.vgame = null; S.info = null; S.cpuInfo = null; S.pending = -1; S.hover = -1;
    S.resultShown = !!S.game.result;
    S.assisted = !!g.assisted; // この対局で AI補助・ヒントを使ったか（戦績を分けて数える）
    afterChange();
  }

  function saveGame() {
    const online = S.online ? { mid: S.online.mid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { rule: S.rule, opening: S.opening, seats: S.seats, moves: S.game.moves, result: S.game.result, shukei: S.shukei, evals: S.evals.map(v => (v == null ? null : Math.round(v))), online, assisted: S.assisted });
  }

  function play(p, fromRemote) {
    const g = S.game;
    if (!g.isLegal(p)) return false;
    if (isHuman(g.stm) && aiOn()) S.assisted = true;
    g.play(p);
    S.lastAnim = p;
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: g.moves.length, p });
    clack(!!g.result);
    afterChange();
    if (S.online && NET) NET.saveState({ moves: g.moves, r: g.result ? 1 : 0 });
    return true;
  }

  function afterChange() {
    S.pending = -1; S.hover = -1;
    S.info = null; S.cpuInfo = null;
    saveGame();
    render();
    if (S.game.result && !S.resultShown && live()) { S.resultShown = true; recordResult(); setTimeout(showResult, 500); }
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    const g = S.game;
    if (!live() || g.result) { analyze(); return; }
    const c = g.stm;
    if (isRemote(c)) { AI.cancel(); renderEval(); return; }
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = g.moves.length;
    S.thinking = true;
    renderPlayers();
    AI.start({ rule: S.rule, moves: g.moves.slice(), centerOnly: S.opening !== 'any', timeMs: cpu.time, maxDepth: cpu.depth, noise: cpu.noise, vcfNodes: cpu.vcfNodes, qvcf: cpu.qvcf, randomTop: cpu.randomTop, parallel: !!cpu.parallel, nn: !!cpu.nn, nnMode: NN_MODE },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        if (live() && S.game.moves.length === ply && !S.game.result) {
          const delay = Math.max(120, 380 - (info.time || 0));
          S.timer = setTimeout(() => { if (!play(info.move)) { const lm = S.game.legalMoves(); if (lm.length) play(lm[0]); } }, delay);
        }
      });
  }

  // 人間の番（または棋譜を見返しているとき）に形勢を読む
  function analyze(force, ms) {
    const g = shownGame();
    if (((!settings.analyze || !aiOn()) && !force) || g.result) { AI.cancel(); renderEval(); renderBoard(); return; }
    const ply = shownPly(), c = g.stm;
    AI.start({ rule: S.rule, moves: g.moves.slice(), centerOnly: S.opening !== 'any', timeMs: ms || ANALYZE_MS, analyze: true, parallel: true, nn: false, nnMode: NN_MODE },
      info => onInfo(ply, c, info, 'analysis'), info => onInfo(ply, c, info, 'analysis'));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || info.move < 0) return;
    const scoreB = c === BLACK ? info.score : -info.score;
    const weak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if ((info.depth || info.forced) && (!weak || S.evals[ply] == null)) S.evals[ply] = scoreB;
    const rec = { ply, scoreB, pv: info.pv || [], depth: info.depth, nodes: info.nodes, time: info.time, stm: c, kind, vcf: info.vcf, forced: info.forced };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!weak || !S.info || S.info.ply !== ply) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderTape(); renderBoard();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力
  const humanTurn = () => live() && !S.game.result && isHuman(S.game.stm);
  function onPoint(p) {
    const g = S.game;
    if (!humanTurn()) return;
    if (!g.isLegal(p)) {
      // 打てない点: 禁手なら理由を情報の行に
      S.pending = -1; S.hover = p;
      renderBoard(); renderSqInfo();
      return;
    }
    if (confirmOn() && S.pending !== p) { S.pending = p; renderBoard(); renderSqInfo(); return; }
    play(p);
  }
  function pointAt(ev) {
    const svg = $('board'), r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * 640, y = (ev.clientY - r.top) / r.height * 640;
    const gx = Math.round((x - OFF) / CELL), gy = Math.round((y - OFF) / CELL);
    if (gx < 0 || gy < 0 || gx >= N || gy >= N) return -1;
    // 交点から離れすぎたタップは無視（線の真ん中あたり）
    const dx = x - (OFF + gx * CELL), dy = y - (OFF + gy * CELL);
    if (dx * dx + dy * dy > (CELL * 0.62) ** 2) return -1;
    return gy * N + gx;
  }

  // ------------------------------------------------------------------ 盤（SVG）
  const CELL = 40, OFF = 40;
  const PX = p => OFF + (p % N) * CELL, PY = p => OFF + ((p / N) | 0) * CELL;
  const STARS = ['d4', 'l4', 'h8', 'd12', 'l12'].map(R.parsePt);
  function boardStatic() {
    // 木目（柾目）: 決まった乱数で縦の筋を引く
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    let grain = '';
    for (let x = 0; x < 640;) {
      const w = 0.6 + rnd() * 2.2, a = 0.25 + rnd() * 0.75, wob = (rnd() - 0.5) * 10;
      grain += `<path d="M${x.toFixed(1)} 0 C ${(x + wob).toFixed(1)} 210, ${(x - wob).toFixed(1)} 430, ${(x + wob * 0.6).toFixed(1)} 640" stroke-width="${w.toFixed(2)}" opacity="${a.toFixed(2)}"/>`;
      x += 3 + rnd() * 11;
    }
    let lines = '';
    for (let k = 0; k < N; k++) {
      const v = OFF + k * CELL;
      lines += `<line class="ln" x1="${OFF}" y1="${v}" x2="${OFF + 14 * CELL}" y2="${v}"/><line class="ln" x1="${v}" y1="${OFF}" x2="${v}" y2="${OFF + 14 * CELL}"/>`;
    }
    const stars = STARS.map(p => `<circle class="star" cx="${PX(p)}" cy="${PY(p)}" r="4.6"/>`).join('');
    let crd = '';
    for (let k = 0; k < N; k++) {
      crd += `<text class="crd" x="${OFF + k * CELL}" y="${640 - 11}">${R.COLS[k]}</text>`;
      crd += `<text class="crd" x="17" y="${OFF + k * CELL + 5}">${N - k}</text>`;
    }
    return `<defs>
      <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--wood-hi)"/><stop offset=".55" style="stop-color:var(--wood)"/><stop offset="1" style="stop-color:var(--wood-lo)"/></linearGradient>
      <radialGradient id="gb" cx=".36" cy=".32" r=".75"><stop offset="0" stop-color="#707070"/><stop offset=".28" stop-color="#2a2a2a"/><stop offset=".75" stop-color="#0c0c0c"/><stop offset="1" stop-color="#000"/></radialGradient>
      <radialGradient id="gw" cx=".36" cy=".32" r=".78"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f3efe6"/><stop offset=".88" stop-color="#d9d1bf"/><stop offset="1" stop-color="#bdb39d"/></radialGradient>
      <pattern id="shell" patternContentUnits="objectBoundingBox" width="1" height="1"><path d="M.08 .62 Q .5 .44 .92 .62 M.1 .74 Q .5 .56 .9 .74 M.16 .84 Q .5 .68 .84 .84 M.12 .5 Q .5 .33 .88 .5" fill="none" stroke="#8a7f68" stroke-width=".012" opacity=".22"/></pattern>
    </defs>
    <rect width="640" height="640" rx="6" fill="url(#wood)"/>
    <g stroke="var(--wood-grain)" fill="none">${grain}</g>
    ${lines}<rect class="edge" x="${OFF}" y="${OFF}" width="${14 * CELL}" height="${14 * CELL}"/>${stars}${crd}
    <g id="g-dim"></g><g id="g-threat"></g><g id="g-stones"></g><g id="g-marks"></g>`;
  }
  function stoneSVG(p, col, cls = '') {
    const x = PX(p), y = PY(p);
    return `<g class="${cls}"><circle cx="${x + 1.6}" cy="${y + 2.4}" r="18.6" fill="rgba(0,0,0,.28)"/>` +
      `<circle cx="${x}" cy="${y}" r="18.6" fill="url(#${col === BLACK ? 'gb' : 'gw'})"${col === WHITE ? ' stroke="rgba(120,108,84,.55)" stroke-width=".8"' : ''}/>` +
      (col === WHITE ? `<circle cx="${x}" cy="${y}" r="18.6" fill="url(#shell)"/>` : '') + '</g>';
  }

  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderSqInfo();
    fitBoardSoon();
  }

  function renderBoard() {
    const svg = $('board');
    if (!svg.firstChild) svg.innerHTML = boardStatic();
    const g = shownGame(), mv = g.moves, ply = mv.length;
    // 石
    let st = '';
    for (let k = 0; k < ply; k++) {
      const p = mv[k], col = k % 2 ? WHITE : BLACK;
      st += stoneSVG(p, col, p === S.lastAnim && k === ply - 1 && live() && !reduceMotion ? 'newstone' : '');
      if (settings.num) st += `<text class="num" x="${PX(p)}" y="${PY(p) + 6}" fill="${k === ply - 1 ? 'var(--shu)' : col === BLACK ? '#f2ede2' : '#1d1b17'}">${k + 1}</text>`;
    }
    if (ply && !settings.num) { const p = mv[ply - 1]; st += `<circle class="last" cx="${PX(p)}" cy="${PY(p)}" r="5"/>`; }
    $('g-stones').innerHTML = st;
    S.lastAnim = -1;
    // 打てない点（黒の禁手・1手目は天元だけ）をやんわり暗く
    let dim = '';
    const can = live() && !g.result;
    if (can && g.centerOnly()) {
      for (let p = 0; p < N * N; p++) if (p !== CENTER) dim += `<circle class="dim" cx="${PX(p)}" cy="${PY(p)}" r="6" opacity=".7"/>`;
      dim += `<circle cx="${PX(CENTER)}" cy="${PY(CENTER)}" r="16" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="5 4"/>`;
    } else if (!g.result) {
      g.forbiddenPoints().forEach((f, p) => {
        const x = PX(p), y = PY(p);
        dim += `<circle class="dim" cx="${x}" cy="${y}" r="15"/><path class="xmark" d="M${x - 7} ${y - 7}L${x + 7} ${y + 7}M${x + 7} ${y - 7}L${x - 7} ${y + 7}"/>`;
      });
    }
    $('g-dim').innerHTML = dim;
    // 四・三（AI補助）
    let th = '';
    if (settings.threat && !(live() && g.result)) {
      const lines = g.lines();
      for (const L of lines) {
        const cls = L.col === BLACK ? 'b' : 'w';
        const ss = L.stones.slice().sort((a, b) => a - b), a = ss[0], b = ss[ss.length - 1];
        th += `<line class="t-${cls}" x1="${PX(a)}" y1="${PY(a)}" x2="${PX(b)}" y2="${PY(b)}" stroke-width="${L.kind === 4 ? 48 : 44}" stroke-linecap="round"/>`;
      }
      for (const L of lines) {
        const cls = L.col === BLACK ? 'b' : 'w';
        for (const q of L.points) th += `<circle class="tp-${cls} tp${L.kind}" cx="${PX(q)}" cy="${PY(q)}" r="${L.kind === 4 ? 12 : 10}"/>`;
      }
    }
    $('g-threat').innerHTML = th;
    // 印: 最善手・仮置き・マウス・キーボード
    let mk = '';
    const info = S.info;
    const showBest = info && info.kind !== 'cpu' && (info.kind === 'hint' || settings.best) && info.ply === shownPly() && info.pv && info.pv.length && !g.result;
    if (showBest) {
      const p = info.pv[0];
      if (p >= 0 && g.at(p) === 0) {
        mk += `<g opacity=".55">${stoneSVG(p, g.stm)}</g><circle class="bestring" cx="${PX(p)}" cy="${PY(p)}" r="19"/>`;
        const lbl = info.kind === 'hint' ? 'ヒント' : '最善';
        const bx = Math.max(4, Math.min(636 - 44, PX(p) - 22)), by = PY(p) - 46 < 2 ? PY(p) + 24 : PY(p) - 46;
        mk += `<rect x="${bx}" y="${by}" width="44" height="22" rx="11" fill="#2e9a5a"/><text class="bestlbl" x="${bx + 22}" y="${by + 16}">${lbl}</text>`;
      }
    }
    if (live() && S.pending >= 0 && g.at(S.pending) === 0) mk += `<g class="ghost">${stoneSVG(S.pending, g.stm)}</g><circle class="pend" cx="${PX(S.pending)}" cy="${PY(S.pending)}" r="21"/>`;
    else if (live() && S.hover >= 0 && humanTurn() && g.isLegal(S.hover) && pointerType === 'mouse') mk += `<g class="ghost">${stoneSVG(S.hover, g.stm)}</g>`;
    if (S.cursor >= 0) mk += `<rect class="cursor" x="${PX(S.cursor) - 19}" y="${PY(S.cursor) - 19}" width="38" height="38" rx="6"/>`;
    $('g-marks').innerHTML = mk;
    const black = g.moves.length ? `、${g.moves.length}手目まで` : '';
    svg.setAttribute('aria-label', `連珠の盤${black}。${g.result ? '終局' : SIDE[g.stm] + 'の番'}`);
  }

  // 盤の大きさ: 盤・情報の行・棋譜テープ・対局者・ボタンが画面の高さに収まる大きさに
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  const landscape = () => window.matchMedia('(orientation: landscape) and (max-height: 560px) and (max-width: 979px)').matches;
  function fitBoard() {
    const col = document.querySelector('.board-col'), row = document.querySelector('.board-row');
    if (!col || !col.offsetParent) return;
    const top = col.getBoundingClientRect().top;
    let w;
    if (landscape()) {
      const cw = col.getBoundingClientRect().width;
      w = Math.min(window.innerHeight - top - 8, cw - 14 - 290);
    } else {
      const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
      let other = 0, n = 0;
      const under = col.querySelector('.under'), ug = parseFloat(getComputedStyle(under).rowGap) || 0;
      for (const el of col.children) {
        if (el === row || getComputedStyle(el).display === 'none') continue;
        if (el === under) { for (const u of under.children) { if (getComputedStyle(u).display === 'none') continue; other += u.getBoundingClientRect().height + ug; } other -= ug; }
        else other += el.getBoundingClientRect().height;
        n++;
      }
      const rowExtra = row.getBoundingClientRect().width - $('board-wrap').getBoundingClientRect().width;
      const avail = window.innerHeight - top - other - gap * n - 10;
      w = Math.min(640 + rowExtra, avail + rowExtra, col.getBoundingClientRect().width);
    }
    w = Math.round(Math.max(200, w));
    if (document.documentElement.style.getPropertyValue('--board-w') !== w + 'px') document.documentElement.style.setProperty('--board-w', w + 'px');
  }

  // ------------------------------------------------------------------ 対局者・情報の行
  function renderPlayers() {
    const g = shownGame();
    // 上が相手、下が自分（ふたりで・観戦は 上 = 白、下 = 黒）
    const me = S.online ? S.online.myColor : isHuman(WHITE) && !isHuman(BLACK) ? WHITE : BLACK;
    [['player-top', 3 - me], ['player-bottom', me]].forEach(([id, c]) => {
      const el = $(id);
      const myTurn = live() && !g.result && g.stm === c;
      el.classList.toggle('turn', myTurn);
      let st = '';
      if (myTurn && isCPU(c) && S.thinking) st = `<span class="think"><i></i>考え中${S.cpuInfo && S.cpuInfo.depth ? `・深さ${S.cpuInfo.depth}` : ''}</span>`;
      else if (myTurn && isRemote(c)) st = S.online && NET && NET.status === 'on' && !S.online.oppPresent ? '<span class="think" style="color:var(--bad)">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      else if (myTurn) st = `<span class="think">${isHuman(c) && !S.online && isHuman(3 - c) ? '番です' : 'あなたの番'}</span>`;
      else if (g.result && live()) st = g.result.winner === c ? '<span class="won">勝ち</span>' : g.result.winner === 0 ? '<span>引き分け</span>' : '<span class="lost">負け</span>';
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : seatLabel(c);
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      const sub = `${SIDE[c]}・${c === BLACK ? '先手' : '後手'}${S.rule === 'renju' && c === BLACK ? '（禁手あり）' : ''}`;
      el.innerHTML = `<span class="stone ${c === BLACK ? 'b' : 'w'}"></span><div class="who"><span class="name">${nm} ${tag}</span><span class="sub">${sub}</span></div><div class="st">${st}</div>`;
    });
  }

  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const mini = c => `<span class="mini stone ${c === BLACK ? 'b' : 'w'}"></span>`;
  function renderSqInfo() {
    const el = $('sqinfo'), g = shownGame();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = g.stm, ply = shownPly(), last = ply ? g.moves[ply - 1] : -1;
    const lastTxt = last >= 0 ? `直前 ${MARK[ply % 2 ? BLACK : WHITE]}${ptName(last)}` : '';
    const fk = live() && S.hover >= 0 && !g.result ? g.forbiddenKind(S.hover) : 0;
    if (live() && S.pending >= 0) {
      cls += ' ask';
      html = `<span class="txt">${mini(c)}<b>${ptName(S.pending)}</b> に打ちますか？　<span class="muted">もう一度タップでも打てます</span></span>`;
      tools = btn('place', '打つ', ' primary') + `<button class="ibtn" data-act="unpend" aria-label="やめる" title="やめる">${CLOSE}</button>`;
    } else if (fk && humanTurn()) {
      cls += ' alert';
      html = `<span class="txt"><b>${ptName(S.hover)} は${R.FORBID_NAME[fk]}の禁手</b>　<span class="muted">黒はここに打てません</span></span>`;
    } else if (live() && S.hover >= 0 && humanTurn() && g.centerOnly() && S.hover !== CENTER) {
      html = `<span class="txt">1手目は天元（中央の <b>h8</b>）に打ちます</span>`;
    } else if (!live()) {
      cls += ' view';
      html = `<span class="txt"><b>${S.view}手目</b> ${last >= 0 ? MARK[S.view % 2 ? BLACK : WHITE] + ptName(last) : '（開始局面）'}</span>`;
      tools = btn('branch', 'ここから打つ') + btn('live', '最新へ', ' primary');
    } else if (g.result && S.online) {
      cls += ' result';
      const r = g.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === 0 ? '引き分け' : r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（黒白を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>（${esc(r.reason)}）</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (g.result) {
      cls += ' result';
      const r = g.result;
      html = `<span class="txt"><b>${r.winner === 0 ? '引き分け' : SIDE[r.winner] + 'の勝ち'}</b>（${esc(r.reason)}）</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' alert';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' alert';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else {
      // 四・三の知らせ（AI補助の「四・三を表示」がオンのとき）
      let note = '';
      if (settings.threat) {
        const op = 3 - c, to = g.threats(op), tm = g.threats(c);
        if (tm.five.length) { note = `<b>${SIDE[c]}は ${tm.five.map(ptName).join('・')} で五</b>`; cls += ' warn'; }
        else if (to.five.length && c === BLACK && S.rule === 'renju' && to.five.every(q => g.forbiddenKind(q))) { note = `<b>白の四！</b> 止める点 ${to.five.map(ptName).join('・')} は黒の禁手（止められない）`; cls += ' alert'; }
        else if (to.five.length) { note = `<b>${SIDE[op]}の四！</b> ${to.five.map(ptName).join('・')} で止める`; cls += ' alert'; }
        else if (tm.four.length) { note = `<b>${SIDE[c]}は ${tm.four.slice(0, 2).map(ptName).join('・')} で達四</b>（止められない四）`; cls += ' warn'; }
        else if (to.four.length) { note = `<b>${SIDE[op]}の三</b>（${to.four.slice(0, 3).map(ptName).join('・')} で達四）`; cls += ' warn'; }
      }
      let who = isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）が考えています` : isRemote(c) ? `${esc(S.online.opp.name)}さんの番です` : S.seats[3 - c] === 'human' && !S.online ? `${SIDE[c]}の番です` : `あなたの番です（${SIDE[c]}）`;
      if (humanTurn() && g.centerOnly()) who += '　1手目は天元（中央の h8）';
      html = `<span class="txt">${mini(c)}${note || who}　<span class="muted">${S.shukei && ply <= 3 ? `珠型 ${S.shukei}` : lastTxt}</span></span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ
  function renderTape() {
    const el = $('tape');
    if (!el) return;
    const cur = shownPly(), mv = S.game.moves;
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    mv.forEach((p, i) => {
      const bad = badMove(i);
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}${bad ? ' bad' : ''}"><span class="no">${i + 1}</span><span class="s stone ${i % 2 ? 'w' : 'b'}"></span>${ptName(p)}${bad ? '?' : ''}</button>`;
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
  // 打った側から見て勝率が大きく下がった手
  function badMove(i) {
    if (!settings.showEval) return false;
    const a = S.evals[i], b = S.evals[i + 1];
    if (a == null || b == null) return false;
    const d = (winP(b) - winP(a)) * (i % 2 ? -1 : 1);
    return d < -0.2;
  }

  function renderControls() {
    const g = S.game;
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-undo').disabled = !g.moves.length || !!S.online || (S.opening === 'shukei' && g.moves.length <= 3);
    $('btn-resign').disabled = !live() || !!g.result || ![BLACK, WHITE].some(isHuman);
    $('btn-hint').disabled = !humanTurn();
    $('btn-num').textContent = settings.num ? '手順の数字を消す' : '石に手順の数字';
    $('kifu-info').textContent = `${R.RULES[S.rule].name}・${S.shukei || R.OPENINGS[S.opening].name}・${g.moves.length}手`;
  }

  // ------------------------------------------------------------------ 形勢
  const winP = s => R.winRate(s, WP.scale);
  function evalText(sB) {
    if (R.isWin(sB)) {
      const n = Math.max(1, Math.ceil((R.WIN - Math.abs(sB)) / 2));
      return { num: '勝', lbl: `${sB > 0 ? '黒' : '白'}の勝ち（あと${n}手）` };
    }
    const p = winP(sB), a = Math.abs(p - 0.5), who = p > 0.5 ? '黒' : '白';
    return { num: `${Math.round(Math.max(p, 1 - p) * 100)}%`, lbl: a < 0.07 ? '互角' : who + (a < 0.18 ? 'やや有利' : a < 0.33 ? '有利' : '優勢') };
  }
  function renderEval() {
    const ply = shownPly(), g = shownGame();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sB = info ? info.scoreB : S.evals[ply];
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    const strip = (n, l, best) => { $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best; };
    if (sB == null || g.result) {
      $('ev-num').textContent = '—';
      $('ev-label').textContent = g.result ? '終局' : (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', $('ev-label').textContent, '');
      return;
    }
    const t = evalText(sB);
    $('ev-num').textContent = t.num; $('ev-label').textContent = t.lbl;
    setWR(winP(sB));
    let best = '';
    if (info && info.pv.length) {
      const pv = info.pv.slice(0, 14).map((p, k) => `${MARK[(ply + k) % 2 ? WHITE : BLACK]}${ptName(p)}`);
      $('pv').innerHTML = `<span class="k">${info.vcf ? '四追い' : '読み筋'}</span><span class="best">${pv[0]}</span> ${pv.slice(1).join(' ')}`;
      const nps = info.time ? Math.round(info.nodes / info.time * 1000) : 0;
      $('ev-meta').textContent = info.forced ? '' : `深さ ${info.depth} ・ ${(info.nodes || 0).toLocaleString()} 局面 ・ ${((info.time || 0) / 1000).toFixed(1)}秒${nps ? ` ・ ${nps.toLocaleString()} 局面/秒` : ''}`;
      if (info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${ptName(info.pv[0])}`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(t.num === '勝' ? t.lbl : t.num, t.num === '勝' ? '' : t.lbl, best);
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-bt').textContent = `黒 ${(p * 100).toFixed(1)}%`;
    $('wr-wt').textContent = `白 ${(100 - p * 100).toFixed(1)}%`;
    $('evalbar-fill').style.height = (p * 100).toFixed(1) + '%';
  }
  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.game.moves.length, 30);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.game.moves.length; i++) { const s = S.evals[i]; if (s != null) pts.push([x(i), y(winP(s))]); }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">黒</text><text x="3" y="${H - 4}">白</text>`;
    if (pts.length) {
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      html += `<polygon class="areab" points="${pts[0][0].toFixed(1)},${y(0.5)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0.5)}"/><polyline class="lineb" points="${line}"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    const cs = S.evals[shownPly()];
    if (cs != null) html += `<circle class="dot" cx="${cx}" cy="${y(winP(cs))}" r="3.5"/>`;
    svg.innerHTML = html;
  }
  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const rows = [`<li data-ply="0" class="start ${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span></span><span>開始局面${S.shukei ? `（珠型 ${esc(S.shukei)}）` : ''}</span><span class="ev"></span></li>`];
    S.game.moves.forEach((p, i) => {
      const s = S.evals[i + 1], bad = badMove(i);
      const ev = s != null && settings.showEval ? (R.isWin(s) ? (s > 0 ? '黒勝' : '白勝') : Math.round(winP(s) * 100) + '%') : '';
      rows.push(`<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span class="s stone ${i % 2 ? 'w' : 'b'}"></span><span>${ptName(p)}${bad ? ' ?' : ''}</span><span class="ev${bad ? ' bad' : ''}">${ev}</span></li>`);
    });
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.innerHTML = rows.join('');
    const c = el.querySelector('.cur');
    if (c && (atEnd || !live())) {
      const top = c.offsetTop, bottom = top + c.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  }

  // ------------------------------------------------------------------ 棋譜・操作
  function viewPly(p) {
    const n = S.game.moves.length;
    if (p >= n) { S.view = null; S.vgame = null; }
    else { S.view = Math.max(0, p); S.vgame = R.Game.fromMoves(gameOpts(), S.game.moves.slice(0, S.view)); }
    S.info = null; S.pending = -1;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }
  function undo() {
    const g = S.game;
    if (!g.moves.length || S.online) return;
    AI.cancel(); clearTimeout(S.timer);
    S.view = null; S.vgame = null;
    const keep = S.opening === 'shukei' ? 3 : 0;
    let n = g.moves.length - 1;
    if ([BLACK, WHITE].some(isHuman)) while (n > keep && isCPU(n % 2 ? WHITE : BLACK)) n--;
    if (n < keep) return;
    rebuild(n);
    afterChange();
  }
  function rebuild(n) {
    const mv = S.game.moves.slice(0, n);
    S.game = R.Game.fromMoves(gameOpts(), mv);
    S.evals.length = Math.min(S.evals.length, n + 1);
    S.resultShown = false;
  }
  function resign() {
    const g = S.game;
    if (!live() || g.result) return;
    const humans = [BLACK, WHITE].filter(isHuman);
    const loser = humans.includes(g.stm) ? g.stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    g.result = { winner: 3 - loser, reason: `${SIDE[loser]}の投了` };
    if (S.online && NET) { NET.send({ t: 'resign' }); NET.saveState({ moves: g.moves, r: 1 }); }
    afterChange();
  }
  function branch() {
    if (live()) return;
    AI.cancel();
    const n = S.view;
    S.view = null; S.vgame = null;
    rebuild(n);
    afterChange();
  }
  function kifuText() {
    const g = S.game;
    const lines = [`連珠 棋譜（${R.RULES[S.rule].name}・${R.OPENINGS[S.opening].name}）`, `黒：${seatLabel(BLACK)} / 白：${seatLabel(WHITE)}`];
    if (S.shukei) lines.push(`珠型：${S.shukei}`);
    g.moves.forEach((p, i) => lines.push(`${i + 1} ${ptName(p)}`));
    if (g.result) lines.push(g.result.winner === 0 ? `まで 引き分け（${g.result.reason}）` : `まで ${SIDE[g.result.winner]}の勝ち（${g.result.reason}）`);
    return lines.join('\n');
  }
  function importKifu(text) {
    const head = text.match(/連珠 棋譜（(連珠|自由)・([^）]+)）/);
    const rule = head && head[1] === '自由' ? 'free' : 'renju';
    const opening = head ? (Object.keys(R.OPENINGS).find(k => R.OPENINGS[k].name === head[2]) || 'any') : 'any';
    const body = text.split(/\r?\n/).filter(l => !/棋譜|^黒：|^まで/.test(l)).join(' ');
    const pts = (body.match(/\b[a-oA-O](1[0-5]|[1-9])\b/g) || []).map(R.parsePt);
    if (!pts.length) throw new Error('手（h8 のような書き方）が見つかりません');
    const g = new R.Game({ rule, opening: opening === 'shukei' ? 'any' : opening });
    pts.forEach((p, i) => { if (!g.isLegal(p)) throw new Error(`${i + 1}手目 ${ptName(p)} は打てません`); g.play(p); });
    const res = text.match(/まで (黒|白)の勝ち（([^）]+)）/);
    loadGame({ rule, opening: opening === 'shukei' ? 'any' : opening, seats: [null, 'human', 'human'], moves: pts, result: res && !g.result ? { winner: res[1] === '黒' ? BLACK : WHITE, reason: res[2] } : null });
  }

  // ------------------------------------------------------------------ ダイアログ
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    $('ng-start').focus();
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['black', '黒（先手）'], ['white', '白（後手）'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    seg('ng-rule', Object.keys(R.RULES).map(k => [k, k === 'renju' ? '連珠（禁手あり）' : '自由（禁手なし）']), draft.rule);
    seg('ng-open', Object.keys(R.OPENINGS).map(k => [k, R.OPENINGS[k].name]), draft.opening);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
    $('ng-rule-hint').textContent = R.RULES[draft.rule].desc + (draft.rule === 'free' ? '（先手の黒がかなり有利です）' : '');
    $('ng-open-hint').textContent = R.OPENINGS[draft.opening].desc;
  }
  // CPU との対局の戦績（この端末に保存）。AI補助・ヒントを使った対局は別に数える
  function cpuOf() {
    const humans = [BLACK, WHITE].filter(isHuman);
    if (S.online || humans.length !== 1 || !isCPU(3 - humans[0])) return null;
    return { human: humans[0], level: S.seats[3 - humans[0]], key: S.seats[3 - humans[0]] + (S.rule === 'free' ? '-free' : '') };
  }
  function recordResult() {
    const c = cpuOf(), r = S.game.result;
    if (!c || !r || S.game.moves.length < 6) return;
    const recs = store.get('record', {}), e = recs[c.key] || { n: [0, 0, 0], a: [0, 0, 0] };
    (S.assisted ? e.a : e.n)[r.winner === 0 ? 2 : r.winner === c.human ? 0 : 1]++;
    recs[c.key] = e;
    store.set('record', recs);
  }
  const recText = a => `${a[0]}勝${a[1]}敗${a[2] ? a[2] + '分' : ''}`;
  function showResult() {
    const r = S.game.result;
    if (!r) return;
    const humans = [BLACK, WHITE].filter(isHuman);
    let title = r.winner === 0 ? '引き分け' : `${SIDE[r.winner]}の勝ち`;
    if (humans.length === 1 && r.winner) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${R.RULES[S.rule].name}・${S.game.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.online ? `相手は ${S.online.opp.name} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[3 - humans[0]]].label}）でした。` : '';
    const c = cpuOf(), e = c ? store.get('record', {})[c.key] : null;
    const tally = e ? `${CPU[c.level].label}との通算（${R.RULES[S.rule].name}）: AI補助なし ${recText(e.n)}${e.a.some(x => x) ? `・あり ${recText(e.a)}` : ''}` : '';
    $('rs-body').textContent = `${r.reason}。${opp}${tally ? '\n' + tally : ''}`;
    $('rs-body').style.whiteSpace = 'pre-line';
    $('rs-again').textContent = S.online ? 'もう一局（黒白を交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI ページ
  // 小さな図: rows の x = 黒、o = 白、* = 禁手の点（×）、+ = 打つ点の印
  function diagram(rows, note) {
    const h = rows.length, w = rows[0].replace(/\s/g, '').length, cs = 24, pad = 16;
    let s = `<svg viewBox="0 0 ${w * cs + pad * 2 - cs} ${h * cs + pad * 2 - cs}" role="img" aria-label="${esc(note || '図')}"><rect width="100%" height="100%" fill="url(#mwood)"/>`;
    s = s.replace('url(#mwood)', 'var(--wood)');
    for (let y = 0; y < h; y++) s += `<line x1="${pad}" y1="${pad + y * cs}" x2="${pad + (w - 1) * cs}" y2="${pad + y * cs}" stroke="var(--wood-line)" stroke-width="1" opacity=".75"/>`;
    for (let x = 0; x < w; x++) s += `<line x1="${pad + x * cs}" y1="${pad}" x2="${pad + x * cs}" y2="${pad + (h - 1) * cs}" stroke="var(--wood-line)" stroke-width="1" opacity=".75"/>`;
    rows.forEach((row, y) => row.replace(/\s/g, '').split('').forEach((ch, x) => {
      const cx = pad + x * cs, cy = pad + y * cs;
      if (ch === 'x') s += `<circle cx="${cx}" cy="${cy}" r="10.5" fill="#151515"/>`;
      else if (ch === 'o') s += `<circle cx="${cx}" cy="${cy}" r="10.5" fill="#f6f2e8" stroke="#a89e86" stroke-width="1"/>`;
      else if (ch === '*') s += `<path d="M${cx - 6} ${cy - 6}L${cx + 6} ${cy + 6}M${cx + 6} ${cy - 6}L${cx - 6} ${cy + 6}" stroke="#b3321c" stroke-width="3" stroke-linecap="round"/>`;
      else if (ch === '+') s += `<circle cx="${cx}" cy="${cy}" r="7" fill="none" stroke="#2e9a5a" stroke-width="3"/>`;
    }));
    return s + '</svg>';
  }
  function renderRules() {
    const fig = (rows, title, text) => `<div class="fig">${diagram(rows, title)}<b>${title}</b><span>${text}</span></div>`;
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>15×15 の盤の交点に、<b>黒から</b>交互に石を1つずつ打ちます。打った石は動かしません。</li>
          <li>縦・横・斜めのどれかに自分の石を<b>5つ並べたら勝ち</b>（五）。</li>
          <li>連珠では、先手の黒が有利すぎないように、黒にだけ<b>禁手</b>（打ってはいけない点）があります。黒は<b>ちょうど5つ</b>で勝ち、白は5つ以上（6つ以上の長連も）で勝ちです。</li>
          <li>このアプリでは、黒の番に禁手の点を<b>×</b>で示し、打てないようにしています。</li>
          <li>盤が埋まったら引き分けです。</li>
          <li>「自由」ルールは禁手なし・黒白とも5つ以上で勝ち（いわゆる五目並べ）。先手がかなり有利です。</li>
        </ul>
      </div>
      <div class="card" data-tab="禁手">
        <h3>黒の禁手（× の点）</h3>
        <div class="figs">
          ${fig(['. . . . . .', '. x . . . .', '. . x . . .', '. . . * x x', '. . . . . .'], '三三', '1手で三が2つできる')}
          ${fig(['. . x . . .', '. . x . . .', '. . x . . .', '. . * x x x', '. . . . . .'], '四四', '1手で四が2つできる')}
          ${fig(['. . . . . . . .', 'x . x * x . x .', '. . . . . . . .'], '四四（一直線）', '同じ線の上でも四が2つ')}
          ${fig(['. . . . . . . .', 'x x * x x x . .', '. . . . . . . .'], '長連', '6つ以上並ぶ')}
          ${fig(['. . x . . .', '. . x . . .', '. . x . . .', '. . + x x .', '. . . . . .'], '四三（打てる）', '四と三が同時は禁手ではない。黒の必勝形')}
          ${fig(['. . x . . . .', '. . x . . . .', '. . x . . . .', '. . x . . . .', 'x x + x x . .'], '五が優先（打てる）', '五ができれば、同時に長連や三三でも勝ち')}
        </div>
        <p class="hint">「三」は、あと1手で<b>達四</b>（両端どちらでも五になる四）にできる形のこと。達四にする点そのものが禁手なら、その三は「偽の三」で数えません（このアプリはこの判定もルールどおりに行います）。</p>
      </div>
      <div class="card" data-tab="用語">
        <h3>用語</h3>
        <ul>
          <li><b>四</b>：あと1手で五になる形。相手は必ず止めなければなりません。</li>
          <li><b>達四</b>：五になる点が2つある四（・●●●●・）。止められないので、作れば勝ち。</li>
          <li><b>三</b>：あと1手で達四になる形（・●●●・ や ・●・●●・）。放っておくと達四にされます。</li>
          <li><b>四三</b>：1手で四と三を同時に作ること。四を止めると三が達四になるので勝ち。</li>
          <li><b>四追い（VCF）</b>：四を打ち続けて、最後に四三や達四で勝つ手順。</li>
          <li><b>禁手追い込み</b>：白が、黒が止めなければならない点を禁手にして勝つこと。</li>
        </ul>
        <p class="hint">AI補助の「四・三を表示」をオンにすると、盤の上の四（実線の輪＝五になる点）と三（点線の輪＝達四になる点）を色で示します。黒は朱、白は藍。</p>
      </div>
      <div class="card" data-tab="打ち始め">
        <h3>打ち始め</h3>
        <ul>
          <li><b>天元から</b>：1手目は盤の中央（天元・h8）。連珠の決まりです。</li>
          <li><b>珠型</b>：2手目を天元の隣、3手目を中央の 5×5 に打った形は、回したり裏返したりして同じものを除くと26通り（直接打ち13・間接打ち13）。そのうち1つをくじ引きで選び、4手目（白）から始めます。</li>
          <li><b>自由に</b>：1手目からどこでも。</li>
        </ul>
        <p class="hint">公式の大会では、さらに「交替打ち」などの開局規定で黒白の有利不利をならしますが、このアプリでは使っていません。</p>
      </div>`;
    docTabs($('view-rules'), 'rules');
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
      document.querySelector('main').scrollTop = 0;
    };
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
    show(Math.min(store.get('doctab-' + key, 0), cards.length - 1));
  }

  function recordCard() {
    const recs = store.get('record', {});
    const rows = [];
    for (const rule of ['renju', 'free']) for (const k of CPU_KEYS) {
      const e = recs[k + (rule === 'free' ? '-free' : '')];
      if (!e) continue;
      rows.push(`<tr><td>${CPU[k].label}</td><td>${R.RULES[rule].name}</td><td>${recText(e.n)}</td><td>${recText(e.a)}</td></tr>`);
    }
    return `<div class="card" data-tab="あなたの戦績">
      <h3>あなたと CPU の戦績</h3>
      ${rows.length ? `<div class="tbl"><table class="lv"><thead><tr><th>CPU</th><th>ルール</th><th>AI補助なし</th><th>AI補助・ヒントあり</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p>まだ CPU と対局していません。</p>'}
      <p class="hint">この端末に保存しています（6手未満で終わった対局は数えません）。対局中に AI補助やヒントを一度でも使った対局は「あり」に数えます。</p>
    </div>`;
  }
  function renderAIPage() {
    const hist = WRAW.history || [];
    const gen = WRAW.gen || 0, games = WRAW.totalGames || 0;
    const ms = (WRAW.measures || []).filter(m => (m.vs || '初期版') === '初期版').slice(-40);
    const bw = 600, bh = 170, pad = 30;
    let chart = '';
    if (ms.length) {
      const top = Math.max(100, ...ms.map(m => m.elo + (m.err || 0))), bot = Math.min(0, ...ms.map(m => m.elo - (m.err || 0)));
      const gMin = ms[0].gen, gMax = ms[ms.length - 1].gen;
      const X = g => pad + (gMax === gMin ? 0.5 : (g - gMin) / (gMax - gMin)) * (bw - pad - 16), Y = e => bh - 20 - (e - bot) / (top - bot) * (bh - 34);
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さ（初期版との Elo 差）">
        ${[bot, (bot + top) / 2, top].map(t => Math.round(t)).map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t > 0 ? '+' : ''}${t}</text>`).join('')}
        ${ms.length > 1 ? `<polyline points="${ms.map(m => `${X(m.gen).toFixed(1)},${Y(m.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--gold)" stroke-width="2"/>` : ''}
        ${ms.map(m => `<line x1="${X(m.gen)}" x2="${X(m.gen)}" y1="${Y(m.elo - (m.err || 0))}" y2="${Y(m.elo + (m.err || 0))}" stroke="var(--gold)" stroke-width="1.5"/><circle cx="${X(m.gen)}" cy="${Y(m.elo)}" r="4" fill="var(--gold)"><title>第${m.gen}世代: ${esc(m.vs || '初期版')}に勝率${(m.score * 100).toFixed(1)}%（Elo ${m.elo >= 0 ? '+' : ''}${m.elo}±${m.err}、${m.games}局）</title></circle><text x="${X(m.gen)}" y="${Y(m.elo) - 9}" text-anchor="middle" fill="var(--ink)" font-size="10">${m.elo >= 0 ? '+' : ''}${m.elo}</text>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${gMin}世代</text>${gMax !== gMin ? `<text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${gMax}世代</text>` : ''}
      </svg>`;
    }
    const last = ms[ms.length - 1];
    const nnm = NNRAW && NNRAW.measures ? NNRAW.measures : [];
    const nnRows = nnm.length ? `<div class="tbl" style="margin-top:10px"><table class="lv"><thead><tr><th>ネットの世代</th><th>相手</th><th>1手</th><th>勝率</th><th>Elo 差</th></tr></thead><tbody>${nnm.slice(-8).map(m => `<tr><td>第${m.gen}世代</td><td>${esc(m.vs)}</td><td>${m.timeMs ? m.timeMs + 'ms' : (m.nodes || '') + '局面'}</td><td>${(m.score * 100).toFixed(1)}%</td><td>${m.elo >= 0 ? '+' : ''}${m.elo}±${m.err}（${m.games}局）</td></tr>`).join('')}</tbody></table></div>` : '';
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>このAIの強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習世代</span></div>
          <div class="stat"><b>${games.toLocaleString()}</b><span>自己対局（累計局数）</span></div>
          ${last ? `<div class="stat"><b>${last.elo >= 0 ? '+' : ''}${last.elo}</b><span>${esc(last.vs || '初期版')}との直接対戦の Elo 差（±${last.err}・${last.games}局）</span></div>` : ''}
        </div>
        ${chart ? `<p class="hint" style="margin:14px 0 6px">世代ごとに、学習前の初期版（自分で決めた素朴な重み）と黒白を入れ替えて対戦したときの Elo 差。縦線は誤差の目安。</p>${chart}` : '<p>まだ学習していません（いまは学習前の初期版です）。</p>'}
        ${NNRAW ? `<p class="hint" style="margin:14px 0 4px"><b>ネットの評価</b>（第${NNRAW.gen || 0}世代・自己対局 ${(NNRAW.totalGames || 0).toLocaleString()}局）：「つよい」「最強」と検討が使います。下は、線形の評価（上のグラフの重み）と同じ考える時間で対戦したときの結果。</p>${nnRows}` : ''}
      </div>
      ${recordCard()}
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>全部自作</b>：既存の連珠・五目並べのソフト、人間の棋譜、定石集は使っていません。ルールの知識だけから作り、AI どうしの対局（自己対局）だけで強くしています。</li>
          <li><b>形の表</b>：石を置いたとき、縦・横・斜めの前後5マスの並び（約6万通り）から「五・四・達四・三…」を表で引きます。三・四の定義はルールのとおりに計算して作った表です。</li>
          <li><b>脅威の探索</b>：相手の四は必ず止める、相手に三があれば防ぐ手か自分の四だけを読む、四を打ち続けて勝つ手順（四追い）を探す、という連珠の決まりごとを使って、読む手を大きく絞ります。</li>
          <li><b>評価と手の順番</b>：各マスの「4方向の形の組（1365通り）」ごとの重みの和。重みは自己対局の勝ち負けと、深く読んだときに選んだ手から学習します。</li>
          <li><b>探索</b>：αβ探索（反復深化・置換表・手の順番での枝刈り）。「最強」は複数のスレッドで同じ局面を読みます。</li>
        </ul>
        <table class="lv wide-only" style="margin-top:8px"><thead><tr><th>CPUの強さ</th><th>1手の考える時間</th><th>特徴</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].time / 1000}秒</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') fitBoardSoon();
    }));
    const svg = $('board');
    svg.addEventListener('click', e => { const p = pointAt(e); if (p >= 0) { S.cursor = -1; onPoint(p); } });
    svg.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      const p = pointAt(e);
      if (p !== S.hover) { S.hover = p; renderBoard(); renderSqInfo(); }
    });
    svg.addEventListener('pointerleave', () => { if (S.hover >= 0) { S.hover = -1; renderBoard(); renderSqInfo(); } });
    // キーボード: 盤を選んで矢印で印を動かし、Enter で打つ
    svg.addEventListener('keydown', e => {
      const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -N, ArrowDown: N }[e.key];
      if (mv) {
        e.preventDefault(); e.stopPropagation();
        if (S.cursor < 0) S.cursor = CENTER;
        else { const x = S.cursor % N + (mv === -1 ? -1 : mv === 1 ? 1 : 0), y = ((S.cursor / N) | 0) + (mv === -N ? -1 : mv === N ? 1 : 0); if (x >= 0 && x < N && y >= 0 && y < N) S.cursor = y * N + x; }
        S.hover = S.cursor; renderBoard(); renderSqInfo();
      } else if ((e.key === 'Enter' || e.key === ' ') && S.cursor >= 0) { e.preventDefault(); e.stopPropagation(); if (humanTurn() && S.game.isLegal(S.cursor)) play(S.cursor); }
    });
    svg.addEventListener('blur', () => { if (S.cursor >= 0) { S.cursor = -1; renderBoard(); } });
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'place' && S.pending >= 0) play(S.pending);
      else if (act === 'unpend') { S.pending = -1; renderBoard(); renderSqInfo(); }
      else if (act === 'live') viewPly(S.game.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.game.result) { S.game.result = { winner: S.online.myColor, reason: '相手の接続切れ' }; afterChange(); }
      else if (act === 'again') startGame(cfg);
    });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      e.stopPropagation();
      const nav = b.dataset.nav;
      if (nav === 'first') viewPly(0);
      else if (nav === 'prev') viewPly(shownPly() - 1);
      else if (nav === 'next') viewPly(shownPly() + 1);
      else if (nav === 'last') viewPly(S.game.moves.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet('kifu'); }
      else if (b.dataset.ply != null) viewPly(Number(b.dataset.ply));
    });
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('best', on, true); setSetting('threat', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'graph' : 'kifu'));
    $('btn-num').addEventListener('click', () => setSetting('num', !settings.num));
    window.addEventListener('resize', () => { fitBoardSoon(); if ($('side').classList.contains('open')) placeSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const segEl = b.closest('[data-seg]');
      if (segEl) { lobby[segEl.dataset.seg] = b.dataset.v; renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { lobby.msg = ''; NET.wait({ ru: lobby.ru, op: lobby.op }, condText(lobby.ru, lobby.op)); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('best', on, true); setSetting('threat', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); }
    });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.game.result && !confirm('オンライン対局の途中です。新しい対局を始めると投了になります。よろしいですか？')) return;
      if (S.online && !S.game.result) resign();
      openNew();
    });
    $('btn-undo').addEventListener('click', undo);
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
      // 盤の外をタップしたら仮置きをやめる
      if (S.pending >= 0 && !e.target.closest('#board, #sqinfo')) { S.pending = -1; renderBoard(); renderSqInfo(); }
    });
    $('btn-resign').addEventListener('click', resign);
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      S.assisted = true;
      if (S.online && NET) { S.online.myHints++; NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      const ply = S.game.moves.length, c = S.game.stm;
      AI.start({ rule: S.rule, moves: S.game.moves.slice(), centerOnly: S.opening !== 'any', timeMs: HINT_MS, analyze: true, parallel: true, nn: false, nnMode: NN_MODE },
        info => onInfo(ply, c, info, 'hint'), info => onInfo(ply, c, info, 'hint'));
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    $('settings').addEventListener('click', e => e.stopPropagation());
    [['set-eval', 'showEval'], ['set-best', 'best'], ['set-threat', 'threat'], ['set-num', 'num'], ['set-sound', 'sound'], ['set-analyze', 'analyze']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    const drawConfirm = () => { $('set-confirm').innerHTML = [['auto', 'タッチのとき'], ['always', 'いつも'], ['never', 'しない']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${settings.confirm === v}">${l}</button>`).join(''); };
    drawConfirm();
    $('set-confirm').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setSetting('confirm', b.dataset.v); drawConfirm(); } });
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    $('evstrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ev'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
    });
    document.querySelector('.evoff-card button').addEventListener('click', () => setSetting('showEval', true));
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewPly(Number(li.dataset.ply)); });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.game.moves.length, 30);
      viewPly(Math.max(0, Math.min(S.game.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    $('btn-copy').addEventListener('click', () => {
      const text = kifuText(), msg = $('copy-msg');
      const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.rows = 6; ta.style.width = '100%'; msg.innerHTML = ''; msg.appendChild(ta); ta.select(); };
      try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); }, fallback); } catch (e) { fallback(); }
    });
    $('btn-import').addEventListener('click', () => { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); });
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => {
      try { importKifu($('im-text').value); $('dlg-import').hidden = true; } catch (err) { $('im-msg').textContent = err.message; }
    });
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-rule') draft.rule = v;
        else if (id === 'ng-open') draft.opening = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) $('dlg-new').hidden = true;
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) requestRematch(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); ['dlg-new', 'dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.pending >= 0) { S.pending = -1; renderBoard(); renderSqInfo(); } return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent || e.target === $('board')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.game.moves.length); }
    });
  }

  // ------------------------------------------------------------------ オンライン対戦（../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && window.SSIHOnline.available();
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/renju/';
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { ru: cfg.rule, op: cfg.opening === 'shukei' ? 'shukei' : 'tengen', msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.best ? 2 : 0) | (settings.threat ? 4 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? '最善手' : '', f & 4 ? '四・三の表示' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }
  const condText = (ru, op) => `${R.RULES[ru] ? R.RULES[ru].name : '？'}・${R.OPENINGS[op] ? R.OPENINGS[op].name : '？'}`;
  // 珠型は対局ID から決める（両方の画面で同じ形になる）
  function shukeiFor(mid) {
    let h = 2166136261;
    for (const ch of String(mid)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    let s = h >>> 0 || 1;
    return R.randomShukei(() => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; });
  }

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: 'renju',
      onStatus: st => {
        renderOnlineBadge(); renderLobby();
        if (S.online) { if (st === 'on') S.online.lostAt = S.online.oppPresent ? 0 : Date.now(); renderSqInfo(); renderPlayers(); }
      },
      onPresence: () => { renderOnlineBadge(); renderLobby(); tryRoom(); },
      onMatch: g => startOnline(g),
      onRemote: m => onRemote(m),
      onOppPresence: p => { if (S.online) { S.online.oppPresent = p; S.online.lostAt = p ? 0 : Date.now(); renderSqInfo(); renderPlayers(); } },
      onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
    });
    NET.setName(myName);
    NET.setAI(aiFlags());
    NET.connect();
    setInterval(() => { if (S.online && !S.online.oppPresent) renderSqInfo(); }, 10000);
    return NET;
  }

  function startOnline(g) {
    $('dlg-online').hidden = true;
    const r = g.r || {};
    const ru = R.RULES[r.ru] ? r.ru : 'renju', op = r.op === 'shukei' ? 'shukei' : 'tengen';
    const online = { mid: g.mid, myColor: g.myColor ? WHITE : BLACK, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false, cond: { ru, op } };
    const seats = online.myColor === BLACK ? [null, 'human', 'remote'] : [null, 'remote', 'human'];
    let moves = [], shukei = '';
    if (op === 'shukei') { const s = shukeiFor(g.mid); moves = s.moves; shukei = s.name; }
    loadGame({ rule: ru, opening: op, seats, moves, shukei, online });
    clack(false);
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    if (S.online) { S.online = null; S.seats = S.seats.map(x => (x === 'remote' ? 'human' : x)); }
  }
  // 相手から届いたもの: あいさつ（名前・AI補助）、指し手、今の状態、投了、AI補助の変更、ヒント、もう一局
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      saveGame(); renderPlayers(); renderSqInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.game.moves.length + 1) applyRemote([msg.p | 0]); }
    else if (msg.t === 'state' && Array.isArray(msg.moves)) {
      const mv = S.game.moves;
      for (let i = 0; i < Math.min(msg.moves.length, mv.length); i++) if ((msg.moves[i] | 0) !== mv[i]) return; // 食い違うものは使わない
      applyRemote(msg.moves.slice(mv.length).map(x => x | 0));
    } else if (msg.t === 'resign') {
      if (!S.game.result) { S.game.result = { winner: o.myColor, reason: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.mid === 'string') {
      NET.start({ mid: msg.mid.slice(0, 20), myColor: msg.oc ? 1 : 0, r: o.cond, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  function applyRemote(list) {
    for (const p of list) {
      if (S.game.result || !isRemote(S.game.stm) || !S.game.isLegal(p)) break;
      if (S.view !== null) { S.view = null; S.vgame = null; }
      play(p, true);
    }
  }
  function requestRematch() {
    const o = S.online;
    if (!o || !NET) return;
    o.myRe = true;
    NET.send({ t: 're' });
    maybeRematch();
    renderSqInfo();
  }
  function maybeRematch() {
    const o = S.online;
    if (!o || !o.myRe || !o.oppRe || !NET || !NET.game) return;
    const oppId = NET.game.oppId;
    if (oppId && NET.id > oppId) return; // 相手が作るのを待つ
    const mid = Math.random().toString(36).slice(2, 12);
    const oc = o.myColor === WHITE ? 1 : 0;
    NET.send({ t: 'rego', mid, oc });
    NET.start({ mid, myColor: oc ^ 1, r: o.cond, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.g === 'renju' && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null;
    history.replaceState(null, '', location.pathname);
    lobby.msg = `${p.n}さんに申し込みました…`;
    NET.challenge(p.id);
    renderLobby();
  }
  function openOnline() {
    if (!ONLINE_OK) {
      lobby.msg = '';
      $('dlg-online').hidden = false;
      $('on-body').innerHTML = window.SSIH_ONLINE_MISSING
        ? `<p>オンラインの部品（common/online.js）を読み込めませんでした。公開版のサイトから開いてください。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`
        : `<p>ここではオンライン対戦につなげません。公開版のサイトで遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
      return;
    }
    net();
    $('dlg-online').hidden = false;
    renderLobby();
  }
  function renderOnlineBadge() {
    const b = $('btn-online');
    if (!b) return;
    const st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null;
    const g = c && c.byGame && c.byGame.renju ? c.byGame.renju : null;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', c = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const gc = c && c.byGame && c.byGame.renju ? c.byGame.renju : { online: 0, wait: 0, play: 0 };
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === 'renju') : [];
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join('')}</div>`;
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全体）</span></div>
        <div class="stat"><b>${num(gc.wait)}</b><span>連珠の対戦待ち</span></div>
        <div class="stat"><b>${num(Math.round(gc.play / 2))}</b><span>連珠の対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・最善手・四と三の表示を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b><span class="hint">${esc(p.r ? condText(p.r.ru, p.r.op) : p.rl || '')}</span>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「この設定で待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span><b>${esc(me.rl)}</b>で待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `${seg('ru', [['renju', '連珠（禁手あり）'], ['free', '自由（禁手なし）']], lobby.ru)}${seg('op', [['tengen', '天元から'], ['shukei', '珠型']], lobby.op)}
             <div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>この設定で待つ</button></div>`}
      </div>
      <p class="hint on-note">黒白は対局が始まるときにランダムに決まります。公開の中継サーバーを使うため、名前と手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // 振り返りパネル: 狭い画面だけ。盤のすぐ下から画面の下までを覆う
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function placeSheet() {
    const fr = $('board-wrap').getBoundingClientRect(), h = window.innerHeight;
    const top = landscape() ? h * 0.12 : Math.min(h * 0.68, Math.max(h * 0.3, fr.bottom + 6));
    $('side').style.setProperty('--sheet-top', Math.round(top) + 'px');
  }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && (tab === 'ev' || tab === 'graph')) tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return;
    placeSheet();
    side.classList.add('open');
    renderKifu(); renderGraph();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', best: 'set-best', threat: 'set-threat', num: 'set-num', sound: 'set-sound', analyze: 'set-analyze' }[k];
    if (box && $(box)) $(box).checked = v;
    if (quiet) return;
    if (NET) NET.setAI(aiFlags());
    if (['analyze', 'showEval', 'best', 'threat'].includes(k) && !S.thinking && isHuman(S.game.stm)) analyze();
    render();
  }

  bind();
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && R.RULES[saved.rule] && Array.isArray(saved.moves)) {
    try {
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; saved.seats = saved.seats.map(x => (x === 'remote' ? 'human' : x)); }
      if (saved.online) saved.online = Object.assign({ myHints: 0, cond: { ru: saved.rule, op: saved.opening } }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false });
      loadGame(saved);
      if (S.online && NET) NET.rejoin({ mid: S.online.mid, myColor: S.online.myColor === WHITE ? 1 : 0, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } });
    } catch (e) { startGame(cfg); }
  } else {
    startGame(cfg);
    openNew();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBoardSoon);
})();
