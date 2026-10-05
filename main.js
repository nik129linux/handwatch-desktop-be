// main.js — Retoma desktop shell (Electron, demo-data driven).
// AI providers, persistence and native behavior live here; the renderer
// never sees keys. Pure handlers in ai/ stay unit-testable headless.
const { app, BrowserWindow, Menu, Tray, Notification, ipcMain, dialog, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const providers = require('./ai/providers');
const store = require('./ai/store');
const habits = require('./ai/habits');
const native = require('./ai/native');
const settingsStore = require('./ai/settings');
const installer = require('./live/installer');
const liveManager = require('./live/live-manager');
const focusSourceMod = require('./live/focus-source');
const idleSourceMod = require('./live/idle-source');

let win = null;
let tray = null;
let paused = false;
let settingsFile = null;
let liveMgr = null;
let liveClock = null;

var persisted = null;

function modeNow() {
  return (persisted && persisted.mode === 'live') ? 'live' : 'demo';
}

function eventsFileFor(mode) {
  return store.eventsPathFor(app.getPath('userData'), mode);
}

function eventsFile() {
  return eventsFileFor(modeNow());
}

function experimentsFileFor(mode) {
  return store.experimentsPathFor(app.getPath('userData'), mode);
}

function dayKeyLocal(ms) {
  var d = new Date(ms);
  function p2(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

function settingsFilePath() {
  if (!settingsFile) settingsFile = settingsStore.settingsPath(app.getPath('userData'));
  return settingsFile;
}

function currentSettings() {
  return settingsStore.loadSettingsFile(fs, settingsFilePath());
}

function persistSettings(patch) {
  return settingsStore.saveSettingsFile(fs, settingsFilePath(), patch);
}

/* Live pipeline: real D-Bus sources, or the scripted fake file when
 * RETOMA_LIVE_FAKE=path.json (tests). Episodes append to events.json,
 * returns fire the same native notification as the demo path. */
function setupLive() {
  var initial = currentSettings();
  persisted = initial;
  var fakePath = process.env.RETOMA_LIVE_FAKE;
  var fakeSamples = null;
  if (fakePath) {
    try {
      fakeSamples = liveManager.loadFakeFile(fs, fakePath);
    } catch (e) {
      fakeSamples = null;
    }
  }
  if (fakeSamples) {
    liveClock = {
      t: Date.now(),
      now: function () { return this.t; },
      advance: function (ms) { this.t += ms; }
    };
  }
  var focusSrc = null;
  var idleSrc = null;
  if (!fakeSamples) {
    focusSrc = focusSourceMod.createFocusSource({});
    idleSrc = idleSourceMod.createIdleSource({});
  }
  liveMgr = liveManager.createLiveManager({
    focusSource: focusSrc,
    idleSource: idleSrc,
    clock: liveClock,
    fakeSamples: fakeSamples,
    settings: {
      storeTitles: initial.storeTitles,
      awayAfterMin: initial.awayAfterMin,
      blocklist: initial.blocklist,
      paused: initial.paused
    },
    send: function (evt) {
      if (win && !win.isDestroyed()) win.webContents.send('retoma:live:event', evt);
    },
    sendStatus: function (status) {
      if (win && !win.isDestroyed()) win.webContents.send('retoma:live:status', status);
    },
    saveEpisode: function (entry) {
      var liveFile = eventsFileFor('live');
      var loaded = store.loadEventsFile(fs, liveFile);
      loaded.events.push({ app: entry.app, duration: entry.duration, ts: new Date().toISOString() });
      store.saveEventsFile(fs, liveFile, loaded.events);
    },
    notify: function (info) {
      showReturnNotification(info);
    }
  });
  paused = !!initial.paused;
  if (initial.mode === 'live') liveMgr.start();
  refreshTray();
}

function applyLiveSettings(next) {
  persisted = next;
  if (!liveMgr) return;
  liveMgr.updateSettings({
    storeTitles: next.storeTitles,
    awayAfterMin: next.awayAfterMin,
    blocklist: next.blocklist,
    paused: next.paused
  });
  paused = !!next.paused;
  if (next.mode === 'live') liveMgr.start();
  else liveMgr.stop();
  refreshTray();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Retoma',
    autoHideMenuBar: true,
    backgroundColor: '#101010',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  const menu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle theme',
          accelerator: 'Ctrl+Shift+L',
          click: () => {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript(
                'window.__toggleTheme ? window.__toggleTheme() : null'
              );
            }
          }
        },
        {
          label: 'Toggle fullscreen',
          accelerator: 'F11',
          click: () => {
            if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
          }
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
  // Esc closes nothing extra: no Escape handler registered.
}

function trayIconPath(isPaused) {
  return path.join(__dirname, 'build', native.trayIconName(isPaused) + '.png');
}

function refreshTray() {
  if (!tray) return;
  try {
    tray.setImage(nativeImage.createFromPath(trayIconPath(paused)));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Retoma', click: () => { if (win) { win.show(); win.focus(); } } },
      {
        label: paused ? 'Resume tracking' : 'Pause tracking',
        click: () => {
          paused = !paused;
          if (win && !win.isDestroyed()) {
            win.webContents.executeJavaScript(
              'window.Retoma && window.Retoma.isPaused && window.Retoma.isPaused() !== ' + (paused ? 'true' : 'false') + ' ? window.Retoma.togglePause() : null'
            );
          }
          refreshTray();
        }
      },
      { label: 'Quit', click: () => app.quit() }
    ]));
    tray.setToolTip(paused ? 'Retoma (paused)' : 'Retoma');
  } catch (e) { /* headless: tray handlers are unit-tested instead */ }
}

function setupTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(trayIconPath(false)));
    tray.on('click', () => {
      if (!win) return;
      if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
    });
    refreshTray();
  } catch (e) { tray = null; /* headless runners have no tray */ }
}

function setupShortcut() {
  try {
    globalShortcut.register('Ctrl+Alt+R', () => {
      if (!win) return;
      if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
    });
  } catch (e) { /* headless */ }
}

function showReturnNotification(info) {
  var awayMinutes = info && info.awayMinutes;
  var appName = (info && info.app) || 'Document';
  if (!native.shouldNotify(awayMinutes)) return false;
  try {
    var note = new Notification(native.resumeNotification(appName));
    note.on('click', () => {
      if (win) {
        if (!win.isVisible()) win.show();
        win.focus();
        win.webContents.send('retoma:focus-resume');
      }
    });
    note.show();
  } catch (e) { /* headless: handler logic is unit-tested */ }
  return true;
}

function setupIpc() {
  ipcMain.handle('retoma:propose', (ev, summary, opts) => providers.propose(summary, opts));
  ipcMain.handle('retoma:preview', (ev, summary, mode) => providers.previewPayload(summary, mode));
  ipcMain.handle('retoma:capabilities', () => providers.capabilities());
  function fileForArg(arg) {
    return eventsFileFor(arg === 'live' || arg === 'demo' ? arg : modeNow());
  }
  ipcMain.handle('retoma:events:load', (ev, mode) => {
    var f = fileForArg(mode);
    var loaded = store.loadEventsFile(fs, f);
    store.saveEventsFile(fs, f, loaded.events);
    return loaded.events;
  });
  ipcMain.handle('retoma:events:save', (ev, events, mode) => {
    store.saveEventsFile(fs, fileForArg(mode), events || []);
    return true;
  });
  ipcMain.handle('retoma:events:delete', (ev, mode) => {
    var m = mode === 'live' || mode === 'demo' ? mode : modeNow();
    store.deleteEventsFile(fs, fileForArg(mode));
    store.deleteEventsFile(fs, experimentsFileFor(m));
    return true;
  });
  ipcMain.handle('retoma:events:export', async () => {
    var m = modeNow();
    var loaded = store.loadEventsFile(fs, eventsFile());
    var exps = store.loadExperimentsFile(fs, experimentsFileFor(m));
    var res = await dialog.showSaveDialog(win, {
      title: 'Export my data',
      defaultPath: 'retoma-data.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return false;
    var base = JSON.parse(store.serialize(loaded.events));
    base.experiments = exps;
    fs.writeFileSync(res.filePath, JSON.stringify(base, null, 2), 'utf8');
    return true;
  });
  ipcMain.on('retoma:notify-return', (ev, info) => showReturnNotification(info));
  /* AI habit coach: aggregates only, gated by the existing consent. */
  ipcMain.handle('retoma:habits:report', async (ev, opts) => {
    var o = opts || {};
    var m = o.mode === 'live' || o.mode === 'demo' ? o.mode : modeNow();
    var loaded = store.loadEventsFile(fs, eventsFileFor(m));
    var metrics = habits.computeMetrics(loaded.events || []);
    var expFile = experimentsFileFor(m);
    var exps = store.loadExperimentsFile(fs, expFile);
    var evaluation = null;
    var today = dayKeyLocal(Date.now());
    var activeIx = -1;
    for (var i = exps.length - 1; i >= 0; i--) {
      if (exps[i] && exps[i].status === 'active') { activeIx = i; break; }
    }
    if (activeIx !== -1 && metrics) {
      var prev = exps[activeIx];
      var createdDay = prev.createdAt ? dayKeyLocal(Date.parse(prev.createdAt)) : '';
      if (createdDay && createdDay !== today) {
        evaluation = habits.evaluateExperiment(prev, metrics);
        prev.status = 'done';
        prev.result = evaluation ? evaluation.status : 'unknown';
        store.saveExperimentsFile(fs, expFile, exps);
      }
    }
    var report = await providers.habitsReport(metrics, {
      mode: o.aiMode || 'off',
      consent: o.consent || {},
      ollamaUrl: process.env.OLLAMA_URL || process.env.RETOMA_OLLAMA_URL
    });
    return { metrics: metrics, report: report, evaluation: evaluation };
  });
  ipcMain.handle('retoma:habits:accept', (ev, experiment, opts) => {
    var o = opts || {};
    var m = o.mode === 'live' || o.mode === 'demo' ? o.mode : modeNow();
    if (!experiment || typeof experiment.text !== 'string' || !experiment.text ||
        typeof experiment.trigger !== 'string' || typeof experiment.action !== 'string' ||
        !Number.isInteger(experiment.minutes)) {
      return false;
    }
    var expFile = experimentsFileFor(m);
    var exps = store.loadExperimentsFile(fs, expFile);
    exps.forEach(function (e) { if (e && e.status === 'active') e.status = 'done'; });
    exps.push({
      id: 'exp-' + Date.now(),
      createdAt: new Date().toISOString(),
      pattern: experiment.pattern || '',
      metric: experiment.metric || 'longest',
      target: experiment.target,
      direction: experiment.direction === 'atMost' ? 'atMost' : 'atLeast',
      trigger: experiment.trigger,
      action: experiment.action,
      minutes: experiment.minutes,
      text: experiment.text,
      status: 'active'
    });
    store.saveExperimentsFile(fs, expFile, exps);
    return true;
  });
  ipcMain.handle('retoma:habits:ask', async (ev, question, opts) => {
    var o = opts || {};
    var m = o.mode === 'live' || o.mode === 'demo' ? o.mode : modeNow();
    var loaded = store.loadEventsFile(fs, eventsFileFor(m));
    var metrics = habits.computeMetrics(loaded.events || []);
    return providers.habitsAsk(metrics, question, {
      mode: o.aiMode || 'off',
      consent: o.consent || {},
      ollamaUrl: process.env.OLLAMA_URL || process.env.RETOMA_OLLAMA_URL
    });
  });
  ipcMain.handle('retoma:ai:status', async (ev, opts) => {
    var o = opts || {};
    var consent = o.consent || {};
    var base = process.env.OLLAMA_URL || process.env.RETOMA_OLLAMA_URL;
    if (!consent.local) {
      return { gated: true, reachable: false, model: '', url: providers.capabilities().ollamaUrl };
    }
    var st = await providers.aiStatus({ ollamaUrl: base });
    st.gated = false;
    return st;
  });
  ipcMain.on('retoma:paused', (ev, isPaused) => {
    paused = !!isPaused;
    try {
      var next = persistSettings({ paused: paused });
      if (liveMgr) liveMgr.setPaused(paused);
      void next;
    } catch (e) { /* settings stay in memory */ }
    refreshTray();
  });
  ipcMain.handle('retoma:settings:load', () => {
    var loaded = currentSettings();
    persistSettings({});
    return loaded;
  });
  ipcMain.handle('retoma:settings:save', (ev, patch) => {
    var next = persistSettings(patch || {});
    applyLiveSettings(next);
    if (win && !win.isDestroyed()) win.webContents.send('retoma:settings', next);
    return next;
  });
  ipcMain.handle('retoma:live:status', () => (liveMgr ? liveMgr.status() : 'error'));
  ipcMain.handle('retoma:live:replay', () => (liveMgr ? liveMgr.replay() : false));
  ipcMain.handle('retoma:live:ready', () => (liveMgr ? liveMgr.ready() : false));
  ipcMain.handle('retoma:helper:describe', () => installer.describeInstall());
  ipcMain.handle('retoma:helper:check', () => ({
    status: liveMgr ? liveMgr.status() : 'error',
    installed: installer.isInstalled(fs),
    installedFiles: installer.installedFiles(fs),
    enableCommand: installer.ENABLE_COMMAND,
    dest: installer.destDir()
  }));
  ipcMain.handle('retoma:helper:install', async (ev, opts) => {
    var meta = installer.describeInstall();
    var confirmed;
    if (opts && opts.skipDialog === true) {
      confirmed = !!opts.confirm;
    } else {
      var res = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Install helper extension',
        message: 'Copy the Retoma focus helper into your GNOME extensions folder?',
        detail: 'This copies exactly 2 files:\n' +
          meta.files.map(function (f) { return '  ' + f; }).join('\n') +
          '\nFrom: ' + meta.from + '\nTo: ' + meta.to + '\n\nNothing else is copied. GNOME loads new extensions at login.',
        buttons: ['Cancel', 'Install helper'],
        defaultId: 0,
        cancelId: 0
      });
      confirmed = res.response === 1;
    }
    if (!confirmed) return { copied: false, dest: meta.to, files: [] };
    var done = installer.installHelper({ fs: fs, confirm: true });
    return done;
  });
}

function enforceRetention() {
  try {
    ['demo', 'live'].forEach(function (m) {
      var f = eventsFileFor(m);
      var loaded = store.loadEventsFile(fs, f);
      store.saveEventsFile(fs, f, loaded.events);
      var xf = experimentsFileFor(m);
      var exps = store.loadExperimentsFile(fs, xf);
      store.saveExperimentsFile(fs, xf, exps);
    });
  } catch (e) { /* first run: nothing stored yet */ }
}

// Single instance: a second launch focuses the open window.
var gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    setupIpc();
    createWindow();
    setupTray();
    setupShortcut();
    enforceRetention();
    setupLive();
    setInterval(enforceRetention, 3600 * 1000);
  });
}
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* noop */ } });

module.exports = { showReturnNotification: showReturnNotification, trayIconPath: trayIconPath };
