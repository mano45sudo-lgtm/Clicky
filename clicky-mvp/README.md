# HeyClicky

A voice-first AI buddy that lives on your Windows desktop. It sits next to your
cursor, sees what you see, and **does things for you** — opens apps, clicks
controls, types text, fills web forms, writes notes — all from a spoken sentence.
Hold a key, say *"open Word and write an essay about climate change"*, and watch
Clicky plan and execute it end-to-end with visible progress.

Every action is **observable** (you see each step; failures show in red and are
spoken out loud) and **recoverable** (Clicky verifies each step and re-plans once
if something goes wrong). A global **Stop** key and confirm-before-destructive
guardrails mean it can never click *Send* or delete something without your OK.

## The loop

```
hold hotkey -> speak -> transcribe (Sarvam) -> brain (Groq) plans tools
-> UI Automation clicks + SendKeys typing + CDP web automation
-> every step verified, progress shown beside the cursor, result spoken back
```

Three ways to use it:

- **Push-to-talk**: hold **Left Ctrl**, speak, release.
- **Command window** (tray icon or Alt+\\): type a question, or press
  **Walk me through** / **Run Agent**.
- **Agent** (Alt+G): give a goal; Clicky plans and runs tools in the background.

## Features

- **Voice-first assistant** with screen-aware Q&A, walkthroughs with an animated
  pointer ring, and out-loud answers.
- **Acting agent with 23 tools**: `openApp`, `clickOnScreen`, `typeInto`,
  `typeText`, `pressKey`, `runCommand`, `captureScreen`, `webSearch`, file
  read/write/list, notes, reminders, email drafts, drawing, and three browser
  tools (`browserNavigate`, `browserClick`, `browserType`).
- **UIA-first control**: clicks and typing go through Windows UI Automation
  (InvokePattern / ValuePattern fast paths) with SendKeys fallback — precise,
  reliable, and no clipboard trampling. The guide arrow never appears during
  real actions.
- **Persistent input server**: one hidden PowerShell process serves every input
  action, removing the ~400 ms cold start per click/keypress (automatic
  one-shot fallback if the server dies).
- **Browser automation via CDP**: web forms in Chrome/Edge are filled through
  the Chrome DevTools Protocol — the one reliable way to type inside a browser.
- **App knowledge pack**: canonical UIA control names for Word, Excel, Chrome,
  Explorer, Settings, Outlook and more, so *"click the address bar"* actually
  finds `Address and search bar`.
- **Guardrails**: a global **Stop** hotkey (Escape, only armed while the agent
  runs), **confirm-before-destructive** (Send / Delete / Submit / pay / `del`
  etc. require an explicit Allow), an **allowlist**, and a read-only **preview
  mode** that narrates the plan before touching anything.
- **Failure visibility**: live per-step activity line, red error lines, spoken
  errors, corrective re-planning (up to 2 retries), and structured file logs.
- **First-run wizard**: connect keys, check mic, learn hold-to-talk, and end
  with Clicky doing one real action.
- **Fast vision fallback**: a lite Gemini model locates on-screen targets in
  ~1.2 s; the full model is reserved for screen Q&A and walkthroughs.
- Tray icon, global hotkeys, optional autostart, multi-monitor overlays, and
  conversation/agent history persisted locally.

## Run

```sh
npm install
npm start
```

First launch opens the **onboarding wizard**. Bring your own keys (paste them in
Settings or a `.env` file — `.env` only seeds first-run defaults):

| Key | Used for |
| --- | --- |
| `GROQ_API_KEY` | The brain (planning + tool calling). |
| `GEMINI_API_KEY` | The eyes (screen vision; also locate fallback). |
| `SARVAM_API_KEY` | The voice (Sarvam STT + TTS, great for Indian languages). |

Settings are saved to `clicky-settings.json` in your user data folder (never
committed). Provider choices are grouped in Settings under Voice, Brain, Vision,
Control, Guardrails, and Privacy.

## Safety & guardrails

- **Stop instantly**: press **Escape** (configurable) any time the agent is
  working; there is also a Stop item in the tray menu.
