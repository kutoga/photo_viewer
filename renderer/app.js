/**
 * Photo Map — Renderer
 *
 * Zoom-adaptive rendering:
 *   zoom < 8   → Heatmap
 *   zoom 8–12  → Cluster bubbles
 *   zoom ≥ 13  → Individual photo/video thumbnails (auto-spread in circles)
 *
 * Features:
 *   - Live map updates as photos are scanned
 *   - Spiderfier for cluster click + auto-spread for overlapping markers
 *   - Lightbox with left/right navigation, video playback
 *   - Collapsible panel, refresh button, labels toggle
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let map;
let markerLayer;
let spiderLayer;
let heatLayer = null;
let labelsLayer = null;

let superclusterIndex = null;
let allPhotos = [];
let heatPoints = [];

let lightboxList = [];
let lightboxIndex = -1;
let sourceDirs = [];

let progressCleanup = null;
let completeCleanup = null;
let errorCleanup = null;
let newItemCleanup = null;
let renderTimer = null;
let mediaFilter = 'all'; // 'all' | 'photo' | 'video'

// ─── Map initialisation ───────────────────────────────────────────────────────

function initMap() {
  map = L.map('map', {
    center: [20, 0],
    zoom: 2,
    zoomControl: false,
    preferCanvas: true,
  });

  // ESRI satellite tiles (free, no API key)
  // maxNativeZoom=19 is where tiles exist; maxZoom=22 lets Leaflet oversample beyond that
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri',
      maxNativeZoom: 19,
      maxZoom: 22,
      detectRetina: true,
      errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWNgAAIABAABAAGpSwAAAABJRU5ErkJggg==',
    }
  ).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  spiderLayer = L.layerGroup().addTo(map);

  map.on('zoomend moveend', () => {
    clearSpider();
    debouncedRender();
  });

  map.on('click', () => {
    if (spiderLayer.getLayers().length > 0) {
      clearSpider();
      renderForZoom(); // Restore the cluster bubble that was hidden
    }
  });
}

// ─── Labels layer toggle ──────────────────────────────────────────────────────

function toggleLabels(show) {
  if (show && !labelsLayer) {
    // ESRI reference overlay with place names, borders, roads
    labelsLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 19, maxZoom: 22, pane: 'overlayPane' }
    );
    labelsLayer.addTo(map);
  } else if (!show && labelsLayer) {
    map.removeLayer(labelsLayer);
    labelsLayer = null;
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function getFilteredPhotos() {
  return allPhotos.filter((p) => {
    if (p.lat === null || p.lng === null) return false;
    if (mediaFilter === 'photo') return p.type !== 'video';
    if (mediaFilter === 'video') return p.type === 'video';
    return true;
  });
}

async function loadPhotosAndRender(fitBounds = true) {
  allPhotos = await window.photoMap.getAllPhotos();

  const gpsPhotos = getFilteredPhotos();

  heatPoints = gpsPhotos.map((p) => [p.lat, p.lng, 1]);
  updatePhotoCount(gpsPhotos.length);
  buildSupercluster(gpsPhotos);

  if (fitBounds && gpsPhotos.length > 0) {
    const latLngs = gpsPhotos.map((p) => [p.lat, p.lng]);
    map.fitBounds(L.latLngBounds(latLngs), { padding: [60, 60], maxZoom: 14 });
  }

  renderForZoom();
}

/**
 * Incrementally add a single new item to the map without full reload.
 */
function addItemLive(entry) {
  if (!entry.lat || !entry.lng || !entry.hasThumbnail) return;

  // Add to our local data
  allPhotos.push(entry);

  // Check if this entry passes the current filter
  const passesFilter = mediaFilter === 'all'
    || (mediaFilter === 'photo' && entry.type !== 'video')
    || (mediaFilter === 'video' && entry.type === 'video');
  if (!passesFilter) return;

  heatPoints.push([entry.lat, entry.lng, 1]);

  // Rebuild the supercluster with the filtered data
  const gpsPhotos = getFilteredPhotos();
  buildSupercluster(gpsPhotos);

  // Re-render current view
  renderForZoom();
}

// ─── Supercluster index ───────────────────────────────────────────────────────

