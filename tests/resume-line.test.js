/* tests/resume-line.test.js — the one-line "where you were" on the resume card.
 * Contract for providers.resumeLine(ctx, opts) and providers.rulesResumeLine(ctx).
 * ctx = { app, title, note, awayMinutes }  (title '' when titles are off).
 * fetch is always injected: no network, no Ollama needed.
 * Run with: node tests/resume-line.test.js */
'use strict';

var assert = require('assert');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var providers = require(path.join(ROOT, 'ai', 'providers'));

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

var BANNED = /productiv|distract|score|lazy|wasted/i;

/* Fake Ollama: /api/tags lists the given models, /api/generate answers `reply`.
 * Records every call so tests can inspect URLs and bodies. */
function fakeOllama(reply, models) {
  var calls = [];
  var impl = function (url, opts) {
    calls.push({url: String(url), body: opts && opts.body ? String(opts.body) : ''});
    if (/\/api\/tags$/.test(url)) {
      return Promise.resolve({ok: true, json: function () { return Promise.resolve({models: (models || ['gemma4:31b-cloud']).map(function (n) { return {name: n}; })}); }});
    }
    if (/\/api\/generate$/.test(url)) {
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ok: true, json: function () { return Promise.resolve({response: reply}); }});
    }
    return Promise.reject(new Error('unexpected url ' + url));
  };
  impl.calls = calls;
  return impl;
}

function noNetwork() {
  var impl = function () { impl.count++; return Promise.reject(new Error('network used')); };
  impl.count = 0;
  return impl;
}

var CTX = {app: 'Document', title: 'Quality report', note: 'fix the citation in paragraph 3', awayMinutes: 25};

