const fs = require('fs');
const path = require('path');

// Persistent settings stored as JSON in userData. All API keys default to EMPTY
// strings - the user fills them in via the Settings window or .env.
let filePath = null;
let cached = null;

function defaults() {
  return {
    // --- Brain (LLM) ---
    provider: 'mock', // 'groq' | 'gemini' | 'anthropic' | 'mock'
    visionProvider: '', // '' = auto (pick a vision-capable key); or 'gemini' | 'anthropic'
    geminiApiKey: '',
    anthropicApiKey: '',
    groqApiKey: '',
    geminiModel: 'gemini-3.5-flash',
    anthropicModel: 'claude-3-5-sonnet-latest',
    groqModel: 'openai/gpt-oss-120b',

    // --- Speech ---
    sttProvider: 'whisper', // 'whisper' (local, open source) | 'os' | 'assemblyai' | 'mock'
    ttsProvider: 'fishaudio', // 'fishaudio' (open source) | 'os' | 'mock'
    assemblyaiApiKey: '',
    // Local Whisper (whisper.cpp). Leave paths blank to auto-detect in PATH
    // and ./models; set them in Settings if the binary lives elsewhere.
    whisperCliPath: '', // e.g. C:\whisper\whisper-cli.exe
    whisperModelPath: '', // e.g. C:\whisper\models\ggml-base.en.bin
    whisperLanguage: 'en', // 'auto' to detect
    // Fish Audio TTS. Point Base URL at a self-hosted Fish Speech server
    // (e.g. http://localhost:8080) for the fully open-source path, or use a
    // fish.audio API key + model id for the hosted one. Neither set = OS voice.
    fishAudioApiKey: '',
    fishAudioBaseUrl: '',
    fishAudioModelId: '',
    fishAudioReferenceId: '',
    fishAudioFormat: 'mp3',
    voice: '', // named OS voice ("" = system default)
    language: 'en-US',

    // --- Interaction / hotkeys ---
    pttKeycode: 29, // uiohook keycode; 29 = Left Ctrl (hold to talk)
    toggleShortcut: 'Alt+\\', // open/focus the assistant + agent panel
    conversationShortcut: 'Alt+V', // start/stop hands-free conversation
    agentShortcut: 'Alt+G', // start a Clicky Agent task
    agentWakePhrase: 'clicky agent',
    handsFree: true, // conversation uses voice-activity detection (no hold)
    vadSilenceMs: 900, // stop an utterance after this much trailing silence

    // --- Agent ---
    agentAllowFileWrites: true,
    agentAllowAppLaunch: true,
    agentAllowRunCommand: true, // run shell commands (the most powerful lever)
    agentAllowInput: true, // move the real mouse + type (the hands-on lever)
    agentConfirmDestructive: true, // ask before Send / Delete / Pay / destructive commands
    agentPreviewMode: false, // narrate the plan only, never execute it
    agentAllowlist: '', // comma phrases that skip the confirm (e.g. a test inbox)
    stopShortcut: 'Escape', // global STOP that cancels the running agent
    webSearchProvider: 'none', // 'serper' | 'brave' | 'none'
    serperApiKey: '',
    braveApiKey: '',

    // --- Misc / feel ---
    maxAnswerChars: 320,
    sttTimeoutMs: 8000,
    multiMonitor: true,
    autostart: false, // launch HeyClicky when Windows signs in
    ttsConfirmations: true, // speak task outcomes + confirmations
    allowAnalytics: false,
    firstRunDone: false
  };
}

