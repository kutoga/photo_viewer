# Architecture

## Process boundaries

- `main.js`: Electron lifecycle, validated IPC handlers, native dialogs, file-manager actions, and the restricted `media://` protocol. The renderer is sandboxed with context isolation and no Node integration.
- `preload.js`: a narrow, allowlisted API. IPC replies distinguish successful values from errors.
- `lib/library.cjs`: source folders, entry map, streaming scans, cache cleanup, persistence, batched changes, and lazy preview requests.
- `lib/workers.cjs` / `lib/media-worker.cjs`: capped worker-thread pools. Scanning uses at most four workers; previews have a separate single worker and identical requests share a promise.
- `lib/media.cjs`: EXIF/GPS extraction, FFmpeg video metadata/frame extraction, thumbnails, previews, and the lazy HEIC codec fallback.
- `lib/heif.cjs`: bounded HEIF box/extent parsing to compensate for exifr's handling of nonzero Exif base offsets.
- `lib/core.cjs`: path rules, IDs, coordinate validation, atomic writes, and asynchronous directory iteration.
- `renderer/model.js`: pure filtering, sorting, date and viewport operations shared with regression tests.
- `renderer/map.js` / `renderer/map-worker.js`: Leaflet presentation and background Supercluster indexing. Pending rebuilds coalesce to the latest data. Marker layers reuse objects, and the heatmap handles detachment with a redraw pending.
- `renderer/gallery.js`: a windowed grid with keyboard navigation. Only visible rows plus overscan are mounted.
- `renderer/app.js`: UI state, native date inputs/range controls, folder flow, scan feedback, and modal viewing. Viewer navigation uses an independent snapshot so live map updates cannot change its ordering.

## Scanning and persistence

Entries keep version 1's path-derived MD5 IDs for cache compatibility. These are identifiers, not security checks. A source file's size, modification time, and cache version determine whether processing is required. Non-geotagged media is also recorded so it can be skipped on future scans; only geotagged entries are sent to the renderer.

The walker resolves selected folders, removes overlapping traversal roots, skips symlinks, and yields supported files without accumulating the whole tree. At most 12 file tasks are pending. Image decoding and CPU-heavy metadata work run outside Electron's main thread. Each worker limits Sharp to one native thread and a small memory cache.

Scans batch renderer messages at 250 ms intervals; the UI coalesces data/filter updates at 600 ms intervals. Metadata checkpoints run at most once per ten seconds and at scan completion. Writes are serialized and use a temporary file plus rename. An interrupted scan checkpoints completed jobs and skips deletion reconciliation, so unseen files are not mistaken for deletions.

Unavailable roots/subfolders are tracked. Their existing records are preserved during reconciliation. A removed source folder only retires entries not covered by any remaining source. File-path comparisons use Windows case rules on Windows and case-sensitive rules on Linux.

The first v2 rescan refreshes legacy thumbnails. Full previews are not generated until requested. Small previews from a v1 library remain usable until their source is reprocessed.

## Media serving

The `media://` protocol only resolves validated IDs already present in the library. There is no renderer-supplied filesystem path. Cached images are fetched via encoded file URLs, preserving spaces, Unicode, `#`, and Windows drive paths. Original videos use explicit byte-range responses for seeking. Shell actions take entry IDs and resolve their path/location in the main process.

Thumbnails are 320 × 240 JPEGs; photo previews fit inside 1920 × 1920. Video posters are extracted at 1600 pixels wide on demand, with a zero-second fallback for short clips. Original photos are never rewritten. HEIC uses Sharp when supported, then a bundled WASM decoder in the media worker.

## Verification

- Node regression tests: Windows/UNC and Linux path semantics, overlapping roots, deletion, unavailable drives, cancellation, v1 loading, filters, zero-valued GPS, world-wrapped viewports, large date ranges, and actual JPEG/HEIC/video processing.
- Browser tests: first-run flow, scan errors/cancellation, date/media/search filters, live updates, heatmap clearing, 10,000-item virtualization, stable lightbox navigation, cluster browsing, keyboard handling, and 900 × 640 layout.
- Desktop smoke test: real Electron sandbox/preload/IPC, native dialog callback, actual media workers, cache protocol, on-demand previews, bundled HEIC decoding, video loading/seeking, and unchanged rescans. It can run against development or packaged binaries.
- `npm run benchmark`: generates 120 synthetic 4000 × 3000 geotagged JPEGs in a temporary folder and reports initial scan, unchanged rescan, and eager preview counts. One local Linux run completed in 677 ms / 5 ms with four workers and zero eager previews. Synthetic solid/gradient images are easier than real photos; this is a reproducibility check, not a real-library performance guarantee or a before/after comparison.

## Distribution

Native CI jobs install native Sharp and FFmpeg dependencies for Windows x64 and Linux x64. Electron-builder unpacks native libraries and executable helpers outside the ASAR. The Windows job creates NSIS and portable executables; Linux creates AppImage and Debian packages. Artifacts and dependencies are ignored by Git.

For a future library with millions of items, the next step would be a transactional SQLite store and paged metadata transfer. Current JSON storage keeps v1 compatibility and is intentionally simpler; loading and serializing very large catalogs still has an O(n) memory/time cost.
