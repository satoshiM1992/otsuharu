// VRM avatar (three.js + @pixiv/three-vrm, loaded from a CDN via the import map
// in index.html). Implements the same interface as PlaceholderAvatar:
//   setModel, setExpression, setTalking, playMotion  (+ speakChar for lip sync)
// Body: a pose per expression (BODY), talking bob/sway, idle glances, and the
// one-shot motions nod / shake / tilt / jump / wave / bow.
//
// One WebGL renderer and one loaded VRM per URL are shared by every VrmView
// (title screen and game screen). Each frame the canvas is moved into the view
// whose host element is currently visible, and only that view is rendered.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// Game expression -> VRM preset weights.
const EXPR = {
  neutral: {},
  happy: { happy: 0.8 },
  shy: { relaxed: 0.45, sad: 0.2 },
  panic: { surprised: 0.7, sad: 0.35 },
  sad: { sad: 0.85 },
  angry: { angry: 0.85 },
  surprised: { surprised: 0.9 },
  smug: { relaxed: 0.6, happy: 0.25 },
  relaxed: { relaxed: 0.8 },
  blank: { surprised: 0.15 },
};
const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
const VISEME_OPEN = { aa: 0.9, ih: 0.6, ou: 0.7, ee: 0.65, oh: 0.8 };

// Head pose for expressions that tilt or lower the head (radians).
const POSE = {
  shy: { x: 0.06, z: 0.12 },
  sad: { x: 0.16, z: 0 },
  smug: { x: -0.06, z: -0.05 },
  surprised: { x: -0.04, z: 0 },
};

// Body pose per expression (normalized humanoid bones, radians), blended smoothly.
// Arms are given for the LEFT side; the right side mirrors them (y/z negated)
// unless a separate `r` entry is given. ua = upper arm, la = lower arm,
// sh = shoulder, sp = spine lean (x: forward, z: sideways), bounce = idle hop.
const ARMS_DOWN = { ua: [0, 0.08, -1.2], la: [0, 0, 0] }; // hands at the sides, not in front of the skirt
const BEHIND = { ua: [0, 0.5, -1.2], la: [0, 0.6, 0] }; // hands clasped behind the back
export const BODY = { // exported for test/vrm-check.html tuning
  neutral: { l: ARMS_DOWN },
  relaxed: { l: ARMS_DOWN, sway: 1.4 },
  // hands stay at the sides or behind the back: in front of the body the thick
  // china-dress sleeves overlap the skirt and clip into the chest, and wider or
  // higher arms get cut by the stage frame
  happy: { l: { ua: [0, 0.05, -1.02], la: [0, 0, 0] }, bounce: 1 },
  shy: { l: BEHIND, sh: [0, 0, 0.1], sp: [0.06, 0, 0] }, // fidgeting, hands behind the back
  panic: { l: { ua: [0, 0.05, -0.98], la: [0, -0.1, 0] }, sh: [0, 0, 0.12] },
  sad: { l: { ua: [0, 0.1, -1.3], la: [0, 0, 0] }, sh: [0, 0, -0.06], sp: [0.08, 0, 0], sway: 0.4 },
  angry: { l: { ua: [0, 0.1, -1.28], la: [0, -0.35, 0] }, sh: [0, 0, 0.08], sp: [0.05, 0, 0] }, // fists at the sides
  surprised: { l: { ua: [0, 0, -1.02], la: [0, -0.1, 0] }, sp: [-0.05, 0, 0] },
  smug: { l: BEHIND, sp: [-0.04, 0, 0] },
  blank: { l: ARMS_DOWN, sway: 0.2 },
};

// right-hand wave (the motion), exported for tuning
export const WAVE = { ua: [0, -0.7, 0.8], la: [0, 0.1, -2.1], h: [-0.6, 0, 0], osc: 0.5, dur: 1.6 }; // close to the face, so the thick sleeve stays in frame
const mirror = ([x, y, z]) => [x, -y, -z];
const lerp = (a, b, k) => a + (b - a) * k;

// ------------------------------------------------------------ lip sync

