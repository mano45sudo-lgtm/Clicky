const { EventEmitter } = require('events');
const llm = require('./llm');
const tools = require('./tools');
const memory = require('./memory');
const config = require('../config');
const { capturePrimaryDisplay } = require('./capture');

// A background agent: plans -> executes tools -> summarizes. Emits progress
// events (status/step/done) that main forwards to the overlay agent panel.
class Agent extends EventEmitter {
  constructor() {
    super();
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.emit('done', { goal: this.goal, summary: 'Cancelled.', cancelled: true });
  }

  async run(goal) {
    this.goal = goal;
    memory.addTask(goal, 'started');
    this.emit('status', { goal, state: 'planning' });

    if (config.mockMode) return this._mockRun(goal);

    const screenshot = await capturePrimaryDisplay().catch(() => null);
    const defs = tools.definitions();

    const system =
      "You are Clicky Agent, an autonomous desktop assistant with FULL control of the user's computer. " +
      'Act immediately - do the task, do not ask permission. Tools: ' +
      JSON.stringify(defs) +
      '. For "open X" use openApp with target X (it understands notepad, word, excel, chrome, edge, settings, files, and paths/URLs). ' +
      'To create an essay/document, use writeFile and put the FULL content yourself in the args (a bare filename saves to Documents). ' +
      'When no other tool fits, use runCommand. Plan the FEWEST steps that fully accomplish the goal, then set answer to a short confirmation of what you did. ' +
      'Return ONLY JSON: {"needsTools": bool, "steps": [{"tool": string, "args": object, "reason": string}], "answer": string}.';

    const plan = await llm.json({
      system,
      text: `Goal: ${goal}`,
      screenshot,
      fallback: { needsTools: false, steps: [], answer: '' }
    });

    const results = [];
    const steps = Array.isArray(plan.steps) ? plan.steps : [];

    for (const step of steps) {
      if (this.cancelled) break;
      this.emit('step', { tool: step.tool, args: step.args, reason: step.reason, state: 'running' });
      const result = await tools.exec(step.tool, step.args || {});
      results.push({ tool: step.tool, args: step.args, result });
      this.emit('step', { tool: step.tool, state: 'done', result });
    }

    if (this.cancelled) return { goal, summary: 'Cancelled.', results };

    const summary = await llm.chat({
      system:
        'You are Clicky Agent. In 2 to 4 spoken-friendly sentences, tell the user the outcome ' +
        'of this task based on the tool results. Be concrete about what you did.',
      text: `Goal: ${goal}\nDraft: ${plan.answer || ''}\nTool results: ${JSON.stringify(results)}`
    });

    memory.addTask(goal, 'done', summary);
    this.emit('done', { goal, summary, results });
    return { goal, summary, results };
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
