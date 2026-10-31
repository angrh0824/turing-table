/* 全ゲーム共通のオンライン（公開の MQTT 中継サーバー経由。自前のサーバーはいらない）
 *
 *   <script src="../common/online.js"></script>
 *   const net = SSIHOnline.create({ game: 'reversi', onStatus, onPresence, onMatch, onRemote, onOppPresence, onChallenge });
 *   net.setName('たろう'); net.setAI(flags); net.connect();
 *
 * トピック（すべて NS の下）:
 *   p/<id>      在席（保持メッセージ）: {id, n:名前, g:ゲーム, s:'idle'|'wait'|'play', ai:AI補助のビット(1=形勢 2=最善手), r:待つ条件(ゲームが決める小さな JSON), rl:その説明, c:部屋コード, m:対局ID, t:時刻, v}
 *               切断すると中継サーバーが空の保持メッセージ（遺言）を出して消える。30秒ごとに更新、古いものは数えない
 *   i/<id>      その人あての連絡: 申し込み {t:'ch'}・受け付け {t:'ok'}・お断り {t:'no'}
 *   g/<mid>     2人対局の連絡（指し手・投了・AI補助・ヒント・もう一局 など。中身はゲームが決める）
 *   g/<mid>/s   2人対局の今の状態（保持メッセージ。再読み込み・取りこぼしで追いつく）
 *   r/<room>/…  多人数の卓などの汎用の部屋（room(id).pub / sub）
 *
 * 2人ゲームの流れ: wait(r, rl) で対戦待ち → だれかが challenge(id) → 待っていた側が自動で受け、先後をランダムに決めて onMatch
 * 中継サーバーは公開のもの（だれでも読み書きできる）。名前と指し手はほかの人からも見える可能性がある。受け取った手は必ず合法か確かめること
 */
