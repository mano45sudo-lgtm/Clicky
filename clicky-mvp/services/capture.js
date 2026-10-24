const { desktopCapturer, screen } = require('electron');

// Capture a specific display (by id) as a PNG base64 string. No extra deps.
async function captureDisplay(displayId) {
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) ||
    screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor || 1;
  const size = display.size;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(size.width * scaleFactor),
      height: Math.round(size.height * scaleFactor)
    }
  });

  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

  if (!source || source.thumbnail.isEmpty()) return null;

  const dataUrl = source.thumbnail.toDataURL(); // "data:image/png;base64,...."
  return {
    base64: dataUrl.split(',')[1],
    mediaType: 'image/png',
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
    displayId: display.id
  };
}

function capturePrimaryDisplay() {
  return captureDisplay(screen.getPrimaryDisplay().id);
}

// Capture the display the OS cursor is currently on.
function captureCursorDisplay() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  return captureDisplay(display.id);
}

module.exports = { captureDisplay, capturePrimaryDisplay, captureCursorDisplay };
