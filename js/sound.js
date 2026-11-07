// Sound: BGM and sound effects synthesized with Web Audio (no audio files),
// plus Haru's short voice clips loaded from voice/ when they exist.
//
//   sound.unlock()        call from a user gesture (browsers block audio before one)
//   sound.bgm(name|null)  'title' | 'stream' | 'night' | 'date'; null stops
//   sound.se(name)        see SE below
//   sound.setEnabled(on)  mute toggle, remembered in localStorage
//   sound.setVoices(cfg)  data.voice from scenario.json; sound.voice(key, forced)

const STORE_KEY = 'oshi-vtuber-sound';
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// ---------------------------------------------------------------- tracks
// chords: one per bar, MIDI notes (root first). arp: chord-tone index per 16th
// step (-1 = rest). bass: steps (of 16) where the root plays.
const TRACKS = {
  title: {
    bpm: 112,
    wave: 'square',
    chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], // C G Am F
    arp: [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 4, 3],
    bass: [0, 6, 8, 14],
    lead: 0.05,
  },
  stream: {
    bpm: 124,
    wave: 'square',
    chords: [[58, 62, 65], [60, 64, 67], [57, 60, 64], [62, 65, 69]], // Bb C Am Dm
    arp: [0, -1, 2, 1, -1, 2, 3, -1, 0, -1, 2, 1, 3, 2, 1, -1],
    bass: [0, 4, 8, 12],
    lead: 0.045,
  },
  night: {
    bpm: 76,
    wave: 'triangle',
    chords: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]], // Am7 Fmaj7 Cmaj7 G7
    arp: [0, -1, 1, -1, 2, -1, 3, -1, 2, -1, 1, -1, -1, -1, -1, -1],
    bass: [0, 8],
    lead: 0.07,
  },
  date: {
    bpm: 96,
    wave: 'triangle',
    chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], // C Am F G
    arp: [0, 1, 2, -1, 3, -1, 2, 1, 0, 1, 2, -1, 4, -1, 3, -1],
    bass: [0, 6, 8],
    lead: 0.06,
  },
};

