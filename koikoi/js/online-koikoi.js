/* 花札こいこい: オンライン対戦（ロビー・対局の進め方・山札の公正な配り方）
 *
 * 2人の端末は「出来事」を名前つきで持ち合う（a0:mp1・a0:sh1・a0:e5・a0:d5 …。a0 は配り直しの回数）。
 * 届いた順番や重なりに関係なく、同じ出来事の集まりと自分の鍵から同じ局面を作り直せる（再読み込みにも強い）。
 *
 *   mp1  親: 48枚を親の鍵で暗号化して並べ替えたもの          mp2  子: それをさらに子の鍵で暗号化して並べ替えた山札 D
 *   sh0/sh1  各自: 相手の手札と場の札の場所の share（自分の鍵をはずした値）
 *   e<t>  手番の人の t 手目: 出す {k:'mv', a, hp: 手札の場所, hs: その share, ds: めくる札の share} / 取る札 {k:'pk'} / こいこい・勝負 {k:'kk'} / 手四 {k:'te'}
 *   d<t>  手番でない人: めくる札の share（これでお互いにめくった札がわかる）
 *   k0/k1 月の終わりの鍵（これでお互いのごまかしがないことを確かめる）
 * 配る場所: D[0..7] 子の手札・D[8..15] 場・D[16..23] 親の手札・D[24..47] 山札（47 から順にめくる）
 */
