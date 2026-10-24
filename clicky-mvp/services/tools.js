const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('../config');
const { capturePrimaryDisplay } = require('./capture');
const integrations = require('./integrations');
const control = require('./control');
const llm = require('./llm');
const knowledge = require('./knowledge');
const cdp = require('./cdp');

// Real input is gated by a setting; coordinates are 0..1 screen fractions mapped
// to physical pixels of the primary display (SetProcessDPIAware keeps these
// aligned with the screenshot the vision model saw).
function inputEnabled() {
  return Boolean(config.settings.agentAllowInput);
}
function fracToPx(x, y) {
  const { screen } = require('electron');
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const w = Math.round(d.size.width * sf);
  const h = Math.round(d.size.height * sf);
  return { px: Math.round(x * w), py: Math.round(y * h) };
}

// Screen bridge (draw / guide / clear) injected by main.js once overlays exist.
let screenApi = null;
function bindScreen(api) {
  screenApi = api || null;
}

// LOOK at a fresh screenshot and return the on-screen position of a described
// control/field as 0..1 fractions. fast=true uses the quick lite model for common
// controls; the web/custom path calls with fast=false (strong model) for higher
// detection accuracy. Shared by clickOnScreen and typeInto so web fields get found.
async function visionLocate(target, { fast } = {}) {
  const shot = await capturePrimaryDisplay().catch(() => null);
  if (!shot) return { found: false, error: 'could not capture the screen' };
  const sys =
    'You locate ONE UI element or input field in a screenshot and return its exact position. ' +
    'Reply JSON {"found":bool,"confidence":number,"x":number,"y":number,"label":string}. ' +
    'x,y are the CENTER of the element as fractions of the image width and height (0..1, top-left origin). ' +
    'For a text field, textarea, search box, or a message/compose body, point at the MIDDLE of the empty editable area, not its label, icon, or border. ' +
    'For a button or link, point at its text. Scan the whole image including web pages, dialogs, and toolbars. ' +
    'confidence is 0..1 = how sure you are this is the RIGHT element; if you can only guess, keep confidence low.';
  const data = await llm.json({ system: sys, text: `Find this on screen: "${target}"`, screenshot: shot, fast, fallback: { found: false } });
  if (!data || !data.found || typeof data.x !== 'number' || typeof data.y !== 'number') return { found: false };
  const confidence = typeof data.confidence === 'number' ? data.confidence : 0.85;
  // A low-confidence point from the quick model is worse than no point: report
  // not-found so the caller escalates to the strong model instead of misclicking.
  if (confidence < 0.55) return { found: false, low: true, confidence };
  const c01 = (v) => Math.max(0, Math.min(1, v));
  return { found: true, confidence, x: c01(data.x), y: c01(data.y), label: data.label };
}

// --- verify-after-act -------------------------------------------------------
// Read the focused control's text so we can confirm typed text actually landed
// (the fix for "it reported success but nothing appeared"). Returns the raw string
// when readable, or null when the control's value can't be read (web content,
// custom controls) - callers must treat null as "unknown", never as a failure.
function normText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}
async function readFocused() {
  const rv = await control.readValue().catch(() => null);
  if (!rv || rv.error || rv.noread || typeof rv.value !== 'string') return null;
  return rv.value;
}
// 'ok' = readable AND contains what we typed; 'miss' = readable but our text is
// absent (real no-op); 'unknown' = not readable (leave the success claim intact).
async function verifyLanded(body) {
  const v = await readFocused();
  if (v === null) return 'unknown';
  const expect = normText(body);
  if (!expect) return 'ok';
  return normText(v).includes(expect.slice(0, Math.min(60, expect.length))) ? 'ok' : 'miss';
}

// Friendly names -> something Windows can actually launch (exe, URI, or file).
const APP_ALIASES = {
  notepad: 'notepad', word: 'winword', excel: 'excel', powerpoint: 'powerp',
  outlook: 'outlook', chrome: 'chrome', google: 'chrome', browser: 'msedge',
  edge: 'msedge', firefox: 'firefox', calculator: 'calc', calc: 'calc',
  paint: 'mspaint', photos: 'photos', explorer: 'explorer', files: 'explorer',
  'file manager': 'explorer', settings: 'ms-settings:', terminal: 'wt',
  cmd: 'cmd', command: 'cmd', code: 'code', 'vs code': 'code', vscode: 'code',
  spotify: 'spotify', steam: 'steam', taskmgr: 'taskmgr', 'task manager': 'taskmgr',
  mail: 'start mailto:', camera: 'microsoft.windows.camera:', store: 'ms-windows-store:'
};

