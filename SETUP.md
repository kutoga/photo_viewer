# Photo Map — Setup Guide

## 1. Install Node.js

Download and install Node.js from https://nodejs.org
Choose the **LTS** version (e.g. 20.x or 22.x). The installer adds `node` and `npm` to your PATH automatically. Restart your terminal after installing.

Verify:
```
node --version   # should print v20.x.x or similar
npm --version
```

## 2. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

This will:
- Install Electron, exifr, sharp, supercluster, leaflet
- Automatically rebuild `sharp` against Electron's Node.js ABI (`electron-rebuild`)
- Copy vendor JS/CSS files into `renderer/vendor/`
- Download `leaflet-heat.js` from GitHub

> **Note:** `npm install` may take 2–5 minutes the first time because it downloads Electron (~100 MB) and prebuilt `sharp` binaries.

## 3. Run the app

```
npm start
```

A window will open showing a satellite world map.

## 4. Using the app

1. Click **"Choose folder"** → select a folder containing JPEG/HEIC/PNG photos with GPS data
2. The app scans in the background — a progress bar shows the status
3. After scanning, the map flies to your photos

**Map modes by zoom:**
- Zoomed out (zoom < 8): **Heatmap** showing photo density
- Medium zoom (8–12): **Cluster bubbles** with photo count; click to zoom in
- Zoomed in (≥ 13): **Individual photo thumbnails** on the map; click to open full preview

## 5. Cache location

Downscaled photo copies are stored in:
```
C:\Users\<you>\AppData\Roaming\photo-map\photo-map-cache\
```

Previously scanned photos are remembered — restarting the app reloads them instantly without re-scanning.
