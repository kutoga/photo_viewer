/**
 * Launcher script that clears ELECTRON_RUN_AS_NODE before spawning Electron.
 * VS Code's terminal sets ELECTRON_RUN_AS_NODE=1 which disables Electron's API.
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require('child_process');
const electron = require('electron');

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('close', (code) => process.exit(code));
