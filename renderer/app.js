'use strict';
const $ = (id) => document.getElementById(id);
const api = window.photoMap;
const state = {
  items: new Map(),
  folders: [],
  summary: { total: 0, located: 0, withoutGPS: 0 },
  filtered: [],
  filters: { type: 'all', search: '', folder: '', from: '', to: '' },
  view: 'map',
  sort: 'newest',
  scanning: false,
  dates: { min: '', max: '' },
  viewer: { list: [], index: -1, token: 0 },
  area: [],
  firstScan: false,
};
let atlas, gallery, areaGallery, filterTimer, toastTimer, removeTarget, previewTimer;
let catalog,
  filterRequest = 0,
  filterBusy = false,
  pendingFilter = null,
  filterOptions;
function sendFilter(options) {
  filterBusy = true;
  filterOptions = options;
  catalog.postMessage({
    type: 'filter',
    request: ++filterRequest,
    filters: state.filters,
    sort: state.sort,
  });
}
function initCatalog() {
  catalog = new Worker('library-worker.js');
  catalog.onerror = () => {
    filterBusy = false;
    error('The library could not be refreshed. Restart Photo Map.');
  };
  catalog.onmessage = ({ data }) => {
    if (data.type === 'error') {
      filterBusy = false;
      error(data.error);
      return;
    }
    if (data.type !== 'filtered' || data.request !== filterRequest) return;
    filterBusy = false;
    if (pendingFilter) {
      const options = pendingFilter;
      pendingFilter = null;
      sendFilter(options);
      return;
    }
    state.filtered = data.ids.map((id) => state.items.get(id)).filter(Boolean);
    state.dates = data.dates;
    atlas.setItems(state.filtered);
    updateDates();
    updateSummary();
    if (state.view === 'gallery') gallery.setItems(state.filtered, filterOptions.resetGallery);
    if (filterOptions.fit && state.items.size) atlas.fit();
  };
}
const count = (value) => Number(value).toLocaleString();
function error(message) {
  $('error-text').textContent = message;
  $('error-banner').hidden = false;
}
function toast(message) {
  $('toast-text').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 5000);
}
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    error(err.message);
    return null;
  }
}
function snapshot(data, fit = false) {
  state.items = new Map(data.items.map((p) => [p.id, p]));
  state.folders = data.folders;
  state.summary = data.summary;
  catalog.postMessage({ type: 'replace', items: data.items });
  renderFolders();
  applyFilters({ fit });
  if (data.scan) progress(data.scan);
}
function renderFolders() {
  const list = $('folder-list');
  list.replaceChildren();
  for (const folder of state.folders) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.title = folder.path;
    row.innerHTML = icon('folder');
    const copy = document.createElement('div');
    copy.className = 'folder-copy';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    const detail = document.createElement('span');
    detail.className = 'folder-detail';
    detail.textContent = folder.warning
      ? 'Folder needs attention'
      : `${count(folder.count)} files indexed`;
    if (folder.warning) {
      detail.classList.add('folder-warning');
      row.title += '\n' + folder.warning;
    }
    copy.append(name, detail);
    const remove = document.createElement('button');
    remove.className = 'icon-button folder-remove';
    remove.innerHTML = icon('close');
    remove.title = `Remove ${folder.name}`;
    remove.setAttribute('aria-label', `Remove folder ${folder.name}`);
    remove.disabled = state.scanning;
    remove.addEventListener('click', () => {
      removeTarget = folder.path;
      $('confirm-description').textContent =
        `“${folder.name}” will be removed from your library. Its cached previews will be cleared unless another source folder includes them.`;
      $('confirm-dialog').showModal();
      $('confirm-cancel').focus();
    });
    row.append(copy, remove);
    list.append(row);
  }
  if (!state.folders.length) {
    const empty = document.createElement('p');
    empty.className = 'folder-empty';
    empty.textContent = 'Every collection starts somewhere.';
    list.append(empty);
  }
  const select = $('folder-filter');
  select.replaceChildren(new Option('All folders', ''));
  for (const folder of state.folders) select.add(new Option(folder.name, folder.path));
  if (!state.folders.some((f) => f.path === state.filters.folder)) state.filters.folder = '';
  select.value = state.filters.folder;
  $('rescan').disabled = state.scanning || !state.folders.length;
}
function updateSummary() {
  const located = state.items.size;
  $('library-total').textContent = count(state.summary.total);
  $('located-total').textContent = count(located);
  $('visible-count').textContent = count(state.filtered.length);
  $('visible-caption').textContent = isFiltered() ? 'matching memories' : 'on your map';
  $('unlocated-note').hidden = !state.summary.withoutGPS;
  $('unlocated-note').textContent =
    `${count(state.summary.withoutGPS)} files have no GPS location and aren’t shown on the map.`;
  $('gallery-count').textContent =
    `${count(state.filtered.length)} ${state.filtered.length === 1 ? 'memory' : 'memories'}${isFiltered() ? ' matching your filters' : ' in your library'}`;
  $('empty-state').hidden = state.folders.length > 0 || located > 0 || state.scanning;
  const noResults =
    !state.filtered.length && (state.folders.length > 0 || located > 0) && !state.scanning;
  $('no-results').hidden = !noResults;
  $('no-results-description').textContent = located
    ? 'Try a different date, folder, or media type.'
    : 'No GPS-tagged photos found yet. Add a folder with location-enabled photos, or rescan your folders.';
  $('clear-empty-filters').hidden = !located;
  $('browse-area').disabled = !state.filtered.length;
  $('fit-map').disabled = !state.filtered.length;
  $('reset-filters').hidden = !isFiltered();
  $('status-secondary').textContent = located
    ? `${count(state.folders.length)} source ${state.folders.length === 1 ? 'folder' : 'folders'} · Originals untouched`
    : 'Made for your memories';
}
function isFiltered() {
  const f = state.filters;
  return f.type !== 'all' || f.search || f.folder || f.from || f.to;
}
function applyFilters({ resetGallery = true, fit = false } = {}) {
  clearTimeout(filterTimer);
  filterTimer = null;
  if (resetGallery) closeArea();
  const options = { resetGallery, fit: fit || (filterOptions?.fit && filterBusy) };
  if (filterBusy) {
    pendingFilter = {
      resetGallery: resetGallery || pendingFilter?.resetGallery,
      fit: options.fit || pendingFilter?.fit,
    };
  } else sendFilter(options);
}
function scheduleFilters() {
  if (!filterTimer)
    filterTimer = setTimeout(
      () => {
        filterTimer = null;
        applyFilters({ resetGallery: false });
      },
      state.scanning ? 2000 : 300,
    );
}
function resetFilters() {
  state.filters = { type: 'all', search: '', folder: '', from: '', to: '' };
  $('search').value = '';
  $('folder-filter').value = '';
  setType('all', false);
  applyFilters();
}
function setType(type, apply = true) {
  state.filters.type = type;
  document.querySelectorAll('[data-type]').forEach((button) => {
    const selected = button.dataset.type === type;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected);
  });
  if (apply) applyFilters();
}
function setView(view) {
  state.view = view;
  const mapView = view === 'map';
  $('map-view').hidden = !mapView;
  $('gallery-view').hidden = mapView;
  $('view-map').classList.toggle('selected', mapView);
  $('view-gallery').classList.toggle('selected', !mapView);
  $('view-map').setAttribute('aria-pressed', mapView);
  $('view-gallery').setAttribute('aria-pressed', !mapView);
  $('breadcrumb-view').textContent = mapView ? 'Map explorer' : 'Photo gallery';
  $('view-title').textContent = mapView
    ? 'Your world, in pictures.'
    : 'A collection of good moments.';
  $('view-eyebrow').textContent = mapView
    ? 'EVERY MEMORY HAS A PLACE'
    : 'THE BIG DAYS. THE LITTLE DETAILS.';
  $('view-description').textContent = mapView
    ? 'Bring your photos together. Rediscover where you’ve been.'
    : 'All your geotagged memories, together in one place.';
  closeArea();
  if (mapView) requestAnimationFrame(() => atlas.resume());
  else gallery.setItems(state.filtered);
}
function showArea(items, title = 'Photos in this area') {
  state.area = PhotoModel.sort(items, state.sort);
  $('area-title').textContent = title;
  $('area-count').textContent =
    `${count(items.length)} ${items.length === 1 ? 'memory' : 'memories'} to rediscover`;
  $('area-panel').hidden = false;
  areaGallery.setItems(state.area);
  $('area-close').focus({ preventScroll: true });
}
function closeArea() {
  $('area-panel').hidden = true;
  state.area = [];
  areaGallery?.setItems([]);
  atlas?.cancelSelection();
}
function dateNumber(date) {
  return Date.parse(date + 'T00:00:00Z') / 86400000;
}
function numberDate(number) {
  return new Date(number * 86400000).toISOString().slice(0, 10);
}
function updateDates() {
  const { min, max } = state.dates;
  const enabled = Boolean(min && max);
  for (const id of ['date-from', 'date-to', 'range-from', 'range-to']) $(id).disabled = !enabled;
  $('date-reset').disabled = !state.filters.from && !state.filters.to;
  $('timeline-caption').textContent = enabled
    ? state.filters.from || state.filters.to
      ? 'A moment in time'
      : 'Every chapter, all dates'
    : 'No dated photos yet';
  if (!enabled) {
    $('date-from').value = '';
    $('date-to').value = '';
    return;
  }
  const from = state.filters.from || min,
    to = state.filters.to || max;
  // An unrestricted range stays unrestricted as new dates arrive during a scan.
  $('date-from').value = from;
  $('date-to').value = to;
  $('date-from').min = min;
  $('date-from').max = to;
  $('date-to').min = from;
  $('date-to').max = max;
  const days = Math.max(0, dateNumber(max) - dateNumber(min));
  $('range-from').max = days;
  $('range-to').max = days;
  $('range-from').value = Math.max(0, dateNumber(from) - dateNumber(min));
  $('range-to').value = Math.min(days, dateNumber(to) - dateNumber(min));
  $('range-fill').style.left =
    (days ? Math.max(0, ((dateNumber(from) - dateNumber(min)) / days) * 100) : 0) + '%';
  $('range-fill').style.right =
    (days ? Math.max(0, ((dateNumber(max) - dateNumber(to)) / days) * 100) : 0) + '%';
  $('range-from').disabled = !days;
  $('range-to').disabled = !days;
}
function changeDate(which, value) {
  const from = which === 'from' ? value : state.filters.from || state.dates.min;
  const to = which === 'to' ? value : state.filters.to || state.dates.max;
  if (from && to && from > to) {
    toast('The start date must come before the end date.');
    updateDates();
    return;
  }
  state.filters[which] = value;
  applyFilters();
}
function setScanning(scanning) {
  state.scanning = scanning;
  $('scan-panel').hidden = !scanning;
  $('map-import-status').hidden = !scanning;
  document.querySelectorAll('[data-add-folder], .folder-remove').forEach((button) => {
    button.disabled = scanning;
  });
  $('rescan').disabled = scanning || !state.folders.length;
  $('cancel-scan').disabled = false;
  $('cancel-scan').textContent = 'Stop scan';
  updateSummary();
}
function progress(data) {
  if (!state.scanning) setScanning(true);
  $('scan-title').textContent = 'Finding your memories…';
  $('scan-detail').textContent = data.currentFile || 'Exploring folders and checking for changes';
  $('map-import-status').textContent = `Importing · ${count(data.processed)} checked`;
  $('scan-count').textContent = `${count(data.processed)} checked · ${count(data.added)} new`;
  $('status-text').textContent = 'Scanning in the background · You can keep exploring';
}
async function startScan() {
  if (state.scanning) return;
  state.firstScan = state.items.size === 0;
  $('error-banner').hidden = true;
  setScanning(true);
  try {
    await api.startScan();
  } catch (err) {
    setScanning(false);
    error(err.message);
  }
}
async function addFolders() {
  const data = await attempt(() => api.addFolders());
  if (!data) return;
  snapshot(data);
  await startScan();
}
function viewerItem() {
  return state.viewer.list[state.viewer.index];
}
function openViewer(items, index) {
  state.viewer.list = [...items];
  state.viewer.index = index;
  if (!$('lightbox').open) $('lightbox').showModal();
  showViewerItem();
}
function photoById(id, list = state.filtered) {
  const index = list.findIndex((p) => p.id === id);
  if (index >= 0) openViewer(list, index);
}
function closeViewer() {
  state.viewer.token++;
  clearTimeout(previewTimer);
  $('viewer-video').pause();
  $('viewer-video').removeAttribute('src');
  $('viewer-video').load();
  $('viewer-image').removeAttribute('src');
  $('lightbox').close();
  state.viewer.index = -1;
}
function moveViewer(delta) {
  const viewer = state.viewer;
  if (!viewer.list.length) return;
  viewer.index = (viewer.index + delta + viewer.list.length) % viewer.list.length;
  showViewerItem();
}
function showViewerItem() {
  const p = viewerItem();
  if (!p) return;
  const token = ++state.viewer.token;
  clearTimeout(previewTimer);
  const image = $('viewer-image'),
    video = $('viewer-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  image.onload = null;
  image.onerror = null;
  image.hidden = !p.hasThumbnail;
  if (p.hasThumbnail) image.src = PhotoModel.thumb(p);
  else image.removeAttribute('src');
  image.alt = p.filename;
  $('viewer-error').hidden = true;
  $('viewer-loading').hidden = false;
  $('viewer-name').textContent = p.filename;
  $('viewer-date').textContent = p.date
    ? new Date(p.date).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
    : 'Date unknown';
  $('viewer-date').textContent += ` · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  $('viewer-path').textContent = p.originalPath;
  $('viewer-position').textContent =
    `${state.viewer.index + 1} / ${count(state.viewer.list.length)}  ·  ${p.type === 'video' ? 'VIDEO' : 'PHOTO'}`;
  $('viewer-prev').disabled = $('viewer-next').disabled = state.viewer.list.length < 2;
  video.onerror = () => {
    if (state.viewer.token === token)
      viewerError(
        'This video cannot be played here. Choose “Open original” to use your default player.',
      );
  };
  previewTimer = setTimeout(async () => {
    try {
      const preview = await api.getPreview(p.id);
      if (token !== state.viewer.token || !$('lightbox').open) return;
      if (preview.video) {
        image.hidden = true;
        video.hidden = false;
        video.poster = preview.image;
        video.src = preview.video;
        video.load();
        $('viewer-loading').hidden = true;
      } else {
        const preload = new Image();
        preload.onload = () => {
          if (token === state.viewer.token && $('lightbox').open) {
            image.src = preview.image;
            image.hidden = false;
            $('viewer-loading').hidden = true;
          }
        };
        preload.onerror = () => {
          if (token === state.viewer.token)
            viewerError('The preview is unavailable. Try opening the original file.');
        };
        preload.src = preview.image;
      }
    } catch (err) {
      if (token === state.viewer.token) viewerError(`${err.message}. You can try “Open original”.`);
    }
  }, 90);
}
function viewerError(message) {
  $('viewer-loading').hidden = true;
  $('viewer-error').textContent = message;
  $('viewer-error').hidden = false;
}
async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else {
    if (state.view !== 'map') setView('map');
    await document.documentElement.requestFullscreen();
  }
}
function updateFullscreen() {
  const active = Boolean(document.fullscreenElement);
  document.body.classList.toggle('map-fullscreen', active);
  $('map-fullscreen').setAttribute('aria-pressed', String(active));
  $('map-fullscreen').setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen map');
  $('map-fullscreen').title = active ? 'Exit fullscreen (Esc or F11)' : 'Fullscreen map (F11)';
  $('fullscreen-label').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
  $('fullscreen-icon').innerHTML = icon(active ? 'minimize' : 'maximize');
  requestAnimationFrame(() => atlas.resume());
}
function setupEvents() {
  $('map-fullscreen').addEventListener('click', () => attempt(toggleFullscreen));
  document.addEventListener('fullscreenchange', updateFullscreen);
  document
    .querySelectorAll('[data-add-folder]')
    .forEach((button) => button.addEventListener('click', addFolders));
  $('rescan').addEventListener('click', startScan);
  $('cancel-scan').addEventListener('click', async () => {
    $('cancel-scan').disabled = true;
    $('cancel-scan').textContent = 'Finishing…';
    await attempt(() => api.cancelScan());
  });
  $('view-map').addEventListener('click', () => setView('map'));
  $('view-gallery').addEventListener('click', () => setView('gallery'));
  $('brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    setView('map');
    atlas.fit();
  });
  $('nav-library').addEventListener('click', () => {
    resetFilters();
    atlas.fit();
  });
  $('fit-map').addEventListener('click', () => atlas.fit());
  $('zoom-in').addEventListener('click', () => atlas.map.zoomIn());
  $('zoom-out').addEventListener('click', () => atlas.map.zoomOut());
  $('show-labels').addEventListener('change', (e) => atlas.setLabels(e.target.checked));
  $('retry-tiles').addEventListener('click', () => atlas.retryTiles());
  $('browse-area').addEventListener('click', () =>
    showArea(state.filtered.filter((p) => PhotoModel.inBounds(p, atlas.bounds()))),
  );
  $('area-close').addEventListener('click', closeArea);
  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    state.filters.search = e.target.value;
    searchTimer = setTimeout(applyFilters, 180);
  });
  document
    .querySelectorAll('[data-type]')
    .forEach((button) => button.addEventListener('click', () => setType(button.dataset.type)));
  $('folder-filter').addEventListener('change', (e) => {
    state.filters.folder = e.target.value;
    applyFilters();
  });
  $('reset-filters').addEventListener('click', resetFilters);
  $('clear-empty-filters').addEventListener('click', resetFilters);
  $('sort-order').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyFilters();
  });
  $('date-from').addEventListener('change', (e) => changeDate('from', e.target.value));
  $('date-to').addEventListener('change', (e) => changeDate('to', e.target.value));
  for (const which of ['from', 'to']) {
    $('range-' + which).addEventListener('input', (e) => {
      const other = Number($('range-' + (which === 'from' ? 'to' : 'from')).value);
      let value = Number(e.target.value);
      value = which === 'from' ? Math.min(value, other) : Math.max(value, other);
      e.target.value = value;
      state.filters[which] = numberDate(dateNumber(state.dates.min) + value);
      updateDates();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 120);
    });
  }
  $('date-reset').addEventListener('click', () => {
    state.filters.from = '';
    state.filters.to = '';
    applyFilters();
  });
  $('help-open').addEventListener('click', () => $('help-dialog').showModal());
  $('help-close').addEventListener('click', () => $('help-dialog').close());
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
  $('confirm-remove').addEventListener('click', async () => {
    const target = removeTarget;
    $('confirm-dialog').close();
    const data = await attempt(() => api.removeFolder(target));
    if (data) {
      snapshot(data);
      toast('Folder removed. Your original files are untouched.');
    }
  });
  $('viewer-close').addEventListener('click', closeViewer);
  $('lightbox').addEventListener('cancel', (e) => {
    e.preventDefault();
    closeViewer();
  });
  $('viewer-prev').addEventListener('click', () => moveViewer(-1));
  $('viewer-next').addEventListener('click', () => moveViewer(1));
  const viewerAction = (method) => {
    const item = viewerItem();
    if (item) api[method](item.id).catch((err) => viewerError(err.message));
  };
  $('viewer-path').addEventListener('click', () => viewerAction('reveal'));
  $('viewer-reveal').addEventListener('click', () => viewerAction('reveal'));
  $('viewer-map').addEventListener('click', () => viewerAction('openMaps'));
  $('viewer-original').addEventListener('click', () => viewerAction('openOriginal'));
  for (const dialog of document.querySelectorAll('dialog'))
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        dialog.id === 'lightbox' ? closeViewer() : dialog.close();
    });
  $('error-dismiss').addEventListener('click', () => {
    $('error-banner').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      if (!e.repeat) attempt(toggleFullscreen);
      return;
    }
    if ($('lightbox').open) {
      if (e.target === $('viewer-video')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        moveViewer(e.key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && document.fullscreenElement) {
      e.preventDefault();
      attempt(() => document.exitFullscreen());
      return;
    }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === '/') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().then(() => $('search').focus());
      else $('search').focus();
    }
    if (e.key.toLowerCase() === 'f') atlas.fit();
    if (e.key === 'Escape') closeArea();
  });
  api.onChanges(({ upsert, remove }) => {
    for (const id of remove) state.items.delete(id);
    for (const p of upsert) {
      if (PhotoModel.hasGPS(p)) state.items.set(p.id, p);
      else state.items.delete(p.id);
    }
    catalog.postMessage({ type: 'changes', upsert, remove });
    // Counts are cheap to update; sorting and spatial rebuilding are batched.
    $('located-total').textContent = count(state.items.size);
    scheduleFilters();
  });
  api.onProgress(progress);
  api.onComplete((data) => {
    state.summary = data.summary;
    state.folders = data.folders;
    setScanning(false);
    renderFolders();
    applyFilters({ resetGallery: false, fit: state.firstScan });
    const cancelled = data.phase === 'cancelled';
    $('status-text').textContent = cancelled
      ? 'Scan stopped · Progress saved'
      : `Library up to date · ${count(data.skipped)} unchanged files skipped`;
    toast(
      cancelled
        ? 'Scan stopped. Everything found so far is saved.'
        : `All caught up. ${count(data.added)} new files indexed.`,
    );
    if (data.errors)
      error(
        `${count(data.errors)} files or folders could not be fully read. You can still browse the rest of your library. Check your source drives and rescan to retry.`,
      );
  });
  api.onError((message) => {
    setScanning(false);
    error(message);
    $('status-text').textContent = 'Scan interrupted · Rescan to try again';
  });
}
async function init() {
  initCatalog();
  atlas = new PhotoAtlas({ onPhoto: photoById, onArea: showArea, onError: error });
  gallery = new VirtualGallery($('gallery-scroll'), $('gallery-space'), openViewer);
  areaGallery = new VirtualGallery($('area-scroll'), $('area-space'), openViewer, true);
  if (!api) {
    error(
      'Open Photo Map as a desktop app using npm start. The browser alone cannot access your photo folders.',
    );
    document.querySelectorAll('[data-add-folder]').forEach((b) => {
      b.disabled = true;
    });
    return;
  }
  setupEvents();
  const data = await attempt(() => api.getLibrary());
  if (data) {
    snapshot(data, true);
    if (state.items.size)
      $('status-text').textContent = 'Library ready · Everything stays on your device';
  }
}
init().catch((err) => error(err.message));
