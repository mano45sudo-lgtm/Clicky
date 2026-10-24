// Unified LLM brain. Providers: openrouter | groq | gemini | anthropic | sarvam | mock. Single-user-turn
// calls (text + strict JSON) are all the assistant, walkthroughs, and agent
// need. Vision is passed as an inline image part when a screenshot exists.
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const ASSISTANT_SYSTEM = [
  "You are Clicky, a hands-on AI buddy living next to the user's cursor. You help, teach, and get things done.",
  'CAPABILITY: you CAN work live inside whatever app is open on screen - you type into Excel cells, Word documents, forms and any focused window, and you click real controls. NEVER say you cannot touch or type into an open app, and never offer "copy-paste-ready" text as a substitute for doing it. If the user seems to want an action done, tell them the single key rule: just say it as a command ("fill this table with sample sales data") and you will do it on the spot.',
  'For doubts or "how do I / how to implement" questions, be a patient tutor: give a short, clear, actionable answer with a few concrete steps.',
  'Keep replies brief and spoken-friendly: about 2 to 4 sentences, plain text, no markdown, no bullet lists.',
  'Be warm, concise, and practical. If something is unclear, ask one short question.'
].join(' ');

// Used whenever a screenshot/photo is attached. It stops the model from defaulting
// to "here is your desktop / app" narration and makes it look at the ACTUAL subject
// the user is asking about (a plant, an animal, an error, a document, a product...).
const VISION_SYSTEM = [
  "You are Clicky's eyes. You are shown an image of the user's screen (or a photo they circled). Your job is to identify the SUBJECT they are asking about - the specific object, plant, animal, person, food, product, place, document, code, error message, or on-screen control - NOT to describe the desktop or list the apps that happen to be open.",
  'Look closely at the thing in focus. Name it concretely: for a living thing give the species/type and the 2-3 visible features that support it; for an error, quote the key text; for a control, say exactly what it is and what it does. If you are not fully sure, give your best single guess first, then the most likely alternative and what would confirm it - never refuse to look.',
  'If the question is genuinely about the whole screen or a walkthrough, then describe the interface and the next step.',
  'Keep replies brief and spoken-friendly: about 2 to 4 sentences, plain text, no markdown, no bullet lists. Be warm, specific and confident.'
].join(' ');

