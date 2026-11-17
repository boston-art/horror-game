// All sound is synthesised with the Web Audio API: no audio files.

export class Audio {
  constructor() {
    this.ctx = null;
    this.staticLevel = 0;
  }

  // Must be called from a user gesture (the click that starts the game).
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    // brick-wall-ish limiter so the loud moments (static at full + the terror layer) get loud
    // without hard digital clipping. The death scream bypasses it on purpose.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8; this.limiter.knee.value = 4; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.2;
    this.master.connect(this.limiter).connect(ctx.destination);

    // shared white-noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- walkie-talkie static: noise -> band-pass -> distortion -> gain ----
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    this.staticBand = ctx.createBiquadFilter();
    this.staticBand.type = 'bandpass'; this.staticBand.frequency.value = 2200; this.staticBand.Q.value = 0.8;
    this.staticShape = ctx.createWaveShaper();
    this.setDistortion(0);
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    src.connect(this.staticBand).connect(this.staticShape).connect(this.staticGain).connect(this.master);
    src.start();
    // a warbling carrier tone that creeps in when the signal is strong
    this.warble = ctx.createOscillator();
    this.warble.type = 'sawtooth'; this.warble.frequency.value = 90;
    this.warbleGain = ctx.createGain(); this.warbleGain.gain.value = 0;
    this.warble.connect(this.warbleGain).connect(this.staticShape);
    this.warble.start();

    // ---- room tone: very quiet low hum ----
    const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = 52;
    const humGain = ctx.createGain(); humGain.gain.value = 0.018;
    hum.connect(humGain).connect(this.master); hum.start();
    const air = ctx.createBufferSource(); air.buffer = this.noiseBuf; air.loop = true;
    const airLp = ctx.createBiquadFilter(); airLp.type = 'lowpass'; airLp.frequency.value = 220;
    const airGain = ctx.createGain(); airGain.gain.value = 0.02;
    air.connect(airLp).connect(airGain).connect(this.master); air.start();

