const { BrowserWindow, screen } = require('electron');
const path = require('path');

// Manages one transparent, click-through overlay per display. Broadcasts the
// cursor position, and targeted commands (record / pointer ring) to the overlay
// that owns the relevant display.
class Overlays {
  constructor(preloadPath) {
    this.preload = preloadPath;
    this.wins = new Map(); // displayId -> BrowserWindow
    this.poll = null;
  }

  _create(display) {
    const bounds = display.bounds;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    win.__displayId = display.id;
    win.__bounds = bounds;
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, '..', 'index.html'));

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('clicky:init', { displayId: display.id, scaleFactor: display.scaleFactor || 1 });
    });

    win.on('closed', () => this.wins.delete(display.id));
    this.wins.set(display.id, win);
  }

  createAll(multiMonitor) {
    this.destroy();
    const displays = multiMonitor ? screen.getAllDisplays() : [screen.getPrimaryDisplay()];
    for (const d of displays) this._create(d);
    this._startPoll();
  }

  _startPoll() {
    this.poll = setInterval(() => {
      const cursor = screen.getCursorScreenPoint();
      for (const win of this.wins.values()) {
        if (!win || win.isDestroyed()) continue;
        const b = win.__bounds;
        const onThis = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
        win.webContents.send('cursor-pos', { x: cursor.x - b.x, y: cursor.y - b.y, onThis });
      }
    }, 16);
  }

  // Broadcast to every overlay.
  send(channel, payload) {
    for (const win of this.wins.values()) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  // Send only to the overlay owning a given display (or the cursor's display).
  sendToDisplay(channel, payload, displayId) {
    const target = displayId != null
      ? this.wins.get(String(displayId)) || this.wins.get(displayId)
      : this._cursorWin();
    if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
  }

  _cursorWin() {
    const cursor = screen.getCursorScreenPoint();
    for (const win of this.wins.values()) {
      const b = win.__bounds;
      if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
        return win;
      }
    }
    // fall back to the primary-display overlay
    const primary = screen.getPrimaryDisplay();
    return this.wins.get(primary.id) || this.wins.values().next().value;
  }

  count() {
    return this.wins.size;
  }

  destroy() {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    for (const win of this.wins.values()) {
      try { win.destroy(); } catch (e) {}
    }
    this.wins.clear();
  }
}

module.exports = { Overlays };
