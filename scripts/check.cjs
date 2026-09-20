'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const folder of ['.', 'lib', 'renderer', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(folder))
    if (/\.(?:js|cjs)$/.test(file))
      execFileSync(process.execPath, ['--check', path.join(folder, file)], { stdio: 'inherit' });
}
console.log('All JavaScript syntax checks passed.');
