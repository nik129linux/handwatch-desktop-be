# Testing — read before verifying anything

1. **Scripted acceptance** (regression gate, run after every change):
   `node tests/acceptance.js` from this directory. Import Playwright by absolute path:
   `const { chromium } = require('/home/nico/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');`
   Load pages with `pathToFileURL(path.resolve('index.html'))`.

2. **playwright-cli** (interactive exploration; state goes to disk):
   ```bash
   python3 -m http.server 8766 &
   playwright-cli -s=desk open http://localhost:8766/
   playwright-cli -s=desk snapshot
   playwright-cli -s=desk click e12
   playwright-cli -s=desk screenshot
   playwright-cli -s=desk close; kill %1
   ```
   Config: `.playwright/cli.config.json` points to the bundled Chromium.
   Turn every bug you find into an assertion in `tests/acceptance.js`.

Stay inside this directory. Do not read or glob the parent folder.