async function main() {
  console.log('resume-line: rules');

  await test('rules: app + title + note, note kept verbatim', function () {
    var r = providers.rulesResumeLine(CTX);
    assert.strictEqual(r.text, 'You were in Document · Quality report. Next: fix the citation in paragraph 3');
    assert.strictEqual(r.source, 'On-device rules');
  });

  await test('rules: no title, no note -> just the app', function () {
    var r = providers.rulesResumeLine({app: 'Firefox', title: '', note: '', awayMinutes: 7});
    assert.strictEqual(r.text, 'You were in Firefox.');
  });

  await test('rules: note without title', function () {
    var r = providers.rulesResumeLine({app: 'Code', title: '', note: 'run the tests', awayMinutes: 3});
    assert.strictEqual(r.text, 'You were in Code. Next: run the tests');
  });

  await test('rules: whitespace-only note and title count as empty; note trimmed', function () {
    var r = providers.rulesResumeLine({app: 'Code', title: '   ', note: '  \n run it \t', awayMinutes: 3});
    assert.strictEqual(r.text, 'You were in Code. Next: run it');
  });

  await test('rules: long note and title are capped, output <= 160 chars, ends with an ellipsis', function () {
    var r = providers.rulesResumeLine({app: 'Document', title: 't'.repeat(300), note: 'n'.repeat(500), awayMinutes: 9});
    assert.ok(r.text.length <= 160, 'got ' + r.text.length);
    assert.ok(/…$/.test(r.text));
  });

  await test('rules: missing app -> "Unknown", never throws on empty ctx', function () {
    assert.strictEqual(providers.rulesResumeLine({}).text, 'You were in Unknown.');
    assert.strictEqual(providers.rulesResumeLine(null).text, 'You were in Unknown.');
  });

  console.log('resume-line: privacy');

  await test('mode off -> rules, zero network', async function () {
    var net = noNetwork();
    var r = await providers.resumeLine(CTX, {mode: 'off', fetchImpl: net});
    assert.strictEqual(net.count, 0);
    assert.strictEqual(r.text, providers.rulesResumeLine(CTX).text);
    assert.strictEqual(r.fallback, false);
  });

  await test('local without consent -> rules, zero network', async function () {
    var net = noNetwork();
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {}, fetchImpl: net});
    assert.strictEqual(net.count, 0);
    assert.strictEqual(r.source, 'On-device rules');
  });

  await test('cloud, even with consent and a key -> rules, zero network (notes never leave the device)', async function () {
    var net = noNetwork();
    var r = await providers.resumeLine(CTX, {mode: 'cloud', consent: {cloud: true}, geminiKey: 'k', fetchImpl: net});
    assert.strictEqual(net.count, 0);
    assert.strictEqual(r.source, 'On-device rules');
    assert.ok(/device/i.test(r.note || ''), 'explains why: ' + r.note);
  });

  await test('local: empty title is not sent to the model', async function () {
    var f = fakeOllama('{"line":"You were in Document, next fix the citation."}');
    await providers.resumeLine({app: 'Document', title: '', note: 'fix the citation', awayMinutes: 4}, {mode: 'local', consent: {local: true}, fetchImpl: f});
    var gen = f.calls.filter(function (c) { return /generate$/.test(c.url); })[0];
    assert.ok(gen, 'generate was called');
    assert.ok(!/Quality report/.test(gen.body));
    assert.ok(!/"title"\s*:\s*"[^"]/.test(gen.body), 'no non-empty title field in the prompt body');
  });

  console.log('resume-line: local gemma');

  await test('local: valid gemma line is used, source names the model', async function () {
    var f = fakeOllama('{"line":"You were tightening the Document quality report; next, fix the paragraph 3 citation."}');
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: f});
    assert.strictEqual(r.fallback, false);
    assert.strictEqual(r.text, 'You were tightening the Document quality report; next, fix the paragraph 3 citation.');
    assert.strictEqual(r.source, 'Ollama cloud · gemma4:31b-cloud', 'a -cloud model is never called local');
    var gen = f.calls.filter(function (c) { return /generate$/.test(c.url); })[0];
    var body = JSON.parse(gen.body);
    assert.strictEqual(body.model, 'gemma4:31b-cloud');
    assert.strictEqual(body.stream, false);
    assert.ok(/fix the citation in paragraph 3/.test(body.prompt), 'note reaches the prompt');
  });

  await test('local: fenced JSON is accepted', async function () {
    var f = fakeOllama('```json\n{"line":"You were in Document; next, fix the citation."}\n```');
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: f});
    assert.strictEqual(r.fallback, false);
    assert.strictEqual(r.text, 'You were in Document; next, fix the citation.');
  });

  await test('local: only non-gemma models installed -> rules, generate never called', async function () {
    var f = fakeOllama('{"line":"You were in Document."}', ['llama3:70b', 'qwen3:32b']);
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: f});
    assert.strictEqual(r.fallback, true);
    assert.strictEqual(r.text, providers.rulesResumeLine(CTX).text);
    assert.strictEqual(f.calls.filter(function (c) { return /generate$/.test(c.url); }).length, 0);
  });

  var BAD = [
    ['line that does not name the app (ungrounded)', '{"line":"You were writing your thesis on renewable energy."}'],
    ['banned judgemental word', '{"line":"You were distracted from Document for 25 minutes."}'],
    ['too long (>140)', JSON.stringify({line: 'You were in Document ' + 'and '.repeat(40)})],
    ['too short (<8)', '{"line":"Doc"}'],
    ['multi-line', '{"line":"You were in Document.\\nNext: fix it."}'],
    ['not JSON', 'You were in Document.'],
    ['wrong key', '{"text":"You were in Document."}'],
    ['non-string line', '{"line":42}'],
    ['third person ("the user")', '{"line":"In Document, the user worked on the report."}']
  ];
  for (const [label, reply] of BAD) {
    await test('local: rejects ' + label + ' -> rules fallback', async function () {
      var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: fakeOllama(reply)});
      assert.strictEqual(r.fallback, true, 'should have fallen back');
      assert.strictEqual(r.text, providers.rulesResumeLine(CTX).text);
      assert.ok(!BANNED.test(r.text));
    });
  }

  await test('local: network error -> rules fallback, never rejects', async function () {
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: fakeOllama(new Error('ECONNREFUSED'))});
    assert.strictEqual(r.fallback, true);
    assert.strictEqual(r.text, providers.rulesResumeLine(CTX).text);
  });

  await test('local: hung model -> fallback within the timeout', async function () {
    var hung = function (url) {
      if (/tags$/.test(url)) return Promise.resolve({ok: true, json: function () { return Promise.resolve({models: [{name: 'gemma4:31b-cloud'}]}); }});
      return new Promise(function () {});
    };
    var t0 = Date.now();
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: hung, timeoutMs: 50});
    assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
    assert.strictEqual(r.fallback, true);
  });

  await test('a truly local gemma is labelled local', async function () {
    var r = await providers.resumeLine(CTX, {mode: 'local', consent: {local: true}, fetchImpl: fakeOllama('{"line":"You were in Document; next, fix the citation."}', ['gemma4:12b'])});
    assert.strictEqual(r.source, 'Local model · gemma4:12b');
  });

  await test('propose: a judging reason from the model falls back to rules', async function () {
    var summary = providers.buildSummary([{app: 'Document', duration: 40}, {app: 'WhatsApp', duration: 18}]);
    var r = await providers.propose(summary, {mode: 'local', consent: {local: true},
      fetchImpl: fakeOllama('{"start":"9:40","minutes":40,"reason":"Avoid the WhatsApp distraction pattern."}')});
    assert.strictEqual(r.fallback, true, JSON.stringify(r));
    assert.ok(!/distract/i.test(r.reason));
  });

  await test('existing propose() still works (no regression in the export list)', async function () {
    assert.strictEqual(typeof providers.propose, 'function');
    assert.strictEqual(typeof providers.resumeLine, 'function');
    assert.strictEqual(typeof providers.rulesResumeLine, 'function');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch(function (e) { console.error(e); process.exit(1); });
