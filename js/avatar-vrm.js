// VRM avatar (three.js + @pixiv/three-vrm, loaded from a CDN via the import map
// in index.html). Implements the same interface as PlaceholderAvatar:
//   setModel, setExpression, setTalking, playMotion  (+ speakChar for lip sync)
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
};

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
  }

  playMotion(name) {
    this.motion = { name, t: 0 };
  }

  // ---------------------------------------------------------- internals

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

    // relaxed arms instead of the T-pose
    const sway = Math.sin(t * 1.6) * 0.03;
    bone('leftUpperArm') && bone('leftUpperArm').rotation.set(0, 0, -1.2 + sway);
    bone('rightUpperArm') && bone('rightUpperArm').rotation.set(0, 0, 1.2 - sway);
    bone('leftLowerArm') && bone('leftLowerArm').rotation.set(0, -0.25, 0);
    bone('rightLowerArm') && bone('rightLowerArm').rotation.set(0, 0.25, 0);

    // breathing
    const breath = Math.sin(t * 1.9);
    bone('spine')?.rotation.set(breath * 0.012, 0, Math.sin(t * 0.7) * 0.015);
    bone('chest')?.rotation.set(breath * 0.012, 0, 0);

    // head: expression pose + idle sway + motion
    const pose = POSE[this.expr] ?? { x: 0, z: 0 };
    const k = Math.min(1, dt * 6);
    this.pose.x += (pose.x - this.pose.x) * k;
    this.pose.z += (pose.z - this.pose.z) * k;
    let hx = this.pose.x + Math.sin(t * 0.9) * 0.02;
    let hy = Math.sin(t * 0.55) * 0.04;
    let hz = this.pose.z + Math.sin(t * 0.75) * 0.02;
    let jump = 0;

    const m = this.motion;
    if (m) {
      m.t += dt;
      const s = m.t;
      switch (m.name) {
        case 'nod':
          if (s < 0.6) hx += Math.sin((s / 0.6) * Math.PI) * 0.28;
          else this.motion = null;
          break;
        case 'shake':
          if (s < 0.5) hy += Math.sin(s * Math.PI * 2 * 3) * 0.3 * (1 - s / 0.5);
          else this.motion = null;
          break;
        case 'tilt':
          if (s < 0.8) hz += Math.sin((s / 0.8) * Math.PI) * 0.22;
          else this.motion = null;
          break;
        case 'jump':
          if (s < 0.3) jump = Math.sin((s / 0.3) * Math.PI) * 0.08;
          else if (s < 0.45) jump = Math.sin(((s - 0.3) / 0.15) * Math.PI) * 0.02;
          else this.motion = null;
          break;
        default:
          this.motion = null;
      }
    }
    bone('neck')?.rotation.set(hx * 0.4, hy * 0.4, hz * 0.4);
    bone('head')?.rotation.set(hx * 0.6, hy * 0.6, hz * 0.6);
    this.vrm.scene.position.y = jump;
  }
}
