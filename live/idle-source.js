// live/idle-source.js — MAIN PROCESS module. Polls GNOME's
// Mutter IdleMonitor for real idle milliseconds via `gdbus call`.
// No polling happens while Live is off (start/stop). IO injectable.
'use strict';

var IDLE_ARGS = [
  'call', '--session',
  '--dest', 'org.gnome.Mutter.IdleMonitor',
  '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
  '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'
];

var DEFAULT_INTERVAL_MS = 5000;

// Parse `(uint64 15433,)` -> 15433. Returns null when unparseable.
function parseIdleLine(out) {
  try {
    var m = /\(\s*uint64\s+(\d+)\s*,?\s*\)/.exec(String(out || ''));
    if (!m) return null;
    return parseInt(m[1], 10);
  } catch (e) {
    return null;
  }
}

function defaultExec(cmd, args) {
  var execFile = require('child_process').execFile;
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, function (err, stdout) {
      if (err) reject(err);
      else resolve(String(stdout || ''));
    });
  });
}

// createIdleSource({ exec, timer, intervalMs }):
// - exec(cmd, args) -> Promise<string> (stdout)
// - timer { setInterval, clearInterval }
function createIdleSource(opts) {
  opts = opts || {};
  var exec = opts.exec || defaultExec;
  var timer = opts.timer || {setInterval: setInterval, clearInterval: clearInterval};
  var intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;

  var listeners = [];
  var intervalId = null;
  var running = false;

  function emitIdle(ms) {
    listeners.slice().forEach(function (fn) {
      try { fn(ms); } catch (e) { /* listener bugs must not stop polling */ }
    });
  }

  function poll() {
    if (!running) return;
    exec('gdbus', IDLE_ARGS).then(function (out) {
      if (!running) return;
      var ms = parseIdleLine(out);
      if (ms !== null) emitIdle(ms);
    }, function () {
      // D-Bus hiccup: skip this sample, keep polling.
    });
  }

  return {
    start: function () {
      if (running) return;
      running = true;
      poll();
      intervalId = timer.setInterval(poll, intervalMs);
    },
    stop: function () {
      running = false;
      if (intervalId) {
        timer.clearInterval(intervalId);
        intervalId = null;
      }
    },
    onIdle: function (fn) {
      listeners.push(fn);
      return function () {
        var ix = listeners.indexOf(fn);
        if (ix !== -1) listeners.splice(ix, 1);
      };
    },
    isRunning: function () {
      return running;
    }
  };
}

module.exports = {
  IDLE_ARGS: IDLE_ARGS,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  parseIdleLine: parseIdleLine,
  createIdleSource: createIdleSource
};
