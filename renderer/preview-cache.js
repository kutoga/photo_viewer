'use strict';
class PreviewCache {
  constructor(api, limit = 5) {
    this.api = api;
    this.limit = limit;
    this.entries = new Map();
  }
  key(item) {
    return `${item.id}:${item.fileMtime || 0}:${item.cacheVersion || 0}`;
  }
  peek(item) {
    return this.entries.get(this.key(item))?.result;
  }
  load(item, options = {}) {
    const key = this.key(item);
    if (!options.full && this.entries.has(key)) {
      const cached = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }
    const cached = {};
    cached.promise = this.api
      .getPreview(item.id, options)
      .then(
        (result) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
              cached.result = { ...result, decoded: image };
              resolve(cached.result);
            };
            image.onerror = () => reject(new Error('The preview could not be loaded'));
            image.src = result.image;
          }),
      )
      .catch((err) => {
        if (this.entries.get(key) === cached) this.entries.delete(key);
        throw err;
      });
    if (!options.full) {
      this.entries.set(key, cached);
      while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    }
    return cached.promise;
  }
}
window.PreviewCache = PreviewCache;