function resolveApp(target) {
  const raw = String(target || '').trim();
  if (!raw) return raw;
  const low = raw.toLowerCase();
  if (APP_ALIASES[low]) return APP_ALIASES[low];
  const m = low.match(/^(?:open|launch|start|run)\s+(.+)$/);
  if (m && APP_ALIASES[m[1].trim()]) return APP_ALIASES[m[1].trim()];
  return raw;
}

// Expand ~ and resolve bare filenames to the user's Documents folder.
function expandPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return raw;
  const home = os.homedir();
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(home, raw.slice(1).replace(/^[\\/]/, ''));
  }
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, 'Documents', raw);
}

function openCommand(target) {
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  if (process.platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

function runOpen(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', () => resolve({ ok: true }));
  });
}

// Open a URL in the default browser WITHOUT a shell, so query strings with &
// (e.g. the Gmail compose link) are not split into separate commands.
function openUrl(url) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let p;
    try { p = spawn(cmd, [url], { windowsHide: true }); } catch (e) { return finish({ error: e.message }); }
    p.on('error', (e) => finish({ error: e.message }));
    p.on('close', () => finish({ ok: true }));
    setTimeout(() => finish({ ok: true }), 1500);
  });
}

async function webSearch(query) {
  const st = config.settings;
  try {
    if (st.webSearchProvider === 'serper' && st.serperApiKey) {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': st.serperApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, num: 6 })
      });
      const j = await res.json();
      return (j.organic || []).slice(0, 6).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
    }
    if (st.webSearchProvider === 'brave' && st.braveApiKey) {
      const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query), {
        headers: { 'X-Subscription-Token': st.braveApiKey, Accept: 'application/json' }
      });
      const j = await res.json();
      return (j.web && j.web.results ? j.web.results : []).slice(0, 6).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
    }
  } catch (e) {
    return { error: e.message };
  }
  return { error: 'Web search not configured. Add a Serper or Brave key in Settings.' };
}

// Read a bounded amount of a file (PDFs handled by caller elsewhere / skipped here).
function readTextFile(p, maxBytes = 200000) {
  try {
    const stat = fs.statSync(p);
    if (stat.size > maxBytes) return { error: `file too large (${stat.size} bytes)` };
    return { content: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { error: e.message };
  }
}

function writeTextFile(p, content) {
  if (!config.settings.agentAllowFileWrites) return { error: 'file writes are disabled in Settings' };
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    return { ok: true, path: p };
  } catch (e) {
    return { error: e.message };
  }
}

