// Validates data/scenario.json and plays thousands of games with fake UI.
// Open /test/ through the local server. window.testResult holds the summary.

import { Engine } from '../js/engine.js';
import { createRng } from '../js/rng.js';
import { newState } from '../js/state.js';
import { EXPRESSIONS } from '../js/avatar.js';
import { loadScenario } from '../js/data.js';

const out = document.getElementById('out');
const status = document.getElementById('status');
const log = (s = '') => (out.textContent += `${s}\n`);
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  log(`✗ ${msg}`);
};

const data = await loadScenario('../data/');

// ------------------------------------------------------------ static checks

const TYPES = ['good', 'normal', 'bad', 'trap', 'gag', 'out'];
const WHO = ['haru', 'me', 'mob', 'narr', 'sys'];
const CMDS = ['flag', 'set', 'face', 'motion', 'wait', 'pop', 'affection', 'reveal', 'persona', 'blackout', 'bgm'];
const UIS = ['stream', 'dm', 'call', 'adv'];

function checkLines(lines, where) {
  for (const l of lines ?? []) {
    if (l.cmd) {
      if (!CMDS.includes(l.cmd)) fail(`${where}: unknown cmd ${l.cmd}`);
      if (l.ui && !UIS.includes(l.ui)) fail(`${where}: unknown ui ${l.ui}`);
      continue;
    }
    if (!WHO.includes(l.who)) fail(`${where}: unknown who "${l.who}"`);
    if (typeof l.text !== 'string' || !l.text) fail(`${where}: empty text`);
    if (l.face && !EXPRESSIONS[l.face]) fail(`${where}: unknown face ${l.face}`);
    if (l.voice && !data.voice?.clips?.[l.voice]) fail(`${where}: unknown voice ${l.voice}`);
    for (const [p, o] of Object.entries(l.by ?? {})) {
      if (!data.personas[p] && !data.realPersonas?.[p]) fail(`${where}: unknown persona in by: ${p}`);
      if (o.face && !EXPRESSIONS[o.face]) fail(`${where}: unknown face ${o.face} (by.${p})`);
    }
  }
}

function checkChoice(def, where) {
  const pool = def.pool ?? [];
  if (!pool.some((c) => c.type === 'good')) fail(`${where}: no good choice in pool`);
  pool.forEach((c, i) => {
    const w = `${where} choice#${i} "${c.text}"`;
    if (!TYPES.includes(c.type)) fail(`${w}: bad type ${c.type}`);
    if (c.end && !data.endings[c.end]) fail(`${w}: unknown ending ${c.end}`);
    if (c.type === 'out' && !c.end) fail(`${w}: out choice without end`);
    (c.reactions ?? []).forEach((r, j) => checkLines(r, `${w} reaction#${j}`));
  });
}

