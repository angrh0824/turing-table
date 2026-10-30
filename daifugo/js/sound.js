/* 効果音（WebAudio でその場で合成。音の素材は使わない）
 *   DFSound.on = true/false、DFSound.play('card' | 'deal' | 'pass' | 'clear' | 'rev' | 'eight' | 'finish' | 'miyako' | 'turn' | 'give' | 'win' | 'lose' | 'lock' | 'skip')
 */
(function (root) {
  'use strict';
  let ctx = null, master = null, noiseBuf = null;
  function ac() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
      const n = Math.floor(ctx.sampleRate * 0.6);
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 雑音を帯域で絞った短い音（札がこすれる・はじく）
  function noise(t, dur, freq, q, gain, sweepTo) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.02);
  }
  function tone(t, freq, dur, type, gain, toFreq) {
    const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  const SOUNDS = {
    card(t) { noise(t, 0.07, 2600, 1.2, 0.9); tone(t, 180, 0.07, 'sine', 0.35, 90); },
    deal(t) { noise(t, 0.045, 3400, 1.5, 0.45); },
    pass(t) { tone(t, 520, 0.08, 'triangle', 0.12, 430); },
    clear(t) { noise(t, 0.35, 900, 0.8, 0.5, 4200); },
    give(t) { noise(t, 0.09, 2000, 1, 0.5, 3200); tone(t + 0.03, 660, 0.12, 'sine', 0.12); },
    turn(t) { tone(t, 880, 0.12, 'sine', 0.08); tone(t + 0.09, 1320, 0.16, 'sine', 0.06); },
    lock(t) { tone(t, 300, 0.05, 'square', 0.08); tone(t + 0.06, 300, 0.12, 'square', 0.08); noise(t, 0.05, 1500, 3, 0.4); },
    skip(t) { tone(t, 700, 0.06, 'triangle', 0.14, 1100); tone(t + 0.07, 900, 0.06, 'triangle', 0.14, 1400); },
    eight(t) { noise(t, 0.18, 5000, 0.7, 0.8, 900); tone(t, 1600, 0.16, 'sawtooth', 0.06, 400); },
    rev(t) {
      [0, 0.12, 0.24].forEach((d, i) => { tone(t + d, [110, 147, 196][i], 0.9 - d, 'sawtooth', 0.09); tone(t + d, [220, 294, 392][i], 0.9 - d, 'triangle', 0.08); });
      noise(t, 0.8, 300, 0.6, 0.35, 2400);
    },
    finish(t) { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.08, f, 0.32, 'triangle', 0.12)); },
    win(t) { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.09, f, 0.45, 'triangle', 0.13)); },
    lose(t) { [392, 330, 262].forEach((f, i) => tone(t + i * 0.14, f, 0.4, 'sine', 0.1)); },
    miyako(t) { [600, 450, 300, 200].forEach((f, i) => tone(t + i * 0.1, f, 0.3, 'square', 0.05)); },
  };
  const api = {
    on: true,
    play(name, delay = 0) {
      if (!api.on || !SOUNDS[name]) return;
      try { if (!ac()) return; SOUNDS[name](ctx.currentTime + delay); } catch (e) { /* 音が出せない環境 */ }
    },
    unlock() { try { ac(); } catch (e) { /* 無視 */ } },
  };
  root.DFSound = api;
})(typeof self !== 'undefined' ? self : this);
