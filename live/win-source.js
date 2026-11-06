// live/win-source.js — MAIN PROCESS module. Tracks the real foreground
// window and idle time on Windows by spawning a small PowerShell probe
// (user32 GetForegroundWindow/GetLastInputInfo). No npm deps; IO injectable.
'use strict';

var DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000];

function defaultBackoffMs(attempt) {
  if (attempt < 1) attempt = 1;
  if (attempt > DEFAULT_BACKOFF.length) return DEFAULT_BACKOFF[DEFAULT_BACKOFF.length - 1];
  return DEFAULT_BACKOFF[attempt - 1];
}

// Parse one probe output line. Returns
// { type:'focus', appId, appName, title } or { type:'idle', ms } or null.
function parseWinLine(line) {
  try {
    if (typeof line !== 'string') return null;
    var s = line.trim();
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1).trim();
    if (!s) return null;
    var obj = JSON.parse(s);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.t === 'focus') {
      if (typeof obj.exe !== 'string' || typeof obj.name !== 'string' || typeof obj.title !== 'string') return null;
      var name = obj.name === '' ? obj.exe : obj.name;
      return { type: 'focus', appId: obj.exe.toLowerCase(), appName: name, title: obj.title };
    }
    if (obj.t === 'idle') {
      if (typeof obj.ms !== 'number' || !isFinite(obj.ms) || obj.ms < 0) return null;
      return { type: 'idle', ms: obj.ms };
    }
    return null;
  } catch (e) {
    return null;
  }
}

var PS_SCRIPT = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class RetomaWin {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '}',
  '"@',
  '',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$lastHwnd = [IntPtr]::Zero',
  '$lastTitle = $null',
  '$idleCounter = 0',
  'while ($true) {',
  '  $hwnd = [RetomaWin]::GetForegroundWindow()',
  '  $title = $null',
  '  if ($hwnd -ne [IntPtr]::Zero) {',
  '    $sb = New-Object System.Text.StringBuilder 512',
  '    [void][RetomaWin]::GetWindowText($hwnd, $sb, 512)',
  '    $title = $sb.ToString()',
  '  }',
  '  if ($hwnd -ne [IntPtr]::Zero -and ($hwnd -ne $lastHwnd -or $title -ne $lastTitle)) {',
  '    $lastHwnd = $hwnd',
  '    $lastTitle = $title',
  '    $procId = 0',
  '    [void][RetomaWin]::GetWindowThreadProcessId($hwnd, [ref]$procId)',
  '    $exe = \'\'',
  '    $name = \'\'',
  '    try {',
  '      $p = [System.Diagnostics.Process]::GetProcessById($procId)',
  '      $exe = $p.ProcessName',
  '      try { $name = $p.MainModule.FileVersionInfo.FileDescription } catch { $name = \'\' }',
  '      if (-not $name) { $name = \'\' }',
  '    } catch {',
  '      $exe = \'\'',
  '      $name = \'\'',
  '    }',
  '    $line = @{ t = \'focus\'; exe = $exe; name = $name; title = $title } | ConvertTo-Json -Compress',
  '    [Console]::WriteLine($line)',
  '    [Console]::Out.Flush()',
  '  }',
  '  $idleCounter++',
  '  if ($idleCounter -ge 5) {',
  '    $idleCounter = 0',
  '    $lii = New-Object RetomaWin+LASTINPUTINFO',
  '    $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)',
  '    [void][RetomaWin]::GetLastInputInfo([ref]$lii)',
  '    $now = [int64]([Environment]::TickCount) -band 0xFFFFFFFFL',
  '    $idleMs = $now - [int64]$lii.dwTime',
  '    if ($idleMs -lt 0) { $idleMs = $idleMs + 4294967296L }',
  '    $line = @{ t = \'idle\'; ms = [long]$idleMs } | ConvertTo-Json -Compress',
  '    [Console]::WriteLine($line)',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Seconds 1',
  '}'
].join('\n');

function psArgs() {
  var enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc];
}

