const path = require('path');
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, session, shell } = require('electron');

const providers = require('./services/providers');
const { captureCursorDisplay, capturePrimaryDisplay, captureDisplay } = require('./services/capture');
const hotkey = require('./services/hotkey');
const { Overlays } = require('./services/overlays');
const { Agent } = require('./services/agent');
const walkthroughSvc = require('./services/walkthrough');
const memory = require('./services/memory');
const integrations = require('./services/integrations');
const tools = require('./services/tools');
const config = require('./config');
const store = require('./store');
const log = require('./services/log');
const control = require('./services/control');

const PRELOAD = path.join(__dirname, 'preload.js');
const overlays = new Overlays(PRELOAD);

let tray = null;
let commandWin = null;
let settingsWin = null;
let onboardWin = null;
let currentAgent = null;
let audioWait = null;

// --- voice loop state: idle -> listening -> thinking -> speaking -> idle -----
let busy = false;
let pttStart = 0; // when the current hold-to-talk press began
let conversationMode = false; // optional hands-free loop (Alt+V)

// --- "circle an area to ask" gesture state ----------------------------------
// While Ctrl is held and the mouse is dragged, we track a selection rectangle
// (absolute screen px), draw it on the overlay, then on release capture that
// region and answer the next spoken question using the cropped image.
let region = null; // { displayId, x0, y0, x1, y1 }
let regionShot = null; // pending cropped screenshot for the next utterance
let regionQuestionMode = false; // one-shot: answer the next utterance about regionShot

