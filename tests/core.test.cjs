'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  isWithin,
  uniqueRoots,
  hasGPS,
  parseLocation,
  atomicWrite,
  readJSON,
  walk,
} = require('../lib/core.cjs');
const model = require('../renderer/model.js');

test('exact duplicate filtering respects folders and keeps files without checksums', () => {
  const items = [
    { id: 'a', originalPath: '/a/photo.jpg', contentHash: 'same', lat: 0, lng: 0 },
    { id: 'b', originalPath: '/b/photo.jpg', contentHash: 'same', lat: 0, lng: 0 },
    { id: 'c', originalPath: '/b/other.jpg', contentHash: 'different', lat: 0, lng: 0 },
    { id: 'd', originalPath: '/b/unknown.jpg', lat: 0, lng: 0 },
  ];
  assert.deepEqual(
    model.filter(items, { hideDuplicates: true }).map((p) => p.id),
    ['a', 'c', 'd'],
  );
  assert.equal(model.filter(items, { hideDuplicates: false }).length, 4);
  assert.deepEqual(
    model.filter(items, { hideDuplicates: true, folder: '/b' }).map((p) => p.id),
    ['b', 'c', 'd'],
  );
});

test('Windows paths: case insensitive, safe boundaries, roots, and UNC paths', () => {
  assert.ok(isWithin('C:\\Photos\\Trip\\a.jpg', 'c:\\photos', 'win32'));
  assert.ok(isWithin('C:\\Photos\\a.jpg', 'C:\\', 'win32'));
  assert.ok(!isWithin('C:\\Photos-old\\a.jpg', 'C:\\Photos', 'win32'));
  assert.ok(!isWithin('D:\\Photos\\a.jpg', 'C:\\Photos', 'win32'));
  assert.ok(isWithin('\\\\server\\share\\Pictures\\a.jpg', '\\\\server\\share', 'win32'));
  assert.deepEqual(
    uniqueRoots(['C:\\Photos', 'c:\\photos\\Trip', 'C:\\PHOTOS', 'D:\\Photos'], 'win32'),
    ['C:\\Photos', 'D:\\Photos'],
  );
});
test('Linux paths are case sensitive and respect directory boundaries', () => {
  assert.ok(isWithin('/home/me/photos/a.jpg', '/home/me/photos', 'linux'));
  assert.ok(!isWithin('/home/me/Photos/a.jpg', '/home/me/photos', 'linux'));
  assert.ok(!isWithin('/home/me/photos-old/a.jpg', '/home/me/photos', 'linux'));
  assert.ok(isWithin('/a.jpg', '/', 'linux'));
});
test('valid coordinates include equator and prime meridian; malformed GPS is rejected', () => {
  for (const [lat, lng] of [
    [0, 0],
    [0, 45],
    [45, 0],
    [-90, 180],
  ])
    assert.ok(hasGPS({ lat, lng }));
  for (const lat of [null, undefined, NaN, Infinity, 91]) assert.ok(!hasGPS({ lat, lng: 10 }));
  assert.deepEqual(parseLocation('+47.3769+008.5417+408.0/'), { lat: 47.3769, lng: 8.5417 });
  assert.deepEqual(parseLocation('-33.85+151.20/'), { lat: -33.85, lng: 151.2 });
  assert.equal(parseLocation('+147.0+008.0/'), null);
});
test('filters compose and unrestricted dates include newly imported dates', () => {
  const items = [
    {
      id: 'a',
      lat: 0,
      lng: 0,
      type: 'photo',
      date: '2020-06-01T12:00:00Z',
      originalPath: '/photos/old.jpg',
      filename: 'old.jpg',
    },
    {
      id: 'b',
      lat: 47,
      lng: 8,
      type: 'video',
      date: '2026-06-01T12:00:00Z',
      originalPath: '/photos/new.mp4',
      filename: 'new.mp4',
    },
    {
      id: 'c',
      lat: 40,
      lng: 7,
      type: 'photo',
      date: null,
      originalPath: '/photos/unknown.jpg',
      filename: 'unknown.jpg',
    },
  ];
  assert.equal(model.filter(items, {}).length, 3);
  assert.equal(model.filter(items, { from: '2025-01-01' }).length, 2);
  assert.deepEqual(
    model
      .filter(items, { type: 'video', search: 'NEW', folder: '/photos', to: '2026-12-31' })
      .map((p) => p.id),
    ['b'],
  );
  assert.equal(model.filter(items, { folder: '/photo' }).length, 0);
  assert.equal(model.filter(items, { type: 'photo', from: '2025-01-01' }).length, 1);
  assert.equal(model.dateBounds(items).min, '2020-06-01');
  assert.equal(model.dateBounds(items).max, '2026-06-01');
});
test('viewport membership uses each photo, including wrapped map copies', () => {
  assert.ok(model.inBounds({ lat: 10, lng: 175 }, [170, 0, 190, 20]));
  assert.ok(model.inBounds({ lat: 10, lng: -175 }, [170, 0, 190, 20]));
  assert.ok(!model.inBounds({ lat: 10, lng: -150 }, [170, 0, 190, 20]));
  assert.ok(model.inBounds({ lat: 10, lng: 0 }, [-540, 0, 540, 20]));
});
test('date bounds remain safe for a 200,000-item library', () => {
  const items = Array.from({ length: 200000 }, (_, i) => ({
    lat: 47,
    lng: 8,
    date: i % 2 ? '2020-01-01T12:00:00Z' : '2026-01-01T12:00:00Z',
  }));
  assert.deepEqual(model.dateBounds(items), { min: '2020-01-01', max: '2026-01-01' });
});
test('atomic persistence and streaming walk preserve originals and skip unsupported files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'a.JPG'), 'original');
  await fs.writeFile(path.join(dir, 'sub', 'b.mp4'), 'video');
  await fs.writeFile(path.join(dir, 'notes.txt'), 'ignore');
  const found = [];
  for await (const file of walk(dir, () => assert.fail('unexpected read error')))
    found.push(path.basename(file));
  assert.deepEqual(found.sort(), ['a.JPG', 'b.mp4']);
  await atomicWrite(path.join(dir, 'data.json'), { version: 1 });
  await atomicWrite(path.join(dir, 'data.json'), { version: 2 });
  assert.deepEqual(await readJSON(path.join(dir, 'data.json'), {}), { version: 2 });
  assert.equal(await fs.readFile(path.join(dir, 'a.JPG'), 'utf8'), 'original');
  await fs.writeFile(path.join(dir, 'broken.json'), '{');
  await assert.rejects(readJSON(path.join(dir, 'broken.json'), []), /Could not read/);
});

test('large checkpoints yield to the event loop and keep the last good file on failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-save-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.json');
  const entries = Array.from({ length: 12000 }, (_, id) => ({
    id,
    filename: `Photo ${id}.jpg`,
    path: 'a'.repeat(300),
  }));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await atomicWrite(file, entries);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 1, 'checkpoint should yield while writing batches');
  assert.deepEqual(await readJSON(file), entries);
  const circular = {};
  circular.self = circular;
  await assert.rejects(atomicWrite(file, [...entries.slice(0, 1000), circular]));
  assert.deepEqual(await readJSON(file), entries);
  assert.deepEqual(await fs.readdir(dir), ['metadata.json']);
});
