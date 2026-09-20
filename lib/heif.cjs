'use strict';
// Read HEIF's Exif item when exifr cannot resolve a nonzero iloc base offset.
// All offsets are checked before reading; unsupported fragmented items return null.
function extractHeifExif(buffer) {
  const uint = (offset, size) => {
    if (!size) return 0;
    if (![1, 2, 4, 8].includes(size) || offset < 0 || offset + size > buffer.length)
      throw new Error('Invalid HEIF offset');
    const n = size === 8 ? Number(buffer.readBigUInt64BE(offset)) : buffer.readUIntBE(offset, size);
    if (!Number.isSafeInteger(n)) throw new Error('HEIF offset is too large');
    return n;
  };
  const boxes = (start, end) => {
    const result = [];
    while (start + 8 <= end) {
      let size = uint(start, 4),
        header = 8;
      const type = buffer.toString('ascii', start + 4, start + 8);
      if (size === 1) {
        size = uint(start + 8, 8);
        header = 16;
      }
      if (size === 0) size = end - start;
      if (size < header || start + size > end) break;
      result.push({ type, start: start + header, end: start + size });
      start += size;
    }
    return result;
  };
  try {
    const meta = boxes(0, buffer.length).find((b) => b.type === 'meta');
    if (!meta) return null;
    const children = boxes(meta.start + 4, meta.end);
    const info = children.find((b) => b.type === 'iinf'),
      loc = children.find((b) => b.type === 'iloc');
    if (!info || !loc) return null;
    const infoVersion = uint(info.start, 1);
    const item = boxes(info.start + 4 + (infoVersion === 0 ? 2 : 4), info.end).find((b) => {
      if (b.type !== 'infe') return false;
      const version = uint(b.start, 1),
        idSize = version === 3 ? 4 : 2;
      return (
        version >= 2 &&
        buffer.toString('ascii', b.start + 4 + idSize + 2, b.start + 4 + idSize + 6) === 'Exif'
      );
    });
    if (!item) return null;
    const itemId = uint(item.start + 4, uint(item.start, 1) === 3 ? 4 : 2);
    const version = uint(loc.start, 1);
    if (version > 2) return null;
    let offset = loc.start + 4;
    const sizes = uint(offset++, 1),
      sizes2 = uint(offset++, 1);
    const offsetSize = sizes >> 4,
      lengthSize = sizes & 15,
      baseSize = sizes2 >> 4,
      indexSize = version ? sizes2 & 15 : 0;
    const idSize = version === 2 ? 4 : 2;
    const count = uint(offset, idSize);
    offset += idSize;
    for (let i = 0; i < count && offset < loc.end; i++) {
      const id = uint(offset, idSize);
      offset += idSize;
      const method = version ? uint(offset, 2) & 15 : 0;
      if (version) offset += 2;
      const reference = uint(offset, 2);
      offset += 2;
      const base = uint(offset, baseSize);
      offset += baseSize;
      const extents = uint(offset, 2);
      offset += 2;
      if (id === itemId) {
        if (reference || extents !== 1 || method > 1) return null;
        const itemOffset = uint(offset + indexSize, offsetSize),
          length = uint(offset + indexSize + offsetSize, lengthSize);
        const idat = method === 1 ? children.find((b) => b.type === 'idat')?.start : 0;
        if (idat === undefined) return null;
        const start = idat + base + itemOffset;
        if (length < 12 || start + length > buffer.length) return null;
        const tiff = start + 4 + uint(start, 4);
        if (tiff + 8 > start + length) return null;
        return buffer.subarray(tiff, start + length);
      }
      offset += extents * (indexSize + offsetSize + lengthSize);
    }
  } catch {
    return null;
  }
  return null;
}
module.exports = { extractHeifExif };
