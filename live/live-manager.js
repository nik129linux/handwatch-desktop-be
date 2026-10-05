/* live/live-manager.js — MAIN PROCESS module. Owns the live pipeline:
 * focus-source + idle-source feed the pure live-tracker; tracker events go
 * to the renderer over IPC, episodes are appended to events.json, returns
 * fire the native notification. With RETOMA_LIVE_FAKE=path.json the real
 * D-Bus sources stay off and a scripted timeline drives the same tracker,
 * so tests see the exact same privacy rules and events. Timers injectable. */
'use strict';

var fs = require('fs');

function defaultTimer() {
  return {
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval
  };
}

/* Fake script shape:
 * { "samples": [ { "waitMs": 100, "advanceMs": 0,
 *                  "focus": { "appId": "..", "appName": "..", "title": ".." },
 *                  "idleMs": 300000 } ] }
 * waitMs is real scheduling delay; advanceMs moves the tracker's virtual
 * clock so scripted away periods read as real minutes. */
function loadFakeFile(fsImpl, filePath) {
  var raw = fsImpl.readFileSync(filePath, 'utf8');
  var data = JSON.parse(raw);
  var samples = (data && data.samples) || data;
  if (!Array.isArray(samples)) throw new Error('fake file needs a samples array');
  return samples.map(function (s) {
    return {
      waitMs: Number(s.waitMs || 0),
      advanceMs: Number(s.advanceMs || 0),
      focus: s.focus || null,
      idleMs: s.idleMs === undefined || s.idleMs === null ? null : Number(s.idleMs)
    };
  });
}

/* createLiveManager({ focusSource, idleSource, tracker, send, sendStatus,
 *   saveEpisode, notify, timer, fakeSamples, clock }):
 * - tracker: a live-tracker instance (owns the virtual clock when fake)
 * - send(evt): tracker events for the renderer
 * - saveEpisode(entry): append one { app, duration } to events.json
 * - notify({ awayMinutes, app }): native return notification
 * - clock: { now(), advance(ms) } in fake mode; defaults to Date */
