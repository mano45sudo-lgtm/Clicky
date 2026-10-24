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
  if (st.provider === 'groq') return st.groqApiKey ? 'groq' : 'mock';
  // auto-detect when provider unset
  if (st.groqApiKey) return 'groq';
  if (st.geminiApiKey) return 'gemini';
  if (st.anthropicApiKey) return 'anthropic';
  return 'mock';
}

// The provider that actually LOOKS at screenshots. Groq is text-only, so
// every screen-aware answer and the walkthrough pointing path route here. It
// auto-picks a vision-capable provider that has a key, and falls back to the text
// brain (which then honestly notes it cannot see) when no vision key is present.
function visionProvider() {
  const st = s();
  if (forcedMock() || st.provider === 'mock') return 'mock';
  const pref = (st.visionProvider || process.env.CLICKY_VISION || '').toLowerCase();
  const hasKey = (p) => (p === 'gemini' ? !!st.geminiApiKey : p === 'anthropic' ? !!st.anthropicApiKey : false);
  if (pref && hasKey(pref)) return pref;
  if (st.geminiApiKey) return 'gemini';
  if (st.anthropicApiKey) return 'anthropic';
  return llmProvider();
}

function sttProvider() {
  const st = s();
  if (forcedMock() || st.sttProvider === 'mock') return 'mock';
  if (st.sttProvider === 'whisper') return 'whisper'; // binary/model checked at call time, falls back to OS
  if (st.sttProvider === 'assemblyai') return st.assemblyaiApiKey ? 'assemblyai' : 'os';
  return 'os';
}

function ttsProvider() {
  const st = s();
  if (forcedMock() || st.ttsProvider === 'mock') return 'mock';
  if (st.ttsProvider === 'fishaudio') {
    // Usable either self-hosted (any base URL) or hosted (API key + model id);
    // with neither configured we stay on the reliable OS voice.
    return st.fishAudioBaseUrl || (st.fishAudioApiKey && st.fishAudioModelId) ? 'fishaudio' : 'os';
  }
  return 'os';
}

module.exports = {
  store,
  get settings() {
    return s();
  },

  llmProvider,
  visionProvider,
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
  get model() {
    const p = llmProvider();
    if (p === 'groq') return s().groqModel;
    if (p === 'gemini') return s().geminiModel;
    return s().anthropicModel;
  },
  get voice() {
    return s().voice;
  },
  get whisperCliPath() {
    return s().whisperCliPath;
  },
  get whisperModelPath() {
    return s().whisperModelPath;
  },
  get whisperLanguage() {
    return s().whisperLanguage;
  },
  get fishAudioApiKey() {
    return s().fishAudioApiKey;
  },
  get fishAudioBaseUrl() {
    return s().fishAudioBaseUrl;
  },
  get fishAudioModelId() {
    return s().fishAudioModelId;
  },
  get fishAudioReferenceId() {
    return s().fishAudioReferenceId;
  },
  get fishAudioFormat() {
    return s().fishAudioFormat;
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
