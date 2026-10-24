// Headless release smoke test. Run with `npm run test:smoke` (or in CI) before
// building. It asserts the core wiring without opening any Electron windows:
//   - config resolves (provider detected from .env / defaults)
//   - the tool table registers (and the browser + guardrail tools are present)
//   - the guardrails flag destructive actions but not ordinary typing
//   - the Windows UI Automation driver runs (read-only probe, never clicks)
//   - a trivial agent step executes cleanly
// Exits non-zero on any hard failure so it can gate a release.
const os = require('os');
const fs = require('fs');
const path = require('path');

// Load config first (it reads .env through dotenv), then point the store at a
// throwaway temp dir so the test never touches the user's real settings.
const config = require('../config');
const store = require('../store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clicky-smoke-'));
store.init(tmp);

const tools = require('../services/tools');
const guardrails = require('../services/guardrails');
const control = require('../services/control');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? '  (' + extra + ')' : ''));
  if (!cond) failures++;
}

const defs = tools.definitions();
check('config resolves a provider', typeof config.provider === 'string' && config.provider.length > 0, 'provider=' + config.provider);
check('tool table registers (>= 20)', defs.length >= 20, defs.length + ' tools');
check('browser (CDP) tools present', ['browserNavigate', 'browserClick', 'browserType'].every((n) => defs.some((d) => d.name === n)));
check('guardrails flag a "Send" click', guardrails.analyze({ tool: 'clickOnScreen', args: { target: 'the Send button' } }).destructive === true);
check('guardrails allow ordinary typing', guardrails.analyze({ tool: 'typeText', args: { text: 'an essay about sending letters' } }).destructive === false);

(async () => {
  // Read-only UIA probe: findName never clicks or moves the cursor, so it is safe
  // to run unattended. A missing PowerShell (non-Windows CI) is skipped, not failed.
  if (process.platform === 'win32') {
    const r = await control.findName('__clicky_smoke_probe__');
    check('UIA input driver runs (no error)', !(r && r.error), r && r.error ? r.error : 'ok');
  } else {
    console.log('SKIP - UIA probe (non-Windows host)');
  }

  const w = await tools.exec('wait', { ms: 40 });
  check('a trivial agent step executes', w && w.ok === true, JSON.stringify(w));

  try {
    if (control.shutdown) control.shutdown();
  } catch (e) {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {}

  if (failures) {
    console.error('\nSMOKE FAILED: ' + failures + ' check(s).');
    process.exit(1);
  }
  console.log('\nSMOKE OK');
  process.exit(0);
})();
