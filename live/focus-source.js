// live/focus-source.js — MAIN PROCESS module. Follows the Retoma GNOME
// Shell extension over D-Bus by spawning `gdbus monitor` (no npm deps).
// All IO is injectable so unit tests run with no display and no D-Bus.
'use strict';

var BUS_NAME = 'org.retoma.Focus';
var OBJECT_PATH = '/org/retoma/Focus';
var SIGNAL_NAME = 'FocusChanged';

var DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000];

function defaultBackoffMs(attempt) {
  if (attempt < 1) attempt = 1;
  if (attempt > DEFAULT_BACKOFF.length) return DEFAULT_BACKOFF[DEFAULT_BACKOFF.length - 1];
  return DEFAULT_BACKOFF[attempt - 1];
}

// Unescape one GVariant text-format string body (quotes already stripped).
function unescapeBody(body) {
  var out = '';
  var i = 0;
  while (i < body.length) {
    var c = body[i];
    if (c !== '\\' || i + 1 >= body.length) {
      out += c;
      i++;
      continue;
    }
    var n = body[i + 1];
    if (n === 'n') { out += '\n'; i += 2; }
    else if (n === 't') { out += '\t'; i += 2; }
    else if (n === 'r') { out += '\r'; i += 2; }
    else if (n === 'b') { out += '\b'; i += 2; }
    else if (n === 'f') { out += '\f'; i += 2; }
    else if (n === '\\') { out += '\\'; i += 2; }
    else if (n === "'") { out += "'"; i += 2; }
    else if (n === '"') { out += '"'; i += 2; }
    else if (n === 'u' || n === 'U') {
      var len = n === 'u' ? 4 : 8;
      var hex = body.substr(i + 2, len);
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === len) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
      } else {
        out += n;
        i += 2;
      }
    } else {
      // Unknown escape: keep the escaped char, drop the backslash.
      out += n;
      i += 2;
    }
  }
  return out;
}

// Parse the argument tuple after FocusChanged: three quoted strings.
// Accepts single or double quotes, separator commas, trailing ')'.
function parseTuple(text, start) {
  var parts = [];
  var i = start;
  while (i < text.length && parts.length < 3) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return null;
    var quote = text[i];
    if (quote !== "'" && quote !== '"') return null;
    i++;
    var body = '';
    var closed = false;
    while (i < text.length) {
      var c = text[i];
      if (c === '\\' && i + 1 < text.length) {
        body += c + text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        closed = true;
        i++;
        break;
      }
      body += c;
      i++;
    }
    if (!closed) return null;
    parts.push(unescapeBody(body));
    while (i < text.length && /\s/.test(text[i])) i++;
    if (parts.length < 3) {
      if (text[i] !== ',') return null;
      i++;
    }
  }
  return parts.length === 3 ? {parts: parts, end: i} : null;
}

// Parse one `gdbus monitor` output line. Returns
// { appId, appName, title } or null for anything else. Never throws.
function parseFocusLine(line) {
  try {
    if (typeof line !== 'string') return null;
    var ix = line.indexOf(SIGNAL_NAME);
    if (ix === -1) return null;
    var open = line.indexOf('(', ix + SIGNAL_NAME.length);
    if (open === -1) return null;
    var tup = parseTuple(line, open + 1);
    if (!tup) return null;
    return {appId: tup.parts[0], appName: tup.parts[1], title: tup.parts[2]};
  } catch (e) {
    return null;
  }
}

function parseNameHasOwner(out) {
  return /\(\s*true\s*,?\s*\)/.test(String(out || ''));
}

function defaultSpawn(cmd, args) {
  return require('child_process').spawn(cmd, args);
}

function defaultExecFile(cmd, args) {
  var execFile = require('child_process').execFile;
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, function (err, stdout) {
      if (err) reject(err);
      else resolve({stdout: String(stdout || '')});
    });
  });
}

