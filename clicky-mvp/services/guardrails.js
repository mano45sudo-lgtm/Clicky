// Safety guardrails for the autonomous agent. The agent has full mouse/keyboard
// control, so before it performs an action that cannot be easily undone -
// clicking "Send", "Delete", "Submit", "Pay", running a destructive shell
// command - we require an explicit confirmation (unless the user turned it off
// or allowlisted the app). Normal work (writing an essay, drafting an email,
// opening apps, filling ordinary fields) is NOT intercepted, so everyday tasks
// stay friction-free.
//
// We intentionally scan only the ACTION surface (the control a click targets, or
// a shell command) - never the body of text being typed or the content of a
// file, because an essay that mentions "send" is not the same as clicking Send.

// Words that mean "this click commits something real / hard to undo".
const CLICK_RE =
  /\b(delete|remove|send|reply all|reply-all|forward|submit|post|publish|pay|purchase|buy|checkout|order now|transfer|withdraw|unsubscribe|empty trash|purge|format|wipe|erase|shutdown|shut ?down|restart|reboot|log ?off|sign ?out|force ?quit|kill|grant|approve|accept|allow access|confirm payment|place order)\b/i;

// Destructive shell patterns for runCommand (Windows + *nix verbs).
const SHELL_RE =
  /\b(rm|rmdir|del|erase|format|remove-item|shutdown|taskkill|cipher)\b|\bdel\s+\/|\brm\s+-rf|reg\s+delete|format\s+[a-z]:\/|>\s*\S+\.(txt|doc|docx|xls|xlsx|csv|json|db)\b/i;

// Tools that only read, draft, or draw - never irreversible by themselves.
const SAFE_TOOLS = new Set([
  'captureScreen', 'webSearch', 'listFolder', 'summarizeFolder', 'readFile',
  'draw', 'guide', 'clearDrawing', 'wait', 'createNote', 'addReminder',
  'openApp', 'composeEmail', 'writeFile', 'typeText', 'typeInto', 'pressKey'
]);

function firstText(args, keys) {
  for (const k of keys) {
    const v = args && args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// Return { destructive, reason } for a planned step { tool, args }.
function analyze(step) {
  const tool = step && step.tool;
  if (!tool) return { destructive: false };
  if (SAFE_TOOLS.has(tool)) return { destructive: false };

  const args = step.args || {};
  if (tool === 'runCommand') {
    const cmd = firstText(args, ['command']);
    const m = cmd.match(SHELL_RE);
    if (m) return { destructive: true, keyword: m[0], reason: `this runs a destructive command ("${m[0]}")` };
    return { destructive: false };
  }

  // clickAt / clickOnScreen and anything else that acts on a named control:
  // inspect only the target label.
  const target = firstText(args, ['target']);
  if (target) {
    const m = target.match(CLICK_RE);
    if (m) return { destructive: true, keyword: m[0], reason: `this clicks "${target}", which commits an action` };
  }
  return { destructive: false };
}

// The user can allowlist app / action phrases so e.g. their own test inbox is
// never interrupted. A match on the allowlist suppresses the confirm.
function isAllowlisted(step, allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : String(allowlist || '').split(',').map((s) => s.trim());
  const needles = list.filter(Boolean).map((s) => s.toLowerCase());
  if (!needles.length) return false;
  const args = step.args || {};
  const hay = [args.target, args.command, args.text].filter(Boolean).join(' ').toLowerCase();
  return needles.some((n) => hay.includes(n));
}

module.exports = { analyze, isAllowlisted };
