const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('../config');
const { capturePrimaryDisplay } = require('./capture');
const integrations = require('./integrations');

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

module.exports = { definitions, exec, tools };
