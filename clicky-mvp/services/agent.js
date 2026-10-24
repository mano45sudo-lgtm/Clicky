const { EventEmitter } = require('events');
const llm = require('./llm');
const tools = require('./tools');
const memory = require('./memory');
const config = require('../config');
const log = require('./log');
const guardrails = require('./guardrails');
const knowledge = require('./knowledge');
const { capturePrimaryDisplay } = require('./capture');

// Human helpers so the overlay + log show WHAT a step did and whether it failed.
function stepLabel(step) {
  const a = step.args || {};
  const t = a.target || a.text || a.command || a.path || a.goal || a.query || a.title || '';
  const s = String(t).replace(/\s+/g, ' ').trim();
  return step.tool + (s ? ': ' + (s.length > 42 ? s.slice(0, 42) + '\u2026' : s) : '');
}
function isOk(tool, r) {
  if (!r || r.error) return false;
  if (r.found === false || r.typed === false || r.skipped) return false;
  return true;
}
function resultDetail(tool, r) {
  if (!r) return '';
  if (r.error) return String(r.error).slice(0, 140);
  if (r.found === false) return 'not found';
  if (r.typed === false) return 'field not found';
  if (r.chars) return r.chars + ' chars typed';
  if (r.via) return r.via + (typeof r.x === 'number' ? ` @${r.x},${r.y}` : '');
  if (r.opened) return 'opened ' + r.opened;
  if (r.drafted) return 'draft ready';
  if (r.waitedMs != null) return r.waitedMs + 'ms';
  return '';
}
function lastError(results) {
  const e = (results || []).slice().reverse().find((r) => r.result && r.result.error);
  return e ? 'Last error: ' + e.result.error : '';
}

