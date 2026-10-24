const config = require('../config');

const API = 'https://api.assemblyai.com/v2';

// Transcribe a PCM WAV buffer: upload, submit, poll until complete.
async function transcribe(buffer) {
  const key = config.settings.assemblyaiApiKey;
  if (!key) return '';
  const headers = { authorization: key };

  const up = await fetch(`${API}/upload`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: buffer
  });
  const { upload_url } = await up.json();
  if (!upload_url) throw new Error('AssemblyAI upload failed');

  const submit = await fetch(`${API}/transcript`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url })
  });
  let t = await submit.json();

  const deadline = Date.now() + 30000;
  while (t.status !== 'completed' && t.status !== 'error' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    t = await (await fetch(`${API}/transcript/${t.id}`, { headers })).json();
  }

  return (t.text || '').trim();
}

module.exports = { transcribe };
