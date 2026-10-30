// 全ゲーム共通の「音を消す」元栓（トップ画面のボタンで切り替え、localStorage の 'tt-mute' に覚える）
// ゲームのページでは app.js より先に読み込む。各ゲームの音（Web Audio）は、消しているあいだ音量 0 の層を通る
// 各ゲームの中の「音」の設定はそのまま。元栓を閉じているときは、ゲームの中で音をオンにしても鳴らない
(function () {
  'use strict';
  const KEY = 'tt-mute';
  const read = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  let muted = read();
  const gains = new Set();
  const Orig = window.AudioContext || window.webkitAudioContext;
  if (Orig) {
    class Ctx extends Orig {
      constructor(...a) {
        super(...a);
        const g = super.createGain();
        g.gain.value = muted ? 0 : 1;
        g.connect(super.destination);
        this._ttGain = g;
        gains.add(g);
      }
      get destination() { return this._ttGain || super.destination; }
    }
    window.AudioContext = Ctx;
    if (window.webkitAudioContext) window.webkitAudioContext = Ctx;
  }
  const apply = () => gains.forEach(g => { g.gain.value = muted ? 0 : 1; });
  // 別のタブ（トップ画面）で切り替えたら、開いているゲームにもすぐ効く
  window.addEventListener('storage', e => { if (e.key === KEY) { muted = read(); apply(); } });
  window.TTSound = {
    get muted() { return muted; },
    set(v) { muted = !!v; try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* 覚えられないときはこのページだけ */ } apply(); },
  };
})();
