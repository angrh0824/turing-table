/* アマゾンズ Webアプリ: 盤面UI・CPU（Web Worker）・AI補助（形勢・陣地・最善手）・オンライン対戦 */
(function () {
  'use strict';
  const A = {};
  AmazonsCore(A);
  AmazonsAI(A);
  const { Position, WHITE, BLACK, P, SQ, ARROW, EMPTY } = A;
  const $ = id => document.getElementById(id);
  const SIDE = ['白', '黒'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const sqName = A.sqName, moveName = A.moveName;

  // 学習した評価関数（js/weights.js）
  const WT = (typeof AMAZONS_WEIGHTS !== 'undefined' && AMAZONS_WEIGHTS) ? AMAZONS_WEIGHTS : null;
  const EV = A.evalFromWeights(WT);

  // ------------------------------------------------------------------ CPU の強さ
  // 下の段は同じ AI で、読みを1手だけにしたり、評価にわざと揺らぎを入れたりして弱くしてある（段どうしの差は README）
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '1手先だけを、気まぐれに見ます', depth: 1, noise: 1.5, time: 300, tm: '1手先' },
    normal: { label: 'ふつう', stars: 2, desc: '1手先をしっかり見ます（ときどき迷います）', depth: 1, noise: 0.3, time: 300, tm: '1手先' },
    strong: { label: 'つよい', stars: 3, desc: '1手 約2秒。相手の応手まで読みます', time: 2000, tm: '約2秒' },
    max: { label: '最強', stars: 4, desc: '1手 約6秒・複数スレッドで深く読みます', time: 6000, parallel: true, tm: '約6秒' },
    ultra: { label: '超最強', stars: 5, desc: '最強と同じ AI で、1手 約30秒じっくり読みます', time: 30000, parallel: true, tm: '約30秒' },
  };
  // 超最強は、読む量を増やすとはっきり強くなると測れたとき（train/match.js time → weights.js の levels.ultraOk）だけ出す
  const ULTRA = !!(WT && WT.levels && WT.levels.ultraOk);
  const CPU_KEYS = ULTRA ? ['easy', 'normal', 'strong', 'max', 'ultra'] : ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 4000, HINT_MS = 3000;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('amazons-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('amazons-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'white', cpuW: 'strong', cpuB: 'strong' }, store.get('cfg', {}));
  if (!CPU_KEYS.includes(cfg.cpu)) cfg.cpu = CPU[cfg.cpu] ? 'max' : 'normal';
  if (!CPU_KEYS.includes(cfg.cpuW)) cfg.cpuW = 'max';
  if (!CPU_KEYS.includes(cfg.cpuB)) cfg.cpuB = 'max';
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  // AI補助: showEval = 形勢、terr = 陣地を盤に塗る、best = 最善手の矢印
  const settings = Object.assign({ sound: true, anim: true, analyze: true, showEval: true, terr: true, best: true, confirm: coarse }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.terr || settings.best;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    seats: ['human', 'normal'], moves: [], hist: [new Position()], evals: [], view: null, result: null,
    info: null, cpuInfo: null, thinking: false, timer: 0, resultShown: false, hover: -1,
    sel: { from: 0, to: 0, arrow: 0 }, inspect: 0, userFlip: false,
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
  const clearSel = () => { S.sel.from = 0; S.sel.to = 0; S.sel.arrow = 0; };

  // ------------------------------------------------------------------ CPU（Web Worker）
  function workerMain() {
    const A = {};
    AmazonsCore(A);
    AmazonsAI(A);
    let S = null;
    const pack = r => ({ move: r.move, score: r.score, depth: r.depth, pv: r.pv, nodes: r.nodes, evals: r.evals, time: r.time, legal: r.legal, partial: !!r.partial });
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') { S = new A.Searcher(A.evalFromWeights(j.w), { ttBits: 18 }); return; }
      const pos = A.Position.fromMoves(j.moves);
      const r = S.think(pos, { timeMs: j.timeMs, maxDepth: j.maxDepth, noise: j.noise, noiseRel: j.noiseRel, analyze: j.analyze, split: j.split, seed: j.seed, onInfo: info => self.postMessage({ id: j.id, type: 'info', info: pack(info) }) });
      self.postMessage({ id: j.id, type: 'done', info: pack(r) });
    };
  }
  const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const AI = {
    pool: [], id: 0, busy: false, fallback: null, src: null,
    make() {
      try {
        if (!this.src) this.src = URL.createObjectURL(new Blob([AmazonsCore.toString() + '\n' + AmazonsAI.toString() + '\n(' + workerMain.toString() + ')();'], { type: 'text/javascript' }));
        const w = new Worker(this.src);
        w.postMessage({ type: 'init', w: WT });
        return w;
      } catch (e) {
        return null; // Worker が使えない環境ではメインスレッドで考える
      }
    },
    ensure(n) {
      while (this.pool.length < n) { const w = this.make(); if (!w) break; this.pool.push(w); }
      return Math.min(n, this.pool.length);
    },
    // 複数のワーカーは、1手目の候補を分けて受け持つ（評価順で i, i+n, …番目）。深さをそろえて一番良い手を選ぶ
    merge(hists) {
      const have = hists.filter(h => h.length);
      if (!have.length) return null;
      const D = Math.min(...have.map(h => h[h.length - 1].depth));
      let best = null, evals = 0, nodes = 0, time = 0, legal = 0;
      for (const h of have) {
        const r = h.filter(x => x.depth === D).pop() || h[h.length - 1];
        evals += h[h.length - 1].evals || 0; nodes += h[h.length - 1].nodes || 0; time = Math.max(time, h[h.length - 1].time || 0); legal = Math.max(legal, r.legal || 0);
        if (!best || r.score > best.score) best = r;
      }
      return Object.assign({}, best, { evals, nodes, time, legal, threads: hists.length });
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
          if (!this.fallback) this.fallback = new A.Searcher(EV, { ttBits: 16 });
          finish(this.fallback.think(Position.fromMoves(job.moves), { timeMs: Math.min(job.timeMs, 1500), maxDepth: job.maxDepth, noise: job.noise, noiseRel: job.noiseRel, analyze: job.analyze, seed: job.seed }));
        }, 30);
        return;
      }
      const hists = Array.from({ length: n }, () => []), done = new Array(n).fill(false);
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.id !== this.id) return;
          if (m.type === 'info' || (m.type === 'done' && !m.info.partial && m.info.move >= 0)) {
            const h = hists[i];
            if (!h.length || h[h.length - 1].depth !== m.info.depth) h.push(m.info); else h[h.length - 1] = m.info;
          }
          if (m.type === 'info') { const r = n > 1 ? this.merge(hists) : m.info; if (r && onInfo) onInfo(r); return; }
          done[i] = true;
          if (n === 1 && m.info.partial && m.info.move >= 0) hists[0].push(m.info);
          if (done.every(Boolean)) finish(n > 1 ? this.merge(hists) : (hists[0].length ? hists[0][hists[0].length - 1] : m.info));
        };
        w.postMessage({ type: 'think', id, moves: job.moves, timeMs: job.timeMs, maxDepth: job.maxDepth, noise: job.noise || 0, noiseRel: job.noiseRel || 0, analyze: job.analyze, seed: job.seed, split: n > 1 ? { i, n } : null });
      });
    },
    cancel() {
      if (this.busy) { this.pool.forEach(w => w.terminate()); this.pool = []; } // 途中で止める手段がないので作り直す
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 音（WebAudio で合成）
  let actx = null;
  function sound(kind, delay = 0) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + delay;
      if (kind === 'move' || kind === 'thunk') {
        // 木の駒を置く音 / 矢が刺さる音
        const len = kind === 'move' ? 0.07 : 0.05, n = Math.floor(actx.sampleRate * len);
        const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
        const src = actx.createBufferSource(); src.buffer = buf;
        const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'move' ? 1300 : 700; bp.Q.value = 1.4;
        const g = actx.createGain(); g.gain.setValueAtTime(kind === 'move' ? 1.2 : 1.5, t);
        src.connect(bp).connect(g).connect(actx.destination); src.start(t);
        const o = actx.createOscillator(), og = actx.createGain();
        o.frequency.setValueAtTime(kind === 'move' ? 300 : 180, t); o.frequency.exponentialRampToValueAtTime(kind === 'move' ? 130 : 70, t + 0.08);
        og.gain.setValueAtTime(kind === 'move' ? 0.25 : 0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.12);
      } else if (kind === 'whoosh') {
        // 矢が飛ぶ音: 帯域を上から下へ動かしたノイズ
        const len = 0.22, n = Math.floor(actx.sampleRate * len);
        const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / n);
        const src = actx.createBufferSource(); src.buffer = buf;
        const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
        bp.frequency.setValueAtTime(3200, t); bp.frequency.exponentialRampToValueAtTime(900, t + len);
        const g = actx.createGain(); g.gain.setValueAtTime(0.35, t);
        src.connect(bp).connect(g).connect(actx.destination); src.start(t);
      } else if (kind === 'tick') {
        const o = actx.createOscillator(), og = actx.createGain();
        o.frequency.setValueAtTime(880, t);
        og.gain.setValueAtTime(0.06, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.07);
      }
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuW, cfg.cpuB];
    else {
      const human = cfg.side === 'random' ? (Math.random() < 0.5 ? WHITE : BLACK) : cfg.side === 'black' ? BLACK : WHITE;
      seats = human === WHITE ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    S.userFlip = false;
    loadGame({ seats, moves: [] });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.seats = g.seats; S.online = g.online || null;
    S.moves = []; S.hist = [new Position()]; S.evals = g.evals ? g.evals.slice() : [];
    for (const m of g.moves) { const p = S.hist[S.hist.length - 1].clone(); p.make(m); S.hist.push(p); S.moves.push(m); }
    S.view = null; S.result = g.result || null; S.info = null; S.cpuInfo = null;
    S.resultShown = !!g.result; clearSel(); S.inspect = 0;
    afterChange();
  }

  function saveGame() {
    const online = S.online ? { mid: S.online.mid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { seats: S.seats, moves: S.moves.map(A.toWire), result: S.result, evals: S.evals.map(v => (v == null ? null : Math.round(v * 100) / 100)), online });
  }

  function rebuild(n) {
    S.moves.length = n; S.hist.length = n + 1; S.evals.length = Math.min(S.evals.length, n + 1);
    S.result = null; S.resultShown = false;
  }

  function play(m, fromRemote) {
    const pos = curPos();
    if (!pos.isLegal(m)) return;
    const p = pos.clone(); p.make(m);
    S.moves.push(m); S.hist.push(p);
    clearSel(); S.inspect = 0;
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: S.moves.length, m: A.toWire(m) });
    afterChange({ move: m });
    if (S.online && NET) NET.saveState({ moves: S.moves.map(A.toWire), r: S.result ? 1 : 0 });
  }

  function afterChange(anim) {
    S.hover = -1;
    if (!S.result) {
      const r = curPos().result();
      if (r) S.result = { winner: r.winner, reason: `${SIDE[r.loser]}は動ける手がなくなりました` };
    }
    S.info = null; S.cpuInfo = null; terrCache = null;
    saveGame();
    render(anim);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, anim && settings.anim ? 1100 : 350); }
    schedule(anim);
  }

  // 「新しい対局」を開いている間は裏の対局を進めない（CPU は読まず指さない。閉じたら schedule() で続ける）
  const choosing = () => !$('dlg-new').hidden;

  function schedule(anim) {
    clearTimeout(S.timer);
    S.thinking = false;
    if (choosing()) { AI.cancel(); renderPlayers(); return; }
    if (!live() || S.result) { analyze(); return; }
    const c = curPos().stm;
    if (isRemote(c)) { AI.cancel(); renderEval(); return; }
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = S.moves.length, t0 = Date.now();
    // 動きが終わってから読み始めたように見せる（読みは裏ですぐ始める）
    const animWait = anim && settings.anim && !reduceMotion ? 700 : 0;
    S.thinking = true;
    renderPlayers(); renderSqInfo(); renderMarks();
    // 強い CPU も序盤の6手は評価に小さな揺らぎを入れて、毎回同じ指し方にならないようにする
    // 弱い段の揺らぎ（noise）は、候補の値の散らばりに対する割合。強い段は散らばりの 0.05 倍
    const noiseRel = cpu.noise || (ply < 6 ? 0.05 : 0);
    AI.start({ moves: S.moves.slice(), timeMs: cpu.time, maxDepth: cpu.depth, noiseRel, parallel: !!cpu.parallel, seed: (Math.random() * 1e9) | 0 },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        const wait = Math.max(120, 450 + animWait - (Date.now() - t0));
        if (live() && S.moves.length === ply && !S.result && !choosing() && info && info.move >= 0) S.timer = setTimeout(() => play(info.move), wait);
      });
  }
  // 長く考える段で「すぐ指す」: 今までに読み終えた中で一番良い手を指す
  function moveNow() {
    const ci = S.cpuInfo;
    if (!S.thinking || !ci || ci.best == null || ci.ply !== S.moves.length) return;
    AI.cancel(); S.thinking = false;
    play(ci.best);
  }

  // 人間の手番（または棋譜を見返しているとき）に形勢を読む
  function analyze(force, ms, kind = 'analysis') {
    const pos = shownPos();
    if (((!settings.analyze || !(settings.showEval || settings.best)) && !force) || pos.isOver()) { AI.cancel(); renderEval(); renderMarks(); return; }
    const ply = shownPly(), c = pos.stm;
    AI.start({ moves: S.moves.slice(0, ply), timeMs: ms || ANALYZE_MS, analyze: true, parallel: true },
      info => onInfo(ply, c, info, kind), info => onInfo(ply, c, info, kind));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || info.move == null || info.move < 0) return;
    const scoreW = c === WHITE ? info.score : -info.score;
    // 弱い CPU（揺らぎあり・1手読み）の値は形勢には使わない
    const cpuWeak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if (!cpuWeak) S.evals[ply] = scoreW;
    const rec = { ply, scoreW, pv: info.pv || [info.move], depth: info.depth, evals: info.evals, time: info.time, stm: c, kind, best: info.move, threads: info.threads || 1, legal: info.legal };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!cpuWeak && (kind !== 'cpu' || !S.info || S.info.ply !== ply)) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderTape(); renderOverlay();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力: アマゾンを選ぶ → 行き先 → 矢を放つマス
  function onSquare(p) {
    const pos = curPos();
    const pc = shownPos().b[p];
    if (!humanTurn()) {
      // 相手の番・見返し中: アマゾンを押すと行ける先を見せる
      S.inspect = (pc === 1 || pc === 2) && S.inspect !== p ? p : 0;
      renderMarks(); renderSqInfo();
      return;
    }
    const me = pos.stm + 1, sel = S.sel;
    S.inspect = 0;
    if (sel.arrow) {
      // 確定を待っているとき: 同じマスでもう一度 → 指す。ほかの矢の先 → 矢を変える
      if (p === sel.arrow) { commit(); return; }
      if (arrowTargets().has(p)) { sel.arrow = p; sound('tick'); renderMarks(); renderSqInfo(); return; }
      if (p === sel.to) { sel.arrow = 0; renderMarks(); renderSqInfo(); }
      return;
    }
    if (sel.to) {
      if (arrowTargets().has(p)) {
        sel.arrow = p;
        if (settings.confirm) { sound('tick'); renderMarks(); renderSqInfo(); } else commit();
        return;
      }
      if (p === sel.to) { sel.to = 0; sound('tick'); renderMarks(); renderSqInfo(); return; } // 行き先を選び直す
      if (pc === me && p !== sel.from) { clearSel(); sel.from = p; sound('tick'); renderMarks(); renderSqInfo(); }
      return;
    }
    if (sel.from) {
      if (p === sel.from) { clearSel(); renderMarks(); renderSqInfo(); return; }
      if (pc === me) { sel.from = p; sound('tick'); renderMarks(); renderSqInfo(); return; }
      if (destTargets().has(p)) { sel.to = p; sound('move'); renderMarks(); renderSqInfo(); return; }
      clearSel(); renderMarks(); renderSqInfo();
      return;
    }
    if (pc === me) {
      if (!pos.reachFrom(p).length) { S.inspect = 0; flashInfo(`${sqName(p)} のアマゾンは囲まれていて動けません`); return; }
      sel.from = p; sound('tick'); renderMarks(); renderSqInfo(); return;
    }
    if (pc === 1 || pc === 2) { S.inspect = p; renderMarks(); renderSqInfo(); }
  }
  function destTargets() { return new Set(S.sel.from ? curPos().reachFrom(S.sel.from) : []); }
  function arrowTargets() {
    if (!S.sel.to) return new Set();
    const pos = curPos(), b = pos.b, f = S.sel.from, t = S.sel.to, out = new Set();
    const me = b[f];
    b[f] = EMPTY; b[t] = me;
    for (const x of pos.reachFrom(t)) out.add(x);
    b[t] = EMPTY; b[f] = me;
    return out;
  }
  function commit() {
    const m = A.mv(S.sel.from, S.sel.to, S.sel.arrow);
    if (!curPos().isLegal(m)) { clearSel(); render(); return; }
    play(m);
  }
  function undoStep() {
    if (S.sel.arrow) S.sel.arrow = 0; else if (S.sel.to) S.sel.to = 0; else S.sel.from = 0;
    renderMarks(); renderSqInfo();
  }
  let flashMsg = '', flashTimer = 0;
  function flashInfo(msg) { flashMsg = msg; clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashMsg = ''; renderSqInfo(); }, 2200); renderSqInfo(); }

  // ------------------------------------------------------------------ 描画
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
    if (mode === 'L-land') bs = Math.min(availH, mainW - 14 - 300);
    else {
      const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
      let other = 0, n = 0;
      for (const el of stage.children) {
        if (el.id === 'board-wrap' || getComputedStyle(el).display === 'none') continue;
        other += el.getBoundingClientRect().height; n++;
      }
      const w = mode === 'L-wide' ? mainW - 340 - 22 : mainW;
      bs = Math.min(w, availH - other - gap * n);
    }
    bs = Math.round(Math.max(220, Math.min(760, bs)));
    if (document.documentElement.style.getPropertyValue('--bs') !== bs + 'px') document.documentElement.style.setProperty('--bs', bs + 'px');
    const over = main.scrollHeight - main.clientHeight;
    if (over > 0 && mode !== 'L-land' && bs > 220) document.documentElement.style.setProperty('--bs', Math.max(220, bs - over) + 'px');
    if (mode === 'L-land') {
      const br = $('board-wrap').getBoundingClientRect();
      $('side').style.setProperty('--sheet-left', Math.round(br.right + 8) + 'px');
    }
  }

  // 盤の向き: 下は自分（人間）の色。CPU と対局で黒を持ったときは黒が下。メニューの「盤を反転」で入れ替え
  function bottomColor() {
    const base = S.online ? S.online.myColor : (isHuman(BLACK) && !isHuman(WHITE) ? BLACK : WHITE);
    return S.userFlip ? base ^ 1 : base;
  }
  let flipped = false;
  const cellP = g => { const r = Math.floor(g / 10), c = g % 10; return flipped ? P(r, 9 - c) : P(9 - r, c); };
  const cellXY = p => { const r = A.rowOf(p), c = A.colOf(p); return flipped ? [9 - c + 0.5, r + 0.5] : [c + 0.5, 9 - r + 0.5]; };
  const cells = new Map(); // 盤の添字 → マスの要素
  const AMZ = c => `<svg class="amz" viewBox="0 0 40 40" aria-hidden="true"><use href="#amz" class="${c ? 'b' : 'w'}"/></svg>`;
  function buildBoard() {
    flipped = bottomColor() === BLACK;
    const grid = $('grid');
    grid.innerHTML = ''; cells.clear();
    for (let g = 0; g < 100; g++) {
      const p = cellP(g), b = document.createElement('button');
      const dark = (A.rowOf(p) + A.colOf(p)) % 2 === 0;
      b.className = 'sq' + (dark ? ' dk' : ''); b.dataset.p = p; b.dataset.dk = dark ? '1' : '';
      b.setAttribute('role', 'gridcell');
      b.innerHTML = '<span class="tint"></span><span class="hl"></span><span class="arw"><svg viewBox="0 0 20 20"><use href="#arw"/></svg></span><span class="pc"></span><span class="dot"></span>';
      b.addEventListener('click', e => { e.stopPropagation(); onSquare(p); });
      b.addEventListener('mouseenter', () => { if (pointerType === 'mouse') { S.hover = p; renderSqInfo(); } });
      b.addEventListener('mouseleave', () => { if (S.hover === p) { S.hover = -1; renderSqInfo(); } });
      grid.appendChild(b); cells.set(p, b);
    }
    const files = 'abcdefghij'.split('');
    $('coords-top').innerHTML = (flipped ? files.slice().reverse() : files).map(c => `<span>${c}</span>`).join('');
    const ranks = Array.from({ length: 10 }, (_, i) => (flipped ? i + 1 : 10 - i));
    $('coords-left').innerHTML = ranks.map(n => `<span>${n}</span>`).join('');
    drawn.clear();
  }
  const drawn = new Map(); // マス → 描いている駒（0 なし・1 白・2 黒）
  let animToken = 0;
  function renderBoard(anim) {
    if ((bottomColor() === BLACK) !== flipped) buildBoard();
    const pos = shownPos(), board = $('board');
    const animate = !!anim && settings.anim && !reduceMotion && live() && drawn.size > 0;
    if (!animate) board.classList.add('noanim');
    const token = ++animToken;
    let mf = 0, mt = 0, ma = 0;
    if (animate) { mf = A.mFrom(anim.move); mt = A.mTo(anim.move); ma = A.mArrow(anim.move); }
    for (const [p, el] of cells) {
      const v = pos.b[p];
      const want = v === 1 || v === 2 ? v : 0;
      if ((drawn.get(p) || 0) !== want) {
        el.querySelector('.pc').innerHTML = want ? AMZ(want - 1) : '';
        drawn.set(p, want);
      }
      el.classList.toggle('blk', v === ARROW && !(animate && p === ma));
    }
    // 矢の絵は、放たれた向きに回す（絵の矢は右上向き）
    for (let i = 0, n = shownPly(); i < n; i++) {
      const m = S.moves[i], [x1, y1] = cellXY(A.mTo(m)), [x2, y2] = cellXY(A.mArrow(m));
      const deg = Math.round(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI + 45), svg = cells.get(A.mArrow(m)).querySelector('.arw svg');
      if (svg.dataset.deg !== String(deg)) { svg.dataset.deg = deg; svg.style.transform = `rotate(${deg}deg)`; }
    }
    if (animate) {
      // 駒がすべるように動き、続いて矢が飛んで刺さる
      const pc = cells.get(mt).querySelector('.pc'), from = cells.get(mf).getBoundingClientRect(), to = cells.get(mt).getBoundingClientRect();
      pc.style.transition = 'none'; pc.style.translate = `${from.left - to.left}px ${from.top - to.top}px`;
      void pc.offsetWidth;
      pc.style.transition = ''; pc.style.translate = '';
      sound('move');
      setTimeout(() => {
        if (token !== animToken) return;
        const [x1, y1] = cellXY(mt), [x2, y2] = cellXY(ma);
        const ov = $('ov'), ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('class', 'fly'); ln.setAttribute('x1', x1); ln.setAttribute('y1', y1); ln.setAttribute('x2', x1); ln.setAttribute('y2', y1);
        ov.appendChild(ln);
        sound('whoosh');
        const t0 = performance.now(), dur = 160 + 25 * Math.hypot(x2 - x1, y2 - y1);
        const step = now => {
          if (token !== animToken) { ln.remove(); return; }
          const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) * (1 - k), tail = Math.max(0, e - 0.35);
          ln.setAttribute('x1', x1 + (x2 - x1) * tail); ln.setAttribute('y1', y1 + (y2 - y1) * tail);
          ln.setAttribute('x2', x1 + (x2 - x1) * e); ln.setAttribute('y2', y1 + (y2 - y1) * e);
          if (k < 1) requestAnimationFrame(step);
          else { ln.remove(); cells.get(ma).classList.add('blk'); sound('thunk'); }
        };
        requestAnimationFrame(step);
      }, 320);
    } else { board.offsetWidth; requestAnimationFrame(() => board.classList.remove('noanim')); }
    // 終局の表示
    let em = $('endmark');
    if (live() && S.result) {
      if (!em) { em = document.createElement('div'); em.id = 'endmark'; em.className = 'endmark'; $('board-wrap').appendChild(em); }
      em.innerHTML = `<b>${SIDE[S.result.winner]}の勝ち</b><span>${esc(S.result.reason)}</span>`;
    } else if (em) em.remove();
    renderMarks();
  }

  // 陣地（先に届く側）。局面ごとに一度だけ数える
  let terrCache = null;
  function terr() {
    const ply = shownPly();
    if (!terrCache || terrCache.ply !== ply || terrCache.n !== S.moves.length) terrCache = Object.assign(A.territory(shownPos()), { ply, n: S.moves.length });
    return terrCache;
  }

  // 選択・行き先・矢の先・暗くするマス・直前の手・陣地
  function renderMarks() {
    if (cells.size !== 100) return;
    const pos = shownPos(), sel = S.sel, my = humanTurn();
    const dests = my ? destTargets() : new Set(), aims = my ? arrowTargets() : new Set();
    const lm = shownPly() ? S.moves[shownPly() - 1] : 0;
    const lf = lm ? A.mFrom(lm) : 0, lt = lm ? A.mTo(lm) : 0, la = lm ? A.mArrow(lm) : 0;
    const reach = S.inspect ? new Set(pos.reachFrom(S.inspect)) : null;
    // 陣地の色は、手を選んでいる間は消す（行き先・矢の先を見やすく）
    const T = settings.terr && aiOn() && !(my && sel.from) ? terr() : null;
    const me = my ? pos.stm + 1 : 0;
    for (const [p, el] of cells) {
      const v = pos.b[p];
      let cls = 'sq' + (el.dataset.dk ? ' dk' : '');
      if (v === ARROW) cls += ' blk';
      if (my) {
        if (sel.arrow) {
          if (p === sel.from) cls += ' ghost' + (aims.has(p) ? ' aim can' : '');
          else if (p === sel.to) cls += ' sel';
          else if (p === sel.arrow) cls += ' pend can';
          else if (aims.has(p)) cls += ' aim can';
          else cls += ' dim';
        } else if (sel.to) {
          if (p === sel.from) cls += ' ghost' + (aims.has(p) ? ' aim can' : '');
          else if (p === sel.to) cls += ' sel can';
          else if (aims.has(p)) cls += ' aim can';
          else if (v === me) cls += ' can';
          else cls += ' dim';
        } else if (sel.from) {
          if (p === sel.from) cls += ' sel can';
          else if (dests.has(p)) cls += ' to can';
          else if (v === me) cls += ' can';
          else cls += ' dim';
        } else if (v === me) cls += ' can';
      }
      if (!sel.from) {
        if (p === lf) cls += ' lastfrom';
        if (p === lt) cls += ' lastto';
        if (p === la) cls += ' lastarw';
      }
      if (reach && reach.has(p)) cls += ' reach';
      if (p === S.inspect) cls += ' inspect';
      if (v === 1 || v === 2 || v === ARROW) { if ((v === 1 || v === 2) && !my) cls += ' can'; }
      if (el.className !== cls) el.className = cls;
      // 確定を待っている矢・選んだ行き先の駒（局面にはまだない）
      const showTo = my && sel.to && p === sel.to, showArrow = my && sel.arrow && p === sel.arrow;
      const want = showArrow ? 0 : showTo ? pos.stm + 1 : (v === 1 || v === 2 ? v : 0);
      if ((drawn.get(p) || 0) !== want) { el.querySelector('.pc').innerHTML = want ? AMZ(want - 1) : ''; drawn.set(p, want); }
      if (showArrow) el.classList.add('pend');
      // 陣地
      const tint = el.firstChild;
      let tc = 'tint';
      if (T && v === EMPTY && !showTo && !showArrow) {
        const i = A.idx100(p), o = T.owner[i];
        if (o === -2) tc += ' td';
        else if (o === -1) tc += ' tn';
        else if (o >= 0) tc += ` t${o ? 'b' : 'w'}${T.sure100[i] ? 3 : T.margin[i] >= 2 ? 2 : 1}`;
      }
      if (tint.className !== tc) tint.className = tc;
      el.setAttribute('aria-label', `${sqName(p)} ${v === 1 ? '白のアマゾン' : v === 2 ? '黒のアマゾン' : v === ARROW ? '矢' : '空き'}`);
    }
    $('board').classList.toggle('thinking', S.thinking);
    renderOverlay();
  }

  // 盤の上の線: 最善手（緑）・ヒント（金）。駒 → 行き先の矢印と、行き先 → 矢のマスの点線
  function renderOverlay() {
    const ov = $('ov');
    if (!ov) return;
    [...ov.querySelectorAll('.mv')].forEach(e => e.remove());
    const info = S.info && S.info.ply === shownPly() && S.info.kind !== 'cpu' ? S.info : null;
    if (!info || info.best == null || info.best < 0 || (live() && S.result) || S.sel.from) return;
    const hint = info.kind === 'hint';
    if (!hint && !(settings.best && aiOn() && (settings.analyze || !live()))) return;
    const m = info.best, [x0, y0] = cellXY(A.mFrom(m)), [x1, y1] = cellXY(A.mTo(m)), [x2, y2] = cellXY(A.mArrow(m));
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    const sx = x0 + ux * 0.3, sy = y0 + uy * 0.3, ex = x1 - ux * 0.42, ey = y1 - uy * 0.42;
    const hx = x1 - ux * 0.14, hy = y1 - uy * 0.14, w = 0.2;
    const L2 = Math.hypot(x2 - x1, y2 - y1), vx = (x2 - x1) / L2, vy = (y2 - y1) / L2;
    const k = hint ? ' hint' : '';
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'mv');
    g.innerHTML = `<line class="best${k}" x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}"/>
      <polygon class="${hint ? 'hintf' : 'bestf'}" points="${hx},${hy} ${ex - uy * w},${ey + ux * w} ${ex + uy * w},${ey - ux * w}"/>
      <line class="best shot${k}" x1="${x1 + vx * 0.38}" y1="${y1 + vy * 0.38}" x2="${x2 - vx * 0.36}" y2="${y2 - vy * 0.36}"/>
      <circle class="tgt${k}" cx="${x2}" cy="${y2}" r=".3"/><circle class="${hint ? 'hintf' : 'bestf'}" cx="${x2}" cy="${y2}" r=".07"/>`;
    ov.appendChild(g);
  }

  function renderPlayers() {
    const pos = shownPos();
    const bottom = bottomColor();
    const T = settings.terr && aiOn() ? terr() : null;
    [['player-top', bottom ^ 1], ['player-bottom', bottom]].forEach(([id, c]) => {
      const el = $(id);
      const turn = live() && !S.result && pos.stm === c;
      el.classList.toggle('turn', turn);
      let st = '';
      if (turn && isCPU(c) && S.thinking) {
        const ci = S.cpuInfo, cpu = CPU[S.seats[c]];
        st = `<span class="think"><i></i>考え中${ci && !cpu.noise && ci.depth > 1 ? `・${ci.depth}手先` : ''}</span>${cpu.time >= 5000 && ci && ci.depth >= 2 ? '<button class="now" data-act="now">すぐ指す</button>' : ''}`;
      } else if (turn && isCPU(c) && choosing()) {
        st = '<span class="think">待っています</span>';
      } else if (turn && isRemote(c)) {
        st = S.online && NET && NET.status === 'on' && !S.online.oppPresent ? '<span class="think lost">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think win">勝ち</span>' : '<span class="think lose">負け</span>';
      }
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : seatLabel(c);
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      const movable = pos.q[c].reduce((a, p) => a + (pos.reachFrom(p).length ? 1 : 0), 0);
      const cnt = T ? `<span class="count" title="${SIDE[c]}が先に届く空きマスの数"><b>${T.count[c]}</b><small>陣地</small></span>`
        : `<span class="count" title="動けるアマゾンの数"><b>${movable}</b><small>動ける</small></span>`;
      el.innerHTML = `
        <svg class="chip" viewBox="0 0 40 40" aria-hidden="true"><use href="#amz" class="${c ? 'b' : 'w'}"/></svg>
        <div class="id"><span class="name">${nm}</span><span class="sub">${SIDE[c]}${c === WHITE ? '・先手' : ''}</span>${tag}</div>
        <div class="right">${st}${cnt}</div>`;
    });
  }

  // 情報の行（盤のすぐ下、高さ固定）
  function moveText(i) { const c = S.hist[i - 1].stm; return `${SIDE[c]} ${moveName(S.moves[i - 1])}`; }
  function renderSqInfo() {
    const el = $('sqinfo'), pos = shownPos();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = pos.stm, n = shownPly(), sel = S.sel;
    if (!live()) {
      cls += ' view';
      html = `<span class="txt"><b>${n ? `${n}手目` : '開始局面'}</b>${n ? ` ${moveText(n)}` : ''}　<span class="muted">見返し中</span></span>`;
      tools = btn('branch', 'ここから指す') + btn('live', '最新へ', ' primary');
    } else if (S.result && S.online) {
      cls += ' result';
      const r = S.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（白黒を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>　${esc(r.reason)}</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      html = `<span class="txt"><b>${SIDE[S.result.winner]}の勝ち</b>　${esc(S.result.reason)}</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' bad';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' bad';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (flashMsg) {
      cls += ' alert';
      html = `<span class="txt">${esc(flashMsg)}</span>`;
    } else if (humanTurn() && sel.arrow) {
      cls += ' step';
      html = `<span class="txt"><b>${moveName(A.mv(sel.from, sel.to, sel.arrow))}</b>　<span class="muted">この手でよければ確定</span></span>`;
      tools = btn('back', '戻す') + btn('commit', '確定', ' primary');
    } else if (humanTurn() && sel.to) {
      cls += ' step';
      html = `<span class="txt">${sqName(sel.from)}→<b>${sqName(sel.to)}</b>　<b>矢を放つマス</b>を選んでください</span>`;
      tools = btn('back', '戻す');
    } else if (humanTurn() && sel.from) {
      cls += ' step';
      html = `<span class="txt"><b>${sqName(sel.from)}</b> のアマゾン　<b>行き先</b>を選んでください</span>`;
      tools = btn('back', 'やめる');
    } else if (S.inspect) {
      const v = pos.b[S.inspect];
      html = `<span class="txt"><b>${sqName(S.inspect)}</b> ${SIDE[v - 1]}のアマゾン　<span class="muted">行けるマス ${pos.reachFrom(S.inspect).length}か所</span></span>`;
    } else if (S.hover >= 0 && pos.b[S.hover] === EMPTY && settings.terr && aiOn()) {
      const T = terr(), i = A.idx100(S.hover), d = T.dist;
      const f = x => (x === 255 ? '届かない' : `${x}手`);
      html = `<span class="txt"><b>${sqName(S.hover)}</b>　<span class="muted">白 ${f(d[0][i])}・黒 ${f(d[1][i])}で届く</span>${T.owner[i] >= 0 ? `（${SIDE[T.owner[i]]}の陣地）` : T.owner[i] === -1 ? '（争い）' : '（どちらも届かない）'}</span>`;
    } else if (isCPU(c) && S.thinking) {
      html = `<span class="txt muted">${seatLabel(c)}が考えています…${n ? `　直前 ${moveText(n)}` : ''}</span>`;
    } else if (isRemote(c)) {
      html = `<span class="txt"><b>${esc(S.online ? S.online.opp.name : '相手')}さん</b>の番です　<span class="muted">${n ? `直前 ${moveText(n)}` : ''}</span></span>`;
    } else {
      const who = isHuman(c) && S.seats[c ^ 1] !== 'human' ? `あなた（${SIDE[c]}）` : SIDE[c];
      html = `<span class="txt"><b>${who}の番</b>　<span class="muted">${humanTurn() ? 'アマゾンを選んでください' : ''}${n ? `${humanTurn() ? '・' : ''}直前 ${moveText(n)}` : ''}</span></span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ
  const winW = v => A.winRate(v);
  function badMove(i) { // i 手目が大きく形勢を損ねた手か
    const a = S.evals[i - 1], b = S.evals[i];
    if (!settings.showEval || a == null || b == null) return false;
    const mover = S.hist[i - 1].stm;
    return (winW(b) - winW(a)) * (mover === WHITE ? 1 : -1) < -0.2;
  }
  function renderTape() {
    const el = $('tape');
    const cur = shownPly();
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    for (let i = 1; i <= S.moves.length; i++) {
      const c = S.hist[i - 1].stm, bad = badMove(i);
      html += `<button data-ply="${i}" class="${cur === i ? 'cur' : ''}${bad ? ' bad' : ''}"><span class="no">${i}</span><span class="mini ${c ? 'b' : 'w'}"></span>${moveName(S.moves[i - 1])}${bad ? '?' : ''}</button>`;
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
    $('btn-undo').disabled = !S.moves.length || !!S.online || ![WHITE, BLACK].some(isHuman);
    $('btn-resign').disabled = !live() || !!S.result || ![WHITE, BLACK].some(isHuman);
    $('btn-hint').disabled = !humanTurn();
    $('kifu-info').textContent = `${S.moves.length}手${S.result ? '・終局' : ''}`;
  }

  // 形勢: 白の勝つ見込み（評価値はロジット）
  function evalLabel(pW) {
    const p = Math.max(pW, 1 - pW), who = pW >= 0.5 ? '白' : '黒';
    if (p < 0.56) return '互角';
    return who + (p < 0.66 ? 'やや有利' : p < 0.8 ? '有利' : p < 0.93 ? '優勢' : '勝勢');
  }
  function renderEval() {
    const ply = shownPly(), pos = shownPos();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sW = info ? info.scoreW : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    const strip = (n, l, best) => { $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best; };
    renderTerr();
    if (pos.isOver()) {
      const w = pos.stm ^ 1;
      num.textContent = `${SIDE[w]}の勝ち`; lbl.textContent = '終局';
      setWR(w === WHITE ? 1 : 0);
      $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip(SIDE[w] + '勝ち', '終局', '');
      return;
    }
    if (sW == null) {
      num.textContent = '—';
      lbl.textContent = (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', lbl.textContent, '');
      return;
    }
    const pW = winW(sW);
    const lead = pW >= 0.5 ? WHITE : BLACK, pct = Math.round(Math.max(pW, 1 - pW) * 100);
    num.textContent = Math.abs(sW) >= A.WIN - 300 ? `${SIDE[sW > 0 ? WHITE : BLACK]}の勝ち` : `${SIDE[lead]} ${pct}%`;
    lbl.textContent = Math.abs(sW) >= A.WIN - 300 ? '読み切り' : evalLabel(pW);
    setWR(pW);
    let best = '';
    if (info && info.pv && info.pv.length) {
      const c0 = pos.stm, txt = [];
      info.pv.slice(0, 8).forEach((m, k) => { const col = (c0 + k) & 1; txt.push(`<span class="mini ${col ? 'b' : 'w'}"></span>${moveName(m)}`); });
      $('pv').innerHTML = `<span class="k">読み筋</span><span class="best">${txt[0]}</span> ${txt.slice(1).join(' ')}`;
      const eps = info.time ? Math.round(info.evals / info.time * 1000) : 0;
      $('ev-meta').textContent = `${info.depth}手先まで ・ 合法手 ${(info.legal || 0).toLocaleString()} ・ ${(info.evals || 0).toLocaleString()} 局面を評価 ・ ${(info.time / 1000).toFixed(1)}秒${info.threads > 1 ? ` ・ ${info.threads}スレッド` : ''} ・ ${eps.toLocaleString()} 局面/秒`;
      if (info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${moveName(info.pv[0])}`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(num.textContent, lbl.textContent, best);
  }
  function renderTerr() {
    const el = $('terr');
    if (!el) return;
    const T = terr();
    el.innerHTML = `<span><span class="sw w"></span>白の陣地 <b>${T.count[0]}</b>${T.sure[0] ? `（確定 ${T.sure[0]}）` : ''}</span><span><span class="sw b"></span>黒の陣地 <b>${T.count[1]}</b>${T.sure[1] ? `（確定 ${T.sure[1]}）` : ''}</span><span><span class="sw n"></span>争い <b>${T.neutral}</b></span>`;
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-wt').textContent = `白 ${(p * 100).toFixed(0)}%`;
    $('wr-bt').textContent = `黒 ${(100 - p * 100).toFixed(0)}%`;
  }

  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.moves.length, 60);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.moves.length; i++) {
      const p = S.hist[i];
      const v = p.isOver() ? (p.stm === BLACK ? 1 : 0) : S.evals[i] != null ? winW(S.evals[i]) : null;
      if (v != null) pts.push([x(i), y(v)]);
    }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">白</text><text x="3" y="${H - 4}">黒</text>`;
    if (pts.length) {
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      html += `<polygon class="areab" points="${pts[0][0].toFixed(1)},${y(0.5)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0.5)}"/><polyline class="lineb" points="${line}"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    const cs = S.evals[shownPly()];
    if (cs != null) html += `<circle class="dot" cx="${cx}" cy="${y(winW(cs))}" r="3.5"/>`;
    svg.innerHTML = html;
  }

  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>開始</span></li>`];
    for (let i = 1; i <= S.moves.length; i++) {
      const c = S.hist[i - 1].stm, s = S.evals[i], bad = badMove(i);
      const ev = s != null && settings.showEval ? `${Math.round(winW(s) * 100)}%` : '';
      rows.push(`<li data-ply="${i}" class="${cur === i ? 'cur' : ''}"><span class="no">${i}</span><span class="mini ${c ? 'b' : 'w'}"></span><span>${moveName(S.moves[i - 1])}${bad ? '?' : ''}</span><span class="ev${bad ? ' bad' : ''}" title="白の勝つ見込み">${ev}</span></li>`);
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
    S.info = null; S.hover = -1; S.inspect = 0; clearSel();
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }

  function undo() {
    if (!S.moves.length || S.online) return; // オンライン対局では待ったなし
    AI.cancel(); clearTimeout(S.timer);
    S.view = null;
    let n = S.moves.length - 1;
    // 人間の番まで戻す（CPU の手は飛ばす）
    if ([WHITE, BLACK].some(isHuman)) while (n > 0 && !isHuman(S.hist[n].stm)) n--;
    rebuild(n);
    clearSel();
    afterChange();
  }

  function resign() {
    if (!live() || S.result) return;
    const humans = [WHITE, BLACK].filter(isHuman);
    if (!humans.length) return;
    const loser = humans.includes(curPos().stm) ? curPos().stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    S.result = { winner: loser ^ 1, resigned: true, reason: `${SIDE[loser]}の投了` };
    if (S.online && NET) { NET.send({ t: 'resign' }); NET.saveState({ moves: S.moves.map(A.toWire), r: 1 }); }
    afterChange();
  }

  function kifuText() {
    const lines = ['アマゾンズ 棋譜', `白：${seatLabel(WHITE)} / 黒：${seatLabel(BLACK)}`, A.transcript(S.moves)];
    if (S.result) lines.push(`まで ${SIDE[S.result.winner]}の勝ち（${S.result.reason}）`);
    return lines.join('\n');
  }
  function importKifu(text) {
    const body = String(text).split(/\r?\n/).filter(l => !/棋譜|白：|まで/.test(l)).join(' ');
    const moves = A.parseMoves(body);
    if (!moves.length) throw new Error('手（d1-d7/g7 など）が見つかりません');
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
    schedule(); // 裏の対局を止める
    $('ng-start').focus();
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦'], ['online', 'オンライン対戦']], draft.mode);
    $('ng-cpu').style.gridTemplateColumns = `repeat(${CPU_KEYS.length}, minmax(0, 1fr))`;
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(CPU_KEYS.length - CPU[k].stars)}</span><b>${CPU[k].label}</b><i class="tm">${CPU[k].tm}</i><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['white', '白（先に指す）'], ['black', '黒'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
  }

  function showResult() {
    const r = S.result;
    if (!r) return;
    const humans = [WHITE, BLACK].filter(isHuman);
    let title = `${SIDE[r.winner]}の勝ち`;
    if (S.online) title = r.winner === S.online.myColor ? 'あなたの勝ち' : 'あなたの負け';
    else if (humans.length === 1) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${S.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.online ? `相手は ${esc(S.online.opp.name)} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[humans[0] ^ 1]].label}）でした。` : '';
    $('rs-body').innerHTML = `${esc(r.reason)}。${opp}`;
    $('rs-again').textContent = S.online ? 'もう一局（白黒を交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI ページ
  // 小さな盤の図。cells: 100文字（下の段から。. 空き / w 白 / b 黒 / x 矢）。marks: 100マスの番号 → 'm' 行ける・'a' 矢の先・'f' 枠・'tw' 'tb' 'tn' 陣地
  function miniBoard(cells, marks = {}) {
    let h = '<div class="minib" aria-hidden="true">';
    for (let r = 9; r >= 0; r--) for (let c = 0; c < 10; c++) {
      const i = r * 10 + c, ch = cells[i];
      h += `<i class="${(r + c) % 2 === 0 ? 'dk' : ''}${ch === 'w' ? ' w' : ch === 'b' ? ' b' : ch === 'x' ? ' x' : ''}${marks[i] ? ' ' + marks[i] : ''}"></i>`;
    }
    return h + '</div>';
  }
  const posCells = p => { let s = ''; for (let i = 0; i < 100; i++) s += '.wbx'[p.at(i)]; return s; };
  function renderRules() {
    const p0 = new Position();
    const d1 = P(0, 3), d7 = P(6, 3), g7 = P(6, 6);
    const m1 = {}; p0.reachFrom(d1).forEach(p => { m1[A.idx100(p)] = 'm'; }); m1[A.idx100(d1)] = 'f';
    const p1 = p0.clone(); p1.b[d1] = EMPTY; p1.b[d7] = 1;
    const m2 = {}; p1.reachFrom(d7).forEach(p => { m2[A.idx100(p)] = 'a'; }); m2[A.idx100(d7)] = 'f';
    const p2 = p0.clone(); p2.make(A.mv(d1, d7, g7));
    const m3 = { [A.idx100(d7)]: 'f', [A.idx100(g7)]: 'f' };
    // 終わり方の例: 囲まれた陣地
    const pe = Position.fromMoves(A.parseMoves('d1-d7/g7 g10-g8/g9'));
    const te = A.territory(pe), mt = {};
    for (let i = 0; i < 100; i++) { const o = te.owner[i]; if (o === 0) mt[i] = 'tw'; else if (o === 1) mt[i] = 'tb'; else if (o === -1) mt[i] = 'tn'; }
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>10×10 の盤で、<b>白と黒</b>が4体ずつの「アマゾン」を動かします。<b>白が先</b>です。</li>
          <li>1手は2つの動きでできています。①自分のアマゾンを1体、<b>チェスのクイーンのように</b>（縦・横・斜めに、何マスでも）動かす。②動いた先から、同じくクイーンのように<b>矢を放つ</b>。</li>
          <li>矢が刺さったマスは、<b>最後までふさがったまま</b>です。アマゾンも矢も、ほかのアマゾンや矢を飛び越えられません（動いたアマゾンが元いたマスには矢を放てます）。</li>
          <li>駒を取ることはありません。盤がだんだんふさがっていき、<b>自分の番に1手も指せなくなった側の負け</b>です（引き分けはありません）。</li>
        </ul>
        <div class="figs">
          <figure>${miniBoard(posCells(p0), m1)}<figcaption>はじめの並び。d1 のアマゾンが行けるのは青い点のマス</figcaption></figure>
          <figure>${miniBoard(posCells(p1), m2)}<figcaption>d7 へ動いたら、そこから赤い輪のどこかへ矢を放つ</figcaption></figure>
          <figure>${miniBoard(posCells(p2), m3)}<figcaption>g7 に矢。この手は「d1-d7/g7」と書く</figcaption></figure>
        </div>
      </div>
      <div class="card" data-tab="終わり方">
        <h3>終わり方と陣地</h3>
        <ul>
          <li>勝ち負けは「最後に指せた側」で決まります。動けるアマゾンが残っていても、まわりがすべてふさがっていれば動けません。</li>
          <li>中盤からは、矢で盤を<b>区切って</b>、自分のアマゾンだけが入れる広い部屋（陣地）を作るのがねらいになります。陣地の空きマスの数だけ、あとで手を指せるからです。</li>
          <li>部屋が完全に分かれたら、あとは手の数の比べ合い。自分の部屋のマスを1つずつ埋めていき、先に指す手がなくなった側が負けます。</li>
          <li>このアプリの「陣地」は、空きマスごとに<b>どちらのアマゾンが先に届くか</b>（クイーンの動きで何手か。同じなら1マスずつの動きで比べる）を塗ったものです。白の陣地は明るく、黒の陣地は暗く、同じ手数で争っているマスは斜線です。</li>
        </ul>
        <div class="figs"><figure>${miniBoard(posCells(pe), mt)}<figcaption>2手目のあとの陣地のようす（明るい＝白が先に届く、暗い＝黒、斜線＝争い）</figcaption></figure></div>
      </div>
      <div class="card" data-tab="操作">
        <h3>このアプリの操作</h3>
        <ul>
          <li>自分の番に<b>アマゾンをタップ</b> → 浮き上がり、行ける先に青い点が出ます（ほかは暗くなります）→ <b>行き先をタップ</b> → 矢を放てる先に赤い輪が出ます → <b>矢のマスをタップ</b>で指します。</li>
          <li>途中で「戻す」（または選んだアマゾンをもう一度タップ）で一つ前に戻れます。設定の「矢を選んだあと『確定』で指す」をオンにすると、矢を選んでから「確定」を押すまで指しません（スマホではオンで始まります）。</li>
          <li>相手のアマゾンをタップすると、その行ける先が赤い点で出ます。</li>
          <li><b>AI補助</b>：形勢（勝つ見込み）・陣地の色・最善手の緑の矢印（駒の動きと、点線の先の矢のマス）をまとめて出し入れします。細かくは右上の歯車で。<b>ヒント</b>は AI が約3秒読んで、おすすめの手を金の矢印で示します。</li>
          <li>盤の下の<b>棋譜テープ</b>で前の局面に戻って見返せます。「ここから指す」でその局面から指し直せます。</li>
          <li><b>オンライン</b>：右上のボタン、または「新しい対局」の「オンライン対戦」から。相手を待つか、待っている人に申し込みます。招待リンクで友達とも指せます。オンラインでは「待った」はなく、相手が AI補助やヒントを使っているかが表示されます。</li>
        </ul>
      </div>
      <div class="card" data-tab="由来">
        <h3>このゲームについて</h3>
        <p>アマゾンズは、1988年にアルゼンチンのワルテル・セナによって考えられ、雑誌で紹介されてから広まった2人用のゲームです。ルールは自由に遊ばれていて、コンピューターどうしの大会の種目にもなっています。囲碁のように陣地を囲い合う性格と、チェスのような駒の動きをあわせ持ちます。</p>
        <p>1手の組み合わせ（どのアマゾンを・どこへ・どこへ矢を）がとても多く、はじめの局面だけで <b>2,176通り</b> あります。そのため、コンピューターにとって難しいゲームの一つとして研究されてきました。</p>
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

  // AI が自分で見つけたこと: 学習した表から、空きマス1つの値を「どちらが先に届くか」の種類ごとに平均する（自己対局でよく出る組ほど重く）
  function learnedHTML() {
    if (!WT || !WT.data || EV.empty) return '';
    const QN = A.QN, F = WT.freq;
    const cats = [
      ['自分だけが届く', (m, o) => o === 5 && m < 5],
      ['自分が先に届く', (m, o) => m < o && o < 5],
      ['同じ手数（争い）', (m, o) => m === o && m < 5],
      ['相手が先に届く', (m, o) => o < m && m < 5],
      ['相手だけが届く', (m, o) => m === 5 && o < 5],
    ];
    const phases = [[10, '序盤（10手目）'], [30, '中盤（30手目）'], [55, '終盤（55手目）']];
    const val = (ply, test) => {
      const T = EV.tables[ply];
      let s = 0, w = 0;
      for (let qm = 0; qm < QN; qm++) for (let qo = 0; qo < QN; qo++) {
        if (!test(qm, qo)) continue;
        for (let km = 0; km < QN; km++) for (let ko = 0; ko < QN; ko++) {
          const i = ((qm * QN + qo) * QN + km) * QN + ko, f = F ? F[i] : 1;
          if (!f) continue;
          s += f * T[i]; w += f;
        }
      }
      return w ? s / w : 0;
    };
    const fmt = v => `<span style="color:${v > 0.005 ? 'var(--good)' : v < -0.005 ? 'var(--bad)' : 'var(--muted)'}">${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(3)}</span>`;
    const rows = cats.map(([name, test]) => `<tr><td>${name}</td>${phases.map(([ply]) => `<td>${fmt(val(ply, test))}</td>`).join('')}</tr>`).join('');
    return `<div class="card" data-tab="見つけたこと">
      <h3>AI が自分で見つけたこと</h3>
      <p class="hint">人は何も教えていませんが、自己対局をくり返すうちに、空きマス1つの「値」を学びました。数字は、手番の側から見て、そのマスがあると勝つ見込み（ロジット）がどれだけ動くか。「先に届く」はクイーンの動きで何手で届くかの比べ合いです（自己対局でよく出る形ほど重く平均）。</p>
      <div class="tbl"><table class="lv"><thead><tr><th>空きマスの種類</th>${phases.map(p => `<th>${p[1]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">相手より先に届くマスは得、相手しか届かないマスは損 — 陣地の考え方そのものを、勝ち負けの結果だけから見つけています。</p>
    </div>`;
  }
  function renderAIPage() {
    const W = WT || {};
    const h = W.history || [];
    const gen = W.gen || 0, total = W.totalGames || 0;
    const acc = h.filter(e => e.accepted);
    const bw = 600, bh = 170, pad = 30;
    let cum = 0;
    const series = [{ gen: 0, elo: 0, accepted: true }].concat(h.filter(e => e.elo != null).map(e => { if (e.accepted) cum += Math.max(0, e.elo); return { gen: e.gen, elo: cum, accepted: e.accepted, e }; }));
    let chart = '';
    if (series.length > 1) {
      const maxE = Math.max(50, ...series.map(s => s.elo)), g1 = series[series.length - 1].gen;
      const X = g => pad + g / Math.max(1, g1) * (bw - pad - 8), Y = e => bh - 20 - e / maxE * (bh - 34);
      const ticks = [0, 0.5, 1].map(f => Math.round(maxE * f));
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（新旧の対戦の Elo を積み上げたもの）">
        ${ticks.map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t}</text>`).join('')}
        <polyline points="${series.map(s => `${X(s.gen).toFixed(1)},${Y(s.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${series.slice(1).map(s => `<circle cx="${X(s.gen)}" cy="${Y(s.elo)}" r="${s.accepted ? 3.2 : 2}" fill="${s.accepted ? 'var(--good)' : 'var(--muted)'}"><title>第${s.gen}世代 ${s.accepted ? '採用' : '不採用'}・新旧 ${(s.e.matchScore * 100).toFixed(1)}%（Elo ${s.e.elo >= 0 ? '+' : ''}${s.e.elo}±${s.e.eloErr}）</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第1世代</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代</text>
      </svg>`;
    }
    const ms = (W.measures || []).slice(-40);
    const last = ms[ms.length - 1];
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
    const lv = W.levels;
    const lvRows = lv && lv.results ? lv.results.map(r => `<tr><td>${esc(r.label)}</td><td>${r.win}勝${r.loss}敗</td><td>勝率 ${(r.score * 100).toFixed(0)}%</td><td>Elo ${r.elo >= 0 ? '+' : ''}${r.elo}±${r.eloErr}</td></tr>`).join('') : '';
    const t4 = lv && lv.time4x;
    const t4Row = t4 ? `<tr><td>同じ AI で読む量 4倍 vs 1倍</td><td>${t4.win}勝${t4.loss}敗</td><td>勝率 ${(t4.score * 100).toFixed(0)}%</td><td>Elo ${t4.elo >= 0 ? '+' : ''}${t4.elo}±${t4.eloErr}</td></tr>` : '';
    const rows = h.slice(-14).reverse().map(e => `<tr><td>第${e.gen}世代</td><td>${(e.totalGames || 0).toLocaleString()}</td><td>${e.loss != null ? e.loss.toFixed(3) : '—'}</td><td>${e.matchScore != null ? (e.matchScore * 100).toFixed(1) + '%' : '—'}</td><td>${e.elo != null ? `${e.elo >= 0 ? '+' : ''}${e.elo}±${e.eloErr}` : '—'}</td><td>${e.accepted ? '採用' : '—'}</td></tr>`).join('');
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
        ${chart ? `<div><p class="hint" style="margin:14px 0 6px">世代ごとの検定：「学習した新しい版 vs それまでの版」を、でたらめな序盤2手 × 先後入れ替えで対戦し、勝ち越したら採用（緑）。線はその上昇幅の合計です。</p>${chart}</div>` : '<p>まだ学習の記録がありません。</p>'}
        ${mchart ? `<div class="wide-only"><p class="hint" style="margin:14px 0 6px"><b>実測の強さ</b>：${esc(last.anchor)}（でたらめな対局だけから学んだ版）と、探索ありで先後入れ替えの直接対戦をしたときの Elo 差。縦線は誤差の目安。</p>${mchart}</div>` : ''}
        </div>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>何も教えていない</b>：人が作った定石・評価の点数・棋譜・ほかのソフトは一切使っていません。最初の AI は、でたらめに指した対局の勝ち負けだけから学びました。</li>
          <li><b>評価関数</b>：空きマスごとに「自分と相手のアマゾンが、クイーンの動きで何手で届くか・1マスずつの動きで何手で届くか」の組（1296通り）を見て、その組ごとの点数を足します。アマゾン1体ごとの「1手で行けるマスの数」の点数も足します。点数の表は対局の進み具合で8つに分け、自己対局の勝ち負けを当てるように学びます（ロジスティック回帰）。</li>
          <li><b>強化学習</b>：今いちばん強い AI どうしで何千局も指し、その勝ち負けで点数を直します。直した版が前の版に勝ち越したときだけ採用します。</li>
          <li><b>探索</b>：1手の組み合わせが序盤で 2,000 通りを超えるので、まず全部の手を評価して並べ、上位の数十手だけを深く読みます（反復深化・PVS・置換表・キラー手）。読みの末端では相手の全部の手を評価して一番良い応手を選びます。複数スレッドでは1手目の候補を分けて読みます。</li>
          <li><b>陣地の表示</b>は AI の学習とは別に、ルールだけから数えたもの（どちらのアマゾンが先に届くか）です。</li>
        </ul>
        <table class="lv wide-only" style="margin-top:8px"><thead><tr><th>CPUの強さ</th><th>考え方</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table>
        ${lvRows || t4Row ? `<p class="hint" style="margin:12px 0 4px"><b>段階どうしの対戦</b>（${esc(lv.note || '')}）</p><div class="tbl"><table class="lv"><tbody>${lvRows}${t4Row}</tbody></table></div>${t4 ? `<p class="hint">超最強（最強と同じ AI で約5倍の時間）は、読む量を4倍にしてはっきり強くなると測れたときだけ置きます: ${ULTRA ? '置いています' : 'いまは置いていません'}。</p>` : ''}` : ''}
      </div>
      ${learnedHTML()}
      ${rows ? `<div class="card" data-tab="学習の記録">
        <h3>学習の記録（新しい順）</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>累計局数</th><th>予想の損失</th><th>新 vs 旧</th><th>Elo</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">予想の損失：学習に使っていない対局で、勝ち負けの予想がどれだけ外れたか（対数損失。0.693 が当てずっぽう）。</p>
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
      else if (act === 'claim' && S.online && !S.result) { S.result = { winner: S.online.myColor, resigned: true, reason: '相手の接続切れ' }; afterChange(); }
      else if (act === 'again') startGame(cfg);
      else if (act === 'back') undoStep();
      else if (act === 'commit') commit();
    });
    ['player-top', 'player-bottom'].forEach(id => $(id).addEventListener('click', e => { if (e.target.closest('[data-act="now"]')) moveNow(); }));
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
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('terr', on, true); setSetting('best', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'ev' : 'kifu'));
    $('btn-flip').addEventListener('click', () => { S.userFlip = !S.userFlip; render(); });
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
      if (act === 'wait') { lobby.msg = ''; NET.wait(null, '10×10'); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('terr', on, true); setSetting('best', on); renderLobby(); }
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
      clearSel(); renderMarks(); renderSqInfo();
      analyze(true, HINT_MS, 'hint');
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-terr', 'terr'], ['set-best', 'best'], ['set-confirm', 'confirm'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-analyze', 'analyze']].forEach(([id, k]) => {
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
        // オンライン対戦: 上の丸いボタンと同じパネルを開く（今の対局はオンラインで始まるまでそのまま）
        if (id === 'ng-mode' && v === 'online') { $('dlg-new').hidden = true; schedule(); openOnline(); return; }
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) { $('dlg-new').hidden = true; schedule(); }
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; schedule(); });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) requestRematch(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const wasChoosing = choosing();
        closeSheet(); ['dlg-new', 'dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true;
        if (S.sel.from) { undoStep(); }
        if (wasChoosing) schedule();
        return;
      }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
      if (e.key === 'Enter' && S.sel.arrow) { e.preventDefault(); commit(); }
    });
  }

  // ------------------------------------------------------------------ オンライン対戦（../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && window.SSIHOnline.available();
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { msg: '' };
  const aiFlags = () => (settings.showEval || settings.terr ? 1 : 0) | (settings.best ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢・陣地' : '', f & 2 ? '最善手' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: 'amazons',
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
    $('dlg-online').hidden = true; $('dlg-result').hidden = true; $('dlg-new').hidden = true;
    const online = { mid: g.mid, myColor: g.myColor ? BLACK : WHITE, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false };
    const seats = online.myColor === WHITE ? ['human', 'remote'] : ['remote', 'human'];
    S.userFlip = false;
    loadGame({ seats, moves: [], online });
    sound('move');
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
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.moves.length + 1) applyRemote([A.fromWire(msg.m)]); }
    else if (msg.t === 'state' && Array.isArray(msg.moves)) {
      const ms = msg.moves.map(A.fromWire);
      for (let i = 0; i < Math.min(ms.length, S.moves.length); i++) if (ms[i] !== S.moves[i]) return; // 食い違うものは使わない
      applyRemote(ms.slice(S.moves.length));
    } else if (msg.t === 'resign') {
      if (!S.result) { S.result = { winner: o.myColor, resigned: true, reason: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.mid === 'string') {
      NET.start({ mid: msg.mid.slice(0, 20), myColor: msg.oc ? 1 : 0, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 相手の手を順に指す（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const m of list) {
      if (S.result || !isRemote(curPos().stm) || m < 0 || !curPos().isLegal(m)) break;
      if (!live()) S.view = null;
      play(m, true);
    }
  }
  // もう一局: 両方が希望したら、ID の小さい方が新しい対局を作る（白黒は交代）
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
    const p = NET.list().find(x => x.s === 'wait' && x.g === 'amazons' && x.c === roomCode.toUpperCase());
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
      $('on-body').innerHTML = '<p>オンライン対戦は、公開版のページや手元のサーバーで開いたときに使えます。</p><p><a href="https://angrh0824.github.io/turing-table/amazons/" target="_blank" rel="noopener">https://angrh0824.github.io/turing-table/amazons/</a></p>';
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
    const g = c && c.byGame && c.byGame.amazons;
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', c = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const g = c && c.byGame && c.byGame.amazons;
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === 'amazons') : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(g ? g.wait : 0)}</b><span>アマゾンズの対戦待ち</span></div>
        <div class="stat"><b>${num(g ? g.play : 0)}</b><span>アマゾンズの対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・陣地・最善手を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「相手を待つ」で待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span>待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）。白黒は始まるときにランダムで決まります。</span></div>`
          : `<div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>相手を待つ</button></div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と指した手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
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
    const box = { showEval: 'set-eval', terr: 'set-terr', best: 'set-best', confirm: 'set-confirm' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if (NET && ['showEval', 'terr', 'best'].includes(k)) NET.setAI(aiFlags());
    if (['analyze', 'showEval', 'best'].includes(k) && !S.thinking && (humanTurn() || !live())) analyze();
    render();
  }

  function branch() {
    if (live()) return;
    AI.cancel();
    const n = S.view;
    S.view = null;
    rebuild(n);
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
      if (!saved.seats.every(s => s === 'human' || s === 'remote' || CPU[s])) throw new Error('bad');
      const p = new Position(), moves = [];
      for (const w of saved.moves) { const m = A.fromWire(w); if (!p.isLegal(m)) throw new Error('bad'); p.make(m); moves.push(m); }
      saved.moves = moves;
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
