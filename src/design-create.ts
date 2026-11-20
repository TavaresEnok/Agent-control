import {chmod, mkdir, open, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {defaultTreeAdapter, html as parse5Html, parse, serialize} from 'parse5';
import type {DefaultTreeAdapterTypes} from 'parse5';
import {Refusal} from './contracts.ts';
import {providerFailureCode, safeFailureCode} from './exam-login.ts';
import type {DesignRawFinding, DesignWorker} from './design-types.ts';
import {DesignWorkerCall} from './design-types.ts';

const SCREEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp)(?:;base64)?,/i;
const DROPPED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'noscript']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'background', 'data', 'ping']);
const HTML_NS = parse5Html.NS.HTML;
export const MAX_CREATE_TASK_CHARS = 100_000;

type DocumentNode = DefaultTreeAdapterTypes.Document;
type ElementNode = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type TemplateNode = DefaultTreeAdapterTypes.Template;
type TextNode = DefaultTreeAdapterTypes.TextNode;

export type CreatedScreen = {name: string; html: string; css: string};

export type CreateBundle = {tokens: Record<string, unknown>; screens: CreatedScreen[]};

export type CreateExamScreen = {
  name: string;
  rejected: boolean;
  findings: DesignRawFinding[];
  visualNotes: string[];
};

export type CreateExam = {screens: CreateExamScreen[]; notes: string[]};

/** The model returned no screens. `causeCode` is a provider code, never the raw sentence. */
export class DesignCreateModelFailure extends Refusal {
  readonly causeCode: string;
  constructor(cause: string) {
    super('DESIGN_CREATE_MODEL_FAILED', 400);
    this.causeCode = safeFailureCode(cause);
  }
}

export type CreateRound = {
  round: number;
  approved: string[];
  rejected: string[];
  notes: string[];
  visualNotes: {name: string; notes: string[]}[];
};

type StoredScreen = {name: string; css: string; fileHtml: string};

type ReworkScreen = {name: string; html: string; findings: readonly DesignRawFinding[]; visualNotes: readonly string[]};

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function isElement(node: ChildNode): node is ElementNode {
  return node.nodeName !== '#text' && node.nodeName !== '#comment' && node.nodeName !== '#documentType';
}

function isTemplate(node: ElementNode): node is TemplateNode {
  return node.tagName === 'template' && 'content' in node;
}

function isText(node: ChildNode): node is TextNode {
  return node.nodeName === '#text';
}

function childElement(parent: ParentNode, tag: string): ElementNode | null {
  for (const child of parent.childNodes) {
    if (isElement(child) && child.tagName.toLowerCase() === tag) return child;
  }
  return null;
}

function readCssChar(css: string, index: number): {value: string; next: number} | null {
  if (index >= css.length) return null;
  const char = css[index] ?? '';
  if (char !== '\\') return {value: char, next: index + 1};
  if (index + 1 >= css.length) return {value: '', next: index + 1};
  const escaped = css[index + 1] ?? '';
  if (escaped === '\n') return {value: '', next: index + 2};
  if (escaped === '\r') return {value: '', next: css[index + 2] === '\n' ? index + 3 : index + 2};
  const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(index + 1));
  if (hex) {
    let cursor = index + 1 + hex[0].length;
    const space = css[cursor];
    if (space === '\r' && css[cursor + 1] === '\n') cursor += 2;
    else if (space === ' ' || space === '\t' || space === '\n' || space === '\r' || space === '\f') cursor += 1;
    const code = Number.parseInt(hex[0], 16);
    const value = code === 0 || code > 0x10ffff ? '\uFFFD' : String.fromCodePoint(code);
    return {value, next: cursor};
  }
  return {value: escaped, next: index + 2};
}

function decodeCssValue(value: string): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    const read = readCssChar(value, index);
    if (!read || read.next <= index) break;
    out += read.value;
    index = read.next;
  }
  return out;
}

function isAllowedFontHref(raw: string): boolean {
  const trimmed = raw.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return FONT_HOSTS.has(host);
}

