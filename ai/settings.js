/* ai/settings.js — MAIN PROCESS file. Retoma settings (mode, live privacy)
 * live in app.getPath('userData')/settings.json. Pure helpers so unit tests
 * drive them without Electron. Demo is always the default mode. */
'use strict';

var path = require('path');

var tracker;
try {
  tracker = require('../live/live-tracker');
} catch (e) {
  tracker = { DEFAULT_BLOCKLIST: ['keepassxc', 'bitwarden', '1password', 'org.gnome.seahorse', 'gnome-keyring', 'polkit'] };
}

var SETTINGS_VERSION = 1;
var AWAY_CHOICES = [2, 5, 10];

function defaults() {
  return {
    mode: 'demo',
    storeTitles: false,
    awayAfterMin: 5,
    blocklist: tracker.DEFAULT_BLOCKLIST.slice(),
    paused: false
  };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

/* Merge anything partial over defaults. Unknown modes fall back to demo;
 * awayAfterMin accepts any positive number (the UI offers 2/5/10). */
function sanitize(input) {
  var out = defaults();
  if (!input || typeof input !== 'object') return out;
  if (input.mode === 'demo' || input.mode === 'live') out.mode = input.mode;
  if (Object.prototype.hasOwnProperty.call(input, 'storeTitles')) {
    out.storeTitles = !!input.storeTitles;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'awayAfterMin')) {
    var m = Number(input.awayAfterMin);
    if (isFinite(m) && m > 0) out.awayAfterMin = m;
  }
  if (Array.isArray(input.blocklist)) {
    out.blocklist = input.blocklist.filter(function (e) {
      return typeof e === 'string' && e.trim().length > 0;
    }).map(function (e) { return e.trim(); });
  }
  if (Object.prototype.hasOwnProperty.call(input, 'paused')) {
    out.paused = !!input.paused;
  }
  return out;
}

function loadSettingsFile(fsImpl, filePath) {
  var raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (e) {
    return sanitize(null);
  }
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return sanitize(null);
  }
  var body = data && typeof data === 'object' && data.settings ? data.settings : data;
  return sanitize(body);
}

function saveSettingsFile(fsImpl, filePath, patchOrFull) {
  var current = loadSettingsFile(fsImpl, filePath);
  var merged = sanitize(Object.assign({}, current, patchOrFull || {}));
  var data = { version: SETTINGS_VERSION, savedAt: new Date().toISOString(), settings: merged };
  fsImpl.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return merged;
}

module.exports = {
  SETTINGS_VERSION: SETTINGS_VERSION,
  AWAY_CHOICES: AWAY_CHOICES.slice(),
  defaults: defaults,
  sanitize: sanitize,
  settingsPath: settingsPath,
  loadSettingsFile: loadSettingsFile,
  saveSettingsFile: saveSettingsFile
};
