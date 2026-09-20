'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.join(__dirname, '..');
const colors = [
  ['#adc6cf', '#7a958d', '#d8cfb3'],
  ['#b7c3c0', '#748282', '#c7b59b'],
  ['#c1b6a8', '#a3aa94', '#cec4a6'],
  ['#8aaaba', '#657a82', '#d7d9d0'],
  ['#bbcfce', '#759589', '#bac7a1'],
  ['#c5ced7', '#a9a2a6', '#e2d7c5'],
];
function landscape(n) {
  const c = colors[n % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${c[0]}"/><stop offset="1" stop-color="#e5e8df"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="${c[0]}"/><stop offset="1" stop-color="#547b85"/></linearGradient></defs><rect width="800" height="600" fill="url(#sky)"/><circle cx="${180 + (n % 4) * 130}" cy="110" r="35" fill="#f3e8cf" opacity=".8"/><path d="M0 310 140 130 260 260 430 90 620 280 750 160 800 190V600H0" fill="${c[1]}"/><path d="m345 180 85-90 84 98-57-18-26 22-28-30-35 27Z" fill="#e1e6de"/><path d="M0 350 190 230 330 310 500 220 680 335 800 275V600H0" fill="${c[2]}"/><path d="M0 410Q220 290 410 410T800 415V600H0" fill="url(#lake)"/><path d="M0 510 130 480 280 545 410 510 550 600H0" fill="#637866"/><path d="m610 600 140-70 50 20v50" fill="#536856"/></svg>`;
}
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/fixture/')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
      res.end(landscape(Number(url.pathname.split('/').pop()) || 0));
      return;
    }
    const file = path.resolve(
      root,
      '.' + decodeURIComponent(url.pathname === '/' ? '/renderer/index.html' : url.pathname),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const data = await fs.readFile(file);
      const mime =
        {
          '.js': 'text/javascript',
          '.html': 'text/html',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
        }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(4173, '127.0.0.1', () => console.log('Test server ready'));