const KANA_VOWEL = {};
[
  ['aa', 'あかさたなはまやらわがざだばぱぁゃゎ'],
  ['ih', 'いきしちにひみりぎじぢびぴぃ'],
  ['ou', 'うくすつぬふむゆるぐずづぶぷぅゅゔ'],
  ['ee', 'えけせてねへめれげぜでべぺぇ'],
  ['oh', 'おこそとのほもよろをごぞどぼぽぉょ'],
].forEach(([v, chars]) => [...chars].forEach((c) => (KANA_VOWEL[c] = v)));
const LATIN_VOWEL = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' };

// Returns a viseme name, 'keep' (long vowel), or null (mouth closed).
export function vowelOf(ch) {
  let c = ch;
  const code = c.codePointAt(0);
  if (code >= 0x30a1 && code <= 0x30f6) c = String.fromCodePoint(code - 0x60); // katakana -> hiragana
  if (KANA_VOWEL[c]) return KANA_VOWEL[c];
  if (c === 'ー' || c === '〜' || c === '~') return 'keep';
  if (c === 'ん' || c === 'っ') return null;
  const low = c.toLowerCase();
  if (LATIN_VOWEL[low]) return LATIN_VOWEL[low];
  if (/[\p{L}\p{N}]/u.test(c)) return VISEMES[Math.floor(Math.random() * VISEMES.length)]; // kanji etc.
  return null; // punctuation, spaces, emoji
}

// ---------------------------------------------------------------- stage

export const stage = {
  renderer: null,
  scene: null,
  camera: null,
  clock: null,
  views: new Set(),
  cache: new Map(), // url -> Promise<vrm>
  current: null, // vrm currently in the scene
  frames: 0,
};

function initStage() {
  if (stage.renderer) return;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'av-vrm';
  stage.renderer = renderer;

  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(0.5, 1.2, 1.5);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.5));
  stage.scene = scene;
  stage.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  stage.clock = new THREE.Clock();
  renderer.setAnimationLoop(tick);
  stage.tick = tick; // for test/vrm-check.html
}

// Returns { promise, progress (bytes received), listeners } shared per URL.
// Bytes, not a percentage: GitHub Pages gzips .vrm, so Content-Length (compressed)
// is smaller than the bytes received and a percentage would pass 100%.
function loadVrm(url) {
  if (!stage.cache.has(url)) {
    const entry = { progress: 0, listeners: new Set() };
    const onProgress = (e) => {
      entry.progress = e.loaded;
      entry.listeners.forEach((fn) => fn(entry.progress));
    };
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const p = loader.loadAsync(url, onProgress).then((gltf) => {
      const vrm = gltf.userData.vrm;
      if (!vrm) throw new Error(`${url} is not a VRM`);
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM0 models face -Z; make them face +Z like VRM1
      vrm.scene.traverse((o) => (o.frustumCulled = false));
      if (vrm.lookAt) vrm.lookAt.target = stage.camera;
      vrm.update(0);
      const head = new THREE.Vector3();
      vrm.humanoid.getRawBoneNode('head').getWorldPosition(head);
      vrm.scene.userData.headY = head.y;
      // top of the model (hair, ears, accessories) so the bust shot never cuts it
      vrm.scene.userData.topY = new THREE.Box3().setFromObject(vrm.scene).max.y;
      return vrm;
    });
    p.catch(() => stage.cache.delete(url)); // allow a retry later
    entry.promise = p;
    stage.cache.set(url, entry);
  }
  return stage.cache.get(url);
}

// Loading badge over the avatar (styled by .vrm-loading in css/style.css).
// bytes: bytes received so far, or false to hide.
export function setLoading(host, bytes) {
  host.classList.toggle('vrm-loading', bytes !== false);
  if (bytes === false) return;
  const mb = bytes > 0 ? ` ${(bytes / 1048576).toFixed(1)}MB` : '';
  host.dataset.loading = `3Dモデル読み込み中…${mb}`;
}

function isShown(el) {
  return el.getClientRects().length > 0;
}

