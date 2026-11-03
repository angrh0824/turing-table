// 全ゲーム共通の「動き」の部品（駒・札が滑る、つかんで置く、サイコロを転がす、得点がふわっと出る）
// ゲームのページでは app.js より先に <script src="../common/motion.js"></script> を読み込む。依存なし
// 動きを減らす設定（prefers-reduced-motion）・設定の「アニメーション オフ」（localStorage 'tt-motion' = '0'）・裏のタブのときは、
// どれも一瞬で終わる（返す Promise もすぐ解決する）。なので、ゲームの進行は動きの完了を待っても止まらない
// 見本はルートの motion-demo/（公開しない）。使い方は CONVENTIONS.md §3「動き」
(function () {
  'use strict';
  const KEY = 'tt-motion';
  const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const read = () => { try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; } };
  let wanted = read();
  const on = () => wanted && !(mq && mq.matches) && !document.hidden;
  const EASE = { out: 'cubic-bezier(.2,.8,.2,1)', inOut: 'cubic-bezier(.6,0,.3,1)', back: 'cubic-bezier(.3,1.5,.5,1)' };
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  // 動いているもの（finish() で全部その場で終わらせる。新しい操作が来たときや、タブを隠したとき）
  const anims = new Set(), tweens = new Set();
  // 画面が描かれていないのに「見えている」扱いのとき（アプリの中のプレビューなど）は、時間が進まず終わらないことがある。
  // 動きの長さ＋0.26秒で打ち切って、待っているゲームが止まらないようにする
  const track = a => {
    anims.add(a);
    let end = 0;
    try { end = a.effect.getComputedTiming().endTime; } catch (e) { /* 長さが分からなければ 0.6秒 */ }
    const cut = setTimeout(() => { if (anims.has(a)) { try { a.finish(); } catch (e) { a.cancel(); } } }, (Number.isFinite(end) && end > 0 ? end : 600) + 260);
    return a.finished.then(() => {}, () => {}).then(() => { clearTimeout(cut); anims.delete(a); });
  };
  function finish() {
    anims.forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } });
    tweens.forEach(j => j.end());
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); });
  window.addEventListener('storage', e => { if (e.key === KEY) wanted = read(); });

  const CSS = `
.tt-dragging{opacity:.35!important}
.tt-ghost *,.tt-peek *{pointer-events:none!important}
.tt-ghost{position:fixed!important;margin:0!important;pointer-events:none!important;z-index:9999!important;filter:drop-shadow(0 10px 14px rgba(0,0,0,.35));will-change:left,top}
.tt-over{outline:3px solid var(--tt-over,rgba(255,196,64,.95))!important;outline-offset:-3px}
.tt-die{--s:var(--tt-die-size,40px);display:inline-block;width:var(--s);height:var(--s);perspective:calc(var(--s)*6)}
.tt-die>.c{position:relative;width:100%;height:100%;transform-style:preserve-3d}
.tt-die .f{position:absolute;inset:0;box-sizing:border-box;border-radius:18%;padding:13%;display:grid;grid-template:repeat(3,1fr)/repeat(3,1fr);backface-visibility:hidden;
  background:var(--tt-die-bg,#fbf8f1);box-shadow:inset 0 0 0 1px var(--tt-die-edge,rgba(0,0,0,.2)),inset 0 calc(var(--s)*-.06) calc(var(--s)*.12) rgba(0,0,0,.1)}
.tt-die .k{position:absolute;inset:1%;border-radius:14%;background:var(--tt-die-bg,#fbf8f1);filter:brightness(.82)}
.tt-die .k2{transform:rotateY(90deg)}
.tt-die .k3{transform:rotateX(90deg)}
.tt-die .f i{width:64%;height:64%;margin:auto;border-radius:50%;background:var(--tt-die-pip,#1d1b17)}
.tt-die .f1 i{width:86%;height:86%;background:var(--tt-die-pip1,var(--tt-die-pip,#1d1b17))}
.tt-die .f1{transform:translateZ(calc(var(--s)/2))}
.tt-die .f6{transform:rotateY(180deg) translateZ(calc(var(--s)/2))}
.tt-die .f2{transform:rotateY(90deg) translateZ(calc(var(--s)/2))}
.tt-die .f5{transform:rotateY(-90deg) translateZ(calc(var(--s)/2))}
.tt-die .f3{transform:rotateX(90deg) translateZ(calc(var(--s)/2))}
.tt-die .f4{transform:rotateX(-90deg) translateZ(calc(var(--s)/2))}
.tt-float{position:fixed;z-index:9999;pointer-events:none;white-space:nowrap;font-weight:700;color:var(--tt-float,currentColor);text-shadow:0 1px 3px rgba(0,0,0,.35)}`;
  function style() {
    if (document.getElementById('tt-motion-css')) return;
    const s = document.createElement('style');
    s.id = 'tt-motion-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  if (document.head) style(); else document.addEventListener('DOMContentLoaded', style);

  const rectOf = x => (x instanceof Element ? x.getBoundingClientRect() : x);
  const still = r => !r || (!r.width && !r.height);

  // 動いている間だけ、ほかの駒・札の上に出す（元の指定は戻す）
  function raise(el) {
    const s = el.style, z = s.zIndex, p = s.position;
    s.zIndex = '60';
    if (getComputedStyle(el).position === 'static') s.position = 'relative';
    return () => { s.zIndex = z; s.position = p; };
  }

  // el を、from（要素か DOMRect）の場所から今の場所へ滑らせる。HTML の要素だけ（SVG の中の駒は tween で自分で動かす）
  // o: { ms, arc（弧を描いて少し持ち上がる）, scale: false（大きさは変えない）, delay, ease }
  function fly(el, from, o = {}) {
    if (!on() || !el || !from) return Promise.resolve();
    const a = rectOf(from), b = el.getBoundingClientRect();
    if (still(a) || still(b)) return Promise.resolve();
    const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const sx = o.scale === false ? 1 : a.width / b.width, sy = o.scale === false ? 1 : a.height / b.height;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return Promise.resolve();
    const dist = Math.hypot(dx, dy);
    const kf = [{ translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}` }];
    if (o.arc) {
      const lift = Math.min(60, 12 + dist * 0.2);
      kf.push({ translate: `${dx / 2}px ${dy / 2 - lift}px`, scale: `${(sx + 1) / 2 * 1.08} ${(sy + 1) / 2 * 1.08}`, offset: 0.5 });
    }
    kf.push({ translate: '0px 0px', scale: '1 1' });
    const ms = o.ms || Math.round(Math.min(420, 160 + dist * 0.6));
    const undo = raise(el);
    return track(el.animate(kf, { duration: ms, delay: o.delay || 0, easing: o.ease || EASE.out, fill: 'backwards' })).then(undo);
  }

  // 新しく出てきたもの（配られた札・置いた石）をふわっと出す
  function enter(el, o = {}) {
    if (!on() || !el) return Promise.resolve();
    return track(el.animate([{ opacity: 0, scale: o.from || 0.85 }, { opacity: 1, scale: 1 }],
      { duration: o.ms || 200, delay: o.delay || 0, easing: EASE.out, fill: 'backwards' }));
  }

  // 消えるもの（取られた駒など）を縮めて消す。描き直す前に await する（最大 0.18秒）
  function vanish(el, o = {}) {
    if (!on() || !el) return Promise.resolve();
    return track(el.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.6 }],
      { duration: o.ms || 180, easing: EASE.inOut, fill: 'forwards' }));
  }

  // root の中の [data-key] の要素を、描き直し（mutate）の前後で同じ key どうし結んで滑らせる。新しい key はふわっと出す
  // o: { ms, arc, stagger（1つごとの遅れ ms）, enter: false }
  function flip(root, mutate, o = {}) {
    if (!on()) { mutate(); return Promise.resolve(); }
    const before = new Map();
    root.querySelectorAll('[data-key]').forEach(el => before.set(el.dataset.key, el.getBoundingClientRect()));
    mutate();
    const jobs = [];
    let n = 0;
    root.querySelectorAll('[data-key]').forEach(el => {
      const r = before.get(el.dataset.key);
      const delay = o.stagger ? o.stagger * n++ : 0;
      if (r) jobs.push(fly(el, r, { ms: o.ms, arc: o.arc, delay }));
      else if (o.enter !== false) jobs.push(enter(el, { delay }));
    });
    return Promise.all(jobs).then(() => {});
  }

  // 自分で動かす（SVG の駒・canvas・数字が増えていく など）。step(t) を 0→1 で呼ぶ。動かないときは step(1) だけ
  function tween(ms, step, o = {}) {
    if (!on() || !(ms > 0)) { step(1); return Promise.resolve(); }
    const ease = typeof o.ease === 'function' ? o.ease : easeOut;
    return new Promise(res => {
      const t0 = performance.now();
      const cut = setTimeout(() => job.end(), ms + 260);   // 描かれず requestAnimationFrame が来ないときの打ち切り
      const job = { done: false, end() { if (job.done) return; job.done = true; clearTimeout(cut); tweens.delete(job); step(1); res(); } };
      tweens.add(job);
      const frame = now => {
        if (job.done) return;
        const t = (now - t0) / ms;
        if (t >= 1) { job.end(); return; }
        step(ease(Math.max(0, t)));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  // 小さな強調。kind: 'land'（置いたとき）, 'shake'（置けない）, 'glow'（役・王手など）
  function pop(el, kind = 'land') {
    if (!on() || !el) return Promise.resolve();
    const K = {
      land: [[{ scale: 1.14 }, { scale: 1 }], { duration: 220, easing: EASE.back }],
      shake: [[{ translate: '0 0' }, { translate: '-6px 0' }, { translate: '6px 0' }, { translate: '-4px 0' }, { translate: '3px 0' }, { translate: '0 0' }], { duration: 280 }],
      glow: [[{ filter: 'brightness(1)' }, { filter: 'brightness(1.5)' }, { filter: 'brightness(1)' }], { duration: 600, easing: EASE.inOut }],
    }[kind] || null;
    return K ? track(el.animate(K[0], K[1])) : Promise.resolve();
  }

  // 得点・役の名前などを、at（要素か DOMRect）の上にふわっと出して消す。text は文字のまま入れる
  function float(text, at, o = {}) {
    const r = rectOf(at);
    if (!on() || still(r)) return Promise.resolve();
    const s = document.createElement('span');
    s.className = 'tt-float';
    s.textContent = text;
    if (o.color) s.style.color = o.color;
    s.style.fontSize = (o.size || 18) + 'px';
    document.body.appendChild(s);
    const w = s.offsetWidth, h = s.offsetHeight;
    s.style.left = (r.left + r.width / 2 - w / 2) + 'px';
    s.style.top = (r.top + r.height / 2 - h / 2) + 'px';
    return track(s.animate([
      { opacity: 0, translate: '0 6px', scale: 0.8 },
      { opacity: 1, translate: '0 -8px', scale: 1, offset: 0.25 },
      { opacity: 1, translate: '0 -18px', offset: 0.7 },
      { opacity: 0, translate: '0 -30px' },
    ], { duration: o.ms || 1000, easing: 'ease-out' })).then(() => s.remove());
  }

  // ---------------------------------------------------------------- サイコロ（CSS の立方体）
  const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  const FACE = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };   // その目を正面に向ける rotateX・rotateY
  function build(el) {
    if (el._ttDie) return el._ttDie;
    style();
    el.classList.add('tt-die');
    const c = document.createElement('div');
    c.className = 'c';
    // 中の3枚（.k）は、転がっている間に角のすき間から中が透けて、面が紙のように見えないための芯
    c.innerHTML = '<div class="k"></div><div class="k k2"></div><div class="k k3"></div>' +
      [1, 2, 3, 4, 5, 6].map(v => `<div class="f f${v}">${PIPS[v].map(p => `<i style="grid-area:${Math.ceil(p / 3)}/${(p - 1) % 3 + 1}"></i>`).join('')}</div>`).join('');
    el.textContent = '';
    el.appendChild(c);
    el.setAttribute('role', 'img');
    el._ttDie = c;
    return c;
  }
  // el の中にサイコロを作って value の目まで転がす。o: { roll: false（転がさず置くだけ）, ms }
  // 大きさ・色は CSS 変数で: --tt-die-size, --tt-die-bg, --tt-die-pip, --tt-die-pip1（1の目）, --tt-die-edge
  function dice(el, value, o = {}) {
    const c = build(el);
    const v = Math.min(6, Math.max(1, value | 0));
    const [fx, fy] = FACE[v];
    // 傾き（rotateZ）は画面の上での回転なので先頭に置く。後ろに置くと、2〜5の目で横の面が細く見えてしまう
    const tilt = Math.round(Math.random() * 16 - 8);
    const end = `rotateZ(${tilt}deg) rotateX(${fx}deg) rotateY(${fy}deg)`;
    el.setAttribute('aria-label', `サイコロ ${v}`);
    c.style.transform = end;
    if (o.roll === false || !on()) return Promise.resolve();
    const spin = () => 360 * (1 + Math.floor(Math.random() * 2)) * (Math.random() < 0.5 ? -1 : 1);
    const start = `rotateZ(${tilt + Math.random() * 180 - 90}deg) rotateX(${fx + spin() + Math.random() * 90}deg) rotateY(${fy + spin() + Math.random() * 90}deg)`;
    const ms = o.ms || 700 + Math.round(Math.random() * 200);
    return Promise.all([
      track(c.animate([{ transform: start }, { transform: end }], { duration: ms, easing: 'cubic-bezier(.15,.65,.25,1)' })),
      track(el.animate([
        { translate: '0 -45%' }, { translate: '0 0', offset: 0.45 }, { translate: '0 -14%', offset: 0.65 },
        { translate: '0 0', offset: 0.82 }, { translate: '0 -3%', offset: 0.91 }, { translate: '0 0' },
      ], { duration: ms, easing: 'ease-in' })),
    ]).then(() => {});
  }

  // ---------------------------------------------------------------- つかんで置く（タップ → タップ はそのまま使える）
  // 指やマウスで少し動かしたら「つかんだ」になり、離した所に置く。動かさずに離したらふつうのタップ（ゲームの click がそのまま動く）
  // drag(root, {
  //   pick(target, e)  → つかむ要素（root の中の駒・札。つかめないなら null）
  //   start(el)        → つかんだとき（ふつうは、タップで選んだときと同じく行き先を光らせる）
  //   target(x, y, el) → 置き先の要素か null（省略時は指の下の [data-drop]）
  //   drop(el, to, at) → 離したとき。false を返したら置けなかった扱いで元へ戻る。at は離した所の DOMRect（fly(新しい要素, at) で吸い付かせる）
  //   cancel(el)       → 置き先の外で離したとき（選択を解く など）
  //   ghost(el)        → 指についてくる見た目（省略時は el の見た目の写し。大きさを付けなければ el と同じ大きさ）
  // })  → 外すときに呼ぶ関数を返す
  // 写しは body に置くので、親に頼る CSS が外れないよう見た目を書き写す（SVG の中の図形は、見た目に関わるものだけ。札の絵柄が細かくても速い）
  const SVGP = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'display',
    'visibility', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'paint-order', 'filter', 'clip-path', 'mask'];
  function copyLook(src, dst) {
    const cs = getComputedStyle(src);
    const list = src instanceof SVGElement && !(src instanceof SVGSVGElement) ? SVGP : cs;
    for (let i = 0; i < list.length; i++) dst.style.setProperty(list[i], cs.getPropertyValue(list[i]));
    for (let i = 0; i < src.children.length && i < dst.children.length; i++) copyLook(src.children[i], dst.children[i]);
  }
  function ghostOf(el) {
    const r = el.getBoundingClientRect();
    let g;
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) {
      // SVG の中の駒は、それだけを小さな <svg> に包んで写す
      const b = el.getBBox();
      g = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      g.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
      const c = el.cloneNode(true);
      c.removeAttribute('transform');
      g.appendChild(c);
      copyLook(el, c);
      c.style.transform = 'none';
    } else {
      g = el.cloneNode(true);
      copyLook(el, g);
      g.removeAttribute('id');
    }
    Object.assign(g.style, { transform: 'none', translate: 'none', rotate: 'none', scale: 'none', transition: 'none', animation: 'none', opacity: '1', width: r.width + 'px', height: r.height + 'px', left: r.left + 'px', top: r.top + 'px' });
    return g;
  }
  // つかんで離したあと・長押しのあとの click は、タップとして扱わない
  function eatClick() {
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', eat, true);
    setTimeout(() => window.removeEventListener('click', eat, true), 60);
  }
  let peeking = null;   // 長押しで大きく見ている写し（その間はつかまない）
  function drag(root, o) {
    let st = null;
    root.style.touchAction = 'pinch-zoom';   // 1本指はつかむのに使い、2本指の拡大・移動は残す
    root.style.webkitUserSelect = root.style.userSelect = 'none';
    const findTarget = (x, y, el) => {
      if (o.target) return o.target(x, y, el);
      const hit = document.elementFromPoint(x, y);
      return hit && hit.closest('[data-drop]');
    };
    const setOver = t => {
      if (st.over === t) return;
      if (st.over) st.over.classList.remove('tt-over');
      st.over = t;
      if (t) t.classList.add('tt-over');
    };
    const place = (x, y) => {
      const lift = st.touch ? st.h * 0.6 : 0;   // 指で隠れないように、指より少し上に出す
      st.g.style.left = (x - st.ox - st.w / 2) + 'px';
      st.g.style.top = (y - st.oy - st.h / 2 - lift) + 'px';
    };
    const begin = e => {
      finish();
      const r = st.el.getBoundingClientRect();
      st.w = r.width; st.h = r.height;
      st.ox = st.touch ? 0 : st.x0 - (r.left + r.width / 2);
      st.oy = st.touch ? 0 : st.y0 - (r.top + r.height / 2);
      st.g = o.ghost ? o.ghost(st.el) : ghostOf(st.el);
      if (!st.g.style.width) st.g.style.width = st.w + 'px';   // ghost(el) が大きさを付けていなければ el と同じ大きさ
      if (!st.g.style.height) st.g.style.height = st.h + 'px';
      st.g.classList.add('tt-ghost');
      document.body.appendChild(st.g);
      st.el.classList.add('tt-dragging');
      st.moved = true;
      if (o.start) o.start(st.el);
      place(e.clientX, e.clientY);
      if (on()) track(st.g.animate([{ scale: 1 }, { scale: 1.1 }], { duration: 120, fill: 'forwards' }));
    };
    const move = e => {
      if (!st || e.pointerId !== st.id || peeking) return;
      if (!st.moved) {
        if (Math.hypot(e.clientX - st.x0, e.clientY - st.y0) < (st.touch ? 8 : 4)) return;
        begin(e);
      }
      e.preventDefault();
      place(e.clientX, e.clientY);
      const gr = st.g.getBoundingClientRect();
      const t = findTarget(st.touch ? gr.left + gr.width / 2 : e.clientX, st.touch ? gr.top + gr.height / 2 : e.clientY, st.el);
      setOver(t || null);
    };
    const quit = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointerdown', second, true);
    };
    const back = s => {
      if (!on()) { s.g.remove(); return; }
      const a = s.g.getBoundingClientRect(), b = s.el.getBoundingClientRect();
      track(s.g.animate([{ translate: '0 0' }, { translate: `${b.left - a.left + (a.width - b.width) / 2}px ${b.top - a.top + (a.height - b.height) / 2}px` }],
        { duration: 200, easing: EASE.out, fill: 'forwards' })).then(() => { s.g.remove(); s.el.classList.remove('tt-dragging'); });
    };
    const done = ok => {
      quit();
      const s = st;
      st = null;
      if (!s || !s.moved) return;
      eatClick();
      const to = ok ? s.over : null;
      if (s.over) s.over.classList.remove('tt-over');
      const at = s.g.getBoundingClientRect();
      if (to && o.drop(s.el, to, at) !== false) { s.g.remove(); s.el.classList.remove('tt-dragging'); return; }
      back(s);
      if (!s.g.isConnected) s.el.classList.remove('tt-dragging');
      if (o.cancel) o.cancel(s.el);
    };
    const up = e => { if (st && e.pointerId === st.id) done(true); };
    const cancel = e => { if (st && e.pointerId === st.id) done(false); };
    const second = e => { if (st && e.pointerId !== st.id) done(false); };   // 2本目の指 = 拡大しようとしている。つかむのをやめて元へ
    const down = e => {
      if (st || e.button > 0 || !e.isPrimary) return;
      const el = o.pick(e.target, e);
      if (!el) return;
      st = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, touch: e.pointerType !== 'mouse', moved: false, over: null };
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('pointerdown', second, true);
    };
    root.addEventListener('pointerdown', down);
    return () => { root.removeEventListener('pointerdown', down); quit(); };
  }

  // ---------------------------------------------------------------- 長押しで大きく見る（スマホで小さな札・駒・取り札を確かめる）
  // 押したまま約0.4秒で、その要素の写しが画面の真ん中に大きく出る。指を離すと閉じる。途中で動かしたら取りやめ（つかむほうに任せる）
  // peek(root, { pick(target, e) → 大きく見せる要素か null, ms（長押しの長さ。既定 420）, show(el) → 見せる要素（省略時は el の写し） })
  function peek(root, o) {
    let p = null;
    root.style.webkitTouchCallout = 'none';
    root.style.webkitUserSelect = root.style.userSelect = 'none';
    root.addEventListener('contextmenu', e => { if (p || peeking) e.preventDefault(); });
    const stop = () => {
      if (!p) return;
      clearTimeout(p.t);
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      p = null;
    };
    const close = () => {
      if (!peeking) return;
      const v = peeking;
      peeking = null;
      eatClick();
      if (!on()) { v.remove(); return; }
      track(v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' })).then(() => v.remove());
    };
    const mv = e => { if (p && e.pointerId === p.id && !peeking && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) stop(); };
    const up = e => { if (p && e.pointerId === p.id) { stop(); close(); } };
    const open = el => {
      const r = el.getBoundingClientRect();
      if (still(r)) return;
      const g = o.show ? o.show(el) : ghostOf(el);
      const k = Math.min(innerWidth * 0.8 / r.width, innerHeight * 0.6 / r.height, o.scale || 4);
      const v = document.createElement('div');
      v.className = 'tt-peek';
      v.style.cssText = 'position:fixed;inset:0;z-index:9998;pointer-events:none;background:rgba(0,0,0,.45);display:grid;place-items:center';
      Object.assign(g.style, { position: 'relative', left: 'auto', top: 'auto', margin: '0', scale: String(k), filter: 'drop-shadow(0 8px 24px rgba(0,0,0,.5))' });
      v.appendChild(g);
      document.body.appendChild(v);
      peeking = v;
      if (on()) {
        const b = g.getBoundingClientRect();
        track(g.animate([{ translate: `${r.left + r.width / 2 - (b.left + b.width / 2)}px ${r.top + r.height / 2 - (b.top + b.height / 2)}px`, scale: '1' }, { translate: '0 0', scale: String(k) }],
          { duration: 180, easing: EASE.out }));
        track(v.animate([{ background: 'rgba(0,0,0,0)' }, { background: 'rgba(0,0,0,.45)' }], { duration: 180 }));
      }
    };
    root.addEventListener('pointerdown', e => {
      if (p || peeking || !e.isPrimary || e.button > 0) return;
      const el = o.pick(e.target, e);
      if (!el) return;
      p = { id: e.pointerId, x: e.clientX, y: e.clientY, t: setTimeout(() => { if (p) open(el); }, o.ms || 420) };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  window.TTMotion = {
    get on() { return on(); },
    set(v) { wanted = !!v; try { localStorage.setItem(KEY, wanted ? '1' : '0'); } catch (e) { /* 覚えられないときはこのページだけ */ } if (!wanted) finish(); },
    EASE, fly, enter, vanish, flip, tween, pop, float, dice, drag, peek, finish,
  };
})();
