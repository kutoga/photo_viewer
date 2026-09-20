# Photo Map

A private desktop atlas for your photos and videos, rebuilt for **Windows and Linux**. Explore a satellite map, browse a gallery, and find a memory by date, filename, or folder. Original files stay untouched; there is no account or photo upload.

## Run

Install [Node.js 24 LTS](https://nodejs.org/) and run:

```sh
npm ci
npm start
```

Windows users can also double-click `start.bat`; Linux users can run `./start.sh`. The development checkout needs Node, but the packaged desktop applications do not.

Supported build targets are **Windows 10/11 x64** (installer and portable executable) and **Linux x64** (AppImage and Debian package). See [SETUP.md](SETUP.md) for platform instructions.

## Explore your library

1. Choose **Add photos** and select one or more folders. Subfolders are scanned automatically.
2. Zoom out for a heatmap; zoom in for clusters and photo thumbnails. Click a cluster to explore it. Small clusters also expand on the map.
3. Use **Browse this area** for photos inside the current map bounds, or switch to **Gallery** for all matching photos.
4. Search filenames/folder paths, filter photos or videos, select a source folder, and narrow the timeline with the sliders or date pickers. Undated files stay visible.
5. Open a photo for a larger preview. Use the arrow keys to navigate, open its coordinates in Google Maps, reveal the file, or open it in your default viewer. Press Escape to close.
6. Use the refresh button next to **Folders** to find additions, changes, and deletions. Scans can be stopped; completed work is saved.

Only media with embedded GPS coordinates appears on the map or in the gallery. The sidebar reports files without GPS. Adding folders never moves or edits originals; removing a folder deletes only its library entries and cached images, and preserves entries covered by another source folder.

## Media support

- Photos: JPEG, HEIC/HEIF, PNG, TIFF, WebP.
- Videos: MP4, MOV, M4V, AVI, MKV, WebM, with recognized ISO 6709 location metadata.
- HEIC decoding is bundled, including on platforms where Sharp's native image library cannot decode HEVC.
- Video thumbnails use bundled FFmpeg. In-app playback depends on Electron's supported codecs; **Open original** is always available as a fallback.
- Esri imagery and labels require internet. Cached media browsing works offline.

## Faster by design

- A streaming directory walker avoids building a second complete file list before processing begins.
- One to four background workers process media; Sharp uses one native thread per worker. File operations and pending jobs are bounded.
- Unchanged files are skipped using size, modification time, and cache version. Overlapping source folders are scanned once.
- Scanning produces only 320 × 240 thumbnails. Larger previews are generated when opened, in a separate worker so viewing remains responsive during scanning.
- Scan updates are batched. Spatial indexing runs in a Web Worker; map markers are reused between viewport changes.
- The gallery renders only visible rows and a small buffer. A 10,000-item UI test verifies fewer than 60 cards are mounted at a 1440 × 960 viewport.
- Atomic, serialized JSON checkpoints prevent overlapping saves from overwriting newer library state. Disconnected source folders retain their cached records.

Run `npm run benchmark` for a reproducible synthetic scan/rescan benchmark. Actual performance depends on image formats, resolution, disk speed, and library size; this is not a claim of a fixed speedup over version 1.

## Build and test

```sh
npm run check
npm test
npx playwright install chromium
npm run test:ui
npm run test:desktop
npm run build:win      # run on Windows
npm run build:linux    # run on Linux
```

Builds go to `dist/`. The [desktop workflow](.github/workflows/build.yml) installs platform-native dependencies, runs unit/browser/desktop tests, builds each platform's packages, tests the unpacked packaged applications, and uploads artifacts. It does not publish releases.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, persistence format, and performance details.

## Existing libraries

Version 2 keeps the `photo-map` application data directory and reads the original `photo-map-cache/config.json` and `metadata.json` files. Cached photos and configured folders load immediately. The first rescan upgrades old thumbnails to the new format; subsequent scans skip unchanged successful entries. Corrupt metadata is reported instead of silently replaced.

## License

MIT. Third-party components retain their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
