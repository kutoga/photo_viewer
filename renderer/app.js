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

// Date range filter (timestamps in ms, null = no restriction)
let dateSliderMin = null;   // overall min date across all photos
let dateSliderMax = null;   // overall max date across all photos
let dateFilterMin = null;   // user-selected min
let dateFilterMax = null;   // user-selected max

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
  // keepBuffer=8 retains lower-zoom tiles so they show through when error tiles are hidden
  const esriTiles = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri',
      maxNativeZoom: 19,
      maxZoom: 22,
      detectRetina: true,
      keepBuffer: 8,
      crossOrigin: 'anonymous',
      errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWNgAAIABAABAAGpSwAAAABJRU5ErkJggg==',
    }
  );

  // ESRI returns HTTP 200 with a placeholder image ("Map data not available")
  // instead of 404 when tiles don't exist. Detect these by sampling pixel color
  // and hide them so the lower-zoom tile (kept via keepBuffer) shows through.
  esriTiles.on('tileload', (e) => {
    try {
      const img = e.tile;
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 4;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 4, 4);
      const d = ctx.getImageData(0, 0, 4, 4).data;
      // ESRI error tiles are uniform beige/tan ~(226, 220, 207).
      // Check first pixel for that color range AND low variance across samples.
      const r0 = d[0], g0 = d[1], b0 = d[2];
      if (r0 > 200 && g0 > 190 && b0 > 170 && r0 - b0 > 10 && r0 - b0 < 40) {
        let maxDiff = 0;
        for (let i = 4; i < d.length; i += 4) {
          maxDiff = Math.max(maxDiff, Math.abs(d[i] - r0), Math.abs(d[i+1] - g0), Math.abs(d[i+2] - b0));
        }
        if (maxDiff < 15) {
          img.style.opacity = '0';
        }
      }
    } catch (_) { /* CORS or canvas error — ignore */ }
  });

  esriTiles.addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  spiderLayer = L.layerGroup().addTo(map);

  map.on('zoomend', () => {
    clearSpider();
    debouncedRender();
  });

  map.on('moveend', () => {
    // Don't clear spider on pan — it stays positioned correctly as a marker.
    // Only zoom changes and explicit map clicks should close it.
    debouncedRender();
  });

  map.on('click', () => {
    if (spiderLayer.getLayers().length > 0) {
      clearSpider();
      renderForZoom(); // Restore the cluster bubble that was hidden
    }
  });

  // Labels on by default (matches the checked checkbox)
  toggleLabels(true);
}

// ─── Labels layer toggle ──────────────────────────────────────────────────────

function toggleLabels(show) {
  if (show && !labelsLayer) {
    // Two ESRI reference overlays: streets/roads + place names/borders
    const opts = { maxNativeZoom: 19, maxZoom: 22, pane: 'overlayPane' };
    labelsLayer = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', opts),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', opts),
    ]);
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
    if (mediaFilter === 'photo' && p.type === 'video') return false;
    if (mediaFilter === 'video' && p.type !== 'video') return false;
    // Date range filter
    if (dateFilterMin != null && dateFilterMax != null && p.date) {
      const ts = new Date(p.date).getTime();
      if (ts < dateFilterMin || ts > dateFilterMax) return false;
    }
    return true;
  });
}

