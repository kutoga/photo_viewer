'use strict';
const $ = (id) => document.getElementById(id);
const api = window.photoMap;
function readWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem('photo-map-workspace'));
    return saved?.version === 1 ? saved : {};
  } catch {
    return {};
  }
}
const workspace = readWorkspace();
let prefetchBusy = false;
let workspaceReady = false,
  workspaceTimer;
function saveWorkspace() {
  if (!workspaceReady) return;
  const center = atlas.map.getCenter();
  try {
    localStorage.setItem(
      'photo-map-workspace',
      JSON.stringify({
        version: 1,
        map: { lat: center.lat, lng: center.lng, zoom: atlas.map.getZoom() },
        mode: atlas.mode,
        labels: $('show-labels').checked,
        sidebar: !document.body.classList.contains('sidebar-collapsed'),
        view: state.view,
        sort: state.sort,
        gallerySize: gallery.targetSize,
        galleryLayout: gallery.layoutMode,
      }),
    );
  } catch {
    /* Browsing remains available if local storage is disabled/full. */
  }
}
function scheduleWorkspace() {
  clearTimeout(workspaceTimer);
  workspaceTimer = setTimeout(saveWorkspace, 180);
}
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
let atlas,
  gallery,
  areaGallery,
  filterTimer,
  toastTimer,
  removeTarget,
  previewTimer,
  neighborTimer,
  previewCache,
  photoZoom;
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
    renderMonths(data.months || []);
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
  $('visible-caption').textContent = isFiltered()
    ? 'matching memories'
    : state.view === 'map'
      ? 'on your map'
      : 'in your gallery';
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
  updateViewDates();
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
  $('view-title').textContent = mapView ? 'Map explorer' : 'Photo gallery';
  closeArea();
  updateSummary();
  scheduleWorkspace();
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
  updateViewDates();
  $('area-close').focus({ preventScroll: true });
}
function closeArea() {
  $('area-panel').hidden = true;
  state.area = [];
  areaGallery?.setItems([]);
  atlas?.cancelSelection();
  updateViewDates();
}
function viewItems() {
  if (!$('area-panel').hidden) return state.area;
  if (state.view === 'gallery') return state.filtered;
  const bounds = atlas.bounds();
  return state.filtered.filter((p) => PhotoModel.inBounds(p, bounds));
}
function updateViewDates() {
  if (!atlas) return;
  const dated = (p) => p.date && Number.isFinite(Date.parse(p.date));
  const bounds = atlas.bounds();
  const hasDates = !$('area-panel').hidden
    ? state.area.some(dated)
    : state.filtered.some(
        (p) => dated(p) && (state.view === 'gallery' || PhotoModel.inBounds(p, bounds)),
      );
  $('use-view-dates').disabled = !hasDates;
  $('area-use-dates').disabled = !state.area.some(dated);
  const context = !$('area-panel').hidden
    ? 'the open area panel'
    : state.view === 'map'
      ? 'the current map area'
      : 'the gallery results';
  $('use-view-dates').title = hasDates
    ? `Apply the earliest and latest photo dates from ${context} to the timeline`
    : `No dated photos in ${context}`;
}
function useViewDates() {
  const { min, max } = PhotoModel.dateBounds(viewItems());
  if (!min || !max) return;
  state.filters.from = min;
  state.filters.to = max;
  updateDates();
  applyFilters();
  toast(`Timeline set to ${min} – ${max}. Undated photos stay visible.`);
}
function toggleSidebar(show = document.body.classList.contains('sidebar-collapsed')) {
  document.body.classList.toggle('sidebar-collapsed', !show);
  $('sidebar').inert = !show;
  $('sidebar-toggle').setAttribute('aria-expanded', String(show));
  const label = `${show ? 'Hide' : 'Show'} library and filters`;
  $('sidebar-toggle').setAttribute('aria-label', label);
  $('sidebar-toggle').title = label;
  scheduleWorkspace();
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
function renderMonths(months) {
  const chart = $('timeline-months');
  const focused = document.activeElement?.dataset.month;
  chart.replaceChildren();
  const max = Math.max(1, ...months.map((entry) => entry.count));
  for (const entry of months) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.month = entry.month;
    const label = new Date(entry.month + '-01T12:00:00').toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    button.title = `${label} · ${count(entry.count)} photos — click to select this month`;
    button.setAttribute('aria-label', `${label}: ${count(entry.count)} photos`);
    button.disabled = !entry.count;
    button.style.setProperty('--month-height', `${Math.max(8, (entry.count / max) * 100)}%`);
    const selected =
      (!state.filters.from || entry.month >= state.filters.from.slice(0, 7)) &&
      (!state.filters.to || entry.month <= state.filters.to.slice(0, 7));
    button.setAttribute('aria-pressed', String(selected));
    chart.append(button);
    if (focused === entry.month) button.focus({ preventScroll: true });
  }
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
  clearTimeout(neighborTimer);
  photoZoom.reset();
  state.viewer.detailPromise = null;
  $('lightbox').close();
  state.viewer.index = -1;
}
function moveViewer(delta) {
  const viewer = state.viewer;
  if (!viewer.list.length) return;
  viewer.index = (viewer.index + delta + viewer.list.length) % viewer.list.length;
  showViewerItem();
}
function updateViewerNeighbors() {
  const { list, index } = state.viewer;
  for (const [direction, offset] of [
    ['prev', -1],
    ['next', 1],
  ]) {
    const button = $('viewer-' + direction);
    const frame = $('viewer-' + direction + '-preview');
    frame.replaceChildren();
    button.disabled = button.hidden = list.length < 2;
    if (list.length < 2) {
      button.removeAttribute('title');
      continue;
    }
    const item = list[(index + offset + list.length) % list.length];
    button.title = `${direction === 'prev' ? 'Previous' : 'Next'}: ${item.filename}`;
    const fallback = document.createElement('span');
    fallback.className = 'viewer-neighbor-fallback';
    fallback.innerHTML = icon(item.type === 'video' ? 'video' : 'image');
    frame.append(fallback);
    if (item.hasThumbnail) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.addEventListener(
        'load',
        () => {
          fallback.hidden = true;
        },
        { once: true },
      );
      image.addEventListener(
        'error',
        () => {
          image.remove();
        },
        { once: true },
      );
      image.src = PhotoModel.thumb(item);
      frame.append(image);
    }
    if (item.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'viewer-neighbor-video';
      badge.innerHTML = icon('play');
      frame.append(badge);
    }
  }
}
function showViewerItem() {
  const p = viewerItem();
  if (!p) return;
  const token = ++state.viewer.token;
  clearTimeout(previewTimer);
  clearTimeout(neighborTimer);
  state.viewer.detailPromise = null;
  state.viewer.full = false;
  photoZoom.reset(p.type !== 'video');
  document.querySelector('.viewer-zoom-controls').hidden = p.type === 'video';
  const image = $('viewer-image'),
    video = $('viewer-video');
  video.pause();
  video.onloadedmetadata = null;
  video.style.cssText = '';
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  image.onload = null;
  image.onerror = null;
  image.hidden = !p.hasThumbnail;
  if (p.hasThumbnail) image.src = PhotoModel.thumb(p);
  else image.removeAttribute('src');
  photoZoom.reserve();
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
  updateViewerNeighbors();
  video.onerror = () => {
    if (state.viewer.token === token)
      viewerError(
        'This video cannot be played here. Choose “Open original” to use your default player.',
      );
  };
  const ready = previewCache.peek(p);
  if (ready) displayPreview(ready, p, token);
  else
    previewTimer = setTimeout(async () => {
      try {
        const preview = await previewCache.load(p);
        if (token !== state.viewer.token || !$('lightbox').open) return;
        displayPreview(preview, p, token);
      } catch (err) {
        if (token === state.viewer.token)
          viewerError(`${err.message}. You can try “Open original”.`);
      }
    }, 90);
}
function displayPreview(preview, item, token) {
  if (state.viewer.full) return;
  if (preview.video) {
    $('viewer-image').hidden = true;
    $('viewer-video').hidden = false;
    fitViewerVideo(item);
    $('viewer-video').poster = preview.image;
    $('viewer-video').onloadedmetadata = () => fitViewerVideo(item);
    $('viewer-video').src = preview.video;
    $('viewer-video').load();
  } else {
    const image = $('viewer-image');
    image.onload = () => {
      if (token !== state.viewer.token) return;
      image.hidden = false;
      photoZoom.activate();
      $('viewer-loading').hidden = true;
    };
    image.onerror = () => {
      if (token === state.viewer.token)
        viewerError('The preview is unavailable. Try opening the original file.');
    };
    image.src = preview.image;
    if (image.complete && image.naturalWidth) image.onload();
  }
  if (preview.video) $('viewer-loading').hidden = true;
  // Sequential, cancellable lookahead: at most one speculative request at a time.
  neighborTimer = setTimeout(() => prefetchNeighbors(token), 250);
}
function fitViewerVideo(item) {
  const video = $('viewer-video');
  const ratio =
    video.videoWidth && video.videoHeight
      ? video.videoWidth / video.videoHeight
      : item.thumbnailWidth && item.thumbnailHeight
        ? item.thumbnailWidth / item.thumbnailHeight
        : 16 / 9;
  const stage = document.querySelector('.viewer-stage');
  if (!stage.clientWidth || !stage.clientHeight || !ratio) return;
  const width = Math.min(stage.clientWidth, stage.clientHeight * ratio);
  const height = width / ratio;
  Object.assign(video.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: `${width}px`,
    height: `${height}px`,
    transform: 'translate(-50%, -50%)',
    objectFit: 'contain',
  });
}
async function prefetchNeighbors(token) {
  if (token !== state.viewer.token || !$('lightbox').open) return;
  if (prefetchBusy) {
    neighborTimer = setTimeout(() => prefetchNeighbors(token), 150);
    return;
  }
  const { list, index } = state.viewer;
  if (list.length < 2) return;
  prefetchBusy = true;
  try {
    const neighbors = new Set([
      list[(index + 1) % list.length],
      list[(index - 1 + list.length) % list.length],
    ]);
    for (const neighbor of neighbors) {
      if (token !== state.viewer.token || !$('lightbox').open) return;
      try {
        await previewCache.load(neighbor, { prefetch: true });
      } catch {
        /* Retry on selection. */
      }
    }
  } finally {
    prefetchBusy = false;
  }
}

