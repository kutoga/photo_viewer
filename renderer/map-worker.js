'use strict';
importScripts('vendor/supercluster.js');
let index,
  version = 0;
onmessage = ({ data }) => {
  try {
    if (data.type === 'load') {
      index = new Supercluster({ radius: 65, maxZoom: 21, minPoints: 2 });
      index.load(
        data.points.map((p) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { id: p.id },
        })),
      );
      version = data.version;
      postMessage({ type: 'ready', version });
    } else if (data.type === 'query') {
      postMessage({
        type: 'clusters',
        request: data.request,
        version,
        clusters: index ? index.getClusters(data.bounds, data.zoom) : [],
      });
    } else if (data.type === 'leaves') {
      postMessage({
        type: 'leaves',
        request: data.request,
        version,
        ids: index.getLeaves(data.id, Infinity).map((p) => p.properties.id),
      });
    }
  } catch (err) {
    postMessage({ type: 'error', error: err.message, request: data.request });
  }
};
