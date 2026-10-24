const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

// Fish Audio / Fish Speech text-to-speech (open source). Two supported modes:
//   • Self-hosted (the truly open-source path): set a Base URL pointing at a
//     running Fish Speech server, e.g. http://localhost:8080 -> POST /v1/tts.
//   • Hosted fish.audio: set an API key + model id -> POST
//     https://api.fish.audio/model/{modelId}.
// Both return raw audio bytes; we write a temp file and play it natively. On
// any problem we fall back to the OS voice so Clicky is never silent.

let current = null;

function cancel() {
  if (current) {
    try { current.kill(); } catch (e) {}
    current = null;
  }
}

function base() {
  const raw = (config.settings.fishAudioBaseUrl || '').trim().replace(/\/+$/, '');
  return raw || 'https://api.fish.audio';
}

function isSelfHosted() {
  return Boolean((config.settings.fishAudioBaseUrl || '').trim());
}

async function speak(text) {
  cancel();
  const clean = (text || '').trim();
  if (!clean) return;

  const st = config.settings;
  const format = (st.fishAudioFormat || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';

  let url, headers, body;
  if (isSelfHosted()) {
    // Open-source Fish Speech server API.
    url = base() + '/v1/tts';
    headers = { 'Content-Type': 'application/json' };
    if (st.fishAudioApiKey) headers.Authorization = 'Bearer ' + st.fishAudioApiKey;
    body = { text: clean, format, mp3_bitrate: 128 };
    if (st.fishAudioReferenceId) body.reference_id = st.fishAudioReferenceId;
  } else {
    // Hosted fish.audio. Needs a key + a model (voice) id.
    if (!st.fishAudioApiKey || !st.fishAudioModelId) {
      return require('./tts-os').speak(clean);
    }
    url = 'https://api.fish.audio/model/' + encodeURIComponent(st.fishAudioModelId);
    headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + st.fishAudioApiKey,
      model: 'speech-1.6'
    };
    body = { text: clean, format, mp3_bitrate: 128 };
    if (st.fishAudioReferenceId) body.reference_id = st.fishAudioReferenceId;
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('Fish Audio HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 180));
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('Fish Audio: empty audio');

    const file = path.join(os.tmpdir(), `clicky-fish-${Date.now()}.${format}`);
    fs.writeFileSync(file, buf);
    try {
      await playFile(file);
    } finally {
      try { fs.unlinkSync(file); } catch (e) {}
    }
  } catch (e) {
    console.error('[tts-fishaudio] falling back to OS voice:', e.message);
    require('./tts-os').speak(clean);
  }
}

// Play an audio file with a native player. The Windows MediaPlayer wait loops
// are BOUNDED (a fixed iteration cap) so a file that never reports a duration
// cannot hang the assistant.
function playFile(file) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; ' +
        `$p.Open([uri]'${file}'); ` +
        '$i = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $i -lt 50) { Start-Sleep -m 100; $i++ }; ' +
        'if ($p.NaturalDuration.HasTimeSpan) { $p.Play(); ' +
        '$total = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds; $s = 0; ' +
        'while ($p.Position -lt $p.NaturalDuration.TimeSpan -and $s -lt ($total + 1500)) { Start-Sleep -m 100; $s += 100 } }; ' +
        '$p.Close()'
      ];
    } else if (process.platform === 'darwin') {
      cmd = 'afplay';
      args = [file];
    } else {
      cmd = 'ffplay';
      args = ['-nodisp', '-autoexit', '-loglevel', 'quiet', file];
    }

    const p = spawn(cmd, args, { windowsHide: true });
    current = p;
    p.on('close', () => { if (current === p) current = null; resolve(); });
    p.on('error', (e) => {
      console.error('[tts-fishaudio] player unavailable:', e.message);
      if (current === p) current = null;
      resolve();
    });
  });
}

module.exports = { speak, cancel };
