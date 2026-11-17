import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {Refusal} from './contracts.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 65535;
const MAX_RAW_BYTES = 128 * 1024 * 1024;
const STROKE = 3;
const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/;

type ColorType = 2 | 6;

type DecodedPng = {
  width: number;
  height: number;
  colorType: ColorType;
  pixels: Buffer;
};

export function captureProof(fileName: string): string {
  if (typeof fileName !== 'string' || !isSafeCaptureName(fileName)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  return `capturas/${fileName}`;
}

function isSafeCaptureName(fileName: string): boolean {
  if (fileName.length === 0 || fileName.length > 160) return false;
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return false;
  return CAPTURE_NAME.test(fileName);
}

function bytesPerPixel(colorType: ColorType): number {
  return colorType === 6 ? 4 : 3;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function assertChunkType(type: string): void {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Refusal('DESIGN_MARK_INVALID', 400);
}

function readChunk(png: Buffer, offset: number): {type: string; data: Buffer; next: number} {
  if (offset < 0 || offset + 8 > png.length) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const length = png.readUInt32BE(offset);
  if (length > png.length - offset - 12) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const type = png.toString('ascii', offset + 4, offset + 8);
  assertChunkType(type);
  const dataStart = offset + 8;
  const next = dataStart + length + 4;
  const actual = crc32(png.subarray(offset + 4, dataStart + length)) >>> 0;
  const expected = png.readUInt32BE(dataStart + length);
  if (actual !== expected) throw new Refusal('DESIGN_MARK_INVALID', 400);
  return {type, data: png.subarray(dataStart, dataStart + length), next};
}

function colorTypeOf(value: number): ColorType {
  if (value === 2 || value === 6) return value;
  throw new Refusal('DESIGN_MARK_INVALID', 400);
}

function isCritical(type: string): boolean {
  const first = type.charCodeAt(0);
  return first >= 65 && first <= 90;
}

function unfilter(data: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  if (data.length !== height * rowBytes) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * rowBytes];
    if (filter > 4) throw new Refusal('DESIGN_MARK_INVALID', 400);
    const source = y * rowBytes + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? pixels[target + x - bpp] : 0;
      const up = y > 0 ? pixels[target - stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? pixels[target - stride + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = Math.floor((left + up) / 2);
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      pixels[target + x] = (data[source + x] + predicted) & 0xff;
    }
  }
  return pixels;
}

function decodePng(png: Buffer): DecodedPng {
  if (!Buffer.isBuffer(png) || png.length < PNG_SIGNATURE.length + 12) throw new Refusal('DESIGN_MARK_INVALID', 400);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const first = readChunk(png, PNG_SIGNATURE.length);
  if (first.type !== 'IHDR' || first.data.length !== 13) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const width = first.data.readUInt32BE(0);
  const height = first.data.readUInt32BE(4);
  const bitDepth = first.data[8];
  const colorType = colorTypeOf(first.data[9]);
  const compression = first.data[10];
  const filterMethod = first.data[11];
  const interlace = first.data[12];
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) throw new Refusal('DESIGN_MARK_INVALID', 400);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const bpp = bytesPerPixel(colorType);
  const rawBytes = height * (width * bpp + 1);
  if (!Number.isSafeInteger(rawBytes) || rawBytes <= 0 || rawBytes > MAX_RAW_BYTES) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const idat: Buffer[] = [];
  let idatStarted = false;
  let idatClosed = false;
  let sawEnd = false;
  let offset = first.next;
  while (offset < png.length) {
    const chunk = readChunk(png, offset);
    if (chunk.type === 'IHDR') throw new Refusal('DESIGN_MARK_INVALID', 400);
    if (chunk.type === 'IDAT') {
      if (idatClosed) throw new Refusal('DESIGN_MARK_INVALID', 400);
      idatStarted = true;
      idat.push(chunk.data);
    } else if (chunk.type === 'IEND') {
      sawEnd = true;
      break;
    } else if (idatStarted) {
      idatClosed = true;
      if (isCritical(chunk.type)) throw new Refusal('DESIGN_MARK_INVALID', 400);
    } else if (isCritical(chunk.type) && chunk.type !== 'PLTE') {
      throw new Refusal('DESIGN_MARK_INVALID', 400);
    }
    offset = chunk.next;
  }
  if (!sawEnd || !idatStarted) throw new Refusal('DESIGN_MARK_INVALID', 400);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    throw new Refusal('DESIGN_MARK_INVALID', 400);
  }
  return {width, height, colorType, pixels: unfilter(inflated, width, height, bpp)};
}

function encodePng(image: DecodedPng): Buffer {
  const bpp = bytesPerPixel(image.colorType);
  const stride = image.width * bpp;
  if (image.pixels.length !== image.height * stride) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = image.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  let compressed: Buffer;
  try {
    compressed = deflateSync(raw);
  } catch {
    throw new Refusal('DESIGN_MARK_INVALID', 400);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function assertRectInt(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Refusal('DESIGN_MARK_INVALID', 400);
  return value;
}

function paintRect(image: DecodedPng, rect: {x: number; y: number; width: number; height: number}): void {
  const x0 = assertRectInt(rect.x, -MAX_DIMENSION, MAX_DIMENSION);
  const y0 = assertRectInt(rect.y, -MAX_DIMENSION, MAX_DIMENSION);
  const rectWidth = assertRectInt(rect.width, 1, MAX_DIMENSION);
  const rectHeight = assertRectInt(rect.height, 1, MAX_DIMENSION);
  const x1 = x0 + rectWidth;
  const y1 = y0 + rectHeight;
  if (!Number.isSafeInteger(x1) || !Number.isSafeInteger(y1)) throw new Refusal('DESIGN_MARK_INVALID', 400);
  const bpp = bytesPerPixel(image.colorType);
  const drawLeft = Math.max(0, x0);
  const drawTop = Math.max(0, y0);
  const drawRight = Math.min(image.width, x1);
  const drawBottom = Math.min(image.height, y1);
  for (let y = drawTop; y < drawBottom; y += 1) {
    const top = y - y0;
    const bottom = y1 - 1 - y;
    for (let x = drawLeft; x < drawRight; x += 1) {
      const left = x - x0;
      const right = x1 - 1 - x;
      if (left >= STROKE && right >= STROKE && top >= STROKE && bottom >= STROKE) continue;
      const offset = (y * image.width + x) * bpp;
      image.pixels[offset] = 255;
      image.pixels[offset + 1] = 0;
      image.pixels[offset + 2] = 0;
      if (bpp === 4) image.pixels[offset + 3] = 255;
    }
  }
}

export function markPngRect(png: Buffer, rect: {x: number; y: number; width: number; height: number}): Buffer {
  if (!Buffer.isBuffer(png) || rect === null || typeof rect !== 'object') throw new Refusal('DESIGN_MARK_INVALID', 400);
  try {
    const image = decodePng(png);
    paintRect(image, rect);
    return encodePng(image);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('DESIGN_MARK_INVALID', 400);
  }
}
