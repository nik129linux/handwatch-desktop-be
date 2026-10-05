/* tests/ai.test.js — habit-coach provider chain + experiments store.
 * fetch is always injected (fetchImpl): no network, no Ollama needed.
 * Run with: node tests/ai.test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var os = require('os');
var fs = require('fs');

var ROOT = path.resolve(__dirname, '..');
var providers = require(path.join(ROOT, 'ai', 'providers'));
var habits = require(path.join(ROOT, 'ai', 'habits'));
var store = require(path.join(ROOT, 'ai', 'store'));

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

function demoMetrics() {
  return habits.computeMetrics([
    { app: 'Document', duration: 40 },
    { app: 'Browser', duration: 12 },
    { app: 'WhatsApp', duration: 18 },
    { app: 'Spreadsheet', duration: 10 }
  ]);
}

function tagsFetch(models) {
  return function (url) {
    assert.ok(url.indexOf('/api/tags') !== -1, 'tags first: ' + url);
    return Promise.resolve({ json: function () { return Promise.resolve({ models: models }); } });
  };
}

function ollamaFetch(models, responseObj) {
  var calls = [];
  var impl = function (url, opts) {
    calls.push(url);
    if (url.indexOf('/api/tags') !== -1) {
      return Promise.resolve({ json: function () { return Promise.resolve({ models: models }); } });
    }
    var body = JSON.parse(opts.body);
    assert.strictEqual(body.format, 'json');
    assert.strictEqual(body.stream, false);
    return Promise.resolve({ json: function () { return Promise.resolve({ response: JSON.stringify(responseObj) }); } });
  };
  impl.calls = calls;
  return impl;
}

function groundedReply(m) {
  return {
    note: 'Steady day: longest ' + m.longest.minutes + ' min in ' + m.longest.app + ' across ' + m.count + ' blocks.',
    experiment: {
      text: 'After I start work, I will do one focused stretch for 25 min.',
      trigger: 'I start work',
      action: 'do one focused stretch',
      minutes: 25,
      metric: 'longest',
      target: 25,
      direction: 'atLeast'
    }
  };
}

function main() {
  return test('pickLocalModel: gemma only, never another local model', function () {
    assert.strictEqual(
      providers.pickLocalModel({ models: [{ name: 'qwen:4b' }, { name: 'gemma4:31b-cloud', remote_host: 'x' }] }),
      'gemma4:31b-cloud');
    assert.strictEqual(providers.pickLocalModel({ models: [{ name: 'qwen:4b' }] }), null);
    assert.deepStrictEqual(providers.parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(providers.parseModelJson('Here: {"a":2} done'), { a: 2 });
    assert.strictEqual(
      providers.pickLocalModel({ models: [{ name: 'gemma4:31b-cloud', remote_host: 'x' }] }),
      'gemma4:31b-cloud');
    assert.strictEqual(providers.pickLocalModel({ models: [] }), null);
  }).then(function () {
    return test('report: Ollama up returns grounded model note', function () {
      var m = demoMetrics();
      return providers.habitsReport(m, {
        mode: 'local', consent: { local: true },
        fetchImpl: ollamaFetch([{ name: 'gemma4:31b-cloud', remote_host: 'x' }], groundedReply(m))
      }).then(function (rep) {
        assert.ok(/^Ollama · /.test(rep.source), rep.source);
        assert.strictEqual(rep.fallback, false);
        assert.ok(rep.note.indexOf(String(m.longest.minutes)) !== -1, rep.note);
      });
    });
  }).then(function () {
    return test('report: Ollama down falls back to rules', function () {
      var m = demoMetrics();
      var down = function () { return Promise.reject(new Error('refused')); };
      return providers.habitsReport(m, { mode: 'local', consent: { local: true }, fetchImpl: down })
        .then(function (rep) {
          assert.strictEqual(rep.source, 'rules');
          assert.strictEqual(rep.fallback, true);
          assert.ok(rep.note && rep.experiment, 'rules note + experiment present');
        });
    });
  }).then(function () {
    return test('report: invalid JSON falls back to rules', function () {
      var m = demoMetrics();
      var bad = function (url) {
        if (url.indexOf('/api/tags') !== -1) {
          return Promise.resolve({ json: function () { return Promise.resolve({ models: [{ name: 'gemma4:31b-cloud' }] }); } });
        }
        return Promise.resolve({ json: function () { return Promise.resolve({ response: 'not json{{' }); } });
      };
      return providers.habitsReport(m, { mode: 'local', consent: { local: true }, fetchImpl: bad })
        .then(function (rep) {
          assert.strictEqual(rep.source, 'rules');
          assert.strictEqual(rep.fallback, true);
        });
    });
  }).then(function () {
    return test('report: hallucinated number rejected, rules used', function () {
      var m = demoMetrics();
      var liar = {
        note: 'Incredible 999 min marathon in Document today, keep it up.',
        experiment: {
          text: 'After I start work, I will do one focused stretch for 25 min.',
          trigger: 'I start work', action: 'do one focused stretch',
          minutes: 25, metric: 'longest', target: 25, direction: 'atLeast'
        }
      };
      assert.strictEqual(habits.validateReport(liar), true, 'shape is valid');
      assert.strictEqual(habits.groundedReport(liar, m), false, 'grounding rejects 999');
      return providers.habitsReport(m, {
        mode: 'local', consent: { local: true },
        fetchImpl: ollamaFetch([{ name: 'gemma4:31b-cloud' }], liar)
      }).then(function (rep) {
        assert.strictEqual(rep.source, 'rules');
        assert.strictEqual(rep.fallback, true);
      });
    });
  }).then(function () {
    return test('report: cloud-tagged-only list still calls the model', function () {
      var m = demoMetrics();
      var impl = ollamaFetch([{ name: 'gemma4:31b-cloud', remote_host: 'cloud' }], groundedReply(m));
      return providers.habitsReport(m, { mode: 'local', consent: { local: true }, fetchImpl: impl })
        .then(function (rep) {
          assert.ok(rep.source.indexOf('gemma4:31b-cloud') !== -1, rep.source);
          assert.ok(impl.calls.some(function (u) { return u.indexOf('/api/generate') !== -1; }), 'generate called');
        });
    });
  }).then(function () {
    return test('report: off / no consent never touches the network', function () {
      var m = demoMetrics();
      var boom = function () { throw new Error('must not fetch'); };
      return providers.habitsReport(m, { mode: 'off', consent: {}, fetchImpl: boom })
        .then(function (rep) {
          assert.strictEqual(rep.source, 'rules');
          assert.strictEqual(rep.fallback, false);
        });
    });
  }).then(function () {
    return test('ask: grounded model answer passes through', function () {
      var m = demoMetrics();
      var answer = 'Your longest block was Document 40 min (median 18 min).';
      assert.ok(habits.groundedAnswer(answer, m), 'fixture is grounded');
      var impl = ollamaFetch([{ name: 'gemma4:31b-cloud' }], { answer: answer });
      return providers.habitsAsk(m, 'longest block?', { mode: 'local', consent: { local: true }, fetchImpl: impl })
        .then(function (res) {
          assert.strictEqual(res.answer, answer);
          assert.ok(/^Ollama · /.test(res.source), res.source);
        });
    });
  }).then(function () {
    return test('ask: failure answers from rules with fallback flag', function () {
      var m = demoMetrics();
      var down = function () { return Promise.reject(new Error('down')); };
      return providers.habitsAsk(m, 'most used app?', { mode: 'local', consent: { local: true }, fetchImpl: down })
        .then(function (res) {
          assert.strictEqual(res.source, 'rules');
          assert.strictEqual(res.fallback, true);
          assert.ok(/Document/.test(res.answer), res.answer);
          assert.ok(res.answer.length <= 240, 'ask cap 240');
        });
    });
  }).then(function () {
    return test('aiStatus: reachable model / unreachable', function () {
      return providers.aiStatus({ fetchImpl: tagsFetch([{ name: 'gemma4:31b-cloud', remote_host: 'x' }]) })
        .then(function (st) {
          assert.strictEqual(st.reachable, true);
          assert.strictEqual(st.model, 'gemma4:31b-cloud');
        })
        .then(function () {
          return providers.aiStatus({ fetchImpl: function () { return Promise.reject(new Error('down')); } });
        })
        .then(function (st) {
          assert.strictEqual(st.reachable, false);
          assert.strictEqual(st.model, '');
        });
    });
  }).then(function () {
    return test('experiments store: save/load/prune/export roundtrip', function () {
      var dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'retoma-exp-'));
      var file = store.experimentsPathFor(dir, 'demo');
      assert.ok(/experiments-demo\.json$/.test(file), file);
      assert.ok(/experiments-live\.json$/.test(store.experimentsPathFor(dir, 'live')));
      var old = { id: 'old', createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), status: 'active', text: 'x' };
      var fresh = { id: 'new', createdAt: new Date().toISOString(), status: 'active', text: 'y' };
      store.saveExperimentsFile(fs, file, [old, fresh]);
      var loaded = store.loadExperimentsFile(fs, file);
      assert.strictEqual(loaded.length, 1, '7-day retention prunes the old one');
      assert.strictEqual(loaded[0].id, 'new');
      var ser = JSON.parse(store.serializeExperiments(loaded));
      assert.strictEqual(ser.experiments.length, 1);
      store.deleteEventsFile(fs, file);
      assert.deepStrictEqual(store.loadExperimentsFile(fs, file), []);
    });
  }).then(function () {
    return test('payload preview shows aggregates only', function () {
      var m = demoMetrics();
      var body = providers.buildHabitsBody(m, 'first available local model');
      assert.strictEqual(body.format, 'json');
      assert.strictEqual(body.stream, false);
      assert.ok(body.prompt.indexOf(JSON.stringify(m.perApp)) !== -1, 'aggregates in prompt');
      var ask = providers.buildAskBody(m, 'longest?', 'first available local model');
      assert.ok(ask.prompt.indexOf('longest?') !== -1, 'question travels only with consent');
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
