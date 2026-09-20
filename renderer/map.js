'use strict';
class PhotoAtlas {
  constructor({ onPhoto, onArea, onError }) {
    this.onPhoto = onPhoto;
    this.onArea = onArea;
    this.onError = onError;
    this.items = new Map();
    this.mode = 'auto';
    this.markers = new Map();
    this.version = 0;
    this.renderedVersion = 0;
    this.selection = 0;
    this.deferredItems = null;
    this.readyVersion = 0;
    this.request = 0;
    this.leaves = new Map();
    this.loadBusy = false;
    this.nextItems = null;
    this.map = L.map('map', {
      center: [35, 12],
      zoom: 3,
      zoomControl: false,
      preferCanvas: true,
      minZoom: 2,
      maxZoom: 22,
      worldCopyJump: true,
      attributionControl: true,
    });
    this.tiles = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Imagery © Esri',
        maxNativeZoom: 19,
        maxZoom: 22,
        keepBuffer: 3,
        updateWhenIdle: true,
      },
    ).addTo(this.map);
    this.labels = L.layerGroup([
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        { maxNativeZoom: 19, maxZoom: 22, opacity: 0.85 },
      ),
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        { maxNativeZoom: 19, maxZoom: 22, opacity: 0.45 },
      ),
    ]).addTo(this.map);
    this.tiles.on('tileerror', () => {
      document.getElementById('map-offline').hidden = false;
    });
    this.tiles.on('load', () => {
      /* A failed tile remains visible as a retry banner until the user retries. */
    });
    this.layer = L.layerGroup().addTo(this.map);
    this.spider = L.layerGroup().addTo(this.map);
    const SafeHeatLayer = L.HeatLayer.extend({
      redraw() {
        return this._map ? L.HeatLayer.prototype.redraw.call(this) : this;
      },
      _redraw() {
        if (this._map) L.HeatLayer.prototype._redraw.call(this);
        else this._frame = null;
      },
    });
    this.heat = new SafeHeatLayer([], {
      radius: 25,
      blur: 20,
      maxZoom: 8,
      minOpacity: 0.35,
      gradient: { 0.25: '#82b5a8', 0.5: '#d5cd92', 0.75: '#d79965', 1: '#c36346' },
    });
    this.worker = new Worker('map-worker.js');
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = () =>
      this.onError('The map index could not be loaded. Restart Photo Map.');
    this.map.on('moveend zoomend', () => this.scheduleQuery());
    this.map.on('zoomstart', () => this.clearSpider());
    this.map.on('click', () => this.clearSpider());
    new ResizeObserver(() => {
      const element = document.getElementById('map');
      if (element.clientWidth && element.clientHeight)
        this.map.invalidateSize({ pan: true, animate: false });
    }).observe(document.getElementById('map'));
  }
  setItems(items) {
    if (document.getElementById('map-view').hidden) {
      this.deferredItems = items;
      return;
    }
    this.heat.setLatLngs(items.map((p) => [p.lat, p.lng, 1]));
    this.clearSpider();
    if (this.loadBusy) {
      this.nextItems = items;
      return;
    }
    this.load(items);
  }
  load(items) {
    this.items = new Map(items.map((p) => [p.id, p]));
    this.loadBusy = true;
    this.worker.postMessage({
      type: 'load',
      version: ++this.version,
      keepVersion: this.renderedVersion,
      points: items.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })),
    });
  }
  receive(data) {
    if (data.type === 'ready') {
      this.readyVersion = data.version;
      this.loadBusy = false;
      if (this.nextItems) {
        const items = this.nextItems;
        this.nextItems = null;
        this.load(items);
      } else this.query();
    } else if (
      data.type === 'clusters' &&
      data.version === this.version &&
      data.request === this.queryRequest
    ) {
      this.render(data.clusters);
      this.renderedVersion = data.version;
      this.worker.postMessage({ type: 'retain', versions: [this.version, this.renderedVersion] });
    } else if (data.type === 'leaves') {
      const resolve = this.leaves.get(data.request);
      this.leaves.delete(data.request);
      resolve?.(data.ids);
    } else if (data.type === 'error') {
      this.leaves.get(data.request)?.([]);
      this.leaves.delete(data.request);
      this.loadBusy = false;
      this.onError(data.error);
    }
  }
  resume() {
    this.map.invalidateSize({ pan: true, animate: false });
    if (this.deferredItems) {
      const items = this.deferredItems;
      this.deferredItems = null;
      this.setItems(items);
    }
    if (this.fitWhenVisible) {
      this.fitWhenVisible = false;
      this.fit();
    }
    this.query();
  }
  bounds() {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  fit() {
    if (document.getElementById('map-view').hidden) {
      this.fitWhenVisible = true;
      return;
    }
    const points = [...this.items.values()].map((p) => [p.lat, p.lng]);
    if (points.length)
      this.map.fitBounds(L.latLngBounds(points), {
        padding: [65, 65],
        maxZoom: 14,
        animate: false,
      });
  }
  scheduleQuery() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.query();
    });
  }
  setMode(mode) {
    if (!['auto', 'heat', 'bubbles'].includes(mode)) return;
    this.mode = mode;
    this.cancelSelection();
    this.layer.clearLayers();
    this.markers.clear();
    this.queryRequest = ++this.request;
    this.query();
  }
  usesHeat() {
    return this.mode === 'heat' || (this.mode === 'auto' && this.map.getZoom() < 8);
  }
  query() {
    const zoom = Math.floor(this.map.getZoom());
    const heat = this.usesHeat();
    document.getElementById('map-mode').textContent = heat
      ? 'Memory heatmap'
      : this.mode === 'bubbles'
        ? 'Photo counts'
        : 'Photo clusters';
    document.getElementById('map-hint').textContent = heat
      ? 'Browse an area to explore its photos.'
      : 'Click a photo or a bubble to explore.';
    if (heat) {
      this.layer.clearLayers();
      this.markers.clear();
      this.renderedVersion = 0;
      this.clearSpider();
      if (this.items.size) {
        if (!this.map.hasLayer(this.heat)) this.heat.addTo(this.map);
      } else this.hideHeat();
      return;
    }
    this.hideHeat();
    if (this.readyVersion !== this.version || this.loadBusy) return;
    const bounds = this.bounds();
    // Normalize wrapped longitudes for Supercluster while retaining viewport width.
    if (bounds[2] - bounds[0] >= 360) {
      bounds[0] = -180;
      bounds[2] = 180;
    }
    this.worker.postMessage({
      type: 'query',
      bounds,
      zoom,
      request: (this.queryRequest = ++this.request),
    });
  }
  hideHeat() {
    // Leaflet.heat leaves a scheduled redraw behind when detached mid-frame.
    if (this.heat._frame) {
      L.Util.cancelAnimFrame(this.heat._frame);
      this.heat._frame = null;
    }
    if (this.map.hasLayer(this.heat)) this.map.removeLayer(this.heat);
  }
  render(clusters) {
    if (this.usesHeat()) return;
    const wanted = new Set();
    for (const cluster of clusters) {
      const p = cluster.properties,
        entry = this.items.get(p.id);
      if (!p.cluster && !entry) continue;
      const key = p.cluster
        ? `c${this.version}:${p.cluster_id}`
        : `p${p.id}:${entry.fileMtime}:${entry.cacheVersion}`;
      wanted.add(key);
      if (this.markers.has(key)) continue;
      const [lng, lat] = cluster.geometry.coordinates;
      let marker;
      if (p.cluster || this.mode === 'bubbles') {
        const total = p.cluster ? p.point_count : 1;
        const size = Math.round(Math.min(58, 35 + Math.log(total) * 3));
        marker = L.marker([lat, lng], {
          icon: L.divIcon({
            className: 'cluster-marker',
            html: `<div class="cluster-pin" style="width:${size}px;height:${size}px">${p.cluster ? p.point_count_abbreviated : 1}</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
          title: p.cluster ? `Explore ${total} memories` : `Open ${entry.filename}`,
          keyboard: true,
          autoPanOnFocus: false,
          riseOnHover: true,
          zIndexOffset: 100,
        });
        const clusterVersion = this.version;
        const records = this.items;
        marker.on('click', async () => {
          if (!p.cluster) {
            this.onPhoto(entry.id);
            return;
          }
          const selection = ++this.selection;
          this.markers.forEach((m) => m.getElement()?.classList.remove('is-selected'));
          const element = marker.getElement();
          element?.classList.add('is-loading', 'is-selected');
          element?.setAttribute('aria-busy', 'true');
          const request = ++this.request;
          const ids = await new Promise((resolve) => {
            this.leaves.set(request, resolve);
            this.worker.postMessage({
              type: 'leaves',
              id: p.cluster_id,
              version: clusterVersion,
              request,
            });
          });
          element?.classList.remove('is-loading');
          element?.removeAttribute('aria-busy');
          if (selection !== this.selection) return;
          const items = ids.map((id) => records.get(id)).filter(Boolean);
          if (!items.length) return;
          this.onArea(items, 'Photos at this location');
          if (items.length <= 24 && this.mode !== 'bubbles') this.spiderfy(items, [lat, lng]);
        });
      } else marker = this.photoMarker(entry, [lat, lng], 48, () => this.onPhoto(entry.id));
      marker.addTo(this.layer);
      this.markers.set(key, marker);
    }
    for (const [key, marker] of this.markers)
      if (!wanted.has(key)) {
        this.layer.removeLayer(marker);
        this.markers.delete(key);
      }
  }
  photoMarker(entry, pos, size, click) {
    const container = document.createElement('div');
    container.className = 'photo-pin';
    container.style.width = `${size}px`;
    container.style.height = `${size}px`;
    if (entry.hasThumbnail) {
      const img = document.createElement('img');
      img.src = PhotoModel.thumb(entry);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => {
        container.innerHTML = `<span class="photo-fallback">${icon('image')}</span>`;
      };
      container.append(img);
    } else container.innerHTML = `<span class="photo-fallback">${icon('image')}</span>`;
    if (entry.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'pin-video';
      badge.innerHTML = icon('play');
      container.append(badge);
    }
    return L.marker(pos, {
      icon: L.divIcon({
        className: '',
        html: container,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      title: entry.filename,
      keyboard: true,
    }).on('click', click);
  }
  spiderfy(items, position) {
    this.clearSpider();
    const center = this.map.latLngToLayerPoint(position);
    const radius = Math.max(70, items.length * 10);
    items.forEach((entry, index) => {
      const angle = (Math.PI * 2 * index) / items.length;
      const pos = this.map.layerPointToLatLng(
        L.point(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius),
      );
      L.polyline([position, pos], {
        weight: 1,
        color: '#fff',
        opacity: 0.7,
        interactive: false,
      }).addTo(this.spider);
      this.photoMarker(entry, pos, 48, () => this.onPhoto(entry.id, items)).addTo(this.spider);
    });
  }
  cancelSelection() {
    this.selection++;
    this.markers.forEach((marker) => marker.getElement()?.classList.remove('is-selected'));
    this.clearSpider();
  }
  clearSpider() {
    this.spider.clearLayers();
  }
  setLabels(show) {
    show ? this.labels.addTo(this.map) : this.map.removeLayer(this.labels);
  }
  retryTiles() {
    document.getElementById('map-offline').hidden = true;
    this.tiles.redraw();
  }
}
window.PhotoAtlas = PhotoAtlas;
