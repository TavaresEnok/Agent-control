import {
  DESIGN_FIXED_WIDTH_PX,
  DESIGN_GRAY_MIN,
  DESIGN_OFFSCALE_SPACING_MIN,
  DESIGN_PLANTED_RULES,
  designRawFinding,
  type DesignRawFinding,
} from './design-types.ts';

/** Cores, fontes, tamanhos, espaçamentos, raios e sombras vistos no CSS. */
export type DesignInventory = {
  colors: string[];
  grays: string[];
  fontFamilies: string[];
  fontSizes: string[];
  spacings: string[];
  offScaleSpacings: string[];
  radii: string[];
  shadows: string[];
};

export type DesignComputedSample = {
  selector: string;
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: string;
  margin?: string;
  padding?: string;
  gap?: string;
  borderRadius?: string;
  boxShadow?: string;
};

type Rgb = {r: number; g: number; b: number; a: number};

type Decl = {prop: string; value: string; line: number; index: number};

type WidthHit = {prop: string; px: number; line: number};

type CutHit = {line: number; via: string};

type InventoryBuilder = {
  colors: string[];
  grays: string[];
  fontFamilies: string[];
  fontSizes: string[];
  spacings: string[];
  offScaleSpacings: string[];
  radii: string[];
  shadows: string[];
  seenColor: Set<string>;
  seenGray: Set<string>;
  seenFont: Set<string>;
  seenSize: Set<string>;
  seenSpacing: Set<string>;
  seenOff: Set<string>;
  seenRadius: Set<string>;
  seenShadow: Set<string>;
  grayLine: number | null;
  spacingLine: number | null;
  widths: WidthHit[];
  cuts: CutHit[];
};

const SPACING_PROPS = new Set([
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-block-start', 'margin-block-end',
  'margin-inline', 'margin-inline-start', 'margin-inline-end',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap',
]);

const ANALYZER_META = new Set([
  'total', 'totalUnique', 'uniquenessRatio', 'unique', 'itemsPerContext', 'ratio',
  'formats', 'prefixed', 'complexity', 'min', 'max', 'mean', 'mode', 'range', 'sum', 'items',
]);

/** Nomes estáveis. Branco, preto e azul ficam de fora da régua de cinza pelo canal. */
const NAMED_HEX: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  dimgray: '#696969',
  dimgrey: '#696969',
  gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5',
  red: '#ff0000',
  maroon: '#800000',
  yellow: '#ffff00',
  olive: '#808000',
  lime: '#00ff00',
  green: '#008000',
  aqua: '#00ffff',
  cyan: '#00ffff',
  teal: '#008080',
  blue: '#0000ff',
  navy: '#000080',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  purple: '#800080',
  orange: '#ffa500',
  rebeccapurple: '#663399',
};

function createBuilder(): InventoryBuilder {
  return {
    colors: [],
    grays: [],
    fontFamilies: [],
    fontSizes: [],
    spacings: [],
    offScaleSpacings: [],
    radii: [],
    shadows: [],
    seenColor: new Set(),
    seenGray: new Set(),
    seenFont: new Set(),
    seenSize: new Set(),
    seenSpacing: new Set(),
    seenOff: new Set(),
    seenRadius: new Set(),
    seenShadow: new Set(),
    grayLine: null,
    spacingLine: null,
    widths: [],
    cuts: [],
  };
}

function toInventory(builder: InventoryBuilder): DesignInventory {
  return {
    colors: builder.colors,
    grays: builder.grays,
    fontFamilies: builder.fontFamilies,
    fontSizes: builder.fontSizes,
    spacings: builder.spacings,
    offScaleSpacings: builder.offScaleSpacings,
    radii: builder.radii,
    shadows: builder.shadows,
  };
}

function pushUnique(list: string[], seen: Set<string>, value: string): boolean {
  if (value.length === 0 || seen.has(value)) return false;
  seen.add(value);
  list.push(value);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blankExceptNewlines(text: string): string {
  let out = '';
  for (const ch of text) out += ch === '\n' ? '\n' : ' ';
  return out;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, blankExceptNewlines);
}

/** O prelúdio de @media não é declaração. min-width ali não quebra a tela de 375. */
function stripAtRulePreludes(css: string): string {
  return css.replace(/@[a-zA-Z-]+[^{;]*/g, blankExceptNewlines);
}

function lineAt(css: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(index, 0), css.length);
  for (let i = 0; i < end; i += 1) if (css[i] === '\n') line += 1;
  return line;
}

