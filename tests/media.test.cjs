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

test('thumbnails preserve portrait, panorama and EXIF-rotated proportions without cropping', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-ratios-'));
  await fs.mkdir(path.join(root, 'thumbnails'));
  const pool = new Workers(1);
  t.after(async () => {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [width, height, orientation, expected] of [
    [600, 1200, 1, [160, 320]],
    [1600, 400, 1, [320, 80]],
    [1200, 600, 6, [160, 320]],
  ]) {
    const file = path.join(root, `${width}-${height}.jpg`);
    // Contrasting edges reveal accidental cropping, including after autorotation.
    await sharp({ create: { width, height, channels: 3, background: '#008800' } })
      .composite([
        {
          input: await sharp({ create: { width: 100, height, channels: 3, background: '#ff0000' } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({ create: { width: 100, height, channels: 3, background: '#0000ff' } })
            .png()
            .toBuffer(),
          left: width - 100,
          top: 0,
        },
      ])
      .withMetadata({ orientation })
      .withExifMerge({
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '47/1 0/1 0/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '8/1 0/1 0/1',
        },
      })
      .jpeg()
      .toFile(file);
    const stat = await fs.stat(file);
    const entry = await pool.run('scan', {
      file,
      id: fileId(file),
      stat: { size: stat.size, mtimeMs: stat.mtimeMs },
      cacheDir: root,
    });
    assert.ok(entry.hasThumbnail, entry.error);
    const thumbnail = sharp(path.join(root, 'thumbnails', `${entry.id}_thumb.jpg`));
    const { width: w, height: h } = await thumbnail.metadata();
    assert.deepEqual([w, h], expected);
    const { data, info } = await thumbnail.raw().toBuffer({ resolveWithObject: true });
    const sample = (x, y) => [
      ...data.subarray((y * w + x) * info.channels, (y * w + x) * info.channels + 3),
    ];
    const first = orientation === 6 ? sample(Math.floor(w / 2), 2) : sample(2, Math.floor(h / 2));
    const last =
      orientation === 6 ? sample(Math.floor(w / 2), h - 3) : sample(w - 3, Math.floor(h / 2));
    assert.ok(first[0] > 200 && first[1] < 40, `red edge missing: ${first}`);
    assert.ok(last[2] > 200 && last[1] < 40, `blue edge missing: ${last}`);
  }
});

test('corrupt previews regenerate and actual-pixel images retain original resolution', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-detail-'));
  await fs.mkdir(path.join(root, 'previews'));
  const file = path.join(root, 'large.jpg');
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#648b75' } })
    .jpeg()
    .toFile(file);
  const entry = { id: fileId(file), originalPath: file, type: 'photo' };
  const pool = new Workers(1);
  t.after(async () => {
    await pool.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const regular = await pool.run('preview', { entry, cacheDir: root });
  assert.equal((await sharp(regular).metadata()).width, 1920);
  await fs.writeFile(regular, 'corrupt image data');
  await pool.run('preview', { entry, cacheDir: root });
  assert.equal((await sharp(regular).metadata()).width, 1920);
  const full = await pool.run('preview', { entry, cacheDir: root, full: true });
  assert.notEqual(full, regular);
  assert.equal((await sharp(full).metadata()).width, 3000);
  assert.equal((await sharp(full).metadata()).height, 2000);
});
