const STIFFNESS = 0.18;
const DAMPING = 0.62;
const FOLLOW_OFFSET = { x: 14, y: 14 };

const CANVAS_SIZE = 84;
const CURSOR_HOTSPOT = { x: 8.5, y: 6 };

const canvas = document.getElementById('clicky');
const ctx = canvas.getContext('2d');
const caption = document.getElementById('caption');
const captionLabel = caption.querySelector('.label');
const captionText = caption.querySelector('.text');
const ring = document.getElementById('ring');
const ringTag = ring.querySelector('.tag');
const agentEl = document.getElementById('agent');
const agentGoal = agentEl.querySelector('.goal');
const agentList = agentEl.querySelector('ul');
const body = document.body;

const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const pos = { x: target.x, y: target.y };
const velocity = { x: 0, y: 0 };

let state = 'idle';
let frame = 0;
let myDisplayId = null;

const LABELS = { idle: '', listening: 'Listening...', thinking: 'Thinking...', speaking: 'Clicky' };

window.onCursorMove((point) => {
  target.x = point.x + FOLLOW_OFFSET.x;
  target.y = point.y + FOLLOW_OFFSET.y;
});

function setCaption(label, text) {
  captionLabel.textContent = label || '';
  captionLabel.style.display = label ? 'block' : 'none';
  captionText.textContent = text || '';
  caption.classList.toggle('visible', Boolean(label || text));
}

if (window.clicky) {
  window.clicky.onInit((p) => {
    myDisplayId = p.displayId;
  });

  window.clicky.onState((payload) => {
    state = payload.state || 'idle';
    body.dataset.state = state;
    if (state === 'listening') setCaption(LABELS.listening, '');
    else if (state === 'thinking') setCaption(LABELS.thinking, payload.question || '');
    else if (state === 'idle') setCaption('', '');
  });

  window.clicky.onResult((payload) => {
    setCaption(LABELS.speaking, (payload && payload.answer) || '');
  });

  window.clicky.onPoint((p) => {
    if (!p || !p.target) {
      ring.classList.remove('visible');
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const t = p.target;
    const w = Math.max(44, t.w * W);
    const h = Math.max(44, t.h * H);
    const left = t.x * W - w / 2;
    const top = t.y * H - h / 2;
    ring.style.width = w + 'px';
    ring.style.height = h + 'px';
    ring.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    ringTag.textContent = p.label || '';
    ring.classList.add('visible');
  });

  window.clicky.onAgent((p) => {
    agentEl.classList.add('visible');
    if (p.type === 'start' || p.type === 'status') {
      if (p.goal) agentGoal.textContent = p.goal;
      if (p.type === 'start') agentList.innerHTML = '';
    } else if (p.type === 'step') {
      if (p.state === 'running') {
        const li = document.createElement('li');
        li.dataset.tool = p.tool;
        li.className = 'running';
        li.textContent = p.tool + (p.reason ? ' - ' + p.reason : '');
        agentList.appendChild(li);
      } else if (p.state === 'done') {
        const li = [...agentList.children].find((x) => x.dataset.tool === p.tool && x.className === 'running');
        if (li) {
          li.className = 'done';
          li.textContent = p.tool + ' \u2713';
        }
      }
    } else if (p.type === 'done') {
      agentGoal.textContent = (p.summary || 'Done');
      setTimeout(() => agentEl.classList.remove('visible'), 7000);
    }
  });

  // Push-to-talk microphone capture, targeted at this display only.
  window.clicky.onRecord((p) => {
    if (p && p.on) startRecording();
    else stopRecording();
  });

  // Hands-free conversation: main arms us for one utterance; we auto-detect
  // start/end of speech and send the completed utterance back.
  window.clicky.onConversation((p) => {
    if (p && p.on) startConversation(p);
    else stopConversation(false);
  });
}

// --- Microphone -> WAV (16-bit PCM mono 16 kHz) ----------------------------
let rec = null;

async function startRecording() {
  if (rec) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const actx = new AudioCtx();
    const src = actx.createMediaStreamSource(stream);
    const proc = actx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(actx.destination);
    rec = { stream, actx, proc, chunks, sampleRate: actx.sampleRate };
  } catch (err) {
    console.error('[rec] mic unavailable', err.message);
    rec = null;
    if (window.clicky) window.clicky.sendAudio(null);
  }
}

function stopRecording() {
  if (!rec) return;
  const { stream, actx, chunks, sampleRate } = rec;
  rec = null;
  try {
    stream.getTracks().forEach((t) => t.stop());
    actx.close();
  } catch (e) {}

  const samples = concat(chunks);
  if (!samples.length) {
    if (window.clicky) window.clicky.sendAudio(null);
    return;
  }
  const down = downsampleTo16k(samples, sampleRate);
  const wav = encodeWav(down, 16000);
  if (window.clicky) window.clicky.sendAudio(bufferToBase64(wav));
}

// --- Hands-free conversation (voice activity detection) --------------------
// Main arms us once per turn. We listen for speech onset, capture until trailing
// silence, then send that single utterance back and close the mic (so Clicky's
// own voice is never picked up). Main re-arms us after it finishes speaking.
let conv = null;
const VAD = { frame: 2048, onset: 0.02, off: 0.012, maxMs: 15000, leadInFrames: 10, minSpeechMs: 250 };

