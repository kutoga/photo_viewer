'use strict';
class PhotoAtlas {
  constructor({ onPhoto, onArea, onError }) {
    this.onPhoto = onPhoto;
    this.onArea = onArea;
    this.onError = onError;
    this.items = new Map();
    this.markers = new Map();
    this.version = 0;
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
        { maxNativeZoom: 19, maxZoom: 22 },
      ),
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        { maxNativeZoom: 19, maxZoom: 22 },
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
    new ResizeObserver(() => this.map.invalidateSize({ pan: false })).observe(
      document.getElementById('map'),
    );
  }
  setItems(items) {
    this.items = new Map(items.map((p) => [p.id, p]));
    this.heat.setLatLngs(items.map((p) => [p.lat, p.lng, 1]));
    this.clearSpider();
    if (this.loadBusy) {
      this.nextItems = items;
      return;
    }
    this.load(items);
  }
  load(items) {
    this.loadBusy = true;
    this.worker.postMessage({
      type: 'load',
      version: ++this.version,
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
    )
      this.render(data.clusters);
    else if (data.type === 'leaves') {
      const resolve = this.leaves.get(data.request);
      this.leaves.delete(data.request);
      resolve?.(
        data.version === this.version
          ? data.ids.map((id) => this.items.get(id)).filter(Boolean)
          : [],
      );
    } else if (data.type === 'error') {
      this.leaves.get(data.request)?.([]);
      this.leaves.delete(data.request);
      this.loadBusy = false;
      this.onError(data.error);
    }
  }
  bounds() {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  fit() {
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
  query() {
    const zoom = Math.floor(this.map.getZoom());
    document.getElementById('map-mode').textContent =
      zoom < 8 && this.items.size ? 'Memory heatmap' : 'Satellite view';
    document.getElementById('map-hint').textContent =
      zoom < 8 ? 'Zoom in to get a little closer.' : 'Click a photo or a cluster to explore.';
    if (zoom < 8) {
      this.layer.clearLayers();
      this.markers.clear();
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
    if (this.map.getZoom() < 8) return;
    const wanted = new Set();
    for (const cluster of clusters) {
      const p = cluster.properties,
        entry = this.items.get(p.id);
      if (!p.cluster && !entry) continue;
      const key = p.cluster ? `c${this.version}:${p.cluster_id}` : `p${p.id}:${entry.fileMtime}`;
      wanted.add(key);
      if (this.markers.has(key)) continue;
      const [lng, lat] = cluster.geometry.coordinates;
      let marker;
      if (p.cluster) {
        const size = Math.min(52, 31 + Math.log(p.point_count) * 3);
        marker = L.marker([lat, lng], {
          icon: L.divIcon({
            className: '',
            html: `<div class="cluster-pin" style="width:${size}px;height:${size}px">${p.point_count_abbreviated}</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          }),
          title: `Explore ${p.point_count} memories`,
          keyboard: true,
        });
        marker.on('click', async () => {
          const request = ++this.request;
          const items = await new Promise((resolve) => {
            this.leaves.set(request, resolve);
            this.worker.postMessage({ type: 'leaves', id: p.cluster_id, request });
          });
          if (!items.length) return;
          this.onArea(items, 'A place to remember');
          if (items.length <= 24) this.spiderfy(items, [lat, lng]);
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
