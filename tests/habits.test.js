/* tests/habits.test.js — pure habit metrics + rules coach unit tests.
 * No display, no network, no Electron. Run with: node tests/habits.test.js */
'use strict';

var assert = require('assert');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var Habits = require(path.join(ROOT, 'ai', 'habits'));

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

function ts(hour, min) {
  var d = new Date(2026, 9, 5, hour, min || 0, 0);
  return d.toISOString();
}

/* Steady workday: Document dominates, one long block, few switches. */
function steadyDay() {
  return [
    { app: 'Document', duration: 40, ts: ts(9, 40) },
    { app: 'Spreadsheet', duration: 20, ts: ts(10, 5) },
    { app: 'Document', duration: 30, ts: ts(10, 40) }
  ];
}

function main() {
  return test('metrics: null on empty input', function () {
    assert.strictEqual(Habits.computeMetrics([]), null);
    assert.strictEqual(Habits.computeMetrics(null), null);
  }).then(function () {
    return test('metrics: focus blocks (longest, median, count >=25)', function () {
      var m = Habits.computeMetrics(steadyDay());
      assert.strictEqual(m.longest.app, 'Document');
      assert.strictEqual(m.longest.minutes, 40);
      assert.strictEqual(m.median, 30);
      assert.strictEqual(m.countLong, 2);
      assert.strictEqual(m.totalMinutes, 90);
    });
  }).then(function () {
    return test('metrics: switches per hour + per-app minutes', function () {
      var m = Habits.computeMetrics(steadyDay());
      assert.deepStrictEqual(m.perApp, { Document: 70, Spreadsheet: 20 });
      assert.strictEqual(m.switchesPerHour, 1.3);
      assert.strictEqual(m.mostUsedApp, 'Document');
    });
  }).then(function () {
    return test('metrics: distraction share counts WhatsApp/Browser', function () {
      var m = Habits.computeMetrics([
        { app: 'Document', duration: 30, ts: ts(9, 30) },
        { app: 'WhatsApp', duration: 18, ts: ts(9, 50) },
        { app: 'Browser', duration: 12, ts: ts(10, 5) }
      ]);
      assert.strictEqual(m.distractionMinutes, 30);
      assert.strictEqual(m.distractionShare, 0.5);
      assert.strictEqual(m.distractionPct, 50);
      assert.strictEqual(m.topDistraction, 'WhatsApp');
    });
  }).then(function () {
    return test('metrics: first/last activity + late-night flag', function () {
      var day = Habits.computeMetrics(steadyDay());
      assert.strictEqual(day.firstAt, '9:00');
      assert.strictEqual(day.lastAt, '10:40');
      assert.strictEqual(day.lateNight, false);
      var late = Habits.computeMetrics([{ app: 'Browser', duration: 20, ts: ts(23, 30) }]);
      assert.strictEqual(late.lateNight, true);
      assert.strictEqual(late.lastAt, '23:30');
    });
  }).then(function () {
    return test('metrics: break regularity from idle gaps', function () {
      var m = Habits.computeMetrics([
        { app: 'Document', duration: 30, ts: ts(9, 30) },
        { app: 'Document', duration: 30, ts: ts(10, 15) },
        { app: 'Document', duration: 30, ts: ts(11, 0) }
      ]);
      assert.strictEqual(m.breakCount, 2);
      assert.strictEqual(m.longestGap, 15);
    });
  }).then(function () {
    return test('metrics: trend vs previous day', function () {
      var d1 = new Date(2026, 9, 4, 10, 0, 0).toISOString();
      var d2 = new Date(2026, 9, 5, 10, 0, 0).toISOString();
      var m = Habits.computeMetrics([
        { app: 'Document', duration: 60, ts: d1 },
        { app: 'Document', duration: 30, ts: d2 }
      ]);
      assert.strictEqual(m.trend.days, 2);
      assert.strictEqual(m.trend.direction, 'down');
      assert.strictEqual(m.trend.delta, -30);
      var single = Habits.computeMetrics(steadyDay());
      assert.strictEqual(single.trend.direction, 'unknown');
    });
  }).then(function () {
    return test('rules: worst pattern wins (switches / focus / late / distraction)', function () {
      var busy = [];
      for (var i = 0; i < 12; i++) busy.push({ app: i % 2 ? 'WhatsApp' : 'Document', duration: 5, ts: ts(9, 5 * (i + 1)) });
      assert.strictEqual(Habits.rulesReport(Habits.computeMetrics(busy)).pattern, 'switches');
      var short = [
        { app: 'Document', duration: 10, ts: ts(9, 10) },
        { app: 'Spreadsheet', duration: 10, ts: ts(9, 25) }
      ];
      assert.strictEqual(Habits.rulesReport(Habits.computeMetrics(short)).pattern, 'focus');
      var late = Habits.computeMetrics([
        { app: 'Document', duration: 40, ts: ts(20, 0) },
        { app: 'Document', duration: 40, ts: ts(23, 30) }
      ]);
      assert.strictEqual(Habits.rulesReport(late).pattern, 'lateNight');
      var chatty = Habits.computeMetrics([
        { app: 'Document', duration: 40, ts: ts(9, 40) },
        { app: 'WhatsApp', duration: 30, ts: ts(10, 15) },
        { app: 'Browser', duration: 30, ts: ts(10, 50) }
      ]);
      assert.strictEqual(Habits.rulesReport(chatty).pattern, 'distraction');
      assert.strictEqual(Habits.rulesReport(Habits.computeMetrics(steadyDay())).pattern, 'steady');
    });
  }).then(function () {
    return test('rules: note <=400 chars, experiment in intention form', function () {
      var r = Habits.rulesReport(Habits.computeMetrics(steadyDay()));
      assert.ok(r.note.length <= 400 && r.note.length > 0, 'note length ' + r.note.length);
      assert.ok(/^After .+, I will .+ for \d+ min\.$/.test(r.experiment.text), r.experiment.text);
      assert.ok(!/lazy|wasted|shame|guilty/i.test(r.note), 'no guilt language');
    });
  }).then(function () {
    return test('closed loop: followed / not yet with real numbers', function () {
      var exp = { metric: 'longest', target: 25, direction: 'atLeast' };
      var good = Habits.evaluateExperiment(exp, Habits.computeMetrics(steadyDay()));
      assert.strictEqual(good.status, 'followed');
      assert.ok(/40 min/.test(good.text), good.text);
      var bad = Habits.evaluateExperiment(exp, Habits.computeMetrics([{ app: 'Document', duration: 10 }]));
      assert.strictEqual(bad.status, 'not yet');
      var cap = Habits.evaluateExperiment({ metric: 'switchesPerHour', target: 6, direction: 'atMost' },
        Habits.computeMetrics(steadyDay()));
      assert.strictEqual(cap.status, 'followed');
    });
  }).then(function () {
    return test('ask: longest block / most-used app / switches / cannot-tell', function () {
      var m = Habits.computeMetrics(steadyDay());
      var longest = Habits.rulesAsk(m, 'what was my longest block?');
      assert.ok(/Document 40 min/.test(longest), longest);
      assert.ok(longest.length <= 240, 'ask cap 240 (' + longest.length + ')');
      var app = Habits.rulesAsk(m, 'where did my time go?');
      assert.ok(/Document/.test(app), app);
      var sw = Habits.rulesAsk(m, 'how many context switches?');
      assert.ok(/switches per hour/.test(sw), sw);
      var lost = Habits.rulesAsk(m, 'will it rain tomorrow?');
      assert.ok(/cannot tell/i.test(lost), lost);
      assert.ok(/cannot tell/i.test(Habits.rulesAsk(null, 'anything?')), 'empty metrics');
    });
  }).then(function () {
    return test('grounding: hallucinated number rejected', function () {
      var m = Habits.computeMetrics(steadyDay());
      assert.strictEqual(Habits.groundedNote('Great 40 min in Document today.', m), true);
      assert.strictEqual(Habits.groundedNote('Amazing 97 min deep work streak.', m), false);
    });
  }).then(function () {
    return test('grounding: unknown app, guilt and medical claims rejected', function () {
      var m = Habits.computeMetrics(steadyDay());
      assert.strictEqual(Habits.groundedNote('Less Slack, more focus.', m), false);
      assert.strictEqual(Habits.groundedNote('You lazy waster.', m), false);
      assert.strictEqual(Habits.groundedNote('This will cure your insomnia.', m), false);
    });
  }).then(function () {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failures.length) {
      console.log('failures:\n - ' + failures.join('\n - '));
      process.exit(1);
    }
  });
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
