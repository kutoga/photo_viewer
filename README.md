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
2. The map gets most of the window. Use the sidebar button beside **Map explorer** to hide library controls. **Auto** switches from heatmap to clusters as you zoom; **Heatmap** and **Bubbles** keep their display at every zoom level. Click a bubble to explore its photos. Use **Fullscreen** or **F11** for an edge-to-edge map; press **Escape** to return.
3. Use **Browse this area** for photos inside the current map bounds, or switch to **Gallery** for all matching photos.
4. Search filenames/folder paths, filter photos or videos, select a source folder, and narrow the timeline with the sliders or date pickers. Undated files stay visible.
5. Open a photo for a larger preview. Click the small previous/next previews beside the image or use the arrow keys to navigate. Nearby previews preload after the current photo loads. Use the mouse wheel to zoom and drag to pan; double-click to switch between fitting the image and actual pixels. **Actual pixels** loads the original resolution on demand, including HEIC. You can also open its coordinates in Google Maps, reveal the file, or open it in your default viewer. Press Escape to close.
6. Use the refresh button next to **Folders** to find additions, changes, and deletions. Scans can be stopped; completed work is saved.

Only media with embedded GPS coordinates appears on the map or in the gallery. The sidebar reports files without GPS. Adding folders never moves or edits originals; removing a folder deletes only its library entries and cached images, and preserves entries covered by another source folder.

**Use view dates** sets the timeline to the earliest and latest dates of photos in the current map boundaries, open area panel, or matching gallery results. Area panels also offer **Use these dates**. Undated photos stay visible, and the timeline reset restores all dates. Gallery thumbnails preserve portrait and panoramic proportions without cropping. **Natural proportions** gives portrait photos taller cards; use the **Size** slider to adjust thumbnails, or choose **Uniform grid**. Monthly bars above the date slider show photo counts for the current folder/search/media filters, independent of the selected date range. Hover for counts and click a bar to select that month.

Map position, display mode, label visibility, sidebar state, gallery settings, and window size are restored after restarting. Date and search filters start fresh.

## Media support

- Photos: JPEG, HEIC/HEIF, PNG, TIFF, WebP.
- Videos: MP4, MOV, M4V, AVI, MKV, WebM, with recognized ISO 6709 location metadata.
- HEIC decoding is bundled, including on platforms where Sharp's native image library cannot decode HEVC.
- Video thumbnails use bundled FFmpeg. In-app playback depends on Electron's supported codecs; **Open original** is always available as a fallback.
- Esri imagery and labels require internet. Cached media browsing works offline.

## Faster by design

- A streaming directory walker avoids building a second complete file list before processing begins.
- One or two background workers process media, leaving CPU capacity for browsing; Sharp and FFmpeg decoding use one native thread per worker. File operations and pending jobs are bounded.
- Unchanged files are skipped using size, modification time, cache version, and thumbnail integrity. Missing or corrupt thumbnails regenerate on access or rescan, and corrupt full previews regenerate when opened. Overlapping source folders are scanned once.
- Scanning produces thumbnails that fit within 320 × 320 while preserving the full image and its aspect ratio. Gallery cards show the whole thumbnail; map photo pins use square crops. Larger previews are generated when opened, with at most one neighboring preview being prefetched at a time in a separate worker. The viewer retains up to five decoded standard previews; original-resolution images load only when zooming.
- Scan updates are batched. Filtering, sorting, date bounds, and spatial indexing run in Web Workers. Map rebuilding pauses while browsing the gallery. Visible clusters retain their own index until their replacement is displayed.
- The gallery renders only visible rows and a small buffer. A 10,000-item UI test verifies fewer than 60 cards are mounted at a 1440 × 960 viewport.
- Atomic, serialized JSON checkpoints write in small batches to keep desktop controls responsive and prevent overlapping saves from overwriting newer library state. Disconnected source folders retain their cached records.

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

Version 2 keeps the `photo-map` application data directory and reads the original `photo-map-cache/config.json` and `metadata.json` files. Cached photos and configured folders load immediately. On startup, a missing or outdated per-entry cache version automatically starts a background rescan to regenerate thumbnails and refresh metadata. Cached photos remain browsable while this runs; disconnected drives retain their cached entries and are retried on a later startup. Subsequent scans skip unchanged successful entries at the current version. Corrupt metadata is reported instead of silently replaced.

## License

MIT. Third-party components retain their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
