const config = require('../config');
const win = require('./stt-win');
const assemblyai = require('./assemblyai');
const whisper = require('./stt-whisper');

// Transcribe a PCM 16-bit mono WAV buffer to text using the active provider.
async function transcribe(buffer) {
  const provider = config.sttProvider();
  if (provider === 'mock') return '[mock voice input] what is on my screen?';

  if (provider === 'whisper') {
    try {
      return await whisper.transcribe(buffer);
    } catch (e) {
      console.error('[stt] Whisper failed, falling back to OS:', e.message);
    }
  }

  if (provider === 'assemblyai') {
    try {
      return await assemblyai.transcribe(buffer);
    } catch (e) {
      console.error('[stt] AssemblyAI failed, falling back to OS:', e.message);
    }
  }

  // 'os'
  if (process.platform === 'win32') return win.transcribe(buffer);

  console.warn('[stt] no built-in offline STT on ' + process.platform + '; enable AssemblyAI in Settings.');
  return '';
}

module.exports = { transcribe };
