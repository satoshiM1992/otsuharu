// Game state and persistence (localStorage). Every storage access is guarded,
// because storage can be unavailable (private browsing, blocked site data, tests).

const SAVE_KEY = 'otsuharu.save.v2';
const GALLERY_KEY = 'otsuharu.gallery.v1';

export function newState({ seed, handle, flags = {} }) {
  return {
    v: 2,
    seed,
    rngState: seed,
    handle,
    haruName: 'ハル',
    affection: 0,
    revealed: false, // affection meter shown (after the first DM)
    pop: 0, // popularity 0..100
    peakPop: 0, // highest popularity reached (epilogue)
    persona: 'angel', // angel | queen | geinin
    personaChanged: false,
    realPersona: 'shy', // shy | amae | shikkari | itazura (ひなの off stream)
    chapterStyles: {}, // comment styles chosen this chapter: { kind, mitsugi, neta }
    mood: null,
    moodChapter: null,
    chapterIndex: 0,
    sceneIndex: 0,
    flags: { ...flags },
    topicsUsed: [],
  };
}

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the game still works, it just cannot resume */
  }
}

export function saveGame(state) {
  writeJson(SAVE_KEY, state);
}

export function loadGame() {
  const s = readJson(SAVE_KEY);
  return s && s.v === 2 ? s : null;
}

export function clearSave() {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadGallery() {
  const g = readJson(GALLERY_KEY) ?? {};
  return { endings: g.endings ?? {}, rares: g.rares ?? {} };
}

export function recordGallery(kind, id) {
  const g = loadGallery();
  g[kind][id] = true;
  writeJson(GALLERY_KEY, g);
}
