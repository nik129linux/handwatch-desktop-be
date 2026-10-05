// preload.js — the ONLY bridge between renderer and main. Exposes
// window.retoma.propose(summary) etc. No keys ever reach the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('retoma', {
  platform: 'electron',
  propose: (summary, opts) => ipcRenderer.invoke('retoma:propose', summary, opts),
  previewPayload: (summary, mode) => ipcRenderer.invoke('retoma:preview', summary, mode),
  capabilities: () => ipcRenderer.invoke('retoma:capabilities'),
  loadEvents: (mode) => ipcRenderer.invoke('retoma:events:load', mode),
  saveEvents: (events, mode) => ipcRenderer.invoke('retoma:events:save', events, mode),
  deleteEvents: (mode) => ipcRenderer.invoke('retoma:events:delete', mode),
  exportEvents: () => ipcRenderer.invoke('retoma:events:export'),
  notifyReturn: (info) => ipcRenderer.send('retoma:notify-return', info),
  setPaused: (paused) => ipcRenderer.send('retoma:paused', paused),
  onFocusResume: (fn) => ipcRenderer.on('retoma:focus-resume', () => fn()),
  loadSettings: () => ipcRenderer.invoke('retoma:settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('retoma:settings:save', patch),
  onSettings: (fn) => ipcRenderer.on('retoma:settings', (ev, data) => fn(data)),
  liveStatus: () => ipcRenderer.invoke('retoma:live:status'),
  liveReplay: () => ipcRenderer.invoke('retoma:live:replay'),
  liveReady: () => ipcRenderer.invoke('retoma:live:ready'),
  onLiveEvent: (fn) => ipcRenderer.on('retoma:live:event', (ev, data) => fn(data)),
  onLiveStatus: (fn) => ipcRenderer.on('retoma:live:status', (ev, status) => fn(status)),
  helperDescribe: () => ipcRenderer.invoke('retoma:helper:describe'),
  helperCheck: () => ipcRenderer.invoke('retoma:helper:check'),
  helperInstall: (opts) => ipcRenderer.invoke('retoma:helper:install', opts || {}),
  habitsReport: (opts) => ipcRenderer.invoke('retoma:habits:report', opts || {}),
  habitsAccept: (experiment, opts) => ipcRenderer.invoke('retoma:habits:accept', experiment, opts || {}),
  habitsAsk: (question, opts) => ipcRenderer.invoke('retoma:habits:ask', question, opts || {}),
  aiStatus: (opts) => ipcRenderer.invoke('retoma:ai:status', opts || {})
});
