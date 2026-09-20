/* Pure library operations, shared by the UI and regression tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhotoModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const hasGPS = (p) =>
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180;
  const day = (date) => {
    const d = new Date(date);
    return Number.isFinite(d.getTime())
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : '';
  };
  const normalizedPath = (path) =>
    /^[a-z]:[\\/]|^\\\\/i.test(path)
      ? path.replace(/\\/g, '/').toLowerCase()
      : path.replace(/\/$/, '');
  const withinFolder = (file, folder) => {
    const f = normalizedPath(file),
      d = normalizedPath(folder).replace(/\/$/, '');
    return f === d || f.startsWith(d + '/');
  };
  function filter(items, filters) {
    const q = (filters.search || '').trim().toLocaleLowerCase();
    return items.filter(
      (p) =>
        hasGPS(p) &&
        (filters.type === 'all' || !filters.type || (p.type || 'photo') === filters.type) &&
        (!q || p.originalPath.toLocaleLowerCase().includes(q)) &&
        (!filters.folder || withinFolder(p.originalPath, filters.folder)) &&
        (!p.date ||
          ((!filters.from || day(p.date) >= filters.from) &&
            (!filters.to || day(p.date) <= filters.to))),
    );
  }
  function dateBounds(items) {
    let min = '',
      max = '';
    for (const p of items) {
      if (!hasGPS(p) || !p.date) continue;
      const value = day(p.date);
      if (!value) continue;
      if (!min || value < min) min = value;
      if (!max || value > max) max = value;
    }
    return { min, max };
  }
  function inBounds(p, bounds) {
    let lng = p.lng;
    const [west, south, east, north] = bounds;
    // Leaflet's world copies can produce bounds outside [-180, 180].
    lng += 360 * Math.round(((west + east) / 2 - lng) / 360);
    return p.lat >= south && p.lat <= north && (east - west >= 360 || (lng >= west && lng <= east));
  }
  function sort(items, order = 'newest') {
    return [...items].sort((a, b) => {
      if (order === 'name')
        return a.filename.localeCompare(b.filename, undefined, { numeric: true });
      if (!a.date && b.date) return 1;
      if (a.date && !b.date) return -1;
      const cmp =
        (a.date || '').localeCompare(b.date || '') || a.filename.localeCompare(b.filename);
      return order === 'oldest' ? cmp : -cmp;
    });
  }
  const thumb = (p) => p.thumbnailUrl || `media://thumbnails/${p.id}?v=${p.fileMtime || 0}`;
  return { hasGPS, day, filter, dateBounds, inBounds, sort, thumb, withinFolder };
});
