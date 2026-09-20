'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
delete process.env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, '.')], {
  stdio: 'inherit',
  env: { ...process.env },
});
child.on('error', (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
