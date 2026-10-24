# Changelog

All notable changes to HeyClicky are documented here.

## [0.1.0] - 2026-02 (beta)

Launch-readiness milestone release for Windows.

### Added
- **Voice loop**: push-to-talk (hold Left Ctrl), local Whisper STT, Groq brain,
  Gemini vision, Fish Audio TTS (OS voice fallback); command window and per-goal agent.
- **Acting agent** with 23 tools: openApp, clickOnScreen, typeInto, typeText,
  pressKey, runCommand, captureScreen, webSearch, file tools, notes, reminders,
  email drafts, drawing, and browser tools (navigate/click/type).
- **UIA-first input driver** (`assets/input.ps1` + `services/control.js`):
  InvokePattern/ValuePattern fast paths, SendKeys typing with focus guarantee;
  the guide arrow never shows during real actions.
- **Persistent input server**: one hidden PowerShell process handles all input
  commands over stdin (removes ~400 ms PowerShell cold start per action), with
  automatic one-shot fallback.
- **Fast vision fallback**: lite Gemini model for locate-only calls (~1.2 s).
- **Observe-and-retry loop**: per-step verification, corrective re-plan with a
  fresh screenshot (max 2 retries), failures surfaced in red and spoken aloud.
- **Browser automation via CDP** (`services/cdp.js`): launch/attach Chrome or
  Edge on a debug port; reliable web form typing/clicking where UIA is weak.
- **App knowledge pack** (`services/knowledge.js`): canonical UIA control names
  for Word, Excel, Chrome, Explorer, Settings, Outlook, plus phrase synonyms.
- **Live in-app editing**: the agent works directly in the foreground window
  (Excel cells via the Name Box recipe, Word docs, forms) - no side files, no
  copy-paste blocks; "do this in excel here"-style commands route to the agent.
- **Guardrails** (`services/guardrails.js`): global Stop hotkey (Escape, armed
  only during agent runs), confirm-before-destructive with Allow/Block/Stop
  overlay prompt (60 s auto-refuse), allowlist, read-only preview mode.
- **Observability**: live per-step activity line in the overlay; structured
  rotating file log (`clicky.log`, 5 MB); input-driver health probe on startup.
- **Onboarding**: first-run wizard (keys status, mic/driver check, hold-to-talk
  explainer, live "draw a smiley" demo); tray menu with Stop; optional autostart;
  Antivirus & troubleshooting section with Defender-exclusions shortcut.
- **Multiplayer-cursor buddy design**: the cursor buddy is now the arrow-pointer
  glyph with an accent-tinted name+message label pill (Figma-style).
- **Packaging**: electron-builder NSIS installer + portable exe; auto-update
  via electron-updater + GitHub Releases (packaged builds only).
- **Release gate**: headless smoke test (`npm run test:smoke`) checking config,
  tool registration, guardrail classification, and the UIA probe.

### Fixed
- Typing regression: SendKeys lands text in the focused window without
  touching the clipboard; foreground window is forced before typing.