async function loadPhotosAndRender(fitBounds = true) {
  allPhotos = await window.photoMap.getAllPhotos();

  initDateSlider();

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
  if (!superclusterIndex) { markerLayer.clearLayers(); return; }

  // Double-buffer: build markers into a fresh layer, then swap.
  // Old markers stay visible until new ones are in the DOM → no flicker.
  const oldLayer = markerLayer;
  markerLayer = L.layerGroup().addTo(map);

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

  // Sort lightbox navigation by date
  lightboxList.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Remove old layer now that new markers are in the DOM
  oldLayer.clearLayers();
  map.removeLayer(oldLayer);
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
    html: `<div style="position:relative;width:${containerSize}px;height:${containerSize}px;pointer-events:none">${html}</div>`,
    iconSize: [containerSize, containerSize],
    iconAnchor: [cx, cy],
  });

  const marker = L.marker([centerLat, centerLng], { icon });
  markerLayer.addLayer(marker);

  // Set pointer-events:none on the Leaflet wrapper so clicks pass through gaps
  // between thumbnails to reach markers from other overlap groups underneath.
  // Individual thumbnails get pointer-events:auto so they remain clickable.
  const el = marker.getElement();
  if (el) {
    el.style.pointerEvents = 'none';
    el.querySelectorAll('.overlap-thumb').forEach((thumb) => {
      thumb.style.pointerEvents = 'auto';
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = thumb.dataset.id;
        const lbIdx = lightboxList.findIndex((p) => p.id === id);
        if (lbIdx >= 0) openLightboxAt(lbIdx);
      });
    });
  }
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

  const spiderPhotos = leaves.map((l) => l.properties)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
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

      const props = spiderPhotos[itemIdx];
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
    html: `<div style="position:relative;width:${containerSize}px;height:${containerSize}px;pointer-events:none">${thumbsHtml}</div>`,
    iconSize: [containerSize, containerSize],
    iconAnchor: [cx, cy],
  });

  const overlay = L.marker([centerLat, centerLng], { icon, zIndexOffset: 1000 });
  spiderLayer.addLayer(overlay);

  // Attach click listeners directly to each thumbnail DOM element.
  // The container has pointer-events:none so gaps between thumbnails
  // pass through to the map, which closes the spider naturally.
  const container = overlay.getElement();
  if (container) {
    container.style.pointerEvents = 'none';
    container.querySelectorAll('.spider-thumb').forEach((el) => {
      el.style.pointerEvents = 'auto';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.idx, 10);
        lightboxList = spiderPhotos;
        lightboxIndex = idx;
        openLightboxAt(idx);
      });
    });
  }
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
  const playBtn = document.getElementById('lightbox-play');
  const isVideo = props.type === 'video';
  const isAlreadyOpen = !lb.classList.contains('hidden');

  // ── Synchronous: show lightbox immediately with thumbnail ──────────────
  // Must happen BEFORE any await, otherwise debouncedRender() can rebuild
  // lightboxList during the yield, causing the guard check to silently abort.

  vid.pause();
  vid.src = '';
  vid.classList.add('hidden');
  playBtn.classList.add('hidden');
  playBtn.onclick = null;

  img.classList.remove('hidden');

  // When navigating (lightbox already open), keep the old image visible
  // while the new preview loads to avoid a flash of the tiny thumbnail.
  if (!isAlreadyOpen) {
    img.src = `cache://thumbnails/${props.id}_thumb.jpg`;
  }

  if (props.date) {
    const d = new Date(props.date);
    dateEl.textContent = d.toLocaleDateString(undefined, { dateStyle: 'long' })
      + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else {
    dateEl.textContent = '';
  }

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

  // ── Async: load high-res preview and swap it in ────────────────────────

  const previewUrl = await window.photoMap.getPreviewPath(props.id);
  if (lightboxList[lightboxIndex]?.id !== props.id) return; // user navigated away

  if (isVideo) {
    const frameUrl = `cache://previews/${props.id}_preview.jpg`;
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
      vid.src = previewUrl;
      vid.load();
      vid.play();
    };
  } else {
    const preload = new Image();
    preload.onload = () => {
      if (lightboxList[lightboxIndex]?.id === props.id) {
        img.src = previewUrl;
      }
    };
    preload.src = previewUrl;
  }
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

// ─── Gallery overlay ──────────────────────────────────────────────────────────

let galleryPhotos = [];

function isGalleryOpen() {
  return !document.getElementById('gallery').classList.contains('hidden');
}

/**
 * Collect all individual photos visible in the current map viewport.
 * Expands clusters so every leaf photo is included.
 */
function getViewportPhotos() {
  if (!superclusterIndex) return [];

  const bounds = map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  const zoom = Math.floor(map.getZoom());
  const clusters = superclusterIndex.getClusters(bbox, zoom);

  const photos = [];
  for (const c of clusters) {
    const props = c.properties;
    if (props.cluster) {
      const leaves = superclusterIndex.getLeaves(props.cluster_id, Infinity);
      for (const leaf of leaves) photos.push(leaf.properties);
    } else {
      photos.push(props);
    }
  }

  photos.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return photos;
}

