const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

// Sarvam text-to-speech (Bulbul). POST JSON to /text-to-speech with the
// api-subscription-key header; the response carries base64 WAV in "audios".
// We decode, write a temp file, and play it with a native player. Falls back
// to OS-native TTS on any error.
const API = 'https://api.sarvam.ai/text-to-speech';

let current = null;

function cancel() {
  if (current) {
    try { current.kill(); } catch (e) {}
    current = null;
  }
}

// Bulbul supports a fixed Indian language set + en-IN. Map our UI language.
function langCode() {
  const l = (config.settings.language || 'en-IN').toLowerCase();
  if (l.startsWith('en')) return 'en-IN';
  const supported = ['bn-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN'];
  return supported.includes(l) ? l : 'en-IN';
}

async function speak(text) {
  cancel();
  const clean = (text || '').trim();
  if (!clean) return;

  const st = config.settings;
  const key = st.sarvamApiKey;
  if (!key) return require('./tts-os').speak(clean);

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        language_code: langCode(),
        speaker: st.sarvamSpeaker || 'shubh',
        model: st.sarvamTtsModel || 'bulbul:v3',
        output_audio_codec: 'wav'
      })
    });
    if (!res.ok) throw new Error('Sarvam TTS HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    const b64 = (data.audios && data.audios[0]) || '';
    if (!b64) throw new Error('Sarvam TTS: empty audio');

    const file = path.join(os.tmpdir(), `clicky-sarvam-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    await playFile(file);
    try { fs.unlinkSync(file); } catch (e) {}
  } catch (e) {
    console.error('[tts-sarvam] falling back to OS voice:', e.message);
    require('./tts-os').speak(clean);
  }
}

function playFile(file) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Add-Type -AssemblyName PresentationCore; $p=New-Object System.Windows.Media.MediaPlayer; ` +
        `$p.Open([uri]'${file}'); do{Start-Sleep -m 100}while($p.NaturalDuration.HasTimeSpan -eq $false); ` +
        `$p.Play(); do{Start-Sleep -m 100}while($p.Position -lt $p.NaturalDuration.TimeSpan); $p.Close()`
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
      console.error('[tts-sarvam] player unavailable:', e.message);
      if (current === p) current = null;
      resolve();
    });
  });
}

module.exports = { speak, cancel };
