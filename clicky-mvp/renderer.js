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

// Full-screen layers: #draw = persistent pictures, #fx = animated cursor guide.
const drawCanvas = document.getElementById('draw');
const dctx = drawCanvas.getContext('2d');
const fxCanvas = document.getElementById('fx');
const fctx = fxCanvas.getContext('2d');
let drawItems = [];
let guide = null; // { x, y, label, since }
let selRect = null; // { x, y, w, h } display-local: the "circle to ask" marquee

const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const pos = { x: target.x, y: target.y };
const velocity = { x: 0, y: 0 };

let state = 'idle';
let frame = 0;
let myDisplayId = null;
// Micro-interaction state: eased lean into the direction of travel, a periodic
// eye-blink squash, and a short position trail for a motion echo.
let tilt = 0;
let blinkAt = 1400;
let blinkUntil = 0;
const trail = [];

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
      if (p.type === 'start') { agentList.innerHTML = ''; agentEl.classList.remove('confirming'); }
      if (p.state === 'recovering') agentGoal.textContent = p.goal + '  \u00b7  recovering\u2026';
    } else if (p.type === 'confirm') {
      if (p.decision) {
        agentEl.classList.remove('confirming');
        if (agentGoal.dataset.confirming) { delete agentGoal.dataset.confirming; }
        return;
      }
      // A destructive step is waiting on the user. Overlay is click-through, so
      // the actionable Allow/Block buttons live in the command window; here we
      // shout the warning and show the always-available STOP key hint.
      agentEl.classList.add('confirming');
      agentGoal.dataset.confirming = '1';
      agentGoal.textContent = '\u26a0 Need your OK: ' + (p.label || p.tool) + ' \u2014 ' + (p.reason || '') + '. Press Escape to STOP.';
    } else if (p.type === 'step') {
      if (p.state === 'running') {
        const li = document.createElement('li');
        li.dataset.idx = p.index;
        li.className = 'running';
        li.textContent = (p.label || p.tool) + (p.reason ? '  \u00b7  ' + p.reason : '');
        agentList.appendChild(li);
      } else if (p.state === 'preview') {
        const li = document.createElement('li');
        li.dataset.idx = p.index;
        li.className = 'preview';
        li.textContent = '\u25e1 ' + (p.label || p.tool) + ' (planned)';
        agentList.appendChild(li);
      } else {
        const li = [...agentList.children].find((x) => x.dataset.idx === String(p.index));
        if (li) {
          const bad = p.state === 'error';
          li.className = bad ? 'error' : 'done';
          li.textContent = (p.label || p.tool) + (bad ? '  \u2717  ' : '  \u2713  ') + (p.detail || '');
        }
      }
    } else if (p.type === 'done') {
      agentEl.classList.remove('confirming');
      agentGoal.textContent = p.summary || 'Done';
      agentGoal.classList.toggle('err', Boolean(p.failures));
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

  // Agent drawing + cursor guidance onto the full-screen layers.
  if (window.clicky.onDraw) {
    window.clicky.onDraw((p) => {
      if (!p) return;
      if (p.op === 'clear') { drawItems = []; renderDraw(); return; }
      const list = p.items || p.shapes || [];
      if (p.clearFirst) drawItems = [];
      drawItems = drawItems.concat(list);
      renderDraw();
    });
  }
  if (window.clicky.onGuide) {
    window.clicky.onGuide((p) => {
      if (!p || p.clear) { guide = null; return; }
      guide = { x: p.x, y: p.y, label: p.label || '', since: performance.now() };
    });
  }
  if (window.clicky.onSelect) {
    window.clicky.onSelect((r) => { selRect = r && r.w > 0 && r.h > 0 ? r : null; });
  }
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

// --- On-screen drawing + cursor guide --------------------------------------
function sizeLayer(canvas) {
  const w = window.innerWidth, h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
function mapX(v, W) { return v <= 1 ? v * W : v; }
function mapY(v, H) { return v <= 1 ? v * H : v; }
function mapS(v, S) { return v <= 1 ? v * S : v; }

function renderDraw() {
  sizeLayer(drawCanvas);
  const W = drawCanvas.width, H = drawCanvas.height, S = Math.min(W, H);
  dctx.clearRect(0, 0, W, H);
  for (const it of drawItems) renderItem(dctx, it, W, H, S);
}

function renderItem(g, it, W, H, S) {
  if (!it) return;
  const shape = String(it.shape || it.kind || '').toLowerCase();
  const color = it.color || '#38bdf8';
  const lw = it.width ? mapS(it.width, S) : Math.max(3, S * 0.006);
  g.save();
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round';
  const cx = mapX(it.x != null ? it.x : 0.5, W);
  const cy = mapY(it.y != null ? it.y : 0.5, H);
  const size = mapS(it.size != null ? it.size : 0.16, S);
  const x2 = it.x2 != null ? mapX(it.x2, W) : cx + size;
  const y2 = it.y2 != null ? mapY(it.y2, H) : cy;

  switch (shape) {
    case 'circle': g.beginPath(); g.arc(cx, cy, size / 2, 0, Math.PI * 2); it.fill ? g.fill() : g.stroke(); break;
    case 'square': case 'rect': g.beginPath(); g.rect(cx - size / 2, cy - size / 2, size, size); it.fill ? g.fill() : g.stroke(); break;
    case 'triangle': g.beginPath(); g.moveTo(cx, cy - size / 2); g.lineTo(cx + size / 2, cy + size / 2); g.lineTo(cx - size / 2, cy + size / 2); g.closePath(); it.fill ? g.fill() : g.stroke(); break;
    case 'line': g.beginPath(); g.moveTo(mapX(it.x, W), mapY(it.y, H)); g.lineTo(x2, y2); g.stroke(); break;
    case 'arrow': arrow(g, mapX(it.x != null ? it.x : 0.2, W), mapY(it.y != null ? it.y : 0.5, H), x2, y2, lw); break;
    case 'text': g.font = `600 ${size * 0.6}px system-ui, "Segoe UI", sans-serif`; g.textBaseline = 'middle'; g.fillText(it.text || '', cx, cy); break;
    case 'smiley': smiley(g, cx, cy, size, color); break;
    case 'heart': heart(g, cx, cy, size, color); break;
    case 'star': star(g, cx, cy, size / 2, color); break;
    case 'house': house(g, cx, cy, size, color); break;
    case 'check': g.beginPath(); g.moveTo(cx - size / 2, cy); g.lineTo(cx - size / 8, cy + size / 3); g.lineTo(cx + size / 2, cy - size / 3); g.stroke(); break;
    case 'path': if (it.points) { g.beginPath(); it.points.forEach((p, i) => (i ? g.lineTo(mapX(p[0], W), mapY(p[1], H)) : g.moveTo(mapX(p[0], W), mapY(p[1], H)))); if (it.closed) g.closePath(); it.fill ? g.fill() : g.stroke(); } break;
    default: g.beginPath(); g.arc(cx, cy, size / 2, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

function arrow(g, x1, y1, x2, y2, lw) {
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(12, lw * 5);
  g.beginPath(); g.moveTo(x2, y2);
  g.lineTo(x2 - len * Math.cos(a - Math.PI / 6), y2 - len * Math.sin(a - Math.PI / 6));
  g.moveTo(x2, y2);
  g.lineTo(x2 - len * Math.cos(a + Math.PI / 6), y2 - len * Math.sin(a + Math.PI / 6));
  g.stroke();
}

function smiley(g, cx, cy, size, color) {
  const r = size / 2;
  g.strokeStyle = color; g.lineWidth = Math.max(3, size * 0.05);
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.fillStyle = color;
  const ex = r * 0.35, ey = -r * 0.25, er = Math.max(2, size * 0.045);
  g.beginPath(); g.arc(cx - ex, cy + ey, er, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(cx + ex, cy + ey, er, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(cx, cy + r * 0.05, r * 0.55, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
}

function heart(g, cx, cy, size, color) {
  const s = size / 16; g.fillStyle = color; g.beginPath();
  g.moveTo(cx, cy + s * 5);
  g.bezierCurveTo(cx, cy + s * 2, cx - s * 8, cy - s * 6, cx - s * 8, cy + s * 1);
  g.bezierCurveTo(cx - s * 8, cy + s * 5, cx, cy + s * 8, cx, cy + s * 10);
  g.bezierCurveTo(cx, cy + s * 8, cx + s * 8, cy + s * 5, cx + s * 8, cy + s * 1);
  g.bezierCurveTo(cx + s * 8, cy - s * 6, cx, cy + s * 2, cx, cy + s * 5);
  g.fill();
}

function star(g, cx, cy, r, color) {
  g.fillStyle = color; g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath(); g.fill();
}

function house(g, cx, cy, size, color) {
  const w = size, h = size * 0.7, top = cy - h / 2;
  g.strokeStyle = color; g.lineWidth = Math.max(3, size * 0.04);
  g.beginPath(); g.rect(cx - w / 2, top + h * 0.4, w, h * 0.6); g.stroke();
  g.beginPath(); g.moveTo(cx - w / 2, top + h * 0.4); g.lineTo(cx, top); g.lineTo(cx + w / 2, top + h * 0.4); g.closePath(); g.stroke();
}

// A Figma-style multiplayer cursor bubble: a small pointer + a rounded label
// with a muted name line and a bold message line (adapted from the Cursor
// component into our canvas overlay - this app is Electron/vanilla JS, not React).
function drawBubble(g, x, y, name, message, accent) {
  const S = Math.min(fxCanvas.width, fxCanvas.height);
  const fs = Math.max(13, S * 0.017);
  const padX = fs * 0.85, padY = fs * 0.6, lineH = fs * 1.3;
  g.textBaseline = 'top';
  g.font = `700 ${fs}px system-ui, "Segoe UI", sans-serif`;
  const wMsg = g.measureText(message || '').width;
  g.font = `600 ${fs * 0.9}px system-ui, "Segoe UI", sans-serif`;
  const wName = g.measureText(name || '').width;
  const bw = Math.max(wMsg, wName) + padX * 2;
  const lines = (name ? 1 : 0) + (message ? 1 : 0);
  const bh = padY * 2 + lineH * Math.max(1, lines);
  const bx = x + 16, by = y + 18;
  g.fillStyle = accent;
  g.beginPath();
  g.moveTo(x, y); g.lineTo(x + 13, y + 13); g.lineTo(x + 4, y + 15); g.closePath(); g.fill();
  g.beginPath();
  if (g.roundRect) g.roundRect(bx, by, bw, bh, 10); else g.rect(bx, by, bw, bh);
  g.fillStyle = 'rgba(17,24,39,0.94)'; g.fill();
  g.lineWidth = 2; g.strokeStyle = accent; g.stroke();
  let ty = by + padY;
  if (name) { g.fillStyle = 'rgba(226,232,240,0.6)'; g.font = `600 ${fs * 0.9}px system-ui, "Segoe UI", sans-serif`; g.fillText(name, bx + padX, ty); ty += lineH; }
  if (message) { g.fillStyle = '#e5f6fb'; g.font = `700 ${fs}px system-ui, "Segoe UI", sans-serif`; g.fillText(message, bx + padX, ty); }
}

// Animated guide + the "circle to ask" selection marquee.
function drawFx() {
  sizeLayer(fxCanvas);
  const W = fxCanvas.width, H = fxCanvas.height, S = Math.min(W, H);
  fctx.clearRect(0, 0, W, H);

  // Living presence around the pointer (always on, independent of the guide).
  drawPresence();

  // Selection ellipse: the area the user circled to ask about.
  if (selRect) {
    const t = performance.now() / 1000;
    const cx = selRect.x + selRect.w / 2;
    const cy = selRect.y + selRect.h / 2;
    const rx = selRect.w / 2 + 6 + Math.sin(t * 4) * 2;
    const ry = selRect.h / 2 + 6 + Math.sin(t * 4) * 2;
    fctx.save();
    fctx.beginPath();
    fctx.ellipse(cx, cy, Math.max(6, rx), Math.max(6, ry), 0, 0, Math.PI * 2);
    fctx.fillStyle = 'rgba(34, 211, 238, 0.12)';
    fctx.fill();
    fctx.lineWidth = Math.max(3, S * 0.005);
    fctx.strokeStyle = '#22d3ee';
    fctx.setLineDash([14, 9]);
    fctx.lineDashOffset = -t * 40;
    fctx.stroke();
    fctx.restore();
  }

  if (!guide) return;
  if (performance.now() - guide.since > 12000) { guide = null; return; }
  const gx = mapX(guide.x != null ? guide.x : 0.5, W);
  const gy = mapY(guide.y != null ? guide.y : 0.5, H);
  const t = (performance.now() - guide.since) / 1000;
  const pulse = (Math.sin(t * 3) + 1) / 2;
  const color = '#22d3ee';
  fctx.strokeStyle = color; fctx.fillStyle = color; fctx.lineWidth = Math.max(3, S * 0.005);
  fctx.lineJoin = 'round'; fctx.lineCap = 'round';
  arrow(fctx, pos.x, pos.y, gx, gy, fctx.lineWidth);
  fctx.globalAlpha = 0.9;
  fctx.beginPath(); fctx.arc(gx, gy, 22 + pulse * 26, 0, Math.PI * 2); fctx.stroke();
  fctx.beginPath(); fctx.arc(gx, gy, 5, 0, Math.PI * 2); fctx.fill();
  fctx.globalAlpha = 1;
  if (guide.label) {
    drawBubble(fctx, gx, gy, 'Clicky', guide.label, color);
  }
}

// --- Character drawing ------------------------------------------------------
// The buddy is the multiplayer-cursor arrow (adapted from the Cursor component's
// CursorPointer SVG path). This app is Electron/vanilla canvas, not React/
// Tailwind/shadcn, so we render the same arrow shape + accent-tinted label pill
// directly instead of importing the .tsx component.
const POINTER_PATH = new Path2D(
  'M19.438 6.716 1.115.05A.832.832 0 0 0 .05 1.116L6.712 19.45a.834.834 0 0 0 1.557.025l3.198-8 7.995-3.2a.833.833 0 0 0 0-1.559h-.024Z'
);
const STATE_ACCENT = {
  idle: '#10b981',      // emerald-500 (the component's default pointer color)
  listening: '#34d399', // emerald-400
  thinking: '#f59e0b',  // amber-500
  speaking: '#0ea5e9'   // sky-500
};

function drawCursor() {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.save();
  // Arrow tip (path origin ~0.5,0.5 in its 20x20 box) sits on the cursor hotspot.
  ctx.translate(17, 12);
  // Lean the arrow into horizontal movement so it feels like it is swinging
  // through the air, and squash it flat for a few frames on a blink.
  ctx.rotate(tilt);
  const blink = performance.now() < blinkUntil ? 0.24 : 1;
  ctx.scale(2.5, 2.5 * blink);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetX = 0.6;
  ctx.shadowOffsetY = 1.2;
  ctx.fillStyle = STATE_ACCENT[state] || STATE_ACCENT.idle;
  ctx.fill(POINTER_PATH);
  // White outline so the arrow reads on any app background.
  ctx.shadowColor = 'transparent';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke(POINTER_PATH);
  ctx.restore();
}

function stateScale() {
  // A little extra size while the pointer is actually moving makes it feel alive.
  const boost = Math.min(0.14, Math.hypot(velocity.x, velocity.y) * 0.006);
  if (state === 'listening') return 1 + Math.sin(frame / 8) * 0.05 + boost;
  if (state === 'thinking') return 1 + Math.sin(frame / 6) * 0.03 + boost;
  if (state === 'speaking') return 1 + Math.sin(frame / 5) * 0.06 + boost;
  return 1 + Math.sin(frame / 40) * 0.015 + boost * 0.5;
}

// State-reactive presence drawn around the pointer: a soft breathing halo when
// idle, expanding rings while listening, an orbiting spinner while thinking, and
// a pulsing equalizer of dots while speaking. Plus a faint motion trail.
function drawPresence() {
  const now = performance.now() / 1000;
  const accent = STATE_ACCENT[state] || STATE_ACCENT.idle;
  const cx = pos.x;
  const cy = pos.y;

  // Motion echo: fading dots along where the pointer just travelled.
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    const k = (i + 1) / trail.length;
    fctx.globalAlpha = k * 0.15;
    fctx.fillStyle = accent;
    fctx.beginPath();
    fctx.arc(p.x, p.y, 1.5 + k * 3, 0, Math.PI * 2);
    fctx.fill();
  }
  fctx.globalAlpha = 1;

  fctx.strokeStyle = accent;
  fctx.fillStyle = accent;
  fctx.lineCap = 'round';

  if (state === 'listening') {
    for (let i = 0; i < 3; i++) {
      const ph = (now * 1.4 + i / 3) % 1;
      fctx.globalAlpha = (1 - ph) * 0.5;
      fctx.lineWidth = 3;
      fctx.beginPath();
      fctx.arc(cx, cy, 14 + ph * 46, 0, Math.PI * 2);
      fctx.stroke();
    }
  } else if (state === 'thinking') {
    const a = now * 3.2;
    fctx.globalAlpha = 0.9;
    fctx.lineWidth = 4;
    fctx.beginPath(); fctx.arc(cx, cy, 26, a, a + Math.PI * 0.9); fctx.stroke();
    fctx.beginPath(); fctx.arc(cx, cy, 26, a + Math.PI, a + Math.PI * 1.9); fctx.stroke();
  } else if (state === 'speaking') {
    const n = 10;
    fctx.globalAlpha = 0.85;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + now * 1.2;
      const rr = 24 + 6 + Math.sin(now * 7 + i) * 6;
      fctx.beginPath();
      fctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 2.6, 0, Math.PI * 2);
      fctx.fill();
    }
  } else {
    fctx.globalAlpha = 0.16;
    fctx.lineWidth = 2;
    fctx.beginPath();
    fctx.arc(cx, cy, 18 + Math.sin(now * 2) * 2.2, 0, Math.PI * 2);
    fctx.stroke();
  }
  fctx.globalAlpha = 1;
}

function tick() {
  frame += 1;
  velocity.x += (target.x - pos.x) * STIFFNESS;
  velocity.y += (target.y - pos.y) * STIFFNESS;
  velocity.x *= DAMPING;
  velocity.y *= DAMPING;
  pos.x += velocity.x;
  pos.y += velocity.y;

  // Ease the lean toward the current horizontal velocity, record the trail, and
  // fire a quick blink every ~2.6-5.2s so the pointer reads as a living buddy.
  const lean = Math.max(-0.5, Math.min(0.5, velocity.x * 0.03));
  tilt += (lean - tilt) * 0.18;
  trail.push({ x: pos.x, y: pos.y });
  if (trail.length > 16) trail.shift();
  const nowMs = performance.now();
  if (nowMs > blinkAt) {
    blinkUntil = nowMs + 90;
    blinkAt = nowMs + 2600 + Math.random() * 2600;
  }

  drawCursor();
  drawFx();
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

window.addEventListener('resize', () => { renderDraw(); });
renderDraw();

requestAnimationFrame(tick);
