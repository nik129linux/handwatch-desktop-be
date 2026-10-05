/* ai/store.js — MAIN PROCESS file. Real persistence for Retoma events.
 * File lives at app.getPath('userData')/events.json. Retention is 7 days,
 * enforced on load and on an hourly timer in main.js. Pure helpers here so
 * unit tests can drive them without Electron. */
'use strict';

var path = require('path');

var RETENTION_MS = 7 * 24 * 3600 * 1000;
var STORE_VERSION = 1;

function eventsPath(userDataDir) {
  return path.join(userDataDir, 'events.json');
}

/* Per-mode stores: Live reads ONLY live events, Demo ONLY demo events.
 * No silent migration: a fresh mode starts empty, old events.json is left alone. */
function eventsPathFor(userDataDir, mode) {
  var m = mode === 'live' ? 'live' : 'demo';
  return path.join(userDataDir, 'events-' + m + '.json');
}

function eventTime(ev) {
  if (!ev || typeof ev !== 'object') return NaN;
  var t = Date.parse(ev.ts || ev.savedAt || '');
  return t;
}

/* Drop anything older than 7 days. Events without a date are kept. */
function pruneEvents(events, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  return (events || []).filter(function (ev) {
    var t = eventTime(ev);
    if (isNaN(t)) return true;
    return now - t <= RETENTION_MS;
  });
}

function loadEventsFile(fsImpl, filePath, nowMs) {
  var raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { version: STORE_VERSION, events: [] };
  }
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { version: STORE_VERSION, events: [] };
  }
  var events = Array.isArray(data) ? data : (data.events || []);
  return { version: STORE_VERSION, events: pruneEvents(events, nowMs) };
}

function saveEventsFile(fsImpl, filePath, events, nowMs) {
  var pruned = pruneEvents(events, nowMs);
  var data = { version: STORE_VERSION, savedAt: new Date().toISOString(), events: pruned };
  fsImpl.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return pruned;
}

function deleteEventsFile(fsImpl, filePath) {
  try {
    fsImpl.unlinkSync(filePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
}

/* Accepted habit experiments persist per mode with the same 7-day
 * retention, delete-all and export behaviour as the events store. */
function experimentsPathFor(userDataDir, mode) {
  var m = mode === 'live' ? 'live' : 'demo';
  return path.join(userDataDir, 'experiments-' + m + '.json');
}

function expTime(exp) {
  if (!exp || typeof exp !== 'object') return NaN;
  return Date.parse(exp.createdAt || '');
}

function pruneExperiments(exps, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  return (exps || []).filter(function (exp) {
    var t = expTime(exp);
    if (isNaN(t)) return true;
    return now - t <= RETENTION_MS;
  });
}

function loadExperimentsFile(fsImpl, filePath, nowMs) {
  var raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (e) {
    return [];
  }
  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  var exps = Array.isArray(data) ? data : (data.experiments || []);
  return pruneExperiments(exps, nowMs);
}

function saveExperimentsFile(fsImpl, filePath, exps, nowMs) {
  var pruned = pruneExperiments(exps, nowMs);
  var data = { version: STORE_VERSION, savedAt: new Date().toISOString(), experiments: pruned };
  fsImpl.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return pruned;
}

function serializeExperiments(exps) {
  return JSON.stringify({ version: STORE_VERSION, exportedAt: new Date().toISOString(), experiments: exps || [] }, null, 2);
}

function serialize(events) {
  return JSON.stringify({ version: STORE_VERSION, exportedAt: new Date().toISOString(), events: events || [] }, null, 2);
}

module.exports = {
  RETENTION_MS: RETENTION_MS,
  eventsPath: eventsPath,
  eventsPathFor: eventsPathFor,
  pruneEvents: pruneEvents,
  loadEventsFile: loadEventsFile,
  saveEventsFile: saveEventsFile,
  deleteEventsFile: deleteEventsFile,
  serialize: serialize,
  experimentsPathFor: experimentsPathFor,
  pruneExperiments: pruneExperiments,
  loadExperimentsFile: loadExperimentsFile,
  saveExperimentsFile: saveExperimentsFile,
  serializeExperiments: serializeExperiments
};
