/* リバーシ Webアプリ: 盤面UI・CPU（Web Worker）・AI補助・オンライン対戦 */
(function () {
  'use strict';
  const R = {};
  ReversiCore(R);
  ReversiAI(R);
  const { Position, BLACK, WHITE, PASS } = R;
  const $ = id => document.getElementById(id);
  const SIDE = ['黒', '白'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // 学習した評価関数（js/weights.js）。展開した表は CPU のワーカーにも渡す
  const WT = (typeof REVERSI_WEIGHTS !== 'undefined' && REVERSI_WEIGHTS) ? REVERSI_WEIGHTS : null;
  const EV = R.makeEval(WT);
  // ProbCut の表（js/mpc.js）。重みに入っていなければ別のファイルから
  if (!EV.mpc && typeof REVERSI_MPC !== 'undefined' && !EV.empty) EV.mpc = R.makeMPC(REVERSI_MPC);

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'すぐ打ちます。1手先だけを気まぐれに見ます', time: 300, depth: 1, noise: 1600 },
    normal: { label: 'ふつう', stars: 2, desc: '2手先まで読みます（ときどき迷います）', time: 600, depth: 2, noise: 900 },
    strong: { label: 'つよい', stars: 3, desc: '1手1.5秒。残り18マスから最後まで読み切ります', time: 1500, solveAt: 18 },
    max: { label: '最強', stars: 4, desc: '1手6秒・全スレッド。残り20マスから最後まで読み切り、22マスから勝ち負けを読み切ります', time: 6000, solveAt: 20, wldAt: 22, parallel: true },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 5000, HINT_MS = 2500;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('reversi-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('reversi-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong' }, store.get('cfg', {}));
  if (!CPU[cfg.cpu]) cfg.cpu = 'normal';
  // AI補助: showEval = 形勢、best = 最善手の印、nums = 置ける場所ごとの評価値
  const settings = Object.assign({ sound: true, anim: true, moves: true, analyze: true, showEval: true, best: true, nums: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.best || settings.nums;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    seats: ['human', 'normal'], moves: [], hist: [new Position()], evals: [], view: null, result: null,
    info: null, cpuInfo: null, thinking: false, timer: 0, hover: -1, resultShown: false,
    online: null, // { mid, myColor, opp: {name, ai, hints}, myHints, oppPresent, lostAt, myRe, oppRe }
  };
  const live = () => S.view === null;
  const shownPly = () => (live() ? S.moves.length : S.view);
  const shownPos = () => S.hist[shownPly()];
  const curPos = () => S.hist[S.moves.length];
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (S.seats[c ^ 1] !== 'human' ? 'あなた' : '人間'));
  const humanTurn = () => live() && !S.result && isHuman(curPos().stm);

  // ------------------------------------------------------------------ CPU（Web Worker）
  function workerMain() {
    const R = {};
    ReversiCore(R);
    ReversiAI(R);
    let S = null, helper = 0, lastNoise = 0;
    const pack = r => ({ move: r.move, score: r.score, depth: r.depth, exact: r.exact, wld: r.wld, pv: r.pv, nodes: r.nodes, time: r.time, scores: r.scores });
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') { helper = j.helper || 0; S = new R.Searcher(j.ev, { sharedTT: j.tt, stopFlag: j.flag, helper, ttBits: 20 }); return; }
      const pos = R.Position.fromMoves(j.moves);
      // 評価にわざと揺らぎを入れる弱い CPU のあとは、置換表に残った雑な読みを捨てる
      if ((j.noise || 0) !== lastNoise) { S.clearTT(); lastNoise = j.noise || 0; }
      const onInfo = helper ? null : info => self.postMessage({ id: j.id, type: 'info', info: pack(info) });
      const r = S.think(pos, { timeMs: j.timeMs, maxDepth: j.maxDepth, solveAt: j.solveAt, wldAt: j.wldAt, noise: j.noise, multi: !helper && j.multi, analyze: j.analyze, jobId: j.id, onInfo });
      self.postMessage({ id: j.id, type: 'done', info: pack(r) });
    };
  }
  // ページが共有メモリを使える状態（start.bat のサーバや COOP/COEP 付きの公開先）なら、複数のワーカーが置換表を共有して読む（Lazy SMP）
  const SMP = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const THREADS = SMP ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const AI = {
    pool: [], id: 0, busy: false, fallback: null,
    tt: SMP ? R.makeTT(21, true) : null,
    flag: SMP ? new SharedArrayBuffer(4) : null,
    ev: (() => {
      if (!SMP) return EV;
      const T = new Int16Array(new SharedArrayBuffer(EV.T.length * 2)); T.set(EV.T);
      return { T, SB: EV.SB, empty: EV.empty, mob: EV.mob, mpc: EV.mpc };
    })(),
    make(i) {
      try {
        const src = ReversiCore.toString() + '\n' + ReversiAI.toString() + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', ev: this.ev, tt: this.tt, flag: this.flag, helper: i });
        return w;
      } catch (e) {
        return null; // Worker が使えない環境ではメインスレッドで考える
      }
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
        setTimeout(() => {
          if (id !== this.id) return;
          if (!this.fallback) this.fallback = new R.Searcher(EV, { ttBits: 18 });
          finish(this.fallback.think(Position.fromMoves(job.moves), { timeMs: Math.min(job.timeMs, 1200), maxDepth: job.maxDepth, solveAt: Math.min(16, job.solveAt == null ? 16 : job.solveAt), noise: job.noise, multi: job.multi, analyze: job.analyze }));
        }, 30);
        return;
      }
      if (this.flag) Atomics.store(new Int32Array(this.flag), 0, id);
      const msg = { type: 'think', id, moves: job.moves, noise: job.noise || 0, timeMs: job.timeMs, maxDepth: job.maxDepth, solveAt: job.solveAt, wldAt: job.wldAt, multi: job.multi, analyze: job.analyze };
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.id !== this.id || i !== 0) return; // 結果は主ワーカー（0番）のものを使う
          if (m.type === 'info') { if (onInfo) onInfo(m.info); return; }
          if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -id); // 補助ワーカーも止める
          finish(m.info);
        };
        w.postMessage(msg);
      });
    },
    cancel() {
      if (this.busy) {
        if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -this.id);
        else { this.pool.forEach(w => w.terminate()); this.pool = []; } // 止められないので作り直す
      }
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 石の音（WebAudio で合成）
  let actx = null;
  function clack(kind, delay = 0) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + delay, len = kind === 'flip' ? 0.035 : 0.07, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, kind === 'flip' ? 6 : 4);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'flip' ? 2600 : 1500; bp.Q.value = kind === 'flip' ? 3 : 1.6;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'flip' ? 0.45 : 1.3, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      if (kind !== 'flip') {
        const o = actx.createOscillator(), og = actx.createGain();
        o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.07);
        og.gain.setValueAtTime(0.28, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.1);
      }
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuB, cfg.cpuW];
    else {
      const human = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = human === BLACK ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    loadGame({ seats, moves: [] });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.seats = g.seats; S.online = g.online || null;
    S.moves = []; S.hist = [new Position()]; S.evals = g.evals ? g.evals.slice() : [];
    for (const m of g.moves) { const p = S.hist[S.hist.length - 1].clone(); p.make(m); S.hist.push(p); S.moves.push(m); }
    S.view = null; S.result = g.result || null; S.info = null; S.cpuInfo = null;
    S.resultShown = !!g.result;
    shownStones = null; // 盤の石をアニメーションなしで描き直す
    afterChange();
  }

  function saveGame() {
    const online = S.online ? { mid: S.online.mid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { seats: S.seats, moves: S.moves, result: S.result, evals: S.evals.map(v => (v == null ? null : Math.round(v))), online });
  }

  function rebuild(n) {
    S.moves.length = n; S.hist.length = n + 1; S.evals.length = Math.min(S.evals.length, n + 1);
    S.result = null; S.resultShown = false;
  }

  function play(m, fromRemote) {
    if (m == null || m < 0) return;
    const pos = curPos();
    if (!pos.isLegal(m)) return;
    const flipped = pos.flipsOf(m);
    const p = pos.clone(); p.make(m);
    S.moves.push(m); S.hist.push(p);
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: S.moves.length, m });
    if (m !== PASS) {
      clack('place');
      if (settings.anim && !reduceMotion) flipped.forEach((s, i) => clack('flip', 0.1 + flipDelay(m, s) / 1000 + i * 0.004));
    }
    afterChange(m !== PASS ? { move: m, flipped } : null);
    if (S.online && NET) NET.saveState({ moves: S.moves, r: S.result ? 1 : 0 });
  }

  function afterChange(anim) {
    S.hover = -1;
    if (!S.result) {
      const r = curPos().result();
      if (r) S.result = Object.assign(r, { reason: '' });
    }
    S.info = null; S.cpuInfo = null;
    saveGame();
    render(anim);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, anim && settings.anim ? 900 : 350); }
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (!live() || S.result) { analyze(); return; }
    const pos = curPos(), c = pos.stm, legal = pos.legalMoves();
    // パス: 置ける場所がなければ、手番の側（人間・CPU）が自動でパスする。オンラインの相手の番なら相手から届くのを待つ
    if (legal.length === 1 && legal[0] === PASS && !isRemote(c)) {
      AI.cancel();
      const ply0 = S.moves.length;
      S.timer = setTimeout(() => { if (live() && S.moves.length === ply0) play(PASS); }, isHuman(c) ? 1400 : 700);
      renderSqInfo();
      return;
    }
    if (isRemote(c)) { AI.cancel(); renderEval(); return; }
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = S.moves.length, t0 = Date.now();
    S.thinking = true;
    renderPlayers(); renderSqInfo();
    // 強い CPU も序盤の8手は評価にごく小さな揺らぎを入れて、毎回同じ打ち方にならないようにする
    const noise = cpu.noise || (S.moves.length < 8 ? 80 : 0);
    AI.start({ moves: S.moves.slice(), timeMs: cpu.time, maxDepth: cpu.depth, noise, solveAt: cpu.solveAt, wldAt: cpu.wldAt, parallel: !!cpu.parallel && !noise },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        // 速すぎると何が起きたか見えないので、少なくとも0.45秒は待つ
        const wait = Math.max(120, 450 - (Date.now() - t0));
        if (live() && S.moves.length === ply && !S.result) S.timer = setTimeout(() => play(info.move), wait);
      });
  }

  // 人間の手番（または棋譜を見返しているとき）に形勢を読む。置ける場所ごとの評価値も出す
  function analyze(force, ms, kind = 'analysis') {
    const pos = shownPos();
    if (((!settings.analyze || !aiOn()) && !force) || pos.isOver()) { AI.cancel(); renderEval(); renderMarks(); return; }
    const legal = pos.legalMoves();
    if (legal.length === 1 && legal[0] === PASS) { AI.cancel(); renderEval(); return; }
    const ply = shownPly(), c = pos.stm;
    AI.start({ moves: S.moves.slice(0, ply), timeMs: ms || ANALYZE_MS, analyze: true, multi: true, solveAt: 16, parallel: true },
      info => onInfo(ply, c, info, kind), info => onInfo(ply, c, info, kind));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || !info.depth) return;
    const scoreB = c === BLACK ? info.score : -info.score;
    // 弱い CPU（揺らぎあり）の読みは形勢には使わない
    const cpuWeak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if (!cpuWeak) S.evals[ply] = scoreB;
    const rec = { ply, scoreB, pv: info.pv || [], depth: info.depth, exact: info.exact, wld: info.wld, nodes: info.nodes, time: info.time, stm: c, kind, scores: info.scores || null, best: info.move };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!cpuWeak && (kind !== 'cpu' || !S.info || S.info.ply !== ply)) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderTape(); renderMarks();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力
  function onSquare(s) {
    if (!humanTurn()) return;
    const pos = curPos();
    if (!pos.isLegal(s)) return;
    play(s);
  }

  // ------------------------------------------------------------------ 描画
  const sqName = R.sqName;
  function render(anim) {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(anim); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderSqInfo();
    fitBoardSoon();
  }

  // 画面の形（縦長・横長・広い）と盤の大きさ: ページがスクロールしないよう、盤以外のものの高さを測って残りを盤にする
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  function layoutMode() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w >= 980 && h >= 600) return 'L-wide';
    if (w > h * 1.15) return 'L-land';
    return 'L-port';
  }
  function fitBoard() {
    const mode = layoutMode(), body = document.body;
    if (!body.classList.contains(mode)) { body.classList.remove('L-wide', 'L-land', 'L-port'); body.classList.add(mode); closeSheet(); }
    const main = $('main'), stage = $('stage');
    if (!stage.offsetParent) return;
    const mcs = getComputedStyle(main);
    const top = main.getBoundingClientRect().top;
    const availH = window.innerHeight - top - parseFloat(mcs.paddingBottom) - 2;
    const mainW = main.clientWidth;
    let bs;
    if (mode === 'L-land') {
      bs = Math.min(availH, mainW - 14 - 300);
    } else {
      const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
      let other = 0, n = 0;
      for (const el of stage.children) {
        if (el.id === 'board-wrap' || getComputedStyle(el).display === 'none') continue;
        other += el.getBoundingClientRect().height; n++;
      }
      const w = mode === 'L-wide' ? mainW - 340 - 22 : mainW;
      bs = Math.min(w, availH - other - gap * n);
    }
    bs = Math.round(Math.max(200, Math.min(720, bs)));
    const cur = document.documentElement.style.getPropertyValue('--bs');
    if (cur !== bs + 'px') document.documentElement.style.setProperty('--bs', bs + 'px');
    // それでもはみ出すとき（文字の大きさなど）は、はみ出した分だけ小さく
    const over = main.scrollHeight - main.clientHeight;
    if (over > 0 && mode !== 'L-land' && bs > 200) document.documentElement.style.setProperty('--bs', Math.max(200, bs - over) + 'px');
    if (mode === 'L-land') {
      const br = $('board-wrap').getBoundingClientRect();
      $('side').style.setProperty('--sheet-left', Math.round(br.right + 8) + 'px');
    }
  }

  // 盤のマス（一度だけ作る）
  let shownStones = null; // いま描いている石（0 空き・1 黒・2 白）
  function buildBoard() {
    const grid = $('grid');
    grid.innerHTML = '';
    for (let s = 0; s < 64; s++) {
      const b = document.createElement('button');
      b.className = 'sq'; b.dataset.sq = s;
      b.setAttribute('role', 'gridcell');
      b.innerHTML = '<span class="hl"></span><span class="dot"></span><span class="ring" hidden></span><span class="ev"></span>';
      b.addEventListener('click', e => { e.stopPropagation(); onSquare(s); });
      b.addEventListener('mouseenter', () => { if (pointerType === 'mouse') onHover(s); });
      b.addEventListener('mouseleave', () => { if (S.hover === s) onHover(-1); });
      grid.appendChild(b);
    }
    $('coords-top').innerHTML = 'abcdefgh'.split('').map(c => `<span>${c}</span>`).join('');
    $('coords-left').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `<span>${n}</span>`).join('');
  }
  // 裏返す順: 置いた石から近い順に少しずつ遅らせる
  function flipDelay(m, s) {
    const dx = (s & 7) - (m & 7), dy = (s >> 3) - (m >> 3);
    return Math.max(Math.abs(dx), Math.abs(dy)) * 70;
  }
  function renderBoard(anim) {
    const pos = shownPos(), grid = $('grid');
    const animate = !!anim && settings.anim && !reduceMotion && shownStones;
    const board = $('board');
    if (!animate) board.classList.add('noanim');
    const flippedSet = anim ? new Set(anim.flipped) : null;
    for (let s = 0; s < 64; s++) {
      const want = pos.at(s), el = grid.children[s];
      let st = el.querySelector('.stone');
      const had = shownStones ? shownStones[s] : (st ? (st.classList.contains('w') ? 2 : 1) : 0);
      if (!want) { if (st) st.remove(); continue; }
      if (!st) {
        st = document.createElement('span');
        st.className = 'stone' + (want === 2 ? ' w' : '');
        st.innerHTML = '<span class="f b"></span><span class="f w"></span>';
        if (animate && anim.move === s) st.classList.add('drop');
        el.insertBefore(st, el.children[1]);
      } else if (had !== want || st.classList.contains('w') !== (want === 2)) {
        if (animate && flippedSet.has(s)) {
          const d = 80 + flipDelay(anim.move, s);
          st.style.transitionDelay = d + 'ms'; st.style.animationDelay = d + 'ms';
          st.classList.remove('flip'); void st.offsetWidth; st.classList.add('flip');
        } else { st.style.transitionDelay = ''; st.style.animationDelay = ''; }
        st.classList.toggle('w', want === 2);
      }
    }
    shownStones = Array.from({ length: 64 }, (_, s) => pos.at(s));
    if (!animate) { board.offsetWidth; requestAnimationFrame(() => board.classList.remove('noanim')); }
    // 終局の表示
    let em = $('endmark');
    if (live() && S.result) {
      if (!em) { em = document.createElement('div'); em.id = 'endmark'; em.className = 'endmark'; $('board-wrap').appendChild(em); }
      const r = S.result;
      em.innerHTML = `<b>${r.resigned ? `${SIDE[r.winner]}の勝ち` : r.winner === -1 ? '引き分け' : `${SIDE[r.winner]}の勝ち`}</b><span>${r.resigned ? esc(r.reason) : `黒 ${r.black} − 白 ${r.white}`}</span>`;
    } else if (em) em.remove();
    renderMarks();
  }

  // 置ける場所の印・暗くするマス・直前の手・AI補助（評価値・最善手）・マウスを乗せたときに返る石
  function renderMarks() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length !== 64) return;
    const myTurn = humanTurn() && settings.moves;
    const legal = new Set(myTurn ? pos.legalMoves().filter(m => m !== PASS) : []);
    const lm = shownPly() ? S.moves[shownPly() - 1] : -1;
    const info = S.info && S.info.ply === shownPly() && S.info.kind !== 'cpu' ? S.info : null;
    const showNums = info && info.scores && settings.nums && (settings.analyze || info.kind === 'hint') && !(live() && S.result);
    const nums = new Map();
    if (showNums) for (const x of info.scores) nums.set(x.move, x.score);
    const bestSq = info && info.best != null && info.best !== PASS && ((settings.best && aiOn()) || info.kind === 'hint') ? info.best : -1;
    const flipPrev = S.hover >= 0 && legal.has(S.hover) ? new Set(pos.flipsOf(S.hover)) : null;
    const dotCls = pos.stm === BLACK ? 'dot b' : 'dot w';
    for (let s = 0; s < 64; s++) {
      const el = grid.children[s];
      const can = legal.has(s), empty = !pos.at(s);
      let cls = 'sq';
      if (can) cls += ' can';
      else if (myTurn && empty) cls += ' dim';
      if (s === lm) cls += ' last';
      if (flipPrev && flipPrev.has(s)) cls += ' flipprev';
      if (s === bestSq) cls += info.kind === 'hint' ? ' best hint' : ' best';
      const evEl = el.lastChild;
      if (nums.has(s) && empty) {
        cls += ' has-ev';
        const v = Math.round(nums.get(s) / R.SC);
        const t = (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);
        if (evEl.textContent !== t) evEl.textContent = t;
        evEl.className = 'ev' + (v < 0 ? ' neg' : '');
      } else if (evEl.textContent) evEl.textContent = '';
      if (el.className !== cls) el.className = cls;
      const dot = el.children[el.children.length - 3];
      const want = can ? dotCls : 'dot';
      if (dot.className !== want) dot.className = want;
      dot.hidden = !can;
      const ring = el.children[el.children.length - 2];
      ring.hidden = s !== bestSq;
      el.setAttribute('aria-label', `${sqName(s)} ${pos.at(s) === 1 ? '黒' : pos.at(s) === 2 ? '白' : can ? '置ける' : '空き'}${nums.has(s) ? ` 評価 ${Math.round(nums.get(s) / R.SC)}` : ''}`);
    }
    $('board').classList.toggle('thinking', S.thinking);
  }
  function onHover(s) {
    S.hover = s;
    renderMarks(); renderSqInfo();
  }

  function renderPlayers() {
    const pos = shownPos();
    // 下は自分（人間）。CPU と対局で白を持ったときは白が下。ふたりで・観戦は黒が下
    const bottom = S.online ? S.online.myColor : (isHuman(WHITE) && !isHuman(BLACK) ? WHITE : BLACK);
    [['player-top', bottom ^ 1], ['player-bottom', bottom]].forEach(([id, c]) => {
      const el = $(id);
      const turn = live() && !S.result && pos.stm === c;
      el.classList.toggle('turn', turn);
      let st = '';
      if (turn && isCPU(c) && S.thinking) {
        const ci = S.cpuInfo;
        st = `<span class="think"><i></i>考え中${ci && !CPU[S.seats[c]].noise ? `・${ci.exact || ci.wld != null ? '読み切り' : `深さ${ci.depth}`}` : ''}</span>`;
      } else if (turn && isRemote(c)) {
        st = S.online && NET && NET.status === 'on' && !S.online.oppPresent ? '<span class="think lost">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think win">勝ち</span>' : S.result.winner === -1 ? '<span class="think">引き分け</span>' : '<span class="think lose">負け</span>';
      }
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : seatLabel(c);
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      el.innerHTML = `
        <span class="chip ${c ? 'w' : 'b'}" aria-hidden="true"></span>
        <div class="id"><span class="name">${nm}</span><span class="sub">${SIDE[c]}${c === BLACK ? '・先手' : ''}</span>${tag}</div>
        <div class="right">${st}<span class="count" aria-label="${SIDE[c]}の石 ${pos.count(c)}個">${pos.count(c)}</span></div>`;
    });
  }

  // 情報の行（盤のすぐ下、高さ固定）
  function moveText(i) { // i 手目（1始まり）
    const m = S.moves[i - 1], c = S.hist[i - 1].stm;
    return `${SIDE[c]} ${m === PASS ? 'パス' : sqName(m)}`;
  }
  function renderSqInfo() {
    const el = $('sqinfo'), pos = shownPos();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = pos.stm;
    const legal = pos.legalMoves();
    const n = shownPly();
    if (!live()) {
      cls += ' view';
      html = `<span class="txt"><b>${n ? `${n}手目` : '開始局面'}</b>${n ? ` ${moveText(n)}` : ''}　<span class="muted">見返し中</span></span>`;
      tools = btn('branch', 'ここから打つ') + btn('live', '最新へ', ' primary');
    } else if (S.result && S.online) {
      cls += ' result';
      const r = S.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === -1 ? '引き分け' : r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（黒白を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>　${r.resigned ? esc(r.reason) : `黒${r.black}−白${r.white}`}</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      const r = S.result;
      html = `<span class="txt"><b>${r.winner === -1 ? '引き分け' : SIDE[r.winner] + 'の勝ち'}</b>　${r.resigned ? esc(r.reason) : `黒 ${r.black} − 白 ${r.white}`}</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' bad';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' bad';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (legal.length === 1 && legal[0] === PASS) {
      cls += ' alert';
      html = `<span class="txt">${isHuman(c) && S.seats[c ^ 1] !== 'human' ? 'あなた' : SIDE[c]}は置ける場所がないので<b>パス</b>です</span>`;
    } else if (S.moves.length && S.moves[S.moves.length - 1] === PASS) {
      cls += ' alert';
      html = `<span class="txt">${SIDE[c ^ 1]}がパスしたので、続けて<b>${SIDE[c]}</b>の番です</span>`;
    } else if (S.hover >= 0 && humanTurn() && pos.isLegal(S.hover)) {
      html = `<span class="txt"><b>${sqName(S.hover)}</b> に置くと <b>${pos.flipsOf(S.hover).length}</b> 個 返ります</span>`;
    } else if (isCPU(c) && S.thinking) {
      html = `<span class="txt muted">${seatLabel(c)}が考えています…${n ? `　直前 ${moveText(n)}` : ''}</span>`;
    } else if (isRemote(c)) {
      html = `<span class="txt"><b>${esc(S.online ? S.online.opp.name : '相手')}さん</b>の番です　<span class="muted">${n ? `直前 ${moveText(n)}` : ''}</span></span>`;
    } else {
      const who = isHuman(c) && S.seats[c ^ 1] !== 'human' ? `あなた（${SIDE[c]}）` : SIDE[c];
      html = `<span class="txt"><b>${who}の番</b>　<span class="muted">置ける場所 ${legal.length}か所${n ? `・直前 ${moveText(n)}` : ''}</span></span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ
  const winP = s => R.winRate(s);
  function badMove(i) { // i 手目が大きく形勢を損ねた手か
    const a = S.evals[i - 1], b = S.evals[i];
    if (!settings.showEval || a == null || b == null) return false;
    const mover = S.hist[i - 1].stm;
    return (winP(b) - winP(a)) * (mover === BLACK ? 1 : -1) < -0.2;
  }
  function renderTape() {
    const el = $('tape');
    const cur = shownPly();
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    for (let i = 1; i <= S.moves.length; i++) {
      const m = S.moves[i - 1], c = S.hist[i - 1].stm, bad = badMove(i);
      html += `<button data-ply="${i}" class="${cur === i ? 'cur' : ''}${bad ? ' bad' : ''}${m === PASS ? ' pass' : ''}"><span class="no">${i}</span><span class="mini ${c ? 'w' : 'b'}"></span>${m === PASS ? 'パス' : sqName(m)}${bad ? '?' : ''}</button>`;
    }
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    const cb = el.querySelector('.cur');
    if (cb) el.scrollLeft = cb.offsetLeft - el.clientWidth / 2 + cb.offsetWidth / 2;
    const nav = $('navrow');
    nav.querySelector('[data-nav="first"]').disabled = cur === 0;
    nav.querySelector('[data-nav="prev"]').disabled = cur === 0;
    nav.querySelector('[data-nav="next"]').disabled = live();
    nav.querySelector('[data-nav="last"]').disabled = live();
  }

  function renderControls() {
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-undo').disabled = !S.moves.length || !!S.online || ![BLACK, WHITE].some(isHuman);
    $('btn-resign').disabled = !live() || !!S.result || ![BLACK, WHITE].some(isHuman);
    $('btn-hint').disabled = !humanTurn() || curPos().legalMoves()[0] === PASS;
    $('kifu-info').textContent = `${S.moves.filter(m => m !== PASS).length}手${S.result ? '・終局' : ''}`;
  }

  // 形勢: 予想の石差（黒から見て）と勝つ見込み
  function evalLabel(sB, exact, wld) {
    const d = Math.round(sB / R.SC), a = Math.abs(d), who = d > 0 ? '黒' : '白';
    if (exact) return d === 0 ? '読み切り：引き分け' : `読み切り：${who}の勝ち`;
    if (wld != null) return wld === 0 ? '読み切り：引き分け' : `読み切り：${who}の勝ち（石差は未確定）`;
    if (a < 2) return '互角';
    return who + (a < 6 ? 'やや有利' : a < 14 ? '有利' : a < 26 ? '優勢' : '勝勢');
  }
  const fmtDiff = sB => { const d = Math.round(sB / R.SC); return d === 0 ? '±0' : `${d > 0 ? '黒' : '白'}+${Math.abs(d)}`; };
  function renderEval() {
    const ply = shownPly(), pos = shownPos();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sB = info ? info.scoreB : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    const strip = (n, l, best) => { $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best; };
    if (pos.isOver()) {
      const r = pos.result();
      num.textContent = r.black === r.white ? '±0' : `${r.black > r.white ? '黒' : '白'}+${Math.abs(r.black - r.white)}`;
      lbl.textContent = '終局';
      setWR(r.black > r.white ? 1 : r.black < r.white ? 0 : 0.5);
      $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip(num.textContent, '終局', '');
      return;
    }
    if (sB == null) {
      num.textContent = '—';
      lbl.textContent = (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', lbl.textContent, '');
      return;
    }
    num.textContent = fmtDiff(sB);
    lbl.textContent = evalLabel(sB, info && info.exact, info && info.wld != null ? info.wld : null);
    setWR(info && (info.exact || info.wld != null) ? (sB > 0 ? 1 : sB < 0 ? 0 : 0.5) : winP(sB));
    let best = '';
    if (info && info.pv && info.pv.length) {
      const c0 = pos.stm, txt = [];
      info.pv.slice(0, 14).forEach((m, k) => { const col = (c0 + k) & 1; txt.push(`<span class="mini ${col ? 'w' : 'b'}"></span>${m === PASS ? 'パス' : sqName(m)}`); });
      $('pv').innerHTML = `<span class="k">読み筋</span><span class="best">${txt[0]}</span> ${txt.slice(1).join(' ')}`;
      const nps = info.time ? Math.round(info.nodes / info.time * 1000) : 0;
      $('ev-meta').textContent = `${info.exact ? '最後まで読み切り' : info.wld != null ? '勝ち負けを読み切り' : `深さ ${info.depth}`} ・ ${info.nodes.toLocaleString()} 局面 ・ ${(info.time / 1000).toFixed(1)}秒 ・ ${nps.toLocaleString()} 局面/秒`;
      if (info.kind !== 'cpu' && info.pv[0] !== PASS) best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${sqName(info.pv[0])}`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(num.textContent, lbl.textContent, best);
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-bt').textContent = `黒 ${(p * 100).toFixed(0)}%`;
    $('wr-wt').textContent = `白 ${(100 - p * 100).toFixed(0)}%`;
  }

  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.moves.length, 60);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.moves.length; i++) {
      const p = S.hist[i];
      const v = p.isOver() ? (p.count(BLACK) > p.count(WHITE) ? 1 : p.count(BLACK) < p.count(WHITE) ? 0 : 0.5) : S.evals[i] != null ? winP(S.evals[i]) : null;
      if (v != null) pts.push([x(i), y(v)]);
    }
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
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>開始</span></li>`];
    for (let i = 1; i <= S.moves.length; i++) {
      const m = S.moves[i - 1], c = S.hist[i - 1].stm, s = S.evals[i], bad = badMove(i);
      const dv = s != null ? Math.round(s / R.SC) : 0;
      const ev = s != null && settings.showEval ? (dv > 0 ? '+' : dv < 0 ? '−' : '±') + Math.abs(dv) : '';
      rows.push(`<li data-ply="${i}" class="${cur === i ? 'cur' : ''}"><span class="no">${i}</span><span class="mini ${c ? 'w' : 'b'}"></span><span>${m === PASS ? 'パス' : sqName(m)}${bad ? '?' : ''}</span><span class="ev${bad ? ' bad' : ''}">${ev}</span></li>`);
    }
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
    p = Math.max(0, Math.min(S.moves.length, p));
    S.view = p >= S.moves.length ? null : p;
    S.info = null; S.hover = -1;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }

  function undo() {
    if (!S.moves.length || S.online) return; // オンライン対局では待ったなし
    AI.cancel(); clearTimeout(S.timer);
    S.view = null;
    let n = S.moves.length - 1;
    // 人間の番まで戻す（CPU の手とパスは飛ばす）
    if ([BLACK, WHITE].some(isHuman)) while (n > 0 && (!isHuman(S.hist[n].stm) || S.hist[n].legalMoves()[0] === PASS)) n--;
    rebuild(n);
    shownStones = null;
    afterChange();
  }

  function resign() {
    if (!live() || S.result) return;
    const humans = [BLACK, WHITE].filter(isHuman);
    if (!humans.length) return;
    const loser = humans.includes(curPos().stm) ? curPos().stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    const p = curPos();
    S.result = { winner: loser ^ 1, black: p.count(BLACK), white: p.count(WHITE), resigned: true, reason: `${SIDE[loser]}の投了` };
    if (S.online && NET) { NET.send({ t: 'resign' }); NET.saveState({ moves: S.moves, r: 1 }); }
    afterChange();
  }

  function kifuText() {
    const lines = ['リバーシ 棋譜', `黒：${seatLabel(BLACK)} / 白：${seatLabel(WHITE)}`, R.transcript(S.moves)];
    if (S.result) lines.push(S.result.resigned ? `まで ${SIDE[S.result.winner]}の勝ち（${S.result.reason}）` : `まで 黒${S.result.black} − 白${S.result.white}（${S.result.winner === -1 ? '引き分け' : SIDE[S.result.winner] + 'の勝ち'}）`);
    return lines.join('\n');
  }
  function importKifu(text) {
    const body = String(text).split(/\r?\n/).filter(l => !/棋譜|黒：|まで/.test(l)).join(' ');
    const moves = R.parseTranscript(body);
    if (!moves.length) throw new Error('置いたマス（f5 など）が見つかりません');
    loadGame({ seats: ['human', 'human'], moves });
  }
  function copyKifu() {
    const text = kifuText(), msg = $('copy-msg');
    const done = () => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); };
    const fallback = () => { openSheet('kifu'); const ta = document.createElement('textarea'); ta.value = text; ta.rows = 4; ta.style.width = '100%'; msg.innerHTML = ''; msg.appendChild(ta); ta.select(); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
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
    seg('ng-side', [['black', '黒（先に打つ）'], ['white', '白'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
  }

  function showResult() {
    const r = S.result;
    if (!r) return;
    const humans = [BLACK, WHITE].filter(isHuman);
    let title = r.winner === -1 ? '引き分け' : `${SIDE[r.winner]}の勝ち`;
    if (S.online) title = r.winner === -1 ? '引き分け' : r.winner === S.online.myColor ? 'あなたの勝ち' : 'あなたの負け';
    else if (humans.length === 1 && r.winner !== -1) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${S.moves.filter(m => m !== PASS).length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    $('rs-score').innerHTML = `<span class="chip b"></span>${r.black}<span style="color:var(--muted);font-size:20px">−</span>${r.white}<span class="chip w"></span>`;
    const opp = S.online ? `相手は ${esc(S.online.opp.name)} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[humans[0] ^ 1]].label}）でした。` : '';
    $('rs-body').innerHTML = `${r.resigned ? esc(r.reason) + '。' : ''}${opp}`;
    $('rs-again').textContent = S.online ? 'もう一局（黒白を交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI ページ
  function miniBoard(cells, marks = {}) {
    // cells: 64文字（. 空き / b 黒 / w 白）。marks: マス → 'm'（置ける）・'f'（返る）・'n'（置いた）
    let h = '<div class="minib" aria-hidden="true">';
    for (let s = 0; s < 64; s++) { const c = cells[s]; h += `<i class="${c === 'b' ? 'b' : c === 'w' ? 'w' : ''}${marks[s] ? ' ' + marks[s] : ''}"></i>`; }
    return h + '</div>';
  }
  function posCells(p) { let s = ''; for (let i = 0; i < 64; i++) s += '.bw'[p.at(i)]; return s; }
  function renderRules() {
    const p0 = new Position();
    const m0 = {}; p0.legalMoves().forEach(s => { m0[s] = 'm'; });
    const p1 = Position.fromMoves(R.parseTranscript('f5d6c3d3c4'));
    const mv = R.parseSq('f4'), fl = p1.flipsOf(mv);
    const before = {}; fl.forEach(s => { before[s] = 'f'; }); before[mv] = 'm';
    const p2 = p1.clone(); p2.make(mv);
    const after = { [mv]: 'n' }; fl.forEach(s => { after[s] = 'f'; });
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>8×8の盤で、<b>黒と白</b>が交互に石を1つずつ置きます。<b>黒が先</b>です。</li>
          <li>置けるのは、<b>相手の石を自分の石ではさめる</b>マスだけ。はさんだ相手の石は、すべて裏返って自分の色になります（縦・横・斜めのどの向きでも、いくつでも）。</li>
          <li>置ける場所がないときは<b>パス</b>（このアプリでは自動）。両方とも置けなくなったら終わりで、<b>石の多い方の勝ち</b>です。</li>
        </ul>
        <div class="figs">
          <figure>${miniBoard(posCells(p0), m0)}<figcaption>はじめの並び。黒が置けるのは金の点の4か所</figcaption></figure>
          <figure>${miniBoard(posCells(p1), before)}<figcaption>白が金の点（f4）に置くと、輪の石がはさまれる</figcaption></figure>
          <figure>${miniBoard(posCells(p2), after)}<figcaption>はさまれた黒が白に裏返る</figcaption></figure>
        </div>
      </div>
      <div class="card" data-tab="終わり方">
        <h3>パスと終わり方</h3>
        <ul>
          <li>自分の番に置ける場所がなければパスになり、相手が続けて打ちます。置ける場所があるときはパスできません。</li>
          <li>盤が埋まるか、両方とも置けなくなったら終局。石の数を比べます。同じ数なら引き分けです。</li>
          <li>AI の評価値（予想の石差）は、空きマスが残って終わったときは空きを勝った側に足して数えます（世界大会と同じ数え方）。勝ち負けは変わりません。</li>
        </ul>
      </div>
      <div class="card" data-tab="操作">
        <h3>このアプリの操作</h3>
        <ul>
          <li>自分の番になると、<b>置ける場所に小さな点</b>が出て、ほかの空きマスは少し暗くなります。点のマスを<b>タップするとすぐ置きます</b>。パソコンではマウスを乗せると、返る石が光ります。</li>
          <li><b>AI補助</b>：形勢（最後に何石差になりそうか・勝つ見込み）と、置ける場所ごとの評価値（＋なら自分が多く終わる見込み）、最善手の緑の輪をまとめて出し入れします。細かくは右上の歯車で。</li>
          <li><b>ヒント</b>：AI が2〜3秒読んで、おすすめのマスを金の輪で示します。</li>
          <li>盤の下の<b>棋譜テープ</b>で前の局面に戻って見返せます。「ここから打つ」でその局面から打ち直せます。</li>
          <li><b>オンライン</b>：右上のボタンから。相手を待つか、待っている人に申し込みます。招待リンクで友達とも打てます。オンラインでは「待った」はなく、相手が AI補助やヒントを使っているかが表示されます。</li>
        </ul>
      </div>
      <div class="card" data-tab="名前">
        <h3>「リバーシ」という名前</h3>
        <p>このゲームは19世紀のイギリスで「リバーシ」として遊ばれていたものと同じ形です。同じルールのゲームが別の名前（商標）でも広く知られていますが、ここでは昔からの名前で呼んでいます。</p>
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
      $('main').scrollTop = 0;
    };
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.i)); });
    show(Math.min(store.get('doctab-' + key, 0), cards.length - 1));
  }

  // AI が自分で見つけたこと: 学習したパターンの点数から、1つのマスに石があるときの値（そのマスを含む全部の形の点数の和）を読む
  let learnedCache = null;
  function learnedHTML() {
    if (!WT || !WT.data) return '';
    if (!learnedCache) {
      const { L, stages } = R.decodeCompact(WT), ci = R.canonIndexTables();
      const stageOf = WT.stageOf || R.defaultStageOf();
      const val = (sq, who, discs) => {
        const w = stages[Math.min(stages.length - 1, stageOf[discs])];
        let v = 0;
        for (const it of R.INST) {
          const k = it.sq.indexOf(sq);
          if (k < 0) continue;
          const o = L.off[it.type], m = ci[it.type];
          v += w[o + m[who * Math.pow(3, k)]] - w[o + m[0]];
        }
        return v / R.SC;
      };
      const rows = [['隅（a1）を自分が持つ', 0, 1], ['隅（a1）を相手が持つ', 0, 2], ['隅が空いたまま、斜め隣（b2）に自分の石', 9, 1], ['隅が空いたまま、隣（b1）に自分の石', 1, 1]];
      learnedCache = rows.map(([name, sq, who]) => [name, ...[16, 24, 32].map(d => val(sq, who, d))]);
    }
    const f = v => `<span style="color:${v > 0.3 ? 'var(--good)' : v < -0.3 ? 'var(--bad)' : 'var(--muted)'}">${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}</span>`;
    return `<div class="card" data-tab="見つけたこと">
      <h3>AI が自分で見つけたこと</h3>
      <p class="hint">人は何も教えていませんが、自己対局をくり返すうちに、こんな「価値」を学びました。数字は、まわりの辺や隅がまだ空いているとき、そのマスに石が1つあるだけで評価がどれだけ動くか（最後の石差の見込み、手番の側から見て）。並びによって変わるので目安です。</p>
      <div class="tbl"><table class="lv"><thead><tr><th></th><th>石16</th><th>石24</th><th>石32</th></tr></thead><tbody>
        ${learnedCache.map(r => `<tr><td>${r[0]}</td><td>${f(r[1])}</td><td>${f(r[2])}</td><td>${f(r[3])}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint">「隅を取ると得」「隅が空いているのにその斜め隣に打つと損」は、人のあいだでも昔から知られている考え方です。AI はそれを、勝ち負けの結果だけから自分で見つけました。</p>
    </div>`;
  }

  // CPU の段階どうしの対戦の結果（train/levels.js → js/levels.js）
  function levelsHTML() {
    const L = typeof REVERSI_LEVELS !== 'undefined' && REVERSI_LEVELS;
    if (!L || !L.results || !L.results.length) return '';
    return `<p class="hint" style="margin:12px 0 4px"><b>となりの段階どうしの対戦</b>（先後入れ替え・各${L.games}局。考える時間は ${L.scale} 倍に縮めて測定）</p>
      <div class="tbl"><table class="lv"><tbody>${L.results.map(r => `<tr><td>${CPU[r.a] ? CPU[r.a].label : esc(r.a)} vs ${CPU[r.b] ? CPU[r.b].label : esc(r.b)}</td><td>${r.win}勝${r.loss}敗${r.draw ? r.draw + '分' : ''}</td><td>勝率 ${(r.score * 100).toFixed(0)}%</td><td>Elo ${r.elo >= 0 ? '+' : ''}${r.elo}±${r.eloErr}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderAIPage() {
    const W = WT || {};
    const h = W.history || [];
    const gen = W.gen || 0, total = W.totalGames || 0;
    const acc = h.filter(e => e.accepted);
    const bw = 600, bh = 170, pad = 30;
    // 世代ごとの検定（新 vs 旧）の Elo を積み上げた線
    let cum = 0;
    const series = [{ gen: 0, elo: 0, accepted: true }].concat(h.map(e => { if (e.accepted) cum += Math.max(0, e.elo); return { gen: e.gen, elo: cum, accepted: e.accepted, e }; }));
    let chart = '';
    if (series.length > 1) {
      const maxE = Math.max(50, ...series.map(s => s.elo)), g0 = 0, g1 = series[series.length - 1].gen;
      const X = g => pad + (g - g0) / Math.max(1, g1 - g0) * (bw - pad - 8), Y = e => bh - 20 - e / maxE * (bh - 34);
      const ticks = [0, 0.5, 1].map(f => Math.round(maxE * f));
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（新旧の対戦の Elo を積み上げたもの）">
        ${ticks.map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t}</text>`).join('')}
        <polyline points="${series.map(s => `${X(s.gen).toFixed(1)},${Y(s.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${series.slice(1).map(s => `<circle cx="${X(s.gen)}" cy="${Y(s.elo)}" r="${s.accepted ? 3.2 : 2}" fill="${s.accepted ? 'var(--good)' : 'var(--muted)'}"><title>第${s.gen}世代 ${s.accepted ? '採用' : '不採用'}・新旧 ${(s.e.matchScore * 100).toFixed(1)}%（Elo ${s.e.elo >= 0 ? '+' : ''}${s.e.elo}±${s.e.eloErr}）・誤差 ${s.e.errAfter}石</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第0世代（何も知らない）</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代</text>
      </svg>`;
    }
    const ms = (W.measures || []).slice(-40);
    const last = ms[ms.length - 1];
    // 基準の版（第1世代）との直接対戦の推移
    let mchart = '';
    if (ms.length >= 2) {
      const top = Math.max(100, ...ms.map(m => m.elo + (m.eloErr || 0))), gMin = ms[0].gen, gMax = ms[ms.length - 1].gen;
      const X = g => pad + (gMax === gMin ? 0.5 : (g - gMin) / (gMax - gMin)) * (bw - pad - 16), Y = e => bh - 20 - Math.max(0, e) / top * (bh - 34);
      mchart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="基準の版との直接対戦で測った強さの推移">
        ${[0, 0.5, 1].map(f => Math.round(top * f)).map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">+${t}</text>`).join('')}
        <polyline points="${ms.map(m => `${X(m.gen).toFixed(1)},${Y(m.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--gold)" stroke-width="2"/>
        ${ms.map(m => `<line x1="${X(m.gen)}" x2="${X(m.gen)}" y1="${Y(m.elo - (m.eloErr || 0))}" y2="${Y(m.elo + (m.eloErr || 0))}" stroke="var(--gold)" stroke-width="1.5"/><circle cx="${X(m.gen)}" cy="${Y(m.elo)}" r="4" fill="var(--gold)"><title>第${m.gen}世代: ${esc(m.anchor)}に${(m.score * 100).toFixed(1)}%（Elo +${m.elo}±${m.eloErr}、${m.games}局）</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${gMin}世代</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${gMax}世代</text>
      </svg>`;
    }
    const rows = h.slice(-12).reverse().map(e => `<tr><td>第${e.gen}世代</td><td>${(e.totalGames || 0).toLocaleString()}</td><td>${e.errAfter}石</td><td>${(e.matchScore * 100).toFixed(1)}%</td><td>${e.elo >= 0 ? '+' : ''}${e.elo}±${e.eloErr}</td><td>${e.accepted ? '採用' : '—'}</td></tr>`).join('');
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習した世代</span></div>
          <div class="stat"><b>${total.toLocaleString()}</b><span>自己対局（累計局数）</span></div>
          <div class="stat"><b>${acc.length}</b><span>採用された更新</span></div>
          <div class="stat"><b>+${cum}</b><span>世代ごとの上昇幅の合計（Elo の目安）</span></div>
          ${last ? `<div class="stat"><b>${(last.score * 100).toFixed(1)}%</b><span>${esc(last.anchor)}との直接対戦の勝率（第${last.gen}世代・${last.games}局・Elo ${last.elo >= 0 ? '+' : ''}${last.elo}±${last.eloErr}）</span></div>` : ''}
        </div>
        <div class="charts2">
        ${chart ? `<div><p class="hint" style="margin:14px 0 6px">世代ごとの検定：「学習した新しい版 vs それまでの版」を先後入れ替えで対戦し、勝ち越したら採用（緑）。線はその上昇幅の合計です。</p>${chart}</div>` : '<p>まだ学習していません（評価はすべて 0。終盤の読み切りだけで打ちます）。</p>'}
        ${mchart ? `<div class="wide-only"><p class="hint" style="margin:14px 0 6px"><b>実測の強さ</b>：${esc(last.anchor)}と先後入れ替えで直接対戦したときの Elo 差。縦線は誤差の目安。</p>${mchart}</div>` : ''}
        </div>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>何も教えていない</b>：人が作った定石・評価表・棋譜・ほかのソフトは一切使っていません。最初の AI はでたらめに打ち、終盤だけ最後まで読み切ります。</li>
          <li><b>評価関数</b>：盤の辺・隅・斜め・行など 11 種類の形（パターン）、盤全体で 46 か所の並びに、それぞれ点数があります。点数の表は自己対局の結果から学びます（約 170 万個の数）。対局の進み具合で 15 段階に分けています。</li>
          <li><b>強化学習</b>：今いちばん強い AI どうしで何万局も打ち、「この局面から最後に何石差になったか」を当てるよう点数を直します。直した版が前の版に勝ち越したときだけ採用します。</li>
          <li><b>探索</b>：αβ探索（PVS・置換表・手の並べ替え）で先を読み、残りが少なくなったら最後まで読み切って正確な石差を出します。スレッドが使える環境では複数の Web Worker が置換表を共有して読みます。</li>
        </ul>
        <table class="lv wide-only" style="margin-top:8px"><thead><tr><th>CPUの強さ</th><th>1手の時間</th><th>特徴</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].time / 1000}秒</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table>
        ${levelsHTML()}
      </div>
      ${learnedHTML()}
      ${rows ? `<div class="card" data-tab="学習の記録">
        <h3>学習の記録（新しい順）</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>累計局数</th><th>予想の誤差</th><th>新 vs 旧</th><th>Elo</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">予想の誤差：学習に使っていない局面で、最後の石差の予想がどれだけ外れたか（平均二乗誤差の平方根）。</p>
      </div>` : ''}`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      $('main').classList.toggle('doc-view', b.dataset.tab !== 'play');
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') fitBoardSoon();
      closeSheet();
    }));
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'live') viewPly(S.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.result) { const p = curPos(); S.result = { winner: S.online.myColor, black: p.count(BLACK), white: p.count(WHITE), resigned: true, reason: '相手の接続切れ' }; afterChange(); }
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
      else if (nav === 'last') viewPly(S.moves.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet('kifu'); }
      else if (b.dataset.ply != null) viewPly(Number(b.dataset.ply));
    });
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('best', on, true); setSetting('nums', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'graph' : 'kifu'));
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    window.addEventListener('resize', () => { fitBoardSoon(); if ($('side').classList.contains('open')) placeSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { lobby.msg = ''; NET.wait(null, '8×8'); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('best', on, true); setSetting('nums', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }, () => { lobby.msg = link; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET) NET.setName(myName); }
    });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.result && !confirm('オンライン対局の途中です。新しい対局を始めると投了になります。よろしいですか？')) return;
      if (S.online && !S.result) resign();
      openNew();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-resign').addEventListener('click', resign);
    $('btn-copy').addEventListener('click', copyKifu);
    $('btn-import').addEventListener('click', () => { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); });
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      if (S.online && NET) { S.online.myHints++; NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      analyze(true, HINT_MS, 'hint');
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-best', 'best'], ['set-nums', 'nums'], ['set-moves', 'moves'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-analyze', 'analyze']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    $('evstrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ev'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
      if (e.target.closest('[data-act="show-eval"]')) setSetting('showEval', true);
      if (e.target.closest('[data-act="copy"]')) copyKifu();
      if (e.target.closest('[data-act="import"]')) { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); }
    });
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewPly(Number(li.dataset.ply)); });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.moves.length, 60);
      viewPly(Math.round((e.clientX - r.left) / r.width * n));
    });
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => {
      try { importKifu($('im-text').value); $('dlg-import').hidden = true; closeSheet(); } catch (err) { $('im-msg').textContent = err.message; }
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
      if (e.key === 'Escape') { closeSheet(); ['dlg-new', 'dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
    });
  }

  // ------------------------------------------------------------------ オンライン対戦（../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && window.SSIHOnline.available();
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.best || settings.nums ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? '最善手・評価値' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: 'reversi',
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
    $('dlg-online').hidden = true; $('dlg-result').hidden = true;
    const online = { mid: g.mid, myColor: g.myColor ? WHITE : BLACK, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false };
    const seats = online.myColor === BLACK ? ['human', 'remote'] : ['remote', 'human'];
    loadGame({ seats, moves: [], online });
    clack('place');
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
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.moves.length + 1) applyRemote([msg.m | 0]); }
    else if (msg.t === 'state' && Array.isArray(msg.moves)) {
      for (let i = 0; i < Math.min(msg.moves.length, S.moves.length); i++) if ((msg.moves[i] | 0) !== S.moves[i]) return; // 食い違うものは使わない
      applyRemote(msg.moves.slice(S.moves.length).map(x => x | 0));
    } else if (msg.t === 'resign') {
      if (!S.result) { const p = curPos(); S.result = { winner: o.myColor, black: p.count(BLACK), white: p.count(WHITE), resigned: true, reason: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.mid === 'string') {
      NET.start({ mid: msg.mid.slice(0, 20), myColor: msg.oc ? 1 : 0, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 相手の手を順に打つ（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const m of list) {
      if (S.result || !isRemote(curPos().stm) || !curPos().isLegal(m)) break;
      if (!live()) S.view = null;
      play(m, true);
    }
  }
  // もう一局: 両方が希望したら、ID の小さい方が新しい対局を作る（黒白は交代）
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
    NET.send({ t: 'rego', mid, oc: o.myColor });
    NET.start({ mid, myColor: o.myColor ^ 1, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  // 招待リンク（?room=コード）で開いたら、その部屋の人が見えしだい申し込む
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.g === 'reversi' && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null;
    history.replaceState(null, '', location.pathname);
    lobby.msg = `${p.n}さんに申し込みました…`;
    NET.challenge(p.id);
    renderLobby();
  }

  function openOnline() {
    $('dlg-online').hidden = false;
    if (!ONLINE_OK) {
      $('on-body').innerHTML = '<p>オンライン対戦は、公開版のページや手元のサーバー（start.bat）で開いたときに使えます。</p><p><a href="https://angrh0824.github.io/turing-table/reversi/" target="_blank" rel="noopener">https://angrh0824.github.io/turing-table/reversi/</a></p>';
      return;
    }
    net();
    renderLobby();
  }
  function renderOnlineBadge() {
    const b = $('btn-online');
    const st = NET ? NET.status : 'off';
    b.dataset.st = st;
    const c = NET && st === 'on' ? NET.counts() : null;
    const g = c && c.byGame && c.byGame.reversi;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', c = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const g = c && c.byGame && c.byGame.reversi;
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === 'reversi') : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(g ? g.wait : 0)}</b><span>リバーシの対戦待ち</span></div>
        <div class="stat"><b>${num(g ? g.play : 0)}</b><span>リバーシの対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・最善手を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「相手を待つ」で待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span>待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）。黒白は始まるときにランダムで決まります。</span></div>`
          : `<div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>相手を待つ</button></div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と打った手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // 振り返りパネル（狭い画面）: 盤は見えたまま、盤の下（横長では右）からせり上がる
  function placeSheet() {
    const fr = $('board-wrap').getBoundingClientRect(), h = window.innerHeight;
    if (document.body.classList.contains('L-port')) $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.68, Math.max(h * 0.3, fr.bottom + 6))) + 'px');
    else if (document.body.classList.contains('L-land')) { $('side').style.setProperty('--sheet-top', Math.round(fr.top) + 'px'); $('side').style.setProperty('--sheet-left', Math.round(fr.right + 8) + 'px'); }
  }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && (tab === 'ev' || tab === 'graph')) tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (document.body.classList.contains('L-wide')) return; // 広い画面では右に常に出ている
    placeSheet();
    side.classList.add('open');
    renderKifu(); renderGraph();
  }
  function closeSheet() { $('side').classList.remove('open'); }

  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', best: 'set-best', nums: 'set-nums' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if (NET && ['showEval', 'best', 'nums'].includes(k)) NET.setAI(aiFlags());
    if (['analyze', 'showEval', 'best', 'nums'].includes(k) && !S.thinking && (humanTurn() || !live())) analyze();
    render();
  }

  function branch() {
    if (live()) return;
    AI.cancel();
    const n = S.view;
    S.view = null;
    rebuild(n);
    // 見返していた局面から打ち直すときは、人間どうしでなければ今の席のまま
    shownStones = null;
    afterChange();
  }

  // ------------------------------------------------------------------ はじめ
  buildBoard();
  bind();
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && Array.isArray(saved.moves) && Array.isArray(saved.seats)) {
    try {
      // 終わったオンライン対局や、オンラインにつなげない場所では、ふたりで対局として開く
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; saved.seats = saved.seats.map(x => (x === 'remote' ? 'human' : x)); }
      if (saved.online) saved.online = Object.assign({ myHints: 0 }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false });
      const p = new Position();
      for (const m of saved.moves) { if (!p.isLegal(m)) throw new Error('bad'); p.make(m); }
      loadGame(saved);
      if (S.online && NET) NET.rejoin({ mid: S.online.mid, myColor: S.online.myColor, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } });
    } catch (e) { startGame(cfg); }
  } else {
    startGame(cfg);
    openNew();
  }
  fitBoardSoon();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBoardSoon);
})();