function defaultSpawn(cmd, args, opts) {
  return require('child_process').spawn(cmd, args, opts);
}

// createWinSources({ spawn, timer, backoffMs })
function createWinSources(opts) {
  opts = opts || {};
  var spawn = opts.spawn || defaultSpawn;
  var timer = opts.timer || { setTimeout: setTimeout, clearTimeout: clearTimeout };
  var backoffMs = opts.backoffMs || defaultBackoffMs;

  var listenersFocus = [];
  var listenersIdle = [];
  var proc = null;
  var buf = '';
  var retryId = null;
  var runningCount = 0;
  var stopped = true;
  var attempts = 0;
  var currentStatus = 'error';

  function setStatus(s) { currentStatus = s; }

  function emitFocus(focus) {
    listenersFocus.slice().forEach(function (fn) {
      try { fn(focus); } catch (e) { /* listener bugs must not kill the stream */ }
    });
  }

  function emitIdle(ms) {
    listenersIdle.slice().forEach(function (fn) {
      try { fn(ms); } catch (e) { /* listener bugs must not kill the stream */ }
    });
  }

  function scheduleRetry() {
    if (stopped) return;
    attempts++;
    var ms = (typeof backoffMs === 'function') ? backoffMs(attempts) : backoffMs;
    if (retryId) timer.clearTimeout(retryId);
    retryId = timer.setTimeout(function () {
      retryId = null;
      if (!stopped) boot();
    }, ms);
  }

  function spawnChild() {
    buf = '';
    var child;
    try {
      child = spawn('powershell.exe', psArgs(), { windowsHide: true });
    } catch (e) {
      setStatus('error');
      scheduleRetry();
      return;
    }
    proc = child;
    if (child.stdout && child.stdout.on) {
      child.stdout.on('data', function (chunk) {
        buf += String(chunk);
        var lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(function (line) {
          var parsed = parseWinLine(line);
          if (parsed) {
            attempts = 0;
            setStatus('ready');
            if (parsed.type === 'focus') {
              emitFocus({ appId: parsed.appId, appName: parsed.appName, title: parsed.title });
            } else if (parsed.type === 'idle') {
              emitIdle(parsed.ms);
            }
          }
        });
      });
    }
    var onDeath = function () {
      if (proc !== child) return;
      proc = null;
      if (stopped) return;
      setStatus('error');
      scheduleRetry();
    };
    if (child.on) {
      child.on('close', onDeath);
      child.on('error', onDeath);
    }
  }

  function boot() {
    if (stopped) return;
    spawnChild();
  }

  function start() {
    if (runningCount === 0) {
      stopped = false;
      attempts = 0;
    }
    runningCount++;
    if (runningCount === 1) {
      boot();
    }
  }

  function stop() {
    if (runningCount > 0) runningCount--;
    if (runningCount === 0) {
      stopped = true;
      if (retryId) {
        timer.clearTimeout(retryId);
        retryId = null;
      }
      if (proc) {
        var p = proc;
        proc = null;
        try { p.kill(); } catch (e) { /* already dead */ }
      }
      setStatus('error');
    }
  }

  var focus = {
    start: start,
    stop: stop,
    onFocus: function (fn) {
      listenersFocus.push(fn);
      return function () {
        var ix = listenersFocus.indexOf(fn);
        if (ix !== -1) listenersFocus.splice(ix, 1);
      };
    },
    status: function () { return currentStatus; }
  };

  var idle = {
    start: start,
    stop: stop,
    onIdle: function (fn) {
      listenersIdle.push(fn);
      return function () {
        var ix = listenersIdle.indexOf(fn);
        if (ix !== -1) listenersIdle.splice(ix, 1);
      };
    },
    isRunning: function () { return runningCount > 0; }
  };

  return { focus: focus, idle: idle };
}

module.exports = {
  parseWinLine: parseWinLine,
  PS_SCRIPT: PS_SCRIPT,
  psArgs: psArgs,
  createWinSources: createWinSources
};
