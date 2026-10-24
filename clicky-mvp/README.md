# HeyClicky

An AI buddy that lives on your desktop. It sits next to your cursor, sees what you
see, and helps out loud. Hold a key and ask about whatever is on screen and Clicky
answers by voice; ask it to "walk you through" something and an animated ring points
at the exact control; hand it a goal and a background **Clicky Agent** researches,
reads and writes files, opens apps, and takes notes for you.

Works on Windows first, with macOS and Linux support built in. Bring your own keys:
**Gemini** or **Claude** for the brain, optional **AssemblyAI** / **ElevenLabs** for
speech. Everything runs in a free **mock mode** with no keys.

## The loop

```
hold hotkey -> speak -> capture screen -> brain (Gemini/Claude) answers
-> Clicky replies out loud + shows a caption beside the cursor
```

Three ways to use it:

- **Push-to-talk**: hold **Left Ctrl**, speak, release.
- **Command window** (tray icon or Alt+\\): type a question, or press
  **Walk me through** / **Run Agent**.
- **Agent** (Alt+G): give a goal; Clicky plans and runs tools in the background.

## Run

```sh
npm install
npm start
```

First launch opens **Settings**. Leave everything blank to try mock mode, or paste a
`GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) and pick your speech providers. Settings are
saved to `clicky-settings.json` in your user data folder (never committed). A `.env`
file is optional and only seeds first-run defaults.

## Features

- Screen-aware Q&A with voice answers and an on-screen caption.
- Push-to-talk global hotkey (hold to talk) with a status-glowing cursor character.
- Step-by-step **walkthroughs** with an animated pointer ring over the target control.
- Background **Clicky Agent** with a tool set: screenshot, web search, list/read/write
  files, summarize a folder, open apps/URLs, create notes, add reminders.
- Native integrations (file-based, cross-platform): Notes and Reminders.
- Multi-monitor overlays; conversation + agent history persisted locally.
- Pluggable providers: Gemini/Claude brain, OS or AssemblyAI STT, OS or ElevenLabs TTS.
- System tray, Settings UI, Command UI, mock mode, cross-platform build targets.

## Configuration

| Setting | Options | Notes |
| --- | --- | --- |
| Provider | mock / gemini / anthropic | The brain. Needs a key unless mock. |
| STT | os / assemblyai / mock | `os` = Windows SAPI (free). macOS/Linux have no offline STT - use AssemblyAI. |
| TTS | os / elevenlabs / mock | `os` = Windows SAPI / macOS `say` / Linux `espeak-ng`. |
| Web search | none / serper / brave | Used by the agent's `webSearch` tool. |
| PTT keycode | uiohook keycode | Default 29 (Left Ctrl). |
| Multi-monitor | on/off | One overlay per display. |

Agent safety toggles: file writes, app launch. Both are on by default and can be
disabled in Settings.

## Architecture

- `main.js` - app orchestration: overlays, tray, command/settings windows, PTT loop,
  walkthroughs, agent, IPC.
- `store.js` / `config.js` - persistent settings (source of truth) + live resolution of
  providers from keys.
- `services/providers.js` - facade that picks the active LLM/STT/TTS at call time.
- `services/llm.js` - Gemini + Claude (vision + text + strict JSON).
- `services/stt.js` + `stt-win.js` / `assemblyai.js` + `assets/stt.ps1` - speech-to-text.
- `services/tts.js` + `tts-os.js` / `tts-win.js` / `tts-elevenlabs.js` + `assets/tts.ps1` - text-to-speech.
- `services/capture.js` - per-display screenshots. `services/overlays.js` - overlay windows.
- `services/hotkey.js` - hold-to-talk (uiohook, globalShortcut fallback).
- `services/agent.js` + `tools.js` - the background agent and its tools.
- `services/walkthrough.js` - structured steps with normalized pointing targets.
- `services/integrations.js` / `memory.js` / `cache.js` - notes/reminders/folders, history, LRU cache.
- `renderer.js` / `command.js` / `settings.js` - cursor character + ring + caption, the command UI, the settings UI.

## Build / package

```sh
npm run build   # electron-builder: Windows (nsis, portable), macOS (dmg, zip), Linux (AppImage, deb)
```

## Notes and limitations

- Offline STT is Windows-only out of the box; use AssemblyAI elsewhere.
- Walkthrough coordinates are best-effort visual estimates from the screenshot.
- The pointer overlay is click-through; the Command and Settings windows are normal windows.
- Brand icons are placeholders.
