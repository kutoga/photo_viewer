'use strict';
const icons = {
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  settings:
    '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0-0-8Zm0-5v2m0 14v3M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M3 12h2m14 0h2M4.9 19.1l1.4-1.4M18 6.3l1.4-1.4"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
  maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  minimize: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  aperture:
    '<circle cx="12" cy="12" r="9"/><path d="m14.3 3.3 3.4 5.9-3.4 5.9H7.5L4.1 9.2M21 12H14.3l-3.4 5.9 3.4 3M7.5 20l3.4-5.9L7.5 8.2 10 3"/>',
  map: '<path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Zm0-15v15m6-12v15"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  mountain:
    '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="m2 17 6-7 5 6 3-4 6 7"/><circle cx="16" cy="7.5" r="1"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 9 5-3v12l-5-3"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  'folder-plus':
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM12 10v7m-3-3.5h6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6 6-2Z"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h2m4 0h2m-8 3h2"/>',
  undo: '<path d="M3 5v6h6m-6 0a9 9 0 1 1 2 7"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1-1.5 3m0 3h.01"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
  'wifi-off':
    '<path d="m3 3 18 18M2 8a16 16 0 0 1 3-2m4-2a16 16 0 0 1 13 4M5 12a11 11 0 0 1 4-2m5 0a11 11 0 0 1 5 2M8.5 15.5a5 5 0 0 1 7 0M12 19h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  play: '<path d="m9 5 11 7-11 7V5Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
};
window.icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.image}</svg>`;
window.fillIcons = (root = document) =>
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
fillIcons();
