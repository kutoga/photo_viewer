# Third-party components

Photo Map's original application code is MIT licensed. Bundled dependencies keep their own licenses, including the license files installed with their packages.

- [Electron](https://www.electronjs.org/) — MIT; Chromium and related components have additional notices in `LICENSES.chromium.html` beside the packaged executable.
- [Leaflet](https://leafletjs.com/) — BSD-2-Clause.
- [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) — BSD-2-Clause.
- [Supercluster](https://github.com/mapbox/supercluster) — ISC.
- [exifr](https://github.com/MikeKovarik/exifr) — MIT.
- [Sharp](https://sharp.pixelplumbing.com/) — Apache-2.0, with libvips and codec notices distributed with its native packages.
- [heic-decode](https://github.com/catdad-experiments/heic-decode) — ISC. Uses [libheif-js](https://github.com/catdad-experiments/libheif-js), a libheif WebAssembly bundle; retain its included LGPL/license notices when distributing.
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) — GPL-3.0-or-later package. The bundled FFmpeg binary has its own build/license terms; its downloaded `ffmpeg.LICENSE` / `ffmpeg.exe.LICENSE` and README are included in the unpacked package.
- Satellite imagery, road labels, and place labels are provided by Esri ArcGIS Online. The map retains its on-screen attribution. These remote tiles are not bundled with the app.

The tiny `tests/fixtures/location.heic` is an original synthetic solid-color image generated for this repository using Sharp and libheif, with artificial GPS/date metadata. It is covered by the application's MIT license. Browser-test scenery is generated SVG, not user photography.
