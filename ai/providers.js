/* ai/providers.js — MAIN PROCESS ONLY. Renderer never sees keys.
 * Provider chain for Retoma smart suggestions: rules (default, on-device,
 * no network) -> local Ollama -> cloud Gemini. Every call has an 8s timeout,
 * output is validated, failures fall back to rules. */
'use strict';

var TIMEOUT_MS = 8000;
var FALLBACK_NOTE = 'Model unavailable, used on-device rules';
var OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
var GEMINI_LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function ollamaBaseUrl() {
  return process.env.RETOMA_OLLAMA_URL || OLLAMA_DEFAULT_URL;
}

function geminiKey() {
  return process.env.GEMINI_API_KEY || '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtClock(totalMin) {
  var h = Math.floor(totalMin / 60) % 24;
  var m = totalMin % 60;
  return h + ':' + pad2(m);
}

function parseClock(str) {
  var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/* summary = { perApp: {app: minutes}, longest: {app, minutes},
 *             firstInterruption: {app, at: 'H:MM'} }. No titles, no text. */
function buildSummary(timeline) {
  var entries = (timeline && timeline.length ? timeline : [{ app: 'Document', duration: 40 }]).slice();
  var perApp = {};
  var order = [];
  entries.forEach(function (e) {
    if (!perApp[e.app]) { perApp[e.app] = 0; order.push(e.app); }
    perApp[e.app] += e.duration;
  });
  var longest = { app: entries[0].app, minutes: entries[0].duration };
  entries.forEach(function (e) {
    if (e.duration > longest.minutes) longest = { app: e.app, minutes: e.duration };
  });
  var ix = -1;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].app === 'WhatsApp') { ix = i; break; }
  }
  if (ix === -1) ix = entries.length > 1 ? 1 : 0;
  var startMin = 9 * 60;
  for (var j = 0; j < ix; j++) startMin += entries[j].duration;
  return {
    perApp: perApp,
    longest: longest,
    firstInterruption: { app: entries[ix] ? entries[ix].app : longest.app, at: fmtClock(startMin) }
  };
}

/* Pure on-device rules. No network, ever. */
function rulesPropose(summary) {
  var minutes = Math.max(15, Math.min(180, Math.round(summary.longest.minutes)));
  var interMin = parseClock(summary.firstInterruption.at);
  if (interMin === null) interMin = 9 * 60 + 52;
  var winStart = Math.ceil(Math.max(6 * 60, interMin - 60) / 15) * 15;
  var reason = 'Longest block ' + summary.longest.app + ' ' + minutes +
    ' min. First break ' + summary.firstInterruption.app + ' ' +
    summary.firstInterruption.at + '.';
  return { start: fmtClock(winStart), minutes: minutes, reason: reason.slice(0, 140), source: 'rules' };
}

function validateProposal(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (parseClock(obj.start) === null) return false;
  if (!Number.isInteger(obj.minutes) || obj.minutes < 15 || obj.minutes > 180) return false;
  if (typeof obj.reason !== 'string' || obj.reason.length < 1 || obj.reason.length > 140) return false;
  return true;
}

function fallbackResult(summary, note) {
  var r = rulesPropose(summary);
  r.source = 'rules';
  r.fallback = true;
  r.note = note || FALLBACK_NOTE;
  return r;
}

function fetchWithTimeout(url, opts, timeoutMs, fetchImpl) {
  var impl = fetchImpl || fetch;
  var ms = timeoutMs === undefined ? TIMEOUT_MS : timeoutMs;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  var fetchOpts = Object.assign({}, opts || {}, { signal: ctrl.signal });
  return impl(url, fetchOpts).then(
    function (res) { clearTimeout(timer); return res; },
    function (err) { clearTimeout(timer); throw err; }
  );
}

function promptFor(summary) {
  return 'Plan one focused work block from this usage summary (per-app minutes, ' +
    'longest uninterrupted block, first break time). Reply with JSON only, ' +
    'exactly {"start":"HH:MM","minutes":15-180,"reason":"140 chars max"}. ' +
    'Summary: ' + JSON.stringify(summary);
}

function buildOllamaBody(summary, model) {
  return { model: model, prompt: promptFor(summary), format: 'json', stream: false };
}

