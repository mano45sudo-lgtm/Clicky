const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const SCRIPT = path.join(__dirname, '..', 'assets', 'stt.ps1');

// Transcribe a PCM 16-bit mono WAV buffer via Windows SAPI (file mode).
function transcribe(buffer) {
  const file = path.join(os.tmpdir(), `clicky-${crypto.randomBytes(6).toString('hex')}.wav`);
  try {
    fs.writeFileSync(file, buffer);
  } catch (e) {
    console.error('[stt-win] write tmp failed', e.message);
    return Promise.resolve('');
  }

  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(file); } catch (e) {}
      resolve(v);
    };

    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Path', file],
      { windowsHide: true }
    );

    const timer = setTimeout(() => {
      try { ps.kill(); } catch (e) {}
      finish(out.trim());
    }, (config.sttTimeoutMs || 8000) + 6000);

    ps.stdout.on('data', (b) => { out += b.toString(); });
    ps.stderr.on('data', (b) => console.error('[stt-win]', b.toString().trim()));
    ps.on('close', () => { clearTimeout(timer); finish(out.trim()); });
    ps.on('error', (e) => { clearTimeout(timer); console.error('[stt-win]', e.message); finish(''); });
  });
}

module.exports = { transcribe };
