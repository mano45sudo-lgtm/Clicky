const llm = require('./llm');
const { capturePrimaryDisplay } = require('./capture');

// Produce a step-by-step walkthrough for the current screen, each step optionally
// carrying a normalized (0..1) pointing box so the overlay can draw a ring on the
// exact control. Coordinates are best-effort visual grounding from the screenshot.
async function walkthrough({ request, screenshot }) {
  const shot = screenshot || (await capturePrimaryDisplay().catch(() => null));

  if (!shot) {
    return { steps: [], note: 'I could not see your screen to guide you.' };
  }

  const system =
    'You are Clicky, giving a concise step-by-step walkthrough of a desktop app based on a ' +
    'screenshot. Return JSON: {"steps":[{"instruction": string, "target": {"x": number, "y": number, "w": number, "h": number} | null, "label": string}]}. ' +
    'x, y, w, h are normalized 0..1 coordinates of the button/area to point at (use null if unsure). ' +
    'Keep it to 2 to 6 steps. No prose outside JSON.';

  const text =
    `The user asked: "${request || 'Walk me through what I am looking at.'}"\n` +
    'Give the steps that point at the relevant on-screen controls.';

  const data = await llm.json({ system, text, screenshot: shot, fallback: { steps: [] } });

  const steps = Array.isArray(data.steps)
    ? data.steps
        .filter((s) => s && s.instruction)
        .map((s) => ({
          instruction: String(s.instruction),
          label: s.label ? String(s.label) : '',
          target: normalizeTarget(s.target)
        }))
    : [];

  return { steps, note: data.note || '' };
}

function normalizeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return Math.max(0, Math.min(1, n));
  };
  const x = num(t.x);
  const y = num(t.y);
  if (x == null || y == null) return null;
  return { x, y, w: num(t.w) || 0.08, h: num(t.h) || 0.05 };
}

module.exports = { walkthrough };
