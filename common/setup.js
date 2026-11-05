// 全ゲーム共通の「新しい対局」（#dlg-new）を気持ちよくする部品
// - いちばん下に「始める」を固定し、その上に「勝てば +XP」と上乗せ（本日初勝利・連勝・ピックアップ）・取れる実績を出す
// - CPU の強さのカードに、強さの色・勝ったときの XP・撃破済みの王冠・次の挑戦（はじめての人には おすすめ）を足す
// - 選んだときの手ごたえ（はずむ・小さな音・強い CPU は火花）、出てきた項目はふわっと出す
// - キーボード: ← → ↑ ↓ で選ぶ、1〜5 で CPU の強さ、選んであるものの上で Enter を押すと始める
// - 「始める」を押したら「あなた VS CPU」の演出（約1秒。触るのは止めない）
// ゲームのページでは juice.js のあとに <script src="../common/setup.js"></script>。各ゲームの作り（#dlg-new の .dialog・#ng-mode・#ng-cpu・#ng-start、
// 項目の .lab と .seg・選んでいるボタンの aria-pressed="true"）をそのまま読むだけなので、ゲームの側は何もしなくてよい
(function () {
  'use strict';
  // AI補助（評価・おすすめの手などの表示）は、さいしょは出さない。「AI補助」ボタンを押したら出る（押して付けたものは覚える）
  // ユーザーから「AI補助はデフォルトはなしで、ボタン押したら出てくるように」。ゲームが設定 '<slug>-settings' を読む前（このファイルは app.js より先）に、
  // 各ゲームの AI補助の項目（app.js の aiOn() が見ているもの）を一度だけオフにする
  const AIK = {
    gungi: ['showEval', 'arrow'], reversi: ['showEval', 'best', 'nums'], renju: ['showEval', 'best', 'threat'], koikoi: ['wp', 'best'], holdem: ['eq', 'rec'],
    shogi: ['showEval', 'arrow'], chess: ['showEval', 'arrow'], mahjong: ['showEval', 'showWaits'], go: ['showEval', 'cands', 'own'], backgammon: ['showEval', 'arrow'],
    daifugo: ['showProb', 'showBest'], xiangqi: ['showEval', 'arrow'], yacht: ['ai'], amazons: ['showEval', 'terr', 'best'], gunjin: ['showEval', 'arrow'],
  };
  const PFX = slug => (slug === 'backgammon' ? 'bg-' : slug + '-');   // ゲームが localStorage に使う頭の文字（バックギャモンだけ bg-）
  (() => {
    const slug = (window.TTJuice || {}).here, keys = AIK[slug];
    if (!keys) return;
    try {
      const flag = 'tt-aioff1:' + slug, k = PFX(slug) + 'settings';
      if (localStorage.getItem(flag)) return;
      const v = JSON.parse(localStorage.getItem(k) || '{}') || {};
      keys.forEach(x => { v[x] = false; });
      localStorage.setItem(k, JSON.stringify(v));
      localStorage.setItem(flag, '1');
    } catch (e) { /* 覚えられないときは、ゲームのいつもの設定のまま */ }
  })();
  const dlg = document.getElementById('dlg-new');
  const box = dlg && dlg.querySelector('.dialog');
  const start = document.getElementById('ng-start');
  if (!box || !start) return;
  const J = window.TTJuice || null;
  const motion = () => (J ? J.motion : !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches));
  const anim = (el, kf, o) => { if (!motion() || !el || !el.animate) return null; try { return el.animate(kf, o); } catch (e) { return null; } };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shown = el => !!el && el.getClientRects().length > 0;
  const starsOf = b => { const s = b && b.querySelector('.stars'); return s ? (s.textContent.match(/★/g) || []).length : 0; };
  const nameOf = b => { const n = b && b.querySelector('b'); return ((n || b || {}).textContent || '').trim(); };
  const LV = ['#8a8a8a', '#3fbf7f', '#4d9fff', '#f0b429', '#ff6a3d', '#c86bff'];   // ★の数 → 色
  const CROWN = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>';

  const CSS = `
#dlg-new.tts-under{visibility:hidden!important}
#dlg-new .tts-act{position:sticky;bottom:calc(-1*var(--tts-pb,0px));z-index:3;margin-bottom:calc(-1*var(--tts-pb,0px));padding-top:8px;padding-bottom:var(--tts-pb,0px);
  background:var(--tts-bg);box-shadow:0 -16px 14px -6px var(--tts-bg);flex-wrap:wrap}
.tts-dup{display:none!important}
.tts-sum{flex:1 0 100%;order:-1;display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-width:0;font-size:11.5px;line-height:1.3;color:var(--muted,#8a857a)}
.tts-c{padding:2px 9px;border-radius:999px;border:1px solid var(--line,rgba(127,127,127,.3));white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.tts-c .tts-s{color:var(--tts-lv);letter-spacing:-1px;margin-right:3px}
.tts-x{margin-left:auto;display:inline-flex;align-items:baseline;gap:4px;padding:3px 11px;border-radius:999px;font-weight:800;white-space:nowrap;color:#2b1700;
  background:linear-gradient(90deg,#ffe07a,#ffb347);box-shadow:0 0 14px -4px #ffb02e;font-variant-numeric:tabular-nums}
.tts-x b{font-size:14px}
.tts-b{font-size:10.5px;font-weight:700;color:#e2731b;white-space:nowrap}
.tts-u{font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid var(--rc);color:var(--rc);white-space:nowrap}
#ng-cpu>button{position:relative;overflow:hidden;transition:translate .15s,box-shadow .15s,background-color .15s,border-color .15s}
#ng-cpu>button::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--tts-lv);opacity:.9;pointer-events:none}
#ng-cpu>button[aria-pressed="true"]::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.16) 50%,transparent 65%);transform:translateX(-110%)}
.ttj-move #ng-cpu>button[aria-pressed="true"]::after{animation:tts-sweep 2.8s ease-in-out infinite}
@keyframes tts-sweep{0%,45%{transform:translateX(-110%)}100%{transform:translateX(110%)}}
@media (hover:hover){.ttj-move #ng-cpu>button:hover{translate:0 -2px;box-shadow:0 10px 20px -12px rgba(0,0,0,.55)}}
#dlg-new #ng-cpu.cards{grid-template-columns:repeat(auto-fit,minmax(56px,1fr))}
#ng-cpu>button small.tts-cl{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tts-m{display:flex;flex-wrap:wrap;align-items:center;gap:2px 4px;min-height:16px;margin-top:2px;font-size:10.5px;font-weight:800;color:var(--gold,#c9a24a);font-variant-numeric:tabular-nums;white-space:nowrap}
.tts-m svg{width:13px;height:13px;flex:none}
#dlg-new.tts-noxp .tts-m{display:none}
.tts-m .tts-n{padding:0 6px;border-radius:999px;font-size:9.5px;letter-spacing:.04em;color:#2b1700;background:linear-gradient(90deg,#ffd45a,#ff9a3c)}
.ttj-move .tts-m .tts-n{animation:tts-pulse 1.6s ease-in-out infinite}
@keyframes tts-pulse{50%{box-shadow:0 0 10px #ffb02e}}
.tts-ring{position:fixed;pointer-events:none;z-index:2147483300;border-radius:12px;border:2px solid var(--tts-lv,#ffd45a)}
.tts-vs{position:fixed;inset:0;z-index:2147483400;pointer-events:none;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:2vw;padding:0 4vw;color:#fff;
  font-family:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic",system-ui,sans-serif}
.tts-vs::before,.tts-vs::after{content:"";position:absolute;top:-10%;bottom:-10%;width:62%;z-index:-1}
.tts-vs::before{left:-8%;transform:skewX(-12deg);background:linear-gradient(90deg,rgba(10,14,30,.92),color-mix(in srgb,var(--tts-me) 55%,rgba(10,14,30,.9)))}
.tts-vs::after{right:-8%;transform:skewX(-12deg);background:linear-gradient(-90deg,rgba(30,8,8,.92),color-mix(in srgb,var(--tts-lv) 55%,rgba(30,8,8,.9)))}
.tts-vs .tts-side{display:grid;justify-items:center;gap:6px;text-align:center}
.tts-vs .tts-side b{font:800 clamp(22px,6.4vw,44px)/1.1 "Shippori Mincho B1","Hiragino Mincho ProN","Yu Mincho",serif;letter-spacing:.06em;text-shadow:0 3px 10px rgba(0,0,0,.6);white-space:nowrap}
.tts-vs .tts-side .tts-k{font-size:clamp(11px,2.8vw,15px);font-weight:800;letter-spacing:.3em;opacity:.8;margin-bottom:-2px}
.tts-vs .tts-side small{font-size:clamp(10px,2.6vw,15px);font-weight:700;opacity:.85;letter-spacing:.08em;white-space:nowrap}
.tts-vs .tts-st{color:var(--tts-lv);font-size:clamp(14px,3.4vw,22px);letter-spacing:1px;text-shadow:0 0 10px var(--tts-lv)}
.tts-vs .tts-vv{font:italic 900 clamp(54px,15vw,120px)/1 "Shippori Mincho B1",serif;color:transparent;-webkit-background-clip:text;background-clip:text;
  background-image:linear-gradient(180deg,#fff8d6,#ffd75e 45%,#df9612 55%,#ffe48a);filter:drop-shadow(0 4px 0 rgba(60,30,0,.6)) drop-shadow(0 0 18px rgba(255,190,50,.7))}
.tts-vs .tts-vx{position:absolute;left:50%;bottom:16%;transform:translateX(-50%);padding:5px 16px;border-radius:999px;font-weight:800;font-size:clamp(13px,3vw,16px);color:#2b1700;background:linear-gradient(90deg,#ffe07a,#ffb347);white-space:nowrap}
@media (max-width:480px){.tts-sum .tts-c{display:none}.tts-x{margin-left:0}.tts-m .tts-uu{display:none}}
/* 横向きのスマホ（高さが低い）: まとめは XP だけにして、ボタンと同じ行に */
@media (max-height:520px){.tts-sum{flex:1 1 0;order:0}.tts-sum .tts-c,.tts-sum .tts-b{display:none}.tts-x{margin-left:0}}`;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  // ---------------------------------------------------------------- 下に固定する欄（ゲームの .actions / .actions-row をそのまま使う）
  const act = start.parentElement;
  act.classList.add('tts-act');
  const sum = document.createElement('div');
  sum.className = 'tts-sum';
  sum.setAttribute('aria-live', 'polite');
  act.insertBefore(sum, act.firstChild);
  // 欄の地の色と、ダイアログの下の余白（固定する欄を下の端までのばすため）
  const bg = () => {
    const cs = getComputedStyle(box), c = cs.backgroundColor;
    box.style.setProperty('--tts-bg', c && c !== 'rgba(0, 0, 0, 0)' ? c : 'var(--surface, #1c1b17)');
    box.style.setProperty('--tts-pb', cs.paddingBottom);
  };
  window.addEventListener('resize', () => {
    if (dlg.hidden) return;
    bg();
    document.querySelectorAll('#ng-cpu small.tts-cl').forEach(e => e.classList.remove('tts-cl'));   // 向きを変えたら、説明を見せるかどうかはゲームの CSS で決め直す
    cards();
  });

  const cpuBox = () => document.getElementById('ng-cpu');
  const modeBtn = () => { const m = document.getElementById('ng-mode'); return m && m.querySelector('button[aria-pressed="true"]'); };
  // 選んでいる遊び方: online・watch（CPU どうしの観戦）・pvp / local（ふたり・みんなで1台）。data-v が無いゲームは文字で見る
  const modeV = () => {
    const b = modeBtn();
    if (!b) return '';
    const t = b.textContent;
    return b.dataset.v || (/オンライン/.test(t) ? 'online' : /観戦/.test(t) ? 'watch' : /ふたり|みんなで/.test(t) ? 'pvp' : '');
  };
  const online = () => modeV() === 'online';
  const watching = () => modeV() === 'watch';
  const cpuShown = () => shown(cpuBox()) && !online();   // CPU の強さを選べる（観戦の CPU も含む）
  const cpuOn = () => cpuShown() && !['watch', 'pvp', 'local'].includes(modeV());   // CPU と対局する（XP がもらえる）
  const cpuPick = () => { const c = cpuBox(); return c && c.querySelector('button[aria-pressed="true"]'); };
  // 1つだけ選ぶ欄（.seg と CPU のカード）。チェックの並び（.chips・.rules）は数えない
  const groups = () => [...box.querySelectorAll('.seg, #ng-cpu')].filter(shown);
  const gid = (g, i) => g.id || 'g' + i;

  function cards() {
    const c = cpuBox();
    if (!c) return;
    const off = J ? J.offer(0, false) : null;
    const top = off ? off.top : 0;
    const max = Math.max(0, ...[...c.children].map(starsOf));
    const rec = top >= 1 ? Math.min(top + 1, max) : off && off.n >= 3 && !off.w ? 1 : 2;   // 次の挑戦。まだ勝ったことがなければ ふつう（何度か負けていたら やさしい）
    for (const b of c.children) {
      const n = starsOf(b);
      b.style.setProperty('--tts-lv', LV[n] || LV[0]);
      const sm = b.querySelector('small');   // 説明はゲームが見せているときだけ3行までに（スマホで隠しているものは出さない）
      if (sm && !sm.classList.contains('tts-cl') && getComputedStyle(sm).display !== 'none') sm.classList.add('tts-cl');
      if (!J || b.querySelector('.tts-m')) continue;
      const o = J.offer(n, false);
      const done = n && n <= top, next = n === rec && top < max;
      const m = document.createElement('span');
      m.className = 'tts-m';
      m.innerHTML = `${done ? `<span title="撃破済み">${CROWN}</span>` : ''}<span>+${o.xp.toLocaleString()}<span class="tts-uu"> XP</span></span>${next ? `<span class="tts-n">${top >= 1 ? '挑戦' : 'おすすめ'}</span>` : ''}`;
      m.title = `勝てば +${o.xp.toLocaleString()} XP${done ? '（撃破済み）' : ''}`;
      if (getComputedStyle(b).textAlign === 'center') m.style.justifyContent = 'center';   // スマホの小さなカード（真ん中ぞろえ）
      b.appendChild(m);
    }
  }

  function summary() {
    const chips = [];
    const mb = modeBtn();
    if (mb) chips.push(`<span class="tts-c">${esc(nameOf(mb))}</span>`);
    for (const g of groups()) {
      if (g.id === 'ng-mode') continue;
      const b = g.querySelector('button[aria-pressed="true"]');
      if (!b) continue;
      if (g.id === 'ng-cpu') chips.push(`<span class="tts-c" style="--tts-lv:${LV[starsOf(b)]}"><span class="tts-s">${'★'.repeat(starsOf(b))}</span>${esc(nameOf(b))}</span>`);
      else if (chips.length < 4) chips.push(`<span class="tts-c">${esc(nameOf(b))}</span>`);
    }
    let x = '';
    if (J && (cpuOn() || online())) {
      const o = J.offer(online() ? 0 : starsOf(cpuPick()), online());
      x = `<span class="tts-x" title="運のボーナスで さらに ×2・×5 も">勝てば <b>+${o.xp.toLocaleString()}</b> XP</span>`;
      if (o.tags.length) x += `<span class="tts-b">${esc(o.tags.join('・'))}</span>`;
      const u = o.unlock[o.unlock.length - 1];
      if (u) x += `<span class="tts-u" style="--rc:${J.RAR[u.rar][1]}" title="勝てば実績「${esc(u.name)}」">実績 +${u.xp}</span>`;
    }
    sum.innerHTML = chips.join('') + x;
  }

  // ---------------------------------------------------------------- 選んだときの手ごたえ・出てきた項目
  let picked = new Map(), seenFields = new WeakSet(), opened = false;
  const ring = (b, color) => {
    if (!motion()) return;
    const r = b.getBoundingClientRect(), d = document.createElement('div');
    d.className = 'tts-ring';
    d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${getComputedStyle(b).borderRadius}`;
    if (color) d.style.setProperty('--tts-lv', color);
    document.body.appendChild(d);
    const a = anim(d, [{ opacity: 0.9, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.18)' }], { duration: 420, easing: 'ease-out' });
    if (a) a.finished.then(() => d.remove(), () => d.remove()); else d.remove();
    setTimeout(() => d.remove(), 700);
  };
  function feel() {
    groups().forEach((g, i) => {
      const b = g.querySelector('button[aria-pressed="true"]');
      const v = b ? (b.dataset.v || b.textContent) : '';
      const key = gid(g, i);
      if (opened && picked.has(key) && picked.get(key) !== v && b) {
        const n = g.id === 'ng-cpu' ? starsOf(b) : 0;
        anim(b, [{ scale: 0.9 }, { scale: 1.06, offset: 0.55 }, { scale: 1 }], { duration: 300, easing: 'ease-out' });
        ring(b, n ? LV[n] : null);
        if (J) {
          J.sfx.sel(n || [...g.children].indexOf(b));
          if (n >= 4) J.burst(b, { kind: n >= 5 ? 'star' : 'spark', n: n >= 5 ? 26 : 14, speed: 6, colors: n >= 5 ? [LV[5], '#fff', '#ffd45a'] : undefined });
        }
      }
      picked.set(key, v);
    });
    // 種類を変えて出てきた項目は、ふわっと出す
    for (const f of box.children) {
      if (!f.querySelector || !f.querySelector('.lab') || !shown(f)) continue;
      if (!seenFields.has(f)) { seenFields.add(f); if (opened) anim(f, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' }); }
    }
    for (const f of box.children) if (f.querySelector && f.querySelector('.lab') && !shown(f)) seenFields.delete(f);
  }

  // カードの中に説明が見えているときは、下の同じ説明（#ng-cpu-desc）を出さない
  function dup() {
    const d = document.getElementById('ng-cpu-desc'), p = cpuPick(), sm = p && p.querySelector('small');
    if (d) d.classList.toggle('tts-dup', !!sm && shown(sm) && sm.textContent.trim() === d.textContent.trim());
  }
  function refresh() {
    dlg.classList.toggle('tts-noxp', !cpuOn());   // 観戦・ふたりで: 勝っても XP は無いので、カードの +XP・王冠も出さない
    cards();
    dup();
    summary();
    feel();
  }
  const obs = new MutationObserver(() => {
    if (dlg.hidden) return;
    refresh();
    obs.takeRecords();   // ここで足したもので、もう一度呼ばれないように
  });
  obs.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'hidden', 'style', 'class'] });

  // 開いたとき: 項目を上から順に出し、選んである内容を覚え直す
  new MutationObserver(() => {
    if (dlg.hidden) { opened = false; return; }
    if (opened) return;
    bg();
    picked = new Map();
    seenFields = new WeakSet();
    refresh();
    obs.takeRecords();
    opened = true;
    let i = 0;
    for (const f of box.children) {
      if (!shown(f) || f === act) continue;
      anim(f, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 60 + i++ * 35, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    }
    anim(start, [{ scale: 1 }, { scale: 1.06 }, { scale: 1 }], { duration: 380, delay: 120 + i * 35, easing: 'ease-out' });
  }).observe(dlg, { attributes: true, attributeFilter: ['hidden'] });
  if (!dlg.hidden) { bg(); refresh(); opened = true; }

  // ---------------------------------------------------------------- キーボード
  // この部品が受けたキーは、ゲームの側のキー操作に渡さない（始めた直後の Enter でサイコロを振る、などを防ぐ）
  const eat = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  // マウスで選んだあとはフォーカスがページに戻るので、ページ全体で受ける（ダイアログが開いているときだけ）
  document.addEventListener('keydown', e => {
    if (dlg.hidden || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    if (asking || document.querySelector('.ttj-ov, .ttj-tour')) return;   // 続きの確認・ごほうびの画面が上に出ているときは、裏の「新しい対局」を動かさない
    const t = e.target;
    if (t !== document.body && !dlg.contains(t)) return;
    if (t === document.body && e.key === 'Enter') { eat(e); start.click(); return; }
    const g = t.closest && t.closest('.seg, #ng-cpu');
    // 1〜5: CPU の強さ
    if (/^[1-9]$/.test(e.key) && cpuShown() && !(t.matches && t.matches('input, textarea, select'))) {
      const b = [...cpuBox().children].find(x => starsOf(x) === +e.key) || cpuBox().children[+e.key - 1];
      if (b) { eat(e); b.click(); focusIn('ng-cpu'); }
      return;
    }
    if (!g || t.tagName !== 'BUTTON') return;
    const list = [...g.querySelectorAll(':scope > button')].filter(shown);
    const i = list.indexOf(t);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step) {
      eat(e);
      const b = list[(i + step + list.length) % list.length];
      const id = g.id, idx = list.indexOf(b);
      b.click();
      focusIn(id, idx);
    } else if (e.key === 'Enter' && t.getAttribute('aria-pressed') === 'true') {   // 選んであるものの上で Enter → 始める
      eat(e);
      start.click();
    } else if (e.key === 'Enter' || e.key === ' ') {
      const id = g.id, idx = i;
      setTimeout(() => focusIn(id, idx), 0);
    }
  });
  // 描き直されたあとも、同じ欄の同じ所にフォーカスを戻す（キーボードで選んでいるとき）
  function focusIn(id, idx) {
    const g = id && document.getElementById(id);
    if (!g) return;
    const list = [...g.querySelectorAll(':scope > button')].filter(shown);
    const b = idx != null && list[idx] ? list[idx] : g.querySelector('button[aria-pressed="true"]');
    if (b) b.focus({ preventScroll: false });
  }

  // ---------------------------------------------------------------- 始めたとき: あなた VS CPU
  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('#ng-start') || dlg.hidden) return;
    if (online()) return;
    if (cpuOn()) vs(); else if (J) J.hype(watching() ? '観戦開始' : '対局開始', null, { tier: 1 });
  }, true);
  function vs() {
    const b = cpuPick();
    if (!b || !motion()) return;
    const n = starsOf(b), s = J ? J.state() : null;
    const o = J ? J.offer(n, false) : null;
    const many = /3人|3 人|人とも/.test((cpuBox().closest('.field, .field-row') || box).textContent);
    const v = document.createElement('div');
    v.className = 'tts-vs';
    v.setAttribute('aria-hidden', 'true');
    v.style.setProperty('--tts-lv', LV[n] || LV[0]);
    v.style.setProperty('--tts-me', s ? s.rank.color : '#4d9fff');
    v.innerHTML = `<div class="tts-side tts-sl">${s && J ? J.badge(s.level) : ''}<b>あなた</b><small>${s ? (s.title ? `〈${esc(s.title)}〉` : `Lv ${s.level}・${esc(s.rank.name)}`) : ''}</small></div>
      <div class="tts-vv">VS</div>
      <div class="tts-side tts-sr"><span class="tts-st">${'★'.repeat(n)}</span><small class="tts-k">CPU${many ? '×3' : ''}</small><b>${esc(nameOf(b))}</b><small>自己対局で学習</small></div>
      ${o ? `<div class="tts-vx">勝てば +${o.xp.toLocaleString()} XP</div>` : ''}`;
    document.body.appendChild(v);
    const L = v.querySelector('.tts-sl'), R = v.querySelector('.tts-sr'), V = v.querySelector('.tts-vv'), X = v.querySelector('.tts-vx');
    anim(v, [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.78 }, { opacity: 0 }], { duration: 1250, easing: 'linear', fill: 'forwards' });
    anim(L, [{ transform: 'translateX(-60vw)' }, { transform: 'translateX(0)' }], { duration: 360, easing: 'cubic-bezier(.2,1.3,.4,1)' });
    anim(R, [{ transform: 'translateX(60vw)' }, { transform: 'translateX(0)' }], { duration: 360, easing: 'cubic-bezier(.2,1.3,.4,1)' });
    anim(V, [{ opacity: 0, transform: 'scale(3) rotate(-8deg)' }, { opacity: 0, offset: 0.4 }, { opacity: 1, transform: 'scale(.9)', offset: 0.75 }, { transform: 'scale(1)' }], { duration: 520, easing: 'ease-out' });
    if (X) anim(X, [{ opacity: 0, transform: 'translate(-50%, 12px)' }, { opacity: 0, offset: 0.5 }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 640, easing: 'ease-out' });
    if (J) {
      J.sfx.vs();
      setTimeout(() => { J.flash('#fff', 0.35, 220); J.shake(6); J.burst(V, { kind: 'spark', n: 26, speed: 12 }); if (n >= 4) J.burst(R, { kind: 'star', n: 18, colors: [LV[n], '#fff'], speed: 7 }); }, 390);
    }
    setTimeout(() => v.remove(), 1400);
  }

  // ---------------------------------------------------------------- 前回の続き: しばらくぶりに開いたら「続きから／はじめから」を聞く
  // ユーザーから「ブラウザバックで終わったところからそのまま始まるけど、何も覚えていないので、はじめからするか聞いてほしい」
  // 10分以上あいて開いた（読み込み直し・戻るボタンで戻った）とき、途中の対局が残っていれば聞く。聞いている間は、ゲームの「新しい対局」を
  // 裏で開いておく（どのゲームも、それが開いている間は CPU が指さない）。続きから → その画面を閉じる。はじめから → その画面を見せる
  const SLUG = J ? J.here : '';
  const SEEN = 'tt-seen:' + SLUG, AWAY = 10 * 60 * 1000;
  const LVN = { easy: 'やさしい', normal: 'ふつう', strong: 'つよい', max: '最強', ultra: '超最強' };
  const seen = () => { try { return +localStorage.getItem(SEEN) || 0; } catch (e) { return 0; } };
  const mark = () => { try { localStorage.setItem(SEEN, String(Date.now())); } catch (e) { /* 覚えられないときは毎回聞かない */ } };
  // ゲームが残している途中の対局を読む（'<slug>-game'。ホールデムは卓 'holdem-table'）→ { done, at, who } か null
  function lastGame() {
    try {
      const g = JSON.parse(localStorage.getItem(PFX(SLUG) + (SLUG === 'holdem' ? 'table' : 'game')));
      if (!g || typeof g !== 'object' || g.online || g.mode === 'online') return null;   // オンラインは各ゲームが相手との状態で戻す
      // 席は ['human', 'normal'] / [null, 'human', 'normal'] / [{ kind, level }] / 古い囲碁の { 1: …, 2: … } のどれでも読む
      const seats = (Array.isArray(g.seats) ? g.seats : g.seats && typeof g.seats === 'object' ? Object.values(g.seats) : []).filter(x => x != null);
      const keys = [].concat(seats, (g.cfg || {}).cpu || []).map(x => (x && typeof x === 'object' ? x.level || x.kind : x));
      const cpu = keys.find(k => LVN[k]), humans = seats.filter(x => x === 'human' || x.kind === 'human' || x.kind === 'me').length;
      const watch = seats.length > 0 && !humans;   // CPU どうしの観戦
      const who = watch ? 'CPU どうしの観戦' : humans > 1 ? 'ふたりでの対局' : cpu ? `CPU（${LVN[cpu]}）との対局` : '';
      const len = a => (Array.isArray(a) ? a.length : 0);
      let n = 0, done = false, at = '';
      if (Array.isArray(g.moves)) { n = g.moves.length; done = !!g.result; at = `${n}手まで進んだところです。`; }   // 盤のゲーム
      else if (SLUG === 'koikoi' && g.match) { n = len(g.match.history) + 1; done = n > g.match.months; at = `${Math.min(n, g.match.months)}/${g.match.months}か月目`; }
      else if (SLUG === 'mahjong' && g.g) { n = len(g.g.rounds) + (g.cur && len(g.cur.steps) ? 1 : 0); done = !!g.g.ended; at = `${'東南西北'[g.g.roundWind || 0]}${(g.g.kyoku || 0) + 1}局`; }
      else if (SLUG === 'daifugo') { n = g.round || 0; done = !!g.ended; at = n ? `第${n}回戦` : ''; }
      else if (SLUG === 'backgammon' && Array.isArray(g.games)) { n = g.games.reduce((a, x) => a + len(x && x.actions), 0); done = !!g.over; at = `第${(g.gi || 0) + 1}局`; }
      else if (SLUG === 'yacht' && g.g) { n = (g.g.round || 0) + ((g.g.rolls || 0) ? 1 : 0); done = !!g.g.over; at = `${Math.min(12, (g.g.round || 0) + 1)}/12ラウンド`; }
      else if (SLUG === 'holdem') { n = g.handNo || 0; done = !!g.over || !seats.length; at = n ? `${n}ハンド目` : ''; }
      if (!n) return null;   // まだ1手も進んでいない
      if (at && !/。$/.test(at)) at += 'の途中です。';
      return { done, at, who, watch };
    } catch (e) { return null; }   // 読めない形の保存なら聞かない（ゲームはいつもどおり続きから）
  }
  const ago = ms => (ms < 3600e3 ? `${Math.max(10, Math.round(ms / 60e3))}分前` : ms < 86400e3 ? `${Math.round(ms / 3600e3)}時間前` : `${Math.round(ms / 86400e3)}日前`);
  // ゲームの「新しい対局」を開く部品（12ゲームは #btn-new、ホールデム・麻雀はメニューの中、軍人将棋は data-act）
  const opener = () => document.querySelector('#btn-new, [data-menu="new"], [data-act="new"]');
  let asking = false;
  function ask(away) {
    if (asking || !SLUG || !dlg.hidden) return;
    if ([...document.querySelectorAll('.overlay')].some(o => !o.hidden)) return;   // ほかの画面（結果など）が出ているときは聞かない
    const last = lastGame(), op = opener();
    if (!last || !op) return;
    asking = true;
    op.click();   // 裏で「新しい対局」を開いて、CPU を止めておく
    if (dlg.hidden) { asking = false; return; }
    dlg.classList.add('tts-under');
    const ov = document.createElement('div');
    ov.className = 'overlay tts-resume';
    const ac = [...act.classList].filter(c => c !== 'tts-act').join(' ') || 'actions';
    ov.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="tts-rz" style="width:min(420px,100%)">
      <p class="hint" style="margin:0 0 4px">${esc([away ? ago(away) : '前回', last.who].filter(Boolean).join('・'))}</p>
      <h2 id="tts-rz" style="margin:0 0 6px">${last.done ? '前回の対局は終わっています' : last.watch ? '前回の観戦の続きがあります' : '前回の続きがあります'}</h2>
      <p style="margin:0 0 16px">${last.done ? '盤をもう一度見るか、新しい対局を始めるか選んでください。' : `${esc(last.at)}${last.watch ? '続きを見ますか？' : '続きから遊びますか？'} それとも、はじめからにしますか？`}</p>
      <div class="${esc(ac)}"><button type="button" class="btn" data-rz="go">${last.done ? '盤を見る' : last.watch ? '続きを見る' : '続きから'}</button><button type="button" class="btn primary" data-rz="new">${last.done ? '新しい対局' : 'はじめから'}</button></div>
    </div>`;
    document.body.appendChild(ov);
    anim(ov, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    anim(ov.querySelector('.dialog'), [{ opacity: 0, scale: 0.93, translate: '0 16px' }, { opacity: 1, scale: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.3,1.4,.5,1)' });
    const end = go => {
      if (!ov.isConnected) return;
      ov.remove();
      window.removeEventListener('keydown', key, true);
      asking = false;
      if (go) { const c = document.getElementById('ng-cancel'); if (c && !dlg.hidden) c.click(); if (!dlg.hidden) dlg.hidden = true; dlg.classList.remove('tts-under'); return; }
      dlg.classList.remove('tts-under');
      anim(box, [{ opacity: 0, scale: 0.94, translate: '0 16px' }, { opacity: 1, scale: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.3,1.4,.5,1)' });
      start.focus();
    };
    const key = e => { if (e.key === 'Escape') { eat(e); end(true); } };
    window.addEventListener('keydown', key, true);
    ov.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-rz]'); if (b) end(b.dataset.rz === 'go'); });
    const primary = ov.querySelector('[data-rz="new"]');
    if (primary) primary.focus();
  }
  // 開いたとき・戻るボタンで戻ってきたとき（ページがそのまま残っていた）に、どれだけあいたかを見る
  const check = () => { const t = seen(), away = t ? Date.now() - t : 0; mark(); if (!t || away >= AWAY) setTimeout(() => ask(t ? away : 0), 450); };
  if (SLUG) {
    if (document.readyState === 'complete') check(); else window.addEventListener('load', check, { once: true });
    window.addEventListener('pageshow', e => { if (e.persisted) check(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) mark(); });
    window.addEventListener('pagehide', mark);
    setInterval(() => { if (!document.hidden) mark(); }, 60e3);
  }
})();