function skipString(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i += 1;
  }
  return css.length;
}

type BraceRange = {open: number; close: number};

function braceRanges(css: string): BraceRange[] {
  const ranges: BraceRange[] = [];
  const stack: number[] = [];
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length > 0) {
      const open = stack.pop();
      if (open !== undefined) ranges.push({open, close: i});
    }
    i += 1;
  }
  ranges.sort((a, b) => a.open - b.open);
  return ranges;
}

function directBody(css: string, range: BraceRange, ranges: readonly BraceRange[]): string {
  let body = css.slice(range.open + 1, range.close);
  const start = range.open + 1;
  for (const inner of ranges) {
    if (inner.open <= range.open || inner.close >= range.close) continue;
    const from = inner.open - start;
    const to = inner.close - start;
    if (from < 0 || to < from || to >= body.length) continue;
    let masked = '';
    for (let index = from; index <= to; index += 1) masked += body[index] === '\n' ? '\n' : ' ';
    body = body.slice(0, from) + masked + body.slice(to + 1);
  }
  return body;
}

function splitStatements(body: string): {text: string; offset: number}[] {
  const parts: {text: string; offset: number}[] = [];
  let start = 0;
  let paren = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (ch === ';' && paren === 0) {
      parts.push({text: body.slice(start, i), offset: start});
      start = i + 1;
    }
  }
  parts.push({text: body.slice(start), offset: start});
  return parts;
}

function declarationsIn(css: string, body: string, bodyStart: number): Decl[] {
  const decls: Decl[] = [];
  for (const part of splitStatements(body)) {
    const match = /^\s*(-{0,2}[A-Za-z_][\w-]*)\s*:\s*([\s\S]*)$/.exec(part.text);
    const prop = match?.[1];
    const value = match?.[2];
    if (!match || prop === undefined || value === undefined) continue;
    const lead = part.text.length - part.text.trimStart().length;
    const index = bodyStart + part.offset + lead;
    decls.push({prop: prop.toLowerCase(), value: value.trim(), line: lineAt(css, index), index});
  }
  return decls;
}

function channelHex(n: number): string {
  const value = Math.max(0, Math.min(255, Math.round(n)));
  return value.toString(16).padStart(2, '0');
}

function canonicalColor(rgb: Rgb): string {
  const base = `#${channelHex(rgb.r)}${channelHex(rgb.g)}${channelHex(rgb.b)}`;
  if (rgb.a >= 0.999) return base;
  return `${base}${channelHex(rgb.a * 255)}`;
}

function grayKey(rgb: Rgb): string {
  return `#${channelHex(rgb.r)}${channelHex(rgb.g)}${channelHex(rgb.b)}`;
}

/**
 * Cinza: R, G e B entre 16 e 239 (inclusive) e max(R,G,B)-min(R,G,B) <= 8.
 * Alfa menor que 0.5 não entra: sombra translúcida não é token de cinza.
 * Branco (255), preto (0) e azul ficam de fora por esse intervalo.
 */
function isGray(rgb: Rgb): boolean {
  if (rgb.a < 0.5) return false;
  const r = Math.round(rgb.r);
  const g = Math.round(rgb.g);
  const b = Math.round(rgb.b);
  if (r < 16 || r > 239 || g < 16 || g > 239 || b < 16 || b > 239) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, '');
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null;
  const expand = (digit: string) => digit.length === 1 ? `${digit}${digit}` : digit;
  let r = '';
  let g = '';
  let b = '';
  let a = 'ff';
  if (hex.length <= 4) {
    r = expand(hex[0] ?? '');
    g = expand(hex[1] ?? '');
    b = expand(hex[2] ?? '');
    if (hex.length === 4) a = expand(hex[3] ?? '');
  } else {
    r = hex.slice(0, 2);
    g = hex.slice(2, 4);
    b = hex.slice(4, 6);
    if (hex.length === 8) a = hex.slice(6, 8);
  }
  const red = Number.parseInt(r, 16);
  const green = Number.parseInt(g, 16);
  const blue = Number.parseInt(b, 16);
  const alpha = Number.parseInt(a, 16);
  if (![red, green, blue, alpha].every(part => Number.isFinite(part))) return null;
  return {r: red, g: green, b: blue, a: alpha / 255};
}

function parseChannel(raw: string): number | null {
  const token = raw.trim();
  if (token.endsWith('%')) {
    const percent = Number(token.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return Math.round(Math.max(0, Math.min(100, percent)) * 255 / 100);
  }
  const value = Number(token);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(255, value)));
}

