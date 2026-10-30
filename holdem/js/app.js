/* ホールデム Webアプリ: 卓の画面・CPU・演出と音・AI補助・ハンドの履歴（オンラインの卓は online-table.js） */
(function () {
  'use strict';
  const H = window.HoldemCore, A = window.HoldemAI;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CANCEL = { cancel: true };

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('holdem-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('holdem-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: 'よくコールして、あまりレイズしません。はじめての人向け' },
    normal: { label: 'ふつう', stars: 2, desc: '学習した打ち方に、ときどき単純な判断やでたらめが混ざります' },
    strong: { label: 'つよい', stars: 3, desc: '自己対局（CFR）で学んだ打ち方の表どおりに打ちます' },
    max: { label: '最強', stars: 4, desc: '学んだ打ち方を土台に、相手の手札を推定して先を何百通りも試してから選びます。あなたの癖も読みます' },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const SPEEDS = { none: { label: '上がらない', hands: 0 }, slow: { label: 'ゆっくり', hands: 16 }, normal: { label: 'ふつう', hands: 10 }, fast: { label: 'はやい', hands: 6 } };
  const MODES = { sng: { label: 'シットアンドゴー', hint: '最後の1人になるまで。チップがなくなったら終わり（ブラインドは上がっていきます）' }, cash: { label: 'キャッシュ', hint: 'チップがなくなったら補充して、いつまでも続けます。成績は増えたチップで見ます' } };
  const NAMES = [['Σ', 'シグマ'], ['Δ', 'デルタ'], ['Ω', 'オメガ'], ['Λ', 'ラムダ'], ['Ψ', 'プサイ'], ['Φ', 'ファイ'], ['Θ', 'シータ'], ['Ξ', 'クシー']];
  const BB0 = 20;
  let cfg = Object.assign({ players: 6, cpu: 'normal', mode: 'sng', stack: 100, speed: 'normal' }, store.get('cfg', {}));
  if (!CPU[cfg.cpu]) cfg.cpu = 'normal';
  const settings = Object.assign({ eq: true, rec: true, sound: true, anim: true, four: false, fast: true, bb: false }, store.get('settings', {}));
  const aiOn = () => settings.eq || settings.rec;

  // ------------------------------------------------------------------ 学習した打ち方の表（js/weights.js、圧縮してある）
  let TABLE = null, tableMeta = null;
  async function loadWeights() {
    const w = window.HOLDEM_WEIGHTS;
    if (!w || !w.z || w.nInfo !== A.N_INFO) return;
    try {
      const bin = Uint8Array.from(atob(w.z), c => c.charCodeAt(0));
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([bin]).stream().pipeThrough(ds)).arrayBuffer();
      TABLE = new Uint8Array(buf);
      tableMeta = { iters: w.iters, visited: w.visited, date: w.date };
      if (worker) worker.postMessage({ t: 'init', table: TABLE });
    } catch (e) { console.warn('打ち方の表を読めませんでした', e); }
  }
  // CPU の思考は別のスレッド（ワーカー）で。使えなければその場で
  let worker = null, wid = 0;
  const wjobs = new Map();
  try {
    worker = new Worker('js/ai-worker.js');
    worker.onmessage = e => { const j = wjobs.get(e.data.id); if (j) { wjobs.delete(e.data.id); j(e.data); } };
    worker.onerror = () => { worker = null; };
  } catch (e) { worker = null; }
  // 画面が裏にあっても間引かれにくいタイマー（オンラインのホストの進行用）。戻り値は止めるための関数
  function wTimeout(fn, ms) {
    if (!worker) { const h = setTimeout(fn, ms); return () => clearTimeout(h); }
    const id = ++wid;
    let live = true;
    wjobs.set(id, () => { if (live) { live = false; fn(); } });
    worker.postMessage({ t: 'timer', id, ms });
    return () => { live = false; wjobs.delete(id); };
  }
  function decideAsync(s, p, level, models) {
    const local = () => A.decide(s, p, level, { table: TABLE, rng, models });
    // ワーカーが遅いとき（PC が混んでいるときなど）は、重い探索をこちらでやり直さず、学んだ表だけで打つ
    const quick = () => A.decide(s, p, level === 'max' ? 'strong' : level, { table: TABLE, rng });
    if (!worker || !TABLE) return Promise.resolve(level === 'max' ? quick() : local());
    return new Promise(res => {
      const id = ++wid;
      const timer = setTimeout(() => { if (wjobs.has(id)) { wjobs.delete(id); res(quick()); } }, 6000);
      wjobs.set(id, m => { clearTimeout(timer); res(m.d && !m.err ? m.d : quick()); });
      worker.postMessage({ t: 'decide', id, s, p, level, models: models || null });
    });
  }
  const rng = (() => {
    const seed = new Uint32Array(1);
    try { crypto.getRandomValues(seed); } catch (e) { seed[0] = Date.now(); }
    return H.makeRng(seed[0]);
  })();
  function secureDeck() {
    const d = [];
    for (let i = 0; i < 52; i++) d.push(i);
    const r = new Uint32Array(52);
    try { crypto.getRandomValues(r); } catch (e) { for (let i = 0; i < 52; i++) r[i] = rng.u32(); }
    for (let i = 51; i > 0; i--) { const j = r[i] % (i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }

  // ------------------------------------------------------------------ 卓と今のハンド
  // T.seats[i]: { name, av, kind: 'me'|'cpu'|'remote'|'empty', level, stack, out, place, away, ai, hints }
  const T = { seats: [], button: -1, level: 0, handNo: 0, mode: 'sng', speed: 'normal', startStack: 2000, mySeat: 0, over: false, online: false, bb: BB0, sb: BB0 / 2, rebuys: 0 };
  let S = null;            // 今のハンド: { s: エンジンの状態, deck, map: エンジンの番号 → 席, rec: 履歴の記録 }
  const D = { bets: [], tags: {}, street: 0, revealed: {}, winners: null, banner: '', dealt: false, hidden: new Set() };
  const history = store.get('hist', []).slice(-60);
  let view = null;         // 見返し中: { h: 履歴の番号, k: 何手目まで }
  let epoch = 0;           // 新しいゲームで古い進行を止める
  let humanWait = null;    // 自分の番で入力を待っている Promise の resolve
  let fastForward = false;
  let hintShown = null;
  let assistCache = null;
  let myHints = 0;
  const stats = Object.assign({ hands: 0, net: 0, games: 0, wins: 0 }, store.get('stats', {}));

  const seatOfEng = p => (S ? S.map[p] : -1);
  const engOfSeat = i => (S ? S.map.indexOf(i) : -1);
  const fmt = (x, bb) => {
    bb = bb || (S ? S.s.bb : T.bb);
    if (settings.bb) { const v = x / bb; return (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'BB'; }
    return Math.round(x).toLocaleString('ja-JP');
  };
  const nameOf = i => (T.seats[i] ? T.seats[i].name : '');
  const isMe = i => T.seats[i] && T.seats[i].kind === 'me';
  const myEng = () => engOfSeat(T.mySeat);

  // ------------------------------------------------------------------ 音（WebAudio で合成）
  let actx = null;
  function ac() {
    if (!settings.sound) return null;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (e) { return null; }
  }
  function noise(a, t, len, freq, q, gain, type) {
    const n = Math.floor(a.sampleRate * len), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = a.createGain(); g.gain.setValueAtTime(gain, t);
    src.connect(f).connect(g).connect(a.destination); src.start(t);
  }
  function tone(a, t, freq, len, gain, type) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + len + 0.02);
  }
  const SFX = {
    card() { const a = ac(); if (!a) return; const t = a.currentTime; noise(a, t, 0.05, 2600, 1.4, 0.9); noise(a, t + 0.012, 0.03, 900, 1, 0.4, 'lowpass'); },
    flip() { const a = ac(); if (!a) return; const t = a.currentTime; noise(a, t, 0.06, 3200, 1.2, 0.7); },
    chip(k = 1) {
      const a = ac(); if (!a) return; const t = a.currentTime;
      for (let i = 0; i < Math.min(k, 4); i++) { const u = t + i * 0.045 + Math.random() * 0.01; tone(a, u, 3100 + Math.random() * 900, 0.07, 0.12, 'triangle'); tone(a, u, 5200 + Math.random() * 700, 0.04, 0.05); noise(a, u, 0.025, 4500, 2, 0.35); }
    },
    check() { const a = ac(); if (!a) return; const t = a.currentTime; for (const d of [0, 0.11]) { tone(a, t + d, 180, 0.08, 0.35); noise(a, t + d, 0.04, 400, 1, 0.5, 'lowpass'); } },
    fold() { const a = ac(); if (!a) return; noise(a, a.currentTime, 0.18, 1800, 0.6, 0.35); },
    turn() { const a = ac(); if (!a) return; const t = a.currentTime; tone(a, t, 880, 0.35, 0.08); tone(a, t + 0.09, 1320, 0.45, 0.06); },
    shuffle() { const a = ac(); if (!a) return; const t = a.currentTime; for (let i = 0; i < 9; i++) noise(a, t + i * 0.035, 0.04, 2200 + i * 80, 1.1, 0.35); },
    win() { const a = ac(); if (!a) return; const t = a.currentTime; [523, 659, 784, 1047].forEach((f, i) => tone(a, t + i * 0.08, f, 0.5, 0.07)); for (let i = 0; i < 6; i++) setTimeout(() => SFX.chip(1), 120 + i * 60); },
    lose() { const a = ac(); if (!a) return; const t = a.currentTime; [392, 330].forEach((f, i) => tone(a, t + i * 0.14, f, 0.45, 0.06)); },
  };

  // ------------------------------------------------------------------ 画面の配置（卓の大きさ・席の位置）
  const L = { side: true, w: 0, h: 0, tw: 0, th: 0, cx: 0, cy: 0, rx: 0, ry: 0, cw: 40, hcw: 56, ocw: 26, sw: 112, chip: 16, av: 30 };
  const ANG = {
    land: { 2: [90, 270], 3: [90, 205, 335], 4: [90, 180, 270, 0], 5: [90, 155, 230, 310, 25], 6: [90, 148, 212, 270, 328, 32] },
    port: { 2: [90, 270], 3: [90, 210, 330], 4: [90, 180, 270, 0], 5: [90, 155, 225, 315, 25], 6: [90, 152, 208, 270, 332, 28] },
  };
  function fitLayout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    L.side = vw >= vh * 1.05 && vw >= 560;
    const play = $('view-play');
    play.classList.toggle('stack', !L.side);
    if (L.side) document.documentElement.style.setProperty('--panel-w', Math.round(Math.max(236, Math.min(330, vw * 0.27))) + 'px');
    const st = $('stage').getBoundingClientRect();
    L.w = st.width; L.h = st.height;
    const land = L.w >= L.h * 1.05;
    L.land = land;
    // 席・カードの大きさは卓の高さ（縦長では幅）から
    const base = land ? Math.min(L.h, L.w / 1.7) : Math.min(L.w * 1.15, L.h * 0.62);
    L.av = Math.round(clamp(base * 0.085, 24, 40));
    L.sw = Math.round(clamp(base * 0.3, 88, 150));
    L.ocw = Math.round(clamp(base * 0.07, 18, 40));
    L.hcw = Math.round(clamp(base * 0.15, 38, 84));
    L.cw = Math.round(clamp(base * 0.115, 28, 70));
    L.chip = Math.round(clamp(base * 0.045, 12, 22));
    const pillH = L.av + 10;
    // 卓の楕円: 上は相手のカードが少しはみ出す分、下は自分の席の分あける
    const topM = pillH / 2 + L.ocw * 0.75 + 4, botM = pillH / 2 + 6, sideM = land ? L.sw * 0.42 : L.sw * 0.36;
    let tw = L.w - 2 * sideM, th = L.h - topM - botM;
    if (land) { if (tw > th * 2.25) tw = th * 2.25; if (tw < th * 1.45) th = tw / 1.45; }
    else { if (th > tw * 1.75) th = tw * 1.75; if (th < tw * 1.15) tw = th / 1.15; }
    L.tw = Math.round(tw); L.th = Math.round(th);
    L.cx = L.w / 2;
    L.cy = topM + (L.h - topM - botM) / 2;
    L.rx = L.tw / 2; L.ry = L.th / 2;
    const tb = $('table');
    tb.style.setProperty('--tw', L.tw + 'px'); tb.style.setProperty('--th', L.th + 'px'); tb.style.setProperty('--mark', Math.round(Math.min(L.th * 0.075, L.tw * 0.058)) + 'px'); tb.style.setProperty('--railw', Math.round(clamp(L.th * 0.05, 9, 22)) + 'px');
    tb.style.top = L.cy + 'px';
    const stg = $('stage').style;
    stg.setProperty('--cw', L.cw + 'px'); stg.setProperty('--hcw', L.hcw + 'px'); stg.setProperty('--ocw', L.ocw + 'px');
    stg.setProperty('--sw', L.sw + 'px'); stg.setProperty('--chip', L.chip + 'px'); stg.setProperty('--av', L.av + 'px');
    stg.setProperty('--db', Math.round(clamp(L.th * 0.07, 16, 28)) + 'px');
    // 場の中央（ポットと場のカード）は少し上に
    stg.setProperty('--cy', (L.cy - L.ry * (land ? 0.12 : 0.1)) + 'px');
    stg.setProperty('--by', (L.cy + L.ry * (land ? 0.3 : 0.28)) + 'px');
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // 席 i の画面上の位置（自分が下になるように回す）
  function seatAngle(i) {
    const n = T.seats.length;
    const vis = (i - T.mySeat + n) % n;
    const set = (L.land ? ANG.land : ANG.port)[n] || ANG.land[6];
    return set[vis] * Math.PI / 180;
  }
  function seatXY(i) {
    const a = seatAngle(i);
    let x = L.cx + L.rx * Math.cos(a), y = L.cy + L.ry * Math.sin(a);
    if (Math.abs(Math.sin(a)) > 0.99 && Math.sin(a) > 0) y = L.cy + L.ry - 2; // 自分の席は下の縁に
    // 左右の端の席は卓の外へはみ出しすぎないように
    x = clamp(x, L.sw / 2 + 2, L.w - L.sw / 2 - 2);
    return { x, y };
  }
  function betXY(i) {
    const a = seatAngle(i), s = Math.sin(a), c = Math.cos(a);
    if (s > 0.99) return { x: L.cx + L.hcw * 1.25, y: L.cy + L.ry * 0.38 };
    const kx = L.land ? 0.66 : 0.6, ky = L.land ? 0.55 : 0.62;
    return { x: L.cx + L.rx * c * kx, y: L.cy + L.ry * s * ky };
  }
  function dealerXY(i) {
    const a = seatAngle(i) + (L.land ? -0.32 : -0.42), s = Math.sin(seatAngle(i));
    if (s > 0.99) return { x: L.cx - L.hcw * 1.45, y: L.cy + L.ry * 0.5 };
    return { x: L.cx + L.rx * Math.cos(a) * 0.74, y: L.cy + L.ry * Math.sin(a) * 0.72 };
  }

  // ------------------------------------------------------------------ カードとチップの部品
  const SUITC = ['s', 'h', 'd', 'c'];
  function cardHTML(c, opt = {}) {
    const cls = ['card'];
    if (opt.down) cls.push('down');
    if (opt.cls) cls.push(opt.cls);
    const style = opt.w || opt.hide ? ` style="${opt.w ? `--w:${opt.w}px;` : ''}${opt.hide ? 'opacity:0' : ''}"` : '';
    if (c == null || c < 0) return `<div class="${cls.join(' ')} down"${style}><div class="face"></div><div class="back"></div></div>`;
    const r = c >> 2, s = c & 3;
    const red = s === 1 || s === 2;
    const rk = H.RANK_JA[r];
    return `<div class="${cls.join(' ')}"${style} data-c="${c}"><div class="face ${red ? 'r' : ''} ${SUITC[s]}"><span class="rk${rk === '10' ? ' ten' : ''}">${rk}</span>` +
      `<span class="s1"><svg viewBox="0 0 100 100"><use href="#s-${SUITC[s]}"/></svg></span><span class="s2"><svg viewBox="0 0 100 100"><use href="#s-${SUITC[s]}"/></svg></span></div><div class="back"></div></div>`;
  }
  const miniCard = c => `<span class="mc ${c & 3 ? ((c & 3) === 1 ? 'r h' : (c & 3) === 2 ? 'r d' : 'c') : ''}">${H.SUIT_MARK[c & 3]}${H.RANK_JA[c >> 2]}</span>`;
  const miniCards = cs => `<span class="mini-cards">${cs.map(miniCard).join('')}</span>`;
  const CHIPS = [[25000, '#c2185b'], [5000, '#2c6fb5'], [1000, '#d9a12b'], [500, '#6b3fa0'], [100, '#232326'], [25, '#2f8f4e'], [5, '#c43a2e'], [1, '#d8d2c4']];
  function chipStackHTML(amount) {
    const cols = [];
    let x = amount;
    for (const [v, col] of CHIPS) { while (x >= v && cols.length < 6) { cols.push(col); x -= v; } if (cols.length >= 6) break; }
    if (!cols.length) cols.push(CHIPS[CHIPS.length - 1][1]);
    cols.reverse();
    return `<span class="stackc" style="--n:${cols.length}">${cols.map((c, i) => `<i class="chip" style="--c:${c};--i:${i}"></i>`).join('')}</span>`;
  }

  // ------------------------------------------------------------------ 描画
  // 今見せている状態（ライブか、見返し中のハンド）
  function shown() {
    if (view) return view.state;
    return S ? { s: S.s, map: S.map, bets: D.bets, live: true } : null;
  }
  function render() {
    fitLayout();
    renderSeats();
    renderCenter();
    renderDealer();
    renderStatus();
    renderAssist();
    renderControls();
    renderLog();
    $('banner').hidden = !D.banner || !!view;
    if (D.banner && !view) $('banner').textContent = D.banner;
  }
  function renderSeats() {
    const box = $('seats');
    const sh = shown();
    const s = sh && sh.s;
    const n = T.seats.length;
    if (box.children.length !== n) box.innerHTML = Array.from({ length: n }, (_, i) => `<div class="seat" data-seat="${i}"></div>`).join('');
    for (let i = 0; i < n; i++) {
      const el = box.children[i], seat = T.seats[i];
      const p = s ? sh.map.indexOf(i) : -1;
      const pos = seatXY(i);
      el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px';
      const me = i === T.mySeat;
      const cls = ['seat'];
      if (me) cls.push('me');
      if (seat.kind === 'remote' || seat.kind === 'me') cls.push('human');
      if (seat.kind === 'empty') cls.push('empty');
      if (seat.out && p < 0) cls.push('out');
      if (seat.away) cls.push('away');
      if (s && p >= 0) {
        if (s.folded[p]) cls.push('folded');
        if (s.phase === 'bet' && s.toAct === p) cls.push('turn');
        if (s.result && s.result.won[p] > 0 && (!sh.live || D.winners)) cls.push('win');
      }
      el.className = cls.join(' ');
      // カード
      let cards = '';
      if (s && p >= 0 && seat.kind !== 'empty') {
        const hole = s.hole[p];
        const showdown = s.result && !s.result.byFold && s.result.contenders.includes(p) && (!sh.live || D.revealed[p]);
        const faceUp = (me && hole) || showdown || (!sh.live && hole && view && view.allOpen) || (sh.live && D.revealed[p] && hole);
        const hidden = sh.live && D.hidden.has(i);
        const winCards = sh.live ? D.winCards : (view && view.winCards);
        for (let k = 0; k < 2; k++) {
          let c = '';
          if (faceUp && hole) {
            let wc = '';
            if (s.result && !s.result.byFold && winCards && (!sh.live || D.winners)) wc = winCards.has(hole[k]) ? 'win' : (s.result.won[p] > 0 ? '' : 'lose');
            c = cardHTML(hole[k], { cls: wc + (sh.live && D.flipSeat === i ? ' flip-in' : ''), hide: hidden });
          } else c = cardHTML(null, { hide: hidden });
          cards += c;
        }
      }
      // 名前とチップ
      let stack = seat.stack;
      if (s && p >= 0) stack = s.stack[p];
      const tag = sh && sh.live ? D.tags[i] : (view && view.tags ? view.tags[i] : null);
      const allin = s && p >= 0 && s.allin[p] && !s.folded[p] && s.phase !== 'done';
      const avTxt = seat.kind === 'empty' ? '' : esc(seat.av || seat.name.slice(0, 1));
      const ai = seat.kind === 'remote' ? `<span class="aitag ${seat.ai || seat.hints ? 'on' : 'off'}" title="${seat.ai ? 'AI補助を使っています' : 'AI補助なし'}${seat.hints ? `・ヒント${seat.hints}回` : ''}">${seat.ai ? 'AI補助' : '補助なし'}${seat.hints ? '・ヒ' + seat.hints : ''}</span>` : '';
      const stTxt = seat.kind === 'empty' ? '空席' : seat.out && p < 0 ? (seat.place ? `${seat.place}位` : '—') : allin ? 'オールイン' : fmt(stack);
      el.innerHTML = `<div class="cards">${cards}</div>
        <div class="pill">${tag ? `<span class="tag ${tag.cls}${tag.pop ? ' pop' : ''}">${esc(tag.text)}</span>` : ''}
          <span class="av">${avTxt}</span>
          <span class="nm" title="${seat.kind === 'cpu' ? 'CPU（' + (CPU[seat.level] || CPU.normal).label + '）' : ''}"><span class="tx">${esc(seat.kind === 'empty' ? '—' : seat.name)}</span></span>
          <span class="st num">${stTxt}${seat.away ? '<small>離席</small>' : ''}</span></div>
        ${ai ? `<div class="info">${ai}</div>` : ''}`;
      if (tag) tag.pop = false;
    }
    D.flipSeat = -1;
    // 賭け
    box.querySelectorAll('.bet').forEach(b => b.remove());
    if (s) {
      const bets = sh.live ? D.bets : s.bet;
      for (let p = 0; p < s.n; p++) {
        if (!bets[p]) continue;
        const i = sh.map[p], q = betXY(i);
        const b = document.createElement('div');
        b.className = 'bet'; b.dataset.seat = i;
        b.style.left = q.x + 'px'; b.style.top = q.y + 'px';
        b.innerHTML = `${chipStackHTML(bets[p])}<span class="amt num">${fmt(bets[p])}</span>`;
        box.appendChild(b);
      }
    }
  }
  function renderCenter() {
    const sh = shown(), s = sh && sh.s;
    const board = $('board');
    const cards = s ? s.board : [];
    let html = '';
    const winCards = sh && sh.live ? D.winCards : (view && view.winCards);
    for (let k = 0; k < 5; k++) {
      if (k < cards.length && !(sh.live && D.boardHidden && k >= D.boardShown)) {
        let wc = '';
        if (s.result && !s.result.byFold && winCards && (!sh.live || D.winners)) wc = winCards.has(cards[k]) ? 'win' : 'lose';
        html += cardHTML(cards[k], { cls: wc + (sh.live && D.flipBoard && D.flipBoard.has(k) ? ' flip-in' : '') });
      } else html += '<div class="slot"></div>';
    }
    board.innerHTML = html;
    board.style.setProperty('--w', L.cw + 'px');
    board.querySelectorAll('.card').forEach(c => c.style.setProperty('--w', L.cw + 'px'));
    if (sh && sh.live) D.flipBoard = null;
    // ポット（テーブルに出ている賭けは別）
    const pot = $('pot');
    if (!s) { pot.innerHTML = ''; return; }
    const bets = sh.live ? D.bets : s.bet;
    let inFront = 0; for (let p = 0; p < s.n; p++) inFront += bets[p] || 0;
    const total = H.potTotal(s);
    let main = total - inFront;
    if (s.phase === 'done' && (!sh.live || D.winners)) main = 0;
    let side = '';
    if (s.phase !== 'done') {
      const pots = H.sidePots(s);
      if (pots.length > 1 && D.street === s.street) side = `<span class="side">（サイド ${pots.slice(1).map(x => fmt(x.amt)).join('・')}）</span>`;
    }
    pot.innerHTML = main > 0 ? `${chipStackHTML(main)}<span class="lab num">ポット ${fmt(main)}</span>${side}` : '';
  }
  function renderDealer() {
    const sh = shown(), d = $('dealer');
    if (!sh || !sh.s) { d.hidden = true; return; }
    const i = sh.map[sh.s.button];
    const q = dealerXY(i);
    d.hidden = false;
    d.style.left = q.x + 'px'; d.style.top = q.y + 'px';
  }

  // 情報の行
  let statusOverride = null;
  function renderStatus() {
    const st = $('status'), txt = $('status-txt'), tools = $('status-tools');
    st.className = 'status';
    let h = '', t = '';
    if (view) {
      st.classList.add('view');
      const rec = history[view.h];
      h = `見返し中 <b>#${rec.no}</b>　${esc(view.label || '')}`;
      t = `<button class="btn small" data-act="live">卓に戻る</button>`;
    } else if (statusOverride) {
      st.classList.add(statusOverride.cls || '');
      h = statusOverride.html;
    } else if (T.online && T.onlineStatus) {
      h = T.onlineStatus;
    } else if (!S) {
      h = T.over ? 'ゲームが終わりました' : '「新しいゲーム」から始めます';
    } else {
      const s = S.s, me = myEng();
      if (s.phase === 'bet' && s.toAct === me && humanWait) {
        st.classList.add('turn');
        const Lg = H.legal(s);
        const left = T.online && T.deadline ? Math.max(0, Math.ceil((T.deadline - Date.now()) / 1000)) : 0;
        h = `<b>あなたの番</b>${left ? `<small>（残り${left}秒）</small>` : ''}　ポット ${fmt(H.potTotal(s))}` + (Lg.toCall > 0 ? `・コールは ${fmt(Lg.toCall)}（必要な勝率 ${Math.round(100 * Lg.toCall / (H.potTotal(s) + Lg.toCall))}%）` : '');
        if (hintShown) h = `ヒント: <b>${esc(hintShown)}</b>`;
      } else if (s.phase === 'bet' && s.toAct >= 0) {
        h = `${esc(nameOf(seatOfEng(s.toAct)))} が考えています…`;
      } else h = D.lastLine || H.STREET_NAMES[Math.min(4, s.street)];
    }
    // 縦長の画面では、ヒント・AI補助・履歴・メニューを情報の行の右に小さく
    if (!view && !L.side) {
      t += `<button class="ibtn" data-act="hint" aria-label="ヒント" title="ヒント"><svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg></button>` +
        `<button class="ibtn ${aiOn() ? 'on' : ''}" data-act="ai" aria-label="AI補助" aria-pressed="${aiOn()}" title="AI補助（勝率とおすすめ）"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>` +
        `<button class="ibtn" data-act="hist" aria-label="ハンドの履歴" title="ハンドの履歴"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg></button>` +
        `<button class="ibtn" data-act="menu" aria-label="メニュー" title="メニュー"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg></button>`;
      if (st.classList.contains('turn')) h = h.replace(/ポット [^・（]+・/, '').replace('必要な勝率', '必要');
    }
    txt.innerHTML = h;
    tools.innerHTML = t;
    $('navrow').hidden = !view;
    if (view) renderTape();
  }
  function setStatus(html, cls) { statusOverride = html ? { html, cls } : null; renderStatus(); }

  // AI補助: 勝率とおすすめ
  function renderAssist() {
    const box = $('assist');
    const sh = shown();
    const on = aiOn() || !!hintShown;
    const s = sh && sh.s;
    const p = s ? sh.map.indexOf(T.mySeat) : -1;
    if (!on || !s || p < 0 || !s.hole[p] || (s.folded[p] && !view)) { box.classList.add('off'); return; }
    box.classList.remove('off');
    const key = `${view ? 'v' + view.h + ':' + view.k : 'L' + T.handNo}:${s.street}:${s.board.length}:${s.toAct}:${s.log ? s.log.length : 0}:${s.folded.join('')}`;
    if (!assistCache || assistCache.key !== key) assistCache = computeAssist(s, p, key);
    const a = assistCache;
    $('as-eq').textContent = settings.eq || view ? Math.round(a.eq * 100) + '%' : '—';
    $('as-bar').style.width = (settings.eq || view ? a.eq * 100 : 0) + '%';
    const need = $('as-need');
    if (a.need > 0 && (settings.eq || view)) { need.hidden = false; need.style.left = (a.need * 100) + '%'; } else need.hidden = true;
    const rec = $('as-rec');
    if (a.rec && (settings.rec || hintShown || view)) {
      const parts = a.rec.filter(x => x.p >= 0.03).sort((x, y) => y.p - x.p);
      rec.innerHTML = `おすすめ ${parts.map((x, j) => `<span class="${j ? '' : 'best'}">${esc(x.label)} ${Math.round(x.p * 100)}%</span>`).join('・')}`;
    } else rec.innerHTML = a.need > 0 ? `必要な勝率 ${Math.round(a.need * 100)}%（${a.nOpp}人を相手に）` : `${a.nOpp}人を相手にしたときの勝率`;
  }
  function computeAssist(s, p, key) {
    let nOpp = 0;
    for (let q = 0; q < s.n; q++) if (q !== p && !s.folded[q]) nOpp++;
    const eq = A.equity(s.hole[p], s.board, Math.max(1, nOpp), 2500, rng).eq;
    let need = 0, rec = null;
    if (s.phase === 'bet' && s.toAct === p) {
      const Lg = H.legal(s);
      if (Lg.toCall > 0) need = Lg.toCall / (H.potTotal(s) + Lg.toCall);
      const R = A.recommend(s, p, { table: TABLE, rng }, 1200);
      rec = R.acts.map((x, j) => ({ slot: x.slot, a: x.a, p: R.probs[j], label: actLabel(s, Lg, x) }));
    }
    return { key, eq, need, rec, nOpp };
  }
  function actLabel(s, Lg, x) {
    if (x.slot === 0) return 'フォールド';
    if (x.slot === 1) return Lg.toCall > 0 ? 'コール' : 'チェック';
    if (x.slot === 4) return 'オールイン';
    const pot = Lg.pot + Lg.toCall, extra = x.a.to - Lg.curBet;
    const frac = extra / Math.max(1, pot);
    const word = Lg.curBet > 0 ? 'レイズ' : 'ベット';
    return `${word}（${frac < 0.6 ? '小' : '大'}）`;
  }

  // 操作ボタン
  let raiseTo = 0;
  function renderControls() {
    const s = S && S.s, me = myEng();
    const myTurn = !view && s && s.phase === 'bet' && s.toAct === me && !!humanWait;
    const Lg = myTurn ? H.legal(s) : null;
    const fold = $('btn-fold'), call = $('btn-call'), raise = $('btn-raise');
    $('actions').classList.toggle('waiting', !myTurn);
    if (!myTurn) {
      fold.disabled = call.disabled = raise.disabled = true;
      fold.innerHTML = 'フォールド'; call.innerHTML = 'チェック'; raise.innerHTML = 'レイズ<small></small>';
      $('sizer').style.visibility = 'hidden';
      // ハンドの合間や観戦中の案内
      if (!view && !T.online && (!S || (s && s.phase === 'done'))) {
        call.disabled = false;
        call.innerHTML = T.over ? '新しいゲーム' : '次のハンド';
      }
      if (!view && !S && !T.over && !T.seats.length) { call.disabled = false; call.innerHTML = 'ゲームを始める'; }
    } else {
      fold.disabled = Lg.toCall === 0;
      call.disabled = false;
      const allinCall = Lg.toCall > 0 && Lg.toCall >= Lg.stack;
      call.innerHTML = Lg.toCall === 0 ? 'チェック' : `${allinCall ? 'オールイン' : 'コール'}<small class="num">${fmt(Lg.toCall)}</small>`;
      raise.disabled = !Lg.canRaise;
      $('sizer').style.visibility = Lg.canRaise ? 'visible' : 'hidden';
      if (Lg.canRaise) {
        const unit = Math.max(1, s.sb);
        if (!(raiseTo >= Lg.minTo && raiseTo <= Lg.maxTo)) raiseTo = defaultRaise(s, Lg);
        const rg = $('range');
        rg.min = Lg.minTo; rg.max = Lg.maxTo; rg.step = unit; rg.value = raiseTo;
        $('range-out').textContent = fmt(raiseTo);
        const word = raiseTo >= Lg.maxTo ? 'オールイン' : Lg.curBet > 0 ? 'レイズ' : 'ベット';
        raise.innerHTML = `${word}<small class="num">${fmt(raiseTo)}</small>`;
        $('presets').querySelectorAll('button').forEach(b => b.classList.toggle('on', presetTo(s, Lg, b.dataset.size) === raiseTo));
      }
    }
    [fold, call, raise].forEach(b => b.classList.remove('hint-on'));
    if (myTurn && hintShown && hintSlot != null) {
      const b = hintSlot === 0 ? fold : hintSlot === 1 ? call : raise;
      b.classList.add('hint-on');
    }
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
  }
  let hintSlot = null;
  function presetTo(s, Lg, k) {
    if (k === 'min') return Lg.minTo;
    if (k === 'all') return Lg.maxTo;
    const f = +k, unit = Math.max(1, s.sb);
    let to = Lg.curBet + f * (Lg.pot + Lg.toCall);
    if (s.street === 0 && Lg.curBet <= s.bb && f === 0.5) to = Math.max(to, s.bb * 2.5);
    to = Math.round(to / unit) * unit;
    return clamp(to, Lg.minTo, Lg.maxTo);
  }
  function defaultRaise(s, Lg) {
    if (s.street === 0 && s.raises === 0) return clamp(Math.round(s.bb * 2.5 / Math.max(1, s.sb)) * Math.max(1, s.sb) + s.callers * s.bb, Lg.minTo, Lg.maxTo);
    return presetTo(s, Lg, s.street === 0 ? '1' : '0.5');
  }

  // 右のパネルの「このハンド」の流れ
  function renderLog() {
    const list = $('log-list');
    if (!L.side || window.innerHeight < 480) return;
    const rec = view ? history[view.h] : S && S.rec;
    $('log-no').textContent = rec ? `#${rec.no}` : '';
    if (!rec) { list.innerHTML = ''; return; }
    const evs = handEvents(rec, view ? view.k : null);
    list.innerHTML = evs.map(e => e.street != null ? `<li class="st">${H.STREET_NAMES[e.street]}${e.cards ? ' ' + miniCards(e.cards) : ''}</li>`
      : `<li class="${e.me ? 'me' : ''} ${e.win ? 'win' : ''}"><span class="who">${esc(e.who)}</span><span class="what">${e.what}</span></li>`).join('');
    list.parentElement.scrollTop = list.parentElement.scrollHeight;
  }
  // 記録から、行動と場のカードの並び（k を指定すると k 手目まで）
  function handEvents(rec, kMax) {
    const out = [];
    const st = replayState(rec, kMax == null ? rec.acts.length : kMax, true);
    for (const e of st.s.log || []) {
      if (e.t === 'deal') { out.push({ street: e.st, cards: e.cards }); continue; }
      if (e.t === 'hole') { out.push({ street: 0 }); continue; }
      if (['f', 'x', 'c', 'b', 'r', 'sb', 'bb'].includes(e.t)) {
        const i = rec.map[e.p];
        out.push({ who: rec.names[e.p], me: i === rec.mySeat, what: esc(H.actionText(e, x => fmt(x, rec.bb))) });
      }
      if (e.t === 'win') out.push({ who: rec.names[e.p], win: true, what: `${fmt(e.amt, rec.bb)} を獲得` });
    }
    if (st.s.result && !st.s.result.byFold) {
      out.push({ street: 4 });
      for (const p of st.s.result.contenders) out.push({ who: rec.names[p], me: rec.map[p] === rec.mySeat, win: st.s.result.won[p] > 0, what: `${miniCards(st.s.hole[p] || [])} ${H.handName(st.s.result.values[p])}${st.s.result.won[p] ? '・' + fmt(st.s.result.won[p], rec.bb) : ''}` });
    }
    return out;
  }

  // ------------------------------------------------------------------ 演出
  const animOn = () => settings.anim && !reduceMotion;
  const speed = () => (fastForward || T.watching ? 0.3 : 1);
  function sleep(ms) {
    const e = epoch;
    return new Promise((res, rej) => setTimeout(() => (e === epoch ? res() : rej(CANCEL)), ms));
  }
  // 要素 el を from（画面上の位置）から to へ飛ばす
  function fly(html, from, to, ms, scaleFrom = 1, scaleTo = 1) {
    if (!animOn()) return Promise.resolve();
    const el = document.createElement('div');
    el.className = 'flying';
    el.innerHTML = html;
    el.style.left = '0px'; el.style.top = '0px';
    $('stage').appendChild(el);
    const r = el.getBoundingClientRect(), st = $('stage').getBoundingClientRect();
    const w = r.width, h = r.height;
    const fx = st.left + from.x - w / 2, fy = st.top + from.y - h / 2, tx = st.left + to.x - w / 2, ty = st.top + to.y - h / 2;
    const anim = el.animate([
      { transform: `translate(${fx}px, ${fy}px) scale(${scaleFrom})`, opacity: 1 },
      { transform: `translate(${tx}px, ${ty}px) scale(${scaleTo})`, opacity: 1 },
    ], { duration: ms * speed(), easing: 'cubic-bezier(.25,.8,.25,1)', fill: 'forwards' });
    // 画面が裏にあると動きが止まることがあるので、時間が来たら必ず片づける
    return Promise.race([anim.finished, new Promise(r => setTimeout(r, ms * speed() + 120))]).then(() => el.remove(), () => el.remove());
  }
  const centerXY = () => ({ x: L.cx, y: parseFloat(getComputedStyle($('stage')).getPropertyValue('--cy')) || L.cy });
  function elXY(el) {
    const r = el.getBoundingClientRect(), st = $('stage').getBoundingClientRect();
    return { x: r.left - st.left + r.width / 2, y: r.top - st.top + r.height / 2 };
  }
  function potXY() { const el = $('pot'); return el.children.length ? elXY(el) : { x: L.cx, y: centerXY().y - L.cw }; }

  // 手札を配る（1枚ずつ、ボタンの左から）
  async function animDeal() {
    const s = S.s;
    const order = [];
    for (let k = 0; k < 2; k++) for (let j = 1; j <= s.n; j++) order.push([(s.button + j) % s.n, k]);
    D.hidden = new Set(S.map);
    render();
    if (!animOn()) { D.hidden.clear(); render(); return; }
    SFX.shuffle();
    await sleep(260);
    const c = centerXY();
    for (const [p, k] of order) {
      const i = S.map[p];
      const seatEl = $('seats').children[i];
      const target = seatEl.querySelectorAll('.cards .card')[k];
      const to = target ? elXY(target) : seatXY(i);
      const w = i === T.mySeat ? L.hcw : L.ocw;
      SFX.card();
      fly(cardHTML(null, { w }), c, to, 300, 0.7, 1).then(() => {
        if (target) { target.style.opacity = ''; target.classList.remove('ghost'); }
      });
      await sleep(70);
    }
    await sleep(320);
    D.hidden.clear();
    render();
  }
  // 賭けのチップが席から前へ
  async function animBet(i, amount) {
    if (!animOn() || amount <= 0) return;
    SFX.chip(2);
    await fly(chipStackHTML(amount), seatXY(i), betXY(i), 260);
  }
  // ラウンドの終わりに賭けをポットへ集める
  async function animCollect() {
    if (!D.bets.some(x => x > 0)) return;
    if (animOn()) {
      const to = potXY(), jobs = [];
      for (let p = 0; p < D.bets.length; p++) {
        if (!D.bets[p]) continue;
        jobs.push(fly(chipStackHTML(D.bets[p]), betXY(S.map[p]), to, 340));
      }
      D.bets = D.bets.map(() => 0);
      renderSeats();
      SFX.chip(3);
      await Promise.all(jobs);
    }
    D.bets = D.bets.map(() => 0);
    render();
  }
  // 場のカードをめくる
  async function animBoard(count) {
    const s = S.s;
    const start = s.board.length - count;
    D.boardHidden = true; D.boardShown = start;
    render();
    for (let k = start; k < s.board.length; k++) {
      D.boardShown = k + 1;
      D.flipBoard = new Set([k]);
      renderCenter();
      SFX.flip();
      await sleep(animOn() ? 170 : 0);
    }
    D.boardHidden = false;
    await sleep(animOn() ? 260 : 60);
  }
  // ポットを勝った人へ
  async function animAward() {
    const s = S.s, res = s.result;
    if (!res) return;
    const from = potXY();
    const jobs = [];
    for (let p = 0; p < s.n; p++) {
      if (!res.won[p]) continue;
      jobs.push(fly(chipStackHTML(res.won[p]), from, seatXY(S.map[p]), 520));
    }
    D.winners = true;
    render();
    if (jobs.length) SFX.chip(4);
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------------ ゲームの進行（手元の卓）
  function newGame(c) {
    epoch++;
    if (window.HoldemOnline && window.HoldemOnline.active()) window.HoldemOnline.leave();
    cfg = Object.assign({}, cfg, c || {});
    store.set('cfg', cfg);
    T.online = false;
    T.mode = cfg.mode; T.speed = cfg.speed; T.level = 0; T.handNo = 0; T.over = false; T.rebuys = 0; T.watching = false;
    T.bb = BB0; T.sb = BB0 / 2;
    T.startStack = cfg.stack * BB0;
    const names = NAMES.slice().sort(() => rng() - 0.5);
    T.seats = [];
    for (let i = 0; i < cfg.players; i++) {
      if (i === 0) T.seats.push({ name: 'あなた', av: '你', kind: 'me', stack: T.startStack, out: false });
      else T.seats.push({ name: names[i - 1][1], av: names[i - 1][0], kind: 'cpu', level: cfg.cpu, stack: T.startStack, out: false });
    }
    T.seats[0].av = '◆';
    T.mySeat = 0;
    T.button = Math.floor(rng() * cfg.players);
    S = null; view = null; D.banner = ''; statusOverride = null; myHints = 0;
    if (cfg.mode === 'sng') { stats.games++; store.set('stats', stats); }
    saveTable();
    runTable(epoch);
  }
  function blindsFor(level) {
    const lv = H.BLIND_LEVELS[Math.min(level, H.BLIND_LEVELS.length - 1)];
    return { sb: lv[0], bb: lv[1] };
  }
  async function runTable(e) {
    render();
    try {
      while (e === epoch) {
        if (checkOver()) return;
        await playHand();
        if (checkOver()) return;
        await betweenHands();
      }
    } catch (err) {
      if (err !== CANCEL) console.error(err);
    }
  }
  function alive() { return T.seats.filter(x => x.kind !== 'empty' && x.stack > 0); }
  function checkOver() {
    if (T.online) return false;
    const me = T.seats[T.mySeat];
    if (T.mode === 'cash') {
      if (me.stack <= 0 && !T.over) { showCashBust(); return true; }
      return false;
    }
    const left = alive();
    if ((me.stack <= 0 && !T.watching) || left.length <= 1) { if (!T.over) gameOver(); return true; }
    return false;
  }
  function startHand() {
    T.handNo++;
    // ブラインド
    if (T.mode === 'sng' && SPEEDS[T.speed].hands > 0) T.level = Math.floor((T.handNo - 1) / SPEEDS[T.speed].hands);
    const bl = T.mode === 'sng' ? blindsFor(T.level) : { sb: BB0 / 2, bb: BB0 };
    T.bb = bl.bb; T.sb = bl.sb;
    // キャッシュでは CPU のチップを補充
    if (T.mode === 'cash') for (const x of T.seats) if (x.kind === 'cpu' && x.stack < T.bb * 10) x.stack = T.startStack;
    const stacks = T.seats.map(x => (x.kind === 'empty' || x.away ? 0 : x.stack));
    T.button = H.nextButton(stacks, T.button < 0 ? 0 : T.button);
    const map = [];
    for (let j = 0; j < T.seats.length; j++) { const i = (T.button + j) % T.seats.length; if (stacks[i] > 0) map.push(i); }
    // エンジンの番号はボタンを 0 にして席順（ボタンの左が 1）
    map.sort((a, b) => ((a - T.button + T.seats.length) % T.seats.length) - ((b - T.button + T.seats.length) % T.seats.length));
    const s = H.newHand({ stacks: map.map(i => T.seats[i].stack), button: 0, sb: bl.sb, bb: bl.bb });
    const deck = secureDeck();
    S = { s, deck, map, rec: null };
    S.rec = { no: T.handNo, map: map.slice(), names: map.map(i => T.seats[i].name), mySeat: T.mySeat, button: 0, sb: bl.sb, bb: bl.bb, start: s.start.slice(), holes: null, board: [], acts: [], result: null, net: 0, t: Date.now() };
    D.bets = s.bet.slice(); D.tags = {}; D.street = 0; D.revealed = {}; D.winners = null; D.winCards = null; D.banner = ''; D.lastLine = '';
    D.boardHidden = false;
    hintShown = null; hintSlot = null; assistCache = null; fastForward = false;
    for (const p of [s.sbSeat, s.bbSeat]) { const e2 = s.log.find(x => x.p === p && (x.t === 'sb' || x.t === 'bb')); if (e2) D.tags[map[p]] = { cls: '', text: `${e2.t.toUpperCase()} ${fmt(e2.amt)}` }; }
    for (let i = 0; i < T.seats.length; i++) if (!map.includes(i)) delete D.tags[i];
  }
  async function playHand() {
    startHand();
    const s = S.s;
    H.autoStep(s, S.deck); // 手札を配る（hole → bet）
    S.rec.holes = s.hole.map(h => h && h.slice());
    await animDeal();
    for (;;) {
      if (s.phase === 'bet') {
        const p = s.toAct, i = S.map[p], seat = T.seats[i];
        if (seat.kind === 'me') await humanTurn(p);
        else await cpuTurn(p);
      } else if (s.phase === 'deal') {
        await endOfRound();
        const before = s.board.length;
        H.autoStep(s, S.deck);
        S.rec.board = s.board.slice();
        D.street = s.street;
        D.tags = keepTags();
        assistCache = null;
        await animBoard(s.board.length - before);
        if (H.runout(s) && s.phase === 'deal') await sleep(500);
      } else if (s.phase === 'show') {
        await endOfRound();
        await showdown();
      } else if (s.phase === 'done') {
        await endOfRound();
        await finishHand();
        return;
      }
    }
  }
  // 降りた人とオールインの人の印だけ残す
  function keepTags() {
    const out = {};
    for (const k in D.tags) if (D.tags[k] && (D.tags[k].cls === 'f' || D.tags[k].cls === 'a')) out[k] = D.tags[k];
    return out;
  }
  async function endOfRound() {
    // エンジンが返した「だれも合わせなかった分」を表示から引く
    const s = S.s;
    for (const e of s.log.slice(S.logSeen || 0)) if (e.t === 'return') D.bets[e.p] = Math.max(0, (D.bets[e.p] || 0) - e.amt);
    S.logSeen = s.log.length;
    await animCollect();
  }
  function humanTurn(p) {
    return new Promise((resolve, reject) => {
      const e = epoch;
      humanWait = a => {
        if (e !== epoch) { reject(CANCEL); return; }
        humanWait = null;
        resolve(applyAction(p, a));
      };
      raiseTo = 0;
      assistCache = null;
      SFX.turn();
      render();
    });
  }
  async function cpuTurn(p) {
    const s = S.s, i = S.map[p], seat = T.seats[i];
    render();
    const t0 = performance.now();
    const dec = await decideAsync(s, p, seat.level || 'normal', humanModels());
    // 考える時間（強い手・大きな賭けほど少し長く）
    const Lg = H.legal(s);
    let think = 450 + rng() * 650 + (Lg.toCall > s.bb * 4 ? 350 : 0) + (dec.a.t === 'r' ? 250 : 0);
    if (fastForward || T.watching || (settings.fast && myFolded())) think *= 0.25;
    await sleep(Math.max(0, think - (performance.now() - t0)));
    await applyAction(p, dec.a);
  }
  // 人（あなた）の打ち方の癖。最強の CPU が読みに使う（少しずつ古い分を忘れる）
  const hero = Object.assign({ hands: 0, vpip: 0, faced: 0, folded: 0 }, store.get('hero', {}));
  function learnHero(s, p) {
    for (const k of ['hands', 'vpip', 'faced', 'folded']) hero[k] *= 0.995;
    hero.hands++;
    let v = false;
    for (const e of s.log) {
      if (e.p !== p) continue;
      if (e.st === 0 && (e.t === 'c' || e.t === 'r' || e.t === 'b')) v = true;
      if (e.st > 0 && (e.t === 'f' || e.t === 'c' || e.t === 'r')) { hero.faced++; if (e.t === 'f') hero.folded++; }
    }
    if (v) hero.vpip++;
    store.set('hero', hero);
  }
  function humanModels() {
    const p = myEng();
    if (p < 0) return null;
    const m = A.opponentModel(hero);
    return m ? { [p]: m } : null;
  }
  const myFolded = () => { const p = myEng(); return !S || p < 0 || S.s.folded[p]; };
  async function applyAction(p, a) {
    const s = S.s, i = S.map[p];
    const before = s.bet[p], street = s.street;
    H.act(s, a);
    const e = [...s.log].reverse().find(x => x.p === p && ['f', 'x', 'c', 'b', 'r'].includes(x.t));
    S.rec.acts.push({ p, a: e.t === 'f' ? { t: 'f' } : e.t === 'x' || e.t === 'c' ? { t: 'c' } : { t: 'r', to: e.to } });
    hintShown = null; hintSlot = null;
    // 表示
    const txt = H.actionText(e, fmt);
    D.lastLine = `${esc(nameOf(i))}: ${esc(txt)}`;
    const cls = e.t === 'f' ? 'f' : e.allin ? 'a' : e.t === 'r' ? 'r' : e.t === 'b' ? 'b' : '';
    D.tags[i] = { cls, text: e.allin ? 'オールイン' : e.t === 'f' ? 'フォールド' : e.t === 'x' ? 'チェック' : e.t === 'c' ? 'コール' : e.t === 'b' ? `ベット ${fmt(e.to)}` : `レイズ ${fmt(e.to)}`, pop: true };
    if (e.t === 'f') SFX.fold(); else if (e.t === 'x') SFX.check();
    const put = (street === s.street ? s.bet[p] : (e.to || before + (e.amt || 0))) - before;
    if (put > 0) {
      const target = before + put;
      await animBet(i, put);
      D.bets[p] = target;
    }
    if (isMe(i) && e.t === 'f' && settings.fast) fastForward = true;
    assistCache = null;
    render();
    await sleep(animOn() ? 120 : 0);
  }
  async function showdown() {
    const s = S.s;
    H.autoStep(s, S.deck); // show → done
    const res = s.result;
    // 残った人の手札を順に開く（ボタンの左から）
    const order = res.contenders.slice().sort((a, b) => ((a - s.button - 1 + s.n) % s.n) - ((b - s.button - 1 + s.n) % s.n));
    for (const p of order) {
      const i = S.map[p];
      if (D.revealed[p]) continue;
      D.revealed[p] = true;
      if (i !== T.mySeat) { D.flipSeat = i; SFX.flip(); }
      D.tags[i] = { cls: '', text: H.handName(res.values[p]), pop: true };
      render();
      await sleep(i === T.mySeat ? 150 : 520);
    }
  }
  async function finishHand() {
    const s = S.s, res = s.result;
    // 勝った役の5枚
    if (!res.byFold) {
      let best = -1;
      for (const p of res.contenders) if (res.won[p] > 0 && res.values[p] > best) best = res.values[p];
      const wp = res.contenders.find(p => res.values[p] === best);
      D.winCards = new Set(H.bestFive(s.hole[wp].concat(s.board)));
    }
    const winners = [];
    for (let p = 0; p < s.n; p++) if (res.won[p] > 0) winners.push(p);
    for (const p of winners) D.tags[S.map[p]] = { cls: 'w', text: `+${fmt(res.won[p])}`, pop: true };
    const wn = winners.map(p => nameOf(S.map[p]));
    const how = res.byFold ? '' : `（${H.handLabel(res.values[winners[0]])}）`;
    D.banner = `${wn.join('・')} の勝ち${how}`;
    const me = myEng();
    const myNet = me >= 0 ? res.net[me] : 0;
    D.lastLine = me >= 0 ? (myNet > 0 ? `あなたの勝ち <b>+${fmt(myNet)}</b>` : myNet < 0 ? `このハンドは ${fmt(myNet)}` : '±0') + `　${esc(D.banner)}` : esc(D.banner);
    await animAward();
    if (me >= 0 && myNet > 0) SFX.win(); else if (me >= 0 && myNet < 0 && !s.folded[me]) SFX.lose();
    // 卓のチップを更新
    for (let p = 0; p < s.n; p++) T.seats[S.map[p]].stack = s.stack[p];
    S.rec.result = { won: res.won, net: res.net, values: res.values, contenders: res.contenders, byFold: res.byFold };
    S.rec.board = s.board.slice();
    S.rec.net = myNet;
    S.rec.myHole = me >= 0 ? s.hole[me] : null;
    S.rec.desc = D.banner;
    history.push(S.rec);
    while (history.length > 60) history.shift();
    store.set('hist', history.slice(-30));
    if (me >= 0) { stats.hands++; stats.net += myNet / s.bb; store.set('stats', stats); learnHero(s, me); }
    // 飛んだ人の順位
    if (T.mode === 'sng') {
      // 同じハンドで飛んだ人は、ハンドの前のチップが多かった人を上の順位に
      const busted = S.map.map((i, p) => ({ i, start: s.start[p] })).filter(o => T.seats[o.i].stack <= 0 && !T.seats[o.i].out).sort((a, b) => b.start - a.start);
      const remaining = alive().length;
      busted.forEach((o, j) => { T.seats[o.i].out = true; T.seats[o.i].place = remaining + 1 + j; });
    }
    saveTable();
    render();
  }
  async function betweenHands() {
    const e = epoch;
    const wait = settings.fast && fastForward ? 1400 : 2600;
    await new Promise(res => {
      let done = false;
      const fin = () => { if (!done) { done = true; nextHandNow = null; res(); } };
      nextHandNow = fin;
      setTimeout(() => { if (!view && !sheetOpen()) fin(); else waitResume = fin; }, wait);
    });
    if (e !== epoch) throw CANCEL;
  }
  let nextHandNow = null, waitResume = null;
  function gameOver() {
    T.over = true;
    const me = T.seats[T.mySeat];
    const won = me.stack > 0 && alive().length === 1;
    if (won) { me.place = 1; stats.wins++; store.set('stats', stats); }
    const ranks = T.seats.map((x, i) => ({ i, name: x.name, place: x.stack > 0 ? 1 : x.place || T.seats.length, stack: x.stack })).sort((a, b) => a.place - b.place);
    $('rs-sub').textContent = `シットアンドゴー・${T.seats.length}人・${T.handNo}ハンド`;
    $('rs-title').textContent = won ? '優勝！' : `${me.place || '—'}位`;
    $('rs-ranks').innerHTML = ranks.map(r => `<li class="${r.i === T.mySeat ? 'me' : ''}"><span>${r.place}位</span><span>${esc(r.name)}</span><span class="num">${r.stack > 0 ? fmt(r.stack) : ''}</span></li>`).join('');
    $('rs-again').textContent = 'もう一度';
    $('rs-watch').hidden = won || alive().length <= 1;
    $('dlg-result').hidden = false;
    if (won) SFX.win();
    saveTable();
    render();
  }
  function showCashBust() {
    T.over = true;
    $('rs-sub').textContent = `キャッシュ・${T.handNo}ハンド`;
    $('rs-title').textContent = 'チップがなくなりました';
    $('rs-ranks').innerHTML = `<li class="me"><span></span><span>補充 ${T.rebuys}回</span><span class="num">通算 ${fmt(-(T.rebuys + 1) * T.startStack)}</span></li>`;
    $('rs-again').textContent = 'チップを補充して続ける';
    $('rs-watch').hidden = true;
    $('dlg-result').hidden = false;
    render();
  }

  // 卓の状態を保存（再読み込みで続きから。ハンドの途中なら、そのハンドは最初からやり直し）
  function saveTable() {
    if (T.online) return;
    store.set('table', { seats: T.seats, button: T.button, level: T.level, handNo: T.handNo, mode: T.mode, speed: T.speed, startStack: T.startStack, mySeat: T.mySeat, over: T.over, rebuys: T.rebuys, cfg });
  }

  // ------------------------------------------------------------------ 見返し（履歴のハンドを1手ずつ）
  function replayState(rec, k, withLog) {
    const s = H.newHand({ stacks: rec.start, button: rec.button, sb: rec.sb, bb: rec.bb });
    if (!withLog) s.nolog = false;
    H.dealHole(s, rec.holes);
    let bi = 0;
    const drain = () => {
      while (s.phase === 'deal' && bi + s.need <= rec.board.length) { const need = s.need; H.deal(s, rec.board.slice(bi, bi + need)); bi += need; }
      if (s.phase === 'show') { try { H.show(s, null); } catch (e) { /* オンラインで相手の手札がまだ分からない */ } }
    };
    for (let j = 0; j < k && j < rec.acts.length; j++) {
      drain();
      if (s.phase !== 'bet') break;
      try { H.act(s, rec.acts[j].a); } catch (e) { break; }
    }
    if (k >= rec.acts.length) drain();
    else if (k > 0) { /* 途中: 次の行動の直前まで（場のカードは出しておく） */ drain(); }
    return { s, map: rec.map, live: false };
  }
  function openView(h, k) {
    const rec = history[h];
    if (!rec) return;
    k = clamp(k == null ? rec.acts.length : k, 0, rec.acts.length);
    const st = replayState(rec, k);
    const s = st.s;
    view = { h, k, state: st, allOpen: true, tags: {} };
    // 札: 直前の行動
    const last = s.log.filter(e => ['f', 'x', 'c', 'b', 'r'].includes(e.t));
    for (const e of last) {
      if (e.st !== s.street && !(e.t === 'f') && !(e.allin)) continue;
      view.tags[rec.map[e.p]] = { cls: e.t === 'f' ? 'f' : e.allin ? 'a' : e.t === 'r' ? 'r' : e.t === 'b' ? 'b' : '', text: H.actionText(e, x => fmt(x, rec.bb)) };
    }
    if (s.result) {
      for (let p = 0; p < s.n; p++) if (s.result.won[p] > 0) view.tags[rec.map[p]] = { cls: 'w', text: `+${fmt(s.result.won[p], rec.bb)}` };
      if (!s.result.byFold) {
        let best = -1, wp = -1;
        for (const p of s.result.contenders) if (s.result.values[p] > best) { best = s.result.values[p]; wp = p; }
        view.winCards = new Set(H.bestFive(s.hole[wp].concat(s.board)));
      }
    }
    const lastE = last[last.length - 1];
    view.label = k === 0 ? '配ったところ' : lastE ? `${rec.names[lastE.p]}: ${H.actionText(lastE, x => fmt(x, rec.bb))}` : '';
    if (s.result && k >= rec.acts.length) view.label = rec.desc || '';
    assistCache = null;
    render();
  }
  function closeView() {
    view = null;
    assistCache = null;
    render();
    if (waitResume) { const f = waitResume; waitResume = null; f(); }
  }
  function renderTape() {
    const rec = history[view.h];
    const tape = $('tape');
    let html = `<button data-k="0" class="${view.k === 0 ? 'cur' : ''}"><span class="st">配る</span></button>`;
    const st = replayState(rec, rec.acts.length, true);
    let k = 0;
    for (const e of st.s.log) {
      if (e.t === 'deal') { html += `<span class="sep">${H.STREET_NAMES[e.st]}</span>`; continue; }
      if (!['f', 'x', 'c', 'b', 'r'].includes(e.t)) continue;
      k++;
      const short = { f: 'F', x: 'チェック', c: 'コール', b: 'ベット', r: 'レイズ' }[e.t];
      html += `<button data-k="${k}" class="${view.k === k ? 'cur' : ''}"><span class="st">${esc(rec.names[e.p])}</span>${e.allin ? 'オールイン' : short}</button>`;
    }
    tape.innerHTML = html;
    const cur = tape.querySelector('.cur');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('navrow').querySelector('[data-nav="prev"]').disabled = view.k <= 0;
    $('navrow').querySelector('[data-nav="first"]').disabled = view.k <= 0;
    $('navrow').querySelector('[data-nav="next"]').disabled = view.k >= rec.acts.length;
    $('navrow').querySelector('[data-nav="last"]').disabled = view.k >= rec.acts.length;
  }

  // ハンドの履歴のパネル
  const sheetOpen = () => $('sheet').classList.contains('open');
  function openSheet() {
    renderHist();
    $('sheet').style.setProperty('--sheet-top', Math.round(window.innerHeight * (L.side ? 0.35 : 0.42)) + 'px');
    $('sheet').classList.add('open');
  }
  function closeSheet() {
    $('sheet').classList.remove('open');
    if (!view && waitResume) { const f = waitResume; waitResume = null; f(); }
  }
  function renderHist() {
    const box = $('hist');
    if (!history.length) { box.innerHTML = '<p class="empty-note">まだハンドがありません。終わったハンドがここに並び、押すと卓の上で1手ずつ見返せます。</p>'; $('hist-sum').textContent = ''; return; }
    let sum = 0; for (const r of history) sum += r.net / r.bb;
    $('hist-sum').textContent = `${history.length}ハンド・${sum >= 0 ? '+' : ''}${Math.round(sum * 10) / 10}BB`;
    box.innerHTML = history.map((r, h) => ({ r, h })).reverse().map(({ r, h }) => {
      const cls = r.net > 0 ? 'plus' : r.net < 0 ? 'minus' : '';
      return `<button class="hrow ${view && view.h === h ? 'cur' : ''}" data-h="${h}"><span class="no">#${r.no}</span>${r.myHole ? miniCards(r.myHole) : '<span></span>'}<span class="desc">${esc(r.desc || '')}${r.board && r.board.length ? ' ' + miniCards(r.board) : ''}</span><span class="res ${cls}">${r.net > 0 ? '+' : ''}${fmt(r.net, r.bb)}</span></button>`;
    }).join('');
  }

  // ------------------------------------------------------------------ 入力
  function onCall() {
    const s = S && S.s;
    if (!view && !T.online && (!S || (s && s.phase === 'done'))) {
      if (T.over || !T.seats.length) { openNew(); return; }
      if (nextHandNow) nextHandNow();
      return;
    }
    if (humanWait) humanWait({ t: 'c' });
  }
  function onFold() { if (humanWait) humanWait({ t: 'f' }); }
  function onRaise() { if (humanWait) humanWait({ t: 'r', to: raiseTo }); }
  function hint() {
    const s = S && S.s, me = myEng();
    if (!s || s.toAct !== me || !humanWait) return;
    const R = A.recommend(s, me, { table: TABLE, rng }, 1500);
    let bi = 0; for (let j = 1; j < R.probs.length; j++) if (R.probs[j] > R.probs[bi]) bi = j;
    const Lg = H.legal(s), x = R.acts[bi];
    hintSlot = x.slot <= 1 ? x.slot : 2;
    if (x.slot >= 2) raiseTo = x.slot === 4 ? Lg.maxTo : A.niceAmount(s, Lg, x.a.to, H.makeRng(1));
    hintShown = `${actLabel(s, Lg, x)}${x.slot >= 2 ? ' ' + fmt(raiseTo) : ''}（学習した打ち方で ${Math.round(R.probs[bi] * 100)}%）`;
    myHints++;
    if (window.HoldemOnline && window.HoldemOnline.active()) window.HoldemOnline.hint();
    render();
  }

  function setSetting(k, v) {
    settings[k] = v; store.set('settings', settings);
    const box = { eq: 'set-eq', rec: 'set-rec', sound: 'set-sound', anim: 'set-anim', four: 'set-four', fast: 'set-fast', bb: 'set-bb' }[k];
    if (box) $(box).checked = v;
    document.body.classList.toggle('four', settings.four);
    if ((k === 'eq' || k === 'rec') && window.HoldemOnline) window.HoldemOnline.setAI(aiFlags());
    assistCache = null;
    render();
  }
  const aiFlags = () => (settings.eq ? 1 : 0) | (settings.rec ? 2 : 0);

  // 新しいゲームのダイアログ
  const ng = {};
  function openNew() {
    Object.assign(ng, cfg);
    drawNew();
    $('dlg-new').hidden = false;
    $('dlg-result').hidden = true;
  }
  function drawNew() {
    const seg = (id, items, val, key) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); $(id).dataset.key = key; };
    seg('ng-players', [2, 3, 4, 5, 6].map(n => [n, n + '人']), ng.players, 'players');
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${ng.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu').dataset.key = 'cpu';
    $('ng-cpu-desc').textContent = CPU[ng.cpu].desc + (TABLE ? '' : '（学習した表を読み込めていないので、いまは単純な打ち方です）');
    seg('ng-mode', Object.entries(MODES).map(([k, v]) => [k, v.label]), ng.mode, 'mode');
    $('ng-mode-hint').textContent = MODES[ng.mode].hint;
    seg('ng-stack', [30, 50, 100, 200].map(n => [n, n + 'BB']), ng.stack, 'stack');
    seg('ng-speed', Object.entries(SPEEDS).map(([k, v]) => [k, v.label + (v.hands ? `（${v.hands}ハンドごと）` : '')]), ng.speed, 'speed');
    $('ng-speed').parentElement.style.visibility = ng.mode !== 'sng' ? 'hidden' : '';
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  function docTabs(view, cards, key) {
    let cur = store.get(key, 0);
    if (cur >= cards.length) cur = 0;
    view.innerHTML = `<div class="doc-in"><div class="doctabs" role="tablist">${cards.map((c, i) => `<button role="tab" data-i="${i}" aria-selected="${i === cur}">${c[0]}</button>`).join('')}</div><div class="dcard">${cards[cur][1]()}</div></div>`;
    view.querySelectorAll('.doctabs button').forEach(b => b.addEventListener('click', () => { store.set(key, +b.dataset.i); docTabs(view, cards, key); }));
  }
  function renderRules() {
    const P = H.parseCards;
    const ex = [
      ['ロイヤルストレートフラッシュ', '同じスートの 10・J・Q・K・A', 'Ts Js Qs Ks As'],
      ['ストレートフラッシュ', '同じスートで5枚の数字が続く', '5h 6h 7h 8h 9h'],
      ['フォーカード', '同じ数字が4枚', 'Qc Qd Qh Qs 7d'],
      ['フルハウス', '同じ数字3枚＋2枚', 'Kc Kd Ks 4h 4c'],
      ['フラッシュ', '同じスートが5枚', '2d 7d 9d Jd Ad'],
      ['ストレート', '5枚の数字が続く（A-2-3-4-5 も）', '6c 7d 8h 9s Tc'],
      ['スリーカード', '同じ数字が3枚', '8c 8d 8h Ks 3d'],
      ['ツーペア', '同じ数字2枚が2組', 'Jc Jd 5h 5s Ac'],
      ['ワンペア', '同じ数字が2枚', 'Ac Ad 9h 6s 3c'],
      ['ハイカード', '役なし。一番大きい数字で比べる', 'Ah Jd 8c 5s 2h'],
    ];
    docTabs($('view-rules'), [
      ['遊び方', () => `<h3>テキサスホールデム（ノーリミット）</h3>
        <p>配られた自分だけの2枚と、みんなで使う場の5枚を合わせた7枚から、一番強い5枚の組み合わせ（役）を作ります。最後まで残った人の中で役が一番強い人が、真ん中のチップ（ポット）をもらえます。</p>
        <p>ただし、役が弱くても「強そうに賭けて」ほかの人を全員降ろせば、その時点でポットをもらえます。手の強さと駆け引きの両方のゲームです。</p>
        <ul><li><b>シットアンドゴー</b>: みんな同じチップで始め、最後の1人になるまで続けます。ブラインド（強制の賭け）はだんだん上がります</li>
        <li><b>キャッシュ</b>: チップがなくなったら補充して続けます</li></ul>
        <p class="hint">2〜6人の卓。空いた席には CPU が座ります。オンラインでは何人でも同じ卓に座れます（6席まで。あふれた人は観戦）。</p>`],
      ['賭けの流れ', () => `<h3>1ハンドの流れ</h3>
        <ol><li><b>ブラインド</b>: ボタン（D の印）の左の人が小さいブラインド（SB）、その左が大きいブラインド（BB）を置きます。2人のときはボタンが SB</li>
        <li><b>プリフロップ</b>: 2枚ずつ配り、BB の左の人から時計回りに賭けます</li>
        <li><b>フロップ</b>: 場に3枚。ボタンの左の人から賭けます</li>
        <li><b>ターン</b>: 4枚目。<b>リバー</b>: 5枚目。それぞれ賭けます</li>
        <li><b>ショーダウン</b>: 残った人が手札を見せ、強い役の人がポットをもらいます。同じ強さなら山分け</li></ol>
        <p>自分の番でできること: <b>フォールド</b>（降りる）・<b>チェック</b>（賭けずに回す。だれも賭けていないとき）・<b>コール</b>（同じ額を払う）・<b>ベット／レイズ</b>（賭ける・上乗せする）。</p>
        <p>ノーリミットなので、手持ちのチップならいくらでも賭けられます（全部賭けるのが <b>オールイン</b>）。レイズは、直前のレイズの上げ幅以上に上げます。足りない人は全額でオールインでき、その人の額を超える分は別のポット（サイドポット）になります。</p>`],
      ['役の強さ', () => `<h3>役（強い順）</h3><div class="hands">${ex.map((x, i) => `<div class="h"><span class="n">${i + 1}</span><span class="cs">${P(x[2]).map(c => cardHTML(c, { w: 22 })).join('')}</span><span><b>${x[0]}</b><small>${x[1]}</small></span></div>`).join('')}</div>
        <p class="hint">同じ役どうしは、役を作る数字が大きい方が強く、それも同じなら残りのカード（キッカー）で比べます。スートに強さはありません。</p>`],
      ['画面の使い方', () => `<h3>画面の使い方</h3>
        <ul><li>自分の番になると下（横向きでは右）のボタンが使えます。<b>レイズ</b>の額はスライダーか「½」「ポット」などのボタンで決めます（PC ではキーボードの F・C・R でも）</li>
        <li><b>AI補助</b>: 自分の勝率（残っている相手の手札がでたらめだとしたときの、勝つ見込み）と、学習した AI ならどう打つか（おすすめ）を出します。コールに<b>必要な勝率</b>（払う額 ÷ 払った後のポット）を赤い線で示します</li>
        <li><b>ヒント</b>: 今の場面のおすすめを1回だけ出します</li>
        <li><b>履歴</b>: 終わったハンドを卓の上で1手ずつ見返せます</li>
        <li>オンラインの卓では、ほかの人が AI補助を使っているかが席に表示されます</li></ul>`],
      ['オンライン', () => `<h3>オンラインの卓</h3>
        <ul><li>右上の「オンライン」から卓を作るか、空き席のある卓に座ります。空いた席には CPU が座り、あとから来た人は CPU の席を（そのチップごと）次のハンドから引き継ぎます。招待リンクを送ることもできます</li>
        <li>自分の番は30秒。2回続けて時間切れになると離席の扱いになり、画面に触れると戻ります。卓を離れると、その席は CPU が引き継ぎます</li>
        <li>ほかの人が AI補助（勝率・おすすめ）を使っているか、ヒントを何回使ったかが、その人の席に出ます</li></ul>
        <h3>だれも山札を知らない配り方</h3>
        <p>サーバーのないゲームなので、だれか1人が山札を混ぜると、その人には全員の手札が分かってしまいます。そこで暗号を使います。</p>
        <ol><li>ハンドごとに、全員がそれぞれ秘密の鍵を作ります</li>
        <li>52枚のカードを暗号にしたまま、1人ずつ順番に混ぜ直します。中身を知らなくても混ぜられる暗号なので、全員が混ぜ終わると、<b>だれも（卓を作った人も）並びを知りません</b></li>
        <li>カードを開くには全員の鍵が要ります。自分の手札は、ほかの人が鍵のかけらを出してくれて、最後の1つを自分が手元で使うので、<b>自分にしか見えません</b>。場のカードは全員が出すので、みんなに見えます</li>
        <li>ハンドが終わったら全員が鍵を見せ合い、山札が正しかったか（すり替えがないか）を確かめます。おかしければ、そのハンドは無効になってチップが戻ります</li></ol>
        <p class="hint">このため、降りた人の手札もハンドの後には分かります（画面には出しません）。CPU の席の手札は、卓を作った人の端末が開きます。公開の中継サーバーを使うので、名前や行動はほかの人からも見える可能性があります。</p>`],
    ], 'rules-tab');
  }
  function renderAIPage() {
    docTabs($('view-ai'), [
      ['しくみ', () => `<h3>AI が一から作った AI</h3>
        <p>この CPU は、人間の対戦記録や、人が作った戦略の表・ソルバーの結果を一切使っていません。ルールだけを知った状態から、<b>自分どうしで何千万ハンドも打ち合って</b>（自己対局）強くなりました。</p>
        <p>学び方は <b>CFR（後悔最小化）</b>という方法です。毎回、自分の行動を全部試して「あのときこう打っていればどれだけ得だったか（後悔）」を数え、後悔の大きい行動ほど次からよく選ぶようにします。これを繰り返すと、だれにも付け込まれにくい打ち方（均衡）に近づきます。多人数のポーカーで人間のプロに勝った AI（Pluribus）と同じ考え方を、小さくしたものです。</p>
        <p>場面は「手の強さ（相手1人への勝率を10段階＋ドローかどうか）・位置・人数・賭けの回数・払う額の割合・スタックとポットの比」などでまとめ、約${Math.round(A.N_INFO / 1000)}千通りの場面ごとに、フォールド／チェック・コール／小さいレイズ／大きいレイズ／オールイン の割合を覚えています。勝率はその場でモンテカルロ法（でたらめに配って数える）で計算します。</p>
        ${tableMeta ? `<div class="stat-row"><div class="stat"><b>${(tableMeta.iters / 1e6).toFixed(0)}百万</b><span>自己対局のハンド数</span></div><div class="stat"><b>${(tableMeta.visited / 1000).toFixed(0)}千</b><span>学んだ場面</span></div><div class="stat"><b>${esc(tableMeta.date || '')}</b><span>表を作った日</span></div></div>` : '<p class="hint">学習した表を読み込めていません（単純な打ち方で代わりに打ちます）。</p>'}`],
      ['オープンの手', () => openChart()],
      ['強さの記録', () => `<h3>強さの記録</h3><p>基準の AI と、同じカードで席を入れ替えて打ち合わせた成績（100ハンドあたりに何ビッグブラインド勝ったか。6人卓・毎ハンド100BB）。</p>${STRENGTH_HTML}
        <p class="hint">「いつもコール」は何でもコールする相手、「手の強さだけ」は勝率と払う額だけで決める相手です。人間との成績はオンラインの卓で集めていきます。</p>`],
      ['4段階の CPU', () => `<h3>CPU の強さ</h3><table class="lv"><tr><th>強さ</th><th>打ち方</th></tr>${CPU_KEYS.map(k => `<tr><td>${'★'.repeat(CPU[k].stars)} ${CPU[k].label}</td><td style="white-space:normal">${CPU[k].desc}</td></tr>`).join('')}</table>`],
    ], 'ai-tab');
  }
  let STRENGTH_HTML = '<p class="hint">（測定中）</p>';
  // 6人卓で、だれも参加していないときに最初にレイズする手（学習した表から）
  function openChart() {
    if (!TABLE) return '<h3>オープンの手</h3><p class="hint">学習した表を読み込めていません。</p>';
    const posSel = store.get('chart-pos', 2);
    const posNames = [[5, 'UTG（一番早い）'], [4, 'HJ'], [3, 'CO'], [2, 'ボタン'], [1, 'SB']];
    let cells = '';
    for (let r = 12; r >= 0; r--) for (let c = 12; c >= 0; c--) {
      const hc = r === c ? r * 13 + r : r > c ? r * 13 + c : c * 13 + r;
      // 6人卓・100BB・だれも参加していない場面
      const idx = ((((hc * 8 + posSel) * 4 + 0) * 3 + 0) * 5 + 4) * 3 + 0;
      const o = idx * A.NA;
      const tot = TABLE[o] + TABLE[o + 1] + TABLE[o + 2] + TABLE[o + 3] + TABLE[o + 4];
      const raise = tot ? (TABLE[o + 2] + TABLE[o + 3] + TABLE[o + 4]) / tot : 0;
      const call = tot ? TABLE[o + 1] / tot : 0;
      const col = `color-mix(in srgb, #d9a12b ${Math.round(raise * 100)}%, color-mix(in srgb, #2f8a5b ${Math.round(call / Math.max(0.01, 1 - raise) * 100)}%, #3a3f3c))`;
      cells += `<i style="background:${tot ? col : '#555'}" title="${H.classLabel(hc)} レイズ ${Math.round(raise * 100)}%">${H.classLabel(hc).replace(/[so]$/, '')}</i>`;
    }
    return `<h3>オープンの手（学習の結果）</h3><p>6人卓・100BB で、前の人が全員降りたときに AI がレイズする割合（金色が濃いほどレイズ、緑はリンプ、灰色は降りる）。人間の定石は入れていないのに、強い手ほど・後ろの席ほど広く打つことを自分で見つけています。右上がスーテッド（同じスート）、左下がオフスート。</p>
      <div class="seg" id="chart-pos" style="margin-bottom:8px">${posNames.map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === posSel}">${l}</button>`).join('')}</div><div class="grid169">${cells}</div>`;
  }

  // ------------------------------------------------------------------ イベント
  function bind() {
    $('btn-fold').addEventListener('click', onFold);
    $('btn-call').addEventListener('click', onCall);
    $('btn-raise').addEventListener('click', onRaise);
    $('btn-hint').addEventListener('click', hint);
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); settings.eq = on; settings.rec = on; setSetting('eq', on); setSetting('rec', on); });
    $('btn-hist').addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
    $('btn-menu').addEventListener('click', openMenu);
    $('assist').addEventListener('click', () => { if (!L.side) openSheet(); });
    $('range').addEventListener('input', e => { raiseTo = +e.target.value; renderControls(); });
    $('presets').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !humanWait) return;
      const Lg = H.legal(S.s); raiseTo = presetTo(S.s, Lg, b.dataset.size); renderControls();
    });
    document.querySelectorAll('.slider .step').forEach(b => b.addEventListener('click', () => {
      if (!humanWait) return;
      const Lg = H.legal(S.s), unit = Math.max(S.s.bb / 2, Math.round((Lg.maxTo - Lg.minTo) / 40 / S.s.sb) * S.s.sb);
      raiseTo = clamp(raiseTo + (+b.dataset.step) * unit, Lg.minTo, Lg.maxTo); renderControls();
    }));
    // キーボード（PC）: F フォールド、C チェック・コール、R レイズ、← → 額
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
      if (!$('dlg-new').hidden || !$('dlg-online').hidden) return;
      const k = e.key.toLowerCase();
      if (k === 'f' && !$('btn-fold').disabled) onFold();
      else if ((k === 'c' || k === ' ') && !$('btn-call').disabled) { e.preventDefault(); onCall(); }
      else if (k === 'r' && !$('btn-raise').disabled) onRaise();
      else if ((k === 'arrowleft' || k === 'arrowright') && humanWait && view === null) {
        const Lg = H.legal(S.s); if (!Lg.canRaise) return;
        const unit = Math.max(S.s.sb, Math.round((Lg.maxTo - Lg.minTo) / 40 / S.s.sb) * S.s.sb);
        raiseTo = clamp(raiseTo + (k === 'arrowright' ? unit : -unit), Lg.minTo, Lg.maxTo); renderControls();
      } else if (view && (k === 'arrowleft' || k === 'arrowright')) openView(view.h, view.k + (k === 'arrowright' ? 1 : -1));
      else if (k === 'escape') { if (view) closeView(); else if (sheetOpen()) closeSheet(); }
    });
    // タブ
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      const t = b.dataset.tab;
      $('view-play').hidden = t !== 'play'; $('view-rules').hidden = t !== 'rules'; $('view-ai').hidden = t !== 'ai';
      if (t === 'rules') renderRules();
      if (t === 'ai') renderAIPage();
      if (t === 'play') render();
    }));
    $('view-ai').addEventListener('click', e => { const b = e.target.closest('#chart-pos button'); if (b) { store.set('chart-pos', +b.dataset.v); renderAIPage(); } });
    // 設定
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    document.addEventListener('click', e => { if (!$('settings').hidden && !e.target.closest('.settings-wrap')) $('settings').hidden = true; });
    for (const [id, k] of [['set-eq', 'eq'], ['set-rec', 'rec'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-four', 'four'], ['set-fast', 'fast'], ['set-bb', 'bb']]) {
      $(id).checked = settings[k];
      $(id).addEventListener('change', e => setSetting(k, e.target.checked));
    }
    // 見返し
    $('status-tools').addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'live') closeView();
      else if (a === 'hint') hint();
      else if (a === 'ai') $('btn-ai').click();
      else if (a === 'hist') (sheetOpen() ? closeSheet() : openSheet());
      else if (a === 'menu') openMenu();
    });
    $('navrow').addEventListener('click', e => {
      const b = e.target.closest('[data-nav]'); if (b && view) {
        const rec = history[view.h], k = { first: 0, prev: view.k - 1, next: view.k + 1, last: rec.acts.length }[b.dataset.nav];
        openView(view.h, k);
      }
      const t = e.target.closest('[data-k]'); if (t && view) openView(view.h, +t.dataset.k);
    });
    $('hist').addEventListener('click', e => { const b = e.target.closest('[data-h]'); if (b) { openView(+b.dataset.h, null); closeSheet(); } });
    $('sheet').addEventListener('click', e => { if (e.target.closest('[data-act="sheet-close"]')) closeSheet(); });
    // メニュー
    $('dlg-menu').addEventListener('click', e => {
      const b = e.target.closest('[data-menu]'); if (!b && e.target !== $('dlg-menu')) return;
      $('dlg-menu').hidden = true;
      const m = b ? b.dataset.menu : 'close';
      if (m === 'new') openNew();
      else if (m === 'hist') openSheet();
      else if (m === 'online') openOnline();
      else if (m === 'leave') { epoch++; humanWait = null; S = null; T.seats = []; T.over = false; store.set('table', null); D.banner = ''; render(); openNew(); }
    });
    // 新しいゲーム
    $('dlg-new').addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (b) { const key = b.parentElement.dataset.key; ng[key] = key === 'players' || key === 'stack' ? +b.dataset.v : b.dataset.v; drawNew(); }
    });
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; });
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; newGame(Object.assign({}, ng)); });
    // 結果
    $('rs-again').addEventListener('click', () => {
      $('dlg-result').hidden = true;
      if (T.mode === 'cash' && T.over) { T.rebuys++; T.seats[T.mySeat].stack = T.startStack; T.over = false; saveTable(); epoch++; runTable(epoch); return; }
      newGame({});
    });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    // 飛んだあとも最後まで見る（CPU どうしを早送りで）
    $('rs-watch').addEventListener('click', () => { $('dlg-result').hidden = true; T.watching = true; T.over = false; epoch++; runTable(epoch); });
    $('rs-hist').addEventListener('click', () => { $('dlg-result').hidden = true; openSheet(); });
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    // 卓をタップしたら次のハンドへ（ハンドの合間）
    $('stage').addEventListener('click', () => { if (nextHandNow && !view) nextHandNow(); });
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 60); });
  }

  function openMenu() {
    const net = Math.round(stats.net * 10) / 10;
    $('mn-stats').textContent = stats.hands ? `これまでの成績: ${stats.hands}ハンド・${net >= 0 ? '+' : ''}${net}BB（100ハンドあたり ${net >= 0 ? '+' : ''}${Math.round(net / stats.hands * 1000) / 10}BB）・シットアンドゴーの優勝 ${stats.wins}回 / ${stats.games}ゲーム` : '';
    $('dlg-menu').hidden = false;
  }
  function openOnline() {
    if (window.HoldemOnline) window.HoldemOnline.open();
    else { $('on-body').innerHTML = '<p>オンラインの部品を読み込めませんでした。</p>'; $('dlg-online').hidden = false; }
  }

  // オンラインの卓（online-table.js）が使う窓口
  window.HoldemApp = {
    H, A, T, D, get S() { return S; }, set S(v) { S = v; }, settings, history, store, rng, fmt, esc, render, setStatus, SFX,
    get table() { return TABLE; }, get epoch() { return epoch; }, decideAsync, wTimeout, bumpEpoch() { epoch++; humanWait = null; return epoch; },
    aiFlags, myHints: () => myHints, cardHTML, miniCards, chipStackHTML,
    animDeal, animBet, animCollect, animBoard, animAward, sleep, keepTags, setHumanWait(fn) { humanWait = fn; raiseTo = 0; assistCache = null; render(); },
    clearHumanWait() { humanWait = null; render(); }, resetHand() { D.bets = []; D.tags = {}; D.street = 0; D.revealed = {}; D.winners = null; D.winCards = null; D.banner = ''; D.lastLine = ''; hintShown = null; hintSlot = null; assistCache = null; },
    pushHistory(rec) { history.push(rec); while (history.length > 60) history.shift(); },
    newLocalGame: () => openNew(),
    CPU, NAMES,
  };

  // ------------------------------------------------------------------ 始める
  bind();
  document.body.classList.toggle('four', settings.four);
  // 強さの記録（README と同じ数字。train/eval.js で測ったもの）
  if (window.HOLDEM_STRENGTH) STRENGTH_HTML = window.HOLDEM_STRENGTH;
  loadWeights().then(() => { if (!$('view-ai').hidden) renderAIPage(); });
  const saved = store.get('table', null);
  if (saved && saved.seats && saved.seats.length >= 2 && !saved.over) {
    Object.assign(T, saved);
    cfg = Object.assign(cfg, saved.cfg || {});
    T.online = false;
    render();
    runTable(epoch);
  } else {
    fitLayout();
    // はじめて開いたときは、見本の卓を出して設定から
    const names = NAMES.slice(0, 5);
    T.seats = [{ name: 'あなた', av: '◆', kind: 'me', stack: cfg.stack * BB0 }].concat(names.map(n => ({ name: n[1], av: n[0], kind: 'cpu', level: cfg.cpu, stack: cfg.stack * BB0 })));
    T.seats = T.seats.slice(0, cfg.players);
    T.over = true;
    render();
    openNew();
  }
  if (window.HoldemOnline) window.HoldemOnline.init(window.HoldemApp);
})();
