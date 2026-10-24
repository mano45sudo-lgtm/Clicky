# HeyClicky — Launch Checklist (1 page)

Definition of launch ready: a non-technical user installs an .exe, completes a
2-minute first run, holds the key and says *"open Word and write an essay about
X"*, watches Clicky do it end-to-end with visible progress, and if anything
fails sees exactly what and why — with a Stop key and confirmations so it can't
do damage.

## 1. Build & release
- [ ] `npm run test:smoke` passes (provider resolves, 23 tools, guardrails, UIA probe).
- [ ] `npm run dist` produces the NSIS installer + portable exe in `dist/`.
- [ ] Version bumped in `package.json`; `CHANGELOG.md` updated.
- [ ] Release uploaded to GitHub Releases (feeds electron-updater).
- [ ] Unsigned-beta note published (SmartScreen → *More info → Run anyway*), or code signing configured.

## 2. Fresh-machine install test
- [ ] Installer completes; app launches from Start menu / tray.
- [ ] First-run wizard appears; keys can be entered; mic permission works.
- [ ] "Run the check" in onboarding passes (input-driver probe green).
- [ ] Onboarding demo ("draw a smiley") completes end-to-end.
- [ ] Autostart toggle actually starts/stops the app on login.

## 3. Manual voice matrix (one command each, verify outcome)
- [ ] Word — "open Word and write an essay about X" (text lands, no guide arrow).
- [ ] Notepad — dictate a paragraph.
- [ ] Excel — open a new workbook, type into a named cell.
- [ ] Chrome — search query, then fill a web form (CDP path).
- [ ] Explorer — open a folder.
- [ ] Settings — toggle a setting by name.
- [ ] No AV popup mid-task; no stray guide arrow; activity line updates live.

## 4. Guardrails
- [ ] Escape (Stop) cancels a running agent instantly; tray Stop works too.
- [ ] "Click Send / Submit / Delete" raises the red Allow/Block/Stop prompt;
      Block skips the step without re-planning; 60 s no-answer auto-refuses.
- [ ] Allowlist entry suppresses the prompt for that target.
- [ ] Preview mode narrates the plan and executes nothing.

## 5. Failure injection
- [ ] Kill the target app mid-task → agent reports the failure in red + speech
      and re-plans (max 2), does not hang.
- [ ] Ask to type into a closed/disabled field → clean error, no freeze.
- [ ] Request an unknown control → notfound reported, vision fallback tried.

## 6. Performance
- [ ] Essay task finishes under ~15 s wall-clock (persistent input server warm).
- [ ] Second action in a session has no PowerShell cold start (~400 ms saved).
- [ ] Locate-only vision calls use the lite model (~1.2 s).

## 7. Privacy & docs
- [ ] README privacy section matches behavior (screenshots only to chosen
      vision provider; logs local; no telemetry).
- [ ] `clicky.log` rotates at 5 MB and contains no key material.
- [ ] LICENSE + CHANGELOG ship with the package.
