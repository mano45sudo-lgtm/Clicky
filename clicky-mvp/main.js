const path = require('path');
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, session } = require('electron');

const providers = require('./services/providers');
const { captureCursorDisplay, capturePrimaryDisplay } = require('./services/capture');
const hotkey = require('./services/hotkey');
const { Overlays } = require('./services/overlays');
const { Agent } = require('./services/agent');
const walkthroughSvc = require('./services/walkthrough');
const memory = require('./services/memory');
const integrations = require('./services/integrations');
const config = require('./config');
const store = require('./store');

const PRELOAD = path.join(__dirname, 'preload.js');
const overlays = new Overlays(PRELOAD);

let tray = null;
let commandWin = null;
let settingsWin = null;
let currentAgent = null;
let audioWait = null;

// --- voice loop state: idle -> listening -> thinking -> speaking -> idle -----
let busy = false;
let pttStart = 0; // when the current hold-to-talk press began
let conversationMode = false; // optional hands-free loop (Alt+V)

// --- UI fan-out --------------------------------------------------------------
function sendToUI(channel, payload) {
  overlays.send(channel, payload);
  if (commandWin && !commandWin.isDestroyed()) commandWin.webContents.send(channel, payload);
}

function setState(next, extra = {}) {
  sendToUI('clicky:state', { state: next, ...extra });
}

function sendResult(payload) {
  sendToUI('clicky:result', payload);
}

function cursorDisplayId() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  } catch (e) {
    return null;
  }
}

function mockAnswerMessage(errMessage) {
  return config.mockMode
    ? 'I am in mock mode and hit a snag. Add a Sarvam key in Settings for real answers.'
    : `Sorry, that did not work (${errMessage || 'unknown error'}).`;
}

// --- Answer (shared by voice, typed, history) -------------------------------
async function respond(question) {
  setState('thinking', { question });

  let screenshot = null;
  try {
    screenshot = await captureCursorDisplay();
  } catch (e) {
    console.error('[capture] failed', e.message);
  }

  let answer;
  try {
    answer = await providers.llm.answer({ question, screenshot });
  } catch (e) {
    console.error('[llm] failed', e.message);
    answer = mockAnswerMessage(e.message);
  }

  console.log(`[clicky] Q: ${JSON.stringify(question)} | A: ${JSON.stringify(answer)}`);

  setState('speaking', { answer });
  sendResult({ question, answer });
  memory.addTurn(question, answer);

  try {
    await providers.tts.speak(answer);
  } catch (e) {
    console.error('[tts] failed', e.message);
  }

  setState('idle');
  busy = false;
}

// --- Push to talk -----------------------------------------------------------
async function onHotkeyDown() {
  if (busy) return;
  busy = true;
  pttStart = Date.now();

  providers.tts.cancel();
  setState('listening');

  if (config.sttProvider() !== 'mock') {
    overlays.sendToDisplay('clicky:record', { on: true }, cursorDisplayId());
  }
}

async function onHotkeyUp() {
  if (!busy) return;

  // A very short Ctrl tap (e.g. Ctrl+C) is not a command - discard it quietly.
  if (Date.now() - pttStart < 300) {
    if (config.sttProvider() !== 'mock') overlays.sendToDisplay('clicky:record', { on: false }, cursorDisplayId());
    busy = false;
    setState('idle');
    return;
  }

  if (config.sttProvider() === 'mock') {
    const question = await providers.stt.transcribe(null);
    return handleSpokenCommand(question);
  }

  overlays.sendToDisplay('clicky:record', { on: false }, cursorDisplayId());
  const buffer = await waitAudio(6000);
  console.log(`[clicky] captured ${buffer ? buffer.length : 0} bytes of audio, transcribing...`);
  let question = '';
  try {
    question = await providers.stt.transcribe(buffer);
  } catch (e) {
    console.error('[stt] failed', e.message);
  }
  console.log(`[clicky] heard: ${JSON.stringify(question)}`);

  await handleSpokenCommand(question);
}

// A spoken command: DO it. Route through the agent so "open docs" opens and
// "create an essay" writes a file, then speak the outcome. Only falls back to a
// plain answer when there is no real LLM driving the agent (mock mode).
async function handleSpokenCommand(question) {
  if (!question) {
    const answer = 'I did not catch that. Hold Ctrl, speak, then let go.';
    setState('speaking', { answer });
    sendResult({ question: '', answer });
    await providers.tts.speak(answer).catch(() => {});
    setState('idle');
    busy = false;
    return;
  }

  if (config.mockMode) {
    await respond(question);
    busy = false;
    return;
  }

  busy = true;
  try {
    await startAgent(question);
  } catch (e) {
    console.error('[agent] failed', e.message);
  }
  busy = false;
}

