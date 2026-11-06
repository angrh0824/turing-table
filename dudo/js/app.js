/* うそつきダイス Webアプリ: 卓・宣言の操作・ラウンドの終わりの開示・CPU（自己対局で学んだ値と、読む最強）・記録・AI補助 */
(function () {
  'use strict';
  const D = {};
  DudoCore(D);
  DudoAI(D);
  const { Game, DOUBT, CALZA, bid, bq, bf, Policy, plan, truthProb } = D;
  const W = (typeof DUDO_WEIGHTS !== 'undefined' && DUDO_WEIGHTS) ? DUDO_WEIGHTS : null;
  const LV = (typeof DUDO_LEVELS !== 'undefined' && DUDO_LEVELS) ? DUDO_LEVELS : null;
  const POL = new Policy(W);
  const TM = window.TTMotion || null;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('dudo-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dudo-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '学んだ値を大きくゆらして、ときどき気まぐれに選びます', temp: 0.4, eps: 0.1 },
    normal: { label: 'ふつう', stars: 2, desc: '学んだ値を少しゆらして選びます', temp: 0.15 },
    strong: { label: 'つよい', stars: 3, desc: '自己対局で学んだ値の一番よい行動を選びます', temp: 0 },
    max: { label: '最強', stars: 4, desc: '相手の宣言から手の内を推し量り、何通りも先を読んで選びます', plan: { samples: 140, top: 6 } },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const NAMES = ['あなた', 'ルイス', 'カルメン', 'ディエゴ', 'ソフィア', 'マテオ'];

  // ------------------------------------------------------------------ 設定
  let cfg = Object.assign({ mode: 'cpu', n: 4, cpu: 'normal', rule: 'full' }, store.get('cfg', {}));
  const settings = Object.assign({ sound: true, anim: true, prob: false, rec: false, fast: false }, store.get('settings', {}));
  if (TM) { try { settings.anim = localStorage.getItem('tt-motion') !== '0'; } catch (e) { /* そのまま */ } }
  const aiOn = () => settings.prob || settings.rec;

  // ------------------------------------------------------------------ 状態
  const S = { g: null, seats: [], me: 0, phase: 'idle', sel: { q: 1, f: 2 }, res: null, log: [], gid: '', timer: 0, paused: false, resultShown: false, cpuInfo: null, rolled: false };
  const rnd = Math.random;
  const isHuman = p => S.seats[p] && S.seats[p].kind === 'human';
  const nameOf = p => (S.seats[p] ? S.seats[p].name : '');
  const mePlaying = () => S.me >= 0 && S.g && S.g.alive(S.me) && !S.g.over;
  const humanTurn = () => S.phase === 'bid' && S.g && !S.g.over && isHuman(S.g.turn);

  // ------------------------------------------------------------------ 音（Web Audio でその場で作る）
  let actx = null;
  function tone(kind) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime, out = actx.destination;
      if (kind === 'roll') {
        // カップの中でサイコロが鳴る: 短い雑音を何回か
        for (let i = 0; i < 7; i++) {
          const n = Math.floor(actx.sampleRate * 0.03), buf = actx.createBuffer(1, n, actx.sampleRate), d = buf.getChannelData(0);
          for (let j = 0; j < n; j++) d[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / n, 4);
          const s = actx.createBufferSource(); s.buffer = buf;
          const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800 + Math.random() * 1600; bp.Q.value = 4;
          const g = actx.createGain(); g.gain.value = 0.5;
          s.connect(bp).connect(g).connect(out); s.start(t + i * 0.045 + Math.random() * 0.02);
        }
        return;
      }
      const o = actx.createOscillator(), g = actx.createGain();
      const spec = { bid: [660, 0.06, 'triangle', 0.18], doubt: [220, 0.22, 'sawtooth', 0.12], calza: [880, 0.25, 'sine', 0.2], lose: [150, 0.3, 'triangle', 0.25], gain: [990, 0.3, 'sine', 0.2], tick: [1200, 0.03, 'square', 0.05] }[kind] || [500, 0.05, 'sine', 0.1];
      o.type = spec[2]; o.frequency.setValueAtTime(spec[0], t);
      if (kind === 'lose') o.frequency.exponentialRampToValueAtTime(70, t + spec[1]);
      if (kind === 'gain' || kind === 'calza') o.frequency.exponentialRampToValueAtTime(spec[0] * 1.5, t + spec[1]);
      g.gain.setValueAtTime(spec[3], t); g.gain.exponentialRampToValueAtTime(0.001, t + spec[1] + 0.05);
      o.connect(g).connect(out); o.start(t); o.stop(t + spec[1] + 0.06);
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 小さなサイコロの絵（SVG）
  const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  function dieSVG(v, cls = '') {
    const pos = i => [22 + ((i - 1) % 3) * 28, 22 + Math.floor((i - 1) / 3) * 28];
    const r = v === 1 ? 13 : 9;
    return `<svg class="ds ${cls}" viewBox="0 0 100 100" aria-label="${v}" role="img"><rect class="b" x="5" y="5" width="90" height="90" rx="20"/>${PIPS[v].map(i => { const [x, y] = pos(i); return `<circle class="p${v === 1 ? ' one' : ''}" cx="${x + 6}" cy="${y + 6}" r="${r}"/>`; }).join('')}</svg>`;
  }
  const cupSVG = () => '<svg viewBox="0 0 40 32" aria-hidden="true"><defs><linearGradient id="cupg" x1="0" x2="1"><stop offset="0" stop-color="var(--cup)"/><stop offset=".45" stop-color="var(--cup-hi)"/><stop offset="1" stop-color="var(--cup)"/></linearGradient></defs><path d="M6 30 L9 4 Q20 0 31 4 L34 30 Z" fill="url(#cupg)" stroke="rgba(0,0,0,.35)" stroke-width="1"/><path d="M8 26 Q20 29 32 26" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.5"/></svg>';
  const bidHTML = (a, sz = 16) => (a > 0 ? `<b>${bq(a)}</b>個の${dieSVG(bf(a)).replace('class="ds ', `style="width:${sz}px;height:${sz}px" class="ds `)}` : a === DOUBT ? 'ダウト！' : 'ぴったり！');

  // ------------------------------------------------------------------ 対局の進行
  function newGame(c) {
    cfg = c; store.set('cfg', cfg);
    clearTimeout(S.timer);
    const n = Math.max(2, Math.min(6, c.n | 0));
    const g = new Game(n, { calza: c.rule !== 'simple', palifico: c.rule !== 'simple' });
    S.seats = Array.from({ length: n }, (_, p) => (c.mode === 'watch' || p > 0 ? { kind: 'cpu', level: c.mode === 'watch' ? c.cpu : c.cpu, name: c.mode === 'watch' ? `${NAMES[p] || 'CPU' + p}` : NAMES[p] || 'CPU' + p } : { kind: 'human', name: 'あなた' }));
    if (c.mode === 'watch') S.seats[0].name = 'アナ';
    S.me = c.mode === 'watch' ? -1 : 0;
    g.starter = Math.floor(rnd() * n);
    S.g = g; S.log = []; S.res = null; S.resultShown = false; S.gid = Math.random().toString(36).slice(2, 12); S.cpuInfo = null;
    startRound();
  }
  function startRound() {
    const g = S.g;
    g.startRound(rnd);
    S.res = null; S.phase = 'rolling'; S.rolled = false;
    S.sel = defaultSel();
    save();
    render();
    tone('roll');
    const dice = [...document.querySelectorAll('#mydice .d')];
    const me = S.me >= 0 ? S.me : -1;
    const done = () => { if (S.phase !== 'rolling') return; S.phase = 'bid'; S.rolled = true; render(); schedule(); };
    if (me >= 0 && dice.length && TM && TM.on) {
      Promise.all(dice.map((el, i) => TM.dice(el, g.hands[me][i] || 1, { ms: 650 + i * 40 }))).then(done);
      setTimeout(done, 1400);
    } else setTimeout(done, settings.fast ? 80 : 350);
  }
  function defaultSel() {
    const g = S.g;
    for (const f of [2, 3, 4, 5, 6, 1]) { const m = g.minBid(f); if (m) return { q: bq(m), f }; }
    return { q: 1, f: 2 };
  }
  function schedule() {
    clearTimeout(S.timer);
    const g = S.g;
    if (!g || S.paused || S.phase !== 'bid') return;
    if (g.over) return;
    const p = g.turn;
    if (isHuman(p)) { render(); return; }
    const lvl = CPU[S.seats[p].level] || CPU.normal;
    const t0 = Date.now();
    S.thinking = p;
    renderSeats();
    // CPU が考える（最強は読む。間をとって自然に）
    setTimeout(() => {
      if (S.g !== g || S.phase !== 'bid' || g.turn !== p) return;
      let a;
      if (lvl.plan) { const r = plan(POL, g, p, Object.assign({ rnd }, lvl.plan)); a = r.a; }
      else a = POL.choose(g, p, { temp: lvl.temp, eps: lvl.eps, rnd });
      const wait = Math.max(0, (settings.fast ? 150 : 650 + Math.random() * 450) - (Date.now() - t0));
      S.timer = setTimeout(() => { S.thinking = -1; if (S.g === g && S.phase === 'bid' && g.turn === p) act(a); }, wait);
    }, 30);
  }
  function act(a) {
    const g = S.g, p = g.turn;
    const res = g.act(a);
    S.lastAct = { p, a, t: Date.now() };
    if (!res) {
      tone('bid');
      S.sel = defaultSel();
      save();
      render();
      const bub = document.querySelector(`.seat[data-p="${p}"] .bubble`);
      if (TM && bub) TM.pop(bub, 'land');
      schedule();
      return;
    }
    reveal(res);
  }
  // ラウンドの終わり: 全員のカップを開けて数える
  function reveal(res) {
    S.res = res; S.phase = 'reveal';
    S.log.unshift({ round: S.g.round, res: { kind: res.kind, caller: res.caller, bidder: res.bidder, a: res.a, count: res.count, loser: res.loser, gainer: res.gainer, palifico: res.palifico, hands: res.hands, bids: res.bids.map(b => ({ p: b.p, a: b.a })), eliminated: res.eliminated, winner: res.winner } });
    if (S.log.length > 60) S.log.length = 60;
    tone(res.kind === 'doubt' ? 'doubt' : 'calza');
    save();
    render();
    // 宣言の目を1つずつ数え上げる
    const hits = [...document.querySelectorAll('.ds.hit')];
    hits.forEach((el, i) => setTimeout(() => { if (TM) TM.pop(el, 'land'); tone('tick'); }, 120 + i * (settings.fast ? 30 : 70)));
    const after = 300 + hits.length * (settings.fast ? 30 : 70);
    setTimeout(() => {
      if (S.res !== res) return;
      const who = res.gainer >= 0 ? res.gainer : res.loser;
      tone(res.gainer >= 0 ? 'gain' : 'lose');
      const el = who === S.me ? $('mine') : document.querySelector(`.seat[data-p="${who}"]`);
      if (TM && el) { TM.pop(el, res.gainer >= 0 ? 'glow' : 'shake'); TM.float(res.gainer >= 0 ? '+1' : '−1', el, { size: 22, color: res.gainer >= 0 ? 'var(--good)' : 'var(--bad)', ms: 1100 }); }
      if (res.gainer >= 0 && window.TTJuice && who === S.me) TTJuice.hype('ぴったり！', $('mine'), { tier: 1 });
      S.res.shownLoss = true;
      renderInfo(); renderSeats(); renderMine();
      // 自分が抜けた・対局が終わった
      if ((res.eliminated === S.me || S.g.over) && !S.resultShown && S.me >= 0) { S.resultShown = true; setTimeout(showResult, 700); }
      else if (!isAnyHumanAlive()) S.timer = setTimeout(nextRound, settings.fast ? 600 : 2600);
    }, after);
  }
  const isAnyHumanAlive = () => S.seats.some((s, p) => s.kind === 'human' && S.g.alive(p)) && !S.g.over;
  function nextRound() {
    clearTimeout(S.timer);
    if (!S.g || S.g.over) { render(); return; }
    if (S.phase !== 'reveal') return;
    startRound();
  }

  // ------------------------------------------------------------------ 保存
  function save() {
    const g = S.g;
    if (!g) return;
    store.set('game', { gid: S.gid, cfg, seats: S.seats, me: S.me, phase: S.phase === 'rolling' ? 'bid' : S.phase, resultShown: S.resultShown, log: S.log.slice(0, 20),
      g: { n: g.n, calzaOn: g.calzaOn, palificoOn: g.palificoOn, dice: g.dice, hands: g.hands, palUsed: g.palUsed, out: g.out, starter: g.starter, turn: g.turn, bids: g.bids, palifico: g.palifico, round: g.round, over: g.over } });
  }
  function load(o) {
    const s = o.g, g = new Game(s.n, { calza: s.calzaOn, palifico: s.palificoOn });
    Object.assign(g, { dice: s.dice, hands: s.hands, palUsed: s.palUsed, out: s.out, starter: s.starter, turn: s.turn, bids: s.bids, palifico: s.palifico, round: s.round, over: s.over });
    S.g = g; S.seats = o.seats; S.me = o.me; S.gid = o.gid || Math.random().toString(36).slice(2, 12); S.log = o.log || []; S.resultShown = !!o.resultShown;
    S.res = null; S.sel = defaultSel(); S.rolled = true;
    if (o.cfg) cfg = Object.assign(cfg, o.cfg);
    S.phase = g.over ? 'over' : 'bid';
    render();
    if (o.phase === 'reveal' && !g.over) startRound(); else schedule();
  }

  // ------------------------------------------------------------------ 描画
  function render() {
    renderSeats(); renderCenter(); renderMine(); renderPad(); renderInfo(); renderSide();
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
  }
  function lastBidOf(p) {
    const g = S.g, bids = S.phase === 'reveal' && S.res ? S.res.bids : g.bids;
    for (let i = bids.length - 1; i >= 0; i--) if (bids[i].p === p) return bids[i].a;
    return 0;
  }
  function pipsHTML(k) { let h = ''; for (let i = 0; i < D.MAXD; i++) h += `<i class="${i < k ? '' : 'off'}"></i>`; return `<span class="pips" aria-label="サイコロ ${k}個">${h}</span>`; }
  function handHTML(hand, a, wild, size = 16) {
    const f = bf(a);
    return hand.map(v => dieSVG(v, (v === f || (wild && f !== 1 && v === 1)) ? 'hit' : 'dim').replace('class="ds', `style="width:${size}px;height:${size}px" class="ds`)).join('');
  }
  function renderSeats() {
    const g = S.g, el = $('opps');
    if (!g) { el.innerHTML = ''; return; }
    const order = S.me >= 0 ? Array.from({ length: g.n - 1 }, (_, i) => (S.me + 1 + i) % g.n) : Array.from({ length: g.n - 1 }, (_, i) => i + 1);
    el.style.setProperty('--no', String(order.length));
    const res = S.phase === 'reveal' ? S.res : null;
    el.innerHTML = order.map(p => {
      const st = S.seats[p];
      const turn = S.phase === 'bid' && g.turn === p && !g.over;
      const lb = lastBidOf(p), call = res && res.caller === p;
      const bub = call ? `<span class="bubble call">${res.kind === 'doubt' ? 'ダウト！' : 'ぴったり！'}</span>` : `<span class="bubble">${lb ? bidHTML(lb, 14) : ''}</span>`;
      const shown = res && res.hands[p] && res.hands[p].length ? `<div class="shown">${handHTML(res.hands[p], res.a, res.palifico < 0, 15)}</div>` : '';
      const dcount = res && res.shownLoss ? g.dice[p] : res ? res.hands[p].length : g.dice[p];
      return `<div class="seat${turn ? ' turn' : ''}${!g.alive(p) && (!res || res.shownLoss) ? ' out' : ''}" data-p="${p}">
        ${turn && S.thinking === p ? '<span class="think" aria-hidden="true"></span>' : ''}
        <span class="nm">${esc(st.name)}</span><span class="lv">${CPU[st.level] ? CPU[st.level].label : ''}</span>
        ${shown || `<span class="cup">${cupSVG()}</span>`}
        ${pipsHTML(dcount)}
        ${bub}
      </div>`;
    }).join('');
  }
  function renderCenter() {
    const g = S.g, el = $('center');
    if (!g) { el.innerHTML = '<div class="bidnow none">「新しい対局」で始めます</div>'; return; }
    const res = S.phase === 'reveal' ? S.res : null;
    const a = res ? res.a : g.cur();
    let html = '';
    const pal = (res ? res.palifico : g.palifico);
    if (pal >= 0) html += `<span class="palbadge" title="1はワイルドにならず、目は変えられません">パリフィコ（${esc(nameOf(pal))}）</span>`;
    if (a) {
      const who = res ? res.bidder : g.bids[g.bids.length - 1].p;
      html += `<div class="bidnow"><span class="q">${bq(a)}</span><span class="x">個の</span>${dieSVG(bf(a))}<span class="x">以上</span></div>`;
      html += `<div class="bidwho">${esc(nameOf(who))}の宣言${pal < 0 && bf(a) !== 1 ? '（1もその目として数える）' : ''}</div>`;
    } else html += `<div class="bidnow none">${S.phase === 'rolling' ? 'サイコロを振っています…' : `${esc(nameOf(g.turn))}が最初の宣言をします`}</div><div class="bidwho">全員のサイコロ ${g.total()}個</div>`;
    if (res) {
      const ok = res.count >= bq(res.a), exact = res.count === bq(res.a);
      const verdict = res.kind === 'doubt' ? (ok ? '宣言どおり → ダウト失敗' : '足りない → ダウト成功') : (exact ? 'ぴったり成功！' : 'ぴったりならず');
      html += `<div class="tally">数えると <b>${res.count}</b>個　${verdict}</div>`;
    } else {
      const bids = g.bids;
      if (bids.length > 1) html += `<div class="histline">${bids.slice(0, -1).map(b => `<span class="${b.p === S.me ? 'me' : ''}">${esc(nameOf(b.p))} ${bidHTML(b.a, 12)}</span>`).join('')}</div>`;
    }
    el.innerHTML = html;
  }
  function renderMine() {
    const g = S.g, el = $('mine');
    if (!g || S.me < 0) {
      // 観戦: 先頭の席を下に
      if (g && S.me < 0) {
        const res = S.phase === 'reveal' ? S.res : null, p = 0;
        el.className = `mine${S.phase === 'bid' && g.turn === p ? ' turn' : ''}`;
        el.innerHTML = `<div class="row">${esc(nameOf(p))}（${CPU[S.seats[p].level].label}）${pipsHTML(res && res.shownLoss ? g.dice[p] : g.dice[p])}<span class="bubble">${lastBidOf(p) ? bidHTML(lastBidOf(p), 14) : ''}</span></div>${res ? `<div class="mydice">${handHTML(res.hands[p], res.a, res.palifico < 0, 30)}</div>` : ''}`;
      } else el.innerHTML = '';
      return;
    }
    const me = S.me, res = S.phase === 'reveal' ? S.res : null;
    const hand = res ? res.hands[me] : g.hands[me];
    el.className = `mine${humanTurn() ? ' turn' : ''}`;
    const lb = lastBidOf(me), call = res && res.caller === me;
    const f = res ? bf(res.a) : 0, wild = res ? res.palifico < 0 : g.wild();
    const cnt = res && res.shownLoss ? g.dice[me] : hand.length;
    let dice = '';
    for (let i = 0; i < hand.length; i++) {
      const v = hand[i], hit = res && (v === f || (wild && f !== 1 && v === 1));
      dice += `<span class="d${hit ? ' hit' : ''}" data-i="${i}"></span>`;
    }
    const sub = !g.alive(me) && (!res || res.shownLoss) ? '<span style="color:var(--hit)">抜けました（観戦中）</span>' : '';
    el.innerHTML = `<div class="row">あなた ${pipsHTML(cnt)}${call ? `<span class="bubble call" style="font-size:12px;padding:1px 8px;border-radius:999px;background:var(--hit);color:#3a2604">${res.kind === 'doubt' ? 'ダウト！' : 'ぴったり！'}</span>` : lb ? `<span style="font-size:12px;opacity:.9">あなたの宣言 ${bidHTML(lb, 13)}</span>` : ''}${sub}</div><div class="mydice" id="mydice">${dice}</div>`;
    // サイコロ（立方体）を置く。振っている間は startRound が転がす
    const els = el.querySelectorAll('.d');
    els.forEach((d, i) => {
      if (TM) { if (S.phase !== 'rolling') TM.dice(d, hand[i], { roll: false }); }
      else d.innerHTML = dieSVG(hand[i]);
    });
  }
  // 宣言の操作
  function renderPad() {
    const g = S.g, el = $('bidpad');
    if (!g || S.me < 0 || !g.alive(S.me) || g.over) {
      el.className = 'bidpad off';
      el.innerHTML = `<div class="hint" style="text-align:center;padding:6px">${!g ? '' : g.over ? '対局は終わりました' : S.me < 0 ? 'CPU どうしの対局を観戦しています' : 'あなたは抜けました。CPU どうしの続きを観戦しています'}</div>`;
      return;
    }
    const my = humanTurn();
    el.className = `bidpad${my ? '' : ' off'}`;
    const cur = g.cur(), T = g.total();
    let faces = '';
    for (let f = 1; f <= 6; f++) {
      const m = g.minBid(f);
      faces += `<button type="button" data-f="${f}" aria-pressed="${S.sel.f === f}"${!m || !my ? ' disabled' : ''} aria-label="${f}の目${m ? `（${bq(m)}個から）` : '（言えない）'}">${dieSVG(f)}<small>${m ? `${bq(m)}〜` : '—'}</small></button>`;
    }
    const minq = g.minBid(S.sel.f) ? bq(g.minBid(S.sel.f)) : 0;
    const okBid = my && minq && S.sel.q >= minq && S.sel.q <= T && g.canBid(bid(S.sel.q, S.sel.f));
    // AI補助: 宣言が本当の確率・ダウトの当たる確率・おすすめ
    let prob = '', recA = 0;
    if (my && settings.prob && okBid) prob = `本当の確率 ${(truthProb(g, S.me, bid(S.sel.q, S.sel.f)).atLeast * 100).toFixed(0)}%`;
    if (my && settings.rec) recA = recommend();
    const dprob = my && settings.prob && cur ? (1 - truthProb(g, S.me, cur).atLeast) : -1, cprob = my && settings.prob && cur ? truthProb(g, S.me, cur).exactly : -1;
    const recTag = a => (recA === a ? '<span class="rec">おすすめ</span>' : '');
    el.innerHTML = `
      <div class="faces" role="group" aria-label="目を選ぶ">${faces}</div>
      <div class="qrow">
        <button class="step" data-q="-1" aria-label="個数を減らす"${!my || S.sel.q <= minq ? ' disabled' : ''}>−</button>
        <span class="qv" aria-live="polite">${S.sel.q}<small>個</small></span>
        <button class="step" data-q="1" aria-label="個数を増やす"${!my || S.sel.q >= T ? ' disabled' : ''}>＋</button>
        <span class="prob">${prob}${recA > 0 ? `${prob ? '・' : ''}おすすめ ${bq(recA)}個の${bf(recA)}` : ''}</span>
        <button class="bigbtn bid go" data-act="bid"${okBid ? '' : ' disabled'}>宣言する${recA === bid(S.sel.q, S.sel.f) ? '<span class="rec">おすすめ</span>' : ''}</button>
      </div>
      <div class="callrow">
        <button class="bigbtn doubt" data-act="doubt"${my && cur ? '' : ' disabled'}>ダウト！<small>${dprob >= 0 ? `当たる確率 ${(dprob * 100).toFixed(0)}%` : 'うそだと思ったら'}</small>${recTag(DOUBT)}</button>
        <button class="bigbtn calza" data-act="calza"${my && cur && g.calzaOn ? '' : ' disabled'}>ぴったり！<small>${cprob >= 0 ? `当たる確率 ${(cprob * 100).toFixed(0)}%` : g.calzaOn ? 'ちょうどだと思ったら' : 'この決まりではなし'}</small>${recTag(CALZA)}</button>
      </div>`;
  }
  let recCache = { key: '', a: 0 };
  function recommend() {
    const g = S.g, key = `${g.round}|${g.bids.length}|${g.turn}`;
    if (recCache.key === key) return recCache.a;
    const r = plan(POL, g, S.me, { samples: 100, top: 6, rnd });
    recCache = { key, a: r.a, est: r.est };
    return r.a;
  }
  function renderInfo() {
    const g = S.g, el = $('info');
    let cls = 'info', html = '', tools = '';
    if (!g) html = '「新しい対局」で始めます';
    else if (S.phase === 'reveal' && S.res) {
      const r = S.res;
      cls += ' result';
      const who = r.gainer >= 0 ? r.gainer : r.loser;
      const txt = r.gainer >= 0 ? `${esc(nameOf(who))}がサイコロを1個取り戻しました` : `${esc(nameOf(who))}がサイコロを1個失いました${r.eliminated === who ? '（抜けました）' : ''}`;
      html = r.shownLoss ? (g.over ? `<b>${esc(nameOf(g.ranking()[0]))}の勝ち！</b>　${txt}` : txt) : `${esc(nameOf(r.caller))}の${r.kind === 'doubt' ? 'ダウト' : 'ぴったり'}…カップを開けます`;
      if (r.shownLoss && !g.over && isAnyHumanAlive()) tools = '<button class="btn small primary" data-act="next">次のラウンドへ</button>';
      if (g.over) tools = '<button class="btn small primary" data-act="again">もう一局</button>';
    } else if (g.over) { cls += ' result'; html = `<b>${esc(nameOf(g.ranking()[0]))}の勝ち</b>`; tools = '<button class="btn small primary" data-act="again">もう一局</button>'; }
    else if (S.phase === 'rolling') html = `第${g.round}ラウンド　サイコロを振っています…`;
    else if (humanTurn()) {
      cls += ' alert';
      const cur = g.cur();
      html = cur ? `<b>あなたの番</b>　「${bq(cur)}個の${bf(cur)}」より上か、ダウト・ぴったり` : '<b>あなたの番</b>　最初の宣言を' + (g.palifico >= 0 ? '（1も可）' : '（1は不可）');
    } else html = `第${g.round}ラウンド　<b>${esc(nameOf(g.turn))}</b>が考えています…　全員のサイコロ ${g.total()}個`;
    el.className = cls;
    el.innerHTML = `<span class="txt">${html}</span><span class="tools">${tools}</span>`;
  }
  function renderSide() {
    const g = S.g;
    // AI の読み
    const ev = $('evcard');
    if (!aiOn()) ev.innerHTML = '<h2>AI の読み</h2><p class="hint" style="margin:0">「AI補助」を押すと、宣言が本当である確率と CPU のおすすめを出します。</p>';
    else if (!g || !humanTurn()) ev.innerHTML = '<h2>AI の読み</h2><p class="hint" style="margin:0">あなたの番になると読みます。</p>';
    else {
      const cur = g.cur();
      let html = '<h2>AI の読み<span class="grow">あなたの番</span></h2>';
      if (cur && settings.prob) {
        const tp = truthProb(g, S.me, cur);
        html += `<div class="evnum"><span class="v">${(tp.atLeast * 100).toFixed(0)}%</span><span class="lbl">今の宣言（${bq(cur)}個の${bf(cur)}）が本当の確率<br>あなたの目だけから計算・ほかの人の目はでたらめとして</span></div>`;
      }
      if (settings.rec) {
        recommend();
        const est = (recCache.est || []).slice().sort((a, b) => b.v - a.v);
        html += `<p class="hint" style="margin:8px 0 2px">CPU（最強）の読み: 候補の行動と「このラウンドでサイコロを失う見込み」</p><ul class="opts">${est.map((e, i) => `<li class="${i === 0 ? 'top' : ''}"><span>${e.a > 0 ? `${bq(e.a)}個の ${dieSVG(bf(e.a))}` : e.a === DOUBT ? 'ダウト' : 'ぴったり'}</span><span class="v">${Math.max(0, Math.round(-e.v * 100))}%</span></li>`).join('')}</ul>`;
      }
      ev.innerHTML = html;
    }
    // 記録
    $('log-info').textContent = g ? `第${g.round}ラウンド` : '';
    $('log').innerHTML = S.log.map(L => {
      const r = L.res, q = bq(r.a);
      const who = r.gainer >= 0 ? `${esc(nameOf(r.gainer))} +1` : `${esc(nameOf(r.loser))} −1`;
      const hands = r.hands.map((h, p) => (h.length ? `<span>${esc(nameOf(p))} ${h.map(v => dieSVG(v, (v === bf(r.a) || (r.palifico < 0 && bf(r.a) !== 1 && v === 1)) ? 'hit' : '')).join('')}</span>` : '')).join('');
      return `<li><b>第${L.round}R</b> ${esc(nameOf(r.bidder))}「${q}個の${dieSVG(bf(r.a))}」に ${esc(nameOf(r.caller))}が${r.kind === 'doubt' ? 'ダウト' : 'ぴったり'} → ${r.count}個・${who}<div class="hands">${hands}</div></li>`;
    }).join('') || '<li class="hint">まだありません</li>';
  }

  // ------------------------------------------------------------------ 入力
  function onPad(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled || !humanTurn()) return;
    const g = S.g, T = g.total();
    if (b.dataset.f) {
      const f = Number(b.dataset.f), m = g.minBid(f);
      if (!m) return;
      // 同じ目なら個数はそのまま（足りなければ最小に）、違う目なら最小の個数に
      S.sel = { f, q: f === S.sel.f ? Math.max(bq(m), S.sel.q) : bq(m) };
      tone('tick'); renderPad(); return;
    }
    if (b.dataset.q) { S.sel.q = Math.max(1, Math.min(T, S.sel.q + Number(b.dataset.q))); tone('tick'); renderPad(); return; }
    const act0 = b.dataset.act;
    if (act0 === 'bid') { const a = bid(S.sel.q, S.sel.f); if (g.canBid(a)) act(a); }
    else if (act0 === 'doubt' && g.cur()) act(DOUBT);
    else if (act0 === 'calza' && g.cur() && g.calzaOn) act(CALZA);
  }

  // ------------------------------------------------------------------ 終わり
  function showResult() {
    const g = S.g;
    if (S.me < 0) return;
    const rank = g.ranking();
    // 自分が途中で抜けたときは、その時点の順位（残っている人の数 + 1）
    const myPlace = g.alive(S.me) ? 1 : (g.n - g.out.indexOf(S.me));
    $('rs-sub').textContent = `${g.n}人・第${g.round}ラウンドまで・CPU ${CPU[cfg.cpu].label}`;
    $('rs-title').textContent = myPlace === 1 ? 'あなたの勝ち！' : `${myPlace}位`;
    const placeOf = p => (g.alive(p) ? (g.over ? 1 : 0) : g.n - g.out.indexOf(p));
    const rows = S.seats.map((s, p) => ({ p, pl: placeOf(p) })).sort((a, b) => (a.pl || 0.5) - (b.pl || 0.5));
    $('rs-rank').innerHTML = rows.map(r => `<li class="${r.p === S.me ? 'me' : ''}"><span class="pl">${r.pl ? r.pl + '位' : '—'}</span><span>${esc(nameOf(r.p))}${S.seats[r.p].kind === 'cpu' ? `（${CPU[S.seats[r.p].level].label}）` : ''}</span><span>${g.dice[r.p] ? `サイコロ ${g.dice[r.p]}個` : ''}</span></li>`).join('');
    $('rs-body').textContent = g.over ? '' : 'CPU どうしの続きは、閉じると観戦できます。';
    if (window.TTJuice) TTJuice.result({ outcome: myPlace === 1 ? 'win' : 'lose', place: myPlace, of: g.n, stars: CPU[cfg.cpu].stars, id: S.gid, ref: S.res });
    $('dlg-result').hidden = false;
    $('rs-again').focus();
    void rank;
  }

  // ------------------------------------------------------------------ 新しい対局のダイアログ（common/setup.js が読む形）
  let draft = null;
  function openNew() { draft = Object.assign({}, cfg); drawNew(); $('dlg-new').hidden = false; S.paused = true; clearTimeout(S.timer); }
  function closeNew() { $('dlg-new').hidden = true; if (S.paused) { S.paused = false; if (S.g && S.phase === 'bid') schedule(); else if (S.g && S.phase === 'reveal' && !isAnyHumanAlive()) S.timer = setTimeout(nextRound, 1200); } }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['watch', 'CPUどうしを観戦']], draft.mode);
    $('ng-mode-hint').textContent = draft.mode === 'watch' ? 'CPU だけで最後まで遊びます（XP は入りません）' : '';
    seg('ng-n', [2, 3, 4, 5, 6].map(n => [n, `${n}人`]), draft.n);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(CPU_KEYS.length - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-rule', [['full', 'ぴったり・パリフィコあり'], ['simple', 'ダウトだけ']], draft.rule);
    $('ng-rule-hint').textContent = draft.rule === 'simple' ? '「ぴったり」と「パリフィコ」なしの、いちばん簡単な決まり' : '伝わっている決まりどおり（くわしくは「遊び方」）';
  }

  // ------------------------------------------------------------------ ルール / AI のページ
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
  function renderRules() {
    const d = v => dieSVG(v);
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>2〜6人。はじめは1人5個のサイコロをカップに入れて振ります。<b>自分の目だけ</b>見られます。</li>
          <li>順番に「<b>全員の目の中に、○の目が△個以上ある</b>」と宣言していきます。前の人より大きい宣言をするか、「<b>ダウト</b>」（うそだ！）か「<b>ぴったり</b>」と言います。</li>
          <li>ダウト・ぴったりのとき、全員のカップを開けて数えます。外れた人がサイコロを1個失います。サイコロがなくなった人は抜けます。<b>最後まで残った人の勝ち</b>。</li>
          <li><b>1の目はワイルド</b>: ほかの目を数えるとき、1もその目として数えます（1を宣言したときは1だけ）。</li>
        </ul>
        <div class="ex">例: 全員の目が ${d(2)}${d(2)}${d(1)}${d(5)}${d(6)} と ${d(1)}${d(3)}${d(2)}${d(4)}${d(4)} なら、「2」は ${d(2)}${d(2)}${d(2)} と ${d(1)}${d(1)} で5個</div>
      </div>
      <div class="card" data-tab="宣言のきまり">
        <h3>宣言のきまり</h3>
        <ul>
          <li>前の宣言より大きく: <b>個数を増やす</b>（目は自由）か、<b>同じ個数でもっと大きい目</b>（2&lt;3&lt;4&lt;5&lt;6）。</li>
          <li><b>1への切り替え</b>: 1は数えられやすい目が少ないので、個数は前の個数の<b>半分（切り上げ）以上</b>でよい（例: 「5個の4」のあと「3個の1」）。</li>
          <li><b>1から別の目へ</b>: 前の個数の<b>2倍＋1以上</b>（例: 「3個の1」のあと「7個の5」）。</li>
          <li>ラウンドの最初の宣言で1は言えません（パリフィコのラウンドは別）。</li>
          <li>宣言の操作: 目のボタン（下の小さな数字は、その目で言える一番小さい個数）を押してから、＋−で個数を決めて「宣言する」。</li>
        </ul>
      </div>
      <div class="card" data-tab="ダウトとぴったり">
        <h3>ダウトとぴったり</h3>
        <ul>
          <li><b>ダウト</b>: 直前の宣言はうそだと思ったら。数えて<b>宣言どおり（以上）なら、ダウトした人</b>が1個失う。<b>足りなければ、宣言した人</b>が1個失う。</li>
          <li><b>ぴったり</b>: 直前の宣言の個数が<b>ちょうど</b>だと思ったら。当たれば言った人がサイコロを<b>1個取り戻す</b>（5個まで）。外れたら言った人が1個失う。</li>
          <li>サイコロを失った人（取り戻した人）が次のラウンドを始めます。抜けた人がいれば、その次の人から。</li>
        </ul>
      </div>
      <div class="card" data-tab="パリフィコ">
        <h3>パリフィコ</h3>
        <ul>
          <li>だれかのサイコロが<b>はじめて1個</b>になったら、次のラウンドはその人から始める<b>パリフィコ</b>。</li>
          <li>パリフィコのラウンドでは、<b>1はワイルドになりません</b>。最初の宣言の<b>目のまま、個数だけ</b>を上げていきます（最初の宣言は1でもよい）。</li>
          <li>残りが2人になったら、パリフィコはもう起きません。新しい対局で「ダウトだけ」を選ぶと、ぴったりとパリフィコなしで遊べます。</li>
        </ul>
      </div>
      <div class="card" data-tab="この版について">
        <h3>この版について</h3>
        <p>南米（チリ・ペルーなど）に昔から伝わる「ドゥード」（スペイン語で「疑う」）の決まりにならっています。サイコロを使ったはったりの遊びは世界中にあり、決まりは地域によって少しずつ違います。この画面では上の決まりで遊びます。</p>
        <p class="hint">CPU は、この決まりで自分どうしで遊んだ結果だけから学んでいます（「AI」のページ）。</p>
      </div>`;
    docTabs($('view-rules'), 'rules');
  }
  function renderAIPage() {
    const h = (W && W.history) || [];
    const gen = W ? W.gen || 0 : 0, total = W ? W.totalGames || 0 : 0;
    const rows = h.slice(-30).reverse().map(e => `<tr><td>第${e.gen + 1}世代${e.accept ? '' : '（候補）'}</td><td>${(e.games || 0).toLocaleString()}局</td><td>${e.match ? `${(e.match.share * 100).toFixed(1)}%（${e.match.games.toLocaleString()}局）` : '—'}</td><td>${e.accept ? '採用' : '不採用'}</td></tr>`).join('');
    const lvName = k => (CPU[k] ? CPU[k].label : k === 'ultra' ? '超最強の候補（最強の5倍読む）' : k);
    const lvRows = LV && LV.pairs ? LV.pairs.map(p => `<tr><td>${lvName(p.a)} vs ${lvName(p.b)}${p.note ? `<br><small style="color:var(--muted)">${esc(p.note)}</small>` : ''}</td><td>${(p.share * 100).toFixed(1)}%</td><td>${p.win != null ? `${(p.win * 100).toFixed(0)}%（互角なら${(p.even * 100).toFixed(0)}%）` : ''}</td><td>${p.games}局</td></tr>`).join('') : '';
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習世代</span></div>
          <div class="stat"><b>${total.toLocaleString()}</b><span>自己対局（累計局数）</span></div>
        </div>
        <p class="hint" style="margin:12px 0 4px">世代ごとの検定: 学んだ新しい版と前の版を同じ卓にまぜて（2〜6人）対戦させ、順位の点の取り分が半分を下回らなければ採用。</p>
        <div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>自己対局</th><th>新しい版の取り分</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">まだありません</td></tr>'}</tbody></table></div>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ（すべて自作・人の知識なし）</h3>
        <ul>
          <li><b>何も知らない状態から</b>: 最初（第0世代）は全部の重みが 0 で、でたらめに宣言します。確率の計算も、うまい人の考え方も教えていません。</li>
          <li><b>学ぶもの</b>: 「この局面でこの行動をしたら、このラウンドで自分のサイコロが減るか」の見込み。特徴は、宣言の個数から自分の手の中の数を引いた「足りない数」と「見えないサイコロの数」の組（表）、宣言の上げ幅、目を変えたか、ほかの人がその目を何回言ったか、人数、サイコロの数など。自己対局の結果に合わせて重みを直すことをくり返します。</li>
          <li><b>最強</b>: 学んだ値をもとに、相手の目を「その人がこのラウンドに言った宣言の起こりやすさ」で重み付けして何通りも引き、有力な行動ごとにラウンドの終わりまで指し進めて比べます（考える時間を使う分だけ強い）。</li>
          <li><b>AI補助</b>の「本当である確率」は、あなたの目だけを見て、ほかの目をでたらめとしたときの確率です（二項分布）。CPU の判断には使っていません。</li>
        </ul>
      </div>
      <div class="card" data-tab="CPU の強さ">
        <h3>CPU の${CPU_KEYS.length}段階</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>特徴</th></tr></thead><tbody>${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].desc}</td></tr>`).join('')}</tbody></table></div>
        ${lvRows ? `<p class="hint" style="margin:12px 0 4px">段階どうしの対戦（上の段を1席、下の段をほかの席にした2〜4人の卓で、上の段の順位の点（1位 = 1・最下位 = 0）の平均。互角なら 50%）</p><div class="tbl"><table class="lv"><thead><tr><th>対戦</th><th>順位の点</th><th>1位</th><th>局数</th></tr></thead><tbody>${lvRows}</tbody></table></div><p class="hint" style="margin:8px 0 0">超最強（最強の5倍読む）は最強とほぼ互角だったので、段には入れていません。</p>` : ''}
      </div>`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ パネル（狭い画面）
  const narrow = () => window.matchMedia('(max-width: 979px)').matches;
  function openSheet(tab) {
    const side = $('side');
    side.dataset.tab = tab;
    side.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === tab)));
    if (!narrow()) return;
    side.style.setProperty('--sheet-top', Math.round(window.innerHeight * 0.4) + 'px');
    side.classList.add('open');
  }
  function closeSheet() { $('side').classList.remove('open'); }
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.tm); toast.tm = setTimeout(() => { t.hidden = true; }, 2200); }
  function setSetting(k, v) {
    settings[k] = v; store.set('settings', settings);
    const box = { prob: 'set-prob', rec: 'set-rec' }[k];
    if (box) $(box).checked = v;
    render();
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      $('main').classList.toggle('scroll', b.dataset.tab !== 'play');
      if (b.dataset.tab === 'rules' && !$('view-rules').innerHTML) renderRules();
      if (b.dataset.tab === 'ai') renderAIPage();
    }));
    $('bidpad').addEventListener('click', onPad);
    $('info').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'next') nextRound();
      else if (b.dataset.act === 'again') newGame(cfg);
    });
    $('btn-new').addEventListener('click', openNew);
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); settings.prob = on; settings.rec = on; store.set('settings', settings); $('set-prob').checked = on; $('set-rec').checked = on; render(); });
    $('btn-panel').addEventListener('click', () => openSheet('ev'));
    $('btn-panel2').addEventListener('click', () => openSheet('log'));
    $('btn-resign').addEventListener('click', () => { if (S.g && !S.g.over && confirm('この対局をやめますか？（負けになります）')) { if (S.me >= 0 && !S.resultShown && S.g.alive(S.me)) { S.g.dice[S.me] = 0; S.g.out.push(S.me); S.resultShown = true; showResult(); } } });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    [['set-prob', 'prob'], ['set-rec', 'rec'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-fast', 'fast']].forEach(([id, k]) => {
      const el = $(id);
      el.checked = settings[k];
      el.addEventListener('change', () => { if (k === 'anim' && TM) TM.set(el.checked); setSetting(k, el.checked); });
    });
    $('side').addEventListener('click', e => { const t = e.target.closest('[data-st]'); if (t) { openSheet(t.dataset.st); return; } if (e.target.closest('[data-act="sheet-close"]')) closeSheet(); });
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('.seg button, .cards button');
      if (b) {
        const id = b.parentElement.id, v = b.dataset.v;
        if (id === 'ng-mode') draft.mode = v;
        else if (id === 'ng-n') draft.n = Number(v);
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-rule') draft.rule = v;
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) closeNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; S.paused = false; newGame(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; newGame(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; openSheet('log'); afterResultClosed(); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) { $('dlg-result').hidden = true; afterResultClosed(); } });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); if (!$('dlg-new').hidden) closeNew(); if (!$('dlg-result').hidden) { $('dlg-result').hidden = true; afterResultClosed(); } $('settings').hidden = true; $('menu-more').hidden = true; return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if ([...document.querySelectorAll('.overlay')].some(o => !o.hidden)) return;
      if (S.phase === 'reveal' && (e.key === 'Enter' || e.key === ' ')) { const b = document.querySelector('#info [data-act="next"]'); if (b) { e.preventDefault(); nextRound(); } return; }
      if (!humanTurn()) return;
      const k = e.key;
      if (/^[1-6]$/.test(k)) { const btn = document.querySelector(`#bidpad [data-f="${k}"]`); if (btn && !btn.disabled) btn.click(); }
      else if (k === 'ArrowUp' || k === '+') { e.preventDefault(); const b = document.querySelector('#bidpad [data-q="1"]'); if (b && !b.disabled) b.click(); }
      else if (k === 'ArrowDown' || k === '-') { e.preventDefault(); const b = document.querySelector('#bidpad [data-q="-1"]'); if (b && !b.disabled) b.click(); }
      else if (k === 'Enter') { const b = document.querySelector('#bidpad [data-act="bid"]'); if (b && !b.disabled) b.click(); }
      else if (k === 'd' || k === 'D') { const b = document.querySelector('#bidpad [data-act="doubt"]'); if (b && !b.disabled) b.click(); }
    });
    window.addEventListener('resize', () => { if ($('side').classList.contains('open')) openSheet($('side').dataset.tab); });
  }
  // 結果を閉じたあと: 自分が抜けた対局は、CPU どうしの続きを観戦
  function afterResultClosed() {
    if (S.g && !S.g.over && S.phase === 'reveal') S.timer = setTimeout(nextRound, 900);
  }

  bind();
  const saved = store.get('game', null);
  if (saved && saved.g && Array.isArray(saved.seats)) {
    try { load(saved); } catch (e) { newGame(cfg); }
  } else {
    render();
    S.paused = true;
    openNew();
  }
})();
