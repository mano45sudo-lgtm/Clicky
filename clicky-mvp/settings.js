const FIELDS = [
  'provider', 'visionProvider', 'geminiApiKey', 'anthropicApiKey', 'groqApiKey', 'geminiModel', 'anthropicModel', 'groqModel',
  'sttProvider', 'ttsProvider', 'assemblyaiApiKey',
  'whisperCliPath', 'whisperModelPath', 'whisperLanguage',
  'fishAudioApiKey', 'fishAudioBaseUrl', 'fishAudioModelId', 'fishAudioReferenceId',
  'voice', 'language', 'pttKeycode', 'toggleShortcut', 'conversationShortcut', 'vadSilenceMs', 'agentShortcut',
  'stopShortcut', 'agentAllowlist',
  'webSearchProvider', 'serperApiKey', 'braveApiKey',
  'maxAnswerChars', 'sttTimeoutMs'
];
const CHECKS = ['agentAllowFileWrites', 'agentAllowAppLaunch', 'agentAllowRunCommand', 'agentAllowInput', 'agentConfirmDestructive', 'agentPreviewMode', 'multiMonitor', 'ttsConfirmations', 'autostart', 'allowAnalytics'];
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

// Desktop-control self-check + a shortcut to the Defender exclusions page.
const diag = document.getElementById('diagnoseMsg');
const diagnoseBtn = document.getElementById('diagnoseBtn');
const exclusionsBtn = document.getElementById('exclusionsBtn');
if (diagnoseBtn) {
  diagnoseBtn.onclick = async () => {
    diag.style.color = '#94a3b8';
    diag.textContent = 'Checking desktop control...';
    const r = await window.clicky.diagnose();
    diag.style.color = r && r.ok ? '#34d399' : '#f87171';
    diag.textContent = (r && r.ok ? 'OK - ' : 'Blocked - ') + ((r && r.detail) || '');
  };
}
if (exclusionsBtn) exclusionsBtn.onclick = () => window.clicky.openExclusions();

if (window.clicky) load();