function tick() {
  const dt = Math.min(stage.clock.getDelta(), 0.1);
  let active = null;
  for (const v of stage.views) {
    if (v.vrm && v.model !== 'none' && isShown(v.host)) {
      active = v;
      break;
    }
  }
  if (!active) return;
  const { renderer, scene, camera } = stage;
  if (renderer.domElement.parentNode !== active.host) active.host.append(renderer.domElement);
  if (stage.current !== active.vrm) {
    if (stage.current) scene.remove(stage.current.scene);
    scene.add(active.vrm.scene);
    stage.current = active.vrm;
  }
  const w = active.host.clientWidth;
  const h = active.host.clientHeight;
  if (!w || !h) return;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
  active.update(dt);
  active.frame(camera, w / h);
  renderer.render(scene, camera);
  stage.frames++;
}

// ----------------------------------------------------------------- view

export class VrmView {
  constructor(host, urls) {
    initStage();
    this.host = host;
    this.urls = urls;
    this.model = 'none';
    this.vrm = null;
    this.expr = 'neutral';
    this.talking = false;
    this.time = 0;

    this.weights = {}; // current smoothed expression weights
    this.emotionScale = 1;
    this.viseme = null; // current mouth shape
    this.visemeNext = undefined; // requested by speakChar, applied with a minimum hold
    this.visemeAt = -1; // time the mouth shape last changed
    this.lastCharAt = -1;
    this.blinkAt = 2 + Math.random() * 3;
    this.motion = null; // { name, t }
    this.pose = { x: 0, z: 0 };
    this.body = null; // current blended body pose (see BODY)
    this.emph = 0; // head-nod impulse from "！" while talking
    this.glance = { at: 3 + Math.random() * 4, until: 0, x: 0, y: 0 }; // idle look-away
    this.look = { x: 0, y: 0 };
    stage.views.add(this);
  }

  // --------------------------------------------------------- interface

  setModel(name) {
    this.model = name;
    const url = this.urls[name];
    if (!url) {
      setLoading(this.host, false);
      this.setVrm(null);
      return Promise.resolve(null);
    }
    const entry = loadVrm(url);
    const show = (p) => this.model === name && setLoading(this.host, p);
    entry.listeners.add(show);
    show(entry.progress);
    const done = () => {
      entry.listeners.delete(show);
      if (this.model === name) setLoading(this.host, false);
    };
    return entry.promise.then(
      (vrm) => {
        done();
        if (this.model === name) this.setVrm(vrm);
        this.preloadOthers();
        return vrm;
      },
      (err) => {
        done();
        console.warn('[vrm] load failed, using placeholder:', err);
        if (this.model === name) this.setVrm(null);
        return null;
      },
    );
  }

  setExpression(name) {
    this.expr = EXPR[name] ? name : 'neutral';
  }

  setTalking(on) {
    this.talking = on;
    if (!on) this.visemeNext = null;
  }

  speakChar(ch) {
    const v = vowelOf(ch);
    if (v !== 'keep') this.visemeNext = v;
    this.lastCharAt = this.time;
    if (ch === '！' || ch === '!' || ch === '？' || ch === '?') this.emph = 1;
  }

  playMotion(name) {
    this.motion = { name, t: 0 };
  }

  // ---------------------------------------------------------- internals

  // Download the other models in the background (e.g. the real-life model used in
  // chapter 3) so switching to them later is instant. Failures are retried on use.
  preloadOthers() {
    if (stage.preloaded) return;
    stage.preloaded = true;
    setTimeout(() => {
      for (const url of new Set(Object.values(this.urls))) loadVrm(url).promise.catch(() => {});
    }, 1500);
  }

  setVrm(vrm) {
    this.vrm = vrm;
    this.host.classList.toggle('has-vrm', !!vrm);
  }

