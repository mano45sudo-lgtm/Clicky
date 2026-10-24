// Unified LLM brain. Providers: groq | gemini | anthropic | sarvam | mock. Single-user-turn
// calls (text + strict JSON) are all the assistant, walkthroughs, and agent
// need. Vision is passed as an inline image part when a screenshot exists.
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const ASSISTANT_SYSTEM = [
  "You are Clicky, a friendly AI buddy living next to the user's cursor on their desktop.",
  'You can see a screenshot of their screen. Answer about what is on screen when relevant.',
  'Keep replies short and spoken-friendly: at most about 3 sentences, plain text, no markdown, no bullet lists.',
  'Be warm, concise, and practical. If the screen is unclear, say so briefly and ask one question.'
].join(' ');

function currentImage(screenshot) {
  if (screenshot && screenshot.base64) {
    return { mediaType: screenshot.mediaType || 'image/png', base64: screenshot.base64 };
  }
  return null;
}

async function geminiText({ system, text, image, json }) {
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({
    model: config.geminiModel,
    systemInstruction: system,
    generationConfig: json ? { responseMimeType: 'application/json' } : undefined
  });

  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
  parts.push({ text });

  const res = await model.generateContent({ contents: [{ role: 'user', parts }] });
  return (res.response.text() || '').trim();
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

async function call({ system, text, image, json }) {
  const provider = config.llmProvider();
  if (provider === 'gemini') return geminiText({ system, text, image, json });
  if (provider === 'anthropic') return anthropicText({ system, text, image, json });
  if (provider === 'sarvam') return sarvamText({ system, text, image, json });
  if (provider === 'groq') return groqText({ system, text, image, json });
  return null; // mock handled by callers
}

// Plain short answer for the voice loop.
async function answer({ question, screenshot }) {
  if (config.mockMode) {
    const seen = screenshot ? 'I can see your screen' : 'I do not have a screenshot';
    return `Sure thing - ${seen}. I am in mock mode; add a Gemini key in Settings for real answers about "${question || 'what is on my screen'}".`;
  }
  const text = await call({
    system: ASSISTANT_SYSTEM,
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
async function json({ system, text, screenshot, fallback }) {
  if (config.mockMode) return fallback || {};
  try {
    const raw = await call({ system, text, image: currentImage(screenshot), json: true });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback || {};
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    console.error('[llm] json parse failed', e.message);
    return fallback || {};
  }
}

module.exports = { answer, chat, json, ASSISTANT_SYSTEM };
