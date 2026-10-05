/* tests/live.test.js — L1 live core unit tests. No display, no D-Bus.
 * Run with: node tests/live.test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var focusSource = require(path.join(ROOT, 'live', 'focus-source'));
var idleSource = require(path.join(ROOT, 'live', 'idle-source'));
var liveTracker = require(path.join(ROOT, 'live', 'live-tracker'));

var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      passed++;
      console.log('  ok ' + name);
    })
    .catch(function (e) {
      failed++;
      failures.push(name + ': ' + (e && e.message));
      console.log('  FAIL ' + name);
      console.log('       ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n       ') : e));
    });
}

function tick(ms) {
  return new Promise(function (res) { setTimeout(res, ms || 0); });
}

function fakeClock() {
  var t = 0;
  return {
    now: function () { return t; },
    advance: function (ms) { t += ms; }
  };
}

function makeTracker(settings, clock) {
  var events = [];
  var tracker = liveTracker.createLiveTracker({
    emit: function (evt) { events.push(evt); },
    clock: clock,
    settings: settings
  });
  return {tracker: tracker, events: events, clock: clock};
}

// onFocus + wait out the blip window + commit, in one step.
function focusStable(h, raw, dwellMs) {
  h.tracker.onFocus(raw);
  h.clock.advance(dwellMs === undefined ? 3100 : dwellMs);
  h.tracker.tick();
}

function F(appId, appName, title) {
  return {appId: appId, appName: appName, title: title};
}

async function main() {
  console.log('live: parser');

  await test('parser: standard FocusChanged line', function () {
    var f = focusSource.parseFocusLine(
      "/org/retoma/Focus: org.retoma.Focus.FocusChanged ('org.firefox', 'Firefox', 'Home page')");
    assert.deepStrictEqual(f, {appId: 'org.firefox', appName: 'Firefox', title: 'Home page'});
  });

  await test('parser: line with bus sender prefix', function () {
    var f = focusSource.parseFocusLine(
      ":1.234 /org/retoma/Focus: org.retoma.Focus.FocusChanged ('org.gnome.Nautilus', 'Files', 'Home')");
    assert.deepStrictEqual(f, {appId: 'org.gnome.Nautilus', appName: 'Files', title: 'Home'});
  });

  await test('parser: escaped single quote in title', function () {
    var f = focusSource.parseFocusLine(
      "org.retoma.Focus.FocusChanged ('code', 'VS Code', 'it\\'s alive')");
    assert.strictEqual(f.title, "it's alive");
  });

  await test('parser: escaped backslashes (Windows path)', function () {
    var f = focusSource.parseFocusLine(
      "FocusChanged ('a', 'b', 'C:\\\\Users\\\\nico')");
    assert.strictEqual(f.title, 'C:\\Users\\nico');
  });

  await test('parser: unicode escapes decoded', function () {
    var f = focusSource.parseFocusLine(
      "FocusChanged ('chat', 'Chat', 'caf\\u00e9 \\u2615 break')");
    assert.strictEqual(f.title, 'café ☕ break');
  });

  await test('parser: literal unicode passes through', function () {
    var f = focusSource.parseFocusLine(
      "FocusChanged ('chat', 'Chat', '日本語タイトル 🎉')");
    assert.strictEqual(f.title, '日本語タイトル 🎉');
  });

  await test('parser: empty title', function () {
    var f = focusSource.parseFocusLine("FocusChanged ('a', 'Desktop', '')");
    assert.deepStrictEqual(f, {appId: 'a', appName: 'Desktop', title: ''});
  });

  await test('parser: very long title (2000 chars)', function () {
    var long = new Array(2001).join('x');
    var f = focusSource.parseFocusLine("FocusChanged ('a', 'b', '" + long + "')");
    assert.strictEqual(f.title.length, 2000);
  });

  await test('parser: double-quoted strings', function () {
    var f = focusSource.parseFocusLine('FocusChanged ("a", "b", "c d")');
    assert.deepStrictEqual(f, {appId: 'a', appName: 'b', title: 'c d'});
  });

  await test('parser: commas inside strings do not split', function () {
    var f = focusSource.parseFocusLine("FocusChanged ('a,b', 'N, x', 't, u, v')");
    assert.deepStrictEqual(f, {appId: 'a,b', appName: 'N, x', title: 't, u, v'});
  });

  await test('parser: garbage lines return null, never throw', function () {
    var garbage = [
      'hello world',
      '',
      '   ',
      'FocusChanged (',
      "FocusChanged ('only', 'two')",
      "FocusChanged ('a', 'b'",
      'org.retoma.Focus.SomethingElse (1, 2, 3)',
      'signal time=1234 sender=:1.5',
      null,
      undefined,
      42
    ];
    garbage.forEach(function (line, i) {
      assert.strictEqual(focusSource.parseFocusLine(line), null, 'garbage[' + i + '] must be null');
    });
  });

  await test('parser: method return line is not a focus event', function () {
    assert.strictEqual(focusSource.parseFocusLine("(('a', 'b', 'c'),)"), null);
  });

  console.log('live: tracker episodes + blips + self window');

  await test('tracker: focus sequence makes correct episodes and minutes', function () {
    var clock = fakeClock();
    var h = makeTracker({}, clock);
    h.tracker.onFocus(F('doc', 'Document', 'report'));
    clock.advance(10 * 60000);
    focusStable(h, F('browser', 'Browser', 'course'));
    clock.advance(12 * 60000);
    focusStable(h, F('sheet', 'Spreadsheet', 'tracker'));
    var episodes = h.events.filter(function (e) { return e.type === 'episode'; });
    assert.strictEqual(episodes.length, 2);
    assert.deepStrictEqual(episodes[0].entry, {app: 'Document', duration: 10});
    assert.deepStrictEqual(episodes[1].entry, {app: 'Browser', duration: 12});
    var switches = h.events.filter(function (e) { return e.type === 'app:switch'; });
    assert.strictEqual(switches.length, 3);
    assert.deepStrictEqual(switches.map(function (s) { return s.app.label; }), ['Document', 'Browser', 'Spreadsheet']);
  });

  await test('tracker: blip at second 4 (2 s) is merged, 4 s dwell kept', function () {
    var clock = fakeClock();
    var h = makeTracker({}, clock);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    clock.advance(60000);
    // Blip: Browser for 2 s, then back to Document.
    h.tracker.onFocus(F('browser', 'Browser', 'x'));
    clock.advance(2000);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    clock.advance(4000);
    h.tracker.tick();
    var episodes = h.events.filter(function (e) { return e.type === 'episode'; });
    assert.strictEqual(episodes.length, 0, 'no episode may close for a merged blip');
    var apps = h.events.filter(function (e) { return e.type === 'app:switch'; }).map(function (e) { return e.app.label; });
    assert.deepStrictEqual(apps, ['Document'], 'blip app never emitted, got ' + JSON.stringify(apps));
    // A 4 s dwell IS a real episode once something else takes over.
    focusStable(h, F('chat', 'Chat', 'hi'));
    clock.advance(60000);
    focusStable(h, F('doc2', 'Doc2', 'z'));
    var chatEp = h.events.filter(function (e) {
      return e.type === 'episode' && e.entry.app === 'Chat';
    });
    assert.strictEqual(chatEp.length, 1, '4 s dwell survives as its own episode');
  });

  await test('tracker: Retoma window never counts', function () {
    var clock = fakeClock();
    var h = makeTracker({}, clock);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    clock.advance(60000);
    var before = h.events.length;
    h.tracker.onFocus(F('com.retoma.desktop', 'Retoma', 'panel'));
    clock.advance(5000);
    h.tracker.tick();
    h.tracker.onFocus(F('retoma-foo', 'Retoma Helper', 'x'));
    clock.advance(5000);
    h.tracker.tick();
    assert.strictEqual(h.events.length, before, 'own window adds no events');
    assert.strictEqual(h.tracker._debug().current.app, 'Document');
  });

  await test('tracker: same-app title change is minutes, not a new episode', function () {
    var clock = fakeClock();
    var h = makeTracker({storeTitles: true}, clock);
    h.tracker.onFocus(F('doc', 'Document', 'para 1'));
    clock.advance(5 * 60000);
    var before = h.events.length;
    h.tracker.onFocus(F('doc', 'Document', 'para 2'));
    clock.advance(5 * 60000);
    h.tracker.tick();
    assert.strictEqual(h.events.length, before, 'title change emits nothing new');
    focusStable(h, F('browser', 'Browser', 'x'));
    var episodes = h.events.filter(function (e) { return e.type === 'episode'; });
    assert.strictEqual(episodes.length, 1);
    assert.deepStrictEqual(episodes[0].entry, {app: 'Document', duration: 10});
  });

  console.log('live: away / return');

  await test('tracker: idle 4:59 no away, 5:00 away, one return with app + minutes', function () {
    var clock = fakeClock();
    var h = makeTracker({awayAfterMin: 5}, clock);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    clock.advance(60000);
    h.tracker.onIdle(4 * 60000 + 59000);
    assert.strictEqual(h.events.filter(function (e) { return e.type === 'away'; }).length, 0);
    h.tracker.onIdle(5 * 60000);
    var aways = h.events.filter(function (e) { return e.type === 'away'; });
    assert.strictEqual(aways.length, 1);
    assert.strictEqual(aways[0].app, 'Document');
    clock.advance(25 * 60000);
    h.tracker.onIdle(1000);
    var returns = h.events.filter(function (e) { return e.type === 'return'; });
    assert.strictEqual(returns.length, 1, 'exactly one return');
    assert.strictEqual(returns[0].app, 'Document');
    assert.strictEqual(returns[0].awayMinutes, 25);
    h.tracker.onIdle(2000);
    h.tracker.onIdle(3000);
    assert.strictEqual(h.events.filter(function (e) { return e.type === 'return'; }).length, 1);
  });

  await test('tracker: awayAfterMin 2 and 10 honored', function () {
    [2, 10].forEach(function (mins) {
      var clock = fakeClock();
      var h = makeTracker({awayAfterMin: mins}, clock);
      h.tracker.onFocus(F('doc', 'Document', 'r'));
      h.tracker.onIdle(mins * 60000 - 1000);
      assert.strictEqual(h.events.filter(function (e) { return e.type === 'away'; }).length, 0, mins + ' min: just below');
      h.tracker.onIdle(mins * 60000);
      assert.strictEqual(h.events.filter(function (e) { return e.type === 'away'; }).length, 1, mins + ' min: at threshold');
    });
  });

  console.log('live: privacy');

  await test('tracker: titles OFF by default (no title field anywhere)', function () {
    var clock = fakeClock();
    var h = makeTracker({}, clock);
    assert.strictEqual(h.tracker.getSettings().storeTitles, false);
    focusStable(h, F('doc', 'Document', 'secret report'));
    var switches = h.events.filter(function (e) { return e.type === 'app:switch'; });
    assert.ok(switches.length >= 1);
    switches.forEach(function (s) {
      assert.strictEqual('title' in s.app, false, 'title must be dropped before emit/persist');
    });
  });

  await test('tracker: titles ON truncated to 60 chars', function () {
    var clock = fakeClock();
    var h = makeTracker({storeTitles: true}, clock);
    var long = new Array(101).join('y');
    focusStable(h, F('doc', 'Document', long));
    var s = h.events.filter(function (e) { return e.type === 'app:switch'; })[0];
    assert.strictEqual(s.app.title.length, 60);
  });

  await test('tracker: blocklisted apps never appear by name', function () {
    var clock = fakeClock();
    var h = makeTracker({storeTitles: true}, clock);
    var names = [
      F('keepassxc', 'KeePassXC', 'vault'),
      F('bitwarden', 'Bitwarden', 'vault'),
      F('org.gnome.seahorse', 'Passwords and Keys', 'k'),
      F('1password', '1Password', 'v'),
      F('polkit-agent', 'PolicyKit agent', 'auth')
    ];
    names.forEach(function (raw) {
      focusStable(h, raw);
      focusStable(h, F('doc', 'Document', 'separator'));
    });
    var dump = JSON.stringify(h.events).toLowerCase();
    ['keepassxc', 'bitwarden', 'seahorse', '1password', 'polkit'].forEach(function (w) {
      assert.strictEqual(dump.indexOf(w) !== -1, false, w + ' leaked into events');
    });
    var privates = h.events.filter(function (e) {
      return e.type === 'app:switch' && e.app.label === 'Private app';
    });
    assert.strictEqual(privates.length, names.length);
    privates.forEach(function (p) {
      assert.strictEqual('title' in p.app, false, 'private app carries no title');
    });
  });

  await test('tracker: paused records nothing', function () {
    var clock = fakeClock();
    var h = makeTracker({}, clock);
    h.tracker.setPaused(true);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    clock.advance(60000);
    h.tracker.tick();
    h.tracker.onIdle(10 * 60000);
    assert.strictEqual(h.events.length, 0);
    h.tracker.setPaused(false);
    h.tracker.onFocus(F('doc', 'Document', 'r'));
    assert.strictEqual(h.events.length, 1);
  });

  console.log('live: focus-source reconnect + idle-source');

  function fakeTimer() {
    var queue = [];
    return {
      queue: queue,
      setTimeout: function (fn, ms) {
        var id = queue.length + 1;
        queue.push({fn: fn, ms: ms, id: id, cleared: false});
        return id;
      },
      clearTimeout: function (id) {
        queue.forEach(function (item) { if (item.id === id) item.cleared = true; });
      },
      runNext: function () {
        var item = queue.find(function (q) { return !q.cleared && !q.ran; });
        if (!item) return false;
        item.ran = true;
        item.fn();
        return true;
      }
    };
  }

  function fakeChild() {
    var handlers = {};
    var stdout = {};
    return {
      stdout: {on: function (ev, fn) { stdout[ev] = fn; }},
      on: function (ev, fn) { handlers[ev] = fn; },
      kill: function () { handlers.killed = true; },
      _die: function () { if (handlers.close) handlers.close(1); },
      _data: function (s) { if (stdout.data) stdout.data(s); }
    };
  }

  await test('focus-source: dies twice then works, backoff grows, status recovers', async function () {
    var timer = fakeTimer();
    var delays = [];
    var children = [fakeChild(), fakeChild(), fakeChild()];
    var spawnCalls = 0;
    var src = focusSource.createFocusSource({
      spawn: function () { return children[spawnCalls++]; },
      execFile: function () { return Promise.resolve({stdout: '(true,)'}); },
      timer: timer,
      backoffMs: function (attempt) {
        var ms = attempt * 500;
        delays.push(ms);
        return ms;
      }
    });
    var got = [];
    src.onFocus(function (f) { got.push(f); });
    src.start();
    await tick(10);
    assert.strictEqual(src.status(), 'ready');
    assert.strictEqual(spawnCalls, 1);
    children[0]._die();
    await tick(10);
    assert.strictEqual(src.status(), 'error');
    timer.runNext(); // retry 1
    await tick(10);
    assert.strictEqual(spawnCalls, 2);
    children[1]._die();
    await tick(10);
    timer.runNext(); // retry 2
    await tick(10);
    assert.strictEqual(spawnCalls, 3);
    assert.strictEqual(src.status(), 'ready');
    children[2]._data("/org/retoma/Focus: org.retoma.Focus.FocusChanged ('ff', 'Firefox', 'hi')\n");
    assert.deepStrictEqual(got, [{appId: 'ff', appName: 'Firefox', title: 'hi'}]);
    assert.deepStrictEqual(delays, [500, 1000], 'backoff grows per attempt');
    src.stop();
  });

  await test('focus-source: missing bus name -> extension-missing, no spawn', async function () {
    var timer = fakeTimer();
    var spawnCalls = 0;
    var src = focusSource.createFocusSource({
      spawn: function () { spawnCalls++; return fakeChild(); },
      execFile: function () { return Promise.resolve({stdout: '(false,)'}); },
      timer: timer,
      backoffMs: function () { return 0; }
    });
    src.start();
    await tick(10);
    assert.strictEqual(src.status(), 'extension-missing');
    assert.strictEqual(spawnCalls, 0);
    src.stop();
  });

  await test('idle-source: parses GetIdletime, polls on start, silent on stop', async function () {
    var calls = 0;
    var intervals = [];
    var timer = {
      setInterval: function (fn) { intervals.push(fn); return 7; },
      clearInterval: function () { intervals.length = 0; }
    };
    var src = idleSource.createIdleSource({
      exec: function (cmd, args) {
        calls++;
        assert.strictEqual(cmd, 'gdbus');
        assert.ok(args.join(' ').indexOf('GetIdletime') !== -1);
        return Promise.resolve('(uint64 15433,)');
      },
      timer: timer,
      intervalMs: 5000
    });
    var got = [];
    src.onIdle(function (ms) { got.push(ms); });
    assert.strictEqual(idleSource.parseIdleLine('(uint64 15433,)'), 15433);
    assert.strictEqual(idleSource.parseIdleLine('garbage'), null);
    src.start();
    await tick(10);
    assert.strictEqual(calls, 1, 'immediate first poll');
    assert.deepStrictEqual(got, [15433]);
    intervals.forEach(function (fn) { fn(); });
    await tick(10);
    assert.strictEqual(calls, 2, 'interval polls');
    var n = calls;
    src.stop();
    intervals.forEach(function (fn) { fn(); });
    await tick(10);
    assert.strictEqual(calls, n, 'no polling when Live is off');
  });

  console.log('live: extension files');

  await test('extension: metadata valid, shell 48/49/50', function () {
    var dir = path.join(ROOT, 'live', 'gnome-extension', 'retoma-focus@retoma.local');
    var meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    assert.strictEqual(meta.uuid, 'retoma-focus@retoma.local');
    assert.deepStrictEqual(meta['shell-version'], ['48', '49', '50']);
    assert.ok(fs.existsSync(path.join(dir, 'extension.js')));
  });

  await test('extension: JS syntax check (gjs if present)', function () {
    var file = path.join(ROOT, 'live', 'gnome-extension', 'retoma-focus@retoma.local', 'extension.js');
    var probed = spawnSync('gjs', ['--version'], {encoding: 'utf8'});
    var via = 'node --check (.mjs copy, parse-only)';
    if (!probed.error) via += '; gjs ' + String(probed.stdout || '').trim() + ' present but has no --check flag';
    // Parse-only check: copy to .mjs so node treats ESM `import` as syntax,
    // never executing the resource:///gi:// imports.
    var tmp = path.join(require('os').tmpdir(), 'retoma-extension-check.mjs');
    fs.copyFileSync(file, tmp);
    var checked = spawnSync(process.execPath, ['--check', tmp], {encoding: 'utf8'});
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    assert.strictEqual(checked.status, 0, 'syntax check (' + via + ') failed: ' + (checked.stderr || checked.stdout));
    var src = fs.readFileSync(file, 'utf8');
    assert.ok(/wrapJSObject/.test(src), 'uses wrapJSObject');
    assert.ok(/bus_unown_name/.test(src), 'unowns bus name');
    assert.ok(/disconnect/.test(src), 'disconnects signals');
    assert.ok(/_exported = null/.test(src), 'nulls references');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
