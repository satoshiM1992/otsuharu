// Entry point: title / name entry / gallery screens, and starting the engine.
// URL options:  ?debug=1  show affection, mood and choice types
//               ?seed=123 fix the random seed
//               ?rare=all (or rare=cat,pin) force rare events
//               ?vrm=0    use the SVG placeholder instead of the VRM models

import { createRng, randomSeed } from './rng.js';
import { newState, saveGame, loadGame, clearSave, loadGallery, recordGallery } from './state.js';
import { Engine } from './engine.js';
import { UI } from './ui.js';
import { Avatar } from './avatar.js';

const params = new URLSearchParams(location.search);
const options = {
  debug: params.has('debug'),
  rare: params.get('rare'),
};
// VRM models per avatar. Both use the VRM consortium sample for now; replace
// with the VRoid models (VTuber 天音ハル / real 春川ひなの) when they exist.
const VRM_MODELS = {
  vtuber: 'models/sample.vrm',
  real: 'models/sample.vrm',
};
const vrmUrls = params.get('vrm') === '0' ? null : VRM_MODELS;

const fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : null;

const $ = (id) => document.getElementById(id);

async function loadData() {
  const res = await fetch('data/scenario.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`scenario.json: HTTP ${res.status}`);
  return res.json();
}

let data;
try {
  data = await loadData();
} catch (e) {
  document.body.innerHTML = `<p class="fatal">シナリオを読み込めませんでした。<br>
    ファイルを直接開いた場合は、ローカルサーバー経由で開いてください（README参照）。<br><small>${e.message}</small></p>`;
  throw e;
}

const avatar = new Avatar($('avatar'), { vrmUrls });
const titleAvatar = new Avatar($('title-avatar'), { vrmUrls });
titleAvatar.setModel('vtuber');
titleAvatar.setExpression('happy');

const ui = new UI({ avatar, mob: data.mob, debug: options.debug });
let engine = null;

ui.onMenuTitle = () => ui.abort();

// ---------------------------------------------------------------- screens

const endingIds = Object.keys(data.endings);
const CATEGORY = { main: 'メインエンド', out: '一発アウトエンド', hidden: '隠しエンド' };

function progressText() {
  const g = loadGallery();
  return `${endingIds.filter((id) => g.endings[id]).length}/${endingIds.length}`;
}

function showTitle() {
  $('title-progress').textContent = progressText();
  document.querySelector('[data-action="continue"]').hidden = !loadGame();
  ui.showScreen('title');
}

function showName() {
  $('name-input').value = '';
  $('name-msg').textContent = '';
  ui.showScreen('name');
  $('name-input').focus();
}

function showGallery() {
  const g = loadGallery();
  const list = $('gallery-list');
  list.innerHTML = '';
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

function showEnding(id) {
  const e = data.endings[id];
  $('ending-cat').textContent = CATEGORY[e.cat];
  $('ending-emoji').textContent = e.emoji;
  $('ending-title').textContent = e.title;
  $('ending-desc').textContent = e.desc ?? '';
  $('ending-progress').textContent = `エンド回収 ${progressText()}`;
  $('screen-ending').dataset.cat = e.cat;
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
      onSave: (s) => saveGame(s),
      onRare: (id) => recordGallery('rares', id),
    },
  });
  const result = await engine.run();
  engine = null;
  if (result.type === 'ending') {
    recordGallery('endings', result.id);
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
      showName();
      break;
    case 'continue': {
      const s = loadGame();
      if (s) play(s);
      break;
    }
    case 'gallery':
      showGallery();
      break;
    case 'back':
    case 'title':
      showTitle();
      break;
  }
});

showTitle();