async function loadPhotoDetail(actual = false) {
  const item = viewerItem(),
    token = state.viewer.token;
  if (!item || item.type === 'video') return;
  try {
    if (!state.viewer.detailPromise)
      state.viewer.detailPromise = previewCache.load(item, { full: true });
    $('viewer-loading').hidden = false;
    const preview = await state.viewer.detailPromise;
    if (token !== state.viewer.token || !$('lightbox').open) return;
    state.viewer.full = true;
    $('viewer-image').src = preview.image;
    $('viewer-image').hidden = false;
    // decode() waits for the element to adopt the new intrinsic dimensions.
    await $('viewer-image').decode();
    if (token !== state.viewer.token) return;
    if (actual) photoZoom.actualPixels();
    else photoZoom.render();
    $('viewer-loading').hidden = true;
  } catch (err) {
    if (token === state.viewer.token) {
      state.viewer.detailPromise = null;
      viewerError(`Full-resolution photo unavailable: ${err.message}`);
    }
  }
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
  $('timeline-months').addEventListener('click', (event) => {
    const month = event.target.closest('[data-month]')?.dataset.month;
    if (!month) return;
    const [year, number] = month.split('-').map(Number);
    const lastDay = new Date(year, number, 0).getDate();
    state.filters.from = month + '-01';
    state.filters.to = `${month}-${lastDay}`;
    // Keep the date fields inside the library's available dates.
    if (state.filters.from < state.dates.min) state.filters.from = state.dates.min;
    if (state.filters.to > state.dates.max) state.filters.to = state.dates.max;
    updateDates();
    applyFilters();
  });
  $('timeline-months').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...$('timeline-months').querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))
    ]?.focus();
  });
  const galleryOptions = () => {
    gallery.setOptions(Number($('gallery-size').value), $('gallery-layout').value);
    scheduleWorkspace();
  };
  $('gallery-size').addEventListener('input', galleryOptions);
  $('gallery-layout').addEventListener('change', galleryOptions);
  $('viewer-zoom-in').addEventListener('click', () => {
    photoZoom.change(photoZoom.zoom * 1.4);
    loadPhotoDetail();
  });
  $('viewer-zoom-out').addEventListener('click', () => photoZoom.change(photoZoom.zoom / 1.4));
  $('viewer-fit').addEventListener('click', () => photoZoom.fit());
  $('viewer-actual').addEventListener('click', () => loadPhotoDetail(true));
  $('sidebar-toggle').addEventListener('click', () => toggleSidebar());
  $('use-view-dates').addEventListener('click', useViewDates);
  $('area-use-dates').addEventListener('click', useViewDates);
  atlas.map.on('moveend', updateViewDates);
  atlas.map.on('moveend', scheduleWorkspace);
  window.addEventListener('beforeunload', saveWorkspace);
  document.querySelectorAll('[data-map-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      atlas.setMode(button.dataset.mapMode);
      scheduleWorkspace();
      document.querySelectorAll('[data-map-mode]').forEach((option) => {
        const selected = option === button;
        option.classList.toggle('selected', selected);
        option.setAttribute('aria-pressed', String(selected));
      });
    });
  });
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
  $('show-labels').addEventListener('change', (e) => {
    atlas.setLabels(e.target.checked);
    scheduleWorkspace();
  });
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
    scheduleWorkspace();
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
      toggleSidebar(true);
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
  previewCache = new PreviewCache(api);
  photoZoom = new PhotoZoom(
    document.querySelector('.viewer-stage'),
    $('viewer-image'),
    loadPhotoDetail,
  );
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
  const map = workspace.map;
  const restoreMap =
    map &&
    [map.lat, map.lng, map.zoom].every(Number.isFinite) &&
    Math.abs(map.lat) <= 85 &&
    map.zoom >= 2 &&
    map.zoom <= 22;
  if (restoreMap) atlas.map.setView([map.lat, map.lng], map.zoom, { animate: false });
  if (['auto', 'heat', 'bubbles'].includes(workspace.mode))
    document.querySelector(`[data-map-mode="${workspace.mode}"]`).click();
  if (typeof workspace.labels === 'boolean') {
    $('show-labels').checked = workspace.labels;
    atlas.setLabels(workspace.labels);
  }
  toggleSidebar(workspace.sidebar !== false);
  if (['newest', 'oldest', 'name'].includes(workspace.sort))
    state.sort = $('sort-order').value = workspace.sort;
  if (Number.isFinite(workspace.gallerySize))
    $('gallery-size').value = Math.max(150, Math.min(360, workspace.gallerySize));
  if (['grid', 'natural'].includes(workspace.galleryLayout))
    $('gallery-layout').value = workspace.galleryLayout;
  gallery.setOptions(Number($('gallery-size').value), $('gallery-layout').value);
  if (workspace.view === 'gallery') setView('gallery');
  workspaceReady = true;
  const data = await attempt(() => api.getLibrary());
  if (data) {
    snapshot(data, !restoreMap);
    if (state.items.size)
      $('status-text').textContent = 'Library ready · Everything stays on your device';
    if (data.needsRescan && !data.scan) {
      toast('Refreshing older thumbnails in the background. You can keep exploring.');
      await startScan();
    }
  }
}
init().catch((err) => error(err.message));
