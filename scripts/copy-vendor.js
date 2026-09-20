'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dest = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(dest, { recursive: true });
for (const [pkg, file, name] of [
  ['leaflet', 'dist/leaflet.js', 'leaflet.js'],
  ['leaflet', 'dist/leaflet.css', 'leaflet.css'],
  ['leaflet.heat', 'dist/leaflet-heat.js', 'leaflet-heat.js'],
  ['supercluster', 'dist/supercluster.js', 'supercluster.js'],
])
  fs.copyFileSync(path.join(root, 'node_modules', pkg, file), path.join(dest, name));
fs.cpSync(path.join(root, 'node_modules/leaflet/dist/images'), path.join(dest, 'images'), {
  recursive: true,
});
console.log('Local map libraries ready.');
