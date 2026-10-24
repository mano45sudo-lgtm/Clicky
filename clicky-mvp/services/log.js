const fs = require('fs');
const path = require('path');

// Tiny structured file logger for the main process. This is how we diagnose
// "it's not working" without watching the screen: every plan, tool result and
// input-driver action is appended to clicky.log (rotates once at 5MB). It also
// mirrors to the console so `npm start` output stays useful.
let file = null;
let ready = false;
const MAX_BYTES = 5 * 1024 * 1024;

function init(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    file = path.join(logDir, 'clicky.log');
    ready = true;
    write('info', 'log', 'session start', { file });
  } catch (e) {
    ready = false;
    console.error('[log] init failed', e.message);
  }
}

function ts() {
  return new Date().toISOString();
}

function write(level, tag, msg, extra) {
  let s = `${ts()} ${level.toUpperCase()} [${tag}] ${msg}`;
  if (extra !== undefined) {
    try {
      s += ' :: ' + JSON.stringify(extra);
    } catch (e) {
      s += ' :: [unserializable]';
    }
  }
  if (ready) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        const old = file + '.1';
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(file, old);
      }
      fs.appendFileSync(file, s + '\n', 'utf8');
    } catch (e) {
      /* never let logging break the app */
    }
  }
  const c = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  c(s);
}

module.exports = {
  init,
  info: (tag, msg, extra) => write('info', tag, msg, extra),
  warn: (tag, msg, extra) => write('warn', tag, msg, extra),
  error: (tag, msg, extra) => write('error', tag, msg, extra)
};
