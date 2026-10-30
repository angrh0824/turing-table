/* ブロック陣取り Webアプリ: 盤（SVG）・手持ち・操作（なぞって合わせる・回す・裏返す）・CPU（Web Worker）・AI補助・振り返り */
(function () {
  'use strict';
  const B = BlocksCore;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------------ 色（4色の樹脂。2人 14×14 は青と赤）
  const PAL = [
    { name: '青', base: '#2b6be0', hi: '#7eaefc', lo: '#1546a8' },
    { name: '黄', base: '#f0b429', hi: '#ffe28c', lo: '#bd8206' },
    { name: '赤', base: '#e0473b', hi: '#ff9c8d', lo: '#a3241a' },
    { name: '緑', base: '#26a259', hi: '#86e3a8', lo: '#0f703a' },
  ];
  const palOf = (mode, c) => (mode === 'duo' ? [0, 2][c] : c);
  const MODE_NAME = { classic: '4人（20×20）', team: '2人・2色ずつ（20×20）', duo: '2人（14×14）' };

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '読まずに、学んだ直感（方策）だけで置きます', kind: 'policy', min: 450 },
    normal: { label: 'ふつう', stars: 2, desc: '少しだけ先を読みます（1手 40回）', kind: 'search', sims: 40, time: 1500, min: 500 },
    strong: { label: 'つよい', stars: 3, desc: '1手 1.5秒 読みます', kind: 'search', time: 1500, sims: 3000, min: 0 },
    max: { label: '最強', stars: 4, desc: '1手 4秒、複数のスレッドで全力で読みます', kind: 'search', time: 4000, parallel: true, min: 0 },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const ANALYZE_MS = 2500, HINT_MS = 2000;

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('blocks-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('blocks-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  let cfg = Object.assign({ mode: 'classic', opp: 'cpu', cpu: 'normal', side: '0' }, store.get('cfg', {}));
  if (!B.RULES[cfg.mode]) cfg.mode = 'classic';
  const settings = Object.assign({ showEval: true, best: true, anchors: true, snap: true, sound: true, dark: null }, store.get('settings', {}));
  const aiOn = () => settings.showEval || settings.best;
  const aiFlags = () => (settings.showEval ? 1 : 0) | (settings.best ? 2 : 0);
  if (settings.dark != null) document.documentElement.dataset.theme = settings.dark ? 'dark' : 'light';

  // ------------------------------------------------------------------ CPU（Web Worker）
  const NET_OK = typeof BLOCKS_WEIGHTS !== 'undefined';
  const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const AI = {
    pool: [], id: 0, busy: false, fallbackNet: null,
    make() { try { return new Worker('js/ai-worker.js'); } catch (e) { return null; } },
    ensure(n) { while (this.pool.length < n) { const w = this.make(); if (!w) break; this.pool.push(w); } return Math.min(n, this.pool.length); },
    start(job, onInfo, onDone) {
      this.cancel();
      const id = ++this.id;
      this.busy = true;
      const n = this.ensure(job.parallel ? THREADS : 1);
      const finish = r => { if (id !== this.id) return; this.busy = false; onDone(r); };
      if (!n) {
        // Worker が使えない環境: 画面のスレッドで短く読む
        setTimeout(() => {
          if (id !== this.id) return;
          const pos = B.Position.fromMoves(job.mode, job.moves);
          if (!NET_OK || job.kind === 'big') { finish({ move: BlocksSearch.bigMove(pos), sims: 0 }); return; }
          if (!this.fallbackNet) this.fallbackNet = new BlocksNN.Net(BLOCKS_WEIGHTS, window.BLOCKS_WASM_B64);
          if (job.kind === 'policy') { finish({ move: BlocksSearch.policyMove(this.fallbackNet, pos), sims: 0 }); return; }
          finish(new BlocksSearch.Search(this.fallbackNet, { seed: Date.now() & 0xffff }).run(pos, { timeMs: Math.min(job.timeMs || 800, 800), maxSims: job.maxSims }));
        }, 30);
        return;
      }
      const results = new Array(n).fill(null);
      let left = n;
      this.pool.slice(0, n).forEach((w, i) => {
        w.onmessage = e => {
          const m = e.data;
          if (m.id !== this.id) return;
          if (m.type === 'info') { if (i === 0 && onInfo) onInfo(m.info, n); return; }
          results[i] = m.result;
          if (--left === 0) finish(n > 1 ? BlocksSearch.merge(results) : results[0]);
        };
        w.onerror = () => { results[i] = null; if (--left === 0) finish(BlocksSearch.merge(results)); };
        w.postMessage({ type: 'think', id, mode: job.mode, moves: job.moves, kind: job.kind, timeMs: job.timeMs, maxSims: job.maxSims, seed: ((Math.random() * 1e9) | 0) + i * 7919, noise: n > 1 ? 0.2 : 0 });
      });
    },
    cancel() {
      if (this.busy) this.pool.forEach(w => w.postMessage({ type: 'stop' })); // 読みは細かく区切って進むので、すぐ止まる
      this.busy = false;
      this.id++;
    },
  };

  // ------------------------------------------------------------------ 音（WebAudio で合成。樹脂のピースを置く「コトッ」）
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
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'pass' ? 600 : 2100; bp.Q.value = 3;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'pass' ? 0.5 : 0.9, t);
      src.connect(bp).connect(g).connect(actx.destination); src.start(t);
      const o = actx.createOscillator(), og = actx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(kind === 'pass' ? 330 : 880, t); o.frequency.exponentialRampToValueAtTime(kind === 'pass' ? 220 : 520, t + 0.07);
      og.gain.setValueAtTime(0.12, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.1);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    mode: 'classic', seats: [], moves: [], pos: null,
    view: null, dpos: null, result: null, resultShown: false,
    evals: [], info: null, legal: new Int32Array(0), legalSet: new Set(), byOri: new Map(),
    sel: null, ghost: null, thinking: false, timer: 0, passes: {}, hint: null,
    online: null, // オンラインの卓（js/online-blocks.js が入れる）
    msgTimer: 0, evOpen: false,
  };
  const live = () => S.view === null;
  const shownPos = () => (live() ? S.pos : S.dpos);
  const shownPly = () => (live() ? S.moves.length : S.view);
  const ownerOf = c => S.pos.R.owner[c];
  const seatOf = c => S.seats[ownerOf(c)] || { k: 'human' };
  const isHumanColor = c => c >= 0 && seatOf(c).k === 'human';
  const isCPUColor = c => c >= 0 && seatOf(c).k === 'cpu';
  const isRemoteColor = c => c >= 0 && seatOf(c).k === 'remote';
  const colorName = c => PAL[palOf(S.mode, c)].name;
  const colorHex = c => PAL[palOf(S.mode, c)].base;
  const humans = () => S.seats.filter(s => s.k === 'human').length;
  function seatLabel(c) {
    const s = seatOf(c);
    if (s.k === 'cpu') return `CPU<span class="lvl"> ${CPU[s.lv] ? CPU[s.lv].label : ''}</span><span class="lvs">${CPU[s.lv] ? '★'.repeat(CPU[s.lv].stars) : ''}</span>`;
    if (s.k === 'remote') return s.name ? esc(s.name) : '相手';
    return humans() === 1 || S.online ? 'あなた' : `人${ownerOf(c) + 1}`;
  }

  // ------------------------------------------------------------------ 対局の進行
  function newSeats(c) {
    const R = B.RULES[c.mode], P = R.players;
    if (c.opp === 'pvp') return Array.from({ length: P }, () => ({ k: 'human' }));
    if (c.opp === 'watch') return Array.from({ length: P }, () => ({ k: 'cpu', lv: c.cpu }));
    let me = c.side === 'random' ? Math.floor(Math.random() * P) : Math.min(P - 1, Number(c.side) || 0);
    if (c.mode === 'team') me = me % 2;
    return Array.from({ length: P }, (_, p) => (p === me ? { k: 'human' } : { k: 'cpu', lv: c.cpu }));
  }
  function startGame(c) {
    if (window.BKOnline && S.online) window.BKOnline.leave(true);
    cfg = c; store.set('cfg', cfg);
    loadGame({ mode: c.mode, seats: newSeats(c), moves: [] });
  }
  function loadGame(g) {
    AI.cancel(); clearTimeout(S.timer);
    S.mode = g.mode; S.seats = g.seats; S.online = g.online || null;
    S.pos = new B.Position(g.mode);
    S.moves = []; S.passes = {};
    S.evals = g.evals ? g.evals.slice() : [];
    for (const m of g.moves) {
      notePasses(S.pos.done, S.moves.length);
      if (!S.pos.legalHas(m)) break;
      S.pos.play(m); S.moves.push(m);
    }
    S.view = null; S.dpos = null; S.sel = null; S.ghost = null; S.info = null; S.hint = null;
    S.result = null; S.resultShown = !!g.resultShown;
    buildBoard();
    afterChange(null, true);
  }
  function saveGame() {
    if (S.online) return; // オンラインの卓はそちらで覚える
    store.set('game', { mode: S.mode, seats: S.seats, moves: S.moves, resultShown: S.resultShown, evals: S.evals.slice(0, S.moves.length + 1) });
  }
  // legal() の前後で「置けなくなった色」を記録（記録とテープにパスとして出す）
  function notePasses(before, ply) {
    const pos = S.pos;
    pos.legal();
    const newly = pos.done & ~before;
    if (newly) { const list = []; for (let c = 0; c < pos.nc; c++) if (newly & (1 << c)) list.push(c); S.passes[ply] = (S.passes[ply] || []).concat(list); }
    return newly;
  }

  function play(m, fromRemote) {
    if (S.result || !S.legalSet.has(m)) return false;
    const c = S.pos.turn;
    const ply = S.moves.length;
    S.pos.play(m); S.moves.push(m);
    clack('place');
    if (S.online && !fromRemote && window.BKOnline) window.BKOnline.sendMove(ply, m, c);
    afterChange({ pid: m, color: c });
    return true;
  }

  function afterChange(placed, quiet) {
    S.sel = placed ? null : S.sel; S.ghost = placed ? null : S.ghost; S.hint = null;
    const before = S.pos.done;
    const newly = notePasses(before, S.moves.length);
    const k = S.pos.legal();
    S.legal = Int32Array.from(S.pos.buf.subarray(0, k));
    S.legalSet = new Set(S.legal);
    S.byOri = new Map();
    for (const pid of S.legal) { const o = S.pos.T.P_ORI[pid]; if (!S.byOri.has(o)) S.byOri.set(o, []); S.byOri.get(o).push(pid); }
    S.info = null;
    if (!k && !S.result) S.result = S.pos.outcome();
    if (newly && !quiet) {
      const list = []; for (let c = 0; c < S.pos.nc; c++) if (newly & (1 << c)) list.push(colorName(c));
      if (!S.result) { flash(`${list.join('・')}はもう置けません（パス）`); clack('pass'); }
    }
    if (S.sel && !S.result && !isHumanColor(S.pos.turn)) { S.sel = null; S.ghost = null; }
    saveGame();
    render();
    if (placed) popPiece(placed.pid);
    if (S.result && !S.resultShown && live()) { S.resultShown = true; saveGame(); setTimeout(showResult, 650); }
    if (S.online && window.BKOnline) window.BKOnline.changed();
    schedule();
  }

  // 「新しい対局」を選んでいる間か（そのあいだ裏の対局は進めない。オンラインの卓は止めない）
  const newPaused = () => !$('dlg-new').hidden && !S.online;
  function schedule() {
    clearTimeout(S.timer);
    S.thinking = false;
    if (newPaused()) { AI.cancel(); return; }
    if (!live() || S.result) { analyze(); return; }
    const c = S.pos.turn;
    if (isRemoteColor(c)) { AI.cancel(); renderPlayers(); return; }
    if (!isCPUColor(c)) {
      // 人の番: AI補助が出ていれば形勢を読む（隠している間は読まない）
      analyze();
      return;
    }
    const cpu = CPU[seatOf(c).lv] || CPU.normal, ply = S.moves.length, t0 = Date.now();
    S.thinking = true;
    renderPlayers(); renderInfo();
    AI.start({ mode: S.mode, moves: S.moves.slice(), kind: NET_OK ? cpu.kind : 'big', timeMs: cpu.time, maxSims: cpu.sims, parallel: !!cpu.parallel },
      info => onInfo(ply, info, 'cpu'),
      r => {
        if (r && r.sims) onInfo(ply, r, 'cpu');
        S.thinking = false;
        if (!(live() && S.moves.length === ply && !S.result && r && r.move >= 0)) { renderPlayers(); return; }
        const wait = Math.max(160, (cpu.min || 0) - (Date.now() - t0));
        S.timer = setTimeout(() => { if (S.moves.length === ply) play(r.move); }, wait);
      });
  }

  // 人の番（または見返しているとき）に形勢を読む
  function analyze(force, ms) {
    const pos = shownPos();
    if ((!aiOn() && !force) || !NET_OK || pos.turn < 0 || (live() && S.result)) { AI.cancel(); renderEval(); return; }
    if (live() && !isHumanColor(pos.turn) && !force) { renderEval(); return; }
    const ply = shownPly();
    AI.start({ mode: S.mode, moves: S.moves.slice(0, ply), kind: 'search', timeMs: ms || ANALYZE_MS, maxSims: 4000 },
      info => onInfo(ply, info, 'analysis'), r => { if (r) onInfo(ply, r, 'analysis'); });
  }

  function onInfo(ply, r, kind) {
    if (!r || !r.kids) return;
    if (kind !== 'cpu' || r.sims >= 30) S.evals[ply] = { score: r.score.map(v => Math.round(v * 10) / 10), util: r.util.map(v => Math.round(v * 1000) / 1000) };
    S.info = { ply, r, kind };
    renderPlayers(); renderEval(); renderGraph(); renderMarks();
  }

  // ------------------------------------------------------------------ 盤（SVG）
  let gridN = 0;
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  // グラデーション（樹脂の色・つや）は、見えない別の SVG に置く（盤を隠しても手持ちやルールの図で使えるように）
  function buildDefs() {
    const svg = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0;overflow:hidden' });
    const defs = el('defs', {}, svg);
    PAL.forEach((p, i) => {
      const g = el('linearGradient', { id: `gp${i}`, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      el('stop', { offset: '0', 'stop-color': p.hi }, g); el('stop', { offset: '.45', 'stop-color': p.base }, g); el('stop', { offset: '1', 'stop-color': p.lo }, g);
    });
    const gb = el('linearGradient', { id: 'g-board', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el('stop', { offset: '0', style: 'stop-color:var(--board-hi)' }, gb); el('stop', { offset: '1', style: 'stop-color:var(--board-lo)' }, gb);
    const gl = el('linearGradient', { id: 'g-gloss', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el('stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '.75' }, gl); el('stop', { offset: '1', 'stop-color': '#fff', 'stop-opacity': '0' }, gl);
    document.body.appendChild(svg);
  }
  buildDefs();

  function buildBoard() {
    const n = S.pos.n, svg = $('board');
    if (gridN === n) return;
    gridN = n;
    svg.setAttribute('viewBox', `-0.3 -0.3 ${n + 0.6} ${n + 0.6}`);
    svg.innerHTML = '';
    el('rect', { x: -0.3, y: -0.3, width: n + 0.6, height: n + 0.6, rx: 0.5, class: 'cellbg' }, svg);
    let d = '';
    for (let i = 1; i < n; i++) d += `M${i} 0V${n}M0 ${i}H${n}`;
    el('path', { d, class: 'gridl' }, svg);
    el('rect', { x: 0, y: 0, width: n, height: n, class: 'frame', rx: 0.08 }, svg);
    for (const id of ['lay-start', 'lay-pieces', 'lay-marks', 'lay-best', 'lay-ghost']) el('g', { id }, svg);
  }

  // マスの集まり → 外周の道（多角形）。1〜5マスの形には穴がない
  function outline(cells, n) {
    const set = new Set(cells), edges = [];
    for (const i of cells) {
      const x = i % n, y = (i / n) | 0;
      if (!(y > 0 && set.has(i - n))) edges.push([x, y, x + 1, y]);
      if (!(x < n - 1 && set.has(i + 1))) edges.push([x + 1, y, x + 1, y + 1]);
      if (!(y < n - 1 && set.has(i + n))) edges.push([x + 1, y + 1, x, y + 1]);
      if (!(x > 0 && set.has(i - 1))) edges.push([x, y + 1, x, y]);
    }
    const from = new Map();
    for (const e of edges) from.set(e[0] + ',' + e[1], e);
    let e = edges[0], d = `M${e[0]} ${e[1]}`;
    const start = e;
    for (let k = 0; k < edges.length; k++) {
      d += `L${e[2]} ${e[3]}`;
      e = from.get(e[2] + ',' + e[3]);
      if (!e || e === start) break;
    }
    return d + 'Z';
  }
  // ピースを描く（樹脂: 全体のグラデーション、マスの継ぎ目、つや）
  function pieceG(cells, n, p, cls = '') {
    const g = el('g', { class: cls });
    const d = outline(cells, n);
    el('path', { d, fill: `url(#gp${p})`, stroke: 'var(--board-lo)', 'stroke-width': 0.1, 'stroke-linejoin': 'round' }, g);
    const set = new Set(cells);
    let seam = '';
    for (const i of cells) {
      const x = i % n, y = (i / n) | 0;
      if (x < n - 1 && set.has(i + 1)) seam += `M${x + 1} ${y + 0.2}V${y + 0.8}`;
      if (y < n - 1 && set.has(i + n)) seam += `M${x + 0.2} ${y + 1}H${x + 0.8}`;
    }
    if (seam) el('path', { d: seam, stroke: PAL[p].lo, 'stroke-opacity': 0.55, 'stroke-width': 0.05, 'stroke-linecap': 'round', fill: 'none' }, g);
    for (const i of cells) {
      const x = i % n, y = (i / n) | 0;
      el('rect', { x: x + 0.17, y: y + 0.13, width: 0.66, height: 0.34, rx: 0.12, fill: 'url(#g-gloss)', opacity: 0.55 }, g);
    }
    return g;
  }

  function renderBoard() {
    const pos = shownPos(), n = pos.n, T = pos.T;
    buildBoard();
    const lp = $('lay-pieces'), ls = $('lay-start');
    lp.innerHTML = ''; ls.innerHTML = '';
    const moves = S.moves.slice(0, shownPly());
    const colors = colorsOf(S.moves);
    moves.forEach((m, i) => {
      const g = pieceG(pos.cellsOf(m), n, palOf(S.mode, colors[i]), 'pc');
      g.dataset.ply = i + 1;
      lp.appendChild(g);
    });
    // まだ置いていない色の、決められた最初のマス
    for (let c = 0; c < pos.nc; c++) {
      if (pos.last(c) >= 0) continue;
      const [x, y] = pos.R.starts[c], col = colorHex(c);
      el('rect', { x: x + 0.12, y: y + 0.12, width: 0.76, height: 0.76, rx: 0.16, class: 'start', stroke: col }, ls);
      el('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.13, fill: col, class: 'startdot' }, ls);
    }
    // 直前の手
    if (moves.length) {
      const last = moves[moves.length - 1];
      el('path', { d: outline(pos.cellsOf(last), n), class: 'last' }, lp);
    }
    void T;
    renderMarks();
  }
  // 手の記録から、それぞれの手を置いた色
  function moveColors(moves) {
    const p = new B.Position(S.mode), out = [];
    for (const m of moves) { p.legal(); out.push(p.turn); p.play(m); }
    return out;
  }
  let colorsCache = { key: '', list: [] };
  function colorsOf(moves) {
    const key = S.mode + ':' + moves.length + ':' + (moves[moves.length - 1] ?? '');
    if (colorsCache.key !== key) colorsCache = { key, list: moveColors(moves) };
    return colorsCache.list;
  }

  // 印: 置ける角・おすすめの一手・持っているピースの影
  function renderMarks() {
    const lm = $('lay-marks'), lb = $('lay-best'), lg = $('lay-ghost');
    if (!lm) return;
    lm.innerHTML = ''; lb.innerHTML = ''; lg.innerHTML = '';
    const pos = shownPos(), n = pos.n;
    const c = pos.turn;
    // 置ける角（自分の番のとき）
    if (live() && !S.result && isHumanColor(c) && settings.anchors) {
      const use = new Set();
      if (S.sel) for (const pid of S.byOri.get(S.sel.ori) || []) for (const i of pos.cellsOf(pid)) use.add(i);
      const col = colorHex(c);
      for (const a of pos.anchors(c)) {
        const usable = S.sel ? use.has(a) : true;
        const g = el('g', { class: 'anc' + (S.sel && usable ? ' use' : '') }, lm);
        el('circle', { cx: a % n + 0.5, cy: ((a / n) | 0) + 0.5, r: S.sel ? (usable ? 0.2 : 0.09) : 0.14, fill: col }, g);
      }
    }
    // おすすめの一手（AI補助・ヒント）
    const best = bestShown();
    if (best != null) {
      const bc = pos.turn;
      el('path', { d: outline(pos.cellsOf(best), n), class: 'best', fill: colorHex(bc), stroke: colorHex(bc), 'stroke-linejoin': 'round' }, lb);
    }
    // 持っているピースの影
    if (S.sel && S.ghost && live()) {
      const pid = pos.placement(S.sel.ori, S.ghost.x, S.ghost.y);
      if (pid >= 0) {
        const ok = S.legalSet.has(pid);
        const g = pieceG(pos.cellsOf(pid), n, palOf(S.mode, c), 'ghost' + (ok ? '' : ' bad'));
        g.querySelectorAll('path, rect').forEach(e => e.classList.add('gcell'));
        g.setAttribute('opacity', ok ? 0.88 : 0.6);
        el('path', { d: outline(pos.cellsOf(pid), n), class: 'gline', stroke: ok ? '#fff' : 'var(--bad)', 'stroke-dasharray': ok ? 'none' : '.25 .15' }, g);
        lg.appendChild(g);
      }
    }
    renderInfo();
  }
  // 盤に出すおすすめの一手（ヒント、または AI補助の「おすすめ」）
  function bestShown() {
    const pos = shownPos();
    if (S.hint && S.hint.ply === shownPly()) return S.hint.move;
    const info = S.info;
    if (!info || info.kind === 'cpu' || !settings.best || info.ply !== shownPly() || (live() && S.result)) return null;
    if (live() && !isHumanColor(pos.turn)) return null;
    return info.r.move >= 0 ? info.r.move : null;
  }
  function popPiece(pid) {
    if (reduceMotion) return;
    const lp = $('lay-pieces');
    const g = lp && lp.querySelector(`.pc[data-ply="${S.moves.length}"]`);
    if (!g || S.moves[S.moves.length - 1] !== pid) return;
    g.style.transformBox = 'fill-box'; g.style.transformOrigin = 'center';
    g.animate([{ transform: 'scale(1.18)', opacity: 0.4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  // ------------------------------------------------------------------ 対局者
  function renderPlayers() {
    const pos = shownPos(), wrap = $('players');
    wrap.style.setProperty('--np', pos.nc);
    wrap.dataset.np = pos.nc;
    const ev = S.evals[shownPly()], sc = pos.scores();
    let html = '';
    for (let c = 0; c < pos.nc; c++) {
      const turn = pos.turn === c && !(live() && S.result);
      const out = !!(pos.done & (1 << c));
      const left = 21 - countBits(B.ALL & ~pos.rem(c));
      const seat = seatOf(c);
      const tag = S.online && seat.k !== 'cpu' && !seat.cpu ? (seat.ai || seat.hi ? `<span class="tag on" title="AI補助${seat.ai ? 'あり' : 'なし'}・ヒント${seat.hi | 0}回">${[seat.ai ? 'AI補助' : '', seat.hi ? `ヒント${seat.hi}` : ''].filter(Boolean).join('・')}</span>` : '<span class="tag off" title="AI補助なし・ヒントなし">補助なし</span>') : '';
      let evh = '';
      if (settings.showEval && ev && ev.score) {
        const u = ev.util[c], p = Math.max(0, Math.min(100, (u + 1) * 50));
        evh = `<div class="ev"><span class="bar"><i style="width:${p.toFixed(0)}%"></i></span><span class="w">見込み </span><b>${fmtScore(ev.score[c])}</b></div>`;
      } else if (settings.showEval) evh = '<div class="ev">見込み —</div>';
      html += `<div class="pl${turn ? ' turn' : ''}${out ? ' out' : ''}" style="--pc:${colorHex(c)}">
        <span class="gem"></span><span class="nm">${seatLabel(c)}</span>
        <span class="st"><b>${fmtScore(sc[c])}</b><span class="left">・残り${left}</span><span class="lefts" title="残りのピース ${left}個">・${left}</span>${out ? '・終' : ''}${tag}</span>${evh}
        ${turn && S.thinking ? '<i class="think" aria-label="考え中"></i>' : ''}</div>`;
    }
    wrap.innerHTML = html;
  }
  const countBits = x => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
  const fmtScore = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(Math.round(v));

  // ------------------------------------------------------------------ 手持ち
  // 並び: 5マス（12）→ 4マス（5）→ 3・2・1マス
  const TRAY_ORDER = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 9, 4, 5, 6, 7, 8, 2, 3, 1, 0];
  // 手持ちに描く向き（横長で、低いもの）
  const SHOW_ORI = B.PIECE_DEF.map((_, p) => {
    let best = B.PIECE_O0[p], bs = Infinity;
    for (let o = B.PIECE_O0[p]; o < B.PIECE_O0[p] + B.PIECE_ON[p]; o++) { const s = B.O_H[o] * 10 - B.O_W[o]; if (s < bs) { bs = s; best = o; } }
    return best;
  });
  const trayOri = {}; // ピースごとに最後に使った向き
  function miniPiece(o, p, cell = 10) {
    const w = B.O_W[o], h = B.O_H[o], cells = [];
    for (let k = 0; k < B.O_NC[o]; k++) cells.push(B.O_CY[o * 5 + k] * 5 + B.O_CX[o * 5 + k]);
    const g = pieceG(cells, 5, p);
    const svg = `<svg viewBox="${-0.2} ${-0.2} ${w + 0.4} ${h + 0.4}" aria-hidden="true" style="width:calc(var(--cell, ${cell}px) * ${w + 0.4});height:calc(var(--cell, ${cell}px) * ${h + 0.4})">${g.outerHTML}</svg>`;
    return svg;
  }
  // 手持ちを見せる色: 人の色の番ならその色、そうでなければ次に回ってくる人の色（なければ手番の色）
  function trayColor() {
    const pos = S.pos;
    if (!pos) return 0;
    const c = pos.turn;
    if (c >= 0 && isHumanColor(c)) return c;
    for (let i = 1; i <= pos.nc; i++) { const k = ((c < 0 ? 0 : c) + i) % pos.nc; if (isHumanColor(k)) return k; }
    return c >= 0 ? c : 0;
  }
  function renderTray() {
    const wrap = $('tray'), pos = shownPos(), c = live() ? trayColor() : (pos.turn >= 0 ? pos.turn : 0);
    const mine = live() && !S.result && pos.turn === c && isHumanColor(c);
    const p = palOf(S.mode, c), rem = pos.rem(c);
    const can = new Set();
    if (mine) for (const pid of S.legal) can.add(pos.T.P_PC[pid]);
    wrap.style.setProperty('--pc', colorHex(c));
    wrap.classList.toggle('watch', !mine);
    let html = `<div class="tray-head"><span style="color:${colorHex(c)}">■</span><b>${colorName(c)}</b>の手持ち<span class="cnt"> 残り${countBits(rem)}個・${pos.remCells(c)}マス</span><span class="grow">${mine ? (S.sel ? 'なぞって位置を合わせる' : 'ピースを選ぶ') : live() && !S.result ? '相手の番' : ''}</span></div>`;
    for (const pc of TRAY_ORDER) {
      const used = !(rem & (1 << pc));
      const sel = S.sel && S.sel.piece === pc;
      const o = sel ? S.sel.ori : (trayOri[pc] != null ? trayOri[pc] : SHOW_ORI[pc]);
      const cant = mine && !used && !can.has(pc);
      html += `<button class="slot${used ? ' used' : ''}${sel ? ' sel' : ''}${cant ? ' cant' : ''}" data-pc="${pc}"${!mine || used ? ' disabled' : ''} aria-label="${B.PIECE_NAME[pc]}（${B.PIECE_SIZE[pc]}マス）${cant ? '・いまは置けない' : ''}" title="${B.PIECE_NAME[pc]}（${B.PIECE_SIZE[pc]}マス）">${miniPiece(o, p, 9)}</button>`;
    }
    wrap.innerHTML = html;
  }

  // ------------------------------------------------------------------ ピースを持つ・合わせる・回す・置く
  const humanTurn = () => live() && !S.result && isHumanColor(S.pos.turn);
  function selectPiece(pc) {
    if (!humanTurn()) return;
    if (S.sel && S.sel.piece === pc) { deselect(); return; }
    const pos = S.pos;
    let ori = trayOri[pc] != null ? trayOri[pc] : SHOW_ORI[pc];
    // この向きで置けなければ、置ける向きに変える
    if (!S.byOri.has(ori)) {
      for (let o = B.PIECE_O0[pc]; o < B.PIECE_O0[pc] + B.PIECE_ON[pc]; o++) if (S.byOri.has(o)) { ori = o; break; }
    }
    S.sel = { piece: pc, ori };
    trayOri[pc] = ori;
    S.ghost = nearestPlacement(ori, focusPoint()) || centerGhost(ori, focusPoint());
    if (!S.byOri.has(ori)) flash(`${B.PIECE_NAME[pc]}はいま置ける所がありません`);
    render();
  }
  function deselect() { S.sel = null; S.ghost = null; render(); }
  // 影を置く目安: 前の影の位置、なければ自分の色の最後の手、なければ最初のマス
  function focusPoint() {
    const pos = S.pos, n = pos.n, c = pos.turn;
    if (S.ghost && S.sel) { const o = S.sel.ori; return [S.ghost.x + B.O_W[o] / 2, S.ghost.y + B.O_H[o] / 2]; }
    const colors = colorsOf(S.moves);
    for (let i = S.moves.length - 1; i >= 0; i--) if (colors[i] === c) {
      const cells = pos.cellsOf(S.moves[i]);
      let sx = 0, sy = 0;
      for (const k of cells) { sx += k % n + 0.5; sy += ((k / n) | 0) + 0.5; }
      return [sx / cells.length, sy / cells.length];
    }
    const [x, y] = pos.R.starts[c];
    return [x + 0.5, y + 0.5];
  }
  function centerGhost(o, [fx, fy]) {
    const n = S.pos.n, w = B.O_W[o], h = B.O_H[o];
    return { x: Math.max(0, Math.min(n - w, Math.round(fx - w / 2))), y: Math.max(0, Math.min(n - h, Math.round(fy - h / 2))) };
  }
  // 向き o の合法な置き方のうち、目安の点に中心がいちばん近いもの（maxD より遠ければなし）
  function nearestPlacement(o, [fx, fy], maxD = Infinity) {
    const list = S.byOri.get(o);
    if (!list) return null;
    const T = S.pos.T, w = B.O_W[o], h = B.O_H[o];
    let best = null, bd = Infinity;
    for (const pid of list) {
      const cx = T.P_X[pid] + w / 2, cy = T.P_Y[pid] + h / 2, d = (cx - fx) ** 2 + (cy - fy) ** 2;
      if (d < bd) { bd = d; best = pid; }
    }
    if (best == null || bd > maxD * maxD) return null;
    return { x: T.P_X[best], y: T.P_Y[best] };
  }
  // 影を (x, y) へ。吸い付け: 1マス以内に置ける所があればそこへ
  function moveGhost(x, y, snap = settings.snap) {
    if (!S.sel) return;
    const o = S.sel.ori, n = S.pos.n, w = B.O_W[o], h = B.O_H[o];
    x = Math.max(0, Math.min(n - w, x)); y = Math.max(0, Math.min(n - h, y));
    const pid = S.pos.placement(o, x, y);
    if (snap && !(pid >= 0 && S.legalSet.has(pid))) {
      const near = nearestPlacement(o, [x + w / 2, y + h / 2], 1.25);
      if (near) { x = near.x; y = near.y; }
    }
    if (S.ghost && S.ghost.x === x && S.ghost.y === y) return;
    S.ghost = { x, y };
    renderMarks();
  }
  function turnPiece(kind) {
    if (!S.sel) return;
    const o = S.sel.ori, n2 = kind === 'cw' ? B.ORI_ROT[o] : kind === 'ccw' ? B.ORI_ROTL[o] : B.ORI_FLIP[o];
    const [fx, fy] = S.ghost ? [S.ghost.x + B.O_W[o] / 2, S.ghost.y + B.O_H[o] / 2] : focusPoint();
    S.sel.ori = n2; trayOri[S.sel.piece] = n2;
    const g = centerGhost(n2, [fx, fy]);
    const pid = S.pos.placement(n2, g.x, g.y);
    S.ghost = (settings.snap && !(pid >= 0 && S.legalSet.has(pid)) && nearestPlacement(n2, [fx, fy], 2)) || g;
    renderTray(); renderMarks();
  }
  function ghostPid() { return S.sel && S.ghost ? S.pos.placement(S.sel.ori, S.ghost.x, S.ghost.y) : -1; }
  function confirmPlace() {
    const pid = ghostPid();
    if (!humanTurn() || pid < 0 || !S.legalSet.has(pid)) { if (S.sel) flash('そこには置けません（同じ色と辺で接するか、角でつながっていません）'); return; }
    play(pid);
  }

  // 盤の上の指・マウス
  let drag = null;
  function cellAt(e) {
    const svg = $('board'), r = svg.getBoundingClientRect(), n = S.pos.n, span = n + 0.6;
    return [(e.clientX - r.left) / r.width * span - 0.3, (e.clientY - r.top) / r.height * span - 0.3];
  }
  function bindBoard() {
    const svg = $('board');
    svg.addEventListener('pointerdown', e => {
      if (!humanTurn()) return;
      const [fx, fy] = cellAt(e);
      if (!S.sel) {
        // 何も持っていないとき: 光っている角を押したら、そこに置ける大きいピースを持つ
        const n = S.pos.n, cell = Math.floor(fy) * n + Math.floor(fx);
        if (fx >= 0 && fy >= 0 && fx < n && fy < n && S.pos.anchors(S.pos.turn).includes(cell)) pickForAnchor(cell);
        return;
      }
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* 合成のイベントなど */ }
      drag = { id: e.pointerId, fx, fy, gx: S.ghost ? S.ghost.x : 0, gy: S.ghost ? S.ghost.y : 0, moved: false, touch: e.pointerType !== 'mouse', t: Date.now() };
      if (e.pointerType === 'mouse') { moveToPointer(fx, fy); drag.gx = S.ghost.x; drag.gy = S.ghost.y; }
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (!S.sel || !humanTurn()) return;
      const [fx, fy] = cellAt(e);
      if (drag && drag.id === e.pointerId) {
        if (Math.abs(fx - drag.fx) > 0.35 || Math.abs(fy - drag.fy) > 0.35) drag.moved = true;
        if (drag.touch) { if (drag.moved) moveGhost(drag.gx + Math.round(fx - drag.fx), drag.gy + Math.round(fy - drag.fy)); }
        else moveToPointer(fx, fy);
      } else if (e.pointerType === 'mouse') moveToPointer(fx, fy);
    });
    const up = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      const [fx, fy] = cellAt(e);
      if (!d.touch) { if (!d.moved || ghostPid() >= 0) confirmPlace(); return; }
      if (!d.moved) tapAt(fx, fy);
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', () => { drag = null; });
    svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !drag) { /* 影はそのまま */ } });
    svg.addEventListener('wheel', e => { if (!S.sel) return; e.preventDefault(); turnPiece(e.deltaY > 0 ? 'cw' : 'ccw'); }, { passive: false });
    svg.addEventListener('contextmenu', e => { if (!S.sel) return; e.preventDefault(); turnPiece('flip'); });
  }
  function moveToPointer(fx, fy) {
    const o = S.sel.ori;
    moveGhost(Math.round(fx - B.O_W[o] / 2), Math.round(fy - B.O_H[o] / 2));
  }
  // 指で軽く押したとき: 光っている角なら、そこを覆う置き方へ。影の上ならそのまま。ほかはそこへ影を動かす
  function tapAt(fx, fy) {
    const pos = S.pos, n = pos.n, o = S.sel.ori;
    if (fx < 0 || fy < 0 || fx >= n || fy >= n) return;
    const cell = Math.floor(fy) * n + Math.floor(fx);
    const gp = ghostPid();
    if (gp >= 0 && pos.cellsOf(gp).includes(cell)) return;
    const list = (S.byOri.get(o) || []).filter(pid => pos.cellsOf(pid).includes(cell));
    if (list.length) {
      const [gx, gy] = S.ghost ? [S.ghost.x + B.O_W[o] / 2, S.ghost.y + B.O_H[o] / 2] : [fx, fy];
      let best = list[0], bd = Infinity;
      for (const pid of list) { const d = (pos.T.P_X[pid] + B.O_W[o] / 2 - gx) ** 2 + (pos.T.P_Y[pid] + B.O_H[o] / 2 - gy) ** 2; if (d < bd) { bd = d; best = pid; } }
      S.ghost = { x: pos.T.P_X[best], y: pos.T.P_Y[best] };
      renderMarks();
      return;
    }
    moveToPointer(fx, fy);
  }
  // 何も持たずに角を押したとき: その角に置けるピースのうち大きいものを持つ
  function pickForAnchor(cell) {
    const pos = S.pos;
    let best = -1, bs = -1;
    for (const pid of S.legal) {
      if (!pos.cellsOf(pid).includes(cell)) continue;
      const sz = B.PIECE_SIZE[pos.T.P_PC[pid]] * 10 + (trayOri[pos.T.P_PC[pid]] === pos.T.P_ORI[pid] ? 1 : 0);
      if (sz > bs) { bs = sz; best = pid; }
    }
    if (best < 0) return;
    const pc = pos.T.P_PC[best], o = pos.T.P_ORI[best];
    S.sel = { piece: pc, ori: o }; trayOri[pc] = o;
    S.ghost = { x: pos.T.P_X[best], y: pos.T.P_Y[best] };
    render();
  }

  // ------------------------------------------------------------------ 情報の行
  const ICON = {
    ccw: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
    cw: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/></svg>',
    flip: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M9 7 4 12l5 5z"/><path d="M15 7l5 5-5 5z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    sheet: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  };
  const ib = (act, icon, label, extra = '') => `<button class="ibtn${extra}" data-act="${act}" aria-label="${label}" title="${label}">${ICON[icon] || icon}</button>`;
  const btn = (act, label, extra = '') => `<button class="btn small${extra}" data-act="${act}">${label}</button>`;
  const sw = c => `<span class="sw" style="background:${colorHex(c)}"></span>`;
  function moveText(m, c, pos = S.pos) { return `${colorName(c)} ${B.PIECE_NAME[pos.T.P_PC[m]]}`; }
  function renderInfo() {
    const box = $('info'), pos = shownPos();
    if (!box || !pos) return;
    let html = '', tools = '', cls = 'info';
    const c = pos.turn, narrowP = narrow();
    const navTools = narrowP ? ib('prev', 'prev', '1手戻って見る') + ib('sheet', 'sheet', '形勢・記録') : '';
    if (!live()) {
      cls += ' view';
      const colors = colorsOf(S.moves);
      html = `<span class="txt"><b>${S.view}手目</b>${S.view ? ` ${sw(colors[S.view - 1])}${moveText(S.moves[S.view - 1], colors[S.view - 1])}` : '（はじめ）'} を表示中</span>`;
      tools = (narrowP ? ib('prev', 'prev', '1手戻る') + ib('next', 'next', '1手進む') : '') + (S.online ? '' : btn('branch', 'ここから')) + btn('live', '最新へ', ' primary');
    } else if (S.result) {
      cls += ' result';
      html = `<span class="txt"><b>${resultHead()}</b>　<span class="muted">${resultLine()}</span></span>`;
      tools = btn('review', '振り返る') + (S.online ? btn('again', 'もう一局', ' primary') : btn('again', 'もう一局', ' primary'));
    } else if (S.sel && humanTurn()) {
      cls += ' sel';
      const pid = ghostPid(), ok = pid >= 0 && S.legalSet.has(pid), cnt = (S.byOri.get(S.sel.ori) || []).length;
      html = `<span class="txt">${sw(c)}<b>${B.PIECE_NAME[S.sel.piece]}</b>（${B.PIECE_SIZE[S.sel.piece]}マス）<span class="muted">${cnt ? `この向きで${cnt}か所` : 'この向きは置けない'}</span></span>`;
      tools = ib('ccw', 'ccw', '左に回す') + ib('cw', 'cw', '右に回す') + ib('flip', 'flip', '裏返す') + ib('desel', 'close', 'やめる') + `<button class="ibtn ok" data-act="place"${ok ? '' : ' disabled'} aria-label="ここに置く">${ICON.ok}置く</button>`;
    } else if (S.online && window.BKOnline && window.BKOnline.alert()) {
      cls += ' alert';
      html = `<span class="txt">${window.BKOnline.alert()}</span>`;
    } else if (humanTurn()) {
      html = `<span class="txt">${sw(c)}<b>${humans() > 1 ? `${colorName(c)}（${seatLabel(c)}）` : `あなた（${colorName(c)}）`}の番</b>　<span class="muted">手持ちからピースを選ぶ・光る角を押す</span></span>`;
      tools = navTools;
    } else if (c >= 0) {
      const ply = S.moves.length, colors = colorsOf(S.moves);
      const lastTxt = ply ? `直前 ${moveText(S.moves[ply - 1], colors[ply - 1])}` : '';
      html = `<span class="txt">${sw(c)}<b>${colorName(c)}（${seatLabel(c)}）</b>${isCPUColor(c) ? 'が考えています…' : 'の番です'}　<span class="muted">${lastTxt}</span></span>`;
      tools = navTools;
    }
    box.className = cls;
    box.innerHTML = html + `<span class="tools">${tools}</span>`;
  }
  function resultHead() {
    const oc = S.result, P = oc.playerScores.length;
    const winners = oc.rank.map((r, p) => (r === 1 ? p : -1)).filter(p => p >= 0);
    const me = S.seats.findIndex(s => s.k === 'human');
    if (humans() === 1) {
      if (winners.length > 1 && winners.includes(me)) return '引き分け（同点の1位）';
      return winners.includes(me) ? 'あなたの勝ち' : `あなたは${oc.rank[me]}位`;
    }
    if (winners.length > 1) return '同点の1位';
    return `${playerName(winners[0])}の勝ち${P > 2 ? '' : ''}`;
  }
  function playerName(p) {
    const cs = []; for (let c = 0; c < S.pos.nc; c++) if (S.pos.R.owner[c] === p) cs.push(colorName(c));
    const s = S.seats[p];
    const who = s.k === 'cpu' ? 'CPU' : s.k === 'remote' ? (s.name || '相手') : humans() === 1 || S.online ? 'あなた' : `人${p + 1}`;
    return `${cs.join('＋')}（${esc(who)}）`;
  }
  function resultLine() {
    const oc = S.result;
    return oc.playerScores.map((v, p) => `${oc.rank[p]}位 ${playerName(p).replace(/（.*/, '')} ${fmtScore(v)}`).join('・');
  }

  // ------------------------------------------------------------------ 記録（テープ・一覧）と形勢
  function renderTape() {
    const cur = shownPly(), colors = colorsOf(S.moves);
    let html = `<button data-ply="0" class="${cur === 0 ? 'cur' : ''}">はじめ</button>`;
    S.moves.forEach((m, i) => {
      for (const pc of S.passes[i] || []) html += `<button class="pass" data-ply="${i}">${colorName(pc)} パス</button>`;
      html += `<button data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><i style="background:${colorHex(colors[i])}"></i>${B.PIECE_NAME[S.pos.T.P_PC[m]]}</button>`;
    });
    for (const id of ['tape', 'tape-s']) {
      const t = $(id);
      if (!t) continue;
      if (t.dataset.html !== html) { t.innerHTML = html; t.dataset.html = html; }
      const c = t.querySelector('button.cur');
      if (c) t.scrollLeft = c.offsetLeft - t.clientWidth / 2 + c.offsetWidth / 2;
    }
    document.querySelectorAll('[data-nav="first"], [data-nav="prev"]').forEach(b => { b.disabled = cur === 0; });
    document.querySelectorAll('[data-nav="next"], [data-nav="last"]').forEach(b => { b.disabled = live(); });
  }
  function renderKifu() {
    const el2 = $('kifu'), cur = shownPly(), colors = colorsOf(S.moves);
    const rows = [`<li data-ply="0" class="${cur === 0 ? 'cur' : ''}"><span class="no">0</span><span>はじめ</span><span class="ev"></span></li>`];
    S.moves.forEach((m, i) => {
      for (const pc of S.passes[i] || []) rows.push(`<li class="pass" data-ply="${i}"><span class="no"></span><span><i style="background:${colorHex(pc)}"></i>${colorName(pc)}はもう置けない（パス）</span><span></span></li>`);
      const e = S.evals[i + 1], c = colors[i];
      const ev = e && settings.showEval ? `見込み ${fmtScore(e.score[c])}` : '';
      rows.push(`<li data-ply="${i + 1}" class="${cur === i + 1 ? 'cur' : ''}"><span class="no">${i + 1}</span><span><i style="background:${colorHex(c)}"></i>${colorName(c)} ${B.PIECE_NAME[S.pos.T.P_PC[m]]}　<span class="ev">${cellsText(m)}</span></span><span class="ev">${ev}</span></li>`);
    });
    el2.innerHTML = rows.join('');
    const c = el2.querySelector('li.cur');
    if (c) { const top = c.offsetTop, bottom = top + c.offsetHeight; if (top < el2.scrollTop) el2.scrollTop = top; else if (bottom > el2.scrollTop + el2.clientHeight) el2.scrollTop = bottom - el2.clientHeight; }
    $('kifu-info').textContent = `${MODE_NAME[S.mode]}・${S.moves.length}手`;
  }
  const cellsText = m => S.pos.cellsOf(m).map(i => B.cellName(S.pos.n, i)).join(' ');
  function renderEval() {
    const body = $('ev-body'), who = $('ev-who');
    if (!body) return;
    const pos = shownPos(), ply = shownPly(), info = S.info && S.info.ply === ply ? S.info : null, e = S.evals[ply];
    who.textContent = info ? (info.kind === 'cpu' ? 'CPU の読み' : info.kind === 'hint' ? 'ヒント' : '検討') : '';
    if (!e) {
      body.innerHTML = `<p class="hint" style="margin:2px 0">${!NET_OK ? 'AI のネットが読み込めませんでした' : (live() && S.result) ? '終局しました' : aiOn() ? '読んでいます…' : '「AI補助」で読みます'}</p>`;
      return;
    }
    const P = pos.R.players;
    let rows = '';
    for (let c = 0; c < pos.nc; c++) {
      const u = e.util[c];
      const chance = P > 2 ? `順位の見込み ${(1 + (P - 1) * (1 - u) / 2).toFixed(1)}位` : `勝ちの見込み ${Math.round((u + 1) * 50)}%`;
      rows += `<tr><td>${sw(c)}</td><td>${colorName(c)}</td><td style="text-align:right"><b>${fmtScore(e.score[c])}</b>点</td><td style="text-align:right">${chance}</td></tr>`;
    }
    let pv = '';
    if (info && info.r.pv && info.r.pv.length) {
      const p = B.Position.fromMoves(S.mode, S.moves.slice(0, ply)), txt = [];
      for (const m of info.r.pv) { if (!p.legalHas(m)) break; txt.push(moveText(m, p.turn, p)); p.play(m); }
      pv = txt.length ? `<div class="pvline"><span class="k">読み筋</span><b style="color:var(--good)">${txt[0]}</b>${txt.slice(1).map(t => ` → ${t}`).join('')}</div>` : '';
    }
    const meta = info ? `<div class="meta">${info.r.sims.toLocaleString()}回読み・${(info.r.ms / 1000).toFixed(1)}秒・合法手 ${info.r.moves}</div>` : '';
    body.innerHTML = `<table class="evtable">${rows}</table>${pv}${meta}`;
  }
  function renderGraph() {
    const svg = $('graph');
    if (!svg) return;
    const W = 300, H = 110, n = Math.max(S.moves.length, S.mode === 'duo' ? 42 : 84);
    const lo = -60, hi = 20, x = i => i / n * W, y = v => (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 12) + 6;
    let html = `<line class="axis" x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}"/><text x="3" y="${y(0) - 2}">0</text><text x="3" y="${H - 3}">${lo}</text>`;
    const nc = S.pos.nc;
    for (let c = 0; c < nc; c++) {
      const pts = [];
      for (let i = 0; i <= S.moves.length; i++) { const e = S.evals[i]; if (e && e.score) pts.push(`${x(i).toFixed(1)},${y(e.score[c]).toFixed(1)}`); }
      if (pts.length) html += `<polyline points="${pts.join(' ')}" fill="none" stroke="${colorHex(c)}" stroke-width="1.6"/>`;
    }
    const cx = x(shownPly());
    html += `<line class="now" x1="${cx}" y1="0" x2="${cx}" y2="${H}"/>`;
    svg.innerHTML = html;
  }

  // ------------------------------------------------------------------ 画面全体
  const narrow = () => window.matchMedia('(orientation: portrait), (max-width: 699px), (max-height: 500px)').matches;
  function render() {
    document.body.classList.toggle('eval-off', !settings.showEval);
    const side = $('side');
    if (!settings.showEval && side.dataset.tab !== 'kifu') { side.dataset.tab = 'kifu'; side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === 'kifu'))); }
    renderPlayers(); renderBoard(); renderTray(); renderControls(); renderTape(); renderKifu(); renderEval(); renderGraph();
    fitSoon();
  }
  function renderControls() {
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-hint').disabled = !humanTurn() || !NET_OK;
    $('btn-undo').disabled = !!S.online || !S.moves.length || !humans();
  }
  // 盤の大きさ: 縦長は 幅 と「画面の高さ − ほかの行」の小さい方。横長は 高さ と「幅 − パネル」の小さい方
  let fitPending = 0;
  function fitSoon() { if (!fitPending) fitPending = requestAnimationFrame(() => { fitPending = 0; fit(); }); }
  function fit() {
    const play = $('view-play');
    if (!play || play.hidden) return;
    const root = document.documentElement, H = window.innerHeight, Wd = window.innerWidth;
    const avail = H - play.getBoundingClientRect().top - 8;
    const wide = window.matchMedia('(orientation: landscape) and (min-width: 700px)').matches;
    // 手持ちのマスの高さ（画面の高さに合わせて。縦長で盤が幅いっぱいになって余った高さは、手持ちを大きくするのに使う）
    const slotH = Math.round(Math.max(30, Math.min(52, H * 0.056)));
    const curSlot = parseFloat(root.style.getPropertyValue('--slot-h')) || slotH;
    let bw;
    if (wide) {
      root.style.setProperty('--slot-h', slotH + 'px');
      const panelW = Math.min(460, Math.max(300, Wd * 0.34));
      bw = Math.min(avail, Wd - panelW - 18 - 36);
    } else {
      let other = 0, n = 0;
      for (const e of [$('players'), $('info'), $('tray'), document.querySelector('.controls')]) { if (e && e.offsetParent) { other += e.getBoundingClientRect().height; n++; } }
      other += 3 * (slotH - curSlot); // 手持ちの高さは、もとのマスの高さで数える
      const gap = parseFloat(getComputedStyle(play).rowGap) || 6;
      bw = Math.min(play.clientWidth, avail - other - gap * n);
      const spare = avail - other - gap * n - bw;
      const add = spare > 6 ? Math.max(0, Math.min(Math.floor((spare - 4) / 3), 64 - slotH)) : 0;
      if (root.style.getPropertyValue('--slot-h') !== (slotH + add) + 'px') root.style.setProperty('--slot-h', (slotH + add) + 'px');
    }
    bw = Math.max(200, Math.floor(bw));
    if (root.style.getPropertyValue('--bw') !== bw + 'px') root.style.setProperty('--bw', bw + 'px');
    // 手持ちのピースの1マスの大きさ（いちばん長い5マスがマスの幅に、3マスの高さが高さに収まるように）
    const slot = document.querySelector('.tray .slot');
    if (slot) {
      const r = slot.getBoundingClientRect(), cell = Math.max(5, Math.min(14, Math.floor(Math.min(r.width / 5.6, r.height / 3.6) * 10) / 10));
      if ($('tray').style.getPropertyValue('--cell') !== cell + 'px') $('tray').style.setProperty('--cell', cell + 'px');
    }
  }

  // ------------------------------------------------------------------ 見返し・操作
  function viewPly(p) {
    if (p >= S.moves.length) { S.view = null; S.dpos = null; }
    else {
      S.view = Math.max(0, p);
      S.dpos = B.Position.fromMoves(S.mode, S.moves.slice(0, S.view));
      S.dpos.legal();
    }
    S.sel = null; S.ghost = null; S.hint = null; S.info = null;
    render();
    if (live()) schedule(); else { AI.cancel(); S.thinking = false; analyze(); }
  }
  function branch() {
    if (live() || S.online) return;
    AI.cancel();
    const n = S.view;
    loadGame({ mode: S.mode, seats: S.seats, moves: S.moves.slice(0, n), evals: S.evals.slice(0, n + 1) });
  }
  function undo() {
    if (!S.moves.length || S.online || !humans()) return;
    AI.cancel(); clearTimeout(S.timer);
    let n = S.moves.length - 1;
    // CPU の手を飛ばして、人の色の番まで戻す
    const colors = moveColors(S.moves);
    while (n > 0 && !isHumanColor(colors[n])) n--;
    loadGame({ mode: S.mode, seats: S.seats, moves: S.moves.slice(0, n), evals: S.evals.slice(0, n + 1) });
  }
  function flash(text) {
    const m = $('board-msg');
    m.textContent = text; m.hidden = false; m.style.opacity = 1;
    clearTimeout(S.msgTimer);
    S.msgTimer = setTimeout(() => { m.style.opacity = 0; S.msgTimer = setTimeout(() => { m.hidden = true; }, 260); }, 1900);
  }
  function hint() {
    if (!humanTurn() || !NET_OK) return;
    if (S.online && window.BKOnline) window.BKOnline.hint();
    const ply = S.moves.length;
    flash('ヒントを読んでいます…');
    AI.start({ mode: S.mode, moves: S.moves.slice(), kind: 'search', timeMs: HINT_MS, maxSims: 3000 },
      info => onInfo(ply, info, 'hint'),
      r => {
        if (!r || S.moves.length !== ply || !live()) return;
        onInfo(ply, r, 'hint');
        S.hint = { ply, move: r.move };
        // そのピースを、その向き・その位置で持つ（あとは「置く」だけ）
        const T = S.pos.T, pc = T.P_PC[r.move], o = T.P_ORI[r.move];
        S.sel = { piece: pc, ori: o }; trayOri[pc] = o;
        S.ghost = { x: T.P_X[r.move], y: T.P_Y[r.move] };
        render();
      });
  }

  // 記録の書き出し・読み込み
  function kifuText() {
    const lines = [`ブロック陣取り 記録（${MODE_NAME[S.mode]}）`], colors = moveColors(S.moves);
    S.moves.forEach((m, i) => lines.push(`${i + 1} ${colorName(colors[i])} ${B.PIECE_NAME[S.pos.T.P_PC[m]]} ${cellsText(m)}`));
    const sc = S.pos.scores();
    lines.push('得点: ' + sc.map((v, c) => `${colorName(c)} ${fmtScore(v)}`).join('・') + (S.result ? '（終局）' : ''));
    return lines.join('\n');
  }
  function importKifu(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const head = lines.find(l => /ブロック陣取り 記録/.test(l)) || '';
    const mode = Object.keys(MODE_NAME).find(k => head.includes(MODE_NAME[k])) || (/14×14/.test(head) ? 'duo' : /2色ずつ/.test(head) ? 'team' : /4人/.test(head) ? 'classic' : null);
    if (!mode) throw new Error('1行目の「ブロック陣取り 記録（4人（20×20））」が見つかりません');
    const pos = new B.Position(mode), moves = [];
    for (const l of lines) {
      const mm = l.match(/^(\d+)\s+\S+\s+\S+\s+((?:[a-t]\d{1,2}\s*)+)$/);
      if (!mm) continue;
      const cells = mm[2].trim().split(/\s+/).map(s => B.parseCell(pos.n, s));
      const pid = cells.includes(-1) ? -1 : pos.findByCells(cells);
      if (pid < 0 || !pos.legalHas(pid)) throw new Error(`${mm[1]}手目が置けません`);
      pos.play(pid); moves.push(pid);
    }
    cfg.mode = mode;
    loadGame({ mode, seats: Array.from({ length: B.RULES[mode].players }, () => ({ k: 'human' })), moves });
  }

  // ------------------------------------------------------------------ ダイアログ
  let draft = null;
  function openNew() {
    draft = Object.assign({}, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    // 選んでいる間は裏の対局を進めない（CPU も観戦も止める。オンラインの卓はほかの人がいるので止めない）
    if (newPaused()) { AI.cancel(); clearTimeout(S.timer); S.thinking = false; renderPlayers(); renderInfo(); }
    $('ng-start').focus();
  }
  // 「やめる」・背景のタップ・Esc で閉じたら、止めたところから続ける
  function closeNew() {
    if ($('dlg-new').hidden) return;
    $('dlg-new').hidden = true;
    if (!S.online) schedule();
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    // 最後の「オンラインの卓」は遊び方ではなく入口: 押すとすぐオンラインのパネルを開く（いまの対局はそのまま）
    seg('ng-mode', [['classic', '4人（20×20）'], ['team', '2人・2色ずつ'], ['duo', '2人（14×14）'], ['online', 'オンラインの卓']], draft.mode);
    $('ng-mode-hint').textContent = {
      classic: '4色が1人1色。自分の角から広げ、残りのマスが少ない人が勝ち（ふつうの遊び方）',
      team: '20×20 の盤で、1人が向かい合う2色（青＋赤 / 黄＋緑）を受け持つ。2色の合計で勝ち負け',
      duo: '14×14 の小さな盤で1人1色。決められたマス（5-5・10-10）から始める',
    }[draft.mode];
    seg('ng-opp', [['cpu', 'CPUと対局'], ['pvp', 'みんなで（1台で交代）'], ['watch', 'CPUどうしを観戦']], draft.opp);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc + (NET_OK ? '' : '（AI のネットが読み込めないので、どの段も「大きいピースから」で打ちます）') : '';
    const cs = draft.mode === 'duo' ? [['0', '青（先手）', 0], ['1', '赤（後手）', 2]]
      : draft.mode === 'team' ? [['0', '青＋赤（先手）', 0], ['1', '黄＋緑', 1]]
        : [['0', '青（最初）', 0], ['1', '黄', 1], ['2', '赤', 2], ['3', '緑', 3]];
    $('ng-side').innerHTML = cs.map(([v, l, p]) => `<button type="button" data-v="${v}" aria-pressed="${String(draft.side) === v}"><span class="sw" style="background:${PAL[p].base}"></span>${l}</button>`).join('') + `<button type="button" data-v="random" aria-pressed="${draft.side === 'random'}">ランダム</button>`;
    if (draft.side !== 'random' && Number(draft.side) >= cs.length) draft.side = '0';
    $('ng-cpu-field').hidden = draft.opp === 'pvp';
    $('ng-side-field').hidden = draft.opp !== 'cpu';
  }
  function showResult() {
    const oc = S.result;
    if (!oc) return;
    $('rs-sub').textContent = `${MODE_NAME[S.mode]}・${S.moves.length}手${S.online ? '・オンライン' : ''}`;
    $('rs-title').textContent = resultHead();
    const P = oc.playerScores.length, order = Array.from({ length: P }, (_, p) => p).sort((a, b) => oc.rank[a] - oc.rank[b]);
    const me = S.seats.findIndex(s => s.k === 'human');
    $('rs-table').innerHTML = order.map(p => {
      const cs = []; for (let c = 0; c < S.pos.nc; c++) if (S.pos.R.owner[c] === p) cs.push(c);
      const rem = cs.reduce((a, c) => a + S.pos.remCells(c), 0);
      return `<tr class="${p === me && humans() === 1 ? 'me' : ''}"><td class="r">${oc.rank[p]}</td><td>${cs.map(c => sw(c)).join('')}${playerName(p)}</td><td class="hint">残り${rem}マス</td><td class="s">${fmtScore(oc.playerScores[p])}</td></tr>`;
    }).join('');
    const cpuTxt = S.seats.some(s => s.k === 'cpu') ? `CPU は「${CPU[(S.seats.find(s => s.k === 'cpu') || {}).lv] ? CPU[S.seats.find(s => s.k === 'cpu').lv].label : ''}」でした。` : '';
    $('rs-body').textContent = `得点 = 残ったマスの数だけ −1、全部置けたら +15（最後が1マスなら さらに +5）。${cpuTxt}`;
    $('rs-again').textContent = S.online ? 'もう一局' : 'もう一局';
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  function docTabs(view, key, tabs) {
    return `<div class="doctabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-doc="${k}" aria-selected="${k === key}">${l}</button>`).join('')}</div>`;
  }
  // 小さな盤の図（cells: [x, y, 色] の並び。marks: [x, y, 'ok'|'ng'] の並び）
  function fig(n, pieces, marks = []) {
    let s = `<svg viewBox="-0.2 -0.2 ${n + 0.4} ${n + 0.4}"><rect x="-0.2" y="-0.2" width="${n + 0.4}" height="${n + 0.4}" rx=".3" fill="url(#g-board)"/>`;
    let d = ''; for (let i = 1; i < n; i++) d += `M${i} 0V${n}M0 ${i}H${n}`;
    s += `<path d="${d}" stroke="var(--grid)" stroke-width=".04"/>`;
    for (const [cells, p] of pieces) s += pieceG(cells.map(([x, y]) => y * n + x), n, p).outerHTML;
    for (const [x, y, k] of marks) s += k === 'ok' ? `<circle cx="${x}" cy="${y}" r=".32" fill="none" stroke="var(--good)" stroke-width=".12"/>` : `<path d="M${x - 0.28} ${y - 0.28}L${x + 0.28} ${y + 0.28}M${x + 0.28} ${y - 0.28}L${x - 0.28} ${y + 0.28}" stroke="var(--bad)" stroke-width=".14" stroke-linecap="round"/>`;
    return s + '</svg>';
  }
  let rulesTab = 'basic';
  function renderRules() {
    const v = $('view-rules');
    const tabs = [['basic', '基本'], ['touch', 'つなぎ方'], ['pieces', 'ピース'], ['score', '得点'], ['play', '操作']];
    let body = '';
    if (rulesTab === 'basic') {
      body = `<div class="card"><h3>ブロック陣取りとは</h3>
        <p>1〜5マスのいろいろな形のピース（各色21個・全部で89マス）を盤に置いて、自分の色の陣地を広げるゲームです。<b>同じ色のピースは角だけで接し、辺では接してはいけません</b>。置ける所がなくなった色はパス。全員が置けなくなったら終わりで、<b>手元に残ったマスが少ないほど勝ち</b>です。</p>
        <ul><li><b>4人（20×20）</b>: 青→黄→赤→緑の順に1つずつ置く。最初の1手は、自分の色の<b>盤の角のマス</b>を覆うように置く</li>
        <li><b>2人・2色ずつ（20×20）</b>: 1人が向かい合う2色（青＋赤 / 黄＋緑）を受け持つ。順番は4人と同じ。2色の得点の合計で勝ち負け</li>
        <li><b>2人（14×14）</b>: 1人1色。最初の1手は決められたマス（青は 5-5、赤は 10-10）を覆う</li>
        <li>ピースは回しても裏返してもよい。ほかの色とは、辺で接しても重ならなければよい</li>
        <li>置ける所が1つでもあれば、置かなければならない（自分からパスはできない）</li></ul></div>`;
    } else if (rulesTab === 'touch') {
      const ok1 = fig(6, [[[[1, 1], [2, 1], [1, 2]], 0], [[[2, 3], [3, 3], [2, 4]], 0]], [[2, 3, 'ok']]);
      const ng1 = fig(6, [[[[1, 1], [2, 1], [1, 2]], 0], [[[3, 1], [4, 1], [4, 2]], 0]], [[3, 1.5, 'ng']]);
      const ok2 = fig(6, [[[[1, 1], [2, 1], [1, 2]], 0], [[[3, 1], [3, 2], [4, 2]], 1]], [[3, 1.5, 'ok']]);
      body = `<div class="card"><h3>つなぎ方</h3>
        <div class="figs"><figure class="ok">${ok1}<b>○ 角で接する</b>同じ色は角だけで</figure><figure class="ng">${ng1}<b>× 辺で接する</b>同じ色はだめ</figure><figure class="ok">${ok2}<b>○ ほかの色</b>辺で接してよい</figure></div>
        <ul><li>2手目からは、<b>自分の色のどれかのピースと角で接する</b>ように置く（角で1か所でもつながればよい）</li>
        <li>同時に、<b>自分の色のピースと辺で接してはいけない</b></li>
        <li>画面では、いま置ける角が<b>光る点</b>で出ます。ピースを持つと、その向きで使える角だけが明るくなります</li></ul></div>`;
    } else if (rulesTab === 'pieces') {
      body = `<div class="card"><h3>ピース（各色21個）</h3><div class="pcs">${TRAY_ORDER.slice().reverse().map(p => `<div>${miniPiece(SHOW_ORI[p], p % 4, 9)}<span>${B.PIECE_NAME[p]}</span></div>`).join('')}</div>
        <p class="hint">1マス1個・2マス1個・3マス2個・4マス5個・5マス12個。名前は形の数学の呼び名（I・L・T・V・W・X・Y・Z・F・N・P・U・O・S）</p></div>`;
    } else if (rulesTab === 'score') {
      body = `<div class="card"><h3>得点</h3><ul>
        <li>残ったピースの<b>マスの数だけ −1</b> 点</li>
        <li>21個<b>全部置けたら +15</b> 点。さらに<b>最後に置いたのが1マスのピースなら +5</b> 点（合計 +20）</li>
        <li>得点の多い順に順位。同点は同じ順位。2人・2色ずつは2色の合計で比べる</li></ul>
        <p class="hint">この得点の数え方（残りのマスを引く・全部置けたら +15・最後が1マスなら +5）を採用しました。ふつうに数えるより、終盤まで「どのピースを残すか」に意味が出ます。</p></div>`;
    } else {
      body = `<div class="card"><h3>操作</h3><ul>
        <li><b>スマホ</b>: 手持ちのピースを押す → 盤の上に影が出る → 盤の上を<b>指でなぞって</b>位置を合わせる（指で隠れないよう、なぞった分だけ動きます。置ける所に吸い付きます）→ ⟲ ⟳ で回す・⇋ で裏返す → <b>「✓置く」</b></li>
        <li>何も持たずに<b>光る角を押す</b>と、そこに置ける大きいピースを持ちます。影が出ているときに光る角を押すと、その角を覆う位置へ動きます</li>
        <li><b>パソコン</b>: ピースを選んでマウスを動かすと影がついてくる。<b>ホイールで回す</b>・<b>右クリックで裏返す</b>・クリックで置く。キー: R/E で回す、F で裏返す、矢印で動かす、Enter で置く、Esc でやめる</li>
        <li>置けない位置では影が薄く、赤い点線になります</li>
        <li>AI補助: 各色の<b>見込みの得点</b>と、順位・勝ちの見込み（バー）、<b>おすすめの一手</b>（盤に点線）。ヒントを押すと、AI のおすすめのピースをその位置で持ちます</li></ul></div>`;
    }
    v.innerHTML = docTabs(v, rulesTab, tabs) + body;
  }
  let aiTab = 'how';
  function renderAIPage() {
    const v = $('view-ai'), W = NET_OK ? BLOCKS_WEIGHTS : null;
    const tabs = [['how', 'しくみ'], ['strength', '強さ'], ['levels', 'CPU の段']];
    let body = '';
    if (aiTab === 'how') {
      body = `<div class="card"><h3>AI は全部自作・自己対局だけ</h3>
        <p>この AI は、人の対局の記録・既存のブロック陣取りの AI・人が考えた評価を<b>一切使っていません</b>。知っているのはルールだけ。でたらめに置くネットが、<b>自分自身との対局（自己対局）だけ</b>で強くなりました（AlphaZero 型）。</p>
        <ul><li><b>ネット</b>: 盤を「手番の色が自分」になるように回して読み、<b>置き方ごとの良さ（方策）</b>と、<b>色ごとの最終の得点・順位の見込み</b>を出す（残差ネット ${W ? `${W.blocks}ブロック×${W.ch}チャンネル` : ''}）</li>
        <li><b>読み</b>: 多人数の木探索。どの局面でも、手番の色は「自分の見込み」が上がる手を選ぶ（ほかの色もそれぞれ自分のために打つと考える）</li>
        <li><b>学習</b>: 自己対局（4人・2色ずつ・14×14 をまぜる）で、読んだ結果の手の選び方と、最後の得点・順位をネットに覚えさせる。これをくり返す</li>
        <li>ブラウザでは、ネットの計算を WebAssembly（SIMD）で行い、CPU の読みは Web Worker（最強は複数）で動かします</li></ul>
        ${W ? `<p class="hint">いまのネット: 第${W.gen || '?'}世代・${W.note ? esc(W.note) + '・' : ''}${esc((W.time || '').slice(0, 10))}</p>` : '<p class="hint">ネット（js/weights.js）が読み込めませんでした。CPU はどの段も「大きいピースから」で打ちます。</p>'}</div>`;
    } else if (aiTab === 'strength') {
      const st = W && W.strength;
      body = `<div class="card"><h3>強さの記録</h3>${st && st.html ? st.html : '<p class="hint">まだ記録がありません（README の「強さの記録」を見てください）。</p>'}
        <p class="hint">強さは、AI の段や過去の世代、自作の基準（でたらめ・大きいピースから）と卓を組んで、平均順位・平均得点と誤差で測っています。人間に勝てるかは、オンラインの成績でも見ていきます。</p></div>`;
    } else {
      body = `<div class="card"><h3>CPU の段</h3><div class="tbl"><table class="lv"><tr><th>段</th><th>考え方</th></tr>${CPU_KEYS.map(k => `<tr><td>${'★'.repeat(CPU[k].stars)} ${CPU[k].label}</td><td>${CPU[k].desc}</td></tr>`).join('')}</table></div>
        <p class="hint">最強は、端末のスレッド（最大4つ）で別々に読んで、読んだ回数を足し合わせます。端末が速いほど強くなります。</p></div>`;
    }
    v.innerHTML = docTabs(v, aiTab, tabs) + body;
  }

  // ------------------------------------------------------------------ 振り返りパネル（狭い画面: 下からせり上がる）
  function placeSheet() {
    const fr = $('board-wrap').getBoundingClientRect(), h = window.innerHeight;
    $('side').style.setProperty('--sheet-top', Math.round(Math.min(h * 0.62, Math.max(h * 0.28, fr.bottom - fr.height * 0.25))) + 'px');
  }
  function openSheet(tab) {
    const side = $('side');
    if (!settings.showEval && (tab === 'ev' || tab === 'graph')) tab = 'kifu';
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return;
    placeSheet();
    side.classList.add('open');
    renderKifu(); renderTape(); renderGraph();
  }
  const closeSheet = () => $('side').classList.remove('open');

  function setSetting(k, v, quiet) {
    settings[k] = v; store.set('settings', settings);
    const box = { showEval: 'set-eval', best: 'set-best', anchors: 'set-anchors', snap: 'set-snap', sound: 'set-sound' }[k];
    if (box) $(box).checked = v;
    if (k === 'dark') document.documentElement.dataset.theme = v ? 'dark' : 'light';
    if (quiet) return;
    if ((k === 'showEval' || k === 'best') && window.BKOnline) window.BKOnline.setAI(aiFlags());
    if ((k === 'showEval' || k === 'best') && !S.thinking) analyze();
    render();
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      if (b.dataset.tab === 'rules') renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') { render(); }
    }));
    $('view-rules').addEventListener('click', e => { const t = e.target.closest('[data-doc]'); if (t) { rulesTab = t.dataset.doc; renderRules(); } });
    $('view-ai').addEventListener('click', e => { const t = e.target.closest('[data-doc]'); if (t) { aiTab = t.dataset.doc; renderAIPage(); } });
    bindBoard();
    $('tray').addEventListener('click', e => {
      const b = e.target.closest('.slot');
      if (!b || b.disabled) return;
      selectPiece(Number(b.dataset.pc));
    });
    $('info').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === 'ccw' || act === 'cw' || act === 'flip') turnPiece(act);
      else if (act === 'desel') deselect();
      else if (act === 'place') confirmPlace();
      else if (act === 'live') viewPly(S.moves.length);
      else if (act === 'branch') branch();
      else if (act === 'review') viewPly(0);
      else if (act === 'again') { if (S.online && window.BKOnline) window.BKOnline.again(); else startGame(cfg); }
      else if (act === 'prev') viewPly(shownPly() - 1);
      else if (act === 'next') viewPly(shownPly() + 1);
      else if (act === 'sheet') { if ($('side').classList.contains('open')) closeSheet(); else openSheet(settings.showEval ? 'ev' : 'kifu'); }
    });
    const nav = e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const n = b.dataset.nav;
      if (n === 'first') viewPly(0);
      else if (n === 'prev') viewPly(shownPly() - 1);
      else if (n === 'next') viewPly(shownPly() + 1);
      else if (n === 'last') viewPly(S.moves.length);
      else if (b.dataset.ply != null) viewPly(Number(b.dataset.ply));
    };
    $('navrow').addEventListener('click', nav);
    $('navrow-s').addEventListener('click', nav);
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); setSetting('showEval', on, true); setSetting('best', on); });
    $('btn-hint').addEventListener('click', hint);
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-panel').addEventListener('click', () => openSheet(settings.showEval ? 'ev' : 'kifu'));
    $('btn-resign').remove();
    $('btn-copy').addEventListener('click', () => {
      const text = kifuText();
      try { navigator.clipboard.writeText(text).then(() => flash('記録をコピーしました'), () => prompt('記録', text)); } catch (e) { prompt('記録', text); }
    });
    $('btn-import').addEventListener('click', () => { $('im-msg').textContent = ''; $('dlg-import').hidden = false; $('im-text').focus(); });
    $('im-cancel').addEventListener('click', () => { $('dlg-import').hidden = true; });
    $('im-ok').addEventListener('click', () => { try { importKifu($('im-text').value); $('dlg-import').hidden = true; } catch (err) { $('im-msg').textContent = err.message; } });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.result && !confirm('オンラインの卓の途中です。新しい対局を始めると卓を離れます（あなたの席は CPU が引き継ぎます）。よろしいですか？')) return;
      openNew();
    });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    [['set-eval', 'showEval'], ['set-best', 'best'], ['set-anchors', 'anchors'], ['set-snap', 'snap'], ['set-sound', 'sound']].forEach(([id, k]) => {
      const e2 = $(id); e2.checked = settings[k]; e2.addEventListener('change', () => setSetting(k, e2.checked));
    });
    const dk = $('set-dark');
    dk.checked = settings.dark != null ? settings.dark : window.matchMedia('(prefers-color-scheme: dark)').matches;
    dk.addEventListener('change', () => setSetting('dark', dk.checked));
    $('side').addEventListener('click', e => {
      const t = e.target.closest('[data-st]');
      if (t) { openSheet(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
    });
    $('kifu').addEventListener('click', e => { const li = e.target.closest('li'); if (li) viewPly(Number(li.dataset.ply)); });
    $('graph').addEventListener('click', e => {
      const r = $('graph').getBoundingClientRect(), n = Math.max(S.moves.length, S.mode === 'duo' ? 42 : 84);
      viewPly(Math.max(0, Math.min(S.moves.length, Math.round((e.clientX - r.left) / r.width * n))));
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v2 = b.dataset.v;
        if (id === 'ng-mode' && v2 === 'online') {
          // オンラインの卓: 上の丸いボタンを押したのと同じ（卓に着くまで、いまの対局はそのまま続く）
          closeNew();
          if (window.BKOnline) window.BKOnline.open();
          return;
        }
        if (id === 'ng-mode') draft.mode = v2;
        else if (id === 'ng-opp') draft.opp = v2;
        else if (id === 'ng-cpu') draft.cpu = v2;
        else if (id === 'ng-side') draft.side = v2;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) closeNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; startGame(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; if (S.online && window.BKOnline) window.BKOnline.again(); else startGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; viewPly(0); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); closeNew(); ['dlg-result', 'dlg-import', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel) deselect(); return; }
      const tg = e.target && e.target.closest ? e.target : document.body;
      if (tg.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if (S.sel && humanTurn()) {
        const k = e.key.toLowerCase();
        if (k === 'r') { e.preventDefault(); turnPiece(e.shiftKey ? 'ccw' : 'cw'); return; }
        if (k === 'e') { e.preventDefault(); turnPiece('ccw'); return; }
        if (k === 'f') { e.preventDefault(); turnPiece('flip'); return; }
        if (k === 'enter' || k === ' ') { e.preventDefault(); confirmPlace(); return; }
        const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
        if (d && S.ghost) { e.preventDefault(); moveGhost(S.ghost.x + d[0], S.ghost.y + d[1], false); return; }
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); viewPly(shownPly() - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); viewPly(shownPly() + 1); }
      if (e.key === 'Home') { e.preventDefault(); viewPly(0); }
      if (e.key === 'End') { e.preventDefault(); viewPly(S.moves.length); }
    });
    window.addEventListener('resize', () => { fitSoon(); renderInfo(); if ($('side').classList.contains('open')) placeSheet(); });
  }

  // ------------------------------------------------------------------ オンラインの卓（js/online-blocks.js）とのつなぎ
  window.BlocksApp = {
    S, B, CPU, CPU_KEYS, PAL, palOf, MODE_NAME, settings, store, esc, $, aiFlags, aiOn,
    render, flash, colorName, colorHex,
    // 卓の状態を受け取る: { mode, seats（自分から見た席: human/cpu/remote）, moves }
    syncOnline(st) {
      const seatsChanged = JSON.stringify(S.seats) !== JSON.stringify(st.seats);
      const sameGame = S.online && st.online && S.online.game === st.online.game && S.mode === st.mode;
      // 自分が置いたばかりの手がまだ卓の状態に入っていない（手元が先）なら、手元のまま待つ
      const behind = st.moves.length <= S.moves.length && st.moves.every((m, i) => S.moves[i] === m);
      const ahead = st.moves.length >= S.moves.length && S.moves.every((m, i) => st.moves[i] === m);
      S.seats = st.seats;
      if (!sameGame || !(behind || ahead)) {
        S.online = st.online;
        $('dlg-new').hidden = true; $('dlg-result').hidden = true;
        loadGame({ mode: st.mode, seats: st.seats, moves: st.moves, online: st.online, resultShown: st.resultShown });
        return;
      }
      S.online = st.online;
      let added = false;
      for (let i = S.moves.length; i < st.moves.length; i++) {
        const m = st.moves[i];
        if (!S.legalSet.has(m)) { loadGame({ mode: st.mode, seats: st.seats, moves: st.moves, online: st.online }); return; }
        AI.cancel(); clearTimeout(S.timer);
        const c = S.pos.turn;
        S.pos.play(m); S.moves.push(m);
        clack('place');
        afterChange({ pid: m, color: c });
        added = true;
      }
      if (!added) { render(); if (seatsChanged) schedule(); }
    },
    leaveOnline() {
      S.online = null;
      S.seats = S.seats.map(s => (s.k === 'remote' ? { k: 'cpu', lv: cfg.cpu } : s));
      saveGame(); render(); schedule();
    },
    startLocal() { startGame(cfg); },
  };

  bind();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitSoon());
  const saved = store.get('game', null);
  if (saved && B.RULES[saved.mode] && Array.isArray(saved.moves) && Array.isArray(saved.seats)) {
    try { loadGame(saved); } catch (e) { startGame(cfg); }
  } else {
    // はじめて開いたときは対局の設定から（招待リンクでオンラインの卓に来たときは出さない）
    startGame(cfg);
    let joining = false;
    try { joining = !!new URLSearchParams(location.search).get('table') || !!JSON.parse(sessionStorage.getItem('blocks-online') || 'null'); } catch (e) { /* 無視 */ }
    if (!joining) openNew();
  }
})();