/** Lista permitida: só URL relativa (sem esquema e sem //), data:image/{png,jpeg,webp}, ou fontes do Google quando permitido. */
function isAllowedUrl(raw: string, options: {allowFontHost: boolean; allowDataImage: boolean}): boolean {
  const trimmed = raw.trim();
  if (options.allowFontHost && isAllowedFontHref(trimmed)) return true;
  const compact = trimmed.replace(/[\u0000-\u0020]+/g, '').replace(/\\/g, '/').toLowerCase();
  if (options.allowDataImage && ALLOWED_DATA_IMAGE.test(compact)) return true;
  if (compact.startsWith('//')) return false;
  return !/^[^/?#]*:/.test(compact);
}

function consumeCssString(css: string, index: number): number {
  const quote = css[index];
  let cursor = index + 1;
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      cursor += cursor + 1 < css.length ? 2 : 1;
      continue;
    }
    if (css[cursor] === quote) return cursor + 1;
    if (css[cursor] === '\n' || css[cursor] === '\r') return cursor;
    cursor += 1;
  }
  return cursor;
}

function precededByIdent(css: string, index: number): boolean {
  if (index === 0) return false;
  const previous = css[index - 1] ?? '';
  if (previous === '\\') return true;
  return /[A-Za-z0-9_-]/.test(previous);
}

function matchKeyword(css: string, index: number, keyword: string): number | null {
  if (precededByIdent(css, index)) return null;
  let cursor = index;
  for (const expected of keyword) {
    const read = readCssChar(css, cursor);
    if (!read || read.value.toLowerCase() !== expected) return null;
    if (read.next <= cursor) return null;
    cursor = read.next;
  }
  return cursor;
}

function startsIdent(css: string, index: number): boolean {
  const read = readCssChar(css, index);
  if (!read || read.value.length === 0) return false;
  return /[A-Za-z0-9_-]/i.test(read.value);
}

