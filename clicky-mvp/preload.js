const { contextBridge, ipcRenderer } = require('electron');

// Cursor position (shared by every overlay).
contextBridge.exposeInMainWorld('onCursorMove', (callback) => {
  const listener = (_event, point) => callback(point);
  ipcRenderer.on('cursor-pos', listener);
  return () => ipcRenderer.removeListener('cursor-pos', listener);
});

// HeyClicky API. Overlay + command + settings windows use subsets of this.
contextBridge.exposeInMainWorld('clicky', {
  // --- overlay receives ---
  onInit: (cb) => on('clicky:init', cb),
  onState: (cb) => on('clicky:state', cb),
  onResult: (cb) => on('clicky:result', cb),
  onAgent: (cb) => on('clicky:agent', cb),
  onPoint: (cb) => on('clicky:point', cb),
  onRecord: (cb) => on('clicky:record', cb),
  onConversation: (cb) => on('clicky:conversation', cb),
  onDraw: (cb) => on('clicky:draw', cb),
  onGuide: (cb) => on('clicky:guide', cb),
  onPrefillAgent: (cb) => on('clicky:prefill-agent', cb),

  // --- overlay -> main (recorded audio) ---
  sendAudio: (wavBase64) => ipcRenderer.send('stt-audio', { wav: wavBase64 }),
  // hands-free: send one completed utterance; main transcribes + answers
  utterance: (wavBase64) => ipcRenderer.send('clicky:utterance', { wav: wavBase64 }),

  // --- actions ---
  ask: (text) => ipcRenderer.invoke('clicky:ask', { text }),
  walkthrough: (text) => ipcRenderer.invoke('clicky:walkthrough', { text }),
  agent: (goal) => ipcRenderer.invoke('clicky:agent', { goal }),
  agentCancel: () => ipcRenderer.invoke('clicky:agent-cancel'),
  agentConfirm: (decision) => ipcRenderer.invoke('clicky:agent-confirm', { decision }),
  capture: () => ipcRenderer.invoke('capture-screen'),
  conversationToggle: () => ipcRenderer.invoke('clicky:conversation-toggle'),

  // --- settings + history ---
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (partial) => ipcRenderer.invoke('settings:save', partial),
  historyGet: () => ipcRenderer.invoke('history:get'),

  // --- diagnostics + onboarding ---
  diagnose: () => ipcRenderer.invoke('clicky:diagnose'),
  openExclusions: () => ipcRenderer.invoke('clicky:open-exclusions'),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  onboardFinish: () => ipcRenderer.invoke('onboard:finish')
});

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