(function () {
  'use strict';
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.10.1/mqtt.min.js';
  const NS = 'ssih-angrh0824/v1';
  const STALE = 100 * 1000;   // これより古い在席は数えない
  const BEAT = 30 * 1000;     // 在席の更新間隔
  const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
  const rid = n => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[Math.floor(Math.random() * ALPHA.length)]; return s; };
  const code4 = () => rid(4).toUpperCase();

  // オンラインにつないでよい場所か（claude.ai のアーティファクトなどでは外部へつなげない）
  const available = () => /^https?:$/.test(location.protocol) && !/claude|anthropic/i.test(location.hostname);

  function loadLib() {
    if (window.mqtt) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LIB; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error('通信の部品を読み込めませんでした'));
      document.head.appendChild(s);
    });
  }

  function create(h) {
    h = h || {};
    const me = { id: 'u' + rid(9), name: '', g: h.game || 'hub', s: 'idle', ai: 0, r: null, rl: '', c: '', m: '' };
    const peers = new Map();
    const roomSubs = new Map(); // topic → Set(cb)
    let client = null, status = 'off', brokerIdx = 0, game = null, pending = null, oppPresent = null, timersOn = false;
    const T = sub => `${NS}/${sub}`;
    const call = (name, ...a) => { if (h[name]) try { h[name](...a); } catch (e) { console.error(e); } };
    const setStatus = s => { status = s; call('onStatus', s); };

    function list() {
      const now = Date.now(), out = [];
      peers.forEach(p => { if (now - (p.t || 0) < STALE || now - p.seen < STALE) out.push(p); });
      return out;
    }
    // 全体とゲームごとの人数（自分も含む）: { online, wait, play, byGame: { slug: {online, wait, play} } }
    function counts() {
      const all = list().concat(status === 'on' ? [Object.assign({ self: true }, me, { n: me.name })] : []);
      const byGame = {};
      for (const p of all) {
        const g = byGame[p.g || 'hub'] || (byGame[p.g || 'hub'] = { online: 0, wait: 0, play: 0 });
        g.online++; if (p.s === 'wait') g.wait++; if (p.s === 'play') g.play++;
      }
      return { online: all.length, wait: all.filter(p => p.s === 'wait').length, play: all.filter(p => p.s === 'play').length, byGame };
    }
    function publishMe() {
      if (!client || !client.connected) return;
      const body = { id: me.id, n: me.name || 'ゲスト', g: me.g, s: me.s, ai: me.ai, t: Date.now(), v: 1 };
      if (me.s === 'wait') { body.r = me.r; body.rl = me.rl; body.c = me.c; }
      if (me.s === 'play') body.m = me.m;
      client.publish(T(`p/${me.id}`), JSON.stringify(body), { retain: true, qos: 1 });
    }
    function send(sub, body) { if (client && client.connected) client.publish(T(sub), JSON.stringify(body), { qos: 1 }); }

    async function connect() {
      if (client || !available()) { if (!available()) setStatus('unavailable'); return; }
      setStatus('connecting');
      try { await loadLib(); } catch (e) { setStatus('error'); return; }
      client = window.mqtt.connect(BROKERS[brokerIdx], {
        clientId: me.id, clean: true, keepalive: 30, reconnectPeriod: 4000, connectTimeout: 8000,
        will: { topic: T(`p/${me.id}`), payload: '', retain: true, qos: 1 },
      });
      let ever = false;
      const failTimer = setTimeout(() => {
        if (!ever && brokerIdx + 1 < BROKERS.length) { try { client.end(true); } catch (e) { /* 無視 */ } client = null; brokerIdx++; connect(); }
      }, 9000);
      client.on('connect', () => {
        ever = true; clearTimeout(failTimer);
        const subs = [T('p/+'), T(`i/${me.id}`)];
        if (game) subs.push(T(`g/${game.mid}`), T(`g/${game.mid}/s`));
        roomSubs.forEach((_, topic) => subs.push(topic));
        client.subscribe(subs, { qos: 1 });
        publishMe();
        if (game) gameSend({ t: 'hi', n: me.name, ai: me.ai, back: 1 });
        setStatus('on');
      });
      client.on('reconnect', () => setStatus('connecting'));
      client.on('offline', () => setStatus('connecting'));
      client.on('error', () => { /* 再接続に任せる */ });
      client.on('message', onMessage);
      if (!timersOn) {
        timersOn = true;
        setInterval(publishMe, BEAT);
        setInterval(() => { call('onPresence', list()); checkOpp(); }, 10000);
        window.addEventListener('pagehide', () => { try { client.publish(T(`p/${me.id}`), '', { retain: true, qos: 0 }); client.end(true); } catch (e) { /* 無視 */ } });
      }
    }

    function onMessage(topic, buf) {
      const sub = topic.slice(NS.length + 1);
      let msg = null;
      if (buf && buf.length) { try { msg = JSON.parse(buf.toString()); } catch (e) { return; } }
      if (sub.startsWith('p/')) {
        const id = sub.slice(2);
        if (id === me.id) return;
        if (!msg) peers.delete(id); else peers.set(id, Object.assign(msg, { id, seen: Date.now() }));
        call('onPresence', list()); checkOpp();
      } else if (sub === `i/${me.id}`) { if (msg) onInbox(msg); }
      else if (game && sub === `g/${game.mid}`) { if (msg && msg.from !== me.id) call('onRemote', msg); }
      else if (game && sub === `g/${game.mid}/s`) { if (msg && msg.from !== me.id) call('onRemote', Object.assign({}, msg, { t: 'state', ts: typeof msg.t === 'number' ? msg.t : 0 })); } // 保存の時刻（t）で 'state' を上書きしない。時刻は ts に
      else if (roomSubs.has(topic)) roomSubs.get(topic).forEach(cb => { try { cb(msg, topic); } catch (e) { console.error(e); } });
    }

    // 相手の在席（同じ対局IDの人）。再読み込みで ID が変わっても見つけられる。自分がつながっていないときは判定しない
    function checkOpp() {
      if (!game || status !== 'on') return;
      const p = list().find(x => x.m === game.mid);
      if (p) game.oppId = p.id;
      const now = !!p;
      if (now !== oppPresent) { oppPresent = now; call('onOppPresence', now); }
    }

    function onInbox(msg) {
      if (msg.t === 'ch') {
        if (me.s !== 'wait' || game || (msg.g && msg.g !== me.g)) { send(`i/${msg.from}`, { t: 'no', from: me.id }); return; }
        const mid = rid(10), myColor = Math.random() < 0.5 ? 0 : 1;
        send(`i/${msg.from}`, { t: 'ok', from: me.id, n: me.name, ai: me.ai, mid, r: me.r, oc: myColor ^ 1 });
        startGame({ mid, myColor, r: me.r, opp: { id: msg.from, name: msg.n || 'ゲスト', ai: msg.ai | 0 } });
      } else if (msg.t === 'ok' && pending && pending.id === msg.from) {
        clearTimeout(pending.timer); pending = null;
        startGame({ mid: msg.mid, myColor: msg.oc ? 1 : 0, r: msg.r, opp: { id: msg.from, name: msg.n || 'ゲスト', ai: msg.ai | 0 } });
      } else if (msg.t === 'no' && pending && pending.id === msg.from) {
        clearTimeout(pending.timer); pending = null;
        call('onChallenge', 'no');
      }
    }

    function startGame(g) {
      if (game) leaveGame(true);
      game = Object.assign({ oppId: g.opp.id }, g);
      oppPresent = null;
      me.s = 'play'; me.m = g.mid; me.c = '';
      if (client) client.subscribe([T(`g/${g.mid}`), T(`g/${g.mid}/s`)], { qos: 1 });
      publishMe();
      call('onMatch', game);
      gameSend({ t: 'hi', n: me.name, ai: me.ai });
    }
    function gameSend(body) { if (game) send(`g/${game.mid}`, Object.assign({ from: me.id }, body)); }
    function leaveGame(quiet) {
      if (!game) return;
      if (client) client.unsubscribe([T(`g/${game.mid}`), T(`g/${game.mid}/s`)]);
      game = null; oppPresent = null;
      me.s = 'idle'; me.m = '';
      if (!quiet) publishMe();
    }

    return {
      NS, get id() { return me.id; }, get status() { return status; }, get game() { return game; }, get me() { return me; },
      available, connect, list, counts,
      setName(n) { me.name = String(n || '').slice(0, 16); publishMe(); },
      setAI(flags) { me.ai = flags | 0; publishMe(); gameSend({ t: 'ai', ai: me.ai }); },
      setGame(slug) { me.g = slug; publishMe(); },
      // 2人ゲーム: 対戦待ち（r はゲームが決める条件、rl はその説明）・やめる・申し込む
      wait(r, rl) { me.s = 'wait'; me.r = r || null; me.rl = String(rl || '').slice(0, 40); me.c = me.c || code4(); publishMe(); return me.c; },
      unwait() { if (me.s === 'wait') { me.s = 'idle'; me.c = ''; publishMe(); } },
      challenge(id) {
        if (pending) clearTimeout(pending.timer);
        pending = { id, timer: setTimeout(() => { pending = null; call('onChallenge', 'timeout'); }, 12000) };
        send(`i/${id}`, { t: 'ch', from: me.id, g: me.g, n: me.name, ai: me.ai });
      },
      start: startGame,
      send: gameSend,
      saveState(state) { if (game && client && client.connected) client.publish(T(`g/${game.mid}/s`), JSON.stringify(Object.assign({ from: me.id, t: Date.now() }, state)), { retain: true, qos: 1 }); },
      leaveGame,
      rejoin(g) {
        game = Object.assign({}, g); oppPresent = null;
        me.s = 'play'; me.m = g.mid;
        if (client && client.connected) { client.subscribe([T(`g/${g.mid}`), T(`g/${g.mid}/s`)], { qos: 1 }); publishMe(); gameSend({ t: 'hi', n: me.name, ai: me.ai, back: 1 }); }
      },
      // 在席の状態を自分で決める（多人数の卓に座っているときなど）: setPresence({s:'play', m:卓ID})
      setPresence(o) { Object.assign(me, o); publishMe(); },
      // 汎用の部屋（多人数の卓など）: room(id).pub('seat', body, {retain}) / .sub('seat', cb) / .unsub('seat', cb)
      room(id) {
        const base = `r/${id}`;
        return {
          pub(sub, body, opt = {}) { if (client && client.connected) client.publish(T(`${base}/${sub}`), body == null ? '' : JSON.stringify(Object.assign({ from: me.id }, body)), { qos: 1, retain: !!opt.retain }); },
          sub(sub, cb) {
            const topic = T(`${base}/${sub}`);
            if (!roomSubs.has(topic)) { roomSubs.set(topic, new Set()); if (client && client.connected) client.subscribe(topic, { qos: 1 }); }
            roomSubs.get(topic).add(cb);
          },
          unsub(sub, cb) {
            const topic = T(`${base}/${sub}`), set = roomSubs.get(topic);
            if (!set) return;
            if (cb) set.delete(cb); else set.clear();
            if (!set.size) { roomSubs.delete(topic); if (client) client.unsubscribe(topic); }
          },
        };
      },
    };
  }

  window.SSIHOnline = { create, NS, available };
})();
