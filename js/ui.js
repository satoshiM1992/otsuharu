// DOM side of the game. The engine talks to it only through:
//   setMode, setBackground, setStream, setAffection, setPopularity, setChapter,
//   setDebug, revealAffection, say, choose, card, popDelta, popPopularity, wait
// Four layouts are switched with a class on #screen-game:
//   mode-stream (配信サイト), mode-dm (メッセージアプリ), mode-call (通話), mode-adv (ノベル)

import { ABORT } from './engine.js';
import { sound } from './sound.js';
import { viewersFor, subsFor, fmtCount } from './stats.js';
import { loadRead, saveRead } from './state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = ['stream', 'dm', 'call', 'adv'];

// Illustrated backgrounds: img/bg/<name>.(jpg|webp|png|svg), first file found
// wins, so dropping in station.jpg replaces the bundled station.svg.
// Other backgrounds (room, night, call) are CSS gradients only.
const IMAGE_BGS = ['station', 'cafe', 'arcade', 'sunset', 'aquarium', 'park'];
const BG_EXTS = ['jpg', 'webp', 'png', 'svg'];
const bgCache = {};
function resolveBg(name) {
  if (!IMAGE_BGS.includes(name)) return Promise.resolve(null);
  bgCache[name] ??= new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= BG_EXTS.length) return resolve(null);
      const url = `img/bg/${name}.${BG_EXTS[i++]}`;
      const img = new Image();
      // absolute URL: a relative url() inside a CSS variable is resolved against
      // the stylesheet (css/), not the page, and would 404
      img.onload = () => resolve(new URL(url, document.baseURI).href);
      img.onerror = next;
      img.src = url;
    };
    next();
  });
  return bgCache[name];
}

export const preloadBackgrounds = () => IMAGE_BGS.forEach(resolveBg);

