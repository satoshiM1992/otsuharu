// Avatars. Every avatar implements this interface:
//
//   setModel(name)       'vtuber' | 'real' | 'none'
//   setExpression(name)  one of EXPRESSIONS
//   setTalking(bool)     lip flap while text is typing
//   playMotion(name)     'nod' | 'jump' | 'shake' | 'tilt' | 'wave' | 'bow'
//   speakChar(ch)        optional: the character being typed, for lip sync
//
// PlaceholderAvatar draws an SVG girl. Avatar wraps it and, when VRM model URLs
// are given, lazily loads js/avatar-vrm.js (three.js from a CDN) and shows the
// VRM instead once it has loaded. If loading fails the SVG simply stays.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SKIN = '#ffe7da';
const SKIN_SHADE = '#f5cdb8';
const LINE = '#5a3a3a';
const MOUTH = '#d4566a';

const MODELS = {
  vtuber: {
    hair: '#f7a8c4',
    hairDark: '#e47fa5',
    eye: '#7b5cff',
    outfit: '#ffffff',
    accent: '#ff7fb0',
    back: 'M42 112 C36 52 70 26 100 26 C130 26 164 52 158 112 C162 150 166 190 172 228 C150 238 50 238 28 228 C34 190 38 150 42 112Z',
    locks: [
      'M50 96 C44 130 46 162 54 190 C58 162 60 130 63 104Z',
      'M150 96 C156 130 154 162 146 190 C142 162 140 130 137 104Z',
    ],
    acc: 'star',
  },
  real: {
    hair: '#7a5338',
    hairDark: '#5c3c27',
    eye: '#5b3b2a',
    outfit: '#eadbc4',
    accent: '#b38b67',
    back: 'M44 112 C40 56 70 30 100 30 C130 30 160 56 156 112 C158 132 160 150 164 170 C140 180 60 180 36 170 C40 150 42 132 44 112Z',
    locks: [
      'M50 96 C46 120 48 142 56 160 C60 140 60 120 63 104Z',
      'M150 96 C154 120 152 142 144 160 C140 140 140 120 137 104Z',
    ],
    acc: 'glasses',
  },
};

export const EXPRESSIONS = {
  neutral: { eyes: 'open', mouth: 'smile', brows: 'normal', blush: 0.15 },
  happy: { eyes: 'happy', mouth: 'smileOpen', brows: 'normal', blush: 0.35 },
  shy: { eyes: 'open', mouth: 'wavy', brows: 'sad', blush: 0.85, look: -3, tilt: true },
  panic: { eyes: 'surprised', mouth: 'wavy', brows: 'sad', blush: 0.9 },
  sad: { eyes: 'open', mouth: 'frown', brows: 'sad', blush: 0.1, look: 0, down: true },
  angry: { eyes: 'open', mouth: 'frown', brows: 'angry', blush: 0.1 },
  surprised: { eyes: 'surprised', mouth: 'o', brows: 'up', blush: 0.15 },
  smug: { eyes: 'half', mouth: 'smile', brows: 'normal', blush: 0.2 },
  relaxed: { eyes: 'happy', mouth: 'smile', brows: 'normal', blush: 0.3 },
  blank: { eyes: 'dot', mouth: 'neutral', brows: 'normal', blush: 0 },
};

const BROWS = {
  normal: ['M71 92 Q80 88 89 91', 'M111 91 Q120 88 129 92'],
  angry: ['M71 87 L89 94', 'M111 94 L129 87'],
  sad: ['M71 94 L89 88', 'M111 88 L129 94'],
  up: ['M71 86 Q80 82 89 85', 'M111 85 Q120 82 129 86'],
};

const MOUTHS = {
  smile: `<path d="M92 146 Q100 153 108 146" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  smileOpen: `<path d="M91 145 Q100 158 109 145Z" fill="${MOUTH}" stroke="${LINE}" stroke-width="2" stroke-linejoin="round"/>`,
  neutral: `<path d="M95 149 L105 149" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  frown: `<path d="M93 151 Q100 145 107 151" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>`,
  wavy: `<path d="M89 149 q2.75 -3 5.5 0 t5.5 0 t5.5 0 t5.5 0" fill="none" stroke="${LINE}" stroke-width="2.2" stroke-linecap="round"/>`,
  o: `<ellipse cx="100" cy="149" rx="4.5" ry="5.5" fill="${MOUTH}" stroke="${LINE}" stroke-width="2"/>`,
  talk: `<ellipse cx="100" cy="148" rx="6" ry="4.5" fill="${MOUTH}" stroke="${LINE}" stroke-width="2"/>`,
  talkBig: `<ellipse cx="100" cy="149" rx="6" ry="7.5" fill="${MOUTH}" stroke="${LINE}" stroke-width="2"/>`,
};

