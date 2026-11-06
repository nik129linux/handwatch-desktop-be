/* tests/hypr-live.test.js — Live tracking on Hyprland (Wayland), no GNOME helper.
 * Contract for live/hypr-source.js:
 *   isHyprland(env)            true when env.HYPRLAND_INSTANCE_SIGNATURE is a non-empty string
 *   socketPath(env)            `${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket2.sock`
 *   prettyName(cls)            'org.gnome.Nautilus' -> 'Nautilus', 'brave-browser' -> 'Brave browser', 'kitty' -> 'Kitty'
 *   parseHyprEvent(line)       'activewindow>>CLASS,TITLE' -> { appId: class lowercased, appName: prettyName(class), title }
 *                              (title may contain commas: split on the FIRST comma); empty class or any other event -> null
 *   idleConf(stateFile, sec)   hypridle config text: one listener, timeout = sec,
 *                              on-timeout = printf idle > stateFile, on-resume = printf active > stateFile
 *   createHyprSources({ env, net, execFile, spawn, fs, timer, clock, backoffMs, confDir, idleTimeoutSec, pollMs })
 *     -> { focus: { start, stop, onFocus, status }, idle: { start, stop, onIdle, isRunning } }
 *     focus: connects net.createConnection(socketPath) and reads lines; emits the current window first via
 *            execFile('hyprctl', ['activewindow', '-j']); status 'ready' once connected; on close -> 'error' + retry.
 *     idle:  writes idleConf to <confDir>/retoma-hypridle.conf, spawns 'hypridle' ['-c', conf], polls the state file
 *            every pollMs; 'active' or no file -> onIdle(0); 'idle' -> onIdle(idleTimeoutSec*1000 + time since first
 *            seen idle). Missing hypridle (spawn throws or child errors) -> isRunning() false, no crash.
 *            stop() kills the hypridle child.
 *   installer.needsHelper(platform, env): false on win32 and on Hyprland; true on other Linux. env defaults to {}.
 * Run with: node tests/hypr-live.test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var EventEmitter = require('events');

var ROOT = path.resolve(__dirname, '..');
var hypr = require(path.join(ROOT, 'live', 'hypr-source'));
var installer = require(path.join(ROOT, 'live', 'installer'));

var passed = 0;
var failed = 0;
var failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(function () { passed++; console.log('  ok ' + name); })
    .catch(function (e) {
      failed++; failures.push(name + ': ' + (e && e.message));
      console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join('\n       ') : e));
    });
}
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

var ENV = { HYPRLAND_INSTANCE_SIGNATURE: 'abc_123', XDG_RUNTIME_DIR: '/run/user/1000' };

function fakeTimer() {
  var q = [];
  var iv = [];
  return {
    setTimeout: function (fn, ms) { q.push({ fn: fn, ms: ms }); return q.length; },
    clearTimeout: function (id) { if (q[id - 1]) q[id - 1].fn = null; },
    setInterval: function (fn, ms) { iv.push({ fn: fn, ms: ms }); return 1000 + iv.length; },
    clearInterval: function (id) { if (iv[id - 1001]) iv[id - 1001].fn = null; },
    runNext: function () { for (var i = 0; i < q.length; i++) if (q[i].fn) { var f = q[i].fn; q[i].fn = null; f(); return true; } return false; },
    pending: function () { return q.filter(function (x) { return x.fn; }).length; },
    fireIntervals: function () { iv.forEach(function (x) { if (x.fn) x.fn(); }); },
    intervals: function () { return iv.filter(function (x) { return x.fn; }).length; }
  };
}
function fakeSocket() {
  var s = new EventEmitter();
  s.setEncoding = function () {};
  s.destroyed = false;
  s.destroy = function () { s.destroyed = true; };
  s.end = s.destroy;
  return s;
}
function fakeNet(sockets, calls) {
  return { createConnection: function (p) { calls.push(p); var s = sockets.shift(); setTimeout(function () { s.emit('connect'); }, 0); return s; } };
}
function hyprctlOk(json) {
  return function (cmd, args) {
    assert.strictEqual(cmd, 'hyprctl');
    assert.deepStrictEqual(args, ['activewindow', '-j']);
    return Promise.resolve({ stdout: JSON.stringify(json) });
  };
}
function memFs(files) {
  return {
    files: files,
    writeFileSync: function (p, data) { files[p] = String(data); },
    readFileSync: function (p) { if (!(p in files)) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[p]; },
    existsSync: function (p) { return p in files; },
    mkdirSync: function () {}
  };
}
function fakeChild() {
  var c = new EventEmitter();
  c.killed = false;
  c.kill = function () { c.killed = true; };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

async function main() {
  console.log('hypr-live: detection + parsing');

  await test('isHyprland / socketPath', function () {
    assert.strictEqual(hypr.isHyprland(ENV), true);
    assert.strictEqual(hypr.isHyprland({}), false);
    assert.strictEqual(hypr.isHyprland({ HYPRLAND_INSTANCE_SIGNATURE: '' }), false);
    assert.strictEqual(hypr.socketPath(ENV), '/run/user/1000/hypr/abc_123/.socket2.sock');
  });

  await test('prettyName', function () {
    assert.strictEqual(hypr.prettyName('org.gnome.Nautilus'), 'Nautilus');
    assert.strictEqual(hypr.prettyName('brave-browser'), 'Brave browser');
    assert.strictEqual(hypr.prettyName('kitty'), 'Kitty');
    assert.strictEqual(hypr.prettyName('code_oss'), 'Code oss');
    assert.strictEqual(hypr.prettyName(''), '');
  });

  await test('parseHyprEvent: activewindow, commas in title, junk', function () {
    assert.deepStrictEqual(hypr.parseHyprEvent('activewindow>>kitty,fedora: ~'),
      { appId: 'kitty', appName: 'Kitty', title: 'fedora: ~' });
    assert.deepStrictEqual(hypr.parseHyprEvent('activewindow>>brave-browser,Inbox, 3 unread - Brave'),
      { appId: 'brave-browser', appName: 'Brave browser', title: 'Inbox, 3 unread - Brave' });
    assert.strictEqual(hypr.parseHyprEvent('activewindow>>,'), null);
    assert.strictEqual(hypr.parseHyprEvent('workspace>>2'), null);
    assert.strictEqual(hypr.parseHyprEvent('activewindowv2>>0x55'), null);
    assert.strictEqual(hypr.parseHyprEvent(''), null);
    assert.strictEqual(hypr.parseHyprEvent(null), null);
  });

  await test('idleConf: one listener writing idle/active to the state file', function () {
    var c = hypr.idleConf('/tmp/x/state', 60);
    assert.ok(/listener\s*\{[^}]*timeout\s*=\s*60\b/.test(c), c);
    assert.ok(/on-timeout\s*=\s*printf idle > \/tmp\/x\/state/.test(c), c);
    assert.ok(/on-resume\s*=\s*printf active > \/tmp\/x\/state/.test(c), c);
    assert.strictEqual((c.match(/listener/g) || []).length, 1);
    assert.ok(!/lock|dpms|brightness|suspend/i.test(c), 'never locks, dims or suspends anything');
  });

  console.log('hypr-live: focus');

  await test('focus: initial window from hyprctl, then socket events; status ready', async function () {
    var calls = [];
    var sock = fakeSocket();
    var src = hypr.createHyprSources({
      env: ENV, net: fakeNet([sock], calls), timer: fakeTimer(), backoffMs: function () { return 0; },
      execFile: hyprctlOk({ class: 'kitty', title: 'fedora: ~' }), spawn: function () { return fakeChild(); },
      fs: memFs({}), confDir: '/tmp/r'
    });
    var got = [];
    src.focus.onFocus(function (f) { got.push(f); });
    src.focus.start();
    await tick(10);
    assert.deepStrictEqual(calls, ['/run/user/1000/hypr/abc_123/.socket2.sock']);
    assert.strictEqual(src.focus.status(), 'ready');
    sock.emit('data', 'workspace>>2\nactivewindow>>brave-browser,Brightspace - Br');
    sock.emit('data', 'ave\nactivewindow>>kitty,vim notes.md\n');
    await tick(5);
    assert.deepStrictEqual(got, [
      { appId: 'kitty', appName: 'Kitty', title: 'fedora: ~' },
      { appId: 'brave-browser', appName: 'Brave browser', title: 'Brightspace - Brave' },
      { appId: 'kitty', appName: 'Kitty', title: 'vim notes.md' }
    ]);
    src.focus.stop();
    assert.strictEqual(sock.destroyed, true, 'stop closes the socket');
  });

  await test('focus: socket closes -> error -> retry reconnects', async function () {
    var calls = [];
    var s1 = fakeSocket();
    var s2 = fakeSocket();
    var timer = fakeTimer();
    var src = hypr.createHyprSources({
      env: ENV, net: fakeNet([s1, s2], calls), timer: timer, backoffMs: function () { return 0; },
      execFile: hyprctlOk({}), spawn: function () { return fakeChild(); }, fs: memFs({}), confDir: '/tmp/r'
    });
    src.focus.start();
    await tick(10);
    s1.emit('close');
    await tick(5);
    assert.strictEqual(src.focus.status(), 'error');
    assert.ok(timer.runNext(), 'retry scheduled');
    await tick(10);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(src.focus.status(), 'ready');
    src.focus.stop();
    assert.strictEqual(timer.pending(), 0);
  });

  await test('focus: a throwing listener does not kill the stream; hyprctl failure is harmless', async function () {
    var sock = fakeSocket();
    var src = hypr.createHyprSources({
      env: ENV, net: fakeNet([sock], []), timer: fakeTimer(), backoffMs: function () { return 0; },
      execFile: function () { return Promise.reject(new Error('no hyprctl')); }, spawn: function () { return fakeChild(); },
      fs: memFs({}), confDir: '/tmp/r'
    });
    var got = [];
    src.focus.onFocus(function () { throw new Error('boom'); });
    src.focus.onFocus(function (f) { got.push(f.appId); });
    src.focus.start();
    await tick(10);
    sock.emit('data', 'activewindow>>a,1\nactivewindow>>b,2\n');
    await tick(5);
    assert.deepStrictEqual(got, ['a', 'b']);
    src.focus.stop();
  });

  console.log('hypr-live: idle');

  await test('idle: spawns hypridle with its own config, maps the state file to idle ms', async function () {
    var spawned = [];
    var child = fakeChild();
    var files = {};
    var t = 0;
    var timer = fakeTimer();
    var src = hypr.createHyprSources({
      env: ENV, net: fakeNet([fakeSocket()], []), timer: timer, backoffMs: function () { return 0; },
      execFile: hyprctlOk({}), fs: memFs(files), confDir: '/tmp/r', idleTimeoutSec: 60, pollMs: 2000,
      clock: { now: function () { return t; } },
      spawn: function (cmd, args) { spawned.push([cmd, args]); return child; }
    });
    var idles = [];
    src.idle.onIdle(function (ms) { idles.push(ms); });
    src.idle.start();
    await tick(5);
    assert.deepStrictEqual(spawned, [['hypridle', ['-c', '/tmp/r/retoma-hypridle.conf']]]);
    var conf = files['/tmp/r/retoma-hypridle.conf'];
    assert.ok(conf && /timeout\s*=\s*60\b/.test(conf), 'config written');
    var stateFile = /on-timeout\s*=\s*printf idle > (\S+)/.exec(conf)[1];
    assert.strictEqual(src.idle.isRunning(), true);
    timer.fireIntervals();
    assert.deepStrictEqual(idles, [0], 'no state file yet -> active');
    files[stateFile] = 'idle';
    t = 1000;
    timer.fireIntervals();
    t = 31000;
    timer.fireIntervals();
    files[stateFile] = 'active';
    timer.fireIntervals();
    assert.deepStrictEqual(idles, [0, 60000, 90000, 0]);
    src.idle.stop();
    assert.strictEqual(child.killed, true, 'stop kills hypridle');
    assert.strictEqual(timer.intervals(), 0, 'stop clears the poll');
  });

  await test('idle: hypridle missing -> not running, no crash', async function () {
    var src = hypr.createHyprSources({
      env: ENV, net: fakeNet([fakeSocket()], []), timer: fakeTimer(), backoffMs: function () { return 0; },
      execFile: hyprctlOk({}), fs: memFs({}), confDir: '/tmp/r',
      spawn: function () { throw new Error('ENOENT'); }
    });
    src.idle.start();
    await tick(5);
    assert.strictEqual(src.idle.isRunning(), false);
    src.idle.stop();
  });

  console.log('hypr-live: wiring');

  await test('installer.needsHelper(platform, env)', function () {
    assert.strictEqual(installer.needsHelper('win32'), false);
    assert.strictEqual(installer.needsHelper('linux'), true);
    assert.strictEqual(installer.needsHelper('linux', {}), true);
    assert.strictEqual(installer.needsHelper('linux', ENV), false);
  });

  await test('main.js picks hypr-source on Hyprland and passes env to needsHelper', function () {
    var src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/require\(['"]\.\/live\/hypr-source['"]\)/.test(src), 'main.js requires ./live/hypr-source');
    assert.ok(/isHyprland\(process\.env\)/.test(src), 'main.js branches on isHyprland(process.env)');
    assert.ok(/needsHelper\(process\.platform,\s*process\.env\)/.test(src), 'helper check passes process.env');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) { console.log('failures:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch(function (e) { console.error(e); process.exit(1); });
