const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');

let current = null;

function cancel() {
  if (current) {
    try { current.kill(); } catch (e) {}
    current = null;
  }
}

// ElevenLabs text-to-speech: HTTP synth to mp3, play via an available native
// player. Falls back to OS-native TTS on failure.
async function speak(text) {
  cancel();
  const clean = (text || '').trim();
  if (!clean) return;

  const st = config.settings;
  const voiceId = st.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM';

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': st.elevenlabsApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean })
      }
    );
    if (!res.ok) throw new Error('ElevenLabs HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());

    const file = path.join(os.tmpdir(), `clicky-tts-${Date.now()}.mp3`);
    fs.writeFileSync(file, buf);

    await playFile(file);
    try { fs.unlinkSync(file); } catch (e) {}
  } catch (e) {
    console.error('[tts-11l] falling back to OS voice:', e.message);
    require('./tts-os').speak(clean);
  }
}

function playFile(file) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') {
      // PowerShell MediaPlayer waits until the clip finishes.
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
      console.error('[tts-11l] player unavailable:', e.message);
      if (current === p) current = null;
      resolve();
    });
  });
}

module.exports = { speak, cancel };
