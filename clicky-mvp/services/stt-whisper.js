const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Local, open-source speech-to-text via whisper.cpp (no cloud, audio never
// leaves the machine). We feed it the same 16 kHz mono PCM16 WAV the renderer
// records, which is exactly whisper's native format.
//
// Discovery, in order:
//   1. settings.whisperCliPath / settings.whisperModelPath (explicit, from Settings or .env)
//   2. whisper-cli / whisper / main on PATH, plus a ggml-*.bin next to it or in ./models
// If nothing is found we throw, and stt.js falls back to the OS voice with a
// one-time hint telling the user where to put the binary.

let hinted = false;

function which(name) {
  // Cheap PATH probe (win32: where.exe, posix: `which`).
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [name], { encoding: 'utf8' });
    if (r.status === 0) {
      for (const line of (r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        try {
          const st = fs.statSync(line);
          if (!st.isFile()) continue;
          // On Windows only accept a real executable, so `where main` cannot
          // accidentally match a project's main.js.
          if (process.platform === 'win32' && !/\.exe$/i.test(line)) continue;
          return line;
        } catch (e) {}
      }
    }
  } catch (e) {}
  return null;
}

function findCli() {
  const st = config.settings;
  if (st.whisperCliPath && fs.existsSync(st.whisperCliPath)) return st.whisperCliPath;
  for (const name of ['whisper-cli', 'whisper']) {
    const p = which(name);
    if (p) return p;
  }
  // Common install locations worth a peek.
  const guesses = [
    'C:\\whisper\\whisper-cli.exe',
    'C:\\whisper.cpp\\build\\bin\\whisper-cli.exe',
    path.join(os.homedir(), 'whisper', 'whisper-cli.exe')
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

function findModel(cliPath) {
  const st = config.settings;
  if (st.whisperModelPath && fs.existsSync(st.whisperModelPath)) return st.whisperModelPath;
  const dirs = [
    cliPath ? path.dirname(cliPath) : null,
    cliPath ? path.join(path.dirname(cliPath), 'models') : null,
    path.join(process.cwd(), 'models'),
    path.join(os.homedir(), '.cache', 'whisper')
  ].filter(Boolean);
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const bins = fs.readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f));
      if (!bins.length) continue;
      // Prefer a small English model, then any 'base', else the first ggml bin.
      const pick =
        bins.find((b) => /base.*en/.test(b)) ||
        bins.find((b) => /tiny.*en|base/.test(b)) ||
        bins.find((b) => /tiny/.test(b)) ||
        bins[0];
      return path.join(d, pick);
    } catch (e) {}
  }
  return null;
}

function missingHint() {
  if (hinted) return;
  hinted = true;
  console.error(
    '[stt-whisper] whisper.cpp not found. Download whisper-cli and a ggml model ' +
      '(e.g. ggml-base.en.bin), then set their paths in Settings > Voice, or add ' +
      'WHISPER_CLI / WHISPER_MODEL to .env. Falling back to the OS voice.'
  );
}

// Transcribe a WAV buffer to text. Throws when whisper is unavailable so the
// caller can fall back.
async function transcribe(buffer) {
  if (!buffer || !buffer.length) return '';
  const cli = findCli();
  const model = findModel(cli);
  if (!cli || !model) {
    missingHint();
    throw new Error('whisper.cpp not installed (missing ' + (!cli ? 'binary' : 'model') + ')');
  }

  const file = path.join(os.tmpdir(), `clicky-asr-${crypto.randomBytes(6).toString('hex')}.wav`);
  fs.writeFileSync(file, buffer);

  const lang = (config.settings.whisperLanguage || 'en').toLowerCase();
  const args = ['-m', model, '-f', file, '-nt', '-np'];
  if (lang && lang !== 'auto') args.push('-l', lang);

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try { fs.unlinkSync(file); } catch (e) {}
      fn(v);
    };

    const p = spawn(cli, args, { windowsHide: true });
    // Whisper on a short utterance is a few seconds; allow a generous window.
    const timer = setTimeout(() => {
      try { p.kill(); } catch (e) {}
      finish(reject, new Error('whisper timed out'));
    }, Math.max(20000, config.sttTimeoutMs + 15000));

    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { err += b.toString(); });
    p.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        return finish(reject, new Error('whisper exited ' + code + ': ' + err.slice(0, 160)));
      }
      // -np prints only the transcript; strip a possible whisper prefix marker.
      const text = out
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*>\s?/, '').trim())
        .filter((l) => l && !/\[00:/.test(l))
        .join(' ')
        .trim();
      finish(resolve, text);
    });
  });
}

module.exports = { transcribe, findCli, findModel };
