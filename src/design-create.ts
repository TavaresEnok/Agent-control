import {chmod, mkdir, open, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {defaultTreeAdapter, html as parse5Html, parse, serialize} from 'parse5';
import type {DefaultTreeAdapterTypes} from 'parse5';
import {Refusal} from './contracts.ts';
import type {DesignRawFinding, DesignWorker} from './design-types.ts';
import {DesignWorkerCall} from './design-types.ts';

const SCREEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const DROPPED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base']);
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'background', 'data', 'ping']);
const HTML_NS = parse5Html.NS.HTML;

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

function stripCssComments(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith('/*', index)) {
      const end = value.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    out += value[index] ?? '';
  }
  return out;
}

/** URL que o navegador iria buscar fora da pasta, ou esquema de script. */
function isRemoteOrScriptUrl(raw: string): boolean {
  let value = stripCssComments(raw).trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1).trim();
  }
  value = decodeCssValue(value).trim();
  const compact = value.replace(/[\u0000-\u0020]+/g, '').replace(/\\/g, '/').toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return true;
  if (compact.startsWith('http:') || compact.startsWith('https:')) return true;
  return compact.startsWith('//');
}

function isAllowedFontHref(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return FONT_HOSTS.has(host);
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
    if (css[index] === ';' || css[index] === '{' || css[index] === '}') return css[index] === ';' ? index + 1 : index;
    if (css[index] === '\\') {
      index += index + 1 < css.length ? 2 : 1;
      continue;
    }
    index += 1;
  }
  return index;
}

function ruleContainsRemoteUrl(rule: string): boolean {
  let index = 0;
  while (index < rule.length) {
    if (rule.startsWith('/*', index)) {
      const end = rule.indexOf('*/', index + 2);
      index = end === -1 ? rule.length : end + 2;
      continue;
    }
    if (rule[index] === '"' || rule[index] === "'") {
      const end = consumeCssString(rule, index);
      const literal = rule.slice(index + 1, Math.max(index + 1, end - (rule[end - 1] === rule[index] ? 1 : 0)));
      if (isRemoteOrScriptUrl(literal)) return true;
      index = end;
      continue;
    }
    const urlAt = matchKeyword(rule, index, 'url(');
    if (urlAt !== null) {
      const endParen = endOfUrl(rule, urlAt);
      const inner = rule.slice(urlAt, endParen === -1 ? rule.length : endParen);
      if (isRemoteOrScriptUrl(inner)) return true;
      const next = endParen === -1 ? rule.length : endParen + 1;
      index = next > index ? next : index + 1;
      continue;
    }
    index += 1;
  }
  return false;
}

/** parse5 não entra em CSS. Esta varredura tira url() e @import que saem da pasta. */
export function sanitizeCss(css: string): string {
  let out = '';
  let index = 0;
  while (index < css.length) {
    if (css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      if (end === -1) return out + css.slice(index);
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
    const importAt = matchKeyword(css, index, '@import');
    if (importAt !== null && !startsIdent(css, importAt)) {
      const end = endOfImport(css, importAt);
      if (end <= index) {
        out += css[index] ?? '';
        index += 1;
        continue;
      }
      const rule = css.slice(index, end);
      if (!ruleContainsRemoteUrl(rule)) out += rule;
      index = end;
      continue;
    }
    const urlAt = matchKeyword(css, index, 'url(');
    if (urlAt !== null) {
      const endParen = endOfUrl(css, urlAt);
      const end = endParen === -1 ? css.length : endParen + 1;
      if (end <= index) {
        out += css[index] ?? '';
        index += 1;
        continue;
      }
      const inner = css.slice(urlAt, endParen === -1 ? css.length : endParen);
      out += isRemoteOrScriptUrl(inner) ? 'none' : css.slice(index, end);
      index = end;
      continue;
    }
    out += css[index] ?? '';
    index += 1;
  }
  return out;
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
  if (isAllowedFontHref(href.value)) return false;
  return isRemoteOrScriptUrl(href.value);
}

function shouldDrop(element: ElementNode): boolean {
  const tag = element.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return true;
  if (tag === 'meta' && hasRefresh(element)) return true;
  return tag === 'link' && linkHrefIsBlocked(element);
}

function sanitizeSrcset(value: string): string | null {
  const kept: string[] = [];
  for (const part of value.split(',')) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    const urlToken = candidate.split(/\s+/)[0] ?? '';
    if (urlToken.length === 0 || isRemoteOrScriptUrl(urlToken)) continue;
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
      const value = sanitizeCss(attr.value);
      if (value.trim().length > 0) kept.push({...attr, value});
      continue;
    }
    if (name === 'srcset' || name === 'imagesrcset') {
      const value = sanitizeSrcset(attr.value);
      if (value !== null) kept.push({...attr, value});
      continue;
    }
    if (isUrlAttribute(name)) {
      if (tag === 'link' && name === 'href' && isAllowedFontHref(attr.value)) {
        kept.push(attr);
        continue;
      }
      if (isRemoteOrScriptUrl(attr.value)) continue;
    } else if (isRemoteOrScriptUrl(attr.value) && (attr.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase().startsWith('javascript:') || attr.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase().startsWith('vbscript:'))) {
      continue;
    }
    kept.push(attr);
  }
  element.attrs = kept;
  if (tag === 'style') {
    for (const child of element.childNodes) {
      if (isText(child)) child.value = sanitizeCss(child.value);
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
  if (isRemoteOrScriptUrl(value)) return false;
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

function createTask(input: {briefing: string; screens: number; round: number; referenceNote: string; rework: readonly ReworkScreen[]}): string {
  const lines = [
    'Pedido de criação.',
    'Responda só um JSON com kind "criacao", tokens (DTCG) e screens.',
    `screens tem ${input.screens} itens. Cada item tem name, html e css.`,
    'O HTML é autossuficiente, com fonte por <link>, sem base64 e sem JavaScript externo.',
    `Rodada: ${input.round}`,
    'Briefing:',
    input.briefing.slice(0, 8000),
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
  return lines.join('\n').slice(0, 100000);
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
 * O modelo de produção é claude-opus-5-5 com esforço medium, forçado no worker.
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
    const seat = await input.reserve();
    let output = '';
    try {
      const call = DesignWorkerCall.parse({
        role: 'specialist',
        provider: seat.provider,
        accountId: seat.accountId,
        profileId: seat.profileId,
        model: seat.model,
        grantId: seat.grantId,
        intentId: input.intentId,
        task: createTask({briefing: input.briefing, screens: expect, round, referenceNote: input.referenceNote, rework}),
        repo: input.repository,
        writePaths: [],
        forcedModel: 'claude-opus-5-5',
        forcedEffort: 'medium',
      });
      output = await input.worker.run(call);
    } finally {
      await input.release(seat);
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