function createLiveManager(opts) {
  opts = opts || {};
  var focusSource = opts.focusSource || null;
  var idleSource = opts.idleSource || null;
  var tracker = opts.tracker;
  if (!tracker) {
    tracker = require('./live-tracker').createLiveTracker({
      emit: function (evt) { emitToTracker(evt); },
      clock: opts.clock || Date,
      settings: opts.settings || {}
    });
  }
  var send = opts.send || function () {};
  var sendStatus = opts.sendStatus || function () {};
  var saveEpisode = opts.saveEpisode || function () {};
  var notify = opts.notify || function () {};
  var timer = opts.timer || defaultTimer();
  var fakeSamples = opts.fakeSamples || null;
  var clock = opts.clock || null;

  var running = false;
  var played = false;
  var tickId = null;
  var statusId = null;
  var lastStatus = null;
  var playTimers = [];
  var unsubFocus = null;
  var unsubIdle = null;

  function emitToTracker(evt) {
    try {
      if (evt.type === 'episode' && evt.entry) {
        try { saveEpisode(evt.entry); } catch (e) { /* store errors never stop tracking */ }
      }
      if (evt.type === 'return') {
        try { notify({ awayMinutes: evt.awayMinutes, app: evt.app }); } catch (e) { /* headless */ }
      }
      send(evt);
    } catch (e) { /* renderer bugs must not break tracking */ }
    pushStatus();
  }

  function currentStatus() {
    if (tracker && tracker.getSettings && tracker.getSettings().paused) return 'paused';
    if (fakeSamples) return 'ready';
    if (focusSource && typeof focusSource.status === 'function') {
      var s = focusSource.status();
      if (s === 'extension-missing') return 'extension-missing';
      if (s === 'ready') return 'ready';
      return 'error';
    }
    return 'error';
  }

  function pushStatus() {
    var s = currentStatus();
    if (s !== lastStatus) {
      lastStatus = s;
      try { sendStatus(s); } catch (e) { /* noop */ }
    }
  }

  function playFake() {
    if (!fakeSamples || !fakeSamples.length) return;
    fakeSamples.forEach(function (sample, ix) {
      var delay = fakeSamples.slice(0, ix + 1).reduce(function (sum, s) { return sum + (s.waitMs || 0); }, 0);
      var id = timer.setTimeout(function () {
        if (!running) return;
        if (clock && sample.advanceMs) {
          try { clock.advance(sample.advanceMs); } catch (e) { /* noop */ }
        }
        if (sample.focus) {
          try { tracker.onFocus(sample.focus); } catch (e) { /* bad sample: skip */ }
        }
        if (sample.idleMs !== null && sample.idleMs !== undefined) {
          try { tracker.onIdle(sample.idleMs); } catch (e) { /* skip */ }
        }
        try { tracker.tick(); } catch (e) { /* noop */ }
      }, delay);
      playTimers.push(id);
    });
  }

  function clearPlay() {
    playTimers.forEach(function (id) {
      try { timer.clearTimeout(id); } catch (e) { /* noop */ }
    });
    playTimers = [];
  }

  return {
    start: function () {
      if (running) return;
      running = true;
      lastStatus = null;
      if (fakeSamples) {
        // Scripted playback starts on ready(), once the renderer subscribes.
      } else {
        if (focusSource && focusSource.start) {
          try {
            unsubFocus = focusSource.onFocus
              ? focusSource.onFocus(function (f) {
                try { tracker.onFocus(f); } catch (e) { /* skip */ }
              })
              : null;
          } catch (e) { unsubFocus = null; }
          try { focusSource.start(); } catch (e) { /* D-Bus down: status tells the truth */ }
        }
        if (idleSource && idleSource.start) {
          try {
            unsubIdle = idleSource.onIdle
              ? idleSource.onIdle(function (ms) {
                try { tracker.onIdle(ms); } catch (e) { /* skip */ }
              })
              : null;
          } catch (e) { unsubIdle = null; }
          try { idleSource.start(); } catch (e) { /* noop */ }
        }
      }
      try {
        tickId = timer.setInterval(function () {
          if (!running) return;
          try { tracker.tick(); } catch (e) { /* noop */ }
        }, 1000);
      } catch (e) { tickId = null; }
      try {
        statusId = timer.setInterval(function () {
          if (!running) return;
          pushStatus();
        }, 2000);
      } catch (e) { statusId = null; }
      pushStatus();
    },
    stop: function () {
      running = false;
      clearPlay();
      if (tickId) { try { timer.clearInterval(tickId); } catch (e) { /* noop */ } tickId = null; }
      if (statusId) { try { timer.clearInterval(statusId); } catch (e) { /* noop */ } statusId = null; }
      if (unsubFocus) { try { unsubFocus(); } catch (e) { /* noop */ } unsubFocus = null; }
      if (unsubIdle) { try { unsubIdle(); } catch (e) { /* noop */ } unsubIdle = null; }
      if (!fakeSamples) {
        if (focusSource && focusSource.stop) { try { focusSource.stop(); } catch (e) { /* noop */ } }
        if (idleSource && idleSource.stop) { try { idleSource.stop(); } catch (e) { /* noop */ } }
      }
    },
    /* Re-run the scripted timeline (tests). No-op without a fake file. */
    replay: function () {
      if (!running || !fakeSamples) return false;
      played = true;
      clearPlay();
      playFake();
      return true;
    },
    /* The renderer calls this after subscribing so no event is lost. */
    ready: function () {
      if (!running || !fakeSamples || played) return false;
      played = true;
      playFake();
      return true;
    },
    updateSettings: function (patch) {
      try { tracker.updateSettings(patch); } catch (e) { /* noop */ }
      pushStatus();
    },
    setPaused: function (paused) {
      try { tracker.setPaused(paused); } catch (e) { /* noop */ }
      pushStatus();
    },
    status: function () {
      return currentStatus();
    },
    isRunning: function () {
      return running;
    },
    isFake: function () {
      return !!fakeSamples;
    },
    getTracker: function () {
      return tracker;
    }
  };
}

module.exports = {
  loadFakeFile: loadFakeFile,
  createLiveManager: createLiveManager
};
