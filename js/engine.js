// Scenario engine. It has no DOM access: it drives a `ui` and an `avatar`
// object through small interfaces, so it can also run inside the test page
// with fake implementations.

import { viewersFor, subsFor, fmtCount } from './stats.js';

export const ABORT = Symbol('abort');

// Rare events with special handling in the engine; every other id in
// data.rares is a generic event: { chance, at?: 'before'|'after', lines }.
const SPECIAL_RARES = ['cat', 'slip', 'pin', 'tategaki'];

export const TYPE_LABEL = {
  good: '💗好印象',
  normal: '🙂普通',
  bad: '💀ダメ',
  trap: '💣地雷',
  gag: '🤪ギャグ',
  out: '☠️一発アウト',
};

export const STYLE_LABEL = { kind: '😇', mitsugi: '💰', neta: '🎤' };

// Three hidden-ish stats drive the story besides affection:
//   pop      0..100 popularity, shown as viewers / subscribers
//   persona  'angel' | 'queen' | 'geinin', re-evaluated at the end of each
//            chapter from the comment styles chosen in it (kind / mitsugi / neta)
//   revealed affection is hidden (no meter, no popups) until {cmd: "reveal"}
//   realPersona  'shy' | 'amae' | 'shikkari' | 'itazura' — who ひなの is off
//            stream. Starts shy; {cmd: "persona"} re-evaluates it from the
//            styles chosen since the last evaluation (data.realPersonas).
//            In chapters with "real": true its styleMod replaces the VTuber one.
export class Engine {
  /**
   * @param {object} p
   * @param {object} p.data     parsed data/scenario.json
   * @param {object} p.ui       see js/ui.js for the interface
   * @param {object} p.avatar   see js/avatar.js for the interface
   * @param {object} p.state    from newState() or loadGame()
   * @param {object} p.rng      from createRng(); its state must match state.rngState
   * @param {object} [p.options] { debug, rare: 'all' | 'cat,pin' }
   * @param {object} [p.hooks]  { onSave(state), onRare(id) }
   */
  constructor({ data, ui, avatar, state, rng, options = {}, hooks = {} }) {
    Object.assign(this, { data, ui, avatar, state, rng, options, hooks });
    this.chapter = null;
  }

  get rules() {
    return this.data.rules;
  }

  /** Runs from the saved position until an ending. Returns { type: 'ending', id } or { type: 'abort' }. */
  async run() {
    const { data, state } = this;
    let resumed = true;
    try {
      while (state.chapterIndex < data.chapters.length) {
        const ch = data.chapters[state.chapterIndex];
        this.chapter = ch;
        if (state.moodChapter !== ch.id) {
          state.mood = this.rng.pick(Object.keys(data.moods));
          state.moodChapter = ch.id;
        }
        while (state.sceneIndex < ch.scenes.length) {
          const scene = ch.scenes[state.sceneIndex];
          state.rngState = this.rng.state;
          this.hooks.onSave?.(state);
          this.applySettings({ ...ch.defaults, face: 'neutral', ...scene.set });
          this.refreshHud();
          if (resumed || state.sceneIndex === 0) {
            await this.ui.card(ch.subtitle, ch.title);
            resumed = false;
            if (state.sceneIndex === 0 && state.personaChanged) {
              state.personaChanged = false;
              await this.playLines(data.personas?.[state.persona]?.becomes);
            }
          }
          const result = await this.playScene(scene);
          if (result?.end) return await this.playEnding(result.end);
          state.sceneIndex++;
        }
        if (ch.evalPersona !== false) this.updatePersona();
        state.chapterIndex++;
        state.sceneIndex = 0;
      }
      return await this.playEnding('friend');
    } catch (e) {
      if (e === ABORT) return { type: 'abort' };
      throw e;
    }
  }

  // ---------------------------------------------------------------- scenes