function openGallery() {
  galleryPhotos = getViewportPhotos();
  if (galleryPhotos.length === 0) return;

  const grid = document.getElementById('gallery-grid');
  const countEl = document.getElementById('gallery-count');
  countEl.textContent = `${galleryPhotos.length.toLocaleString()} photo${galleryPhotos.length !== 1 ? 's' : ''} in view`;

  let html = '';
  for (let i = 0; i < galleryPhotos.length; i++) {
    const p = galleryPhotos[i];
    const thumbUrl = `cache://thumbnails/${p.id}_thumb.jpg`;
    const isVideo = p.type === 'video';

    let dateLabel = '';
    if (p.date) {
      const d = new Date(p.date);
      dateLabel = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    html += `<div class="gallery-item" data-idx="${i}">` +
      `<img src="${thumbUrl}" alt="" loading="lazy" />` +
      (isVideo ? '<div class="gallery-video-badge">&#9654;</div>' : '') +
      (dateLabel ? `<div class="gallery-date">${dateLabel}</div>` : '') +
      '</div>';
  }

  grid.innerHTML = html;
  grid.scrollTop = 0;

  // Attach click handlers
  grid.querySelectorAll('.gallery-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      lightboxList = galleryPhotos;
      lightboxIndex = idx;
      openLightboxAt(idx);
    });
  });

  document.getElementById('gallery').classList.remove('hidden');
}

function closeGallery() {
  document.getElementById('gallery').classList.add('hidden');
  document.getElementById('gallery-grid').innerHTML = '';
  galleryPhotos = [];
}

// ─── Help overlay ─────────────────────────────────────────────────────────────

function isHelpOpen() {
  return !document.getElementById('help').classList.contains('hidden');
}

function openHelp() {
  document.getElementById('help').classList.remove('hidden');
}

function closeHelp() {
  document.getElementById('help').classList.add('hidden');
}

// ─── Date range slider ───────────────────────────────────────────────────────

let calTarget = null;   // 'min' | 'max' | null
let calViewDate = null;  // Date object for the currently displayed month

function initDateSlider() {
  const slider = document.getElementById('date-slider');
  const minInput = document.getElementById('date-range-min');
  const maxInput = document.getElementById('date-range-max');

  // Collect all dates from geotagged photos (regardless of media filter)
  const dates = allPhotos
    .filter((p) => p.lat != null && p.lng != null && p.date)
    .map((p) => new Date(p.date).getTime())
    .filter((t) => !isNaN(t));

  if (dates.length < 2) {
    slider.classList.add('hidden');
    dateSliderMin = null;
    dateSliderMax = null;
    dateFilterMin = null;
    dateFilterMax = null;
    return;
  }

  dateSliderMin = Math.min(...dates);
  dateSliderMax = Math.max(...dates);

  // Preserve user selection if it's still within new bounds, otherwise reset
  if (dateFilterMin == null || dateFilterMin < dateSliderMin) dateFilterMin = dateSliderMin;
  if (dateFilterMax == null || dateFilterMax > dateSliderMax) dateFilterMax = dateSliderMax;

  minInput.min = dateSliderMin;
  minInput.max = dateSliderMax;
  minInput.value = dateFilterMin;

  maxInput.min = dateSliderMin;
  maxInput.max = dateSliderMax;
  maxInput.value = dateFilterMax;

  updateDateSliderUI();
  slider.classList.remove('hidden');
}

function updateDateSliderUI() {
  const minLabel = document.getElementById('date-label-min');
  const maxLabel = document.getElementById('date-label-max');
  const fill = document.getElementById('date-track-fill');
  const resetBtn = document.getElementById('date-reset-btn');

  minLabel.textContent = formatSliderDate(dateFilterMin);
  maxLabel.textContent = formatSliderDate(dateFilterMax);

  // Enable reset button only when range is narrowed
  const isNarrowed = dateFilterMin > dateSliderMin || dateFilterMax < dateSliderMax;
  resetBtn.disabled = !isNarrowed;

  // Position the blue fill bar between the two thumbs
  const range = dateSliderMax - dateSliderMin;
  if (range > 0) {
    const leftPct = ((dateFilterMin - dateSliderMin) / range) * 100;
    const rightPct = ((dateSliderMax - dateFilterMax) / range) * 100;
    fill.style.left = leftPct + '%';
    fill.style.right = rightPct + '%';
  }
}

function formatSliderDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function onDateSliderChange() {
  const minInput = document.getElementById('date-range-min');
  const maxInput = document.getElementById('date-range-max');

  let minVal = parseInt(minInput.value, 10);
  let maxVal = parseInt(maxInput.value, 10);

  // Prevent handles from crossing
  if (minVal > maxVal) {
    minVal = maxVal;
    minInput.value = minVal;
  }

  dateFilterMin = minVal;
  dateFilterMax = maxVal;
  updateDateSliderUI();
  applyDateFilter();
}

function applyDateFilter() {
  const gpsPhotos = getFilteredPhotos();
  heatPoints = gpsPhotos.map((p) => [p.lat, p.lng, 1]);
  updatePhotoCount(gpsPhotos.length);
  buildSupercluster(gpsPhotos);
  renderForZoom();
}

function resetDateFilter() {
  if (dateSliderMin == null) return;
  dateFilterMin = dateSliderMin;
  dateFilterMax = dateSliderMax;

  document.getElementById('date-range-min').value = dateFilterMin;
  document.getElementById('date-range-max').value = dateFilterMax;
  updateDateSliderUI();
  applyDateFilter();
  closeCalendar();
}

// ─── Calendar popup ──────────────────────────────────────────────────────────

function openCalendar(target) {
  const popup = document.getElementById('cal-popup');
  const pillMin = document.getElementById('date-pill-min');
  const pillMax = document.getElementById('date-pill-max');

  // Toggle off if same target clicked again
  if (calTarget === target && !popup.classList.contains('hidden')) {
    closeCalendar();
    return;
  }

  calTarget = target;
  pillMin.classList.toggle('active', target === 'min');
  pillMax.classList.toggle('active', target === 'max');

  // Start calendar on the month of the currently selected date
  const ts = target === 'min' ? dateFilterMin : dateFilterMax;
  calViewDate = new Date(ts);
  calViewDate.setDate(1);

  renderCalendar();

  // Position the popup above the pill
  const pill = target === 'min' ? pillMin : pillMax;
  const rect = pill.getBoundingClientRect();
  popup.classList.remove('hidden');

  const popupW = popup.offsetWidth;
  let left = rect.left + rect.width / 2 - popupW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
  popup.style.left = left + 'px';
  popup.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  popup.style.top = 'auto';
}

function closeCalendar() {
  document.getElementById('cal-popup').classList.add('hidden');
  document.getElementById('date-pill-min').classList.remove('active');
  document.getElementById('date-pill-max').classList.remove('active');
  calTarget = null;
}

function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');

  const year = calViewDate.getFullYear();
  const month = calViewDate.getMonth();
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  title.textContent = `${monthNames[month]} ${year}`;

  // First day of month and how many days
  const firstDay = new Date(year, month, 1);
  let startWeekday = firstDay.getDay() - 1; // Monday=0
  if (startWeekday < 0) startWeekday = 6;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Previous month fill
  const daysInPrev = new Date(year, month, 0).getDate();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;

  // Selected dates as day boundaries
  const selMin = new Date(dateFilterMin);
  const selMax = new Date(dateFilterMax);
  const rangeMinDay = new Date(dateSliderMin);
  const rangeMaxDay = new Date(dateSliderMax);

  let html = '';

  // Previous month days
  for (let i = startWeekday - 1; i >= 0; i--) {
    const day = daysInPrev - i;
    const d = new Date(year, month - 1, day);
    const cls = getDayClasses(d, selMin, selMax, rangeMinDay, rangeMaxDay, todayStr);
    html += `<button class="cal-day other-month ${cls}" data-ts="${d.getTime()}">${day}</button>`;
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const cls = getDayClasses(d, selMin, selMax, rangeMinDay, rangeMaxDay, todayStr);
    html += `<button class="cal-day ${cls}" data-ts="${d.getTime()}">${day}</button>`;
  }

  // Next month fill to complete the grid (6 rows max)
  const totalCells = startWeekday + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let day = 1; day <= remaining; day++) {
    const d = new Date(year, month + 1, day);
    const cls = getDayClasses(d, selMin, selMax, rangeMinDay, rangeMaxDay, todayStr);
    html += `<button class="cal-day other-month ${cls}" data-ts="${d.getTime()}">${day}</button>`;
  }

  grid.innerHTML = html;
}