function skipCssSpaceAndComments(css: string, start: number): number {
  let index = start;
  while (index < css.length) {
    if (/\s/.test(css[index] ?? '')) {
      index += 1;
      continue;
    }
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return css.length;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function unquoteCssToken(raw: string): string | null {
  const start = skipCssSpaceAndComments(raw, 0);
  if (start >= raw.length) return '';
  const quote = raw[start];
  if (quote === '"' || quote === "'") {
    const end = consumeCssString(raw, start);
    if (end <= start + 1 || raw[end - 1] !== quote) return null;
    const trailing = skipCssSpaceAndComments(raw, end);
    if (trailing < raw.length) return null;
    return decodeCssValue(raw.slice(start + 1, end - 1)).trim();
  }
  let out = '';
  let index = start;
  while (index < raw.length) {
    if (raw.startsWith('/*', index)) {
      const end = raw.indexOf('*/', index + 2);
      if (end === -1) return null;
      index = end + 2;
      continue;
    }
    const ch = raw[index] ?? '';
    if (/\s/.test(ch)) {
      const rest = skipCssSpaceAndComments(raw, index);
      if (rest < raw.length) return null;
      break;
    }
    if (ch === '"' || ch === "'") return null;
    const read = readCssChar(raw, index);
    if (!read || read.next <= index) return null;
    out += read.value;
    index = read.next;
  }
  return out.trim();
}

function endOfUrl(css: string, start: number): number {
  let index = start;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return -1;
      index = end + 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      index = consumeCssString(css, index);
      continue;
    }
    if (css[index] === ')') return index;
    if (css[index] === '\\') {
      index += index + 1 < css.length ? 2 : 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

function endOfParenFunction(css: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return -1;
      index = end + 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      index = consumeCssString(css, index);
      continue;
    }
    if (css[index] === '\\') {
      index += index + 1 < css.length ? 2 : 1;
      continue;
    }
    if (css[index] === '(') depth += 1;
    else if (css[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function endOfImport(css: string, start: number): number {
  let index = start;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      index = consumeCssString(css, index);
      continue;
    }
    const urlAt = matchKeyword(css, index, 'url(');
    if (urlAt !== null) {
      const endParen = endOfUrl(css, urlAt);
      index = endParen === -1 ? css.length : endParen + 1;
      continue;
    }
    if (css[index] === ';' || css[index] === '{' || css[index] === '}') return css[index] === ';' ? index + 1 : index;
    if (css[index] === '\\') {
      index += index + 1 < css.length ? 2 : 1;
      continue;
    }
    index += 1;
  }
  return index;
}

function allCssUrlsAllowed(
  segment: string,
  startIndex: number,
  options: {allowFontHost: boolean; allowDataImage: boolean},
): boolean {
  let index = startIndex;
  while (index < segment.length) {
    if (segment.startsWith('/*', index)) {
      const end = segment.indexOf('*/', index + 2);
      if (end === -1) return false;
      index = end + 2;
      continue;
    }
    if (segment[index] === '"' || segment[index] === "'") {
      const end = consumeCssString(segment, index);
      if (end <= index + 1 || segment[end - 1] !== segment[index]) return false;
      const decoded = decodeCssValue(segment.slice(index + 1, end - 1)).trim();
      if (!isAllowedUrl(decoded, options)) return false;
      index = end;
      continue;
    }
    const urlAt = matchKeyword(segment, index, 'url(');
    if (urlAt !== null) {
      const endParen = endOfUrl(segment, urlAt);
      if (endParen === -1) return false;
      const decoded = unquoteCssToken(segment.slice(urlAt, endParen));
      if (decoded === null || !isAllowedUrl(decoded, options)) return false;
      index = endParen + 1;
      continue;
    }
    if (segment[index] === '\\') {
      index += index + 1 < segment.length ? 2 : 1;
      continue;
    }
    index += 1;
  }
  return true;
}

function isAllowedImportRule(rule: string, allowFontHost: boolean): boolean {
  const importAt = matchKeyword(rule, 0, '@import');
  if (importAt === null) return false;
  const targetStart = skipCssSpaceAndComments(rule, importAt);
  const firstCh = rule[targetStart];
  if (firstCh !== '"' && firstCh !== "'" && matchKeyword(rule, targetStart, 'url(') === null) return false;
  return allCssUrlsAllowed(rule, targetStart, {allowFontHost, allowDataImage: false});
}

function splitTopLevelCssCommas(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  while (index < inner.length) {
    if (inner.startsWith('/*', index)) {
      const end = inner.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 2;
      continue;
    }
    if (inner[index] === '"' || inner[index] === "'") {
      index = consumeCssString(inner, index);
      continue;
    }
    if (inner[index] === '\\') {
      index += index + 1 < inner.length ? 2 : 1;
      continue;
    }
    if (inner[index] === '(') depth += 1;
    else if (inner[index] === ')' && depth > 0) depth -= 1;
    else if (inner[index] === ',' && depth === 0) {
      parts.push(inner.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(inner.slice(start));
  return parts;
}

function sanitizeImageSet(inner: string, prefix: string): {value: string; rejected: boolean} {
  const kept: string[] = [];
  let rejected = false;
  for (const part of splitTopLevelCssCommas(inner)) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    if (allCssUrlsAllowed(candidate, 0, {allowFontHost: false, allowDataImage: true})) kept.push(candidate);
    else rejected = true;
  }
  return {
    value: kept.length > 0 ? `${prefix}${kept.join(', ')})` : 'none',
    rejected: rejected || kept.length === 0,
  };
}

/** parse5 não entra em CSS. Esta varredura aceita só URL relativa, data:image/{png,jpeg,webp} e fontes do Google em @import/@font-face. */
function scanCss(css: string, options: {allowFontRules?: boolean} = {}): {css: string; hasBlockedUrl: boolean} {
  const allowFontRules = options.allowFontRules ?? true;
  let out = '';
  let index = 0;
  let pendingFontFace = false;
  let fontFaceDepth = 0;
  let hasBlockedUrl = false;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return {css: out + css.slice(index), hasBlockedUrl};
      out += css.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (css[index] === '"' || css[index] === "'") {
      const end = consumeCssString(css, index);
      out += css.slice(index, end);
      index = end > index ? end : index + 1;
      continue;
    }
    if (allowFontRules && fontFaceDepth === 0) {
      const fontFaceAt = matchKeyword(css, index, '@font-face');
      if (fontFaceAt !== null && !startsIdent(css, fontFaceAt)) {
        pendingFontFace = true;
        out += css.slice(index, fontFaceAt);
        index = fontFaceAt;
        continue;
      }
    }
    const importAt = matchKeyword(css, index, '@import');
    if (importAt !== null && !startsIdent(css, importAt)) {
      const end = endOfImport(css, importAt);
      if (end <= index) {
        out += css[index] ?? '';
        index += 1;
        continue;
      }
      const rule = css.slice(index, end);
      if (isAllowedImportRule(rule, allowFontRules)) out += rule;
      else hasBlockedUrl = true;
      index = end;
      continue;
    }
    const imageSetAt = matchKeyword(css, index, '-webkit-image-set(') ?? matchKeyword(css, index, 'image-set(');
    if (imageSetAt !== null) {
      const endParen = endOfParenFunction(css, imageSetAt);
      if (endParen === -1) {
        out += 'none';
        hasBlockedUrl = true;
        break;
      }
      const imageSet = sanitizeImageSet(css.slice(imageSetAt, endParen), css.slice(index, imageSetAt));
      out += imageSet.value;
      if (imageSet.rejected) hasBlockedUrl = true;
      index = endParen + 1;
      continue;
    }
    const urlAt = matchKeyword(css, index, 'url(');
    if (urlAt !== null) {
      const endParen = endOfUrl(css, urlAt);
      if (endParen === -1) {
        out += 'none';
        hasBlockedUrl = true;
        break;
      }
      const decoded = unquoteCssToken(css.slice(urlAt, endParen));
      const allowed = decoded !== null && isAllowedUrl(decoded, {
        allowFontHost: allowFontRules && fontFaceDepth > 0,
        allowDataImage: true,
      });
      out += allowed ? css.slice(index, endParen + 1) : 'none';
      if (!allowed) hasBlockedUrl = true;
      index = endParen + 1;
      continue;
    }
    const ch = css[index] ?? '';
    if (ch === '{') {
      if (pendingFontFace) {
        pendingFontFace = false;
        fontFaceDepth = 1;
      } else if (fontFaceDepth > 0) {
        fontFaceDepth += 1;
      }
    } else if (ch === '}') {
      if (fontFaceDepth > 0) fontFaceDepth -= 1;
      pendingFontFace = false;
    } else if (ch === ';') {
      pendingFontFace = false;
    }
    out += ch;
    index += 1;
  }
  return {css: out, hasBlockedUrl};
}

export function sanitizeCss(css: string, options: {allowFontRules?: boolean} = {}): string {
  return scanCss(css, options).css;
}

function isUrlAttribute(name: string): boolean {
  return URL_ATTRIBUTES.has(name) || name.endsWith(':href') || name.endsWith(':src');
}

function hasRefresh(element: ElementNode): boolean {
  return element.attrs.some(attr => attr.name.toLowerCase() === 'http-equiv' && attr.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase() === 'refresh');
}

function linkHrefIsBlocked(element: ElementNode): boolean {
  const href = element.attrs.find(attr => attr.name.toLowerCase() === 'href');
  if (!href) return false;
  return !isAllowedUrl(href.value, {allowFontHost: true, allowDataImage: true});
}

function shouldDrop(element: ElementNode): boolean {
  const tag = element.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return true;
  if (tag === 'meta' && hasRefresh(element)) return true;
  return tag === 'link' && linkHrefIsBlocked(element);
}

function splitSrcsetCandidates(value: string): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index] ?? '')) index += 1;
    if (index >= value.length) break;
    const urlStart = index;
    const isData = value.slice(index, index + 5).toLowerCase() === 'data:';
    if (isData) {
      while (index < value.length && !/\s/.test(value[index] ?? '')) index += 1;
    } else {
      while (index < value.length && !/[\s,]/.test(value[index] ?? '')) index += 1;
    }
    while (index < value.length && value[index] !== ',') index += 1;
    parts.push(value.slice(urlStart, index).trim());
    if (value[index] === ',') index += 1;
  }
  return parts;
}

