/* 量子観測将棋 Webアプリ: 盤面UI・CPU（Web Worker）・形勢表示・棋譜・オンライン
 * 将棋の画面（../shogi/js/app.js）をもとに、量子駒の候補の表示・取ったときの観測・候補の絞り込みと確定の見せ方を足した */
(function () {
  'use strict';
  const K = {};
  KansokuCore(K);
  KansokuAI(K);
  // 学習した重み（js/weights.js）は後から非同期に届く。届くまで CPU の読みは待たせる（盤はすぐ出す）
  let W = (typeof KANSOKU_WEIGHTS !== 'undefined' && KANSOKU_WEIGHTS) ? KANSOKU_WEIGHTS : null;
  let wReady = !!W || window.KANSOKU_WEIGHTS_STATE === undefined || window.KANSOKU_WEIGHTS_STATE !== 0;
  const LV = (typeof KANSOKU_LEVELS !== 'undefined' && KANSOKU_LEVELS) ? KANSOKU_LEVELS : null;
  const { Position, BLACK, WHITE, QU } = K;
  // 将棋の画面から引き継いだところのため（量子観測将棋に入玉宣言・手合割はない）
  const DECLARE = -1, HANDICAPS = { hirate: { name: '量子観測将棋' } };
  const PC = KansokuPieces;
  const $ = id => document.getElementById(id);
  const FW = K.FW, KN = K.KN;
  const MARK = ['▲', '△'];
  // 動き（common/motion.js の TTMotion）。動きを減らす設定・設定のオフ・裏のタブでは一瞬で終わる
  const TM = window.TTMotion || null;
  let pointerType = 'mouse';
  document.addEventListener('pointerdown', e => { pointerType = e.pointerType || 'mouse'; }, true);

  // ------------------------------------------------------------------ CPU の強さ
  // 「最強」は共有メモリが使えるとき、すべてのスレッドで同じ置換表を使って読む（Lazy SMP）。超最強は、長く読むほど強くなると測れたときだけ足す
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'すぐ指します。指したあとの形だけを見て、少しでたらめに選びます', easy: true, temp: 350 },
    normal: { label: 'ふつう', stars: 2, desc: '数手先まで読みます', nodes: 6000, noise: 60 },
    strong: { label: 'つよい', stars: 3, desc: '学習した評価で深く読みます', time: 2000 },
    max: { label: '最強', stars: 4, desc: 'すべてのスレッドで、じっくり読みます', time: 8000, parallel: true },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 6000, HINT_MS = 2500;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('kansoku-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kansoku-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', side: 'black', cpuB: 'strong', cpuW: 'strong', handicap: 'hirate' }, store.get('cfg', {}));
  if (!HANDICAPS[cfg.handicap]) cfg.handicap = 'hirate';
  const settings = Object.assign({ sound: true, anim: true, arrow: true, reach: true, analyze: true, showEval: true, detail: false }, store.get('settings', {}));
  if (TM) { try { settings.anim = localStorage.getItem('tt-motion') !== '0'; } catch (e) { /* そのまま */ } } // アニメーションのオン・オフは全ゲーム共通
  const aiOn = () => settings.showEval || settings.arrow;

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    handicap: 'hirate', seats: ['human', 'normal'],
    pos: null, moves: [], texts: [], notes: [], evals: [], legal: [], bigSq: false, kcFlash: -1, qfx: null,
    view: null, dpos: null, sel: null, targets: new Map(),
    result: null, flip: false, info: null, cpuInfo: null, timer: 0, thinking: false,
    hover: -1, hoverHand: 0, resultShown: false, online: null, inspect: -1, pending: -1, evOpen: false,
  };
  const live = () => S.view === null;
  const shownPos = () => (live() ? S.pos : S.dpos);
  const shownPly = () => (live() ? S.moves.length : S.view);
  const isCPU = c => !!CPU[S.seats[c]];
  const isRemote = c => S.seats[c] === 'remote';
  const isHuman = c => S.seats[c] === 'human';
  const handi = () => S.handicap !== 'hirate';
  const sideName = c => (handi() ? ['下手', '上手'] : ['先手', '後手'])[c];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const seatLabel = c => (isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : isRemote(c) ? (S.online ? `${esc(S.online.opp.name)}さん` : '相手') : (S.seats[c ^ 1] !== 'human' ? 'あなた' : '人間'));

  // ------------------------------------------------------------------ CPU（Web Worker）
  function workerMain() {
    const K = {};
    KansokuCore(K);
    KansokuAI(K);
    let se = null, helper = 0;
    const pack = r => ({ move: r.move, score: r.score, depth: r.depth, pv: r.pv, nodes: r.nodes, time: r.time });
    self.onmessage = e => {
      const j = e.data;
      if (j.type === 'init') {
        helper = j.helper || 0;
        se = new K.Searcher(j.weights, { ttBits: 20, sharedTT: j.sharedTT, stopFlag: j.stopFlag, helper });
        return;
      }
      const pos = K.Position.fromMoves(j.handicap, j.moves);
      if ((j.noise || 0) !== se.noise) se.clearTT();
      se.noise = j.noise || 0;
      se.salt = (Math.random() * 1e9) | 0;
      if (j.easy) {
        // やさしい: 指したあとの静的評価の softmax で選ぶ（読まない）
        const sc = se.rootMoveScores(pos);
        let pick = sc.length ? sc[0] : null;
        if (sc.length) {
          const mx = Math.max(...sc.map(x => x.v)), ws = sc.map(x => Math.exp((x.v - mx) / ((j.temp || 300) * se.W.k)));  // 温度は評価の大きさに合わせる
          let r0 = Math.random() * ws.reduce((a, b) => a + b, 0);
          for (let i = 0; i < sc.length; i++) { r0 -= ws[i]; if (r0 <= 0) { pick = sc[i]; break; } }
        }
        self.postMessage({ id: j.id, type: 'done', helper, info: { move: pick ? pick.m : 0, score: pick ? pick.v : 0, depth: 1, pv: pick ? [pick.m] : [], nodes: sc.length, time: 0 } });
        return;
      }
      const onInfo = helper ? null : info => self.postMessage({ id: j.id, type: 'info', info: pack(info) });
      const r = se.think(pos, { timeMs: j.timeMs, nodes: j.nodes, maxDepth: j.maxDepth, analyze: j.analyze, jobId: j.id, onInfo });
      self.postMessage({ id: j.id, type: 'done', helper, info: pack(r) });
    };
  }
  // 共有メモリが使えるとき（serve.py で開いたとき・公開版は sw.js で）は、複数のワーカーが置換表を共有して読む（Lazy SMP）
  const SMP = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  const THREADS = SMP ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const AI = {
    pool: [], id: 0, busy: false, fallback: null,
    tt: SMP ? K.makeTT(20, true) : null,
    flag: SMP ? new SharedArrayBuffer(4) : null,
    make(i) {
      try {
        const src = KansokuCore.toString() + '\n' + KansokuAI.toString() + '\n(' + workerMain.toString() + ')();';
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.postMessage({ type: 'init', weights: W, sharedTT: this.tt, stopFlag: this.flag, helper: i });
        return w;
      } catch (e) {
        return null;
      }
    },
    ensure(n) {
      while (this.pool.length < n) { const w = this.make(this.pool.length); if (!w) break; this.pool.push(w); }
      return this.pool.length;
    },
    start(job, onInfo, onDone) {
      this.cancel();
      if (!wReady) { this.waiting = [job, onInfo, onDone]; return; }
      const id = ++this.id;
      this.busy = true;
      const n = this.ensure(job.parallel ? THREADS : 1);
      const finish = r => { if (id !== this.id) return; this.busy = false; onDone(r); };
      if (!n) {
        setTimeout(() => {
          if (id !== this.id) return;
          if (!this.fallback) this.fallback = new K.Searcher(W, { ttBits: 18 });
          const pos = Position.fromMoves(job.handicap, job.moves);
          this.fallback.noise = job.noise || 0;
          finish(this.fallback.think(pos, { timeMs: Math.min(job.timeMs || 1500, 1500), nodes: job.nodes, maxDepth: job.maxDepth, analyze: job.analyze }));
        }, 30);
        return;
      }
      if (this.flag) Atomics.store(new Int32Array(this.flag), 0, id);
      const msg = { type: 'think', id, handicap: job.handicap, moves: job.moves, noise: job.noise, timeMs: job.timeMs, nodes: job.nodes, maxDepth: job.maxDepth, analyze: job.analyze, easy: job.easy, temp: job.temp };
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
      this.waiting = null;
      if (this.busy) {
        if (this.flag) Atomics.store(new Int32Array(this.flag), 0, -this.id);
        else { this.pool.forEach(w => w.terminate()); this.pool = []; }
      }
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 駒音（WebAudio で合成。榧の盤に黄楊の駒を打つ音）
  let actx = null;
  function clack(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, len = 0.05, n = Math.floor(actx.sampleRate * len);
      const buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'cap' ? 1700 : kind === 'drop' ? 2300 : 2000; bp.Q.value = 3;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'cap' ? 1.8 : 1.3, t);
      src.connect(bp).connect(g).connect(actx.destination);
      src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(kind === 'cap' ? 420 : 520, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.06);
      og.gain.setValueAtTime(0.32, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.09);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の進行
  function startGame(c) {
    leaveOnline();
    cfg = c; store.set('cfg', cfg);
    AI.cancel(); clearTimeout(S.timer);
    let seats;
    if (cfg.mode === 'pvp') seats = ['human', 'human'];
    else if (cfg.mode === 'watch') seats = [cfg.cpuB, cfg.cpuW];
    else {
      const humanColor = cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : cfg.side === 'white' ? WHITE : BLACK;
      seats = humanColor === BLACK ? ['human', cfg.cpu] : [cfg.cpu, 'human'];
    }
    loadGame({ handicap: 'hirate', seats, moves: [] });
  }

  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.handicap = 'hirate'; S.seats = g.seats; S.online = g.online || null;
    S.gid = g.gid || Math.random().toString(36).slice(2, 12);   // 対局ごとの印（待った・ここからで終局をやり直しても、ごほうびは1局1回）
    S.pos = Position.initial(S.handicap);
    S.moves = []; S.texts = []; S.notes = []; S.evals = g.evals ? g.evals.slice() : [];
    for (const m of g.moves) { const b = snapQ(S.pos); S.texts.push(S.pos.moveText(m)); S.pos.make(m); S.moves.push(m); S.notes.push(noteOf(b, S.pos, m)); }
    S.view = null; S.dpos = null; S.sel = null; S.result = g.result || null; S.info = null; S.cpuInfo = null;
    S.resultShown = !!g.result;
    S.flip = g.flip != null ? g.flip : (S.seats[BLACK] !== 'human' && S.seats[WHITE] === 'human');
    afterChange();
  }

  function saveGame() {
    const online = S.online ? { gid: S.online.gid, myColor: S.online.myColor, opp: S.online.opp, myHints: S.online.myHints } : null;
    store.set('game', { gid: S.gid, handicap: S.handicap, seats: S.seats, moves: S.moves, result: S.result, flip: S.flip, evals: S.evals.map(v => (v == null ? null : Math.round(v))), online });
  }

  function rebuild(n) {
    S.moves.length = n; S.texts.length = n; S.notes.length = n; S.evals.length = Math.min(S.evals.length, n + 1);
    S.pos = Position.fromMoves(S.handicap, S.moves);
    S.result = null; S.resultShown = false;
  }

  function play(m, fromRemote) {
    if (!m) return;
    const anim = animOrigin(m);
    const kind = m === DECLARE ? null : K.isDrop(m) ? 'drop' : S.pos.board[K.mvTo(m)] ? 'cap' : 'move';
    const before = snapQ(S.pos);
    S.texts.push(S.pos.moveText(m));
    S.pos.make(m);
    S.moves.push(m);
    S.notes.push(noteOf(before, S.pos, m));
    S.qfx = live() ? qDiff(before, S.pos, m) : null;
    if (S.online && NET && !fromRemote) NET.send({ t: 'mv', n: S.moves.length, m });
    afterChange(anim, kind);
    if (S.online && NET) NET.saveState({ k: 'st', moves: S.moves, r: S.result ? 1 : 0 });
  }

  // anim: 指した駒の動き（animOrigin）。kind: 駒音の種類（動きがあれば着いたときに鳴らす）
  function afterChange(anim, kind) {
    S.sel = null; S.targets = new Map(); S.hover = -1; S.inspect = -1;
    hideChooser();
    if (!S.result) S.result = S.pos.result();
    S.legal = S.result ? [] : S.pos.legalMoves();
    S.info = null; S.cpuInfo = null;
    saveGame();
    render();
    if (anim) runAnim(anim, kind); else if (kind) clack(kind);
    if (S.qfx) { const fx = S.qfx; S.qfx = null; setTimeout(() => runQfx(fx), anim ? 300 : 0); }
    if (S.result && !S.resultShown && live()) { S.resultShown = true; setTimeout(showResult, 450); }
    schedule();
  }

  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    // 「新しい対局」を選んでいる間は進めない（CPU は読まず指さない・観戦も止める）。閉じたら続きから
    if (S.paused) { AI.cancel(); renderPlayers(); return; }
    if (!live() || S.result) { analyze(); return; }
    const c = S.pos.stm;
    if (isRemote(c)) { AI.cancel(); renderEval(); return; }
    if (!isCPU(c)) { analyze(); return; }
    const cpu = CPU[S.seats[c]], ply = S.moves.length;
    S.thinking = true;
    renderPlayers();
    AI.start({ handicap: S.handicap, moves: S.moves.slice(), timeMs: cpu.time, nodes: cpu.nodes, noise: cpu.noise, parallel: !!cpu.parallel, easy: !!cpu.easy, temp: cpu.temp },
      info => onInfo(ply, c, info, 'cpu'),
      info => {
        onInfo(ply, c, info, 'cpu');
        S.thinking = false;
        if (!(live() && S.moves.length === ply && !S.result)) return;
        if (!info.move) { renderPlayers(); return; }
        // 弱い CPU はすぐ指しすぎないよう、少し間をおく
        const wait = (cpu.nodes || cpu.easy) && info.time < 450 ? 450 - info.time : 100;
        S.timer = setTimeout(() => play(info.move), wait);
      });
  }

  function analyze(force, ms) {
    const pos = shownPos();
    if (((!settings.analyze || !aiOn()) && !force) || pos.result()) { AI.cancel(); renderEval(); return; }
    const ply = shownPly(), c = pos.stm;
    AI.start({ handicap: S.handicap, moves: S.moves.slice(0, ply), timeMs: ms || ANALYZE_MS, analyze: true, parallel: true },
      info => onInfo(ply, c, info, 'analysis'), info => onInfo(ply, c, info, 'analysis'));
  }

  function onInfo(ply, c, info, kind) {
    if (!info || !info.depth) return;
    const scoreB = c === BLACK ? info.score : -info.score;
    const cpuWeak = kind === 'cpu' && CPU[S.seats[c]] && CPU[S.seats[c]].noise;
    if (!cpuWeak || S.evals[ply] == null) S.evals[ply] = scoreB;
    const rec = { ply, scoreB, pv: info.pv || [], depth: info.depth, nodes: info.nodes, time: info.time, stm: c, kind };
    if (kind === 'cpu') S.cpuInfo = rec;
    if (!cpuWeak || !S.info || S.info.ply !== ply) S.info = rec;
    renderEval(); renderGraph(); renderKifu(); renderArrows(); renderTape();
    if (kind === 'cpu') renderPlayers();
  }

  // ------------------------------------------------------------------ 入力
  const humanTurn = () => live() && !S.result && isHuman(S.pos.stm);

  // マスをタップ: 自分の駒 → 選ぶ（行き先以外が暗くなる）・行き先 → 指す（成る・成らないを選べるときだけ小さなメニュー）・相手の駒 → 利きを見る
  function onSquare(sq) {
    hideChooser();
    const pos = shownPos(), p = pos.board[sq];
    if (!humanTurn()) { setInspect(p && S.inspect !== sq ? sq : -1); return; }
    if (S.sel && S.targets.has(sq)) {
      const ms = S.targets.get(sq);
      if (ms.length === 1) play(ms[0]); else showChooser(sq, ms);
      return;
    }
    if (p && (p >> 4) === pos.stm && canMoveFrom(sq)) {
      if (S.sel && S.sel.sq === sq) { clearSel(); return; }
      S.inspect = -1;
      selectSq(sq);
      return;
    }
    S.sel = null; S.targets = new Map();
    setInspect(p && S.inspect !== sq ? sq : -1);
  }
  const canMoveFrom = sq => S.legal.some(m => !K.isDrop(m) && K.mvFrom(m) === sq);
  function setInspect(sq) { S.inspect = sq; renderBoard(); renderPlayers(); renderSqInfo(); }
  // keep: 駒台を描き直さず、選んだ印だけ付け外しする（つかんでいる持ち駒の要素を消さないため）
  function clearSel(keep) { S.sel = null; S.targets = new Map(); S.inspect = -1; renderBoard(); if (keep) markHand(); else renderPlayers(); renderSqInfo(); }
  const markHand = () => document.querySelectorAll('.hp').forEach(b => b.classList.toggle('sel', !!(S.sel && S.sel.hand === Number(b.dataset.hand) && Number(b.dataset.color) === S.pos.stm)));
  function collectTargets(pred) {
    const t = new Map();
    for (const m of S.legal) {
      if (!pred(m)) continue;
      const to = K.mvTo(m);
      if (!t.has(to)) t.set(to, []);
      t.get(to).push(m);
    }
    for (const ms of t.values()) ms.sort((a, b) => K.mvPromo(b) - K.mvPromo(a)); // 成るを先に
    return t;
  }
  function selectSq(sq) { S.sel = { sq }; S.targets = collectTargets(m => !K.isDrop(m) && K.mvFrom(m) === sq); renderBoard(); renderPlayers(); renderSqInfo(); }
  function selectHand(t, keep) {
    S.sel = { hand: t }; S.inspect = -1;
    S.targets = collectTargets(m => K.isDrop(m) && K.mvDrop(m) === t);
    renderBoard(); if (keep) markHand(); else renderPlayers(); renderSqInfo();
  }

  const NAMES = ['', '歩兵', '香車', '桂馬', '銀将', '金将', '角行', '飛車', '玉将', 'と金', '成香', '成桂', '成銀', '量子駒', '竜馬', '竜王'];
  const short = t => K.NAME[t];
  const komaHTML = (t, rot, cls = 'koma', c = 0) => `<span class="${cls}">${PC.koma(t, rot, { king: c ? '王' : '玉' })}</span>`;
  // 盤の駒の絵（量子駒は候補の字を並べた駒）
  function pieceHTML(pos, sq, rot, cls = 'koma', detail = false) {
    const p = pos.board[sq], c = p >> 4;
    if ((p & 15) === QU) return `<span class="${cls}">${PC.qkoma(pos.qs[sq], pos.qp[sq], rot, { king: c ? '王' : '玉', detail })}</span>`;
    return komaHTML(p & 15, rot, cls, c);
  }
  const tName = (t, c, promoted) => (t === 8 ? (c ? '王' : '玉') : K.NAME[promoted ? t + 8 : t]);
  // 候補の字の並び（玉 飛 角 金 銀 桂 香 歩 の順。王の候補は赤）
  function candHTML(m, promoted, c) {
    const ts = [8, 7, 6, 5, 4, 3, 2, 1].filter(t => m & K.bitOf(t));
    return `<span class="qc" aria-label="候補 ${ts.map(t => tName(t, c, promoted)).join('・')}">${ts.map(t => `<i class="${t === 8 ? 'k' : promoted ? 'n' : ''}">${t === 8 ? (c ? '王' : '玉') : PC.CH[promoted ? t + 8 : t]}</i>`).join('')}</span>`;
  }
  function pieceName(pos, sq) {
    const p = pos.board[sq], c = p >> 4;
    if ((p & 15) !== QU) return `${sideName(c)}の${NAMES[p & 15]}`;
    const m = pos.qs[sq];
    return `${sideName(c)}の量子駒${pos.qp[sq] ? '（成）' : ''}（候補 ${K.typesOf(m).reverse().map(t => tName(t, c, pos.qp[sq])).join('・')}）`;
  }
  // 王の候補の数（確定していれば「玉確定」）
  function kcHTML(pos, c) {
    const k = pos.king(c);
    if (k >= 0) return `<span class="kc det${S.kcFlash === c ? ' flash' : ''}" title="${sideName(c)}の${c ? '王' : '玉'}は確定しています（${sqLabel(k)}）">${c ? '王' : '玉'}確定</span>`;
    return `<span class="kc" title="${sideName(c)}の王の候補の駒の数（まだ玉が決まっていない）">王候補${pos.kingCands(c).length}</span>`;
  }
  // まだ正体の決まっていない駒の残り（持ち駒の一覧に出す）
  function poolHTML(pos, c) {
    const n = [1, 2, 3, 4, 5, 6, 7, 8].reduce((a, t) => a + pos.pool[c * 9 + t], 0);
    const k = pos.king(c);
    if (!n) return `<span>量子駒はもうありません（すべての駒の正体が決まりました）</span>`;
    const parts = [8, 7, 6, 5, 4, 3, 2, 1].filter(t => pos.pool[c * 9 + t]).map(t => `${tName(t, c, 0)}${pos.pool[c * 9 + t]}`);
    return `<span>量子駒 <b>${n}枚</b>の残り</span><span>${parts.join(' ')}</span><span>${k >= 0 ? `${c ? '王' : '玉'}は確定（${sqLabel(k)}）` : `王の候補 <b>${pos.kingCands(c).length}枚</b>`}</span>`;
  }

  // ------------------------------------------------------------------ 量子駒の候補の変化（指すたびに）
  function snapQ(pos) { return { board: pos.board.slice(), qs: pos.qs.slice(), qp: pos.qp.slice(), king: [pos.king(0), pos.king(1)] }; }
  // その手で起きたことの短い説明（情報の行・見返しに出す。HTML）
  function noteOf(b, pos, m) {
    const out = [];
    const drop = K.isDrop(m), from = drop ? -1 : K.mvFrom(m), to = K.mvTo(m);
    if (!drop) {
      const p0 = b.board[from], c = p0 >> 4;
      if ((p0 & 15) === QU) {
        const a = pos.board[to], t = a & 15;
        if (t === QU) { if (pos.qs[to] !== b.qs[from]) out.push(`候補 ${candHTML(pos.qs[to], pos.qp[to], c)}`); }
        else out.push(`<b>${t === 8 ? (c ? '王' : '玉') : K.NAME[t]}に確定</b>`);
      }
      if (K.mvMeas(m)) out.push(`取った駒を<b>${K.NAME[K.mvMeas(m)]}</b>と観測`);
    }
    let others = 0;
    for (let sq = 0; sq < 81; sq++) {
      if (sq === from || sq === to || (b.board[sq] & 15) !== QU) continue;
      const p = pos.board[sq];
      if (p && (p & 15) !== QU && (p >> 4) === (b.board[sq] >> 4)) others++;
    }
    if (others) out.push(`つじつまで${others}枚が確定`);
    for (const c of [BLACK, WHITE]) if (b.king[c] < 0 && pos.king(c) >= 0) out.push(`<b style="color:var(--q-king)">${sideName(c)}の${c ? '王' : '玉'}が確定</b>（${sqLabel(pos.king(c))}）`);
    return out.join('・');
  }
  // 動きのための差分: 候補が減った駒・確定した駒・玉の確定
  function qDiff(b, pos, m) {
    const list = [], drop = K.isDrop(m);
    for (let sq = 0; sq < 81; sq++) {
      const p = pos.board[sq];
      if (!p) continue;
      const src = !drop && sq === K.mvTo(m) ? K.mvFrom(m) : sq, p0 = b.board[src];
      if (!p0 || (p0 >> 4) !== (p >> 4) || (p0 & 15) !== QU) continue;
      if ((p & 15) === QU) { if (pos.qs[sq] !== b.qs[src]) list.push({ sq, kind: 'narrow' }); }
      else list.push({ sq, kind: (p & 15) === K.OU ? 'king' : 'det', name: (p & 15) === K.OU ? ((p >> 4) ? '王' : '玉') : K.NAME[p & 15] });
    }
    return { list, kings: [BLACK, WHITE].filter(c => b.king[c] < 0 && pos.king(c) >= 0) };
  }
  function runQfx(fx) {
    if (!fx || !live()) return;
    if (fx.kings.length) { S.kcFlash = fx.kings[0]; renderPlayers(); setTimeout(() => { S.kcFlash = -1; }, 2600); }
    if (!TM || !TM.on) return;
    for (const e of fx.list) {
      const el = sqEl(e.sq), ring = el && el.querySelector('.qfx'), k = el && el.querySelector('.koma');
      if (!ring) continue;
      ring.className = 'qfx';
      void ring.offsetWidth;
      ring.className = `qfx go${e.kind === 'det' ? ' det' : e.kind === 'king' ? ' king' : ''}`;
      if (!k) continue;
      if (e.kind === 'narrow') TM.pop(k, 'land');
      else {
        TM.pop(k, 'glow');
        TM.float(e.kind === 'king' ? `${e.name}が確定！` : `${e.name}に確定`, k, { size: e.kind === 'king' ? 18 : 14, color: e.kind === 'king' ? 'var(--q-king)' : 'var(--gold)', ms: e.kind === 'king' ? 1500 : 1000 });
      }
    }
    if (fx.kings.length) clack('cap');
  }
  // 成る・成らない、取った量子駒の正体（観測）を選ぶ小さなメニュー（マスの横に）
  function showChooser(sq, ms) {
    const pos = S.pos, from = K.mvFrom(ms[0]), p = pos.board[from], t = p & 15, c = p >> 4, rot = c === topColor();
    const promos = [...new Set(ms.map(K.mvPromo))].sort((a, b) => b - a);
    const meases = [...new Set(ms.map(K.mvMeas))].filter(Boolean);
    const box = document.createElement('div');
    box.className = 'choose'; box.id = 'chooser'; box.setAttribute('role', 'menu');
    let promo = promos[0];
    // 動いたあとの自分の駒の絵（量子駒は絞られたあとの候補で）
    const after = pr => {
      if (t !== QU) return komaHTML(pr ? t + 8 : t, rot, 'koma minik', c);
      const nm = pos.narrowed(ms.find(m => K.mvPromo(m) === pr)), P = pr || pos.qp[from];
      if (nm & (nm - 1)) return `<span class="koma minik">${PC.qkoma(nm, P, rot, { king: c ? '王' : '玉' })}</span>`;
      const tt = K.lowType(nm);
      return komaHTML(P && tt !== 8 ? tt + 8 : tt, rot, 'koma minik', c);
    };
    const draw = () => {
      let html = '';
      if (meases.length) {
        html += `<div class="ttl">${sqLabel(sq)}の量子駒を取ります</div>`;
        if (promos.length > 1) html += `<div class="seg2">${promos.map(pr => `<button type="button" data-pr="${pr}" aria-pressed="${pr === promo}">${after(pr)}<span>${pr ? '成る' : '成らない'}</span></button>`).join('')}</div>`;
        html += `<div class="sub">取った駒の正体を決めてください（玉以外の候補から）。その駒があなたの持ち駒になり、相手の残りから1枚消えます</div><div class="types">`;
        for (const T of [7, 6, 5, 4, 3, 2, 1]) if (meases.includes(T)) html += `<button type="button" data-meas="${T}" role="menuitem">${komaHTML(T, false, 'koma minik', c)}<span>${K.NAME[T]}</span></button>`;
        html += '</div>';
      } else {
        html += `<div class="ttl">${sqLabel(sq)}へ　成りますか？</div><div class="opts">`;
        for (const pr of promos) html += `<button type="button" class="${pr ? 'act' : ''}" data-go="${pr}" role="menuitem">${after(pr)}<span>${pr ? '成る' : '成らない'}</span></button>`;
        html += '</div>';
        if (t === QU && promos.includes(1)) html += '<div class="sub">成ると、金と玉は候補から外れます</div>';
      }
      html += '<button type="button" class="quiet" data-q="1">やめる</button>';
      box.innerHTML = html;
    };
    draw();
    box.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.q) { hideChooser(); return; }
      if (b.dataset.pr != null) { promo = Number(b.dataset.pr); draw(); return; }
      let m = 0;
      if (b.dataset.meas) m = ms.find(x => K.mvMeas(x) === Number(b.dataset.meas) && K.mvPromo(x) === promo);
      else if (b.dataset.go != null) m = ms.find(x => K.mvPromo(x) === Number(b.dataset.go));
      if (m) { hideChooser(); play(m); }
    });
    S.pending = sq;
    renderMarks();
    const el = sqEl(sq), wrap = $('board-wrap');
    const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    wrap.appendChild(box);
    let left = r.right - wr.left + 6, top2 = r.top - wr.top - 10;
    if (left + box.offsetWidth > wr.width) left = r.left - wr.left - box.offsetWidth - 6;
    if (left < 0) left = Math.max(0, Math.min(wr.width - box.offsetWidth, r.left - wr.left + r.width / 2 - box.offsetWidth / 2));
    if (top2 + box.offsetHeight > wr.height) top2 = wr.height - box.offsetHeight;
    box.style.left = left + 'px'; box.style.top = Math.max(0, top2) + 'px';
    if (pointerType !== 'touch') box.querySelector('button').focus();
  }
  function hideChooser() {
    const c = $('chooser');
    if (c) c.remove();
    if (S.pending >= 0) { S.pending = -1; renderMarks(); }
  }

  // ------------------------------------------------------------------ 描画
  const sqLabel = sq => FW[9 - (sq % 9)] + KN[((sq / 9) | 0) + 1];
  const sqEl = sq => $('grid').children[S.flip ? 80 - sq : sq];
  const topColor = () => (S.flip ? BLACK : WHITE);

  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    renderPlayers(); renderBoard(); renderControls(); renderKifu(); renderTape(); renderEval(); renderGraph(); renderArrows(); renderSqInfo();
    fitBoardSoon();
  }

  // 盤の大きさ: 盤・駒台・情報の行・ボタンが画面の高さに収まる大きさにする（ページはスクロールしない）
  let fitPending = 0;
  function fitBoardSoon() { if (!fitPending) fitPending = setTimeout(() => { fitPending = 0; fitBoard(); }, 0); }
  function fitBoard() {
    const land = window.innerWidth > window.innerHeight && window.innerHeight < 560 && window.innerWidth >= 560;
    const wide = !land && window.innerWidth >= 1180 && window.innerHeight >= 560;
    document.body.classList.toggle('land', land);
    document.body.classList.toggle('wide', wide);
    const col = document.querySelector('.board-col'), row = document.querySelector('.board-row'), frame = document.querySelector('.board-frame');
    if (!col || !col.offsetParent) return;
    const fcs = getComputedStyle(frame);
    const padV = parseFloat(fcs.paddingTop) + parseFloat(fcs.paddingBottom), padH = parseFloat(fcs.paddingLeft) + parseFloat(fcs.paddingRight);
    const rowExtra = row.getBoundingClientRect().width - frame.getBoundingClientRect().width;
    const ratio = 1.09, top = col.getBoundingClientRect().top;
    let w;
    if (land) {
      const avail = window.innerHeight - top - 8;
      w = (avail - padV - 4) / ratio + padH;
      w = Math.min(w, col.getBoundingClientRect().width - 300);
    } else if (wide) {
      const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
      const foot = document.querySelector('.boardfoot').getBoundingClientRect().height, ctl = document.querySelector('.controls').getBoundingClientRect().height;
      const avail = window.innerHeight - top - foot - ctl - gap * 2 - 12;
      w = (avail - padV - 4) / ratio + padH + rowExtra;
      w = Math.min(w, col.getBoundingClientRect().width - 2 * (158 + 12));
    } else {
      const cs = getComputedStyle(col), gap = parseFloat(cs.rowGap) || 0;
      let other = 0, n = 0;
      for (const el of col.children) {
        if (el === row || getComputedStyle(el).display === 'none') continue;
        other += el.getBoundingClientRect().height; n++;
      }
      const avail = window.innerHeight - top - other - gap * n - 10;
      w = (avail - padV - 4) / ratio + padH + rowExtra;
      w = Math.min(w, col.getBoundingClientRect().width);
    }
    w = Math.round(Math.max(220, Math.min(wide ? 680 : 620, w)));
    const big = (w - padH - rowExtra) / 9 >= 54;
    if (big !== S.bigSq) { S.bigSq = big; renderBoard(); }
    const cur = document.documentElement.style.getPropertyValue('--board-w');
    if (cur !== w + 'px') { document.documentElement.style.setProperty('--board-w', w + 'px'); if ($('side').classList.contains('open')) placeSheet(); }
  }

  function renderPlayers() {
    const pos = shownPos(), tc = topColor();
    [['player-top', tc], ['player-bottom', tc ^ 1]].forEach(([id, c]) => {
      const el = $(id);
      const myTurn = live() && !S.result && pos.stm === c;
      el.classList.toggle('turn', myTurn);
      const can = humanTurn() && pos.stm === c;
      let st = '';
      if (myTurn && isCPU(c) && S.thinking) {
        const ci = S.cpuInfo;
        st = `<span class="think"><i></i>考え中${ci ? `・深さ${ci.depth}` : ''}</span>`;
      } else if (myTurn && isRemote(c)) {
        st = S.online && NET && NET.status === 'on' && !S.online.oppPresent ? '<span class="think" style="color:var(--bad)">接続切れ</span>' : '<span class="think"><i></i>相手の番</span>';
      } else if (S.result && live()) {
        st = S.result.winner === c ? '<span class="think" style="color:var(--good)">勝ち</span>' : S.result.winner === -1 ? '<span class="think">引き分け</span>' : '<span class="think" style="color:var(--muted)">負け</span>';
      }
      let hand = '';
      for (const t of [K.HI, K.KA, K.KI, K.GI, K.KE, K.KY, K.FU]) {
        const n = pos.handCount(c, t);
        if (!n) continue;
        const sel = live() && S.sel && S.sel.hand === t && pos.stm === c;
        const usable = can && S.legal.some(m => K.isDrop(m) && K.mvDrop(m) === t);
        // 打てない持ち駒も押せる（押すと両者の持ち駒の一覧が開く）
        hand += `<button class="hp${sel ? ' sel' : ''}${usable ? '' : ' off'}" data-hand="${t}" data-color="${c}"${usable ? '' : ' aria-disabled="true"'} aria-label="${sideName(c)}の持ち駒 ${NAMES[t]} ${n}枚" title="${NAMES[t]}">${komaHTML(t, c === tc, 'koma', c)}${n > 1 ? `<span class="n">${n}</span>` : ''}</button>`;
      }
      const on = S.online;
      const nm = on ? (c === on.myColor ? 'あなた' : esc(on.opp.name)) : sideName(c);
      const tag = on ? aiTagHTML(c === on.myColor ? aiFlags() : on.opp.ai, c === on.myColor ? on.myHints : on.opp.hints) : '';
      el.innerHTML = `
        <div class="id"><svg class="mark${c ? ' g' : ''}" viewBox="0 0 100 100" aria-hidden="true"><path d="${PC.SHAPE}"/></svg><span class="name">${MARK[c]}${nm}</span>${kcHTML(pos, c)}<span class="sub">${on ? sideName(c) : seatLabel(c)}</span>${tag}</div>
        <div class="hand" aria-label="${sideName(c)}の持ち駒（押すと一覧）">${hand || '<span class="empty-note">持ち駒なし</span>'}</div>
        <div class="st">${st}</div>`;
      const selEl = el.querySelector('.hp.sel');
      if (selEl) { const hd = el.querySelector('.hand'); if (selEl.offsetLeft < hd.scrollLeft || selEl.offsetLeft + selEl.offsetWidth > hd.scrollLeft + hd.clientWidth) hd.scrollLeft = selEl.offsetLeft - 8; }
    });
  }

  function renderBoard() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length < 81) {
      grid.innerHTML = '';
      for (let i = 0; i < 81; i++) {
        const b = document.createElement('button');
        b.className = 'sq';
        b.innerHTML = '<span class="tint"></span><span class="pc"></span><span class="qfx"></span><span class="mark"></span>';
        b.addEventListener('click', e => { e.stopPropagation(); onSquare(Number(b.dataset.sq)); });
        b.addEventListener('mouseenter', () => { if (pointerType === 'mouse') onHover(Number(b.dataset.sq)); });
        b.addEventListener('mouseleave', () => { if (S.hover >= 0) onHover(-1); });
        b.addEventListener('focus', () => { if (b.matches(':focus-visible')) onHover(Number(b.dataset.sq)); });
        b.addEventListener('blur', () => { if (S.hover >= 0) onHover(-1); });
        grid.appendChild(b);
      }
      for (const [x, y] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
        const s = document.createElement('span');
        s.className = 'star'; s.style.left = (x / 9 * 100) + '%'; s.style.top = (y / 9 * 100) + '%';
        grid.appendChild(s);
      }
    }
    const tc = topColor();
    const lm = live() ? S.moves[S.moves.length - 1] : (S.view ? S.moves[S.view - 1] : 0);
    const lastTo = lm && lm !== DECLARE ? K.mvTo(lm) : -1, lastFrom = lm && lm !== DECLARE && !K.isDrop(lm) ? K.mvFrom(lm) : -1;
    const checkSq = pos.inCheck() ? pos.king(pos.stm) : -1;
    const detail = settings.detail || S.bigSq;
    for (let i = 0; i < 81; i++) {
      const sq = S.flip ? 80 - i : i, b = grid.children[i];
      b.dataset.sq = sq;
      let cls = 'sq';
      if (sq === lastTo) cls += ' last'; else if (sq === lastFrom) cls += ' from';
      if (live() && S.sel && S.sel.sq === sq) cls += ' selected';
      if (S.inspect === sq) cls += ' inspect';
      if (sq === checkSq) cls += ' check';
      b.className = cls;
      const p = pos.board[sq], q = (p & 15) === QU, key = p + '|' + tc + (q ? `|${pos.qs[sq]}|${pos.qp[sq]}|${detail ? 1 : 0}` : ''), pc = b.children[1];
      if (pc.dataset.key !== key) {
        pc.dataset.key = key;
        pc.innerHTML = p ? pieceHTML(pos, sq, (p >> 4) === tc, 'koma', detail) : '';
        b.setAttribute('aria-label', `${sqLabel(sq)} ${p ? pieceName(pos, sq) : '空き'}`);
      }
    }
    renderMarks();
    const cols = [], rows = [];
    for (let i = 0; i < 9; i++) { cols.push(`<span>${S.flip ? FW[i + 1] : FW[9 - i]}</span>`); rows.push(`<span>${S.flip ? KN[9 - i] : KN[i + 1]}</span>`); }
    $('coords-top').innerHTML = cols.join('');
    $('coords-right').innerHTML = rows.join('');
  }

  // マスの塗り（駒の下）と印（駒の上）。選んだ駒の行き先: 空きは点・取るは赤い枠。利きを見ている駒: 利きのマスを赤く
  function renderMarks() {
    const pos = shownPos(), grid = $('grid');
    if (grid.children.length < 81) return;
    let preview = null, reach = null;
    if (S.inspect >= 0 && pos.board[S.inspect]) reach = new Set(pos.reach(S.inspect));
    else if (settings.reach && !S.sel) {
      if (S.hoverHand && humanTurn()) preview = new Set(S.legal.filter(m => K.isDrop(m) && K.mvDrop(m) === S.hoverHand).map(K.mvTo));
      else if (S.hover >= 0 && pos.board[S.hover]) {
        const p = pos.board[S.hover];
        if (humanTurn() && (p >> 4) === pos.stm && canMoveFrom(S.hover)) preview = new Set(S.legal.filter(m => !K.isDrop(m) && K.mvFrom(m) === S.hover).map(K.mvTo));
        else reach = new Set(pos.reach(S.hover));
      }
    }
    let focus = null;
    if (live() && S.sel && S.targets.size) focus = S.targets;
    else if (S.inspect >= 0 && reach) focus = reach;
    const keep = live() && S.sel && S.sel.sq != null ? S.sel.sq : S.inspect;
    for (let i = 0; i < 81; i++) {
      const sq = S.flip ? 80 - i : i, el = grid.children[i], tint = el.firstChild, mk = el.lastChild;
      let tcl = 'tint', mc = 'mark';
      if (live() && S.targets.has(sq)) mc += pos.board[sq] ? ' cap' : ' move';
      else if (preview && preview.has(sq)) tcl += ' prev';
      else if (reach && reach.has(sq)) { tcl += ' reach'; if (pos.board[sq]) mc += ' ring'; }
      if (focus && !focus.has(sq) && sq !== keep) mc += ' dim';
      if (sq === S.pending) mc += ' pending';
      if (tint.className !== tcl) tint.className = tcl;
      if (mk.className !== mc) mk.className = mc;
    }
  }
  function onHover(sq) { S.hover = sq; renderMarks(); renderSqInfo(); }

  // 盤の下の情報の行
  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  function pieceTitle(pos, sq) { const p = pos.board[sq]; return `${sqLabel(sq)}の${sideName(p >> 4)}の${(p & 15) === QU ? (pos.qp[sq] ? '成った量子駒' : '量子駒') : NAMES[p & 15]}`; }
  const miniSq = (pos, sq) => pieceHTML(pos, sq, (pos.board[sq] >> 4) === topColor(), 'koma minik', false);
  function renderSqInfo() {
    const el = $('sqinfo'), pos = shownPos();
    if (!el) return;
    let html = '', tools = '', cls = 'sqinfo';
    const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
    const c = pos.stm;
    const x = `<button class="ibtn" data-act="desel" aria-label="選択を解除" title="選択を解除">${CLOSE}</button>`;
    const qinfo = sq => ((pos.board[sq] & 15) === QU ? ' ' + candHTML(pos.qs[sq], pos.qp[sq], pos.board[sq] >> 4) : '');
    if (live() && S.sel && S.sel.sq != null) {
      let cap = 0; S.targets.forEach((ms, to) => { if (pos.board[to]) cap++; });
      html = `${miniSq(pos, S.sel.sq)}<span class="txt"><b>${pieceTitle(pos, S.sel.sq)}</b>${qinfo(S.sel.sq)}　<span class="muted">行き先${S.targets.size}${cap ? `・取る${cap}` : ''}</span></span>`;
      tools = x;
    } else if (live() && S.sel && S.sel.hand) {
      html = `${komaHTML(S.sel.hand, c === topColor(), 'koma minik', c)}<span class="txt"><b>${NAMES[S.sel.hand]}</b>を打つマスを選んでください</span>`;
      tools = x;
    } else if (S.inspect >= 0 && pos.board[S.inspect]) {
      html = `${miniSq(pos, S.inspect)}<span class="txt"><b>${pieceTitle(pos, S.inspect)}</b>${qinfo(S.inspect)} の利き</span>`;
      tools = `<button class="ibtn" data-act="desel" aria-label="利きの表示を消す" title="利きの表示を消す">${CLOSE}</button>`;
    } else if (S.hover >= 0 && pos.board[S.hover]) {
      html = `${miniSq(pos, S.hover)}<span class="txt"><b>${pieceTitle(pos, S.hover)}</b>${qinfo(S.hover)}</span>`;
    } else if (!live()) {
      cls += ' view';
      const t = S.texts[S.view - 1];
      const nt = S.notes[S.view - 1];
      html = `<span class="txt"><b>${S.view}手目</b>${t ? ` ${t}` : '（開始局面）'}${nt ? `　<span class="muted">${nt}</span>` : ''}</span>`;
      tools = btn('branch', 'ここから指す') + btn('live', '最新へ', ' primary');
    } else if (S.result && S.online) {
      cls += ' result';
      const r = S.result, o = S.online, nm = esc(o.opp.name);
      const head = r.winner === -1 ? '引き分け' : r.winner === o.myColor ? 'あなたの勝ち' : `${nm}さんの勝ち`;
      if (o.oppRe && !o.myRe) { html = `<span class="txt"><b>${nm}さんがもう一局を希望</b>（先後を交代）</span>`; tools = btn('rematch', '受ける', ' primary') + btn('lobby', 'ロビーへ'); }
      else if (o.myRe) { html = `<span class="txt"><b>${head}</b>　もう一局の返事を待っています…</span>`; tools = btn('lobby', 'ロビーへ'); }
      else { html = `<span class="txt"><b>${head}</b>（${esc(r.reason)}）</span>`; tools = btn('rematch', 'もう一局', ' primary') + btn('lobby', 'ロビーへ'); }
    } else if (S.result) {
      cls += ' result';
      const r = S.result;
      html = `<span class="txt"><b>${r.winner === -1 ? '引き分け' : sideName(r.winner) + 'の勝ち'}</b>（${esc(r.reason)}）</span>`;
      tools = btn('review', '振り返る') + btn('again', 'もう一局', ' primary');
    } else if (S.online && NET && NET.status !== 'on') {
      cls += ' alert';
      html = `<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>`;
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' alert';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (pos.inCheck()) {
      cls += ' alert';
      html = `<span class="txt">王手：${sideName(c)}の${c ? '王' : '玉'}が狙われています</span>`;
    } else if (S.online && isRemote(c)) {
      html = `<span class="txt"><b>${esc(S.online.opp.name)}さん</b>の番です　<span class="muted">${S.texts.length ? `直前 ${S.texts[S.texts.length - 1]}` : ''}</span></span>`;
    } else {
      const ply = shownPly(), t = S.texts[ply - 1], note = S.notes[ply - 1];
      html = `<span class="txt muted">${ply ? `${ply}手目 <b style="color:var(--ink)">${t}</b>${note ? `　${note}` : ''}` : 'どの駒もまだ正体不明'}${!note && ply < 2 && humanTurn() ? '　タップで行き先・候補' : ''}</span>`;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }

  function renderTape() {
    const el = $('tape');
    if (!el) return;
    const cur = shownPly();
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">開始</button>`;
    S.texts.forEach((t, i) => {
      const bad = badMove(i);
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}${bad ? ' bad' : ''}"><span class="no">${i + 1}</span>${t}${bad ? '?' : ''}</button>`;
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
  // 指した側から見て勝率が大きく下がった手
  function badMove(i) {
    if (!settings.showEval) return false;
    const s2 = S.evals[i + 1], prev = S.evals[i];
    if (s2 == null || prev == null) return false;
    const mover = S.texts[i].startsWith('▲') ? BLACK : WHITE;
    return (K.winRate(s2) - K.winRate(prev)) * (mover === BLACK ? 1 : -1) < -0.15;
  }

  // 最善手の矢印（打つ手は点線の輪と「打」、成る手は「成」）
  function renderArrows() {
    const wrapEl = $('grid');
    let svg = $('arrows');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'arrows'; svg.setAttribute('class', 'arrows'); svg.setAttribute('viewBox', '0 0 900 981'); svg.setAttribute('preserveAspectRatio', 'none');
      wrapEl.appendChild(svg);
    }
    const info = S.info, pos = shownPos();
    const ok = info && info.kind !== 'cpu' && (info.kind === 'hint' || settings.arrow) && info.ply === shownPly() && info.pv && info.pv.length && !(live() && S.result);
    if (!ok) { svg.innerHTML = ''; return; }
    const m = info.pv[0];
    if (m === DECLARE || !pos.isLegal(m)) { svg.innerHTML = ''; return; }
    const cxy = sq => { const i = S.flip ? 80 - sq : sq; return [(i % 9) * 100 + 50, ((i / 9) | 0) * 109 + 54.5]; };
    const [tx, ty] = cxy(K.mvTo(m));
    const drop = K.isDrop(m), cap = !drop && pos.board[K.mvTo(m)];
    const col = cap ? '#c8321e' : '#2e8c50';
    const label = drop ? `打・${K.NAME[K.mvDrop(m)]}` : [K.mvPromo(m) ? '成' : '', K.mvMeas(m) ? `取→${K.NAME[K.mvMeas(m)]}` : ''].filter(Boolean).join('・');
    let html = `<defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker></defs>`;
    if (drop) html += `<ellipse cx="${tx}" cy="${ty}" rx="42" ry="46" fill="none" stroke="${col}" stroke-width="6" stroke-dasharray="10 7" opacity=".95"/>`;
    else {
      const [fx, fy] = cxy(K.mvFrom(m));
      const dx = tx - fx, dy = ty - fy, L = Math.hypot(dx, dy) || 1;
      const ex = tx - dx / L * 28, ey = ty - dy / L * 28;
      html += `<line x1="${fx}" y1="${fy}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-opacity=".85" stroke-width="15" stroke-linecap="round" marker-end="url(#ah)"/>`;
    }
    if (label) {
      const w = 26 + label.length * 26, h = 38;
      let bx = Math.max(4, Math.min(896 - w, tx - w / 2)), by = ty - 56 - h;
      if (by < 2) by = ty + 56;
      html += `<g><rect x="${bx}" y="${by}" width="${w}" height="${h}" rx="19" fill="${col}"/><text x="${bx + w / 2}" y="${by + 27}" text-anchor="middle" fill="#fff" style="font:700 25px var(--font-body)">${label}</text></g>`;
    }
    svg.innerHTML = html;
  }

  function renderControls() {
    const pos = S.pos;
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-undo').disabled = !S.moves.length || !!S.online;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    $('btn-resign').disabled = !live() || !!S.result || !humans.length;
    $('btn-hint').disabled = !humanTurn();
    $('viewing').hidden = live();
    if (!live()) $('viewing-text').textContent = `${S.view}手目を表示中`;
    $('kifu-info').textContent = `${S.moves.length}手`;
    void pos;
  }

  function fmtScore(s) {
    if (K.isMate(s)) { const n = K.MATE - Math.abs(s); return `${sideName(s > 0 ? BLACK : WHITE)}勝ち（${n}手で詰み）`; }
    return (s > 0 ? '+' : s < 0 ? '−' : '±') + Math.abs(Math.round(s));
  }
  function renderEval() {
    const ply = shownPly(), pos = shownPos();
    const info = S.info && S.info.ply === ply ? S.info : null;
    const sB = info ? info.scoreB : S.evals[ply];
    const num = $('ev-num'), lbl = $('ev-label');
    $('ev-who').textContent = info ? (info.kind === 'cpu' ? `${seatLabel(info.stm)}の読み` : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    $('graph-who').textContent = `${sideName(BLACK)}の勝率`;
    const strip = (n, l, best, more) => {
      $('evs-num').textContent = n; $('evs-lbl').textContent = l; $('evs-best').textContent = best;
      $('evs-more').innerHTML = more; $('evs-more').hidden = !S.evOpen || !more;
    };
    if (sB == null) {
      num.textContent = '—';
      lbl.textContent = pos.result() ? '' : (settings.analyze || S.thinking) ? '読んでいます…' : '「ヒント」で読みます';
      setWR(0.5); $('pv').innerHTML = ''; $('ev-meta').textContent = '';
      strip('—', lbl.textContent, '', '');
      return;
    }
    if (K.isMate(sB)) { num.textContent = '詰'; lbl.textContent = fmtScore(sB); }
    else {
      num.textContent = fmtScore(sB);
      const a = Math.abs(sB);
      lbl.textContent = a < 250 ? '互角' : sideName(sB > 0 ? BLACK : WHITE) + (a < 800 ? 'やや有利' : a < 2000 ? '有利' : a < 4000 ? '優勢' : '勝勢');
    }
    setWR(K.winRate(sB));
    let best = '', more = '';
    if (info) {
      const p = Position.fromMoves(S.handicap, S.moves.slice(0, ply));
      const txt = [];
      for (const m of info.pv.slice(0, 12)) {
        if (!p.isLegal(m)) break;
        txt.push(p.moveText(m));
        if (m === DECLARE) break;
        p.make(m);
      }
      $('pv').innerHTML = txt.length ? `<span class="k">読み筋</span><span class="best">${txt[0]}</span> ${txt.slice(1).join(' ')}` : '';
      const nps = info.time ? Math.round(info.nodes / info.time * 1000) : 0;
      $('ev-meta').textContent = `深さ ${info.depth} ・ ${info.nodes.toLocaleString()} 局面 ・ ${(info.time / 1000).toFixed(1)}秒 ・ ${nps.toLocaleString()} 局面/秒`;
      if (txt.length && info.kind !== 'cpu') best = `${info.kind === 'hint' ? 'ヒント' : '最善'} ${txt[0]}`;
      if (txt.length) more = `${$('pv').innerHTML}<div class="meta">${$('ev-meta').textContent}</div>`;
    } else { $('pv').innerHTML = ''; $('ev-meta').textContent = ''; }
    strip(num.textContent, lbl.textContent, best, more);
  }
  function setWR(p) {
    $('wr-b').style.width = (p * 100).toFixed(1) + '%';
    $('evs-b').style.width = (p * 100).toFixed(1) + '%';
    $('wr-bt').textContent = `${sideName(BLACK)} ${(p * 100).toFixed(1)}%`;
    $('wr-wt').textContent = `${sideName(WHITE)} ${(100 - p * 100).toFixed(1)}%`;
    const bar = $('evalbar'), fill = $('evalbar-fill');
    bar.classList.toggle('flip', S.flip);
    fill.style.height = (p * 100).toFixed(1) + '%';
  }
  function renderGraph() {
    const svg = $('graph'), Wd = 300, H = 130, n = Math.max(S.moves.length, 60);
    const x = i => (i / n) * Wd, y = p => (1 - p) * (H - 14) + 7;
    const pts = [];
    for (let i = 0; i <= S.moves.length; i++) { const s = S.evals[i]; if (s != null) pts.push([x(i), y(K.winRate(s))]); }
    let html = `<line class="axis" x1="0" y1="${H - 0.5}" x2="${Wd}" y2="${H - 0.5}"/><line class="mid" x1="0" y1="${y(0.5)}" x2="${Wd}" y2="${y(0.5)}"/>`;
    html += `<text x="3" y="13">${sideName(BLACK)}</text><text x="3" y="${H - 4}">${sideName(WHITE)}</text>`;
    if (pts.length) {
      const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      html += `<polygon class="areab" points="${pts[0][0].toFixed(1)},${y(0.5)} ${line} ${pts[pts.length - 1][0].toFixed(1)},${y(0.5)}"/><polyline class="lineb" points="${line}"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    const cs = S.evals[shownPly()];
    if (cs != null) html += `<circle class="dot" cx="${cx}" cy="${y(K.winRate(cs))}" r="3.5"/>`;
    svg.innerHTML = html;
  }
  function renderKifu() {
    const el = $('kifu'), cur = shownPly();
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>${handi() ? `${HANDICAPS[S.handicap].name}` : '開始局面'}</span><span class="ev"></span></li>`];
    S.texts.forEach((t, i) => {
      const s = S.evals[i + 1];
      let ev = '';
      if (s != null && settings.showEval) ev = K.isMate(s) ? '詰' : (s > 0 ? '+' : '') + Math.round(s);
      const bad = badMove(i);
      rows.push(`<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span>${t}${bad ? ' ?' : ''}</span><span class="ev${bad ? ' bad' : ''}">${ev}</span></li>`);
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

  // ------------------------------------------------------------------ 動き（common/motion.js の TTMotion）
  // 指す直前に、動く駒と取られる駒の場所を覚えておき、描き直したあとで新しい場所へ滑らせる（人も CPU も同じ速さ）。
  // 取った駒は駒台へ山なりに飛ぶ。成ったら着いたところで光って「成」。読みやオンラインの同期は動きを待たない
  const unpromote = t => (t > 8 ? t - 8 : t);
  function animOrigin(m) {
    const at = S.dropAt;
    S.dropAt = null;
    if (!TM || !TM.on || m === DECLARE || !live()) return null;
    const pos = S.pos, to = K.mvTo(m);
    let rect = at; // つかんで置いたときは、離したところから吸い付かせる
    if (!rect) {
      const el = K.isDrop(m) ? document.querySelector(`.hp[data-hand="${K.mvDrop(m)}"][data-color="${pos.stm}"] .koma`) : sqEl(K.mvFrom(m)).querySelector('.koma');
      if (el) rect = el.getBoundingClientRect();
    }
    const cp = K.isDrop(m) ? 0 : pos.board[to], ce = cp ? sqEl(to).querySelector('.koma') : null;
    const meas = cp && (cp & 15) === QU ? K.mvMeas(m) : 0;
    return { rect, to, promo: !K.isDrop(m) && !!K.mvPromo(m), cap: ce ? { t: meas || unpromote(cp & 15), c: pos.stm, rect: ce.getBoundingClientRect(), meas } : null };
  }
  function runAnim(a, kind) {
    const el = sqEl(a.to).querySelector('.koma');
    TM.fly(el, a.rect).then(() => {
      if (kind) clack(kind);
      if (a.promo && el && el.isConnected) { TM.pop(el, 'glow'); TM.float('成', el, { size: 16, color: 'var(--shu)', ms: 800 }); }
    });
    if (a.cap) {
      const h = document.querySelector(`.hp[data-hand="${a.cap.t}"][data-color="${a.cap.c}"] .koma`);
      if (h) Promise.resolve(TM.fly(h, a.cap.rect, { arc: true, delay: 80 })).then(() => {
        if (a.cap.meas && h.isConnected) { TM.pop(h, 'glow'); TM.float(`${K.NAME[a.cap.meas]}と観測`, h, { size: 14, color: 'var(--q-edge)', ms: 1200 }); }
      });
    }
  }

  // つかんで置く（TTMotion.drag）。少し動かすとつかみ、タップで選んだときと同じく行き先が光る。タップ → タップ もそのまま使える
  function bindMotion() {
    if (!TM) return;
    // 動いている途中に触ったら、今の動きをその場で終わらせる（次の操作を待たせない）
    $('view-play').addEventListener('pointerdown', () => TM.finish(), true);
    const onSq = (x, y) => { const h = document.elementFromPoint(x, y), b = h && h.closest('#grid .sq'); return b && S.targets.has(Number(b.dataset.sq)) ? b : null; };
    const drop = (to, at) => {
      const sq = Number(to.dataset.sq), ms = S.targets.get(sq);
      if (!ms || !humanTurn()) return false;
      if (ms.length === 1) { S.dropAt = at; play(ms[0]); } else showChooser(sq, ms);
      return true;
    };
    TM.drag($('grid'), {
      pick: t => {
        const b = t.closest('.sq');
        if (!b || !humanTurn()) return null;
        const sq = Number(b.dataset.sq), p = S.pos.board[sq];
        return p && (p >> 4) === S.pos.stm && canMoveFrom(sq) ? b.querySelector('.koma') : null;
      },
      start: el => { hideChooser(); const sq = Number(el.closest('.sq').dataset.sq); if (!S.sel || S.sel.sq !== sq) selectSq(sq); },
      target: onSq,
      drop: (el, to, at) => drop(to, at),
      cancel: () => clearSel(),
    });
    for (const id of ['player-top', 'player-bottom']) {
      TM.drag($(id), {
        pick: t => {
          const hp = t.closest('.hp');
          return hp && humanTurn() && !hp.classList.contains('off') && Number(hp.dataset.color) === S.pos.stm ? hp.querySelector('.koma') : null;
        },
        start: el => { hideChooser(); const t = Number(el.closest('.hp').dataset.hand); if (!S.sel || S.sel.hand !== t) selectHand(t, true); },
        target: onSq,
        drop: (el, to, at) => drop(to, at),
        cancel: () => clearSel(true),
      });
    }
    // 長押しで大きく見る（盤の駒・両者の持ち駒・一覧の駒）。離すと閉じる
    const big = el => {
      const r = el.getBoundingClientRect(), d = document.createElement('div'), b = el.closest('.sq'), hp = el.closest('[data-hand]');
      let cap = '';
      let inner = el.innerHTML;
      if (b) {
        const sq = Number(b.dataset.sq), pos = shownPos(), p = pos.board[sq];
        if (p && (p & 15) === QU) {
          const n = K.popcnt(pos.qs[sq]);
          cap = `${sideName(p >> 4)}の量子駒・候補${n}つ${pos.qs[sq] & K.OUBIT ? '（王の候補）' : ''}`;
          inner = PC.qkoma(pos.qs[sq], pos.qp[sq], (p >> 4) === topColor(), { king: p >> 4 ? '王' : '玉', detail: true });
        } else if (p) cap = `${sideName(p >> 4)}の${NAMES[p & 15]}`;
      }
      else if (hp) { const c = Number(hp.dataset.color), t = Number(hp.dataset.hand); cap = `${sideName(c)}の持ち駒 ${NAMES[t]} ${shownPos().handCount(c, t)}枚`; }
      d.className = 'peek-koma';
      d.style.width = r.width + 'px';
      d.innerHTML = `<span class="koma" style="width:${r.width}px;height:${r.height}px">${inner}</span>${cap ? `<span class="cap" style="font-size:${Math.max(3, r.width / 6.5).toFixed(1)}px">${esc(cap)}</span>` : ''}`;
      return d;
    };
    const kOf = t => { const x = t.closest('.sq, .hp, .hd-p'); return x && x.querySelector('.koma'); };
    for (const id of ['grid', 'player-top', 'player-bottom', 'hd-body']) TM.peek($(id), { pick: kOf, show: big, scale: 6 });
  }

  // 両者の持ち駒の一覧（駒台を押すと大きく開く。打てる駒は今までどおり押すと選ぶ）
  function openHands() {
    const pos = shownPos(), tc = topColor();
    let html = '';
    for (const c of [tc, tc ^ 1]) {
      let items = '', total = 0;
      for (const t of [K.HI, K.KA, K.KI, K.GI, K.KE, K.KY, K.FU]) {
        const n = pos.handCount(c, t);
        if (!n) continue;
        total += n;
        items += `<div class="hd-p" data-hand="${t}" data-color="${c}">${komaHTML(t, false, 'koma', c)}<b>${NAMES[t]}</b><span>${n}枚</span></div>`;
      }
      html += `<div class="hd-side"><div class="hd-head">${MARK[c]}${sideName(c)}（${S.online ? (c === S.online.myColor ? 'あなた' : esc(S.online.opp.name) + 'さん') : seatLabel(c)}）<span>${total ? `持ち駒${total}枚` : ''}</span></div><div class="hd-list">${items || '<span class="empty-note">持ち駒なし</span>'}</div><div class="hd-pool">${poolHTML(pos, c)}</div></div>`;
    }
    $('hd-body').innerHTML = html;
    $('dlg-hands').hidden = false;
    $('hd-close').focus();
  }

  // ------------------------------------------------------------------ 棋譜・操作
  function viewPly(p) {
    hideChooser();
    if (p >= S.moves.length) { S.view = null; S.dpos = null; }
    else { S.view = Math.max(0, p); S.dpos = Position.fromMoves(S.handicap, S.moves.slice(0, S.view)); }
    S.sel = null; S.targets = new Map(); S.info = null; S.inspect = -1;
    render();
    // 見返している間に終わった対局（オンラインで相手が詰ませた・投了した）は、最新の局面に戻ったときに結果を出す
    if (live() && S.result && !S.resultShown) { S.resultShown = true; setTimeout(showResult, 450); }
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }
  function undo() {
    if (!S.moves.length || S.online) return;
    AI.cancel(); clearTimeout(S.timer);
    S.view = null; S.dpos = null;
    let n = S.moves.length - 1;
    if ([BLACK, WHITE].some(c => isHuman(c))) {
      while (n > 0 && isCPU(Position.fromMoves(S.handicap, S.moves.slice(0, n)).stm)) n--;
      if (n === 0 && isCPU(Position.initial(S.handicap).stm)) { rebuild(0); afterChange(); return; }
    }
    rebuild(n);
    afterChange();
  }
  function resign() {
    if (!live() || S.result) return;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    const loser = humans.includes(S.pos.stm) ? S.pos.stm : humans[0];
    AI.cancel(); clearTimeout(S.timer);
    S.result = { winner: loser ^ 1, reason: `${sideName(loser)}の投了` };
    if (S.online && NET) { NET.send({ t: 'resign' }); NET.saveState({ k: 'st', moves: S.moves, r: 1 }); }
    afterChange();
  }
  const kifNames = () => [0, 1].map(c => (S.online ? (c === S.online.myColor ? myName : S.online.opp.name) : isCPU(c) ? `CPU（${CPU[S.seats[c]].label}）` : (S.seats[c ^ 1] !== 'human' ? 'あなた' : '')));
  const kifText = () => K.toKIF({ handicap: S.handicap, moves: S.moves, names: kifNames(), result: S.result });
  function importKifu(text) {
    const k = K.parseKIF(text);
    if (!k.moves.length && !/手合割|[▲△]|^\s*\d+\s/m.test(text)) throw new Error('棋譜が見つかりません');
    loadGame({ handicap: k.handicap, seats: ['human', 'human'], moves: k.moves, result: k.result });
    viewPly(0);
  }
  function downloadKif() {
    const d = new Date(), z = v => String(v).padStart(2, '0');
    const name = `kansoku-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.kif`;
    const url = URL.createObjectURL(new Blob([kifText()], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ------------------------------------------------------------------ ダイアログ
  let draft = null;
  function openNew() { draft = Object.assign({}, cfg); drawNew(); $('dlg-new').hidden = false; $('ng-start').focus(); S.paused = true; schedule(); }
  // 「やめる」などで閉じる: 止めていた対局を続ける
  function closeNew() { $('dlg-new').hidden = true; if (S.paused) { S.paused = false; schedule(); } }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${val === v}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['pvp', 'ふたりで対局'], ['watch', 'CPUどうしを観戦'], ['online', 'オンライン対戦']], draft.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(CPU_KEYS.length - CPU[k].stars)}</span><b>${CPU[k].label}</b>${CPU[k].time ? `<span class="tm">1手 約${CPU[k].time / 1000}秒</span>` : ''}<small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-side', [['black', '先手（先に指す）'], ['white', '後手'], ['random', 'ランダム']], draft.side);
    seg('ng-cpu-b', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuB);
    seg('ng-cpu-w', CPU_KEYS.map(k => [k, CPU[k].label]), draft.cpuW);
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-side-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
  }
  function showResult() {
    const r = S.result;
    if (!r) return;
    const humans = [BLACK, WHITE].filter(c => isHuman(c));
    let title = r.winner === -1 ? '引き分け' : `${sideName(r.winner)}の勝ち`;
    if (humans.length === 1 && r.winner !== -1) title = r.winner === humans[0] ? 'あなたの勝ち' : 'あなたの負け';
    $('rs-sub').textContent = `${HANDICAPS[S.handicap].name}・${S.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = title;
    const opp = S.online ? `相手は ${S.online.opp.name} さん（${aiText(S.online.opp.ai)}${S.online.opp.hints ? `・ヒント${S.online.opp.hints}回` : ''}）でした。`
      : humans.length === 1 ? `相手は CPU（${CPU[S.seats[humans[0] ^ 1]].label}）でした。` : '';
    $('rs-body').textContent = `${r.reason}。${opp}`;
    $('rs-again').textContent = S.online ? 'もう一局（先後交代）' : 'もう一局';
    // 共通のごほうび（common/juice.js）: 人ひとりと CPU、またはオンラインの対局だけ
    const me = S.online ? S.online.myColor : humans.length === 1 ? humans[0] : -1;
    if (window.TTJuice && me >= 0) TTJuice.result({ outcome: r.winner === -1 ? 'draw' : r.winner === me ? 'win' : 'lose', stars: S.online ? 0 : CPU[S.seats[me ^ 1]].stars, online: !!S.online, ref: r, id: S.gid });
    if (!$('dlg-new').hidden) return; // オンラインの途中で「新しい対局」を押して投了したとき: 選ぶ画面の上に結果を重ねない
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  const MOVES = { // 先手から見た動き: [dx, dy, どこまでも]
    1: [[0, -1]], 2: [[0, -1, 1]], 3: [[-1, -2, 0, 1], [1, -2, 0, 1]], 4: [[0, -1], [-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1]],
    6: [[1, 1, 1], [1, -1, 1], [-1, 1, 1], [-1, -1, 1]], 7: [[0, 1, 1], [0, -1, 1], [1, 0, 1], [-1, 0, 1]], 8: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]],
    14: [[1, 1, 1], [1, -1, 1], [-1, 1, 1], [-1, -1, 1], [0, 1], [0, -1], [1, 0], [-1, 0]], 15: [[0, 1, 1], [0, -1, 1], [1, 0, 1], [-1, 0, 1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
  };
  [9, 10, 11, 12].forEach(t => { MOVES[t] = MOVES[5]; });
  const MOVE_TEXT = ['', '前に1マス。成ると「と金」（金と同じ動き）', '前にどこまでも。成ると「成香」（金と同じ動き）', '前へ2マス先の左右に跳ぶ（間の駒を飛び越える）。成ると「成桂」', '前・斜め4方向に1マス。成ると「成銀」（金と同じ動き）',
    '前・横・斜め前・後ろに1マス。成れない', '斜めにどこまでも。成ると「竜馬」（縦横に1マスも動ける）', '縦横にどこまでも。成ると「竜王」（斜めに1マスも動ける）', '全方向に1マス。確定してから詰まされたら負け（成れない）',
    '金と同じ動き', '金と同じ動き', '金と同じ動き', '金と同じ動き', '', '斜めにどこまでも＋縦横に1マス', '縦横にどこまでも＋斜めに1マス'];
  function diagram(t) {
    const cells = new Array(81).fill(''), cx = 4, cy = 4;
    for (const [dx, dy, slide, jump] of MOVES[t]) {
      for (let i = 1; i <= (slide ? 8 : 1); i++) {
        const x = cx + dx * i, y = cy + dy * i;
        if (x < 0 || x > 8 || y < 0 || y > 8) break;
        cells[y * 9 + x] = jump ? 'j' : slide ? 'r' : 'm';
      }
    }
    return cells.map((c, i) => (i === cy * 9 + cx ? `<i class="c">${komaHTML(t, false)}</i>` : `<i class="${c}"></i>`)).join('');
  }
  const PIECE_ORDER = [8, 7, 6, 5, 4, 3, 2, 1, 15, 14, 12, 11, 10, 9];
  function renderRules() {
    const chips = PIECE_ORDER.map(t => `<button type="button" data-t="${t}" aria-pressed="${t === 8}" title="${NAMES[t]}">${komaHTML(t, false)}</button>`).join('');
    const ex = (m, label) => `<span style="display:inline-flex;align-items:center;gap:6px;margin:2px 10px 2px 0"><span class="koma" style="display:inline-block;width:44px;height:48px">${PC.qkoma(m, 0, false, { detail: true })}</span>${label}</span>`;
    const B = t => 1 << (t - 1);
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>盤と駒の並びは平手の将棋と同じ。ただし最初は、<b>どの駒も何の駒か決まっていません</b>（量子駒）。各側の駒は全部で 玉1・飛1・角1・金2・銀2・桂2・香2・歩9 の20枚です。</li>
          <li>量子駒は、候補のどれかの動きで動かせます。動かすと、<b>その動きができる種類だけが候補に残ります</b>。動かすほど正体が絞られていきます。</li>
          <li>候補が1つになった駒は正体が<b>確定</b>し、ふつうの将棋の駒になります。玉もいつか確定します。<b>確定した相手の玉を詰ませた方の勝ち</b>です。</li>
          <li>操作: 自分の駒をタップすると行き先が光り、行き先をタップすると指します。相手の駒をタップすると利き（動けるマス）と候補が見えます。駒を長押しすると大きく見られます。</li>
        </ul>
      </div>
      <div class="card" data-tab="量子駒">
        <h3>量子駒（正体の決まっていない駒）</h3>
        <ul>
          <li>縁が青緑の駒が量子駒。駒に並んでいる字が<b>候補</b>（その駒がなりうる種類）です。候補が多いときは「？」と数で表し、王の候補なら赤い「玉（王）」が付きます。盤が大きいとき・長押ししたとき・設定でオンにしたときは全部の字を出します。</li>
          <li>動かしたときに残る候補の例:<br>${ex(B(1) | B(2) | B(4) | B(5) | B(8) | B(7), '1マス前')}${ex(B(2) | B(7), '2マス以上まっすぐ前')}${ex(B(5) | B(8) | B(7), '1マス横')}${ex(B(4) | B(8) | B(6), '1マス斜め後ろ')}<br>斜めに2マス以上なら角に、桂の跳び方をすれば桂に確定します。</li>
          <li><b>枚数のつじつま</b>: 各側の種類ごとの枚数は決まっているので、ほかの駒の候補も自動で絞られます（例: 角の候補が1枚だけになれば、その駒が角に確定。玉の候補が1枚だけになれば、それが玉）。割り当てがどうやっても合わなくなる候補は、全部消えます。</li>
          <li><b>成る</b>: 相手の陣地（向こうの3段）に入る・その中で動く・そこから出るときに成れます。量子駒が成ると、<b>金と玉は候補から外れます</b>。成らずに行き所のなくなる種類（一番奥の段の歩・香、奥の2段の桂）も外れます。</li>
        </ul>
      </div>
      <div class="card" data-tab="取る・観測">
        <h3>取ると「観測」</h3>
        <ul>
          <li>相手の量子駒を取ると、<b>取った側がその正体を決めます</b>（観測）。選べるのは、その駒の候補のうち<b>玉以外</b>。決めた駒が自分の持ち駒になり、相手の残りの駒からその種類が1枚減ります（相手のほかの駒の候補も絞られます）。</li>
          <li>高い駒（飛・角）と観測すれば持ち駒は強くなります。相手の玉の候補を減らして、残った駒を玉に確定させる狙いもあります。</li>
          <li>確定した駒を取ったときは、ふつうの将棋と同じくその駒が持ち駒になります。持ち駒（打つ駒）はいつも確定しています。</li>
          <li>まだ正体の決まっていない駒の中身（残りの種類と数）は、駒台を押すと出る一覧で見られます。</li>
        </ul>
      </div>
      <div class="card" data-tab="王手と詰み">
        <h3>王手と詰み</h3>
        <ul>
          <li>王手と詰みは<b>玉が確定してから</b>。まだ玉の決まっていない側には王手はありません（王の候補の駒を取られても、それは玉以外として観測されます）。駒台の行の「王候補N」が、その側の王の候補の駒の数です。</li>
          <li>確定した玉は取れません。ふつうの将棋と同じく、王手を放っておく手・取られるマスへ玉を動かす手は指せません。自分の指し手で自分の玉が確定するときも同じです。</li>
          <li><b>量子駒の利き</b>は、候補のどれか1つでも届くマス全部。候補の多い量子駒は、飛・角・桂を合わせたような強い利きを持ちます。</li>
          <li>相手の王の候補を取って減らすと、残った駒が玉に確定することがあります。確定した瞬間に詰んでいれば勝ちです。</li>
        </ul>
      </div>
      <div class="card" data-tab="駒の動き">
        <h3>駒の動き</h3>
        <p class="hint" style="margin:0 0 8px">量子駒は、候補にある種類のどれかの動きで動けます。確定した駒はふつうの将棋と同じ動きです。</p>
        <div class="pchips" id="pchips">${chips}</div>
        <div class="pview" id="pview"></div>
      </div>
      <div class="card" data-tab="反則">
        <h3>してはいけない手（指せないようにしてあります）</h3>
        <ul>
          <li><b>二歩</b>: 確定した成っていない歩がある筋（縦の列）に、もう1枚歩を打つこと（量子駒は数えません）。</li>
          <li><b>打ち歩詰め</b>: 持ち駒の歩を打って詰ませること。</li>
          <li><b>行き所のない駒</b>: 歩・香を一番奥の段、桂を奥の2段に打つこと（量子駒が成らずにそこへ進むと、その種類は候補から外れます）。</li>
          <li><b>王手放置</b>: 確定した自分の玉が取られる状態のままにすること。</li>
          <li><b>千日手</b>: 同じ局面（盤・候補・持ち駒・残り・手番）が4回出たら引き分け。その間ずっと一方が王手をかけ続けていたら、かけていた側の負け。</li>
          <li>指せる手が1つもなくなった側の負け。512手で決着がつかなければ引き分け。</li>
        </ul>
      </div>
      <div class="card" data-tab="量子将棋との違い">
        <h3>着想と、量子将棋との違い</h3>
        <p>このゲームは、将棋ったーで2013年に公開された<b>量子将棋</b>の「動かすほど駒の正体が絞られる」という遊びに着想を得て、チューリング・テーブルで決まりを作り直した自作の将棋です。名前・ルールの文章・見た目は写していません。ここでの決まりは次のとおりです。</p>
        <ul>
          <li><b>勝ち方</b>: 確定した玉を<b>詰ませたら</b>勝ち。王手は放っておけません（ふつうの将棋と同じ）。</li>
          <li><b>取った駒</b>: <b>取った側が正体を決める</b>（玉以外の候補から）。持ち駒はいつも確定した駒です。</li>
          <li><b>候補の絞り込み</b>: 各側の枚数のつじつまで、ほかの駒の候補も自動で絞ります（割り当てが合わなくなる候補を全部消す）。</li>
          <li><b>成り・二歩</b>: 量子駒が成ると金・玉は候補から外れます。二歩は確定した歩だけで数えます。</li>
        </ul>
        <p class="hint">本家の量子将棋の細かい決まりとは違うところがあります。こちらの決まりは、遊びやすさと AI の学習のためにまとめ直したものです。</p>
      </div>
      <div class="card" data-tab="棋譜">
        <h3>棋譜</h3>
        <ul>
          <li>盤の下の棋譜テープ（⏮ ◀ ▶ ⏭）で、好きな局面に戻って見返せます。見返している局面から「ここから指す」で指し直しもできます。</li>
          <li>表記: 「量」は量子駒、「(77)」は元のマス、「＝飛」は取った量子駒を飛と観測したこと。情報の行に、その手で候補がどう絞られたか・何が確定したかが出ます。</li>
          <li>「⋯」→「棋譜を保存」でファイルに、「棋譜を読み込む」でこの形式の棋譜を読み込めます。</li>
        </ul>
      </div>`;
    renderPiece(8);
    docTabs($('view-rules'), 'rules');
  }
  function renderPiece(t) {
    $('pview').innerHTML = `
      <div class="mini">${diagram(t)}</div>
      <div class="info">
        <h4>${NAMES[t]}</h4>
        <p>${MOVE_TEXT[t]}</p>
        <div class="legend"><span style="--c:color-mix(in srgb, var(--accent) 55%, var(--surface-2))">動ける</span><span style="--c:color-mix(in srgb, var(--accent) 30%, var(--surface-2))">どこまでも</span><span style="--c:color-mix(in srgb, var(--gold) 70%, var(--surface-2))">跳ぶ</span></div>
        <p class="hint">先手から見た図（上が前）。対局中は、盤の駒をタップするとその場で利きを見られます。</p>
      </div>`;
    $('pchips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.t) === t)));
  }
  // 読み物のページは、カードの見出しからタブを作って1枚ずつ見せる
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
    const h = (W && W.history) || [];
    const gen = W ? W.gen || 0 : 0, total = W ? (W.totalGames || h.reduce((a, e) => a + (e.games || 0), 0)) : 0;
    // 採用された世代の「新 vs 旧」の Elo を足していった線（目安）
    let cum = 0;
    const series = [{ gen: 0, elo: 0 }];
    for (const e of h) if (e.accept && e.match) { cum += Math.max(0, e.match.elo); series.push({ gen: e.gen + 1, elo: cum }); }
    const bw = 600, bh = 180, pad = 34;
    let chart = '';
    if (series.length > 1) {
      const maxE = Math.max(50, ...series.map(s => s.elo)), g1 = series[series.length - 1].gen;
      const X = g => pad + g / Math.max(1, g1) * (bw - pad - 10), Y = e => bh - 22 - e / maxE * (bh - 36);
      const ticks = [0, 0.5, 1].map(f => Math.round(maxE * f));
      chart = `<svg viewBox="0 0 ${bw} ${bh}" style="width:100%;height:auto;display:block" role="img" aria-label="世代ごとの強さの伸び（Elo）">
        ${ticks.map(t => `<line x1="${pad}" x2="${bw - 8}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)"/><text x="${pad - 4}" y="${Y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="10">${t}</text>`).join('')}
        <polyline points="${series.map(s => `${X(s.gen).toFixed(1)},${Y(s.elo).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
        ${series.map(s => `<circle cx="${X(s.gen)}" cy="${Y(s.elo)}" r="3.5" fill="var(--good)"><title>第${s.gen}世代・累計 +${s.elo}</title></circle>`).join('')}
        <text x="${pad}" y="${bh - 6}" fill="var(--muted)" font-size="10">第0世代</text><text x="${bw - 8}" y="${bh - 6}" text-anchor="end" fill="var(--muted)" font-size="10">第${g1}世代</text>
      </svg>`;
    }
    const rows = h.slice(-30).reverse().map(e => `<tr><td>第${e.gen + 1}世代${e.accept ? '' : '（候補）'}</td><td>${(e.games || 0).toLocaleString()}局${e.nodes ? `・1手${e.nodes.toLocaleString()}局面` : ''}</td><td>${e.match ? `${e.match.elo >= 0 ? '+' : ''}${e.match.elo} ±${e.match.err}（${e.match.w}勝${e.match.l}敗${e.match.d}分）` : '—'}</td><td>${e.accept ? '採用' : '不採用'}</td></tr>`).join('');
    // 学んだ駒の価値（持ち駒1枚あたり・評価値の単位）。手で決めた値ではなく、自己対局の勝ち負けから出てきた値
    let values = '';
    const w = W && W.w, F = K.F;
    if (w && gen > 0 && F) {
      const hv = t => Math.round((w[F.hand + t - 1] + w[F.hand1 + t - 1] * 0.5) * K.EVAL_SCALE), pv = t => Math.round(w[F.pool + t - 1] * K.EVAL_SCALE);
      values = `<div class="tbl"><table class="lv"><thead><tr><th>種類</th><th>持ち駒1枚</th><th>量子駒の残り1枚</th></tr></thead><tbody>${[7, 6, 5, 4, 3, 2, 1].map(t => `<tr><td>${K.NAME[t]}</td><td>${hv(t) >= 0 ? '+' : ''}${hv(t)}</td><td>${pv(t) >= 0 ? '+' : ''}${pv(t)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    const lvRows = LV && LV.pairs ? LV.pairs.filter(p => CPU[p.a] && CPU[p.b]).map(p => `<tr><td>${CPU[p.a].label} vs ${CPU[p.b].label}${p.note ? `<br><small style="color: var(--muted)">${esc(p.note)}</small>` : ''}</td><td>${p.w}勝${p.l}敗${p.d}分</td><td>${!p.l && !p.d ? '全勝' : `${p.elo >= 0 ? '+' : ''}${p.elo} ±${p.err}`}</td></tr>`).join('') : '';
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習世代</span></div>
          <div class="stat"><b>${total.toLocaleString()}</b><span>自己対局（累計局数）</span></div>
          <div class="stat"><b>+${cum}</b><span>各世代の「新 vs 旧」の Elo の合計（目安）</span></div>
        </div>
        ${chart ? `<p class="hint" style="margin:14px 0 6px">世代ごとの検定：学んだ新しい重みと前の重みを、同じ序盤から先後入れ替えて対戦させ、負け越さなければ採用。線はその Elo 差の合計。</p>${chart}` : `<p>${gen ? '' : 'まだ学習していません（第0世代 = 評価なし。詰みだけ読みます）。'}</p>`}
      </div>
      <div class="card" data-tab="世代の記録">
        <h3>世代ごとの検定</h3>
        <p class="hint" style="margin:0 0 6px">新しい順に30回まで。「1手○局面」は自己対局と検定で1手に読んだ局面の数。</p>
        <div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>自己対局</th><th>新 vs 旧（Elo）</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">まだありません</td></tr>'}</tbody></table></div>
      </div>
      <div class="card" data-tab="学んだ駒の価値">
        <h3>AI が自分で見つけた駒の価値</h3>
        <p class="hint" style="margin:0 0 6px">評価の重みのうち、駒の数にかかる部分（評価値の単位。+1000 で勝率が約73%）。どれも自己対局の勝ち負けだけから出てきた値で、最初は全部 0 でした。量子駒は、取られるときに一番高い種類と観測されるので、まだ正体の決まっていない駒の値打ちは持ち駒とは別に学んでいます。</p>
        ${values || '<p>まだ学習していません。</p>'}
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ（すべて自作・人の知識なし）</h3>
        <ul>
          <li><b>何も知らない状態から</b>: 最初（第0世代）は評価が全部 0。駒の価値も、玉の守り方も教えていません。人の棋譜・定跡・ほかのソフトも使っていません。</li>
          <li><b>評価</b>: 局面を約${K.NF || 210}種類の特徴（持ち駒の数・確定した駒の種類と段・量子駒の残り・王の候補の数・確定した玉のまわりの守りと利き・取られそうな駒・候補に入っている種類…）にし、特徴ごとの重みを足します（手番の側 − 相手）。重みはロジスティック回帰で「その局面から勝つ確率」に合わせます。</li>
          <li><b>探索</b>: αβ探索（反復深化・PVS・置換表・Null Move・LMR）。量子駒は取るときに一番高い種類を選べるので、序盤から盤じゅうで取り合いが起きます。静止探索では、取り合いの見積もり（SEE。駒の価値は評価と同じ値）で損な取り合いを省き、順番違いの同じ局面を置換表でまとめます。枝刈りの幅は評価の大きさに合わせて伸び縮みさせます（学び直すたびに評価の大きさが変わっても、読み方が変わらないように）。</li>
          <li><b>強化学習</b>: 今の重みどうしで自己対局 → 出てきた局面（取り合いを読み切った先の局面）と勝ち負けで重みを学び直す → 前の重みと対戦して負け越さなければ採用（僅差のときはもう200局指して決める）、をくり返します。重みはニュートン法で解きます（確率的な方法だと、めったに出ない特徴の重みにゆらぎが残り、探索がそこを突いて弱くなりました）。学習は2スレッド・優先度を下げて動かしています。</li>
          <li><b>評価値</b>: 勝率 = 1 / (1 + e<sup>−評価値/1000</sup>)。+1000 で約73%。</li>
        </ul>
      </div>
      <div class="card" data-tab="CPU の強さ">
        <h3>CPU の${CPU_KEYS.length}段階</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>読み</th><th>特徴</th></tr></thead><tbody>
          ${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].time ? `1手${CPU[k].time / 1000}秒` : CPU[k].nodes ? `${CPU[k].nodes.toLocaleString()}局面` : '読まない'}</td><td>${CPU[k].desc}</td></tr>`).join('')}
        </tbody></table></div>
        ${lvRows ? `<p class="hint" style="margin:12px 0 4px">段階どうしの対戦（${LV.note ? esc(LV.note) + '。' : ''}同じ序盤から先後入れ替え）</p><div class="tbl"><table class="lv"><thead><tr><th>対戦</th><th>結果</th><th>Elo</th></tr></thead><tbody>${lvRows}</tbody></table></div>` : ''}
      </div>`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      $('main').classList.toggle('docmode', b.dataset.tab !== 'play');
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') fitBoardSoon();
    }));
    $('view-rules').addEventListener('click', e => { const chip = e.target.closest('#pchips button'); if (chip) renderPiece(Number(chip.dataset.t)); });
    document.addEventListener('click', e => {
      const hp = e.target.closest('.hp');
      if (hp && !hp.classList.contains('off')) {
        hideChooser();
        const t = Number(hp.dataset.hand);
        if (S.sel && S.sel.hand === t) clearSel(); else selectHand(t);
        return;
      }
      if (hp || e.target.closest('.player .hand')) { hideChooser(); openHands(); return; }
      if (!e.target.closest('#chooser')) hideChooser();
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('mouseover', e => {
      const hp = e.target.closest && e.target.closest('.hp');
      const t = hp && !hp.classList.contains('off') ? Number(hp.dataset.hand) : 0;
      if (t !== (S.hoverHand || 0)) { S.hoverHand = t; renderMarks(); }
    });
    $('sqinfo').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'desel') { hideChooser(); clearSel(); }
      else if (act === 'live') viewPly(S.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'rematch') requestRematch();
      else if (act === 'lobby') { leaveOnline(); openOnline(); }
      else if (act === 'claim' && S.online && !S.result) { S.result = { winner: S.online.myColor, reason: '相手の接続切れ' }; afterChange(); }
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
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); });
    $('btn-more').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('menu-more'); m.hidden = !m.hidden;
      $('btn-more').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'graph' : 'kifu'));
    $('btn-kif-dl').addEventListener('click', downloadKif);
    $('btn-kif-in').addEventListener('click', openImport);
    window.addEventListener('resize', () => { fitBoardSoon(); if ($('side').classList.contains('open')) placeSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', e => {
      if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; }
      const b = e.target.closest('button');
      if (!b || !NET) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; NET.challenge(b.dataset.ch); renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { lobby.msg = ''; NET.wait({ h: 'hirate' }, '量子観測'); renderLobby(); renderOnlineBadge(); }
      else if (act === 'unwait') { NET.unwait(); renderLobby(); renderOnlineBadge(); }
      else if (act === 'ai') { const on = !aiOn(); setSetting('showEval', on, true); setSetting('arrow', on); renderLobby(); }
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
    $('btn-flip').addEventListener('click', () => { S.flip = !S.flip; hideChooser(); saveGame(); render(); });
    document.addEventListener('click', e => { if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); } });
    $('btn-resign').addEventListener('click', () => { if (S.online || confirm('投了しますか？')) resign(); });
    $('btn-hint').addEventListener('click', () => {
      if (!humanTurn()) return;
      if (S.online && NET) { S.online.myHints++; NET.send({ t: 'hint' }); saveGame(); renderPlayers(); }
      const ply = S.moves.length, c = S.pos.stm;
      AI.start({ handicap: S.handicap, moves: S.moves.slice(), timeMs: HINT_MS, analyze: true, parallel: true },
        info => onInfo(ply, c, info, 'hint'), info => onInfo(ply, c, info, 'hint'));
    });
    $('btn-settings').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('settings'); p.hidden = !p.hidden;
      $('btn-settings').setAttribute('aria-expanded', String(!p.hidden));
    });
    [['set-eval', 'showEval'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-arrow', 'arrow'], ['set-reach', 'reach'], ['set-analyze', 'analyze'], ['set-detail', 'detail']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => { if (k === 'anim' && TM) TM.set(el.checked); setSetting(k, el.checked); });
    });
    $('hd-close').addEventListener('click', () => { $('dlg-hands').hidden = true; });
    $('dlg-hands').addEventListener('click', e => { if (!e.target.closest('.hd-p')) $('dlg-hands').hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('dlg-hands').hidden) $('dlg-hands').hidden = true; });
    bindMotion();
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
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.moves.length, 60);
      viewPly(Math.max(0, Math.min(S.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    $('btn-live').addEventListener('click', () => viewPly(S.moves.length));
    $('btn-branch').addEventListener('click', branch);
    $('btn-copy').addEventListener('click', () => {
      const text = kifText(), msg = $('copy-msg');
      const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.rows = 6; ta.style.width = '100%'; msg.innerHTML = ''; msg.appendChild(ta); ta.select(); };
      try { navigator.clipboard.writeText(text).then(() => { msg.textContent = 'コピーしました'; setTimeout(() => { msg.textContent = ''; }, 2500); }, fallback); } catch (e) { fallback(); }
    });
    $('btn-save').addEventListener('click', downloadKif);
    $('btn-import').addEventListener('click', openImport);
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => {
      try { importKifu($('im-text').value); $('dlg-import').hidden = true; } catch (err) { $('im-msg').textContent = err.message; }
    });
    $('im-file').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      f.arrayBuffer().then(buf => {
        // KIF は Shift_JIS のことが多い。UTF-8 で読めなければ Shift_JIS で
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) { try { text = new TextDecoder('shift_jis').decode(buf); } catch (err) { /* そのまま */ } }
        $('im-text').value = text;
        e.target.value = '';
      });
    });
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        // オンライン対戦: 今の対局はそのままで、上の丸いボタンと同じパネルを開く
        if (id === 'ng-mode' && v === 'online') { closeNew(); openOnline(); return; }
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-side') draft.side = v;
        else if (id === 'ng-cpu-b') draft.cpuB = v;
        else if (id === 'ng-cpu-w') draft.cpuW = v;
        else if (id === 'ng-handi') draft.handicap = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) closeNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; S.paused = false; startGame(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online) requestRematch(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); hideChooser(); if (!$('dlg-new').hidden) closeNew(); ['dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel || S.inspect >= 0) clearSel(); return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if ([...document.querySelectorAll('.overlay')].some(o => !o.hidden)) return; // ダイアログが開いている間は、裏の棋譜を動かさない
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
    });
  }
  function openImport() { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); }

  // ------------------------------------------------------------------ オンライン対戦（共通の ../common/online.js）
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available();
  const GAME = 'kansoku';
  const PAGES_URL = 'https://angrh0824.github.io/turing-table/kansoku/';
  let NET = null;
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
    setInterval(() => { if (S.online && !S.online.oppPresent) renderSqInfo(); }, 10000);
    return NET;
  }
  function startOnline(g) {
    $('dlg-online').hidden = true;
    const online = { gid: g.mid, myColor: g.myColor ? WHITE : BLACK, opp: { name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 }, myHints: 0, oppPresent: true, lostAt: 0, myRe: false, oppRe: false };
    const seats = online.myColor === BLACK ? ['human', 'remote'] : ['remote', 'human'];
    loadGame({ handicap: 'hirate', seats, moves: [], online });
    clack('move');
  }
  function leaveOnline() {
    if (NET && NET.game) NET.leaveGame();
    if (S.online) { S.online = null; S.seats = S.seats.map(x => (x === 'remote' ? 'human' : x)); }
  }
  // 相手から届いたもの: あいさつ・指し手・今の状態・投了・AI補助の変更・ヒント・もう一局
  function onRemote(msg) {
    const o = S.online;
    if (!o || !msg) return;
    // 保持された今の状態（common/online.js が t を時刻で上書きすることがあるので、k: 'st' で見分ける）
    if ((msg.k === 'st' || msg.t === 'state') && Array.isArray(msg.moves)) {
      for (let i = 0; i < Math.min(msg.moves.length, S.moves.length); i++) if ((msg.moves[i] | 0) !== S.moves[i]) return;
      // 再読み込みで自分の手が抜けていても追いつけるよう、どちらの手も順に（合法なら）指す
      for (const m of msg.moves.slice(S.moves.length).map(x => x | 0)) {
        if (S.result || (!S.legal.includes(m))) break;
        play(m, true);
      }
      return;
    }
    if (msg.t === 'hi') {
      if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
      o.opp.ai = msg.ai | 0;
      if (!msg.re) NET.send({ t: 'hi', re: 1, n: myName, ai: aiFlags() });
      saveGame(); renderPlayers(); renderSqInfo();
    } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveGame(); renderPlayers(); }
    else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveGame(); renderPlayers(); }
    else if (msg.t === 'mv') { if ((msg.n | 0) === S.moves.length + 1) applyRemote([msg.m | 0]); }
    else if (msg.t === 'resign') {
      if (!S.result) { S.result = { winner: o.myColor, reason: `${o.opp.name}さんの投了` }; afterChange(); }
    } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); renderSqInfo(); }
    else if (msg.t === 'rego' && typeof msg.gid === 'string') {
      NET.start({ mid: msg.gid.slice(0, 20), myColor: msg.oc ? 1 : 0, r: { h: 'hirate' }, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
    }
  }
  // 相手の手を順に指す（相手の番で、合法手のときだけ）
  function applyRemote(list) {
    for (const m of list) {
      if (S.result || !isRemote(S.pos.stm)) break;
      if (!S.legal.includes(m)) break;
      play(m, true);
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
    if (oppId && NET.id > oppId) return;
    const gid = Math.random().toString(36).slice(2, 12);
    NET.send({ t: 'rego', gid, oc: o.myColor });
    NET.start({ mid: gid, myColor: o.myColor ^ 1, r: { h: 'hirate' }, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
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
    const c = NET && st === 'on' ? NET.counts() : null, g = c && (c.byGame[GAME] || { wait: 0 });
    b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・量子観測の待ち${g.wait}</small>` : st === 'connecting' ? '…' : '';
  }
  function renderLobby() {
    if ($('dlg-online').hidden || !ONLINE_OK) return;
    const st = NET ? NET.status : 'off', all = NET ? NET.counts() : null, me = NET ? NET.me : null;
    const c = all && Object.assign({ online: all.online }, all.byGame[GAME] ? { wait: all.byGame[GAME].wait, play: all.byGame[GAME].play } : { wait: 0, play: 0 });
    const num = v => (st === 'on' && c ? v : '—');
    const waits = NET && st === 'on' ? NET.list().filter(p => p.s === 'wait' && p.g === GAME) : [];
    const waiting = me && me.s === 'wait';
    const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
    $('on-body').innerHTML = `
      <div class="on-stats">
        <div class="stat"><b>${num(c && c.online)}</b><span>オンライン（全ゲーム）</span></div>
        <div class="stat"><b>${num(c && c.wait)}</b><span>量子観測将棋の対戦待ち</span></div>
        <div class="stat"><b>${num(c && c.play)}</b><span>量子観測将棋の対局中</span></div>
        <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
      </div>
      ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
      <div class="field"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(myName)}" autocomplete="nickname"></div>
      <div class="field"><span class="lab">あなたの AI補助（相手に表示されます）</span>
        <div class="on-ai">${aiTagHTML(aiFlags(), 0)}<button class="btn small" data-act="ai">${aiOn() ? 'オフにする' : 'オンにする'}</button><span class="hint">形勢・最善手の矢印を出しているか、ヒントを何回使ったかが相手にも見えます</span></div></div>
      <div class="field"><span class="lab">対戦を待っている人（${waits.length}人）</span>
        <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b>${aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
          : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「対戦を待つ」で相手を待てます。</p>'}</div></div>
      <div class="field"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ（先後はランダム）'}</span>
        ${waiting ? `<div class="on-wait"><span>相手を待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
            <span class="row-actions" style="margin:0"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
            <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
          : `<div><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>対戦を待つ</button></div>`}
      </div>
      <p class="hint on-note">公開の中継サーバーを使うため、名前と指し手はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
  }

  // 振り返りパネル（狭い画面）: 盤のすぐ下から画面の下までを覆い、盤は見えたまま
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function placeSheet() {
    const fr = document.querySelector('.board-frame').getBoundingClientRect(), h = window.innerHeight;
    const land = document.body.classList.contains('land');
    $('side').style.setProperty('--sheet-top', Math.round(land ? h * 0.18 : Math.min(h * 0.68, Math.max(h * 0.3, fr.bottom + 6))) + 'px');
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
    const box = { showEval: 'set-eval', arrow: 'set-arrow' }[k];
    if (box) $(box).checked = v;
    if (quiet) return;
    if ((k === 'showEval' || k === 'arrow') && NET) NET.setAI(aiFlags());
    if ((k === 'analyze' || k === 'showEval' || k === 'arrow') && !S.thinking && isHuman(S.pos.stm)) analyze();
    render();
  }
  function branch() {
    if (live()) return;
    AI.cancel();
    const n = S.view;
    S.view = null; S.dpos = null;
    rebuild(n);
    afterChange();
  }

  function onWeights() {
    if (wReady) return;
    W = (typeof KANSOKU_WEIGHTS !== 'undefined' && KANSOKU_WEIGHTS) ? KANSOKU_WEIGHTS : null;
    wReady = true;
    const w = AI.waiting;
    AI.waiting = null;
    if (w) AI.start(w[0], w[1], w[2]);
    if (!$('view-ai').hidden) renderAIPage();
  }
  window.addEventListener('kansoku-weights', onWeights);
  // 合図を取りこぼしても、重みが届いていれば始める（念のため）
  if (!wReady) {
    const poll = setInterval(() => {
      if (wReady) { clearInterval(poll); return; }
      if ((typeof KANSOKU_WEIGHTS !== 'undefined' && KANSOKU_WEIGHTS) || window.KANSOKU_WEIGHTS_STATE === 2) { clearInterval(poll); onWeights(); }
    }, 300);
  }
  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBoardSoon());
  if (ONLINE_OK) { net(); renderOnlineBadge(); }
  if (roomCode && ONLINE_OK) openOnline();
  const saved = store.get('game', null);
  if (saved && Array.isArray(saved.moves) && saved.seats) {
    try {
      if (saved.online && (!ONLINE_OK || saved.result)) { saved.online = null; saved.seats = saved.seats.map(x => (x === 'remote' ? 'human' : x)); }
      if (saved.online) saved.online = Object.assign({ myHints: 0 }, saved.online, { oppPresent: true, lostAt: 0, myRe: false, oppRe: false });
      loadGame(saved);
      if (S.online && NET) NET.rejoin({ mid: S.online.gid, myColor: S.online.myColor, opp: { id: '', name: S.online.opp.name, ai: S.online.opp.ai } });
    } catch (e) { startGame(cfg); }
  } else {
    S.paused = true; // 初めて開いたとき: 選び終えるまで CPU に指させない
    startGame(cfg);
    openNew();
  }
})();
