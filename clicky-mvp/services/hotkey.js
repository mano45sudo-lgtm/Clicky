// Global hold-to-talk hotkey + the "circle an area to ask" gesture.
// Prefers uiohook (real press/release detection on one key + global mouse
// events). Falls back to an Electron globalShortcut toggle (press = start, press
// again = stop) for voice only if uiohook is unavailable.
//
// Gesture disambiguation (both share the Ctrl key):
//   Ctrl (hold) .................... push-to-talk voice command (unchanged)
//   Ctrl + mouse drag .............. draw a region to ask about ("circle to ask")
// When a mouse press happens while Ctrl is held, we cancel the voice capture that
// started on key-down and switch into region mode, so the two never collide.
const { globalShortcut } = require('electron');
const config = require('../config');

let uiohook = null;
try {
  uiohook = require('uiohook-napi').uIOhook;
} catch (e) {
  uiohook = null;
}

// onDown/onUp drive the push-to-talk cycle. onRegionStart/Drag/End drive the
// selection gesture; onRegionCancel lets main abort a recording already started.
function start({ onDown, onUp, onRegionStart, onRegionDrag, onRegionEnd, onRegionCancel }) {
  if (uiohook) {
    try {
      const target = config.hotkeyUiohookKeycode;
      let mode = 'idle'; // idle | voice | region

      uiohook.on('keydown', (e) => {
        if (e.keycode === target && mode === 'idle') {
          mode = 'voice';
          if (onDown) onDown();
        }
      });

      uiohook.on('keyup', (e) => {
        if (e.keycode !== target) return;
        if (mode === 'voice') {
          mode = 'idle';
          if (onUp) onUp();
        } else if (mode === 'region') {
          // Releasing Ctrl after a selection: swallow so we don't fire voice.
          mode = 'idle';
        }
      });

      uiohook.on('mousedown', (e) => {
        if (mode === 'voice') {
          mode = 'region';
          if (onRegionCancel) onRegionCancel(); // abort the PTT capture from key-down
          if (onRegionStart) onRegionStart({ x: e.x, y: e.y });
        }
      });

      uiohook.on('mousemove', (e) => {
        if (mode === 'region' && onRegionDrag) onRegionDrag({ x: e.x, y: e.y });
      });

      uiohook.on('mouseup', (e) => {
        if (mode === 'region' && onRegionEnd) onRegionEnd({ x: e.x, y: e.y });
      });

      uiohook.start();
      return { mode: 'uiohook', stop: () => { try { uiohook.stop(); } catch (e) {} } };
    } catch (e) {
      console.error('[hotkey] uiohook start failed, using globalShortcut fallback', e.message);
    }
  }

  // Fallback: voice toggle only (no global mouse events available).
  const accelerator = process.env.CLICKY_HOTKEY_SHORTCUT || 'Control';
  const ok = globalShortcut.register(accelerator, () => {
    if (onDown) onDown();
  });

  if (!ok) console.error('[hotkey] globalShortcut fallback registration failed');

  return { mode: 'globalShortcut', stop: () => globalShortcut.unregisterAll() };
}

module.exports = { start };
