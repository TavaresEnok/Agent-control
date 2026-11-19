import {PNG} from 'pngjs';

const maxPngBytes = 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

export function staticPngSize(bytes) {
  if (bytes.length < 33 || bytes.length > maxPngBytes || !bytes.subarray(0, 8).equals(pngSignature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes[28] !== 0) return;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 1600 || height > 1600 || width * height > 1440000) return;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length || type === 'acTL') return;
    if (type === 'IEND' && offset === bytes.length) return {width, height};
  }
}

export function compatibleReference(metadata, profile) {
  return Object.entries(profile).every(([key, value]) => metadata?.[key] === value);
}

export function compareVisualPng(expected, actual, {width, height}) {
  for (const png of [expected, actual]) {
    const size = staticPngSize(png);
    if (size?.width !== width || size?.height !== height) throw new Error('QA_VISUAL_PNG_INCOMPATIBLE');
  }
  const reference = PNG.sync.read(expected).data;
  const capture = PNG.sync.read(actual).data;
  let changed = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    if (reference.readUInt32BE(offset) === capture.readUInt32BE(offset)) continue;
    changed++;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {changed, total: width * height, bounds: changed ? `${left},${top}–${right},${bottom}` : null};
}
