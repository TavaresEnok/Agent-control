import assert from 'node:assert/strict';
import {test} from 'node:test';
import {apcaLc, compositeRgb, parseCssColor} from '../src/design-color.ts';

const black = {r: 0, g: 0, b: 0};
const white = {r: 255, g: 255, b: 255};
const gray = {r: 128, g: 128, b: 128};
const blackOnWhite = 106.04067321268862;
const whiteOnBlack = -107.88473318309848;
const grayOnWhite = 63.72448153616479;
const oldBlackOnWhite = 98.74067321268862;

test('APCA preto sobre branco fica perto de 106, não do offset 0,1', () => {
  const lc = apcaLc(black, white);
  assert.ok(Math.abs(106 - blackOnWhite) <= 2);
  assert.ok(Math.abs(oldBlackOnWhite - blackOnWhite) > 2);
  assert.ok(Math.abs(lc - blackOnWhite) <= 2, `obtido ${lc}`);
});

test('APCA branco sobre preto fica perto de -108', () => {
  const lc = apcaLc(white, black);
  assert.ok(Math.abs(-108 - whiteOnBlack) <= 2);
  assert.ok(lc < 0, `obtido ${lc}`);
  assert.ok(Math.abs(lc - whiteOnBlack) <= 2, `obtido ${lc}`);
});

test('APCA cinza 128 sobre branco é finito e intermediário', () => {
  const lc = apcaLc(gray, white);
  assert.equal(Number.isFinite(lc), true);
  assert.ok(Math.abs(lc - grayOnWhite) <= 2, `obtido ${lc}`);
  assert.ok(Math.abs(lc - blackOnWhite) > 2);
  assert.ok(Math.abs(lc - whiteOnBlack) > 2);
});

test('rgba(0,0,0,0) tem alfa 0 e não é preto opaco', () => {
  const color = parseCssColor('rgba(0,0,0,0)');
  const opaque = parseCssColor('#000');
  assert.ok(color);
  assert.equal(color.a, 0);
  assert.equal(color.r, 0);
  assert.equal(color.g, 0);
  assert.equal(color.b, 0);
  assert.equal(opaque?.a, 1);
  assert.notDeepEqual(color, opaque);
});

test('hex curto, transparent, barra e #rrggbbaa leem alfa', () => {
  assert.deepEqual(parseCssColor('#0000'), {r: 0, g: 0, b: 0, a: 0});
  assert.deepEqual(parseCssColor('transparent'), {r: 0, g: 0, b: 0, a: 0});
  assert.deepEqual(parseCssColor('rgb(0 0 0 / 0.5)'), {r: 0, g: 0, b: 0, a: 0.5});
  assert.deepEqual(parseCssColor('rgb(0 0 0 / 50%)'), {r: 0, g: 0, b: 0, a: 0.5});
  const hex = parseCssColor('#00000080');
  assert.ok(hex);
  assert.equal(hex.a, 128 / 255);
  assert.ok(Math.abs(hex.a - 0.5) < 0.01);
});

test('#abc e rgb(1, 2, 3) continuam com alfa 1', () => {
  assert.deepEqual(parseCssColor('#abc'), {r: 0xaa, g: 0xbb, b: 0xcc, a: 1});
  assert.deepEqual(parseCssColor('rgb(1, 2, 3)'), {r: 1, g: 2, b: 3, a: 1});
});

test('preto transparente sobre branco opaco compõe branco', () => {
  assert.deepEqual(compositeRgb({r: 0, g: 0, b: 0, a: 0}, {r: 255, g: 255, b: 255, a: 1}), {r: 255, g: 255, b: 255, a: 1});
});