let sceneCount = 0;
for (const ch of data.chapters) {
  for (const sc of ch.scenes) {
    sceneCount++;
    const w = `scene ${sc.id}`;
    checkLines(sc.lines, w);
    checkLines(sc.after, w);
    if (sc.choice) checkChoice(sc.choice, w);
    if (sc.gate && !data.endings[sc.gate.fail]) fail(`${w}: unknown gate ending`);
    if (sc.rareEnd && !data.endings[sc.rareEnd.ending]) fail(`${w}: unknown rareEnd ending`);
    checkLines(sc.intro, w);
    const variants = typeof sc.topic === 'string' ? ch.topics?.[sc.topic] : sc.variants;
    if (typeof sc.topic === 'string' && !variants) fail(`${w}: unknown topic pool ${sc.topic}`);
    for (const [k, v] of Object.entries(variants ?? {})) {
      checkLines(v.lines, `${w}/${k}`);
      if (v.choice) checkChoice(v.choice, `${w}/${k}`);
      if (sc.topic && !v.choice && !sc.choice) fail(`${w}/${k}: no choice`);
      if (sc.variantBy === 'persona' && k !== 'default' && !data.personas[k]) fail(`${w}: unknown persona variant ${k}`);
      if (sc.variantBy === 'real' && k !== 'default' && !data.realPersonas?.[k]) fail(`${w}: unknown real persona variant ${k}`);
    }
  }
}
checkLines(data.rules.gesu?.warn, 'rules.gesu.warn');
checkLines(data.epilogue, 'epilogue');
for (const o of data.omake ?? []) checkLines(o.lines, `omake ${o.id}`);
if ((data.omake ?? []).some((o) => o.need !== 'all' && o.need > Object.keys(data.endings).length)) fail('omake: need exceeds the number of endings');
if (data.rules.gesu && !data.endings[data.rules.gesu.end]) fail('rules.gesu: unknown ending');
if (data.spice) checkChoice({ pool: [{ type: 'good' }, ...data.spice] }, 'spice');
// event-pool keys share state.topicsUsed (no repeats in a game), so they must be unique
{
  const seen = {};
  for (const ch of data.chapters) {
    for (const k of Object.keys(ch.topics?.events ?? {})) (seen[k] ??= []).push(`ch${ch.id}`);
    for (const sc of ch.scenes) if (sc.topic === true) for (const k of Object.keys(sc.variants)) (seen[k] ??= []).push(`ch${ch.id}`);
  }
  for (const [k, where] of Object.entries(seen)) if (new Set(where).size > 1) fail(`topic key "${k}" used in ${[...new Set(where)].join(', ')}`);
}
for (const [id, e] of Object.entries(data.endings)) checkLines(e.lines, `ending ${id}`);
for (const [id, r] of Object.entries(data.rares)) checkLines(r.lines, `rare ${id}`);
for (const [id, p] of Object.entries(data.personas)) checkLines(p.becomes, `persona ${id}`);
for (const [id, p] of Object.entries(data.realPersonas ?? {})) {
  checkLines(p.becomes, `realPersona ${id}`);
  checkLines(p.stays, `realPersona ${id}`);
}
for (const [id, routes] of Object.entries(data.routes ?? {})) {
  for (const r of routes) if (!data.endings[r.to]) fail(`route ${id}: unknown ending ${r.to}`);
}
for (const ch of data.chapters) {
  for (const m of Object.values(data.moods)) if (!m.hint[ch.id]) fail(`mood ${m.label}: no hint for chapter ${ch.id}`);
}
for (const m of Object.values(data.moods)) for (const [k, l] of Object.entries(m.hint)) checkLines(l, `mood ${m.label}/${k}`);
log(`静的チェック: ${sceneCount}シーン、エンド${Object.keys(data.endings).length}種`);

// --------------------------------------------------------------- simulation

class FakeUI {
  constructor(policy) {
    this.policy = policy;
    this.lines = 0;
  }
  setMode(m) {
    if (!UIS.includes(m)) throw new Error(`bad mode ${m}`);
    this.mode = m;
  }
  setBackground() {}
  setStream({ title } = {}) {
    if (title && /\{\w+\}/.test(title)) throw new Error(`unformatted stream title: ${title}`);
  }
  setAffection(r) {
    if (r != null && (r < 0 || r > 1)) throw new Error(`affection ratio ${r}`);
  }
  setPopularity(p) {
    if (p < 0 || p > 100) throw new Error(`popularity ${p}`);
  }
  popPopularity() {}
  revealAffection() {
    this.revealed = true;
  }
  setChapter() {}
  setDebug() {}
  popDelta() {
    if (!this.revealed) throw new Error('affection popup while hidden');
  }
  async card() {}
  async wait() {}
  async say(line) {
    this.lines++;
    if (/\{\w+\}/.test(line.text)) throw new Error(`unformatted text: ${line.text}`);
    if (line.who === 'haru' && !line.name) throw new Error(`haru without name: ${line.text}`);
  }
  async choose(options, { noSpice = false } = {}) {
    if (options.length < 2) throw new Error('fewer than 2 choices');
    if (!options.some((o) => o.type === 'good')) throw new Error('no good choice shown');
    if (this.mode === 'stream' && !noSpice && !options.some((o) => o.spice)) throw new Error('stream choices without a spice comment');
    if (new Set(options.map((o) => o.text)).size !== options.length) throw new Error('duplicate choice');
    return this.policy(options);
  }
}
const fakeAvatar = { setModel() {}, setExpression() {}, setTalking() {}, playMotion() {} };

