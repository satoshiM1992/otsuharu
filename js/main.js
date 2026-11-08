// Entry point: title / name entry / gallery screens, and starting the engine.
// URL options:  ?debug=1  show affection, mood and choice types
//               ?seed=123 fix the random seed
//               ?rare=all (or rare=cat,pin) force rare events
//               ?vrm=0    use the SVG placeholder instead of the VRM models

import { createRng, randomSeed } from './rng.js';
import { loadScenario } from './data.js';
import {
  newState,
  saveGame,
  loadGame,
  clearSave,
  loadGallery,
  recordGallery,
  hasSeenHowto,
  markHowtoSeen,
  loadChapterSnapshots,
  saveChapterSnapshot,
  loadHandle,
  saveHandle,
} from './state.js';
import { Engine, ABORT } from './engine.js';
import { UI, preloadBackgrounds } from './ui.js';
import { Avatar } from './avatar.js';
import { sound } from './sound.js';

const params = new URLSearchParams(location.search);
const options = {
  debug: params.has('debug'),
  rare: params.get('rare'),
};
// VRM models per avatar (VRoid, by the author): VTuber 天音ハル / real 春川ひなの.
const VRM_MODELS = {
  vtuber: 'models/Vtuber_red.vrm',
  real: 'models/Human_red.vrm',
};
const vrmUrls = params.get('vrm') === '0' ? null : VRM_MODELS;

const fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : null;

const $ = (id) => document.getElementById(id);


let data;
try {
  data = await loadScenario();
} catch (e) {
  document.body.innerHTML = `<p class="fatal">シナリオを読み込めませんでした。<br>
    ファイルを直接開いた場合は、ローカルサーバー経由で開いてください（README参照）。<br><small>${e.message}</small></p>`;
  throw e;
}

const avatar = new Avatar($('avatar'), { vrmUrls });
const titleAvatar = new Avatar($('title-avatar'), { vrmUrls });
titleAvatar.setModel('vtuber');
titleAvatar.setExpression('happy');

sound.setVoices(data.voice);
preloadBackgrounds();
const ui = new UI({ avatar, mob: data.mob, debug: options.debug });
let engine = null;

ui.onMenuTitle = () => ui.abort();

// ---------------------------------------------------------------- screens

const endingIds = Object.keys(data.endings);
const CATEGORY = { main: 'メインエンド', bad: 'バッドエンド', out: '一発アウトエンド', hidden: '隠しエンド', rare: '超レアエンド' };

function progressText() {
  const g = loadGallery();
  return `${endingIds.filter((id) => g.endings[id]).length}/${endingIds.length}`;
}

function showTitle() {
  sound.bgm('title');
  $('title-progress').textContent = progressText();
  document.querySelector('[data-action="continue"]').hidden = !loadGame();
  // 章をえらぶ appears once a second chapter has been reached
  document.querySelector('[data-action="chapters"]').hidden = !Object.keys(loadChapterSnapshots()).some((i) => i > 0);
  ui.showScreen('title');
}

function showName() {
  $('name-input').value = '';
  $('name-msg').textContent = '';
  ui.showScreen('name');
  $('name-input').focus();
}

// ------------------------------------------------------------- how to play

const howto = { page: 0, then: null };
const howtoPages = () => document.querySelectorAll('.howto-page');

function showHowto(then = null) {
  howto.then = then; // called after the last page (first game: name entry)
  document.querySelector('.howto-endings').textContent = String(endingIds.length);
  const dots = $('howto-dots');
  dots.innerHTML = '';
  howtoPages().forEach(() => dots.append(document.createElement('span')));
  setHowtoPage(0);
  ui.showScreen('howto');
}

function setHowtoPage(i) {
  const n = howtoPages().length;
  howto.page = Math.max(0, Math.min(n - 1, i));
  $('howto-track').style.transform = `translateX(${-100 * howto.page}%)`;
  [...$('howto-dots').children].forEach((d, j) => d.classList.toggle('is-on', j === howto.page));
  const last = howto.page === n - 1;
  document.querySelector('[data-action="howto-next"]').textContent = last ? (howto.then ? 'はじめる' : 'とじる') : 'つぎへ';
  document.querySelector('[data-action="howto-prev"]').textContent = howto.page === 0 ? 'タイトルへ' : 'もどる';
  howtoPages()[howto.page].scrollTop = 0;
}

function howtoNext() {
  if (howto.page < howtoPages().length - 1) return setHowtoPage(howto.page + 1);
  markHowtoSeen();
  const then = howto.then;
  howto.then = null;
  (then ?? showTitle)();
}

function howtoPrev() {
  if (howto.page > 0) return setHowtoPage(howto.page - 1);
  showTitle();
}

