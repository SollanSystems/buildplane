---
"@buildplane/mission-control-server": patch
---

Fix the package exports map: `import` now targets `./dist/index.js` (the emitted file) and a `source` condition covers tsx dev mode. The prior `./src/index.js` target never existed on disk, so `bp web` failed from the built CLI with `Cannot find module`.