const policies = {
  random: (o, rng) => rng.int(o.length),
  alwaysGood: (o) => o.findIndex((x) => x.type === 'good'),
  // a player who usually spots the good answer but misses 1 in 4 times
  mostlyGood: (o, rng) => {
    if (rng.chance(0.75)) return o.findIndex((x) => x.type === 'good');
    const ok = o.map((x, i) => [x, i]).filter(([x]) => x.type !== 'good' && x.type !== 'out');
    return rng.pick(ok)[1];
  },
  // style players: always take a 💰 superchat / 🤪 joke when offered, else the 💗
  tipper: (o) => {
    const i = o.findIndex((x) => x.style === 'mitsugi' && x.type !== 'out');
    return i >= 0 ? i : o.findIndex((x) => x.type === 'good');
  },
  joker: (o) => {
    const i = o.findIndex((x) => x.style === 'neta' && x.type !== 'out');
    return i >= 0 ? i : o.findIndex((x) => x.type === 'good');
  },
  noOut: (o, rng) => {
    const ok = o.map((x, i) => [x, i]).filter(([x]) => x.type !== 'out');
    return rng.pick(ok)[1];
  },
};

async function simulate(name, runs, extraOptions = {}) {
  const counts = {};
  const rares = {};
  const personas = {};
  const reals = {};
  let popSum = 0;
  let lines = 0;
  const pickRng = createRng(12345);
  for (let i = 0; i < runs; i++) {
    const seed = (i * 2654435761) >>> 0;
    const state = newState({ seed, handle: 'テスト', flags: { nameLong: i % 7 === 0 } });
    const ui = new FakeUI((o) => policies[name](o, pickRng));
    const engine = new Engine({
      data,
      ui,
      avatar: fakeAvatar,
      state,
      rng: createRng(seed),
      options: extraOptions,
      hooks: { onRare: (id) => (rares[id] = (rares[id] ?? 0) + 1) },
    });
    try {
      const r = await engine.run();
      counts[r.id] = (counts[r.id] ?? 0) + 1;
      personas[state.persona] = (personas[state.persona] ?? 0) + 1;
      if (state.chapterIndex >= 3) reals[state.realPersona] = (reals[state.realPersona] ?? 0) + 1;
      popSum += state.pop;
    } catch (e) {
      fail(`${name} seed=${seed}: ${e.message}`);
      break;
    }
    lines += ui.lines;
  }
  return { counts, rares, personas, reals, avgPop: Math.round(popSum / runs), avgLines: Math.round(lines / runs) };
}

function fmtCounts(c, runs) {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${((v / runs) * 100).toFixed(1)}%`)
    .join('  ');
}

const RUNS = 3000;
const results = {};
for (const [name, opts] of [['random', {}], ['noOut', {}], ['mostlyGood', {}], ['alwaysGood', {}], ['tipper', {}], ['joker', {}], ['random', { rare: 'all' }]]) {
  const label = opts.rare ? `${name}+rare` : name;
  const r = await simulate(name, RUNS, opts);
  results[label] = r;
  log(`\n[${label}] ${RUNS}回  平均セリフ数 ${r.avgLines}`);
  log(`  エンド: ${fmtCounts(r.counts, RUNS)}`);
  log(`  最終の性格: ${fmtCounts(r.personas, RUNS)}  平均人気 ${r.avgPop}`);
  log(`  リアルの性格（会えた回のみ・全体比）: ${fmtCounts(r.reals, RUNS)}`);
  log(`  レア: ${JSON.stringify(r.rares)}`);
}

const notLover = Object.keys(results.alwaysGood.counts).filter((id) => !id.startsWith('lover') && data.endings[id].cat !== 'rare');
if (notLover.length) fail(`alwaysGood should reach lover (or a rare ending), got ${notLover.join(', ')}`);

const reached = new Set(Object.values(results).flatMap((r) => Object.keys(r.counts)));
const missing = Object.keys(data.endings).filter((id) => !reached.has(id));
if (missing.length) fail(`unreached endings: ${missing.join(', ')}`);
else log(`\n全${reached.size}エンド到達を確認`);

status.textContent = failures.length ? `失敗 ${failures.length}件` : 'すべて成功';
status.className = failures.length ? 'fail' : 'pass';
window.testResult = { ok: failures.length === 0, failures, results };