function parseAlpha(raw: string): number | null {
  const token = raw.trim();
  if (token.endsWith('%')) {
    const percent = Number(token.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent)) / 100;
  }
  const value = Number(token);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function parseHue(raw: string): number | null {
  const match = /^(-?(?:\d+\.\d+|\d+|\.\d+))(deg|turn|rad|grad)?$/i.exec(raw.trim());
  const number = match?.[1];
  if (!match || number === undefined) return null;
  const value = Number(number);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? 'deg').toLowerCase();
  if (unit === 'turn') return value * 360;
  if (unit === 'rad') return value * 180 / Math.PI;
  if (unit === 'grad') return value * 0.9;
  return value;
}

function parsePercent(raw: string): number | null {
  const token = raw.trim();
  if (token.endsWith('%')) {
    const percent = Number(token.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return Math.max(0, Math.min(100, percent)) / 100;
  }
  if (Number(token) === 0) return 0;
  return null;
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
    a,
  };
}

function parseColorFunction(input: string): Rgb | null {
  const match = /^(rgba?|hsla?)\(([\s\S]*)\)$/i.exec(input.trim());
  const kindRaw = match?.[1];
  const innerRaw = match?.[2];
  if (!match || kindRaw === undefined || innerRaw === undefined) return null;
  const kind = kindRaw.toLowerCase();
  const inner = innerRaw.trim();
  let alphaRaw: string | null = null;
  let body = inner;
  const slash = inner.indexOf('/');
  if (slash >= 0) {
    body = inner.slice(0, slash).trim();
    alphaRaw = inner.slice(slash + 1).trim();
  }
  let parts: string[];
  if (body.includes(',')) {
    const bits = body.split(',').map(part => part.trim()).filter(part => part.length > 0);
    if (alphaRaw === null && bits.length >= 4) alphaRaw = bits[3] ?? null;
    parts = bits.slice(0, 3);
  } else parts = body.split(/\s+/).filter(part => part.length > 0);
  const first = parts[0];
  const second = parts[1];
  const third = parts[2];
  if (first === undefined || second === undefined || third === undefined) return null;
  const alpha = alphaRaw === null ? 1 : parseAlpha(alphaRaw);
  if (alpha === null) return null;
  if (kind === 'rgb' || kind === 'rgba') {
    const r = parseChannel(first);
    const g = parseChannel(second);
    const b = parseChannel(third);
    if (r === null || g === null || b === null) return null;
    return {r, g, b, a: alpha};
  }
  const h = parseHue(first);
  const s = parsePercent(second);
  const l = parsePercent(third);
  if (h === null || s === null || l === null) return null;
  return hslToRgb(h, s, l, alpha);
}

function parseColorToken(token: string): Rgb | null {
  const trimmed = token.trim();
  if (trimmed.startsWith('#')) return parseHex(trimmed);
  if (/^(?:rgba?|hsla?)\(/i.test(trimmed)) return parseColorFunction(trimmed);
  const named = NAMED_HEX[trimmed.toLowerCase()];
  return named === undefined ? null : parseHex(named);
}

function extractColors(value: string, named: boolean): Rgb[] {
  const found: Rgb[] = [];
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
  for (const match of value.matchAll(hex)) {
    const rgb = parseHex(match[0] ?? '');
    if (rgb) found.push(rgb);
  }
  const fn = /(?:rgba?|hsla?)\([^)]*\)/gi;
  for (const match of value.matchAll(fn)) {
    const rgb = parseColorFunction(match[0] ?? '');
    if (rgb) found.push(rgb);
  }
  if (named) {
    for (const match of value.matchAll(/[a-zA-Z]+/g)) {
      const name = match[0]?.toLowerCase() ?? '';
      const hexName = NAMED_HEX[name];
      if (hexName === undefined) continue;
      const rgb = parseHex(hexName);
      if (rgb) found.push(rgb);
    }
  }
  return found;
}

function isColorProperty(prop: string): boolean {
  if (prop === 'color' || prop === 'background' || prop === 'background-color' || prop === 'background-image') return true;
  if (prop === 'border' || prop === 'outline' || prop === 'box-shadow' || prop === 'text-shadow') return true;
  if (prop === 'fill' || prop === 'stroke' || prop === 'column-rule' || prop === 'text-decoration') return true;
  if (prop.endsWith('-color') || prop.startsWith('border-') || prop.startsWith('outline-')) return true;
  return false;
}

