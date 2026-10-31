/* ヨットの画面: 点数表・サイコロ・CPU の進行・AI補助・ダイアログ・遊び方と AI のページ
 * オンラインの卓（js/online-table.js）は window.YachtApp を通して、この画面に卓の状態を流し込む
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const Y = window.YachtCore, AI = window.YachtAI;
  Y.loadTable(window.YACHT_TABLE, window.YACHT_SD);
  if (window.YACHT_WEIGHTS) { try { AI.setNet(window.YACHT_WEIGHTS); } catch (e) { console.error(e); } }
  const NCAT = Y.NCAT, CATS = Y.CATS, LV = AI.LEVELS, LV_KEYS = AI.LEVEL_KEYS;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('yacht-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('yacht-' + k, JSON.stringify(v)); } catch (e) { /* 覚えられないときはこのページだけ */ } },
  };
  const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const settings = Object.assign({ ai: true, values: true, best: true, sound: true, anim: true, fast: false, confirm: true }, store.get('settings', {}));
  let cfg = Object.assign({ mode: 'cpu', n: 2, cpu: 'strong', order: 'first', watch: ['best', 'strong', 'normal', 'easy'] }, store.get('cfg', {}));
  const OPTIMAL = Y.tableValue(0, 0);
  const ROWS = [0, 1, 2, 3, 4, 5, 'sub', 6, 7, 8, 9, 10, 11, 'tot'];
  const RULE = ['1の合計', '2の合計', '3の合計', '4の合計', '5の合計', '6の合計', '5個の合計', '4個の合計', '5個の合計', '30点', '30点', '50点'];
  const MODES = [['solo', 'ひとりで'], ['cpu', 'CPUと対戦'], ['local', 'みんなで（1台）'], ['watch', 'CPUどうしを観戦'], ['online', 'オンラインの卓']];
  const MODE_HINT = {
    solo: `12回の手番で何点取れるかの点数アタック。理論上の最善（AI）の期待値は ${OPTIMAL.toFixed(1)}点です。`,
    cpu: 'あなたと CPU で順に振り、最後の合計点が一番多い人の勝ちです。',
    local: '1台の端末を順に回して遊びます（2〜4人）。',
    watch: 'CPU どうしの対局を見ます。AI の読み（勝つ確率）も見られます。',
    online: '選ぶとオンラインの卓の画面を開きます（今の対局はそのまま）。',
  };

  // ------------------------------------------------------------------ 音（Web Audio。共通の元栓 ../common/mute.js を通る）
  const Sound = (() => {
    let ctx = null;
    const ok = () => settings.sound;
    function ensure() {
      if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { ctx = new C(); } catch (e) { return null; } }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function noise(t, dur, freq, q, vol) {
      const c = ctx, len = Math.max(1, Math.floor(c.sampleRate * dur));
      const b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const s = c.createBufferSource(); s.buffer = b;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = vol;
      s.connect(f); f.connect(g); g.connect(c.destination); s.start(t);
    }
    function tone(t, freq, dur, vol, type) {
      const c = ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    }
    return {
      unlock() { if (ok()) ensure(); },
      rattle(sec) {
        if (!ok() || !ensure()) return;
        const t = ctx.currentTime;
        for (let i = 0; i < 9; i++) noise(t + Math.random() * sec * 0.8, 0.025, 1600 + Math.random() * 2600, 2.5, 0.22);
        for (let i = 0; i < 3; i++) noise(t + sec * (0.82 + i * 0.05), 0.03, 900 + Math.random() * 700, 4, 0.3);
      },
      tick() { if (!ok() || !ensure()) return; noise(ctx.currentTime, 0.018, 3200, 6, 0.25); },
      write(big) {
        if (!ok() || !ensure()) return;
        const t = ctx.currentTime;
        noise(t, 0.07, 5200, 1.2, 0.08); noise(t + 0.06, 0.05, 4200, 1.2, 0.06);
        if (big) [523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(t + 0.08 + i * 0.09, f, 0.35, 0.09, 'triangle'));
      },
      turn() { if (!ok() || !ensure()) return; const t = ctx.currentTime; tone(t, 784, 0.12, 0.05); tone(t + 0.1, 988, 0.16, 0.05); },
      end(win) { if (!ok() || !ensure()) return; const t = ctx.currentTime; (win ? [523.3, 659.3, 784, 1046.5, 1318.5] : [392, 349.2, 329.6]).forEach((f, i) => tone(t + i * 0.12, f, 0.4, 0.08, 'triangle')); },
    };
  })();

  // ------------------------------------------------------------------ サイコロの絵（自作の SVG。1の目は赤く大きい）
  const PIPS = { 1: [[50, 50]], 2: [[27, 27], [73, 73]], 3: [[27, 27], [50, 50], [73, 73]], 4: [[27, 27], [73, 27], [27, 73], [73, 73]], 5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]], 6: [[27, 24], [73, 24], [27, 50], [73, 50], [27, 76], [73, 76]] };
  const pipsSVG = v => (v ? PIPS[v].map(([x, y]) => `<circle class="pip${v === 1 ? ' one' : ''}" cx="${x}" cy="${y}" r="${v === 1 ? 14 : 9.5}"/>`).join('') : '');
  const dieSVG = v => `<svg class="dsvg" viewBox="0 0 100 100" aria-hidden="true"><rect class="body" x="5" y="5" width="90" height="90" rx="20"/>${pipsSVG(v)}</svg>`;
  const facesSVG = arr => `<span class="faces">${arr.map(dieSVG).join('')}</span>`;

  // ------------------------------------------------------------------ 状態
  // S.seats[i] = { kind: 'me'|'human'|'cpu'|'remote', name, level }。S.g は yacht-core の対局（JSON にできる）
  let S = null;
  let timer = 0, anim = null;
  const isOnline = () => !!(S && S.online);
  const seatOf = i => S.seats[i];
  function myInput() {
    if (!S || S.view != null || S.g.over || anim) return false;
    if (S.online) return S.g.cur === S.online.me && S.online.canAct();
    const k = seatOf(S.g.cur).kind;
    return k === 'me' || k === 'human';
  }
  const meIndex = () => (S.online ? S.online.me : S.seats.findIndex(s => s.kind === 'me'));
  const humanCount = () => S.seats.filter(s => s.kind === 'me' || s.kind === 'human').length;
  const nameOf = i => (S.seats[i].kind === 'cpu' && S.mode !== 'watch' && !S.online ? S.seats[i].name : S.seats[i].name);
  const levelText = i => (S.seats[i].kind === 'cpu' ? `CPU（${(LV[S.seats[i].level] || {}).label || ''}）` : '');
  const paused = () => !$('dlg-new').hidden;

  function newGameFrom(c) {
    clearTimeout(timer);
    const mode = c.mode === 'online' ? 'cpu' : c.mode;
    const n = mode === 'solo' ? 1 : Math.max(2, Math.min(4, c.n | 0));
    let seats;
    if (mode === 'solo') seats = [{ kind: 'me', name: 'あなた' }];
    else if (mode === 'local') seats = [...Array(n)].map((_, i) => ({ kind: 'human', name: `P${i + 1}` }));
    else if (mode === 'watch') {
      seats = [...Array(n)].map((_, i) => { const l = c.watch[i] || 'strong'; return { kind: 'cpu', level: l, name: LV[l].label }; });
      seats.forEach((s, i) => { if (seats.filter(x => x.name === s.name).length > 1) s.name += i + 1; });
    } else {
      const me = c.order === 'first' ? 0 : c.order === 'last' ? n - 1 : Math.floor(Math.random() * n);
      let k = 0;
      seats = [...Array(n)].map((_, i) => (i === me ? { kind: 'me', name: 'あなた' } : { kind: 'cpu', level: c.cpu, name: n > 2 ? `CPU${++k}` : 'CPU' }));
    }
    S = { mode, seats, g: Y.newGame(n), seed: (Math.random() * 4294967296) >>> 0, hist: [], hints: 0, meta: [], pend: -1, view: null, adv: null, hintOn: false, cpu: null, resultShown: false };
    $('dlg-result').hidden = true;
    save();
    renderAll();
    onTurnStart();
  }
  function save() {
    if (!S || S.online) return;
    store.set('game', { mode: S.mode, seats: S.seats, g: S.g, seed: S.seed, hist: S.hist.slice(-3), hints: S.hints, meta: S.meta });
  }
  function restore() {
    const s = store.get('game', null);
    if (!s || !s.g || !s.seats || s.g.n !== s.seats.length) return false;
    S = Object.assign({ pend: -1, view: null, adv: null, hintOn: false, cpu: null, resultShown: !!s.g.over }, s);
    if (S.g.rolls > 0 && seatOf(S.g.cur).kind === 'cpu') { S.g.rolls = 0; S.g.dice = [0, 0, 0, 0, 0]; S.g.hold = 0; } // CPU は手番の始めからやり直す（同じ目が出る）
    return true;
  }

  // ------------------------------------------------------------------ 手番の進行
  function onTurnStart() {
    S.pend = -1; S.cpu = null; S.hintOn = false;
    if (S.g.over) { renderAll(); return; }
    warm();
    if (myInput() && humanCount() + (S.online ? 1 : 0) >= 1 && S.g.n > 1) Sound.turn();
    schedule();
  }
  // 終盤の正確な分布を、手のすいているときに少しずつ先に計算する（CPU の番や AI補助で固まらないように）
  let warmT = 0;
  function warm() {
    clearTimeout(warmT);
    if (!S || S.g.n < 2 || S.g.over) return;
    const tasks = AI.warmTasks(S.g.sheets);
    let i = 0;
    const step = () => {
      const t0 = performance.now();
      while (i < tasks.length && performance.now() - t0 < 15) { AI.remDist(tasks[i][0], tasks[i][1]); i++; }
      if (i < tasks.length) warmT = setTimeout(step, anim ? 120 : 25);
    };
    warmT = setTimeout(step, 200);
  }
  function schedule(delay) {
    clearTimeout(timer);
    if (!S || paused() || S.g.over || S.view != null || S.online || anim) return;
    if (seatOf(S.g.cur).kind !== 'cpu') return;
    timer = setTimeout(cpuStep, delay != null ? delay : cpuDelay('start'));
  }
  const cpuDelay = k => {
    const f = settings.fast ? 0.35 : 1;
    return Math.round(f * ({ start: 500, hold: 520, pick: 650, roll: 380 }[k] || 400));
  };
  // CPU の1手番を、振る → 残す → 振る → … → 役を選ぶ → 記入 の小さな段に分けて進める
  function cpuStep() {
    if (!S || paused() || S.g.over || S.online) return;
    const g = S.g, seat = g.cur, lv = seatOf(seat).level;
    if (!S.cpu) S.cpu = { plan: AI.plan(g.sheets, seat, lv), rnd: Y.rng(Y.hash32(S.seed, seat, g.round, 999)), stage: 'roll' };
    const C = S.cpu;
    if (C.stage === 'roll') {
      C.stage = 'decide';
      doRoll(Y.seededRoll(S.seed, seat, g.round, g.rolls)).then(() => schedule(cpuDelay('roll')));
      return;
    }
    const d = Y.dIndex(g.dice);
    if (C.stage === 'decide') {
      if (g.rolls < 3) {
        const k = AI.decideKeep(C.plan, d, 3 - g.rolls, lv, C.rnd);
        if (k >= 0) {
          Y.applyHold(g, Y.holdMaskFor(g.dice, k, g.hold));
          Sound.tick();
          C.stage = 'roll';
          renderAll();
          schedule(cpuDelay('hold'));
          return;
        }
      }
      S.pend = AI.decideCat(C.plan, d, lv, C.rnd);
      C.stage = 'write';
      renderAll();
      schedule(cpuDelay('pick'));
      return;
    }
    commit(S.pend);
  }

  // 振る（目は決まった並びから。オンラインでは卓が決める）
  function doRoll(fresh) {
    const g = S.g;
    const mask = Y.applyRoll(g, fresh);
    S.pend = -1;
    save();
    return animateRoll(mask);
  }
  function commit(cat) {
    const g = S.g, seat = g.cur;
    if (!Y.canScore(g, cat)) return;
    const human = seatOf(seat).kind === 'me' || seatOf(seat).kind === 'human';
    if (human && !S.online) S.hist.push(JSON.stringify({ g, meta: S.meta }));
    if (human) judgeScore(cat);
    const pts = Y.applyScore(g, cat);
    S.just = { seat, cat };
    Sound.write(pts >= 30 && cat >= 8);
    S.pend = -1; S.cpu = null; S.adv = null; S.hintOn = false;
    save();
    renderAll();
    if (g.over) { finish(); return; }
    onTurnStart();
  }

  // ------------------------------------------------------------------ 人の操作
  function onRoll() {
    Sound.unlock();
    if (!myInput()) return;
    const g = S.g;
    if (g.rolls >= 3) { if (S.pend >= 0) onCat(S.pend, true); return; }
    if (g.rolls > 0 && g.hold === 31) { toast('5個とも残しています。役を選ぶか、目をタップして外してください'); return; }
    if (g.rolls > 0) judgeHold();
    S.hintOn = false;
    if (S.online) { S.online.act({ t: 'roll', hold: g.rolls ? g.hold : 0 }); return; }
    doRoll(Y.seededRoll(S.seed, g.cur, g.round, g.rolls)).then(renderAll);
  }
  function onDie(i) {
    if (!myInput() || !Y.canHold(S.g)) return;
    const m = S.g.hold ^ (1 << i);
    Sound.tick();
    if (S.online) { S.g.hold = m; S.online.act({ t: 'hold', mask: m }); renderAll(); return; }
    Y.applyHold(S.g, m);
    save();
    renderAll();
  }
  function onCat(cat, force) {
    Sound.unlock();
    if (!myInput() || !Y.canScore(S.g, cat)) return;
    if (settings.confirm && !force && S.pend !== cat) { S.pend = cat; renderAll(); return; }
    if (S.online) { judgeScore(cat); S.online.act({ t: 'score', cat }); S.pend = -1; renderAll(); return; }
    commit(cat);
  }
  function undo() {
    if (S.online || !S.hist.length || anim) return;
    clearTimeout(timer);
    const h = JSON.parse(S.hist.pop());
    S.g = h.g; S.meta = h.meta || []; S.pend = -1; S.cpu = null; S.adv = null; S.view = null; S.resultShown = false;
    $('dlg-result').hidden = true;
    save();
    renderAll();
    toast('直前の記入を取り消しました');
  }

  // ------------------------------------------------------------------ AI補助
  // 手番の始めに1回だけ計算（点数表は手番の中で変わらない）: 期待値の計画と、2人以上なら勝率の計画
  function adviser() {
    const g = S.g, key = `${g.round}:${g.cur}:${g.sheets[g.cur].mask}`;
    if (!S.adv || S.adv.key !== key) {
      const solo = AI.planSolo(g.sheets[g.cur]);
      const win = g.n > 1 ? AI.planWin(g.sheets, g.cur) : null;
      S.adv = { key, solo, win };
    }
    return S.adv;
  }
  // いまの局面の読み: { start?, keeps: [{keep, e, w}], cats: Map(cat → {pts, e, w}), best: {keep|-1}, bestCat, judge: 'w'|'e' }
  function reading() {
    const g = S.g, A = adviser(), J = A.win ? 'w' : 'e';
    const out = { judge: J, rollsLeft: 3 - g.rolls };
    if (g.rolls === 0) { out.e = AI.startValue(A.solo); out.w = A.win ? AI.startValue(A.win) : null; return out; }
    const d = Y.dIndex(g.dice), rl = 3 - g.rolls;
    const as = AI.advise(A.solo, d, rl), aw = A.win ? AI.advise(A.win, d, rl) : null;
    const km = new Map();
    as.keeps.forEach(o => km.set(o.keep, { keep: o.keep, e: o.v, w: null }));
    if (aw) aw.keeps.forEach(o => { const x = km.get(o.keep); if (x) x.w = o.v; });
    out.keeps = [...km.values()].sort((a, b) => (J === 'w' ? b.w - a.w || b.e - a.e : b.e - a.e));
    const cm = new Map();
    as.cats.forEach(o => cm.set(o.cat, { cat: o.cat, pts: o.pts, e: o.v, w: null }));
    if (aw) aw.cats.forEach(o => { cm.get(o.cat).w = o.v; });
    out.cats = cm;
    out.catList = [...cm.values()].sort((a, b) => (J === 'w' ? b.w - a.w || b.e - a.e : b.e - a.e));
    out.best = out.keeps[0];
    out.bestCat = out.catList[0].cat;
    out.e = out.best.e; out.w = out.best.w;
    return out;
  }
  const showValues = () => settings.ai && settings.values;
  const showBest = () => (settings.ai && settings.best) || S.hintOn;
  const pct = v => `${Math.round(v * 100)}%`;
  const ev = v => v.toFixed(1);
  // 自分の判断の見直し（記録に残す）: 期待値なら点、勝率ならパーセントの差
  function judgeHold() {
    try {
      const g = S.g, R = reading(), k = Y.keepOfMask(g.dice, g.hold);
      const mine = R.keeps.find(o => o.keep === k);
      if (!mine) return;
      addRegret(R.judge, R.judge === 'w' ? R.best.w - mine.w : R.best.e - mine.e);
    } catch (e) { console.error(e); }
  }
  function judgeScore(cat) {
    try {
      const R = reading(), J = R.judge, c = R.cats.get(cat);
      const v = o => (J === 'w' ? o.w : o.e);
      // 止めた判断（まだ振れたのに記入した）＋役の選び方
      const stop = R.keeps.find(o => o.keep === -1);
      addRegret(J, (v(R.best) - v(stop)) + (v(R.catList[0]) - v(c)));
      S.turnMeta = null;
    } catch (e) { console.error(e); }
  }
  function addRegret(J, x) {
    const i = S.g.log.length;
    const m = S.meta[i] || (S.meta[i] = { j: J, r: 0 });
    m.r += Math.max(0, x);
  }
  function hint() {
    if (!myInput()) { toast('あなたの番のときに使えます'); return; }
    if (S.g.rolls === 0) { toast('まず「振る」を押しましょう'); return; }
    S.hintOn = true; S.hints++;
    if (S.online) S.online.useHint();
    const R = reading();
    const best = R.best;
    toast(best.keep < 0 ? `ここで記入するのが最善: ${CATS[R.bestCat].name}` : `おすすめ: ${Y.keepFaces(best.keep).join('・') || '全部'}を${best.keep >= 0 && Y.KN[best.keep] ? '残して' : ''}振り直す`);
    renderAll();
  }

  // ------------------------------------------------------------------ 描画
  function viewGame() {
    if (S.view == null) return S.g;
    const g = S.g, n = g.n, v = Y.newGame(n), e = g.log[S.view];
    for (let i = 0; i <= S.view; i++) { const x = g.log[i]; Y.writeSheet(v.sheets[x.s], x.c, x.p); }
    v.round = e.r; v.cur = e.s; v.dice = e.d.slice(); v.rolls = 0;
    return v;
  }
  function renderAll() {
    if (!S) return;
    renderSheet(); renderDice(); renderInfo(); renderRoll(); renderPanel(); renderLog(); renderControls();
  }
  function renderSheet() {
    const g = viewGame(), n = g.n, live = S.view == null;
    const sh = $('sheet');
    sh.style.setProperty('--np', n);
    sh.classList.toggle('view', !live);
    const inter = live && myInput();
    const R = inter && g.rolls > 0 && (showValues() || showBest()) ? reading() : null;
    const tot = g.sheets.map(Y.totalOf), mx = Math.max(...tot), anyFilled = g.sheets.some(s => s.mask);
    const viewE = live ? null : S.g.log[S.view];
    let h = '<div class="corner">役</div>';
    for (let p = 0; p < n; p++) {
      const t = live && p === g.cur && !g.over;
      const sp = S.seats[p], marks = sp.kind === 'remote' ? `${sp.ai ? '<span class="aimark" title="AI補助あり">AI</span>' : ''}${sp.hints ? `<span class="aimark" title="ヒントの回数">ヒ${sp.hints}</span>` : ''}` : '';
      h += `<div class="head${t ? ' turn' : ''}" style="--sc:var(--s${p})" title="${esc(nameOf(p) + (levelText(p) ? ' ' + levelText(p) : '') + (sp.kind === 'remote' ? (sp.ai ? '・AI補助あり' : '・AI補助なし') + (sp.hints ? `・ヒント${sp.hints}回` : '') : ''))}"><span class="dot"></span><span class="nm">${esc(nameOf(p))}</span>${marks}</div>`;
    }
    for (const r of ROWS) {
      if (r === 'sub') {
        h += '<div class="lab subrow" title="1〜6の目の合計が63以上なら +35点">上段の計<span class="rule">63〜で+35</span></div>';
        for (let p = 0; p < n; p++) {
          const s = g.sheets[p];
          let par = 0; for (let c = 0; c < 6; c++) if (s.mask & (1 << c)) par += 3 * (c + 1);
          const doneUp = (s.mask & 63) === 63;
          const small = s.up >= 63 ? '<span class="bn">+35</span>' : doneUp ? '<span class="pace ng">なし</span>' : (s.mask & 63) ? `<span class="pace ${s.up >= par ? 'ok' : 'ng'}">${s.up >= par ? '+' : '−'}${Math.abs(s.up - par)}</span>` : '<span class="pace">あと63</span>';
          h += `<div class="cell subrow${p === g.cur && live ? ' curcol' : ''}" style="--sc:var(--s${p})">${s.up}${small}</div>`;
        }
        continue;
      }
      if (r === 'tot') {
        h += '<div class="lab totrow">合計</div>';
        for (let p = 0; p < n; p++) h += `<div class="cell totrow${n > 1 && anyFilled && tot[p] === mx ? ' lead' : ''}${p === g.cur && live ? ' curcol' : ''}" style="--sc:var(--s${p})">${tot[p]}</div>`;
        continue;
      }
      const c = r;
      h += `<div class="lab" data-rule="${c}" title="${esc(CATS[c].desc)}">${c < 6 ? dieSVG(c + 1).replace('class="dsvg"', 'class="dsvg mini"') : ''}${esc(CATS[c].name)}<span class="rule">${RULE[c]}</span></div>`;
      for (let p = 0; p < n; p++) {
        const s = g.sheets[p], col = p === g.cur && live ? ' curcol' : '';
        const st = `style="--sc:var(--s${p})"`;
        if (s.mask & (1 << c)) {
          const just = (live && S.just && S.just.seat === p && S.just.cat === c) || (viewE && viewE.s === p && viewE.c === c);
          h += `<div class="cell${s.sc[c] === 0 ? ' zero-in' : ''}${just ? ' just' : ''}${col}" ${st}>${s.sc[c]}</div>`;
        } else if (live && p === g.cur && g.rolls > 0 && !g.over) {
          const pts = Y.score(c, g.dice);
          if (inter) {
            let ai = '';
            if (R && showValues()) { const o = R.cats.get(c); ai = `<span class="ai${o.cat === R.bestCat ? '' : ' lo'}">${R.judge === 'w' ? pct(o.w) : '期待' + Math.round(o.e)}</span>`; }
            const best = R && showBest() && R.bestCat === c;
            h += `<button class="cell${col}${S.pend === c ? ' pend' : ''}${best ? ' best' : ''}" ${st} data-cat="${c}" aria-label="${esc(CATS[c].name)}に${pts}点を記入"><span class="pv${pts ? '' : ' zero'}">${pts}</span>${ai}</button>`;
          } else {
            h += `<div class="cell${col}${S.pend === c ? ' pend' : ''}" ${st}>${S.pend === c ? `<span class="pv">${pts}</span>` : ''}</div>`;
          }
        } else h += `<div class="cell${col}" ${st}></div>`;
      }
    }
    sh.innerHTML = h;
    S.just = live ? S.just : S.just;
  }

  // サイコロ: ボタンは1回だけ作り、目と印だけ差し替える（転がっている間の動きを切らないように）
  const dieEls = [];
  function buildDice() {
    const box = $('dice');
    box.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('button');
      b.className = 'die blank'; b.type = 'button';
      b.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><rect class="body" x="5" y="5" width="90" height="90" rx="20"/><g class="pips"></g></svg><span class="tag" hidden>キープ</span><span class="rec" hidden></span>';
      b.addEventListener('click', () => onDie(i));
      box.appendChild(b); dieEls.push(b);
    }
  }
  function renderDice() {
    const g = viewGame(), live = S.view == null;
    const inter = live && myInput() && Y.canHold(g);
    let rec = 0, drop = 0;
    if (inter && showBest()) {
      const R = reading();
      if (R.best && R.best.keep >= 0) { rec = Y.holdMaskFor(g.dice, R.best.keep, g.hold); drop = g.hold & ~rec; }
    }
    for (let i = 0; i < 5; i++) {
      const el = dieEls[i];
      const rolling = anim && (anim.mask >> i) & 1;
      const v = rolling ? anim.face[i] : g.dice[i];
      const held = live && g.rolls > 0 && g.rolls < 3 && !g.over && (g.hold >> i) & 1;
      el.classList.toggle('blank', !v);
      el.classList.toggle('held', !!held && !rolling);
      el.querySelector('.pips').innerHTML = pipsSVG(v);
      el.querySelector('.tag').hidden = !held || rolling;
      const r = el.querySelector('.rec');
      r.hidden = !((rec | drop) >> i & 1) || rolling;
      r.classList.toggle('drop', !!((drop >> i) & 1));
      el.disabled = !inter;
      el.setAttribute('aria-label', v ? `${v}の目${held ? '（残す）' : ''}` : 'まだ振っていません');
      el.setAttribute('aria-pressed', held ? 'true' : 'false');
    }
  }
  function animateRoll(mask) {
    const dur = !settings.anim || reduced ? 0 : (S.online || seatOf(S.g.cur).kind !== 'cpu' || !settings.fast ? 620 : 380);
    Sound.rattle(Math.max(0.25, dur / 1000));
    if (!dur || !mask) { renderAll(); return Promise.resolve(); }
    anim = { mask, face: [1, 1, 1, 1, 1].map(() => 1 + Math.floor(Math.random() * 6)) };
    dieEls.forEach((el, i) => {
      if (!((mask >> i) & 1)) return;
      el.classList.remove('rolling');
      el.style.setProperty('--rot', String((Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2))));
      el.style.setProperty('--jx', `${Math.round((Math.random() * 2 - 1) * 14)}%`);
      el.style.setProperty('--dur', `${dur / 1000}s`);
      void el.offsetWidth;
      el.classList.add('rolling');
    });
    renderAll();
    return new Promise(res => {
      const iv = setInterval(() => { if (!anim) return; for (let i = 0; i < 5; i++) if ((anim.mask >> i) & 1) anim.face[i] = 1 + Math.floor(Math.random() * 6); renderDice(); }, 75);
      setTimeout(() => {
        clearInterval(iv);
        anim = null;
        dieEls.forEach(el => el.classList.remove('rolling'));
        renderAll();
        res();
      }, dur);
    });
  }

  function renderInfo() {
    const el = $('info'), g = S.g;
    let cls = '', txt = '', right = '';
    if (S.view != null) {
      const e = g.log[S.view];
      cls = 'view';
      txt = `見返し中: 第${e.r + 1}回 <b>${esc(nameOf(e.s))}</b> ${esc(CATS[e.c].name)} ${e.p}点`;
      right = '<button class="btn small" data-act="live">戻る</button>';
    } else if (g.over) {
      cls = 'result';
      const t = g.sheets.map(Y.totalOf), me = meIndex();
      txt = g.n === 1 ? `終わり — <b>${t[0]}点</b>` : me >= 0 ? `終わり — あなたは <b>${Y.ranks(g)[me]}位</b>（${t[me]}点）` : `終わり — <b>${esc(winnerText())}</b>`;
      right = '<button class="btn small" data-act="result">結果</button>';
    } else if (paused()) {
      txt = '新しい対局を選んでいます（いまの対局は止めています）';
    } else {
      const k = seatOf(g.cur).kind, who = esc(nameOf(g.cur));
      const round = `<span class="hint">第${g.round + 1}/12回</span>`;
      if (myInput() || (S.online ? g.cur === S.online.me : k === 'me' || k === 'human')) {
        const you = humanCount() > 1 && !S.online ? `<b>${who}</b>の番` : 'あなたの番';
        cls = 'alert';
        if (S.pend >= 0 && Y.canScore(g, S.pend)) {
          txt = `<b>${esc(CATS[S.pend].name)}</b> に ${Y.score(S.pend, g.dice)}点を記入？`;
          right = '<button class="btn small primary" data-act="commit">記入する</button><button class="btn small" data-act="unpend">やめる</button>';
        } else if (g.rolls === 0) txt = `${you} ${round} — 振ってください`;
        else if (g.rolls < 3) txt = `${you} — 残す目と、記入する役をタップ`;
        else txt = `${you} — 記入する役を選んでください`;
        if (!right && settings.ai && settings.values && myInput()) {
          const R = reading();
          const v = R.judge === 'w' && R.w != null ? `勝率 ${pct(R.w)}` : `期待 ${Math.round(R.e)}点`;
          right = `<button class="ev" data-act="panel" title="AI の読みを開く">${v}</button>`;
          if (g.rolls > 0 && showBest() && R.best && R.best.keep < 0) txt = `${you} — ここで記入するのが最善（★）`;
        }
      } else if (k === 'cpu') {
        txt = `<b>${who}</b>${S.mode === 'watch' ? '' : `（${esc((LV[seatOf(g.cur).level] || {}).label || '')}）`}の番 ${round}${S.pend >= 0 ? ` — ${esc(CATS[S.pend].name)}に記入` : ''}`;
      } else {
        txt = `<b>${who}</b>さんの番 ${round}${S.online && !S.online.present(g.cur) ? '（通信が切れています）' : ''}`;
      }
      if (S.online && S.online.alert) { txt = esc(S.online.alert); cls = 'alert'; }
    }
    el.className = `info ${cls}`;
    el.innerHTML = `<span class="txt">${txt}</span><span class="tools">${right}</span>`;
  }
  function winnerText() {
    const g = S.g, rk = Y.ranks(g), w = [];
    rk.forEach((r, i) => { if (r === 1) w.push(nameOf(i)); });
    return w.length > 1 ? `${w.join('・')}が1位タイ` : `${w[0]}の勝ち`;
  }
  function renderRoll() {
    const b = $('btn-roll'), g = S.g;
    b.classList.remove('write');
    let label = '振る', small = `あと${3 - g.rolls}回`, dis = false;
    if (S.view != null) { dis = true; small = '見返し中'; }
    else if (g.over) { label = 'もう一局'; small = S.online ? '卓で' : ''; dis = !!S.online; }
    else if (!myInput()) { dis = true; small = anim || (S.online && g.cur === S.online.me) ? '…' : seatOf(g.cur).kind === 'cpu' ? 'CPUの番' : '相手の番'; }
    else if (g.rolls >= 3) {
      if (S.pend >= 0) { label = '記入'; small = `+${Y.score(S.pend, g.dice)}`; b.classList.add('write'); }
      else { label = '記入へ'; small = '役をタップ'; dis = true; }
    } else if (g.rolls > 0 && g.hold === 31) { small = '全部残し中'; }
    b.disabled = dis;
    b.innerHTML = `${label}<small>${small}</small>`;
  }
  function renderControls() {
    const ai = $('btn-ai');
    ai.setAttribute('aria-pressed', String(settings.ai));
    $('btn-undo').disabled = !!S.online || !S.hist.length || S.mode === 'watch';
    $('btn-hint').disabled = !myInput() || S.g.rolls === 0;
    $('btn-resign').textContent = S.online ? '卓を離れる' : 'この対局をやめる';
  }
  function renderPanel() {
    const el = $('evcard'), g = S.g;
    if (!settings.ai) { el.innerHTML = '<h2>AI の読み</h2><p class="hint" style="margin:0 0 8px">AI補助はオフです。</p><div><button class="btn small" data-act="ai-on">表示する</button></div>'; return; }
    let h = '';
    if (myInput()) {
      const R = reading(), J = R.judge;
      const big = J === 'w' && R.w != null ? pct(R.w) : ev(R.e);
      h += `<h2>AI の読み<span class="grow">${esc(humanCount() > 1 && !S.online ? nameOf(g.cur) + 'の番' : 'あなたの番')}・第${g.round + 1}回</span></h2>`;
      h += `<div class="evnum"><span class="v">${big}</span><span class="lbl">${J === 'w' ? `勝つ確率<br>期待 ${ev(R.e)}点` : '最後の合計の期待値（点）'}</span></div>`;
      if (g.rolls > 0) {
        if (R.rollsLeft > 0) {
          const mine = Y.keepOfMask(g.dice, g.hold);
          h += `<h2 style="margin-top:12px">残し方（あと${R.rollsLeft}回振れる）</h2><ol class="opts">`;
          R.keeps.slice(0, 6).forEach((o, i) => {
            const lab = o.keep < 0 ? '<span>ここで止めて記入</span>' : Y.KN[o.keep] ? facesSVG(Y.keepFaces(o.keep)) : '<span>全部振り直す</span>';
            h += `<li class="${i === 0 ? 'top' : ''}${o.keep === mine && o.keep >= 0 ? ' mine' : ''}">${lab}<span class="v">${J === 'w' ? pct(o.w) : ''}</span><span class="v">${ev(o.e)}点</span></li>`;
          });
          h += '</ol>';
        }
        h += '<h2 style="margin-top:12px">記入する役</h2><ol class="opts">';
        R.catList.slice(0, 6).forEach((o, i) => { h += `<li class="${i === 0 ? 'top' : ''}"><span>${esc(CATS[o.cat].name)} <b>${o.pts}</b>点</span><span class="v">${J === 'w' ? pct(o.w) : ''}</span><span class="v">${ev(o.e)}点</span></li>`; });
        h += '</ol>';
      }
      h += `<p class="meta">点は「この先、期待値の最善で打ったときの最後の合計の期待値」。${J === 'w' ? '勝つ確率は、ほかの人も「最強」と同じ打ち方をするとしたときの見込み（自己対局で学んだネット）。' : ''}</p>`;
    } else {
      h += `<h2>形勢<span class="grow">${g.over ? '終わり' : `第${Math.min(12, g.round + 1)}回`}</span></h2><ol class="opts">`;
      const proj = g.sheets.map(s => s.raw + Y.tableValue(s.mask, Y.uOf(s)));
      let win = null;
      if (g.n > 1 && !g.over) {
        win = g.sheets.map((_, p) => AI.winValue(AI.ordered(g.sheets, p)));
        const sum = win.reduce((a, b) => a + b, 0) || 1;
        win = win.map(x => x / sum);
      }
      g.sheets.forEach((s, p) => { h += `<li><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--s${p});margin-right:6px"></i>${esc(nameOf(p))}</span><span class="v">${win ? pct(win[p]) : ''}</span><span class="v">${g.over ? Y.totalOf(s) + '点' : '見込み ' + ev(proj[p])}</span></li>`; });
      h += '</ol><p class="meta">見込みは、いまの点＋この先を期待値の最善で打ったときの期待値。勝つ確率は自己対局で学んだネットの見積もり（目安）。</p>';
    }
    el.innerHTML = h;
  }
  function renderLog() {
    const g = S.g, ol = $('log');
    $('log-info').textContent = `${g.log.length}手`;
    ol.innerHTML = g.log.map((e, i) => {
      const m = S.meta[i];
      const bad = m && (m.j === 'w' ? m.r > 0.01 : m.r > 0.5) ? `<span class="bad">${m.j === 'w' ? `−${Math.round(m.r * 100)}%` : `−${m.r.toFixed(1)}点`}</span>` : '';
      return `<li data-i="${i}" class="${S.view === i ? 'cur' : ''}"><span class="no">${e.r + 1}</span><span class="who" style="--sc:var(--s${e.s})"><i></i>${esc(nameOf(e.s))}<span class="faces">${e.d.slice().sort((a, b) => a - b).map(dieSVG).join('')}</span></span><span class="pt">${esc(CATS[e.c].name)} ${e.p} ${bad}</span></li>`;
    }).reverse().join('');
  }

  // ------------------------------------------------------------------ 終わり
  function finish() {
    if (!S.online) recordStats();
    Sound.end(meIndex() >= 0 ? Y.ranks(S.g)[meIndex()] === 1 : true);
    setTimeout(() => { if (S && S.g.over && !S.resultShown) { S.resultShown = true; showResult(); } }, 900);
  }
  function recordStats() {
    const st = store.get('stats', { solo: { n: 0, sum: 0, best: 0 }, cpu: {} });
    const g = S.g, t = g.sheets.map(Y.totalOf), me = meIndex();
    if (S.mode === 'solo') { st.solo.n++; st.solo.sum += t[0]; S.newBest = t[0] > st.solo.best; st.solo.best = Math.max(st.solo.best, t[0]); }
    else if (S.mode === 'cpu' && me >= 0) {
      const lv = S.seats.find(s => s.kind === 'cpu').level, k = `${lv}-${g.n}`;
      const x = st.cpu[k] || (st.cpu[k] = { n: 0, w: 0 });
      x.n++; x.w += Y.shares(t)[me];
    }
    store.set('stats', st);
  }
  function showResult() {
    const g = S.g, t = g.sheets.map(Y.totalOf), rk = Y.ranks(g), me = meIndex();
    const order = t.map((x, i) => i).sort((a, b) => t[b] - t[a]);
    let title;
    if (g.n === 1) title = `${t[0]}点`;
    else if (me >= 0) title = rk[me] === 1 ? (rk.filter(r => r === 1).length > 1 ? '1位タイ' : 'あなたの勝ち') : `${rk[me]}位`;
    else title = winnerText();
    $('rs-title').textContent = title;
    $('rs-sub').textContent = `${S.online ? 'オンラインの卓' : MODES.find(m => m[0] === S.mode)[1]}・${g.n}人${S.seats.some(s => s.kind === 'cpu') && S.mode !== 'watch' ? `・CPU ${(LV[S.seats.find(s => s.kind === 'cpu').level] || {}).label}` : ''}`;
    $('rs-rank').innerHTML = order.map(i => `<li class="${i === me ? 'me' : ''}"><span class="pl">${g.n > 1 ? rk[i] + '位' : ''}</span><i style="--sc:var(--s${i})"></i><span>${esc(nameOf(i))}${g.sheets[i].up >= 63 ? ' <span class="hint">ボーナス</span>' : ''}</span><b>${t[i]}</b></li>`).join('');
    const st = store.get('stats', { solo: { n: 0, sum: 0, best: 0 }, cpu: {} });
    let body = '';
    if (g.n === 1 && !S.online) body = `${S.newBest ? '自己ベスト更新！ ' : ''}自己ベスト ${st.solo.best}点・平均 ${(st.solo.sum / Math.max(1, st.solo.n)).toFixed(1)}点（${st.solo.n}回）。理論上の最善の期待値は ${OPTIMAL.toFixed(1)}点。`;
    const myReg = S.meta.reduce((a, m, i) => (m && g.log[i] && g.log[i].s === me ? a + m.r : a), 0);
    const J = S.meta.find(m => m) ? S.meta.find(m => m).j : null;
    if (me >= 0 && J) body += (J === 'w' ? myReg < 0.005 : myReg < 0.05) ? ' AI から見て、あなたの判断はほぼ最善どおりでした。'
      : ` AI から見たあなたの判断の差: 合計 ${J === 'w' ? `勝つ確率 −${Math.round(myReg * 100)}%` : `−${myReg.toFixed(1)}点`}（記録に赤い印）。`;
    if (S.online) body += ' ' + S.online.resultNote();
    $('rs-body').textContent = body.trim();
    $('rs-again').textContent = S.online ? (S.online.isHost ? '卓でもう一局' : '閉じる') : 'もう一局';
    $('rs-new').hidden = !!S.online;
    $('dlg-result').hidden = false;
  }

  // ------------------------------------------------------------------ 新しい対局
  let draft = null;
  function openNew() {
    draft = JSON.parse(JSON.stringify(cfg));
    if (draft.mode === 'online') draft.mode = 'cpu';
    drawNew();
    $('dlg-new').hidden = false;
    clearTimeout(timer); // 裏の対局を止める
    renderAll();
    $('ng-start').focus();
  }
  function closeNew() { $('dlg-new').hidden = true; renderAll(); schedule(); }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    seg('ng-mode', MODES, draft.mode);
    $('ng-mode-hint').textContent = MODE_HINT[draft.mode];
    seg('ng-n', [[2, '2人'], [3, '3人'], [4, '4人']], draft.n);
    $('ng-cpu').innerHTML = LV_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(LV[k].stars)}${'☆'.repeat(4 - LV[k].stars)}</span><b>${LV[k].label}</b><small>${LV[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = (LV[draft.cpu] || {}).desc || '';
    seg('ng-order', [['first', '1番目'], ['last', '最後'], ['random', 'ランダム']], draft.order);
    $('ng-watch').innerHTML = [...Array(draft.n)].map((_, i) => `<div class="seatrow"><span class="hint"><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--s${i});margin-right:5px"></i>${i + 1}番目</span><div class="seg" data-watch="${i}">${LV_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.watch[i] === k}">${LV[k].label}</button>`).join('')}</div></div>`).join('');
    $('ng-n-field').hidden = draft.mode === 'solo';
    $('ng-cpu-field').hidden = draft.mode !== 'cpu';
    $('ng-order-field').hidden = draft.mode !== 'cpu';
    $('ng-watch-field').hidden = draft.mode !== 'watch';
  }

  // ------------------------------------------------------------------ 遊び方・AI のページ
  let docTab = { rules: 'rules', ai: 'how' };
  function renderDoc(which) {
    const el = $(`view-${which}`);
    const tabs = which === 'rules' ? [['rules', 'ルール'], ['cats', '役と点数'], ['ops', '操作'], ['tips', 'コツ']] : [['how', 'AI のしくみ'], ['levels', '強さの段'], ['rec', '強さの記録']];
    const cur = docTab[which];
    let h = `<div class="doctabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-doc="${which}:${k}" aria-selected="${k === cur}">${l}</button>`).join('')}</div>`;
    h += which === 'rules' ? rulesPage(cur) : aiPage(cur);
    el.innerHTML = h;
  }
  const EX = [[1, 1, 3, 1, 5], [2, 2, 2, 6, 1], [3, 3, 4, 3, 1], [4, 4, 4, 2, 4], [5, 1, 5, 5, 3], [6, 6, 2, 6, 6], [6, 5, 4, 3, 6], [5, 5, 5, 5, 2], [3, 3, 6, 6, 6], [1, 2, 3, 4, 5], [2, 3, 4, 5, 6], [4, 4, 4, 4, 4]];
  function rulesPage(t) {
    if (t === 'rules') return `<div class="card"><h3>ヨットとは</h3>
      <p>5個のサイコロと点数表で遊ぶ、昔から伝わるサイコロ遊びです。1人でも、2〜4人でも遊べます。決まった12の「役」を1つずつ埋めていき、合計点の多い人の勝ちです。</p></div>
      <div class="card"><h3>1回の手番</h3><ol>
      <li>5個のサイコロを振ります（1回目）。</li>
      <li>残したい目をタップして「キープ」し、残りだけを振り直せます（2回目・3回目）。キープは振るたびに付け替えられます。どの回で止めてもかまいません。</li>
      <li>振り終えたら、点数表のまだ空いている役を<b>1つ</b>選んで、その点を記入します。役ができていなければ 0点を記入します（必ずどれか1つ埋めます）。</li></ol></div>
      <div class="card"><h3>終わりと勝ち負け</h3><ul>
      <li>全員が12の役を埋めたら（12回）終わりです。</li>
      <li>合計点（役の点＋上段ボーナス）が一番多い人の勝ち。同点は同じ順位です。</li>
      <li><b>上段ボーナス</b>: 1〜6の目の6つの役の合計が <b>63点以上</b>なら <b>+35点</b>。どの目も3個ずつ取るとちょうど63点です（表の「上段の計」の小さな数は、その目安との差）。</li></ul></div>
      <div class="card"><h3>このサイトでの決まり</h3><ul>
      <li>役は昔ながらの12種類（下の「役と点数」）。ヨットを2回出したときのおまけ点や、ほかの役の代わりに使う決まりはありません。</li>
      <li>フルハウスは「同じ目3個」と「別の同じ目2個」。5個とも同じ目はフルハウスになりません。フォーカードは5個とも同じでもよく、そのうち4個の合計です。</li>
      <li>リトル・ストレートは 1・2・3・4・5、ビッグ・ストレートは 2・3・4・5・6（どちらも 30点）。</li></ul></div>`;
    if (t === 'cats') return `<div class="card"><h3>役と点数</h3><div class="catgrid">${CATS.map((c, i) => `<div><b>${esc(c.name)}</b><span class="pts">${['1の目の数×1', '2の目の数×2', '3の目の数×3', '4の目の数×4', '5の目の数×5', '6の目の数×6', '5個の合計', '4個の合計', '5個の合計', '30点', '30点', '50点'][i]}</span><span class="ex">${EX[i].map(dieSVG).join('')} → ${Y.score(i, EX[i])}点</span><span class="hint" style="grid-column:1/-1">${esc(c.desc)}</span></div>`).join('')}</div>
      <p class="hint" style="margin-top:10px">上段（1〜6の目）の合計が63点以上なら +35点。役ができていなくても、空いている役に 0点を記入できます。</p></div>`;
    if (t === 'ops') return `<div class="card"><h3>操作</h3><ul>
      <li><b>振る</b>: 右の大きなボタン（キーボードならスペース）。下の小さな字が、この手番で振れる残りの回数です。</li>
      <li><b>残す</b>: サイコロをタップすると浮き上がって黄色い枠が付きます（キープ）。もう一度タップで外れます（キーボードなら 1〜5）。</li>
      <li><b>記入</b>: 点数表の自分の列で、空いている役をタップ。薄い数字が、いま記入したときの点です。はじめは「2回タップで記入」（1回目は確認）。設定で1回タップにもできます。</li>
      <li><b>AI補助</b>: 役のマスの小さな数（勝つ確率・期待の点）、★（おすすめの役）、サイコロの上の緑の点（残すとよい目。赤い輪は外すとよい目）。「AI補助」ボタンでまとめて出し入れ、細かくは設定で。</li>
      <li><b>ヒント</b>: AI補助を隠していても、その場だけおすすめを出します（オンラインでは回数がほかの人に見えます）。</li>
      <li><b>記録</b>: 「読み・記録」（スマホでは ⋯ の中）。手番ごとの目と記入した役。あなたの判断が AI の見積もりより悪かった手には赤い印。タップでその時点の点数表を見返せます。</li>
      <li><b>待った</b>: ⋯ の中。直前の記入を取り消して、記入する前（振り終えた目のまま）に戻ります。振り直しはやり直せません。オンラインではありません。</li></ul></div>`;
    return `<div class="card"><h3>コツ（AI の計算から）</h3><ul>
      <li>1人で最善を尽くしたときの平均は約 ${OPTIMAL.toFixed(0)}点。上段ボーナスを取れる割合が点を大きく左右します。</li>
      <li>序盤の 1・2の目は「捨て場」になりがち。悪い目が出たとき 0点や小さな点を入れる役として残しておくと、あとで助かります。</li>
      <li>チョイスは最後の逃げ場。早く使いすぎないこと。</li>
      <li>2人以上では、勝つ確率を見ると打ち方が変わります。大きく負けているならヨットやストレートを狙い、勝っているなら確実な点を取りにいく、など。AI補助の「勝つ確率」と「期待の点」が食い違う手が、その分かれ目です。</li></ul></div>`;
  }
  function aiPage(t) {
    const st = window.YACHT_STRENGTH || null;
    if (t === 'how') return `<div class="card"><h3>この AI は、人の知恵を使っていません</h3>
      <p>どの AI も、ルールと自分たちのコードだけで作りました。人の打ち方の記録や、人が作った評価の表は使っていません。</p></div>
      <div class="card"><h3>① 期待値の最善（つよい）: ルールから計算した表</h3>
      <p>「埋めた役（2<sup>12</sup>=4096通り）× 上段の合計（0〜63）」の全部の局面について、「ここから最善を尽くすと、あと何点取れるか（期待値）」を最後の局面から逆にたどって計算しました（17万9千局面、PC で約15秒）。1回の手番の中は、5個の目の組 252通りと残し方 462通りについて、あと何回振れるかごとに最善を計算します。これは1人で遊ぶときの<b>理論上の最善</b>で、最初の期待値は <b>${OPTIMAL.toFixed(2)}点</b>です。</p></div>
      <div class="card"><h3>② 勝つための打ち方（最強）: 自己対局で学んだネット</h3>
      <p>2人以上では、点の期待値が最大でも勝てるとは限りません。負けていれば大きな役に賭け、勝っていれば確実に点を取るほうが勝ちやすい。そこで「役を記入した直後の、全員の点数表」から「その人が1位になる確率」を見積もり、手番の中では①と同じ計算を、点の代わりにこの確率で行って、残し方と役の選び方を決めます。</p>
      <p><b>土台</b>: 各人の最後の点の分布から、自分が1位になる確率（同点は分ける）を出します。残りの役が4つ以下の人は①の打ち方での<b>正確な分布</b>（ルールから計算）、それより多い人は①の期待値と標準偏差の正規分布。これだけで①に、2人で 51.2%、4人で 26.0%（互角は25%）勝ちます。</p>
      <p><b>補正</b>: その確率の対数オッズに足す補正を、小さなネット（入力80・中間64と32）に<b>自己対局だけ</b>で学ばせています（いまの「最強」同士で3万局 → 学び直す、の繰り返し）。土台にはっきり勝てた版だけを使います。</p></div>
      <div class="card"><h3>超最強がない理由</h3><p>1回の手番の中は毎回最後まで読み切っているので、考える時間を延ばしても強くなりません。そのため段は4つです。</p></div>`;
    if (t === 'levels') {
      const s = st && st.solo ? st.solo : {}, dv = st && st.duelVsStrong ? st.duelVsStrong : {};
      const row = (k, how) => `<tr><td><b>${LV[k].label}</b></td><td>${how}</td><td>${s[k] ? `${s[k].mean.toFixed(1)}点` : k === 'best' && s.strong ? `${s.strong.mean.toFixed(1)}点` : '—'}</td><td>${k === 'strong' ? '50%' : k === 'best' ? (st && st.vsStrong2 ? `${(st.vsStrong2.share * 100).toFixed(1)}% ± ${(st.vsStrong2.se * 100).toFixed(1)}` : '—') : dv[k] ? `${(dv[k].share * 100).toFixed(1)}%` : '—'}</td></tr>`;
      return `<div class="card"><h3>強さの段</h3><div class="tbl"><table class="lv"><tr><th>段</th><th>打ち方</th><th>1人の平均点</th><th>2人で「つよい」と対戦した勝ち</th></tr>
        ${row('easy', 'その場で点の高い役を狙う。ときどき適当に残す')}${row('normal', '①の計算に揺らぎ（標準偏差1.6点）を足して選ぶ')}${row('strong', '①の期待値の最善')}${row('best', '②の勝つ確率の最善（1人のときは①と同じ）')}</table></div>
        <p class="hint">2人の対戦は、同じ目の並びで席を入れ替える「デュプリケート」で測っています（同点は半分ずつ）。</p></div>`;
    }
    if (!st || !st.vsStrong2) return '<div class="card"><h3>強さの記録</h3><p class="hint">まだ記録がありません（学習中）。</p></div>';
    const f = x => `${(x.share * 100).toFixed(1)}% ± ${(x.se * 100).toFixed(1)}`;
    return `<div class="card"><h3>強さの記録</h3>
      <div class="stat-row"><div class="stat">${st.gen ? `<b>第${st.gen}世代</b><span>自己対局 ${(st.games / 10000).toFixed(0)}万局で学んだ補正</span>` : '<b>土台だけ</b><span>補正のネットはまだ使っていません</span>'}</div>
      <div class="stat"><b>${f(st.vsStrong2)}</b><span>2人で①（つよい）と対戦（互角 50%）</span></div>
      ${st.vsStrong2.elo != null ? `<div class="stat"><b>${st.vsStrong2.elo >= 0 ? '+' : ''}${st.vsStrong2.elo.toFixed(0)} ± ${st.vsStrong2.eloSe.toFixed(0)}</b><span>Elo（①との差）</span></div>` : ''}</div>
      <div class="tbl" style="margin-top:10px"><table class="lv"><tr><th>人数</th><th>最強1人 vs つよい</th><th>互角</th><th>局数</th></tr>
      <tr><td>2人</td><td>${f(st.vsStrong2)}</td><td>50%</td><td>${st.vsStrong2.games}</td></tr>
      ${st.vs3 ? `<tr><td>3人</td><td>${f(st.vs3)}</td><td>33.3%</td><td>${st.vs3.games}</td></tr>` : ''}
      ${st.vs4 ? `<tr><td>4人</td><td>${f(st.vs4)}</td><td>25%</td><td>${st.vs4.games}</td></tr>` : ''}</table></div>
      <p class="hint">± は標準誤差。同じ目の並びで席を入れ替えて測っています。</p></div>
      <div class="card"><h3>世代ごと</h3><div class="tbl"><table class="lv"><tr><th>世代</th><th>学んだ局数</th><th>2人で①と</th><th>前の版と</th><th>日付</th></tr>
      ${(st.history || []).map(x => `<tr><td>${x.gen}</td><td>${(x.games / 10000).toFixed(0)}万</td><td>${x.vsStrong2 ? f(x.vsStrong2) : '—'}</td><td>${x.vsPrev2 ? f(x.vsPrev2) : '—'}</td><td>${esc(x.date || '')}</td></tr>`).join('')}</table></div></div>`;
  }

  // ------------------------------------------------------------------ 小物
  let toastTimer = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }
  function setTab(tab) {
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('view-play').hidden = tab !== 'play'; $('view-rules').hidden = tab !== 'rules'; $('view-ai').hidden = tab !== 'ai';
    $('main').classList.toggle('scroll', tab !== 'play');
    if (tab !== 'play') renderDoc(tab);
  }
  function openPanel(tab) {
    const side = $('side');
    if (tab) { side.dataset.tab = tab; side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab))); }
    side.classList.add('open');
  }
  function saveSettings() { store.set('settings', settings); }
  function syncSettingsUI() {
    $('set-values').checked = settings.values; $('set-best').checked = settings.best; $('set-sound').checked = settings.sound;
    $('set-anim').checked = settings.anim; $('set-fast').checked = settings.fast; $('set-confirm').checked = settings.confirm;
  }

  // ------------------------------------------------------------------ つなぎ
  function bind() {
    buildDice();
    syncSettingsUI();
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('main').addEventListener('click', e => {
      const b = e.target.closest('[data-doc]');
      if (!b) return;
      const [which, k] = b.dataset.doc.split(':');
      docTab[which] = k; renderDoc(which); $('main').scrollTop = 0;
    });
    $('btn-roll').addEventListener('click', () => {
      if (S.g.over && !S.online) { newGameFrom(cfg); return; }
      onRoll();
    });
    $('sheet').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (b) { onCat(+b.dataset.cat); return; }
      const l = e.target.closest('[data-rule]');
      if (l) toast(`${CATS[+l.dataset.rule].name}: ${CATS[+l.dataset.rule].desc}`);
    });
    $('info').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'commit') onCat(S.pend, true);
      else if (a === 'unpend') { S.pend = -1; renderAll(); }
      else if (a === 'live') { S.view = null; renderAll(); schedule(); }
      else if (a === 'result') showResult();
      else if (a === 'panel') openPanel('ev');
    });
    $('btn-new').addEventListener('click', openNew);
    $('btn-hint').addEventListener('click', hint);
    $('btn-ai').addEventListener('click', () => { settings.ai = !settings.ai; saveSettings(); if (S.online) S.online.setAI(settings.ai ? 1 : 0); renderAll(); });
    $('btn-undo').addEventListener('click', () => { $('menu-more').hidden = true; undo(); });
    const panelBtn = () => { $('menu-more').hidden = true; openPanel(); };
    $('btn-panel').addEventListener('click', panelBtn);
    $('btn-panel2').addEventListener('click', panelBtn);
    $('btn-resign').addEventListener('click', () => {
      $('menu-more').hidden = true;
      if (S.online) { if (window.YachtOnline) window.YachtOnline.leave(); return; }
      openNew();
    });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) $('menu-more').hidden = true;
      if (!e.target.closest('.settings-wrap')) $('settings').hidden = true;
    });
    const setMap = { 'set-values': 'values', 'set-best': 'best', 'set-sound': 'sound', 'set-anim': 'anim', 'set-fast': 'fast', 'set-confirm': 'confirm' };
    Object.keys(setMap).forEach(id => $(id).addEventListener('change', e => {
      settings[setMap[id]] = e.target.checked;
      if ((id === 'set-values' || id === 'set-best') && e.target.checked && !settings.ai) { settings.ai = true; if (S.online) S.online.setAI(1); }
      saveSettings(); renderAll();
    }));
    $('side').addEventListener('click', e => {
      const t = e.target.closest('.sheet-tabs button');
      if (t) { openPanel(t.dataset.st); return; }
      if (e.target.closest('[data-act="sheet-close"]')) { $('side').classList.remove('open'); return; }
      if (e.target.closest('[data-act="ai-on"]')) { settings.ai = true; saveSettings(); if (S.online) S.online.setAI(1); renderAll(); return; }
      const li = e.target.closest('#log li');
      if (li) { const i = +li.dataset.i; S.view = S.view === i ? null : i; clearTimeout(timer); renderAll(); if (S.view == null) schedule(); }
    });
    // 新しい対局
    $('dlg-new').addEventListener('click', e => {
      if (e.target === $('dlg-new')) { closeNew(); return; }
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const box = b.parentElement, v = b.dataset.v;
      if (box.id === 'ng-mode') {
        if (v === 'online') { $('dlg-new').hidden = true; renderAll(); schedule(); if (window.YachtOnline) window.YachtOnline.openLobby(); return; }
        draft.mode = v;
      } else if (box.id === 'ng-n') draft.n = +v;
      else if (box.id === 'ng-cpu' || b.closest('#ng-cpu')) draft.cpu = b.closest('#ng-cpu') ? b.dataset.v : v;
      else if (box.id === 'ng-order') draft.order = v;
      else if (box.dataset.watch != null) draft.watch[+box.dataset.watch] = v;
      drawNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => {
      cfg = draft; store.set('cfg', cfg);
      $('dlg-new').hidden = true;
      if (S.online && window.YachtOnline) window.YachtOnline.leave(true);
      newGameFrom(cfg);
    });
    // 結果
    $('rs-again').addEventListener('click', () => {
      $('dlg-result').hidden = true;
      if (S.online) { if (S.online.isHost) S.online.again(); return; }
      newGameFrom(cfg);
    });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') {
        if (!$('dlg-new').hidden) closeNew();
        $('dlg-result').hidden = true; $('side').classList.remove('open');
        if (S && S.pend >= 0) { S.pend = -1; renderAll(); }
        return;
      }
      if ($('view-play').hidden || !$('dlg-new').hidden || !$('dlg-online').hidden) return;
      if (e.key === ' ' || e.key === 'Enter') { if (e.target.closest && e.target.closest('button')) return; e.preventDefault(); onRoll(); }
      else if (/^[1-5]$/.test(e.key)) onDie(+e.key - 1);
    });
    // 狭い画面: パネルの高さ（点数表の上端あたりまで）
    const fit = () => { const r = $('sheet').getBoundingClientRect(); document.documentElement.style.setProperty('--sheet-top', `${Math.max(60, Math.round(r.top + 30))}px`); };
    window.addEventListener('resize', fit); setTimeout(fit, 50);
  }

  // ------------------------------------------------------------------ オンラインの卓から使う口
  window.YachtApp = {
    get S() { return S; }, esc, store, settings, toast, renderAll, Sound, dieSVG, cfg: () => cfg, aiOn: () => settings.ai, openNew, nameOf: i => nameOf(i),
    // 卓に座ったとき: seats（kind は me/remote/cpu）・g（卓の状態）・online（act / canAct / me / present / useHint / setAI / again / isHost / alert / resultNote）
    beginOnline(seats, g, online) {
      clearTimeout(timer);
      S = { mode: 'online', seats, g: JSON.parse(JSON.stringify(g)), seed: 0, hist: [], hints: 0, meta: [], pend: -1, view: null, adv: null, hintOn: false, cpu: null, online, resultShown: !!g.over };
      $('dlg-result').hidden = true;
      renderAll();
    },
    // 卓の状態が変わったとき。同じ手番で振った回数が増えていれば、振り直した位置を転がす
    updateOnline(seats, g) {
      if (!S || !S.online) return;
      const prev = S.g;
      S.seats = seats;
      const sameTurn = prev.round === g.round && prev.cur === g.cur && !prev.over;
      const rolled = sameTurn && g.rolls > prev.rolls ? (prev.rolls === 0 ? 31 : 31 & ~g.hold) : 0;
      const newTurn = prev.round !== g.round || prev.cur !== g.cur;
      const wrote = g.log.length > prev.log.length ? g.log[g.log.length - 1] : null;
      // 自分が残し方を変えている途中は、卓からの古い印で上書きしない
      const keepHold = sameTurn && g.rolls === prev.rolls && g.cur === S.online.me && S.online.canAct() ? prev.hold : g.hold;
      S.g = JSON.parse(JSON.stringify(g));
      S.g.hold = keepHold;
      if (wrote) { S.just = { seat: wrote.s, cat: wrote.c }; Sound.write(wrote.p >= 30 && wrote.c >= 8); }
      if (newTurn) { S.pend = -1; S.adv = null; S.hintOn = false; if (g.cur === S.online.me && !g.over) Sound.turn(); warm(); }
      if (g.cur !== S.online.me) S.pend = g.pend != null ? g.pend : -1;
      if (g.over && !prev.over) { finish(); }
      if (!g.over && prev.over) { S.resultShown = false; S.meta = []; $('dlg-result').hidden = true; }
      if (rolled && !anim) animateRoll(rolled); else renderAll();
    },
    endOnline() { if (!S || !S.online) return; S = null; if (!restore()) newGameFrom(cfg); else { renderAll(); onTurnStart(); } },
  };

  // ------------------------------------------------------------------ はじめ
  bind();
  if (restore()) { renderAll(); onTurnStart(); } else newGameFrom(cfg);
  if (S.g.over && !S.resultShown) S.resultShown = true;
})();