// swipe between pages
{
  let x0 = null;
  let y0 = null;
  const track = $('howto-track');
  track.addEventListener('pointerdown', (e) => {
    x0 = e.clientX;
    y0 = e.clientY;
  });
  track.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0) {
      if (howto.page < howtoPages().length - 1) setHowtoPage(howto.page + 1);
    } else setHowtoPage(howto.page - 1);
  });
  track.addEventListener('pointercancel', () => (x0 = null));
}

// ------------------------------------------------------- rewards for replays

const collected = () => endingIds.filter((id) => loadGallery().endings[id]).length;
const omakeNeed = (o) => (o.need === 'all' ? endingIds.length : o.need);
const omakeUnlocked = (o) => collected() >= omakeNeed(o);

function showChapters() {
  const snaps = loadChapterSnapshots();
  const list = $('chapter-list');
  list.innerHTML = '';
  data.chapters.forEach((ch, i) => {
    const b = document.createElement('button');
    b.className = 'chapter-item';
    const open = i === 0 || !!snaps[i];
    b.disabled = !open;
    const t = document.createElement('b');
    t.textContent = open ? ch.title : '？？？';
    const sub = document.createElement('small');
    sub.textContent = open ? ch.subtitle : 'まだたどり着いていない章';
    b.append(t, sub);
    b.addEventListener('click', () => {
      if (i === 0) return startNew();
      // the saved chapter-start state, with fresh random draws
      const s = structuredClone(snaps[i]);
      s.seed = s.rngState = fixedSeed ?? randomSeed();
      s.sceneIndex = 0;
      play(s);
    });
    list.append(b);
  });
  ui.showScreen('chapters');
}

function startNew() {
  // first game: the how-to pages come first, then the name entry
  if (hasSeenHowto()) showName();
  else showHowto(showName);
}

// Bonus scenes (data.omake) unlocked by the number of endings collected.
async function playOmake(o) {
  ui.reset();
  ui.showScreen('game');
  const state = newState({ seed: 1, handle: loadHandle() ?? 'あなた' });
  state.revealed = false;
  const bonus = new Engine({ data, ui, avatar, state, rng: createRng(1), options: {} });
  bonus.chapter = { id: 0, title: `おまけ：${o.title}` };
  bonus.applySettings(o.set ?? {});
  bonus.refreshHud();
  try {
    await bonus.playLines(o.lines);
  } catch (e) {
    if (e !== ABORT) throw e;
    return showTitle();
  }
  showGallery();
}

function showGallery() {
  const g = loadGallery();
  const list = $('gallery-list');
  list.innerHTML = '';
  if (data.omake?.length) {
    const h = document.createElement('h3');
    h.textContent = `おまけ（エンド回収 ${collected()}/${endingIds.length}）`;
    list.append(h);
    for (const o of data.omake) {
      const open = omakeUnlocked(o);
      const row = galleryItem({ emoji: o.emoji, title: o.title, desc: o.desc, hint: o.need === 'all' ? 'すべてのエンドを集めると解放' : `エンドを${o.need}種集めると解放` }, open);
      row.classList.add('omake-item');
      if (open) row.addEventListener('click', () => playOmake(o));
      list.append(row);
    }
  }
  for (const [cat, label] of Object.entries(CATEGORY)) {
    const h = document.createElement('h3');
    h.textContent = label;
    list.append(h);
    for (const id of endingIds.filter((i) => data.endings[i].cat === cat)) {
      list.append(galleryItem(data.endings[id], g.endings[id]));
    }
  }
  const h = document.createElement('h3');
  h.textContent = 'レアイベント';
  list.append(h);
  for (const [id, r] of Object.entries(data.rares)) {
    list.append(galleryItem({ emoji: r.emoji, title: r.label, hint: r.hint }, g.rares[id]));
  }
  ui.showScreen('gallery');
}

function galleryItem(e, got) {
  const row = document.createElement('div');
  row.className = `gallery-item${got ? '' : ' is-locked'}`;
  const icon = document.createElement('span');
  icon.className = 'g-emoji';
  icon.textContent = got ? e.emoji : '？';
  const body = document.createElement('div');
  const t = document.createElement('p');
  t.className = 'g-title';
  t.textContent = got ? e.title : '？？？';
  const d = document.createElement('p');
  d.className = 'g-desc';
  d.textContent = got ? (e.desc ?? '') : (e.hint ?? '');
  body.append(t, d);
  row.append(icon, body);
  return row;
}

// ---------------------------------------------------------------- sharing

const GAME_TITLE = '推しVTuberを落とせ！';
const HASHTAG = '推しVTuberを落とせ';
let lastEnding = null;

function shareText() {
  const e = data.endings[lastEnding];
  const rare = e.cat === 'rare' ? '【超レア】' : '';
  return `「${GAME_TITLE}」で${rare}${e.emoji}${e.title}を見た！（エンド回収 ${progressText()}）\n#${HASHTAG}`;
}

// share/<id>.html carries that ending's og:image (img/share/<id>.jpg, made by
// tools/make-share.mjs) and forwards visitors to the game
function shareUrl() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return lastEnding ? `${base}share/${lastEnding}.html` : base;
}

