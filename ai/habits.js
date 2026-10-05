/* ai/habits.js — PURE habit metrics + rules coach for the AI habit coach.
 * No network, no Electron, no fs here: persistence helpers for experiments
 * live in ai/store.js next to the events store. This file is UMD so the
 * renderer can reuse the same rules offline via <script src="ai/habits.js">.
 * Only aggregates (app names, minutes, counts) ever leave the process;
 * window titles and free text never enter the metrics. */
(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.Habits = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FOCUS_MIN = 25;
  var SWITCHES_PER_HOUR_HIGH = 6;
  var DISTRACTION_SHARE_HIGH = 0.35;
  var LATE_HOUR = 22;
  var BREAK_MIN = 10;
  var NOTE_MAX = 400;
  var ANSWER_MAX = 240;

  /* Apps counted as quick checks / browsing. Everything else counts as
   * main-task time. Matching is case-insensitive on the app label. */
  var DISTRACTION_APPS = [
    'whatsapp', 'browser', 'firefox', 'chrome', 'chromium', 'edge',
    'safari', 'messages', 'telegram', 'signal', 'instagram', 'tiktok',
    'twitter', 'facebook', 'youtube', 'reddit'
  ];

  var EXPERIMENT_METRICS = ['switchesPerHour', 'longest', 'lateNight', 'distractionShare'];

  var MEDICAL_WORDS = [
    'doctor', 'diagnos', 'disease', 'disorder', 'anxiety', 'depress',
    'insomnia', 'therapy', 'treatment', 'medicat', 'vitamin',
    'supplement', 'syndrome', 'clinical'
  ];

  var GUILT_WORDS = [
    'lazy', 'wasted', 'failure', 'shame', 'guilty', 'useless', 'worthless'
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fmtHM(date) {
    return date.getHours() + ':' + pad2(date.getMinutes());
  }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    if (s.length % 2 === 1) return s[mid];
    return Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function isDistraction(app) {
    return DISTRACTION_APPS.indexOf(String(app || '').toLowerCase()) !== -1;
  }

  function eventEndMs(ev) {
    if (!ev || typeof ev !== 'object') return NaN;
    var t = Date.parse(ev.ts || '');
    return t;
  }

  /* events: [{ app, duration (min), ts? }]. Returns null when there is
   * nothing tracked yet so the UI can show an empty state. */
  function computeMetrics(events, nowMs) {
    var now = nowMs === undefined ? Date.now() : nowMs;
    var list = (events || []).filter(function (e) {
      return e && typeof e.app === 'string' && e.app &&
        typeof e.duration === 'number' && isFinite(e.duration) && e.duration > 0;
    });
    if (!list.length) return null;
    var totalMinutes = 0;
    var perApp = {};
    var order = [];
    var durations = [];
    list.forEach(function (e) {
      totalMinutes += e.duration;
      if (!perApp[e.app]) { perApp[e.app] = 0; order.push(e.app); }
      perApp[e.app] += e.duration;
      durations.push(e.duration);
    });
    totalMinutes = Math.round(totalMinutes);
    var sorted = durations.slice().sort(function (a, b) { return a - b; });
    var longestMinutes = sorted[sorted.length - 1];
    var longestApp = list[0].app;
    list.forEach(function (e) {
      if (e.duration === longestMinutes && longestApp === list[0].app) longestApp = e.app;
    });
    var countLong = durations.filter(function (d) { return d >= FOCUS_MIN; }).length;
    var switches = Math.max(0, list.length - 1);
    var hours = totalMinutes / 60;
    var switchesPerHour = hours > 0 ? round1(switches / hours) : 0;
    var distractionMinutes = 0;
    var topDistraction = null;
    order.forEach(function (app) {
      if (isDistraction(app)) {
        distractionMinutes += perApp[app];
        if (!topDistraction || perApp[app] > perApp[topDistraction]) topDistraction = app;
      }
    });
    distractionMinutes = Math.round(distractionMinutes);
    var distractionShare = totalMinutes > 0
      ? Math.round((distractionMinutes / totalMinutes) * 1000) / 1000
      : 0;
    var mostUsedApp = order[0];
    order.forEach(function (app) {
      if (perApp[app] > perApp[mostUsedApp]) mostUsedApp = app;
    });
    /* Clock times from dated events only. ts marks the end of a block. */
    var timed = list.map(function (e) {
      var end = eventEndMs(e);
      if (isNaN(end)) return null;
      return { app: e.app, duration: e.duration, start: end - e.duration * 60000, end: end };
    }).filter(Boolean).sort(function (a, b) { return a.end - b.end; });
    var firstAt = null;
    var lastAt = null;
    var lateNight = false;
    if (timed.length) {
      firstAt = fmtHM(new Date(timed[0].start));
      var last = new Date(timed[timed.length - 1].end);
      lastAt = fmtHM(last);
      var h = last.getHours();
      lateNight = h >= LATE_HOUR || h < 5;
    }
    var gaps = [];
    for (var i = 1; i < timed.length; i++) {
      var gap = (timed[i].start - timed[i - 1].end) / 60000;
      if (gap >= 0) gaps.push(round1(gap));
    }
    var breakCount = gaps.filter(function (g) { return g >= BREAK_MIN; }).length;
    /* Trend across days with data (UTC days). */
    var dayTotals = {};
    timed.forEach(function (t) {
      var k = dayKey(t.end);
      dayTotals[k] = (dayTotals[k] || 0) + t.duration;
    });
    var days = Object.keys(dayTotals).sort();
    var trend = { days: days.length, current: null, previous: null, delta: 0, direction: 'unknown' };
    if (days.length >= 2) {
      var cur = Math.round(dayTotals[days[days.length - 1]]);
      var prev = Math.round(dayTotals[days[days.length - 2]]);
      var delta = cur - prev;
      trend = {
        days: days.length,
        current: cur,
        previous: prev,
        delta: delta,
        direction: delta === 0 || Math.abs(delta) < 5 ? 'flat' : (delta > 0 ? 'up' : 'down')
      };
    } else if (days.length === 1) {
      trend.current = Math.round(dayTotals[days[0]]);
    }
    return {
      totalMinutes: totalMinutes,
      count: list.length,
      perApp: perApp,
      order: order,
      longest: { app: longestApp, minutes: longestMinutes },
      median: median(durations),
      countLong: countLong,
      switchesPerHour: switchesPerHour,
      distractionMinutes: distractionMinutes,
      distractionShare: distractionShare,
      distractionPct: Math.round(distractionShare * 100),
      topDistraction: topDistraction,
      mostUsedApp: mostUsedApp,
      firstAt: firstAt,
      lastAt: lastAt,
      lateNight: lateNight,
      gaps: gaps,
      breakCount: breakCount,
      medianGap: median(gaps),
      longestGap: gaps.length ? Math.max.apply(null, gaps) : 0,
      trend: trend,
      computedAt: new Date(now).toISOString()
    };
  }

  function getMetricValue(metrics, key) {
    if (!metrics) return 0;
    if (key === 'switchesPerHour') return metrics.switchesPerHour;
    if (key === 'longest') return metrics.longest.minutes;
    if (key === 'lateNight') return metrics.lateNight ? 1 : 0;
    if (key === 'distractionShare') return metrics.distractionShare;
    return 0;
  }

  function pickPattern(metrics) {
    var scores = [
      {
        pattern: 'switches',
        score: metrics.switchesPerHour > SWITCHES_PER_HOUR_HIGH
          ? Math.min(1, metrics.switchesPerHour / 12)
          : 0
      },
      {
        pattern: 'focus',
        score: metrics.longest.minutes >= FOCUS_MIN
          ? 0
          : (FOCUS_MIN - metrics.longest.minutes) / FOCUS_MIN
      },
      { pattern: 'lateNight', score: metrics.lateNight ? 0.8 : 0 },
      {
        pattern: 'distraction',
        score: metrics.distractionShare > DISTRACTION_SHARE_HIGH ? metrics.distractionShare : 0
      }
    ];
    var best = scores[0];
    scores.forEach(function (s) {
      if (s.score > best.score) best = s;
    });
    return best.score > 0 ? best.pattern : 'steady';
  }

  /* Deterministic fallback: worst pattern wins, templated coaching note
   * plus one tiny experiment in implementation-intention form. */
  function rulesReport(metrics) {
    if (!metrics || !metrics.totalMinutes) return null;
    var pattern = pickPattern(metrics);
    var note = '';
    var exp = null;
    if (pattern === 'switches') {
      note = 'Many quick switches today (' + metrics.switchesPerHour +
        ' per hour across ' + metrics.count +
        ' blocks). Short single-app stretches can help ideas settle.';
      exp = {
        trigger: 'I finish a message check',
        action: 'keep one window open',
        minutes: 25,
        metric: 'switchesPerHour',
        target: SWITCHES_PER_HOUR_HIGH,
        direction: 'atMost'
      };
    } else if (pattern === 'focus') {
      note = 'No block reached ' + FOCUS_MIN + ' min yet (longest ' +
        metrics.longest.app + ' ' + metrics.longest.minutes +
        ' min). One longer stretch can move the main task forward.';
      exp = {
        trigger: 'I open my main task',
        action: 'stay with it',
        minutes: 25,
        metric: 'longest',
        target: FOCUS_MIN,
        direction: 'atLeast'
      };
    } else if (pattern === 'lateNight') {
      note = 'Last activity ran to ' + (metrics.lastAt || 'late') +
        '. A clear evening stop can protect tomorrow morning.';
      exp = {
        trigger: 'dinner ends',
        action: 'leave work windows closed',
        minutes: 30,
        metric: 'lateNight',
        target: 0,
        direction: 'atMost'
      };
    } else if (pattern === 'distraction') {
      note = 'Messages and browsing took ' + metrics.distractionPct +
        '% of tracked time (' + metrics.distractionMinutes +
        ' min). A short boundary can help the main task keep its turn.';
      exp = {
        trigger: 'I check messages',
        action: 'return to my main task',
        minutes: 25,
        metric: 'distractionShare',
        target: DISTRACTION_SHARE_HIGH,
        direction: 'atMost'
      };
    } else {
      note = 'Steady day: longest ' + metrics.longest.minutes + ' min in ' +
        metrics.longest.app + ' across ' + metrics.count +
        ' blocks. Small reps keep it going.';
      exp = {
        trigger: 'I start work',
        action: 'do one focused stretch',
        minutes: 25,
        metric: 'longest',
        target: FOCUS_MIN,
        direction: 'atLeast'
      };
    }
    exp.text = 'After ' + exp.trigger + ', I will ' + exp.action + ' for ' + exp.minutes + ' min.';
    return { pattern: pattern, note: note.slice(0, NOTE_MAX), experiment: exp };
  }

  function experimentLabel(exp) {
    if (!exp) return '';
    return 'After ' + exp.trigger + ', I will ' + exp.action + ' for ' + exp.minutes + ' min.';
  }

  /* Closed loop: measure an accepted experiment against fresh metrics. */
  function evaluateExperiment(exp, metrics) {
    if (!exp || !metrics) return null;
    var actual = getMetricValue(metrics, exp.metric);
    var followed = exp.direction === 'atLeast' ? actual >= exp.target : actual <= exp.target;
    var actualText = exp.metric === 'distractionShare'
      ? Math.round(actual * 100) + '%'
      : exp.metric === 'switchesPerHour'
        ? actual + '/h'
        : exp.metric === 'lateNight'
          ? (actual ? 'late' : 'on time')
          : actual + ' min';
    var targetText = exp.metric === 'distractionShare'
      ? Math.round(exp.target * 100) + '%'
      : exp.metric === 'switchesPerHour'
        ? exp.target + '/h'
        : exp.metric === 'lateNight'
          ? 'evening stop'
          : exp.target + ' min';
    return {
      status: followed ? 'followed' : 'not yet',
      actual: actual,
      target: exp.target,
      metric: exp.metric,
      text: ('Last try: ' + actualText + ' vs target ' + targetText +
        ' - ' + (followed ? 'followed' : 'not yet') + '.').slice(0, 200)
    };
  }

  /* --- validation + grounding (model output must pass both) --- */

  function validExperimentText(text) {
    return typeof text === 'string' &&
      /^After .+, I will .+ for \d+ min\.?$/.test(text) && text.length <= 200;
  }

  function validateReport(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.note !== 'string' || obj.note.length < 1 || obj.note.length > NOTE_MAX) return false;
    var e = obj.experiment;
    if (!e || typeof e !== 'object') return false;
    if (!validExperimentText(e.text)) return false;
    if (typeof e.trigger !== 'string' || !e.trigger) return false;
    if (typeof e.action !== 'string' || !e.action) return false;
    if (!Number.isInteger(e.minutes) || e.minutes < 5 || e.minutes > 120) return false;
    if (EXPERIMENT_METRICS.indexOf(e.metric) === -1) return false;
    if (typeof e.target !== 'number' || !isFinite(e.target)) return false;
    if (e.direction !== 'atLeast' && e.direction !== 'atMost') return false;
    return true;
  }

  function allowedNumbers(metrics) {
    var set = {};
    function add(n) {
      if (typeof n !== 'number' || !isFinite(n)) return;
      set[String(Math.round(n))] = true;
      set[String(Math.round(n * 10) / 10)] = true;
    }
    add(metrics.totalMinutes);
    add(metrics.count);
    add(metrics.longest.minutes);
    add(metrics.median);
    add(metrics.countLong);
    add(metrics.switchesPerHour);
    add(metrics.distractionMinutes);
    add(metrics.distractionPct);
    add(metrics.distractionShare);
    add(metrics.breakCount);
    add(metrics.medianGap);
    add(metrics.longestGap);
    Object.keys(metrics.perApp || {}).forEach(function (k) { add(metrics.perApp[k]); });
    (metrics.gaps || []).forEach(add);
    if (metrics.trend) {
      add(metrics.trend.current);
      add(metrics.trend.previous);
      add(metrics.trend.delta);
      add(Math.abs(metrics.trend.delta));
    }
    if (metrics.firstAt) metrics.firstAt.split(':').forEach(function (p) { add(Number(p)); });
    if (metrics.lastAt) metrics.lastAt.split(':').forEach(function (p) { add(Number(p)); });
    return set;
  }

  function integersIn(text) {
    var out = [];
    var m = String(text || '').match(/\d+(\.\d+)?/g) || [];
    m.forEach(function (raw) { out.push(Number(raw)); });
    return out;
  }

  function hasBannedWord(text, words) {
    var low = String(text || '').toLowerCase();
    return words.some(function (w) { return low.indexOf(w) !== -1; });
  }

  function mentionsUnknownApp(text, metrics) {
    var low = String(text || '').toLowerCase();
    var known = {};
    Object.keys(metrics.perApp || {}).forEach(function (k) { known[String(k).toLowerCase()] = true; });
    /* 'messages' stays generic coach vocabulary, not an app claim. */
    var universe = DISTRACTION_APPS.filter(function (a) { return a !== 'messages'; }).concat(
      ['document', 'spreadsheet', 'terminal', 'code', 'vscode', 'editor',
        'mail', 'calendar', 'notes', 'music', 'video', 'settings', 'files',
        'slack', 'discord', 'teams', 'zoom', 'spotify', 'photoshop',
        'netflix', 'gmail', 'outlook', 'excel', 'word', 'powerpoint',
        'github']
    );
    return universe.some(function (app) {
      if (known[app]) return false;
      return new RegExp('\\b' + app + 's?\\b').test(low);
    });
  }

  /* The note may only cite numbers present in the metrics and apps already
   * tracked; anything else (plus guilt language or medical claims) fails.
   * Small clock/day integers (0-31) and the coach thresholds (35, 100)
   * are always citable. */
  function groundedNote(note, metrics) {
    if (!metrics) return false;
    var allowed = allowedNumbers(metrics);
    var nums = integersIn(note);
    for (var i = 0; i < nums.length; i++) {
      var n = nums[i];
      var whole = Math.round(n);
      if (allowed[String(whole)] || allowed[String(Math.round(n * 10) / 10)]) continue;
      if (whole >= 0 && whole <= 31) continue;
      if (whole === 35 || whole === 100) continue;
      return false;
    }
    if (mentionsUnknownApp(note, metrics)) return false;
    if (hasBannedWord(note, MEDICAL_WORDS)) return false;
    if (hasBannedWord(note, GUILT_WORDS)) return false;
    return true;
  }

  function groundedReport(obj, metrics) {
    if (!metrics || !validateReport(obj)) return false;
    if (!groundedNote(obj.note, metrics)) return false;
    if (mentionsUnknownApp(obj.experiment.text, metrics) &&
        obj.experiment.metric !== 'lateNight') return false;
    if (hasBannedWord(obj.experiment.text, MEDICAL_WORDS)) return false;
    if (hasBannedWord(obj.experiment.text, GUILT_WORDS)) return false;
    return true;
  }

  /* --- Ask your day: rules fallback, grounded only --- */

  function clipAnswer(text) {
    return String(text).slice(0, ANSWER_MAX);
  }

  function rulesAsk(metrics, question) {
    if (!metrics || !metrics.totalMinutes) {
      return 'Nothing tracked yet - I cannot tell from this week.';
    }
    var q = String(question || '').toLowerCase();
    if (/longest|focus|block|stretch/.test(q)) {
      return clipAnswer('Your longest block was ' + metrics.longest.app + ' ' +
        metrics.longest.minutes + ' min (median ' + metrics.median + ' min).');
    }
    if (/switch|context|interrupt/.test(q)) {
      return clipAnswer(metrics.count + ' blocks, about ' + metrics.switchesPerHour +
        ' switches per hour.');
    }
    if (/whatsapp|browser|brows|message|checks|quick/.test(q)) {
      return clipAnswer('Messages and browsing: ' + metrics.distractionMinutes +
        ' min (' + metrics.distractionPct + '% of tracked time).');
    }
    if (/late|night|evening|first|last|morning|stop/.test(q)) {
      if (!metrics.firstAt) return 'No clock times stored yet.';
      return clipAnswer('First activity ' + metrics.firstAt + ', last ' + metrics.lastAt +
        (metrics.lateNight ? ' - last ran late.' : '.'));
    }
    if (/break|pause|gap|away/.test(q)) {
      return clipAnswer(metrics.breakCount + ' breaks of 10+ min (longest gap ' +
        metrics.longestGap + ' min).');
    }
    if (/trend|better|yesterday|week|progress|change/.test(q)) {
      if (!metrics.trend || metrics.trend.direction === 'unknown') {
        return 'Not enough days yet to compare trends.';
      }
      return clipAnswer('Tracked ' + metrics.trend.current + ' min recently vs ' +
        metrics.trend.previous + ' min before (' + metrics.trend.direction + ').');
    }
    if (/most|used|where|time|app/.test(q)) {
      return clipAnswer('Most-used app: ' + metrics.mostUsedApp + ' ' +
        metrics.perApp[metrics.mostUsedApp] + ' min of ' + metrics.totalMinutes + ' min tracked.');
    }
    return 'I cannot tell from the tracked time yet. Ask about your longest block, most-used app, or switches.';
  }

  function validateAnswer(obj) {
    if (typeof obj === 'string') return obj.length >= 1 && obj.length <= ANSWER_MAX;
    if (!obj || typeof obj !== 'object') return false;
    return typeof obj.answer === 'string' && obj.answer.length >= 1 && obj.answer.length <= ANSWER_MAX;
  }

  function groundedAnswer(answer, metrics) {
    if (!metrics) return false;
    var text = typeof answer === 'string' ? answer : answer.answer;
    if (!validateAnswer(text)) return false;
    if (/cannot tell|nothing tracked|not enough days|no clock times/i.test(text)) return true;
    if (!groundedNote(text, metrics)) return false;
    return true;
  }

  /* Prompt builders: aggregates only, never titles or free text
   * (the ask question itself travels only with consent). */
  function reportPrompt(metrics) {
    return 'You are a supportive habit coach. Read these usage aggregates ' +
      '(app minutes, focus blocks, switches, breaks) and reply with JSON only, ' +
      'exactly {"note":"max 400 chars, kind, no guilt, no medical claims",' +
      '"experiment":{"text":"After <trigger>, I will <action> for <N min>",' +
      '"trigger":"<trigger>","action":"<action>","minutes":N,' +
      '"metric":"switchesPerHour|longest|lateNight|distractionShare",' +
      '"target":N,"direction":"atLeast|atMost"}}. ' +
      'Cite only numbers and apps from these metrics: ' + JSON.stringify(metrics);
  }

  function askPrompt(metrics, question) {
    return 'Answer this question about PC usage using ONLY these aggregates. ' +
      'Reply with JSON only, exactly {"answer":"max 240 chars"}. ' +
      'If the metrics cannot answer it, reply {"answer":"I cannot tell from the tracked time yet. ' +
      'Ask about your longest block, most-used app, or switches."}. ' +
      'Question: ' + String(question || '').slice(0, 200) +
      ' Metrics: ' + JSON.stringify(metrics);
  }

  return {
    FOCUS_MIN: FOCUS_MIN,
    NOTE_MAX: NOTE_MAX,
    ANSWER_MAX: ANSWER_MAX,
    DISTRACTION_APPS: DISTRACTION_APPS.slice(),
    computeMetrics: computeMetrics,
    getMetricValue: getMetricValue,
    pickPattern: pickPattern,
    rulesReport: rulesReport,
    experimentLabel: experimentLabel,
    evaluateExperiment: evaluateExperiment,
    validateReport: validateReport,
    groundedNote: groundedNote,
    groundedReport: groundedReport,
    rulesAsk: rulesAsk,
    validateAnswer: validateAnswer,
    groundedAnswer: groundedAnswer,
    reportPrompt: reportPrompt,
    askPrompt: askPrompt
  };
}));