function cleanValue(value: string): string {
  return value.replace(/!important/gi, ' ').replace(/\s+/g, ' ').trim();
}

function formatPx(n: number): string {
  if (n === 0) return '0px';
  const rounded = Math.round(n * 1000) / 1000;
  return `${rounded}px`;
}

/** Zero não entra na régua. Fora da grade: o número em px não é múltiplo de 4. */
function isOffScale(n: number): boolean {
  if (n === 0) return false;
  const mod = Math.abs(n) % 4;
  return mod > 1e-6 && Math.abs(mod - 4) > 1e-6;
}

function spacingNumbers(value: string): number[] {
  const numbers: number[] = [];
  const re = /(-?(?:\d+\.\d+|\d+|\.\d+))(px)?/gi;
  for (const match of value.matchAll(re)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (match[2]) numbers.push(n);
    else if (n === 0) numbers.push(0);
  }
  return numbers;
}

function leadingPx(value: string): number | null {
  const match = /^(-?(?:\d+\.\d+|\d+|\.\d+))px$/i.exec(value.trim());
  const raw = match?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function hasWord(value: string, word: string): boolean {
  return value.toLowerCase().split(/[\s,]+/).includes(word);
}

function splitList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      const item = current.trim();
      if (item.length > 0) parts.push(item);
      current = '';
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function splitCommas(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let paren = 0;
  for (const ch of value) {
    if (ch === '(') paren += 1;
    else if (ch === ')' && paren > 0) paren -= 1;
    else if (ch === ',' && paren === 0) {
      const item = current.trim();
      if (item.length > 0) parts.push(item);
      current = '';
      continue;
    }
    current += ch;
  }
  const last = current.trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function normalizeLength(token: string): string {
  const match = /^(-?(?:\d+\.\d+|\d+|\.\d+))([a-z%]+)$/i.exec(token.trim());
  const raw = match?.[1];
  const unit = match?.[2];
  if (raw === undefined || unit === undefined) return token.trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) return token.trim().toLowerCase();
  const rounded = Math.round(n * 1000) / 1000;
  return `${rounded}${unit.toLowerCase()}`;
}

function addRgb(builder: InventoryBuilder, rgb: Rgb, line: number): void {
  pushUnique(builder.colors, builder.seenColor, canonicalColor(rgb));
  if (!isGray(rgb)) return;
  const key = grayKey(rgb);
  if (builder.seenGray.has(key)) return;
  builder.seenGray.add(key);
  builder.grays.push(key);
  if (builder.grays.length === DESIGN_GRAY_MIN) builder.grayLine = line;
}

function addColorToken(builder: InventoryBuilder, token: string, line: number): void {
  const rgb = parseColorToken(token);
  if (rgb) {
    addRgb(builder, rgb, line);
    return;
  }
  pushUnique(builder.colors, builder.seenColor, cleanValue(token));
}

function addFamily(builder: InventoryBuilder, value: string): void {
  for (const part of splitList(value)) {
    const name = part.trim();
    const lower = name.toLowerCase();
    if (name.length === 0 || lower === 'inherit' || lower === 'initial' || lower === 'unset') continue;
    pushUnique(builder.fontFamilies, builder.seenFont, name);
  }
}

function addSize(builder: InventoryBuilder, value: string): void {
  const label = cleanValue(value).toLowerCase();
  if (label.length === 0 || label === 'inherit' || label === 'initial' || label === 'unset') return;
  pushUnique(builder.fontSizes, builder.seenSize, label);
}

function addRadii(builder: InventoryBuilder, value: string): void {
  const cleaned = cleanValue(value);
  if (cleaned.length === 0 || cleaned.toLowerCase() === 'none') return;
  const re = /-?(?:\d+\.\d+|\d+|\.\d+)(?:px|rem|em|%|pt|vh|vw|ch|ex)|(?<![.\d])0(?![.\d])/gi;
  for (const match of cleaned.matchAll(re)) {
    const token = match[0];
    if (token === undefined) continue;
    pushUnique(builder.radii, builder.seenRadius, token === '0' ? '0px' : normalizeLength(token));
  }
}

function addShadows(builder: InventoryBuilder, value: string): void {
  for (const part of splitCommas(cleanValue(value))) {
    if (part.toLowerCase() === 'none') continue;
    pushUnique(builder.shadows, builder.seenShadow, part.replace(/\s+/g, ' ').trim());
  }
}

function addSpacingNumber(builder: InventoryBuilder, n: number, line: number): void {
  if (!Number.isFinite(n)) return;
  const label = formatPx(n);
  pushUnique(builder.spacings, builder.seenSpacing, label);
  if (!isOffScale(n) || builder.seenOff.has(label)) return;
  builder.seenOff.add(label);
  builder.offScaleSpacings.push(label);
  if (builder.offScaleSpacings.length === DESIGN_OFFSCALE_SPACING_MIN) builder.spacingLine = line;
}

function ingestFontShorthand(builder: InventoryBuilder, value: string): void {
  const match = /(?:^|\s)(\d*\.?\d+(?:px|rem|em|%|pt|vh|vw|ch|ex)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(?:\s*\/\s*\S+)?\s+([\s\S]+)$/i.exec(cleanValue(value));
  const size = match?.[1];
  const family = match?.[2];
  if (size === undefined || family === undefined) return;
  addSize(builder, size);
  addFamily(builder, family);
}

function ingestDeclaration(builder: InventoryBuilder, propRaw: string, valueRaw: string, line: number): void {
  const prop = propRaw.toLowerCase();
  const value = cleanValue(valueRaw);
  if (value.length === 0) return;
  for (const rgb of extractColors(value, isColorProperty(prop))) addRgb(builder, rgb, line);
  if (SPACING_PROPS.has(prop)) {
    for (const n of spacingNumbers(value)) addSpacingNumber(builder, n, line);
  }
  // max-width não conta: a régua só olha width e min-width em px.
  if (prop === 'width' || prop === 'min-width') {
    const px = leadingPx(value);
    if (px !== null && px >= DESIGN_FIXED_WIDTH_PX) builder.widths.push({prop, px, line});
  }
  if (prop === 'font-family') addFamily(builder, value);
  else if (prop === 'font-size') addSize(builder, value);
  else if (prop === 'font') ingestFontShorthand(builder, value);
  if (prop === 'border-radius' || prop.endsWith('-radius')) addRadii(builder, value);
  if (prop === 'box-shadow' || prop === 'text-shadow') addShadows(builder, value);
}

function noteCut(builder: InventoryBuilder, decls: readonly Decl[]): void {
  let overflow: {value: string; line: number} | null = null;
  let nowrap = false;
  let ellipsis = false;
  for (const decl of decls) {
    const value = cleanValue(decl.value).toLowerCase();
    if (decl.prop === 'overflow') overflow = {value, line: decl.line};
    else if (decl.prop === 'white-space') nowrap = hasWord(value, 'nowrap');
    else if (decl.prop === 'text-overflow') ellipsis = hasWord(value, 'ellipsis');
  }
  if (!overflow || !hasWord(overflow.value, 'hidden') || (!nowrap && !ellipsis)) return;
  const via: string[] = [];
  if (nowrap) via.push('white-space: nowrap');
  if (ellipsis) via.push('text-overflow: ellipsis');
  builder.cuts.push({line: overflow.line, via: via.join(' e ')});
}

function analyzeCss(css: string): InventoryBuilder {
  const builder = createBuilder();
  const prepared = stripAtRulePreludes(stripComments(css));
  const ranges = braceRanges(prepared);
  const grouped: Decl[][] = [];
  const all: Decl[] = [];
  for (const range of ranges) {
    const decls = declarationsIn(prepared, directBody(prepared, range, ranges), range.open + 1);
    grouped.push(decls);
    all.push(...decls);
  }
  all.sort((a, b) => a.index - b.index);
  for (const decl of all) ingestDeclaration(builder, decl.prop, decl.value, decl.line);
  for (const decls of grouped) noteCut(builder, decls);
  return builder;
}

function rawFinding(file: string, rule: string, line: number | null, snippet: string): DesignRawFinding {
  return designRawFinding({
    tool: 'inventario',
    rule,
    cwe: null,
    file,
    line,
    severity: 'alta',
    snippet,
  });
}

/** Declarações do CSS, sem comentários e sem prelúdio de @media. Linha de 1 em diante. */
export function cssDeclarations(css: string): {prop: string; value: string; line: number}[] {
  const prepared = stripAtRulePreludes(stripComments(css));
  const ranges = braceRanges(prepared);
  const all: Decl[] = [];
  for (const range of ranges) all.push(...declarationsIn(prepared, directBody(prepared, range, ranges), range.open + 1));
  all.sort((a, b) => a.index - b.index);
  return all.map(decl => ({prop: decl.prop, value: decl.value, line: decl.line}));
}

/** Cores de um valor CSS: hex, rgb(), hsl() e nomes conhecidos. */
export function colorsIn(value: string): {r: number; g: number; b: number; a: number}[] {
  return extractColors(value, true);
}

export function inventoryFromCss(css: string): DesignInventory {
  return toInventory(analyzeCss(css));
}

export function inventoryFromComputed(samples: readonly DesignComputedSample[]): DesignInventory {
  const builder = createBuilder();
  const fields: readonly {key: keyof DesignComputedSample; prop: string}[] = [
    {key: 'color', prop: 'color'},
    {key: 'backgroundColor', prop: 'background-color'},
    {key: 'fontFamily', prop: 'font-family'},
    {key: 'fontSize', prop: 'font-size'},
    {key: 'margin', prop: 'margin'},
    {key: 'padding', prop: 'padding'},
    {key: 'gap', prop: 'gap'},
    {key: 'borderRadius', prop: 'border-radius'},
    {key: 'boxShadow', prop: 'box-shadow'},
  ];
  for (const sample of samples) {
    for (const field of fields) {
      const value = sample[field.key];
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      ingestDeclaration(builder, field.prop, value, 1);
    }
  }
  return toInventory(builder);
}

function dig(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function tokensFromNode(node: unknown): string[] {
  if (typeof node === 'string') return node.trim().length > 0 ? [node.trim()] : [];
  if (Array.isArray(node)) {
    const out: string[] = [];
    for (const item of node) out.push(...tokensFromNode(item));
    return out;
  }
  if (!isRecord(node)) return [];
  if ('unique' in node) return tokensFromNode(node.unique);
  if (typeof node.value === 'string' && Object.keys(node).every(key => key === 'value' || key === 'count' || key === 'locations' || key === '$value')) {
    return [node.value];
  }
  return Object.keys(node).filter(key => !ANALYZER_META.has(key));
}

function readTokens(report: unknown, paths: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const node = dig(report, path);
    if (node !== undefined) out.push(...tokensFromNode(node));
  }
  return out;
}

export function inventoryFromCssAnalyzer(report: unknown): DesignInventory {
  const builder = createBuilder();
  if (!isRecord(report)) return toInventory(builder);
  for (const token of readTokens(report, [['values', 'colors'], ['colors']])) addColorToken(builder, token, 1);
  for (const token of readTokens(report, [['values', 'fontFamilies'], ['fontFamilies'], ['fonts']])) addFamily(builder, token);
  for (const token of readTokens(report, [['values', 'fontSizes'], ['fontSizes']])) addSize(builder, token);
  const shadows = readTokens(report, [
    ['values', 'boxShadows'], ['values', 'textShadows'], ['boxShadows'], ['textShadows'], ['shadows'],
  ]);
  for (const token of shadows) {
    addShadows(builder, token);
    for (const rgb of extractColors(token, true)) addRgb(builder, rgb, 1);
  }
  for (const token of readTokens(report, [['values', 'borderRadiuses'], ['values', 'radii'], ['borderRadiuses'], ['radii']])) {
    addRadii(builder, token);
  }
  for (const token of readTokens(report, [['values', 'spacings'], ['spacings'], ['values', 'spacing'], ['spacing']])) {
    for (const n of spacingNumbers(token)) addSpacingNumber(builder, n, 1);
  }
  return toInventory(builder);
}

export function inventoryFindingsFromCss(file: string, css: string): DesignRawFinding[] {
  const builder = analyzeCss(css);
  const findings: DesignRawFinding[] = [];
  if (builder.grays.length >= DESIGN_GRAY_MIN) {
    findings.push(rawFinding(
      file,
      DESIGN_PLANTED_RULES.grays,
      builder.grayLine,
      `${builder.grays.length} cinzas distintos: ${builder.grays.join(' ')}`,
    ));
  }
  if (builder.offScaleSpacings.length >= DESIGN_OFFSCALE_SPACING_MIN) {
    findings.push(rawFinding(
      file,
      DESIGN_PLANTED_RULES.spacing,
      builder.spacingLine,
      `${builder.offScaleSpacings.length} espaçamentos fora da grade de 4px: ${builder.offScaleSpacings.join(' ')}`,
    ));
  }
  for (const hit of builder.widths) {
    findings.push(rawFinding(file, DESIGN_PLANTED_RULES.narrow, hit.line, `${hit.prop}: ${formatPx(hit.px)}`));
  }
  for (const cut of builder.cuts) {
    findings.push(rawFinding(file, DESIGN_PLANTED_RULES.truncated, cut.line, `overflow: hidden com ${cut.via}`));
  }
  return findings;
}