  async playScene(scene) {
    const { state, data } = this;
    // optional scenes: "if" conditions and "chance" (random event)
    if (!this.test(scene.if)) return null;
    if (scene.chance != null && !this.rng.chance(scene.chance)) return null;
    // rareEnd: { ending, chance, if?, at?: 'start' } ends the game early with a
    // very rare ending, either before the scene or right before its choice.
    const rareEnd = scene.rareEnd;
    if (rareEnd?.at === 'start' && this.rareEndHit(rareEnd)) return { end: rareEnd.ending };
    let v = scene;
    if (scene.topic) {
      // topic: true draws one of scene.variants; topic: "events" draws from
      // chapter.topics.events, so several scenes can share one event pool.
      // Keys already used this game are skipped while fresh ones remain.
      const variants = typeof scene.topic === 'string' ? this.chapter.topics[scene.topic] : scene.variants;
      const all = Object.keys(variants);
      const fresh = all.filter((k) => !state.topicsUsed.includes(k));
      const topic = this.rng.pick(fresh.length ? fresh : all);
      state.topicsUsed.push(topic);
      v = variants[topic];
      if (v.set) this.applySettings(v.set);
    } else if (scene.variantBy === 'persona' || scene.variantBy === 'real') {
      const key = scene.variantBy === 'real' ? this.realPersona : state.persona;
      v = scene.variants[key] ?? scene.variants.default;
      if (v.set) this.applySettings(v.set);
    }
    await this.playLines(scene.intro);
    const merged = (key) => (v === scene ? scene[key] : [...(v[key] ?? []), ...(scene[key] ?? [])]);

    // moodHint: true plays the mood line after the scene lines, "before" plays it first.
    const moodLines = data.moods[state.mood]?.hint?.[this.chapter.id];
    if (scene.moodHint === 'before') await this.playLines(moodLines);
    await this.playLines(merged('lines'));
    if (scene.moodHint === true) await this.playLines(moodLines);
    await this.playGenericRares(scene, 'before');

    let extra = null;
    if (scene.rares?.includes('cat') && !state.flags.cat && this.rareHit('cat')) {
      state.flags.cat = true;
      this.hooks.onRare?.('cat');
      await this.playLines(data.rares.cat.lines);
      extra = data.rares.cat.choice;
    }

    if (rareEnd && rareEnd.at !== 'start' && this.rareEndHit(rareEnd)) return { end: rareEnd.ending };

    const choiceDef = v.choice ?? scene.choice;
    if (choiceDef) {
      const r = await this.playChoice(choiceDef, scene, extra);
      if (r?.end) return r;
    }

    await this.playLines(merged('after'));
    await this.playGenericRares(scene, 'after');

    if (scene.rares?.includes('slip') && this.rareHit('slip')) {
      state.flags.slip = true;
      this.hooks.onRare?.('slip');
      await this.playLines(data.rares.slip.lines);
    }

    if (scene.gate) {
      if (state.affection < scene.gate.min) return { end: scene.gate.fail };
      await this.playLines(scene.gate.pass);
    }
    return null;
  }

  async playGenericRares(scene, at) {
    for (const id of scene.rares ?? []) {
      const r = this.data.rares[id];
      if (SPECIAL_RARES.includes(id) || !r || (r.at ?? 'after') !== at) continue;
      if (!this.test(r.if) || !this.rareHit(id)) continue;
      this.state.flags[id] = true;
      this.hooks.onRare?.(id);
      await this.playLines(r.lines);
    }
  }

