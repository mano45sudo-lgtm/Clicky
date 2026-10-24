# Changelog

All notable changes to HeyClicky are documented here.

## [Unreleased]

### Added
- **Verify-after-act for typing**: `typeInto` and `typeText` now read the focused
  field's value back through Windows UI Automation and confirm the text actually
  landed. If a field we *can* read is still empty, the step is reported as failed
  after one corrective retry - which finally trips the agent's re-plan loop instead
  of falsely claiming success. Web fields where UIA is blind return a `noread` token,
  so verification is skipped there and never causes a false failure or a double-typed
  email.
- **Cursor micro-interactions**: the pointer now leans into its direction of
  travel, occasionally blinks, grows with speed, and leaves a faint motion
  trail. A state-reactive presence ring surrounds it - expanding emerald rings
  while listening, an amber orbiting spinner while thinking, and a pulsing
  sky equalizer while speaking.

### Changed
- **Stronger open-source planning brain**: the agent/assistant brain now runs on
  **Qwen3-235B via OpenRouter** (`openrouter` provider) instead of the fast Groq
  model, for markedly better multi-step tool planning. If Qwen3 is rate-limited it
  auto-falls back to DeepSeek-V3.2 / Qwen3-Next / Groq. Groq stays configured as an
  instant fallback brain and Gemini remains the vision/eyes provider.
- **Faster perceived voice**: releasing the talk key now shows "Thinking..."
  immediately, and the screen capture runs in parallel with transcription
  instead of after it (hands-free and push-to-talk both benefit).
- **Snappier turn-taking**: default VAD silence lowered 900 ms -> 650 ms.
- **Shorter Gemini retry waits**: fallback backoff trimmed (900/1600/700 ms ->
  250/500/200 ms) so 503 spikes cost far less wall-clock time.
- **Vision identification**: screen/photo answers now use a dedicated
  `VISION_SYSTEM` prompt that names the *subject* (plant, animal, object,
  error, document) instead of narrating the surrounding UI. Fix for "show a
  leaf, get a desktop description."
- **Higher-accuracy vision chain**: identification calls fall through to
  `gemini-2.5-pro` before flash when the preferred model is unavailable, so
  "what is this" answers stay confident under load.

### Fixed
- **Web/email field detection**: `typeInto` and `clickOnScreen` now fall back
  to a strong-model vision locate (find the field, click to focus, then type),
  so writing into an already-open Gmail/Outlook compose body works without the
  user clicking first. CDP matcher also sees `contenteditable`/ARIA textboxes.
- **Already-open browser guidance**: the planner no longer assumes CDP can
  attach to the user's own browser; it drives visible web pages by looking.
- **Browser actions no longer need a manual click**: `browserClick`/`browserType`
  now self-heal - if CDP cannot reach the page they fall back to the vision
  locate + real click/type path instead of just failing.
- **Confidence-gated pointing**: `visionLocate` asks the model for a confidence
  score and refuses a low-confidence (<0.55) guess from the quick model, so it
  escalates to the strong model instead of misclicking off-target.
- **UIA errors no longer abort detection**: a thrown error in the UIA fast path
  of `clickOnScreen`/`typeInto` used to return immediately and skip the vision
  fallback; it now falls through, so web fields still get found by looking.

## [0.1.0] - 2026-02 (beta)

Launch-readiness milestone release for Windows.

### Added
- **Voice loop**: push-to-talk (hold Left Ctrl), Sarvam STT, Groq brain,
  Gemini vision, Sarvam/Bulbul TTS; command window and per-goal agent.
- **Circle-to-ask**: hold Ctrl and drag the mouse to ring any on-screen area;
  Clicky crops that region, listens for one spoken question, and answers about
  just the circled part (the drag cancels hold-to-talk so they never clash).
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
