/* ai/native.js — MAIN PROCESS file. Pure handlers for tray, shortcut and
 * notifications. Kept dependency-free so unit tests cover them headless
 * (Electron cannot show tray or notifications in CI). main.js wires these
 * to real Electron APIs. */
'use strict';

var AWAY_NOTIFY_MIN = 10;

function shouldNotify(awayMinutes) {
  return Number(awayMinutes) >= AWAY_NOTIFY_MIN;
}

function resumeNotification(app) {
  return { title: 'Retoma', body: 'Pick up where you left off: ' + app };
}

function trayMenuLabels(paused) {
  return ['Open Retoma', paused ? 'Resume tracking' : 'Pause tracking', 'Quit'];
}

function trayIconName(paused) {
  return paused ? 'tray-paused' : 'tray-active';
}

function toggleVisible(visible) {
  return !visible;
}

module.exports = {
  AWAY_NOTIFY_MIN: AWAY_NOTIFY_MIN,
  shouldNotify: shouldNotify,
  resumeNotification: resumeNotification,
  trayMenuLabels: trayMenuLabels,
  trayIconName: trayIconName,
  toggleVisible: toggleVisible
};
