'use strict';
// Reproducible synthetic I/O benchmark. Uses temporary files; never touches your library.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');
const { Library } = require('../lib/library.cjs');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-map-bench-'));
  const source = path.join(temp, 'photos');
  await fs.mkdir(source);
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><defs><linearGradient id="g"><stop stop-color="#668978"/><stop offset="1" stop-color="#cead84"/></linearGradient></defs><rect width="4000" height="3000" fill="url(#g)"/><path d="M0 2700 1000 500 2200 2300 3400 1000 4000 2900" fill="#7391a1"/></svg>',
    ),
  )
    .jpeg({ quality: 90 })
    .withExif({
      IFD2: { DateTimeOriginal: '2025:06:01 12:00:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '47/1 22/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '8/1 32/1 0/1',
      },
    })
    .toBuffer();
  const total = Number(process.env.PHOTO_MAP_BENCH_COUNT || 120);
  for (let i = 0; i < total; i++) await fs.writeFile(path.join(source, `${i}.jpg`), image);
  const library = new Library(path.join(temp, 'cache'));
  try {
    await library.init();
    await library.addFolders([source]);
    const first = performance.now();
    const scan = await library.startScan();
    const cold = performance.now() - first;
    const second = performance.now();
    const rescan = await library.startScan();
    const warm = performance.now() - second;
    const previews = await fs.readdir(path.join(temp, 'cache/previews'));
    console.log(
      JSON.stringify(
        {
          fixture: `${total} synthetic 4000×3000 geotagged JPEGs`,
          coldScanMs: Math.round(cold),
          unchangedRescanMs: Math.round(warm),
          located: library.snapshot().items.length,
          added: scan.added,
          skippedOnRescan: rescan.skipped,
          eagerPreviews: previews.length,
          scanWorkers: library.workers.size,
        },
        null,
        2,
      ),
    );
  } finally {
    await library.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
