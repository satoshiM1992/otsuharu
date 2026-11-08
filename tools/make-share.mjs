// Builds the per-ending share images and pages:
//   img/share/<id>.jpg  1200x630 card (VTuber VRM + ending title)
//   share/<id>.html     page with that og:image; it forwards visitors to the game
// Needs Node + Playwright and the game served at http://localhost:8080/ (tools/serve.ps1).
//   node tools/make-share.mjs            all endings
//   node tools/make-share.mjs lover atm  only these
// Optional: LIB_DIR=<dir with three-0.180.0/ and pixiv-three-vrm-3.4.5/ unpacked npm packages>
// serves three.js locally instead of the CDN; FONT_DIR=<@fontsource/m-plus-rounded-1c files dir>.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SITE = 'https://satoshim1992.github.io/otsuharu/';
const GAME = '推しVTuberを落とせ！';
const CATEGORY = { main: 'メインエンド', bad: 'バッドエンド', out: '一発アウトエンド', hidden: '隠しエンド', rare: '超レアエンド' };
const FACE_BY_CAT = { main: 'happy', hidden: 'smug', rare: 'surprised', bad: 'sad', out: 'blank' };
const FACE_BY_ID = { friend: 'relaxed', listener: 'relaxed', aikata: 'happy', star: 'happy', nyanko: 'happy', zarigani: 'surprised', mikudashi: 'angry', neochi: 'relaxed', gyaku: 'shy', lover_queen: 'smug' };

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scenario.json'), 'utf8'));
const only = process.argv.slice(2);
const ids = Object.keys(data.endings).filter((id) => !only.length || only.includes(id));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ---- pages
fs.mkdirSync(path.join(ROOT, 'share'), { recursive: true });
for (const id of ids) {
  const e = data.endings[id];
  const title = `${e.emoji}${e.title}を見た！｜${GAME}`;
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(e.desc ?? '')}">
  <meta property="og:url" content="${SITE}share/${id}.html">
  <meta property="og:image" content="${SITE}img/share/${id}.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE}img/share/${id}.jpg">
  <meta http-equiv="refresh" content="0; url=../">
  <script>location.replace('../');</script>
</head>
<body><p><a href="../">${esc(GAME)} をあそぶ</a></p></body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, 'share', `${id}.html`), html);
}

// ---- images
fs.mkdirSync(path.join(ROOT, 'img/share'), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 } });
if (process.env.LIB_DIR) {
  await ctx.route('https://cdn.jsdelivr.net/npm/**', (route) => {
    const u = new URL(route.request().url()).pathname.replace('/npm/', '');
    const map = [['three@0.180.0/', 'three-0.180.0/package/'], ['@pixiv/three-vrm@3.4.5/', 'pixiv-three-vrm-3.4.5/package/']];
    for (const [from, to] of map) if (u.startsWith(from)) return route.fulfill({ path: path.join(process.env.LIB_DIR, to, u.slice(from.length)), contentType: 'text/javascript' });
    return route.abort();
  });
}
if (process.env.FONT_DIR) {
  const css = ['700', '800'].map((w) => `@font-face{font-family:"M PLUS Rounded 1c";font-weight:${w};src:url(/__font/${w}.woff2)}`).join('');
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: css, contentType: 'text/css' }));
  await ctx.route('http://localhost:8080/__font/*', (r) => {
    const w = r.request().url().match(/(\d+)\.woff2/)[1];
    r.fulfill({ path: path.join(process.env.FONT_DIR, `m-plus-rounded-1c-japanese-${w}-normal.woff2`), contentType: 'font/woff2' });
  });
}
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error(e.message));
await page.goto('http://localhost:8080/tools/share-card.html');
await page.waitForFunction(() => document.querySelector('#av.has-vrm') && window.renderCard, null, { timeout: 120000 });
await page.evaluate(() => document.fonts.ready);
for (const id of ids) {
  const e = data.endings[id];
  await page.evaluate((c) => window.renderCard(c), {
    cat: e.cat,
    catLabel: CATEGORY[e.cat],
    emoji: e.emoji,
    title: e.title,
    desc: e.desc ?? '',
    face: FACE_BY_ID[id] ?? FACE_BY_CAT[e.cat] ?? 'neutral',
  });
  await page.waitForTimeout(1200); // let the expression blend in
  await page.screenshot({ path: path.join(ROOT, 'img/share', `${id}.jpg`), type: 'jpeg', quality: 86 });
  console.log('✓', id);
}
await browser.close();