// Tool definitions (JSON schema) exposed to the LLM planner + their executors.
const tools = {
  captureScreen: {
    description: 'Take a screenshot of the current screen. Use to see what the user is working on.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const shot = await capturePrimaryDisplay();
      return shot ? { ok: true, width: shot.width, height: shot.height } : { error: 'capture failed' };
    }
  },
  webSearch: {
    description: 'Search the web for a query and return top results (title, url, snippet).',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => webSearch(query)
  },
  listFolder: {
    description: 'List files and folders at a path.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }) => integrations.listDir(p)
  },
  summarizeFolder: {
    description: 'Summarize a folder by counting files per extension (a safe cleanup preview).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }) => integrations.folderSummary(p)
  },
  readFile: {
    description: 'Read a text file from disk (bounded size).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }) => readTextFile(p)
  },
  writeFile: {
    description: 'Write a text file to disk (creates parent folders). Bare names go to Documents. Use for essays, notes, docs.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    run: async ({ path: p, content }) => writeTextFile(expandPath(p), content)
  },
  openApp: {
    description: 'Open an application, file, or URL. Understands names like notepad, word, excel, chrome, edge, settings, files, spotify, and full paths/URLs.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: async ({ target }) => {
      if (!config.settings.agentAllowAppLaunch) return { error: 'app launch is disabled in Settings' };
      const resolved = resolveApp(target);
      const { cmd, args } = openCommand(resolved);
      const out = await runOpen(cmd, args);
      return { ...out, opened: resolved };
    }
  },
  runCommand: {
    description: 'Run a shell command on the user\'s computer and return its output. Use for anything the other tools cannot do (open a specific app by path, list files, run utilities). Keep commands safe and non-destructive.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: async ({ command }) => {
      if (!config.settings.agentAllowRunCommand) return { error: 'running commands is disabled in Settings' };
      return new Promise((resolve) => {
        const win = process.platform === 'win32';
        const shell = win ? 'cmd' : '/bin/sh';
        const args = win ? ['/c', command] : ['-c', command];
        const p = spawn(shell, args, { windowsHide: true });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', (e) => resolve({ error: e.message }));
        p.on('close', (code) => resolve({ code, stdout: out.slice(0, 4000), stderr: err.slice(0, 1500) }));
        setTimeout(() => { try { p.kill(); } catch (e) {} }, 20000);
      });
    }
  },
  draw: {
    description:
      'Draw basic pictures/shapes on the screen. items is a list of shapes. Coordinates are fractions of the screen (0..1): x,y is the shape CENTER and size is a fraction of the screen. Shapes: smiley, heart, star, house, circle, square, triangle, check (use x,y,size,color); line and arrow (use x,y,x2,y2,color); text (use text,x,y,size,color). Example "draw a smiley": {items:[{shape:"smiley",x:0.5,y:0.45,size:0.25,color:"#38bdf8"}]}. Put many shapes in items to compose one picture.',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        clearFirst: { type: 'boolean' }
      },
      required: ['items']
    },
    run: async ({ items, clearFirst }) => {
      if (!screenApi || !screenApi.draw) return { error: 'screen overlay not ready' };
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return { error: 'no shapes to draw' };
      screenApi.draw({ op: 'shapes', items: list, clearFirst: clearFirst !== false });
      return { ok: true, drew: list.length };
    }
  },
  guide: {
    description:
      'Guide the user visually: point an on-screen arrow and pulsing ring to a spot with a short label. x,y are fractions of the screen (0..1). Use for "show me where" and step-by-step guidance.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } },
      required: ['x', 'y']
    },
    run: async ({ x, y, label }) => {
      if (!screenApi || !screenApi.guide) return { error: 'screen overlay not ready' };
      screenApi.guide({ x, y, label: label || '' });
      return { ok: true };
    }
  },
  clearDrawing: {
    description: 'Remove all on-screen drawings and the guiding arrow.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => {
      if (!screenApi || !screenApi.clear) return { error: 'screen overlay not ready' };
      screenApi.clear();
      return { ok: true };
    }
  },
  clickAt: {
    description:
      'Move the REAL mouse cursor to a point and click it. x,y are fractions of the screen (0..1). Set double:true to double-click. Use when you already know where something is.',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } },
      required: ['x', 'y']
    },
    run: async ({ x, y, double }) => {
      if (!inputEnabled()) return { error: 'mouse control is disabled in Settings (turn on "Control the mouse and keyboard")' };
      const { px, py } = fracToPx(x, y);
      return control.run(double ? 'doubleclick' : 'click', { x: px, y: py });
    }
  },
  clickOnScreen: {
    description:
      'LOOK at the screen, FIND a control by plain description, then move the real cursor onto it and click. This is the main way to operate apps that are already open, e.g. target "Blank document template", "Compose button", "To field", "Subject field", "message body", "the Send button". Returns found:true/false.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' }, double: { type: 'boolean' } },
      required: ['target']
    },
    run: async ({ target, double }) => {
      if (!inputEnabled()) return { error: 'mouse control is disabled in Settings (turn on "Control the mouse and keyboard")' };
      // 1) Fast + local + pixel-exact: Windows UI Automation by control name (no vision, no clipboard).
      //    Try the app knowledge pack's candidate names so "new file button" still lands on "New".
      const cands = knowledge.candidateNames(target);
      if (!double) {
        for (const name of cands) {
          const ui = await control.clickName(name);
          if (ui && ui.found) return { found: true, via: 'uia', x: ui.x, y: ui.y, target };
          // On notfound OR a UIA error, keep trying the other candidate names and
          // then fall through to the vision locate. Returning early here would skip
          // the vision fallback entirely (why web clicks used to need a manual click).
        }
      } else {
        for (const name of cands) {
          const f = await control.findName(name);
          if (f && f.found) {
            const r = await control.run('doubleclick', { x: f.x, y: f.y });
            return { ...r, found: true, via: 'uia', x: f.x, y: f.y, target };
          }
        }
      }
      // 2) Fallback for web/custom UI that UIA can't see: locate it on a screenshot.
      //    Try the quick model first; if it misses OR is low-confidence, escalate to
      //    the strong model so web compose fields and oddly-labelled controls land.
      let loc = await visionLocate(target, { fast: true });
      if (!loc.found && !loc.error) loc = await visionLocate(target, { fast: false });
      if (!loc.found) {
        return { found: false, error: loc.error || ('I could not find: ' + target) };
      }
      const { px, py } = fracToPx(loc.x, loc.y);
      const r = await control.run(double ? 'doubleclick' : 'click', { x: px, y: py });
      return { ...r, found: true, via: 'vision', x: loc.x, y: loc.y, target };
    }
  },
  typeText: {
    description:
      'Type TEXT into whatever field or document currently has focus (call right after clicking the target). Use for writing an essay into Word or filling an email To/Subject/body. Types real keystrokes via SendKeys (no clipboard), so it handles long and multi-line text.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => {
      if (!inputEnabled()) return { error: 'keyboard control is disabled in Settings (turn on "Control the mouse and keyboard")' };
      const body = String(text == null ? '' : text);
      const r = await control.type(body);
      if (r && r.error) return r;
      // Light verify: if the focused field is readable and still EMPTY, the
      // keystrokes went nowhere - retype once. Never retype when content already
      // exists, so appending to a document/body never duplicates.
      const v = await readFocused();
      let verified = null;
      if (v !== null && body.trim() !== '') {
        if (v.trim() === '') { await control.type(body); verified = false; }
        else verified = normText(v).includes(normText(body).slice(0, 60));
      }
      return { typed: true, verified, chars: body.length };
    }
  },
  pressKey: {
    description: 'Press a key or SendKeys sequence, e.g. "{Enter}", "{Escape}", "^a" (select all), "^s" (save), "%{F4}" (close window).',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async ({ key }) => {
      if (!inputEnabled()) return { error: 'keyboard control is disabled in Settings (turn on "Control the mouse and keyboard")' };
      return control.key(String(key || ''));
    }
  },
  typeInto: {
    description:
      'Type text directly INTO a named field/document by label (e.g. target "Subject", "To", "Body", "Type text here") using UI Automation focus - one step, no separate click. Falls back to clicking the target then typing. Use this to fill a specific input quickly.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' } },
      required: ['target', 'text']
    },
    run: async ({ target, text }) => {
      if (!inputEnabled()) return { error: 'keyboard control is disabled in Settings (turn on "Control the mouse and keyboard")' };
      const t = String(target || '').trim();
      const body = String(text == null ? '' : text);
      // Remember HOW we filled it so a verify miss can retry the same way.
      let fill = null;
      for (const name of knowledge.candidateNames(t)) {
        const r = await control.typeName(name, body);
        if (r && r.found) { fill = { via: 'uia', rerun: () => control.typeName(name, body) }; break; }
        // Ignore a UIA error here too: keep going so we still reach the vision
        // fallback below (web fields are exactly where UIA errors / finds nothing).
        const c = await control.clickName(name);
        if (c && c.found) {
          await new Promise((res) => setTimeout(res, 350));
          await control.type(body);
          fill = { via: 'click+type', rerun: async () => { await control.clickName(name); await new Promise((res) => setTimeout(res, 400)); await control.type(body); } };
          break;
        }
      }
      // UIA is blind inside Chrome/Edge web fields (Gmail/Outlook compose, search
      // boxes, React inputs). Fall back to looking at the screen: find the field,
      // click to focus it, then type real keystrokes. This is what makes "write the
      // email in the message body" land without the user clicking first.
      if (!fill) {
        let loc = await visionLocate(t, { fast: true });
        if (!loc.found && !loc.error) loc = await visionLocate(t, { fast: false });
        if (loc.found) {
          const { px, py } = fracToPx(loc.x, loc.y);
          await control.run('click', { x: px, y: py });
          await new Promise((res) => setTimeout(res, 400));
          await control.type(body);
          fill = { via: 'vision', rerun: async () => { await control.run('click', { x: px, y: py }); await new Promise((res) => setTimeout(res, 500)); await control.type(body); } };
        }
      }
      if (!fill) return { typed: false, error: 'field not found: ' + t, target: t };

      // VERIFY the text landed. A field we can read but that is still missing our
      // text is reported typed:false after one corrective retry, which trips the
      // agent's re-plan loop instead of falsely claiming the task is done.
      let state = await verifyLanded(body);
      if (state === 'miss') {
        await Promise.resolve(fill.rerun());
        await new Promise((res) => setTimeout(res, 300));
        state = await verifyLanded(body);
      }
      if (state === 'miss') {
        return { typed: false, verified: false, via: fill.via, error: 'typed but the field is still empty: ' + t, target: t };
      }
      return { typed: true, verified: state === 'ok', via: fill.via, chars: body.length, target: t };
    },
  },
  composeEmail: {
    description:
      'Draft a NEW email by opening a pre-filled Gmail compose window (To, Subject, Body) in the browser. Use only when NO compose window is open yet; if the user already has a new-message window on screen, fill it with typeInto/clickOnScreen + typeText instead. It only prepares the draft; it never sends.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to']
    },
    run: async ({ to, subject, body }) => {
      if (!config.settings.agentAllowAppLaunch) return { error: 'app launch is disabled in Settings' };
      const url =
        'https://mail.google.com/mail/?view=cm&fs=1' +
        '&to=' + encodeURIComponent(to || '') +
        '&su=' + encodeURIComponent(subject || '') +
        '&body=' + encodeURIComponent(body || '');
      const out = await openUrl(url);
      return { ...out, drafted: true, to, subject };
    }
  },
  wait: {
    description: 'Pause for a moment (milliseconds, 200-8000). Use right after openApp to let a window appear before you clickOnScreen/typeText. This is what makes full automation reliable.',
    parameters: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
    run: async ({ ms }) => {
      const n = Math.max(0, Math.min(8000, Number(ms) || 0));
      await new Promise((r) => setTimeout(r, n));
      return { ok: true, waitedMs: n };
    }
  },
  browserNavigate: {
    description:
      'Open a URL in a CDP-controlled browser (Chrome/Edge) for RELIABLE web automation. Launches the debug browser if needed. Use this instead of openApp when you will fill a web form, so browserClick/browserType can drive the page directly.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => {
      const target = /^https?:\/\//i.test(url) ? url : 'https://' + String(url || '');
      const e = await cdp.ensure();
      if (e.error) return e;
      const r = await cdp.openUrl(target);
      return { ...r, url: target, via: 'cdp' };
    }
  },
  browserClick: {
    description:
      'Click a button/link on the current browser page by its visible text, label, or aria name (e.g. "Log in", "Submit", "Continue"). Uses Chrome DevTools Protocol so it works inside web apps where UIA is blind. Returns found:true/false.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: async ({ target }) => {
      const r = await cdp.clickText(target);
      if (r && r.found) return { found: true, via: 'cdp', target };
      // No CDP browser (the page is in the user's own Chrome/Edge) or the element
      // was not in that DOM: fall back to looking at the real screen and clicking,
      // so a browser action still happens without the user clicking first.
      const v = await tools.clickOnScreen.run({ target });
      return { ...v, via: v.found ? (v.via || 'vision') : v.via, fallbackFrom: 'cdp', target };
    }
  },
  browserType: {
    description:
      'Type text INTO a named web input/textarea by its label, placeholder, aria-label or name (e.g. target "Email", "Password", "Search"). Sets the value and fires input/change events so frameworks (React/Gmail) register it. Falls back to locating the field on screen and typing. One step, no separate click. Returns typed:true/false.',
    parameters: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' } }, required: ['target', 'text'] },
    run: async ({ target, text }) => {
      const body = String(text == null ? '' : text);
      const r = await cdp.fillField(target, body);
      if (r && r.found) return { typed: true, via: 'cdp', chars: body.length, target };
      // Same self-heal as browserClick: vision-locate the field, click to focus, type.
      const v = await tools.typeInto.run({ target, text: body });
      return { ...v, fallbackFrom: 'cdp', target };
    }
  },
  createNote: {
    description: 'Save a note (title + body) to the Clicky notebook.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body']
    },
    run: async ({ title, body }) => integrations.writeNote(title, body)
  },
  addReminder: {
    description: 'Add a reminder (optionally with a due date string).',
    parameters: { type: 'object', properties: { text: { type: 'string' }, due: { type: 'string' } }, required: ['text'] },
    run: async ({ text, due }) => integrations.addReminder(text, due)
  }
};

function definitions() {
  return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
}

async function exec(name, args = {}) {
  const t = tools[name];
  if (!t) return { error: 'unknown tool: ' + name };
  try {
    return await t.run(args || {});
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { definitions, exec, tools, bindScreen };
