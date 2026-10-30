/* 花札こいこい Webアプリ: 卓の表示・操作・CPU（Web Worker）・AI補助・オンライン */
(function () {
  'use strict';
  const K = KoikoiCore, AI = KoikoiAI, KC = KoikoiCards, SND = KoikoiSound;
  const { KOI, STOP, PLAY, PICK, isPlay, isPick, playCard, playTarget, pickTarget, NAME, MONTHS, MONTH_NUM, TYPE } = K;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ CPU の強さ
  const CPU = {
    easy: { label: 'やさしい', stars: 1, desc: '気まぐれに打ちます（目の前の得点だけを追う打ち方より少し弱い）', temp: 0.05 },
    normal: { label: 'ふつう', stars: 2, desc: 'ネットの見込みで打ちますが、ときどき迷います', temp: 0.02 },
    strong: { label: 'つよい', stars: 3, desc: 'ネットの見込みで打ち、ごくまれに迷います', temp: 0.006 },
    max: { label: '最強', stars: 4, desc: '自己対局でいちばん長く学んだネットの一番の手。迷いません', temp: 0 },
  };
  const CPU_KEYS = ['easy', 'normal', 'strong', 'max'];
  const RULE_CHIPS = [
    ['sake', '花見で一杯・月見で一杯'], ['sakeKasu', '菊に盃をカスにも数える'], ['double7', '7点以上は2倍'],
    ['koiDouble', 'こいこい返しは2倍'], ['teshi', '手四・くっつき'], ['oyaken', '親権（流れたら親に1点）'],
  ];

  // ------------------------------------------------------------------ 設定（このブラウザに保存）
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem('koikoi-' + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('koikoi-' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } },
  };
  const settings = Object.assign({ sound: true, anim: true, wp: true, best: true, tag: true, near: true, fast: false }, store.get('settings', {}));
  let cfg = Object.assign({ mode: 'cpu', cpu: 'normal', months: 12, rules: {} }, store.get('cfg', {}));
  cfg.rules = K.normRules(cfg.rules);
  if (!CPU[cfg.cpu]) cfg.cpu = 'normal';
  const aiOn = () => settings.wp || settings.best;
  SND.setEnabled(settings.sound);

  // ------------------------------------------------------------------ 対局の状態
  const S = {
    match: null, round: null, me: 0, seats: ['human', 'normal'], reveal: false,
    slots: [],          // 場の札の置き場所（札の番号か -1）。取られても詰めない
    frame: null,        // いま表示している並び
    busy: false,        // 札が動いている間
    sel: -1,            // 選んでいる手札
    inspect: -1,        // 何も選んでいないときにタップした場の札（取れる手札を光らせる）
    assist: null,       // AI補助: { key, list, best }
    hintKey: '', hints: 0,
    thinking: false,
    log: [],            // この月の流れ（表示用）
    stage: null,        // 卓の上の演出（役・こいこいの選択）
    online: null,
    token: 0,           // 対局ごとの番号（古い処理を捨てる）
  };
  const R = () => S.round;
  const opp = () => S.me ^ 1;
  const isCPU = p => !!CPU[S.seats[p]];
  const isHuman = p => S.seats[p] === 'human';
  const isRemote = p => S.seats[p] === 'remote';
  const ctxOf = p => ({ after: S.match.months - 1 - S.match.monthIndex, lead: S.match.totals[p] - S.match.totals[p ^ 1] });
  const nameOf = p => {
    if (S.online) return p === S.me ? 'あなた' : `${esc(S.online.opp.name)}さん`;
    if (isCPU(p)) return S.seats[0] !== 'human' && S.seats[1] !== 'human' ? `CPU${p + 1}（${CPU[S.seats[p]].label}）` : `CPU（${CPU[S.seats[p]].label}）`;
    return 'あなた';
  };
  const shortName = p => (S.online ? (p === S.me ? 'あなた' : esc(S.online.opp.name)) : isCPU(p) ? (isCPU(p ^ 1) ? `CPU${p + 1}` : 'CPU') : 'あなた');
  const humanTurn = () => { const r = R(); return r && r.phase !== 'end' && isHuman(r.turn) && !S.busy && S.view == null && !(S.online && S.online.waiting != null); };

  // ------------------------------------------------------------------ CPU（Web Worker）
  const THREADS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  let mainNet = null;
  const getMainNet = () => {
    if (!mainNet) mainNet = new AI.Net(window.KOIKOI_WEIGHTS ? AI.unpackWeights(window.KOIKOI_WEIGHTS) : AI.randomWeights(256, 128, 64, K.makeRng(1)));
    return mainNet;
  };
  const AIW = {
    pool: [], id: 0, broken: false, searching: false,
    ensure(n) {
      while (!this.broken && this.pool.length < n) {
        try { this.pool.push(new Worker('js/ai-worker.js')); } catch (e) { this.broken = true; }
      }
      return this.pool.length;
    },
    // 局面を（見えない札を隠して）読ませる。search なら n 個のワーカーで手分けして合わせる
    run(round, p, ctx, opts) {
      const id = ++this.id;
      const pub = hide(round, p);
      const n = opts.search ? this.ensure(THREADS) : this.ensure(1);
      return new Promise(resolve => {
        if (!n) {
          setTimeout(() => {
            if (id !== this.id) return resolve(null);
            const net = getMainNet();
            const o2 = { timeMs: Math.min(opts.timeMs, 1200), prior: 3 };
            const list = opts.search === 'look' ? AI.lookaheadEval(net, pub, ctx, o2) : opts.search ? AI.searchEval(net, pub, ctx, o2) : AI.evaluate(net, pub, ctx);
            resolve(list);
          }, 20);
          return;
        }
        const parts = [];
        if (opts.search) this.searching = true;
        this.pool.slice(0, n).forEach((w, i) => {
          w.onmessage = e => {
            if (e.data.id !== this.id) return;
            parts.push(e.data.list);
            if (parts.length === n) { if (opts.search) this.searching = false; resolve(merge(parts)); }
          };
          w.onerror = () => { this.broken = true; this.pool.forEach(x => x.terminate()); this.pool = []; resolve(null); }; // 次からはこの画面の中で考える
          w.postMessage({ id, round: pub, ctx, search: opts.search || false, timeMs: opts.timeMs || 0, seed: (Math.random() * 1e9) | 0 });
        });
      });
    },
    // 読みの途中なら止める（ワーカーは途中で止められないので作り直す）
    cancel() {
      this.id++;
      if (this.searching) { this.pool.forEach(w => w.terminate()); this.pool = []; this.searching = false; }
    },
  };
  // 見えない札を -1 にする（p から見た局面）
  function hide(round, p) {
    const r = round.clone();
    const o = p ^ 1;
    r.hands[o] = r.hands[o].map(() => -1);
    r.deck = r.deck.map(() => -1);
    r.log = [];
    return r;
  }
  function merge(parts) {
    const base = parts[0].map(e => Object.assign({}, e));
    if (parts.length === 1 && base.every(e => e.n == null)) return base;
    const prior = 3;
    base.forEach((e, i) => {
      if (e.exact) return;
      let sum = 0, n = 0;
      for (const p of parts) { const x = p[i]; if (x.n) { sum += x.mean * x.n; n += x.n; } }
      e.n = n; e.mean = n ? sum / n : e.netWin;
      e.win = (sum + prior * e.netWin) / (n + prior);
    });
    base.forEach(e => { if (!Number.isFinite(e.win)) e.win = Number.isFinite(e.netWin) ? e.netWin : 0.5; });
    return base;
  }
  const bestOf = list => list.reduce((b, e) => (AI.score(e) > AI.score(b) ? e : b), list[0]);
  function pickWithTemp(list, temp) {
    if (!temp) return bestOf(list);
    const m = Math.max(...list.map(AI.score));
    const w = list.map(e => Math.exp((AI.score(e) - m) / temp));
    let t = Math.random() * w.reduce((s, x) => s + x, 0);
    for (let i = 0; i < list.length; i++) { t -= w[i]; if (t <= 0) return list[i]; }
    return list[list.length - 1];
  }

  // ------------------------------------------------------------------ 表示の並び（frame）
  // { hands: [[],[]], slots: [...], caps: [[],[]], deck: 残り枚数, float: めくった札 or -1, on: {札: 重ねる置き場所}, last: [直前に動いた札] }
  function frameOf(r, float) {
    syncSlots(r);
    return {
      hands: [r.hands[0].slice(), r.hands[1].slice()], slots: S.slots.slice(), caps: [r.caps[0].slice(), r.caps[1].slice()],
      deck: r.deck.length, float: float != null ? float : (r.phase === 'pick' ? r.pending : -1), on: {}, last: [],
    };
  }
  // 置き場所を今の場に合わせる（なくなった札は空きに、新しい札は空きに入れる）
  function syncSlots(r) {
    const inField = new Set(r.field);
    S.slots = S.slots.map(c => (inField.has(c) ? c : -1));
    for (const c of r.field) if (!S.slots.includes(c)) placeInSlot(S.slots, c);
    trimSlots(S.slots);
  }
  function placeInSlot(slots, c) {
    const i = slots.indexOf(-1);
    if (i >= 0 && i < Math.max(8, slots.length)) slots[i] = c; else slots.push(c);
  }
  function trimSlots(slots) { while (slots.length > 8 && slots[slots.length - 1] === -1) slots.pop(); }
  const cloneFrame = f => ({ hands: [f.hands[0].slice(), f.hands[1].slice()], slots: f.slots.slice(), caps: [f.caps[0].slice(), f.caps[1].slice()], deck: f.deck, float: f.float, on: Object.assign({}, f.on), last: f.last.slice() });

  // 出来事（r.log）から、札が動くようすを何枚かの並びにする
  function framesFor(f0, ev) {
    const out = [];
    let f = cloneFrame(f0);
    const p = ev.p;
    if (ev.k === 'play' || ev.k === 'draw') {
      const c = ev.c;
      if (ev.k === 'play') {
        const h = f.hands[p], i = h.indexOf(c);
        if (i >= 0) h.splice(i, 1); else { const u = h.indexOf(-1); if (u >= 0) h.splice(u, 1); }
      } else if (f.float !== c) {
        f.deck--; f.float = c; f.last = [c];
        out.push({ f: cloneFrame(f), hint: { [c]: 'deck' }, snd: 'flip', dur: 300 });
      }
      f.float = f.float === c ? -1 : f.float;
      const took = ev.took.filter(x => x !== c);
      if (took.length) {
        const si = f.slots.indexOf(took[0]);
        f.on[c] = si;
      } else placeInSlot(f.slots, c);
      f.last = [c].concat(took);
      out.push({ f: cloneFrame(f), hint: ev.k === 'play' ? { [c]: p === S.me ? null : 'ohand' } : {}, snd: took.length ? 'slap' : 'slap-soft', dur: 280, pause: took.length ? 220 : 120 });
      if (took.length) {
        f.slots = f.slots.map(x => (took.includes(x) ? -1 : x));
        delete f.on[c];
        f.caps[p] = f.caps[p].concat(ev.took);
        f.last = [];
        out.push({ f: cloneFrame(f), hint: {}, snd: 'take', dur: 340 });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 描画
  const cardHTML = (id, cls = '', tagName = 'span', extra = '') =>
    `<${tagName}${tagName === 'button' ? ' type="button"' : ''} class="card ${cls}" data-k="${id}" data-c="${id}" ${tagName === 'button' ? `aria-label="${NAME[id]}"` : `role="img" aria-label="${NAME[id]}"`} ${extra}>${KC.svg(id, { tag: settings.tag })}</${tagName}>`;
  // 卓の外（記録・役の演出・ルールのページ）の札。動かさないので data-k を付けない
  const plainCard = id => `<span class="card" role="img" aria-label="${NAME[id]}">${KC.svg(id, { tag: settings.tag })}</span>`;
  const backHTML = (key, cls = '') => `<span class="card back ${cls}" data-k="${key}" aria-hidden="true">${KC.svg(-1)}</span>`;

  function render() {
    const r = R();
    if (!r || !S.frame) { if (S.online) renderEmpty(infoNote || '相手と札を混ぜています…'); return; }
    renderBars(); renderOppHand(); renderCaps(); renderField(); renderHand(); renderInfo(); renderControls(); renderSideScore();
    fitSoon();
  }

  function renderBars() {
    const r = R(), m = S.match;
    const bar = p => {
      const think = S.thinking && r.turn === p && r.phase !== 'end' ? `<span class="think"><i></i>${isRemote(p) ? '相手の番' : '考え中'}</span>` : '';
      const conn = S.online && p !== S.me && !S.online.oppPresent && S.online.lostAt ? '<span class="think" style="color:#ffb4a4">接続切れ</span>' : '';
      const tag = S.online ? aiTagHTML(p === S.me ? aiFlags() : S.online.opp.ai, p === S.me ? S.hints : S.online.opp.hints) : '';
      return `${r.dealer === p ? '<span class="oya" title="親（先に打つ）">親</span>' : ''}<span class="nm">${nameOf(p)}</span>${tag}` +
        `<span class="tot">合計 <b>${m.totals[p]}</b>点</span>${r.koi[p] ? `<span class="koi">こいこい${r.koi[p] > 1 ? '×' + r.koi[p] : ''}</span>` : ''}${think || conn}`;
    };
    $('pbar-opp').innerHTML = bar(opp());
    $('pbar-me').innerHTML = bar(S.me);
  }

  function renderOppHand() {
    const f = S.frame, o = opp(), r = R();
    const reveal = S.reveal || (r.phase === 'end' && r.hands[o].every(c => c >= 0));
    $('ohand').innerHTML = f.hands[o].map((c, i) => (reveal && c >= 0 ? cardHTML(c) : backHTML('ob' + i))).join('');
  }

  const GROUP = [['光', 0], ['タネ', 1], ['タン', 2], ['カス', 3]];
  // もう少しでできる役（相手に取られていないものだけ）
  function nearYaku(p) {
    const r = R(), mine = new Set(S.frame.caps[p]), theirs = new Set(S.frame.caps[p ^ 1]);
    const out = [];
    const sets = [['猪鹿蝶', [20, 24, 36]], ['赤短', [1, 5, 9]], ['青短', [21, 33, 37]]];
    if (r.rules.sake) sets.push(['花見で一杯', [8, 32]], ['月見で一杯', [28, 32]]);
    for (const [nm, cs] of sets) {
      const have = cs.filter(c => mine.has(c)).length;
      if (have === cs.length - 1 && cs.every(c => mine.has(c) || !theirs.has(c))) out.push(`${nm} あと1`);
    }
    const lights = [0, 8, 28, 44].filter(c => mine.has(c)).length;
    if (lights === 2 && [0, 8, 28, 44].some(c => !mine.has(c) && !theirs.has(c))) out.push('三光 あと1');
    const cnt = [0, 0, 0, 0];
    for (const c of mine) cnt[TYPE[c]]++;
    if (r.rules.sakeKasu && mine.has(32)) cnt[3]++;
    if (cnt[1] === 4) out.push('タネ あと1');
    if (cnt[2] === 4) out.push('タン あと1');
    if (cnt[3] === 9) out.push('カス あと1');
    return out;
  }
  function capsHTML(p) {
    const caps = S.frame.caps[p], r = R();
    const has = new Uint8Array(48);
    caps.forEach(c => { has[c] = 1; });
    let h = '';
    for (const [lab, t] of GROUP) {
      const cs = caps.filter(c => TYPE[c] === t || (t === 3 && c === 32 && r.rules.sakeKasu)).sort((a, b) => a - b);
      const n = cs.length;
      const ov = t === 3 ? (n > 14 ? -0.84 : n > 8 ? -0.76 : -0.62) : n > 6 ? -0.72 : -0.6;
      h += `<div class="cgroup${n ? '' : ' empty'}${t === 3 ? ' kasu' : ''}"><span class="lab">${lab}<b>${n || ''}</b></span><div class="pile" style="--ov:${ov}">` +
        cs.map(c => (c === 32 && t === 3 ? `<span class="card ghostcap" data-k="k32" role="img" aria-label="菊に盃（カスとして）">${KC.svg(32, { tag: settings.tag })}</span>` : cardHTML(c, S.frame.last.includes(c) ? 'last' : ''))).join('') + '</div></div>';
    }
    const y = K.yakuOf(has, r.rules);
    let chips = y.list.map(([k, v]) => `<span class="ychip">${K.YAKU[k].name} ${v}</span>`).join('');
    if (y.list.length > 1) chips += `<span class="ychip sum">計${y.total}点</span>`;
    if (settings.near && r.phase !== 'end') chips += nearYaku(p).map(t => `<span class="ychip near">${t}</span>`).join('');
    return h + `<div class="yaku">${chips}</div>`;
  }
  function renderCaps() {
    $('caps-opp').innerHTML = capsHTML(opp());
    $('caps-me').innerHTML = capsHTML(S.me);
  }

  // 選んでいる手札・めくった札と合う場の札
  function matchTargets() {
    const r = R();
    if (!humanTurn()) return { set: new Set(), ghost: false, src: -1 };
    if (r.phase === 'pick') return { set: new Set(r.matches(r.pending)), ghost: false, src: r.pending };
    if (r.phase === 'play' && S.sel >= 0) { const ms = r.matches(S.sel); return { set: new Set(ms), ghost: ms.length === 0, src: S.sel }; }
    return { set: new Set(), ghost: false, src: -1 };
  }
  function bestAction() {
    const r = R();
    if (!S.assist || S.assist.key !== decisionKey()) return null;
    if (!(settings.best || S.hintKey === decisionKey())) return null;
    return S.assist.best ? S.assist.best.a : null;
  }

  function renderField() {
    const f = S.frame, r = R();
    const mt = matchTargets();
    const best = bestAction();
    const bestTarget = best != null ? (isPlay(best) && playCard(best) === S.sel ? playTarget(best) : isPick(best) ? pickTarget(best) : -2) : -2;
    const dimming = mt.src >= 0;
    let h = '';
    const n = Math.max(S.fieldCap || 8, f.slots.length);
    let ghostDone = false;
    for (let i = 0; i < n; i++) {
      const c = f.slots[i] != null ? f.slots[i] : -1;
      const ons = Object.keys(f.on).filter(k => f.on[k] === i).map(Number);
      if (c < 0 && !ons.length) {
        if (mt.ghost && !ghostDone) { ghostDone = true; h += '<div class="slot ghost" data-act="place" role="button" tabindex="0" aria-label="場に置く">置く</div>'; }
        else h += '<div class="slot"></div>';
        continue;
      }
      let cls = '';
      if (dimming) cls = mt.set.has(c) ? 'match pickme' : 'dim';
      else if (S.inspect === c) cls = 'match';
      if (f.last.includes(c)) cls += ' last';
      const ai = c === bestTarget && mt.set.has(c) && mt.set.size === 2 ? '<span class="ai">おすすめ</span>' : '';
      h += `<div class="slot">${c >= 0 ? cardHTML(c, cls, mt.set.has(c) ? 'button' : 'span').replace('</button>', ai + '</button>') : ''}${ons.map(x => cardHTML(x, 'on last')).join('')}</div>`;
    }
    $('field').innerHTML = h;
    $('fieldwrap').classList.toggle('placeable', mt.ghost && !ghostDone); // 空きがなければ場全体をタップで置く
    // 山札とめくった札
    const mo = S.match.monthIndex;
    let d = `<div class="pile">${f.deck > 0 ? backHTML('deck2') + backHTML('deck1') + backHTML('deck') : ''}</div>`;
    d += `<span class="mon">${MONTH_NUM[(mo) % 12]}</span><span class="cnt">${mo + 1}/${S.match.months}・残り${f.deck}</span>`;
    if (f.float >= 0) d += `<div class="float">${cardHTML(f.float, r.phase === 'pick' ? 'sel' : '')}</div>`;
    $('deck').innerHTML = d;
  }

  function renderHand() {
    const f = S.frame, r = R(), me = S.me;
    const can = humanTurn() && r.phase === 'play' && r.turn === me;
    const best = bestAction();
    const bestCard = best != null && isPlay(best) ? playCard(best) : -1;
    const cards = f.hands[me].slice().sort((a, b) => a - b);
    $('hand').innerHTML = cards.map(c => {
      if (c < 0) return backHTML('mb' + c);
      let cls = can ? 'tap' : '';
      if (S.sel === c) cls += ' sel';
      if (S.inspect >= 0) cls += (c >> 2) === (S.inspect >> 2) ? ' match' : ' dim';
      const ai = c === bestCard && can ? '<span class="ai">おすすめ</span>' : '';
      const flash = S.hintFlash === c ? ' hintflash' : '';
      return cardHTML(c, cls + flash, 'button', can ? '' : 'tabindex="-1"').replace('</button>', ai + '</button>');
    }).join('');
  }

  // 情報の行
  let infoNote = '';
  function setNote(t) { infoNote = t; if (R()) renderInfo(); else if (S.online) renderEmpty(t); }
  function renderInfo() {
    const el = $('info'), r = R();
    if (!el || !r) return;
    let html = '', tools = '', cls = 'info';
    const btn = (act, label, extra = '') => `<button class="mbtn${extra}" data-act="${act}">${label}</button>`;
    const wp = winPill();
    if (S.view != null) {
      cls += ' view';
      const n = S.log.length, i = S.view, e = S.log[i];
      html = `<span class="txt"><b>振り返り ${i + 1}/${n}</b>　${e ? `${shortName(e.p)} ${logLine(e)}` : '配った直後'}</span>`;
      tools = `<button class="mbtn" data-act="v-prev" aria-label="ひとつ前"${i < 0 ? ' disabled' : ''}>◀</button><button class="mbtn" data-act="v-next" aria-label="ひとつ後">▶</button>` + btn('v-exit', '今へ', ' primary');
    } else if (r.phase === 'end') {
      cls += ' result';
      html = `<span class="txt">${resultLine()}</span>`;
      if (S.match.over) tools = btn('again', 'もう一局', ' primary');
      else if (!S.online || !S.online.ready) tools = btn('show-result', '結果') + btn('next', '次の月へ', ' primary');
      else tools = '<span class="muted">次の月の札を混ぜています…</span>';
    } else if (S.online && S.online.netState && S.online.netState !== 'on') {
      cls += ' alert';
      html = '<span class="txt">あなたの通信が切れています（つなぎ直しています…）</span>';
    } else if (S.online && !S.online.oppPresent && S.online.lostAt) {
      cls += ' alert';
      const long = Date.now() - S.online.lostAt > 60000;
      html = `<span class="txt">${esc(S.online.opp.name)}さんの接続が切れています${long ? '' : '（戻るのを待っています）'}</span>`;
      if (long) tools = btn('claim', '勝ちにする');
    } else if (S.inspect >= 0 && !S.busy) {
      const c = S.inspect, mo = c >> 2;
      const mine = S.frame.hands[S.me].filter(x => x >= 0 && (x >> 2) === mo);
      const seen = [S.frame.hands[S.me], S.frame.slots, S.frame.caps[0], S.frame.caps[1]].flat().filter(x => x >= 0 && (x >> 2) === mo).length + (S.frame.float >= 0 && (S.frame.float >> 2) === mo ? 1 : 0);
      html = `<span class="txt"><b>${NAME[c]}</b>　${mine.length ? `手札の${mine.map(x => NAME[x]).join('・')}で取れます` : '手札に合う札はありません'}<span class="muted">（${MONTHS[mo]}の札は あと${4 - seen}枚 見えていません）</span></span>`;
      tools = `<button class="mbtn" data-act="uninspect" aria-label="表示を消す">×</button>`;
    } else if (infoNote && (S.busy || !humanTurn())) {
      html = `<span class="txt">${infoNote}</span>`;
      tools = wp;
    } else if (humanTurn()) {
      cls += ' mine';
      if (r.phase === 'pick') html = `<span class="txt">めくった<b>${NAME[r.pending]}</b>で取る札を選んでください</span>`;
      else if (r.phase === 'koi') html = '<span class="txt"><b>役ができました</b>　こいこいか勝負かを選んでください</span>';
      else if (S.sel >= 0) {
        const ms = r.matches(S.sel);
        html = `<span class="txt"><b>${NAME[S.sel]}</b>　${ms.length === 0 ? '合う札がないので場に置きます（もう一度タップ）' : ms.length === 2 ? '取る札を選んでください' : ms.length === 3 ? '3枚まとめて取れます（もう一度タップ）' : `${NAME[ms[0]]}を取ります（もう一度タップ）`}</span>`;
      } else html = `<span class="txt"><b>あなたの番</b>　<span class="muted">手札から1枚選んでください</span></span>`;
      tools = wp;
    } else if (r.phase !== 'end') {
      html = `<span class="txt">${nameOf(r.turn)}の番です</span>`;
      tools = wp;
    }
    el.className = cls;
    el.innerHTML = html + `<span class="tools">${tools}</span>`;
  }
  // 勝ちの見込み（AI補助）。自分から見た値
  function winPill() {
    if (!settings.wp || !S.assist || S.reveal) return '';
    const v = S.assist.win;
    if (v == null || !Number.isFinite(v) || S.assist.key !== decisionKey()) return '';
    const pc = Math.round(v * 100);
    return `<button class="wp" data-act="wp" title="AI が見積もった、この対局に勝つ見込み（${S.assist.note || ''}）"><span>見込み</span><span class="bar"><i style="width:${pc}%"></i></span><b>${pc}%</b></button>`;
  }
  function resultLine() {
    const r = R(), res = r.result, m = S.match;
    if (m.over) {
      const w = m.winner();
      const head = w < 0 ? '引き分け' : w === S.me ? (S.reveal ? `${nameOf(w)}の勝ち` : 'あなたの勝ち') : `${nameOf(w)}の勝ち`;
      return `<b>対局終了：${head}</b>　${m.totals[S.me]} − ${m.totals[opp()]}`;
    }
    if (res.winner < 0) return `<b>流れ</b>（だれも上がれませんでした）`;
    return `<b>${nameOf(res.winner)}が${res.points}点</b>　${res.yaku.map(([k]) => K.YAKU[k].name).join('・')}${res.mult > 1 ? `（×${res.mult}）` : ''}`;
  }

  function renderControls() {
    const r = R();
    $('btn-ai').setAttribute('aria-pressed', String(aiOn()));
    $('btn-hint').disabled = !humanTurn() || r.phase === 'end';
    $('m-resign').disabled = !r || (S.match.over && r.phase === 'end');
  }

  function renderSideScore() {
    const el = $('side-score');
    if (!el || !document.body.classList.contains('land')) return;
    el.innerHTML = monthsTable(true);
  }
  function monthsTable(compact) {
    const m = S.match, me = S.me, o = opp();
    if (!m) return '';
    let rows = '';
    for (let i = 0; i < m.months; i++) {
      const h = m.history[i];
      const cur = i === m.monthIndex && !m.over;
      const cell = p => (h ? (h.winner === p ? `<td class="w">${h.points}</td>` : '<td>·</td>') : `<td${cur ? ' class="cur"' : ''}></td>`);
      rows += `<tr><th>${compact ? MONTHS[i % 12] : MONTH_NUM[i % 12]}${h && h.dealer === me ? '' : ''}</th>${cell(me)}${cell(o)}</tr>`;
    }
    return `<table class="months"><thead><tr><th></th><th>${shortName(me)}</th><th>${shortName(o)}</th></tr></thead><tbody>${rows}<tr class="sum"><td>計</td><td>${m.totals[me]}</td><td>${m.totals[o]}</td></tr></tbody></table>`;
  }

  // ------------------------------------------------------------------ 札が動くようす（FLIP）
  function snap() {
    const m = new Map();
    $('table').querySelectorAll('[data-k]').forEach(el => m.set(el.dataset.k, el.getBoundingClientRect()));
    return m;
  }
  function animateFrom(before, hint, dur) {
    if (!settings.anim || reduceMotion) return;
    const oh = [...$('ohand').querySelectorAll('[data-k]')];
    $('table').querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      let r0 = before.get(k), flipIn = false;
      if (!r0 && hint[k] === 'deck') { r0 = before.get('deck'); flipIn = true; }
      if (!r0 && hint[k] === 'ohand') { r0 = before.get('ob' + (oh.length)) || before.get('ob0'); flipIn = true; }
      if (!r0 && /^ob\d/.test(k) && hint[k] === 'deck') r0 = before.get('deck');
      if (!r0) return;
      const r1 = el.getBoundingClientRect();
      if (!r1.width) return;
      const dx = r0.left - r1.left, dy = r0.top - r1.top, s = r0.width / r1.width;
      if (!flipIn && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(s - 1) < 0.01) return;
      el.style.zIndex = 30;
      const a = el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${s})${flipIn ? ' rotateY(80deg)' : ''}`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ], { duration: dur, easing: 'cubic-bezier(.2,.8,.2,1)' });
      a.onfinish = () => { el.style.zIndex = ''; };
    });
  }
  const speed = () => (settings.fast ? 0.55 : 1);
  async function showFrames(frames, token) {
    for (const st of frames) {
      if (token !== S.token) return false;
      const before = snap();
      S.frame = st.f;
      render();
      animateFrom(before, st.hint || {}, st.dur * speed());
      if (st.snd === 'slap') SND.slap(); else if (st.snd === 'slap-soft') SND.slap('soft'); else if (st.snd === 'take') SND.take(); else if (st.snd === 'flip') SND.flip();
      await sleep(((settings.anim && !reduceMotion) ? st.dur : 60) * speed() + (st.pause || 0) * speed());
    }
    return token === S.token;
  }

  // ------------------------------------------------------------------ 対局の進行
  function newMatch(c, opts) {
    opts = opts || {};
    AIW.cancel();
    S.token++;
    if (!opts.online) { leaveOnline(); cfg = c; store.set('cfg', cfg); }
    const rules = K.normRules(Object.assign({}, c.rules, { months: c.months }));
    if (opts.online) { S.seats = opts.seats; S.me = opts.me; S.reveal = false; }
    else if (c.mode === 'watch') { S.seats = [c.cpu, c.cpu2 || c.cpu]; S.me = 0; S.reveal = true; }
    else { S.seats = ['human', c.cpu]; S.me = 0; S.reveal = false; }
    // 親決め: 1枚ずつ引いて、早い月（同じ月なら格の高い札）の人が親
    let draw = null;
    if (opts.dealer == null) {
      const d = K.shuffled(Math.random);
      draw = [d[0], d[1]];
      const better = (x, y) => ((x >> 2) !== (y >> 2) ? (x >> 2) < (y >> 2) : (x & 3) < (y & 3));
      opts.dealer = better(draw[0], draw[1]) ? 0 : 1;
    }
    S.match = new K.Match({ rules, dealer: opts.dealer });
    S.hints = 0;
    closeSheet();
    $('dlg-result').hidden = true;
    if (!opts.online) { if (draw && !S.reveal) oyaKime(draw).then(t => { if (t === S.token) startRound(); }); else startRound(); }
    else { S.round = null; S.frame = null; S.roundEnded = null; S.log = []; clearStage(); renderEmpty('相手と札を混ぜています…'); }
  }
  // まだ配っていないとき（オンラインで札を混ぜている間）
  function renderEmpty(note) {
    ['pbar-opp', 'ohand', 'caps-opp', 'field', 'caps-me', 'hand'].forEach(id => { $(id).innerHTML = ''; });
    $('deck').innerHTML = `<div class="pile">${backHTML('deck')}</div>`;
    $('info').className = 'info';
    $('info').innerHTML = `<span class="txt">${note || ''}</span>`;
  }

  // 親決めの演出: 2枚の札を伏せて出し、めくって見せる
  async function oyaKime(draw) {
    const token = ++S.token;
    S.round = null; S.frame = null;
    ['pbar-opp', 'ohand', 'caps-opp', 'field', 'caps-me', 'hand', 'pbar-me'].forEach(id => { $(id).innerHTML = ''; });
    $('deck').innerHTML = `<div class="pile">${backHTML('deck')}</div>`;
    $('info').className = 'info';
    $('info').innerHTML = '<span class="txt">札を1枚ずつ引いて親を決めます（早い月の札を引いた人が親）</span>';
    const who = [S.me, opp()];
    const card = (p, open) => `<div class="oyak"><span class="who">${p === S.me ? 'あなた' : nameOf(p)}</span>${open ? plainCard(draw[p]) : `<span class="card">${KC.svg(-1)}</span>`}${open ? `<span class="mon">${MONTH_NUM[draw[p] >> 2]}</span>` : ''}</div>`;
    const show = open => { $('stage').innerHTML = `<div class="yakuban oyakime pop-in"><div class="who">親決め</div><div class="pair">${who.map(p => card(p, open)).join('')}</div>${open ? `<div class="pts"><b>${S.match.dealer === S.me ? 'あなた' : nameOf(S.match.dealer)}</b>が親です（先に打ちます）</div>` : ''}</div>`; };
    show(false);
    await sleep(700 * speed());
    if (token !== S.token) return -1;
    SND.flip();
    show(true);
    await sleep(1500 * speed());
    if (token !== S.token) return -1;
    clearStage();
    return S.token;
  }

  async function startRound(order, idx) {
    AIW.cancel();
    const token = ++S.token;
    const r = order ? S.match.startRound(order) : S.match.startRound();
    if (!r) return false;
    r.idx = idx != null ? idx : S.match.monthIndex;
    S.round = r;
    S.slots = r.field.slice();
    S.sel = -1; S.assist = null; S.hintKey = ''; S.hintFlash = -1; S.stage = null; S.thinking = false; S.busy = true;
    S.log = [];
    $('stage').innerHTML = '';
    infoNote = `${MONTH_NUM[S.match.monthIndex % 12]}（${S.match.monthIndex + 1}/${S.match.months}）　${nameOf(r.dealer)}が親です`;
    // 配る: 山札から場・手札へ
    const empty = { hands: [[], []], slots: [], caps: [[], []], deck: 48, float: -1, on: {}, last: [] };
    S.frame = empty;
    render();
    const ko = r.dealer ^ 1;
    const steps = [];
    const f = cloneFrame(empty);
    const deal = (who, cards) => {
      for (const c of cards) { if (who === 'field') f.slots.push(c); else f.hands[who].push(c); f.deck--; }
      steps.push({ f: cloneFrame(f), hint: Object.fromEntries(cards.map(c => [c, 'deck'])), snd: 'slap-soft', dur: 260, pause: 40 });
    };
    // 配る順: 子に4・場に4・親に4・子に4・場に4・親に4（親が配る）
    deal(ko, r.hands[ko].slice(0, 4)); deal('field', r.field.slice(0, 4)); deal(r.dealer, r.hands[r.dealer].slice(0, 4));
    deal(ko, r.hands[ko].slice(4)); deal('field', r.field.slice(4)); deal(r.dealer, r.hands[r.dealer].slice(4));
    // 相手の手札は裏（ob0, ob1 …）で描くので、新しく増えた裏も山札から飛ばす
    let prevOb = 0;
    for (const st of steps) {
      const n = st.f.hands[opp()].length;
      for (let i = prevOb; i < n; i++) st.hint['ob' + i] = 'deck';
      prevOb = n;
    }
    await showFrames(steps, token);
    if (token !== S.token) return false;
    S.frame = frameOf(r);
    S.snap0 = cloneFrame(S.frame);
    S.busy = false;
    infoNote = '';
    render();
    saveGame();
    if (r.phase === 'end') { await sleep(400); onRoundEnd(); return true; }
    schedule();
    if (OL && S.online) OL.afterStep();
    return true;
  }

  // 「新しい対局」を開いている間は裏の対局を進めない（CPU は打たない。閉じたら schedule() で続ける）
  const choosing = () => !$('dlg-new').hidden;

  // 次にだれが何をするか
  function schedule() {
    const r = R();
    if (!r || S.busy || S.view != null) return;
    if (choosing()) { S.thinking = false; renderBars(); return; }
    renderInfo();
    if (r.phase === 'end') return;
    const p = r.turn;
    if (isCPU(p)) cpuMove(p);
    else if (isHuman(p)) { S.thinking = false; renderBars(); if (r.phase === 'koi') showKoiChoice(); requestAssist(); }
    else { S.thinking = true; renderBars(); renderInfo(); } // オンラインの相手を待つ
  }

  async function cpuMove(p) {
    const r = R(), token = S.token, lvl = CPU[S.seats[p]];
    const key = decisionKey();
    S.thinking = true;
    renderBars();
    const t0 = Date.now();
    const lg = r.legal();
    let a = lg[0];
    if (lg.length > 1) {
      const job = lvl.search ? { search: lvl.mode || true, timeMs: settings.fast ? 900 : lvl.search } : {};
      let list = await AIW.run(r, p, ctxOf(p), job);
      if (!list && AIW.broken && token === S.token && key === decisionKey()) list = await AIW.run(r, p, ctxOf(p), job); // ワーカーが使えなければこの画面の中で
      if (token !== S.token || key !== decisionKey()) return;
      if (list) a = pickWithTemp(list, lvl.temp || 0).a;
    }
    const wait = (r.phase === 'koi' ? 700 : lg.length > 1 ? 520 : 320) * speed() - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    if (token !== S.token || key !== decisionKey()) return;
    S.thinking = false;
    if (choosing()) { renderBars(); return; } // 閉じたときの schedule() で打ち直す
    act(a);
  }

  // 手を指す（人・CPU・オンラインの相手のどれでも）
  // 画面からの手: オンラインなら相手に送ってから（オンラインの部分が確かめてから act を呼ぶ）
  function userAct(a) {
    if (S.online && OL) { S.sel = -1; OL.myAction(a); render(); return; }
    act(a);
  }
  // 手を指す（人・CPU・オンライン）。external = オンラインの部分が合法か確かめ済み（相手の手札は見えない）
  async function act(a, external) {
    const r = R();
    if (!r || r.phase === 'end' || (!external && !r.isLegal(a))) return false;
    const token = S.token;
    const p = r.turn, phase = r.phase;
    AIW.cancel();
    if (S.view != null) exitView(true);
    S.sel = -1; S.assist = null; S.hintKey = ''; S.hintFlash = -1; S.inspect = -1;
    clearStage();
    const n0 = r.log.length, f0 = S.frame;
    const before = { score: r.score[p] };
    r.step(a);
    const evs = r.log.slice(n0);
    S.busy = true;
    // 札の動き
    let f = f0;
    const frames = [];
    for (const ev of evs) {
      const fs = framesFor(f, ev);
      frames.push(...fs);
      if (fs.length) f = fs[fs.length - 1].f;
      addLog(ev, f);
    }
    if (phase === 'play') {
      infoNote = `${shortName(p)}：${NAME[playCard(a)]}${evs[0] && evs[0].took.length ? `で${evs[0].took.filter(x => x !== playCard(a)).map(x => NAME[x]).join('・')}を取る` : 'を場に'}`;
    }
    if (r.phase === 'pick') {
      // めくった札が2枚と合う: めくった札を見せて止まる
      const ff = cloneFrame(f);
      ff.deck = r.deck.length; ff.float = r.pending; ff.last = [r.pending];
      frames.push({ f: ff, hint: { [r.pending]: 'deck' }, snd: 'flip', dur: 300 });
    }
    if (frames.length) S.slots = frames[frames.length - 1].f.slots.slice(); // 動かした置き場所をそのまま使う
    const ok = await showFrames(frames, token);
    if (!ok) return false;
    S.frame = frameOf(r);
    S.busy = false;
    if (a === KOI) await koiEffect(p);
    else if (a === STOP && r.phase === 'end') SND.stop();
    // 役ができた
    if (r.phase === 'koi' || (r.phase === 'end' && r.result && r.result.reason === '勝負' && a !== STOP && evs.some(e => e.k === 'stop'))) {
      await yakuEffect(p, before.score);
      if (token !== S.token) return false;
    }
    render();
    saveGame();
    if (r.phase === 'end') { onRoundEnd(); return true; }
    schedule();
    if (OL && S.online) OL.afterStep();
    return true;
  }

  // 役ができたときの演出（新しくできた役を大きく）
  async function yakuEffect(p, oldScore) {
    const r = R();
    const y = K.yakuOf(r.has[p], r.rules);
    SND.yaku();
    const names = y.list.map(([k]) => K.YAKU[k].name);
    const cards = yakuCards(y.list, r.has[p]);
    S.stage = { kind: 'yaku', p };
    $('stage').innerHTML = `<div class="yakuban pop-in" id="yakuban">
      <div class="who">${nameOf(p)}</div>
      <div class="names">${names.map(n => `<span>${n}</span>`).join('')}</div>
      <div class="rule"></div>
      <div class="cards">${cards.map(plainCard).join('')}</div>
      <div class="pts">役の合計<b>${y.total}</b>点</div>
      <div class="choose" id="koi-choose"></div><div class="advice" id="koi-advice"></div></div>`;
    if (!isHuman(p) || r.phase !== 'koi') { await sleep(1500 * speed()); if (S.stage && S.stage.kind === 'yaku') clearStage(); }
  }
  function yakuCards(list, has) {
    const pick = new Set();
    const add = cs => cs.forEach(c => { if (has[c]) pick.add(c); });
    for (const [k] of list) {
      if (['goko', 'shiko', 'ameshiko', 'sanko'].includes(k)) add([0, 8, 28, 40, 44]);
      else if (k === 'hanami') add([8, 32]);
      else if (k === 'tsukimi') add([28, 32]);
      else if (k === 'isc') add([20, 24, 36]);
      else if (k === 'akatan' || k === 'akaao') add([1, 5, 9]);
      if (k === 'aotan' || k === 'akaao') add([21, 33, 37]);
    }
    if (!pick.size) { for (const [k] of list) { const t = { tane: 1, tan: 2, kasu: 3 }[k]; if (t != null) for (let c = 0; c < 48; c++) if (has[c] && TYPE[c] === t) pick.add(c); } }
    return [...pick].sort((a, b) => a - b).slice(0, 10);
  }
  // こいこいか勝負か（人の番）
  function showKoiChoice() {
    const r = R(), p = r.turn;
    if (!$('yakuban')) {
      const y = K.yakuOf(r.has[p], r.rules);
      $('stage').innerHTML = `<div class="yakuban pop-in" id="yakuban"><div class="who">${nameOf(p)}</div><div class="names">${y.list.map(([k]) => `<span>${K.YAKU[k].name}</span>`).join('')}</div><div class="rule"></div><div class="pts">役の合計<b>${y.total}</b>点</div><div class="choose" id="koi-choose"></div><div class="advice" id="koi-advice"></div></div>`;
      S.stage = { kind: 'yaku', p };
    }
    const pts = AI.stopPoints(r, p);
    const mult = pts / Math.max(1, r.score[p]);
    $('koi-choose').innerHTML = (r.canKoi() ? '<button class="koi" data-act="koi">こいこい<small>続けて役を増やす</small></button>' : '') +
      `<button class="stop" data-act="stop">勝負<small>${pts}点で上がる${mult > 1 ? `（×${mult}）` : ''}</small></button>`;
    renderKoiAdvice();
  }
  function renderKoiAdvice() {
    const el = $('koi-advice');
    if (!el) return;
    const r = R();
    const best = bestAction();
    $('koi-choose').querySelectorAll('button').forEach(b => b.classList.toggle('rec', best != null && ((best === KOI && b.dataset.act === 'koi') || (best === STOP && b.dataset.act === 'stop'))));
    if (best == null || !S.assist) { el.textContent = ''; return; }
    const ek = S.assist.list.find(e => e.a === KOI), es = S.assist.list.find(e => e.a === STOP);
    el.textContent = `AI のおすすめ：${best === KOI ? 'こいこい' : '勝負'}` + (settings.wp && ek && es ? `（勝つ見込み こいこい ${Math.round(ek.win * 100)}% / 勝負 ${Math.round(es.win * 100)}%）` : '');
  }
  function clearStage() { $('stage').innerHTML = ''; S.stage = null; }
  async function koiEffect(p) {
    SND.koikoi();
    $('stage').innerHTML = '<div class="koicall">こいこい</div>';
    await sleep(1000 * speed());
    clearStage();
  }

  function onRoundEnd() {
    const r = R();
    if (!r || r.phase !== 'end') return;
    if (!S.roundEnded || S.roundEnded !== r) {
      S.roundEnded = r;
      S.match.endRound();
      const res = r.result;
      if (res.winner === S.me && !S.reveal) SND.win(); else if (res.winner < 0) SND.draw(); else SND.lose();
      saveGame();
    }
    S.frame = frameOf(r);
    S.sel = -1; S.assist = null; S.busy = false; S.thinking = false;
    clearStage();
    render();
    if (OL && S.online) OL.afterStep();
    setTimeout(() => { if (R() === r) showResult(); }, 700);
  }

  function showResult() {
    const r = R(), res = r.result, m = S.match;
    if (!r || r.phase !== 'end') return;
    const sub = `${MONTH_NUM[(m.monthIndex - 1 + 12) % 12]}（${m.monthIndex}/${m.months}）${S.online ? '・オンライン' : ''}`;
    let title, body = '';
    if (res.winner < 0) title = '流れ';
    else title = `${nameOf(res.winner)}が ${res.points}点`;
    if (res.winner >= 0) {
      body += '<ul class="rlist">' + res.yaku.map(([k, v]) => `<li><b>${K.YAKU[k].name}</b><span>${v}点</span></li>`).join('');
      if (res.mult > 1) {
        const why = [];
        if (r.rules.double7 && res.base >= 7 && res.reason === '勝負') why.push('7点以上で2倍');
        if (r.rules.koiDouble && res.reason === '勝負' && r.koi[res.winner ^ 1] > 0) why.push('相手のこいこい返しで2倍');
        body += `<li class="mult"><span>${why.join('・')}</span><span>×${res.mult}</span></li>`;
      }
      body += `<li class="total"><span>この月</span><span>${res.points}点</span></li></ul>`;
      if (r.koi[res.winner ^ 1] > 0 && res.reason === '勝負') body += `<p class="hint" style="margin:0 0 6px">${nameOf(res.winner ^ 1)}のこいこいは失敗（0点）</p>`;
    } else body += `<p style="margin:6px 0 10px">${r.koi[0] || r.koi[1] ? 'こいこいした人も役が増えないまま札が尽きました。' : 'どちらも役ができないまま札が尽きました。'}親はそのままです。</p>`;
    body += `<div class="bigscore"><div><b>${m.totals[S.me]}</b><span>${shortName(S.me)}</span></div><div><span>−</span></div><div><b>${m.totals[opp()]}</b><span>${shortName(opp())}</span></div></div>`;
    if (S.online) {
      const o = S.online;
      body += `<p class="hint" style="text-align:center;margin:6px 0 0">相手は ${esc(o.opp.name)} さん（${aiText(o.opp.ai)}${o.opp.hints ? `・ヒント${o.opp.hints}回` : ''}）。あなたは${aiText(aiFlags())}${S.hints ? `・ヒント${S.hints}回` : ''}。</p>`;
      if (o.cheat) body += `<p class="hint" style="text-align:center;color:var(--bad)">⚠ ${esc(o.cheat)}</p>`;
    }
    let actions = '<button class="btn" data-act="close-result">卓を見る</button>';
    if (m.over) {
      const w = m.winner();
      title = w < 0 ? '引き分け' : `${S.reveal ? nameOf(w) : w === S.me ? 'あなた' : nameOf(w)}の勝ち`;
      body = `<p class="hint" style="margin:0">${m.months}か月の合計</p>` + body.replace(/<ul class="rlist">[\s\S]*<\/ul>/, '') + `<div style="margin-top:8px">${monthsTable(false)}</div>`;
      actions += S.online ? '<button class="btn" data-act="lobby">ロビーへ</button><button class="btn primary" data-act="rematch">もう一局</button>' : '<button class="btn" data-act="settings-new">設定を変える</button><button class="btn primary" data-act="again">もう一局</button>';
      if (!S.reveal) { if (w === S.me) SND.win(); }
    } else actions += '<button class="btn primary" data-act="next">次の月へ</button>';
    $('rs-sub').textContent = sub;
    $('rs-title').textContent = title;
    $('rs-body').innerHTML = body;
    $('rs-actions').innerHTML = actions;
    $('dlg-result').hidden = false;
    const pb = $('rs-actions').querySelector('.primary');
    if (pb) pb.focus();
  }
  function nextRound() {
    $('dlg-result').hidden = true;
    if (S.match.over) return;
    if (S.online) { onlineNextRound(); return; }
    startRound();
  }

  // ------------------------------------------------------------------ 記録（この月の流れ）
  // 記録: 出来事と、そのあとの並び（振り返りで見せる）
  function addLog(ev, f) {
    S.log.push({ p: ev.p, k: ev.k, c: ev.c, took: ev.took ? ev.took.slice() : [], month: S.match.monthIndex, f: f ? cloneFrame(f) : null });
  }
  function logLine(e) {
    const mini = cs => `<span class="mini">${cs.map(plainCard).join('')}</span>`;
    if (e.k === 'play') return `出す ${mini([e.c])}${e.took.length ? ` → 取る ${mini(e.took.filter(x => x !== e.c))}` : ' → 場に置く'}`;
    if (e.k === 'draw') return `めくる ${mini([e.c])}${e.took.length ? ` → 取る ${mini(e.took.filter(x => x !== e.c))}` : ' → 場に置く'}`;
    return e.k === 'koi' ? '<b>こいこい</b>' : '<b>勝負</b>';
  }
  // 振り返り: i 番目の出来事のあと（-1 = 配った直後）を卓に出す。その間は打てない（CPU も待つ）
  function enterView(i) {
    const snaps = S.log.map(e => e.f);
    if (i >= S.log.length) { exitView(); return; }
    const f = i < 0 ? S.snap0 : snaps[i];
    if (!f) return;
    S.view = i; S.sel = -1;
    S.frame = cloneFrame(f);
    closeSheet(); clearStage();
    render();
  }
  function exitView(quiet) {
    if (S.view == null) return;
    S.view = null;
    const r = R();
    if (r) S.frame = frameOf(r);
    if (quiet) return;
    render();
    if (r && r.phase === 'koi' && isHuman(r.turn)) showKoiChoice();
    schedule();
  }
  function logHTML() {
    if (!S.log.length) return '<p class="hint">まだ何もしていません。</p>';
    let i = 0;
    return '<p class="hint" style="margin:0 0 4px">押すとその時の卓を見られます（振り返り）</p><ol class="log">' +
      `<li class="ev" data-v="-1" role="button" tabindex="0"><span class="no"></span><span class="who"></span><span>配った直後</span></li>` +
      S.log.map((e, k) => {
        if (e.k === 'play') i++;
        return `<li class="${e.p === S.me ? 'me' : ''}${e.k === 'draw' ? ' ev' : ''}${S.view === k ? ' cur' : ''}" data-v="${k}" role="button" tabindex="0"><span class="no">${e.k === 'play' ? i : ''}</span><span class="who">${shortName(e.p)}</span><span>${logLine(e)}</span></li>`;
      }).join('') + '</ol>';
  }
  function openSheet(tab) {
    const sh = $('sheet');
    sh.dataset.tab = tab || sh.dataset.tab || 'log';
    sh.querySelectorAll('.sheet-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === sh.dataset.tab)));
    $('sheet-body').innerHTML = sh.dataset.tab === 'log' ? logHTML() : monthsTable(false) + winGraph();
    sh.classList.add('open');
  }
  // 月のはじめごとの「対局に勝つ見込み」（AI補助。月の結果の分布から計算した表 V で）
  function winGraph() {
    const m = S.match;
    if (!m || !aiOn() || S.reveal || !m.history.length) return '';
    const V = getMainNet().V;
    const pts = [];
    let tot = [0, 0], dealer = m.firstDealer;
    for (let i = 0; i <= m.history.length && i <= m.months; i++) {
      const after = m.months - i, lead = tot[S.me] - tot[opp()];
      pts.push(after <= 0 ? (lead > 0 ? 1 : lead < 0 ? 0 : 0.5) : AI.vAt(V, after, lead, dealer === S.me));
      const h = m.history[i];
      if (!h) break;
      if (h.winner >= 0) { tot[h.winner] += h.points; dealer = h.winner; }
    }
    const W = 300, H = 90, x = i => 8 + i * (W - 16) / Math.max(1, m.months), y = v => H - 10 - v * (H - 20);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<h4 style="margin:12px 0 4px;font-size:12px;color:var(--muted)">月のはじめの勝つ見込み（${shortName(S.me)}）</h4>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:420px;height:auto;display:block" role="img" aria-label="月ごとの勝つ見込み">
      <line x1="8" x2="${W - 8}" y1="${y(0.5)}" y2="${y(0.5)}" stroke="var(--line)" stroke-dasharray="3 3"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>
      ${pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="var(--accent)"><title>${i + 1}か月目のはじめ ${Math.round(v * 100)}%</title></circle>`).join('')}
      <text x="8" y="9" font-size="9" fill="var(--muted)">100%</text><text x="8" y="${H - 1}" font-size="9" fill="var(--muted)">0%</text></svg>`;
  }
  function closeSheet() { $('sheet').classList.remove('open'); }

  // ------------------------------------------------------------------ AI補助
  const decisionKey = () => { const r = R(); return r ? `${S.token}:${r.log.length}:${r.phase}:${r.turn}` : ''; };
  async function requestAssist(force) {
    const r = R();
    if (!r || !humanTurn()) return;
    if (!aiOn() && !force) return;
    if (r.legal().length < 1) return;
    const key = decisionKey();
    if (S.assist && S.assist.key === key && !force) { renderAssist(); return; }
    const p = r.turn;
    // まずネットの見込み（すぐ）、続けて読み（約1秒）で確かめる
    const quick = await AIW.run(r, p, ctxOf(p), {});
    if (!quick || key !== decisionKey()) return;
    S.assist = { key, list: quick, best: bestOf(quick), win: bestOf(quick).win, note: '最強の CPU と同じネットの見込み' };
    renderAssist();
  }
  function renderAssist() { renderHand(); renderField(); renderInfo(); renderKoiAdvice(); }

  function hint() {
    const r = R();
    if (!humanTurn()) return;
    S.hintKey = decisionKey();
    S.hints++;
    if (S.online && NETC) { NETC.send({ t: 'hint' }); renderBars(); }
    const show = () => {
      const b = S.assist && S.assist.best && S.assist.best.a;
      if (b == null) return;
      if (isPlay(b)) { S.sel = -1; S.hintFlash = playCard(b); }
      renderAssist();
      setTimeout(() => { S.hintFlash = -1; }, 2100);
    };
    if (S.assist && S.assist.key === decisionKey()) show();
    else requestAssist(true).then(show);
  }

  // ------------------------------------------------------------------ 入力
  function onHandTap(c) {
    const r = R();
    S.inspect = -1;
    if (!humanTurn() || r.phase !== 'play' || r.turn !== S.me) return;
    if (S.sel === c) {
      // もう一度タップ: 取る札が1つに決まるなら出す
      const ms = r.matches(c);
      if (ms.length !== 2) { userAct(PLAY(c, -1)); return; }
      S.sel = -1; render(); return;
    }
    S.sel = c;
    SND.slap('soft');
    render();
  }
  function onFieldTap(c) {
    const r = R();
    if (!r || r.phase === 'end' || S.view != null) return;
    // 何も選んでいないとき: その札を取れる手札を光らせる（もう一度で消す）
    if (S.sel < 0 && !(humanTurn() && r.phase === 'pick')) { S.inspect = S.inspect === c ? -1 : c; render(); return; }
    if (!humanTurn()) return;
    if (r.phase === 'pick') { if (r.matches(r.pending).includes(c)) userAct(PICK(c)); return; }
    if (r.phase !== 'play' || S.sel < 0) return;
    const ms = r.matches(S.sel);
    if (!ms.includes(c)) return;
    userAct(PLAY(S.sel, ms.length === 2 ? c : -1));
  }

  function bind() {
    document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('hand').addEventListener('click', e => { const el = e.target.closest('.card[data-c]'); if (el) onHandTap(+el.dataset.c); });
    $('fieldwrap').addEventListener('click', e => {
      if (e.target.closest('[data-act="place"]') || ($('fieldwrap').classList.contains('placeable') && !e.target.closest('#deck'))) { if (S.sel >= 0 && humanTurn() && !R().matches(S.sel).length) userAct(PLAY(S.sel, -1)); return; }
      const el = e.target.closest('.card[data-c]');
      if (el) onFieldTap(+el.dataset.c);
      else if (S.sel >= 0 && !e.target.closest('.slot')) { S.sel = -1; render(); }
    });
    $('field').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-act="place"]')) { e.preventDefault(); if (S.sel >= 0 && humanTurn()) userAct(PLAY(S.sel, -1)); } });
    $('table').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) { if ((S.sel >= 0 || S.inspect >= 0) && !e.target.closest('.card') && !e.target.closest('.slot')) { S.sel = -1; S.inspect = -1; render(); } return; }
      const act2 = b.dataset.act;
      if (act2 === 'koi') { if (humanTurn() && R().phase === 'koi') userAct(KOI); }
      else if (act2 === 'stop') { if (humanTurn() && R().phase === 'koi') userAct(STOP); }
      else if (act2 === 'next') nextRound();
      else if (act2 === 'show-result') showResult();
      else if (act2 === 'again') again();
      else if (act2 === 'wp') { /* 見込みの説明はタイトルに */ }
      else if (act2 === 'claim') claimWin();
      else if (act2 === 'v-prev') enterView(Math.max(-1, S.view - 1));
      else if (act2 === 'v-next') enterView(S.view + 1);
      else if (act2 === 'v-exit') exitView();
      else if (act2 === 'uninspect') { S.inspect = -1; render(); }
    });
    $('dlg-result').addEventListener('click', e => {
      if (e.target === $('dlg-result')) { $('dlg-result').hidden = true; return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'close-result') $('dlg-result').hidden = true;
      else if (a === 'next') nextRound();
      else if (a === 'again') { $('dlg-result').hidden = true; again(); }
      else if (a === 'settings-new') { $('dlg-result').hidden = true; openNew(); }
      else if (a === 'rematch') { $('dlg-result').hidden = true; requestRematch(); }
      else if (a === 'lobby') { $('dlg-result').hidden = true; leaveOnline(); openOnline(); }
    });
    $('btn-new').addEventListener('click', () => {
      if (S.online && !S.match.over && !confirm('オンライン対局の途中です。新しい対局を始めると投了になります。よろしいですか？')) return;
      openNew();
    });
    $('btn-hint').addEventListener('click', hint);
    $('btn-ai').addEventListener('click', toggleAI);
    $('btn-log').addEventListener('click', () => openSheet('log'));
    $('m-log').addEventListener('click', () => { $('menu-more').hidden = true; openSheet('log'); });
    $('m-resign').addEventListener('click', () => { $('menu-more').hidden = true; resign(); });
    $('btn-more').addEventListener('click', e => { e.stopPropagation(); const m = $('menu-more'); m.hidden = !m.hidden; $('btn-more').setAttribute('aria-expanded', String(!m.hidden)); });
    $('sheet').addEventListener('click', e => {
      const t = e.target.closest('.sheet-tabs button');
      if (t) { openSheet(t.dataset.st); return; }
      const li = e.target.closest('.log li[data-v]');
      if (li && !S.busy) { enterView(+li.dataset.v); return; }
      if (e.target.closest('[data-act="sheet-close"]')) closeSheet();
    });
    $('btn-settings').addEventListener('click', e => { e.stopPropagation(); const p = $('settings'); p.hidden = !p.hidden; $('btn-settings').setAttribute('aria-expanded', String(!p.hidden)); });
    $('settings').addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { $('settings').hidden = true; $('menu-more').hidden = true; });
    const boxes = { 'set-wp': 'wp', 'set-best': 'best', 'set-tag': 'tag', 'set-near': 'near', 'set-sound': 'sound', 'set-anim': 'anim', 'set-fast': 'fast' };
    for (const [id, k] of Object.entries(boxes)) {
      $(id).checked = !!settings[k];
      $(id).addEventListener('change', () => {
        settings[k] = $(id).checked; saveSettings();
        if (k === 'sound') SND.setEnabled(settings.sound);
        if ((k === 'wp' || k === 'best') && aiOn()) requestAssist();
        if ((k === 'wp' || k === 'best') && S.online && NETC) NETC.setAI(aiFlags());
        render();
      });
    }
    // 新しい対局
    $('ng-cancel').addEventListener('click', () => { $('dlg-new').hidden = true; schedule(); });
    $('ng-start').addEventListener('click', () => {
      $('dlg-new').hidden = true;
      if (S.online && !S.match.over) resign(true);
      newMatch(Object.assign({}, ngCfg));
    });
    $('dlg-new').addEventListener('click', e => {
      if (e.target === $('dlg-new')) { $('dlg-new').hidden = true; schedule(); return; }
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const grp = b.parentElement.id;
      // オンライン対戦: 上の丸いボタンと同じパネルを開く（今の対局はオンラインで始まるまでそのまま）
      if (grp === 'ng-mode' && b.dataset.v === 'online') { $('dlg-new').hidden = true; schedule(); openOnline(); return; }
      if (grp === 'ng-mode') ngCfg.mode = b.dataset.v;
      else if (grp === 'ng-cpu') ngCfg.cpu = b.dataset.v;
      else if (grp === 'ng-months') ngCfg.months = +b.dataset.v;
      else if (grp === 'ng-rules') ngCfg.rules[b.dataset.v] = !ngCfg.rules[b.dataset.v];
      drawNew();
    });
    // オンライン
    $('btn-online').addEventListener('click', openOnline);
    $('on-close').addEventListener('click', () => { $('dlg-online').hidden = true; });
    $('dlg-online').addEventListener('click', onLobbyClick);
    $('dlg-online').addEventListener('change', e => { if (e.target.id === 'on-name') { myName = e.target.value.trim().slice(0, 16) || 'ゲスト'; store.set('name', myName); if (NETC) NETC.setName(myName); } });
    // キーボード: 1〜8 で手札、Esc で選択を消す
    document.addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (e.key === 'Escape') {
        const wasChoosing = choosing();
        S.inspect = -1; closeSheet(); ['dlg-new', 'dlg-result', 'dlg-online'].forEach(id => { $(id).hidden = true; }); $('settings').hidden = true; $('menu-more').hidden = true; if (S.sel >= 0) { S.sel = -1; render(); }
        if (wasChoosing) schedule();
        return;
      }
      const r = R();
      if (!humanTurn() || !$('dlg-new').hidden || !$('dlg-result').hidden) return;
      if (/^[1-8]$/.test(e.key) && r.phase === 'play') { const hs = S.frame.hands[S.me].slice().sort((a, b) => a - b); const c = hs[+e.key - 1]; if (c != null) onHandTap(c); }
      if (r.phase === 'koi' && (e.key === 'k' || e.key === 'K')) userAct(KOI);
      if (r.phase === 'koi' && (e.key === 's' || e.key === 'S')) userAct(STOP);
    });
    window.addEventListener('resize', fitSoon);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitSoon);
  }
  function saveSettings() {
    store.set('settings', settings);
    const boxes = { 'set-wp': 'wp', 'set-best': 'best' };
    for (const [id, k] of Object.entries(boxes)) $(id).checked = !!settings[k];
  }
  function again() {
    if (S.online) { requestRematch(); return; }
    newMatch(cfg);
  }
  function resign(quiet) {
    const r = R();
    if (!S.match || (S.match.over && (!r || r.phase === 'end'))) return;
    if (!quiet && !confirm('この対局をやめますか？（負けになります）')) return;
    if (S.online && NETC) NETC.send({ t: 'resign' });
    endByResign(S.me, '投了');
    if (!quiet) showResult();
  }
  // 投了・接続切れ: 残りの月を流して、投了した側の負けにする
  function endByResign(loser, reason) {
    AIW.cancel();
    S.token++;
    S.busy = false;
    const m = S.match, r = R();
    m.resigned = loser;
    m.totals[loser ^ 1] = Math.max(m.totals[loser ^ 1], m.totals[loser] + 1);
    if (r && r.phase !== 'end') r.finish(-1, [], 0, 1, reason);
    while (!m.over) m.history.push({ dealer: -1, winner: -1, points: 0, yaku: [], reason });
    if (r) { S.roundEnded = r; S.frame = frameOf(r); }
    clearStage();
    render();
    saveGame();
    if (S.online && OL) OL.afterStep();
  }
  function oppResigned(reason) {
    if (!S.match || S.match.over) return;
    endByResign(opp(), reason || `${S.online ? esc(S.online.opp.name) + 'さん' : '相手'}の投了`);
    setNote(`${S.online ? esc(S.online.opp.name) + 'さん' : '相手'}が対局をやめました（あなたの勝ち）`);
    showResult();
  }
  function toggleAI() {
    const v = !aiOn();
    settings.wp = v; settings.best = v; saveSettings();
    if (v) requestAssist(); else { S.assist = null; AIW.cancel(); }
    render();
    if (NETC) NETC.setAI(aiFlags());
    if (OL) OL.renderLobby();
  }

  // ------------------------------------------------------------------ 新しい対局の設定
  let ngCfg = null;
  function openNew() {
    ngCfg = JSON.parse(JSON.stringify(cfg));
    drawNew();
    $('dlg-new').hidden = false;
  }
  function drawNew() {
    const seg = (id, items, val) => { $(id).innerHTML = items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join(''); };
    seg('ng-mode', [['cpu', 'CPUと対局'], ['watch', 'CPUどうしを観戦'], ['online', 'オンライン対戦']], ngCfg.mode);
    $('ng-cpu').innerHTML = CPU_KEYS.map(k => `<button type="button" data-v="${k}" aria-pressed="${ngCfg.cpu === k}"><span class="stars">${'★'.repeat(CPU[k].stars)}${'☆'.repeat(4 - CPU[k].stars)}</span><b>${CPU[k].label}</b><small>${CPU[k].desc}</small></button>`).join('');
    $('ng-cpu-desc').textContent = CPU[ngCfg.cpu].desc;
    seg('ng-months', [[12, '12か月'], [6, '6か月'], [3, '3か月']], ngCfg.months);
    $('ng-rules').innerHTML = RULE_CHIPS.map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${!!ngCfg.rules[k]}">${l}</button>`).join('');
    const changed = RULE_CHIPS.filter(([k]) => !!ngCfg.rules[k] !== !!K.DEFAULT_RULES[k]).length;
    $('ng-rules-hint').textContent = changed ? `標準のルールから${changed}つ変えています（AI は標準のルールで多く学んでいます）` : '標準のルール（くわしくは「ルール」のページ）';
  }

  // ------------------------------------------------------------------ 画面に合わせた大きさ
  let fitPending = 0;
  function fitSoon() { if (!fitPending) fitPending = requestAnimationFrame(() => { fitPending = 0; fit(); }); }
  function fit() {
    const vw = window.innerWidth, vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const land = vw > vh * 1.15 && vw >= 500;
    document.body.classList.toggle('land', land);
    document.body.classList.toggle('short', land && vh < 520);
    const table = $('table');
    if (!table || !table.offsetParent) return;
    const cs = getComputedStyle(table);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const gap = parseFloat(cs.rowGap) || 6;
    const tw = table.clientWidth - padX, th = table.clientHeight - padY;
    const f = S.frame;
    // 場の置き場所の数は 8・12・16… の段階で決める（1枚増えるたびに並びが変わらないように）
    const used = f ? Math.max(8, f.slots.length) : 8;
    const nslots = used <= 8 ? 8 : Math.ceil(used / 4) * 4;
    const infoH = $('info').offsetHeight || 38;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let best = null;
    const capw = land ? clamp(tw * 0.3, 150, 360) : 0;
    const cwid = land ? tw - capw - 12 : tw;
    for (const rows of [2, 3, 4]) {
      const cols = Math.ceil(nslots / rows);
      const fwW = cwid / (cols * 1.16 + 1.38);
      for (let cw = 26; cw <= 100; cw++) {
        const hov = Math.min(0.05, (cwid / cw - 8) / 7);
        if (hov < -0.32) break;
        const ow = clamp(cw * 0.48, 14, 30);
        // 横長: 取り札は左の列（上が相手・下が自分）。自分の取り札は手札と同じ高さの枠に、高さがあれば 2×2、なければ1列
        const handH0 = cw * 1.78, two = handH0 >= 150;
        const mw = land ? clamp(two ? Math.min((handH0 - 56) / 3.2, capw / 6) : Math.min((handH0 - 38) / 1.6, capw / 7.5), 14, cw * 0.8) : clamp(cw * 0.52, 16, 34);
        const obarH = Math.max(26, ow * 1.6);
        const capsH = land ? 0 : 2 * (mw * 1.6 + 16) + 22 + gap; // 取り札2段と自分の帯
        // 横長: 自分の取り札は手札と同じ行。取り札の方が高ければ、その分だけ行が高くなる
        const mcapsH = land ? (two ? 2 * (mw * 1.6 + 16) : mw * 1.6 + 16) + 22 : 0;
        const handH = Math.max(cw * 1.78, mcapsH);
        const rest = th - obarH - capsH - infoH - handH - gap * (land ? 3 : 5);
        const fwH = rest / (rows * 1.6 + (rows - 1) * 0.14);
        const fw = Math.min(fwW, fwH, 112);
        if (fw < cw * 0.85) continue;
        // 大きいほどよい。重ねた手札・場の札が手札より極端に大きいのは少し減点
        const score = Math.min(fw, cw * 1.3) + cw * 1.15 + (hov < 0 ? hov * cw * 1.2 : 0) - (rows - 2) * 2;
        if (!best || score > best.score) best = { cw, fw, rows, cols, hov, mw, ow, score, two };
      }
    }
    if (!best) best = { cw: 26, fw: 26, rows: 3, cols: Math.ceil(nslots / 3), hov: -0.3, mw: 16, ow: 14 };
    const root = document.documentElement.style;
    root.setProperty('--cw', Math.floor(best.cw) + 'px');
    root.setProperty('--fw', Math.floor(best.fw) + 'px');
    root.setProperty('--mw', Math.floor(best.mw) + 'px');
    root.setProperty('--ow', Math.floor(best.ow) + 'px');
    root.setProperty('--hov', best.hov.toFixed(3));
    table.style.setProperty('--fcols', best.cols);
    if (S.fieldCap !== best.rows * best.cols) { S.fieldCap = best.rows * best.cols; if (S.frame) renderField(); }
    if (land !== S.wasLand) { S.wasLand = land; renderSideScore(); }
    if (land) table.style.setProperty('--capw', Math.round(capw) + 'px');
    document.body.classList.toggle('caps1', land && !best.two);
  }

  // ------------------------------------------------------------------ タブ（対局・ルール・AI）
  function showTab(t) {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    $('view-play').hidden = t !== 'play';
    $('view-rules').hidden = t !== 'rules';
    $('view-ai').hidden = t !== 'ai';
    if (t === 'rules') renderRules();
    if (t === 'ai') renderAIPage();
    if (t === 'play') fitSoon();
  }
  function docTabs(view, key, tabs, draw) {
    const sec = $(view);
    sec.innerHTML = `<div class="doctabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-k="${k}" aria-selected="${k === key}">${l}</button>`).join('')}</div><div class="dbody"></div>`;
    sec.querySelector('.dbody').innerHTML = draw(key);
    sec.querySelector('.doctabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      sec.querySelectorAll('.doctabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      sec.querySelector('.dbody').innerHTML = draw(b.dataset.k);
      sec.scrollTop = 0;
    });
  }
  const mini = cs => cs.map(plainCard).join('');
  function renderRules() {
    docTabs('view-rules', 'flow', [['flow', '遊び方'], ['yaku', '役と点'], ['cards', '48枚の札'], ['detail', '細かいルール']], k => {
      if (k === 'flow') return `<div class="dcard"><h3>こいこいの流れ</h3>
        <ul><li>2人で遊びます。1か月に1局、ふつうは<b>12か月</b>（6か月・3か月も選べます）。合計点の多い方が勝ち。</li>
        <li>手札8枚ずつ、場に8枚、残り24枚が山札。<b>親</b>から交互に打ちます。</li>
        <li>自分の番: ①手札から1枚出す → 場に<b>同じ月</b>の札があれば2枚とも取る（なければ場に置く）。②山札を1枚めくって、同じように取る。</li>
        <li>場に同じ月が2枚あるときはどちらを取るか選びます。3枚あれば4枚まとめて取れます。</li>
        <li>取った札で<b>役</b>ができたら、<b>勝負</b>（ここで上がって点をもらう）か<b>こいこい</b>（続けてもっと役を作る）かを選びます。</li>
        <li>こいこいしたあと、先に相手が役を作って勝負すると、こいこいした人は0点、相手の点は2倍になります（こいこい返し）。</li>
        <li>だれも上がらないまま手札がなくなったら「流れ」で0点。親はそのまま。</li>
        <li>上がった人が次の月の親になります。</li></ul></div>
        <div class="dcard"><h3>この画面の操作</h3><ul>
        <li>手札をタップすると浮き上がり、取れる場の札が光ります（ほかは暗くなります）。光っている札をタップすると取ります。合う札がなければ「置く」かもう一度タップ。</li>
        <li>めくった札が2枚と合うときは、どちらを取るかタップします。</li>
        <li>「AI補助」をオンにすると、勝ちの見込みと「おすすめ」の札が出ます。「ヒント」は一度だけおすすめを見せます。</li>
        <li>キーボード: 1〜8 で手札を選ぶ、K でこいこい、S で勝負、Esc で選び直し。</li></ul></div>`;
      if (k === 'yaku') {
        const Y = (name, pts, cs, note) => `<div class="yrow"><b>${name}</b><span class="p">${pts}</span><div class="cs">${mini(cs)}</div>${note ? `<small>${note}</small>` : ''}</div>`;
        return `<div class="dcard"><h3>役と点</h3><div class="ytab">
          ${Y('五光', '10点', [0, 8, 28, 40, 44], '光札5枚すべて')}
          ${Y('四光', '8点', [0, 8, 28, 44], '柳（雨）以外の光4枚')}
          ${Y('雨四光', '7点', [40, 0, 8, 28], '柳（雨）を含む光4枚')}
          ${Y('三光', '5点', [0, 8, 28], '柳（雨）以外の光3枚')}
          ${Y('花見で一杯', '5点', [8, 32], '桜に幕＋菊に盃')}
          ${Y('月見で一杯', '5点', [28, 32], '芒に月＋菊に盃')}
          ${Y('猪鹿蝶', '5点', [24, 36, 20], '萩に猪・紅葉に鹿・牡丹に蝶')}
          ${Y('赤短', '5点', [1, 5, 9], '字の書かれた赤い短冊3枚')}
          ${Y('青短', '5点', [21, 33, 37], '青い短冊3枚')}
          ${Y('赤短・青短の重複', '10点', [1, 5, 9, 21, 33, 37], '6枚そろうと一つの役として10点')}
          ${Y('タネ', '1点〜', [4, 12, 16, 29, 41], 'タネ5枚で1点、1枚ふえるごとに+1')}
          ${Y('タン', '1点〜', [13, 17, 25, 42, 1], 'タン5枚で1点、1枚ふえるごとに+1')}
          ${Y('カス', '1点〜', [2, 6, 10, 14, 18, 22, 26, 30, 34, 38], 'カス10枚で1点、1枚ふえるごとに+1（菊に盃もカスに数える）')}
          ${Y('手四・くっつき', '6点', [0, 1, 2, 3], '配られた手札に同じ月4枚（手四）、または同じ月2枚が4組（くっつき）')}
        </div><p class="hint">役は重ねて数えます（例: 猪鹿蝶とタネは両方）。勝負したときの点が<b>7点以上なら2倍</b>、相手がこいこいしていたら<b>さらに2倍</b>。</p></div>`;
      }
      if (k === 'cards') {
        let h = '<div class="dcard"><h3>48枚の札（12か月×4枚）</h3><p class="hint">左上が月、右下の印が種類（光・種＝タネ・短＝タン・印なし＝カス）。設定で印を消せます。</p><div class="mtab">';
        for (let m = 0; m < 12; m++) h += `<div class="mrow"><b>${MONTH_NUM[m]}　${MONTHS[m]}</b><div class="cs">${mini([m * 4, m * 4 + 1, m * 4 + 2, m * 4 + 3])}</div></div>`;
        return h + '</div></div>';
      }
      return `<div class="dcard"><h3>このサイトで採用した細かいルール</h3><ul>
        <li>配り方: 親が子・場・親の順に4枚ずつ2回。場に同じ月が4枚、または同じ月2枚が4組配られたら配り直し。</li>
        <li>手四・くっつき（配られた手札）: 6点ですぐ上がり（設定で切り替え）。</li>
        <li>役ができた（点が増えた）ときだけ、こいこいか勝負かを選べます。こいこいは何回でもできます。最後の1枚を打ったあとは勝負だけ。</li>
        <li>勝負の点: 役の合計。<b>7点以上は2倍</b>、<b>相手がこいこいしていたら2倍</b>（両方なら4倍）。どちらも設定で切り替え。</li>
        <li>花見で一杯・月見で一杯: あり（設定でなしにできます）。菊に盃はタネにもカスにも数えます（設定で切り替え）。</li>
        <li>赤短と青短の両方: 「赤短・青短の重複」10点。</li>
        <li>流れ（だれも上がらずに札が尽きた）: 0点で親はそのまま。設定の「親権」をオンにすると親が1点。</li>
        <li>最初の親はランダム（札を引いた早い月の人、と同じこと）。その後は上がった人が親。</li>
        <li>オンラインでは「待った」なし。相手が AI補助やヒントを使っているかは相手の名前の横に出ます。</li></ul>
        <p class="hint">こいこいは地方や遊ぶ人によってルールが少しずつ違います。ここでは一般によく遊ばれている形を標準にしました。</p></div>
        <div class="dcard"><h3>オンライン対戦の札の配り方</h3>
        <p>どちらかの端末が山札を作ると、その端末には相手の手札が全部わかってしまいます。そこで2台が<b>それぞれ秘密の鍵で札を暗号化して混ぜ合わせ</b>、どちらも山札の並びを知らない状態から配ります（「メンタルポーカー」と呼ばれる方法）。</p>
        <ul><li>自分の手札は、相手が自分の鍵をはずした値を送ってくれ、自分の鍵をはずして初めてわかります。中継サーバーを見ている人にもわかりません。</li>
        <li>場の札・めくる札は、2人の鍵がそろったときに開きます。出した札は、相手の端末が「本当に配られた札か」を確かめてから反映します。</li>
        <li>月の終わりに2人とも鍵を見せ合い、混ぜ方やすべてのやりとりにごまかしがなかったかを確かめます。食い違えば画面に知らせます。</li></ul></div>`;
    });
  }

  function renderAIPage() {
    const info = window.KOIKOI_AIINFO || {};
    docTabs('view-ai', 'how', [['how', 'しくみ'], ['level', '強さ'], ['gen', '世代の記録']], k => {
      if (k === 'how') return `<div class="dcard"><h3>AI が一から作った、花札の AI</h3>
        <p>この CPU は、人が作った攻略法や対局の記録を<b>一切使っていません</b>。AI（Claude）がルールと学習の仕組みを書き、CPU どうしの<b>自己対局だけ</b>で強くなりました。</p>
        <ul><li><b>見えている情報だけ</b>で考えます（自分の手札・場・お互いの取り札・残りの枚数・点差・残りの月）。相手の手札や山札の中身はのぞきません。</li>
        <li>小さなニューラルネットが「この手を打ったら、最後に<b>対局に勝つ見込み</b>はどれくらいか」を見積もります。実際に最後まで打った結果を目標に、何千万手も学びました（Deep Monte-Carlo という方法）。</li>
        <li>「勝負」したときの勝つ見込みは計算で正確に出せるので、こいこいするかどうかは「続けたときの見込み」とくらべて決めます。点差と残りの月数を見て、負けているときは攻め、勝っているときは守ります。</li>
        <li><b>最強</b>はネットの一番の手をそのまま打ちます。見えない札を何千通りも仮定して読む方法（最後まで打ってみる・1手先を読む）も試しましたが、今のネットより強くはならなかったので使っていません（「強さ」のページ）。ほかの段階は、ネットの見込みにゆらぎを入れて迷わせています。</li></ul></div>`;
      if (k === 'level') return `<div class="dcard"><h3>4段階の強さ</h3>${info.net ? `<p class="hint" style="margin-top:0">いまのネット: ${esc(info.net)}</p>` : ''}<div class="tbl"><table class="lv"><thead><tr><th>強さ</th><th>打ち方</th><th>基準の CPU との対戦（${info.months || 12}か月）</th></tr></thead><tbody>
        ${CPU_KEYS.map(k2 => `<tr><td><b>${CPU[k2].label}</b></td><td>${CPU[k2].desc}</td><td>${info.levels && info.levels[k2] ? esc(info.levels[k2]) : '測定中'}</td></tr>`).join('')}
        </tbody></table></div><p class="hint">基準の CPU: 「でたらめ」と「目の前の得点だけ」（取れる札で一番点の増える手を選び、こいこいはしない）。花札は運の要素が大きいので、強い CPU でも1局ごとには負けることがあります。</p></div>`;
      const gens = info.gens || [];
      return `<div class="dcard"><h3>世代ごとの強さ</h3>${gens.length ? `<div class="tbl"><table class="lv"><thead><tr><th>世代</th><th>自己対局の手</th><th>対 目の前の得点だけ</th><th>対 前の世代</th></tr></thead><tbody>${gens.map(g => `<tr><td>${g.gen}</td><td>${esc(g.samples)}</td><td>${esc(g.vsGreedy)}</td><td>${esc(g.vsPrev || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p>学習の記録はまだありません。</p>'}
        <p class="hint">勝率は12か月の対局を同じ配りで席を入れ替えて打ったもの。Elo は勝率から計算した強さの差（+200 でおよそ76%勝つ）。</p></div>
        ${(info.search || []).length ? `<div class="dcard"><h3>読み（探索）を足すと強くなるか</h3><div class="tbl"><table class="lv"><thead><tr><th>方法</th><th>結果</th></tr></thead><tbody>${info.search.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.vs)}</td></tr>`).join('')}</tbody></table></div><p class="hint">どれもネットだけと差がなかったので、最強はネットの一番の手をそのまま打ちます。</p></div>` : ''}`;
    });
  }

  // ------------------------------------------------------------------ 保存と再開
  function saveGame() {
    if (!S.match || !S.round) return;
    if (S.online) return; // オンラインは相手との状態で戻る
    const r = S.round;
    store.set('game', {
      cfg, seats: S.seats, me: S.me, reveal: S.reveal,
      match: { rules: S.match.rules, months: S.match.months, totals: S.match.totals, history: S.match.history, dealer: S.match.dealer, firstDealer: S.match.firstDealer },
      round: { dealer: r.dealer, hands: r.hands, field: r.field, deck: r.deck, caps: r.caps, turn: r.turn, phase: r.phase, pending: r.pending, koi: r.koi, score: r.score, decided: r.decided, result: r.result, plays: r.plays, log: r.log },
      slots: S.slots, log: S.log.map(e => Object.assign({}, e, { f: undefined })), snap0: S.snap0, ended: S.roundEnded === r,
    });
  }
  function loadGame(g) {
    const m = new K.Match({ rules: g.match.rules, dealer: g.match.firstDealer });
    Object.assign(m, { totals: g.match.totals, history: g.match.history, dealer: g.match.dealer });
    const r = new K.Round({ rules: g.match.rules, dealer: g.round.dealer });
    Object.assign(r, g.round);
    r.has = [new Uint8Array(48), new Uint8Array(48)];
    r.caps.forEach((cs, p) => cs.forEach(c => { r.has[p][c] = 1; }));
    m.round = r;
    S.match = m; S.round = r; S.seats = g.seats; S.me = g.me; S.reveal = g.reveal;
    S.slots = g.slots || r.field.slice(); S.log = g.log || [];
    // 振り返りの並びを、配った直後から記録をたどって作り直す
    S.snap0 = g.snap0 || null;
    if (S.snap0) { let f = S.snap0; for (const e of S.log) { const fs = framesFor(f, e); if (fs.length) f = fs[fs.length - 1].f; e.f = cloneFrame(f); } }
    S.roundEnded = g.ended ? r : null;
    S.sel = -1; S.busy = false; S.token++;
    S.frame = frameOf(r);
    render();
    if (r.phase === 'end') { if (!g.ended) onRoundEnd(); }
    else schedule();
  }

  // ------------------------------------------------------------------ オンライン
  // 山札は2人で「暗号の鍵」を出し合って混ぜる（mental poker）。どちらの端末も山札の並びと相手の手札を知らない。くわしくは README
  const ONLINE_OK = !!window.SSIHOnline && SSIHOnline.available();
  let NETC = null;
  let myName = store.get('name', '') || ('ゲスト' + Math.floor(Math.random() * 900 + 100));
  let roomCode = new URLSearchParams(location.search).get('room');
  const lobby = { months: 12, msg: '' };
  const aiFlags = () => (settings.wp ? 1 : 0) | (settings.best ? 2 : 0);
  const aiText = f => (f ? `AI補助あり（${[f & 1 ? '勝ちの見込み' : '', f & 2 ? 'おすすめ' : ''].filter(Boolean).join('・')}）` : 'AI補助なし');
  function aiTagHTML(f, hints) {
    const on = !!f || !!hints;
    return `<span class="aitag ${on ? 'on' : 'off'}" title="${aiText(f)}${hints ? `・ヒント${hints}回` : ''}">${f ? 'AI補助あり' : 'AI補助なし'}${hints ? `・ヒント${hints}` : ''}</span>`;
  }
  // オンラインの部分は online-koikoi.js に分ける（mp.js の山札の混ぜ方を使う）
  const OL = ONLINE_OK && window.KoikoiOnline ? window.KoikoiOnline({
    S, K, $, esc, store, lobby, roomCode, act, startRound, newMatch, render, renderInfo, renderBars, frameOf, setNote, schedule, onRoundEnd, oppResigned, toggleAI,
    aiFlags, aiTagHTML, getMyName: () => myName,
  }) : null;
  function leaveOnline() { if (OL) OL.leave(); S.online = null; }
  function openOnline() {
    if (!OL) {
      $('dlg-online').hidden = false;
      $('on-body').innerHTML = '<p>オンライン対戦は、このゲームを公開しているページ（http・https で開いたとき）で遊べます。ファイルを直接開いたときや、外部につなげない場所では使えません。</p>';
      return;
    }
    OL.open();
  }
  function onlineNextRound() { if (OL) OL.nextRound(); }
  function onLobbyClick(e) { if (e.target === $('dlg-online')) { $('dlg-online').hidden = true; return; } if (OL) OL.lobbyClick(e); }
  function requestRematch() { if (OL) OL.rematch(); }
  function claimWin() { if (OL) OL.claim(); }
  Object.defineProperty(window, '__kk', { get: () => ({ S, fit, act, newMatch, OL }) }); // 確かめ用

  // ------------------------------------------------------------------ はじめ
  document.body.insertAdjacentHTML('afterbegin', KC.sprite());
  bind();
  if (OL) { OL.init(); NETC = OL.net; }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSoon);
  const saved = store.get('game', null);
  if (OL && OL.resume()) { /* オンライン対局の途中に戻った */ }
  else if (saved && saved.round && saved.match) { try { loadGame(saved); } catch (e) { console.error(e); newMatch(cfg); } }
  else { newMatch(cfg); openNew(); }
  if (roomCode && OL) OL.open();
  fitSoon();
})();
