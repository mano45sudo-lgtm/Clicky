// Global hold-to-talk hotkey.
// Prefers uiohook (real press/release detection on one key). Falls back to an
// Electron globalShortcut toggle (press = start, press again = stop) if uiohook
// is unavailable.
const { globalShortcut } = require('electron');
const config = require('../config');

let uiohook = null;
try {
  uiohook = require('uiohook-napi').uIOhook;
} catch (e) {
  uiohook = null;
}

// onDown(), onUp() drive the push-to-talk cycle.
function start({ onDown, onUp }) {
  if (uiohook) {
    try {
      const target = config.hotkeyUiohookKeycode;
      let down = false;

      uiohook.on('keydown', (e) => {
        if (e.keycode === target && !down) {
          down = true;
          onDown();
        }
      });
      uiohook.on('keyup', (e) => {
        if (e.keycode === target && down) {
          down = false;
          onUp();
        }
      });
      uiohook.start();
      return { mode: 'uiohook', stop: () => { try { uiohook.stop(); } catch (e) {} } };
    } catch (e) {
      console.error('[hotkey] uiohook start failed, using globalShortcut fallback', e.message);
    }
  }

  // Fallback: every press fires onDown (a toggle). onUp is unused here.
  const accelerator = process.env.CLICKY_HOTKEY_SHORTCUT || 'Control';
  const ok = globalShortcut.register(accelerator, () => {
    onDown();
  });

  if (!ok) console.error('[hotkey] globalShortcut fallback registration failed');

  return { mode: 'globalShortcut', stop: () => globalShortcut.unregisterAll() };
}

module.exports = { start };