export class UI {
  constructor({ avatar, mob, debug = false }) {
    this.$ = (id) => document.getElementById(id);
    this.avatar = avatar;
    this.mob = mob;
    this.debug = debug;
    this.speed = 32; // ms per character
    this.mode = null;
    this.pending = null;
    this.typing = false;
    this.skip = false;
    this.aborted = false;
    this.mobKey = 'common';
    this.viewers = 23;
    this.timers = {};
    this.lastLine = null; // shown above the choices so the question stays readable
    this.log = []; // backlog for the menu
    this.read = loadRead(); // keys of lines read in any playthrough
    this.skipMode = false; // ⏩ 既読スキップ
    this.fast = false; // the current line is skipped
    this.bgmOverride = null;

    this.game = this.$('screen-game');
    this.msg = this.$('msg');
    this.msgName = this.$('msg-name');
    this.msgText = this.$('msg-text');
    this.comments = this.$('comments');
    this.chat = this.$('chat');
    this.choicesBox = this.$('choices');

    this.game.addEventListener('click', (e) => this.onTap(e));
    this.$('btn-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('menu').hidden = false;
    });
    // flush the read lines when the page is hidden or closed
    const flush = () => saveRead(this.read);
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.hidden && flush());
    this.$('btn-skip').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setSkip(!this.skipMode);
      // start right away if a read line is waiting for a tap
      const skippable = this.pendingRead || !this.$('card').hidden || !this.$('blackout').hidden;
      if (this.skipMode && this.pending?.kind === 'tap' && skippable) {
        const p = this.pending;
        this.pending = null;
        this.game.classList.remove('wait-tap');
        p.resolve();
      }
    });
    this.$('log').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('[data-action="log-close"]') || e.target.id === 'log') this.$('log').hidden = true;
    });
    this.$('menu').addEventListener('click', (e) => {
      e.stopPropagation();
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'log') this.showLog();
      if (action === 'close' || e.target.id === 'menu') this.$('menu').hidden = true;
      if (action === 'title') {
        this.$('menu').hidden = true;
        this.onMenuTitle?.();
      }
    });
  }

  // ------------------------------------------------------------ lifecycle

  reset() {
    this.aborted = false;
    this.pending = null;
    this.mode = null;
    this.comments.innerHTML = '';
    this.chat.innerHTML = '';
    this.msg.hidden = true;
    this.choicesBox.hidden = true;
    this.$('card').hidden = true;
    this.$('blackout').hidden = true;
    this.$('menu').hidden = true;
    this.$('log').hidden = true;
    this.lastLine = null;
    this.log = [];
    this.setSkip(false);
    this.fast = false;
    this.bgmOverride = null;
    this.setContact('天音ハル');
    this.$('hud-debug').hidden = !this.debug;
  }

  abort() {
    this.aborted = true;
    this.stopTimers();
    this.avatar.setTalking(false);
    const p = this.pending;
    this.pending = null;
    p?.reject(ABORT);
  }

  check() {
    if (this.aborted) throw ABORT;
  }

  showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `screen-${name}`));
    if (name !== 'game') this.stopTimers();
  }

  // --------------------------------------------------------------- input

  setSkip(on) {
    this.skipMode = on;
    const b = this.$('btn-skip');
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }

  markRead(key) {
    if (!key || this.read.has(key)) return;
    this.read.add(key);
    // throttled (not debounced) so fast tapping still saves
    this.readTimer ??= setTimeout(() => {
      this.readTimer = null;
      saveRead(this.read);
    }, 800);
  }

  // after a line: a tap, or a short pause while skipping read lines
  async advance() {
    if (this.fast) return this.wait(70);
    return this.waitTap();
  }

  onTap(e) {
    if (e.target.closest('button, .choices, .menu, .log')) return;
    // tapping while skipping stops the skip
    if (this.skipMode && this.fast) {
      this.setSkip(false);
      return;
    }
    if (this.typing) {
      this.skip = true;
      return;
    }
    if (this.pending?.kind === 'tap') {
      const p = this.pending;
      this.pending = null;
      this.game.classList.remove('wait-tap');
      sound.se('tap');
      p.resolve();
    }
  }

  waitTap() {
    this.check();
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'tap', resolve, reject };
      this.game.classList.add('wait-tap');
    });
  }

  async wait(ms) {
    await sleep(this.skipMode ? Math.min(ms, 60) : ms);
    this.check();
  }

  // -------------------------------------------------------------- layout

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    MODES.forEach((m) => this.game.classList.toggle(`mode-${m}`, m === mode));
    this.comments.innerHTML = '';
    this.chat.innerHTML = '';
    this.msg.hidden = true;
    this.msgText.textContent = '';
    this.lastLine = null;
    this.stopTimers();
    if (mode === 'stream') this.startMobComments();
    if (mode === 'call') this.startCallTimer();
    if (mode === 'call') sound.se('ring');
    this.updateBgm();
  }

  setBackground(bg) {
    const stage = this.$('stage');
    stage.dataset.bg = bg;
    this.bg = bg;
    stage.style.removeProperty('--bg-img');
    resolveBg(bg).then((url) => {
      if (url && this.bg === bg) stage.style.setProperty('--bg-img', `url("${url}")`);
    });
    this.updateBgm();
  }

  updateBgm() {
    const m = this.mode;
    if (!m) return;
    sound.bgm(this.bgmOverride ?? (m === 'stream' ? 'stream' : m === 'adv' && this.bg !== 'night' ? 'date' : 'night'));
  }

  // special track for a scene / ending (null: back to the one for the layout)
  setBgm(name) {
    this.bgmOverride = name ?? null;
    this.updateBgm();
  }

  setStream({ title, mob }) {
    if (title) this.$('stream-title').textContent = title;
    if (mob) this.mobKey = mob;
  }

  // ratio 0..1, or null while affection is still hidden
  setAffection(ratio) {
    this.$('heart-meter').hidden = ratio == null;
    if (ratio != null) this.$('heart-fill').style.height = `${Math.round(ratio * 100)}%`;
  }

  revealAffection() {
    const m = this.$('heart-meter');
    m.hidden = false;
    m.classList.remove('reveal');
    void m.offsetWidth;
    m.classList.add('reveal');
    sound.se('rare');
  }

  setPopularity(pop) {
    this.pop = pop;
    this.viewers = viewersFor(pop);
    this.$('viewers').textContent = fmtCount(this.viewers);
    this.$('hud-subs').textContent = fmtCount(subsFor(pop));
  }

  // name in the DM header and on the call screen (天音ハル → ひなの after meeting)
  setContact(name) {
    document.querySelector('.dm-header b').textContent = name;
    document.querySelector('.call-name').textContent = name;
  }

  setChapter(label) {
    this.$('hud-chapter').textContent = label;
  }

  setDebug(text) {
    this.$('hud-debug').textContent = text;
  }

  // ------------------------------------------------------------- talking

  async say(line) {
    this.check();
    this.remember(line);
    const read = !!line.key && this.read.has(line.key);
    this.markRead(line.key);
    if (this.skipMode && !read) this.setSkip(false); // stop at the first new line
    this.fast = this.skipMode && read;
    this.pendingRead = read;
    this.clipPlayed = !!(line.voice && this.mode !== 'dm' && !this.fast && sound.voice(line.voice.key, line.voice.forced));
    if (this.mode === 'dm') return this.sayDm(line);
    if (this.mode === 'stream' && line.who !== 'haru' && line.who !== 'narr') {
      this.addComment(line);
      await this.wait(line.who === 'me' ? 650 : 500);
      if (line.who === 'sys') await this.advance();
      return;
    }
    await this.sayMsg(line);
  }

  async sayMsg({ who, name, text, face, tone }) {
    this.msg.hidden = false;
    this.msg.dataset.who = who;
    this.msgName.textContent = name || '';
    this.msgName.hidden = !name;
    const haru = who === 'haru';
    if (haru) this.avatar.setTalking(true);
    if (this.fast) this.msgText.textContent = text;
    else {
      // talking blips unless a recorded voice clip is playing for this line
      const blipFace = face ?? this.lastFace ?? 'neutral';
      const onChar = haru
        ? (ch) => {
            this.avatar.speakChar?.(ch);
            if (!this.clipPlayed) sound.blip(ch, { face: blipFace, tone });
          }
        : null;
      await this.typeText(this.msgText, text, onChar);
    }
    if (haru && face) this.lastFace = face;
    this.avatar.setTalking(false);
    await this.advance();
  }

  async typeText(el, text, onChar = null) {
    this.typing = true;
    this.skip = false;
    const chars = [...text];
    el.textContent = '';
    for (const ch of chars) {
      if (this.skip || this.aborted) break;
      el.textContent += ch;
      onChar?.(ch);
      await sleep(this.speed);
    }
    el.textContent = text;
    this.typing = false;
    this.check();
  }

  remember({ who, name, text }) {
    if (!text) return;
    this.log.push({ who, name, text });
    if (this.log.length > 300) this.log.shift();
    if (who === 'haru' || who === 'narr') this.lastLine = { who, name, text };
  }

  showLog() {
    const list = this.$('log-list');
    list.innerHTML = '';
    for (const { who, name, text } of this.log) {
      const row = document.createElement('div');
      row.className = `log-row is-${who}`;
      if (name) {
        const n = document.createElement('b');
        n.textContent = name;
        row.append(n);
      }
      const t = document.createElement('p');
      t.textContent = text;
      row.append(t);
      list.append(row);
    }
    if (!this.log.length) list.innerHTML = '<p class="hint">まだログはありません</p>';
    this.$('log').hidden = false;
    list.scrollTop = list.scrollHeight;
  }

  addComment({ who, name, text }) {
    const row = document.createElement('div');
    row.className = 'comment';
    if (who === 'me') sound.se('post');
    if (who === 'me') row.classList.add('is-me');
    if (who === 'sys') row.classList.add('is-sys');
    if (/^¥/.test(text)) row.classList.add('is-sc');
    if (name) {
      const n = document.createElement('span');
      n.className = 'c-name';
      n.textContent = name;
      row.append(n);
    }
    const t = document.createElement('span');
    t.className = 'c-text';
    t.textContent = text;
    row.append(t);
    this.comments.append(row);
    while (this.comments.children.length > 40) this.comments.firstElementChild.remove();
  }

  async sayDm({ who, text }) {
    if (who === 'haru') {
      const typing = this.addBubble('haru typing', '');
      typing.innerHTML = '<span></span><span></span><span></span>';
      await this.wait(Math.min(1200, 450 + text.length * 18));
      typing.remove();
      this.addBubble('haru', text);
      if (!this.fast) sound.se('dm');
      await this.advance();
    } else if (who === 'me') {
      this.addBubble('me', text);
      await this.wait(500);
    } else {
      this.addBubble('note', text);
      await this.advance();
    }
  }

  addBubble(cls, text) {
    const b = document.createElement('div');
    b.className = `bubble ${cls}`;
    b.textContent = text;
    this.chat.append(b);
    this.chat.scrollTop = this.chat.scrollHeight;
    return b;
  }

  // ------------------------------------------------------------- choices

  choose(options) {
    this.check();
    const box = this.choicesBox;
    box.innerHTML = '';
    const label = { stream: 'コメントを送る', dm: '返信する' }[this.mode];
    // The sheet covers the subtitle / chat, so repeat the line being answered.
    if (label && this.lastLine) {
      const q = document.createElement('div');
      q.className = 'choices-context';
      if (this.lastLine.name) {
        const n = document.createElement('b');
        n.textContent = this.lastLine.name;
        q.append(n);
      }
      q.append(this.lastLine.text);
      box.append(q);
    }
    if (label) {
      const h = document.createElement('p');
      h.className = 'choices-label';
      h.textContent = label;
      box.append(h);
    }
    return new Promise((resolve, reject) => {
      this.pending = { kind: 'choice', resolve, reject };
      options.forEach((o, i) => {
        const b = document.createElement('button');
        b.className = 'choice';
        b.style.setProperty('--i', i);
        b.textContent = o.text;
        if (o.tag) {
          const tag = document.createElement('small');
          tag.className = 'choice-tag';
          tag.textContent = o.tag;
          b.prepend(tag);
        }
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.pending?.kind !== 'choice') return;
          this.pending = null;
          sound.se('select');
          box.hidden = true;
          box.scrollTop = 0;
          resolve(i);
        });
        box.append(b);
      });
      box.hidden = false;
    });
  }

  // ------------------------------------------------------------- effects

  popDelta(d) {
    const el = document.createElement('div');
    el.className = `popup ${d > 0 ? 'up' : d < 0 ? 'down' : 'zero'}`;
    el.textContent = d > 0 ? `好感度 +${d} 💗` : d < 0 ? `好感度 ${d} 💀` : '好感度 ±0';
    this.$('popups').append(el);
    setTimeout(() => el.remove(), 1700);
    if (d > 0) sound.se('up');
    else if (d <= -10) sound.se('bigdown');
    else if (d < 0) sound.se('down');
    if (d <= -10) {
      this.game.classList.remove('shake');
      void this.game.offsetWidth;
      this.game.classList.add('shake');
    }
  }

  popPopularity(d) {
    const el = document.createElement('div');
    el.className = `popup pop ${d > 0 ? 'up' : 'down'}`;
    el.textContent = `📈 人気 ${d > 0 ? '+' : ''}${d}`;
    this.$('popups').append(el);
    setTimeout(() => el.remove(), 1500);
    sound.se(d > 0 ? 'coin' : 'down');
  }

  // Fade to black, show one line (e.g. "── それから、数年後。 ──"), wait for a tap.
  async blackout(text) {
    const el = this.$('blackout');
    el.querySelector('.blackout-text').textContent = text;
    el.hidden = false;
    el.classList.remove('is-out');
    sound.se('card');
    try {
      await this.wait(900);
      if (this.skipMode) await sleep(700);
      else await this.waitTap();
    } finally {
      el.classList.add('is-out');
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-out');
      }, 500);
    }
  }

  async card(sub, title) {
    const card = this.$('card');
    card.querySelector('.card-sub').textContent = sub ?? '';
    card.querySelector('.card-title').textContent = title ?? '';
    card.hidden = false;
    this.pendingRead = false;
    sound.se('card');
    try {
      if (this.skipMode) await this.wait(600);
      else await this.waitTap();
    } finally {
      card.hidden = true;
    }
  }

  // -------------------------------------------------------------- timers

  stopTimers() {
    clearTimeout(this.timers.mob);
    clearInterval(this.timers.call);
    this.timers = {};
  }

  startMobComments() {
    const tick = () => {
      const pool = [...this.mob.pools.common, ...(this.mob.pools[this.mobKey] ?? [])];
      const names = this.mob.names;
      this.addComment({
        who: 'mob',
        name: names[Math.floor(Math.random() * names.length)],
        text: pool[Math.floor(Math.random() * pool.length)],
      });
      // viewers wobble around the popularity-based count; busier chat when popular
      const base = viewersFor(this.pop ?? 0);
      this.$('viewers').textContent = fmtCount(Math.max(5, Math.round(base * (0.93 + Math.random() * 0.14))));
      const speed = 1 + (this.pop ?? 0) / 25;
      this.timers.mob = setTimeout(tick, (1100 + Math.random() * 1700) / speed);
    };
    this.timers.mob = setTimeout(tick, 600);
  }

  startCallTimer() {
    let sec = 0;
    const el = this.$('call-time');
    el.textContent = '00:00';
    this.timers.call = setInterval(() => {
      sec++;
      el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }, 1000);
  }
}