function sanitizeSrcset(value: string): string | null {
  const kept: string[] = [];
  for (const candidate of splitSrcsetCandidates(value)) {
    if (candidate.length === 0) continue;
    const urlToken = candidate.split(/\s+/)[0] ?? '';
    if (urlToken.length === 0 || !isAllowedUrl(urlToken, {allowFontHost: false, allowDataImage: true})) continue;
    kept.push(candidate);
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

function sanitizeElement(element: ElementNode): void {
  const tag = element.tagName.toLowerCase();
  const kept: ElementNode['attrs'] = [];
  for (const attr of element.attrs) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) continue;
    if (name === 'style') {
      const value = sanitizeCss(attr.value, {allowFontRules: false});
      if (value.trim().length > 0) kept.push({...attr, value});
      continue;
    }
    if (name === 'srcset' || name === 'imagesrcset') {
      const value = sanitizeSrcset(attr.value);
      if (value !== null) kept.push({...attr, value});
      continue;
    }
    if (isUrlAttribute(name)) {
      if (!isAllowedUrl(attr.value, {allowFontHost: tag === 'link' && name === 'href', allowDataImage: true})) continue;
    } else if (/^(?:javascript|vbscript):/i.test(attr.value.replace(/[\u0000-\u0020]+/g, ''))) {
      continue;
    }
    if (scanCss(attr.value, {allowFontRules: false}).hasBlockedUrl) continue;
    kept.push(attr);
  }
  element.attrs = kept;
  if (tag === 'style') {
    for (const child of element.childNodes) {
      if (isText(child)) child.value = sanitizeCss(child.value, {allowFontRules: true});
    }
  }
}