// createFocusSource({ spawn, execFile, timer, backoffMs }):
// - spawn(cmd, args) -> child with stdout.on('data') + on('close'|'error') + kill()
// - execFile(cmd, args) -> Promise<{stdout}>
// - timer { setTimeout, clearTimeout }, backoffMs(attempt) -> ms
function createFocusSource(opts) {
  opts = opts || {};
  var spawn = opts.spawn || defaultSpawn;
  var execFile = opts.execFile || defaultExecFile;
  var timer = opts.timer || {setTimeout: setTimeout, clearTimeout: clearTimeout};
  var backoffMs = opts.backoffMs || defaultBackoffMs;

  var listeners = [];
  var proc = null;
  var buf = '';
  var retryId = null;
  var stopped = true;
  var attempts = 0;
  var currentStatus = 'error';

  function setStatus(s) {
    currentStatus = s;
  }

  function emitFocus(focus) {
    listeners.slice().forEach(function (fn) {
      try { fn(focus); } catch (e) { /* listener bugs must not kill the monitor */ }
    });
  }

  function scheduleRetry() {
    if (stopped) return;
    attempts++;
    var ms = backoffMs(attempts);
    if (retryId) timer.clearTimeout(retryId);
    retryId = timer.setTimeout(function () {
      retryId = null;
      if (!stopped) boot();
    }, ms);
  }

  function checkOwner() {
    return execFile('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner',
      BUS_NAME
    ]).then(function (res) {
      var out = res && typeof res.stdout === 'string' ? res.stdout : String(res || '');
      return parseNameHasOwner(out);
    }, function () {
      return false;
    });
  }

  function spawnMonitor() {
    buf = '';
    var child;
    try {
      child = spawn('gdbus', [
        'monitor', '--session',
        '--dest', BUS_NAME,
        '--object-path', OBJECT_PATH
      ]);
    } catch (e) {
      setStatus('error');
      scheduleRetry();
      return;
    }
    proc = child;
    setStatus('ready');
    if (child.stdout && child.stdout.on) {
      child.stdout.on('data', function (chunk) {
        buf += String(chunk);
        var lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(function (line) {
          var focus = parseFocusLine(line);
          if (focus) {
            attempts = 0;
            emitFocus(focus);
          }
        });
      });
    }
    var onDeath = function () {
      if (proc !== child) return;
      proc = null;
      if (stopped) return;
      // The bus name went away (extension disabled, shell restart):
      // re-check ownership so status() tells the truth, then retry.
      setStatus('error');
      checkOwner().then(function (owned) {
        if (stopped) return;
        if (!owned) {
          setStatus('extension-missing');
          scheduleRetry();
        } else {
          scheduleRetry();
        }
      });
    };
    if (child.on) {
      child.on('close', onDeath);
      child.on('error', onDeath);
    }
  }

  function boot() {
    if (stopped) return;
    checkOwner().then(function (owned) {
      if (stopped) return;
      if (!owned) {
        setStatus('extension-missing');
        scheduleRetry();
        return;
      }
      spawnMonitor();
    });
  }

  return {
    // Starts monitoring. Safe to call twice (second call is a no-op).
    start: function () {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      boot();
    },
    stop: function () {
      stopped = true;
      if (retryId) {
        timer.clearTimeout(retryId);
        retryId = null;
      }
      if (proc && proc.kill) {
        var p = proc;
        proc = null;
        try { p.kill(); } catch (e) { /* already dead */ }
      }
      setStatus('error');
    },
    onFocus: function (fn) {
      listeners.push(fn);
      return function () {
        var ix = listeners.indexOf(fn);
        if (ix !== -1) listeners.splice(ix, 1);
      };
    },
    status: function () {
      return currentStatus;
    },
    // Test hooks (not part of the runtime contract).
    _attempts: function () { return attempts; }
  };
}

module.exports = {
  BUS_NAME: BUS_NAME,
  OBJECT_PATH: OBJECT_PATH,
  SIGNAL_NAME: SIGNAL_NAME,
  parseFocusLine: parseFocusLine,
  parseNameHasOwner: parseNameHasOwner,
  createFocusSource: createFocusSource
};
