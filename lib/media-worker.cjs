'use strict';
const { parentPort } = require('node:worker_threads');
const { processMedia, makePreview } = require('./media.cjs');
parentPort.on('message', async ({ token, kind, payload }) => {
  try {
    const result =
      kind === 'preview'
        ? await makePreview(payload.entry, payload.cacheDir)
        : await processMedia(payload);
    parentPort.postMessage({ token, result });
  } catch (err) {
    parentPort.postMessage({ token, error: err.message });
  }
});
