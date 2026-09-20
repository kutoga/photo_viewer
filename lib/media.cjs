'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const sharp = require('sharp');
const exifr = require('exifr');
const { VIDEOS, hasGPS, parseLocation } = require('./core.cjs');
const { extractHeifExif } = require('./heif.cjs');
sharp.concurrency(1);
sharp.cache({ memory: 24, files: 0, items: 32 });
const ffmpeg = require('ffmpeg-static')?.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

async function videoMetadata(file) {
  let output = '';
  try {
    await exec(ffmpeg, ['-hide_banner', '-i', file], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    output = err.stderr || '';
  }
  const location = output.match(
    /(?:com\.apple\.quicktime\.location\.ISO6709|location(?:-eng)?)\s*:\s*(\S+)/i,
  );
  const created = output.match(/(?:creation_time|com\.apple\.quicktime\.creationdate)\s*:\s*(.+)/i);
  const gps = parseLocation(location?.[1]);
  const time = Date.parse(created?.[1]);
  return { ...gps, date: Number.isFinite(time) ? new Date(time).toISOString() : null };
}
async function videoFrame(file, output, width) {
  // Zero-second fallback also handles clips shorter than a second.
  for (const seek of ['1', '0']) {
    try {
      await exec(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          seek,
          '-i',
          file,
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-vf',
          `scale=${width}:-2`,
          '-q:v',
          '3',
          output,
        ],
        { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const stat = await fs.stat(output);
      if (stat.size) return;
    } catch (err) {
      if (seek === '0') throw err;
    }
  }
  throw new Error('This video has no readable frame.');
}
async function renderImage(file, destination, preview = false) {
  const resize = (pipeline) =>
    preview
      ? pipeline.resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      : pipeline.resize(320, 240, { fit: 'cover', withoutEnlargement: true });
  try {
    await resize(sharp(file, { failOn: 'none' }).rotate())
      .jpeg({ quality: preview ? 86 : 76 })
      .toFile(destination);
  } catch (err) {
    if (!/\.hei[cf]$/i.test(file)) throw err;
    // Prebuilt libvips does not include HEVC on all platforms. Decode HEIC with
    // the bundled WASM codec inside the background worker, without OS codecs.
    const decode = require('heic-decode');
    const { width, height, data } = await decode({ buffer: await fs.readFile(file) });
    await resize(
      sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        raw: { width, height, channels: 4 },
      }),
    )
      .jpeg({ quality: preview ? 86 : 76 })
      .toFile(destination);
  }
}
async function processMedia({ file, id, stat, cacheDir }) {
  const type = VIDEOS.has(path.extname(file).toLowerCase()) ? 'video' : 'photo';
  const entry = {
    id,
    originalPath: file,
    filename: path.basename(file),
    type,
    fileSize: stat.size,
    fileMtime: stat.mtimeMs,
    lat: null,
    lng: null,
    date: null,
    hasThumbnail: false,
    hasPreview: false,
    cacheVersion: 2,
  };
  try {
    if (type === 'video') Object.assign(entry, await videoMetadata(file));
    else {
      let data;
      try {
        data = await exifr.parse(file, { gps: true });
      } catch (err) {
        if (!/\.hei[cf]$/i.test(file)) throw err;
      }
      if (/\.hei[cf]$/i.test(file) && (!data || data.errors?.length)) {
        const tiff = extractHeifExif(await fs.readFile(file));
        if (tiff) data = await exifr.parse(tiff, { gps: true });
      }
      if (data) {
        entry.lat = data.latitude ?? null;
        entry.lng = data.longitude ?? null;
        const date = data.DateTimeOriginal || data.CreateDate || data.ModifyDate;
        if (date instanceof Date && Number.isFinite(date.getTime()))
          entry.date = date.toISOString();
      }
    }
  } catch (err) {
    entry.error = 'Metadata could not be read';
  }
  if (!hasGPS(entry)) {
    entry.lat = null;
    entry.lng = null;
    return entry;
  }
  const dest = path.join(cacheDir, 'thumbnails', `${id}_thumb.jpg`);
  const temp = dest + '.tmp.jpg';
  const frame = path.join(cacheDir, `${id}_frame.jpg`);
  try {
    if (type === 'video') await videoFrame(file, frame, 320);
    await renderImage(type === 'video' ? frame : file, temp);
    await fs.rename(temp, dest);
    entry.hasThumbnail = true;
    delete entry.error;
  } catch (err) {
    entry.error = 'Preview unavailable for this format';
  } finally {
    await Promise.all(
      [fs.rm(frame, { force: true }), fs.rm(temp, { force: true })].map((p) => p.catch(() => {})),
    );
  }
  return entry;
}
async function makePreview(entry, cacheDir) {
  const dest = path.join(cacheDir, 'previews', `${entry.id}_preview.jpg`);
  try {
    await fs.access(dest);
    return dest;
  } catch {}
  const temp = dest + '.tmp.jpg';
  try {
    if (entry.type === 'video') await videoFrame(entry.originalPath, temp, 1600);
    else await renderImage(entry.originalPath, temp, true);
    await fs.rename(temp, dest);
    return dest;
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
module.exports = { processMedia, makePreview };
