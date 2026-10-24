// Provider facade (the `providers.js` seam from the plan). All calls resolve the
// active implementation from Settings at call time, so changes take effect live.
const llm = require('./llm');
const stt = require('./stt');
const tts = require('./tts');

module.exports = {
  llm: {
    answer: (opts) => llm.answer(opts),
    chat: (opts) => llm.chat(opts),
    json: (opts) => llm.json(opts)
  },
  stt: {
    transcribe: (buffer) => stt.transcribe(buffer)
  },
  tts: {
    speak: (text) => tts.speak(text),
    cancel: () => tts.cancel()
  }
};
