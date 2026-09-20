'use strict';
const fs = require('node:fs/promises');
const sharp = require('sharp');
// Validate each file once per filesystem revision; native decoding runs off the JS thread.
const checked = new Map();
async function validImage(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.size) return false;
    const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (checked.get(file) === stamp) return true;
    await sharp(file, { failOn: 'warning' }).raw().toBuffer();
    checked.delete(file);
    checked.set(file, stamp);
    if (checked.size > 2000) checked.delete(checked.keys().next().value);
    return true;
  } catch {
    checked.delete(file);
    return false;
  }
}
module.exports = { validImage };
