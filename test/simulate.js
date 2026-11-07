// Validates data/scenario.json and plays thousands of games with fake UI.
// Open /test/ through the local server. window.testResult holds the summary.

import { Engine } from '../js/engine.js';
import { createRng } from '../js/rng.js';
import { newState } from '../js/state.js';
import { EXPRESSIONS } from '../js/avatar.js';

const out = document.getElementById('out');
const status = document.getElementById('status');
const log = (s = '') => (out.textContent += `${s}\n`);
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  log(`✗ ${msg}`);
};

const data = await fetch('../data/scenario.json', { cache: 'no-store' }).then((r) => r.json());

// ------------------------------------------------------------ static checks

const TYPES = ['good', 'normal', 'bad', 'trap', 'gag', 'out'];
const WHO = ['haru', 'me', 'mob', 'narr', 'sys'];
const CMDS = ['flag', 'set', 'face', 'motion', 'wait'];
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
    for (const [k, v] of Object.entries(sc.variants ?? {})) {
      checkLines(v.lines, `${w}/${k}`);
      if (v.choice) checkChoice(v.choice, `${w}/${k}`);
      if (!v.choice && !sc.choice) fail(`${w}/${k}: no choice`);
    }
  }
}
for (const [id, e] of Object.entries(data.endings)) checkLines(e.lines, `ending ${id}`);
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
  }
  setBackground() {}
  setStream() {}
  setAffection(r) {
    if (r < 0 || r > 1) throw new Error(`affection ratio ${r}`);
  }
  setChapter() {}
  setDebug() {}
  popDelta() {}
  async card() {}
  async wait() {}
  async say(line) {
    this.lines++;
    if (/\{\w+\}/.test(line.text)) throw new Error(`unformatted text: ${line.text}`);
    if (line.who === 'haru' && !line.name) throw new Error(`haru without name: ${line.text}`);
  }
  async choose(options) {
    if (options.length < 2) throw new Error('fewer than 2 choices');
    if (!options.some((o) => o.type === 'good')) throw new Error('no good choice shown');
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
  noOut: (o, rng) => {
    const ok = o.map((x, i) => [x, i]).filter(([x]) => x.type !== 'out');
    return rng.pick(ok)[1];
  },
};

async function simulate(name, runs, extraOptions = {}) {
  const counts = {};
  const rares = {};
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
    } catch (e) {
      fail(`${name} seed=${seed}: ${e.message}`);
      break;
    }
    lines += ui.lines;
  }
  return { counts, rares, avgLines: Math.round(lines / runs) };
}

function fmtCounts(c, runs) {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${((v / runs) * 100).toFixed(1)}%`)
    .join('  ');
}

const RUNS = 3000;
const results = {};
for (const [name, opts] of [['random', {}], ['noOut', {}], ['mostlyGood', {}], ['alwaysGood', {}], ['random', { rare: 'all' }]]) {
  const label = opts.rare ? `${name}+rare` : name;
  const r = await simulate(name, RUNS, opts);
  results[label] = r;
  log(`\n[${label}] ${RUNS}回  平均セリフ数 ${r.avgLines}`);
  log(`  エンド: ${fmtCounts(r.counts, RUNS)}`);
  log(`  レア: ${JSON.stringify(r.rares)}`);
}

const notLover = Object.keys(results.alwaysGood.counts).filter((id) => id !== 'lover' && data.endings[id].cat !== 'rare');
if (notLover.length) fail(`alwaysGood should reach lover (or a rare ending), got ${notLover.join(', ')}`);

const reached = new Set(Object.values(results).flatMap((r) => Object.keys(r.counts)));
const missing = Object.keys(data.endings).filter((id) => !reached.has(id));
if (missing.length) fail(`unreached endings: ${missing.join(', ')}`);
else log(`\n全${reached.size}エンド到達を確認`);

status.textContent = failures.length ? `失敗 ${failures.length}件` : 'すべて成功';
status.className = failures.length ? 'fail' : 'pass';
window.testResult = { ok: failures.length === 0, failures, results };
