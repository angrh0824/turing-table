/* 効果音（WebAudio で合成。音のファイルは使わない）
 *   札を打つ「パチッ」・めくる・取る・役ができた（琴の音）・こいこい（太鼓）・勝ち負け
 */
(function (root) {
  'use strict';
  let ctx = null, master = null, on = true;
  const kotoCache = new Map();
  function ac() {
    if (!on) return null;
    try {
      if (!ctx) {
        ctx = new (root.AudioContext || root.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) { return null; }
  }
  function noise(len, shape) {
    const n = Math.floor(ctx.sampleRate * len), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * shape(i / n);
    return b;
  }
  function play(buf, t, gain, filter) {
    const s = ctx.createBufferSource(); s.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    let node = s;
    if (filter) { const f = ctx.createBiquadFilter(); Object.assign(f, { type: filter.type }); f.frequency.value = filter.f; f.Q.value = filter.q || 1; node.connect(f); node = f; }
    node.connect(g).connect(master);
    s.start(t);
  }
  // 琴（Karplus-Strong の撥弦）
  function koto(freq) {
    const key = Math.round(freq);
    if (kotoCache.has(key)) return kotoCache.get(key);
    const sr = ctx.sampleRate, len = Math.floor(sr * 1.6), N = Math.max(2, Math.round(sr / freq));
    const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    const ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let idx = 0, prev = 0;
    for (let i = 0; i < len; i++) {
      const cur = ring[idx];
      const nx = 0.996 * 0.5 * (cur + prev);
      prev = cur; ring[idx] = nx; d[i] = cur * (i < 40 ? i / 40 : 1);
      idx = (idx + 1) % N;
    }
    kotoCache.set(key, b);
    return b;
  }
  const NOTE = { D4: 293.66, Eb4: 311.13, G4: 392, A4: 440, Bb4: 466.16, D5: 587.33, Eb5: 622.25, G5: 783.99, A5: 880, Bb5: 932.33, D6: 1174.66, G3: 196, D3: 146.83 };
  function phrase(notes, gap, gain) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + 0.02;
    notes.forEach((n, i) => play(koto(NOTE[n] || n), t + i * gap, gain || 0.5));
  }
  const S = {
    setEnabled(v) { on = !!v; },
    slap(kind) {
      const c = ac(); if (!c) return;
      const t = c.currentTime;
      play(noise(0.05, x => Math.pow(1 - x, 6)), t, kind === 'soft' ? 0.6 : 1.1, { type: 'bandpass', f: 2100, q: 0.9 });
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.06);
      g.gain.setValueAtTime(kind === 'soft' ? 0.15 : 0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(g).connect(master); o.start(t); o.stop(t + 0.1);
    },
    flip() {
      const c = ac(); if (!c) return;
      play(noise(0.12, x => Math.sin(Math.PI * x) * 0.6), c.currentTime, 0.35, { type: 'highpass', f: 2600, q: 0.7 });
    },
    take() {
      const c = ac(); if (!c) return;
      S.slap();
      const t = c.currentTime + 0.05;
      [1567.98, 2349.32].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.03); g.gain.exponentialRampToValueAtTime(0.06, t + i * 0.03 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.03 + 0.35);
        o.connect(g).connect(master); o.start(t + i * 0.03); o.stop(t + 0.5);
      });
    },
    deal() { S.slap('soft'); },
    yaku() { phrase(['D5', 'Eb5', 'G5', 'A5', 'D6'], 0.085, 0.45); },
    koikoi() {
      const c = ac(); if (!c) return;
      const t = c.currentTime;
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.35);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(master); o.start(t); o.stop(t + 0.5);
      play(noise(0.08, x => Math.pow(1 - x, 3)), t, 0.6, { type: 'lowpass', f: 600 });
      setTimeout(() => phrase(['A4', 'D5'], 0.12, 0.45), 180);
    },
    stop() { phrase(['G4', 'Bb4', 'D5', 'G5'], 0.07, 0.4); },
    win() { phrase(['D4', 'G4', 'A4', 'D5', 'Eb5', 'G5', 'D6'], 0.11, 0.42); },
    lose() { phrase(['A5', 'G5', 'Eb5', 'D5', 'Bb4', 'A4'], 0.14, 0.32); },
    draw() { phrase(['D5', 'A4', 'D5'], 0.16, 0.32); },
  };
  root.KoikoiSound = S;
})(typeof self !== 'undefined' ? self : this);