function sanitizeParent(parent: ParentNode): void {
  for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
    const child = parent.childNodes[index];
    if (!child || !isElement(child)) continue;
    if (shouldDrop(child)) {
      parent.childNodes.splice(index, 1);
      continue;
    }
    sanitizeElement(child);
    sanitizeParent(child);
    if (isTemplate(child)) sanitizeParent(child.content);
  }
}

export function sanitizeGeneratedHtml(html: string): string {
  const document = parse(html);
  sanitizeParent(document);
  return serialize(document);
}

function referencesStylesheet(value: string, cssName: string): boolean {
  if (!isAllowedUrl(value, {allowFontHost: false, allowDataImage: false})) return false;
  const trimmed = value.trim();
  return trimmed === cssName || trimmed === `./${cssName}` || trimmed.endsWith(`/${cssName}`);
}

function documentReferences(parent: ParentNode, cssName: string): boolean {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    for (const attr of child.attrs) {
      const name = attr.name.toLowerCase();
      if ((name === 'href' || name === 'src') && referencesStylesheet(attr.value, cssName)) return true;
    }
    if (documentReferences(child, cssName)) return true;
    if (isTemplate(child) && documentReferences(child.content, cssName)) return true;
  }
  return false;
}

function attachStylesheet(document: DocumentNode, cssName: string): void {
  const root = childElement(document, 'html') ?? document;
  let head = childElement(root, 'head');
  if (!head) {
    head = defaultTreeAdapter.createElement('head', HTML_NS, []);
    const body = childElement(root, 'body');
    const first = root.childNodes[0];
    if (body && root.childNodes.includes(body)) defaultTreeAdapter.insertBefore(root, head, body);
    else if (first) defaultTreeAdapter.insertBefore(root, head, first);
    else defaultTreeAdapter.appendChild(root, head);
  }
  const link = defaultTreeAdapter.createElement('link', HTML_NS, [
    {name: 'rel', value: 'stylesheet'},
    {name: 'href', value: cssName},
  ]);
  defaultTreeAdapter.appendChild(head, link);
}

/** Sem </head> o link entra na árvore, antes do body ou no começo. Não depende de replace. */
function renderScreenHtml(html: string, cssName: string): string {
  const document = parse(html);
  sanitizeParent(document);
  if (!documentReferences(document, cssName)) attachStylesheet(document, cssName);
  return serialize(document);
}