function currentImage(screenshot) {
  if (screenshot && screenshot.base64) {
    return { mediaType: screenshot.mediaType || 'image/png', base64: screenshot.base64 };
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Gemini via the REST generateContent endpoint (no SDK) so we can ride out the
// frequent 503 "high demand" spikes: try the configured model, then fall back
// across a chain of vision models, each with a short retry. This is what keeps
// screen-aware answers, walkthroughs and real pointing from dying on a blip.
async function geminiText({ system, text, image, json, fast }) {
  const key = config.geminiApiKey;
  const models = [];
  const push = (m) => { if (m && !models.includes(m)) models.push(m); };
  if (fast) {
    // Locate-only calls (finding a control) want the quickest model first.
    ['gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-3.5-flash'].forEach(push);
  } else {
    // Answers / identification want accuracy: configured model, then the strongest
    // vision tiers (Pro first) before falling back to flash, so "what is this" calls
    // keep working at high confidence even when the preferred model is overloaded.
    push(config.geminiModel);
    ['gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest'].forEach(push);
  }

  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
  parts.push({ text });
  const body = { contents: [{ role: 'user', parts }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };

  let lastErr = new Error('Gemini vision unavailable');
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body)
        });
        if (res.status === 503 || res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Gemini ${m} HTTP ${res.status}`);
          await sleep(attempt === 0 ? 250 : 500);
          continue; // retry same model, then next model
        }
        if (!res.ok) { lastErr = new Error('Gemini HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160)); break; }
        const data = await res.json();
        const cand = (data.candidates || [])[0];
        const p = cand && cand.content && cand.content.parts;
        const out = p ? p.map((x) => x.text || '').join('').trim() : '';
        if (out) return out;
        lastErr = new Error(`Gemini ${m} returned empty`);
      } catch (e) {
        lastErr = e;
        await sleep(200);
      }
    }
  }
  throw lastErr;
}

async function anthropicText({ system, text, image, json }) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const content = [];
  if (image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
  }
  let prompt = text;
  if (json) prompt += '\n\nRespond with ONLY a valid JSON object, no prose.';
  content.push({ type: 'text', text: prompt });

  const resp = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system: system + (json ? ' Respond with ONLY valid JSON.' : ''),
    messages: [{ role: 'user', content }]
  });

  return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
}

// Sarvam-105b via its OpenAI-compatible /v1/chat/completions endpoint. This
// model is TEXT-ONLY (it rejects multimodal array content), so a screenshot
// cannot be shown to it; we note that in the prompt and answer from text.
async function sarvamText({ system, text, image, json }) {
  const key = config.sarvamApiKey;
  let prompt = text;
  if (image) {
    prompt += "\n\n(The user shared a screenshot, but you cannot view images. If the screen matters, briefly ask them to describe what they see.)";
  }
  if (json) prompt += "\n\nRespond with ONLY a valid JSON object, no prose.";

  const body = {
    model: config.sarvamModel,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: system + (json ? ' Respond with ONLY valid JSON.' : '') },
      { role: 'user', content: prompt }
    ]
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'api-subscription-key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Sarvam HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

// Groq via its OpenAI-compatible /openai/v1/chat/completions endpoint. Most Groq
// models are text-only, so a screenshot is noted in the prompt unless the model
// name contains "vision". JSON is requested through the prompt (not response_format)
// to avoid strict-mode errors across Groq's models; llm.json extracts the object.
async function groqText({ system, text, image, json }) {
  const key = config.groqApiKey;
  const model = config.groqModel;
  const vision = /vision/i.test(model);
  let prompt = text;
  if (image && !vision) {
    prompt += "\n\n(The user shared a screenshot, but this model cannot view images. If the screen matters, ask them to briefly describe what they see.)";
  }
  if (json) prompt += "\n\nRespond with ONLY a valid JSON object, no prose.";

  const messages = [{ role: 'system', content: system }];
  if (image && vision) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.3, messages })
  });
  if (!res.ok) throw new Error('Groq HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

// OpenRouter: one key to the whole high-end open-source catalog (Qwen3, DeepSeek,
// Llama). Used as the agent's planning brain because Qwen3-235B is a markedly
// stronger multi-step/tool-calling planner than the fast Groq model. OpenAI-
// compatible /chat/completions; JSON is requested through the prompt (not
// response_format) because strict mode is inconsistent across these open models,
// and llm.json extracts the object. A fallback chain rides out any single model
// being rate-limited or down, mirroring the Gemini resilience pattern.
async function openRouterText({ system, text, image, json, fast }) {
  const key = config.openRouterApiKey;
  const models = [];
  const push = (m) => { if (m && !models.includes(m)) models.push(m); };
  if (image) {
    // Only reached if OpenRouter is chosen as the EYES; use a vision-capable model.
    ['qwen/qwen3-vl-32b-instruct', 'qwen/qwen3-vl-30b-a3b-instruct', 'qwen/qwen3-vl-235b-a22b-instruct'].forEach(push);
  } else {
    // Planning / text brain: configured model first, then strong open fallbacks.
    push(config.openRouterModel);
    ['deepseek/deepseek-v3.2', 'qwen/qwen3-next-80b-a3b-instruct', 'deepseek/deepseek-chat-v3.1', 'qwen/qwen3-235b-a22b-2507'].forEach(push);
  }

  const messages = [{ role: 'system', content: system + (json ? ' Respond with ONLY valid JSON.' : '') }];
  let prompt = text;
  if (json) prompt += '\n\nRespond with ONLY a valid JSON object, no prose.';
  if (image) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  let lastErr = new Error('OpenRouter unavailable');
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://heyclicky.app',
            'X-Title': 'HeyClicky'
          },
          body: JSON.stringify({ model: m, max_tokens: 4096, temperature: 0.3, messages })
        });
        if (res.status === 503 || res.status === 429 || res.status >= 500) {
          lastErr = new Error(`OpenRouter ${m} HTTP ${res.status}`);
          await sleep(attempt === 0 ? 250 : 500);
          continue; // retry same model, then next model
        }
        if (!res.ok) { lastErr = new Error('OpenRouter HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160)); break; }
        const data = await res.json();
        const out = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
        if (out) return out;
        lastErr = new Error(`OpenRouter ${m} returned empty`);
      } catch (e) {
        lastErr = e;
        await sleep(200);
      }
    }
  }
  throw lastErr;
}

async function call({ system, text, image, json, fast }) {
  // Screenshots go to the vision provider (Gemini/Anthropic if a key exists);
  // text-only turns stay on the configured brain (Groq). This is what lets Clicky
  // "see" the screen and point at real controls while keeping a fast text brain.
  const provider = image ? config.visionProvider() : config.llmProvider();
  if (provider === 'openrouter') return openRouterText({ system, text, image, json, fast });
  if (provider === 'gemini') return geminiText({ system, text, image, json, fast });
  if (provider === 'anthropic') return anthropicText({ system, text, image, json });
  if (provider === 'sarvam') return sarvamText({ system, text, image, json });
  if (provider === 'groq') return groqText({ system, text, image, json });
  return null; // mock handled by callers
}

// Plain short answer for the voice loop. When a screenshot is present, answer as
// VISION_SYSTEM (identify the subject) so object/plant/photo questions are not
// turned into a description of the surrounding UI.
async function answer({ question, screenshot }) {
  if (config.mockMode) {
    const seen = screenshot ? 'I can see your screen' : 'I do not have a screenshot';
    return `Sure thing - ${seen}. I am in mock mode; add a vision key (Gemini) in Settings for real answers about "${question || 'what is on my screen'}".`;
  }
  const text = await call({
    system: screenshot ? VISION_SYSTEM : ASSISTANT_SYSTEM,
    text: question && question.trim() ? question.trim() : 'What is on my screen right now?',
    image: currentImage(screenshot)
  });
  return (text || '').slice(0, config.maxAnswerChars);
}

// Free-form text with context (used by agent summaries).
async function chat({ system = ASSISTANT_SYSTEM, text, screenshot }) {
  if (config.mockMode) return `[mock] ${text}`;
  return call({ system, text, image: currentImage(screenshot) });
}

// Structured JSON output. Falls back to mock object on error / mock mode.
async function json({ system, text, screenshot, fallback, fast }) {
  if (config.mockMode) return fallback || {};
  try {
    const raw = await call({ system, text, image: currentImage(screenshot), json: true, fast });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback || {};
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    console.error('[llm] json parse failed', e.message);
    return fallback || {};
  }
}

module.exports = { answer, chat, json, ASSISTANT_SYSTEM, VISION_SYSTEM };