- **Confirm destructive**: clicking anything named Send / Delete / Submit /
  Pay / Transfer… or running a destructive shell command pops a red
  **Allow / Block / Stop** prompt in the overlay. It auto-refuses after 60 s.
- **Preview mode**: Settings → *Preview mode* makes Clicky narrate its plan and
  stop — nothing is executed.
- **Allowlist**: add recurring safe targets (comma-separated) in Settings to
  skip confirmations for them.
- Email is **draft-only** (`composeEmail`) unless you explicitly opt into more.

## Privacy

- Screenshots are sent **only** to the vision provider you chose (Gemini) at the
  moment of a question or a locate call — they are not stored by us and never
  uploaded anywhere else.
- Audio is transcribed locally by default (Windows SAPI) or via Sarvam if you
  pick it; recordings are not persisted.
- All logs (`clicky.log`, rotating 5 MB) stay in your local app-data logs
  folder. Settings, history, notes, and reminders are plain local files.
- No telemetry, no accounts, no server of our own.

## Test & build

```sh
npm run test:smoke   # headless release check: config, tools, guardrails, UIA probe
npm run dist         # electron-builder: NSIS installer + portable .exe (Windows)
```

Auto-update ships via GitHub Releases (`electron-updater`); it is active only in
packaged builds.

## Antivirus note

Clicky drives input through a small PowerShell helper. Some antivirus products
(Real Acguard, certain AV settings) flag repeated PowerShell launches. Run
**Settings → Antivirus & troubleshooting → Run the check**; if it reports a
problem, use the **Open Windows Defender exclusions** button and add the Clicky
folder. The input driver also stays alive as a single persistent process, which
greatly reduces AV noise.

## Architecture

- `main.js` - app orchestration: overlays, tray, hotkeys (incl. dynamic Stop),
  command/settings/onboarding windows, PTT loop, agent wiring, IPC, auto-update.
- `store.js` / `config.js` - persistent settings (source of truth) + live
  provider resolution from keys.
- `services/agent.js` - observe-and-retry loop: plan → execute → verify →
  re-plan on failure (max 2), guardrail checks, confirm gate, preview mode.
- `services/tools.js` - the 23 agent tools and their argument schemas.
- `services/guardrails.js` - destructive-action classification + allowlist.
- `services/knowledge.js` - app control-name pack and phrase→control synonyms.
- `services/control.js` + `assets/input.ps1` - UIA-first mouse/keyboard driver
  with a persistent JSON-over-stdin server and one-shot fallback.
- `services/cdp.js` - Chrome DevTools Protocol client (launch/attach Chrome or
  Edge on a debug port; click/type inside pages).
- `services/providers.js` / `llm.js` - Groq (brain) + Gemini (eyes, incl. fast
  locate mode); strict-JSON tool planning.
- `services/stt*.js` / `tts*.js` + `assets/stt.ps1` / `tts.ps1` - speech in/out
  (Sarvam or OS SAPI).
- `services/capture.js` / `overlays.js` / `hotkey.js` - screenshots, per-display
  overlays, hold-to-talk.
- `services/log.js` - structured rotating file log (`clicky.log`).
- `services/integrations.js` / `memory.js` / `cache.js` - notes/reminders,
  history, LRU cache.
- `renderer.js` / `command.js` / `settings.js` / `onboard.js` - cursor character
  + activity panel, command UI with confirm buttons, settings UI, first-run
  wizard.
- `scripts/smoke.js` - headless release gate (see `npm run test:smoke`).

## Notes and limitations

- Windows-first. The UIA driver, CDP path, and OS speech are Windows features;
  macOS/Linux builds exist but act without UI Automation.
- Vision locate is best-effort for non-UIA surfaces (games, custom-drawn apps).
- The pointer overlay is click-through; Command/Settings/Onboarding are normal
  windows.
- Unsigned beta builds trigger a SmartScreen warning on first run (*More info →
  Run anyway*); code signing is planned for stable releases.
- Brand icons are placeholders.
