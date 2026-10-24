const FIELDS = [
  'provider', 'geminiApiKey', 'anthropicApiKey', 'sarvamApiKey', 'groqApiKey', 'geminiModel', 'anthropicModel', 'sarvamModel', 'groqModel',
  'sttProvider', 'ttsProvider', 'assemblyaiApiKey', 'elevenlabsApiKey', 'elevenlabsVoiceId',
  'sarvamSttModel', 'sarvamTtsModel', 'sarvamSpeaker',
  'voice', 'language', 'pttKeycode', 'toggleShortcut', 'conversationShortcut', 'vadSilenceMs', 'agentShortcut',
  'webSearchProvider', 'serperApiKey', 'braveApiKey',
  'maxAnswerChars', 'sttTimeoutMs'
];
const CHECKS = ['agentAllowFileWrites', 'agentAllowAppLaunch', 'agentAllowRunCommand', 'multiMonitor', 'allowAnalytics'];
const NUMBERS = ['pttKeycode', 'maxAnswerChars', 'sttTimeoutMs', 'vadSilenceMs'];

const msg = document.getElementById('msg');
const $ = (id) => document.getElementById(id);

function applyToForm(s) {
  FIELDS.forEach((f) => { if ($(f)) $(f).value = s[f] == null ? '' : s[f]; });
  CHECKS.forEach((f) => { if ($(f)) $(f).checked = Boolean(s[f]); });
}

function collect() {
  const out = {};
  FIELDS.forEach((f) => { if ($(f)) out[f] = $(f).value; });
  CHECKS.forEach((f) => { if ($(f)) out[f] = $(f).checked; });
  NUMBERS.forEach((f) => { if (out[f] != null) out[f] = Number(out[f]) || 0; });
  return out;
}

async function load() {
  const s = await window.clicky.settingsGet();
  applyToForm(s);
}

async function save() {
  msg.textContent = 'Saving...';
  const saved = await window.clicky.settingsSave(collect());
  applyToForm(saved);
  msg.textContent = 'Saved.';
  setTimeout(() => (msg.textContent = ''), 2500);
}

document.getElementById('save').onclick = save;
document.getElementById('reset').onclick = async () => {
  await save();
};

if (window.clicky) load();