function readCreateBundle(value: unknown, maxScreens: number): CreateBundle | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {tokens?: unknown; screens?: unknown};
  if (!row.tokens || typeof row.tokens !== 'object' || Array.isArray(row.tokens)) return null;
  if (!Array.isArray(row.screens)) return null;
  const screens: CreatedScreen[] = [];
  for (const item of row.screens) {
    if (!item || typeof item !== 'object') return null;
    const screen = item as {name?: unknown; html?: unknown; css?: unknown};
    const name = text(screen.name, 40).toLowerCase();
    const html = sanitizeGeneratedHtml(text(screen.html, 200_000));
    const css = sanitizeCss(text(screen.css, 200_000));
    if (!SCREEN_NAME.test(name) || !html.includes('<') || css.length === 0) return null;
    screens.push({name, html, css});
    if (screens.length >= maxScreens) break;
  }
  if (screens.length === 0) return null;
  return {tokens: row.tokens as Record<string, unknown>, screens};
}

export function parseCreateBundle(value: unknown, screens: number): CreateBundle | null {
  const bundle = readCreateBundle(value, screens);
  if (!bundle || bundle.screens.length !== screens) return null;
  return bundle;
}

function measuredFindings(findings: readonly DesignRawFinding[]): DesignRawFinding[] {
  return findings.filter(finding => finding.measure !== undefined && finding.measure !== null).slice(0, 40);
}

export function createTask(input: {briefing: string; screens: number; round: number; referenceNote: string; rework: readonly ReworkScreen[]}): string {
  const lines = [
    'Pedido de criação.',
    'Responda só um JSON com kind "criacao", tokens (DTCG) e screens.',
    `screens tem ${input.screens} itens. Cada item tem name, html e css.`,
    'O HTML é autossuficiente, com fonte por <link>, sem base64 e sem JavaScript externo.',
    'Quando o briefing pedir conceitos diferentes da mesma tela, preserve a função e as ações e siga as direções fornecidas a cada conceito, inclusive no retrabalho dos nomes rejeitados.',
    `Rodada: ${input.round}`,
    'Briefing:',
    input.briefing,
  ];
  if (input.referenceNote.trim().length > 0) lines.push(input.referenceNote.slice(0, 2000));
  if (input.rework.length > 0) {
    lines.push('Devolva só as telas rejeitadas, com o mesmo name.');
    for (const screen of input.rework) {
      lines.push(`Tela rejeitada ${screen.name}.`);
      lines.push('HTML anterior:');
      lines.push(screen.html.slice(0, 8000));
      const measured = measuredFindings(screen.findings);
      if (measured.length > 0) {
        lines.push('Achados para corrigir:');
        for (const finding of measured) {
          lines.push(`- ${finding.rule} ${finding.severity} ${finding.file} ${finding.snippet} ${JSON.stringify(finding.measure)}`.slice(0, 500));
        }
      }
      const visualNotes = screen.visualNotes.filter(note => note.trim().length > 0).slice(0, 20);
      if (visualNotes.length > 0) {
        lines.push('Notas visuais:');
        for (const note of visualNotes) lines.push(`- ${note.slice(0, 500)}`);
      }
    }
  }
  const task = lines.join('\n');
  if (task.length > MAX_CREATE_TASK_CHARS) {
    const refusal = new Refusal('DESIGN_CREATE_PROMPT_TOO_LARGE', 400);
    refusal.message = `O prompt de criação excedeu o limite de ${MAX_CREATE_TASK_CHARS} caracteres (${task.length}).`;
    throw refusal;
  }
  return task;
}