function buildSupercluster(gpsPhotos) {
  const features = gpsPhotos
    .filter((p) => p.hasThumbnail)
    .map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        date: p.date,
        filename: p.filename,
        originalPath: p.originalPath,
        type: p.type || 'photo',
        lat: p.lat,
        lng: p.lng,
      },
    }));

  superclusterIndex = new Supercluster({
    radius: 60,
    maxZoom: 17,
    minPoints: 2,
  });
  superclusterIndex.load(features);
}

// ─── Zoom-level dispatch ──────────────────────────────────────────────────────

function debouncedRender() {
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => {
    renderTimer = null;
    renderForZoom();
  });
}

function renderForZoom() {
  const zoom = map.getZoom();

  if (zoom < 8) {
    showHeatmap();
  } else {
    hideHeatmap();
    renderMarkers();
  }
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

function showHeatmap() {
  markerLayer.clearLayers();

  if (heatPoints.length === 0) return;

  if (heatLayer && map.hasLayer(heatLayer)) {
    map.removeLayer(heatLayer);
  }
  heatLayer = L.heatLayer(heatPoints, {
    radius: 28,
    blur: 20,
    maxZoom: 8,
    gradient: { 0.35: '#1e40af', 0.6: '#7c3aed', 0.85: '#db2777', 1.0: '#ef4444' },
  });
  heatLayer.addTo(map);
}

function hideHeatmap() {
  if (heatLayer && map.hasLayer(heatLayer)) {
    map.removeLayer(heatLayer);
  }
}

// ─── Unified marker rendering (zoom ≥ 8) ──────────────────────────────────────

function renderMarkers() {
  markerLayer.clearLayers();
  if (!superclusterIndex) return;

  const bounds = map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  const zoom = Math.floor(map.getZoom());
  const clusters = superclusterIndex.getClusters(bbox, zoom);

  lightboxList = [];
  const photoSize = zoom >= 13 ? 56 : 38;

  const singles = [];

  for (const cluster of clusters) {
    const [lng, lat] = cluster.geometry.coordinates;
    const props = cluster.properties;

    if (props.cluster) {
      renderClusterBubble(lat, lng, props.point_count, props.cluster_id);
    } else {
      singles.push({ lat, lng, props });
    }
  }

  // Find overlapping groups via Union-Find then render
  renderGroupedSingles(singles, photoSize);
}

/**
 * Group nearby markers via Union-Find, render solo ones as individual markers
 * and overlapping groups as a single DivIcon overlay with CSS-positioned thumbs.
 */
function renderGroupedSingles(singles, markerSize) {
  if (singles.length === 0) return;

  const threshold = markerSize * 0.9;
  const pixels = singles.map((s) => map.latLngToContainerPoint([s.lat, s.lng]));

  // Union-Find for transitive grouping
  const parent = singles.map((_, i) => i);
  function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const dx = pixels[i].x - pixels[j].x;
      const dy = pixels[i].y - pixels[j].y;
      if (dx * dx + dy * dy < threshold * threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < singles.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  for (const members of groups.values()) {
    if (members.length === 1) {
      const s = singles[members[0]];
      lightboxList.push(s.props);
      renderSingleMarker(s.lat, s.lng, s.props, markerSize);
    } else {
      // Centroid lat/lng for the overlay position
      let latSum = 0, lngSum = 0;
      const groupProps = [];
      for (const idx of members) {
        latSum += singles[idx].lat;
        lngSum += singles[idx].lng;
        groupProps.push(singles[idx].props);
        lightboxList.push(singles[idx].props);
      }
      renderOverlapOverlay(latSum / members.length, lngSum / members.length, groupProps, markerSize);
    }
  }
}

/**
 * Render an overlapping group as a single DivIcon with thumbnails on concentric circles.
 */
function renderOverlapOverlay(centerLat, centerLng, groupProps, markerSize) {
  const count = groupProps.length;
  const gap = 8;
  const slot = markerSize + gap;

  const firstRadius = markerSize * 0.75;
  const ringSpacing = slot;
  const rings = [];
  let remaining = count;
  let ringRadius = firstRadius;

  while (remaining > 0) {
    const capacity = Math.max(1, Math.floor((2 * Math.PI * ringRadius) / slot));
    const n = Math.min(capacity, remaining);
    rings.push({ radius: ringRadius, count: n });
    remaining -= n;
    ringRadius += ringSpacing;
  }

  const maxR = rings[rings.length - 1].radius + markerSize;
  const containerSize = maxR * 2;
  const cx = maxR;
  const cy = maxR;

  let html = '';
  let idx = 0;

  for (const ring of rings) {
    const angleStep = (2 * Math.PI) / ring.count;
    for (let k = 0; k < ring.count; k++) {
      const angle = angleStep * k - Math.PI / 2;
      const left = Math.round(cx + Math.cos(angle) * ring.radius - markerSize / 2);
      const top  = Math.round(cy + Math.sin(angle) * ring.radius - markerSize / 2);

      const props = groupProps[idx];
      const thumbUrl = `cache://thumbnails/${props.id}_thumb.jpg`;
      const isVideo = props.type === 'video';

      html += `<div class="photo-marker overlap-thumb" data-id="${props.id}" style="position:absolute;left:${left}px;top:${top}px;width:${markerSize}px;height:${markerSize}px;cursor:pointer">` +
        `<img src="${thumbUrl}" alt="" style="width:${markerSize}px;height:${markerSize}px" loading="lazy" />` +
        (isVideo ? '<div class="video-badge">&#9654;</div>' : '') +
        '</div>';
      idx++;
    }
  }

  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${containerSize}px;height:${containerSize}px">${html}</div>`,
    iconSize: [containerSize, containerSize],
    iconAnchor: [cx, cy],
  });

  const marker = L.marker([centerLat, centerLng], { icon });
  marker.on('click', (e) => {
    const thumb = e.originalEvent.target.closest('.overlap-thumb');
    if (!thumb) return;
    const id = thumb.dataset.id;
    const lbIdx = lightboxList.findIndex((p) => p.id === id);
    lightboxIndex = lbIdx >= 0 ? lbIdx : 0;
    openLightboxAt(lightboxIndex);
  });
  markerLayer.addLayer(marker);
}

