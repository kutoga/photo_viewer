'use strict';
function restoreBounds(saved, displays) {
  const area = displays[0].workArea;
  const bounds = saved?.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])))
    return { width: Math.min(1440, area.width), height: Math.min(960, area.height) };
  const display =
    displays.find(
      ({ workArea: a }) =>
        bounds.x < a.x + a.width &&
        bounds.x + bounds.width > a.x &&
        bounds.y < a.y + a.height &&
        bounds.y + bounds.height > a.y,
    )?.workArea || area;
  const width = Math.min(display.width, Math.max(900, Math.round(bounds.width)));
  const height = Math.min(display.height, Math.max(640, Math.round(bounds.height)));
  return {
    width,
    height,
    x: Math.round(Math.max(display.x, Math.min(display.x + display.width - width, bounds.x))),
    y: Math.round(Math.max(display.y, Math.min(display.y + display.height - height, bounds.y))),
  };
}
module.exports = { restoreBounds };
