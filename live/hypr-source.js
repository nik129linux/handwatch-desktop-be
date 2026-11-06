'use strict';

var path = require('path');
var os = require('os');

var DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000];

function defaultBackoffMs(attempt) {
  if (attempt < 1) attempt = 1;
  if (attempt > DEFAULT_BACKOFF.length) return DEFAULT_BACKOFF[DEFAULT_BACKOFF.length - 1];
  return DEFAULT_BACKOFF[attempt - 1];
}

function isHyprland(env) {
  return !!(env && typeof env.HYPRLAND_INSTANCE_SIGNATURE === 'string' && env.HYPRLAND_INSTANCE_SIGNATURE.length > 0);
}

function socketPath(env) {
  env = env || {};
  var runtime = env.XDG_RUNTIME_DIR;
  var sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  return runtime + '/hypr/' + sig + '/.socket2.sock';
}

function prettyName(cls) {
  if (typeof cls !== 'string' || !cls) return '';
  var parts = cls.split('.');
  var base = parts[parts.length - 1] || '';
  var s = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseHyprEvent(line) {
  if (typeof line !== 'string') return null;
  var s = line;
  if (s.length && s.charAt(s.length - 1) === '\r') s = s.slice(0, -1);
  var prefix = 'activewindow>>';
  if (s.slice(0, prefix.length) !== prefix) return null;
  var rest = s.slice(prefix.length);
  var idx = rest.indexOf(',');
  if (idx === -1) return null;
  var cls = rest.slice(0, idx);
  var title = rest.slice(idx + 1);
  if (!cls) return null;
  return { appId: cls.toLowerCase(), appName: prettyName(cls), title: title };
}

function idleConf(stateFile, sec) {
  // Inhibitors (a video playing) must not hide that nobody is at the keyboard:
  // LIVE.md documents that a video playing while you are gone counts as away.
  return 'general {\n' +
    '    ignore_dbus_inhibit = true\n' +
    '}\n' +
    'listener {\n' +
    '    timeout = ' + sec + '\n' +
    '    on-timeout = printf idle > ' + stateFile + '\n' +
    '    on-resume = printf active > ' + stateFile + '\n' +
    '}\n';
}

function defaultExecFile(cmd, args) {
  var execFile = require('child_process').execFile;
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, function (err, stdout, stderr) {
      if (err) reject(err);
      else resolve({ stdout: stdout });
    });
  });
}

function defaultSpawn(cmd, args) {
  // stdio ignored: an unread pipe fills up and freezes hypridle after a few hours.
  return require('child_process').spawn(cmd, args, { stdio: 'ignore' });
}