// ─── Cluster bubble ───────────────────────────────────────────────────────────

function renderClusterBubble(lat, lng, count, clusterId) {
  const size = Math.round(Math.min(28 + Math.log(count) * 7, 64));
  const fontSize = size < 38 ? 11 : 13;

  const icon = L.divIcon({
    className: '',
    html: `<div class="cluster-marker" style="width:${size}px;height:${size}px;font-size:${fontSize}px">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

  const marker = L.marker([lat, lng], { icon, zIndexOffset: 10 });

  marker.on('click', () => {
    spiderfyCluster(lat, lng, clusterId, marker);
  });

  markerLayer.addLayer(marker);
}

// ─── Spiderfier ───────────────────────────────────────────────────────────────

function clearSpider() {
  spiderLayer.clearLayers();
}

function spiderfyCluster(centerLat, centerLng, clusterId, clusterMarker) {
  clearSpider();

  // Hide the cluster bubble that was clicked
  if (clusterMarker) {
    markerLayer.removeLayer(clusterMarker);
  }

  const leaves = superclusterIndex.getLeaves(clusterId, Infinity);
  if (leaves.length === 0) return;

  const spiderPhotos = leaves.map((l) => l.properties);
  const count = leaves.length;
  const thumbSize = 52;
  const gap = 14;
  const slot = thumbSize + gap;

  // Build concentric rings: fill smallest ring first, then larger ones
  const firstRadius = 55;
  const ringSpacing = slot;
  const rings = [];
  let remaining = count;
  let ringRadius = firstRadius;

  while (remaining > 0) {
    const capacity = Math.max(1, Math.floor((2 * Math.PI * ringRadius) / slot));
    const n = Math.min(capacity, remaining);
    rings.push({ radius: ringRadius, count: n });
    remaining -= n;
    ringRadius += ringSpacing;
  }

  // Build a single DivIcon overlay with all thumbnails positioned absolutely
  // inside it. Pure CSS pixel positioning = guaranteed perfect circles.
  const maxR = rings[rings.length - 1].radius + thumbSize;
  const containerSize = maxR * 2;
  const cx = maxR; // center x within the container
  const cy = maxR; // center y within the container

  let thumbsHtml = '';
  let itemIdx = 0;

  for (const ring of rings) {
    const angleStep = (2 * Math.PI) / ring.count;

    for (let k = 0; k < ring.count; k++) {
      const angle = angleStep * k - Math.PI / 2;
      const left = Math.round(cx + Math.cos(angle) * ring.radius - thumbSize / 2);
      const top  = Math.round(cy + Math.sin(angle) * ring.radius - thumbSize / 2);

      const props = leaves[itemIdx].properties;
      const thumbUrl = `cache://thumbnails/${props.id}_thumb.jpg`;
      const isVideo = props.type === 'video';

      thumbsHtml += `<div class="photo-marker spider-marker spider-thumb" data-idx="${itemIdx}" style="position:absolute;left:${left}px;top:${top}px;width:${thumbSize}px;height:${thumbSize}px;cursor:pointer">` +
        `<img src="${thumbUrl}" alt="" style="width:${thumbSize}px;height:${thumbSize}px" />` +
        (isVideo ? '<div class="video-badge">&#9654;</div>' : '') +
        '</div>';

      itemIdx++;
    }
  }

  const icon = L.divIcon({
    className: 'spider-container',
    html: `<div style="position:relative;width:${containerSize}px;height:${containerSize}px">${thumbsHtml}</div>`,
    iconSize: [containerSize, containerSize],
    iconAnchor: [cx, cy],
  });

  const overlay = L.marker([centerLat, centerLng], { icon, zIndexOffset: 1000, bubblingMouseEvents: false });
  spiderLayer.addLayer(overlay);

  // Event delegation: clicks on thumbnails open lightbox, clicks on empty space close spider
  overlay.on('click', (e) => {
    const thumb = e.originalEvent.target.closest('.spider-thumb');
    if (thumb) {
      const idx = parseInt(thumb.dataset.idx, 10);
      lightboxList = spiderPhotos;
      lightboxIndex = idx;
      openLightboxAt(idx);
    } else {
      clearSpider();
      renderForZoom();
    }
  });
}

