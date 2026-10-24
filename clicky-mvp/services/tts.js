const config = require('../config');
const osTts = require('./tts-os');
const elevenlabs = require('./tts-elevenlabs');
const sarvam = require('./tts-sarvam');

// Speak text aloud using the active provider. Resolves when speech finishes.
async function speak(text) {
  const clean = (text || '').trim();
  if (!clean) return;

  const provider = config.ttsProvider();
  if (provider === 'mock') {
    // No audio in mock mode; just resolve so the state machine advances.
    return;
  }
  if (provider === 'elevenlabs') return elevenlabs.speak(clean);
  if (provider === 'sarvam') return sarvam.speak(clean);
  return osTts.speak(clean);
}

function cancel() {
  osTts.cancel();
  elevenlabs.cancel();
  sarvam.cancel();
}

module.exports = { speak, cancel };
