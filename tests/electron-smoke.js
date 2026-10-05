/* tests/electron-smoke.js — Playwright-Electron smoke: window opens, title, theme toggle, screenshot.
 * Under Wayland run with xvfb-run (or --ozone-platform=x11) — see TESTING.md. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron } = require('/home/nico/.nvm/versions/node/v22.23.2/lib/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
// Isolated profile: parallel agents (or a dev `npm start`) hold the
// single-instance lock on the default ~/.config/retoma profile, which makes
// a second instance quit instantly ("Target page ... has been closed").
// A unique --user-data-dir per run keeps the lock (and events.json) private.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'retoma-smoke-'));

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); return true; }
  fails.push(label + (detail ? ' — ' + detail : ''));
  console.log('  ✗ ' + label + (detail ? '\n      ' + detail : ''));
  return false;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const electronPath = require('electron');
  const app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox', '--user-data-dir=' + PROFILE], cwd: ROOT });
  const window = await app.firstWindow();
  await window.waitForSelector('#deskClock', { timeout: 15000 });
  // screenshots and state checks start only once the entrance choreography is done
  await window.waitForFunction(() => !document.body.classList.contains('is-launch'), { timeout: 15000 });

  ok((await window.title()) === 'Retoma', 'window title is Retoma', await window.title());
  ok((await window.locator('.window').count()) === 4, '4 windows present');
  const entered = await window.evaluate(() => Array.from(document.querySelectorAll('.window')).map(e => ({
    app: e.getAttribute('data-app'),
    min: e.classList.contains('is-minimized'),
    hid: e.classList.contains('is-hidden'),
    op: parseFloat(getComputedStyle(e).opacity)
  })));
  ok(entered.length === 4 && entered.every(w => !w.min && !w.hid && w.op > 0.9), 'all 4 windows visible after the entrance', JSON.stringify(entered));
  ok((await window.locator('#themeToggle[aria-label="Switch theme"]').count()) === 1, 'theme toggle present');

  const before = await window.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await window.click('#themeToggle');
  await window.waitForTimeout(600);
  const after = await window.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok(before !== after, 'theme toggle flips data-theme', before + ' -> ' + after);

  // app window in DARK and LIGHT: resume card + timeline + privacy.
  // Document is back on the desk in both themes (comeBack restores it).
  for (const th of ['dark', 'light']) {    await window.evaluate((t) => Theme.apply(t, false), th);
    await window.evaluate(() => { Retoma.goAway(25); Retoma.comeBack(); });
    await window.waitForTimeout(600);
    const resumeWins = await window.evaluate(() => Array.from(document.querySelectorAll('.window')).map(e => ({
      app: e.getAttribute('data-app'),
      vis: !e.classList.contains('is-minimized') && !e.classList.contains('is-hidden')
    })));
    ok(resumeWins.length === 4 && resumeWins.every(w => w.vis), '[' + th + '] Document present in resume state', JSON.stringify(resumeWins));
    await window.screenshot({ path: path.join(SHOTS, 'app-' + th + '-resume.png') });
    await window.evaluate(() => { document.getElementById('retomarBtn').click(); Retoma.showEndOfDay(); });
    await window.waitForTimeout(500);
    await window.evaluate(() => {
      Retoma.openPanel(); Retoma.switchTab('hoy');
      const bar = document.getElementById('timelineBar');
      if (bar) bar.scrollIntoView({ block: 'start' });
    });
    await window.waitForTimeout(400);
    await window.screenshot({ path: path.join(SHOTS, 'app-' + th + '-timeline.png') });
    await window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('priv'); });
    await window.waitForTimeout(400);
    await window.screenshot({ path: path.join(SHOTS, 'app-' + th + '-privacy.png') });
  }

  console.log('\nD1 · preload bridge + IPC persistence + propose');
  ok(await window.evaluate(() => !!(window.retoma && window.retoma.propose)), 'preload bridge window.retoma.propose present');
  const caps = await window.evaluate(() => window.retoma.capabilities());
  const keyPresent = !!process.env.GEMINI_API_KEY;
  ok(caps && caps.cloudAvailable === keyPresent, 'cloud availability follows the key', JSON.stringify(caps));
  ok(keyPresent ? (caps.cloudReason || '') === '' : /GEMINI_API_KEY/.test(caps.cloudReason || ''), 'disabled reason names the missing key', (caps && caps.cloudReason) || '(enabled)');
  const eProp = await window.evaluate(async () => {
    const s = { perApp: { Document: 40 }, longest: { app: 'Document', minutes: 40 }, firstInterruption: { app: 'WhatsApp', at: '9:52' } };
    return window.retoma.propose(s, { mode: 'off' });
  });
  ok(/^\d{1,2}:[0-5]\d$/.test(eProp.start) && Number.isInteger(eProp.minutes) && eProp.minutes >= 15 && eProp.minutes <= 180 && String(eProp.reason).length <= 140, 'propose off returns valid shape over IPC', JSON.stringify(eProp));
  await window.evaluate(() => window.retoma.saveEvents([{ app: 'Document', duration: 40, ts: new Date().toISOString() }]));
  const eLoaded = await window.evaluate(() => window.retoma.loadEvents());
  ok(Array.isArray(eLoaded) && eLoaded.length >= 1, 'events round-trip through events.json', JSON.stringify(eLoaded).slice(0, 120));
  await window.evaluate(() => window.retoma.deleteEvents());
  const eAfter = await window.evaluate(() => window.retoma.loadEvents());
  ok(Array.isArray(eAfter) && eAfter.length === 0, 'delete-all empties the store');
  await window.evaluate(() => { Retoma.goAway(25); Retoma.comeBack(); });
  await window.waitForTimeout(400);
  ok(await window.evaluate(() => document.getElementById('resumeCard').classList.contains('is-visible')), 'resume card shows after 25 min away (notify path)');
  const segCount = await window.evaluate(() => document.querySelectorAll('[data-ai-mode]').length);
  ok(segCount === 3, 'Smart suggestions control present in app', 'found ' + segCount);

  console.log('\nL2 · live mode UI');
  const settingsStore = require(path.join(ROOT, 'ai', 'settings'));
  const installerMod = require(path.join(ROOT, 'live', 'installer'));
  const l2Errs = [];
  function watchL2(w) {
    w.on('console', m => { if (m.type() === 'error') l2Errs.push('console: ' + m.text()); });
    w.on('pageerror', e => l2Errs.push('pageerror: ' + e.message));
  }
  async function launchL2(profile, extraEnv) {
    const a = await _electron.launch({
      executablePath: electronPath,
      args: ['.', '--no-sandbox', '--user-data-dir=' + profile],
      cwd: ROOT,
      env: Object.assign({}, process.env, extraEnv || {})
    });
    const w = await a.firstWindow();
    watchL2(w);
    await w.waitForSelector('#deskClock', { timeout: 15000 });
    await w.waitForFunction(() => !document.body.classList.contains('is-launch'), { timeout: 15000 });
    return { app: a, window: w };
  }
  async function pollLiveStatus(w, want, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const s = await w.evaluate(() => window.retoma.liveStatus());
      if (s === want) return s;
      if (Date.now() - t0 > timeoutMs) return s;
      await w.waitForTimeout(500);
    }
  }

  // A · no fake: default demo, switch to live, waiting state, persist, pause.
  const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'retoma-homeA-'));
  const PROFILE_A = fs.mkdtempSync(path.join(os.tmpdir(), 'retoma-liveA-'));
  let runA = await launchL2(PROFILE_A, { HOME: HOME_A });
  ok(await runA.window.evaluate(() => window.Live && window.Live.getMode()) === 'demo', 'L2 default mode is demo', 'got ' + await runA.window.evaluate(() => window.Live && window.Live.getMode()));
  ok(await runA.window.evaluate(() => !document.body.classList.contains('is-live')), 'L2 demo shows fake windows');
  ok(await runA.window.evaluate(() => document.getElementById('storyPlay').disabled === false), 'L2 sim buttons enabled in demo');
  await runA.window.evaluate(() => window.retoma.saveEvents([{ app: 'Document', duration: 40, ts: new Date().toISOString() }]));
  await runA.window.click('.menu-bar [data-mode="live"]');
  await runA.window.waitForFunction(() => document.body.classList.contains('is-live'), { timeout: 5000 });
  ok(true, 'L2 mode switch enters live view');
  ok(await runA.window.evaluate(() => !document.getElementById('liveView').classList.contains('is-hidden')), 'L2 live view visible');
  ok(await runA.window.evaluate(() => document.getElementById('storyPlay').disabled === true), 'L2 sim buttons disabled in live');
  ok(await runA.window.evaluate(() => document.getElementById('storyPlay').title === 'Disabled in Live mode'), 'L2 sim buttons carry a tooltip');
  const stA = await pollLiveStatus(runA.window, 'extension-missing', 15000);
  ok(stA === 'extension-missing', 'L2 status is extension-missing without helper', 'got ' + stA);
  ok(((await runA.window.locator('#liveStatusText').textContent()) || '').includes('Waiting for helper'), 'L2 chip reads Waiting for helper');
  ok(await runA.window.evaluate(() => !document.getElementById('helperCard').classList.contains('is-hidden')), 'L2 setup card shows 3 steps');
  ok(await runA.window.evaluate(() => document.querySelectorAll('#helperCard .helper-card__step').length === 3), 'L2 setup card has 3 numbered steps');
  ok(((await runA.window.locator('#enableCmd').textContent()) || '').trim() === 'gnome-extensions enable retoma-focus@retoma.local', 'L2 enable command text is exact');
  await runA.window.screenshot({ path: path.join(SHOTS, 'live-setup.png') });
  await runA.window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('priv'); });
  await runA.window.waitForTimeout(300);
  await runA.window.click('#livePause');
  await runA.window.waitForTimeout(400);
  ok(((await runA.window.locator('#liveStatusText').textContent()) || '').includes('Paused'), 'L2 chip reads Paused');
  await runA.window.click('#livePause');
  await runA.window.waitForTimeout(400);
  ok(((await runA.window.locator('#liveStatusText').textContent()) || '').includes('Waiting for helper'), 'L2 resume restores waiting chip');
  await runA.app.close();
  runA = await launchL2(PROFILE_A, { HOME: HOME_A });
  ok(await runA.window.evaluate(() => window.Live && window.Live.getMode()) === 'live', 'L2 mode persists across restart', 'got ' + await runA.window.evaluate(() => window.Live && window.Live.getMode()));
  const keptA = await runA.window.evaluate(() => window.retoma.loadEvents());
  ok(Array.isArray(keptA) && keptA.length >= 1, 'L2 switching never loses stored data', JSON.stringify(keptA).slice(0, 100));
  await runA.app.close();

  // B · scripted fake timeline: now line, real timeline, Got it card, titles, blocklist, installer.
  const HOME_B = fs.mkdtempSync(path.join(os.tmpdir(), 'retoma-homeB-'));
  const PROFILE_B = fs.mkdtempSync(path.join(os.tmpdir(), 'retoma-liveB-'));
  const LONG_TITLE = new Array(101).join('y');
  const fakePath = path.join(os.tmpdir(), 'retoma-fake-' + Date.now() + '.json');
  fs.writeFileSync(fakePath, JSON.stringify({ samples: [
    { waitMs: 200, advanceMs: 0, focus: { appId: 'org.term', appName: 'Terminal', title: 'bash' } },
    { waitMs: 3600, advanceMs: 300000, focus: { appId: 'keepassxc', appName: 'KeePassXC', title: 'vault' } },
    { waitMs: 3600, advanceMs: 120000, focus: { appId: 'org.firefox', appName: 'Firefox', title: LONG_TITLE } },
    { waitMs: 3600, advanceMs: 360000, idleMs: 300000 },
    { waitMs: 800, advanceMs: 1500000, idleMs: 1000 }
  ] }), 'utf8');
  settingsStore.saveSettingsFile(fs, path.join(PROFILE_B, 'settings.json'), { mode: 'live' });
  const runB = await launchL2(PROFILE_B, { HOME: HOME_B, RETOMA_LIVE_FAKE: fakePath });
  ok(await runB.window.evaluate(() => window.Live && window.Live.getMode()) === 'live', 'L2 fake launch starts in live');
  await runB.window.waitForSelector('#resumeCard.is-visible', { timeout: 40000 });
  ok(true, 'L2 scripted away shows the resume card');
  const nowLine = (await runB.window.locator('#liveNow').textContent()) || '';
  ok(/^Now: Firefox · \d+ min$/.test(nowLine.trim()), 'L2 Now line names app + minutes, no title', nowLine.trim());
  ok(await runB.window.evaluate(() => (document.getElementById('retomarBtn').textContent || '').trim() === 'Got it'), 'L2 resume button reads Got it');
  ok(await runB.window.evaluate(() => {
    const h = document.getElementById('resumeHonest');
    return h && !h.classList.contains('is-hidden') && /can't reopen windows here/.test(h.textContent);
  }), 'L2 honest Wayland line present');
  const chipsB = (await runB.window.locator('#resumeChips').textContent()) || '';
  ok(/Private app/.test(chipsB) && /Firefox/.test(chipsB), 'L2 card lists apps used before the break', chipsB.trim().slice(0, 120));
  const bodyB = await runB.window.evaluate(() => document.body.textContent);
  ok(!bodyB.includes(LONG_TITLE) && !bodyB.includes('vault') && !/KeePassXC/.test(bodyB), 'L2 titles OFF: nothing leaks into the DOM');
  const eventsRaw = fs.readFileSync(path.join(PROFILE_B, 'events.json'), 'utf8');
  ok(!eventsRaw.includes(LONG_TITLE.slice(0, 20)) && !/KeePassXC|vault/.test(eventsRaw), 'L2 titles OFF: nothing leaks into events.json');
  ok(/Private app/.test(eventsRaw), 'L2 blocklisted app stored as Private app');
  ok(((await runB.window.locator('#liveStatusText').textContent()) || '').includes('Tracking this PC'), 'L2 chip reads Tracking this PC');
  await runB.window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('hoy'); });
  await runB.window.waitForTimeout(400);
  ok(await runB.window.evaluate(() => document.querySelectorAll('#liveBar .live-bar__seg').length >= 3), 'L2 live bar built from real events');
  ok(/Private app/.test((await runB.window.locator('#liveToday').textContent()) || ''), 'L2 today lists Private app');
  await runB.window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('priv'); });
  await runB.window.waitForTimeout(300);
  ok(await runB.window.evaluate(() => document.querySelectorAll('[data-away]').length === 3), 'L2 away-after 2/5/10 control present');
  ok(await runB.window.evaluate(() => document.getElementById('titlesToggle').checked === false), 'L2 titles default OFF');
  // screenshots: resume + live view in both themes
  await runB.window.evaluate(() => window.Theme.apply('dark', false));
  await runB.window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('ahora'); });
  await runB.window.waitForTimeout(500);
  await runB.window.screenshot({ path: path.join(SHOTS, 'live-resume-dark.png') });
  await runB.window.evaluate(() => document.getElementById('retomarBtn').click());
  await runB.window.waitForTimeout(400);
  await runB.window.evaluate(() => Retoma.closePanel());
  await runB.window.waitForTimeout(300);
  await runB.window.screenshot({ path: path.join(SHOTS, 'live-dark.png') });
  await runB.window.evaluate(() => window.Theme.apply('light', false));
  await runB.window.waitForTimeout(500);
  await runB.window.screenshot({ path: path.join(SHOTS, 'live-light.png') });
  // titles ON via replay: truncated to 60
  await runB.window.evaluate(() => window.retoma.saveSettings({ storeTitles: true }));
  await runB.window.evaluate(() => window.retoma.liveReplay());
  await runB.window.waitForSelector('#resumeCard.is-visible', { timeout: 40000 });
  await runB.window.waitForTimeout(500);
  const nowOn = (await runB.window.locator('#liveNow').textContent()) || '';
  ok(nowOn.includes(LONG_TITLE.slice(0, 60)) && !nowOn.includes(LONG_TITLE), 'L2 titles ON: truncated to 60', nowOn.slice(0, 140));
  await runB.window.evaluate(() => window.Theme.apply('light', false));
  await runB.window.evaluate(() => { Retoma.openPanel(); Retoma.switchTab('ahora'); });
  await runB.window.waitForTimeout(500);
  await runB.window.screenshot({ path: path.join(SHOTS, 'live-resume-light.png') });
  // installer over IPC with a temp HOME
  const noConfirm = await runB.window.evaluate(() => window.retoma.helperInstall({ skipDialog: true, confirm: false }));
  ok(noConfirm && noConfirm.copied === false, 'L2 install without confirm copies nothing');
  ok(!fs.existsSync(installerMod.destDir(HOME_B)), 'L2 no folder created without confirm');
  const withConfirm = await runB.window.evaluate(() => window.retoma.helperInstall({ skipDialog: true, confirm: true }));
  const destFiles = withConfirm && withConfirm.copied ? fs.readdirSync(withConfirm.dest).sort() : [];
  ok(withConfirm && withConfirm.copied === true && destFiles.join(',') === 'extension.js,metadata.json', 'L2 install copies exactly the 2 files', destFiles.join(','));
  const checkB = await runB.window.evaluate(() => window.retoma.helperCheck());
  ok(checkB && checkB.installed === true && checkB.enableCommand === 'gnome-extensions enable retoma-focus@retoma.local', 'L2 check reports install + enable command');
  // token test in both themes (primary swap, nothing keeps the old lime)
  for (const th of ['dark', 'light']) {
    await runB.window.evaluate((t) => { window.Theme.apply(t, false); document.documentElement.style.setProperty('--color-primary-500', '#ff0000'); }, th);
    await runB.window.waitForTimeout(500);
    const stale = await runB.window.evaluate(() => {
      const props = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'outlineColor', 'fill', 'stroke'];
      const hits = [];
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const cs = getComputedStyle(all[i]);
        for (let k = 0; k < props.length; k++) if (cs[props[k]] === 'rgb(166, 255, 0)') hits.push(all[i].tagName);
      }
      return hits;
    });
    ok(stale.length === 0, '[L2 ' + th + '] token swap leaves no old lime', stale.slice(0, 4).join('|'));
  }
  await runB.window.evaluate(() => { document.documentElement.style.removeProperty('--color-primary-500'); window.Theme.apply('dark', false); });
  ok(l2Errs.length === 0, 'L2 no console errors in either mode or theme', l2Errs.join(' | ').slice(0, 300));
  await runB.app.close();
  for (const d of [PROFILE_A, HOME_A, PROFILE_B, HOME_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  try { fs.unlinkSync(fakePath); } catch (e) { /* best effort */ }

  await app.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  if (fails.length) { console.log(fails.length + ' failed, ' + pass + ' passed'); process.exit(1); }
  console.log('  ' + pass + ' passed, 0 failed');
})().catch(e => { console.error(e); process.exit(1); });
