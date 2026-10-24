const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const log = require('./log');

// Chrome DevTools Protocol path. UI Automation is blind inside Chromium, so web
// forms are the one place where a raw real-mouse click + SendKeys is unreliable.
// We drive Chrome/Edge over CDP instead: launch (or attach to) a browser with a
// remote-debugging port, then click/type by evaluating DOM JS in the page. This
// makes "fill this web form" actually land text in the right field.
//
// Everything here is best-effort: if no CDP browser is reachable and we cannot
// launch one, calls return { error } and the agent falls back to UIA/vision.

const PORT = 9223; // ours, so we never collide with a dev's 9222
const BASE = `http://127.0.0.1:${PORT}`;

function debugProfileDir() {
  const base = process.env.LOCALAPPDATA || os.homedir();
  const dir = path.join(base, 'HeyClicky', 'ChromeDebug');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

function findBrowserExe() {
  if (process.platform !== 'win32') return null;
  const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const names = [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe'
  ];
  const roots = [
    ...pf.map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...pf.map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    path.join(pf[0] || '', 'chrome.exe')
  ];
  for (const cand of names) {
    for (const p of pf) {
      const full = path.join(p, cand);
      if (fs.existsSync(full)) return full;
    }
  }
  for (const r of roots) if (r && fs.existsSync(r)) return r;
  return null;
}

async function probe() {
  try {
    const res = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Ensure a CDP-reachable browser exists. If not, launch one with a debug port.
// Returns { ok, launched } or { error }.
async function ensure() {
  if (process.platform !== 'win32') return { error: 'CDP browser control is Windows-only for now' };
  if (await probe()) return { ok: true, launched: false };
  const exe = findBrowserExe();
  if (!exe) return { error: 'no Chrome or Edge found to enable reliable web control' };
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${debugProfileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ];
  try {
    const p = spawn(exe, args, { windowsHide: true, detached: true });
    p.unref();
  } catch (e) {
    return { error: e.message };
  }
  // Wait up to ~5s for the debug endpoint to come up.
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await probe()) { log.info('cdp', 'browser attached on ' + PORT); return { ok: true, launched: true, exe }; }
  }
  return { error: 'browser launched but its debug port never came up' };
}

async function pages() {
  const res = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await res.json();
  return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
}

// Open a URL in a new tab via the browser-level websocket, then return its page.
async function openUrl(url) {
  const version = await probe();
  if (!version || !version.webSocketDebuggerUrl) { const e = await ensure(); if (e.error) return e; }
  const v = await probe();
  return new Promise((resolve) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(r); } };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) finish({ ok: true, targetId: d.result && d.result.targetId }); };
    ws.onerror = () => finish({ error: 'cdp connect failed' });
    setTimeout(() => finish({ error: 'cdp timeout' }), 4000);
  });
}

// Pick the active/last page target.
async function pickPage() {
  const ps = await pages().catch(() => []);
  if (!ps.length) return null;
  return ps.find((t) => t.active) || ps[0];
}

// Evaluate a JS expression in the page's main world and return its result value.
async function evaluate(expression, { awaitPromise = false } = {}) {
  const page = await pickPage();
  if (!page || !page.webSocketDebuggerUrl) return { error: 'no browser tab is open' };
  return new Promise((resolve) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { ws.close(); } catch (e) {} resolve(r); } };
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
    };
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 2) {
        if (d.error) return finish({ error: d.error.message });
        const r = d.result && d.result.result;
        return finish({ ok: true, value: r && r.value });
      }
    };
    ws.onerror = () => finish({ error: 'cdp eval connect failed' });
    setTimeout(() => finish({ error: 'cdp eval timeout' }), 6000);
  });
}

// JS injected into the page to find an element the way a human reads the screen:
// by visible text, label, placeholder, aria-label, or name. Returns a stable id.
const FIND_FN = `
window.__clickyFind = function(q){
  q = (q||'').toLowerCase().trim();
  const norm = (s) => (s||'').toLowerCase().replace(/\\s+/g,' ').trim();
  const pool = Array.from(document.querySelectorAll('button,a,[role=button],input,textarea,select,label,[aria-label],[placeholder],[ng-click],.btn,[type=submit],[type=button]'));
  let best=null, bestScore=0;
  for (const el of pool){
    const txt=norm(el.innerText||el.textContent); const al=norm(el.getAttribute('aria-label'));
    const ph=norm(el.getAttribute('placeholder')); const nm=norm(el.getAttribute('name')); const lab=norm(el.labels&&el.labels[0]&&el.labels[0].textContent);
    const hay=[txt,al,ph,nm,lab].filter(Boolean);
    let score=0;
    for (const h of hay){ if(h===q) score=Math.max(score,4); else if(h.includes(q)||q.includes(h)) score=Math.max(score,2); }
    if(score>bestScore){bestScore=score;best=el;}
  }
  return best;
};
`;

async function clickText(target) {
  const e = await evaluate(`${FIND_FN}
    (function(){ const el = window.__clickyFind(${JSON.stringify(String(target||''))});
      if(!el) return JSON.stringify({found:false});
      el.scrollIntoView({block:'center'}); el.click();
      const r = el.getBoundingClientRect();
      return JSON.stringify({found:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), label:(el.innerText||el.getAttribute('aria-label')||target||'').slice(0,40)});
    })();`);
  if (e.error) return e;
  try { return JSON.parse(e.value); } catch (_) { return { found: false }; }
}

async function fillField(target, text) {
  const e = await evaluate(`${FIND_FN}
    (function(){ const el = window.__clickyFind(${JSON.stringify(String(target||''))});
      const body = ${JSON.stringify(String(text == null ? '' : text))};
      if(!el) return JSON.stringify({found:false});
      el.scrollIntoView({block:'center'}); el.focus();
      const editable = el.isContentEditable;
      if (editable) { document.execCommand('insertText', false, body); }
      else {
        const proto = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el, body);
      }
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
      return JSON.stringify({found:true, typed:true, chars: body.length});
    })();`);
  if (e.error) return e;
  try { return JSON.parse(e.value); } catch (_) { return { found: false }; }
}

module.exports = { ensure, probe, openUrl, pickPage, evaluate, clickText, fillField };