// Seed any blank values from environment variables (so .env still works).
function seedFromEnv(settings) {
  const e = process.env;
  if (e.GEMINI_API_KEY) { settings.geminiApiKey = e.GEMINI_API_KEY; if (settings.provider === 'mock') settings.provider = 'gemini'; }
  if (e.ANTHROPIC_API_KEY) { settings.anthropicApiKey = e.ANTHROPIC_API_KEY; if (settings.provider === 'mock') settings.provider = 'anthropic'; }
  if (e.GROQ_API_KEY) { settings.groqApiKey = e.GROQ_API_KEY; if (settings.provider === 'mock') settings.provider = 'groq'; }
  if (e.GROQ_MODEL) settings.groqModel = e.GROQ_MODEL;
  if (e.CLICKY_PROVIDER) settings.provider = e.CLICKY_PROVIDER.toLowerCase();
  if (e.CLICKY_VISION) settings.visionProvider = e.CLICKY_VISION.toLowerCase();
  if (e.CLICKY_ALLOW_INPUT) settings.agentAllowInput = e.CLICKY_ALLOW_INPUT === '1';
  if (e.STT_PROVIDER) settings.sttProvider = e.STT_PROVIDER.toLowerCase();
  if (e.TTS_PROVIDER) settings.ttsProvider = e.TTS_PROVIDER.toLowerCase();
  if (e.WHISPER_CLI) settings.whisperCliPath = e.WHISPER_CLI;
  if (e.WHISPER_MODEL) settings.whisperModelPath = e.WHISPER_MODEL;
  if (e.WHISPER_LANG) settings.whisperLanguage = e.WHISPER_LANG;
  if (e.FISH_AUDIO_API_KEY) settings.fishAudioApiKey = e.FISH_AUDIO_API_KEY;
  if (e.FISH_AUDIO_BASE_URL) settings.fishAudioBaseUrl = e.FISH_AUDIO_BASE_URL;
  if (e.FISH_AUDIO_MODEL) settings.fishAudioModelId = e.FISH_AUDIO_MODEL;
  if (e.FISH_AUDIO_REFERENCE) settings.fishAudioReferenceId = e.FISH_AUDIO_REFERENCE;
  if (e.GEMINI_MODEL) settings.geminiModel = e.GEMINI_MODEL;
  if (e.ANTHROPIC_MODEL) settings.anthropicModel = e.ANTHROPIC_MODEL;
  if (e.ASSEMBLYAI_API_KEY) { settings.assemblyaiApiKey = e.ASSEMBLYAI_API_KEY; settings.sttProvider = 'assemblyai'; }
  if (e.WEB_SEARCH_PROVIDER) settings.webSearchProvider = e.WEB_SEARCH_PROVIDER.toLowerCase();
  if (e.SERPER_API_KEY) { settings.serperApiKey = e.SERPER_API_KEY; settings.webSearchProvider = 'serper'; }
  if (e.BRAVE_API_KEY) { settings.braveApiKey = e.BRAVE_API_KEY; settings.webSearchProvider = 'brave'; }
  if (e.CLICKY_VOICE) settings.voice = e.CLICKY_VOICE;
  if (e.CLICKY_HOTKEY) settings.pttKeycode = Number(e.CLICKY_HOTKEY) || settings.pttKeycode;
  if (e.CONVERSATION_SHORTCUT) settings.conversationShortcut = e.CONVERSATION_SHORTCUT;
  if (e.VAD_SILENCE_MS) settings.vadSilenceMs = Number(e.VAD_SILENCE_MS) || settings.vadSilenceMs;
  return settings;
}

function init(userDataDir) {
  filePath = path.join(userDataDir, 'clicky-settings.json');
  cached = null;
  return read();
}

function read() {
  if (cached) return cached;
  const base = seedFromEnv(defaults());
  try {
    if (filePath && fs.existsSync(filePath)) {
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Re-apply env seeds after merging so an explicit .env key wins over a
      // blank value persisted on disk (env only overrides when it is set).
      cached = seedFromEnv(Object.assign(base, onDisk));
    } else {
      cached = base;
    }
  } catch (e) {
    console.error('[store] read failed, using defaults:', e.message);
    cached = base;
  }
  return cached;
}

function write(next) {
  cached = Object.assign(defaults(), seedFromEnv({}), next || {});
  try {
    if (filePath) fs.writeFileSync(filePath, JSON.stringify(cached, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
  return cached;
}

function patch(partial) {
  return write(Object.assign({}, read(), partial || {}));
}

function get(key) {
  return read()[key];
}

module.exports = { init, read, write, patch, get, defaults };
