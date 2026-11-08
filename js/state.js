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
    styleTotals: {}, // the same over the whole game (listener-type result)
    typeCounts: {}, // choices taken by type (good / trap / bad ...)
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

// Lines already read (any playthrough), for 既読スキップ. Stored as short hashes.
const READ_KEY = 'otsuharu.read.v1';
export function loadRead() {
  return new Set(readJson(READ_KEY) ?? []);
}
export function saveRead(set) {
  writeJson(READ_KEY, [...set]);
}

// The how-to-play pages are shown automatically before the first new game.
const HOWTO_KEY = 'otsuharu.howto.v1';
export function hasSeenHowto() {
  return !!readJson(HOWTO_KEY);
}
export function markHowtoSeen() {
  writeJson(HOWTO_KEY, true);
}

// 章をえらぶ: the state at the start of each chapter, from the latest playthrough
// that reached it. { [chapterIndex]: state }
const CHAPTERS_KEY = 'otsuharu.chapters.v1';
export function loadChapterSnapshots() {
  return readJson(CHAPTERS_KEY) ?? {};
}
export function saveChapterSnapshot(state) {
  const all = loadChapterSnapshots();
  all[state.chapterIndex] = { ...state, sceneIndex: 0 };
  writeJson(CHAPTERS_KEY, all);
}

// handle of the latest game, for {name} in the bonus scenes
const HANDLE_KEY = 'otsuharu.handle.v1';
export function loadHandle() {
  return readJson(HANDLE_KEY);
}
export function saveHandle(handle) {
  writeJson(HANDLE_KEY, handle);
}
