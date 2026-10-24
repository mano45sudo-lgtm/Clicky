const config = require('../config');

// Sarvam speech-to-text (Saaras). POST https://api.sarvam.ai/speech-to-text
// as multipart/form-data with the WAV in a "file" part. Auth is the
// api-subscription-key header. The renderer records 16kHz mono PCM16 WAV,
// which is the sample rate Sarvam works best with.
const API = 'https://api.sarvam.ai/speech-to-text';

// Map a BCP-47 UI language to a Sarvam-supported code (Sarvam uses en-IN).
function langCode() {
  const l = (config.settings.language || 'en-IN').toLowerCase();
  if (l.startsWith('en')) return 'en-IN';
  return l; // hi-IN, bn-IN, ta-IN, ... pass through
}

async function transcribe(buffer) {
  const key = config.settings.sarvamApiKey;
  if (!key) throw new Error('Sarvam STT: missing api key');
  if (!buffer || !buffer.length) return '';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', config.settings.sarvamSttModel || 'saaras:v4');
  form.append('language_code', langCode());

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: form
  });
  if (!res.ok) throw new Error('Sarvam STT HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.transcript || '').trim();
}

module.exports = { transcribe };
