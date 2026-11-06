/* tests/win-live.test.js — Windows live source (PowerShell probe).
 * Contract for live/win-source.js. No Windows needed: spawn and timers are
 * injected, the probe's stdout is fed by hand.
 * Run with: node tests/win-live.test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var win = require(path.join(ROOT, 'live', 'win-source'));
var installer = require(path.join(ROOT, 'live', 'installer'));

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () { passed++; console.log('  ok ' + name); })
    .catch(function (e) {
      failed++;
      failures.push(name + ': ' + (e && e.message));
      console.log('  FAIL ' + name);
      console.log('       ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n       ') : e));
    });
}

function tick(ms) { return new Promise(function (res) { setTimeout(res, ms || 0); }); }

function fakeTimer() {
  var queue = [];
  return {
    setTimeout: function (fn, ms) { queue.push({fn: fn, ms: ms}); return queue.length; },
    clearTimeout: function (id) { if (queue[id - 1]) queue[id - 1].fn = null; },
    runNext: function () {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].fn) { var f = queue[i].fn; queue[i].fn = null; f(); return true; }
      }
      return false;
    },
    pending: function () { return queue.filter(function (q) { return q.fn; }).length; }
  };
}

function fakeChild() {
  var handlers = {};
  var stdout = {};
  var child = {
    killed: false,
    stdout: {on: function (ev, fn) { stdout[ev] = fn; }},
    on: function (ev, fn) { handlers[ev] = fn; },
    kill: function () { child.killed = true; },
    _die: function () { if (handlers.close) handlers.close(1); },
    _error: function () { if (handlers.error) handlers.error(new Error('ENOENT')); },
    _data: function (s) { if (stdout.data) stdout.data(Buffer.from(s)); }
  };
  return child;
}

function focusLine(exe, name, title) {
  return JSON.stringify({t: 'focus', exe: exe, name: name, title: title}) + '\r\n';
}

async function main() {
  console.log('win-live: parser');

  await test('parseWinLine: focus line -> {type, appId, appName, title}', function () {
    var r = win.parseWinLine('{"t":"focus","exe":"WINWORD","name":"Microsoft Word","title":"Report.docx - Word"}');
    assert.deepStrictEqual(r, {type: 'focus', appId: 'winword', appName: 'Microsoft Word', title: 'Report.docx - Word'});
  });

  await test('parseWinLine: empty product name falls back to the exe name', function () {
    var r = win.parseWinLine('{"t":"focus","exe":"Code","name":"","title":"main.js"}');
    assert.strictEqual(r.appName, 'Code');
    assert.strictEqual(r.appId, 'code');
  });

  await test('parseWinLine: idle line -> {type:"idle", ms}', function () {
    assert.deepStrictEqual(win.parseWinLine('{"t":"idle","ms":61000}'), {type: 'idle', ms: 61000});
  });

  await test('parseWinLine: CRLF, BOM and surrounding spaces are tolerated', function () {
    var r = win.parseWinLine('﻿  {"t":"idle","ms":5}\r');
    assert.deepStrictEqual(r, {type: 'idle', ms: 5});
  });

  await test('parseWinLine: garbage, empty, wrong types and negative idle -> null, never throws', function () {
    ['', 'hello', '{', '{"t":"focus"}', '{"t":"idle","ms":-4}', '{"t":"idle","ms":"x"}',
      '{"t":"other"}', 'null', '[]', '{"t":"focus","exe":42,"name":"a","title":"b"}'
    ].forEach(function (s) {
      assert.strictEqual(win.parseWinLine(s), null, 'expected null for ' + JSON.stringify(s));
    });
  });

  await test('parseWinLine: unicode titles survive', function () {
    var r = win.parseWinLine(JSON.stringify({t: 'focus', exe: 'chrome', name: 'Google Chrome', title: 'Cálculo — café ☕'}));
    assert.strictEqual(r.title, 'Cálculo — café ☕');
  });

  console.log('win-live: probe script');

  await test('PS_SCRIPT uses Win32 foreground + idle APIs and prints one JSON object per line', function () {
    var s = win.PS_SCRIPT;
    assert.ok(typeof s === 'string' && s.length > 200);
    ['GetForegroundWindow', 'GetWindowText', 'GetWindowThreadProcessId', 'GetLastInputInfo'].forEach(function (api) {
      assert.ok(s.indexOf(api) !== -1, 'missing ' + api);
    });
    assert.ok(/ConvertTo-Json\s+-Compress/i.test(s), 'must emit compact JSON lines');
    assert.ok(/Start-Sleep/i.test(s), 'must poll in a loop');
  });

  await test('PS_SCRIPT never touches keystrokes, screen pixels, clipboard, camera or mic', function () {
    var bad = /GetAsyncKeyState|SetWindowsHookEx|GetKeyboardState|CopyFromScreen|BitBlt|Get-Clipboard|Clipboard|webcam|Microphone/i;
    assert.ok(!bad.test(win.PS_SCRIPT), 'probe reaches beyond app name + title + idle');
  });

  await test('psArgs: hidden, no profile, bypass, script passed as -EncodedCommand (UTF-16LE base64)', function () {
    var a = win.psArgs();
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'].forEach(function (flag) {
      assert.ok(a.indexOf(flag) !== -1, 'missing ' + flag);
    });
    var enc = a[a.indexOf('-EncodedCommand') + 1];
    assert.strictEqual(Buffer.from(enc, 'base64').toString('utf16le'), win.PS_SCRIPT);
  });

  console.log('win-live: sources');

  await test('one powershell child feeds both focus and idle; status ready after first valid line', async function () {
    var child = fakeChild();
    var spawned = [];
    var src = win.createWinSources({
      spawn: function (cmd, args) { spawned.push({cmd: cmd, args: args}); return child; },
      timer: fakeTimer(),
      backoffMs: function () { return 0; }
    });
    var foci = [];
    var idles = [];
    src.focus.onFocus(function (f) { foci.push(f); });
    src.idle.onIdle(function (ms) { idles.push(ms); });
    src.focus.start();
    src.idle.start();
    await tick(5);
    assert.strictEqual(spawned.length, 1, 'focus.start + idle.start must share one child');
    assert.ok(/powershell(\.exe)?$/i.test(spawned[0].cmd));
    assert.notStrictEqual(src.focus.status(), 'ready', 'not ready before any output');
    child._data(focusLine('WINWORD', 'Microsoft Word', 'Report.docx - Word'));
    child._data('{"t":"idle","ms":120');
    child._data('00}\r\n');
    await tick(5);
    assert.strictEqual(src.focus.status(), 'ready');
    assert.deepStrictEqual(foci, [{appId: 'winword', appName: 'Microsoft Word', title: 'Report.docx - Word'}]);
    assert.deepStrictEqual(idles, [12000]);
    assert.strictEqual(src.idle.isRunning(), true);
    src.focus.stop();
    src.idle.stop();
    assert.strictEqual(child.killed, true, 'stopping both kills the child');
  });

  await test('focus event shape matches the GNOME source (live-manager needs no changes)', async function () {
    var child = fakeChild();
    var src = win.createWinSources({spawn: function () { return child; }, timer: fakeTimer(), backoffMs: function () { return 0; }});
    var got = [];
    src.focus.onFocus(function (f) { got.push(f); });
    src.focus.start();
    child._data(focusLine('chrome', 'Google Chrome', 'Brightspace'));
    await tick(5);
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['appId', 'appName', 'title']);
    src.focus.stop();
  });

  await test('child dies -> status error -> retries with backoff -> recovers', async function () {
    var children = [fakeChild(), fakeChild()];
    var n = 0;
    var timer = fakeTimer();
    var src = win.createWinSources({spawn: function () { return children[n++]; }, timer: timer, backoffMs: function (a) { return a * 500; }});
    src.focus.start();
    children[0]._data(focusLine('a', 'A', 't'));
    await tick(5);
    assert.strictEqual(src.focus.status(), 'ready');
    children[0]._die();
    await tick(5);
    assert.strictEqual(src.focus.status(), 'error');
    assert.ok(timer.runNext(), 'a retry was scheduled');
    await tick(5);
    assert.strictEqual(n, 2);
    children[1]._data(focusLine('b', 'B', 't'));
    await tick(5);
    assert.strictEqual(src.focus.status(), 'ready');
    src.focus.stop();
  });

  await test('spawn throwing (no powershell) -> status error, no crash, retry scheduled', async function () {
    var timer = fakeTimer();
    var src = win.createWinSources({spawn: function () { throw new Error('ENOENT'); }, timer: timer, backoffMs: function () { return 0; }});
    src.focus.start();
    await tick(5);
    assert.strictEqual(src.focus.status(), 'error');
    assert.ok(timer.pending() >= 1);
    src.focus.stop();
    assert.strictEqual(timer.pending(), 0, 'stop clears the retry');
  });

  await test('a throwing listener does not kill the stream', async function () {
    var child = fakeChild();
    var src = win.createWinSources({spawn: function () { return child; }, timer: fakeTimer(), backoffMs: function () { return 0; }});
    var got = [];
    src.focus.onFocus(function () { throw new Error('boom'); });
    src.focus.onFocus(function (f) { got.push(f.appId); });
    src.focus.start();
    child._data(focusLine('a', 'A', '1') + focusLine('b', 'B', '2'));
    await tick(5);
    assert.deepStrictEqual(got, ['a', 'b']);
    src.focus.stop();
  });

  console.log('win-live: wiring');

  await test('installer.needsHelper: linux needs the GNOME helper, win32 does not', function () {
    assert.strictEqual(installer.needsHelper('linux'), true);
    assert.strictEqual(installer.needsHelper('win32'), false);
  });

  await test('main.js picks win-source on win32 and the GNOME sources elsewhere', function () {
    var src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/require\(['"]\.\/live\/win-source['"]\)/.test(src), 'main.js must require ./live/win-source');
    assert.ok(/process\.platform\s*===\s*['"]win32['"]/.test(src), 'main.js must branch on win32');
  });

  await test('package.json: Windows NSIS target, png icon, dist:win script', function () {
    var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['dist:win'], 'missing dist:win script');
    var w = pkg.build && pkg.build.win;
    assert.ok(w, 'missing build.win');
    var targets = JSON.stringify(w.target);
    assert.ok(/nsis/.test(targets), 'win target must include nsis');
    assert.ok(/\.(png|ico)$/.test(w.icon), 'Windows icon must be png or ico, not svg');
    assert.ok(fs.existsSync(path.join(ROOT, w.icon)), 'icon file must exist: ' + w.icon);
    assert.ok(pkg.build.files.indexOf('live/') !== -1 || pkg.build.files.some(function (f) { return /^live/.test(f); }),
      'live/ must be packaged or the .exe crashes on require');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch(function (e) { console.error(e); process.exit(1); });
