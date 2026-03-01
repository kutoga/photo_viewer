/**
 * Copies vendor files from node_modules to renderer/vendor/
 * and downloads leaflet-heat.js from GitHub.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'renderer', 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

function copy(src, dest) {
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${path.basename(dest)}`);
}

// Leaflet
copy(
  path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet.js'),
  path.join(vendorDir, 'leaflet.js')
);
copy(
  path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet.css'),
  path.join(vendorDir, 'leaflet.css')
);

// Supercluster
copy(
  path.join(root, 'node_modules', 'supercluster', 'dist', 'supercluster.js'),
  path.join(vendorDir, 'supercluster.js')
);

// Leaflet.heat — download from GitHub if not already present
const heatDest = path.join(vendorDir, 'leaflet-heat.js');
if (fs.existsSync(heatDest)) {
  console.log('leaflet-heat.js already exists, skipping download.');
  process.exit(0);
}

const url = 'https://raw.githubusercontent.com/Leaflet/Leaflet.heat/gh-pages/dist/leaflet-heat.js';
console.log('Downloading leaflet-heat.js...');

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to download leaflet-heat.js: HTTP ${res.statusCode}`);
    process.exit(1);
  }
  const file = fs.createWriteStream(heatDest);
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log('Downloaded: leaflet-heat.js');
  });
}).on('error', (err) => {
  console.error('Download error:', err.message);
  process.exit(1);
});
