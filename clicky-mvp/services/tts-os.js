const { spawn } = require('child_process');
const config = require('../config');
const win = require('./tts-win');

let current = null;

function cancel() {
  if (current) {
    try { current.kill(); } catch (e) {}
    current = null;
  }
  win.cancel();
}

// Cross-platform OS-native text-to-speech.
function speak(text) {
  cancel();
  const clean = (text || '').trim();
  if (!clean) return Promise.resolve();

  if (process.platform === 'win32') return win.speak(clean);

  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'darwin') {
      cmd = 'say';
      args = clean ? [clean] : [];
    } else {
      cmd = 'espeak-ng';
      args = [clean];
    }
    const p = spawn(cmd, args);
    current = p;
    p.on('close', () => { if (current === p) current = null; resolve(); });
    p.on('error', (e) => {
      console.error('[tts-os]', cmd, 'unavailable:', e.message);
      if (current === p) current = null;
      resolve();
    });
  });
}

module.exports = { speak, cancel };