// ─── Single photo/video marker ────────────────────────────────────────────────

function renderSingleMarker(lat, lng, props, size) {
  const thumbUrl = `cache://thumbnails/${props.id}_thumb.jpg`;
  const isVideo = props.type === 'video';

  const icon = L.divIcon({
    className: 'photo-marker',
    html: `<img src="${thumbUrl}" alt="" style="width:${size}px;height:${size}px" loading="lazy" />${isVideo ? '<div class="video-badge">&#9654;</div>' : ''}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

  const marker = L.marker([lat, lng], { icon });

  marker.on('click', () => {
    const idx = lightboxList.findIndex((p) => p.id === props.id);
    lightboxIndex = idx >= 0 ? idx : 0;
    openLightboxAt(lightboxIndex);
  });

  markerLayer.addLayer(marker);
}

// ─── Lightbox with video support ──────────────────────────────────────────────

async function openLightboxAt(index) {
  if (index < 0 || index >= lightboxList.length) return;
  lightboxIndex = index;

  const props = lightboxList[lightboxIndex];
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const vid = document.getElementById('lightbox-video');
  const dateEl = document.getElementById('lightbox-date');
  const coordsEl = document.getElementById('lightbox-coords');
  const fileEl = document.getElementById('lightbox-filepath');
  const counterEl = document.getElementById('lightbox-counter');

  const previewUrl = await window.photoMap.getPreviewPath(props.id);
  if (lightboxList[lightboxIndex]?.id !== props.id) return; // navigated away

  const isVideo = props.type === 'video';
  const isFirstOpen = lb.classList.contains('hidden');
  const playBtn = document.getElementById('lightbox-play');

  // Always stop any playing video first
  vid.pause();
  vid.src = '';
  vid.classList.add('hidden');
  playBtn.classList.add('hidden');
  playBtn.onclick = null;

  if (isVideo) {
    // Show the preview frame image with a play button overlay
    img.classList.remove('hidden');
    const frameUrl = `cache://previews/${props.id}_preview.jpg`;
    if (isFirstOpen) {
      img.src = `cache://thumbnails/${props.id}_thumb.jpg`;
    }
    const preload = new Image();
    preload.onload = () => {
      if (lightboxList[lightboxIndex]?.id === props.id) {
        img.src = frameUrl;
      }
    };
    preload.src = frameUrl;

    playBtn.classList.remove('hidden');
    playBtn.onclick = () => {
      img.classList.add('hidden');
      playBtn.classList.add('hidden');
      vid.classList.remove('hidden');
      vid.src = previewUrl; // file:// URL to original video
      vid.load();
      vid.play();
    };
  } else {
    img.classList.remove('hidden');

    // Preload the high-res preview in the background.
    // On first open: show thumbnail as fast placeholder.
    // On navigation: keep the current image visible (no flicker).
    if (isFirstOpen) {
      img.src = `cache://thumbnails/${props.id}_thumb.jpg`;
    }
    const preload = new Image();
    preload.onload = () => {
      if (lightboxList[lightboxIndex]?.id === props.id) {
        img.src = previewUrl;
      }
    };
    preload.src = previewUrl;
  }

  if (props.date) {
    const d = new Date(props.date);
    dateEl.textContent = d.toLocaleDateString(undefined, { dateStyle: 'long' })
      + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else {
    dateEl.textContent = '';
  }

  // Coordinates → clickable link to Google Maps
  if (props.lat != null && props.lng != null) {
    const latStr = props.lat.toFixed(6);
    const lngStr = props.lng.toFixed(6);
    coordsEl.textContent = `${latStr}, ${lngStr}`;
    coordsEl.title = 'Open in Google Maps';
    coordsEl.onclick = () => {
      window.photoMap.openExternal(`https://www.google.com/maps?q=${latStr},${lngStr}`);
    };
  } else {
    coordsEl.textContent = '';
    coordsEl.onclick = null;
  }

  // File path → clickable link to reveal in file explorer
  if (props.originalPath) {
    fileEl.textContent = props.originalPath;
    fileEl.title = 'Show in file explorer';
    fileEl.onclick = () => {
      window.photoMap.showItemInFolder(props.originalPath);
    };
  } else {
    fileEl.textContent = '';
    fileEl.onclick = null;
  }

  if (lightboxList.length > 1) {
    counterEl.textContent = `${lightboxIndex + 1} / ${lightboxList.length}`;
    counterEl.classList.remove('hidden');
  } else {
    counterEl.classList.add('hidden');
  }

  document.getElementById('lightbox-prev').classList.toggle('hidden', lightboxList.length <= 1);
  document.getElementById('lightbox-next').classList.toggle('hidden', lightboxList.length <= 1);

  lb.classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
  const vid = document.getElementById('lightbox-video');
  vid.pause();
  vid.src = '';
  vid.classList.add('hidden');
  document.getElementById('lightbox-play').classList.add('hidden');
  lightboxIndex = -1;
}

function lightboxPrev() {
  if (lightboxList.length === 0) return;
  lightboxIndex = (lightboxIndex - 1 + lightboxList.length) % lightboxList.length;
  openLightboxAt(lightboxIndex);
}

function lightboxNext() {
  if (lightboxList.length === 0) return;
  lightboxIndex = (lightboxIndex + 1) % lightboxList.length;
  openLightboxAt(lightboxIndex);
}

function isLightboxOpen() {
  return !document.getElementById('lightbox').classList.contains('hidden');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function updatePhotoCount(count) {
  const el = document.getElementById('photo-count');
  if (count === 0) {
    el.textContent = 'No geotagged media found';
  } else {
    el.textContent = `${count.toLocaleString()} geotagged item${count !== 1 ? 's' : ''}`;
  }
}

function shortenPath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length > 2) return '\u2026/' + parts.slice(-2).join('/');
  return p;
}

function renderFolderList() {
  const list = document.getElementById('folders-list');
  list.innerHTML = '';

  for (const dir of sourceDirs) {
    const item = document.createElement('div');
    item.className = 'folder-item';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'folder-path';
    pathSpan.textContent = shortenPath(dir);
    pathSpan.title = dir;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'folder-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove folder';
    removeBtn.addEventListener('click', () => removeFolderUI(dir));

    item.appendChild(pathSpan);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }

  document.getElementById('refresh-btn').classList.toggle('hidden', sourceDirs.length === 0);
}

// ─── Folder management ───────────────────────────────────────────────────────

async function addFolderUI() {
  const dirPath = await window.photoMap.openDirectory();
  if (!dirPath) return;
  sourceDirs = await window.photoMap.addDir(dirPath);
  renderFolderList();
  startScanUI();
}

async function removeFolderUI(dirPath) {
  sourceDirs = await window.photoMap.removeDir(dirPath);
  renderFolderList();
  await loadPhotosAndRender(false);
}

async function refreshScan() {
  if (sourceDirs.length === 0) return;
  startScanUI();
}

// ─── Scan flow ────────────────────────────────────────────────────────────────

function cleanupScanListeners() {
  if (progressCleanup) { progressCleanup(); progressCleanup = null; }
  if (completeCleanup) { completeCleanup(); completeCleanup = null; }
  if (errorCleanup)    { errorCleanup(); errorCleanup = null; }
  if (newItemCleanup)  { newItemCleanup(); newItemCleanup = null; }
}

function startScanUI() {
  cleanupScanListeners();

  const progressSection = document.getElementById('progress-section');
  const progressFill    = document.getElementById('progress-fill');
  const progressLabel   = document.getElementById('progress-label');

  progressSection.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Checking for changes\u2026';

  progressCleanup = window.photoMap.onScanProgress((data) => {
    const pct = data.total > 0 ? (data.processed / data.total) * 100 : 0;
    progressFill.style.width = `${pct.toFixed(1)}%`;

    if (data.phase === 'cleanup') {
      progressLabel.textContent = 'Cleaning removed files\u2026';
    } else if (data.phase === 'indexing') {
      progressLabel.textContent = 'Indexing files\u2026';
    } else {
      progressLabel.textContent =
        `${data.processed.toLocaleString()} / ${data.total.toLocaleString()} \u2014 ${data.currentFile}`;
    }
    updatePhotoCount(data.withGPS);
  });

  newItemCleanup = window.photoMap.onScanNewItem((entry) => {
    addItemLive(entry);
  });

  completeCleanup = window.photoMap.onScanComplete(async () => {
    progressSection.classList.add('hidden');
    await loadPhotosAndRender(false);
  });

  errorCleanup = window.photoMap.onScanError((msg) => {
    progressSection.classList.add('hidden');
    progressLabel.textContent = `Error: ${msg}`;
  });

  window.photoMap.startScan();
}

// ─── Panel collapse ──────────────────────────────────────────────────────────

function togglePanel() {
  const body = document.getElementById('panel-body');
  const btn = document.getElementById('panel-toggle');
  const collapsed = body.classList.toggle('hidden');
  btn.innerHTML = collapsed ? '&#x2b;' : '&#x2212;';
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
}

// ─── Entry point ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initMap();

  // Wire up controls
  document.getElementById('add-folder-btn').addEventListener('click', addFolderUI);
  document.getElementById('refresh-btn').addEventListener('click', refreshScan);
  document.getElementById('panel-toggle').addEventListener('click', togglePanel);

  // Labels toggle
  document.getElementById('labels-check').addEventListener('change', (e) => {
    toggleLabels(e.target.checked);
  });

  // Media filter
  document.getElementById('media-filter').addEventListener('change', (e) => {
    mediaFilter = e.target.value;
    const gpsPhotos = getFilteredPhotos();
    heatPoints = gpsPhotos.map((p) => [p.lat, p.lng, 1]);
    updatePhotoCount(gpsPhotos.length);
    buildSupercluster(gpsPhotos);
    renderForZoom();
  });

  // Lightbox controls
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxPrev();
  });
  document.getElementById('lightbox-next').addEventListener('click', (e) => {
    e.stopPropagation();
    lightboxNext();
  });

  document.addEventListener('keydown', (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNext(); }
  });

  // Load configured folders and cached data
  sourceDirs = await window.photoMap.getDirs();
  renderFolderList();
  await loadPhotosAndRender();
});