class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    try {
      this.enabled = localStorage.getItem(STORE_KEY) !== 'off';
    } catch {}
    this.track = null; // requested BGM name
    this.playing = null; // BGM actually scheduled
    this.timer = null;
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.enabled) this.ctx.resume();
    });
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      this.master.connect(ctx.destination);
      this.bgmBus = ctx.createGain();
      this.bgmBus.gain.value = 0.5;
      this.bgmBus.connect(this.master);
      this.seBus = ctx.createGain();
      this.seBus.gain.value = 0.9;
      this.seBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended' && this.enabled) this.ctx.resume();
    this.loadVoices();
    if (this.track !== this.playing) this.bgm(this.track);
  }

  setEnabled(on) {
    this.enabled = on;
    try {
      localStorage.setItem(STORE_KEY, on ? 'on' : 'off');
    } catch {}
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
    if (on) this.ctx.resume();
  }

  // -------------------------------------------------------------- synthesis

  note(freq, t, dur, { wave = 'sine', vol = 0.2, attack = 0.005, slide = null, bus = this.seBus, vibrato = 0 } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
    if (vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 6;
      depth.gain.value = vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ------------------------------------------------------------------- SE

  se(name) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + 0.01;
    const n = (m, at, dur, o) => this.note(midi(m), t + at, dur, o);
    switch (name) {
      case 'tap':
        n(84, 0, 0.05, { vol: 0.05 });
        break;
      case 'select':
        n(79, 0, 0.08, { wave: 'triangle', vol: 0.18 });
        n(86, 0.06, 0.12, { wave: 'triangle', vol: 0.18 });
        break;
      case 'coin':
        n(88, 0, 0.06, { wave: 'square', vol: 0.05 });
        n(95, 0.05, 0.12, { wave: 'square', vol: 0.05 });
        break;
      case 'post':
        this.note(520, t, 0.09, { slide: 980, vol: 0.12 });
        break;
      case 'dm':
        n(84, 0, 0.12, { vol: 0.2 });
        n(91, 0.1, 0.25, { vol: 0.2 });
        break;
      case 'ring':
        for (let i = 0; i < 2; i++) {
          n(88, i * 0.5, 0.08, { wave: 'triangle', vol: 0.12 });
          n(84, i * 0.5 + 0.1, 0.08, { wave: 'triangle', vol: 0.12 });
          n(88, i * 0.5 + 0.2, 0.08, { wave: 'triangle', vol: 0.12 });
        }
        break;
      case 'up':
        [72, 76, 79, 84].forEach((m, i) => n(m, i * 0.05, 0.25, { wave: 'triangle', vol: 0.16 }));
        n(96, 0.2, 0.4, { vol: 0.06 });
        break;
      case 'down':
        this.note(420, t, 0.3, { wave: 'square', slide: 180, vol: 0.07 });
        break;
      case 'bigdown':
        this.note(300, t, 0.22, { wave: 'sawtooth', slide: 140, vol: 0.09 });
        this.note(220, t + 0.2, 0.45, { wave: 'sawtooth', slide: 70, vol: 0.09 });
        break;
      case 'card':
        [67, 72, 76].forEach((m, i) => n(m, i * 0.07, 0.5, { vol: 0.1 }));
        break;
      case 'rare':
        [91, 95, 98, 103].forEach((m, i) => n(m, i * 0.08, 0.6, { vol: 0.08 }));
        break;
      case 'lover':
        [60, 64, 67, 72].forEach((m, i) => n(m, i * 0.12, 0.3, { wave: 'square', vol: 0.08 }));
        [72, 76, 79, 84].forEach((m) => n(m, 0.5, 1.4, { wave: 'triangle', vol: 0.08 }));
        n(48, 0.5, 1.4, { wave: 'triangle', vol: 0.15 });
        break;
      case 'ending':
        [67, 72, 74, 76].forEach((m, i) => n(m, i * 0.16, 0.5, { wave: 'triangle', vol: 0.12 }));
        n(48, 0.48, 1.2, { wave: 'triangle', vol: 0.12 });
        break;
      case 'fail': // sad trombone
        [67, 66, 65].forEach((m, i) => n(m, i * 0.32, 0.3, { wave: 'sawtooth', vol: 0.07 }));
        n(64, 0.96, 1.1, { wave: 'sawtooth', vol: 0.07, vibrato: 6 });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- voice
  // Haru's short voice clips. data.voice.clips lists the lines per key; the
  // files are voice/<key>_<n>.mp3 (n from 1, same order as the list). Missing
  // files are simply skipped, so the game works with any subset of recordings.

  setVoices(cfg) {
    this.voiceCfg = cfg ?? null;
    this.lastVoice = -Infinity;
    if (this.ctx) this.loadVoices();
  }

  loadVoices() {
    if (this.voiceBufs || !this.voiceCfg) return;
    this.voiceBufs = {};
    for (const [key, lines] of Object.entries(this.voiceCfg.clips ?? {})) {
      lines.forEach((_, i) => {
        fetch(new URL(`../voice/${key}_${i + 1}.mp3`, import.meta.url))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
          .then((b) => this.ctx.decodeAudioData(b))
          .then((buf) => (this.voiceBufs[key] ??= []).push(buf))
          .catch(() => {}); // not recorded yet
      });
    }
  }

  voice(key, forced = false) {
    if (!this.ctx || !this.enabled || !this.voiceCfg) return;
    const bufs = this.voiceBufs?.[key];
    if (!bufs?.length) return;
    const now = performance.now();
    if (!forced) {
      if (now - this.lastVoice < (this.voiceCfg.cooldownMs ?? 0)) return;
      if (Math.random() > (this.voiceCfg.rate ?? 1)) return;
    }
    this.lastVoice = now;
    const src = this.ctx.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    const g = this.ctx.createGain();
    g.gain.value = this.voiceCfg.volume ?? 1;
    src.connect(g).connect(this.master);
    src.start();
  }

  // ------------------------------------------------------------------ BGM

  bgm(name) {
    this.track = name ?? null;
    if (!this.ctx) return; // starts on unlock()
    if (this.playing === this.track) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.trackGain) {
      const g = this.trackGain;
      g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.15);
      setTimeout(() => g.disconnect(), 1000);
      this.trackGain = null;
    }
    this.playing = this.track;
    const tr = TRACKS[this.track];
    if (!tr) return;

    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.setTargetAtTime(1, this.ctx.currentTime, 0.3);
    g.connect(this.bgmBus);
    this.trackGain = g;

    const stepDur = 60 / tr.bpm / 4;
    let step = 0;
    let next = this.ctx.currentTime + 0.1;
    const schedule = () => {
      while (next < this.ctx.currentTime + 0.25) {
        const chord = tr.chords[Math.floor(step / 16) % tr.chords.length];
        const s = step % 16;
        const opt = { bus: g };
        if (s === 0) {
          for (const m of chord) this.note(midi(m), next, stepDur * 15, { ...opt, wave: 'sine', vol: 0.03, attack: 0.08 });
        }
        if (tr.bass.includes(s)) this.note(midi(chord[0] - 24), next, stepDur * 3, { ...opt, wave: 'triangle', vol: 0.16 });
        const a = tr.arp[s];
        if (a >= 0) {
          const m = chord[a % chord.length] + 12 * (1 + Math.floor(a / chord.length));
          this.note(midi(m), next, stepDur * 1.6, { ...opt, wave: tr.wave, vol: tr.lead });
        }
        next += stepDur;
        step++;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 60);
  }
}

export const sound = new Sound();
