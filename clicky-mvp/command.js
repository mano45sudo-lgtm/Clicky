const log = document.getElementById('log');
const input = document.getElementById('input');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');

function add(cls, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function setState(s) {
  dot.className = 'dot ' + (s || 'idle');
  statusEl.textContent = s || 'idle';
}

const askBtn = document.getElementById('askBtn');
const walkBtn = document.getElementById('walkBtn');
const agentBtn = document.getElementById('agentBtn');
const stopBtn = document.getElementById('stopBtn');

function text() {
  return (input.value || '').trim();
}

async function doAsk() {
  const q = text();
  if (!q) return;
  add('user', q);
  input.value = '';
  await window.clicky.ask(q);
}

async function doWalk() {
  const q = text();
  add('sys', q ? 'Walking you through: ' + q : 'Walking you through the current screen');
  input.value = '';
  await window.clicky.walkthrough(q);
}

async function doAgent() {
  const g = text();
  if (!g) return;
  add('user', 'Agent: ' + g);
  input.value = '';
  await window.clicky.agent(g);
}

askBtn.onclick = doAsk;
walkBtn.onclick = doWalk;
agentBtn.onclick = doAgent;
stopBtn.onclick = () => window.clicky.agentCancel();

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doAsk();
  }
});

if (window.clicky) {
  window.clicky.onState((p) => setState(p.state));
  window.clicky.onResult((p) => {
    if (p && p.answer) add('clicky', p.answer);
  });
  window.clicky.onPrefillAgent(() => {
    input.focus();
    input.placeholder = 'Give the agent a goal (it can search, read/write files, open apps, take notes)...';
    add('sys', 'Agent ready. Type a goal and press Run Agent.');
  });

  let agentMsg = null;
  let agentSteps = null;
  window.clicky.onAgent((p) => {
    if (p.type === 'start') {
      agentMsg = add('agent', 'Agent goal: ' + p.goal);
      agentSteps = document.createElement('div');
      agentMsg.appendChild(agentSteps);
    } else if (p.type === 'step' && agentSteps) {
      const line = document.createElement('div');
      const label = p.label || p.tool;
      if (p.state === 'running') {
        line.className = 'step running';
        line.textContent = 'Running ' + label + (p.reason ? ' - ' + p.reason : '');
      } else if (p.state === 'preview') {
        line.className = 'step';
        line.textContent = '\u25e1 ' + label + ' (planned)';
      } else {
        line.className = 'step ' + (p.state === 'done' ? 'done' : 'error');
        line.textContent = label + (p.state === 'done' ? ' \u2713' : ' \u2717 ' + (p.detail || 'failed'));
        const running = [...agentSteps.children].find((c) => c.dataset && c.dataset.idx === String(p.index));
        if (running) { running.replaceWith(line); log.scrollTop = log.scrollHeight; return; }
      }
      line.dataset.idx = String(p.index);
      agentSteps.appendChild(line);
      log.scrollTop = log.scrollHeight;
    } else if (p.type === 'confirm') {
      if (p.decision) return; // the gate cleared
      addAgentConfirm(p);
    } else if (p.type === 'done') {
      const line = document.createElement('div');
      line.className = 'step done';
      line.textContent = 'Done: ' + (p.summary || '');
      (agentSteps || agentMsg).appendChild(line);
      log.scrollTop = log.scrollHeight;
    }
  });

  // A destructive action is waiting for an explicit Allow/Block decision. The
  // STOP key always works; these buttons are the convenient path here.
  function addAgentConfirm(p) {
    const box = add('agent', '\u26a0 Clicky wants to: ' + (p.label || p.tool));
    box.style.borderLeft = '3px solid #ef4444';
    const why = document.createElement('div');
    why.className = 'step';
    why.style.color = '#fca5a5';
    why.textContent = p.reason || 'This is hard to undo.';
    box.appendChild(why);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    const allow = document.createElement('button');
    allow.className = 'primary';
    allow.textContent = 'Allow once';
    const block = document.createElement('button');
    block.className = 'danger';
    block.textContent = 'Block';
    const stopb = document.createElement('button');
    stopb.textContent = 'Stop agent';
    allow.onclick = () => { allow.disabled = block.disabled = stopb.disabled = true; window.clicky.agentConfirm('allow'); };
    block.onclick = () => { allow.disabled = block.disabled = stopb.disabled = true; window.clicky.agentConfirm('block'); };
    stopb.onclick = () => { allow.disabled = block.disabled = stopb.disabled = true; window.clicky.agentCancel(); };
    row.append(allow, block, stopb);
    box.appendChild(row);
    box.scrollIntoView();
  }

  // Load recent history once.
  window.clicky.historyGet().then((h) => {
    if (h && h.conversation && h.conversation.length) {
      add('sys', 'Earlier today:');
      h.conversation.slice(-6).forEach((t) => {
        if (t.question) add('user', t.question);
        if (t.answer) add('clicky', t.answer);
      });
    }
  });
}