// A background agent: plans -> executes tools -> summarizes. Emits progress
// events (status/step/done) that main forwards to the overlay agent panel.
class Agent extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
    this._confirm = null; // pending confirm resolver (set while awaiting a gate)
    this._confirmTimer = null;
  }

  cancel() {
    this.cancelled = true;
    // If we were paused on a confirmation gate, treat cancel as a refusal.
    this.resolveConfirm('stop');
    this.emit('done', { goal: this.goal, summary: 'Cancelled.', cancelled: true });
  }

  // Pause the agent and ask the user to approve a destructive step. Resolves to
  // 'allow' | 'block' | 'timeout' | 'stop'. Auto-refuses after 60s so an absent
  // user never leaves the agent hanging on a dangerous action.
  requestConfirm(info) {
    return new Promise((resolve) => {
      this._confirm = resolve;
      this.emit('confirm', { ...info, allowedDecisions: ['allow', 'block'] });
      this._confirmTimer = setTimeout(() => this.resolveConfirm('timeout'), 60000);
    });
  }

  resolveConfirm(decision) {
    if (!this._confirm) return;
    if (this._confirmTimer) clearTimeout(this._confirmTimer);
    const resolve = this._confirm;
    this._confirm = null;
    this.emit('confirm', { decision }); // tell the UI to clear the prompt
    resolve(decision);
  }

  async run(goal) {
    this.goal = goal;
    memory.addTask(goal, 'started');
    this.emit('status', { goal, state: 'planning' });

    if (config.mockMode) return this._mockRun(goal);

    const defs = tools.definitions();

    const system =
      "You are Clicky Agent, an autonomous desktop assistant with FULL control of the user's computer: you move the real mouse, click, and type. " +
      'You MUST complete the task end to end with ZERO manual steps from the user. NEVER ask them to click, open, focus, or prepare anything yourself - you do it. Do not just describe what to do; DO it. Tools: ' +
      JSON.stringify(defs) +
      'AUTONOMY RULE: if the app or window you need is not on screen, openApp it (notepad, word, excel, chrome, edge, or a URL like gmail.com), then call wait 1500 so it appears, THEN act. Always chain openApp -> wait -> action. '
      + 'OPERATING ANY APP: clickOnScreen finds and clicks a control by a short name (e.g. "Blank document", "File menu", "Run") using the Windows accessibility API, so it is fast and precise; then typeText types into whatever has focus, or use typeInto {target,text} to fill a named field in ONE step; pressKey for keys. This works in any application. '
      + 'EMAIL: for ANY write/draft/compose email request use composeEmail with to/subject/body - it opens a pre-filled Gmail compose automatically. Do NOT click To/Subject/body fields and do NOT ask the user to open Gmail. It only drafts, never sends. '
      + 'DOCUMENT/ESSAY: to write a document, openApp "word" (or "notepad") if not already open, wait 1500, clickOnScreen "Blank document", wait 1000, then typeText the FULL text you wrote yourself. Or use writeFile to save a file directly. '
      + 'WORK LIVE, NOT IN SIDE FILES: when the user refers to what is already open ("here", "this", "my sheet", "this document", "in excel"), you MUST edit that live window with clicks and real keystrokes. NEVER say you cannot type into an open app - you can type into any focused window. Do NOT create a separate file, and do NOT produce a copy-paste-ready block for the user to paste - YOU do the typing. If the request is ambiguous (which data?), decide something sensible and act; do not stop to ask. '
      + 'EXCEL/SPREADSHEET RECIPE (works in the open workbook): to fill cells, drive the Name Box - clickOnScreen "Name Box", typeText "A1", pressKey "{Enter}" (focus jumps to that cell), typeText the value, then pressKey "{Enter}" to go down or "{Tab}" to go right; typeText the next value; repeat. For a header row: Name Box -> "A1" -> {Enter} -> value, {Tab}, value, {Tab}, ... For a table, fill row by row with {Tab} across and Name Box jumps between rows. Formulas are just text starting with "=" (typeText "=SUM(B2:B5)"). '
      + 'You can also clickAt x,y (0..1 fractions) when you know the spot, and runCommand as a last resort. '
      + 'WEB / BROWSER: inside Chrome/Edge, UI Automation cannot see the page, so for ANY web form or web app use the CDP tools instead: browserNavigate {url} to open the page, then browserType {target,text} to fill each field and browserClick {target} for buttons ("Log in", "Submit", "Continue"). Chain browserNavigate -> wait 1500 -> browserType/browserClick. '
      + 'For "how do I / explain" questions, still act where you can and put numbered steps in answer. '
      + 'Plan the FEWEST steps that FULLY accomplish the goal on your own, then set answer to a short confirmation of what you did. '
      + knowledge.plannerHint() +
      'Return ONLY JSON: {"needsTools": bool, "steps": [{"tool": string, "args": object, "reason": string}], "answer": string}.';

    // Plan on the fast text brain (Groq) with NO screenshot: this removes the vision
    // round-trip (and its 503s) from planning. clickOnScreen/typeInto resolve control
    // positions locally via the Windows UI Automation API when each step executes.
    let plan = await llm.json({
      system,
      text: `Goal: ${goal}`,
      fallback: { needsTools: false, steps: [], answer: '' }
    });

    // Preview mode: narrate the plan and stop. Nothing is executed, so the user
    // can see exactly what Clicky intends before trusting it with real actions.
    if (config.settings.agentPreviewMode) {
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      this.emit('status', { goal, state: 'preview' });
      steps.forEach((s, i) =>
        this.emit('step', { index: i, tool: s.tool, args: s.args, reason: s.reason, label: stepLabel(s), state: 'preview' })
      );
      const summary = steps.length
        ? 'Preview mode - here is what I would do: ' + steps.map((s) => stepLabel(s)).join('; ') + '. Turn off Preview in Settings to let me do it.'
        : plan.answer || 'Nothing to do.';
      log.info('agent', 'preview only', { goal, steps: steps.map((s) => s.tool) });
      memory.addTask(goal, 'previewed', summary);
      this.emit('done', { goal, summary, results: [], preview: true });
      return { goal, summary, results: [] };
    }

    const allResults = [];
    const MAX_ATTEMPTS = 3; // first pass + up to 2 corrective re-plans
    let attempt = 0;

    while (attempt < MAX_ATTEMPTS && !this.cancelled) {
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      if (!steps.length) break;
      if (attempt === 0) log.info('agent', `planned ${steps.length} step(s) for "${goal}"`, { steps: steps.map((s) => s.tool) });

      const base = allResults.length;
      await this._exec(steps, allResults);

      // A refused destructive step (or a cancel) is a deliberate stop - never
      // re-plan it, or we would nag the user to confirm the same thing again.
      const blocked = allResults.slice(base).filter((r) => r.blocked);
      if (blocked.length || this.cancelled) break;

      const failed = allResults.slice(base).filter((r) => !r.ok);
      if (!failed.length) break; // every step this pass succeeded

      attempt++;
      if (attempt >= MAX_ATTEMPTS) break;
      this.emit('status', { goal, state: 'recovering' });
      log.warn('agent', `retry ${attempt}: ${failed.length}/${steps.length} step(s) failed, re-planning`, { failed: failed.map((f) => f.tool) });
      plan = await this._replan(system, goal, allResults);
    }

    if (this.cancelled) return { goal, summary: 'Cancelled.', results: allResults };

    const failures = allResults.filter((r) => !r.ok).length;
    let summary;
    if (allResults.length && failures === allResults.length) {
      const le = lastError(allResults);
      summary = `I tried, but could not complete "${goal}". ${le || 'Nothing responded - tap the overlay steps for the exact error.'}`;
      log.error('agent', 'all steps failed', { goal, results: allResults });
    } else {
      summary = await llm.chat({
        system:
          'You are Clicky Agent. In 2 to 4 spoken-friendly sentences, tell the user the outcome ' +
          'of this task based on the tool results. Be concrete about what you did. If a step failed, say so plainly.',
        text: `Goal: ${goal}\nDraft: ${plan.answer || ''}\nTool results: ${JSON.stringify(allResults)}`
      });
    }

    memory.addTask(goal, failures ? 'done-with-errors' : 'done', summary);
    this.emit('done', { goal, summary, results: allResults, failures });
    return { goal, summary, results: allResults };
  }

  // Run a batch of steps, emitting overlay events (indexed globally) and logging.
  async _exec(steps, allResults) {
    const base = allResults.length;
    for (let i = 0; i < steps.length; i++) {
      if (this.cancelled) break;
      const step = steps[i];
      const label = stepLabel(step);
      const index = base + i;

      // Guardrail: ask before an irreversible action (Send / Delete / Pay / a
      // destructive command), unless confirmations are off or it is allowlisted.
      const st = config.settings;
      const guard = guardrails.analyze(step);
      if (guard.destructive && st.agentConfirmDestructive && !guardrails.isAllowlisted(step, st.agentAllowlist)) {
        log.warn('agent', `confirm gate: ${guard.reason}`, { tool: step.tool, args: step.args });
        const decision = await this.requestConfirm({ index, tool: step.tool, args: step.args, label, reason: guard.reason });
        if (decision !== 'allow') {
          const why = decision === 'timeout' ? 'no confirmation' : 'you declined';
          allResults.push({ tool: step.tool, args: step.args, ok: false, blocked: true, result: { error: `Skipped (${why})` } });
          this.emit('step', { index, tool: step.tool, label, state: 'error', detail: `not run - ${why}` });
          log.warn('agent', `step ${step.tool} BLOCKED (${decision})`, { args: step.args });
          continue;
        }
      }

      this.emit('step', { index, tool: step.tool, args: step.args, reason: step.reason, label, state: 'running' });
      const started = Date.now();
      const result = await tools.exec(step.tool, step.args || {});
      const ms = Date.now() - started;
      const ok = isOk(step.tool, result);
      const detail = resultDetail(step.tool, result);
      log[ok ? 'info' : 'warn']('agent', `step ${step.tool} ${ok ? 'ok' : 'FAILED'} (${ms}ms)`, { args: step.args, result });
      allResults.push({ tool: step.tool, args: step.args, ok, result });
      this.emit('step', { index, tool: step.tool, label, state: ok ? 'done' : 'error', detail, result });
    }
  }

  // Corrective re-plan: show the brain what failed and give it fresh eyes on the
  // current screen, asking for ONLY the remaining steps. Vision failure here just
  // yields an empty plan (fallback), which safely ends the loop.
  async _replan(system, goal, results) {
    const screenshot = await capturePrimaryDisplay().catch(() => null);
    const ctx = results.map((r) => ({ tool: r.tool, ok: r.ok, detail: resultDetail(r.tool, r.result) }));
    return llm.json({
      system,
      text:
        `Goal: ${goal}\n\nThe previous attempt ran these steps and some FAILED:\n${JSON.stringify(ctx)}\n\n` +
        'Look at the CURRENT screenshot and emit ONLY the REMAINING corrective steps to finish the goal - do not repeat steps that already succeeded. ' +
        'If the goal is already fully done, return {"needsTools":false,"steps":[],"answer":"a short confirmation"}.',
      screenshot,
      fallback: { needsTools: false, steps: [], answer: '' }
    });
  }

  async _mockRun(goal) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    this.emit('step', { tool: 'webSearch', args: { query: goal }, reason: 'research the goal', state: 'running' });
    await wait(600);
    this.emit('step', { tool: 'webSearch', state: 'done', result: { error: 'mock mode: search not configured' } });

    this.emit('step', { tool: 'createNote', args: { title: 'Agent plan', body: `Mock plan for: ${goal}` }, reason: 'save a plan', state: 'running' });
    await wait(400);
    this.emit('step', { tool: 'createNote', state: 'done', result: { ok: true } });

    const summary =
      'I am in mock mode, so I could not really run the task. Add a Gemini or Claude key ' +
      'in Settings and I will plan and execute tools for this goal.';
    memory.addTask(goal, 'mock', summary);
    this.emit('done', { goal, summary, results: [] });
    return { goal, summary, results: [] };
  }
}

module.exports = { Agent };
