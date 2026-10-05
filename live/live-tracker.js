// live/live-tracker.js — PURE state machine (injectable clock, no IO).
// Consumes real focus ({ appId, appName, title }) + idle milliseconds and
// emits the events the existing app already understands:
//
//   { type: 'app:switch', app: { label, title? } }  like Events.emit('app:switch', next)
//   { type: 'episode', entry: { app, duration } }    like timeline entries { app, duration }
//   { type: 'away', app }                            like Retoma.goAway (prevApp kept)
//   { type: 'return', app, awayMinutes }              like notifyReturn({ awayMinutes, app })
//
// Rules: Retoma's own window never counts; same-app title changes only
// update minutes (no new episode); sub-3s focus blips are merged; idle >=
// awayAfterMin starts away; first activity after away emits one return.
// Privacy: storeTitles defaults FALSE (title dropped BEFORE emit, so it is
// never persisted or sent anywhere); titles truncate to 60 chars;
// blocklisted apps become "Private app" with no title; paused records nothing.
'use strict';

var BLIP_MS = 3000;
var TITLE_MAX = 60;
var PRIVATE_LABEL = 'Private app';

var DEFAULT_BLOCKLIST = [
  'keepassxc',
  'bitwarden',
  '1password',
  'org.gnome.seahorse',
  'gnome-keyring',
  'polkit'
];

var SELF_MATCHERS = ['retoma', 'com.retoma.desktop'];

function defaultSettings() {
  return {
    storeTitles: false,
    awayAfterMin: 5,
    blocklist: DEFAULT_BLOCKLIST.slice(),
    paused: false
  };
}

function lower(s) {
  return String(s || '').toLowerCase();
}

function isSelf(appId, appName) {
  var id = lower(appId);
  var name = lower(appName);
  return SELF_MATCHERS.some(function (m) {
    return id.indexOf(m) !== -1 || name.indexOf(m) !== -1;
  });
}

function isBlocklisted(appId, appName, blocklist) {
  var id = lower(appId);
  var name = lower(appName);
  return (blocklist || []).some(function (entry) {
    var e = lower(entry);
    if (!e) return false;
    return id.indexOf(e) !== -1 || name.indexOf(e) !== -1;
  });
}

function truncateTitle(title) {
  var t = String(title || '');
  if (t.length > TITLE_MAX) return t.slice(0, TITLE_MAX);
  return t;
}

// Normalize raw focus into { app, title? } or null when the window must
// be ignored entirely (Retoma's own window). Privacy is applied here, so
// anything emitted downstream is already safe to persist or render.
function normalize(raw, settings) {
  var appId = raw ? raw.appId : '';
  var appName = raw ? raw.appName : '';
  if (isSelf(appId, appName)) return null;
  var label = String(appName || appId || 'Unknown').trim() || 'Unknown';
  if (isBlocklisted(appId, appName, settings.blocklist)) {
    return {app: PRIVATE_LABEL};
  }
  var out = {app: label};
  if (settings.storeTitles) {
    var title = String(raw && raw.title ? raw.title : '').trim();
    if (title) out.title = truncateTitle(title);
  }
  return out;
}

function focusEvent(norm, at) {
  var app = {label: norm.app};
  if (Object.prototype.hasOwnProperty.call(norm, 'title')) app.title = norm.title;
  return {type: 'app:switch', app: app, at: at};
}

