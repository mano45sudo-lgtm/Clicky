const config = require('../config');
const osTts = require('./tts-os');
const fishaudio = require('./tts-fishaudio');

// Speak text aloud using the active provider. Resolves when speech finishes.
async function speak(text) {
  const clean = (text || '').trim();
  if (!clean) return;

  const provider = config.ttsProvider();
  if (provider === 'mock') {
    // No audio in mock mode; just resolve so the state machine advances.
    return;
  }
  if (provider === 'fishaudio') return fishaudio.speak(clean);
  return osTts.speak(clean);
}

function cancel() {
  osTts.cancel();
  fishaudio.cancel();
}

module.exports = { speak, cancel };