  async playChoice(def, scene, extra) {
    const { state, data } = this;
    const options = this.drawChoices(def, scene);
    if (extra) options.push(extra);

    const idx = await this.ui.choose(
      options.map((o) => ({
        text: this.fmt(o.text),
        type: o.type,
        style: this.styleOf(o),
        spice: o.spice ?? null,
        tag: this.options.debug ? `${TYPE_LABEL[o.type]}${STYLE_LABEL[this.styleOf(o)] ?? ''}` : null,
      })),
    );
    const c = options[idx];

    if (c.echo !== false) {
      const echo = { who: 'me', text: c.echo ?? c.text };
      for (let i = 0; i < (c.repeat ?? 1); i++) await this.playLines([echo]);
    }
    if (c.flag) state.flags[c.flag] = true;

    if (c.special === 'tategaki') {
      const t = data.rares.tategaki;
      const r = this.rng.chance(t.noticeRate) ? t.noticed : t.missed;
      this.changeAffection(r.delta);
      this.applyStyle({ type: 'good' });
      await this.playLines(r.lines);
      return null;
    }

    if (c.end) {
      await this.playLines(this.pickReaction(c));
      return { end: c.end };
    }

    this.changeAffection(this.computeDelta(c));
    this.applyStyle(c);

    const pin = data.rares.pin;
    if (c.type === 'good' && pin.chapters.includes(this.chapter.id) && this.rareHit('pin')) {
      this.hooks.onRare?.('pin');
      await this.playLines([{ who: 'sys', text: pin.text }]);
      this.changeAffection(pin.delta);
    }

    await this.playLines(this.pickReaction(c));

    // creepy / dirty comments add up: a warning, then Haru has had enough
    if (c.spice === 'gesu') {
      state.gesu = (state.gesu ?? 0) + 1;
      const g = this.rules.gesu ?? {};
      if (g.limit && state.gesu >= g.limit) return { end: g.end };
      if (g.limit && state.gesu === g.limit - 1) await this.playLines(g.warn);
    }

    if (scene.resolve === 'confession') return { end: this.resolveConfession(c) };
    return null;
  }

