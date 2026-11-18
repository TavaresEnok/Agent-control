import assert from 'node:assert/strict';
import {test} from 'node:test';
import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {Refusal} from '../src/contracts.ts';
import {captureProof, markPngRect} from '../src/design-mark.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function refused(code: string) {
  return (error: unknown) => error instanceof Refusal && error.code === code;
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

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function encodePng(width: number, height: number, colorType: 2 | 6, pixels: Buffer, filter: 0 | 1 | 2 | 3 | 4): Buffer {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  assert.equal(pixels.length, height * stride);
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x];
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = Math.floor((left + up) / 2);
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gradient(width: number, height: number, bpp: number, alpha: number | null): Buffer {
  const pixels = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = (y * width + x) * bpp;
      pixels[start] = (x * 3 + y * 5) & 0xff;
      pixels[start + 1] = 40;
      pixels[start + 2] = 90;
      if (alpha !== null) pixels[start + 3] = alpha;
    }
  }
  return pixels;
}

type Raster = {width: number; height: number; bpp: number; pixels: Buffer};

function pixelsOf(png: Buffer): Raster {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const expected = png.readUInt32BE(offset + 8 + length);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0, expected, type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[12], 0);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  assert.equal(ended, true);
  const inflated = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    assert.equal(inflated[y * (stride + 1)], 0);
    inflated.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return {width, height, bpp, pixels};
}

function pixel(image: Raster, x: number, y: number): number[] {
  const start = (y * image.width + x) * image.bpp;
  return [...image.pixels.subarray(start, start + image.bpp)];
}

function original(pixels: Buffer, width: number, bpp: number, x: number, y: number): number[] {
  const start = (y * width + x) * bpp;
  return [...pixels.subarray(start, start + bpp)];
}

test('desenha retângulo vermelho de 3 px em PNG RGB sem entrelaçar', () => {
  const width = 30;
  const height = 20;
  const pixels = gradient(width, height, 3, null);
  const png = encodePng(width, height, 2, pixels, 4);
  const before = Buffer.from(png);
  const rect = {x: 5, y: 4, width: 18, height: 12};
  const marked = markPngRect(png, rect);
  assert.deepEqual(png, before);
  const image = pixelsOf(marked);
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.equal(image.bpp, 3);
  const red = [255, 0, 0];
  assert.deepEqual(pixel(image, 5, 4), red);
  assert.deepEqual(pixel(image, 7, 10), red);
  assert.deepEqual(pixel(image, 22, 10), red);
  assert.deepEqual(pixel(image, 12, 6), red);
  assert.deepEqual(pixel(image, 12, 13), red);
  assert.deepEqual(pixel(image, 8, 10), original(pixels, width, 3, 8, 10));
  assert.deepEqual(pixel(image, 19, 10), original(pixels, width, 3, 19, 10));
  assert.deepEqual(pixel(image, 12, 7), original(pixels, width, 3, 12, 7));
  assert.deepEqual(pixel(image, 12, 12), original(pixels, width, 3, 12, 12));
  assert.deepEqual(pixel(image, 0, 0), original(pixels, width, 3, 0, 0));
  assert.deepEqual(pixel(image, 29, 19), original(pixels, width, 3, 29, 19));
  assert.equal(image.pixels.includes(255), true);
});

test('desenha a borda em PNG RGBA e preserva o miolo', () => {
  const width = 20;
  const height = 16;
  const pixels = gradient(width, height, 4, 180);
  const png = encodePng(width, height, 6, pixels, 2);
  const marked = markPngRect(png, {x: 2, y: 2, width: 14, height: 12});
  const image = pixelsOf(marked);
  assert.equal(image.bpp, 4);
  assert.deepEqual(pixel(image, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 4, 8), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 10, 4), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 8, 8), original(pixels, width, 4, 8, 8));
  assert.equal(pixel(image, 8, 8)[3], 180);
  assert.deepEqual(pixel(image, 0, 0), original(pixels, width, 4, 0, 0));
  const again = pixelsOf(markPngRect(marked, {x: 2, y: 2, width: 14, height: 12}));
  assert.deepEqual(pixel(again, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(again, 8, 8), original(pixels, width, 4, 8, 8));
});

test('recusa PNG inválido e nome de captura inseguro', () => {
  const pixels = gradient(4, 4, 3, null);
  const png = encodePng(4, 4, 2, pixels, 0);
  assert.throws(() => markPngRect(Buffer.from('nao-png'), {x: 0, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.throws(() => markPngRect(Buffer.alloc(0), {x: 0, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.throws(() => markPngRect(png, {x: 0, y: 0, width: 0, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.throws(() => markPngRect(png, {x: 1.5, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  const patchIhdr = (source: Buffer, index: number, value: number): Buffer => {
    const copy = Buffer.from(source);
    const dataStart = PNG_SIGNATURE.length + 8;
    copy[dataStart + index] = value;
    const checksum = crc32(copy.subarray(PNG_SIGNATURE.length + 4, dataStart + 13)) >>> 0;
    copy.writeUInt32BE(checksum, dataStart + 13);
    return copy;
  };
  assert.throws(() => markPngRect(patchIhdr(png, 12, 1), {x: 0, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.throws(() => markPngRect(patchIhdr(png, 8, 16), {x: 0, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.throws(() => markPngRect(patchIhdr(png, 9, 3), {x: 0, y: 0, width: 1, height: 1}), refused('DESIGN_MARK_INVALID'));
  assert.equal(captureProof('tela-375.png'), 'capturas/tela-375.png');
  assert.equal(captureProof('A.b-1.png'), 'capturas/A.b-1.png');
  for (const name of ['../x.png', 'a/b.png', 'a..b.png', '..png', '.png', 'sem-extensao', '']) {
    assert.throws(() => captureProof(name), refused('DESIGN_PATH_FORBIDDEN'), name);
  }
});
