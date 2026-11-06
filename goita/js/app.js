/* ごいた Webアプリ: 4人の卓（向かいが味方）・手駒の操作（伏せる・攻める・受ける・なし）・CPU（自己対局で学んだ値と、読む最強）・「し」の手役と相談・記録 */
(function () {
  'use strict';
  const G = {};
  GoitaCore(G);
  GoitaAI(G);
  const { Hand, Match, PASS, recvAct, leadAct, isLead, aFirst, aAtk, team, canCut, OU, SHI, VALUE, COUNT, NAME, Policy, plan, keepValue, view, deal, shiCheck } = G;
  const W = (typeof GOITA_WEIGHTS !== 'undefined' && GOITA_WEIGHTS) ? GOITA_WEIGHTS : null;
  const LV = (typeof GOITA_LEVELS !== 'undefined' && GOITA_LEVELS) ? GOITA_LEVELS : null;
  const POL = new Policy(W);
  const PC = GoitaPieces;
  const TM = window.TTMotion || null;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('goita-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('goita-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  const rnd = Math.random;

  // ------------------------------------------------------------------ CPU の強さ（味方も相手も同じ強さ）
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '学んだ値を大きくゆらして、ときどき気まぐれに出します', temp: 0.3, eps: 0.1 },
    normal: { label: 'ふつう', stars: 2, desc: '学んだ値を少しゆらして出します', temp: 0.08 },
    strong: { label: 'つよい', stars: 3, desc: '自己対局で学んだ値の一番よい手を出します', temp: 0 },
    max: { label: '最強', stars: 4, desc: '見えていない駒を何通りも配り直して、手の終わりまで読んで選びます', plan: { samples: 80, top: 5 } },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const SEATNAME = ['あなた', 'ひがし', 'みかた', 'にし'];

  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', target: 150 }, store.get('cfg', {}));
  const settings = Object.assign({ sound: true, anim: true, rec: false, count: false, fast: false }, store.get('settings', {}));
  if (TM) { try { settings.anim = localStorage.getItem('tt-motion') !== '0'; } catch (e) { /* そのまま */ } }
  const aiOn = () => settings.rec || settings.count;

  // ------------------------------------------------------------------ 状態
  const S = { m: null, seats: [], me: 0, phase: 'idle', pick: -1, gid: '', timer: 0, paused: false, resultShown: false, thinking: -1, lastSay: {}, ended: null, five: null, log: [] };
  const h = () => S.m && S.m.hand;
  const isHuman = p => S.seats[p] && S.seats[p].kind === 'human';
  const nameOf = p => (S.seats[p] ? S.seats[p].name : '');
  const humanTurn = () => S.phase === 'play' && h() && !h().over && isHuman(h().turn);
  const teamName = t => (S.me >= 0 ? (t === team(S.me) ? 'あなたの組' : '相手の組') : (t === 0 ? '南北の組' : '東西の組'));

  // ------------------------------------------------------------------ 音（駒を打つ音。Web Audio で合成）
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
      const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'cut' ? 1500 : kind === 'fd' ? 2500 : 2000; bp.Q.value = 3;
      const g = actx.createGain(); g.gain.setValueAtTime(kind === 'cut' ? 2 : kind === 'fd' ? 0.9 : 1.4, t);
      src.connect(bp).connect(g).connect(actx.destination); src.start(t);
      if (kind === 'win' || kind === 'lose') {
        const o = actx.createOscillator(), og = actx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(kind === 'win' ? 660 : 300, t); o.frequency.exponentialRampToValueAtTime(kind === 'win' ? 990 : 150, t + 0.3);
        og.gain.setValueAtTime(0.2, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(og).connect(actx.destination); o.start(t); o.stop(t + 0.36);
      }
    } catch (e) { /* 音が出せない環境では鳴らさない */ }
  }

  // ------------------------------------------------------------------ 対局
  function newMatch(c) {
    cfg = c; store.set('cfg', cfg);
    clearTimeout(S.timer);
    S.seats = [0, 1, 2, 3].map(p => (c.mode === 'watch' || p > 0 ? { kind: 'cpu', level: c.cpu, name: c.mode === 'watch' ? ['みなみ', 'ひがし', 'きた', 'にし'][p] : SEATNAME[p] } : { kind: 'human', name: 'あなた' }));
    S.me = c.mode === 'watch' ? -1 : 0;
    S.m = new Match({ target: c.target || 150, dealer: Math.floor(rnd() * 4) });
    S.gid = Math.random().toString(36).slice(2, 12); S.resultShown = false; S.log = [];
    nextHand();
  }
  function nextHand() {
    clearTimeout(S.timer);
    const m = S.m;
    if (!m || m.over) { render(); return; }
    m.newHand(rnd);
    S.phase = 'play'; S.pick = -1; S.lastSay = {}; S.ended = null; S.five = null;
    const s = m.hand.shi;
    if (s) { handleShi(s); return; }
    save(); render(); clack('fd'); schedule();
  }
  // 配ったときの「し」の役
  function handleShi(s) {
    const m = S.m;
    if (s.kind === 'yaku') {
      m.settleYaku();
      S.ended = { kind: 'yaku', p: s.p, points: s.points, shi: s.shi, team: team(s.p) };
      S.log.unshift({ no: m.handNo, text: `${esc(nameOf(s.p))}の手役（し${s.shi}枚）で${teamName(team(s.p))}に${s.points}点` });
      S.phase = 'ended'; save(); render(); afterEnd(); return;
    }
    if (s.kind === 'win') {
      m.settleWin();
      S.ended = { kind: 'win', p: s.p, team: team(s.p), points: 0 };
      S.log.unshift({ no: m.handNo, text: `${esc(nameOf(s.p))}と${esc(nameOf(s.q))}が「し」5枚ずつ → ${teamName(team(s.p))}の勝ち` });
      S.phase = 'ended'; save(); render(); afterEnd(); return;
    }
    // 5枚: その組が「このまま」か「配り直し」。相手どうしで5枚ずつなら、両方の組が望んだときだけ配り直す
    const holders = s.kind === 'five' ? [s.p] : [s.p, s.q];
    const wants = holders.map(p => wantRedeal(p));
    Promise.all(wants).then(ws => {
      const redeal = s.kind === 'five' ? ws[0] : ws[0] && ws[1];
      const text = holders.map((p, i) => `${esc(nameOf(p))}（し5枚）: ${ws[i] ? '配り直したい' : 'このまま'}`).join('・');
      S.log.unshift({ no: m.handNo, text: `${text} → ${redeal ? '配り直し' : 'このまま'}` });
      toast(redeal ? '「し」5枚: 配り直します（親は同じ）' : '「し」5枚: このまま始めます');
      if (redeal) { m.handNo--; setTimeout(nextHand, 700); return; }
      save(); render(); schedule();
    });
  }
  // p（し5枚）の組が配り直したいか。人がかかわるときはたずねる
  function wantRedeal(p) {
    const m = S.m, hands = m.hand.hands, partner = (p + 2) % 4;
    const cpuWish = q => keepValue(POL, hands, m.dealer, q, rnd, 40) < 0;
    if (isHuman(p)) return ask(`あなたの手に「し」が5枚あります。このまま始めるか、全部を配り直すかを決めてください。<br>味方（${esc(nameOf(partner))}）の希望: <b>${cpuWish(partner) ? '配り直したい' : 'このまま'}</b>`, true);
    if (isHuman(partner)) return ask(`味方（${esc(nameOf(p))}）の手に「し」が5枚あります。あなたの希望を伝えてください（伝えられるのは配り直したいかどうかだけ。決めるのは味方です）`, false)
      .then(mine => { const v = keepValue(POL, hands, m.dealer, p, rnd, 40); return v < 0 || (mine && v < 0.08); });
    return Promise.resolve(cpuWish(p) && (cpuWish(partner) || keepValue(POL, hands, m.dealer, p, rnd, 30) < -0.05));
  }
  function ask(html, decide) {
    return new Promise(res => {
      $('fv-body').innerHTML = html;
      $('fv-actions').innerHTML = `<button class="btn" data-v="0">${decide ? 'このまま始める' : 'このままがいい'}</button><button class="btn primary" data-v="1">${decide ? '配り直す' : '配り直したい'}</button>`;
      $('dlg-five').hidden = false;
      const on = e => { const b = e.target.closest('button'); if (!b) return; $('fv-actions').removeEventListener('click', on); $('dlg-five').hidden = true; res(b.dataset.v === '1'); };
      $('fv-actions').addEventListener('click', on);
      render();
    });
  }
  function schedule() {
    clearTimeout(S.timer);
    const hd = h();
    if (!hd || S.paused || S.phase !== 'play' || hd.over) return;
    const p = hd.turn;
    if (isHuman(p)) { render(); return; }
    const lv = CPU[S.seats[p].level] || CPU.normal;
    S.thinking = p;
    renderSeats();
    const t0 = Date.now();
    setTimeout(() => {
      if (h() !== hd || hd.turn !== p || S.phase !== 'play') return;
      const a = lv.plan ? plan(POL, hd, p, Object.assign({ rnd }, lv.plan)).a : POL.choose(hd, p, { temp: lv.temp, eps: lv.eps, rnd });
      const wait = Math.max(0, (settings.fast ? 180 : a === PASS ? 450 : 700 + Math.random() * 300) - (Date.now() - t0));
      S.timer = setTimeout(() => { S.thinking = -1; if (h() === hd && hd.turn === p) act(a); }, wait);
    }, 30);
  }
  function act(a) {
    const hd = h(), p = hd.turn;
    const fromEl = isHuman(p) ? null : $('seat-' + p).querySelector('.who');
    const fromRect = fromEl ? fromEl.getBoundingClientRect() : null;
    const handRects = isHuman(p) ? [...document.querySelectorAll('#hand .hp.sel, #hand .hp.pick2')].map(e => e.getBoundingClientRect()) : null;
    hd.act(a);
    // 吹き出し: なし・受け・切り（新しい攻めが始まったら、ほかの人の「なし」は消す）
    if (a === PASS) S.lastSay[p] = 'なし';
    else S.lastSay = { [p]: isLead(a) ? '' : aFirst(a) === OU ? '切り！' : '受け' };
    S.pick = -1;
    if (a !== PASS) clack(isLead(a) ? 'fd' : aFirst(a) === OU ? 'cut' : 'move');
    save();
    render();
    // 出した駒を席の前の場所へ滑らせる
    if (a !== PASS && TM && TM.on) {
      const pks = [...$('seat-' + p).querySelectorAll('.pk')].slice(-2);
      pks.forEach((el, i) => { const r0 = handRects && handRects[i] ? handRects[i] : fromRect; if (r0) TM.fly(el.querySelector('.koma'), r0, { delay: i * 70 }); });
    }
    if (hd.over) { endHand(); return; }
    schedule();
  }
  function endHand() {
    const m = S.m, hd = h();
    m.settle();
    const doubled = hd.doubled;
    S.ended = { kind: doubled ? 'double' : 'out', p: hd.winner, points: hd.points, team: team(hd.winner), last: hd.last };
    S.log.unshift({ no: m.handNo, text: `${esc(nameOf(hd.winner))}が「${NAME[hd.last]}」で上がり${doubled ? '（同じ駒で2倍）' : ''} → ${teamName(team(hd.winner))}に${hd.points}点` });
    S.phase = 'ended';
    save(); render();
    clack(S.me >= 0 && team(hd.winner) === team(S.me) ? 'win' : 'lose');
    const el = $('seat-' + hd.winner);
    if (TM && el) { TM.pop(el, 'glow'); TM.float(`+${hd.points}`, el, { size: 22, color: 'var(--mine)', ms: 1200 }); }
    if (doubled && window.TTJuice) TTJuice.hype('2倍！', el, { tier: 1 });
    afterEnd();
  }
  function afterEnd() {
    const m = S.m;
    if (window.TTJuice && S.me >= 0 && !m.over && S.ended && S.ended.points) TTJuice.result({ outcome: S.ended.team === team(S.me) ? 'win' : 'lose', round: true, label: `第${m.handNo}手`, stars: CPU[cfg.cpu].stars, id: S.gid + ':' + m.handNo });
    if (m.over) { if (!S.resultShown && S.me >= 0) { S.resultShown = true; setTimeout(showResult, 900); } return; }
    if (S.me < 0) S.timer = setTimeout(nextHand, settings.fast ? 900 : 2600);
  }

  // ------------------------------------------------------------------ 保存
  function save() {
    const m = S.m;
    if (!m) return;
    const hd = m.hand;
    store.set('game', { gid: S.gid, cfg, seats: S.seats, me: S.me, phase: S.phase, resultShown: S.resultShown, log: S.log.slice(0, 30),
      m: { target: m.target, scores: m.scores, dealer: m.dealer, handNo: m.handNo, over: m.over, winTeam: m.winTeam, history: m.history.slice(-40) },
      h: hd ? { dealer: hd.dealer, hands: hd.hands.map(x => Array.from(x)), played: hd.played, turn: hd.turn, phase: hd.phase, attacker: hd.attacker, atk: hd.atk, passes: hd.passes, ouOut: hd.ouOut, fdOu: hd.fdOu, over: hd.over, winner: hd.winner, points: hd.points, doubled: hd.doubled, last: hd.last, moves: hd.moves, shi: hd.shi } : null,
      ended: S.ended });
  }
  function load(o) {
    const m = new Match({ target: o.m.target });
    Object.assign(m, { scores: o.m.scores, dealer: o.m.dealer, handNo: o.m.handNo, over: o.m.over, winTeam: o.m.winTeam, history: o.m.history || [] });
    if (o.h) {
      const hd = new Hand(o.h.dealer);
      Object.assign(hd, o.h, { hands: o.h.hands.map(x => Int8Array.from(x)) });
      m.hand = hd;
    }
    S.m = m; S.seats = o.seats; S.me = o.me; S.gid = o.gid || Math.random().toString(36).slice(2, 12); S.log = o.log || []; S.resultShown = !!o.resultShown; S.ended = o.ended || null;
    if (o.cfg) cfg = Object.assign(cfg, o.cfg);
    S.phase = m.hand && !m.hand.over && o.phase === 'play' ? 'play' : 'ended';
    render();
    if (S.phase === 'play') schedule();
  }

  // ------------------------------------------------------------------ 描画
  function render() {
    renderScore(); renderSeats(); renderCenter(); renderHand(); renderInfo(); renderSide();
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    fitPieces();
  }
  const pkHTML = (x, cls = '') => `<span class="pk ${cls}"><span class="koma">${PC.koma(x.t, { back: x.fd })}</span></span>`;
  function renderScore() {
    const m = S.m, el = $('score');
    if (!m) { el.innerHTML = ''; return; }
    const my = S.me >= 0 ? team(S.me) : 0;
    el.innerHTML = `<span class="tm t0">${teamName(my)} <b>${m.scores[my]}</b></span><span class="tm t1">${teamName(my ^ 1)} <b>${m.scores[my ^ 1]}</b></span><span class="goal">${m.target}点先取・第${m.handNo}手</span>`;
  }
  function renderSeats() {
    const m = S.m, hd = h();
    for (let p = 0; p < 4; p++) {
      const el = $('seat-' + p);
      if (!m || !hd) { el.innerHTML = ''; continue; }
      const t = S.me >= 0 ? (team(p) === team(S.me) ? 0 : 1) : team(p);
      const turn = S.phase === 'play' && !hd.over && hd.turn === p;
      el.classList.toggle('turn', turn);
      const say = S.lastSay[p];
      const revealAll = S.phase === 'ended';
      let laid = '';
      const pl = hd.played[p];
      for (let i = 0; i < pl.length; i += 2) {
        const a0 = pl[i], a1 = pl[i + 1];
        const cur = hd.attacker === p && i + 2 === pl.length && !hd.over;
        // 伏せた駒: 自分のものと、手の終わりは表を薄く見せる
        const seeFd = a0.fd && (p === S.me || revealAll);
        laid += `<span class="pair">${pkHTML(seeFd ? { t: a0.t, fd: false } : a0, seeFd ? 'shown' : '')}${a1 ? pkHTML(a1, `atk${cur ? ' cur' : ''}`) : ''}</span>`;
      }
      // 手の終わりは、残りの手駒も見せる
      if (revealAll && p !== S.me) {
        const rest = [];
        for (let tt = 7; tt >= 0; tt--) for (let k = 0; k < hd.hands[p][tt]; k++) rest.push({ t: tt, fd: false });
        // 2枚ずつの組にして並べる（左右の席でもはみ出さない）
        for (let i = 0; i < rest.length; i += 2) laid += `<span class="pair" title="残りの手駒">${rest.slice(i, i + 2).map(x => pkHTML(x, 'shown')).join('')}</span>`;
      }
      const cnt = hd.size(p);
      el.innerHTML = `<div class="who">${S.thinking === p && turn ? '<i class="think"></i>' : ''}<span class="nm">${esc(nameOf(p))}</span><span class="tag t${t}">${p === S.me ? 'あなた' : S.me >= 0 && team(p) === team(S.me) ? '味方' : S.me >= 0 ? '相手' : (team(p) ? '東西' : '南北')}</span>${hd.dealer === p ? '<span class="oya">親</span>' : ''}${say ? `<span class="say">${say}</span>` : ''}<span class="cnt">手駒${cnt}</span></div><div class="laid">${laid}</div>`;
    }
  }
  function renderCenter() {
    const hd = h(), el = $('center');
    if (!hd) { el.innerHTML = '<div class="lbl">「新しい対局」で始めます</div>'; return; }
    if (S.ended) {
      const e = S.ended;
      if (e.kind === 'win') el.innerHTML = `<div class="lbl">「し」5枚ずつ</div><div class="pts">${teamName(e.team)}の勝ち</div>`;
      else el.innerHTML = `${e.kind !== 'yaku' ? `<div class="big"><span class="koma">${PC.koma(e.last)}</span></div>` : ''}<div class="lbl">${esc(nameOf(e.p))}が${e.kind === 'yaku' ? `手役（し${e.shi}枚）` : e.kind === 'double' ? '同じ駒で上がり' : '上がり'}</div><div class="pts">+${e.points}</div>`;
      return;
    }
    if (hd.atk < 0) { el.innerHTML = `<div class="lbl">${esc(nameOf(hd.turn))}（親）が<br>伏せて攻めます</div>`; return; }
    const dots = [0, 1, 2].map(i => `<i class="${i < hd.passes ? 'on' : ''}"></i>`).join('');
    el.innerHTML = `<div class="big"><span class="koma">${PC.koma(hd.atk)}</span></div><div class="lbl">${esc(nameOf(hd.attacker))}の攻め${hd.atk === OU ? '（だれも受けられない）' : ''}</div><div class="dots" aria-label="なし ${hd.passes}人">${dots}</div>`;
  }
  // 手駒（種類ごとに並べる。押して選ぶ）
  function handList() {
    const hd = h(), me = S.me;
    const out = [];
    if (!hd || me < 0) return out;
    for (let t = 7; t >= 0; t--) for (let k = 0; k < hd.hands[me][t]; k++) out.push(t);
    return out;
  }
  function legalNow() { return humanTurn() ? h().legal() : []; }
  function renderHand() {
    const el = $('hand'), hd = h();
    if (!hd || S.me < 0) { el.innerHTML = `<span class="hint" style="align-self:center">${S.me < 0 ? 'CPU どうしの対局を観戦しています' : ''}</span>`; return; }
    const list = handList(), L = legalNow(), my = humanTurn();
    // 1つめ（伏せ・受け）を選ぶ前: その種類で始まる手があるか。選んだあと: その種類で攻められるか
    let firstOk = new Set(), atkOk = new Set();
    for (const a of L) { if (a === PASS) continue; firstOk.add(aFirst(a)); if (S.pick >= 0 && aFirst(a) === S.pick) atkOk.add(aAtk(a)); }
    const rec = my && settings.rec ? recommend() : 0;
    let pickedShown = false;
    el.innerHTML = list.map((t, i) => {
      let cls = 'hp', role = '';
      if (my) {
        if (S.pick < 0) cls += firstOk.has(t) ? ' can' : ' dim';
        else if (t === S.pick && !pickedShown) { cls += ' sel'; pickedShown = true; role = h().phase === 'lead' ? '伏せ' : '受け'; }
        else {
          // 同じ種類の2枚目は、1枚目を選んでいれば攻めに使える
          const sameLeft = t === S.pick && h().hands[S.me][t] >= 2;
          cls += atkOk.has(t) && (t !== S.pick || sameLeft) ? ' can' : ' dim';
        }
      }
      const isRec = rec && rec !== PASS && ((S.pick < 0 && aFirst(rec) === t) || (S.pick >= 0 && aFirst(rec) === S.pick && aAtk(rec) === t && !(t === S.pick && cls.includes('sel'))));
      return `<button class="${cls}" data-t="${t}" data-i="${i}"${my ? '' : ' disabled'} aria-label="${NAME[t]}">${isRec ? '<span class="rec">推</span>' : ''}<span class="koma">${PC.koma(t)}</span>${role ? `<span class="role">${role}</span>` : ''}</button>`;
    }).join('') || '<span class="hint" style="align-self:center">手駒はありません</span>';
  }
  let recCache = { key: '', a: 0, est: null };
  function recommend() {
    const hd = h(), key = `${S.m.handNo}|${hd.moves.length}`;
    if (recCache.key === key) return recCache.a;
    const r = plan(POL, hd, S.me, { samples: 60, top: 5, rnd });
    recCache = { key, a: r.a, est: r.est };
    return r.a;
  }
  function renderInfo() {
    const el = $('info'), m = S.m, hd = h();
    let cls = 'info', html = '', tools = '';
    if (!m || !hd) html = '「新しい対局」で始めます';
    else if (S.phase === 'ended' || m.over) {
      cls += ' result';
      const e = S.ended;
      if (m.over) { html = `<b>${teamName(m.winTeam)}の勝ち！</b>（${m.scores[0]}対${m.scores[1]}）`; tools = '<button class="btn small primary" data-act="again">もう一局</button>'; }
      else { html = e ? `${e.kind === 'yaku' ? '手役' : e.kind === 'double' ? '2倍の上がり' : '上がり'}: <b>${teamName(e.team)}に${e.points}点</b>` : ''; if (S.me >= 0) tools = '<button class="btn small primary" data-act="next">次の手へ</button>'; }
    } else if (humanTurn()) {
      cls += ' alert';
      if (hd.phase === 'lead') html = S.pick < 0 ? '<b>あなたが親</b>　伏せる駒を選んでください' : `「${NAME[S.pick]}」を伏せます。<b>攻める駒</b>を選んで`;
      else {
        html = S.pick < 0 ? `<b>${esc(nameOf(hd.attacker))}の「${NAME[hd.atk]}」</b>　受けるなら${NAME[hd.atk]}${canCut(hd.atk) ? 'か王' : ''}を` : `「${NAME[S.pick]}」で受けます。<b>攻める駒</b>を選んでください`;
        tools = S.pick < 0 ? '<button class="btn small" data-act="pass">なし</button>' : '';
      }
      if (S.pick >= 0) tools = '<button class="btn small" data-act="unpick">戻す</button>';
    } else html = `${esc(nameOf(hd.turn))}が${hd.phase === 'lead' ? '伏せて攻めます' : '考えています'}…`;
    el.className = cls;
    el.innerHTML = `<span class="txt">${html}</span><span class="tools">${tools}</span>`;
  }
  function renderSide() {
    const ev = $('evcard'), hd = h();
    if (!aiOn()) ev.innerHTML = '<h2>AI の読み</h2><p class="hint" style="margin:0">「AI補助」を押すと、CPU のおすすめと、まだ見えていない駒の数を出します。</p>';
    else if (!hd || S.me < 0) ev.innerHTML = '<h2>AI の読み</h2>';
    else {
      let html = '<h2>AI の読み</h2>';
      if (settings.count) {
        const un = view(hd, S.me);
        html += `<p class="hint" style="margin:0 0 4px">まだ見えていない駒（ほかの3人の手駒と伏せた駒）</p><div style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:13px">${[7, 6, 5, 4, 3, 2, 1, 0].map(t => `<span>${NAME[t]} <b>${un[t]}</b>/${COUNT[t]}</span>`).join('')}</div>`;
      }
      if (settings.rec && humanTurn()) {
        recommend();
        const est = (recCache.est || []).slice().sort((a, b) => b.v - a.v);
        const txt = a => (a === PASS ? 'なし' : isLead(a) ? `${NAME[aFirst(a)]}を伏せて${NAME[aAtk(a)]}で攻め` : `${NAME[aFirst(a)]}で受けて${NAME[aAtk(a)]}で攻め`);
        html += `<p class="hint" style="margin:10px 0 2px">CPU（最強）の読み: 候補と、この手で取れる点の見込み</p><ul class="opts">${est.map((e, i) => `<li class="${i === 0 ? 'top' : ''}"><span>${txt(e.a)}</span><span class="v">${e.v >= 0 ? '+' : ''}${Math.round(e.v * 100)}点</span></li>`).join('')}</ul>`;
      }
      ev.innerHTML = html;
    }
    $('log-info').textContent = S.m ? `第${S.m.handNo}手` : '';
    $('log').innerHTML = S.log.map(L => `<li><b>第${L.no}手</b> ${L.text}</li>`).join('') || '<li class="hint">まだありません</li>';
  }
  // 駒の大きさを卓の広さに合わせる
  function fitPieces() {
    const t = $('table');
    if (!t || !t.offsetParent) return;
    const w = t.clientWidth, hgt = t.clientHeight;
    let pw = Math.min(40, Math.max(18, Math.floor((w - 40) / 10)));
    // 高さ: 上下の席（1段）と左右の席（4組を縦に）が入るように
    const maxH = Math.floor((hgt - 120) / 5.2);
    if (maxH > 0) pw = Math.min(pw, Math.max(16, maxH));
    t.style.setProperty('--pw', pw + 'px');
  }

  // ------------------------------------------------------------------ 入力
  function onHand(e) {
    const b = e.target.closest('.hp');
    if (!b || b.disabled || !humanTurn()) return;
    const t = Number(b.dataset.t), hd = h(), L = hd.legal();
    if (S.pick < 0) {
      if (!L.some(a => a !== PASS && aFirst(a) === t)) { if (TM) TM.pop(b, 'shake'); return; }
      S.pick = t; clack('fd'); renderHand(); renderInfo();
      return;
    }
    if (b.classList.contains('sel')) { S.pick = -1; renderHand(); renderInfo(); return; }
    const a = hd.phase === 'lead' ? leadAct(S.pick, t) : recvAct(S.pick, t);
    if (!L.includes(a)) { if (TM) TM.pop(b, 'shake'); return; }
    b.classList.add('pick2');
    act(a);
  }

  // ------------------------------------------------------------------ 終わり
  function showResult() {
    const m = S.m;
    if (S.me < 0) return;
    const my = team(S.me), win = m.winTeam === my;
    $('rs-sub').textContent = `${m.target}点先取・${m.handNo}手・CPU ${CPU[cfg.cpu].label}`;
    $('rs-title').textContent = win ? 'あなたの組の勝ち！' : 'あなたの組の負け';
    $('rs-rank').innerHTML = [my, my ^ 1].map(t => `<li class="${t === my ? 'me' : ''}"><span class="pl">${m.winTeam === t ? '勝ち' : '負け'}</span><span>${teamName(t)}（${[0, 1, 2, 3].filter(p => team(p) === t).map(p => esc(nameOf(p))).join('・')}）</span><span>${m.scores[t]}点</span></li>`).join('');
    $('rs-body').textContent = '';
    if (window.TTJuice) TTJuice.result({ outcome: win ? 'win' : 'lose', stars: CPU[cfg.cpu].stars, id: S.gid, ref: m.history });
    $('dlg-result').hidden = false;
    $('rs-again').focus();
  }

  // ------------------------------------------------------------------ 新しい対局のダイアログ（common/setup.js が読む形）
  let draft = null;
  function openNew() { draft = Object.assign({}, cfg); drawNew(); $('dlg-new').hidden = false; S.paused = true; clearTimeout(S.timer); }
  function closeNew() { $('dlg-new').hidden = true; if (S.paused) { S.paused = false; if (S.phase === 'play') schedule(); else if (S.me < 0 && S.m && !S.m.over) S.timer = setTimeout(nextHand, 1200); } }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局（味方もCPU）'], ['watch', 'CPUどうしを観戦']], draft.mode);
    $('ng-mode-hint').textContent = draft.mode === 'watch' ? 'CPU 4人で最後まで遊びます（XP は入りません）' : 'あなたと向かいの味方（CPU）が組になり、左右の CPU と戦います';
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${draft.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(CPU_KEYS.length - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[draft.cpu] ? CPU[draft.cpu].desc : '';
    seg('ng-target', [[150, '150点（正式）'], [100, '100点'], [50, '50点（短め）']], draft.target);
  }

  // ------------------------------------------------------------------ ルール / AI のページ
  function docTabs(view0, key) {
    const cards = [...view0.querySelectorAll(':scope > .card')];
    if (cards.length < 2) return;
    const bar = document.createElement('div');
    bar.className = 'doctabs'; bar.setAttribute('role', 'tablist');
    bar.innerHTML = cards.map((c, i) => `<button role="tab" data-i="${i}">${esc(c.dataset.tab || i + 1)}</button>`).join('');
    view0.prepend(bar);
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
    const pk = (t, fd) => `<span class="pk" style="--pw:30px"><span class="koma">${PC.koma(t, { back: fd })}</span></span>`;
    const ptable = [7, 6, 5, 4, 3, 2, 1, 0].map(t => `<div>${pk(t)}<b>${NAME[t]}</b><span>${COUNT[t]}枚・${VALUE[t]}点</span></div>`).join('');
    $('view-rules').innerHTML = `
      <div class="card" data-tab="遊び方">
        <h3>遊び方</h3>
        <ul>
          <li>4人で遊びます。<b>向かいの人が味方</b>、左右の人が相手です。順番は反時計回り（あなた → 右 → 向かい → 左）。</li>
          <li>駒は将棋の駒と同じ形の32枚。1人8枚ずつ配ります。<b>手駒を最初に全部出した人の組</b>が、その手の勝ちです。</li>
          <li><b>親</b>は手駒を1枚<b>伏せて</b>置き、1枚を表で出して<b>攻め</b>ます。次の人は、同じ駒を出して<b>受ける</b>か、「<b>なし</b>」と言います（持っていても受けなくてよい）。</li>
          <li>受けた人が新しい親になり、新しい駒で攻めます。親以外の3人が「なし」なら、親はまた1枚伏せて、新しい駒で攻めます。</li>
          <li>操作: 手駒を押して、伏せる駒（受ける駒）→ 攻める駒の順に選びます。受けないときは「なし」。</li>
        </ul>
      </div>
      <div class="card" data-tab="駒と点">
        <h3>駒と点</h3>
        <div class="ptable">${ptable}</div>
        <p class="hint">最後に出した駒（上がり駒）の点が、その組に入ります。先に${cfg.target || 150}点（正式は150点）を取った組の勝ち。</p>
      </div>
      <div class="card" data-tab="王">
        <h3>王</h3>
        <ul>
          <li>王は特別な駒。<b>飛・角・金・銀・馬</b>の攻めを王で受けられます（<b>切る</b>）。<b>香・しは王で切れません</b>。</li>
          <li>王で攻められるのは、<b>王がもう1枚表で出ている</b>とき・<b>自分が王を2枚とも持っている</b>とき・<b>最後の上がり</b>のときだけです。</li>
          <li>王の攻めはだれも受けられません。攻めた人がまた1枚伏せて、新しい駒で攻めます。</li>
        </ul>
      </div>
      <div class="card" data-tab="上がりと2倍">
        <h3>上がりと2倍</h3>
        <ul>
          <li>手駒は伏せ（受け）と攻めの2枚ずつ出すので、いつも偶数枚。最後の2枚を出し切ったら<b>上がり</b>。最後に攻めた駒の点が入り、上がった人が次の親です。</li>
          <li><b>2倍</b>: 残り2枚が同じ駒で、だれも受けずに一巡して、その2枚を伏せと攻めで出し切ったときは、点が2倍。受けてからの上がりは、同じ駒でも2倍になりません。</li>
        </ul>
        <div class="ex">例: ${pk(4, true)}${pk(4)} 金を伏せて金で上がり → 30点の2倍で60点</div>
      </div>
      <div class="card" data-tab="「し」の役">
        <h3>配ったときの「し」の役</h3>
        <ul>
          <li><b>6枚以上（手役）</b>: その組の勝ち。6枚なら残り2枚が同じ駒ならその点の2倍、違えば高い方の点。7枚なら残り1枚の点の2倍。8枚なら100点。その人が次の親。</li>
          <li><b>味方どうしで5枚ずつ</b>: その時点で、点に関係なくその組の対局の勝ち。</li>
          <li><b>1人だけ5枚</b>: その組で「このまま」か「配り直し」を決めます（味方が伝えられるのは配り直したいかどうかだけ）。配り直しても親は変わりません。</li>
          <li><b>相手どうしで5枚ずつ</b>: 両方の組が配り直しを望んだときだけ配り直します。</li>
        </ul>
      </div>
      <div class="card" data-tab="この版について">
        <h3>この版について</h3>
        <p>ごいたは石川県能登町の宇出津に伝わる遊びです。決まりは、能登ごいた保存会の定めをまとめた説明（日本語版・英語版の百科事典の記事）にならっています。駒の絵はこの画面のための自作です。</p>
        <p class="hint">CPU は、この決まりで自分どうしで遊んだ結果だけから学んでいます（「AI」のページ）。</p>
      </div>`;
    docTabs($('view-rules'), 'rules');
  }
  function renderAIPage() {
    const hst = (W && W.history) || [];
    const gen = W ? W.gen || 0 : 0, total = W ? W.totalHands || 0 : 0;
    const rows = hst.slice(-30).reverse().map(e => `<tr><td>第${e.gen + 1}世代${e.accept ? '' : '（候補）'}</td><td>${(e.hands || 0).toLocaleString()}手</td><td>${e.match ? `${e.match.per >= 0 ? '+' : ''}${e.match.per}点/手（${e.match.hands.toLocaleString()}手）` : '—'}</td><td>${e.accept ? '採用' : '不採用'}</td></tr>`).join('');
    const lvName = k => (CPU[k] ? CPU[k].label : k === 'ultra' ? '超最強の候補（最強の5倍読む）' : k);
    const lvRows = LV && LV.pairs ? LV.pairs.map(p => `<tr><td>${lvName(p.a)} vs ${lvName(p.b)}</td><td>${p.per >= 0 ? '+' : ''}${p.per}点/手</td><td>${p.win != null ? (p.win * 100).toFixed(1) + '%' : ''}</td><td>${p.hands}手</td></tr>`).join('') : '';
    $('view-ai').innerHTML = `
      <div class="card" data-tab="強さ">
        <h3>この AI の強さ</h3>
        <div class="stat-row">
          <div class="stat"><b>${gen}</b><span>学習世代</span></div>
          <div class="stat"><b>${total.toLocaleString()}</b><span>自己対局（累計の手の数）</span></div>
        </div>
        <p class="hint" style="margin:12px 0 4px">世代ごとの検定: 同じ配り方で、新しい版の組と前の版の組を入れ替えて2回ずつ遊ぶ（デュプリケート）。1手あたりの点の差が負でなければ採用。</p>
        <div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>自己対局</th><th>新しい版の点の差</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">まだありません</td></tr>'}</tbody></table></div>
      </div>
      <div class="card" data-tab="しくみ">
        <h3>しくみ（すべて自作・人の知識なし）</h3>
        <ul>
          <li><b>何も知らない状態から</b>: 最初（第0世代）は全部の重みが 0 で、でたらめに出します。駒の点や王の使いどころも教えていません。</li>
          <li><b>学ぶもの</b>: 「この局面でこの手を出したら、その手で自分の組が何点取るか（取られるか）」の見込み。特徴は、出したあとに手に残る駒・攻める駒と、それをまだ持つ数・まだ見えていないその駒の数・王で切ったか・味方と相手の残りの枚数・受ける攻めが味方のものか相手のものか、など。</li>
          <li><b>最強</b>: 見えていない駒（ほかの3人の手駒と伏せた駒）を何通りも配り直し、有力な手ごとに手の終わりまで学んだ方策で指し進めて比べます。「し」5枚の相談も、このまま遊んだときの見込みで決めます。</li>
        </ul>
      </div>
      <div class="card" data-tab="CPU の強さ">
        <h3>CPU の${CPU_KEYS.length}段階</h3>
        <div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>特徴</th></tr></thead><tbody>${CPU_KEYS.map(k => `<tr><td>${CPU[k].label}</td><td>${CPU[k].desc}</td></tr>`).join('')}</tbody></table></div>
        ${lvRows ? `<p class="hint" style="margin:12px 0 4px">段階どうしの対戦（上の段の組と下の段の組を、同じ配り方で入れ替えて2回ずつ）</p><div class="tbl"><table class="lv"><thead><tr><th>対戦</th><th>点の差</th><th>手の勝ち</th><th>手</th></tr></thead><tbody>${lvRows}</tbody></table></div><p class="hint" style="margin:8px 0 0">超最強（最強の5倍読む）は最強とほぼ互角だったので、段には入れていません。</p>` : ''}
      </div>`;
    docTabs($('view-ai'), 'ai');
  }

  // ------------------------------------------------------------------ パネル・設定
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
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.tm); toast.tm = setTimeout(() => { t.hidden = true; }, 2400); }
  function setSetting(k, v) { settings[k] = v; store.set('settings', settings); const box = { rec: 'set-rec', count: 'set-count' }[k]; if (box) $(box).checked = v; render(); }

  // ------------------------------------------------------------------ イベント
  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      ['play', 'rules', 'ai'].forEach(k => { $('view-' + k).hidden = b.dataset.tab !== k; });
      $('main').classList.toggle('scroll', b.dataset.tab !== 'play');
      if (b.dataset.tab === 'rules') { $('view-rules').innerHTML = ''; renderRules(); }
      if (b.dataset.tab === 'ai') renderAIPage();
      if (b.dataset.tab === 'play') fitPieces();
    }));
    $('hand').addEventListener('click', onHand);
    $('info').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'pass' && humanTurn() && h().phase === 'respond') act(PASS);
      else if (a === 'unpick') { S.pick = -1; render(); }
      else if (a === 'next') nextHand();
      else if (a === 'again') newMatch(cfg);
    });
    $('btn-new').addEventListener('click', openNew);
    $('btn-ai').addEventListener('click', () => { const on = !aiOn(); settings.rec = on; settings.count = on; store.set('settings', settings); $('set-rec').checked = on; $('set-count').checked = on; render(); });
    $('btn-panel').addEventListener('click', () => openSheet('ev'));
    $('btn-panel2').addEventListener('click', () => openSheet('log'));
    $('btn-resign').addEventListener('click', () => { if (S.m && !S.m.over && S.me >= 0 && confirm('この対局をやめますか？（負けになります）')) { S.m.over = true; S.m.winTeam = team(S.me) ^ 1; S.phase = 'ended'; save(); render(); if (!S.resultShown) { S.resultShown = true; showResult(); } } });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.more-wrap')) { $('menu-more').hidden = true; $('btn-more').setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.settings-wrap')) { $('settings').hidden = true; $('btn-settings').setAttribute('aria-expanded', 'false'); }
    });
    $('menu-more').addEventListener('click', () => { $('menu-more').hidden = true; });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    [['set-rec', 'rec'], ['set-count', 'count'], ['set-sound', 'sound'], ['set-anim', 'anim'], ['set-fast', 'fast']].forEach(([id, k]) => {
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
        else if (id === 'ng-cpu') draft.cpu = v;
        else if (id === 'ng-target') draft.target = Number(v);
        drawNew();
        return;
      }
      if (e.target === $('dlg-new')) closeNew();
    });
    $('ng-cancel').addEventListener('click', closeNew);
    $('ng-start').addEventListener('click', () => { $('dlg-new').hidden = true; S.paused = false; newMatch(draft); });
    $('rs-again').addEventListener('click', () => { $('dlg-result').hidden = true; newMatch(cfg); });
    $('rs-new').addEventListener('click', () => { $('dlg-result').hidden = true; openNew(); });
    $('rs-review').addEventListener('click', () => { $('dlg-result').hidden = true; openSheet('log'); });
    $('dlg-result').addEventListener('click', e => { if (e.target === $('dlg-result')) $('dlg-result').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeSheet(); if (!$('dlg-new').hidden) closeNew(); $('dlg-result').hidden = true; $('settings').hidden = true; $('menu-more').hidden = true; if (S.pick >= 0) { S.pick = -1; render(); } return; }
      if (e.target.closest('input, textarea, .dialog') || !$('view-play').offsetParent) return;
      if ([...document.querySelectorAll('.overlay')].some(o => !o.hidden)) return;
      if (S.phase === 'ended' && (e.key === 'Enter' || e.key === ' ')) { const b = document.querySelector('#info [data-act="next"]'); if (b) { e.preventDefault(); nextHand(); } return; }
      if (humanTurn() && (e.key === 'n' || e.key === 'N') && h().phase === 'respond' && S.pick < 0) act(PASS);
    });
    window.addEventListener('resize', () => { fitPieces(); if ($('side').classList.contains('open')) openSheet($('side').dataset.tab); });
    if (TM) TM.peek($('table'), { pick: t => { const x = t.closest('.pk'); return x && x.querySelector('.koma'); }, scale: 5 });
    if (TM) TM.peek($('hand'), { pick: t => { const x = t.closest('.hp'); return x && x.querySelector('.koma'); }, scale: 4 });
  }

  bind();
  const saved = store.get('game', null);
  if (saved && saved.m && Array.isArray(saved.seats)) {
    try { load(saved); } catch (e) { newMatch(cfg); }
  } else {
    render();
    S.paused = true;
    openNew();
  }
  void deal; void shiCheck; void SHI;
})();