async function startConversation(p) {
  if (conv) return;
  const silenceMs = (p && p.silenceMs) || 900;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const actx = new AudioCtx();
    const src = actx.createMediaStreamSource(stream);
    const proc = actx.createScriptProcessor(VAD.frame, 1, 1);
    conv = {
      stream, actx, proc, silenceMs, sampleRate: actx.sampleRate,
      phase: 'armed', captured: [], leadIn: [], lastVoice: 0, startedAt: 0
    };
    proc.onaudioprocess = onVadFrame;
    src.connect(proc);
    proc.connect(actx.destination);
  } catch (err) {
    console.error('[conv] mic unavailable', err.message);
    conv = null;
    if (window.clicky) window.clicky.utterance(null); // signal mic error to main
  }
}

function onVadFrame(e) {
  if (!conv) return;
  const data = new Float32Array(e.inputBuffer.getChannelData(0));
  let sum = 0;
  for (let i = 0; i < data.length; i++) { const s = data[i]; sum += s * s; }
  const rms = Math.sqrt(sum / data.length);
  const now = performance.now();

  if (conv.phase === 'armed') {
    conv.leadIn.push(data);
    if (conv.leadIn.length > VAD.leadInFrames) conv.leadIn.shift();
    if (rms >= VAD.onset) {
      conv.phase = 'capturing';
      conv.captured = conv.leadIn.slice(); // keep the lead-in so the first syllable isn't cut
      conv.leadIn = [];
      conv.captured.push(data);
      conv.lastVoice = now;
      conv.startedAt = now;
    }
  } else {
    conv.captured.push(data);
    if (rms >= VAD.off) conv.lastVoice = now;
    const spokeEnough = now - conv.startedAt > VAD.minSpeechMs;
    const wentSilent = now - conv.lastVoice >= conv.silenceMs;
    const tooLong = now - conv.startedAt >= VAD.maxMs;
    if ((spokeEnough && wentSilent) || tooLong) finishUtterance();
  }
}

function finishUtterance() {
  const c = conv;
  conv = null;
  teardown(c);
  const samples = concat(c.captured);
  if (!samples.length) {
    if (window.clicky) window.clicky.utterance(null);
    return;
  }
  const down = downsampleTo16k(samples, c.sampleRate);
  const wav = encodeWav(down, 16000);
  if (window.clicky) window.clicky.utterance(bufferToBase64(wav));
}

function stopConversation() {
  const c = conv;
  conv = null;
  if (c) teardown(c);
}

function teardown(c) {
  try {
    c.proc.onaudioprocess = null;
    c.proc.disconnect();
    c.stream.getTracks().forEach((t) => t.stop());
    c.actx.close();
  } catch (e) {}
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function downsampleTo16k(input, fromRate) {
  const toRate = 16000;
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const WStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  WStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  WStr(8, 'WAVE');
  WStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  WStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// --- Character drawing ------------------------------------------------------
function drawCursor() {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.save();
  ctx.translate(13, 9);

  ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 4;

  ctx.fillStyle = state === 'listening' ? '#e6fff6' : '#ffffff';
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(4, 3);
  ctx.lineTo(4, 57);
  ctx.lineTo(19, 43);
  ctx.lineTo(29, 65);
  ctx.lineTo(40, 60);
  ctx.lineTo(30, 39);
  ctx.lineTo(50, 39);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(10, 14);
  ctx.lineTo(10, 43);
  ctx.lineTo(18, 35);
  ctx.stroke();

  ctx.restore();
}

function stateScale() {
  if (state === 'listening') return 1 + Math.sin(frame / 8) * 0.05;
  if (state === 'thinking') return 1 + Math.sin(frame / 6) * 0.03;
  if (state === 'speaking') return 1 + Math.sin(frame / 5) * 0.06;
  return 1 + Math.sin(frame / 40) * 0.015;
}

function tick() {
  frame += 1;
  velocity.x += (target.x - pos.x) * STIFFNESS;
  velocity.y += (target.y - pos.y) * STIFFNESS;
  velocity.x *= DAMPING;
  velocity.y *= DAMPING;
  pos.x += velocity.x;
  pos.y += velocity.y;

  drawCursor();
  const scale = stateScale();
  canvas.style.transform =
    `translate3d(${pos.x - CURSOR_HOTSPOT.x}px, ${pos.y - CURSOR_HOTSPOT.y}px, 0) scale(${scale})`;
  positionCaption();

  requestAnimationFrame(tick);
}

function positionCaption() {
  const pad = 12;
  const gap = 30;
  const w = caption.offsetWidth || 240;
  const h = caption.offsetHeight || 60;
  let x = pos.x + gap;
  let y = pos.y + 8;
  if (x + w + pad > window.innerWidth) x = pos.x - w - gap;
  if (x < pad) x = pad;
  if (y + h + pad > window.innerHeight) y = window.innerHeight - h - pad;
  if (y < pad) y = pad;
  caption.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

requestAnimationFrame(tick);
