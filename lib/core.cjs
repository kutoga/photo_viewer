'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const IMAGES = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.tiff', '.tif', '.webp']);
const VIDEOS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
function key(file, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resolved = p.resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function isWithin(file, dir, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(key(dir, platform), key(file, platform));
  return !rel || (!rel.startsWith('..' + p.sep) && rel !== '..' && !p.isAbsolute(rel));
}
function uniqueRoots(dirs, platform = process.platform) {
  return dirs.filter(
    (dir, i) =>
      !dirs.some(
        (parent, j) =>
          j !== i &&
          isWithin(dir, parent, platform) &&
          (key(dir, platform) !== key(parent, platform) || j < i),
      ),
  );
}
function fileId(file) {
  return crypto.createHash('md5').update(file).digest('hex');
}
function hasGPS(entry) {
  return (
    Number.isFinite(entry.lat) &&
    Number.isFinite(entry.lng) &&
    Math.abs(entry.lat) <= 90 &&
    Math.abs(entry.lng) <= 180
  );
}
function parseLocation(value) {
  const m = String(value || '').match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const entry = { lat: Number(m[1]), lng: Number(m[2]) };
  return hasGPS(entry) ? entry : null;
}
async function atomicWrite(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = filename + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(data), 'utf8');
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
async function readJSON(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Never silently overwrite an unreadable or malformed library.
    throw new Error(`Could not read ${path.basename(filename)}: ${err.message}`);
  }
}
async function* walk(dir, onUnavailable, signal) {
  if (signal?.aborted) return;
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch (err) {
    onUnavailable(dir, err);
    return;
  }
  try {
    for await (const entry of handle) {
      if (signal?.aborted) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(file, onUnavailable, signal);
      else if (entry.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (IMAGES.has(ext) || VIDEOS.has(ext)) yield file;
      }
      // Symlinks are deliberately skipped to avoid cycles and duplicate libraries.
    }
  } catch (err) {
    onUnavailable(dir, err);
  }
}
module.exports = {
  IMAGES,
  VIDEOS,
  key,
  isWithin,
  uniqueRoots,
  fileId,
  hasGPS,
  parseLocation,
  atomicWrite,
  readJSON,
  walk,
};