function waitAudio(ms) {
  return new Promise((resolve) => {
    audioWait = { resolve };
    setTimeout(() => {
      if (audioWait) {
        audioWait.resolve(null);
        audioWait = null;
      }
    }, ms);
  });
}

// --- Hands-free conversation ------------------------------------------------
// Main arms the overlay for exactly one utterance. The overlay's VAD sends the
// finished utterance back via 'clicky:utterance'; we transcribe, answer out loud,
// then re-arm (only after speaking, so Clicky never hears its own voice).
function beginConversationTurn() {
  setState('listening');
  overlays.sendToDisplay('clicky:conversation', { on: true, silenceMs: store.read().vadSilenceMs }, cursorDisplayId());
}

function startConversation() {
  if (busy) return;
  conversationMode = true;
  beginConversationTurn();
}

function endConversation() {
  conversationMode = false;
  overlays.sendToDisplay('clicky:conversation', { on: false }, cursorDisplayId());
  if (!busy) setState('idle');
}

function toggleConversation() {
  if (conversationMode) endConversation();
  else startConversation();
}

function afterTurn() {
  if (conversationMode) setTimeout(beginConversationTurn, 350);
}

async function handleUtterance(buffer) {
  if (busy) return;

  if (!buffer) {
    // Overlay reported the microphone was unavailable.
    const msg = 'I could not access your microphone.';
    endConversation();
    setState('speaking', { answer: msg });
    sendResult({ question: '', answer: msg });
    await providers.tts.speak(msg).catch(() => {});
    setState('idle');
    return;
  }

  busy = true;
  let question = '';
  try {
    question = await providers.stt.transcribe(buffer);
  } catch (e) {
    console.error('[stt] failed', e.message);
  }
  console.log(`[clicky] transcript: ${JSON.stringify(question)}`);

  if (!question) {
    setState('idle');
    busy = false;
    afterTurn();
    return;
  }

  await respond(question);
  afterTurn();
}

// --- Walkthrough ------------------------------------------------------------
async function runWalkthrough(request) {
  setState('thinking', { question: request || 'Walk me through this' });
  let data;
  try {
    data = await walkthroughSvc.walkthrough({ request });
  } catch (e) {
    data = { steps: [], note: e.message };
  }

  const did = cursorDisplayId();
  if (!data.steps || !data.steps.length) {
    const answer = data.note || 'I could not find clear steps to point at on your screen.';
    setState('speaking', { answer });
    sendResult({ question: request || 'walkthrough', answer });
    await providers.tts.speak(answer).catch(() => {});
    setState('idle');
    return;
  }

  for (const step of data.steps) {
    setState('speaking', { answer: step.instruction });
    sendResult({ question: 'Walkthrough', answer: step.instruction });
    overlays.sendToDisplay('clicky:point', { target: step.target, label: step.label }, did);
    await providers.tts.speak(step.instruction).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }

  overlays.send('clicky:point', { target: null });
  setState('idle');
}

// --- Background agent -------------------------------------------------------
async function startAgent(goal) {
  if (!goal) return;
  if (currentAgent) currentAgent.cancel();

  const agent = new Agent();
  currentAgent = agent;

  agent.on('status', (p) => sendToUI('clicky:agent', { type: 'status', ...p }));
  agent.on('step', (p) => sendToUI('clicky:agent', { type: 'step', ...p }));
  agent.on('done', async (p) => {
    sendToUI('clicky:agent', { type: 'done', ...p });
    setState('speaking', { answer: p.summary });
    sendResult({ question: 'Agent: ' + p.goal, answer: p.summary });
    await providers.tts.speak(p.summary).catch(() => {});
    setState('idle');
  });

  sendToUI('clicky:agent', { type: 'start', goal });
  setState('thinking', { question: 'Agent: ' + goal });
  await agent.run(goal);
  currentAgent = null;
}

function cancelAgent() {
  if (currentAgent) currentAgent.cancel();
}

