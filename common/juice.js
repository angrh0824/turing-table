// 全ゲーム共通の「ごほうび」: 勝ったときの演出（光・紙吹雪・音）、経験値とレベル・連勝・実績・毎日のボーナス、ボタンの手ごたえ
// ゲームのページでは motion.js のあとに <script src="../common/juice.js"></script>（トップでも読む）。依存なし
// 画像・音のファイルは使わない（紙吹雪は使うときだけ置く1枚の canvas に描き、音は Web Audio でその場で作る）。記録はこの端末の localStorage 'tt-prog' だけ
// ゲームからは、結果を出すところで TTJuice.result({ outcome, stars, online, place, of, round, ref, quiet }) を1回呼ぶ。くわしくは CONVENTIONS.md §3「ごほうび」
// 動きのオフ（tt-motion）・動きを減らす設定では、紙吹雪などは出さず、ごほうびのカードを止まった絵で出す
(function () {
  'use strict';
  // ゲームの一覧（トップの並び順・紋章・色。実績の名前にも使う）。ultra: 「超最強」がある
  const GAMES = [
    { slug: 'gungi', em: '軍', accent: '#b8862b', name: '軍儀', en: 'Gungi', ultra: 1 },
    { slug: 'reversi', em: '石', accent: '#2f4f9a', name: 'リバーシ', en: 'Reversi' },
    { slug: 'renju', em: '五', accent: '#8a5a2b', name: '連珠', en: 'Renju' },
    { slug: 'koikoi', em: '花', accent: '#b0343c', name: '花札こいこい', short: 'こいこい', en: 'Koi-Koi' },
    { slug: 'holdem', em: '♠', accent: '#1f7a55', name: 'ホールデム', en: "Texas Hold'em" },
    { slug: 'shogi', em: '将', accent: '#9a6b2f', name: '将棋', en: 'Shogi', ultra: 1 },
    { slug: 'chess', em: '♞', accent: '#4b4f5c', name: 'チェス', en: 'Chess', ultra: 1 },
    { slug: 'mahjong', em: '麻', accent: '#1d6a5a', name: '麻雀', en: 'Mahjong' },
    { slug: 'go', em: '碁', accent: '#3a3a3a', name: '囲碁', en: 'Go', ultra: 1 },
    { slug: 'backgammon', em: '賽', accent: '#8a4b2e', name: 'バックギャモン', short: 'ギャモン', en: 'Backgammon' },
    { slug: 'daifugo', em: '富', accent: '#6b3fa0', name: '大富豪', en: 'Daifugo' },
    { slug: 'xiangqi', em: '帥', accent: '#b0302a', name: 'シャンチー', en: 'Xiangqi' },
    { slug: 'yacht', em: '骰', accent: '#c0622a', name: 'ヨット', en: 'Yacht' },
    { slug: 'amazons', em: '矢', accent: '#3d7a46', name: 'アマゾンズ', en: 'Amazons', ultra: 1 },
    { slug: 'gunjin', em: '兵', accent: '#5e6640', name: '軍人将棋', en: 'Gunjin Shogi' },
  ];
  const BY = {};
  GAMES.forEach(g => { BY[g.slug] = g; });
  const HERE = (() => { const p = location.pathname.split('/'); for (let i = p.length - 1; i >= 0; i--) if (BY[p[i]]) return p[i]; return ''; })();

  const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const motion = () => {
    if (window.TTMotion) return TTMotion.on;
    try { if (localStorage.getItem('tt-motion') === '0') return false; } catch (e) { /* 覚えられないときはオン */ }
    return !(mq && mq.matches) && !document.hidden;
  };
  const pad = n => String(n).padStart(2, '0');
  const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => dayOf(new Date());
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dayOf(d); };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
  const pickup = () => GAMES[hash('tt' + today()) % GAMES.length].slug;   // 本日のピックアップ（日ごとに1つ。だれが見ても同じ）
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Math.round(n).toLocaleString();
  const make = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ---------------------------------------------------------------- 記録（この端末だけ）
  const KEY = 'tt-prog';
  // xp 合計・g ゲームごと {n 局数, w 勝ち, top 勝った CPU のいちばん上の★}・streak 連勝・best 最多連勝・day/run 最後に遊んだ日と連続日数
  // bonus 毎日のボーナスを受け取った日・first 本日初勝利を数えた日・ach 実績（id → 取った時刻）・n/w 全体の局数と勝ち・nw オンラインの勝ち・jack 大当たりの回数
  // ids: 数えた対局の印（o.id。読み込み直しても同じ対局を2度数えない。新しい40件）
  const blank = () => ({ v: 1, xp: 0, g: {}, streak: 0, best: 0, day: '', run: 0, bonus: '', first: '', ach: {}, n: 0, w: 0, nw: 0, jack: 0, ids: [] });
  const load = () => { try { const o = JSON.parse(localStorage.getItem(KEY)); if (o && o.v === 1) return Object.assign(blank(), o); } catch (e) { /* 壊れていたら最初から */ } return blank(); };
  let P = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { /* 覚えられないときはこのページだけ */ } };
  const subs = new Set();
  const emit = () => subs.forEach(f => { try { f(state()); } catch (e) { /* 見る側の失敗は無視 */ } });
  window.addEventListener('storage', e => { if (e.key === KEY) { P = load(); emit(); } });
  function touchDay(d) { if (P.day === d) return; P.run = P.day === yesterday() ? (P.run || 0) + 1 : 1; P.day = d; }

  // ---------------------------------------------------------------- レベル・ランク
  const cost = L => 100 + 50 * (L - 1);   // L から L+1 に上がるのに要る XP
  function levelOf(xp) { let L = 1, need = cost(1); while (xp >= need) { xp -= need; L++; need = cost(L); } return { L, cur: xp, need }; }
  const RANKS = [[1, 'ブロンズ', '#c98a55'], [10, 'シルバー', '#aab6c6'], [20, 'ゴールド', '#f0bd3a'], [30, 'プラチナ', '#5fd6cf'],
    [40, 'ダイヤモンド', '#78b4ff'], [50, 'マスター', '#b77cff'], [70, 'レジェンド', '#ff6584'], [100, 'シンギュラリティ', '#ffffff']];
  const rankOf = L => { let r = RANKS[0]; for (const x of RANKS) if (L >= x[0]) r = x; return { name: r[1], color: r[2], min: r[0], top: r === RANKS[RANKS.length - 1] }; };
  // レベルの紋章（六角形。色はランク）。トップでも使う
  const badge = (L, cls = '') => { const r = rankOf(L); return `<span class="ttj-badge${r.top ? ' ttj-rb' : ''}${cls ? ' ' + cls : ''}" style="--rk:${r.color}" aria-label="レベル${L}"><small>Lv</small>${L}</span>`; };

  // ---------------------------------------------------------------- 実績（一覧から作る。ゲームが増えても書き足さなくてよい）
  const RAR = { c: ['コモン', '#9fb3c8', 50], r: ['レア', '#4ea8ff', 150], e: ['エピック', '#b977ff', 400], l: ['レジェンド', '#ffc53d', 1000] };
  const ACH = [];
  const A = (id, name, desc, rar, test, game) => ACH.push({ id, name, desc, rar, test, game });
  const gs = (p, s) => p.g[s] || {};
  const count = (p, f) => GAMES.filter(g => f(gs(p, g.slug))).length;
  A('first', 'はじめの一勝', 'CPU かオンラインの相手にはじめて勝つ', 'c', p => p.w >= 1);
  A('n10', '常連', '10局あそぶ', 'c', p => p.n >= 10);
  A('n50', '卓の主', '50局あそぶ', 'r', p => p.n >= 50);
  A('n200', '眠らない打ち手', '200局あそぶ', 'e', p => p.n >= 200);
  A('s3', '3連勝', '3回つづけて勝つ（ゲームはまたいでよい）', 'r', p => p.best >= 3);
  A('s5', '5連勝', '5回つづけて勝つ', 'e', p => p.best >= 5);
  A('s10', '10連勝', '10回つづけて勝つ', 'l', p => p.best >= 10);
  A('g5', '五つの卓', '5種類のゲームであそぶ', 'c', p => count(p, x => x.n > 0) >= 5);
  A('gall', '全卓めぐり', `${GAMES.length}種類すべてであそぶ`, 'e', p => count(p, x => x.n > 0) >= GAMES.length);
  A('wall', '全卓制覇', 'すべてのゲームで1回は勝つ', 'l', p => count(p, x => x.w > 0) >= GAMES.length);
  A('max3', '最強狩り', '3つのゲームで「最強」に勝つ', 'e', p => count(p, x => x.top >= 4) >= 3);
  A('net', '人類代表', 'オンラインで人に勝つ', 'r', p => p.nw >= 1);
  A('jack', '大当たり', '勝ちのボーナスで ×5 を引く', 'r', p => p.jack >= 1);
  A('d3', '三日坊主じゃない', '3日つづけてあそぶ', 'c', p => p.run >= 3);
  A('d7', '皆勤賞', '7日つづけてあそぶ', 'r', p => p.run >= 7);
  A('d30', '習慣の人', '30日つづけてあそぶ', 'l', p => p.run >= 30);
  [[10, 'c'], [20, 'r'], [30, 'e'], [50, 'l']].forEach(([L, r]) => A('lv' + L, `${rankOf(L).name}到達`, `レベル${L}になる`, r, p => levelOf(p.xp).L >= L));
  GAMES.forEach(g => {
    A('w:' + g.slug, `${g.name} 初勝利`, `${g.name}で勝つ`, 'c', p => gs(p, g.slug).w >= 1, g.slug);
    A('m:' + g.slug, `${g.name} 最強撃破`, `${g.name}で CPU「最強」に勝つ`, 'e', p => gs(p, g.slug).top >= 4, g.slug);
    if (g.ultra) A('u:' + g.slug, `${g.name} 超最強撃破`, `${g.name}で CPU「超最強」に勝つ`, 'l', p => gs(p, g.slug).top >= 5, g.slug);
  });
  // 新しく取れた実績（印をつけ、ごほうびの XP を足す。実績の XP でレベルが上がって取れるものもあるので、増えなくなるまで）
  function check() {
    const got = [];
    for (let k = 0; k < 5; k++) {
      let more = false;
      for (const a of ACH) if (!P.ach[a.id] && a.test(P)) { P.ach[a.id] = Date.now(); P.xp += RAR[a.rar][2]; got.push(a); more = true; }
      if (!more) break;
    }
    return got;
  }

  // ---------------------------------------------------------------- 1局の点数（XP）
  const STAR = ['', 'やさしい', 'ふつう', 'つよい', '最強', '超最強'];
  const STAR_X = [1, 1, 1.3, 1.8, 2.6, 4];
  function award(o) {
    const slug = o.game || HERE, d = today();
    const g = P.g[slug] || (P.g[slug] = { n: 0, w: 0, top: 0 });
    const multi = o.of > 2 && o.place > 0;
    const out = multi ? (o.place === 1 ? 'win' : o.place >= o.of ? 'lose' : 'draw') : o.outcome;
    const lines = [];   // 内わけ: { t 名前, v '+100' か '×1.5', k 見た目 }
    const base = o.round ? (out === 'win' ? 30 : out === 'draw' ? 15 : 8)
      : multi ? Math.round(20 + 80 * (o.of - o.place) / (o.of - 1))
        : out === 'win' ? 100 : out === 'draw' ? 40 : 20;
    lines.push({ t: o.round ? (o.label || 'この局') : multi ? `${o.place}位` : out === 'win' ? '勝利' : out === 'draw' ? (o.title || '引き分け') : '対局', v: '+' + base, k: 'base' });
    let x = 1;
    const mul = (t, m, k) => { x *= m; lines.push({ t, v: '×' + m, k: k || '' }); };
    if (o.online) mul('オンライン対戦', 2);
    else if (o.stars >= 2) mul(`CPU ${STAR[o.stars]}`, STAR_X[o.stars]);
    let luck = 1;
    const before = P.xp;
    if (!o.round) {
      touchDay(d);
      P.n++; g.n++;
      if (out === 'win') {
        P.w++; g.w++; P.streak++; P.best = Math.max(P.best, P.streak);
        if (o.online) P.nw++; else g.top = Math.max(g.top || 0, o.stars || 0);
        if (P.streak >= 2) mul(`${P.streak}連勝`, +(1 + 0.1 * Math.min(P.streak - 1, 10)).toFixed(1), 'hot');
        if (P.first !== d) { P.first = d; mul('本日初勝利', 2, 'hot'); }
      } else if (out === 'lose') P.streak = 0;
      if (slug === pickup()) mul('本日のピックアップ', 1.5, 'hot');
      const r = Math.random();
      luck = out === 'win' ? (r < 0.04 ? 5 : r < 0.18 ? 2 : 1) : (r < 0.1 ? 2 : 1);
      if (luck >= 5) P.jack++;
    }
    const gain = Math.round(base * x * luck);
    P.xp += gain;
    const ach = check();
    save();
    emit();
    return { out, lines, base, x, luck, gain, before, after: P.xp, ach, slug, round: !!o.round, multi, place: o.place, streak: P.streak, stars: o.stars || 0, online: !!o.online, title: o.title, into: o.into };
  }

  // 勝ったらもらえる XP の見込み（運は入れない）と、上乗せ・取れる実績。「新しい対局」の画面で見せる
  function offer(stars, online, slug = HERE) {
    const g = P.g[slug] || {}, tags = [];
    let x = online ? 2 : stars >= 2 ? STAR_X[stars] : 1;
    const streak = P.streak + 1;
    if (streak >= 2) { const m = +(1 + 0.1 * Math.min(streak - 1, 10)).toFixed(1); x *= m; tags.push(`${streak}連勝 ×${m}`); }
    if (P.first !== today()) { x *= 2; tags.push('本日初勝利 ×2'); }
    if (slug === pickup()) { x *= 1.5; tags.push('ピックアップ ×1.5'); }
    const unlock = [];
    const want = id => { const a = ACH.find(q => q.id === id); if (a && !P.ach[a.id]) unlock.push({ name: a.name, xp: RAR[a.rar][2], rar: a.rar }); };
    if (!P.w) want('first');
    want('w:' + slug);
    if (online) want('net');
    else { if (stars >= 4) want('m:' + slug); if (stars >= 5) want('u:' + slug); }
    return { xp: Math.round(100 * x), tags, unlock, top: g.top || 0, n: g.n || 0, w: g.w || 0 };
  }

  // ---------------------------------------------------------------- 見た目（このファイルが1回だけ入れる）
  const FONT = '"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic",system-ui,sans-serif';
  const SERIF = '"Shippori Mincho B1","Hiragino Mincho ProN","Yu Mincho",serif';
  const CSS = `
.ttj-fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483600}
.ttj-ov{position:fixed;inset:0;z-index:2147483500;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px;overflow:hidden;
  background:radial-gradient(ellipse at 50% 38%,rgba(34,26,10,.6),rgba(0,0,0,.82));color:#fff;font:14px/1.5 ${FONT};cursor:pointer;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.ttj-ov.ttj-draw{background:radial-gradient(ellipse at 50% 38%,rgba(20,26,36,.6),rgba(0,0,0,.82))}
.ttj-rays{position:absolute;left:50%;top:34%;width:240vmax;height:240vmax;margin:-120vmax 0 0 -120vmax;pointer-events:none;
  background:repeating-conic-gradient(rgba(255,212,90,.17) 0 7deg,transparent 7deg 15deg);-webkit-mask:radial-gradient(circle,#000,transparent 34%);mask:radial-gradient(circle,#000,transparent 34%)}
.ttj-ov.ttj-draw .ttj-rays{background:repeating-conic-gradient(rgba(200,216,240,.12) 0 7deg,transparent 7deg 15deg)}
.ttj-move .ttj-rays{animation:ttj-spin 24s linear infinite}
@keyframes ttj-spin{to{rotate:360deg}}
.ttj-banner{position:relative;text-align:center;line-height:1;filter:drop-shadow(0 8px 20px rgba(0,0,0,.55))}
.ttj-banner b{display:block;font:800 clamp(58px,17vw,124px)/1 ${SERIF};letter-spacing:.08em;padding:0 .04em;color:transparent;-webkit-background-clip:text;background-clip:text;
  background-image:linear-gradient(105deg,transparent 42%,rgba(255,255,255,.95) 50%,transparent 58%),linear-gradient(180deg,#fff8d6 0%,#ffd75e 44%,#df9612 56%,#ffe48a 100%);background-size:250% 100%,100% 100%;background-position:150% 0,0 0;background-repeat:no-repeat}
.ttj-move .ttj-banner b{animation:ttj-shine 2.4s .5s ease-in-out infinite}
@keyframes ttj-shine{0%{background-position:150% 0,0 0}60%,100%{background-position:-50% 0,0 0}}
.ttj-ov.ttj-draw .ttj-banner b{background-image:linear-gradient(105deg,transparent 42%,rgba(255,255,255,.95) 50%,transparent 58%),linear-gradient(180deg,#fff 0%,#d3dcea 48%,#8e9cb2 56%,#eef2f8 100%)}
.ttj-banner small{display:block;margin-top:10px;font-size:clamp(13px,3.6vw,17px);font-weight:700;letter-spacing:.22em;color:#ffe7a0}
.ttj-ov.ttj-draw .ttj-banner small{color:#dfe7f3}
.ttj-card{position:relative;width:min(400px,100%);padding:16px 18px 14px;border-radius:20px;display:grid;gap:12px;
  background:linear-gradient(180deg,rgba(44,36,22,.94),rgba(18,16,12,.96));border:1px solid rgba(255,214,110,.32);box-shadow:0 24px 70px -20px #000,inset 0 1px 0 rgba(255,255,255,.08)}
.ttj-lines{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;min-height:26px}
.ttj-ln{display:inline-flex;align-items:baseline;gap:6px;padding:2px 10px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);font-size:12.5px;white-space:nowrap}
.ttj-ln b{font-variant-numeric:tabular-nums;color:#ffe08a;font-size:13.5px}
.ttj-ln.ttj-hot{background:linear-gradient(90deg,rgba(255,92,60,.3),rgba(255,176,60,.3));border-color:rgba(255,150,80,.65)}
.ttj-ln.ttj-luck{background:linear-gradient(90deg,#ffd447,#ff8d3a);border-color:#fff1a8;color:#2b1700;font-weight:700;box-shadow:0 0 18px rgba(255,190,60,.7)}
.ttj-ln.ttj-luck b{color:#2b1700}
.ttj-reel{position:relative;height:46px;border-radius:12px;overflow:hidden;background:#0c0b08;box-shadow:inset 0 0 0 1px rgba(255,214,110,.35),inset 0 8px 14px rgba(0,0,0,.6)}
.ttj-reel::before,.ttj-reel::after{content:"";position:absolute;top:0;bottom:0;width:30%;z-index:1;pointer-events:none}
.ttj-reel::before{left:0;background:linear-gradient(90deg,#0c0b08,transparent)}.ttj-reel::after{right:0;background:linear-gradient(-90deg,#0c0b08,transparent)}
.ttj-reel i{position:absolute;left:50%;top:3px;bottom:3px;width:58px;margin-left:-29px;border-radius:9px;border:2px solid #ffd45a;box-shadow:0 0 14px rgba(255,200,70,.7);z-index:2}
.ttj-strip{position:absolute;left:0;top:0;bottom:0;display:flex;will-change:transform}
.ttj-strip span{flex:0 0 60px;display:grid;place-items:center;font-weight:800;font-size:19px;color:#cfc6b0;font-variant-numeric:tabular-nums}
.ttj-strip .ttj-t2{color:#7fd0ff}.ttj-strip .ttj-t3{color:#ffd45a}.ttj-strip .ttj-t4{color:#ff7aa8;text-shadow:0 0 10px rgba(255,90,140,.7)}
.ttj-reel.ttj-big{height:64px}.ttj-reel.ttj-big i{width:84px;margin-left:-42px}.ttj-reel.ttj-big .ttj-strip span{flex-basis:88px;font-size:22px}
.ttj-reel.ttj-hit i{animation:ttj-blink .18s 5 alternate}
@keyframes ttj-blink{to{border-color:#fff;box-shadow:0 0 26px #ffd45a}}
.ttj-gain{text-align:center;font-weight:800;font-size:clamp(38px,11vw,54px);line-height:1;font-variant-numeric:tabular-nums;text-shadow:0 0 20px rgba(255,200,80,.55)}
.ttj-gain small{font-size:.38em;margin-left:6px;color:#ffe08a;letter-spacing:.12em}
.ttj-lv{position:relative;display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:center}
.ttj-lvt{display:flex;justify-content:space-between;gap:8px;margin-top:5px;font-size:11px;color:rgba(255,255,255,.66)}
.ttj-lvt .ttj-rk{color:var(--rk);font-weight:700;letter-spacing:.08em}
.ttj-bar{position:relative;display:block;height:10px;border-radius:999px;background:rgba(127,127,127,.25);overflow:hidden}
.ttj-bar i{position:absolute;left:0;top:0;bottom:0;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--rk,#f0bd3a),#fff5c4);box-shadow:0 0 10px var(--rk,#f0bd3a)}
.ttj-badge{--rk:#c98a55;flex:none;display:inline-grid;place-items:center;align-content:center;width:46px;height:50px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
  background:linear-gradient(160deg,#fff 0%,var(--rk) 34%,color-mix(in srgb,var(--rk) 50%,#000) 100%);color:#fff;font:800 17px/1 ${FONT};text-shadow:0 1px 2px rgba(0,0,0,.65);font-variant-numeric:tabular-nums}
.ttj-badge small{display:block;font-size:8px;letter-spacing:.12em;opacity:.92;margin-bottom:1px}
.ttj-badge.ttj-rb{background:conic-gradient(from 200deg,#ff6584,#ffc53d,#5fd6cf,#78b4ff,#b77cff,#ff6584)}
.ttj-badge.ttj-sm{width:32px;height:35px;font-size:12px}.ttj-badge.ttj-sm small{font-size:6.5px}
.ttj-up{position:absolute;left:0;bottom:100%;margin-bottom:2px;font:800 15px/1 ${FONT};letter-spacing:.14em;color:#fff3b0;text-shadow:0 0 12px #ffb400,0 2px 3px #000;white-space:nowrap;pointer-events:none}
.ttj-tap{font-size:11px;letter-spacing:.24em;color:rgba(255,255,255,.55);opacity:0;transition:opacity .3s}
.ttj-ov.ttj-done .ttj-tap{opacity:1}
.ttj-toasts{position:fixed;left:50%;top:max(10px,env(safe-area-inset-top,0px));transform:translateX(-50%);z-index:2147483700;display:grid;gap:8px;width:min(380px,calc(100vw - 24px));pointer-events:none}
.ttj-toast{--rc:#ffd45a;position:relative;overflow:hidden;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:9px 14px;border-radius:14px;
  background:rgba(20,17,12,.95);color:#fff;border:1px solid var(--rc);box-shadow:0 12px 32px -12px #000,0 0 22px -6px var(--rc);font:13px/1.35 ${FONT};pointer-events:auto;cursor:pointer}
.ttj-toast::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.25) 50%,transparent 65%);transform:translateX(-100%);pointer-events:none}
.ttj-move .ttj-toast::after{animation:ttj-sweep 1.1s .25s ease-out forwards}
@keyframes ttj-sweep{to{transform:translateX(100%)}}
.ttj-toast .ttj-ic{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:color-mix(in srgb,var(--rc) 22%,transparent);color:var(--rc)}
.ttj-toast .ttj-ic svg{width:20px;height:20px}
.ttj-toast .ttj-k{display:block;font-size:10px;letter-spacing:.18em;color:var(--rc);font-weight:700}
.ttj-toast .ttj-n{display:block;font-weight:700;font-size:14px}
.ttj-toast .ttj-x{font-weight:800;color:#ffe08a;font-variant-numeric:tabular-nums;white-space:nowrap}
.ttj-toast .ttj-bar{height:6px;margin-top:4px}
.ttj-hype{position:fixed;z-index:2147483550;pointer-events:none;white-space:nowrap;font:800 30px/1 ${SERIF};letter-spacing:.06em;color:transparent;-webkit-background-clip:text;background-clip:text;
  background-image:linear-gradient(180deg,#fff8d6,#ffd75e 45%,#df9612 55%,#ffe48a);filter:drop-shadow(0 3px 0 rgba(60,30,0,.55)) drop-shadow(0 0 14px rgba(255,190,50,.6))}
.ttj-mini{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:8px 12px;border-radius:12px;background:color-mix(in srgb,currentColor 6%,transparent);border:1px solid color-mix(in srgb,currentColor 14%,transparent);font-size:12px;line-height:1.3}
.ttj-mini .ttj-g{font-weight:800;font-size:16px;font-variant-numeric:tabular-nums}
.ttj-mini .ttj-m{flex:1;min-width:0}
.ttj-mini .ttj-s{display:flex;justify-content:space-between;gap:8px;opacity:.75;margin-top:4px;font-size:11px}
.ttj-mini .ttj-bar{height:7px}
.ttj-sheet{position:relative;width:min(560px,100%);max-height:min(82vh,760px);overflow-y:auto;overscroll-behavior:contain;padding:18px;border-radius:20px;cursor:auto;user-select:text;-webkit-user-select:text;
  background:linear-gradient(180deg,rgba(40,34,24,.97),rgba(16,14,11,.98));border:1px solid rgba(255,214,110,.3);box-shadow:0 30px 80px -24px #000}
.ttj-sheet h2{margin:0 0 4px;font:800 22px/1.2 ${SERIF};letter-spacing:.06em}
.ttj-sheet .ttj-close{position:absolute;right:10px;top:10px;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#fff;font-size:18px;line-height:1;cursor:pointer}
.ttj-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0 14px}
.ttj-stats div{padding:8px 4px;border-radius:12px;background:rgba(255,255,255,.06);text-align:center;font-size:10.5px;color:rgba(255,255,255,.65)}
.ttj-stats b{display:block;font-size:19px;color:#fff;font-variant-numeric:tabular-nums}
.ttj-sheet h3{margin:14px 0 8px;font-size:12px;letter-spacing:.2em;color:#ffe08a}
.ttj-achs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.ttj-ach{--rc:#9fb3c8;display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid color-mix(in srgb,var(--rc) 55%,transparent);font-size:12px;line-height:1.3}
.ttj-ach .ttj-ic{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:color-mix(in srgb,var(--rc) 24%,transparent);color:var(--rc)}
.ttj-ach .ttj-ic svg{width:16px;height:16px}
.ttj-ach b{display:block;font-size:12.5px}
.ttj-ach small{display:block;color:rgba(255,255,255,.6);font-size:10.5px}
.ttj-ach.ttj-no{border-color:rgba(255,255,255,.1);filter:grayscale(1);opacity:.5}
.ttj-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1);font-size:12px;color:rgba(255,255,255,.75)}
.ttj-row button{padding:6px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;font:700 12px ${FONT};cursor:pointer}
.ttj-prize{display:grid;justify-items:center;gap:6px}
.ttj-move #dlg-result .btn.primary{position:relative;overflow:hidden;animation:ttj-cta 1.6s ease-in-out infinite}
.ttj-move #dlg-result .btn.primary::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.5) 50%,transparent 65%);transform:translateX(-120%);animation:ttj-sweep2 2.8s ease-in-out infinite;pointer-events:none}
@keyframes ttj-cta{50%{box-shadow:0 0 0 4px rgba(255,190,60,.25),0 0 22px rgba(255,180,50,.55)}}
@keyframes ttj-sweep2{0%,55%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
@media (max-width:420px){.ttj-card{padding:14px 12px 12px}.ttj-stats{grid-template-columns:repeat(2,1fr)}}`;
  function style() {
    if (document.getElementById('tt-juice-css')) return;
    const s = document.createElement('style');
    s.id = 'tt-juice-css';
    // トップとゲームの行き来は、ページどうしをなめらかに入れ替える（対応するブラウザだけ。動きオンのとき）
    s.textContent = CSS + (motion() ? '@view-transition{navigation:auto}' +
      '::view-transition-old(root){animation:.2s ease-in both ttj-vt-out}::view-transition-new(root){animation:.28s cubic-bezier(.2,.8,.2,1) both ttj-vt-in}' +
      '@keyframes ttj-vt-out{to{opacity:0;transform:scale(.985)}}@keyframes ttj-vt-in{from{opacity:0;transform:scale(1.015)}}' : '');
    document.head.appendChild(s);
  }
  // 動くときだけ <html> に ttj-move（光の流れ・ボタンの手ごたえなど、CSS の動きをまとめて止められるように）
  const sync = () => {
    const m = motion();
    document.documentElement.classList.toggle('ttj-move', m);
    if (!m && cv) { parts.length = 0; if (cv.isConnected) cv.remove(); }   // 止めたら、舞っている紙吹雪も消す
  };
  if (window.TTMotion) { const set = TTMotion.set; TTMotion.set = v => { set(v); sync(); }; }
  window.addEventListener('storage', e => { if (e.key === 'tt-motion') sync(); });
  if (mq && mq.addEventListener) mq.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);

  // ---------------------------------------------------------------- 音（Web Audio でその場で作る。全体の音の元栓 mute.js と、ゲームの「音」オフに従う）
  let ac = null, quiet = false;
  // ゲームの設定の「音」（localStorage '<slug>-settings' の sound）がオフなら鳴らさない
  const gameMuted = () => { try { const v = JSON.parse(localStorage.getItem(HERE + '-settings')); return !!v && v.sound === false; } catch (e) { return false; } };
  function audio() {
    if (quiet || (window.TTSound && TTSound.muted) || gameMuted()) return null;
    if (!ac) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { ac = new C(); } catch (e) { return null; } }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  function tone(f0, f1, dur, vol, type, at) {
    const a = audio();
    if (!a) return;
    const t = a.currentTime + (at || 0), o = a.createOscillator(), g = a.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }
  const N = i => 523.25 * Math.pow(2, i / 12);   // ド（C5）から半音 i
  const SFX = {
    tick: () => tone(2600, 1900, 0.025, 0.025, 'square'),
    chip: i => { const f = N(7 + 2 * Math.min(i, 9)); tone(f, f, 0.14, 0.06, 'triangle'); tone(f * 2, f * 2, 0.08, 0.02, 'sine', 0.02); },
    coin: () => { tone(N(11), N(11), 0.07, 0.05, 'square'); tone(N(16), N(16), 0.3, 0.05, 'square', 0.07); },
    win: () => { [0, 4, 7, 12].forEach((s, i) => tone(N(s), N(s), 0.2, 0.08, 'triangle', i * 0.085)); [0, 4, 7, 12].forEach(s => tone(N(s + 12), N(s + 12), 1.0, 0.035, 'sine', 0.36)); },
    draw: () => [0, 5, 9, 12].forEach((s, i) => tone(N(s), N(s), 0.24, 0.06, 'triangle', i * 0.1)),
    level: () => [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(N(s), N(s), 0.16, 0.05, 'square', i * 0.05)),
    jackpot: () => { for (let i = 0; i < 10; i++) { const f = N(12 + (i % 4) * 4); tone(f, f, 0.09, 0.045, 'square', i * 0.055); } [0, 4, 7, 11, 14].forEach(s => tone(N(s + 12), N(s + 12), 1.2, 0.03, 'sine', 0.55)); },
    unlock: () => [19, 24, 28, 31].forEach((s, i) => tone(N(s), N(s), 0.32, 0.04, 'sine', i * 0.06)),
    miss: () => tone(N(2), N(-3), 0.22, 0.04, 'triangle'),
    pop: () => tone(N(12), N(19), 0.09, 0.05, 'triangle'),
    sel: i => { const f = N(12 + (i || 0) * 2); tone(f, f * 1.5, 0.06, 0.03, 'triangle'); },
    vs: () => { tone(160, 50, 0.45, 0.12, 'sawtooth'); tone(N(7), N(7), 0.5, 0.05, 'triangle', 0.04); tone(N(19), N(19), 0.6, 0.03, 'sine', 0.08); },
  };

  // ---------------------------------------------------------------- 紙吹雪・火花・コイン・星（使っている間だけ置く1枚の canvas）
  let cv = null, cx = null, parts = [], raf = 0, last = 0, dpr = 1;
  const PAL = {
    confetti: ['#ffd23f', '#ff5d8f', '#3ec1ff', '#7bff8a', '#b47bff', '#ff9a3c', '#ffffff'],
    gold: ['#ffe27a', '#ffc53d', '#fff2b8', '#f5a623'],
    spark: ['#fff6c8', '#ffd45a', '#ffb02e'],
    star: ['#fff6c8', '#ffe08a', '#ffffff'],
  };
  function fit() { if (!cv) return; dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr); }
  function canvas() {
    if (!cv) { cv = make('canvas', 'ttj-fx'); cv.setAttribute('aria-hidden', 'true'); cx = cv.getContext('2d'); window.addEventListener('resize', fit); }
    if (!cv.isConnected) { document.body.appendChild(cv); fit(); }
  }
  const pt = at => {
    if (!at) return { x: innerWidth / 2, y: innerHeight / 2 };
    if (at instanceof Element) { const r = at.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    if (at.width != null) return { x: at.left + at.width / 2, y: at.top + at.height / 2 };
    return at;
  };
  const LIFE = { confetti: [2600, 3800], spark: [450, 900], coin: [2200, 3000], star: [800, 1300] };
  function add(kind, x, y, vx, vy, c, delay) {
    if (parts.length > 420) return;
    const L = LIFE[kind];
    parts.push({ kind, x, y, vx, vy, c, t: 0, delay: delay || 0, life: L[0] + Math.random() * (L[1] - L[0]),
      w: kind === 'coin' ? 7 + Math.random() * 4 : kind === 'star' ? 4 + Math.random() * 5 : 5 + Math.random() * 6, h: 3 + Math.random() * 4,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.35, ph: Math.random() * 6.28 });
    if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
  }
  // at の所から飛び散らせる。o: { kind: 'confetti'|'spark'|'coin'|'star', n, colors, speed, dir（角度。既定は上）, spread（広がり。既定は全周）, delay（ばらつき ms） }
  function burst(at, o = {}) {
    if (!motion()) return;
    canvas();
    const p = pt(at), kind = o.kind || 'confetti', cols = o.colors || PAL[kind] || PAL.confetti, n = Math.min(o.n || 40, 260);
    const sp = o.speed || (kind === 'spark' ? 11 : 9), dir = o.dir == null ? -Math.PI / 2 : o.dir, spread = o.spread == null ? Math.PI * 2 : o.spread;
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * spread, v = sp * (0.35 + Math.random() * 0.8);
      add(kind, p.x, p.y, Math.cos(a) * v, Math.sin(a) * v, cols[i % cols.length], o.delay ? Math.random() * o.delay : 0);
    }
  }
  // 画面の上から降らせる（大当たり・ランクアップ）
  function rain(o = {}) {
    if (!motion()) return;
    canvas();
    const kind = o.kind || 'coin', cols = o.colors || PAL[kind === 'coin' ? 'gold' : kind] || PAL.confetti, n = Math.min(o.n || 60, 200);
    for (let i = 0; i < n; i++) add(kind, Math.random() * innerWidth, -20 - Math.random() * 60, (Math.random() - 0.5) * 2, 2 + Math.random() * 3, cols[i % cols.length], Math.random() * (o.ms || 1200));
  }
  // 下の両すみから打ち上げる（勝ったとき）
  function cannon(n = 90) {
    burst({ x: -10, y: innerHeight * 0.92 }, { n, dir: -Math.PI / 3, spread: 0.7, speed: Math.max(14, innerHeight / 38), delay: 260 });
    burst({ x: innerWidth + 10, y: innerHeight * 0.92 }, { n, dir: -Math.PI * 2 / 3, spread: 0.7, speed: Math.max(14, innerHeight / 38), delay: 260 });
  }
  function star(c, r) {
    c.beginPath();
    for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, q = i & 1 ? r * 0.45 : r; c.lineTo(Math.cos(a) * q, Math.sin(a) * q); }
    c.closePath();
    c.fill();
  }
  function tick(now) {
    const dt = last ? Math.min(48, now - last) : 16.7, k = dt / 16.7;
    last = now;
    const c = cx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    let keep = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.delay > 0) { p.delay -= dt; parts[keep++] = p; continue; }
      p.t += dt;
      if (p.t >= p.life || p.y > innerHeight + 40) continue;
      parts[keep++] = p;
      const g = p.kind === 'confetti' ? 0.24 : p.kind === 'coin' ? 0.3 : p.kind === 'spark' ? 0.06 : 0.08;
      const drag = p.kind === 'confetti' ? 0.965 : p.kind === 'coin' ? 0.99 : 0.93;
      const dk = Math.pow(drag, k);
      p.vx *= dk; p.vy = p.vy * dk + g * k;
      if (p.kind === 'confetti') { p.ph += 0.12 * k; p.x += (p.vx + Math.sin(p.ph) * 0.9) * k; p.vy = Math.min(p.vy, 3.2); } else p.x += p.vx * k;
      p.y += p.vy * k;
      p.r += p.vr * k;
      const fade = Math.min(1, (p.life - p.t) / 400);
      c.globalAlpha = fade;
      c.setTransform(dpr, 0, 0, dpr, p.x * dpr, p.y * dpr);
      if (p.kind === 'confetti') {
        c.rotate(p.r);
        c.scale(1, Math.cos(p.ph * 1.7));
        c.fillStyle = p.c;
        c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      } else if (p.kind === 'coin') {
        const sx = Math.cos(p.ph + p.t / 90);
        c.scale(Math.abs(sx) < 0.15 ? 0.15 : sx, 1);
        c.fillStyle = '#b37800';
        c.beginPath(); c.arc(0, 0, p.w, 0, 6.283); c.fill();
        c.fillStyle = p.c;
        c.beginPath(); c.arc(0, 0, p.w * 0.8, 0, 6.283); c.fill();
        c.fillStyle = 'rgba(255,255,255,.75)';
        c.fillRect(-p.w * 0.12, -p.w * 0.5, p.w * 0.24, p.w);
      } else if (p.kind === 'spark') {
        c.globalCompositeOperation = 'lighter';
        c.strokeStyle = p.c;
        c.lineWidth = 2;
        c.lineCap = 'round';
        c.beginPath(); c.moveTo(0, 0); c.lineTo(-p.vx * 2.4, -p.vy * 2.4); c.stroke();
        c.globalCompositeOperation = 'source-over';
      } else {
        c.globalCompositeOperation = 'lighter';
        c.rotate(p.r);
        c.fillStyle = p.c;
        star(c, p.w);
        c.globalCompositeOperation = 'source-over';
      }
    }
    parts.length = keep;
    c.globalAlpha = 1;
    if (keep) raf = requestAnimationFrame(tick);
    else { raf = 0; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); cv.remove(); }
  }
  // 画面をゆらす・光らせる
  function shake(px = 7) {
    if (!motion()) return;
    const s = [0, -1, 1, -0.7, 0.6, -0.3, 0].map((v, i) => ({ translate: `${(v * px).toFixed(1)}px ${(i % 2 ? -v * px * 0.6 : v * px * 0.4).toFixed(1)}px` }));
    document.body.animate(s, { duration: 380, easing: 'ease-out' });
  }
  function flash(color = '#fff', a = 0.55, ms = 300) {
    if (!motion()) return;
    const f = make('div');
    f.style.cssText = `position:fixed;inset:0;z-index:2147483650;pointer-events:none;background:${color}`;
    document.body.appendChild(f);
    f.animate([{ opacity: a }, { opacity: 0 }], { duration: ms, easing: 'ease-out' }).finished.then(() => f.remove(), () => f.remove());
    setTimeout(() => f.remove(), ms + 400);
  }

  // ---------------------------------------------------------------- 小さな道具
  // step(t) を 0→1 で呼ぶ。動かないとき・飛ばしたときは step(1) だけ。描かれず requestAnimationFrame が来なくても、時間で打ち切る
  function tween(ms, step, seq, ease) {
    const e = ease || (t => 1 - Math.pow(1 - t, 3));
    if (!motion() || (seq && seq.skip) || !(ms > 0)) { step(1); return Promise.resolve(); }
    return new Promise(res => {
      const t0 = performance.now();
      let done = false;
      const end = () => { if (done) return; done = true; clearTimeout(cut); step(1); res(); };
      const cut = setTimeout(end, ms + 300);
      const f = now => {
        if (done) return;
        const t = (now - t0) / ms;
        if (t >= 1 || (seq && seq.skip)) { end(); return; }
        step(e(Math.max(0, t)));
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
  }
  const anim = (el, kf, o) => { if (!motion() || !el) return Promise.resolve(); try { return el.animate(kf, o).finished.then(() => {}, () => {}); } catch (e) { return Promise.resolve(); } };
  const ICON = {
    trophy: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 3h10v2h3v3a5 5 0 0 1-4.6 5A5 5 0 0 1 13 15.9V18h3v3H8v-3h3v-2.1A5 5 0 0 1 8.6 13 5 5 0 0 1 4 8V5h3zm0 4H6v1a3 3 0 0 0 1.2 2.4A7 7 0 0 1 7 9zm10 0v2a7 7 0 0 1-.2 1.4A3 3 0 0 0 18 8V7z"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l8 9h-5v9H9v-9H4z"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7c-1.5-3-5-4-5-1.5S10 7 12 7zm0 0c1.5-3 5-4 5-1.5S14 7 12 7z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h1v11H6V10zm2 0h6V8a3 3 0 0 0-6 0z"/></svg>',
  };

  // ---------------------------------------------------------------- 上に出る小さな知らせ（実績・負けたときの XP など）
  let box = null;
  function toast(html, o = {}) {
    style();
    if (!box || !box.isConnected) { box = make('div', 'ttj-toasts'); box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = make('div', 'ttj-toast', html);
    if (o.color) t.style.setProperty('--rc', o.color);
    box.appendChild(t);
    anim(t, [{ opacity: 0, transform: 'translateY(-16px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.3,1.5,.5,1)' });
    const gone = () => { if (!t.isConnected || t._gone) return; t._gone = 1; anim(t, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: 220 }).then(() => t.remove()); };
    t.addEventListener('click', gone);
    setTimeout(gone, o.ms || 3000);
    return t;
  }
  function achToast(a, i) {
    setTimeout(() => {
      const r = RAR[a.rar];
      const t = toast(`<span class="ttj-ic">${ICON.trophy}</span><span><span class="ttj-k">実績解除・${r[0]}</span><span class="ttj-n">${esc(a.name)}</span></span><span class="ttj-x">+${r[2]} XP</span>`, { color: r[1], ms: 3400 });
      SFX.unlock();
      if (a.rar === 'e' || a.rar === 'l') { burst(t, { kind: 'star', n: a.rar === 'l' ? 40 : 22, colors: [r[1], '#fff'], speed: 7 }); }
      if (a.rar === 'l') { flash(r[1], 0.3); burst(t, { kind: 'confetti', n: 50, speed: 10, dir: Math.PI / 2, spread: 2.4 }); }
    }, 250 + i * 750);
  }

  // ---------------------------------------------------------------- レベルの表示（結果のカード・トップ・毎日のボーナスで共通）
  function paint(el, L, frac, left) {
    const r = rankOf(L), b = el.querySelector('.ttj-badge');
    if (b) { b.style.setProperty('--rk', r.color); b.classList.toggle('ttj-rb', r.top); b.innerHTML = `<small>Lv</small>${L}`; b.setAttribute('aria-label', `レベル${L}`); }
    el.style.setProperty('--rk', r.color);
    const i = el.querySelector('.ttj-bar i');
    if (i) i.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
    const rk = el.querySelector('.ttj-rk'), nx = el.querySelector('.ttj-nx');
    if (rk) rk.textContent = r.name;
    if (nx) nx.textContent = `次のレベルまで ${fmt(left)} XP`;
  }
  function levelUp(el, L, seq) {
    const r = rankOf(L), rankUp = r.min === L, b = el.querySelector('.ttj-badge') || el;
    SFX.level();
    burst(b, { kind: 'star', n: rankUp ? 46 : 26, colors: [r.color, '#fff', '#ffe08a'], speed: 8 });
    anim(b, [{ scale: 1 }, { scale: 1.45 }, { scale: 1 }], { duration: 420, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    const host = el.classList.contains('ttj-lv') ? el : el.querySelector('.ttj-lv');
    if (host) {   // 紋章の上に「LEVEL UP!」
      const u = make('span', 'ttj-up', rankUp ? `ランクアップ！ ${esc(r.name)}` : 'LEVEL UP!');
      host.appendChild(u);
      anim(u, [{ opacity: 0, transform: 'translateY(8px) scale(.6)' }, { opacity: 1, transform: 'translateY(-4px) scale(1.1)', offset: 0.3 }, { opacity: 1, transform: 'translateY(-8px)', offset: 0.75 }, { opacity: 0, transform: 'translateY(-14px)' }],
        { duration: seq && seq.skip ? 1 : 1500, easing: 'ease-out' }).then(() => u.remove());
      if (!motion()) setTimeout(() => u.remove(), 1500);
    } else toast(`<span class="ttj-ic">${ICON.up}</span><span><span class="ttj-k">${rankUp ? 'ランクアップ' : 'LEVEL UP'}</span><span class="ttj-n">レベル ${L}${rankUp ? '・' + esc(r.name) : ''}</span></span><span></span>`, { color: r.color });   // 小さな知らせのときは、もう1枚の知らせで
    if (rankUp) { flash(r.color, 0.35); rain({ kind: 'confetti', n: 90, colors: [r.color, '#fff', '#ffe08a'], ms: 900 }); }
  }
  // from → to の XP を、バーを伸ばしながら見せる（上がるたびに LEVEL UP）
  async function grow(el, from, to, seq, ms) {
    let { L, cur } = levelOf(from);
    paint(el, L, cur / cost(L), cost(L) - cur);
    let left = to - from;
    while (left > 0) {
      const need = cost(L), step = Math.min(need - cur, left), c0 = cur;
      await tween(Math.max(260, (ms || 900) * step / need), t => paint(el, L, (c0 + step * t) / need, need - c0 - step * t), seq);
      cur += step; left -= step;
      if (cur >= need) {
        L++; cur = 0;
        levelUp(el, L, seq);
        paint(el, L, 0, cost(L));
        if (!(seq && seq.skip) && motion()) await new Promise(r => setTimeout(r, 360));
      }
    }
  }
  const lvHTML = () => `<div class="ttj-lv">${badge(levelOf(P.xp).L)}<div><div class="ttj-bar"><i></i></div><div class="ttj-lvt"><span class="ttj-rk"></span><span class="ttj-nx"></span></div></div></div>`;

  // ---------------------------------------------------------------- スロットのリール（勝ったときの「×?」・毎日のボーナス）
  // items（文字の HTML の並び）を回して stop 番目で止める。tick ごとにカチカチ鳴らす
  function spin(reel, items, stop, seq, ms) {
    const strip = reel.querySelector('.ttj-strip');
    strip.innerHTML = items.join('');
    const w = strip.firstElementChild.getBoundingClientRect().width || 60;
    const end = stop * w + w / 2 - reel.clientWidth / 2;
    let lastCell = -1;
    return tween(ms || 1500, t => {
      const x = end * t;
      strip.style.transform = `translateX(${-x}px)`;
      const cell = Math.floor((x + reel.clientWidth / 2) / w);
      if (cell !== lastCell && t < 1) { lastCell = cell; SFX.tick(); }
    }, seq, t => 1 - Math.pow(1 - t, 4));
  }

  // ---------------------------------------------------------------- 結果のごほうび
  const seen = new WeakSet();
  let cur = null;   // 出ている大きな演出 { ov, seq, close }
  // 勝ち・引き分け・多人数の順位（最下位以外）は画面いっぱいの演出、負けと1局ごとの結果は上の小さな知らせ
  function result(o) {
    if (!o || (!o.outcome && !(o.place > 0))) return null;
    if (o.ref && typeof o.ref === 'object') { if (seen.has(o.ref)) return null; seen.add(o.ref); }
    if (o.id) { const id = (o.game || HERE) + ':' + o.id; if (P.ids.includes(id)) return null; P.ids.push(id); if (P.ids.length > 40) P.ids.shift(); }
    quiet = !!o.quiet;
    style();
    sync();
    const r = award(o);
    if (r.round || r.out === 'lose') small(r); else big(r);
    return r;
  }

  function small(r) {
    const head = r.round ? (r.lines[0].t) : r.multi ? `${r.place}位` : 'おつかれさま';
    const t = toast(`${badge(levelOf(r.before).L, 'ttj-sm')}<span class="ttj-m"><span class="ttj-n">${esc(head)}${r.luck > 1 ? ' <span style="color:#ffd45a">おまけ ×' + r.luck + '</span>' : ''}</span><span class="ttj-bar"><i></i></span></span><span class="ttj-x">+${fmt(r.gain)} XP</span>`, { ms: 2800 });
    if (r.luck > 1) { SFX.coin(); burst(t, { kind: 'coin', n: 16, speed: 7, colors: PAL.gold }); }
    grow(t, r.before, r.after, null, 700);
    r.ach.forEach(achToast);
    setTimeout(() => mini(r), 50);
  }

  function big(r) {
    if (cur) cur.close(true);
    const moving = motion();
    const win = r.out === 'win';
    const ov = make('div', 'ttj-ov ' + (win ? 'ttj-win' : 'ttj-draw'));
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'ごほうび');
    const title = r.title || (r.multi ? `${r.place}位` : win ? '勝利' : '引き分け');
    const who = r.online ? 'オンライン対戦' : r.stars ? `CPU「${STAR[r.stars]}」` : '';
    const sub = [who, win && r.streak >= 2 ? `${r.streak}連勝中` : ''].filter(Boolean).join('・');
    ov.innerHTML = `<div class="ttj-rays"></div>
      <div class="ttj-banner"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <div class="ttj-card"><div class="ttj-lines"></div><div class="ttj-reel" hidden><div class="ttj-strip"></div><i></i></div>
        <div class="ttj-gain">+<span>0</span><small>XP</small></div>${lvHTML()}</div>
      <div class="ttj-tap">タップで閉じる</div>`;
    document.body.appendChild(ov);
    const seq = { skip: false, done: false, wake: null };
    const wait = ms => (seq.skip || !moving ? Promise.resolve() : new Promise(res => { const t = setTimeout(res, ms); seq.wake = () => { clearTimeout(t); res(); }; }));
    let timer = 0;
    const close = now => {
      if (!ov.isConnected || ov._closing) return;
      ov._closing = 1;
      clearTimeout(timer);
      window.removeEventListener('keydown', key, true);
      if (cur && cur.ov === ov) cur = null;
      mini(r);
      if (now || !motion()) { ov.remove(); return; }
      anim(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).then(() => ov.remove());
    };
    const skip = () => { if (seq.done) { close(); return; } seq.skip = true; if (seq.wake) seq.wake(); };
    const key = e => { if (['Enter', ' ', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); skip(); } };
    ov.addEventListener('click', skip);
    window.addEventListener('keydown', key, true);
    cur = { ov, seq, close };

    const card = ov.querySelector('.ttj-card'), lines = ov.querySelector('.ttj-lines'), gainEl = ov.querySelector('.ttj-gain span'), lv = ov.querySelector('.ttj-lv');
    paint(lv, levelOf(r.before).L, levelOf(r.before).cur / levelOf(r.before).need, levelOf(r.before).need - levelOf(r.before).cur);
    let shown = 0;
    const setGain = v => { shown = v; gainEl.textContent = fmt(v); };
    const countTo = (v, ms) => { const a = shown; return tween(ms, t => setGain(a + (v - a) * t), seq); };
    (async () => {
      if (moving) {
        anim(ov, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        anim(ov.querySelector('.ttj-banner'), [{ opacity: 0, scale: 2.6 }, { opacity: 1, scale: 0.9, offset: 0.6 }, { scale: 1 }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
        anim(card, [{ opacity: 0, translate: '0 40px' }, { opacity: 1, translate: '0 0' }], { duration: 420, delay: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
        setTimeout(() => {
          if (win) { flash('#fff', 0.5); shake(6); cannon(r.stars >= 4 || r.online ? 110 : 80); } else burst(ov.querySelector('.ttj-banner'), { kind: 'star', n: 30, colors: ['#fff', '#cfe0ff'], speed: 8 });
        }, 280);
      }
      (win ? SFX.win : SFX.draw)();
      await wait(560);
      let total = 1;
      for (let i = 0; i < r.lines.length; i++) {
        const l = r.lines[i];
        const chip = make('span', 'ttj-ln' + (l.k ? ' ttj-' + l.k : ''), `${esc(l.t)} <b>${esc(l.v)}</b>`);
        lines.appendChild(chip);
        total = i === 0 ? r.base : total * parseFloat(l.v.slice(1));
        if (!seq.skip && moving) {
          SFX.chip(i);
          anim(chip, [{ opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1.15, offset: 0.6 }, { scale: 1 }], { duration: 300, easing: 'ease-out' });
          if (l.k === 'hot') burst(chip, { kind: 'spark', n: 14, speed: 7 });
        }
        await countTo(total, 220);
        await wait(140);
      }
      // 運だめし（勝ったときはいつもリールを回す。引き分けなどは当たったときだけ）
      if (win || r.luck > 1) {
        const reel = ov.querySelector('.ttj-reel');
        reel.hidden = false;
        const pool = [1, 1, 1, 2, 1, 2, 5, 1, 2, 1];
        const items = [];
        for (let i = 0; i < 30; i++) items.push(pool[(i * 7 + (Math.random() * 10 | 0)) % pool.length]);
        const stop = 24;
        items[stop] = r.luck;
        if (r.luck === 1) { items[stop + 1] = 5; items[stop - 1] = 2; }   // あと少しで ×5
        await spin(reel, items.map(v => `<span class="${v >= 5 ? 'ttj-t4' : v >= 2 ? 'ttj-t3' : ''}">×${v}</span>`), stop, seq, 1400);
        if (r.luck > 1) {
          reel.classList.add('ttj-hit');
          const chip = make('span', 'ttj-ln ttj-luck', `${r.luck >= 5 ? '超大当たり' : '大当たり'} <b>×${r.luck}</b>`);
          lines.appendChild(chip);
          if (!seq.skip) {
            (r.luck >= 5 ? SFX.jackpot : SFX.coin)();
            anim(chip, [{ opacity: 0, scale: 0.2 }, { opacity: 1, scale: 1.3, offset: 0.6 }, { scale: 1 }], { duration: 420, easing: 'ease-out' });
            burst(reel, { kind: 'coin', n: r.luck >= 5 ? 40 : 22, speed: 10, colors: PAL.gold });
            if (r.luck >= 5) { flash('#ffd45a', 0.45); shake(9); rain({ kind: 'coin', n: 90, ms: 1400 }); }
          }
        } else if (!seq.skip) SFX.miss();
        await wait(r.luck > 1 ? 380 : 200);
      }
      await countTo(r.gain, 700);
      if (!seq.skip && moving) anim(ov.querySelector('.ttj-gain'), [{ scale: 1 }, { scale: 1.18 }, { scale: 1 }], { duration: 260, easing: 'ease-out' });
      await grow(lv, r.before, r.after, seq, 900);
      r.ach.forEach(achToast);
      seq.done = true;
      ov.classList.add('ttj-done');
      timer = setTimeout(() => close(), (r.ach.length ? 1200 : 0) + (moving ? 2600 : 4200));
    })();
  }

  // ゲームの結果の画面（ふつうは #dlg-result。o.into で変えられる）のいちばん上に、もらった XP とレベルを残す
  function mini(r) {
    const d = document.querySelector(`${r.into || '#dlg-result'} .dialog`);
    if (!d) return;
    let m = d.querySelector(':scope > .ttj-mini');
    if (!m) { m = make('div', 'ttj-mini'); d.insertBefore(m, d.firstChild); }
    const lv = levelOf(r.after);
    m.innerHTML = `${badge(lv.L, 'ttj-sm')}<span class="ttj-m"><span><span class="ttj-g">+${fmt(r.gain)}</span> XP${r.luck > 1 ? `（×${r.luck}）` : ''}${r.streak >= 2 && r.out === 'win' ? `・${r.streak}連勝中` : ''}</span><span class="ttj-bar"><i></i></span><span class="ttj-s"><span class="ttj-rk"></span><span class="ttj-nx"></span></span></span>`;
    paint(m, lv.L, lv.cur / lv.need, lv.need - lv.cur);
  }

  // ---------------------------------------------------------------- 盛り上がる瞬間（役・革命・ヨット など）。tier 1〜3
  function hype(text, at, o = {}) {
    if (o.quiet != null) quiet = !!o.quiet;
    const tier = o.tier || 1;
    if (!motion()) return;
    style();
    const p = pt(at);
    if (text) {   // 文字なしなら光と音だけ（ゲームが自分で文字を出しているとき）
      const s = make('span', 'ttj-hype');
      s.textContent = text;
      s.style.fontSize = (o.size || [0, 26, 34, 46][tier]) + 'px';
      document.body.appendChild(s);
      const w = s.offsetWidth, h = s.offsetHeight;
      s.style.left = Math.max(8, Math.min(innerWidth - w - 8, p.x - w / 2)) + 'px';
      s.style.top = Math.max(8, p.y - h / 2) + 'px';
      anim(s, [{ opacity: 0, scale: 2.2 }, { opacity: 1, scale: 0.92, offset: 0.18 }, { scale: 1, offset: 0.26 }, { opacity: 1, translate: '0 -10px', offset: 0.78 }, { opacity: 0, translate: '0 -22px' }],
        { duration: 1300 + tier * 200, easing: 'ease-out' }).then(() => s.remove());
      setTimeout(() => s.remove(), 2400);
    }
    burst(p, { kind: 'spark', n: 10 + tier * 10 });
    if (tier >= 2) { burst(p, { kind: 'star', n: 16 * tier, speed: 7 }); SFX.coin(); } else SFX.pop();
    if (tier >= 3) { flash('#fff3c0', 0.4); shake(8); burst(p, { kind: 'confetti', n: 80, speed: 12 }); SFX.jackpot(); }
  }

  // ---------------------------------------------------------------- 毎日のボーナス（トップのギフト）
  const PRIZES = [[50, 30], [100, 30], [150, 18], [300, 12], [500, 7], [1000, 3]];
  const dailyReady = () => P.bonus !== today();
  function daily() {
    if (!dailyReady()) return null;
    style();
    sync();
    const d = today();
    touchDay(d);
    const run = P.run, boost = +(1 + 0.1 * Math.min(run - 1, 5)).toFixed(1);
    let roll = Math.random() * PRIZES.reduce((a, p) => a + p[1], 0), prize = PRIZES[0][0];
    for (const [v, w] of PRIZES) { if ((roll -= w) < 0) { prize = v; break; } }
    const gain = Math.round(prize * boost), before = P.xp;
    P.xp += gain;
    P.bonus = d;
    const ach = check();
    save();
    emit();
    const moving = motion();
    const tier = v => (v >= 1000 ? 'ttj-t4' : v >= 300 ? 'ttj-t3' : v >= 150 ? 'ttj-t2' : '');
    const ov = make('div', 'ttj-ov ttj-win');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', '毎日のボーナス');
    ov.innerHTML = `<div class="ttj-rays"></div>
      <div class="ttj-banner"><b style="font-size:clamp(40px,11vw,76px)">デイリー</b><small>連続 ${run} 日目${boost > 1 ? `・ボーナス ×${boost}` : ''}</small></div>
      <div class="ttj-card"><div class="ttj-reel ttj-big"><div class="ttj-strip"></div><i></i></div>
        <div class="ttj-gain">+<span>0</span><small>XP</small></div>${lvHTML()}</div>
      <div class="ttj-tap">タップで閉じる</div>`;
    document.body.appendChild(ov);
    const seq = { skip: false, done: false };
    const lv = ov.querySelector('.ttj-lv'), gainEl = ov.querySelector('.ttj-gain span');
    const b0 = levelOf(before);
    paint(lv, b0.L, b0.cur / b0.need, b0.need - b0.cur);
    let timer = 0;
    const close = () => { if (!ov.isConnected || ov._closing) return; ov._closing = 1; clearTimeout(timer); window.removeEventListener('keydown', key, true); anim(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).then(() => ov.remove()); if (!motion()) ov.remove(); };
    const skip = () => { if (seq.done) close(); else seq.skip = true; };
    const key = e => { if (['Enter', ' ', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); skip(); } };
    ov.addEventListener('click', skip);
    window.addEventListener('keydown', key, true);
    return (async () => {
      if (moving) anim(ov.querySelector('.ttj-banner'), [{ opacity: 0, scale: 2 }, { opacity: 1, scale: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
      SFX.draw();
      const items = [];
      for (let i = 0; i < 34; i++) items.push(PRIZES[(Math.random() * PRIZES.length) | 0][0]);
      const stop = 27;
      items[stop] = prize;
      if (prize < 1000) items[stop + 1] = 1000;   // となりに大当たり
      await new Promise(res => setTimeout(res, moving ? 300 : 0));
      await spin(ov.querySelector('.ttj-reel'), items.map(v => `<span class="${tier(v)}">${v}</span>`), stop, seq, 2600);
      const reel = ov.querySelector('.ttj-reel');
      reel.classList.add('ttj-hit');
      if (prize >= 500) { SFX.jackpot(); flash('#ffd45a', 0.45); shake(8); rain({ kind: 'coin', n: prize >= 1000 ? 120 : 70, ms: 1400 }); } else SFX.coin();
      burst(reel, { kind: 'coin', n: prize >= 300 ? 34 : 18, speed: 10, colors: PAL.gold });
      await tween(800, t => { gainEl.textContent = fmt(gain * t); }, seq);
      await grow(lv, before, before + gain + ach.reduce((a, x) => a + RAR[x.rar][2], 0), seq, 900);
      ach.forEach(achToast);
      seq.done = true;
      ov.classList.add('ttj-done');
      timer = setTimeout(close, moving ? 3000 : 4200);
      return gain;
    })();
  }

  // ---------------------------------------------------------------- 実績と記録の一覧（トップから開く。ゲームからも開ける）
  function openAchievements() {
    style();
    sync();
    const st = state();
    const ov = make('div', 'ttj-ov ttj-draw');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', '実績と記録');
    const item = a => { const r = RAR[a.rar], ok = !!P.ach[a.id]; return `<div class="ttj-ach${ok ? '' : ' ttj-no'}" style="--rc:${r[1]}" title="${esc(r[0])}"><span class="ttj-ic">${ok ? ICON.trophy : ICON.lock}</span><span><b>${esc(a.name)}</b><small>${esc(a.desc)}・${r[0]}</small></span></div>`; };
    const general = ACH.filter(a => !a.game), per = ACH.filter(a => a.game);
    ov.innerHTML = `<div class="ttj-sheet">
      <button class="ttj-close" type="button" aria-label="閉じる">×</button>
      <h2>実績と記録</h2>
      ${lvHTML()}
      <div class="ttj-stats"><div><b>${fmt(st.n)}</b>局</div><div><b>${fmt(st.w)}</b>勝</div><div><b>${fmt(st.best)}</b>最多連勝</div><div><b>${st.achDone}<small style="font-size:11px;color:rgba(255,255,255,.6)">/${st.achTotal}</small></b>実績</div></div>
      <h3>全体</h3><div class="ttj-achs">${general.map(item).join('')}</div>
      <h3>ゲームごと</h3><div class="ttj-achs">${per.map(item).join('')}</div>
      <div class="ttj-row"><span>演出・アニメーション（全ゲーム共通）</span><button type="button" class="ttj-mo">${motion() ? 'オン' : 'オフ'}</button></div>
      <div class="ttj-row" style="border:0;margin-top:6px;padding-top:0"><span>記録はこの端末のブラウザだけに残ります。</span></div>
    </div>`;
    document.body.appendChild(ov);
    const lv = ov.querySelector('.ttj-lv');
    paint(lv, st.level, st.cur / st.need, st.need - st.cur);
    const close = () => { window.removeEventListener('keydown', key, true); anim(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).then(() => ov.remove()); if (!motion()) ov.remove(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('.ttj-close').addEventListener('click', close);
    ov.querySelector('.ttj-mo').addEventListener('click', e => { setMotion(!motion()); e.target.textContent = motion() ? 'オン' : 'オフ'; });
    window.addEventListener('keydown', key, true);
    anim(ov.querySelector('.ttj-sheet'), [{ opacity: 0, scale: 0.94, translate: '0 16px' }, { opacity: 1, scale: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.3,1.4,.5,1)' });
    ov.querySelector('.ttj-close').focus();
  }
  function setMotion(v) {
    if (window.TTMotion) TTMotion.set(v);
    else { try { localStorage.setItem('tt-motion', v ? '1' : '0'); } catch (e) { /* このページだけ */ } }
    sync();
    emit();
  }

  // ---------------------------------------------------------------- どのページでも効く手ごたえ
  // ダイアログ（.overlay）が開くとき、中の .dialog をはずませて出す
  function watch() {
    new MutationObserver(ms => {
      if (!motion()) return;
      for (const m of ms) {
        const el = m.target;
        if (m.oldValue === null || el.hidden || !el.classList || !el.classList.contains('overlay')) continue;
        const d = el.querySelector(':scope > .dialog');
        anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
        if (d) anim(d, [{ opacity: 0, scale: 0.93, translate: '0 16px' }, { opacity: 1, scale: 1, translate: '0 0' }], { duration: 260, easing: 'cubic-bezier(.3,1.4,.5,1)' });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
    // ボタンを押したら、ぷにっと縮んで戻る（ゲームの CSS の transition には触らない）
    document.addEventListener('pointerdown', e => {
      const b = e.target.closest && e.target.closest('.btn,.ibtn,.iconbtn,.onbtn,.ttj-btn');
      if (b && !b.disabled && motion()) anim(b, [{ scale: 1 }, { scale: 0.92, offset: 0.35 }, { scale: 1.03, offset: 0.75 }, { scale: 1 }], { duration: 260, easing: 'ease-out' });
    }, { capture: true, passive: true });
  }
  function boot() { style(); sync(); watch(); }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);

  function state() {
    const lv = levelOf(P.xp);
    return {
      xp: P.xp, level: lv.L, cur: lv.cur, need: lv.need, rank: rankOf(lv.L), streak: P.streak, best: P.best, n: P.n, w: P.w,
      run: P.day === today() || P.day === yesterday() ? P.run : 0, daily: dailyReady(), pickup: pickup(), games: P.g,
      achDone: ACH.filter(a => P.ach[a.id]).length, achTotal: ACH.length,
    };
  }

  window.TTJuice = {
    GAMES, here: HERE, result, hype, burst, rain, cannon, shake, flash, toast, daily, openAchievements, setMotion, badge, paint, state, offer, RAR,
    sfx: SFX, get motion() { return motion(); },
    on(f) { subs.add(f); return () => subs.delete(f); },
  };
})();