// --- UI fan-out --------------------------------------------------------------
function sendToUI(channel, payload) {
  overlays.send(channel, payload);
  if (commandWin && !commandWin.isDestroyed()) commandWin.webContents.send(channel, payload);
  if (onboardWin && !onboardWin.isDestroyed()) onboardWin.webContents.send(channel, payload);
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
// presetShot, when given, is used INSTEAD of a fresh full-screen capture (used by
// the "circle an area to ask" gesture so Clicky sees only the region you drew).
async function respond(question, presetShot) {
  setState('thinking', { question });

  let screenshot = presetShot || null;
  if (!screenshot) {
    try {
      screenshot = await captureCursorDisplay();
    } catch (e) {
      console.error('[capture] failed', e.message);
    }
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

// --- "Circle an area to ask" ------------------------------------------------
// Crop a rectangle (absolute screen px) out of the owning display's capture and
// return it in the same {base64, mediaType, ...} shape the vision brain expects.
async function captureRegion(abs, display) {
  const full = await captureDisplay(display.id);
  if (!full) return null;
  const sf = display.scaleFactor || 1;
  const img = nativeImage.createFromBuffer(Buffer.from(full.base64, 'base64'));
  const size = img.getSize();
  const cx = Math.round((abs.x - display.bounds.x) * sf);
  const cy = Math.round((abs.y - display.bounds.y) * sf);
  const cw = Math.round(abs.w * sf);
  const ch = Math.round(abs.h * sf);
  const crop = {
    x: Math.max(0, Math.min(cx, size.width - 1)),
    y: Math.max(0, Math.min(cy, size.height - 1)),
    width: Math.max(1, Math.min(cw, size.width)),
    height: Math.max(1, Math.min(ch, size.height))
  };
  const cropped = img.crop(crop);
  return {
    base64: cropped.toPNG().toString('base64'),
    mediaType: 'image/png',
    width: cropped.getSize().width,
    height: cropped.getSize().height,
    displayId: display.id
  };
}

function displayOf(id) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}
function absRectOf(r) {
  const x = Math.min(r.x0, r.x1), y = Math.min(r.y0, r.y1);
  return { x, y, w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) };
}

// Abort the push-to-talk capture that started on Ctrl key-down (a drag means the
// user is selecting, not speaking).
function cancelVoiceForRegion() {
  overlays.sendToDisplay('clicky:record', { on: false }, cursorDisplayId());
  if (audioWait) {
    try { audioWait.resolve(null); } catch (e) {}
    audioWait = null;
  }
  busy = false;
  setState('idle');
}

function pushRegionRect() {
  if (!region) return;
  const d = displayOf(region.displayId);
  const a = absRectOf(region);
  overlays.sendToDisplay('clicky:select', { x: a.x - d.bounds.x, y: a.y - d.bounds.y, w: a.w, h: a.h }, region.displayId);
}

function onRegionStart(pt) {
  const d = screen.getDisplayNearestPoint(pt);
  region = { displayId: d.id, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
  pushRegionRect();
}

function onRegionDrag(pt) {
  if (!region) return;
  region.x1 = pt.x;
  region.y1 = pt.y;
  pushRegionRect();
}

async function onRegionEnd(pt) {
  if (!region) return;
  region.x1 = pt.x;
  region.y1 = pt.y;
  const d = displayOf(region.displayId);
  const abs = absRectOf(region);
  const did = region.displayId;
  region = null;
  overlays.sendToDisplay('clicky:select', null, did);
  if (abs.w < 14 || abs.h < 14) return; // a Ctrl+click, not a drawn area
  await startRegionQuestion(abs, d);
}

// Capture the just-drawn region, then listen for ONE spoken question about it.
async function startRegionQuestion(abs, d) {
  setState('thinking', { question: 'Looking at the area you circled…' });
  let shot = null;
  try {
    shot = await captureRegion(abs, d);
  } catch (e) {
    log.error('region', 'capture failed', { error: e.message });
  }
  if (!shot) {
    const msg = 'I could not capture that area. Please try circling it again.';
    setState('speaking', { answer: msg });
    sendResult({ question: '', answer: msg });
    await providers.tts.speak(msg).catch(() => {});
    setState('idle');
    return;
  }
  regionShot = shot;
  regionQuestionMode = true;
  busy = false; // let the upcoming utterance through handleUtterance
  log.info('region', 'area selected, listening for a question', { w: abs.w, h: abs.h });
  setState('listening');
  overlays.sendToDisplay('clicky:conversation', { on: true, silenceMs: store.read().vadSilenceMs }, cursorDisplayId());
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
    log.error('stt', 'transcribe failed', { error: e.message });
  }
  log.info('voice', 'transcript', { bytes: buffer ? buffer.length : 0, question });

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
  const q = question.toLowerCase();
  // Eyes-on paths, decided before "do it": a walkthrough (vision steps + ring on
  // the exact control) or a question about what is visible (vision answer). An
  // imperative action verb always wins over a screen ask, so "summarize this
  // folder" still runs the agent while "what is this button" uses the eyes.
  const actionVerb = /^\s*(open|launch|start|close|create|make|write|draw|save|delete|rename|move|copy|search|find|list|summarize|read|add|set|run|execute|play|download|organize|clean|type|click|send|email|book|turn|change|install|print|zoom|minimize|maximize|shutdown|restart|lock|mute|go\s+to|navigate)\b/.test(q)
    // "do/fill/put this in excel|here|my sheet|this document" is an action on the
    // LIVE window, not a screen question - force it to the agent so Clicky edits
    // the open app instead of answering conversationally or making a side file.
    || (/\b(excel|word|powerpoint|notepad|spreadsheet|workbook|worksheet|table|cell|row|column|sheet|document|doc|form|field)\b/.test(q)
        && /\b(do|make|write|fill|enter|add|put|type|edit|update|change|fix|complete|work|prepare|generate|build|create)\b/.test(q));
  const walkthrough = /walk me through|step[ -]by[ -]step|guide me|show me how|how do i|how to|how can i|teach me|point (to|at)|where (do|should|can|wo) i (click|go|find)|which (button|tab|field|one)/.test(q);
  const screenAsk = /\b(this|screen|here|panel|button|window|menu|page|toolbar|dialog)\b|(what|can|do) you see|look at (this|the)|on (my|the) screen|explain (this|what)|what (does|is) this|describe (this|the|what)/.test(q);
  log.info('voice', 'routing', { question, walkthrough, screenAsk, actionVerb });
  try {
    if (walkthrough) await runWalkthrough(question);
    else if (screenAsk && !actionVerb) await respond(question);
    else await startAgent(question);
  } catch (e) {
    log.error('voice', 'command failed', { error: e.message });
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
    regionQuestionMode = false;
    regionShot = null;
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

  // A one-shot "circle an area" question: answer using the cropped region image.
  if (regionQuestionMode) {
    const shot = regionShot;
    regionQuestionMode = false;
    regionShot = null;
    if (!question) question = 'What is this? Tell me what the circled area is and how I use it.';
    await respond(question, shot);
    return;
  }

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
let stopHotkeyRegistered = false;
function registerStopHotkey() {
  if (stopHotkeyRegistered) return;
  const acc = (store.read().stopShortcut || 'Escape').trim();
  if (!acc) return;
  try {
    stopHotkeyRegistered = globalShortcut.register(acc, () => cancelAgent());
  } catch (e) {
    stopHotkeyRegistered = false;
  }
}

function unregisterStopHotkey() {
  if (!stopHotkeyRegistered) return;
  const acc = (store.read().stopShortcut || 'Escape').trim();
  try {
    if (acc) globalShortcut.unregister(acc);
  } catch (e) {}
  stopHotkeyRegistered = false;
}

async function startAgent(goal) {
  if (!goal) return;
  if (currentAgent) currentAgent.cancel();

  const agent = new Agent();
  currentAgent = agent;
  registerStopHotkey(); // STOP is only live while an agent is running

  agent.on('status', (p) => sendToUI('clicky:agent', { type: 'status', ...p }));
  agent.on('step', (p) => sendToUI('clicky:agent', { type: 'step', ...p }));
  agent.on('confirm', (p) => sendToUI('clicky:agent', { type: 'confirm', ...p }));
  agent.on('done', async (p) => {
    unregisterStopHotkey();
    sendToUI('clicky:agent', { type: 'done', ...p });
    setState('speaking', { answer: p.summary });
    sendResult({ question: 'Agent: ' + p.goal, answer: p.summary });
    // Speak the outcome only when confirmations are on; errors are always spoken.
    if (store.read().ttsConfirmations || p.failures || p.cancelled) {
      await providers.tts.speak(p.summary).catch(() => {});
    }
    setState('idle');
  });

  agent.on('confirm', (p) => {
    // Read the safety prompt aloud so a non-technical user knows to look up.
    if (!p.decision && store.read().ttsConfirmations !== false) {
      providers.tts.speak('Wait - I am about to ' + (p.label || 'do something hard to undo') + '. Confirm in the Clicky window, or press Escape to stop.').catch(() => {});
      openCommandWindow();
    }
  });

  sendToUI('clicky:agent', { type: 'start', goal });
  setState('thinking', { question: 'Agent: ' + goal });
  try {
    await agent.run(goal);
  } finally {
    unregisterStopHotkey();
    currentAgent = null;
  }
}

function cancelAgent() {
  if (currentAgent) currentAgent.cancel();
  unregisterStopHotkey();
}

function resolveAgentConfirm(decision) {
  if (currentAgent) currentAgent.resolveConfirm(String(decision || 'block'));
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

function openOnboardWindow() {
  if (onboardWin && !onboardWin.isDestroyed()) {
    onboardWin.focus();
    return;
  }
  onboardWin = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    title: 'Welcome to HeyClicky',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  onboardWin.loadFile('onboard.html');
  onboardWin.on('closed', () => { onboardWin = null; });
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
    { label: 'Circle-to-ask: hold Ctrl, drag over an area, then ask', enabled: false },
    { type: 'separator' },
    { label: 'STOP the agent', accelerator: 'Esc', click: () => cancelAgent() },
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
  // Hold Ctrl and drag the mouse to circle an area and ask about it instead.
  hotkey.start({
    onDown: onHotkeyDown,
    onUp: onHotkeyUp,
    onRegionCancel: cancelVoiceForRegion,
    onRegionStart,
    onRegionDrag,
    onRegionEnd
  });
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
  ipcMain.handle('clicky:agent-confirm', (_e, { decision }) => resolveAgentConfirm(decision));

  ipcMain.handle('settings:get', () => store.read());
  ipcMain.handle('settings:save', (_e, partial) => applySettings(partial || {}));
  ipcMain.handle('history:get', () => ({
    conversation: memory.recentConversations(40),
    tasks: memory.allTasks()
  }));

  // Desktop-control self-check for the Settings / onboarding "test" button.
  ipcMain.handle('clicky:diagnose', async () => {
    const r = await control.findName('__clicky_probe__');
    if (r && r.error) return { ok: false, detail: r.error };
    return { ok: true, detail: 'Windows input driver is working (UIA + keyboard). Antivirus is not blocking it.' };
  });
  ipcMain.handle('clicky:open-exclusions', () => {
    // Jump straight to the Windows Defender exclusion page (best-effort).
    shell.openExternal('windowsdefender://exclusions').catch(() => {});
    return { ok: true };
  });
  ipcMain.handle('onboard:finish', () => {
    store.patch({ firstRunDone: true });
    if (onboardWin && !onboardWin.isDestroyed()) onboardWin.close();
    return { ok: true };
  });
  ipcMain.handle('window:open-settings', () => {
    openSettingsWindow();
    return { ok: true };
  });
}

function applySettings(partial) {
  const before = store.read();
  const after = store.patch(partial);

  // Multi-monitor changed -> rebuild overlays.
  if (before.multiMonitor !== after.multiMonitor) {
    overlays.createAll(after.multiMonitor);
  }
  // Autostart changed -> register/unregister the login item.
  if (before.autostart !== after.autostart) applyAutostart(after.autostart);
  // STOP key changed while it was live -> it is re-registered per agent run, so
  // nothing to do here; the next run reads the new accelerator.
  return after;
}

function applyAutostart(on) {
  try {
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: Boolean(on), path: process.execPath });
    else app.setLoginItemSettings({ openAtLogin: Boolean(on) });
  } catch (e) {
    log.warn('startup', 'autostart toggle failed', { error: e.message });
  }
}

// Silent background updates for packaged builds (electron-updater + GitHub
// Releases). Never required in dev; a missing/misconfigured updater must not
// stop the app from starting, so everything is wrapped and best-effort.
function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = { info: (m) => log.info('update', String(m)), warn: (m) => log.warn('update', String(m)), error: (m) => log.error('update', String(m)) };
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => {
      try {
        tray.displayBalloon({ title: 'HeyClicky updated', content: 'Restart to finish updating.' });
      } catch (e) {}
    });
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log.warn('update', 'check failed', { error: e.message }));
  } catch (e) {
    log.warn('update', 'electron-updater unavailable', { error: e.message });
  }
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
  try {
    log.init(app.getPath('logs'));
  } catch (e) {
    log.init(userData);
  }
  log.info('startup', 'HeyClicky starting', { provider: config.provider, vision: config.visionProvider(), overlays: store.read().multiMonitor });

  registerIpc();
  overlays.createAll(store.read().multiMonitor);

  // Let the agent draw on / guide with the screen overlays.
  tools.bindScreen({
    draw: (p) => overlays.sendToDisplay('clicky:draw', p, cursorDisplayId()),
    guide: (p) => overlays.sendToDisplay('clicky:guide', p, cursorDisplayId()),
    clear: () => {
      const did = cursorDisplayId();
      overlays.sendToDisplay('clicky:draw', { op: 'clear' }, did);
      overlays.sendToDisplay('clicky:guide', { clear: true }, did);
    }
  });

  createTray();
  startHotkeys();
  registerShortcuts();
  initAutoUpdate();

  // Input-driver health probe: prove UIA + PowerShell input works before the user
  // relies on it, and surface a clear message if antivirus blocked it. findName is
  // read-only (no click, no cursor move), so this is safe to run on every start.
  control
    .findName('__clicky_probe__')
    .then((r) => {
      if (r && r.error) {
        log.error('startup', 'input driver unavailable', { error: r.error });
        try {
          tray.displayBalloon({
            title: 'HeyClicky: control blocked',
            content: 'Desktop control is not working: ' + String(r.error).slice(0, 140) + ' (antivirus may be blocking PowerShell).'
          });
        } catch (e) {}
      } else {
        log.info('startup', 'input driver OK');
      }
    })
    .catch((e) => log.error('startup', 'input probe threw', { error: e.message }));

  // Apply the autostart preference every launch (idempotent).
  applyAutostart(store.read().autostart);

  // First run: show the welcome/onboarding wizard (keys, mic, hold-to-talk, one
  // real demo action). It marks firstRunDone when the user finishes.
  if (!store.read().firstRunDone) {
    openOnboardWindow();
  }

  screen.on('display-metrics-changed', () => overlays.createAll(store.read().multiMonitor));
  screen.on('display-added', () => overlays.createAll(store.read().multiMonitor));
  screen.on('display-removed', () => overlays.createAll(store.read().multiMonitor));

  log.info('startup', 'ready', { overlayCount: overlays.count(), provider: config.provider });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { control.shutdown(); } catch (e) {}
  overlays.destroy();
});

app.on('window-all-closed', () => {
  // Keep running in the tray (it's an overlay companion). Quit via tray menu.
  if (process.platform !== 'darwin' && !tray) app.quit();
});