// --- Windows ----------------------------------------------------------------
function openCommandWindow() {
  if (commandWin && !commandWin.isDestroyed()) {
    commandWin.focus();
    return;
  }
  commandWin = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 360,
    minHeight: 420,
    title: 'HeyClicky',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  commandWin.loadFile('command.html');
  commandWin.on('closed', () => { commandWin = null; });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    title: 'HeyClicky Settings',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

// --- Tray -------------------------------------------------------------------
function trayIcon() {
  // Draw a 16x16 disc glyph as a raw BGRA bitmap. Windows nativeImage cannot
  // rasterize SVG data URLs, so we build the image from pixels instead.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - c) ** 2 + (y - c) ** 2);
      const i = (y * size + x) * 4;
      let a = 0, b = 0, g = 0, r = 0;
      if (dist <= 6.5) {
        // fill: soft blue
        r = 96; g = 165; b = 250; a = 255;
      } else if (dist <= 7.3) {
        // outline: near-black
        r = 17; g = 24; b = 39; a = 255;
      }
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('HeyClicky');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Assistant', click: openCommandWindow },
    { label: 'Talk (hold Ctrl, or press Alt+V)', click: openCommandWindow },
    { label: 'Ask about my screen', click: () => { if (!busy) { busy = true; respond('What is on my screen right now? Summarize what I am looking at and suggest a next step.'); } } },
    { label: 'Walk me through this', click: () => runWalkthrough('') },
    { label: 'Settings', click: openSettingsWindow },
    { type: 'separator' },
    { label: 'Quit HeyClicky', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', openCommandWindow);
}

// --- Global shortcuts (toggles) --------------------------------------------
function registerShortcuts() {
  const st = store.read();
  try {
    globalShortcut.register(st.toggleShortcut, openCommandWindow);
  } catch (e) {}
  try {
    // Secondary hands-free toggle (Ctrl via uiohook is the primary path).
    if (st.conversationShortcut) globalShortcut.register(st.conversationShortcut, () => toggleConversation());
  } catch (e) {}
  try {
    globalShortcut.register(st.agentShortcut, () => {
      openCommandWindow();
      if (commandWin && !commandWin.isDestroyed()) commandWin.webContents.send('clicky:prefill-agent');
    });
  } catch (e) {}
}

function startHotkeys() {
  // Hold Left Ctrl to talk; release to run the spoken command as an action.
  hotkey.start({ onDown: onHotkeyDown, onUp: onHotkeyUp });
}

// --- IPC --------------------------------------------------------------------
function registerIpc() {
  ipcMain.on('stt-audio', (_e, { wav }) => {
    if (audioWait) {
      const buffer = wav ? Buffer.from(wav, 'base64') : null;
      audioWait.resolve(buffer);
      audioWait = null;
    }
  });

  ipcMain.handle('capture-screen', () => capturePrimaryDisplay().catch((e) => ({ error: e.message })));
  ipcMain.handle('clicky:ask', (_e, { text }) => respond(String(text || '').trim()));
  ipcMain.handle('clicky:conversation-toggle', () => toggleConversation());

  // One completed hands-free utterance from an overlay's VAD.
  ipcMain.on('clicky:utterance', (_e, { wav }) => {
    const buffer = wav ? Buffer.from(wav, 'base64') : null;
    handleUtterance(buffer);
  });

  ipcMain.handle('clicky:walkthrough', (_e, { text }) => runWalkthrough(String(text || '').trim()));
  ipcMain.handle('clicky:agent', (_e, { goal }) => startAgent(String(goal || '').trim()));
  ipcMain.handle('clicky:agent-cancel', () => cancelAgent());

  ipcMain.handle('settings:get', () => store.read());
  ipcMain.handle('settings:save', (_e, partial) => applySettings(partial || {}));
  ipcMain.handle('history:get', () => ({
    conversation: memory.recentConversations(40),
    tasks: memory.allTasks()
  }));
}

function applySettings(partial) {
  const before = store.read();
  const after = store.patch(partial);

  // Multi-monitor changed -> rebuild overlays.
  if (before.multiMonitor !== after.multiMonitor) {
    overlays.createAll(after.multiMonitor);
  }
  // PTT key changed -> uiohook listener reads live value, so no re-register needed.
  return after;
}

// --- App lifecycle ----------------------------------------------------------
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Grant mic/media to our own overlays so push-to-talk recording works without
  // a prompt (this is a local, single-window trust app).
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media' || permission === 'mediaKeySystem');
    });
  } catch (e) {
    console.error('[clicky] permission handler failed', e.message);
  }

  const userData = app.getPath('userData');
  store.init(userData);
  memory.init(userData);
  integrations.init(userData);

  registerIpc();
  overlays.createAll(store.read().multiMonitor);
  createTray();
  startHotkeys();
  registerShortcuts();

  // First run: open settings so the user can drop in their keys.
  if (!store.read().firstRunDone) {
    store.patch({ firstRunDone: true });
    openSettingsWindow();
  }

  screen.on('display-metrics-changed', () => overlays.createAll(store.read().multiMonitor));
  screen.on('display-added', () => overlays.createAll(store.read().multiMonitor));
  screen.on('display-removed', () => overlays.createAll(store.read().multiMonitor));

  console.log(`[clicky] ready - ${overlays.count()} overlay(s), provider=${config.provider}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  overlays.destroy();
});

app.on('window-all-closed', () => {
  // Keep running in the tray (it's an overlay companion). Quit via tray menu.
  if (process.platform !== 'darwin' && !tray) app.quit();
});
