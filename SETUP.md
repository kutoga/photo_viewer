# Setup and distribution

## Windows

Development requires Node.js 24 LTS and Windows 10 or 11, 64-bit.

```powershell
npm ci
npm start
```

`start.bat` changes into the project directory before launching, so it also works when double-clicked. Dependencies include prebuilt image libraries and FFmpeg; no separate compiler or codec installation is required for JPEG/HEIC thumbnails.

Build on Windows:

```powershell
npm run build:win
```

Outputs:

- `dist/Photo Map Setup 2.0.1.exe`: per-user installer with a destination picker and desktop shortcut.
- `dist/Photo Map 2.0.1.exe`: portable launcher; application data still lives in the user's profile.

No Node installation is needed to run these executables. Builds are unsigned unless a signing certificate is configured in electron-builder; Windows may display its usual reputation prompt for an unsigned download.

## Linux

Use a current x64 desktop distribution supported by Electron, such as Ubuntu 24.04 or newer, with Node.js 24 LTS for development.

```sh
npm ci
npm start
# or ./start.sh
```

Build on Linux:

```sh
npm run build:linux
```

Run the AppImage:

```sh
chmod +x 'dist/Photo Map-2.0.1.AppImage'
'./dist/Photo Map-2.0.1.AppImage'
```

If the distribution does not have FUSE 2 support, use the AppImage's `--appimage-extract-and-run` option, or install the Debian package:

```sh
sudo apt install ./dist/photo-map_2.0.1_amd64.deb
```

The Debian package declares desktop runtime dependencies and installs a launcher/icon. On Ubuntu versions restricting unprivileged user namespaces, prefer the installed package and its Electron sandbox configuration. The production launcher does not disable Chromium's sandbox.

## Tests on a headless Linux machine

```sh
npx playwright install --with-deps chromium
npm test
npm run test:ui
xvfb-run -a npm run test:desktop
```

Some isolated CI hosts restrict Chromium's sandbox. For those test hosts only, set `PHOTO_MAP_TEST_NO_SANDBOX=1` when running the desktop smoke test. This variable is consumed by the test script, not the production application.

To test a packaged app, set `PHOTO_MAP_EXECUTABLE` to `dist/linux-unpacked/photo-map` or `dist/win-unpacked/Photo Map.exe`, using an absolute path. The test always uses a temporary library and never your real photos.

## Application data

- Windows: `%APPDATA%\photo-map\photo-map-cache\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/photo-map/photo-map-cache/`

The directory contains `config.json`, `metadata.json`, `thumbnails/`, and `previews/`. Keep the metadata/config together when backing up. Originals remain in their source folders.

`PHOTO_MAP_USER_DATA` overrides the application-data directory for isolated testing. A single-instance lock prevents concurrent application instances from writing the same library.

## Troubleshooting

- **No photos on the map:** the files must contain GPS coordinates. Check the count of files without GPS in the sidebar.
- **Disconnected drive:** reconnect it and rescan. Cached records are retained when a folder cannot be read.
- **No map imagery:** check the connection and click Retry. Gallery and local previews still work.
- **Unsupported video playback:** use Open original. FFmpeg can often generate thumbnails for formats the embedded player cannot play.
- **A scan reports unreadable files:** check drive permissions, reconnect external sources, and rescan. Failed items are retried.
- **Dependency download fails:** rerun `npm ci` with network access. Runtime binaries are downloaded for the host OS; install/build separately on Windows and Linux instead of copying `node_modules` between them.
