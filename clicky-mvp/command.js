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
      line.className = 'step ' + (p.state === 'done' ? 'done' : 'running');
      line.textContent = p.state === 'done' ? p.tool + ' \u2713' : 'Running ' + p.tool + (p.reason ? ' - ' + p.reason : '');
      if (p.state === 'done') {
        const running = [...agentSteps.children].find((c) => c.textContent.startsWith('Running ' + p.tool));
        if (running) {
          running.className = 'step done';
          running.textContent = p.tool + ' \u2713';
          return;
        }
      }
      agentSteps.appendChild(line);
      log.scrollTop = log.scrollHeight;
    } else if (p.type === 'done') {
      const line = document.createElement('div');
      line.className = 'step done';
      line.textContent = 'Done: ' + (p.summary || '');
      (agentSteps || agentMsg).appendChild(line);
      log.scrollTop = log.scrollHeight;
    }
  });

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