  /**
   * Draws the choices shown for one scene:
   * always one 💗, one 🤪, one 💰 and one 💣 when the pool has any, a ☠️ with probability outRate,
   * the rest from the remaining pool. The order is shuffled.
   * In a stream, one slot always holds a "spice" comment from data.spice
   * (a net meme 🤪, or a creepy / dirty comment 💀☠️) — the 🤪 slot when a ☠️ takes the free slot.
   */
  drawChoices(def, scene) {
    const { rng, data } = this;
    const pool = def.pool.filter((c) => this.test(c.if));
    const goods = pool.filter((c) => c.type === 'good');
    const gags = pool.filter((c) => c.type === 'gag');
    const outs = pool.filter((c) => c.type === 'out');
    const traps = pool.filter((c) => c.type === 'trap');
    const count = def.count ?? this.rules.choiceCount ?? 3;
    const spice = this.uiMode === 'stream' && !def.noSpice ? (data.spice ?? []).filter((c) => this.test(c.if)) : [];
    const memes = spice.filter((c) => c.spice === 'meme');
    const picked = [];

    let good = rng.pick(goods);
    if (scene.rares?.includes('tategaki') && this.rareHit('tategaki')) {
      good = { ...data.rares.tategaki.choice, type: 'good', special: 'tategaki' };
      this.hooks.onRare?.('tategaki');
    }
    picked.push(good);

    const outRate = def.outRate ?? this.rules.outRate;
    const outRoll = outs.length > 0 && rng.chance(outRate);
    // with a ☠️ there is no free slot left, so the 🤪 slot carries the meme
    const gagPool = outRoll && memes.length ? memes : gags;
    if (gagPool.length && picked.length < count) picked.push(rng.pick(gagPool));
    // a 💰 superchat when the pool has one (so a tipping player can keep tipping)
    const tips = pool.filter((c) => this.styleOf(c) === 'mitsugi' && c.type !== 'out' && !picked.includes(c));
    if (tips.length && picked.length < count) picked.push(rng.pick(tips));
    const freeTraps = traps.filter((c) => !picked.includes(c));
    if (freeTraps.length && picked.length < count) picked.push(rng.pick(freeTraps));
    if (outRoll && picked.length < count) picked.push(rng.pick(outs));
    if (spice.length && !picked.some((c) => spice.includes(c)) && picked.length < count) picked.push(this.pickSpice(spice));

    const rest = pool.filter((c) => c.type !== 'good' && c.type !== 'out' && !picked.includes(c));
    for (const c of rng.shuffle(rest)) {
      if (picked.length >= count) break;
      picked.push(c);
    }
    for (const c of rng.shuffle(goods)) {
      if (picked.length >= count) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return rng.shuffle(picked);
  }

  // rules.spiceRate { meme, bad, out }: chance of each kind of spice comment
  pickSpice(spice) {
    const rate = this.rules.spiceRate ?? {};
    const kinds = [
      ['meme', (c) => c.spice === 'meme'],
      ['bad', (c) => c.spice !== 'meme' && c.type !== 'out'],
      ['out', (c) => c.spice !== 'meme' && c.type === 'out'],
    ].filter(([, f]) => spice.some(f));
    const total = kinds.reduce((t, [k]) => t + (rate[k] ?? 1), 0);
    let r = this.rng.next() * total;
    for (const [k, f] of kinds) {
      r -= rate[k] ?? 1;
      if (r < 0) return this.rng.pick(spice.filter(f));
    }
    return this.rng.pick(spice);
  }

  computeDelta(c) {
    const { state, data } = this;
    let d = c.delta ?? this.rules.typeDelta[c.type] ?? 0;
    d += data.moods[state.mood]?.typeMod?.[c.type] ?? 0;
    d += c.moodDelta?.[state.mood] ?? 0;
    // the persona likes some comment styles more (queen: superchats, geinin: jokes);
    // on dates it is ひなの's real-life personality that counts
    const prefs = this.chapter?.real ? data.realPersonas?.[this.realPersona] : data.personas?.[state.persona];
    d += prefs?.styleMod?.[this.styleOf(c)] ?? 0;
    d += c.personaDelta?.[state.persona] ?? 0;
    return d;
  }

  resolveConfession(c) {
    const a = this.state.affection;
    if (c.confess && a >= this.rules.loverMin) return 'lover';
    // joke confessions need more affection, except for a persona that loves jokes
    const gagMin = Math.min(
      this.data.personas?.[this.state.persona]?.loverGagMin ?? this.rules.loverGagMin,
      this.data.realPersonas?.[this.realPersona]?.loverGagMin ?? this.rules.loverGagMin,
    );
    if (c.confessGag && a >= gagMin) return 'lover';
    return 'friend';
  }

  pickReaction(c) {
    return this.rng.pick(c.reactions) ?? [];
  }

  rareHit(id) {
    const forced = this.options.rare;
    const isForced = forced === 'all' || (forced ?? '').split(',').includes(id);
    return this.rng.chance(isForced ? 1 : (this.data.rares[id]?.chance ?? 0));
  }

  // Rare endings are forced only when named explicitly (?rare=neochi), never by ?rare=all.
  rareEndHit(r) {
    if (!this.test(r.if)) return false;
    const forced = (this.options.rare ?? '').split(',').includes(r.ending);
    return this.rng.chance(forced ? 1 : r.chance);
  }

  async playEnding(id) {
    const { state, data } = this;
    id = this.routeEnding(id);
    const ending = data.endings[id];
    if (!ending) throw new Error(`unknown ending: ${id}`);
    await this.playLines(ending.lines);
    return { type: 'ending', id };
  }

  // data.routes: { friend: [{ if: {...}, to: 'zarigani' }, ...] } — the first
  // matching route replaces the ending (followed again, so routes can chain).
  routeEnding(id) {
    for (let hops = 0; hops < 8; hops++) {
      const next = this.data.routes?.[id]?.find((r) => this.test(r.if))?.to;
      if (!next) break;
      id = next;
    }
    return id;
  }

  // ------------------------------------------------------------ pop / persona

  styleOf(c) {
    return c.style ?? this.rules.typeStyle?.[c.type] ?? null;
  }

  applyStyle(c) {
    const style = this.styleOf(c);
    const s = this.state;
    if (style) s.chapterStyles[style] = (s.chapterStyles[style] ?? 0) + (c.styleW ?? 1);
    // Only comments in a stream are seen by viewers; DMs, calls and dates are
    // private, so they never move popularity (the persona vote still counts).
    if (this.uiMode !== 'stream') return;
    const d = c.pop ?? this.rules.stylePop?.[style] ?? 0;
    if (d) this.changePop(d);
  }

  changePop(d) {
    const s = this.state;
    const before = s.pop;
    s.pop = Math.max(0, Math.min(100, s.pop + d));
    if (s.pop !== before) this.ui.popPopularity?.(s.pop - before);
    this.refreshHud();
  }

  /** Switches persona when another style led the chapter by rules.personaMargin. */
  updatePersona() {
    const s = this.state;
    const personas = this.data.personas ?? {};
    const byStyle = Object.fromEntries(Object.entries(personas).map(([id, p]) => [p.style, id]));
    const count = (st) => s.chapterStyles[st] ?? 0;
    const cur = personas[s.persona]?.style;
    const [top] = Object.keys(byStyle).sort((a, b) => count(b) - count(a));
    if (top && top !== cur && count(top) - count(cur) >= (this.rules.personaMargin ?? 1)) {
      s.persona = byStyle[top];
      s.personaChanged = true;
      s.flags[`was_${s.persona}`] = true;
    }
    s.chapterStyles = {};
  }

  get realPersona() {
    return this.state.realPersona ?? 'shy';
  }

  /** {cmd: "persona"}: ひなの's real-life personality follows the styles chosen since the last check. */
  async updateRealPersona() {
    const s = this.state;
    const defs = this.data.realPersonas ?? {};
    const byStyle = Object.fromEntries(Object.entries(defs).filter(([, p]) => p.style).map(([id, p]) => [p.style, id]));
    const votes = s.chapterStyles;
    s.chapterStyles = {};
    const count = (st) => votes[st] ?? 0;
    const cur = defs[this.realPersona]?.style;
    // most-chosen style wins; a tie only goes to kind (being nice is how she opens up)
    const [top, second] = Object.keys(byStyle).sort((a, b) => count(b) - count(a) || (b === 'kind') - (a === 'kind'));
    const clear = count(top) > count(second) || top === 'kind';
    if (top && top !== cur && clear && count(top) - count(cur) >= (this.rules.personaMargin ?? 1)) {
      s.realPersona = byStyle[top];
      s.flags[`real_${s.realPersona}`] = true;
      await this.playLines(defs[s.realPersona].becomes);
    } else {
      await this.playLines(defs[this.realPersona]?.stays);
    }
    this.refreshHud();
  }

  // ----------------------------------------------------------------- lines

  async playLines(lines) {
    for (let line of lines ?? []) {
      if (!this.test(line.if)) continue;
      if (line.cmd) {
        await this.runCmd(line);
        continue;
      }
      // by: { queen: { text, face, motion } } overrides fields for a persona;
      // a real-life personality key (amae, ...) wins over the VTuber one
      const by = line.by?.[this.realPersona] ?? line.by?.[this.state.persona];
      if (by) line = { ...line, ...by };
      if (line.who === 'haru' && line.face) this.avatar.setExpression(line.face);
      if (line.motion) this.avatar.playMotion(line.motion);
      await this.ui.say({
        who: line.who,
        name: this.speakerName(line),
        text: this.fmt(line.text),
        voice: this.voiceFor(line),
      });
    }
  }

  // Short voice clip for one of Haru's lines: { key, forced } or null.
  // line.voice: "laugh" forces a clip, false suppresses it; otherwise the face
  // set on the line picks one (data.voice.byFace) and the sound layer applies
  // rate/cooldown.
  voiceFor(line) {
    if (line.who !== 'haru' || line.voice === false) return null;
    if (line.voice) return { key: line.voice, forced: true };
    const key = this.data.voice?.byFace?.[line.face];
    return key ? { key, forced: false } : null;
  }

  async runCmd(line) {
    switch (line.cmd) {
      case 'flag':
        this.state.flags[line.key] = line.value ?? true;
        break;
      case 'set':
        this.applySettings(line);
        break;
      case 'face':
        this.avatar.setExpression(line.value);
        break;
      case 'motion':
        this.avatar.playMotion(line.value);
        break;
      case 'wait':
        await this.ui.wait(line.ms ?? 500);
        break;
      case 'pop':
        this.changePop(line.value ?? 0);
        break;
      case 'affection':
        this.changeAffection(line.value ?? 0);
        break;
      case 'persona':
        await this.updateRealPersona();
        break;
      case 'reveal':
        this.state.revealed = true;
        this.ui.revealAffection?.();
        this.refreshHud();
        break;
      default:
        throw new Error(`unknown cmd: ${line.cmd}`);
    }
  }

  applySettings(s) {
    if (s.ui) {
      this.uiMode = s.ui;
      this.ui.setMode(s.ui);
    }
    if (s.bg) this.ui.setBackground(s.bg);
    if (s.stream) this.ui.setStream({ ...s.stream, title: s.stream.title && this.fmt(s.stream.title) });
    if (s.model) this.avatar.setModel(s.model);
    if (s.face) this.avatar.setExpression(s.face);
    if (s.haruName) this.state.haruName = s.haruName;
    if (s.contact) this.ui.setContact?.(s.contact);
  }

  speakerName(line) {
    if (line.name) return line.name;
    switch (line.who) {
      case 'haru':
        return this.state.haruName;
      case 'me':
        return this.state.handle;
      case 'mob': {
        const names = this.data.mob.names;
        return names[Math.floor(Math.random() * names.length)];
      }
      default:
        return '';
    }
  }

  callName() {
    const { handle, flags, affection } = this.state;
    // chapter.call: 'listener' (until noticed) | 'san' (くん from affection 75) | 'kun'
    switch (this.chapter?.call ?? 'kun') {
      case 'listener':
        return flags.noticed ? `${handle}さん` : 'リスナーさん';
      case 'san':
        return affection >= 75 ? `${handle}くん` : `${handle}さん`;
      default:
        return `${handle}くん`;
    }
  }

  fmt(text) {
    const pop = this.state.pop ?? 0;
    return String(text ?? '')
      .replaceAll('{name}', this.state.handle)
      .replaceAll('{call}', this.callName())
      .replaceAll('{viewers}', fmtCount(viewersFor(pop)))
      .replaceAll('{subs}', fmtCount(subsFor(pop)));
  }

  test(cond) {
    if (!cond) return true;
    const s = this.state;
    if (cond.mood && cond.mood !== s.mood) return false;
    if (cond.flag && !s.flags[cond.flag]) return false;
    if (cond.notFlag && s.flags[cond.notFlag]) return false;
    if (cond.minAff != null && s.affection < cond.minAff) return false;
    if (cond.maxAff != null && s.affection > cond.maxAff) return false;
    if (cond.chapter != null && ![].concat(cond.chapter).includes(this.chapter?.id)) return false;
    if (cond.persona && ![].concat(cond.persona).includes(s.persona)) return false;
    if (cond.notPersona && [].concat(cond.notPersona).includes(s.persona)) return false;
    if (cond.real && ![].concat(cond.real).includes(this.realPersona)) return false;
    if (cond.notReal && [].concat(cond.notReal).includes(this.realPersona)) return false;
    if (cond.minPop != null && s.pop < cond.minPop) return false;
    if (cond.maxPop != null && s.pop > cond.maxPop) return false;
    if (cond.revealed != null && !!s.revealed !== cond.revealed) return false;
    return true;
  }

  // ------------------------------------------------------------- affection

  changeAffection(d) {
    const s = this.state;
    s.affection = Math.max(0, Math.min(this.rules.max, s.affection + d));
    if (s.revealed) this.ui.popDelta(d); // hidden phase: Haru's reaction is the only feedback
    this.refreshHud();
  }

  refreshHud() {
    const s = this.state;
    this.ui.setAffection(s.revealed ? s.affection / this.rules.max : null);
    this.ui.setPopularity?.(s.pop);
    this.ui.setChapter(this.chapter?.title ?? '');
    if (this.options.debug) {
      const mood = this.data.moods[s.mood]?.label ?? '-';
      let p = this.data.personas?.[s.persona]?.label ?? s.persona;
      if (this.chapter?.real) p += `/${this.data.realPersonas?.[this.realPersona]?.label ?? this.realPersona}`;
      const st = Object.entries(s.chapterStyles).map(([k, v]) => `${STYLE_LABEL[k] ?? k}${v}`).join('');
      this.ui.setDebug(`♥${s.affection} 📈${s.pop} ${p}${st ? ` (${st})` : ''} ${mood}`);
    }
  }
}