  frame(camera, aspect) {
    const headY = this.vrm.scene.userData.headY;
    // Square host (call screen icon): face close-up. Otherwise: bust shot.
    const close = aspect > 0.9;
    const viewH = close ? 0.38 : 0.8;
    const topY = this.vrm.scene.userData.topY ?? headY + 0.25;
    const y = close ? headY + 0.04 : Math.min(headY - 0.1, topY + 0.06 - viewH / 2);
    camera.aspect = aspect;
    camera.fov = 28;
    const dist = viewH / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.set(0, y, dist);
    camera.lookAt(0, y, 0);
    camera.updateProjectionMatrix();
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const em = this.vrm.expressionManager;
    const target = {};

    // emotions (scaled down while talking so the mouth shapes stay visible)
    const scaleTarget = this.talking ? 0.6 : 1;
    this.emotionScale += (scaleTarget - this.emotionScale) * Math.min(1, dt * 8);
    const e = EXPR[this.expr];
    for (const k of EMOTIONS) target[k] = (e[k] ?? 0) * this.emotionScale;

    // lip sync: follow the typed characters, holding each shape >= 70 ms
    if (this.talking) {
      if (this.visemeNext !== undefined && t - this.visemeAt >= 0.07) {
        this.viseme = this.visemeNext;
        this.visemeNext = undefined;
        this.visemeAt = t;
      } else if (t - this.lastCharAt > 0.25 && t - this.visemeAt >= 0.11) {
        // talking without speakChar calls: generic flapping
        this.viseme = this.viseme ? null : VISEMES[Math.floor(Math.random() * 5)];
        this.visemeAt = t;
      }
    } else if (this.visemeNext !== undefined || this.viseme) {
      this.viseme = null;
      this.visemeNext = undefined;
    }
    for (const v of VISEMES) target[v] = v === this.viseme ? VISEME_OPEN[v] : 0;

    // blink
    let blink = 0;
    if (t >= this.blinkAt) {
      const p = (t - this.blinkAt) / 0.14;
      if (p >= 1) this.blinkAt = t + 2 + Math.random() * 3.5;
      else blink = Math.sin(p * Math.PI);
    }
    // happy/relaxed already close the eyes on VRoid models; blinking on top distorts them
    target.blink = blink * Math.max(0, 1 - (target.happy + target.relaxed) * 1.5);

    for (const [k, v] of Object.entries(target)) {
      const rate = k === 'blink' ? 1 : VISEMES.includes(k) ? Math.min(1, dt * 22) : Math.min(1, dt * 9);
      const cur = this.weights[k] ?? 0;
      this.weights[k] = cur + (v - cur) * rate;
      em?.setValue(k, this.weights[k]);
    }

    this.updateBones(dt);
    this.vrm.update(dt);
  }

