'use strict';
importScripts('vendor/supercluster.js');
const indices = new Map();
let version = 0;
function retain(versions) {
  for (const key of indices.keys()) if (!versions.includes(key)) indices.delete(key);
}
onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      const index = new Supercluster({ radius: 65, maxZoom: 21, minPoints: 2 });
      index.load(
        data.points.map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { id: p.id },
        })),
      );
      version = data.version;
      indices.set(version, index);
      // Keep the index that owns the visible bubbles until the UI swaps them.
      retain([version, data.keepVersion]);
      postMessage({ type: 'ready', version });
    } else if (data.type === 'retain') {
      retain([...data.versions, version]);
    } else if (data.type === 'query') {
      postMessage({
        type: 'clusters',
        request: data.request,
        version,
        clusters: indices.get(version)?.getClusters(data.bounds, data.zoom) || [],
      });
    } else if (data.type === 'leaves') {
      const index = indices.get(data.version);
      postMessage({
        type: 'leaves',
        request: data.request,
        version: data.version,
        ids: index ? index.getLeaves(data.id, Infinity).map((p) => p.properties.id) : [],
      });
    }
  } catch (err) {
    postMessage({ type: 'error', error: err.message, request: data.request });
  }
};
