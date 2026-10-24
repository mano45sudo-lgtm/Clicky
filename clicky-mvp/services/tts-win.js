const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');

const SCRIPT = path.join(__dirname, '..', 'assets', 'tts.ps1');

let current = null;

function cancel() {
  if (current) {
    try { current.kill(); } catch (e) {}
    current = null;
  }
}

// Windows SAPI text-to-speech. A new speak() cancels any in-flight utterance.
function speak(text) {
  cancel();
  const clean = (text || '').trim();
  if (!clean) return Promise.resolve();

  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
    if (config.voice) args.push('-Voice', config.voice);
    args.push('-Text', clean);

    const ps = spawn('powershell.exe', args, { windowsHide: true });
    current = ps;
    ps.stderr.on('data', (b) => console.error('[tts-win]', b.toString().trim()));
    ps.on('close', () => { if (current === ps) current = null; resolve(); });
    ps.on('error', (e) => {
      console.error('[tts-win] spawn failed', e.message);
      if (current === ps) current = null;
      resolve();
    });
  });
}

module.exports = { speak, cancel };