    // ---- terror layer: plays while the player can see the monster ----
    // a dissonant low drone (minor seconds and a tritone) under a wavering high screech
    this.terrorGain = ctx.createGain(); this.terrorGain.gain.value = 0;
    const tShape = ctx.createWaveShaper();
    const tc = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i * 2) / 256 - 1; tc[i] = Math.tanh(x * 2.5); }
    tShape.curve = tc;
    tShape.connect(this.terrorGain).connect(this.master);
    this.terrorOsc = [];
    for (const [f, type, g] of [[55, 'sawtooth', 0.22], [58.3, 'sawtooth', 0.2], [77.8, 'square', 0.1], [110, 'sawtooth', 0.1]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(lp).connect(og).connect(tShape); o.start();
    }
    for (const [f, g] of [[1480, 0.05], [1568, 0.05], [2217, 0.03]]) {   // close high clusters: a screech
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5 + Math.random() * 4;
      const lg = ctx.createGain(); lg.gain.value = f * 0.04;
      lfo.connect(lg).connect(o.frequency); lfo.start();
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 1.2; bp.Q.value = 2;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(bp).connect(og).connect(tShape); o.start();
      this.terrorOsc.push(o);
    }
    this.terrorOn = false;
    this.terrorCool = 0;
  }

  // on: the player can see the monster right now. Called every frame.
  updateTerror(on, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.terrorCool = Math.max(0, this.terrorCool - dt);
    if (on && !this.terrorOn && this.terrorCool <= 0) { this.stinger(); this.terrorCool = 7; }
    if (on !== this.terrorOn) {
      this.terrorGain.gain.cancelScheduledValues(t);
      this.terrorGain.gain.setValueAtTime(this.terrorGain.gain.value, t);
      this.terrorGain.gain.setTargetAtTime(on ? 0.85 : 0, t, on ? 0.06 : 0.3);   // in fast, out over ~1 s
    }
    this.terrorOn = on;
  }

  // sharp hit the moment it comes into view: a slammed low boom, a noise crack and a falling shriek
  stinger() {
    const ctx = this.ctx, t = ctx.currentTime;
    this.tone({ from: 120, to: 32, dur: 1.2, gain: 0.9, type: 'sine' });
    this.burst({ dur: 0.35, freq: 1800, q: 0.7, type: 'bandpass', gain: 0.8, attack: 0.002 });
    this.burst({ dur: 0.6, freq: 180, gain: 0.7, attack: 0.002 });
    for (const [a, b] of [[2400, 900], [2550, 870], [1700, 640]]) {
      this.tone({ from: a, to: b, dur: 1.1, gain: 0.12, type: 'sawtooth' });
    }
  }

  setDistortion(amount) {
    const n = 256, curve = new Float32Array(n), k = 2 + amount * 60;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.staticShape.curve = curve;
    this._dist = amount;
  }

  // level 0 (monster far away / gone / another floor) .. 1 (in sight). Called every frame.
  // Level 0 means a completely silent radio: no base hiss, gain exactly 0.
  updateStatic(level, dt, radioOn = true) {
    if (!this.ctx) return;
    if (!radioOn) level = 0;
    this.staticLevel += (level - this.staticLevel) * Math.min(1, dt * 4);
    if (level <= 0 && this.staticLevel < 0.004) this.staticLevel = 0;   // the smoothing never reaches 0 on its own
    const l = this.staticLevel, t = this.ctx.currentTime, gain = this.staticGain.gain;
    if (l <= 0) {
      // fade out, then hold at exactly 0
      gain.cancelScheduledValues(t);
      if (gain.value < 0.002) gain.setValueAtTime(0, t);
      else { gain.setValueAtTime(gain.value, t); gain.setTargetAtTime(0, t, 0.03); }
      this.warbleGain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    // crackle: random dropouts and pops; sparse and faint when far, violent when close
    const crackle = Math.random() < 0.35 - l * 0.25 ? 0 : 1 + (Math.random() - 0.5) * (0.5 + l * 1.4);
    const g = (0.02 + Math.pow(l, 1.3) * 0.48) * Math.max(0, crackle);
    gain.setTargetAtTime(g, t, 0.03);
    this.staticBand.frequency.setTargetAtTime(2200 - l * 1400 + (Math.random() - 0.5) * l * 900, t, 0.05);
    this.warbleGain.gain.setTargetAtTime(l > 0.35 ? (l - 0.35) * 0.5 : 0, t, 0.08);
    this.warble.frequency.setTargetAtTime(70 + l * 120 + Math.sin(t * 9) * 25 * l, t, 0.05);
    if (Math.abs(l - this._dist) > 0.08) this.setDistortion(l);
  }

  burst({ dur = 0.15, freq = 800, q = 1, type = 'lowpass', gain = 0.3, attack = 0.005, when = 0, pan = 0 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    s.connect(f).connect(g).connect(p).connect(this.master);
    s.start(t, Math.random() * 1.5, dur + 0.05);
  }

  tone({ from = 200, to = 100, dur = 0.3, gain = 0.1, type = 'sine', when = 0 }) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // the player's own step: a light, short shoe tap (high and quiet) so it can never be mistaken
  // for the monster's heavy low thud
  footstep(sprint) {
    this.burst({ dur: 0.04, freq: 1500 + Math.random() * 300, type: 'bandpass', q: 1.2, gain: sprint ? 0.05 : 0.03, attack: 0.002 });
    this.burst({ dur: 0.025, freq: 3200, type: 'highpass', gain: sprint ? 0.02 : 0.012, attack: 0.001, when: 0.01 });
  }

  doorOpen(vol = 1, slow = false) {
    const d = slow ? 1.6 : 0.5;
    this.tone({ from: 180, to: 320, dur: d, gain: 0.05 * vol, type: 'sawtooth' }); // hinge creak
    this.burst({ dur: 0.12, freq: 900, gain: 0.2 * vol });                          // latch
    if (slow) this.tone({ from: 250, to: 140, dur: 1.2, gain: 0.05 * vol, type: 'sawtooth', when: 0.5 });
  }

  doorClose(vol = 1) {
    this.tone({ from: 260, to: 170, dur: 0.35, gain: 0.04 * vol, type: 'sawtooth' });
    this.burst({ dur: 0.2, freq: 260, gain: 0.5 * vol, when: 0.33 });
  }

  rattle() {
    for (let i = 0; i < 4; i++) this.burst({ dur: 0.05, freq: 1700, type: 'bandpass', q: 3, gain: 0.35, when: i * 0.085 });
    this.burst({ dur: 0.1, freq: 300, gain: 0.25, when: 0.05 });
  }

  click() { this.burst({ dur: 0.03, freq: 3000, type: 'highpass', gain: 0.15 }); }

  pickup() {
    this.tone({ from: 880, to: 880, dur: 0.12, gain: 0.08 });
    this.tone({ from: 1320, to: 1320, dur: 0.25, gain: 0.08, when: 0.1 });
  }

  unlock() {
    this.burst({ dur: 0.06, freq: 2200, type: 'bandpass', q: 4, gain: 0.4 });
    this.burst({ dur: 0.25, freq: 300, gain: 0.5, when: 0.25 });
  }

  // heavy step of the monster; vol already scaled by distance
  // One bare foot coming down, heel first: a heavy dull thud, then the wet slap of skin
  // flattening on the floor and the toes peeling after it. `heavy` 0..1 (a running step lands harder).
  monsterStep(vol, pan, heavy = 0) {
    if (vol < 0.004) return;
    const g = vol * (1 + heavy * 0.5);
    this.burst({ dur: 0.22, freq: 95 + Math.random() * 30, gain: Math.min(0.9, g * 1.1), pan, attack: 0.006 });
    this.burst({ dur: 0.07, freq: 850 + Math.random() * 250, type: 'bandpass', q: 1.4, gain: Math.min(0.4, g * 0.45), pan, when: 0.035 });
    this.burst({ dur: 0.05, freq: 1900 + Math.random() * 600, type: 'bandpass', q: 2.5, gain: Math.min(0.16, g * 0.16), pan, when: 0.11 + Math.random() * 0.03 });
  }

  scream() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(1.0, t + 0.04);
    out.gain.setValueAtTime(1.0, t + 1.3);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    const shape = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i * 2) / 256 - 1; curve[i] = Math.tanh(x * 6); }
    shape.curve = curve;
    shape.connect(out).connect(ctx.destination);
    for (const [f0, f1, type] of [[620, 1500, 'sawtooth'], [655, 1380, 'square'], [311, 760, 'sawtooth']]) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.25);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 2.1);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 27 + Math.random() * 9;
      const lg = ctx.createGain(); lg.gain.value = 90;
      lfo.connect(lg).connect(o.frequency);
      const g = ctx.createGain(); g.gain.value = 0.3;
      o.connect(g).connect(shape);
      o.start(t); lfo.start(t); o.stop(t + 2.3); lfo.stop(t + 2.3);
    }
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.6;
    const ng = ctx.createGain(); ng.gain.value = 0.7;
    n.connect(bp).connect(ng).connect(shape);
    n.start(t); n.stop(t + 2.3);
    this.staticGain.gain.setTargetAtTime(0, t, 0.05);
  }
}
