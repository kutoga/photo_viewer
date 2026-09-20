'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
class Workers {
  constructor(size = 2) {
    this.size = size;
    this.slots = [];
    this.queue = [];
    this.token = 0;
    this.closed = false;
  }
  run(kind, payload) {
    if (this.closed) return Promise.reject(new Error('Worker pool closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ token: ++this.token, kind, payload, resolve, reject });
      this.dispatch();
    });
  }
  spawn() {
    const worker = new Worker(path.join(__dirname, 'media-worker.cjs'));
    const slot = { worker, task: null };
    worker.on('message', ({ result, error }) => {
      const task = slot.task;
      slot.task = null;
      if (task) error ? task.reject(new Error(error)) : task.resolve(result);
      this.dispatch();
    });
    worker.on('error', (err) => {
      slot.task?.reject(err);
      slot.task = null;
    });
    worker.on('exit', (code) => {
      slot.task?.reject(new Error(`Media worker stopped (${code})`));
      this.slots = this.slots.filter((s) => s !== slot);
      if (!this.closed) this.dispatch();
    });
    this.slots.push(slot);
    return slot;
  }
  dispatch() {
    if (this.closed) return;
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.task);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) break;
      slot.task = this.queue.shift();
      const { token, kind, payload } = slot.task;
      slot.worker.postMessage({ token, kind, payload });
    }
  }
  async close() {
    this.closed = true;
    const error = new Error('Application closing');
    this.queue.splice(0).forEach((t) => t.reject(error));
    this.slots.forEach((s) => s.task?.reject(error));
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }
}
module.exports = { Workers };
