'use strict';
importScripts('model.js');
const items = new Map();
let dates = { min: '', max: '' },
  datesDirty = true;
onmessage = ({ data }) => {
  try {
    if (data.type === 'replace') {
      items.clear();
      for (const item of data.items) items.set(item.id, item);
      datesDirty = true;
    } else if (data.type === 'changes') {
      for (const id of data.remove) items.delete(id);
      for (const item of data.upsert) {
        if (PhotoModel.hasGPS(item)) items.set(item.id, item);
        else items.delete(item.id);
      }
      datesDirty = true;
    } else if (data.type === 'filter') {
      const all = [...items.values()];
      if (datesDirty) {
        dates = PhotoModel.dateBounds(all);
        datesDirty = false;
      }
      const matches = PhotoModel.sort(PhotoModel.filter(all, data.filters), data.sort);
      postMessage({
        type: 'filtered',
        request: data.request,
        ids: matches.map((p) => p.id),
        dates,
      });
    }
  } catch (err) {
    postMessage({ type: 'error', request: data.request, error: err.message });
  }
};