async function writePrivate(path: string, body: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(body);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function outsideRepository(directory: string, repository: string): void {
  const rel = relative(resolve(repository), resolve(directory));
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..`))) {
    if (!rel.startsWith('..')) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderIndex(rounds: readonly CreateRound[], namesByRound: readonly (readonly string[])[]): string {
  const sections = rounds.map((round, index) => {
    const names = namesByRound[index] ?? [];
    const notes = round.notes.length > 0 ? round.notes.map(note => escapeHtml(note)).join('<br>') : 'nenhuma';
    const visual = round.visualNotes
      .filter(item => item.notes.length > 0)
      .map(item => `<li>${escapeHtml(item.name)}: ${item.notes.map(note => escapeHtml(note)).join(' ')}</li>`)
      .join('');
    const links = names.map(name => `<p><a href="rodada-${round.round}/${escapeHtml(name)}.html">${escapeHtml(name)}</a></p>`).join('');
    return [
      '<section>',
      `<h2>Rodada ${round.round}</h2>`,
      `<p>Aprovadas: ${round.approved.map(name => escapeHtml(name)).join(', ') || 'nenhuma'}. Rejeitadas: ${round.rejected.map(name => escapeHtml(name)).join(', ') || 'nenhuma'}.</p>`,
      `<p>Notas: ${notes}</p>`,
      visual.length > 0 ? `<ul>${visual}</ul>` : '',
      links,
      '</section>',
    ].join('');
  });
  return [
    '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vitrine</title></head><body>',
    '<h1>Vitrine</h1>',
    ...sections,
    '</body></html>',
  ].join('\n');
}

function stringList(values: readonly string[] | undefined, max: number): string[] {
  if (!values) return [];
  return values.filter(value => value.trim().length > 0).map(value => value.slice(0, 500)).slice(0, max);
}

/**
 * Gera telas fora do repositório e devolve cada rodada para o exame injetado.
 * O modelo de produção é claude-opus-5-5 com esforço high, forçado no worker.
 * Aprovação é por tela: só a rejeitada volta no pedido seguinte.
 */
export async function runDesignCreate(input: {
  dataDirectory: string;
  runId: string;
  repository: string;
  briefing: string;
  screens: number;
  rounds: number;
  referenceNote: string;
  worker: DesignWorker;
  reserve: () => Promise<{provider: string; accountId: string; profileId: string; model: string; grantId: string}>;
  release: (seat: {provider: string; accountId: string; profileId: string; model: string; grantId: string}) => Promise<void>;
  intentId: string;
  examine(round: number, files: readonly {path: string; text: string}[]): Promise<CreateExam>;
}): Promise<{directory: string; rounds: CreateRound[]; indexPath: string}> {
  if (input.screens < 1 || input.screens > 8 || input.rounds < 1 || input.rounds > 5) throw new Refusal('DESIGN_CREATE_INVALID', 400);
  const firstTask = createTask({briefing: input.briefing, screens: input.screens, round: 1, referenceNote: input.referenceNote, rework: []});
  const root = join(input.dataDirectory, 'design-criacoes', input.runId);
  outsideRepository(root, input.repository);
  await mkdir(root, {recursive: true, mode: 0o700});
  const rounds: CreateRound[] = [];
  const roundNames: string[][] = [];
  let order: string[] = [];
  let kept = new Map<string, StoredScreen>();
  let rework: ReworkScreen[] = [];
  for (let round = 1; round <= input.rounds; round += 1) {
    const expect = rework.length > 0 ? rework.length : input.screens;
    const task = round === 1 ? firstTask : createTask({briefing: input.briefing, screens: expect, round, referenceNote: input.referenceNote, rework});
    const seat = await input.reserve();
    let output = '';
    try {
      const call = DesignWorkerCall.parse({
        designPurpose: 'create',
        role: 'specialist',
        provider: seat.provider,
        accountId: seat.accountId,
        profileId: seat.profileId,
        model: seat.model,
        grantId: seat.grantId,
        intentId: input.intentId,
        task,
        repo: input.repository,
        writePaths: [],
        forcedModel: 'claude-opus-5-5',
        forcedEffort: 'high',
      });
      try {
        output = await input.worker.run(call);
      } catch (error) {
        if (error instanceof Refusal && (error.code === 'EXAM_LOGIN_STALE' || error.code === 'EXAM_LOGIN_BUSY' || error.code === 'EXAM_LOGIN_RESTORE_FAILED' || error.code === 'EXAM_PROVIDER_UNSUPPORTED')) throw error;
        throw new DesignCreateModelFailure(error instanceof Refusal ? safeFailureCode(error.code) : 'EXECUTION_NATIVE_FAILED');
      }
    } finally {
      await input.release(seat);
    }
    const trimmed = output.trim();
    if (trimmed.length === 0) throw new DesignCreateModelFailure('EXECUTION_NATIVE_FAILED');
    if (providerFailureCode(output) === 'PROVIDER_AUTH_FAILED' && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      throw new DesignCreateModelFailure('PROVIDER_AUTH_FAILED');
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      parsed = null;
    }
    const bundle = readCreateBundle(parsed, 8);
    if (!bundle) throw new Refusal('DESIGN_CREATE_INVALID', 400);
    const byName = new Map<string, CreatedScreen>();
    for (const screen of bundle.screens) {
      if (byName.has(screen.name)) throw new Refusal('DESIGN_CREATE_INVALID', 400);
      byName.set(screen.name, screen);
    }
    const ready: StoredScreen[] = [];
    if (rework.length === 0) {
      if (bundle.screens.length < input.screens) throw new Refusal('DESIGN_CREATE_INVALID', 400);
      const selected = bundle.screens.slice(0, input.screens);
      if (new Set(selected.map(screen => screen.name)).size !== selected.length) throw new Refusal('DESIGN_CREATE_INVALID', 400);
      order = selected.map(screen => screen.name);
      for (const screen of selected) ready.push({name: screen.name, css: screen.css, fileHtml: renderScreenHtml(screen.html, `${screen.name}.css`)});
    } else {
      for (const screen of rework) {
        if (!byName.has(screen.name)) throw new Refusal('DESIGN_CREATE_INVALID', 400);
      }
      for (const name of order) {
        const pending = rework.find(screen => screen.name === name);
        if (!pending) {
          const previous = kept.get(name);
          if (!previous) throw new Refusal('DESIGN_CREATE_INVALID', 400);
          ready.push(previous);
          continue;
        }
        const screen = byName.get(name);
        if (!screen) throw new Refusal('DESIGN_CREATE_INVALID', 400);
        ready.push({name, css: screen.css, fileHtml: renderScreenHtml(screen.html, `${name}.css`)});
      }
    }
    const roundDir = join(root, `rodada-${round}`);
    await mkdir(roundDir, {mode: 0o700});
    await writePrivate(join(roundDir, 'tokens.json'), `${JSON.stringify(bundle.tokens, null, 2)}\n`);
    const files: {path: string; text: string}[] = [];
    const stored = new Map<string, StoredScreen>();
    for (const screen of ready) {
      const htmlName = `${screen.name}.html`;
      const cssName = `${screen.name}.css`;
      await writePrivate(join(roundDir, htmlName), screen.fileHtml);
      await writePrivate(join(roundDir, cssName), screen.css);
      files.push({path: htmlName, text: screen.fileHtml}, {path: cssName, text: screen.css});
      stored.set(screen.name, screen);
    }
    const examined = await input.examine(round, files);
    const verdicts = new Map(examined.screens.map(screen => [screen.name.toLowerCase(), screen]));
    const approved: string[] = [];
    const rejected: string[] = [];
    const visualNotes: {name: string; notes: string[]}[] = [];
    const nextKept = new Map<string, StoredScreen>();
    const nextRework: ReworkScreen[] = [];
    for (const name of order) {
      const verdict = verdicts.get(name);
      const row = stored.get(name);
      if (!row) throw new Refusal('DESIGN_CREATE_INVALID', 400);
      const screenNotes = stringList(verdict?.visualNotes, 20);
      if (screenNotes.length > 0) visualNotes.push({name, notes: screenNotes});
      if (verdict?.rejected === true) {
        rejected.push(name);
        nextRework.push({name, html: row.fileHtml, findings: verdict.findings ?? [], visualNotes: stringList(verdict.visualNotes, 20)});
      } else {
        approved.push(name);
        nextKept.set(name, row);
      }
    }
    rounds.push({
      round,
      approved,
      rejected,
      notes: stringList(examined.notes, 40),
      visualNotes,
    });
    roundNames.push(order.slice());
    kept = nextKept;
    rework = nextRework;
    if (rejected.length === 0) break;
  }
  const index = renderIndex(rounds, roundNames);
  const indexPath = join(root, 'index.html');
  await writeFile(indexPath, index, {mode: 0o600});
  await chmod(indexPath, 0o600);
  await chmod(root, 0o700);
  return {directory: root, rounds, indexPath};
}