/* Exact JSON payload that would be sent (shown for consent before Allow). */
function previewPayload(summary, mode, modelHint) {
  if (mode === 'local') {
    return buildOllamaBody(summary, modelHint || 'first available local model');
  }
  if (mode === 'cloud') {
    return {
      contents: [{ role: 'user', parts: [{ text: promptFor(summary) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            start: { type: 'STRING' },
            minutes: { type: 'INTEGER' },
            reason: { type: 'STRING' }
          },
          required: ['start', 'minutes', 'reason']
        }
      }
    };
  }
  return null;
}

function pickLocalModel(tagsJson) {
  var models = (tagsJson && tagsJson.models) || [];
  for (var i = 0; i < models.length; i++) {
    if (!models[i].remote_host && models[i].name) return models[i].name;
  }
  return null;
}

function ollamaPropose(summary, opts) {
  var o = opts || {};
  var base = o.ollamaUrl || ollamaBaseUrl();
  var impl = o.fetchImpl;
  var ms = o.timeoutMs === undefined ? TIMEOUT_MS : o.timeoutMs;
  return fetchWithTimeout(base + '/api/tags', { method: 'GET' }, ms, impl)
    .then(function (res) { return res.json(); })
    .then(function (tags) {
      var model = pickLocalModel(tags);
      if (!model) throw new Error('no local model');
      return fetchWithTimeout(base + '/api/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildOllamaBody(summary, model))
        }, ms, impl)
        .then(function (res) { return res.json(); })
        .then(function (gen) {
          var parsed;
          try { parsed = JSON.parse(gen.response); } catch (e) { throw new Error('bad json'); }
          if (!validateProposal(parsed)) throw new Error('invalid shape');
          return { start: parsed.start, minutes: parsed.minutes, reason: parsed.reason, source: 'Local model \u00b7 ' + model, fallback: false };
        });
    });
}

function pickFlashModel(listJson) {
  var models = (listJson && listJson.models) || [];
  var flash = null;
  for (var i = 0; i < models.length; i++) {
    var n = String(models[i].name || '');
    if (/flash/i.test(n)) { flash = n; break; }
  }
  var name = flash || (models[0] && models[0].name);
  return name || null;
}

function geminiPropose(summary, opts) {
  var o = opts || {};
  var key = o.geminiKey !== undefined ? o.geminiKey : geminiKey();
  if (!key) return Promise.resolve(fallbackResult(summary, 'Cloud model disabled: set GEMINI_API_KEY'));
  var impl = o.fetchImpl;
  var ms = o.timeoutMs === undefined ? TIMEOUT_MS : o.timeoutMs;
  return fetchWithTimeout(GEMINI_LIST_URL + '?key=' + encodeURIComponent(key), { method: 'GET' }, ms, impl)
    .then(function (res) { return res.json(); })
    .then(function (list) {
      var model = pickFlashModel(list);
      if (!model) throw new Error('no flash model');
      return fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/' + model + ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(previewPayload(summary, 'cloud'))
        }, ms, impl)
        .then(function (res) { return res.json(); })
        .then(function (gen) {
          var text = '';
          try {
            var parts = gen.candidates[0].content.parts || [];
            text = parts.map(function (p) { return p.text || ''; }).join('');
          } catch (e) { throw new Error('bad shape'); }
          var parsed;
          try { parsed = JSON.parse(text); } catch (e) { throw new Error('bad json'); }
          if (!validateProposal(parsed)) throw new Error('invalid shape');
          return { start: parsed.start, minutes: parsed.minutes, reason: parsed.reason, source: 'Cloud \u00b7 Gemini', fallback: false };
        });
    });
}

/* Main entry. mode 'off' or missing consent: pure rules, zero network. */
function propose(summary, opts) {
  var o = opts || {};
  var mode = o.mode || 'off';
  var consent = o.consent || {};
  if (mode === 'off' || !consent[mode]) {
    var r = rulesPropose(summary);
    r.fallback = false;
    if (mode !== 'off') r.note = 'Consent needed before the model is called';
    return Promise.resolve(r);
  }
  if (mode === 'local') {
    return ollamaPropose(summary, o).catch(function () { return fallbackResult(summary); });
  }
  if (mode === 'cloud') {
    return geminiPropose(summary, o).catch(function () { return fallbackResult(summary); });
  }
  var unknown = rulesPropose(summary);
  unknown.fallback = false;
  return Promise.resolve(unknown);
}

function capabilities() {
  var hasKey = !!geminiKey();
  return {
    cloudAvailable: hasKey,
    cloudReason: hasKey ? '' : 'Set GEMINI_API_KEY to enable the cloud model',
    ollamaUrl: ollamaBaseUrl()
  };
}

module.exports = {
  TIMEOUT_MS: TIMEOUT_MS,
  FALLBACK_NOTE: FALLBACK_NOTE,
  buildSummary: buildSummary,
  rulesPropose: rulesPropose,
  validateProposal: validateProposal,
  previewPayload: previewPayload,
  buildOllamaBody: buildOllamaBody,
  promptFor: promptFor,
  pickLocalModel: pickLocalModel,
  pickFlashModel: pickFlashModel,
  propose: propose,
  capabilities: capabilities,
  fmtClock: fmtClock,
  parseClock: parseClock
};
