// Scenario engine. It has no DOM access: it drives a `ui` and an `avatar`
// object through small interfaces, so it can also run inside the test page
// with fake implementations.

export const ABORT = Symbol('abort');

export const TYPE_LABEL = {
  good: '💗好印象',
  normal: '🙂普通',
  bad: '💀ダメ',
  gag: '🤪ギャグ',
  out: '☠️一発アウト',
};

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
          }
          const result = await this.playScene(scene);
          if (result?.end) return await this.playEnding(result.end);
          state.sceneIndex++;
        }
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
    let v = scene;
    if (scene.topic) {
      const all = Object.keys(scene.variants);
      const fresh = all.filter((k) => !state.topicsUsed.includes(k));
      const topic = this.rng.pick(fresh.length ? fresh : all);
      state.topicsUsed.push(topic);
      v = scene.variants[topic];
      if (v.set) this.applySettings(v.set);
    }
    const merged = (key) => (v === scene ? scene[key] : [...(v[key] ?? []), ...(scene[key] ?? [])]);

    // moodHint: true plays the mood line after the scene lines, "before" plays it first.
    const moodLines = data.moods[state.mood]?.hint?.[this.chapter.id];
    if (scene.moodHint === 'before') await this.playLines(moodLines);
    await this.playLines(merged('lines'));
    if (scene.moodHint === true) await this.playLines(moodLines);

    let extra = null;
    if (scene.rares?.includes('cat') && !state.flags.cat && this.rareHit('cat')) {
      state.flags.cat = true;
      this.hooks.onRare?.('cat');
      await this.playLines(data.rares.cat.lines);
      extra = data.rares.cat.choice;
    }

    const choiceDef = v.choice ?? scene.choice;
    if (choiceDef) {
      const r = await this.playChoice(choiceDef, scene, extra);
      if (r?.end) return r;
    }

    await this.playLines(merged('after'));

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

  async playChoice(def, scene, extra) {
    const { state, data } = this;
    const options = this.drawChoices(def, scene);
    if (extra) options.push(extra);

    const idx = await this.ui.choose(
      options.map((o) => ({
        text: this.fmt(o.text),
        type: o.type,
        tag: this.options.debug ? TYPE_LABEL[o.type] : null,
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
      await this.playLines(r.lines);
      return null;
    }

    if (c.end) {
      await this.playLines(this.pickReaction(c));
      return { end: c.end };
    }

    this.changeAffection(this.computeDelta(c));

    const pin = data.rares.pin;
    if (c.type === 'good' && pin.chapters.includes(this.chapter.id) && this.rareHit('pin')) {
      this.hooks.onRare?.('pin');
      await this.playLines([{ who: 'sys', text: pin.text }]);
      this.changeAffection(pin.delta);
    }

    await this.playLines(this.pickReaction(c));

    if (scene.resolve === 'confession') return { end: this.resolveConfession(c) };
    return null;
  }

  /**
   * Draws the choices shown for one scene:
   * always one 💗, one 🤪 when the pool has any, a ☠️ with probability outRate,
   * the rest from the remaining pool. The order is shuffled.
   */
  drawChoices(def, scene) {
    const { rng, data } = this;
    const pool = def.pool.filter((c) => this.test(c.if));
    const goods = pool.filter((c) => c.type === 'good');
    const gags = pool.filter((c) => c.type === 'gag');
    const outs = pool.filter((c) => c.type === 'out');
    const count = def.count ?? 3;
    const picked = [];

    let good = rng.pick(goods);
    if (scene.rares?.includes('tategaki') && this.rareHit('tategaki')) {
      good = { ...data.rares.tategaki.choice, type: 'good', special: 'tategaki' };
      this.hooks.onRare?.('tategaki');
    }
    picked.push(good);

    if (gags.length && picked.length < count) picked.push(rng.pick(gags));
    const outRate = def.outRate ?? this.rules.outRate;
    if (outs.length && picked.length < count && rng.chance(outRate)) picked.push(rng.pick(outs));

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

  computeDelta(c) {
    const { state, data } = this;
    let d = c.delta ?? this.rules.typeDelta[c.type] ?? 0;
    d += data.moods[state.mood]?.typeMod?.[c.type] ?? 0;
    d += c.moodDelta?.[state.mood] ?? 0;
    return d;
  }

  resolveConfession(c) {
    const a = this.state.affection;
    if (c.confess && a >= this.rules.loverMin) return 'lover';
    if (c.confessGag && a >= this.rules.loverGagMin) return 'lover';
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

  async playEnding(id) {
    const { state, data } = this;
    if (id === 'friend' && state.flags.zarigani) id = 'zarigani';
    if (id === 'listener' && state.flags.cat) id = 'nyanko';
    const ending = data.endings[id];
    if (!ending) throw new Error(`unknown ending: ${id}`);
    await this.playLines(ending.lines);
    return { type: 'ending', id };
  }

  // ----------------------------------------------------------------- lines

  async playLines(lines) {
    for (const line of lines ?? []) {
      if (!this.test(line.if)) continue;
      if (line.cmd) {
        await this.runCmd(line);
        continue;
      }
      if (line.who === 'haru' && line.face) this.avatar.setExpression(line.face);
      if (line.motion) this.avatar.playMotion(line.motion);
      await this.ui.say({
        who: line.who,
        name: this.speakerName(line),
        text: this.fmt(line.text),
      });
    }
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
      default:
        throw new Error(`unknown cmd: ${line.cmd}`);
    }
  }

  applySettings(s) {
    if (s.ui) this.ui.setMode(s.ui);
    if (s.bg) this.ui.setBackground(s.bg);
    if (s.stream) this.ui.setStream(s.stream);
    if (s.model) this.avatar.setModel(s.model);
    if (s.face) this.avatar.setExpression(s.face);
    if (s.haruName) this.state.haruName = s.haruName;
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
    switch (this.chapter?.id) {
      case 1:
        return flags.noticed ? `${handle}さん` : 'リスナーさん';
      case 2:
        return affection >= 75 ? `${handle}くん` : `${handle}さん`;
      default:
        return `${handle}くん`;
    }
  }

  fmt(text) {
    return String(text ?? '')
      .replaceAll('{name}', this.state.handle)
      .replaceAll('{call}', this.callName());
  }

  test(cond) {
    if (!cond) return true;
    const s = this.state;
    if (cond.mood && cond.mood !== s.mood) return false;
    if (cond.flag && !s.flags[cond.flag]) return false;
    if (cond.notFlag && s.flags[cond.notFlag]) return false;
    if (cond.minAff != null && s.affection < cond.minAff) return false;
    if (cond.maxAff != null && s.affection > cond.maxAff) return false;
    if (cond.chapter != null && cond.chapter !== this.chapter?.id) return false;
    return true;
  }

  // ------------------------------------------------------------- affection

  changeAffection(d) {
    const s = this.state;
    s.affection = Math.max(0, Math.min(this.rules.max, s.affection + d));
    this.ui.popDelta(d);
    this.refreshHud();
  }

  refreshHud() {
    const s = this.state;
    this.ui.setAffection(s.affection / this.rules.max);
    this.ui.setChapter(this.chapter?.title ?? '');
    if (this.options.debug) {
      const mood = this.data.moods[s.mood]?.label ?? '-';
      this.ui.setDebug(`♥${s.affection} ${mood} seed:${s.seed}`);
    }
  }
}
