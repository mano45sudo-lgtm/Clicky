const path = require('path');

// Load clicky-mvp/.env if present (no crash if missing). The .env is only a
// seed; the live source of truth is the persistent store (Settings window).
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (e) {
  // dotenv is optional at runtime; fall back to process.env only.
}

const store = require('./store');

function s() {
  return store.read();
}

function forcedMock() {
  return process.env.CLICKY_MOCK === '1';
}

// Resolve the active LLM provider from settings + key presence.
function llmProvider() {
  const st = s();
  if (forcedMock() || st.provider === 'mock') return 'mock';
  if (st.provider === 'gemini') return st.geminiApiKey ? 'gemini' : 'mock';
  if (st.provider === 'anthropic') return st.anthropicApiKey ? 'anthropic' : 'mock';
  if (st.provider === 'sarvam') return st.sarvamApiKey ? 'sarvam' : 'mock';
  if (st.provider === 'groq') return st.groqApiKey ? 'groq' : 'mock';
  // auto-detect when provider unset
  if (st.groqApiKey) return 'groq';
  if (st.geminiApiKey) return 'gemini';
  if (st.anthropicApiKey) return 'anthropic';
  if (st.sarvamApiKey) return 'sarvam';
  return 'mock';
}

function sttProvider() {
  const st = s();
  if (forcedMock() || st.sttProvider === 'mock') return 'mock';
  if (st.sttProvider === 'assemblyai') return st.assemblyaiApiKey ? 'assemblyai' : 'os';
  if (st.sttProvider === 'sarvam') return st.sarvamApiKey ? 'sarvam' : 'os';
  return 'os';
}

function ttsProvider() {
  const st = s();
  if (forcedMock() || st.ttsProvider === 'mock') return 'mock';
  if (st.ttsProvider === 'elevenlabs') return st.elevenlabsApiKey ? 'elevenlabs' : 'os';
  if (st.ttsProvider === 'sarvam') return st.sarvamApiKey ? 'sarvam' : 'os';
  return 'os';
}

module.exports = {
  store,
  get settings() {
    return s();
  },

  llmProvider,
  sttProvider,
  ttsProvider,
  isMock: () => llmProvider() === 'mock',

  // Convenience getters (live, read from the store each access).
  get provider() {
    return llmProvider();
  },
  get mockMode() {
    return llmProvider() === 'mock';
  },
  get geminiApiKey() {
    return s().geminiApiKey;
  },
  get anthropicApiKey() {
    return s().anthropicApiKey;
  },
  get sarvamApiKey() {
    return s().sarvamApiKey;
  },
  get groqApiKey() {
    return s().groqApiKey;
  },
  get geminiModel() {
    return s().geminiModel;
  },
  get groqModel() {
    return s().groqModel;
  },
  get anthropicModel() {
    return s().anthropicModel;
  },
  get sarvamModel() {
    return s().sarvamModel;
  },
  get model() {
    const p = llmProvider();
    if (p === 'groq') return s().groqModel;
    if (p === 'gemini') return s().geminiModel;
    if (p === 'sarvam') return s().sarvamModel;
    return s().anthropicModel;
  },
  get voice() {
    return s().voice;
  },
  get language() {
    return s().language;
  },
  get sttTimeoutMs() {
    return s().sttTimeoutMs;
  },
  get maxAnswerChars() {
    return s().maxAnswerChars;
  },
  get hotkeyUiohookKeycode() {
    return s().pttKeycode;
  }
};