function eye(kind, cx, cy, color, look) {
  const x = cx + look;
  switch (kind) {
    case 'happy':
      return `<path d="M${cx - 9} ${cy + 2} Q${cx} ${cy - 8} ${cx + 9} ${cy + 2}" fill="none" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`;
    case 'closed':
      return `<path d="M${cx - 9} ${cy} Q${cx} ${cy + 5} ${cx + 9} ${cy}" fill="none" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`;
    case 'dot':
      return `<circle cx="${cx}" cy="${cy}" r="2.8" fill="${LINE}"/>`;
    case 'surprised':
      return `<ellipse cx="${cx}" cy="${cy}" rx="9" ry="11.5" fill="#fff" stroke="${LINE}" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy + 1}" r="4.5" fill="${color}"/>
        <circle cx="${cx - 1.5}" cy="${cy - 1}" r="1.5" fill="#fff"/>`;
    case 'half':
      return `<ellipse cx="${x}" cy="${cy + 3}" rx="8" ry="7" fill="${color}"/>
        <circle cx="${x - 3}" cy="${cy + 1}" r="2.2" fill="#fff"/>
        <path d="M${cx - 10} ${cy - 3} L${cx + 10} ${cy - 3}" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`;
    default:
      return `<ellipse cx="${x}" cy="${cy}" rx="8.5" ry="11" fill="${color}"/>
        <ellipse cx="${x}" cy="${cy + 3}" rx="4.5" ry="5.5" fill="#2a1d3d" opacity=".55"/>
        <circle cx="${x - 3}" cy="${cy - 4}" r="3" fill="#fff"/>
        <path d="M${cx - 11} ${cy - 9} Q${cx} ${cy - 15} ${cx + 11} ${cy - 9}" fill="none" stroke="${LINE}" stroke-width="3" stroke-linecap="round"/>`;
  }
}

export class PlaceholderAvatar {
  constructor(host) {
    this.host = host;
    this.layer = document.createElement('div');
    this.layer.className = 'av-svg';
    host.append(this.layer);
    this.model = 'none';
    this.expr = 'neutral';
    this.talking = false;
    this.mouthOpen = false;
    this.blinking = false;
    this.svg = null;
    this.dyn = null;
    this.head = null;
    this.scheduleBlink();
  }

  setModel(name) {
    if (name === this.model) return;
    this.model = name;
    this.host.classList.toggle('is-none', name === 'none');
    if (name === 'none') return;
    this.build(MODELS[name]);
  }

  setExpression(name) {
    this.expr = EXPRESSIONS[name] ? name : 'neutral';
    this.render();
  }

  setTalking(on) {
    this.talking = on;
    clearInterval(this.talkTimer);
    this.mouthOpen = false;
    if (on) {
      this.talkTimer = setInterval(() => {
        this.mouthOpen = !this.mouthOpen;
        this.render();
      }, 110);
    }
    this.render();
  }

  playMotion(name) {
    if (!this.svg) return;
    const cls = `motion-${name}`;
    this.svg.classList.remove(cls);
    void this.svg.getBoundingClientRect(); // restart the CSS animation
    this.svg.classList.add(cls);
    setTimeout(() => this.svg?.classList.remove(cls), 900);
  }

  // ------------------------------------------------------------- drawing

  build(m) {
    this.m = m;
    const accessory =
      m.acc === 'star'
        ? `<polygon points="140,47 143.5,55.5 152.5,56 145.5,61.5 148,70.5 140,65.5 132,70.5 134.5,61.5 127.5,56 136.5,55.5" fill="#ffd84d" stroke="#e8a92c" stroke-width="1.5" stroke-linejoin="round"/>
           <circle cx="56" cy="74" r="5" fill="${m.accent}"/>`
        : `<g fill="rgba(255,255,255,.15)" stroke="#3a2a2a" stroke-width="2.5">
             <rect x="65" y="101" width="30" height="25" rx="9"/>
             <rect x="105" y="101" width="30" height="25" rx="9"/>
           </g>
           <path d="M95 111 Q100 108 105 111" fill="none" stroke="#3a2a2a" stroke-width="2.5"/>`;
    const collar =
      m.acc === 'star'
        ? `<path d="M80 205 L100 228 L120 205" fill="none" stroke="${m.accent}" stroke-width="6" stroke-linejoin="round"/>
           <circle cx="100" cy="232" r="6" fill="${m.accent}"/>`
        : `<path d="M86 205 L100 222 L114 205" fill="${SKIN}" stroke="${m.accent}" stroke-width="3"/>`;

    this.layer.innerHTML = `
      <svg xmlns="${SVG_NS}" viewBox="0 0 200 260" class="avatar-svg" aria-hidden="true">
        <g class="av-body">
          <path d="${m.back}" fill="${m.hairDark}"/>
          <rect x="88" y="164" width="24" height="46" rx="10" fill="${SKIN_SHADE}"/>
          <path d="M28 262 C32 222 62 203 100 203 C138 203 168 222 172 262Z" fill="${m.outfit}" stroke="${m.accent}" stroke-width="2"/>
          ${collar}
          <g class="av-head">
            <path d="M54 98 C54 148 76 174 100 174 C124 174 146 148 146 98 C146 64 126 50 100 50 C74 50 54 64 54 98Z" fill="${SKIN}"/>
            <g class="av-dyn"></g>
            <path d="M48 104 C44 58 72 34 100 34 C128 34 156 58 152 104 C146 90 140 80 132 74 C128 86 120 92 112 88 C110 80 106 74 102 70 C98 82 88 92 76 92 C80 84 80 78 78 74 C66 82 56 92 48 104Z" fill="${m.hair}"/>
            ${m.locks.map((d) => `<path d="${d}" fill="${m.hair}"/>`).join('')}
            <g class="av-brows"></g>
            ${accessory}
          </g>
        </g>
      </svg>`;
    this.svg = this.layer.querySelector('svg');
    this.dyn = this.layer.querySelector('.av-dyn');
    this.brows = this.layer.querySelector('.av-brows');
    this.head = this.layer.querySelector('.av-head');
    this.render();
  }