  updateBones(dt) {
    const t = this.time;
    const hum = this.vrm.humanoid;
    const bone = (n) => hum.getNormalizedBoneNode(n);
    const set = (n, [x, y, z]) => bone(n)?.rotation.set(x, y, z);

    // --- body pose for the expression, blended over ~0.3 s
    const def = BODY[this.expr] ?? BODY.neutral;
    const goal = {
      lua: def.l.ua, lla: def.l.la,
      rua: def.r?.ua ?? mirror(def.l.ua), rla: def.r?.la ?? mirror(def.l.la),
      lh: def.l.h ?? [0, 0, 0], rh: def.r?.h ?? mirror(def.l.h ?? [0, 0, 0]),
      sh: def.sh ?? [0, 0, 0], sp: def.sp ?? [0, 0, 0],
    };
    if (!this.body) this.body = structuredClone(goal);
    const kb = Math.min(1, dt * 5);
    for (const key of Object.keys(goal)) for (let a = 0; a < 3; a++) this.body[key][a] = lerp(this.body[key][a], goal[key][a], kb);
    const b = this.body;

    const talking = this.talking && t - this.lastCharAt < 0.4;
    const swayAmp = (def.sway ?? 1) * (talking ? 1.6 : 1);
    const armSway = Math.sin(t * 1.6) * 0.03 * swayAmp;
    // small gestures while talking: forearms move a little with the words
    const gest = talking ? Math.sin(t * 5.3) * 0.08 : 0;

    let lua = [...b.lua], rua = [...b.rua], lla = [...b.lla], rla = [...b.rla];
    let lh = [...b.lh], rh = [...b.rh];
    lua[2] += armSway; rua[2] -= armSway;
    lla[1] -= gest; rla[1] += gest * 0.7;

    // --- head: expression pose + idle sway + talking bob + glances
    const pose = POSE[this.expr] ?? { x: 0, z: 0 };
    const k = Math.min(1, dt * 6);
    this.pose.x += (pose.x - this.pose.x) * k;
    this.pose.z += (pose.z - this.pose.z) * k;

    // look away now and then while idle (not while talking)
    const g = this.glance;
    if (t >= g.at) {
      g.until = t + 0.8 + Math.random() * 1.2;
      g.at = g.until + 3 + Math.random() * 5;
      g.x = (Math.random() - 0.5) * 0.12;
      g.y = (Math.random() - 0.5) * 0.35;
    }
    const glancing = !talking && t < g.until;
    const kl = Math.min(1, dt * 4);
    this.look.x = lerp(this.look.x, glancing ? g.x : 0, kl);
    this.look.y = lerp(this.look.y, glancing ? g.y : 0, kl);

    this.emph = Math.max(0, this.emph - dt * 3);
    const bob = talking ? Math.abs(Math.sin(t * 7.5)) * 0.035 : 0;
    let hx = this.pose.x + Math.sin(t * 0.9) * 0.02 + bob + this.emph * 0.12 + this.look.x;
    let hy = Math.sin(t * 0.55) * 0.04 * swayAmp + this.look.y + (talking ? Math.sin(t * 2.1) * 0.05 : 0);
    let hz = this.pose.z + Math.sin(t * 0.75) * 0.02 * swayAmp + (talking ? Math.sin(t * 1.7) * 0.03 : 0);

    // body: breathing, sideways sway, the pose's lean, a little hop when happy
    const breath = Math.sin(t * 1.9);
    let spx = b.sp[0] + breath * 0.012;
    let spz = b.sp[2] + Math.sin(t * 0.7) * 0.02 * swayAmp + (talking ? Math.sin(t * 1.3) * 0.02 : 0);
    let spy = Math.sin(t * 0.45) * 0.03 * swayAmp;
    let jump = def.bounce ? Math.max(0, Math.sin(t * 4.2)) * 0.008 : 0;

    // --- one-shot motions
    const m = this.motion;
    if (m) {
      m.t += dt;
      const s = m.t;
      const env = (d) => Math.sin(Math.min(1, s / d) * Math.PI); // 0 → 1 → 0 over d seconds
      switch (m.name) {
        case 'nod':
          if (s < 0.6) hx += env(0.6) * 0.28;
          else this.motion = null;
          break;
        case 'shake':
          if (s < 0.5) hy += Math.sin(s * Math.PI * 2 * 3) * 0.3 * (1 - s / 0.5);
          else this.motion = null;
          break;
        case 'tilt':
          if (s < 0.8) hz += env(0.8) * 0.22;
          else this.motion = null;
          break;
        case 'jump':
          if (s < 0.3) jump += Math.sin((s / 0.3) * Math.PI) * 0.08;
          else if (s < 0.45) jump += Math.sin(((s - 0.3) / 0.15) * Math.PI) * 0.02;
          else this.motion = null;
          break;
        case 'wave': {
          // right hand up beside the face, waving
          const d = WAVE.dur;
          if (s < d) {
            const w = Math.min(1, s / 0.25, (d - s) / 0.3);
            const osc = Math.sin(s * Math.PI * 2 * 1.8) * WAVE.osc;
            rua = rua.map((v, i) => lerp(v, WAVE.ua[i], w));
            // swing the raised forearm left-right in the same plane it was raised in (z),
            // not around its own length (y), which looked like twisting a doorknob
            rla = rla.map((v, i) => lerp(v, WAVE.la[i] + (i === 2 ? osc : 0), w));
            rh = rh.map((v, i) => lerp(v, WAVE.h[i], w));
            hz += w * 0.05;
          } else this.motion = null;
          break;
        }
        case 'bow':
          if (s < 1.1) {
            const w = env(1.1);
            spx += w * 0.35;
            hx += w * 0.2;
          } else this.motion = null;
          break;
        default:
          this.motion = null;
      }
    }

    set('leftHand', lh);
    set('rightHand', rh);
    set('leftUpperArm', lua);
    set('rightUpperArm', rua);
    set('leftLowerArm', lla);
    set('rightLowerArm', rla);
    set('leftShoulder', b.sh);
    set('rightShoulder', mirror(b.sh));
    set('spine', [spx, spy, spz]);
    set('chest', [breath * 0.012, spy * 0.5, spz * 0.5]);
    set('neck', [hx * 0.4, hy * 0.4, hz * 0.4]);
    set('head', [hx * 0.6, hy * 0.6, hz * 0.6]);
    this.vrm.scene.position.y = jump;
  }
}