function getDayClasses(d, selMin, selMax, rangeMin, rangeMax, todayStr) {
  const cls = [];
  const dayStr = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  if (dayStr === todayStr) cls.push('today');

  // Disable days outside the photo date range
  if (d < startOfDay(rangeMin) || d > endOfDay(rangeMax)) {
    cls.push('disabled');
    return cls.join(' ');
  }

  // Check if this day is the selected start or end date
  if (sameDay(d, selMin) || sameDay(d, selMax)) cls.push('selected');
  else if (d >= startOfDay(selMin) && d <= endOfDay(selMax)) cls.push('in-range');

  return cls.join(' ');
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function onCalendarDayClick(ts) {
  if (!calTarget) return;

  // Set the filter to the start or end of the clicked day
  if (calTarget === 'min') {
    const d = new Date(ts);
    dateFilterMin = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (dateFilterMin > dateFilterMax) dateFilterMin = dateFilterMax;
    document.getElementById('date-range-min').value = dateFilterMin;
  } else {
    const d = new Date(ts);
    dateFilterMax = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
    if (dateFilterMax < dateFilterMin) dateFilterMax = dateFilterMin;
    document.getElementById('date-range-max').value = dateFilterMax;
  }

  updateDateSliderUI();
  applyDateFilter();
  renderCalendar(); // refresh highlights
}

function calPrevMonth() {
  calViewDate.setMonth(calViewDate.getMonth() - 1);
  renderCalendar();
}

function calNextMonth() {
  calViewDate.setMonth(calViewDate.getMonth() + 1);
  renderCalendar();
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

  // Help
  document.getElementById('help-btn').addEventListener('click', openHelp);
  document.getElementById('help-close').addEventListener('click', closeHelp);
  document.getElementById('help-backdrop').addEventListener('click', closeHelp);

  // Gallery
  document.getElementById('gallery-btn').addEventListener('click', openGallery);
  document.getElementById('gallery-close').addEventListener('click', closeGallery);
  document.getElementById('gallery-backdrop').addEventListener('click', closeGallery);

  // Date range slider + calendar
  document.getElementById('date-range-min').addEventListener('input', onDateSliderChange);
  document.getElementById('date-range-max').addEventListener('input', onDateSliderChange);
  document.getElementById('date-pill-min').addEventListener('click', () => openCalendar('min'));
  document.getElementById('date-pill-max').addEventListener('click', () => openCalendar('max'));
  document.getElementById('date-reset-btn').addEventListener('click', resetDateFilter);
  document.getElementById('cal-prev').addEventListener('click', calPrevMonth);
  document.getElementById('cal-next').addEventListener('click', calNextMonth);
  document.getElementById('cal-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-day');
    if (!btn || btn.classList.contains('disabled')) return;
    onCalendarDayClick(parseInt(btn.dataset.ts, 10));
  });
  // Close calendar on outside click
  document.addEventListener('mousedown', (e) => {
    const popup = document.getElementById('cal-popup');
    if (popup.classList.contains('hidden')) return;
    if (popup.contains(e.target)) return;
    if (e.target.closest('.date-pill')) return;
    closeCalendar();
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
    if (e.key === 'Escape') {
      if (isLightboxOpen()) { closeLightbox(); return; }
      if (calTarget) { closeCalendar(); return; }
      if (isHelpOpen()) { closeHelp(); return; }
      if (isGalleryOpen()) { closeGallery(); return; }
    }
    if (!isLightboxOpen()) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxPrev(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNext(); }
  });

  // Load configured folders and cached data
  sourceDirs = await window.photoMap.getDirs();
  renderFolderList();
  await loadPhotosAndRender();
});