async function shareImageFile() {
  try {
    const res = await fetch(`img/share/${lastEnding}.jpg`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], `oshi-vtuber-${lastEnding}.jpg`, { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

function shareToX() {
  const q = new URLSearchParams({ text: shareText(), url: shareUrl() });
  window.open(`https://x.com/intent/post?${q}`, '_blank', 'noopener');
}

async function shareNative() {
  const text = shareText();
  const url = shareUrl();
  try {
    if (navigator.share) {
      // attach the ending card when the device can share files (LINE, Instagram, ...)
      const file = await shareImageFile();
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: GAME_TITLE, text: `${text}\n${url}`, files: [file] });
      } else {
        await navigator.share({ title: GAME_TITLE, text, url });
      }
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    $('share-msg').textContent = 'コピーしました！';
  } catch (e) {
    if (e?.name !== 'AbortError') $('share-msg').textContent = 'シェアできませんでした';
  }
}

function showEnding(id) {
  const e = data.endings[id];
  $('ending-cat').textContent = CATEGORY[e.cat];
  $('ending-emoji').textContent = e.emoji;
  $('ending-title').textContent = e.title;
  $('ending-desc').textContent = e.desc ?? '';
  $('ending-progress').textContent = `エンド回収 ${progressText()}`;
  $('screen-ending').dataset.cat = e.cat;
  sound.bgm(null);
  sound.se(id === 'lover' || id === 'gyaku' ? 'lover' : e.cat === 'out' || e.cat === 'bad' ? 'fail' : e.cat === 'rare' ? 'rare' : 'ending');
  $('share-msg').textContent = '';
  lastEnding = id;
  ui.showScreen('ending');
}

// ------------------------------------------------------------------- game

async function play(state) {
  const rng = createRng(state.seed);
  rng.state = state.rngState;
  ui.reset();
  ui.showScreen('game');
  engine = new Engine({
    data,
    ui,
    avatar,
    state,
    rng,
    options,
    hooks: {
      onSave: (s) => {
        saveGame(s);
        if (s.sceneIndex === 0) saveChapterSnapshot(s);
      },
      onRare: (id) => {
        recordGallery('rares', id);
        sound.se('rare');
      },
    },
  });
  saveHandle(state.handle);
  const before = collected();
  const result = await engine.run();
  engine = null;
  if (result.type === 'ending') {
    recordGallery('endings', result.id);
    // newly unlocked bonus scenes
    const now = collected();
    const unlocked = (data.omake ?? []).filter((o) => before < omakeNeed(o) && now >= omakeNeed(o));
    $('ending-unlock').hidden = !unlocked.length;
    $('ending-unlock').textContent = unlocked.map((o) => `🎁 おまけ『${o.title}』が解放されました！（ギャラリー）`).join('\n');
    clearSave();
    showEnding(result.id);
  } else {
    showTitle();
  }
}

const NG_NAMES = /^(天音)?(ハル|はる|haru)(ちゃん|さん)?$/i;

$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('name-input').value.trim();
  if (NG_NAMES.test(raw) || raw === '天音ハル' || raw === 'あまねはる') {
    $('name-msg').textContent = 'ハル「え、わたし！？ なりすまし！？ ……別の名前にしてね！」';
    return;
  }
  const handle = raw || '名無しのリスナー';
  const flags = { nameLong: [...handle].length > 10 };
  play(newState({ seed: fixedSeed ?? randomSeed(), handle, flags }));
});

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const screen = e.target.closest('.screen')?.id;
  if (screen === 'screen-game') return; // handled by UI
  switch (action) {
    case 'new':
      startNew();
      break;
    case 'chapters':
      showChapters();
      break;
    case 'howto':
      showHowto();
      break;
    case 'howto-next':
      howtoNext();
      break;
    case 'howto-prev':
      howtoPrev();
      break;
    case 'continue': {
      const s = loadGame();
      if (s) play(s);
      break;
    }
    case 'share-x':
      shareToX();
      break;
    case 'share':
      shareNative();
      break;
    case 'gallery':
      showGallery();
      break;
    case 'back':
    case 'title':
      showTitle();
      break;
  }
});

// ------------------------------------------------------------------ sound

// Browsers only allow audio after a user gesture; resume on every tap
// (iOS suspends the context when the page goes to the background).
sound.bindUnlock();

function refreshSoundButtons() {
  document.querySelectorAll('.sound-toggle').forEach((b) => {
    b.textContent = sound.enabled ? '🔊' : '🔇';
    b.setAttribute('aria-pressed', String(sound.enabled));
  });
}
document.addEventListener(
  'click',
  (e) => {
    if (!e.target.closest('.sound-toggle')) return;
    e.stopPropagation();
    sound.setEnabled(!sound.enabled);
    refreshSoundButtons();
  },
  true,
);
refreshSoundButtons();

showTitle();
