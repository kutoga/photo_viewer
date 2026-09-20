'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { Workers } = require('../lib/workers.cjs');
const { fileId } = require('../lib/core.cjs');

test('real workers extract EXIF GPS, produce thumbnails and generate previews on demand', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-media-'));
  await fs.mkdir(path.join(root, 'thumbnails'));
  await fs.mkdir(path.join(root, 'previews'));
  const file = path.join(root, 'Photo #1 ü.jpg');
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#809a87' } })
    .jpeg()
    .withExif({
      IFD0: { DateTime: '2024:06:12 14:32:00' },
      IFD2: { DateTimeOriginal: '2024:06:12 14:32:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '47/1 22/1 3600/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '8/1 32/1 3000/100',
      },
    })
    .toFile(file);
  const pool = new Workers(2);
  t.after(async () => {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const stat = await fs.stat(file),
    id = fileId(file);
  const entry = await pool.run('scan', {
    file,
    id,
    stat: { size: stat.size, mtimeMs: stat.mtimeMs },
    cacheDir: root,
  });
  assert.ok(Math.abs(entry.lat - 47.3766667) < 0.0001);
  assert.ok(entry.lng > 8.5);
  assert.ok(entry.hasThumbnail);
  const thumb = await sharp(path.join(root, 'thumbnails', `${id}_thumb.jpg`)).metadata();
  assert.equal(thumb.width, 320);
  assert.deepEqual(await fs.readdir(path.join(root, 'previews')), []);
  const preview = await pool.run('preview', { entry, cacheDir: root });
  assert.equal((await sharp(preview).metadata()).width, 1200);
  assert.equal((await fs.stat(file)).size, stat.size);
});
test('real video GPS extraction and short-clip frame fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-video-'));
  await fs.mkdir(path.join(root, 'thumbnails'));
  await fs.mkdir(path.join(root, 'previews'));
  const file = path.join(root, 'clip.mov');
  execFileSync(
    require('ffmpeg-static'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=0.4',
      '-c:v',
      'mpeg4',
      '-metadata',
      'location=+47.3769+008.5417/',
      '-metadata',
      'creation_time=2024-06-01T12:00:00Z',
      file,
    ],
    { windowsHide: true },
  );
  const pool = new Workers(1);
  t.after(async () => {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const stat = await fs.stat(file);
  const entry = await pool.run('scan', {
    file,
    id: fileId(file),
    stat: { size: stat.size, mtimeMs: stat.mtimeMs },
    cacheDir: root,
  });
  assert.equal(entry.type, 'video');
  assert.ok(Math.abs(entry.lat - 47.3769) < 0.001);
  assert.ok(entry.hasThumbnail);
  assert.ok(entry.date.startsWith('2024-06-01'));
});
test('bundled HEIC codec generates thumbnails and previews without system HEVC support', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-heic-'));
  await fs.mkdir(path.join(root, 'thumbnails'));
  await fs.mkdir(path.join(root, 'previews'));
  const file = path.join(__dirname, 'fixtures/location.heic');
  const pool = new Workers(1);
  t.after(async () => {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const stat = await fs.stat(file);
  const entry = await pool.run('scan', {
    file,
    id: fileId(file),
    stat: { size: stat.size, mtimeMs: stat.mtimeMs },
    cacheDir: root,
  });
  assert.ok(entry.lat > 47);
  assert.ok(entry.hasThumbnail, entry.error);
  const preview = await pool.run('preview', { entry, cacheDir: root });
  assert.equal((await sharp(preview).metadata()).width, 64);
});
