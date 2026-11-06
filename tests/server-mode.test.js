/* tests/server-mode.test.js — "Retoma server" AI mode: gemma through the Acompaña EC2.
 * Contract (ai/providers.js):
 *   DEFAULT_API_BASE = 'https://184-72-152-71.sslip.io'; opts.apiBase or env RETOMA_API_BASE override it.
 *   resumeLine(ctx, { mode: 'server', consent: { server: true }, apiBase, fetchImpl, lang, timeoutMs })
 *     POST <apiBase>/api/retoma/resume-line  JSON { ctx: {app, title, note, awayMinutes}, lang }
 *     reply { ok, text, source, fallback:false } is re-validated locally (same rules as the local model);
 *     anything else (fallback, bad line, HTTP error, timeout) -> rules with fallback:true. Never rejects.
 *   propose(summary, { mode: 'server', consent: { server: true }, ... })
 *     POST <apiBase>/api/retoma/propose JSON { summary, lang }; reply validated with validateProposal.
 *   Without consent.server: rules, zero network.
 *   serverStatus({ apiBase, fetchImpl, timeoutMs }) -> GET <apiBase>/api/health -> { reachable: true, model }
 *     or { reachable: false } (never rejects).
 * Contract (UI): Privacy > Smart suggestions shows Off / Local model / Retoma server
 *   (button data-ai-mode="server"); the Gemini "Cloud model" button is gone from the UI. Choosing Retoma
 *   server asks for consent with text that names the server and Ollama cloud. Spanish label: "Servidor Retoma".
 *   preload exposes serverStatus(); main handles 'retoma:server:status'.
 * Run with: node tests/server-mode.test.js */
'use strict';

var assert = require('assert');
var path = require('path');
var fs = require('fs');
var ROOT = path.resolve(__dirname, '..');
var providers = require(path.join(ROOT, 'ai', 'providers'));

var passed = 0;
var failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(function () { passed++; console.log('  ok ' + name); })
    .catch(function (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); });
}

var CTX = { app: 'Document', title: 'Informe de calidad', note: 'fix the citation in paragraph 3', awayMinutes: 25 };
var SUMMARY = providers.buildSummary([{ app: 'Document', duration: 40 }, { app: 'WhatsApp', duration: 18 }]);
var BASE = 'https://srv.test';

function fakeServer(replyFor) {
  var calls = [];
  var impl = function (url, opts) {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null, headers: (opts && opts.headers) || {} });
    var r = replyFor(String(url));
    if (r instanceof Error) return Promise.reject(r);
    if (r === 'hang') return new Promise(function () {});
    return Promise.resolve({ ok: r.status ? r.status < 400 : true, status: r.status || 200, json: function () { return Promise.resolve(r.json); } });
  };
  impl.calls = calls;
  return impl;
}
function noNet() { var f = function () { f.n++; return Promise.reject(new Error('network')); }; f.n = 0; return f; }
var OPTS = function (impl, extra) { return Object.assign({ mode: 'server', consent: { server: true }, apiBase: BASE, fetchImpl: impl, timeoutMs: 200 }, extra || {}); };