(function () {
  'use strict';
  window.KoikoiOnline = function (A) {
    const { S, K, $, esc, store } = A;
    const MP = window.KoikoiMP;
    if (!MP || !window.SSIHOnline || !SSIHOnline.available()) return null;
    const tick = () => new Promise(r => setTimeout(r, 0));
    async function chunk(arr, fn, per = 3) { const out = []; for (let i = 0; i < arr.length; i++) { out.push(fn(arr[i], i)); if (i % per === per - 1) await tick(); } return out; }
    const lobby = A.lobby;
    let roomCode = A.roomCode;
    // 対局の途中の状態: タブごと（sessionStorage）に置き、新しいタブ用に localStorage にも置く
    const saved = {
      get() { try { const v = sessionStorage.getItem('koikoi-online'); if (v) return JSON.parse(v); } catch (e) { /* なし */ } return store.get('online', null); },
      set(v) { try { if (v == null) sessionStorage.removeItem('koikoi-online'); else sessionStorage.setItem('koikoi-online', JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } store.set('online', v); },
    };
    let net = null;
    const PR = {};      // 月ごとの手順の状態（保存しない。出来事から作り直す）
    const keyName = (idx, at) => `mpk-${S.online.mid}-${S.online.me}-${idx}-${at}`;

    // ------------------------------------------------------------------ 出来事
    const evOf = idx => (S.online.rounds[idx] || (S.online.rounds[idx] = {}));
    function sendEv(idx, k, b) {
      const ev = evOf(idx);
      if (ev[k]) return;
      b.by = S.online.me;
      ev[k] = b;
      if (net) net.send({ t: 'ev', i: idx, k, b });
      publish();
      saveLocal();
    }
    // 相手が作った出来事だけを受け取る（自分の出来事は自分の端末に保存してある）
    function gotEv(idx, k, b) {
      if (typeof idx !== 'number' || typeof k !== 'string' || !b || typeof b !== 'object' || b.by !== (S.online.me ^ 1)) return;
      const ev = evOf(idx);
      if (ev[k]) return;
      ev[k] = b;
      saveLocal();
      drive();
    }
    // つなぎ直したとき: 切れている間に送れなかったかもしれない自分の出来事を送り直す（相手は同じ名前のものを捨てる）
    function resendMine() {
      const o = S.online;
      if (!o || !net) return;
      Object.keys(o.rounds).map(Number).sort((a, b) => b - a).slice(0, 2).forEach(i => {
        for (const [k, b] of Object.entries(o.rounds[i])) if (b && b.by === o.me) net.send({ t: 'ev', i, k, b });
      });
    }
    // 保持メッセージ（相手が再読み込みしても追いつけるように、知っている出来事をすべて）
    let pubTimer = 0;
    function publish() {
      clearTimeout(pubTimer);
      pubTimer = setTimeout(() => { if (net && S.online) net.saveState(state()); }, 150);
    }
    function state() {
      const o = S.online;
      if (!o) return {};
      const rounds = {};
      Object.keys(o.rounds).map(Number).sort((a, b) => b - a).slice(0, 2).forEach(i => { rounds[i] = o.rounds[i]; });
      return { v: 1, mid: o.mid, months: o.months, fd: o.firstDealer, rounds, over: !!(S.match && S.match.over) };
    }
    function saveLocal() {
      const o = S.online;
      if (!o) return;
      const rounds = {};
      Object.keys(o.rounds).map(Number).sort((a, b) => b - a).slice(0, 2).forEach(i => { rounds[i] = o.rounds[i]; });
      saved.set({ mid: o.mid, me: o.me, opp: o.opp, months: o.months, firstDealer: o.firstDealer, myHints: S.hints, rounds,
        match: S.match ? { totals: S.match.totals, history: S.match.history, dealer: S.match.dealer } : null, t: Date.now() });
    }

    // ------------------------------------------------------------------ 手順を進める
    let driving = false, again = false;
    async function drive() {
      if (driving) { again = true; return; }
      driving = true;
      try { do { again = false; await step(); } while (again); } catch (e) { console.error(e); } finally { driving = false; }
    }
    function pr(idx) { return PR[idx] || (PR[idx] = { idx, at: 0, key: null, t: 0, played: new Set(), dealt: false, verified: null }); }
    function myKey(p) {
      if (p.key && p.keyAt === p.at) return p.key;
      const name = keyName(p.idx, p.at);
      const h = store.get(name, null);
      p.key = h ? MP.keyFromHex(h) : MP.makeKey();
      p.keyAt = p.at;
      if (!h) store.set(name, MP.keyToHex(p.key));
      return p.key;
    }
    const handPos = (seat, dealer) => (seat === dealer ? [16, 17, 18, 19, 20, 21, 22, 23] : [0, 1, 2, 3, 4, 5, 6, 7]);
    const FIELD = [8, 9, 10, 11, 12, 13, 14, 15];

    async function step() {
      const o = S.online;
      if (!o || !S.match) return;
      // 終わった月: 鍵を見せ合って確かめる
      const r = S.round;
      if (r && r.phase === 'end' && r.idx != null && PR[r.idx] && PR[r.idx].dealt) await finishRound(r);
      if (S.match.over) return;
      const playing = r && r.phase !== 'end' && r.idx === S.match.monthIndex;
      const idx = playing ? r.idx : S.match.monthIndex;
      const p = pr(idx);
      const ev = evOf(idx);
      const me = o.me, dealer = S.match.dealer, ko = dealer ^ 1;
      if (!p.dealt) {
        // 配り直しの回数を出来事から決める
        const A0 = `a${p.at}:`;
        if (!ev[A0 + 'mp1']) {
          if (me === dealer && !p.busy) { p.busy = true; const key = myKey(p); const d1 = await deferred(() => MP.step1(key)); p.busy = false; sendEv(idx, A0 + 'mp1', { deck: d1 }); again = true; }
          return setWait(me === dealer ? '札を混ぜています…' : '相手が札を混ぜています…');
        }
        if (!ev[A0 + 'mp2']) {
          if (me === ko && !p.busy) {
            p.busy = true;
            let d2 = null;
            try { const key = myKey(p); d2 = await deferred(() => MP.step2(ev[A0 + 'mp1'].deck, key)); } catch (e) { cheat('相手の配った山札が正しくありません'); }
            p.busy = false;
            if (d2) { sendEv(idx, A0 + 'mp2', { deck: d2 }); again = true; }
          }
          return setWait(me === ko ? '札を混ぜています…' : '相手が札を混ぜています…');
        }
        const D = ev[A0 + 'mp2'].deck;
        if (!Array.isArray(D) || D.length !== 48) return cheat('山札の形が正しくありません');
        const opp = me ^ 1;
        if (!ev[A0 + 'sh' + me] && !p.busy) {
          p.busy = true;
          const key = myKey(p), pos = handPos(opp, dealer).concat(FIELD), sh = {};
          await chunk(pos, i => { sh[i] = MP.share(D[i], key); });
          p.busy = false;
          sendEv(idx, A0 + 'sh' + me, { s: sh });
        }
        const osh = ev[A0 + 'sh' + opp];
        if (!osh) return setWait('相手の配りを待っています…');
        // 自分の手札と場の札を開く
        const key = myKey(p), order = new Array(48).fill(-1);
        const mine = handPos(me, dealer);
        let bad = false;
        await chunk(mine.concat(FIELD), i => { const s = osh.s && osh.s[i]; let c = -1; try { c = MP.open(s, key); } catch (e) { /* 下で */ } if (c < 0) bad = true; order[i] = c; });
        if (bad) return cheat('配られた札が開けません');
        const field = FIELD.map(i => order[i]);
        if (K.fieldVoid(field)) {
          // 場に同じ月が4枚など: 配り直し（新しい鍵で最初から）
          p.at++; p.key = null;
          again = true;
          return;
        }
        if (idx > 0 && !o.ready) return setWait('');
        if (ev[A0 + 'mp1'].by !== dealer || ev[A0 + 'mp2'].by !== ko) return cheat('札を混ぜた人が正しくありません');
        p.order = order; p.D = D; p.dealt = true; p.t = 0; p.played = new Set();
        o.waiting = null;
        o.ready = false;
        A.setNote('');
        await A.startRound(order, idx);
        return;
      }
      if (!playing || S.busy) return;
      // 手番の出来事を順に
      await playTurns(idx, p, false);
    }
    // 重い計算（96回のべき乗など）は少し待ってから（画面の更新を先に）
    const deferred = fn => new Promise(res => setTimeout(() => res(fn()), 30));
    function setWait(t) { if (S.online.waitNote !== t) { S.online.waitNote = t; A.setNote(t); } }

    // 手番の出来事を局面に当てる（live: 札を動かして見せる）
    async function playTurns(idx, p, sync) {
      const o = S.online, r = S.round, ev = evOf(idx), A0 = `a${p.at}:`;
      const me = o.me;
      for (;;) {
        if (r.phase === 'end' || (!sync && S.busy)) return;
        const t = p.t, actor = r.turn, e = ev[A0 + 'e' + t];
        if (!e) {
          if (actor === me) { o.waiting = null; if (!sync) autoTeshi(idx, p); }
          else if (!sync) { A.setNote(''); }
          return;
        }
        if (e.by !== actor) return cheat('手番でない人の手が届きました');
        let a = e.a;
        if (e.k === 'te') {
          const pos = handPos(actor, r.dealer);
          let cards;
          if (actor === me) cards = pos.map(i => p.order[i]);
          else {
            try { cards = pos.map(i => MP.open(e.s[i], myKey(p))); } catch (err) { return cheat('手四・くっつきの札が開けません'); }
          }
          if (cards.some(c => c < 0) || !r.declareHand(actor, cards)) return cheat('手四・くっつきが正しくありません');
          p.t++;
          if (sync) return;
          A.onRoundEnd();
          return;
        }
        if (e.k === 'mv') {
          if (r.phase !== 'play' || !K.isPlay(a)) return cheat('手の順番が合いません');
          const c = K.playCard(a), f = K.playTarget(a);
          const j = 24 + r.deck.length - 1;
          let cj;
          if (actor === me) {
            const d = ev[A0 + 'd' + t];
            if (!d) { o.waiting = t; if (!sync) A.setNote('相手の確認を待っています…'); return; }
            try { cj = MP.open(d.s, myKey(p)); } catch (err) { cj = -1; }
          } else {
            // 相手の手: 出した札が相手の手札の場所のものか・その札か・取る札が合っているか
            const pos = handPos(actor, r.dealer);
            if (!pos.includes(e.hp) || p.played.has(e.hp)) return cheat('出した札の場所が正しくありません');
            let c2 = -1;
            try { c2 = MP.open(e.hs, myKey(p)); } catch (err) { /* 下で */ }
            if (c2 !== c || seen(r, c)) return cheat('出した札が正しくありません');
            const ms = r.matches(c);
            if ((ms.length === 2) !== (f >= 0) || (f >= 0 && !ms.includes(f))) return cheat('取る札が正しくありません');
            if (!ev[A0 + 'd' + t]) sendEv(idx, A0 + 'd' + t, { s: MP.share(p.D[j], myKey(p)) });
            try { cj = MP.open(e.ds, myKey(p)); } catch (err) { cj = -1; }
            p.played.add(e.hp);
          }
          if (cj < 0 || seen(r, cj) || cj === c) return cheat('めくった札が正しくありません');
          r.setTop(cj);
          if (actor === me) p.played.add(e.hp);
          p.t++;
          o.waiting = null;
          if (sync) { r.step(a); continue; }
          A.setNote('');
          await A.act(a, true);
          return;
        }
        if (e.k === 'pk' || e.k === 'kk') {
          if (!r.isLegal(a)) return cheat('手が正しくありません');
          p.t++;
          if (sync) { r.step(a); continue; }
          await A.act(a, true);
          return;
        }
        return cheat('知らない手です');
      }
    }
    // 見えている札か（同じ札が2度出てくるごまかしを見つける）
    function seen(r, c) {
      return r.field.includes(c) || r.caps[0].includes(c) || r.caps[1].includes(c) || r.hands[0].includes(c) || r.hands[1].includes(c) || r.pending === c;
    }
    // 配られた手札に手四・くっつきがあれば、最初の手番で名乗る
    function autoTeshi(idx, p) {
      const r = S.round, me = S.online.me;
      if (!r.rules.teshi || r.hands[me].length !== 8 || r.log.some(e => e.p === me)) return;
      if (!K.handYaku(r.hands[me])) return;
      const pos = handPos(me, r.dealer), key = myKey(p), s = {};
      pos.forEach(i => { s[i] = MP.share(p.D[i], key); });
      sendEv(idx, `a${p.at}:e${p.t}`, { k: 'te', s });
      drive();
    }

    // 自分の手（画面から）
    function myAction(a) {
      const o = S.online, r = S.round;
      if (!o || !r || r.phase === 'end' || r.turn !== o.me || o.waiting != null || !r.isLegal(a)) return;
      const idx = r.idx, p = PR[idx], A0 = `a${p.at}:`;
      if (evOf(idx)[A0 + 'e' + p.t]) return;
      if (K.isPlay(a)) {
        const c = K.playCard(a), hp = p.order.indexOf(c), j = 24 + r.deck.length - 1, key = myKey(p);
        o.waiting = p.t;
        sendEv(idx, A0 + 'e' + p.t, { k: 'mv', a, hp, hs: MP.share(p.D[hp], key), ds: MP.share(p.D[j], key) });
        A.setNote('相手の確認を待っています…');
        A.render();
      } else sendEv(idx, A0 + 'e' + p.t, { k: K.isPick(a) ? 'pk' : 'kk', a });
      drive();
    }

    // 月の終わり: 鍵を見せ合い、相手の配り方・share・出した札を確かめる
    async function finishRound(r) {
      const o = S.online, idx = r.idx, p = PR[idx], ev = evOf(idx), A0 = `a${p.at}:`, me = o.me, opp = me ^ 1;
      if (!ev[A0 + 'k' + me]) sendEv(idx, A0 + 'k' + me, { key: MP.keyToHex(myKey(p)) });
      const ok = ev[A0 + 'k' + opp];
      if (!ok || p.verified != null || p.verifying) return;
      p.verifying = true;
      let good = true;
      try {
        const kh = ok.key, kE = MP.keyFromHex(kh).e;
        const d1 = ev[A0 + 'mp1'].deck, D = ev[A0 + 'mp2'].deck;
        await tick();
        if (opp === r.dealer) good = MP.verifyStep1(d1, kh); else good = MP.verifyStep2(d1, D, kh);
        await tick();
        const sh = ev[A0 + 'sh' + opp].s;
        for (const i of Object.keys(sh)) { if (!MP.checkShare(D[+i], sh[i], kE)) { good = false; break; } }
        await tick();
        // 相手が出した手の share と、相手が返しためくる札の share
        for (let t = 0; good && ev[A0 + 'e' + t]; t++) {
          const e = ev[A0 + 'e' + t], dd = ev[A0 + 'd' + t];
          if (e.k !== 'mv') continue;
          // e を出した人の share は e.hs・e.ds、もう一人の share は dd.s
          const j = drawPosAt(ev, A0, t);
          if (e.by === me) { if (dd && !MP.checkShare(D[j], dd.s, kE)) good = false; }
          else if (!MP.checkShare(D[e.hp], e.hs, kE) || !MP.checkShare(D[j], e.ds, kE)) good = false;
          if (t % 4 === 3) await tick();
        }
      } catch (e) { good = false; }
      p.verified = good;
      p.verifying = false;
      if (!good) cheat('鍵を見せ合ったところ、相手の配り方に食い違いがありました');
      else { A.renderInfo(); }
    }
    // t 手目でめくった山札の場所（t より前の「出す」手の数から）
    function drawPosAt(ev, A0, t) {
      let plays = 0;
      for (let u = 0; u < t; u++) { const e = ev[A0 + 'e' + u]; if (e && e.k === 'mv') plays++; }
      return 47 - plays;
    }
    function cheat(msg) {
      const o = S.online;
      if (!o || o.cheat) return;
      o.cheat = msg;
      A.setNote(`⚠ ${msg}（通信の不具合か、不正の可能性があります）`);
      A.renderInfo();
    }

    // ------------------------------------------------------------------ 対局の始まり・終わり
    const hashDealer = mid => { let h = 0; for (const ch of String(mid)) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 3) & 1; };
    function startOnline(g) {
      $('dlg-online').hidden = true;
      const months = g.r && [3, 6, 12].includes(+g.r.m) ? +g.r.m : 12;
      S.online = {
        mid: g.mid, me: g.myColor ? 1 : 0, opp: { id: g.opp.id, name: String(g.opp.name || 'ゲスト').slice(0, 16), ai: g.opp.ai | 0, hints: 0 },
        oppPresent: true, lostAt: 0, netState: 'on', months, firstDealer: hashDealer(g.mid), rounds: {}, ready: true, waiting: null, myRe: false, oppRe: false, cheat: null,
      };
      Object.keys(PR).forEach(k => delete PR[k]);
      cleanKeys(g.mid);
      const seats = S.online.me === 0 ? ['human', 'remote'] : ['remote', 'human'];
      A.newMatch({ mode: 'online', months, rules: {} }, { online: true, seats, me: S.online.me, dealer: S.online.firstDealer });
      A.render && S.round && A.render();
      saveLocal();
      KoikoiSound.slap();
      drive();
    }
    function leave() {
      if (net && net.game) net.leaveGame();
      if (S.online) { S.online = null; saved.set(null); }
      cleanKeys(null);
    }
    // 終わった対局の鍵を消す（keep の対局の鍵だけ残す）
    function cleanKeys(keep) {
      try {
        Object.keys(localStorage).filter(k => k.startsWith('koikoi-mpk-') && (!keep || !k.startsWith(`koikoi-mpk-${keep}-`))).forEach(k => localStorage.removeItem(k));
      } catch (e) { /* 消せなくても動く */ }
    }
    // 再読み込みしたとき: 保存していた対局に戻る
    function resume() {
      const sv = saved.get();
      cleanKeys(sv && sv.mid);
      if (!sv || !sv.mid || !sv.match || Date.now() - (sv.t || 0) > 6 * 3600 * 1000) return false;
      S.online = { mid: sv.mid, me: sv.me, opp: Object.assign({ hints: 0 }, sv.opp), oppPresent: true, lostAt: 0, netState: 'connecting', months: sv.months, firstDealer: sv.firstDealer, rounds: sv.rounds || {}, ready: true, waiting: null, myRe: false, oppRe: false, cheat: null };
      const seats = sv.me === 0 ? ['human', 'remote'] : ['remote', 'human'];
      A.newMatch({ mode: 'online', months: sv.months, rules: {} }, { online: true, seats, me: sv.me, dealer: sv.firstDealer });
      Object.assign(S.match, { totals: sv.match.totals, history: sv.match.history, dealer: sv.match.dealer });
      S.hints = sv.myHints | 0;
      if (S.match.over) { leave(); return false; }
      rebuild();
      if (net) net.rejoin({ mid: sv.mid, myColor: sv.me, opp: { id: sv.opp.id || '', name: sv.opp.name, ai: sv.opp.ai } });
      return true;
    }
    // いまの月を出来事から作り直す（札は動かさない）
    function rebuild() {
      const idx = S.match.monthIndex, ev = evOf(idx);
      const p = pr(idx);
      // 配り直しの回数: 鍵が保存されている一番新しいもの
      for (let at = 0; at < 10; at++) if (store.get(keyName(idx, at), null) && ev[`a${at}:mp1`]) p.at = at;
      const A0 = `a${p.at}:`, me = S.online.me, dealer = S.match.dealer;
      const D = ev[A0 + 'mp2'] && ev[A0 + 'mp2'].deck, osh = ev[A0 + 'sh' + (me ^ 1)];
      if (!D || !osh || !ev[A0 + 'sh' + me]) { A.setNote('つなぎ直しています…'); return; }
      const key = myKey(p), order = new Array(48).fill(-1);
      try { handPos(me, dealer).concat(FIELD).forEach(i => { order[i] = MP.open(osh.s[i], key); }); } catch (e) { return; }
      const r = S.match.startRound(order);
      if (!r) return;
      r.idx = idx;
      Object.assign(p, { order, D, dealt: true, t: 0, played: new Set() });
      S.round = r; S.slots = r.field.slice(); S.log = []; S.roundEnded = null;
      playTurns(idx, p, true);
      r.log.forEach(e => S.log.push({ p: e.p, k: e.k, c: e.c, took: e.took ? e.took.slice() : [] }));
      S.frame = A.frameOf(r);
      A.render();
      if (r.phase === 'end') A.onRoundEnd();
      else A.schedule();
    }
    function nextRound() {
      if (!S.online) return;
      S.online.ready = true;
      drive();
    }

    // ------------------------------------------------------------------ 通信
    function init() {
      net = SSIHOnline.create({
        game: 'koikoi',
        onStatus: st => {
          renderBadge(); renderLobby();
          if (S.online) { S.online.netState = st; if (st === 'on') S.online.lostAt = S.online.oppPresent ? 0 : Date.now(); A.renderInfo(); A.renderBars(); if (st === 'on') { resendMine(); publish(); drive(); } }
        },
        onPresence: () => { renderBadge(); renderLobby(); tryRoom(); },
        onMatch: g => startOnline(g),
        onRemote: m => onRemote(m),
        onOppPresence: v => { if (S.online) { S.online.oppPresent = v; S.online.lostAt = v ? 0 : Date.now(); A.renderInfo(); A.renderBars(); } },
        onChallenge: r => { lobby.msg = r === 'no' ? 'その人はもう別の対局を始めていました' : '返事がありませんでした（相手の通信が切れているかもしれません）'; renderLobby(); },
      });
      net.setName(A.getMyName());
      net.setAI(A.aiFlags());
      net.connect();
      api.net = net;
      setInterval(() => { if (S.online && !S.online.oppPresent) A.renderInfo(); }, 10000);
    }
    function onRemote(msg) {
      const o = S.online;
      if (!o || !msg) return;
      if (msg.t === 'hi') {
        if (msg.n) o.opp.name = String(msg.n).slice(0, 16);
        o.opp.ai = msg.ai | 0;
        if (!msg.re) net.send({ t: 'hi', re: 1, n: A.getMyName(), ai: A.aiFlags() });
        saveLocal(); A.renderBars();
        publish();
      } else if (msg.t === 'ai') { o.opp.ai = msg.ai | 0; saveLocal(); A.renderBars(); }
      else if (msg.t === 'hint') { o.opp.hints = (o.opp.hints | 0) + 1; saveLocal(); A.renderBars(); }
      else if (msg.t === 'ev') gotEv(msg.i, msg.k, msg.b);
      // 保持メッセージ（common/online.js の saveState は時刻を t に入れるので、t が 'state' でなく数のこともある）
      else if ((msg.t === 'state' || typeof msg.t === 'number') && msg.v === 1 && msg.rounds && typeof msg.rounds === 'object') {
        for (const [i, ev] of Object.entries(msg.rounds)) {
          if (!ev || typeof ev !== 'object') continue;
          const mine = evOf(+i);
          for (const [k, b] of Object.entries(ev)) if (!mine[k] && b && typeof b === 'object' && b.by === (o.me ^ 1)) mine[k] = b;
        }
        saveLocal();
        if (!S.round || S.round.idx == null) rebuild();
        drive();
      } else if (msg.t === 'resign') {
        if (!S.match.over) A.oppResigned();
      } else if (msg.t === 're') { o.oppRe = true; maybeRematch(); A.renderInfo(); }
      else if (msg.t === 'rego' && typeof msg.mid === 'string') {
        net.start({ mid: msg.mid.slice(0, 20), myColor: msg.oc ? 1 : 0, r: { m: o.months }, opp: { id: msg.from, name: o.opp.name, ai: o.opp.ai } });
      }
    }
    function rematch() {
      const o = S.online;
      if (!o || !net) return;
      o.myRe = true;
      net.send({ t: 're' });
      maybeRematch();
      A.setNote(`${esc(o.opp.name)}さんの返事を待っています…`);
    }
    function maybeRematch() {
      const o = S.online;
      if (!o || !o.myRe || !o.oppRe || !net || !net.game) return;
      const oppId = net.game.oppId;
      if (oppId && net.id > oppId) return; // 相手が作るのを待つ
      const mid = Math.random().toString(36).slice(2, 12);
      net.send({ t: 'rego', mid, oc: o.me });
      net.start({ mid, myColor: o.me ^ 1, r: { m: o.months }, opp: { id: oppId, name: o.opp.name, ai: o.opp.ai } });
    }
    function claim() { if (S.online && !S.match.over) A.oppResigned('相手の接続切れ'); }

    // ------------------------------------------------------------------ ロビー
    function tryRoom() {
      if (!roomCode || !net || net.status !== 'on' || net.game) return;
      const p = net.list().find(x => x.s === 'wait' && x.g === 'koikoi' && x.c === roomCode.toUpperCase());
      if (!p) return;
      roomCode = null;
      history.replaceState(null, '', location.pathname);
      lobby.msg = `${p.n}さんに申し込みました…`;
      net.challenge(p.id);
      renderLobby();
    }
    function open() {
      $('dlg-online').hidden = false;
      renderLobby();
    }
    function renderBadge() {
      const b = $('btn-online');
      if (!b) return;
      const st = net ? net.status : 'off';
      b.dataset.st = st;
      const c = net && st === 'on' ? net.counts() : null;
      const g = c && c.byGame.koikoi;
      b.querySelector('.cnt').innerHTML = c ? `${c.online}人<small>・待ち${g ? g.wait : 0}</small>` : st === 'connecting' ? '…' : '';
    }
    function renderLobby() {
      if ($('dlg-online').hidden) return;
      const st = net ? net.status : 'off', c = net ? net.counts() : null, me = net ? net.me : null;
      const g = c && c.byGame.koikoi;
      const num = v => (st === 'on' && c ? v : '—');
      const waits = net && st === 'on' ? net.list().filter(p => p.s === 'wait' && p.g === 'koikoi') : [];
      const waiting = me && me.s === 'wait';
      const link = me && me.c ? `${location.origin}${location.pathname}?room=${me.c}` : '';
      const seg = (name, items, val) => `<div class="seg" data-seg="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
      const ml = m => `${[3, 6, 12].includes(+m) ? +m : 12}か月`;
      $('on-body').innerHTML = `
        <div class="on-stats">
          <div class="stat"><b>${num(c && c.online)}</b><span>オンライン</span></div>
          <div class="stat"><b>${num(g ? g.wait : 0)}</b><span>こいこいの対戦待ち</span></div>
          <div class="stat"><b>${num(g ? g.play : 0)}</b><span>対局中</span></div>
          <span class="on-conn" data-st="${st}">${st === 'on' ? '● つながっています' : st === 'error' ? 'つながりません（通信を確かめてください）' : 'つないでいます…'}</span>
        </div>
        ${lobby.msg ? `<p class="on-msg">${esc(lobby.msg)}</p>` : ''}
        <div class="field-row"><span class="lab">あなたの名前（相手に表示）</span><input class="text" id="on-name" maxlength="16" value="${esc(A.getMyName())}" autocomplete="nickname"></div>
        <div class="field-row"><span class="lab">あなたの AI補助（相手に表示されます）</span>
          <div class="on-ai">${A.aiTagHTML(A.aiFlags(), 0)}<button class="btn small" data-act="ai">${A.aiFlags() ? 'オフにする' : 'オンにする'}</button></div></div>
        <div class="field-row"><span class="lab">対戦を待っている人（${waits.length}人）</span>
          <div class="on-list">${waits.length ? waits.map(p => `<div class="on-row"><b>${esc(p.n)}</b><span class="hint">${esc(ml(p.r && p.r.m))}</span>${A.aiTagHTML(p.ai | 0, 0)}<button class="btn small primary" data-ch="${esc(p.id)}">対戦する</button></div>`).join('')
            : '<p class="hint" style="margin:0">いま対戦を待っている人はいません。下の「この設定で待つ」で相手を待てます。</p>'}</div></div>
        <div class="field-row"><span class="lab">${waiting ? '相手を待っています' : '自分が相手を待つ'}</span>
          ${waiting ? `<div class="on-wait"><span><b>${esc(ml(me.r && me.r.m))}</b>で待っています…　部屋コード <b class="code">${esc(me.c)}</b></span>
              <span class="row-actions"><button class="btn small" data-act="copy">招待リンクをコピー</button><button class="btn small" data-act="unwait">待つのをやめる</button></span>
              <span class="hint">友達にリンクを送ると、開いた時点で対局が始まります（${esc(link)}）</span></div>`
            : `${seg('m', [[12, '12か月'], [6, '6か月'], [3, '3か月']], lobby.months)}
               <div style="margin-top:8px"><button class="btn primary" data-act="wait"${st === 'on' ? '' : ' disabled'}>この設定で待つ</button></div>`}
        </div>
        <p class="hint" style="margin:0">ルールは標準（「ルール」のページ）。山札は2人の端末が暗号の鍵を出し合って混ぜるので、どちらも山札の並びと相手の手札を知りません。公開の中継サーバーを使うため、名前はほかの人からも見える可能性があります。オンラインでは「待った」はできません。</p>`;
    }
    function lobbyClick(e) {
      const b = e.target.closest('button');
      if (!b || !net) return;
      if (b.dataset.ch) { lobby.msg = '申し込みました。返事を待っています…'; net.challenge(b.dataset.ch); renderLobby(); return; }
      if (b.closest('[data-seg="m"]')) { lobby.months = +b.dataset.v; renderLobby(); return; }
      const act = b.dataset.act;
      if (act === 'wait') { net.wait({ m: lobby.months }, `${lobby.months}か月`); lobby.msg = ''; renderLobby(); }
      else if (act === 'unwait') { net.unwait(); renderLobby(); }
      else if (act === 'copy') {
        const link = `${location.origin}${location.pathname}?room=${net.me.c}`;
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => { lobby.msg = '招待リンクをコピーしました'; renderLobby(); }, () => { lobby.msg = link; renderLobby(); });
      } else if (act === 'ai') A.toggleAI();
    }

    const api = { net: null, init, open, lobbyClick, myAction, state, nextRound, leave, rematch, claim, resume, drive, renderLobby, renderBadge, afterStep: () => drive(), debugPR: () => PR };
    return api;
  };
})();