// createLiveTracker({ emit, clock, settings }):
// - emit(evt): receives every event above
// - clock { now() -> ms }, defaults to Date
// - settings: partial; merged over defaults
function createLiveTracker(opts) {
  opts = opts || {};
  var emit = opts.emit || function () {};
  var clock = opts.clock || Date;
  var settings = defaultSettings();
  if (opts.settings) updateSettings(opts.settings);

  var current = null; // { app, title?, since }
  var pending = null; // { app, title?, at }
  var away = false;
  var awayStart = 0;
  var awayApp = null;

  function now() {
    return clock.now();
  }

  function send(evt) {
    try { emit(evt); } catch (e) { /* consumer bugs must not break tracking */ }
  }

  function updateSettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(patch, 'storeTitles')) {
      settings.storeTitles = !!patch.storeTitles;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'awayAfterMin')) {
      var m = Number(patch.awayAfterMin);
      if (isFinite(m) && m > 0) settings.awayAfterMin = m;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'blocklist') && Array.isArray(patch.blocklist)) {
      settings.blocklist = patch.blocklist.slice();
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'paused')) {
      settings.paused = !!patch.paused;
    }
  }

  function closeCurrent(endedAt) {
    if (!current) return;
    var ms = Math.max(0, endedAt - current.since);
    var duration = Math.max(1, Math.round(ms / 60000));
    var entry = {app: current.app, duration: duration};
    send({type: 'episode', entry: entry, at: endedAt});
    current = null;
  }

  function commitPending() {
    if (!pending) return;
    closeCurrent(pending.at);
    current = {app: pending.app, since: pending.at};
    if (Object.prototype.hasOwnProperty.call(pending, 'title')) current.title = pending.title;
    var norm = {app: pending.app};
    if (Object.prototype.hasOwnProperty.call(pending, 'title')) norm.title = pending.title;
    pending = null;
    awayApp = current.app;
    send(focusEvent(norm, current.since));
  }

  // Stage a focus change; it commits once stable for BLIP_MS.
  // Anything that dies faster is a blip and never becomes an episode.
  function stage(norm, at) {
    if (!current) {
      current = {app: norm.app, since: at};
      if (Object.prototype.hasOwnProperty.call(norm, 'title')) current.title = norm.title;
      send(focusEvent(norm, at));
      return;
    }
    if (norm.app === current.app) {
      // Same app (title change counts as more minutes, not a new episode).
      // Focus came back: any staged newcomer was a blip — drop it.
      pending = null;
      if (Object.prototype.hasOwnProperty.call(norm, 'title')) current.title = norm.title;
      else delete current.title;
      return;
    }
    if (pending && norm.app === pending.app) {
      if (Object.prototype.hasOwnProperty.call(norm, 'title')) pending.title = norm.title;
      else delete pending.title;
      if (at - pending.at >= BLIP_MS) commitPending();
      return;
    }
    if (pending) {
      if (at - pending.at < BLIP_MS) {
        // The staged app was a blip: drop it, stage the newcomer instead.
        pending = {app: norm.app, at: at};
        if (Object.prototype.hasOwnProperty.call(norm, 'title')) pending.title = norm.title;
      } else {
        commitPending();
        pending = {app: norm.app, at: at};
        if (Object.prototype.hasOwnProperty.call(norm, 'title')) pending.title = norm.title;
      }
      return;
    }
    pending = {app: norm.app, at: at};
    if (Object.prototype.hasOwnProperty.call(norm, 'title')) pending.title = norm.title;
  }

  function goAway(at) {
    if (away) return;
    // Focus was stable (the user is idle): commit before freezing.
    commitPending();
    closeCurrent(at);
    away = true;
    awayStart = at;
    send({type: 'away', app: awayApp, at: at});
  }

  function comeBack(at) {
    if (!away) return false;
    away = false;
    var awayMinutes = Math.max(1, Math.round((at - awayStart) / 60000));
    var app = awayApp || 'Unknown';
    awayApp = null;
    send({type: 'return', app: app, awayMinutes: awayMinutes, at: at});
    return true;
  }

  return {
    // Focus from focus-source: { appId, appName, title }.
    onFocus: function (raw) {
      if (settings.paused) return;
      var at = now();
      if (away) {
        // A focus change means the user is back: return first, then track.
        var norm0 = normalize(raw, settings);
        if (!norm0) return;
        comeBack(at);
        stage(norm0, at);
        return;
      }
      var norm = normalize(raw, settings);
      if (!norm) return; // Retoma's own window never counts.
      stage(norm, at);
      if (current) awayApp = current.app;
      else if (pending) awayApp = pending.app;
    },
    // Idle sample from idle-source: milliseconds since last input.
    onIdle: function (idleMs) {
      if (settings.paused) return;
      var at = now();
      var threshold = settings.awayAfterMin * 60000;
      if (!away && idleMs >= threshold) {
        if (current) awayApp = current.app;
        else if (pending) awayApp = pending.app;
        goAway(at);
      } else if (away && idleMs < threshold) {
        comeBack(at);
      }
    },
    // Commit a staged focus change once it survived BLIP_MS. Call on a
    // timer or after advancing a fake clock in tests.
    tick: function () {
      if (settings.paused) return;
      if (away) return;
      if (pending && now() - pending.at >= BLIP_MS) commitPending();
    },
    setPaused: function (paused) {
      settings.paused = !!paused;
      if (paused) {
        // Paused records nothing: drop staged, keep current frozen silently.
        pending = null;
      }
    },
    updateSettings: updateSettings,
    getSettings: function () {
      return {
        storeTitles: settings.storeTitles,
        awayAfterMin: settings.awayAfterMin,
        blocklist: settings.blocklist.slice(),
        paused: settings.paused
      };
    },
    isAway: function () {
      return away;
    },
    // Test/debug introspection (not part of the event contract).
    _debug: function () {
      return {current: current, pending: pending, away: away};
    }
  };
}

module.exports = {
  BLIP_MS: BLIP_MS,
  TITLE_MAX: TITLE_MAX,
  PRIVATE_LABEL: PRIVATE_LABEL,
  DEFAULT_BLOCKLIST: DEFAULT_BLOCKLIST.slice(),
  createLiveTracker: createLiveTracker
};
