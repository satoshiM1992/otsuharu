# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

「推しVTuberを落とせ！」 (formerly 「おつハル！」; おつハル is still Haru's sign-off line in the story): a short (10–15 min) romance sim for smartphone browsers. The player is a listener of the original VTuber 天音ハル (real name 春川ひなの). Static HTML + vanilla JS ES modules, no build step, published with GitHub Pages from the repo root (`.nojekyll` present). No npm dependencies; three.js 0.180 + @pixiv/three-vrm 3.4.5 are loaded from jsDelivr via the import map in `index.html` (keep `test/vrm-check.html` in sync).

## Commands

- Serve locally (no Node/Python on this machine): `powershell -ExecutionPolicy Bypass -File tools/serve.ps1` → http://localhost:8080/
- Tests: open http://localhost:8080/test/ — validates `data/scenario.json` and plays 5×3000 simulated games (random, no-out, mostly-good = right 75% of the time, always-good, forced rares) and prints the ending distribution — use it for balancing. Headless run:
  `& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --user-data-dir=<scratch dir> --virtual-time-budget=120000 --dump-dom http://localhost:8080/test/` and look for `すべて成功`.
- URL options: `?debug=1` (affection/mood/choice types), `?seed=N` (fixed RNG), `?rare=all` or `?rare=cat,pin` (rare *endings* are forced only by name: `?rare=neochi`, `?rare=gyaku`), `?vrm=0` (SVG avatar).
- Note: headless Edge does not advance CSS transitions under `--virtual-time-budget`, so transitioned values (e.g. the heart meter) look stuck in headless screenshots only.

## Architecture

- `data/scenario.json` — all content: `rules` (affection deltas, thresholds), `moods`, `mob` comments, `rares`, `chapters[].scenes[]`, `endings`. Lines are `{who: haru|me|mob|narr|sys, text, face, motion, if}` or commands `{cmd: flag|set|face|motion|wait}`. `{name}` / `{call}` are substituted.
- `js/engine.js` — DOM-free scenario runner (also used by the test page with fakes). Scene flow: optional topic variant → lines → mood hint → rare events → choice → after → gate. Choice types: good / normal / bad / trap (💣 sounds nice but is heavy or pushy, default −8) / gag / out. `drawChoices` shows `rules.choiceCount` (4) options: always one 💗 good, one 🤪 gag and one 💣 trap if any, a ☠️ out with probability `outRate`, then fills and shuffles. `scene.rareEnd` `{ending, chance, if?, at?: "start"}` ends the game early with a `cat: "rare"` ending (寝落ち 0.3% at 1-0, 逆告白 5% at 3-3 when affection ≥ 95). Endings `zarigani`/`nyanko` are substituted for `friend`/`listener` by flags.
- `js/rng.js` — seeded mulberry32. All gameplay randomness goes through it; cosmetic randomness (mob comments, blink) uses `Math.random`. The game autosaves state (incl. `rngState`) at each scene start, so resuming replays the same draws.
- `js/ui.js` — DOM layer with four layouts toggled by class on `#screen-game`: `mode-stream`, `mode-dm`, `mode-call`, `mode-adv`.
- `js/avatar.js` — `PlaceholderAvatar` (SVG) and `Avatar`, the wrapper used by the game: it shows the SVG and lazily imports `js/avatar-vrm.js`; once the model loads the host gets class `has-vrm` and the canvas replaces the SVG. Interface: `setModel` (`vtuber`/`real`/`none`), `setExpression`, `setTalking`, `playMotion`, `speakChar` (UI passes each typed character of Haru's lines).
- `js/avatar-vrm.js` — one shared WebGL renderer + VRM cache; each frame the canvas moves to the visible `VrmView` (title or game). Maps game expressions to VRM presets, lip sync = kana → vowel viseme (aa/ih/ou/ee/oh, kanji random), blink, idle sway, motions via bones. Camera: bust shot, face close-up when the host is square (call screen).
- `models/sample.vrm` — temporary VRM (pixiv VRM1_Constraint_Twist_Sample, redistribution OK, no credit required). Model URLs are `VRM_MODELS` in `js/main.js`; `?vrm=0` forces the SVG. `test/vrm-check.html` renders a grid of expressions/visemes/motions.
- `js/sound.js` — all audio synthesized with Web Audio (no files): procedural BGM loops `title`/`stream`/`night`/`date` (UI picks by mode/background) and SEs. Starts on the first `pointerdown`; mute toggle (`.sound-toggle`) saved in localStorage.
- `js/main.js` — screens, gallery, ending share (X intent + Web Share API / clipboard), sound toggle. OGP tags are in `index.html`.
- `js/state.js` — localStorage save + gallery (endings/rares); all access is try/catch guarded.
- `docs/scenario-outline.md` — design doc agreed with the user (story, choice tables, endings).

## Environment

- Development happens on Windows 11. Both PowerShell and Git Bash are available.
- Branch is `main`, pushed to https://github.com/satoshiM1992/otsuharu (GitHub Pages from `main` / root): https://satoshim1992.github.io/otsuharu/
