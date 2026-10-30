/* 囲碁 Webアプリ: 碁盤（SVG）・CPU（Web Worker のネット＋木探索）・AI補助・オンライン */
(function () {
  'use strict';
  const G = {};
  GoCore(G); GoNN(G); GoSearch(G);
  const { Board, BLACK, WHITE, EMPTY, PASS } = G;
  // ネットの計算には WebAssembly の SIMD が要る（Chrome 91・Firefox 89・Safari 16.4 から）。使えなければ CPU は止めて知らせる
  const HAS_NET = typeof GO_WEIGHTS !== 'undefined' && GO_WEIGHTS && typeof GO_WASM_B64 !== 'undefined' && typeof WebAssembly === 'object' && (() => {
    try { const bin = atob(GO_WASM_B64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return WebAssembly.validate(u); } catch (e) { return false; }
  })();
  const $ = id => document.getElementById(id);
  const COLOR = { 1: '黒', 2: '白' };
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ------------------------------------------------------------------ CPU の強さ
  // 9路の時間。13路・19路は同じ時間で読める回数が減る
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '読まずに、ネットの直感だけで打ちます（ときどき甘い手も）', policy: true, temp: 1.0, minP: 0.03 },
    normal: { label: 'ふつう', stars: 2, desc: '1手に32回だけ先を読みます', visits: 32, timeMs: 4000 },
    strong: { label: 'つよい', stars: 3, desc: '1手2秒まで、数百回読みます', visits: 800, timeMs: 2000 },
    max: { label: '最強', stars: 4, desc: '1手6秒、全部のスレッドで読みます', visits: 200000, timeMs: 6000, parallel: true },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 10000, HINT_MS = 2500; // 人の番に読む時間（電池を使いすぎないよう、10秒で止める）

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('go-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('go-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong', size: 9, ha: 0 }, store.get('cfg', {}));
  if (![9, 13, 19].includes(cfg.size)) cfg.size = 9;
  // AI補助: showEval = 形勢（勝率・目数・グラフ）、cands = 最善手の候補を盤に、own = 地の見込みを盤に
  const settings = Object.assign({ sound: true, showEval: true, cands: true, own: false, confirm: true, coords: true, analyze: true, resign: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.cands || settings.own;
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.cands ? 2 : 0) | (settings.own ? 4 : 0);

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    size: 9, komi: 7, handicap: 0, setup: null, first: BLACK,
    seats: { 1: 'human', 2: 'normal' },
    board: null, view: null, dboard: null,
    evals: [],         // 手数ごとの { wr: 黒の期待勝率, sc: 黒から見た目数 }
    result: null,      // { winner: 1|2|0, reason, score, black, white }
    phase: 'play',     // 'play' | 'mark'（死に石の確認）
    dead: new Set(), markReady: false,
    pending: -1, hover: -1,
    info: null,        // 最後の読み { ply, res, kind: 'analysis'|'hint'|'cpu' }
    thinking: false, timer: 0, low: { 1: 0, 2: 0 },
    online: null,      // { gid, myColor, opp: {name, ai, hints}, myHints, oppPresent, lostAt, myRe, oppRe, myAgree, oppAgree }
  };
  const live = () => S.view === null;
  // 相手の接続が切れているか（対局の始まりなど、在席の更新が届くまでの一瞬は数えない）
  const oppLost = () => !!(S.online && !S.online.oppPresent && S.online.lostAt && Date.now() - S.online.lostAt > 15000);
  const shownBoard = () => (live() ? S.board : S.dboard);
  const shownPly = () => (live() ? S.board.moves.length : S.view);
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const humans = () => [BLACK, WHITE].filter(isHuman);
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (humans().length === 1 ? 'あなた' : '人間'));

  function newBoard() {
    const b = new Board(S.size, { komi: S.komi, handicap: S.handicap });
    if (S.setup) { for (const [p, c] of S.setup) b.place(p, c); b.resetHistory(); b.toPlay = S.first; b.firstColor = S.first; }
    return b;
  }
  function boardAt(n) { const b = newBoard(); for (const m of S.board.moves.slice(0, n)) b.play(m); return b; }

  // ------------------------------------------------------------------ CPU（Web Worker）
  // ワーカー: 'init' でネットを受け取り、'go' で読む（少しずつ進めて、途中経過を 'info' で返す）
  function workerMain() {
    const G = {};
    GoCore(G); GoNN(G); GoSearch(G);
    let net = null, search = null, cur = 0;
    const ch = new MessageChannel(), waits = [];
    ch.port1.onmessage = () => { const r = waits.shift(); if (r) r(); };
    const yieldNow = () => new Promise(r => { waits.push(r); ch.port2.postMessage(0); });
    const pack = (r, el) => ({ move: r.move, visits: r.visits, value: r.value, score: r.score, rootValue: r.rootValue, rootScore: r.rootScore, cands: r.allCands.slice(0, 24), own: r.own, toPlay: r.toPlay, ply: r.ply, ms: el, evals: net.evals });
    function build(m) {
      const b = new G.Board(m.size, { komi: m.komi, handicap: m.handicap });
      if (m.setup) { for (const [p, c] of m.setup) b.place(p, c); b.resetHistory(); b.toPlay = m.first; b.firstColor = m.first; }
      for (const mv of m.moves) b.play(mv);
      if (m.passes != null) b.passes = m.passes; // 終局のあと「再開」した局面（パス2回のあとでも続ける）
      return b;
    }
    async function run(m) {
      const b = build(m);
      if (m.policy) {
        const r = G.policyMove(net, b, m.temp, Math.random, m.minP);
        self.postMessage({ id: m.id, type: 'done', res: { move: r.move, visits: 1, value: r.value, score: r.score, rootValue: r.value, rootScore: r.score, cands: [], own: r.own, toPlay: b.toPlay, ply: b.ply, ms: 0 } });
        cur = 0;
        return;
      }
      search.su = m.su != null ? m.su : 0.05;
      search.setRoot(b);
      const t0 = Date.now();
      let last = 0;
      for (;;) {
        if (cur !== m.id) return;
        const tEnd = Date.now() + 35;
        while (Date.now() < tEnd && search.root.n < m.visits) search.step();
        const now = Date.now(), el = now - t0;
        const done = search.root.n >= m.visits || (m.timeMs && el >= m.timeMs) || (!m.analysis && search.decided(m.visits));
        if (done || now - last > 300) { last = now; self.postMessage({ id: m.id, type: done ? 'done' : 'info', res: pack(search.result(24), el) }); }
        if (done) { cur = 0; return; }
        await yieldNow();
      }
    }
    self.onmessage = e => {
      const m = e.data;
      if (m.type === 'init') {
        try { net = new G.Net(m.weights, m.wasm); search = new G.Search(net); self.postMessage({ type: 'ready' }); } catch (err) { self.postMessage({ type: 'error', error: String(err) }); }
        return;
      }
      if (m.type === 'stop') { cur = 0; return; }
      if (m.type === 'go') { cur = m.id; run(m).catch(err => self.postMessage({ id: m.id, type: 'error', error: String(err && err.stack || err) })); }
    };
  }

  const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const AI = {
    pool: [], id: 0, busy: false, fallback: null, ok: HAS_NET,
    make() {
      try {
        const src = [GoCore, GoNN, GoSearch].map(f => f.toString()).join('\n') + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', weights: GO_WEIGHTS, wasm: GO_WASM_B64 });
        return w;
      } catch (e) { return null; }
    },
    ensure(n) {
      while (this.pool.length < n) { const w = this.make(); if (!w) break; this.pool.push(w); }
      return this.pool.length;
    },
    // job: { moves, policy, temp, minP, visits, timeMs, analysis, parallel, su }
    start(job, onInfo, onDone) {
      this.cancel();
      if (!this.ok) { setTimeout(() => onDone(null), 0); return; }
      const id = ++this.id;
      this.busy = true;
      const n = this.ensure(job.parallel && !job.policy ? THREADS : 1);
      const msg = Object.assign({ type: 'go', id, size: S.size, komi: S.komi, handicap: S.handicap, setup: S.setup, first: S.first,
        passes: job.moves.length === S.board.moves.length ? S.board.passes : null }, job);
      if (!n) { this.runHere(msg, onInfo, onDone); return; }
      const parts = new Array(n).fill(null), done = new Array(n).fill(false);
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.type === 'error') { console.error(m.error); }
          if (m.id !== this.id) return;
          if (m.type === 'error') { done[i] = true; }
          else { parts[i] = m.res; if (m.type === 'done') done[i] = true; }
          const merged = mergeResults(parts.filter(Boolean));
          if (done.every(Boolean)) { this.busy = false; this.id++; onDone(merged); }
          else if (onInfo && merged) onInfo(merged);
        };
        w.postMessage(i ? Object.assign({}, msg, { seed: i }) : msg);
      });
    },
    // Worker が使えない環境: メインスレッドで少しだけ読む
    runHere(msg, onInfo, onDone) {
      const id = this.id;
      setTimeout(() => {
        if (id !== this.id) return;
        if (!this.fallback) { const net = new G.Net(GO_WEIGHTS, GO_WASM_B64); this.fallback = { net, search: new G.Search(net) }; }
        const b = newBoard();
        for (const m of msg.moves) b.play(m);
        if (msg.passes != null) b.passes = msg.passes;
        let res;
        if (msg.policy) { const r = G.policyMove(this.fallback.net, b, msg.temp, Math.random, msg.minP); res = { move: r.move, visits: 1, value: r.value, score: r.score, rootValue: r.value, rootScore: r.score, cands: [], own: r.own, toPlay: b.toPlay, ply: b.ply }; }
        else {
          const s = this.fallback.search;
          s.setRoot(b);
          const r = s.think({ visits: Math.min(msg.visits, 200), timeMs: Math.min(msg.timeMs || 1500, 1500) });
          res = { move: r.move, visits: r.visits, value: r.value, score: r.score, rootValue: r.rootValue, rootScore: r.rootScore, cands: r.allCands.slice(0, 24), own: r.own, toPlay: r.toPlay, ply: r.ply };
        }
        this.busy = false; this.id++;
        onDone(mergeResults([res]));
      }, 30);
    },
    cancel() {
      if (this.busy) this.pool.forEach(w => w.postMessage({ type: 'stop' }));
      this.busy = false;
      this.id++;
    },
  };

  // 複数のワーカーの読みをまとめる（根で分けて読む root parallel。候補ごとに回数を足し、値は回数で重み付けした平均）
  function mergeResults(parts) {
    if (!parts.length) return null;
    if (parts.length === 1) { const r = parts[0]; return Object.assign({}, r, { cands: r.cands.slice() }); }
    const map = new Map();
    let visits = 0, own = null, ownW = 0, ms = 0;
    for (const r of parts) {
      visits += r.visits; ms = Math.max(ms, r.ms || 0);
      for (const c of r.cands) {
        const m = map.get(c.move) || { move: c.move, n: 0, q: 0, v: 0, s: 0, p: c.p, pv: c.pv, pvn: 0 };
        m.q += c.q * c.n; m.v += c.v * c.n; m.s += c.s * c.n; m.n += c.n;
        if (c.n > m.pvn) { m.pv = c.pv; m.pvn = c.n; }
        map.set(c.move, m);
      }
      if (r.own) { if (!own) own = new Float32Array(r.own.length); const w = Math.max(1, r.visits); for (let i = 0; i < own.length; i++) own[i] += r.own[i] * w; ownW += w; }
    }
    const cands = [...map.values()].map(m => ({ move: m.move, n: m.n, q: m.q / m.n, v: m.v / m.n, s: m.s / m.n, p: m.p, pv: m.pv })).sort((a, b) => b.n - a.n || b.q - a.q);
    if (own) for (let i = 0; i < own.length; i++) own[i] /= ownW;
    const best = cands[0], r0 = parts[0];
    return { move: best ? best.move : r0.move, visits, value: best ? best.v : r0.value, score: best ? best.s : r0.score, rootValue: r0.rootValue, rootScore: r0.rootScore, cands, own, toPlay: r0.toPlay, ply: r0.ply, ms };
  }

  // ------------------------------------------------------------------ 石の音（WebAudio で合成した「パチッ」）
  let actx = null;
  function clack(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, len = 0.05, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 7);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'cap' ? 1900 : 2600; bp.Q.value = 1.6;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'cap' ? 1.5 : 1.2, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.frequency.setValueAtTime(kind === 'pass' ? 520 : 240, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.07);
      og.gain.setValueAtTime(kind === 'pass' ? 0.12 : 0.3, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.09);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    let seats;
    if (cfg.mode === 'pvp') seats = { 1: 'human', 2: 'human' };
    else if (cfg.mode === 'watch') seats = { 1: cfg.cpuB, 2: cfg.cpuW };
    else {
      const hc = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = hc === BLACK ? { 1: 'human', 2: cfg.cpu } : { 1: cfg.cpu, 2: 'human' };
    }
    const ha = cfg.ha >= 2 ? Math.min(cfg.ha, G.maxHandicap(cfg.size)) : 0;
    loadGame({ size: cfg.size, komi: ha ? 0.5 : 7, handicap: ha, seats, moves: [] });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.size = g.size; S.komi = g.komi; S.handicap = g.handicap || 0; S.setup = g.setup || null; S.first = g.first || (S.handicap >= 2 ? WHITE : BLACK);
    S.seats = g.seats; S.online = g.online || null;
    S.board = newBoard();
    for (const m of g.moves) S.board.play(m);
    S.evals = g.evals ? g.evals.slice() : [];
    S.view = null; S.dboard = null; S.info = null; S.pending = -1; S.hover = -1;
    S.result = g.result || null;
    S.phase = g.phase === 'mark' && !S.result ? 'mark' : 'play';
    if (S.phase === 'play' && !S.result && S.board.passes >= 2) S.board.passes = 0; // 「再開」したあとの局面
    S.dead = new Set(g.dead || []); S.markReady = S.phase === 'mark' && !!g.dead;
    S.low = { 1: 0, 2: 0 };
    S.resultShown = !!S.result;
    S.boardKey = '';
    afterChange();
    if (S.phase === 'mark' && !S.markReady) proposeDead();
  }

  function saveGame() {
    const online = S.online ? { gid: S.online.gid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    // オンライン対局の「自分の側」はタブごとにも残す（同じブラウザで2つのタブから対局しても、再読み込みで相手の側に入れ替わらないように）
    try { if (online) sessionStorage.setItem('go-online', JSON.stringify({ online, seats: S.seats })); else sessionStorage.removeItem('go-online'); } catch (e) { /* なくても動く */ }
    store.set('game', { size: S.size, komi: S.komi, handicap: S.handicap, setup: S.setup, first: S.first, seats: S.seats, moves: S.board.moves, result: S.result,
      phase: S.phase, dead: S.phase === 'mark' ? [...S.dead] : null, evals: S.evals.map(e => (e ? { wr: +e.wr.toFixed(3), sc: +e.sc.toFixed(1) } : null)), online });
  }

  function play(m, fromRemote) {
    const b = S.board;
    if (S.result || S.phase !== 'play') return;
    if (m !== PASS && !b.isLegal(m)) return;
    const caps = b.play(m);
    S.pending = -1;
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: b.moves.length, m });
    clack(m === PASS ? 'pass' : caps ? 'cap' : 'move');
    if (b.passes >= 2) enterMark();
    afterChange();
    if (S.online && NET) saveOnline();
  }
  function saveOnline() { if (S.online && NET) NET.saveState({ st: 1, moves: S.board.moves, r: S.result ? 1 : 0, ph: S.phase, dead: [...S.dead], rs: S.result }); }

  function afterChange() {
    S.hover = -1;
    saveGame();
    render();
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, 450); }
    schedule();
  }

  // 次にすること: CPU の番なら読ませる、人の番なら（設定しだいで）形勢を読む
  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (!live() || S.result) { analyze(); return; }
    if (S.phase === 'mark') {
      // 死に石を調べている途中（markReady が false）なら、その読みは止めない
      if (S.markReady) { AI.cancel(); if (!humans().length) S.timer = setTimeout(() => finishMark(), 900); }
      return;
    }
    const c = S.board.toPlay;
    if (isRemote(c)) { AI.cancel(); renderEval(); return; }
    if (!isCPU(c)) { analyze(); return; }
    if (!AI.ok) { renderAll(); return; }
    const cpu = CPU[S.seats[c]], ply = S.board.moves.length;
    S.thinking = true;
    renderPlayers();
    const job = cpu.policy ? { moves: S.board.moves.slice(), policy: true, temp: cpu.temp, minP: cpu.minP }
      : { moves: S.board.moves.slice(), visits: cpu.visits, timeMs: cpu.timeMs, parallel: !!cpu.parallel, su: 0.05 };
    const t0 = Date.now();
    AI.start(job, res => onInfo(ply, res, 'cpu'), res => {
      onInfo(ply, res, 'cpu');
      S.thinking = false;
      if (!live() || S.board.moves.length !== ply || S.result || S.phase !== 'play' || !res) return;
      let m = res.move;
      // 相手がパスして、こちらも打つ場所がない（パスがいちばん）ならパスで終局へ
      if (m !== PASS && !S.board.isLegal(m)) m = PASS;
      // 大差で負けが決まったら投了する（人と打つときだけ。設定で止められる）
      const v = res.value, sc = res.score, n = S.size * S.size;
      if (settings.resign && humans().length && !cpu.policy && S.board.ply > n / 3) {
        if (v < -0.94 && sc < -(S.size <= 9 ? 12 : S.size <= 13 ? 20 : 30)) S.low[c]++; else S.low[c] = 0;
        if (S.low[c] >= 2) { S.timer = setTimeout(() => resignBy(c), 400); return; }
      }
      const wait = Math.max(120, (cpu.policy ? 450 : 200) - (Date.now() - t0));
      S.timer = setTimeout(() => play(m), wait);
    });
  }

  // 人の番（または棋譜を見返しているとき）に形勢を読む
  function analyze(force, ms) {
    const b = shownBoard();
    const over = live() && (S.result || S.phase === 'mark');
    if ((!force && (!settings.analyze || !aiOn())) || over || b.passes >= 2 || !AI.ok) { AI.cancel(); renderEval(); renderBoardMarks(); return; }
    const ply = shownPly();
    AI.start({ moves: S.board.moves.slice(0, ply), visits: 1e7, timeMs: ms || ANALYZE_MS, analysis: true, parallel: true, su: 0.05 },
      res => onInfo(ply, res, force ? 'hint' : 'analysis'), res => onInfo(ply, res, force ? 'hint' : 'analysis'));
  }

  function onInfo(ply, res, kind) {
    if (!res) return;
    const stm = res.toPlay;
    const v = stm === BLACK ? res.value : -res.value, sc = stm === BLACK ? res.score : -res.score;
    const weak = kind === 'cpu' && (res.visits || 0) < 64; // 弱い CPU の浅い読みはグラフに使わない
    if (!weak || !S.evals[ply]) S.evals[ply] = { wr: (1 + v) / 2, sc };
    if (kind !== 'cpu' || !S.info || S.info.ply !== ply || S.info.kind === 'cpu') S.info = { ply, res, kind };
    renderEval(); renderGraph(); renderKifu(); renderTape(); renderBoardMarks();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 終局: 死に石の確認 → 数える
  function enterMark() {
    S.phase = 'mark'; S.dead = new Set(); S.markReady = false;
    if (S.online) { S.online.myAgree = false; S.online.oppAgree = false; }
    AI.cancel();
    proposeDead();
  }
  // AI が死に石を提案する（パスの前の局面から少し読んで、地の見込みが相手のものになっている石）
  function proposeDead() {
    const moves = S.board.moves.slice();
    while (moves.length && moves[moves.length - 1] === PASS) moves.pop();
    const apply = own => {
      if (S.phase !== 'mark') return;
      const b = S.board, dead = new Set();
      if (own) {
        b.analyze();
        const seen = new Set();
        for (const p of b.points) {
          const col = b.c[p];
          if ((col !== BLACK && col !== WHITE) || seen.has(p)) continue;
          const chain = b.chainAt(p);
          let s = 0;
          for (const q of chain) { seen.add(q); s += own[b.index(q)]; }
          const mine = (s / chain.size) * (col === BLACK ? 1 : -1);
          if (mine < -0.3) for (const q of chain) dead.add(q);
        }
      }
      S.dead = dead; S.markReady = true;
      if (S.online) { S.online.myAgree = false; S.online.oppAgree = false; if (NET && proposerIsMe()) NET.send({ t: 'mk', dead: [...dead] }); }
      saveGame(); if (S.online) saveOnline();
      render(); schedule();
    };
    // オンラインでは黒の側だけが提案を作って送る（両方で作ると食い違う）
    if (S.online && !proposerIsMe()) { render(); return; }
    if (!AI.ok) { apply(null); return; }
    S.thinking = true; render();
    AI.start({ moves, visits: 400, timeMs: 1500, parallel: true, su: 0 }, null, res => { S.thinking = false; apply(res && res.own); });
  }
  const proposerIsMe = () => !S.online || S.online.myColor === BLACK;
  function toggleDead(p) {
    const b = S.board;
    if (b.c[p] !== BLACK && b.c[p] !== WHITE) return;
    const grp = b.deadGroupAt(p), isDead = S.dead.has(p);
    for (const q of grp) { if (isDead) S.dead.delete(q); else S.dead.add(q); }
    if (S.online) { S.online.myAgree = false; S.online.oppAgree = false; if (NET) NET.send({ t: 'mk', dead: [...S.dead] }); saveOnline(); }
    clack('move');
    saveGame(); render();
  }
  function finishMark() {
    if (S.phase !== 'mark') return;
    const sc = S.board.score(S.dead);
    S.result = { winner: sc.score > 0 ? BLACK : sc.score < 0 ? WHITE : 0, reason: '終局', score: sc.score, black: sc.black, white: sc.white, dead: [...S.dead] };
    S.phase = 'play';
    afterChange();
    if (S.online) saveOnline();
  }
  function resumePlay() {
    if (S.phase !== 'mark') return;
    S.phase = 'play'; S.dead = new Set(); S.markReady = false;
    // パスが2回続いた状態から戻すと、すぐまた終局になるので、パスの数を数え直す（次の手で 0 に戻る）
    S.board.passes = 0;
    if (S.online && NET) { NET.send({ t: 'resume' }); saveOnline(); }
    afterChange();
  }
  function resignBy(c) {
    if (S.result) return;
    AI.cancel(); clearTimeout(S.timer);
    S.phase = 'play';
    S.result = { winner: 3 - c, reason: '中押し', score: null };
    if (S.online && NET && c === S.online.myColor) NET.send({ t: 'resign' });
    afterChange();
    if (S.online) saveOnline();
  }
  function resign() {
    if (!live() || S.result) return;
    const hs = humans();
    if (!hs.length) return;
    const c = hs.includes(S.board.toPlay) ? S.board.toPlay : hs[0];
    resignBy(c);
  }

  // ------------------------------------------------------------------ 入力（盤）
  const humanTurn = () => live() && !S.result && S.phase === 'play' && isHuman(S.board.toPlay);
  // 盤の上の位置 → 点（盤の外なら -1）
  function pointAt(clientX, clientY) {
    const svg = $('board'), r = svg.getBoundingClientRect(), V = view();
    const x = (clientX - r.left) / r.width * V.w + V.x, y = (clientY - r.top) / r.height * V.w + V.x;
    const i = Math.round(x / 100), j = Math.round(y / 100);
    if (i < 0 || j < 0 || i >= S.size || j >= S.size) return -1;
    if (Math.hypot(x - i * 100, y - j * 100) > 62) return -1;
    return S.board.pt(i, j);
  }
  let aim = null; // タッチで狙っている点 { id, p }
  function onDown(e) {
    if (e.button && e.button !== 0) return;
    const p = pointAt(e.clientX, e.clientY);
    if (S.phase === 'mark' && live() && !S.result) return; // 死に石の印は離したときに
    if (!humanTurn()) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      e.preventDefault();
      aim = { id: e.pointerId, p, start: S.pending };
      try { $('board').setPointerCapture(e.pointerId); } catch (err) { /* なくても動く */ }
      showLoupe(e.clientX, e.clientY, p);
      S.hover = p; renderBoardMarks();
    }
  }
  function onMove(e) {
    if (aim && e.pointerId === aim.id) {
      const p = pointAt(e.clientX, e.clientY);
      aim.p = p; S.hover = p;
      showLoupe(e.clientX, e.clientY, p);
      renderBoardMarks();
      return;
    }
    if (e.pointerType === 'mouse' && humanTurn()) {
      const p = pointAt(e.clientX, e.clientY);
      if (p !== S.hover) { S.hover = p; renderBoardMarks(); renderSqInfo(); }
    }
  }
  function onUp(e) {
    const p = pointAt(e.clientX, e.clientY);
    if (S.phase === 'mark' && live() && !S.result) { if (p >= 0 && S.markReady && (!S.online || !S.online.myAgree || true)) toggleDead(p); return; }
    if (aim && e.pointerId === aim.id) {
      hideLoupe();
      const start = aim.start;
      aim = null; S.hover = -1;
      if (!humanTurn()) { renderBoardMarks(); return; }
      if (p < 0 || !S.board.isLegal(p)) { if (p >= 0) flashIllegal(p); S.pending = -1; render(); return; }
      if (!settings.confirm || p === start) { play(p); return; }
      S.pending = p;
      clack('tick');
      renderBoardMarks(); renderSqInfo();
      return;
    }
    if (e.pointerType === 'mouse' && humanTurn()) {
      if (p < 0) return;
      if (!S.board.isLegal(p)) { flashIllegal(p); return; }
      play(p);
    }
  }
  function onLeave() { if (S.hover >= 0 && !aim) { S.hover = -1; renderBoardMarks(); renderSqInfo(); } }
  let illegalMsg = null;
  function flashIllegal(p) {
    const b = S.board;
    b.analyze();
    const why = b.c[p] !== EMPTY ? '' : b.legality(p) === 2 ? '自殺手になるので打てません' : b.legality(p) === 3 ? 'コウ（同じ形のくり返し）なので、いまは打てません。ほかに打ってから' : '';
    if (!why) return;
    illegalMsg = { p, text: `${b.name(p)} は${why}`, t: Date.now() };
    renderSqInfo();
    setTimeout(() => { if (illegalMsg && Date.now() - illegalMsg.t >= 2400) { illegalMsg = null; renderSqInfo(); } }, 2500);
  }

  // 拡大鏡: 指で隠れる場所を、指の少し上に大きく見せる（盤の SVG の中身をそのまま使う）
  function showLoupe(cx, cy, p) {
    let el = $('loupe');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loupe'; el.className = 'loupe';
      el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#bcontent"/><g class="lp-x"></g></svg><span class="lp-name"></span>';
      document.body.appendChild(el);
    }
    const V = view();
    const r = $('board').getBoundingClientRect();
    const bx = (cx - r.left) / r.width * V.w + V.x, by = (cy - r.top) / r.height * V.w + V.x;
    const span = S.size <= 9 ? 210 : S.size <= 13 ? 250 : 290;
    const fx = p >= 0 ? S.board.xy(p)[0] * 100 : bx, fy = p >= 0 ? S.board.xy(p)[1] * 100 : by;
    el.querySelector('svg').setAttribute('viewBox', `${fx - span / 2} ${fy - span / 2} ${span} ${span}`);
    // 狙っている点に細い十字（石があっても見えるよう赤）
    const k = span * 0.09;
    el.querySelector('.lp-x').innerHTML = `<path d="M${fx - k} ${fy}H${fx + k}M${fx} ${fy - k}V${fy + k}" stroke="var(--shu)" stroke-width="${span / 70}" stroke-linecap="round"/>`;
    el.querySelector('.lp-name').textContent = p >= 0 ? S.board.name(p) : '';
    const size = 124;
    let left = cx - size / 2, top = cy - size - 46;
    if (top < 6) top = cy + 46;
    left = Math.max(6, Math.min(window.innerWidth - size - 6, left));
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.hidden = false;
  }
  function hideLoupe() { const el = $('loupe'); if (el) el.hidden = true; }

  // ------------------------------------------------------------------ 描画
  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderSqInfo();
    fitBoardSoon();
  }
  const renderAll = render;

  // 盤の大きさ: 盤・情報の行・対局者・ボタンが画面の高さに収まる大きさにする（ページはスクロールしない）
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  // 広い画面（盤の右にパネルがある）では、操作のボタンを右のパネルの一番上に移して盤を大きくする
  function placeControls() {
    const ctl = document.querySelector('.controls'), side = $('side'), col = document.querySelector('.board-col');
    const wide = window.matchMedia('(min-width: 980px)').matches;
    if (wide && ctl.parentElement !== side) { side.insertBefore(ctl, side.querySelector('.evoff-card')); ctl.classList.add('in-side'); }
    else if (!wide && ctl.parentElement !== col) { col.appendChild(ctl); ctl.classList.remove('in-side'); }
  }
  function fitBoard() {
    placeControls();
    const col = document.querySelector('.board-col'), row = document.querySelector('.board-row');
    if (!col || !col.offsetParent) return;
    const landscape = window.matchMedia('(max-height: 520px) and (min-aspect-ratio: 4/3)').matches;
    const top = col.getBoundingClientRect().top;
    let w;
    if (landscape) {
      w = window.innerHeight - top - 10;
      w = Math.min(w, (col.getBoundingClientRect().width - 14) * 0.58);
    } else {
      const cs = getComputedStyle(col), gap = parseFloat(cs.rowGap) || 0;
      let other = 0, n = 0;
      for (const el of col.children) {
        if (el === row || getComputedStyle(el).display === 'none') continue;
        other += el.getBoundingClientRect().height; n++;
      }
      const rowExtra = row.getBoundingClientRect().width - $('goban').getBoundingClientRect().width; // 評価値バーの分
      w = window.innerHeight - top - other - gap * n - 12 + rowExtra;
      w = Math.min(w, col.getBoundingClientRect().width);
    }
    w = Math.round(Math.max(240, Math.min(720, w)));
    const cur = document.documentElement.style.getPropertyValue('--board-w');
    if (cur !== w + 'px') document.documentElement.style.setProperty('--board-w', w + 'px');
  }

  function renderPlayers() {
    const b = shownBoard(), on = S.online;
    // 自分（人間がひとりのとき）を下に
    const hs = humans(), bottom = on ? on.myColor : hs.length === 1 ? hs[0] : BLACK;
    [['player-top', 3 - bottom], ['player-bottom', bottom]].forEach(([id, c]) => {
      const el = $(id);
      const myTurn = live() && !S.result && S.phase === 'play' && b.toPlay === c;
      el.classList.toggle('turn', myTurn);
      let st = '';
      if (myTurn && isCPU(c) && S.thinking) {
        const r = S.info && S.info.kind === 'cpu' && S.info.ply === b.moves.length ? S.info.res : null;
        st = `<span class="think"><i></i>考え中${r && r.visits > 1 ? `・${r.visits.toLocaleString()}回` : ''}</span>`;
      } else if (myTurn && isRemote(c)) {
        st = NET && NET.status === 'on' && oppLost() ? '<span class="think" style="color:var(--bad)">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think" style="color:var(--good)">勝ち</span>' : S.result.winner === 0 ? '<span class="think">持碁</span>' : '<span style="color:var(--muted)">負け</span>';
      }
      const prisoners = b.prisoners[c];
      const kom = c === WHITE ? `コミ${S.komi}${S.handicap >= 2 ? `＋${S.handicap}` : ''}` : (S.handicap >= 2 ? `置き石${S.handicap}` : '');
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : seatLabel(c);
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      el.innerHTML = `
        <div class="id"><span class="stone ${c === BLACK ? 'b' : 'w'}"></span><span class="name">${COLOR[c]}　${nm}</span>${tag}<span class="sub">${kom}</span></div>
        <div class="st">${st || `<span title="取った石（中国ルールでは数えに入らない）">アゲハマ <b>${prisoners}</b></span>`}</div>`;
    });
  }

  // 盤の SVG の座標: 点 (i, j) は (i*100, j*100)。周りに座標の余白
  function view() {
    const pad = settings.coords ? 80 : 58, w = (S.size - 1) * 100 + 2 * pad;
    return { x: -pad, w, pad };
  }
  const R = 48; // 石の半径
  function defsHTML() {
    return `<defs>
      <radialGradient id="gB" cx="36%" cy="32%" r="70%"><stop offset="0" stop-color="#6b6f75"/><stop offset=".28" stop-color="#2b2d31"/><stop offset=".75" stop-color="#0e0f10"/><stop offset="1" stop-color="#050505"/></radialGradient>
      <radialGradient id="gW" cx="36%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f1ede3"/><stop offset=".9" stop-color="#d6cfbf"/><stop offset="1" stop-color="#bfb7a5"/></radialGradient>
      <radialGradient id="gS" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="rgba(30,18,4,.42)"/><stop offset="1" stop-color="rgba(30,18,4,0)"/></radialGradient>
      <radialGradient id="gHB" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="rgba(255,255,255,.22)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient>
      <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="3" seed="7" result="n"/>
        <feColorMatrix type="matrix" values="0 0 0 0 .38  0 0 0 0 .22  0 0 0 0 .06  0 0 0 .55 -.18"/></filter>
      <g id="shell"><path d="M-40 -14 Q0 -26 40 -14" /><path d="M-44 0 Q0 -10 44 0"/><path d="M-41 14 Q0 6 41 14"/><path d="M-33 27 Q0 21 33 27"/></g>
    </defs>`;
  }
  // 盤の目・星・座標・木目（盤の大きさと座標の有無が変わったときだけ描き直す）
  function boardBaseHTML() {
    const n = S.size, V = view(), L = (n - 1) * 100;
    let h = `<rect x="${V.x}" y="${V.x}" width="${V.w}" height="${V.w}" filter="url(#grain)" opacity=".9"/>`;
    const sw = n <= 9 ? 2.6 : n <= 13 ? 2.4 : 2.2;
    h += `<g class="g-line" stroke-width="${sw}">`;
    for (let i = 0; i < n; i++) h += `<line x1="0" y1="${i * 100}" x2="${L}" y2="${i * 100}"/><line x1="${i * 100}" y1="0" x2="${i * 100}" y2="${L}"/>`;
    h += `</g><rect x="0" y="0" width="${L}" height="${L}" fill="none" class="g-line" stroke-width="${sw * 1.9}"/>`;
    for (const [x, y] of G.starPoints(n)) h += `<circle class="g-star" cx="${x * 100}" cy="${y * 100}" r="${n <= 9 ? 11 : 10}"/>`;
    if (settings.coords) {
      const fs = n <= 9 ? 30 : n <= 13 ? 32 : 34, o = V.pad * 0.58;
      h += `<g class="g-coord" font-size="${fs}" text-anchor="middle" dominant-baseline="central">`;
      for (let i = 0; i < n; i++) {
        h += `<text x="${i * 100}" y="${-o}">${G.LETTERS[i]}</text><text x="${i * 100}" y="${L + o}">${G.LETTERS[i]}</text>`;
        h += `<text x="${-o}" y="${i * 100}">${n - i}</text><text x="${L + o}" y="${i * 100}">${n - i}</text>`;
      }
      h += '</g>';
    }
    return h;
  }
  function stoneHTML(x, y, col, extra = '', p = 0) {
    const cx = x * 100, cy = y * 100;
    if (col === BLACK) {
      return `<g${extra}><circle cx="${cx + 5}" cy="${cy + 7}" r="${R + 3}" fill="url(#gS)"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#gB)"/><circle cx="${cx - 15}" cy="${cy - 17}" r="${R * 0.42}" fill="url(#gHB)"/></g>`;
    }
    const rot = (p * 47) % 180 - 90;
    return `<g${extra}><circle cx="${cx + 5}" cy="${cy + 7}" r="${R + 3}" fill="url(#gS)"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#gW)"/>` +
      `<use href="#shell" transform="translate(${cx} ${cy}) rotate(${rot})" fill="none" stroke="rgba(150,140,118,.16)" stroke-width="2.2"/></g>`;
  }

  function renderBoard() {
    const svg = $('board'), V = view(), b = shownBoard();
    const key = S.size + '|' + settings.coords;
    if (S.boardKey !== key) {
      S.boardKey = key;
      svg.setAttribute('viewBox', `${V.x} ${V.x} ${V.w} ${V.w}`);
      svg.innerHTML = defsHTML() + `<g id="bcontent"><g id="b-base">${boardBaseHTML()}</g><g id="b-own"></g><g id="b-stones"></g><g id="b-marks"></g></g>`;
      svg.setAttribute('aria-label', `${S.size}路の碁盤`);
    }
    // 石
    let h = '';
    const counted = live() && S.result && S.result.reason === '終局' && S.result.dead;
    const markDead = live() && (S.phase === 'mark' || counted);
    if (counted && S.dead.size !== S.result.dead.length) S.dead = new Set(S.result.dead);
    for (let i = 0; i < S.size * S.size; i++) {
      const p = b.points[i], col = b.c[p];
      if (col !== BLACK && col !== WHITE) continue;
      const [x, y] = b.xy(p);
      const dead = markDead && S.dead.has(p);
      h += stoneHTML(x, y, col, dead ? ' opacity=".42"' : '', p);
    }
    $('b-stones').innerHTML = h;
    renderBoardMarks();
  }

  // 石の上の印: 直前の手・コウ・候補手・地の見込み・打つ前の確かめ・死に石の印。マウスを乗せたときの薄い石
  function renderBoardMarks() {
    const b = shownBoard(), n = S.size, marks = $('b-marks'), ownEl = $('b-own');
    if (!marks) return;
    let h = '', oh = '';
    const lastMove = b.moves.length ? b.moves[b.moves.length - 1] : -1;
    if (lastMove > 0 && b.c[lastMove] !== EMPTY) {
      const [x, y] = b.xy(lastMove);
      h += `<circle class="mk-last" cx="${x * 100}" cy="${y * 100}" r="${R * 0.42}" stroke-width="${n <= 9 ? 7 : 8}"/>`;
    }
    const playing = live() && !S.result && S.phase === 'play';
    // コウで打てない点
    if (playing && b.passes < 2) {
      b.analyze();
      for (const p of b.points) if (b.c[p] === EMPTY && b.legality(p) === 3) { const [x, y] = b.xy(p); h += `<rect class="mk-ko" x="${x * 100 - 24}" y="${y * 100 - 24}" width="48" height="48" stroke-width="6"/>`; }
    }
    // 死に石の確認中（と数えたあと）: 地と死に石の印
    if (live() && ((S.phase === 'mark' && !S.result) || (S.result && S.result.reason === '終局' && S.result.dead))) {
      const sc = b.score(S.dead);
      for (let i = 0; i < n * n; i++) {
        const p = b.points[i], o = sc.owner[i], [x, y] = b.xy(p);
        if (S.dead.has(p)) h += `<g class="dead-x" stroke-width="9"><line x1="${x * 100 - 18}" y1="${y * 100 - 18}" x2="${x * 100 + 18}" y2="${y * 100 + 18}"/><line x1="${x * 100 + 18}" y1="${y * 100 - 18}" x2="${x * 100 - 18}" y2="${y * 100 + 18}"/></g>`;
        if (o && (b.c[p] === EMPTY || S.dead.has(p))) oh += `<rect x="${x * 100 - 20}" y="${y * 100 - 20}" width="40" height="40" fill="${o === 1 ? '#121314' : '#f8f5ee'}" opacity=".85" ${o === 2 ? 'stroke="rgba(0,0,0,.35)" stroke-width="2"' : ''}/>`;
      }
    } else {
      // 地の見込み（AI補助）
      const info = S.info && S.info.ply === shownPly() ? S.info.res : null;
      if (settings.own && info && info.own && info.own.length === n * n && !(live() && S.result)) {
        for (let i = 0; i < n * n; i++) {
          const o = info.own[i], a = Math.abs(o);
          if (a < 0.15) continue;
          const p = b.points[i], [x, y] = b.xy(p), col = b.c[p];
          const blackOwns = o > 0;
          if (col === EMPTY) oh += `<rect x="${x * 100 - 17}" y="${y * 100 - 17}" width="34" height="34" fill="${blackOwns ? '#121314' : '#f8f5ee'}" opacity="${(0.25 + a * 0.6).toFixed(2)}"/>`;
          else if ((col === BLACK) !== blackOwns && a > 0.4) oh += `<rect x="${x * 100 - 15}" y="${y * 100 - 15}" width="30" height="30" fill="${blackOwns ? '#121314' : '#f8f5ee'}" opacity=".9" stroke="${blackOwns ? '#fff' : '#000'}" stroke-width="2"/>`;
        }
      }
      // 候補手（AI補助）とヒント
      const showC = info && (settings.cands || S.info.kind === 'hint') && S.info.kind !== 'cpu' && !(live() && S.result) && b.passes < 2;
      if (showC && info.cands && info.cands.length) {
        const top = info.cands[0].n;
        const list = info.cands.filter((c, i) => i === 0 || (c.n >= top * 0.08 && i < 6));
        list.forEach((c, i) => {
          if (c.move === PASS || b.c[c.move] !== EMPTY) return;
          const [x, y] = b.xy(c.move), wr = Math.round((1 + c.v) / 2 * 100);
          const al = i === 0 ? 0.92 : Math.max(0.35, 0.8 * c.n / top);
          const fill = i === 0 ? `rgba(var(--cand), ${al})` : `rgba(70, 110, 190, ${al.toFixed(2)})`;
          h += `<g class="cand"><circle cx="${x * 100}" cy="${y * 100}" r="${R * 0.86}" fill="${fill}" stroke-width="4"/>` +
            `<text x="${x * 100}" y="${y * 100}" font-size="${n <= 9 ? 34 : 38}">${S.info.kind === 'hint' && i === 0 ? '★' : wr}</text></g>`;
        });
      }
    }
    // 打つ前の確かめ（タッチ）とマウスを乗せた点の薄い石
    const ghostAt = (p, strong) => {
      const [x, y] = b.xy(p), col = b.toPlay;
      return stoneHTML(x, y, col, ` opacity="${strong ? 0.78 : 0.45}" pointer-events="none"`, p);
    };
    if (playing && isHuman(b.toPlay)) {
      if (S.pending >= 0 && b.c[S.pending] === EMPTY) {
        const [x, y] = b.xy(S.pending), L = (n - 1) * 100;
        h += `<line class="pend-line" x1="0" y1="${y * 100}" x2="${L}" y2="${y * 100}" stroke-width="5"/><line class="pend-line" x1="${x * 100}" y1="0" x2="${x * 100}" y2="${L}" stroke-width="5"/>`;
        h += ghostAt(S.pending, true) + `<circle class="pend-ring" cx="${x * 100}" cy="${y * 100}" r="${R + 7}" stroke-width="7"/>`;
      }
      if (S.hover >= 0 && S.hover !== S.pending && b.c[S.hover] === EMPTY) h += ghostAt(S.hover, false);
    }
    marks.innerHTML = h;
    ownEl.innerHTML = oh;
  }

  // 盤の下の情報の行: 状況（相手の番・パス・終局・見返し中）・打つ前の確かめ・直前の手
  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function renderSqInfo() {
    const el = $('sqinfo'), b = shownBoard();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = b.toPlay;
    const lastText = () => { const k = b.moves.length; return k ? `${k}手目 ${COLOR[3 - c]} ${b.name(b.moves[k - 1])}` : (S.handicap >= 2 ? `置き石${S.handicap}子（白から）` : '開始局面'); };
    if (illegalMsg && live() && humanTurn()) {
      cls += ' alert';
      html = `<span class="txt">${esc(illegalMsg.text)}</span>`;
    } else if (!live()) {
      cls += ' view';
      const k = S.view;
      html = `<span class="txt"><b>${k}手目</b>${k ? ` ${COLOR[b.toPlay === BLACK ? WHITE : BLACK]} ${b.name(b.moves[k - 1])}` : '（開始局面）'}</span>`;
      tools = (S.online ? '' : btn('branch', 'ここから打つ')) + btn('live', '最新へ', ' primary');
    } else if (S.phase === 'mark' && !S.result) {
      cls += ' mark';
      const sc = b.score(S.dead), lead = sc.score;
      const res = lead > 0 ? `黒${lead}目勝ち` : lead < 0 ? `白${-lead}目勝ち` : '持碁';
      if (!S.markReady) html = `<span class="txt"><b>終局</b>　死に石を${S.online && !proposerIsMe() ? '相手が調べています' : 'AI が調べています'}…</span>`;
      else if (S.online) {
        const o = S.online;
        html = `<span class="txt"><b>死に石の確認</b>　このままだと${res}<span class="muted">　石をタップで生き死にを切り替え${o.oppAgree ? '・相手は同意' : ''}</span></span>`;
        tools = (o.myAgree ? '<span class="muted">同意しました</span>' : btn('agree', '同意', ' primary')) + btn('resume', '再開');
      } else {
        html = `<span class="txt"><b>死に石の確認</b>　${res}<span class="muted">　×の石が死に石。タップで切り替え</span></span>`;
        tools = btn('resume', '再開') + btn('finish', '数える', ' primary');
      }
    } else if (S.result && S.online) {
      cls += ' result';
      const o = S.online, nm = esc(o.opp.name);
      const head = resultHead(S.result, c => (c === o.myColor ? 'あなた' : `${nm}さん`));
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（白黒を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b></span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      html = `<span class="txt"><b>${resultHead(S.result)}</b>${S.result.score != null ? `<span class="muted">　黒${S.result.black} 白${S.result.white}${S.result.white !== null ? '' : ''}</span>` : ''}</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' alert';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (oppLost()) {
      cls += ' alert';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (live() && !S.result && S.phase === 'play' && isCPU(c) && !AI.ok) {
      cls += ' alert';
      html = '<span class="txt">この環境では CPU を動かせません（WebAssembly が使えないか、AI のネットを読み込めませんでした）</span>';
    } else if (S.pending >= 0 && humanTurn()) {
      cls += ' confirm';
      html = `<span class="txt"><b>${COLOR[c]} ${b.name(S.pending)}</b> に打ちますか？<span class="muted">　もう一度タップでも打てます</span></span>`;
      tools = btn('place', '打つ', ' primary') + `<button class="ibtn" data-act="unpend" aria-label="やめる" title="やめる">${CLOSE}</button>`;
    } else if (b.moves.length && b.moves[b.moves.length - 1] === PASS && !S.result) {
      html = `<span class="txt"><b>${COLOR[3 - c]}がパスしました</b><span class="muted">　${COLOR[c]}もパスすると終局</span></span>`;
    } else if (S.online && isRemote(c)) {
      html = `<span class="txt"><b>${esc(S.online.opp.name)}さん</b>の番です　<span class="muted">${lastText()}</span></span>`;
    } else {
      const hv = S.hover >= 0 && humanTurn() ? `　<b style="color:var(--ink)">${b.name(S.hover)}</b>` : '';
      html = `<span class="txt muted">${lastText()}${humanTurn() ? `　<span>${COLOR[c]}の番</span>${hv}` : ''}</span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }
  function resultHead(r, who) {
    who = who || (c => COLOR[c]);
    if (r.winner === 0) return '持碁（引き分け）';
    if (r.reason === '中押し') return `${who(r.winner)}の中押し勝ち`;
    if (r.reason === '接続切れ') return `${who(r.winner)}の勝ち（相手の接続切れ）`;
    return `${who(r.winner)}の${Math.abs(r.score)}目勝ち`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ
  function moveBad(i) {
    const e2 = S.evals[i + 1], e1 = S.evals[i];
    if (!settings.showEval || !e2 || !e1) return false;
    const mover = colorOfMove(i);
    return (e2.wr - e1.wr) * (mover === BLACK ? 1 : -1) < -0.15;
  }
  const colorOfMove = i => ((S.first === BLACK) === (i % 2 === 0) ? BLACK : WHITE);
  function renderTape() {
    const el = $('tape');
    if (!el) return;
    const cur = shownPly(), mv = S.board.moves;
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    mv.forEach((m, i) => {
      const bad = moveBad(i), col = colorOfMove(i);
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}${bad ? ' bad' : ''}"><span class="no">${i + 1}</span><span class="dot ${col === BLACK ? 'b' : 'w'}"></span>${S.board.name(m)}${bad ? '?' : ''}</button>`;
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

  function renderControls() {
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    const canUndo = S.board.moves.length && !S.online && (S.phase === 'play' || S.phase === 'mark');
    $('btn-undo').disabled = !canUndo; $('btn-undo2').disabled = !canUndo;
    $('btn-pass').disabled = !humanTurn();
    $('btn-resign').disabled = !live() || !!S.result || !humans().length;
    $('btn-hint').disabled = !humanTurn() || !AI.ok;
    $('btn-ownmenu').textContent = settings.own ? '地の見込みを隠す' : '地の見込みを盤に出す';
    $('viewing').hidden = live();
    if (!live()) $('viewing-text').textContent = `${S.view}手目を表示中`;
    $('kifu-info').textContent = `${S.size}路・コミ${S.komi}${S.handicap >= 2 ? `・置き石${S.handicap}` : ''}・${S.board.moves.length}手`;
  }

  const fmtLead = sc => (Math.abs(sc) < 0.25 ? '互角' : `${sc > 0 ? '黒' : '白'} +${Math.abs(sc).toFixed(1)}目`);
  function renderEval() {
    const ply = shownPly();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const e = info ? null : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.res.toPlay)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    let wr = null, sc = null;
    if (info) { const r = info.res, v = r.toPlay === BLACK ? r.value : -r.value; wr = (1 + v) / 2; sc = r.toPlay === BLACK ? r.score : -r.score; }
    else if (e) { wr = e.wr; sc = e.sc; }
    if (wr == null && live() && (S.result || S.phase === 'mark')) {
      const r = S.result;
      num.textContent = r ? resultHead(r) : '終局';
      lbl.textContent = r ? (r.score != null ? `黒${r.black}・白${r.white}` : '') : '死に石を確かめて数えます';
      setWR(r ? (r.winner === BLACK ? 1 : r.winner === WHITE ? 0 : 0.5) : 0.5); $('cands').innerHTML = ''; $('ev-meta').textContent = '';
      $('evs-num').textContent = num.textContent; $('evs-lbl').textContent = lbl.textContent; $('evs-best').textContent = '';
      return;
    }
    if (wr == null) {
      num.textContent = '—';
      lbl.textContent = !AI.ok ? 'AI のネットがありません' : S.thinking ? '読んでいます…' : settings.analyze ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('cands').innerHTML = ''; $('ev-meta').textContent = '';
      $('evs-num').textContent = '—'; $('evs-lbl').textContent = lbl.textContent; $('evs-best').textContent = '';
      return;
    }
    num.textContent = fmtLead(sc);
    lbl.textContent = `黒の勝率 ${(wr * 100).toFixed(1)}%`;
    setWR(wr);
    let best = '';
    if (info && info.res.cands && info.res.cands.length) {
      const r = info.res, b = boardAt(ply);
      const rows = r.cands.slice(0, 6).map((c, i) => {
        const w = (1 + c.v) / 2 * 100, s = c.s;
        const pv = (c.pv || []).slice(1, 8).map(m => b.name(m)).join(' ');
        return `<li class="${i === 0 ? 'best' : ''}"><span class="rank">${i + 1}</span><span>${b.name(c.move)}</span><span>${w.toFixed(1)}%</span><span>${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(1)}目</span><span class="pv">${pv}</span></li>`;
      });
      $('cands').innerHTML = info.kind === 'cpu' ? '' : rows.join('');
      $('ev-meta').textContent = `${r.visits.toLocaleString()}回読み${r.ms ? `・${(r.ms / 1000).toFixed(1)}秒` : ''}（勝率と目数は${COLOR[r.toPlay]}から見た値）`;
      if (info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${b.name(r.cands[0].move)}`;
    } else { $('cands').innerHTML = ''; $('ev-meta').textContent = ''; }
    $('evs-num').textContent = num.textContent; $('evs-lbl').textContent = `黒${(wr * 100).toFixed(0)}%`; $('evs-best').textContent = best;
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-bt').textContent = `黒 ${(p * 100).toFixed(1)}%`;
    $('wr-wt').textContent = `白 ${(100 - p * 100).toFixed(1)}%`;
    const bar = $('evalbar'), fill = $('evalbar-fill');
    const bottomIsBlack = !(S.online ? S.online.myColor === WHITE : humans().length === 1 && humans()[0] === WHITE);
    bar.classList.toggle('flip', !bottomIsBlack);
    fill.style.height = (p * 100).toFixed(1) + '%';
  }

  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.board.moves.length, S.size * S.size * 0.6);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.board.moves.length; i++) { const e = S.evals[i]; if (e) pts.push([x(i), y(e.wr)]); }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">黒</text><text x="3" y="${H - 4}">白</text>`;
    if (pts.length) {
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      html += `<polygon class="areab" points="${pts[0][0].toFixed(1)},${y(0.5)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0.5)}"/><polyline class="lineb" points="${line}"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    const ce = S.evals[shownPly()];
    if (ce) html += `<circle class="dot" cx="${cx}" cy="${y(ce.wr)}" r="3.5"/>`;
    svg.innerHTML = html;
  }

  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>開始局面${S.handicap >= 2 ? `（置き石${S.handicap}）` : ''}</span><span class="ev"></span></li>`];
    S.board.moves.forEach((m, i) => {
      const e = S.evals[i + 1], bad = moveBad(i);
      const ev = e && settings.showEval ? `${(e.wr * 100).toFixed(0)}%` : '';
      rows.push(`<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span>${COLOR[colorOfMove(i)]} ${S.board.name(m)}${bad ? ' ?' : ''}</span><span class="ev${bad ? ' bad' : ''}">${ev}</span></li>`);
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
    S.pending = -1;
    if (p >= S.board.moves.length) { S.view = null; S.dboard = null; }
    else { S.view = Math.max(0, p); S.dboard = boardAt(S.view); }
    S.info = null;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }
  function undo() {
    if (!S.board.moves.length || S.online) return;
    AI.cancel(); clearTimeout(S.timer);
    S.view = null; S.dboard = null; S.result = null; S.resultShown = false; S.phase = 'play'; S.dead = new Set();
    // 最後の人の手（とそのあとの CPU の手）を取り消す
    let n = S.board.moves.length - 1;
    if (humans().length) while (n > 0 && isCPU(colorOfMove(n))) n--;
    const moves = S.board.moves.slice(0, n);
    S.board = newBoard(); for (const m of moves) S.board.play(m);
    S.evals.length = Math.min(S.evals.length, n + 1);
    S.info = null; S.pending = -1;
    afterChange();
  }
  function branch() {
    if (live() || S.online) return;
    AI.cancel();
    const n = S.view, moves = S.board.moves.slice(0, n);
    S.view = null; S.dboard = null; S.result = null; S.resultShown = false; S.phase = 'play'; S.dead = new Set();
    S.board = newBoard(); for (const m of moves) S.board.play(m);
    S.evals.length = Math.min(S.evals.length, n + 1);
    afterChange();
  }

  function sgfText() {
    const nm = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) && S.online ? S.online.opp.name : S.online && c === S.online.myColor ? myName : '人間');
    const r = S.result;
    const re = !r ? '' : r.winner === 0 ? '0' : `${r.winner === BLACK ? 'B' : 'W'}+${r.reason === '中押し' ? 'R' : Math.abs(r.score)}`;
    const d = new Date(), p2 = v => String(v).padStart(2, '0');
    return G.toSGF(S.board, { black: nm(BLACK), white: nm(WHITE), result: re, date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, comment: 'チューリング・テーブルの囲碁（中国ルール）' });
  }
  function importSGF(text) {
    const r = G.parseSGF(text);
    const b = r.board;
    if (![9, 13, 19].includes(b.n)) throw new Error(`${b.n}路の盤は、このアプリでは打てません（9路・13路・19路だけ）`);
    const setup = b.setup.length && !(b.handicap >= 2 && b.setup.length === b.handicap && b.setup.every(([p, c]) => c === BLACK)) ? b.setup.slice() : null;
    leaveOnline();
    loadGame({ size: b.n, komi: b.komi, handicap: setup ? 0 : b.handicap, setup, first: b.firstColor, seats: { 1: 'human', 2: 'human' }, moves: r.moves });
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
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦'], ['online', 'オンライン対戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['black', '黒（先に打つ）'], ['white', '白'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    seg('ng-size', [[9, '9路'], [13, '13路'], [19, '19路']], draft.size);
    const maxH = G.maxHandicap(draft.size);
    if (draft.ha > maxH) draft.ha = maxH;
    seg('ng-ha', [[0, 'なし（コミ7目）']].concat(Array.from({ length: maxH - 1 }, (_, i) => [i + 2, `${i + 2}子`])), draft.ha);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
    $('ng-size-hint').textContent = draft.size === 9 ? 'AI がいちばん強いのは9路です（9路で学習しました）' : 'AI は9路で学んだネットをそのまま使うので、9路ほど強くありません';
    $('ng-ha-hint').textContent = draft.ha >= 2 ? `黒が星に${draft.ha}子置き、白から打ちます。コミは0.5目、白に置き石の数（${draft.ha}目）を足して数えます（中国ルール）` : '黒から打ちます。白にコミ7目を足して数えます（持碁＝引き分けもあります）';
  }

  function showResult() {
    const r = S.result;
    if (!r) return;
    const hs = humans();
    let title = resultHead(r);
    if (hs.length === 1 && r.winner !== 0) title = r.winner === hs[0] ? 'あなたの勝ち' : 'あなたの負け';
    if (S.online) title = r.winner === 0 ? '持碁（引き分け）' : r.winner === S.online.myColor ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${S.size}路・${S.board.moves.length}手${S.online ? '・オンライン' : ''}　${resultHead(r)}`;
    $('rs-title').textContent = title;
    $('rs-count').innerHTML = r.score != null ? `<div><span class="stone b"></span>黒 <b>${r.black}</b></div><div><span class="stone w"></span>白 <b>${r.white}</b><span class="hint">＋コミ${S.komi}${S.handicap >= 2 ? `＋${S.handicap}` : ''}</span></div>` : '';
    const opp = S.online ? `相手は ${esc(S.online.opp.name)} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : hs.length === 1 ? `相手は CPU（${CPU[S.seats[3 - hs[0]]].label}）でした。` : '';
    $('rs-body').innerHTML = (r.score != null ? '盤上の石と、囲んだ地を数えます（中国ルール）。' : '') + esc(opp);
    $('rs-again').textContent = S.online ? 'もう一局（白黒交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  function openSGF(mode) {
    $('sg-msg').textContent = '';
    const out = mode === 'out';
    $('sg-title').textContent = out ? '棋譜を書き出す（SGF）' : '棋譜を読み込む（SGF）';
    $('sg-hint').textContent = out ? 'ほかの囲碁ソフトでも読める SGF 形式です。コピーするかファイルに保存してください。' : 'SGF を貼り付けるか、ファイルを選んでください（9路・13路・19路。最初の変化だけを読みます）。';
    $('sg-text').value = out ? sgfText() : '';
    $('sg-text').readOnly = out;
    $('sg-ok').hidden = out; $('sg-file-lab').hidden = out; $('sg-save').hidden = !out;
    $('dlg-sgf').hidden = false;
    if (out) { $('sg-text').select(); } else $('sg-text').focus();
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  function figSVG(rows, marks = {}) {
    const n = rows.length, pad = 40, w = (n - 1) * 100 + 2 * pad;
    let h = `<svg viewBox="${-pad} ${-pad} ${w} ${w}" aria-hidden="true" style="background:linear-gradient(160deg,var(--kaya-hi),var(--kaya) 45%,var(--kaya-lo))">${defsHTML()}`;
    for (let i = 0; i < n; i++) h += `<line class="g-line" stroke-width="3" x1="0" y1="${i * 100}" x2="${(n - 1) * 100}" y2="${i * 100}"/><line class="g-line" stroke-width="3" x1="${i * 100}" y1="0" x2="${i * 100}" y2="${(n - 1) * 100}"/>`;
    rows.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch === 'X') h += stoneHTML(x, y, BLACK);
      else if (ch === 'O') h += stoneHTML(x, y, WHITE, '', x * 7 + y);
      else if (ch === '*') h += `<circle cx="${x * 100}" cy="${y * 100}" r="20" fill="var(--shu)"/>`;
      else if (ch === 'x') h += stoneHTML(x, y, BLACK, ' opacity=".45"') + `<g class="dead-x" stroke-width="10"><line x1="${x * 100 - 22}" y1="${y * 100 - 22}" x2="${x * 100 + 22}" y2="${y * 100 + 22}"/><line x1="${x * 100 + 22}" y1="${y * 100 - 22}" x2="${x * 100 - 22}" y2="${y * 100 + 22}"/></g>`;
      else if (ch === 'b' || ch === 'w') h += `<rect x="${x * 100 - 22}" y="${y * 100 - 22}" width="44" height="44" fill="${ch === 'b' ? '#121314' : '#f8f5ee'}"/>`;
    }));
    return h + '</svg>';
  }
  function renderRules() {
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>黒と白が交互に、線の交わる点に石を1つずつ打ちます。打った石は動きません。黒が先に打ちます。</li>
          <li>石の上下左右の空いた点を<b>呼吸点</b>と言います。つながった石（連）の呼吸点を全部ふさぐと、その石を<b>取れ</b>ます。</li>
          <li>自分の石の呼吸点がなくなる所には打てません（<b>自殺手</b>）。ただし相手の石を取れるなら打てます。</li>
          <li><b>コウ</b>：すぐ取り返すと同じ形がくり返されるときは、一度ほかに打ってからでないと取り返せません。このアプリは<b>スーパーコウ</b>（盤全体の同じ形のくり返しは全部禁止）です。</li>
          <li>打つ所がなくなったら<b>パス</b>。2人続けてパスすると終局です。</li>
          <li>終局したら<b>死に石</b>（取られるのを待つだけの石）を確かめて取り除き、<b>盤上の石＋囲んだ地</b>を数えます（中国ルール）。白にはコミ7目を足し、多い方の勝ち。同じなら持碁（引き分け）。</li>
        </ul>
      </div>
      <div class="card" data-tab="図で見る">
        <h3>図で見る</h3>
        <div class="figs">
          <div class="fig">${figSVG(['.....', '..X..', '.XO*.', '..X..', '.....'])}<span>白1子の呼吸点は残り1つ。黒が●に打つと取れる</span></div>
          <div class="fig">${figSVG(['.....', '.XO..', 'XO*O.', '.XO..', '.....'])}<span>コウ：白が●の黒1子を取った直後。黒はすぐには●に打ち返せない</span></div>
          <div class="fig">${figSVG(['bXOww', 'bXOwx', 'XXOww', 'bXOOw', 'bXOww'])}<span>終局後：×の黒は死に石。■は黒の地、□は白の地</span></div>
        </div>
      </div>
      <div class="card" data-tab="操作">
        <h3>このアプリの操作</h3>
        <ul>
          <li><b>パソコン</b>：点にマウスを乗せると薄い石が出ます。クリックで打ちます。</li>
          <li><b>スマホ</b>：指を置くと、指の上に<b>拡大鏡</b>が出ます。指を動かして位置を合わせ、離すと仮置き（十字の線）。もう一度タップするか「打つ」で確定します（設定で1回のタップにもできます）。</li>
          <li>終局のあとは、AI が死に石を提案します。石をタップすると生き死にが切り替わります。「数える」で結果、「再開」で対局に戻ります。</li>
          <li>「AI補助」で形勢（勝率・目数）と最善手の候補（盤の上の数字＝その手の勝率）を出し入れ。⋯メニューから地の見込みも出せます。</li>
          <li>盤の下の棋譜テープで、好きな手の局面に戻れます。SGF の書き出し・読み込みは⋯メニューから。</li>
        </ul>
      </div>
      <div class="card" data-tab="置き碁">
        <h3>置き碁（ハンデ）</h3>
        <p>力に差があるときは、黒が先に星へ石を置いて始めます（9路は2〜5子、13路・19路は2〜9子）。置き碁では白から打ち、コミは0.5目、さらに白に置き石の数だけ目を足して数えます（中国ルールの数え方）。</p>
        <p class="hint">9路の置き石の位置: 2子＝左下と右上の星、3子＝＋左上、4子＝＋右下、5子＝＋天元。</p>
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
  function renderAIPage() {
    const W = HAS_NET ? GO_WEIGHTS : null;
    const info = (W && W.info) || {}, elo = (W && W.elo) || [], gens = (W && W.gens) || [], levels = (W && W.levels) || [];
    // 世代ごとの強さ: 測った世代どうしの対戦の Elo を古い順につないで足した伸び（第1世代 = 0。目安）。誤差は二乗和の平方根。
    // いまの端の世代を相手に測った対戦のうち、いちばん近い世代へ進む（となりを測っていなければ間を飛ばした対戦で）
    const meas = {};
    for (const e of elo) {
      const m = /^g(\d+) vs g(\d+)$/.exec(e.label || '');
      if (m && Number(m[1]) > Number(m[2]) && Number(m[2]) >= 1 && e.score < 0.999) (meas[Number(m[2])] = meas[Number(m[2])] || {})[Number(m[1])] = e;
    }
    const pts = [{ g: 1, e: 0, err: 0 }];
    for (let next; meas[pts[pts.length - 1].g] && (next = Math.min(...Object.keys(meas[pts[pts.length - 1].g]).map(Number))) < Infinity;) {
      const p = pts[pts.length - 1], m = meas[p.g][next];
      pts.push({ g: next, e: p.e + m.elo, err: Math.hypot(p.err, m.err) });
    }
    const bw = 600, bh = 170, pad = 34;
    let chart = '';
    if (pts.length > 1) {
      const top = Math.max(100, ...pts.map(p => p.e + p.err)), g0 = pts[0].g, g1 = pts[pts.length - 1].g;
      const X = g => pad + (g - g0) / Math.max(1, g1 - g0) * (bw - pad - 16), Y = e => bh - 20 - Math.max(0, e) / top * (bh - 34);
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（Elo）">
        ${[0, 0.5, 1].map(f => Math.round(top * f)).map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">+${t}</text>`).join('')}
        <polyline points="${pts.map(p => `${X(p.g).toFixed(1)},${Y(p.e).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${pts.map(p => `<line x1="${X(p.g)}" x2="${X(p.g)}" y1="${Y(p.e - p.err)}" y2="${Y(p.e + p.err)}" stroke="var(--accent)" stroke-width="1.5" opacity=".6"/><circle cx="${X(p.g)}" cy="${Y(p.e)}" r="4" fill="var(--accent)"><title>第${p.g}世代: +${Math.round(p.e)}±${Math.round(p.err)}</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${g0}世代</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代（+${Math.round(pts[pts.length - 1].e)}）</text>
      </svg>`;
    }
    const eloText = e => (e.score >= 0.999 ? '全勝' : e.score <= 0.001 ? '全敗' : `${e.elo >= 0 ? '+' : ''}${e.elo} ±${e.err}`);
    const rowsElo = elo.slice(-14).map(e => `<tr><td>${esc(e.label)}</td><td>${e.wins}勝${e.losses}敗${e.draws ? e.draws + '分' : ''}</td><td>${(e.score * 100).toFixed(1)}%</td><td>${eloText(e)}</td></tr>`).join('');
    const rowsLv = levels.map(e => `<tr><td>${esc(e.label)}</td><td>${e.wins}勝${e.losses}敗${e.draws ? e.draws + '分' : ''}</td><td>${eloText(e)}</td></tr>`).join('');
    const totalGames = info.games || (gens.length ? gens[gens.length - 1].games : 0) || 0;
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        ${W ? `<div class="stat-row">
          <div class="stat"><b>${W.gen || '—'}</b><span>世代（いまの CPU）</span></div>
          <div class="stat"><b>${totalGames ? totalGames.toLocaleString() : '—'}</b><span>自己対局（累計局数）</span></div>
          <div class="stat"><b>${W.blocks}×${W.ch}</b><span>ネットの大きさ（ブロック×チャンネル）</span></div>
        </div>${W.note ? `<p class="hint" style="margin:8px 0 0">いまのネット: ${esc(W.note)}${W.exported ? `（${esc(W.exported)}）` : ''}</p>` : ''}` : '<p>AI のネット（js/weights.js）がまだありません。</p>'}
        ${chart ? `<p class="hint" style="margin:14px 0 6px">第1世代からの強さの伸び（Elo）。世代どうしを先後入れ替えで対戦させた差を、古い順につないで足したもの（となりを測っていない世代は飛ばす。目安）。縦線は誤差の目安。</p>${chart}` : '<p class="hint">世代どうしの対戦の記録は、学習が進むとここに出ます。</p>'}
        ${rowsElo ? `<div class="tbl wide-only" style="margin-top:8px"><table class="lv"><thead><tr><th>対戦</th><th>結果</th><th>勝率</th><th>Elo</th></tr></thead><tbody>${rowsElo}</tbody></table></div>` : ''}
        ${rowsLv ? `<p class="hint" style="margin:12px 0 4px">CPU の強さの段の差（すぐ下の段と対戦）</p><div class="tbl"><table class="lv"><thead><tr><th>対戦</th><th>結果</th><th>Elo</th></tr></thead><tbody>${rowsLv}</tbody></table></div>` : ''}
        <p class="hint">人間に勝てるかどうかは、オンライン対戦の成績で見ていきます。</p>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ（AlphaZero 型）</h3>
        <ul>
          <li><b>人の知識はゼロ</b>：棋譜・定石・既存の囲碁ソフトは一切使っていません。知っているのはルールだけ。最初はでたらめに打つネットが、自分自身との対局（自己対局）だけで強くなりました。</li>
          <li><b>ネット</b>：盤の形（石・呼吸点の数・コウ・最近の手・コミ）を読んで、「次の一手の確率」「勝ち・持碁・負けの確率」「最後の目数の差」「点ごとにどちらの地になるか」を同時に答える残差ネット（${W ? `${W.blocks}ブロック×${W.ch}チャンネル` : '—'}）。</li>
          <li><b>木探索</b>：ネットの答えを手がかりに、有望な手を何手も先まで読みます（PUCT。AlphaZero と同じ形）。学習の自己対局では少ない回数でも確実に良くなる Gumbel 版を使いました。</li>
          <li><b>学習</b>：自己対局の結果（勝ち負け・目数・地）と、読んだ結果の手の確率をネットに覚えさせ、それをくり返します。学習は Google Colab の TPU、ブラウザでは学習したネットを int8 にして WebAssembly（SIMD）で計算します。</li>
          <li><b>13路・19路</b>：9路で学んだネットをそのまま使います（盤の大きさによらない作りにしてあります）。9路より弱いです。</li>
        </ul>
        <table class="lv wide-only" style="margin-top:8px"><thead><tr><th>CPU の強さ</th><th>読み方</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].desc}</td></tr>`).join('')}
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
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', () => { aim = null; hideLoupe(); S.hover = -1; renderBoardMarks(); });
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('click', e => {
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
    });
    // 情報の行のボタン
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'place' && S.pending >= 0) play(S.pending);
      else if (act === 'unpend') { S.pending = -1; renderBoardMarks(); renderSqInfo(); }
      else if (act === 'live') viewPly(S.board.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'again') startGame(cfg);
      else if (act === 'finish') finishMark();
      else if (act === 'resume') resumePlay();
      else if (act === 'agree') agreeMark();
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.result) { S.result = { winner: S.online.myColor, reason: '接続切れ', score: null }; S.phase = 'play'; afterChange(); }
    });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      e.stopPropagation();
      const nav = b.dataset.nav;
      if (nav === 'first') viewPly(0);
      else if (nav === 'prev') viewPly(shownPly() - 1);
      else if (nav === 'next') viewPly(shownPly() + 1);
      else if (nav === 'last') viewPly(S.board.moves.length);
      else if (nav === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet('kifu'); }
      else if (b.dataset.ply != null) viewPly(Number(b.dataset.ply));
    });
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('cands', on, true); if (!on) setSetting('own', false, true); setSetting('cands', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'ev' : 'kifu'));
    $('btn-ownmenu').addEventListener('click', () => setSetting('own', !settings.own));
    $('btn-sgf-out').addEventListener('click', () => openSGF('out'));
    $('btn-sgf-in').addEventListener('click', () => openSGF('in'));
    window.addEventListener('resize', () => { fitBoardSoon(); if ($('side').classList.contains('open')) placeSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const segEl = b.closest('[data-seg]');
      if (segEl) { lobby[segEl.dataset.seg] = Number(b.dataset.v); renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { lobby.msg = ''; NET.wait({ sz: lobby.sz }, `${lobby.sz}路・コミ7目`); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('cands', on, true); if (!on) setSetting('own', false, true); setSetting('cands', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
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
    $('btn-pass').addEventListener('click', () => { if (humanTurn()) { if (S.board.moves.length && S.board.moves[S.board.moves.length - 1] === PASS || confirm('パスしますか？（相手も続けてパスすると終局です）')) play(PASS); } });
    $('btn-undo').addEventListener('click', undo);
    $('btn-undo2').addEventListener('click', undo);
    $('btn-resign').addEventListener('click', () => { if (confirm('投了しますか？')) resign(); });
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      if (S.online && NET) { S.online.myHints++; NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      analyze(true, HINT_MS);
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-cands', 'cands'], ['set-own', 'own'], ['set-confirm', 'confirm'], ['set-coords', 'coords'], ['set-sound', 'sound'], ['set-analyze', 'analyze'], ['set-resign', 'resign']].forEach(([id, k]) => {
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
    });
    document.querySelector('.evoff-card button').addEventListener('click', () => setSetting('showEval', true));
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewPly(Number(li.dataset.ply)); });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.board.moves.length, S.size * S.size * 0.6);
      viewPly(Math.max(0, Math.min(S.board.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    $('btn-live').addEventListener('click', () => viewPly(S.board.moves.length));
    $('btn-branch').addEventListener('click', branch);
    $('btn-copy').addEventListener('click', () => {
      const text = sgfText(), msg = $('copy-msg');
      try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); }, () => openSGF('out')); } catch (e) { openSGF('out'); }
    });
    $('btn-import').addEventListener('click', () => openSGF('in'));
    $('sg-cancel').addEventListener('click', () => { $('dlg-sgf').hidden = true; });
    $('sg-ok').addEventListener('click', () => {
      try { importSGF($('sg-text').value); $('dlg-sgf').hidden = true; } catch (err) { $('sg-msg').textContent = err.message; }
    });
    $('sg-file').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      f.text().then(t => { $('sg-text').value = t; });
    });
    $('sg-save').addEventListener('click', () => {
      const blob = new Blob([$('sg-text').value], { type: 'application/x-go-sgf' }), a = document.createElement('a');
      const d = new Date(), p2 = v => String(v).padStart(2, '0');
      a.href = URL.createObjectURL(blob); a.download = `go-${S.size}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.sgf`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        // オンライン対戦: すぐこのダイアログを閉じてオンラインのパネルへ（上の丸いボタンと同じ）。今の対局は、オンラインで始まるまでそのまま
        if (id === 'ng-mode' && v === 'online') { $('dlg-new').hidden = true; openOnline(); return; }
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-size') draft.size = Number(v);
        else if (id === 'ng-ha') draft.ha = Number(v);
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
      if (e.key === 'Escape') { closeSheet(); ['dlg-new', 'dlg-result', 'dlg-sgf', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.pending >= 0) { S.pending = -1; renderBoardMarks(); renderSqInfo(); } return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.board.moves.length); }
    });
  }

  // 振り返りパネル: 狭い画面だけ。盤のすぐ下から画面の下までを覆う
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function placeSheet() {
    const fr = $('goban').getBoundingClientRect(), h = window.innerHeight;
    $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.68, Math.max(h * 0.3, fr.bottom + 6))) + 'px');
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
    const box = { showEval: 'set-eval', cands: 'set-cands', own: 'set-own' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if ((k === 'showEval' || k === 'cands' || k === 'own') && NET) NET.setAI(aiFlags());
    if (k === 'coords') S.boardKey = '';
    if ((k === 'analyze' || k === 'showEval' || k === 'cands' || k === 'own') && !S.thinking && live() && isHuman(S.board.toPlay)) analyze();
    render();
  }

  // ------------------------------------------------------------------ オンライン対戦（共通の ../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available();
  const GAME = 'go';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/go/';
  let NET = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { sz: 9, msg: '' };
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? '最善手の候補' : '', f & 4 ? '地の見込み' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }

  function net() {
    if (NET || !ONLINE_OK) return NET;
    NET = SSIHOnline.create({
      game: GAME,
      onStatus: st => {
        renderOnlineBadge(); renderLobby();
        if (S.online) { if (st === 'on') { S.online.lostAt = S.online.oppPresent ? 0 : Date.now(); } renderSqInfo(); renderPlayers(); }
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
    setInterval(() => { if (S.online && !S.online.oppPresent) { renderSqInfo(); renderPlayers(); } }, 5000);
    return NET;
  }

  function startOnline(g) {
    $('dlg-online').hidden = true;
    const r = g.r || {};
    const sz = [9, 13, 19].includes(r.sz) ? r.sz : 9;
    const myColor = g.myColor ? WHITE : BLACK;
    const online = { gid: g.mid, myColor, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false, myAgree: false, oppAgree: false };
    const seats = myColor === BLACK ? { 1: 'human', 2: 'remote' } : { 1: 'remote', 2: 'human' };
    loadGame({ size: sz, komi: 7, handicap: 0, seats, moves: [], online });
    clack('move');
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    if (S.online) { S.online = null; for (const c of [BLACK, WHITE]) if (S.seats[c] === 'remote') S.seats[c] = 'human'; }
  }

  // 相手から届いたもの: あいさつ・指し手・今の状態・投了・AI補助・ヒント・死に石の印・同意・再開・もう一局
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    // 保持された「今の状態」（common/online.js が t に時刻を入れることがあるので、st の印で見分ける）
    if (msg.st === 1 && Array.isArray(msg.moves)) { applyState(msg); return; }
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      saveGame(); renderPlayers(); renderSqInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.board.moves.length + 1) applyRemote([msg.m | 0]); }
    else if (msg.t === 'resign') { if (!S.result) { S.phase = 'play'; S.result = { winner: o.myColor, reason: '中押し', score: null }; afterChange(); } }
    else if (msg.t === 'mk' && S.phase === 'mark' && Array.isArray(msg.dead)) {
      S.dead = new Set(msg.dead.map(x => x | 0).filter(p => S.board.c[p] === BLACK || S.board.c[p] === WHITE));
      S.markReady = true; o.myAgree = false; o.oppAgree = false;
      saveGame(); render();
    } else if (msg.t === 'agree' && S.phase === 'mark') {
      if (msg.k === deadKey()) { o.oppAgree = true; maybeFinishOnline(); } renderSqInfo();
    } else if (msg.t === 'resume' && S.phase === 'mark') { S.phase = 'play'; S.dead = new Set(); S.markReady = false; S.board.passes = 0; afterChange(); }
    else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.gid === 'string') {
      NET.start({ mid: msg.gid.slice(0, 20), myColor: msg.oc === WHITE ? 1 : 0, r: { sz: S.size }, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 相手の手を順に打つ（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const m of list) {
      if (S.result || S.phase !== 'play' || !isRemote(S.board.toPlay)) break;
      if (m !== PASS && !S.board.isLegal(m)) break;
      play(m, true);
    }
  }
  // 保持された状態に追いつく（再読み込み・取りこぼし）
  function applyState(st) {
    const mine = S.board.moves;
    for (let i = 0; i < Math.min(st.moves.length, mine.length); i++) if ((st.moves[i] | 0) !== mine[i]) return; // 食い違うものは使わない
    if (st.moves.length > mine.length) applyRemote(st.moves.slice(mine.length).map(x => x | 0));
    if (st.ph === 'mark' && S.phase === 'mark' && Array.isArray(st.dead) && st.moves.length === S.board.moves.length) {
      S.dead = new Set(st.dead.map(x => x | 0)); S.markReady = true; render();
    }
    if (st.rs && !S.result && st.moves.length === S.board.moves.length) {
      const r = st.rs;
      if (r.reason === '中押し' || r.reason === '接続切れ' || r.reason === '終局') { S.result = { winner: r.winner | 0, reason: r.reason, score: r.score, black: r.black, white: r.white }; S.phase = 'play'; afterChange(); }
    }
  }
  const deadKey = () => [...S.dead].sort((a, b) => a - b).join(',');
  function agreeMark() {
    const o = S.online;
    if (!o || S.phase !== 'mark') return;
    o.myAgree = true;
    NET.send({ t: 'agree', k: deadKey() });
    maybeFinishOnline();
    renderSqInfo();
  }
  function maybeFinishOnline() { const o = S.online; if (o && o.myAgree && o.oppAgree) finishMark(); }
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
    const gid = Math.random().toString(36).slice(2, 12);
    NET.send({ t: 'rego', gid, oc: o.myColor }); // 相手の新しい色 = いまの自分の色
    NET.start({ mid: gid, myColor: o.myColor === BLACK ? 1 : 0, r: { sz: S.size }, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  function tryRoom() {
    if (!roomCode || !NET || NET.status !== 'on' || NET.game) return;
    const p = NET.list().find(x => x.s === 'wait' && x.g === GAME && x.c === roomCode.toUpperCase());
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
      $('on-body').innerHTML = `<p>オンライン対戦は、公開版で遊べます。</p><p><a href="${PAGES_URL}" target="_blank" rel="noopener">${PAGES_URL}</a></p>`;
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
    // つながっていれば「オンライン対戦」（狭い画面では「対戦」だけ。数字だけにしない）、つながっていないときは「オンライン」
    b.querySelector('.lbl').innerHTML = st === 'on' || st === 'connecting' ? '<span class="lw">オンライン</span>対戦' : 'オンライン';
    const c = NET && st === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・囲碁の待ち${g.wait}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', all = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const c = all && Object.assign({ online: all.online }, all.byGame[GAME] ? { wait: all.byGame[GAME].wait, play: all.byGame[GAME].play } : { wait: 0, play: 0 });
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === GAME) : [];
    const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join('')}</div>`;
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(c && c.wait)}</b><span>囲碁の対戦待ち</span></div>
        <div class="stat"><b>${num(c && c.play)}</b><span>囲碁の対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・候補手・地の見込みを出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b><span class="hint">${esc(p.rl || ((p.r && p.r.sz) || 9) + '路')}</span>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「この碁盤で待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span><b>${esc(me.rl)}</b>で待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `${seg('sz', [[9, '9路'], [13, '13路'], [19, '19路']], lobby.sz)}
             <div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>この碁盤で待つ</button></div>`}
      </div>
      <p class="hint on-note">白黒はランダム、コミ7目。公開の中継サーバーを使うため、名前と手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // ------------------------------------------------------------------ はじめ
  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBoardSoon());
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && [9, 13, 19].includes(saved.size) && Array.isArray(saved.moves)) {
    try {
      let mine = null;
      try { mine = JSON.parse(sessionStorage.getItem('go-online') || 'null'); } catch (e) { /* なくても動く */ }
      if (mine && saved.online && mine.online && mine.online.gid === saved.online.gid) { saved.online = mine.online; saved.seats = mine.seats; }
      // 終わったオンライン対局や、オンラインにつなげない場所では、ふつうの対局（ふたりで対局）として開く
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; for (const c of [1, 2]) if (saved.seats[c] === 'remote') saved.seats[c] = 'human'; }
      if (saved.online) saved.online = Object.assign({ myHints: 0 }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false, myAgree: false, oppAgree: false });
      loadGame(saved);
      if (S.online && NET) NET.rejoin({ mid: S.online.gid, myColor: S.online.myColor === WHITE ? 1 : 0, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } });
    } catch (e) { console.error(e); startGame(cfg); }
  } else {
    startGame(cfg);
    openNew();
  }
})();
