const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const log = require('./log');

// Drives assets/input.ps1 (real Windows mouse + keyboard via UIA + SendKeys).
// No native deps, no clipboard. Coordinates for clickAt are absolute physical
// pixels; for *Name actions the PowerShell side resolves the control.
//
// Speed: we keep ONE hidden "server" PowerShell alive (-Server) reading JSON
// commands over stdin, so we pay the ~400ms PowerShell cold-start + UIAutomation
// assembly load only once instead of on every action. If that process ever dies
// or a command times out, we transparently fall back to one-shot spawns so the
// agent never stalls. Text is sent inside the JSON (never as an arg) to avoid
// quoting bugs with long/multiline content.
const SCRIPT = path.join(__dirname, '..', 'assets', 'input.ps1');

function parseResult(text, action, code) {
  const t = (text || '').trim();
  if (/^err\b/.test(t)) return { error: t.slice(3).trim() || 'input error' };
  const m = t.match(/found\s+(\d+)\s+(\d+)/);
  if (m) return { ok: true, action, found: true, x: Number(m[1]), y: Number(m[2]) };
  if (/\bnotfound\b/.test(t)) return { ok: true, action, found: false };
  if (/\bfound\b/.test(t)) return { ok: true, action, found: true };
  if (code != null && code !== 0) return { error: `powershell exit ${code}: ${t.slice(0, 300)}` };
  return { ok: true, action };
}

// --- one-shot path (the always-available fallback) --------------------------
function runOnce(action, opts = {}) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action];
    if (opts.x != null) args.push('-X', String(Math.round(opts.x)));
    if (opts.y != null) args.push('-Y', String(Math.round(opts.y)));
    if (opts.name) args.push('-Name', String(opts.name));
    if (opts.key) args.push('-Key', opts.key);
    if (opts.steps != null) args.push('-Steps', String(opts.steps));
    if (opts.delayMs != null) args.push('-DelayMs', String(opts.delayMs));
    const env = Object.assign({}, process.env);
    if (opts.text != null) env.CLICKY_TEXT = String(opts.text);

    let p;
    try {
      p = spawn('powershell', args, { windowsHide: true, env });
    } catch (e) {
      return resolve({ error: e.message });
    }
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ error: e.message }));
    p.on('close', (code) => resolve(parseResult(out || err, action, code)));
  });
}

// --- persistent server path -------------------------------------------------
let server = null; // { proc, waiter, dead }
let chain = Promise.resolve(); // serializes stdin writes -> one response at a time

function startServer() {
  if (server && !server.dead) return server;
  let proc;
  try {
    proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Server'],
      { windowsHide: true }
    );
  } catch (e) {
    log.error('input', 'server spawn failed', { error: e.message });
    return null;
  }
  const s = { proc, waiter: null, dead: false };
  server = s;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (s.waiter) { const w = s.waiter; s.waiter = null; w(line); }
  });
  proc.stderr.on('data', (d) => log.warn('input', 'server stderr', { data: String(d).slice(0, 200) }));
  proc.on('close', () => teardown(s, 'process exited'));
  proc.on('error', (e) => teardown(s, e.message));
  log.info('input', 'server started');
  return s;
}

function teardown(s, reason) {
  if (s.dead) return;
  s.dead = true;
  if (server === s) server = null;
  if (s.waiter) { const w = s.waiter; s.waiter = null; w(null); } // null => caller falls back
  log.warn('input', 'server down', { reason });
}

// Send one command to the server. Resolves with the raw response line, or null
// if the server is unavailable/failed (so run() falls back to one-shot).
function serverRun(cmd, timeoutMs) {
  return chain.then(
    () =>
      new Promise((resolve) => {
        const s = startServer();
        if (!s || s.dead) return resolve(null);
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (server) server.waiter = null;
          resolve(v);
        };
        const timer = setTimeout(() => {
          teardown(s, 'command timeout');
          finish(null);
        }, timeoutMs);
        s.waiter = (line) => finish(line);
        try {
          s.proc.stdin.write(JSON.stringify(cmd) + '\n');
        } catch (e) {
          clearTimeout(timer);
          finish(null);
        }
      })
  );
}

function timeoutFor(opts) {
  if (opts.text && String(opts.text).length > 200) return 90000;
  return 20000;
}

async function run(action, opts = {}) {
  const cmd = {
    action,
    x: opts.x != null ? Math.round(opts.x) : undefined,
    y: opts.y != null ? Math.round(opts.y) : undefined,
    name: opts.name,
    key: opts.key,
    text: opts.text,
    steps: opts.steps,
    delayMs: opts.delayMs
  };
  const hasText = opts.text != null;
  const started = Date.now();
  let line = await serverRun(cmd, timeoutFor(opts));
  let res;
  let via = 'server';
  if (line === null || line === undefined) {
    via = 'one-shot';
    res = await runOnce(action, opts);
  } else {
    res = parseResult(line, action, 0);
  }
  const ms = Date.now() - started;
  log.info(
    'input',
    `${action}${opts.name ? ' name=' + JSON.stringify(opts.name) : ''}${hasText ? ' textLen=' + String(opts.text).length : ''} (${via}, ${ms}ms) -> ${
      res.error ? 'ERR ' + res.error : res.found === false ? 'notfound' : res.found ? 'found ' + (res.x != null ? res.x + ',' + res.y : '') : 'ok'
    }`
  );
  return res;
}

function shutdown() {
  if (server) {
    try {
      server.proc.stdin.end();
      server.proc.kill();
    } catch (e) {}
    server = null;
  }
}

module.exports = {
  run,
  shutdown,
  move: (x, y) => run('move', { x, y }),
  click: (x, y) => run('click', { x, y }),
  doubleClick: (x, y) => run('doubleclick', { x, y }),
  type: (text) => run('type', { text }),
  key: (key) => run('key', { key }),
  findName: (name) => run('findName', { name }),
  clickName: (name) => run('clickName', { name }),
  typeName: (name, text) => run('typeName', { name, text })
};