function createHyprSources(opts) {
  opts = opts || {};
  var env = opts.env || process.env;
  var net = opts.net || require('net');
  var execFile = opts.execFile || defaultExecFile;
  var spawn = opts.spawn || defaultSpawn;
  var fsImpl = opts.fs || require('fs');
  var timer = opts.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval };
  var clock = opts.clock || Date;
  var backoffMs = opts.backoffMs || defaultBackoffMs;
  var confDir = opts.confDir || path.join(os.tmpdir(), 'retoma-hypridle');
  var idleTimeoutSec = (typeof opts.idleTimeoutSec === 'number') ? opts.idleTimeoutSec : 60;
  var pollMs = (typeof opts.pollMs === 'number') ? opts.pollMs : 5000;

  // ---- focus ----
  var focusListeners = [];
  var sock = null;
  var focusBuf = '';
  var focusRetryId = null;
  var focusStarted = false;
  var focusStatus = 'error';
  var focusAttempts = 0;

  function emitFocus(f) {
    focusListeners.slice().forEach(function (fn) {
      try { fn(f); } catch (e) { /* listener bugs must not kill the stream */ }
    });
  }

  function setFocusStatus(s) { focusStatus = s; }

  function scheduleFocusRetry() {
    if (!focusStarted) return;
    focusAttempts++;
    var ms = (typeof backoffMs === 'function') ? backoffMs(focusAttempts) : backoffMs;
    if (focusRetryId) timer.clearTimeout(focusRetryId);
    focusRetryId = timer.setTimeout(function () {
      focusRetryId = null;
      if (!focusStarted) return;
      connectFocus();
    }, ms);
  }

  function fetchInitial() {
    var p;
    try {
      p = execFile('hyprctl', ['activewindow', '-j']);
    } catch (e) {
      return;
    }
    Promise.resolve(p).then(function (res) {
      var out = res && res.stdout != null ? String(res.stdout) : '';
      var obj;
      try { obj = JSON.parse(out); } catch (e) { return; }
      var cls = (obj && typeof obj.class === 'string') ? obj.class : '';
      if (!cls) return;
      var title = (obj && typeof obj.title === 'string') ? obj.title : '';
      emitFocus({ appId: cls.toLowerCase(), appName: prettyName(cls), title: title });
    }).catch(function () { /* hyprctl failure is harmless */ });
  }

  function connectFocus() {
    if (!focusStarted) return;
    focusBuf = '';
    var s;
    try {
      s = net.createConnection(socketPath(env));
    } catch (e) {
      setFocusStatus('error');
      scheduleFocusRetry();
      return;
    }
    sock = s;
    if (s.setEncoding) { try { s.setEncoding('utf8'); } catch (e) {} }
    var dead = false;
    function onDeath() {
      if (dead) return;
      dead = true;
      if (sock === s) sock = null;
      if (!focusStarted) return;
      setFocusStatus('error');
      scheduleFocusRetry();
    }
    if (s.on) {
      s.on('data', function (chunk) {
        focusBuf += String(chunk);
        var lines = focusBuf.split('\n');
        focusBuf = lines.pop();
        lines.forEach(function (line) {
          var parsed = parseHyprEvent(line);
          if (parsed) {
            focusAttempts = 0;
            setFocusStatus('ready');
            emitFocus(parsed);
          }
        });
      });
      s.on('connect', function () {
        setFocusStatus('ready');
      });
      s.on('close', onDeath);
      s.on('error', onDeath);
    } else {
      setFocusStatus('ready');
    }
  }

  function focusStart() {
    if (!focusStarted) {
      focusStarted = true;
      focusAttempts = 0;
      connectFocus();
      fetchInitial();
    }
  }

  function focusStop() {
    focusStarted = false;
    if (focusRetryId) {
      try { timer.clearTimeout(focusRetryId); } catch (e) {}
      focusRetryId = null;
    }
    if (sock) {
      var s = sock;
      sock = null;
      try { s.destroy(); } catch (e) {}
    }
    setFocusStatus('error');
  }

  var focus = {
    start: focusStart,
    stop: focusStop,
    onFocus: function (fn) {
      focusListeners.push(fn);
      return function () {
        var ix = focusListeners.indexOf(fn);
        if (ix !== -1) focusListeners.splice(ix, 1);
      };
    },
    status: function () { return focusStatus; }
  };

  // ---- idle ----
  var idleListeners = [];
  var idleStarted = false;
  var idleChild = null;
  var idlePollId = null;
  var idleRunning = false;
  var idleStateFile = null;
  var firstIdleAt = null;

  function emitIdle(ms) {
    idleListeners.slice().forEach(function (fn) {
      try { fn(ms); } catch (e) { /* listener bugs must not kill the stream */ }
    });
  }

  function pollOnce() {
    if (!idleStarted) return;
    var content = null;
    var isIdle = false;
    try {
      content = fsImpl.readFileSync(idleStateFile, 'utf8');
      isIdle = (String(content).trim() === 'idle');
    } catch (e) {
      isIdle = false;
    }
    if (!isIdle) {
      firstIdleAt = null;
      emitIdle(0);
    } else {
      var now = clock.now();
      if (firstIdleAt == null) firstIdleAt = now;
      emitIdle(idleTimeoutSec * 1000 + (now - firstIdleAt));
    }
  }

  function idleStart() {
    if (idleStarted) return;
    idleStarted = true;
    firstIdleAt = null;
    var confFile = path.join(confDir, 'retoma-hypridle.conf');
    idleStateFile = path.join(confDir, 'retoma-hypridle.state');
    var conf = idleConf(idleStateFile, idleTimeoutSec);
    try { fsImpl.mkdirSync(confDir, { recursive: true }); } catch (e) {}
    try {
      fsImpl.writeFileSync(confFile, conf);
    } catch (e) {}
    var child;
    try {
      child = spawn('hypridle', ['-c', confFile]);
    } catch (e) {
      idleRunning = false;
      return;
    }
    idleChild = child;
    idleRunning = true;
    if (child && child.on) {
      child.on('error', function () { idleRunning = false; });
      child.on('close', function () { idleRunning = false; });
    }
    try {
      idlePollId = timer.setInterval(pollOnce, pollMs);
    } catch (e) {
      idlePollId = null;
    }
  }

  function idleStop() {
    idleStarted = false;
    idleRunning = false;
    firstIdleAt = null;
    if (idlePollId) {
      try { timer.clearInterval(idlePollId); } catch (e) {}
      idlePollId = null;
    }
    if (idleChild) {
      var c = idleChild;
      idleChild = null;
      try { c.kill(); } catch (e) {}
    }
  }

  var idle = {
    start: idleStart,
    stop: idleStop,
    onIdle: function (fn) {
      idleListeners.push(fn);
      return function () {
        var ix = idleListeners.indexOf(fn);
        if (ix !== -1) idleListeners.splice(ix, 1);
      };
    },
    isRunning: function () { return idleRunning; }
  };

  return { focus: focus, idle: idle };
}

module.exports = {
  isHyprland: isHyprland,
  socketPath: socketPath,
  prettyName: prettyName,
  parseHyprEvent: parseHyprEvent,
  idleConf: idleConf,
  createHyprSources: createHyprSources
};
