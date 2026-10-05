/* live/installer.js — MAIN PROCESS module. Copies the helper GNOME Shell
 * extension from the app bundle to the user's extensions folder, only after
 * an explicit confirm (the renderer shows a native dialog first). IO is
 * injectable so tests run with a temp HOME and never touch the real one. */
'use strict';

var path = require('path');
var os = require('os');

var UUID = 'retoma-focus@retoma.local';
var FILES = ['extension.js', 'metadata.json'];
var ENABLE_COMMAND = 'gnome-extensions enable ' + UUID;
var DISABLE_COMMAND = 'gnome-extensions disable ' + UUID;

function sourceDir() {
  return path.join(__dirname, 'gnome-extension', UUID);
}

function homeDir(home) {
  return home || process.env.HOME || os.homedir();
}

function destDir(home) {
  return path.join(homeDir(home), '.local', 'share', 'gnome-shell', 'extensions', UUID);
}

/* What the native confirm dialog shows: exactly what is copied and where. */
function describeInstall(home) {
  return { files: FILES.slice(), from: sourceDir(), to: destDir(home) };
}

function installedFiles(fsImpl, home) {
  var dir = destDir(home);
  return FILES.filter(function (f) {
    try {
      fsImpl.accessSync(path.join(dir, f));
      return true;
    } catch (e) {
      return false;
    }
  });
}

function isInstalled(fsImpl, home) {
  return installedFiles(fsImpl, home).length === FILES.length;
}

/* install({ fs, home, confirm }): without confirm nothing is copied.
 * With confirm exactly the FILES above are copied, nothing else. */
function installHelper(opts) {
  opts = opts || {};
  var fsImpl = opts.fs || require('fs');
  var home = opts.home || homeDir();
  if (!opts.confirm) {
    return { copied: false, dest: destDir(home), files: [] };
  }
  var from = sourceDir();
  var to = destDir(home);
  fsImpl.mkdirSync(to, { recursive: true });
  FILES.forEach(function (f) {
    var src = fsImpl.readFileSync(path.join(from, f));
    fsImpl.writeFileSync(path.join(to, f), src);
  });
  return { copied: true, dest: to, files: FILES.slice() };
}

module.exports = {
  UUID: UUID,
  FILES: FILES.slice(),
  ENABLE_COMMAND: ENABLE_COMMAND,
  DISABLE_COMMAND: DISABLE_COMMAND,
  sourceDir: sourceDir,
  destDir: destDir,
  describeInstall: describeInstall,
  installedFiles: installedFiles,
  isInstalled: isInstalled,
  installHelper: installHelper
};
