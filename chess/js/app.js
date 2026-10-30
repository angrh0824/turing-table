/* チェス Webアプリ: 盤面UI・CPU（Web Worker）・AI補助・棋譜（PGN・FEN）・オンライン対戦 */
(function () {
  'use strict';
  const C = {};
  ChessCore(C);
  ChessAI(C);
  const { Position, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, START_FEN } = C;
  const P = window.ChessPieces;
  const $ = id => document.getElementById(id);
  const SIDE = ['白', '黒'];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // 学習した評価（js/weights.js）。なければ評価はいつも 0（何も知らない第0世代と同じ）
  const WT = (typeof CHESS_WEIGHTS !== 'undefined' && CHESS_WEIGHTS) ? CHESS_WEIGHTS : null;
  let NET = null;
  try { NET = WT ? C.loadNet(WT) : null; } catch (e) { NET = null; }
  const VALUES = WT && WT.values ? WT.values : C.DEFAULT_VALUES;

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'すぐ指します。1手先だけを、気まぐれに見ます', time: 400, depth: 1, noiseP: 3 },
    normal: { label: 'ふつう', stars: 2, desc: '1手に約3000局面を読みます（ときどき迷います）', time: 1500, nodes: 3000, noiseP: 0.3 },
    strong: { label: 'つよい', stars: 3, desc: '1手2秒。学習した評価で深く読みます', time: 2000 },
    max: { label: '最強', stars: 4, desc: '1手8秒・全スレッド。全力で読みます', time: 8000, parallel: true, hint: '1手 約8秒' },
    // 超最強: 最強と同じ AI で、考える時間を大きく延ばしたもの（延ばすと強くなることを測ってから足した。README）
    ultra: { label: '超最強', stars: 5, desc: '最強と同じ AI で、1手 約30秒・全スレッド。じっくり読みます', time: 30000, parallel: true, hint: '1手 約30秒' },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max', 'ultra'];
  // 弱い段の「気まぐれ」の大きさは、学習から測ったポーンの価値の何倍か（世代で評価の目盛りが変わっても同じくらいの弱さに）
  for (const k of CPU_KEYS) if (CPU[k].noiseP) CPU[k].noise = Math.round(CPU[k].noiseP * Math.max(30, VALUES[PAWN] || 100));
  const ANALYZE_MS = 6000, HINT_MS = 2500;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('chess-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('chess-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'white', cpuW: 'strong', cpuB: 'strong', start: 'std', fen: '' }, store.get('cfg', {}));
  if (!CPU[cfg.cpu]) cfg.cpu = 'normal';
  // AI補助: showEval = 形勢、arrow = 最善手の矢印
  const settings = Object.assign({ sound: true, anim: true, moves: true, reach: true, analyze: true, showEval: true, arrow: true }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.arrow;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    seats: ['human', 'normal'], startFen: START_FEN, pos: Position.start(), start0: Position.start(), moves: [], sans: [], evals: [], view: null, dpos: null, result: null,
    legal: [], sel: -1, targets: new Map(), inspect: -1, hover: -1, promo: null,
    info: null, cpuInfo: null, thinking: false, timer: 0, resultShown: false, flip: false,
    online: null, // { mid, myColor, opp: {name, ai, hints}, myHints, oppPresent, lostAt, myRe, oppRe, drawOffer: 0|1(相手から)|2(自分から) }
  };
  const live = () => S.view === null;
  const shownPly = () => (live() ? S.moves.length : S.view);
  const shownPos = () => (live() ? S.pos : S.dpos);
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (S.seats[c ^ 1] !== 'human' ? 'あなた' : '人間'));
  const humanTurn = () => live() && !S.result && isHuman(S.pos.stm);

  // ------------------------------------------------------------------ CPU（Web Worker）
  function workerMain() {
    const C = {};
    ChessCore(C);
    ChessAI(C);
    let S = null, helper = 0, lastNoise = 0;
    const pack = r => ({ move: r.move, score: r.score, depth: r.depth, pv: r.pv, nodes: r.nodes, time: r.time });
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') { helper = j.helper || 0; S = new C.Searcher(j.net, { sharedTT: j.tt, stopFlag: j.flag, helper, ttBits: 20, values: j.values }); return; }
      const pos = C.Position.fromMoves(j.fen, j.moves);
      // 評価にわざと揺らぎを入れる弱い CPU のあとは、置換表に残った雑な読みを捨てる
      if ((j.noise || 0) !== lastNoise) { S.clearTT(); lastNoise = j.noise || 0; }
      S.noise = j.noise || 0;
      S.salt = (Math.random() * 1e9) | 0;
      const onInfo = helper ? null : info => self.postMessage({ id: j.id, type: 'info', info: pack(info) });
      const r = S.think(pos, { timeMs: j.timeMs, maxDepth: j.maxDepth, maxNodes: j.maxNodes, analyze: j.analyze, jobId: j.id, onInfo });
      self.postMessage({ id: j.id, type: 'done', info: pack(r) });
    };
  }
  // ページが共有メモリを使える状態（serve.py や COOP/COEP 付きの公開先）なら、複数のワーカーが置換表を共有して読む（Lazy SMP）
  const SMP = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const THREADS = SMP ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const AI = {
    pool: [], id: 0, busy: false, fallback: null,
    tt: SMP ? C.makeTT(21, true) : null,
    flag: SMP ? new SharedArrayBuffer(4) : null,
    make(i) {
      try {
        const src = ChessCore.toString() + '\n' + ChessAI.toString() + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', net: NET, values: VALUES, tt: this.tt, flag: this.flag, helper: i });
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
      const n = this.ensure(job.parallel ? (job.parallel === 'all' ? THREADS : Math.min(THREADS, 4)) : 1); // 形勢を読む・ヒントは4スレッドまで、最強は全部
      const finish = r => { if (id !== this.id) return; this.busy = false; onDone(r); };
      if (!n) {
        setTimeout(() => {
          if (id !== this.id) return;
          if (!this.fallback) this.fallback = new C.Searcher(NET, { ttBits: 18, values: VALUES });
          this.fallback.noise = job.noise || 0;
          finish(this.fallback.think(Position.fromMoves(job.fen, job.moves), { timeMs: Math.min(job.timeMs, 1200), maxDepth: job.maxDepth, maxNodes: job.maxNodes, analyze: job.analyze }));
        }, 30);
        return;
      }
      if (this.flag) Atomics.store(new Int32Array(this.flag), 0, id);
      const msg = { type: 'think', id, fen: job.fen, moves: job.moves, noise: job.noise || 0, timeMs: job.timeMs, maxDepth: job.maxDepth, maxNodes: job.maxNodes, analyze: job.analyze };
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
    // 読みを今すぐ終わらせて、それまでの最善手を返させる（共有の停止フラグが使えるときだけ。使えなければ false）
    stopNow() { if (this.busy && this.flag) { Atomics.store(new Int32Array(this.flag), 0, -this.id); return true; } return false; },
    cancel() {
      if (this.busy) {
        if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -this.id);
        else { this.pool.forEach(w => w.terminate()); this.pool = []; } // 止められないので作り直す
      }
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 駒の音（WebAudio で合成。木の駒を盤に置く音）
  let actx = null;
  function clack(kind, delay = 0) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + delay, len = 0.07, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'cap' ? 800 : 1150; bp.Q.value = 2.4;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'cap' ? 1.7 : 1.15, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.frequency.setValueAtTime(kind === 'cap' ? 150 : 210, t); o.frequency.exponentialRampToValueAtTime(85, t + 0.08);
      og.gain.setValueAtTime(0.32, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.1);
      if (kind === 'check' || kind === 'end') {
        // 王手・終局: 小さな鈴の音
        [kind === 'end' ? 660 : 880, kind === 'end' ? 990 : 1320].forEach((f, i) => {
          const b = actx.createOscillator(), bg = actx.createGain();
          b.type = 'sine'; b.frequency.value = f;
          bg.gain.setValueAtTime(0.0001, t + 0.05 + i * 0.07); bg.gain.exponentialRampToValueAtTime(0.09, t + 0.07 + i * 0.07); bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6 + i * 0.07);
          b.connect(bg).connect(actx.destination); b.start(t + 0.05 + i * 0.07); b.stop(t + 0.7 + i * 0.07);
        });
      }
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    AI.cancel(); clearTimeout(S.timer);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuW, cfg.cpuB];
    else {
      const humanColor = cfg.side === 'random' ? (Math.random() < 0.5 ? WHITE : BLACK) : cfg.side === 'black' ? BLACK : WHITE;
      seats = humanColor === WHITE ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    loadGame({ seats, startFen: cfg.start === 'fen' && cfg.fen ? cfg.fen : START_FEN, moves: [] });
  }

  // moves は UCI の文字列（保存・オンライン）か整数
  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.seats = g.seats; S.online = g.online || null;
    S.startFen = g.startFen || START_FEN;
    S.pos = Position.fromFEN(S.startFen);
    S.start0 = S.pos.clone();
    S.moves = []; S.sans = []; S.evals = g.evals ? g.evals.slice() : [];
    for (const u of g.moves || []) {
      const m = typeof u === 'number' ? u : S.pos.moveFromUCI(u);
      if (!m || !S.pos.isLegal(m)) break;
      S.sans.push(S.pos.san(m)); S.pos.makeMove(m); S.moves.push(m);
    }
    S.view = null; S.dpos = null; S.result = g.result || null; S.info = null; S.cpuInfo = null;
    S.resultShown = !!g.result;
    S.flip = g.flip != null ? g.flip : (S.seats[WHITE] !== 'human' && S.seats[BLACK] === 'human');
    hidePromo();
    afterChange();
  }
  const uciList = () => { const p = Position.fromFEN(S.startFen), out = []; for (const m of S.moves) { out.push(p.uci(m)); p.makeMove(m); } return out; };
  function saveGame() {
    const online = S.online ? { mid: S.online.mid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { seats: S.seats, startFen: S.startFen, moves: uciList(), result: S.result, flip: S.flip, evals: S.evals.map(v => (v == null ? null : Math.round(v))), online });
  }
  function rebuild(n) {
    S.moves.length = n; S.sans.length = n; S.evals.length = Math.min(S.evals.length, n + 1);
    S.pos = Position.fromMoves(S.startFen, S.moves);
    S.result = null; S.resultShown = false;
  }

  function play(m, fromRemote) {
    if (!m) return;
    hidePromo();
    const anim = animOrigin(m);
    const uci = S.pos.uci(m), san = S.pos.san(m, S.legal.length ? S.legal : null);
    const kind = C.mvCap(m) ? 'cap' : 'move';
    S.sans.push(san);
    S.pos.makeMove(m);
    S.moves.push(m);
    if (S.online && NET_ && !fromRemote) NET_.send({ t: 'mv', n: S.moves.length, u: uci });
    if (S.online) S.online.drawOffer = 0;
    clack(S.pos.inCheck() ? 'check' : kind);
    if (C.mvFlag(m) === C.F_CASTLE) clack('move', 0.09);
    afterChange(anim);
    publishState();
  }

  function afterChange(anim) {
    S.sel = -1; S.targets = new Map(); S.hover = -1; S.inspect = -1;
    if (!S.result) S.result = S.pos.result();
    S.legal = S.result ? [] : S.pos.legalMoves();
    S.info = null; S.cpuInfo = null;
    saveGame();
    render(anim);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; clack('end', 0.15); setTimeout(showResult, 600); }
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (!live() || S.result) { analyze(); return; }
    const c = S.pos.stm;
    if (isRemote(c)) { AI.cancel(); renderEval(); renderArrows(); return; } // オンラインの相手の番: 届くのを待つ
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = S.moves.length;
    S.thinking = true;
    renderPlayers();
    AI.start({ fen: S.startFen, moves: S.moves.slice(), timeMs: cpu.time, maxDepth: cpu.depth, maxNodes: cpu.nodes, noise: cpu.noise, parallel: cpu.parallel ? 'all' : false },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        if (live() && S.moves.length === ply && !S.result) S.timer = setTimeout(() => play(info.move), 160);
      });
  }

  // 人間の手番（または棋譜を見返しているとき）に形勢を読む
  function analyze(force, ms, kind = 'analysis') {
    const pos = shownPos();
    if (((!settings.analyze || !aiOn()) && !force) || (live() && S.result) || !pos.hasLegal()) { AI.cancel(); renderEval(); renderArrows(); return; }
    const ply = shownPly(), c = pos.stm;
    AI.start({ fen: S.startFen, moves: S.moves.slice(0, ply), timeMs: ms || ANALYZE_MS, analyze: true, parallel: true },
      info => onInfo(ply, c, info, kind), info => onInfo(ply, c, info, kind));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || !info.depth) return;
    const scoreW = c === WHITE ? info.score : -info.score;
    // 弱い CPU（やさしい・ふつう）は読みが浅いので形勢グラフには使わない
    const cpuWeak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if (!cpuWeak || S.evals[ply] == null) S.evals[ply] = scoreW;
    const rec = { ply, scoreW, pv: info.pv || [], depth: info.depth, nodes: info.nodes, time: info.time, stm: c, kind };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!cpuWeak || !S.info || S.info.ply !== ply) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderTape(); renderArrows();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力（タップ・ドラッグ）
  //   自分の駒 → 選ぶ（行き先以外のマスがやんわり暗くなる。もう一度タップで解除）
  //   選んだ駒の行き先 → すぐ指す（昇格だけ、小さなメニューで駒を選ぶ）
  //   相手の駒・動かせない駒 → その駒の利きを見る（もう一度タップで消す）
  const canMoveFrom = sq => S.legal.some(m => C.mvFrom(m) === sq);
  function onSquare(sq) {
    hidePromo();
    const pos = shownPos(), p = pos.b[sq];
    if (!humanTurn()) { setInspect(p && S.inspect !== sq ? sq : -1); return; }
    if (S.sel >= 0 && S.targets.has(sq)) { moveTo(sq); return; }
    if (p && (p >> 3) === pos.stm && canMoveFrom(sq)) {
      if (S.sel === sq) { clearSel(); return; }
      select(sq);
      return;
    }
    S.sel = -1; S.targets = new Map();
    setInspect(p && S.inspect !== sq ? sq : -1);
  }
  function select(sq) {
    S.sel = sq; S.inspect = -1;
    S.targets = new Map();
    for (const m of S.legal) {
      if (C.mvFrom(m) !== sq) continue;
      const to = C.mvTo(m);
      if (!S.targets.has(to)) S.targets.set(to, []);
      S.targets.get(to).push(m);
    }
    renderBoard(); renderSqInfo();
  }
  function moveTo(sq) {
    const ms = S.targets.get(sq);
    if (!ms) return;
    if (ms.length > 1) showPromo(sq, ms); else play(ms[0]);
  }
  function setInspect(sq) { S.inspect = sq; renderBoard(); renderSqInfo(); }
  function clearSel() { S.sel = -1; S.targets = new Map(); S.inspect = -1; hidePromo(); renderBoard(); renderSqInfo(); }

  // 昇格の駒を選ぶ小さなメニュー（行き先のマスのそば）
  function showPromo(sq, ms) {
    hidePromo();
    const c = S.pos.stm, box = document.createElement('div');
    box.className = 'promo'; box.id = 'promo'; box.setAttribute('role', 'menu'); box.setAttribute('aria-label', '昇格する駒');
    for (const t of [QUEEN, KNIGHT, ROOK, BISHOP]) {
      const m = ms.find(x => C.mvPromo(x) === t);
      if (!m) continue;
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem'); b.setAttribute('aria-label', C.PIECE_JA[t] + 'に昇格'); b.title = C.PIECE_JA[t];
      b.innerHTML = P.svg(c, t, '');
      b.addEventListener('click', e => { e.stopPropagation(); play(m); });
      box.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'やめる');
    x.addEventListener('click', e => { e.stopPropagation(); hidePromo(); renderBoard(); });
    box.appendChild(x);
    S.promo = sq;
    const wrap = $('board-wrap'), el = sqEl(sq);
    wrap.appendChild(box);
    const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    let left = r.left - wr.left + r.width / 2 - box.offsetWidth / 2;
    left = Math.max(2, Math.min(wr.width - box.offsetWidth - 2, left));
    const top = r.top - wr.top < wr.height / 2 ? r.bottom - wr.top + 4 : r.top - wr.top - box.offsetHeight - 4;
    box.style.left = left + 'px'; box.style.top = Math.max(2, Math.min(wr.height - box.offsetHeight - 2, top)) + 'px';
    renderMarks();
    if (pointerType !== 'touch') box.querySelector('button').focus();
  }
  function hidePromo() { const b = $('promo'); if (b) b.remove(); if (S.promo != null) { S.promo = null; } }

  // ドラッグで指す（マウス・指どちらでも。動かさずに離せばタップと同じ）
  let drag = null, suppressClick = false;
  function bindDrag() {
    const grid = $('grid');
    grid.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const el = e.target.closest('.sq');
      if (!el || !humanTurn()) return;
      const sq = Number(el.dataset.sq), p = S.pos.b[sq];
      if (!p || (p >> 3) !== S.pos.stm || !canMoveFrom(sq)) return;
      drag = { sq, x: e.clientX, y: e.clientY, active: false, id: e.pointerId, ghost: null };
    });
    window.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 7) return;
        drag.active = true;
        if (S.sel !== drag.sq) select(drag.sq);
        const p = S.pos.b[drag.sq];
        const g = document.createElement('div');
        g.innerHTML = P.svg(p >> 3, p & 7, 'dragpiece');
        drag.ghost = g.firstChild;
        document.body.appendChild(drag.ghost);
        const pc = sqEl(drag.sq).querySelector('.piece');
        if (pc) pc.style.opacity = '.3';
      }
      drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const sqx = over && over.closest && over.closest('.sq');
      document.querySelectorAll('.sq.drop-hover').forEach(x => x.classList.remove('drop-hover'));
      if (sqx && S.targets.has(Number(sqx.dataset.sq))) sqx.classList.add('drop-hover');
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (!d.active) return;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
      if (d.ghost) d.ghost.remove();
      document.querySelectorAll('.sq.drop-hover').forEach(x => x.classList.remove('drop-hover'));
      const pc = sqEl(d.sq).querySelector('.piece');
      if (pc) pc.style.opacity = '';
      const over = e.type === 'pointerup' ? document.elementFromPoint(e.clientX, e.clientY) : null;
      const sqx = over && over.closest && over.closest('.sq');
      const to = sqx ? Number(sqx.dataset.sq) : -1;
      if (to >= 0 && S.targets.has(to)) { noAnimOnce = true; moveTo(to); } else renderBoard();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  let noAnimOnce = false;

  // ------------------------------------------------------------------ 描画
  const sqName = C.sqName;
  const dispToSq = i => { const r = i >> 3, f = i & 7; return S.flip ? ((r << 4) | (7 - f)) : (((7 - r) << 4) | f); };
  const sqEl = sq => { const r = sq >> 4, f = sq & 7; const i = S.flip ? (r * 8 + (7 - f)) : ((7 - r) * 8 + f); return $('grid').children[i]; };
  function render(anim) {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(anim); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderSqInfo(); renderArrows();
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

  function buildBoard() {
    const grid = $('grid');
    grid.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const b = document.createElement('button');
      b.className = 'sq';
      b.innerHTML = '<span class="tint"></span><span class="pc"></span><span class="mark"></span>';
      b.addEventListener('click', e => { e.stopPropagation(); if (suppressClick) return; onSquare(Number(b.dataset.sq)); });
      b.addEventListener('mouseenter', () => { if (pointerType === 'mouse' && !drag) onHover(Number(b.dataset.sq)); });
      b.addEventListener('mouseleave', () => { if (S.hover >= 0) onHover(-1); });
      grid.appendChild(b);
    }
  }
  function renderBoard(anim) {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length !== 64) buildBoard();
    const ply = shownPly();
    const lm = ply ? S.moves[ply - 1] : 0;
    const lastFrom = lm ? C.mvFrom(lm) : -1, lastTo = lm ? C.mvTo(lm) : -1;
    const checkSq = pos.inCheck() ? pos.king[pos.stm] : -1;
    for (let i = 0; i < 64; i++) {
      const sq = dispToSq(i), b = grid.children[i];
      b.dataset.sq = sq;
      let cls = 'sq' + ((((sq >> 4) + (sq & 7)) & 1) ? '' : ' dk');
      if (sq === lastFrom || sq === lastTo) cls += ' last';
      if (live() && S.sel === sq) cls += ' selected';
      if (S.inspect === sq) cls += ' inspect';
      if (sq === checkSq) cls += ' check';
      if (humanTurn() && pos.b[sq] && (pos.b[sq] >> 3) === pos.stm && canMoveFrom(sq)) cls += ' can';
      else if (live() && S.targets.has(sq)) cls += ' can';
      if (b.className !== cls) b.className = cls;
      const p = pos.b[sq], pc = b.children[1];
      const key = String(p);
      if (pc.dataset.key !== key) {
        pc.dataset.key = key;
        pc.innerHTML = p ? P.svg(p >> 3, p & 7) : '';
      }
      b.setAttribute('aria-label', `${sqName(sq)} ${p ? SIDE[p >> 3] + 'の' + C.PIECE_JA[p & 7] : '空き'}`);
    }
    renderMarks();
    const files = [], ranks = [];
    for (let i = 0; i < 8; i++) { files.push(`<span>${C.FILES[S.flip ? 7 - i : i]}</span>`); ranks.push(`<span>${S.flip ? i + 1 : 8 - i}</span>`); }
    $('coords-bot').innerHTML = files.join('');
    $('coords-left').innerHTML = ranks.join('');
    $('board').classList.toggle('noanim', !settings.anim || reduceMotion);
    renderEndmark();
    if (anim) runAnim(anim);
  }
  // 行き先の印（空きマスは点、取る手は輪）・利き・やんわり暗くする
  function renderMarks() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length !== 64) return;
    let reach = null, preview = null;
    if (S.inspect >= 0 && pos.b[S.inspect]) reach = new Set(pos.attacksFrom(S.inspect));
    else if (settings.reach && S.sel < 0 && S.hover >= 0 && pos.b[S.hover]) {
      const p = pos.b[S.hover];
      if (humanTurn() && (p >> 3) === pos.stm && canMoveFrom(S.hover)) preview = new Set(S.legal.filter(m => C.mvFrom(m) === S.hover).map(C.mvTo));
      else reach = new Set(pos.attacksFrom(S.hover));
    }
    let focus = null;
    if (live() && S.sel >= 0) focus = S.targets;
    else if (S.inspect >= 0 && reach) focus = reach;
    const keep = live() && S.sel >= 0 ? S.sel : S.inspect;
    for (let i = 0; i < 64; i++) {
      const sq = dispToSq(i), el = grid.children[i], tint = el.firstChild, mk = el.lastChild;
      let tc = 'tint', mc = 'mark';
      if (live() && S.targets.has(sq)) { if (settings.moves || S.promo != null) mc += pos.b[sq] || C.mvFlag(S.targets.get(sq)[0]) === C.F_EP ? ' cap' : ' move'; }
      else if (preview && preview.has(sq)) tc += ' prev';
      else if (reach && reach.has(sq)) { tc += ' reach'; if (pos.b[sq]) mc += ' ring'; }
      if (focus && !focus.has(sq) && sq !== keep) mc += ' dim';
      if (sq === S.promo) mc += ' pending';
      if (tint.className !== tc) tint.className = tc;
      if (mk.className !== mc) mk.className = mc;
    }
  }
  function onHover(sq) { S.hover = sq; renderMarks(); renderSqInfo(); }
  function renderEndmark() {
    const wrap = $('board');
    let el = $('endmark');
    const r = live() ? S.result : null;
    if (!r) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'endmark'; el.className = 'endmark'; wrap.appendChild(el); }
    el.innerHTML = `<b>${r.winner === -1 ? '引き分け' : SIDE[r.winner] + 'の勝ち'}</b><span>${esc(reasonText(r))}</span>`;
  }
  const reasonText = r => r.text || C.REASON_JA[r.reason] || r.reason;

  // 最善手・ヒントの矢印（ナイトは L 字に曲げる）
  function renderArrows() {
    const grid = $('grid');
    let svg = $('arrows');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'arrows'; svg.setAttribute('class', 'arrows'); svg.setAttribute('viewBox', '0 0 800 800'); svg.setAttribute('preserveAspectRatio', 'none');
      grid.appendChild(svg);
    }
    const info = S.info, pos = shownPos();
    const ok = info && info.kind !== 'cpu' && (info.kind === 'hint' || settings.arrow) && info.ply === shownPly() && info.pv && info.pv.length && !(live() && S.result);
    if (!ok) { svg.innerHTML = ''; return; }
    const m = info.pv[0];
    if (!pos.legalMoves().includes(m)) { svg.innerHTML = ''; return; }
    const xy = sq => { const r = sq >> 4, f = sq & 7; const x = S.flip ? 7 - f : f, y = S.flip ? r : 7 - r; return [x * 100 + 50, y * 100 + 50]; };
    const col = info.kind === 'hint' ? '#e0a526' : '#2e9a5a';
    const [fx, fy] = xy(C.mvFrom(m)), [tx, ty] = xy(C.mvTo(m));
    let d;
    if ((pos.b[C.mvFrom(m)] & 7) === KNIGHT) {
      const dx = tx - fx, dy = ty - fy;
      const cx = Math.abs(dx) > Math.abs(dy) ? tx : fx, cy = Math.abs(dx) > Math.abs(dy) ? fy : ty;
      const L = Math.hypot(tx - cx, ty - cy) || 1;
      d = `M${fx} ${fy} L${cx} ${cy} L${tx - (tx - cx) / L * 30} ${ty - (ty - cy) / L * 30}`;
    } else {
      const dx = tx - fx, dy = ty - fy, L = Math.hypot(dx, dy) || 1;
      d = `M${fx} ${fy} L${tx - dx / L * 30} ${ty - dy / L * 30}`;
    }
    svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="4" refY="5" markerWidth="3.4" markerHeight="3.4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker></defs>`
      + `<path d="${d}" fill="none" stroke="${col}" stroke-opacity=".82" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#ah)"/>`;
  }

  // 対局者のカード: 名前・取った駒・考え中／勝ち負け
  function capturedBy(pos, c) {
    // c が取った相手の駒 = 開始局面の相手の駒 − 今の相手の駒（昇格で増えた分は 0 で止める）
    const start = S.start0, them = c ^ 1, out = [];
    for (const t of [QUEEN, ROOK, BISHOP, KNIGHT, PAWN]) {
      const n = start.cnt[t | (them << 3)] - pos.cnt[t | (them << 3)];
      for (let k = 0; k < n; k++) out.push(t);
    }
    return out;
  }
  function renderPlayers() {
    const pos = shownPos(), topC = S.flip ? WHITE : BLACK;
    [['player-top', topC], ['player-bottom', topC ^ 1]].forEach(([id, c]) => {
      const el = $(id);
      const myTurn = live() && !S.result && pos.stm === c;
      el.classList.toggle('turn', myTurn);
      let st = '';
      if (myTurn && isCPU(c) && S.thinking) {
        const ci = S.cpuInfo;
        st = `<span class="think"><i></i>考え中${ci ? `・深さ${ci.depth}` : ''}</span>`;
        // 長く考える段（最強・超最強）は、待ちきれないときに「すぐ指して」で今までの最善手を指させる
        if (CPU[S.seats[c]].time >= 8000) st += '<button class="btn small" data-act="movenow" title="今までに読んだ中で一番よい手を、すぐ指します">すぐ指して</button>';
      } else if (myTurn && isRemote(c)) {
        st = S.online && NET_ && NET_.status === 'on' && !S.online.oppPresent ? '<span class="think lost">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think win">勝ち</span>' : S.result.winner === -1 ? '<span class="think">引き分け</span>' : '<span class="think lose">負け</span>';
      }
      const caps = capturedBy(pos, c);
      const capHTML = caps.length ? `<span class="caps" title="取った駒 ${caps.length}つ">${caps.slice(0, 9).map(t => P.svg(c ^ 1, t, '')).join('')}${caps.length > 9 ? `<span class="more">+${caps.length - 9}</span>` : ''}</span>` : '';
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : SIDE[c];
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      el.innerHTML = `
        <div class="id">${P.svg(c, KING, 'chip')}<span class="name">${nm}</span><span class="sub">${on ? SIDE[c] : seatLabel(c)}</span>${tag}</div>
        ${capHTML || '<span></span>'}
        <div class="right">${st}</div>`;
    });
  }

  // 情報の行: 選んだ駒・利きを見ている駒・状況（王手・終局・見返し中・相手の番）、何もなければ直前の手
  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const moveNo = i => { const p0 = S.start0; const n = p0.full + ((i + p0.stm) >> 1); return (i + p0.stm) % 2 === 0 ? `${n}.` : `${n}…`; };
  function renderSqInfo() {
    const el = $('sqinfo'), pos = shownPos();
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = pos.stm;
    const pieceTitle = sq => { const p = pos.b[sq]; return `${P.svg(p >> 3, p & 7, '')}<b>${sqName(sq)}の${SIDE[p >> 3]}の${C.PIECE_JA[p & 7]}</b>`; };
    if (live() && S.sel >= 0) {
      let mv = 0, cap = 0;
      S.targets.forEach((ms, to) => { if (pos.b[to] || C.mvFlag(ms[0]) === C.F_EP) cap++; else mv++; });
      html = `<span class="txt">${pieceTitle(S.sel)}　<span class="muted">動ける${mv}・取れる${cap}</span></span>`;
      tools = `<button class="ibtn" data-act="desel" aria-label="選択を解除" title="選択を解除">${CLOSE}</button>`;
    } else if (S.inspect >= 0 && pos.b[S.inspect]) {
      html = `<span class="txt">${pieceTitle(S.inspect)}の利き</span>`;
      tools = `<button class="ibtn" data-act="desel" aria-label="利きの表示を消す" title="利きの表示を消す">${CLOSE}</button>`;
    } else if (S.hover >= 0 && pos.b[S.hover]) {
      html = `<span class="txt">${pieceTitle(S.hover)}</span>`;
    } else if (!live()) {
      cls += ' view';
      const t = S.sans[S.view - 1];
      html = `<span class="txt"><b>${S.view}手目</b>${t ? ` ${moveNo(S.view - 1)} ${esc(t)}` : '（開始局面）'}</span>`;
      tools = btn('branch', 'ここから指す') + btn('live', '最新へ', ' primary');
    } else if (S.result && S.online) {
      cls += ' result';
      const r = S.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === -1 ? '引き分け' : r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（白黒を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>（${esc(reasonText(r))}）</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      const r = S.result;
      html = `<span class="txt"><b>${r.winner === -1 ? '引き分け' : SIDE[r.winner] + 'の勝ち'}</b>（${esc(reasonText(r))}）</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET_ && NET_.status !== 'on') {
      cls += ' bad';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' bad';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (S.online && S.online.drawOffer === 1) {
      cls += ' alert';
      html = `<span class="txt">${esc(S.online.opp.name)}さんから引き分けの申し込み</span>`;
      tools = btn('drawok', '受ける', ' primary') + btn('drawno', '断る');
    } else if (pos.inCheck()) {
      cls += ' bad';
      html = `<span class="txt">チェック！ ${SIDE[c]}のキングが狙われています</span>`;
    } else if (S.online && isRemote(c)) {
      html = `<span class="txt"><b>${esc(S.online.opp.name)}さん</b>の番です　<span class="muted">${S.online.drawOffer === 2 ? '引き分けを申し込みました' : S.sans.length ? `直前 ${esc(S.sans[S.sans.length - 1])}` : ''}</span></span>`;
    } else {
      const ply = shownPly(), t = S.sans[ply - 1];
      html = `<span class="txt muted">${ply ? `${moveNo(ply - 1)} <b style="color:var(--ink)">${esc(t)}</b>　` : ''}${humanTurn() ? `${SIDE[c]}の番です。駒をタップ（またはドラッグ）で指します` : `${SIDE[c]}の番`}</span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  // 棋譜テープ（盤の下で横に流れる手の一覧）。タップでその局面へ。今の手を真ん中に
  const winP = s => (C.isMate(s) ? (s > 0 ? 1 : 0) : C.winRate(s));
  function badMove(i) { // i 手目（0始まり）が大きく形勢を損ねた手か
    const a = S.evals[i], b = S.evals[i + 1];
    if (!settings.showEval || a == null || b == null) return false;
    const mover = (S.start0.stm + i) & 1;
    return (winP(b) - winP(a)) * (mover === WHITE ? 1 : -1) < -0.15;
  }
  function renderTape() {
    const el = $('tape');
    const cur = shownPly();
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    S.sans.forEach((t, i) => {
      const bad = badMove(i), no = moveNo(i);
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}${bad ? ' bad' : ''}">${no.endsWith('.') || i === 0 ? `<span class="no">${no}</span>` : ''}${esc(t)}${bad ? '?' : ''}</button>`;
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
  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const p0 = S.start0;
    let html = `<button class="start${cur === 0 ? ' cur' : ''}" data-ply="0">開始局面${S.startFen !== START_FEN ? '（FEN）' : ''}</button>`;
    let i = 0;
    const cell = k => {
      if (k >= S.sans.length) return '<span></span>';
      const s = S.evals[k + 1], bad = badMove(k);
      const ev = s != null && settings.showEval ? (C.isMate(s) ? (s > 0 ? '#+' : '#−') : (s > 0 ? '+' : '') + Math.round(s)) : '';
      return `<button data-ply="${k + 1}" class="${cur === k + 1 ? 'cur' : ''}${bad ? ' bad' : ''}"><span>${esc(S.sans[k])}${bad ? '?' : ''}</span><span class="ev">${ev}</span></button>`;
    };
    if (p0.stm === BLACK && S.sans.length) { html += `<span class="no">${p0.full}.</span><span></span>${cell(0)}`; i = 1; }
    for (; i < S.sans.length; i += 2) {
      const n = p0.full + ((i + p0.stm) >> 1);
      html += `<span class="no">${n}.</span>${cell(i)}${cell(i + 1)}`;
    }
    el.innerHTML = html;
    const c = el.querySelector('.cur');
    if (c) {
      const top = c.offsetTop, bottom = top + c.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    }
  }

  function renderControls() {
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-undo').disabled = !S.moves.length || !!S.online;
    const humans = [WHITE, BLACK].filter(c => isHuman(c));
    $('btn-resign').disabled = !live() || !!S.result || !humans.length;
    $('btn-draw').hidden = !S.online;
    $('btn-draw').disabled = !S.online || !!S.result || S.online.drawOffer === 2;
    $('btn-hint').disabled = !humanTurn();
    $('kifu-info').textContent = `${S.moves.length}手${S.online ? '・オンライン' : ''}`;
  }

  function fmtScore(s) {
    if (C.isMate(s)) { const n = Math.ceil((C.MATE - Math.abs(s)) / 2); return `${s > 0 ? '白' : '黒'}の勝ち（${n}手で詰み）`; }
    return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(Math.round(s));
  }
  function evalLabel(sW) {
    const a = Math.abs(sW);
    if (a < 50) return '互角';
    return (sW > 0 ? '白' : '黒') + (a < 150 ? 'やや有利' : a < 400 ? '有利' : a < 900 ? '優勢' : '勝勢');
  }
  function renderEval() {
    const ply = shownPly(), pos = shownPos();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sW = info ? info.scoreW : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    const strip = (n, l, best) => { $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best; };
    if (sW == null) {
      num.textContent = '—';
      lbl.textContent = (live() && S.result) ? '終局' : (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', lbl.textContent, '');
      return;
    }
    if (C.isMate(sW)) { num.textContent = '#' + Math.ceil((C.MATE - Math.abs(sW)) / 2); lbl.textContent = fmtScore(sW); }
    else { num.textContent = fmtScore(sW); lbl.textContent = evalLabel(sW); }
    setWR(winP(sW));
    let best = '';
    if (info) {
      const p = Position.fromMoves(S.startFen, S.moves.slice(0, ply)), txt = [];
      for (const m of info.pv.slice(0, 12)) {
        if (!p.isLegal(m)) break;
        txt.push(p.san(m)); p.makeMove(m);
      }
      $('pv').innerHTML = txt.length ? `<span class="k">読み筋</span><span class="best">${esc(txt[0])}</span> ${esc(txt.slice(1).join(' '))}` : '';
      const nps = info.time ? Math.round(info.nodes / info.time * 1000) : 0;
      $('ev-meta').textContent = `深さ ${info.depth} ・ ${info.nodes.toLocaleString()} 局面 ・ ${(info.time / 1000).toFixed(1)}秒 ・ ${nps.toLocaleString()} 局面/秒`;
      if (txt.length && info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${txt[0]}`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(num.textContent, lbl.textContent, best);
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-wt').textContent = `白 ${(p * 100).toFixed(1)}%`;
    $('wr-bt').textContent = `黒 ${(100 - p * 100).toFixed(1)}%`;
  }
  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.moves.length, 40);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.moves.length; i++) { const s = S.evals[i]; if (s != null) pts.push([x(i), y(winP(s))]); }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">白</text><text x="3" y="${H - 4}">黒</text>`;
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

  // ------------------------------------------------------------------ アニメーション（動いた駒が元のマスからすべる。キャスリングはルークも）
  function animOrigin(m) {
    if (!settings.anim || reduceMotion || !live()) return null;
    if (noAnimOnce) { noAnimOnce = false; return null; }
    const out = [];
    const add = (from, to) => { const el = sqEl(from).querySelector('.piece'); if (el) out.push({ rect: el.getBoundingClientRect(), to }); };
    add(C.mvFrom(m), C.mvTo(m));
    if (C.mvFlag(m) === C.F_CASTLE) { const to = C.mvTo(m); if (to === 6) add(7, 5); else if (to === 2) add(0, 3); else if (to === 0x76) add(0x77, 0x75); else add(0x70, 0x73); }
    return out;
  }
  function runAnim(list) {
    for (const a of list) {
      const el = sqEl(a.to).querySelector('.piece');
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dx = a.rect.left - r.left, dy = a.rect.top - r.top;
      const sq = el.closest('.sq');
      sq.classList.add('moving');
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect();
      el.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; sq.classList.remove('moving'); }, 230);
    }
  }

  // ------------------------------------------------------------------ 棋譜・操作
  function viewPly(p) {
    hidePromo();
    if (p >= S.moves.length) { S.view = null; S.dpos = null; }
    else { S.view = Math.max(0, p); S.dpos = Position.fromMoves(S.startFen, S.moves.slice(0, S.view)); }
    S.sel = -1; S.targets = new Map(); S.info = null; S.inspect = -1;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }
  function undo() {
    if (!S.moves.length || S.online) return; // オンライン対局では待ったなし
    AI.cancel(); clearTimeout(S.timer);
    S.view = null; S.dpos = null;
    let n = S.moves.length - 1;
    if ([WHITE, BLACK].some(c => isHuman(c))) {
      const st = S.start0.stm;
      while (n > 0 && isCPU((st + n) & 1)) n--;
    }
    rebuild(n);
    afterChange();
  }
  function resign() {
    if (!live() || S.result) return;
    const humans = [WHITE, BLACK].filter(c => isHuman(c));
    const loser = humans.includes(S.pos.stm) ? S.pos.stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    S.result = { winner: loser ^ 1, reason: 'resign', text: `${SIDE[loser]}の投了` };
    if (S.online && NET_) { NET_.send({ t: 'resign' }); }
    afterChange();
    publishState();
  }
  const pgnResult = () => (!S.result ? '*' : S.result.winner === -1 ? '1/2-1/2' : S.result.winner === WHITE ? '1-0' : '0-1');
  function pgnText() {
    const d = new Date(), p0 = Position.fromFEN(S.startFen);
    const name = c => (S.online ? (c === S.online.myColor ? myName : S.online.opp.name) : isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : '人間');
    const tags = { Event: S.online ? 'チューリング・テーブル オンライン対局' : 'チューリング・テーブル', Site: 'https://angrh0824.github.io/turing-table/chess/', Date: `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`, Round: '-', White: name(WHITE), Black: name(BLACK) };
    if (S.result) tags.Termination = reasonText(S.result);
    return C.toPGN({ tags, sans: S.sans, startFen: S.startFen, result: pgnResult(), firstFull: p0.full, blackFirst: p0.stm === BLACK });
  }
  function importText(text) {
    const t = text.trim();
    if (!t) throw new Error('何も書かれていません');
    // FEN（1行で、/ が7つ）ならその局面から
    if (/^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}\s+[wb]/.test(t)) {
      Position.fromFEN(t);
      loadGame({ seats: ['human', 'human'], startFen: t, moves: [] });
      return;
    }
    const g = C.parsePGN(t);
    let result = null;
    if (g.result === '1-0' || g.result === '0-1') {
      const pr = g.position.result();
      if (!pr) result = { winner: g.result === '1-0' ? WHITE : BLACK, reason: 'resign', text: (g.tags.Termination || `${SIDE[g.result === '1-0' ? BLACK : WHITE]}の投了`) };
    } else if (g.result === '1/2-1/2' && !g.position.result()) result = { winner: -1, reason: 'agree', text: g.tags.Termination || '引き分け' };
    loadGame({ seats: ['human', 'human'], startFen: g.startFen, moves: g.moves, result });
  }
  function copyText(text, msgEl, label) {
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.rows = 6; ta.style.width = '100%'; msgEl.innerHTML = ''; msgEl.appendChild(ta); ta.select(); };
    try { navigator.clipboard.writeText(text).then(() => { msgEl.textContent = `${label}をコピーしました`; setTimeout(() => { msgEl.textContent = ''; }, 2500); }, fallback); } catch (e) { fallback(); }
  }
  function toast(msg) {
    // 狭い画面ではパネルが閉じているので、情報の行に一時的に出す
    const el = $('sqinfo');
    el.className = 'sqinfo alert';
    el.innerHTML = `<span class="txt">${esc(msg)}</span><span class="tools"></span>`;
    setTimeout(renderSqInfo, 2200);
  }

  // ------------------------------------------------------------------ ダイアログ
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    $('ng-start').focus({ preventScroll: true });
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(5 - CPU[k].stars)}</span><b>${CPU[k].label}</b>${CPU[k].hint ? `<span class="tm">${CPU[k].hint}</span>` : ''}<small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['white', '白（先に指す）'], ['black', '黒'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-start-pos', [['std', 'ふつうの初期配置'], ['fen', 'FEN で指定']], draft.start);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
    $('ng-fen').hidden = draft.start !== 'fen';
    if (draft.start === 'fen' && !$('ng-fen').value) $('ng-fen').value = draft.fen || '';
    $('ng-fen-msg').textContent = draft.start === 'fen' ? '好きな局面から始められます（詰め問題・終盤の練習など）' : '';
  }
  function showResult() {
    const r = S.result;
    if (!r) return;
    const humans = [WHITE, BLACK].filter(c => isHuman(c));
    let title = r.winner === -1 ? '引き分け' : `${SIDE[r.winner]}の勝ち`;
    if (humans.length === 1 && r.winner !== -1) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${S.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.online ? `相手は ${S.online.opp.name} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[humans[0] ^ 1]].label}）でした。` : '';
    $('rs-body').textContent = `${reasonText(r)}。${opp}`;
    $('rs-again').textContent = S.online ? 'もう一局（白黒交代）' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ ルール / AI ページ
  function miniBoard(cells, opts = {}) {
    // cells: { sq88: 'wN' のような駒 or 'm'（動ける）'x'（取れる）'a'（強調） }
    let h = '<div class="minib">';
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) {
      const sq = (r << 4) | f, v = cells[sq] || '';
      const pc = v.match(/[wb][PNBRQK]/), cl = (((r + f) & 1) ? '' : 'dk') + (v.includes('m') ? ' m' : '') + (v.includes('x') ? ' x' : '') + (v.includes('a') ? ' a' : '');
      h += `<i class="${cl}">${pc ? P.svg(pc[0][0] === 'b' ? 1 : 0, ' PNBRQK'.indexOf(pc[0][1]), '') : ''}</i>`;
    }
    return h + '</div>' + (opts.cap ? `<figcaption>${opts.cap}</figcaption>` : '');
  }
  const SQ = s => C.parseSq(s);
  function pieceDiagram(t) {
    const pos = Position.fromFEN('8/8/8/8/8/8/8/8 w - - 0 1'.replace('8/8/8/8/8/8/8/8', '4k3/8/8/8/8/8/8/K7'));
    const center = t === PAWN ? SQ('e2') : SQ('d4');
    pos.b[pos.king[0]] = 0; pos.b[pos.king[1]] = 0;
    pos.b[center] = t;
    const cells = {}; cells[center] = 'w' + ' PNBRQK'[t];
    for (const s of pos.attacksFrom(center)) cells[s] = (cells[s] || '') + (t === PAWN ? 'x' : 'm');
    if (t === PAWN) { cells[SQ('e3')] = 'm'; cells[SQ('e4')] = 'm'; delete cells[SQ('d3')]; delete cells[SQ('f3')]; cells[SQ('d3')] = 'bNx'; }
    return miniBoard(cells);
  }
  const MOVE_TEXT = ['', '前に1マス進みます（最初の位置からは2マスも可）。取るときだけ斜め前に1マス。最後の段に着くと昇格します。',
    '「L」の形に跳びます（縦横に2マス＋横縦に1マス）。間に駒があっても跳び越えます。',
    '斜めにどこまでも進みます。最初に置かれたマスの色から離れません。',
    '縦横にどこまでも進みます。キャスリングにも使います。',
    '縦横斜めにどこまでも進みます。いちばん強い駒です。',
    '全方向に1マス。取られそうなマス（相手の利きのあるマス）には動けません。'];
  function renderRules() {
    const chips = [KING, QUEEN, ROOK, BISHOP, KNIGHT, PAWN].map(t => `<button type="button" data-t="${t}" aria-pressed="${t === KNIGHT}" title="${C.PIECE_JA[t]}">${P.svg(0, t, '')}</button>`).join('');
    const castle = {}; Object.assign(castle, { [SQ('e1')]: 'a', [SQ('h1')]: 'a', [SQ('g1')]: 'wK', [SQ('f1')]: 'wR', [SQ('a1')]: 'wR', [SQ('e8')]: 'bK', [SQ('a8')]: 'bR', [SQ('h8')]: 'bR' });
    const ep = { [SQ('e5')]: 'wP', [SQ('d5')]: 'bPa', [SQ('d7')]: 'a', [SQ('d6')]: 'x', [SQ('e1')]: 'wK', [SQ('e8')]: 'bK' };
    const promo = { [SQ('b7')]: 'wPa', [SQ('b8')]: 'm', [SQ('e1')]: 'wK', [SQ('g8')]: 'bK' };
    const mate = { [SQ('g8')]: 'bK', [SQ('f7')]: 'bP', [SQ('g7')]: 'bP', [SQ('h7')]: 'bP', [SQ('a8')]: 'wRa', [SQ('g1')]: 'wK' };
    const stale = { [SQ('h8')]: 'bKa', [SQ('f7')]: 'wQ', [SQ('g6')]: 'wK' };
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>8×8 の盤で、白と黒が1手ずつ交互に駒を動かします。<b>白が先</b>です。</li>
          <li>相手のキングを<b>チェックメイト</b>（取られるのを防げない形）にすれば勝ち。キングが狙われている状態を<b>チェック</b>といい、チェックされた側は必ず逃げるか防ぎます。自分のキングがチェックされる手は指せません。</li>
          <li>相手の駒のいるマスに動くと、その駒を<b>取れます</b>（取った駒は使えません）。</li>
          <li>指せる手がないのにチェックされていなければ<b>ステイルメイト</b>で引き分け。ほかの引き分けは「引き分け」のタブに。</li>
          <li>このアプリでは、駒をタップ（またはドラッグ）すると行き先に印が出ます。相手の駒をタップするとその駒の利きが見られます。</li>
        </ul>
        <div class="figs">
          <figure>${miniBoard(mate)}<figcaption>チェックメイトの例: ルークが8段目に入り、黒のキングは逃げられない</figcaption></figure>
          <figure>${miniBoard(stale)}<figcaption>ステイルメイトの例（黒番）: 黒は動ける手がないが、チェックされていない → 引き分け</figcaption></figure>
        </div>
      </div>
      <div class="card" data-tab="駒の動き">
        <h3>駒の動き</h3>
        <div class="pchips" id="pchips">${chips}</div>
        <div class="pview" id="pview"></div>
      </div>
      <div class="card" data-tab="特別な手">
        <h3>特別な手</h3>
        <ul>
          <li><b>キャスリング</b>: キングとルークを1手で同時に動かします。キングが2マス横に動き、ルークがキングを跳び越えて隣に来ます。キングとそのルークが一度も動いていない・間に駒がない・キングがチェックされていない・キングが通るマスと着くマスが相手に利かれていない、のすべてが必要です。表記は O-O（キング側）・O-O-O（クイーン側）。</li>
          <li><b>アンパッサン</b>: 相手のポーンが最初の位置から2マス進んで自分のポーンの横に来たとき、<b>すぐ次の手に限り</b>、1マスだけ進んだものとして斜めに取れます。</li>
          <li><b>昇格（プロモーション）</b>: ポーンが最後の段に着いたら、クイーン・ルーク・ビショップ・ナイトのどれかに変わります（このアプリでは小さなメニューで選びます）。</li>
        </ul>
        <div class="figs">
          <figure>${miniBoard(castle)}<figcaption>キング側のキャスリング（O-O）: e1 のキングが g1 へ、h1 のルークが f1 へ</figcaption></figure>
          <figure>${miniBoard(ep)}<figcaption>黒が d7→d5 と2マス進んだ直後なら、e5 の白のポーンは d6 へ動いて d5 のポーンを取れる</figcaption></figure>
          <figure>${miniBoard(promo)}<figcaption>b7 のポーンが b8 に進むと昇格</figcaption></figure>
        </div>
      </div>
      <div class="card" data-tab="引き分け">
        <h3>引き分け</h3>
        <ul>
          <li><b>ステイルメイト</b>: 手番の側に指せる手がなく、チェックもされていない。</li>
          <li><b>三回同形</b>: 同じ局面（駒の配置・手番・キャスリングとアンパッサンの権利）が3回現れた。このアプリでは自動で引き分けにします。</li>
          <li><b>50手ルール</b>: 50手ずつ（両者で100手）、ポーンが動かず駒も取られなかった。このアプリでは自動で引き分けにします（その手でチェックメイトならチェックメイトが優先）。</li>
          <li><b>駒不足</b>: どちらもチェックメイトにできる駒がない（キング同士・キング＋ナイト1つ・キング＋同じ色のマスのビショップだけ など）。</li>
          <li><b>合意</b>: オンライン対局では「引き分けを申し込む」で、相手が受ければ引き分け。</li>
        </ul>
        <p class="hint">公式の大会では三回同形と50手ルールは「申し立て」で引き分けになりますが、このアプリでは自動にしています（ネット対局のサイトの多くと同じ）。</p>
      </div>
      <div class="card" data-tab="記録">
        <h3>棋譜の書き方（代数表記）</h3>
        <ul>
          <li>マスは筋（a〜h）＋段（1〜8）。白から見て左下が a1。</li>
          <li>駒は英語の頭文字: K キング・Q クイーン・R ルーク・B ビショップ・N ナイト（ポーンは書かない）。例: <b>Nf3</b>（ナイトが f3 へ）、<b>e4</b>（ポーンが e4 へ）。</li>
          <li>取る手は x: <b>Bxe5</b>、<b>exd5</b>（ポーンは元の筋を書く）。チェックは +、チェックメイトは #、昇格は =Q、キャスリングは O-O / O-O-O。</li>
          <li>同じ種類の駒が同じマスへ行けるときは、元の筋か段を足す: <b>Nbd2</b>、<b>R1e2</b>。</li>
          <li><b>PGN</b> は棋譜を保存する形式、<b>FEN</b> は局面を1行で書く形式。「⋯」のメニューからコピー・読み込みができ、ほかのチェスのアプリとやりとりできます。</li>
        </ul>
      </div>`;
    renderPiece(KNIGHT);
    docTabs($('view-rules'), 'rules');
  }
  function renderPiece(t) {
    $('pview').innerHTML = `${pieceDiagram(t)}<div class="info"><h4>${C.PIECE_JA[t]}（${C.LETTER[t] === 'P' ? '記号なし' : C.LETTER[t]}）</h4><p>${MOVE_TEXT[t]}</p><p class="hint">図の点は動けるマス、赤い輪は取れるマス。</p></div>`;
    $('pchips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.t) === t)));
  }
  // 読み物のページ（ルール・AI）は、カードの見出しからタブを作って1枚ずつ見せる
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

  function renderAIPage() {
    const w = WT || {}, h = w.history || [], gen = w.gen || 0;
    const acc = h.filter(e => e.accepted);
    let cum = 0;
    const series = [{ gen: 0, elo: 0, accepted: true }].concat(h.map(e => { if (e.accepted) cum += Math.max(0, e.elo); return { gen: e.gen, elo: cum, accepted: e.accepted, e }; }));
    const bw = 600, bh = 170, pad = 30;
    let chart = '';
    if (series.length > 1) {
      const maxE = Math.max(50, ...series.map(s => s.elo)), g0 = series[0].gen, g1 = series[series.length - 1].gen;
      const X = g => pad + (g - g0) / Math.max(1, g1 - g0) * (bw - pad - 8), Y = e => bh - 20 - e / maxE * (bh - 34);
      const line = series.map(s => `${X(s.gen).toFixed(1)},${Y(s.elo).toFixed(1)}`).join(' ');
      const ticks = [0, 0.5, 1].map(f => Math.round(maxE * f));
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（Elo の積み上げ）">
        ${ticks.map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t}</text>`).join('')}
        <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${series.map(s => `<circle cx="${X(s.gen)}" cy="${Y(s.elo)}" r="${s.accepted ? 3.2 : 2}" fill="${s.accepted ? 'var(--good)' : 'var(--muted)'}"><title>第${s.gen}世代${s.e ? ` ${s.accepted ? '採用' : '不採用'}・前の版に Elo ${s.e.elo >= 0 ? '+' : ''}${s.e.elo}±${s.e.err}` : '（何も知らない版）'}</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 4}" fill="var(--muted)" font-size="10">第${g0}世代</text><text x="${bw - 8}" y="${bh - 4}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代</text>
      </svg>`;
    }
    const ms = (w.measures || []).slice(-30);
    const rows = h.slice(-12).reverse().map(e => `<tr><td>第${e.gen}世代</td><td>${e.accepted ? '採用' : '不採用'}</td><td>${e.elo >= 0 ? '+' : ''}${e.elo}±${e.err}</td><td>${(e.score * 100).toFixed(1)}%（${e.games}局）</td><td>${(e.selfplay || 0).toLocaleString()}局</td></tr>`).join('');
    const lv = w.levels;
    const levelRows = lv && lv.rows ? lv.rows.map(r => `<tr><td>${esc(r.a)} vs ${esc(r.b)}</td><td>${(r.score * 100).toFixed(1)}%</td><td>${r.elo >= 0 ? '+' : ''}${r.elo}±${r.err}</td><td>${r.games}局</td></tr>`).join('') : '';
    const vals = w.values;
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>このAIの強さ</h3>
        ${!NET ? '<p>まだ学習した評価がありません（評価はいつも 0。詰みだけを読みます）。</p>' : ''}
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習の世代（採用された版）</span></div>
          <div class="stat"><b>${(w.totalGames || 0).toLocaleString()}</b><span>自己対局（累計局数）</span></div>
          <div class="stat"><b>${(w.totalPositions || 0).toLocaleString()}</b><span>学んだ局面（累計）</span></div>
          <div class="stat"><b>+${cum}</b><span>第0世代（何も知らない版）からの Elo（各世代の「新 vs 旧」の積み上げ）</span></div>
          ${ms.length ? `<div class="stat"><b>${ms[ms.length - 1].elo >= 0 ? '+' : ''}${ms[ms.length - 1].elo}</b><span>${esc(ms[ms.length - 1].anchor)}との直接対戦（第${ms[ms.length - 1].gen}世代・${ms[ms.length - 1].games}局・±${ms[ms.length - 1].eloErr}）</span></div>` : ''}
        </div>
        ${chart ? `<p class="hint" style="margin:14px 0 6px">世代ごとの検定: 「学習した新しい版 vs それまでの版」を、同じランダムな序盤から先後を入れ替えて対戦（1手の読みの量を固定）。勝ち越したら採用（緑）。線はその Elo の積み上げ。</p>${chart}` : ''}
        ${rows ? `<div class="tbl wide-only" style="margin-top:10px"><table class="lv"><thead><tr><th>世代</th><th>検定</th><th>前の版との Elo</th><th>勝率</th><th>自己対局</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ</h3>
        <ul>
          <li><b>探索</b>: αβ 探索（PVS・反復深化・置換表・静止探索・Null Move・LMR・枝刈り・キラー手と履歴による並べ替え）。ブラウザの JavaScript で1秒に数十万局面を読みます。「最強」は複数のスレッドが置換表を共有して読みます（Lazy SMP）。</li>
          <li><b>評価</b>: 小さなニューラルネット（NNUE と同じ形）。入力は「どちらの側から見て、どの駒がどのマスにあるか」（768 個の 0/1）、隠れ層 ${NET ? NET.H : 128}、出力1つ。指すたびに差分だけを計算するので速く、整数（16ビット）に直して同梱しています。</li>
          <li><b>人の知識は使っていない</b>: 駒の価値（ポーン=1 など）・マスの表・定跡・人の棋譜・ほかのソフトは一切使いません。第0世代の評価は全部 0 で、詰みだけを読む「何も知らない」AI から始めました。</li>
          <li><b>評価値</b>: 「手番の側が勝つ確率」を当てるように学習しているので、評価値 +400 で白の勝つ見込みが約73%（勝率 = 1 / (1 + e<sup>−評価値/400</sup>)）。</li>
          ${vals ? `<li><b>学習から測った駒の価値</b>（盤からその駒を除くと評価がどれだけ下がるか）: ポーン ${vals[1]}・ナイト ${vals[2]}・ビショップ ${vals[3]}・ルーク ${vals[4]}・クイーン ${vals[5]}。取る手の並べ替えにだけ使います。</li>` : ''}
        </ul>
      </div>
      <div class="card" data-tab="学習">
        <h3>自己対局による学習</h3>
        <ul>
          <li><b>1世代</b> = ① 今の版どうしで数千局の自己対局（序盤はランダムな手で始めて、いろいろな局面を見る。一部は駒の少ないランダムな局面から始めて終盤も覚える）→ ② その局面で「最後に勝ったか」と「探索の評価値」を目標にネットを学習 → ③ 新旧の対戦で勝ち越したら採用。</li>
          <li>第0世代は評価が全部 0 で、ほぼでたらめに指しながら1手詰めだけを見つけます。それでも「駒が多い側が詰ませやすい」ことから、第1世代は駒の大切さを自分で覚えます。</li>
          <li>学習は Node.js（この PC）と Google Colab（たくさんの CPU）で行い、学習のプログラムもすべてこのゲームのために書いたものです。</li>
        </ul>
      </div>
      <div class="card" data-tab="CPUの強さ">
        <h3>CPUの強さ</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>1手の時間</th><th>特徴</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].time / 1000}秒</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table></div>
        ${levelRows ? `<p class="hint" style="margin:12px 0 6px">段階どうしの対戦（${esc(lv.note || '')}）</p><div class="tbl"><table class="lv"><thead><tr><th>対戦</th><th>勝率</th><th>Elo 差</th><th>局数</th></tr></thead><tbody>${levelRows}</tbody></table></div>` : ''}
        <p class="hint" style="margin-top:10px"><b>考える時間を延ばすと強くなる</b>: 同じ AI（第99世代）で1手に読む局面の数を2倍（6万→12万）にすると、400局で 240勝86分74敗（Elo +153±32）。そこで、最強と同じ AI で1手 約30秒（最強の約3.75倍）読む「超最強」を足しました。</p>
        <p class="hint">人間のトップに勝てるかは、オンライン対戦の成績で見ていきます。</p>
      </div>`;
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
    }));
    $('view-rules').addEventListener('click', e => { const chip = e.target.closest('#pchips button'); if (chip) renderPiece(Number(chip.dataset.t)); });
    document.addEventListener('click', e => {
      // 「すぐ指して」: 停止フラグで読みを止めると、ワーカーがそれまでの最善手を返して指す。止められない環境では、届いている読み筋の最善手を指す
      if (e.target.closest('[data-act="movenow"]') && S.thinking && live()) {
        if (!AI.stopNow()) {
          const ci = S.cpuInfo, m = ci && ci.ply === S.moves.length && ci.pv[0];
          if (m && S.pos.isLegal(m)) { AI.cancel(); S.thinking = false; play(m); }
        }
        return;
      }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('#promo') && !e.target.closest('.sq') && S.promo != null) { hidePromo(); renderMarks(); }
    });
    // 情報の行のボタン
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'desel') clearSel();
      else if (act === 'live') viewPly(S.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.result) { S.result = { winner: S.online.myColor, reason: 'disconnect' }; afterChange(); }
      else if (act === 'drawok' && S.online && !S.result) { NET_.send({ t: 'drawok' }); S.result = { winner: -1, reason: 'agree', text: '合意の引き分け' }; afterChange(); publishState(); }
      else if (act === 'drawno' && S.online) { NET_.send({ t: 'drawno' }); S.online.drawOffer = 0; renderSqInfo(); }
      else if (act === 'again') startGame(cfg);
    });
    // ナビの行: ⏮ ◀ ▶ ⏭ と棋譜テープ
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
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'graph' : 'kifu'));
    $('btn-flip').addEventListener('click', () => { S.flip = !S.flip; hidePromo(); saveGame(); render(); });
    $('btn-copy').addEventListener('click', () => { copyText(pgnText(), $('copy-msg'), 'PGN'); toast('棋譜（PGN）をコピーしました'); });
    $('btn-fen').addEventListener('click', () => { copyText(shownPos().fen(), $('copy-msg'), 'FEN'); toast('局面（FEN）をコピーしました'); });
    $('btn-import').addEventListener('click', openImport);
    $('btn-draw').addEventListener('click', () => { if (S.online && NET_ && !S.result) { NET_.send({ t: 'draw' }); S.online.drawOffer = 2; render(); } });
    window.addEventListener('resize', () => { fitBoardSoon(); hidePromo(); if ($('side').classList.contains('open')) placeSheet(); setTimeout(() => { $('tape').dataset.html = ''; renderTape(); renderKifu(); }, 60); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET_) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET_.challenge(b.dataset.ch); renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') {
        if (S.online && !S.result) { lobby.msg = 'オンライン対局の途中です。終わってから（または投了してから）待てます'; renderLobby(); return; }
        leaveOnline(); // 終わったオンライン対局からは抜ける
        lobby.msg = ''; NET_.wait({ v: 1 }, '標準'); renderLobby(); renderOnlineBadge(); renderPlayers(); renderSqInfo();
      }
      else if (act === 'unwait') { NET_.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${NET_.me.c}`;
        try { navigator.clipboard.writeText(link).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }); } catch (err) { lobby.msg = link; renderLobby(); }
      }
    });
    $('dlg-online').addEventListener('change', e => {
      if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || myName; store.set('name', myName); if (NET_) NET_.setName(myName); }
    });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.result && !confirm('オンライン対局の途中です。新しい対局を始めると投了になります。よろしいですか？')) return;
      if (S.online && !S.result) resign();
      openNew();
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-resign').addEventListener('click', () => { if (S.online || confirm('投了しますか？')) resign(); });
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      if (S.online && NET_) { S.online.myHints++; NET_.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      const ply = S.moves.length, c = S.pos.stm;
      AI.start({ fen: S.startFen, moves: S.moves.slice(), timeMs: HINT_MS, analyze: true, parallel: true },
        info => onInfo(ply, c, info, 'hint'), info => onInfo(ply, c, info, 'hint'));
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-arrow', 'arrow'], ['set-moves', 'moves'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-reach', 'reach'], ['set-analyze', 'analyze']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => setSetting(k, el.checked));
    });
    $('evstrip').addEventListener('click', () => openSheet('ev'));
    $('evstrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet('ev'); } });
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) { closeSheet(); return; }
      const a = e.target.closest('[data-act]');
      if (a && a.dataset.act === 'show-eval') setSetting('showEval', true);
      else if (a && a.dataset.act === 'copy') copyText(pgnText(), $('copy-msg'), 'PGN');
      else if (a && a.dataset.act === 'fen') copyText(shownPos().fen(), $('copy-msg'), 'FEN');
      else if (a && a.dataset.act === 'import') openImport();
      const k = e.target.closest('#kifu button');
      if (k) viewPly(Number(k.dataset.ply));
    });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.moves.length, 40);
      viewPly(Math.max(0, Math.min(S.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => {
      try { importText($('im-text').value); $('dlg-import').hidden = true; } catch (err) { $('im-msg').textContent = err.message; }
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-start-pos') draft.start = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) $('dlg-new').hidden = true;
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; });
    $('ng-start').addEventListener('click', () => {
      if (draft.start === 'fen') {
        const f = $('ng-fen').value.trim();
        try { const p = Position.fromFEN(f); if (!p.hasLegal()) throw new Error('この局面はもう終わっています（指せる手がありません）'); draft.fen = f; } catch (err) { $('ng-fen-msg').textContent = err.message; return; }
      }
      $('dlg-new').hidden = true; startGame(draft);
    });
    // 終局
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) requestRematch(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); hidePromo(); ['dlg-new', 'dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel >= 0 || S.inspect >= 0) clearSel(); return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
    });
    bindDrag();
  }
  function openImport() { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); }

  // ------------------------------------------------------------------ オンライン対戦（../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available();
  const GAME = 'chess';
  let NET_ = null;
  let myName = store.get('name', '') || `ゲスト${Math.floor(100 + Math.random() * 900)}`;
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { msg: '' };
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.arrow ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '形勢' : '', f & 2 ? '最善手の矢印' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }
  function net() {
    if (NET_ || !ONLINE_OK) return NET_;
    NET_ = SSIHOnline.create({
      game: GAME,
      onStatus: st => {
        renderOnlineBadge(); renderLobby();
        if (S.online) {
          if (st === 'on') {
            S.online.lostAt = S.online.oppPresent ? 0 : Date.now();
            // つながり直したら、保持されている今の状態が届くのを少し待ってから、こちらの状態を出し直す（切れている間に指した手を相手に届ける）
            clearTimeout(S.online.resync);
            S.online.resync = setTimeout(publishState, 3000);
          }
          renderSqInfo(); renderPlayers();
        }
      },
      onPresence: () => { renderOnlineBadge(); renderLobby(); tryRoom(); },
      onMatch: g => startOnline(g),
      onRemote: m => onRemote(m),
      onOppPresence: p => { if (S.online) { S.online.oppPresent = p; S.online.lostAt = p ? 0 : Date.now(); renderSqInfo(); renderPlayers(); } },
      onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
    });
    NET_.setName(myName);
    NET_.setAI(aiFlags());
    NET_.connect();
    setInterval(() => { if (S.online && !S.online.oppPresent) renderSqInfo(); }, 10000);
    return NET_;
  }
  function startOnline(g) {
    $('dlg-online').hidden = true; $('dlg-result').hidden = true;
    const online = { mid: g.mid, myColor: g.myColor ? BLACK : WHITE, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false, drawOffer: 0 };
    const seats = online.myColor === WHITE ? ['human', 'remote'] : ['remote', 'human'];
    loadGame({ seats, startFen: START_FEN, moves: [], online });
    clack('move');
  }
  function leaveOnline() {
    if (NET_ && NET_.game) NET_.leaveGame();
    if (S.online) { S.online = null; S.seats = S.seats.map(x => (x === 'remote' ? 'human' : x)); }
  }
  // 相手から届いたもの: あいさつ（名前・AI補助）、指し手、今の状態、投了、AI補助の変更、ヒント、引き分けの申し込み、もう一局
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    // 保持メッセージ（今の状態）: common/online.js は時刻を t に入れることがあるので、moves があればそれとして扱う
    const isState = msg.t === 'state' || (typeof msg.t === 'number' && Array.isArray(msg.moves));
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET_.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      saveGame(); renderPlayers(); renderSqInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.moves.length + 1) applyRemote([String(msg.u || '')]); }
    else if (isState && Array.isArray(msg.moves)) {
      const mine = uciList();
      for (let i = 0; i < Math.min(msg.moves.length, mine.length); i++) if (String(msg.moves[i]) !== mine[i]) return; // 食い違うものは使わない
      applyRemote(msg.moves.slice(mine.length).map(String));
      if (msg.moves.length < S.moves.length) publishState(); // 相手（または保持されている状態）が遅れていれば、こちらの状態を出し直す
      // 盤の上では決まらない終わり方（投了・合意）が届いていなければ、状態から反映する
      const e = msg.end;
      if (e && !S.result && msg.moves.length === S.moves.length && [-1, 0, 1].includes(e.w)) {
        if (e.why === 'agree') S.result = { winner: -1, reason: 'agree', text: '合意の引き分け' };
        else if (e.why === 'resign' && e.w === o.myColor) S.result = { winner: o.myColor, reason: 'resign', text: `${o.opp.name}さんの投了` };
        if (S.result) afterChange();
      }
    } else if (msg.t === 'resign') {
      if (!S.result) { S.result = { winner: o.myColor, reason: 'resign', text: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 'draw') { if (!S.result) { o.drawOffer = 1; clack('check'); renderSqInfo(); } }
    else if (msg.t === 'drawok') { if (!S.result && o.drawOffer === 2) { S.result = { winner: -1, reason: 'agree', text: '合意の引き分け' }; afterChange(); } }
    else if (msg.t === 'drawno') { if (o.drawOffer === 2) { o.drawOffer = 0; lobby.msg = ''; renderControls(); toast(`${o.opp.name}さんは引き分けを断りました`); } }
    else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.mid === 'string') {
      NET_.start({ mid: msg.mid.slice(0, 20), myColor: msg.oc ? 1 : 0, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 今の状態（保持メッセージ）: 手の列と、盤の上では決まらない終わり方（投了・合意・接続切れ）
  function publishState() {
    if (!S.online || !NET_ || !NET_.game) return;
    const r = S.result, end = r && ['resign', 'agree', 'disconnect'].includes(r.reason) ? { w: r.winner, why: r.reason } : null;
    NET_.saveState({ t: 'state', moves: uciList(), r: r ? 1 : 0, end });
  }
  // 相手の手を順に指す（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const u of list) {
      if (S.result || !isRemote(S.pos.stm)) break;
      const m = S.pos.moveFromUCI(u);
      if (!m) break;
      if (!live()) { S.view = null; S.dpos = null; }
      play(m, true);
    }
  }
  // もう一局: 両方が希望したら、ID の小さい方が新しい対局を作る（白黒は交代）
  function requestRematch() {
    const o = S.online;
    if (!o || !NET_) return;
    o.myRe = true;
    NET_.send({ t: 're' });
    maybeRematch();
    renderSqInfo();
  }
  function maybeRematch() {
    const o = S.online;
    if (!o || !o.myRe || !o.oppRe || !NET_ || !NET_.game) return;
    const oppId = NET_.game.oppId;
    if (oppId && NET_.id > oppId) return; // 相手が作るのを待つ
    const mid = Math.random().toString(36).slice(2, 12);
    NET_.send({ t: 'rego', mid, oc: o.myColor });
    NET_.start({ mid, myColor: o.myColor ^ 1, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
  }
  // 招待リンク（?room=コード）で開いたら、その部屋の人が見えしだい申し込む
  function tryRoom() {
    if (!roomCode || !NET_ || NET_.status !== 'on' || NET_.game) return;
    const p = NET_.list().find(x => x.s === 'wait' && x.g === GAME && x.c === roomCode.toUpperCase());
    if (!p) return;
    roomCode = null;
    history.replaceState(null, '', location.pathname);
    lobby.msg = `${p.n}さんに申し込みました…`;
    NET_.challenge(p.id);
    renderLobby();
  }
  function openOnline() {
    $('dlg-online').hidden = false;
    if (!ONLINE_OK) {
      $('on-body').innerHTML = '<p>オンライン対戦は、公開版のページや手元のサーバー（serve.py）で開いたときに使えます。</p><p><a href="https://angrh0824.github.io/turing-table/chess/" target="_blank" rel="noopener">https://angrh0824.github.io/turing-table/chess/</a></p>';
      return;
    }
    net();
    renderLobby();
  }
  function renderOnlineBadge() {
    const b = $('btn-online');
    const st = NET_ ? NET_.status : 'off';
    b.dataset.st = st;
    const c = NET_ && st === 'on' ? NET_.counts() : null;
    const g = c && c.byGame && c.byGame[GAME];
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET_ ? NET_.status : 'off', c = NET_ ? NET_.counts() : null, me = NET_ ? NET_.me : null;
    const g = c && c.byGame && c.byGame[GAME];
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET_ && st === 'on' ? NET_.list().filter(p => p.s === 'wait' && p.g === GAME) : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(g ? g.wait : 0)}</b><span>チェスの対戦待ち</span></div>
        <div class="stat"><b>${num(g ? g.play : 0)}</b><span>チェスの対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・最善手の矢印を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「相手を待つ」で待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
        ${waiting ? `<div class="on-wait"><span>待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）。白黒は始まるときにランダムで決まります。</span></div>`
          : `<div><button class="btn primary" data-act="wait"${st === 'on' && !(S.online && !S.result) ? '' : ' disabled'}>相手を待つ</button>${S.online && !S.result ? '<span class="hint" style="margin-left:8px">オンライン対局の途中です</span>' : ''}</div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と指し手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。持ち時間はありません。</p>`;
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
    const box = { showEval: 'set-eval', arrow: 'set-arrow' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if (NET_ && ['showEval', 'arrow'].includes(k)) NET_.setAI(aiFlags());
    if (['analyze', 'showEval', 'arrow'].includes(k) && !S.thinking && (humanTurn() || !live())) analyze();
    render();
  }
  function branch() {
    if (live()) return;
    if (S.online) { viewPly(S.moves.length); return; }
    AI.cancel();
    const n = S.view;
    S.view = null; S.dpos = null;
    rebuild(n);
    afterChange();
  }

  // ------------------------------------------------------------------ はじめ
  buildBoard();
  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitBoardSoon);
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && Array.isArray(saved.moves)) {
    try {
      // 終わったオンライン対局や、オンラインにつなげない場所では、ふつうの対局（ふたりで対局）として開く
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; saved.seats = saved.seats.map(x => (x === 'remote' ? 'human' : x)); }
      if (saved.online) saved.online = Object.assign({ myHints: 0 }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false, drawOffer: 0 });
      loadGame(saved);
      if (S.online && NET_) NET_.rejoin({ mid: S.online.mid, myColor: S.online.myColor, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } }); // 対局の途中に戻る
    } catch (e) { startGame(cfg); }
  } else {
    // はじめて開いたときは対局の設定から
    startGame(cfg);
    openNew();
  }
})();