async function main() {
  console.log('server-mode: providers');

  await test('default api base is the Acompaña EC2 name', function () {
    assert.strictEqual(providers.DEFAULT_API_BASE, 'https://184-72-152-71.sslip.io');
  });

  await test('resumeLine: posts ctx + lang, keeps a valid server line', async function () {
    var f = fakeServer(function () { return { json: { ok: true, text: 'You were in Document; next, fix the citation.', source: 'Retoma server · gemma4:31b', fallback: false } }; });
    var r = await providers.resumeLine(CTX, OPTS(f, { lang: 'es' }));
    assert.deepStrictEqual(r, { text: 'You were in Document; next, fix the citation.', source: 'Retoma server · gemma4:31b', fallback: false });
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, BASE + '/api/retoma/resume-line');
    assert.strictEqual(f.calls[0].method, 'POST');
    assert.deepStrictEqual(f.calls[0].body, { ctx: CTX, lang: 'es' });
  });

  await test('resumeLine: an empty title is not sent', async function () {
    var f = fakeServer(function () { return { json: { ok: true, fallback: true } }; });
    await providers.resumeLine({ app: 'Document', title: '', note: '', awayMinutes: 3 }, OPTS(f));
    assert.ok(!('title' in f.calls[0].body.ctx) || f.calls[0].body.ctx.title === '', JSON.stringify(f.calls[0].body));
  });

  await test('resumeLine: server fallback, bad line, HTTP 429, network error, hang -> rules, fallback:true', async function () {
    var replies = [
      { json: { ok: true, fallback: true } },
      { json: { ok: true, text: 'In Document, the user was distracted.', source: 'x', fallback: false } },
      { status: 429, json: { ok: false, error: 'rate limited' } },
      new Error('ECONNREFUSED'),
      'hang'
    ];
    for (var i = 0; i < replies.length; i++) {
      var rep = replies[i];
      var r = await providers.resumeLine(CTX, OPTS(fakeServer(function () { return rep; })));
      assert.strictEqual(r.fallback, true, 'case ' + i);
      assert.strictEqual(r.text, providers.rulesResumeLine(CTX).text, 'case ' + i);
    }
  });

  await test('resumeLine: no consent -> rules, zero network', async function () {
    var f = noNet();
    var r = await providers.resumeLine(CTX, { mode: 'server', consent: {}, apiBase: BASE, fetchImpl: f });
    assert.strictEqual(f.n, 0);
    assert.strictEqual(r.source, 'On-device rules');
  });

  await test('propose: posts summary, validates the reply', async function () {
    var f = fakeServer(function () { return { json: { ok: true, start: '9:00', minutes: 40, reason: 'Your longest block was in Document.', source: 'Retoma server · gemma4:31b', fallback: false } }; });
    var r = await providers.propose(SUMMARY, OPTS(f, { lang: 'en' }));
    assert.strictEqual(r.start, '9:00');
    assert.strictEqual(r.minutes, 40);
    assert.strictEqual(r.source, 'Retoma server · gemma4:31b');
    assert.strictEqual(r.fallback, false);
    assert.strictEqual(f.calls[0].url, BASE + '/api/retoma/propose');
    assert.deepStrictEqual(f.calls[0].body, { summary: SUMMARY, lang: 'en' });
  });

  await test('propose: judging reason or server fallback -> rules', async function () {
    var bad = fakeServer(function () { return { json: { ok: true, start: '9:00', minutes: 40, reason: 'Avoid the distraction.', source: 's', fallback: false } }; });
    assert.strictEqual((await providers.propose(SUMMARY, OPTS(bad))).fallback, true);
    var fb = fakeServer(function () { return { json: { ok: true, fallback: true } }; });
    assert.strictEqual((await providers.propose(SUMMARY, OPTS(fb))).fallback, true);
  });

  await test('serverStatus: reachable with model, or unreachable', async function () {
    var up = fakeServer(function () { return { json: { ok: true, service: 'acompana', ollama: { reachable: true, model: 'gemma4:31b' } } }; });
    assert.deepStrictEqual(await providers.serverStatus({ apiBase: BASE, fetchImpl: up }), { reachable: true, model: 'gemma4:31b' });
    assert.strictEqual(up.calls[0].url, BASE + '/api/health');
    var down = fakeServer(function () { return new Error('ETIMEDOUT'); });
    assert.deepStrictEqual(await providers.serverStatus({ apiBase: BASE, fetchImpl: down }), { reachable: false });
  });

  console.log('server-mode: wiring + UI');

  await test('preload exposes serverStatus and main handles it', function () {
    var pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    var main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(/serverStatus\s*:/.test(pre) && /retoma:server:status/.test(pre));
    assert.ok(/ipcMain\.handle\(\s*['"]retoma:server:status['"]/.test(main));
  });

  const { chromium } = require('playwright');
  const { pathToFileURL } = require('url');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', function (e) { errs.push(e.message); });
  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
  await page.waitForFunction(function () { return window.Retoma && !document.body.classList.contains('is-launch'); });
  await page.evaluate(function () { Retoma.switchTab('priv'); });
  await page.waitForTimeout(300);

  await test('Privacy: Off / Local model / Retoma server; no Gemini button', async function () {
    var labels = await page.$$eval('[data-ai-mode]', function (bs) { return bs.map(function (b) { return b.getAttribute('data-ai-mode') + ':' + b.textContent.trim(); }); });
    assert.deepStrictEqual(labels, ['off:Off', 'local:Local model', 'server:Retoma server'], JSON.stringify(labels));
  });

  await test('consent text names the server and Ollama cloud', async function () {
    var text = await page.evaluate(function () {
      var box = document.getElementById('aiConsent');
      return box ? box.textContent : '';
    });
    var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') + fs.readFileSync(path.join(ROOT, 'js', 'retoma.js'), 'utf8');
    assert.ok(/Retoma server|Retoma's server/.test(html) && /Ollama cloud/.test(html), 'consent copy mentions the server and Ollama cloud');
  });

  await test('Spanish label: Servidor Retoma', async function () {
    await page.click('.lang-switch__btn[data-lang="es"]');
    await page.waitForTimeout(250);
    var t = await page.textContent('[data-ai-mode="server"]');
    assert.strictEqual(t.trim(), 'Servidor Retoma');
    await page.click('.lang-switch__btn[data-lang="en"]');
  });

  await test('no page errors', function () { assert.deepStrictEqual(errs, []); });
  await browser.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
