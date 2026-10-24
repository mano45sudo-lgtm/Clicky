// First-run wizard. Reads the current setup, lets the user verify desktop
// control, runs one safe real action (draw a smiley), then finishes.
const $ = (id) => document.getElementById(id);

function pill(label, on) {
  return '<span class="pill ' + (on ? 'on' : 'off') + '">' + label + (on ? ' \u2713' : ' \u2014 add key') + '</span>';
}

async function loadKeys() {
  const el = $('keys');
  try {
    const s = await window.clicky.settingsGet();
    const brain = s.provider !== 'mock' ? s.provider : 'none';
    const parts = [];
    parts.push(pill('Brain: ' + brain, s.provider !== 'mock'));
    parts.push(pill('Vision', Boolean(s.geminiApiKey || s.anthropicApiKey)));
    parts.push(pill('Voice (STT/TTS)', s.sttProvider !== 'mock' && s.ttsProvider !== 'mock'));
    parts.push(pill('Desktop control', Boolean(s.agentAllowInput)));
    el.innerHTML = parts.join('');
    if (s.provider === 'mock') {
      el.innerHTML += '<p style="margin-top:8px;color:#f87171">No brain key yet - add one in Settings so Clicky can think.</p>';
    }
  } catch (e) {
    el.textContent = 'Could not read settings.';
  }
}

$('openSettings').onclick = () => window.clicky.openSettings();

$('check').onclick = async () => {
  const msg = $('checkMsg');
  msg.className = 'msg';
  msg.textContent = 'Checking...';
  const r = await window.clicky.diagnose();
  if (r && r.ok) {
    msg.className = 'msg ok';
    msg.textContent = 'Desktop control works - Clicky can move the mouse and type.';
    $('exclusions').style.display = 'none';
  } else {
    msg.className = 'msg bad';
    msg.textContent = 'Blocked: ' + ((r && r.detail) || 'unknown') + '. Your antivirus may be stopping PowerShell.';
    $('exclusions').style.display = 'inline-block';
  }
};

$('exclusions').onclick = () => window.clicky.openExclusions();

let demoRunning = false;
$('demo').onclick = () => {
  if (demoRunning) return;
  demoRunning = true;
  const msg = $('demoMsg');
  msg.className = 'msg';
  msg.textContent = 'Clicky is drawing... watch your screen.';
  window.clicky.agent('Draw a big friendly smiley face in the middle of my screen.');
};

if (window.clicky && window.clicky.onAgent) {
  window.clicky.onAgent((p) => {
    if (p.type === 'done') {
      demoRunning = false;
      const msg = $('demoMsg');
      msg.className = 'msg ' + (p.failures ? 'bad' : 'ok');
      msg.textContent = p.summary || 'Done.';
    }
  });
}

function finish() {
  window.clicky.onboardFinish();
}
$('done').onclick = finish;
$('skip').onclick = finish;

if (window.clicky) loadKeys();