  render() {
    if (!this.dyn || this.model === 'none') return;
    const m = this.m;
    const e = EXPRESSIONS[this.expr];
    const eyeKind = this.blinking && (e.eyes === 'open' || e.eyes === 'half' || e.eyes === 'surprised') ? 'closed' : e.eyes;
    let mouth = MOUTHS[e.mouth];
    if (this.talking && this.mouthOpen) mouth = e.mouth === 'o' || e.mouth === 'smileOpen' ? MOUTHS.talkBig : MOUTHS.talk;
    const look = e.look ?? 0;

    this.dyn.innerHTML = `
      <ellipse cx="72" cy="134" rx="9" ry="5" fill="#ff8aa8" opacity="${e.blush}"/>
      <ellipse cx="128" cy="134" rx="9" ry="5" fill="#ff8aa8" opacity="${e.blush}"/>
      ${e.blush > 0.7 ? `<path d="M66 132 l3 -4 M72 132 l3 -4 M122 132 l3 -4 M128 132 l3 -4" stroke="#f0607f" stroke-width="1.5" stroke-linecap="round"/>` : ''}
      ${eye(eyeKind, 80, 114, m.eye, look)}
      ${eye(eyeKind, 120, 114, m.eye, look)}
      ${mouth}`;
    const [l, r] = BROWS[e.brows];
    this.brows.innerHTML = `<path d="${l}" fill="none" stroke="${m.hairDark}" stroke-width="2.6" stroke-linecap="round"/>
      <path d="${r}" fill="none" stroke="${m.hairDark}" stroke-width="2.6" stroke-linecap="round"/>`;
    this.head.classList.toggle('is-tilt', !!e.tilt);
    this.head.classList.toggle('is-down', !!e.down);
  }

  scheduleBlink() {
    setTimeout(() => {
      this.blinking = true;
      this.render();
      setTimeout(() => {
        this.blinking = false;
        this.render();
        this.scheduleBlink();
      }, 120);
    }, 2000 + Math.random() * 3000);
  }
}

export class Avatar {
  constructor(host, { vrmUrls = null } = {}) {
    this.host = host;
    this.svg = new PlaceholderAvatar(host);
    this.vrm = null;
    this.model = 'none';
    this.expr = 'neutral';
    if (vrmUrls) {
      host.classList.add('vrm-loading');
      host.dataset.loading = '3Dモデル準備中…';
    }
    this.ready = vrmUrls ? this.loadVrm(vrmUrls) : Promise.resolve(null);
  }

  async loadVrm(urls) {
    try {
      const { VrmView } = await import('./avatar-vrm.js');
      this.vrm = new VrmView(this.host, urls);
      this.vrm.setExpression(this.expr);
      await this.vrm.setModel(this.model);
      return this.vrm;
    } catch (e) {
      console.warn('[avatar] VRM unavailable, using placeholder:', e);
      this.host.classList.remove('vrm-loading');
      this.vrm = null;
      return null;
    }
  }

  setModel(name) {
    this.model = name;
    this.svg.setModel(name);
    return this.vrm?.setModel(name);
  }

  setExpression(name) {
    this.expr = name;
    this.svg.setExpression(name);
    this.vrm?.setExpression(name);
  }

  setTalking(on) {
    this.svg.setTalking(on);
    this.vrm?.setTalking(on);
  }

  speakChar(ch) {
    this.vrm?.speakChar(ch);
  }

  playMotion(name) {
    this.svg.playMotion(name);
    this.vrm?.playMotion(name);
  }
}
