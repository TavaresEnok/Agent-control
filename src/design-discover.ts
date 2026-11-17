import {Refusal} from './contracts.ts';
import {DESIGN_PLANTED_RULES, designRawFinding, type DesignRawFinding} from './design-types.ts';

/** Rota declarada no código. `source` fica `codigo` para distinguir da navegação. */
export type DiscoveredRoute = {
  id: string;
  route: string;
  file: string;
  line: number;
  title: string;
  source: 'codigo';
};

export type DesignLogin = {
  username: string;
  password: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
};

/** Username e seletores. A senha não entra neste objeto. */
export type PublicLoginRecord = {
  username: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
};

export type ScreenCoverageRow = {
  screenId: string;
  route: string;
  file: string;
  fromCode: boolean;
  fromNavigation: boolean;
  captures: number;
};

type RouteHit = {
  file: string;
  route: string;
  line: number;
  index: number;
};

const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;
const SOURCE_FILE = /\.(tsx|ts|jsx|js)$/;
const LIST_MARKER = /<ul\b|<ol\b|data-list(?![A-Za-z0-9-])|role\s*=\s*(?:\{\s*)?(["'])list\1|role\s*=\s*list\b/;
const EMPTY_MARKER = /data-empty(?![A-Za-z0-9-])|Nenhum item|empty-state|length\s*===?\s*0(?!\d)|(?:^|[^!\w])!\s*items\.length\b|\.length\s*\?(?!\.)/;

/**
 * Rotas de React Router, Next (pages e app), Vue Router e GoRoute.
 * Não devolve caminho que o texto ou o arquivo de página não declaram.
 * Grupos `(nome)` e slots `@slot` do App Router não entram na URL.
 * Rota com `:param`, `*` ou segmento `[id]` só entra se a mesma declaração tiver example concreto.
 */
export function discoverRoutesFromSource(files: readonly {path: string; text: string}[]): DiscoveredRoute[] {
  const hits: RouteHit[] = [];
  for (const file of files) {
    const next = nextRoute(file.path);
    if (next !== null && !isDynamicRoute(next)) {
      hits.push({file: file.path, route: next, line: 1, index: -1});
    }
    hits.push(...routesInText(file.path, file.text));
  }
  const unique = dedupeHits(hits);
  const used = new Set<string>();
  return unique.map(hit => ({
    id: uniqueId(routeSlug(hit.route), used),
    route: hit.route,
    file: hit.file,
    line: hit.line,
    title: routeTitle(hit.route),
    source: 'codigo',
  }));
}

/** Regra ESTADOS-VAZIO-AUSENTE: lista dinâmica sem ramo de vazio. Itens literais não geram achado. O marcador vale só no mesmo componente. */
export function missingEmptyStateFindings(file: string, text: string): DesignRawFinding[] {
  const spans = functionSpans(text);
  const marked = new Set<string>();
  const pattern = new RegExp(EMPTY_MARKER.source, 'g');
  let marker: RegExpExecArray | null;
  const masked = maskComments(text);
  while ((marker = pattern.exec(masked)) !== null) {
    if (marker[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    marked.add(spanKey(innermostSpan(spans, marker.index, text.length)));
  }
  const findings: DesignRawFinding[] = [];
  for (const hit of listHits(text)) {
    if (isLiteralList(hit.inner)) continue;
    if (marked.has(spanKey(innermostSpan(spans, hit.index, text.length)))) continue;
    const rawLine = lineText(text, hit.index);
    const snippet = rawLine.trim().length <= 200 ? rawLine : text.slice(hit.index, hit.index + 120);
    findings.push(designRawFinding({
      tool: 'html',
      rule: DESIGN_PLANTED_RULES.empty,
      cwe: null,
      file,
      line: lineAt(text, hit.index),
      severity: 'media',
      snippet,
    }));
  }
  return findings;
}

type SourceSpan = {start: number; end: number};

function functionSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const skipped = skipNoise(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (isFunctionKeyword(text, index)) {
      const body = functionBody(text, index + 'function'.length);
      if (body !== null) {
        spans.push(body);
        index = body.start + 1;
        continue;
      }
    }
    if (text.startsWith('=>', index)) {
      const body = arrowBody(text, index + 2);
      if (body !== null) {
        spans.push(body);
        index = body.start + 1;
        continue;
      }
    }
    index += 1;
  }
  return spans;
}

function innermostSpan(spans: readonly SourceSpan[], index: number, length: number): SourceSpan {
  let best: SourceSpan | null = null;
  for (const span of spans) {
    if (index < span.start || index >= span.end) continue;
    if (best === null || span.end - span.start < best.end - best.start) best = span;
  }
  return best ?? {start: 0, end: length};
}

function spanKey(span: SourceSpan): string {
  return `${span.start}:${span.end}`;
}

function isFunctionKeyword(text: string, index: number): boolean {
  if (!text.startsWith('function', index)) return false;
  const before = index === 0 ? '' : text[index - 1] ?? '';
  const after = text[index + 'function'.length] ?? '';
  if (before !== '' && /[A-Za-z0-9_$]/.test(before)) return false;
  return !/[A-Za-z0-9_$]/.test(after);
}

function functionBody(text: string, from: number): SourceSpan | null {
  let index = skipSpaceAndNoise(text, from);
  if (text[index] === '*') index = skipSpaceAndNoise(text, index + 1);
  if (isIdentStart(text[index] ?? '')) {
    index += 1;
    while (index < text.length && isIdentPart(text[index] ?? '')) index += 1;
    index = skipSpaceAndNoise(text, index);
  }
  if (text[index] !== '(') return null;
  const paramsEnd = matchingCloser(text, index, '(', ')');
  if (paramsEnd < 0) return null;
  index = skipSpaceAndNoise(text, paramsEnd);
  if (text[index] !== '{') return null;
  const end = matchingCloser(text, index, '{', '}');
  if (end < 0) return null;
  return {start: index, end};
}

function arrowBody(text: string, from: number): SourceSpan | null {
  const index = skipSpaceAndNoise(text, from);
  const char = text[index];
  if (char !== '{' && char !== '(') return null;
  const end = matchingCloser(text, index, char, char === '{' ? '}' : ')');
  if (end < 0) return null;
  return {start: index, end};
}

function matchingCloser(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const skipped = skipNoise(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

function skipSpaceAndNoise(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const skipped = skipNoise(text, cursor);
    if (skipped > cursor) {
      cursor = skipped;
      continue;
    }
    if (/[ \t\r\n]/.test(text[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    break;
  }
  return cursor;
}

function skipNoise(text: string, index: number): number {
  const char = text[index];
  const next = text[index + 1];
  if (char === '/' && next === '/') {
    const end = text.indexOf('\n', index + 2);
    return end < 0 ? text.length : end;
  }
  if (char === '/' && next === '*') {
    const end = text.indexOf('*/', index + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (char === '<' && text.startsWith('<!--', index)) {
    const end = text.indexOf('-->', index + 4);
    return end < 0 ? text.length : end + 3;
  }
  if (char === '"' || char === '\'' || char === '`') {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (text[cursor] === char) return cursor + 1;
      cursor += 1;
    }
    return text.length;
  }
  return index;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

function listHits(text: string): {index: number; inner: string}[] {
  const hits: {index: number; inner: string}[] = [];
  const open = /<([A-Za-z][\w:-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(text)) !== null) {
    const start = match.index;
    const tag = match[1] ?? '';
    const tagEnd = endOfOpeningTag(text, start);
    if (tagEnd < 0) {
      open.lastIndex = start + 1;
      continue;
    }
    const opening = text.slice(start, tagEnd + 1);
    if (!isListOpening(tag, opening)) {
      open.lastIndex = tagEnd + 1;
      continue;
    }
    if (/\/\s*>$/.test(opening)) {
      hits.push({index: start, inner: ''});
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const close = findListClose(text, tag, tagEnd + 1);
    if (close === null) {
      hits.push({index: start, inner: ''});
      open.lastIndex = tagEnd + 1;
      continue;
    }
    hits.push({index: start, inner: text.slice(tagEnd + 1, close.innerEnd)});
    open.lastIndex = close.rawEnd;
  }
  return hits;
}

function isListOpening(tag: string, opening: string): boolean {
  const lower = tag.toLowerCase();
  if (lower === 'ul' || lower === 'ol') return true;
  return LIST_MARKER.test(opening);
}

function isLiteralList(inner: string): boolean {
  if (/\.map\s*\(/.test(inner)) return false;
  if (inner.includes('{')) return false;
  return /<[A-Za-z]/.test(inner) || /[A-Za-z0-9À-ÿ]/.test(inner.replace(/<[^>]*>/g, ' '));
}

const LIST_CLOSE = /^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/;
const LIST_OPEN_NAME = /^<([A-Za-z][\w:-]*)\b/;

function findListClose(html: string, tag: string, from: number): {innerEnd: number; rawEnd: number} | null {
  const lower = tag.toLowerCase();
  let quote: '"' | "'" | '`' | null = null;
  let brace = 0;
  let depth = 1;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (brace > 0 && quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (brace > 0 && (char === '"' || char === "'" || char === '`')) {
      quote = char;
      continue;
    }
    if (char === '{') {
      brace += 1;
      continue;
    }
    if (char === '}' && brace > 0) {
      brace -= 1;
      continue;
    }
    if (char !== '<' || brace !== 0) continue;
    const slice = html.slice(index);
    const close = LIST_CLOSE.exec(slice);
    if (close?.[1] && close[1].toLowerCase() === lower) {
      depth -= 1;
      if (depth === 0) return {innerEnd: index, rawEnd: index + close[0].length};
      index += close[0].length - 1;
      continue;
    }
    const opened = LIST_OPEN_NAME.exec(slice);
    if (!opened?.[1] || opened[1].toLowerCase() !== lower) continue;
    const tagEnd = endOfOpeningTag(html, index);
    if (tagEnd < 0) return null;
    const opening = html.slice(index, tagEnd + 1);
    if (!/\/\s*>$/.test(opening)) depth += 1;
    index = tagEnd;
  }
  return null;
}

/**
 * Copia o login sem a senha.
 * Se a senha aparecer no JSON ou dentro de algum campo devolvido, recusa DESIGN_PASSWORD_LEAK.
 */
export function publicLoginRecord(login: DesignLogin | undefined): PublicLoginRecord | undefined {
  if (login === undefined) return undefined;
  const record: PublicLoginRecord = {
    username: login.username,
    usernameSelector: login.usernameSelector,
    passwordSelector: login.passwordSelector,
    submitSelector: login.submitSelector,
  };
  if (login.password.length > 0 && passwordLeaked(record, login.password)) {
    throw new Refusal('DESIGN_PASSWORD_LEAK');
  }
  return record;
}

/** Tabela de cobertura em português. */
export function screenCoverageMarkdown(rows: readonly ScreenCoverageRow[]): string {
  const header = '| Tela | Rota | Arquivo | No código | Na navegação | Capturas |';
  const divider = '| --- | --- | --- | --- | --- | --- |';
  const body = rows.map(row => '| ' + [
    cell(row.screenId),
    cell(row.route),
    cell(row.file),
    row.fromCode ? 'sim' : 'não',
    row.fromNavigation ? 'sim' : 'não',
    String(row.captures),
  ].join(' | ') + ' |');
  const total = rows.length === 1 ? 'Total: 1 tela.' : `Total: ${rows.length} telas.`;
  return ['# Cobertura das telas', '', header, divider, ...body, '', total, ''].join('\n');
}

function passwordLeaked(record: PublicLoginRecord, password: string): boolean {
  const serialized = JSON.stringify(record);
  if (serialized.includes(JSON.stringify(password))) return true;
  return Object.values(record).some(value => value.includes(password));
}

function dedupeHits(hits: readonly RouteHit[]): RouteHit[] {
  const seen = new Set<string>();
  const unique: RouteHit[] = [];
  for (const hit of hits) {
    const key = `${hit.file}\0${hit.route}\0${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

function nextRoute(filePath: string): string | null {
  const parts = filePath.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(part => part.length > 0);
  const file = parts[parts.length - 1] ?? '';
  if (parts.length === 1 && PAGE_FILE.test(file)) return '/';
  let rootAt = -1;
  let rootKind: 'app' | 'pages' | null = null;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === 'app' || part === 'pages') {
      rootAt = index;
      rootKind = part;
    }
  }
  if (rootAt < 0 || rootKind === null) return null;
  if (rootKind === 'app') {
    if (!PAGE_FILE.test(file)) return null;
    const segments = parts.slice(rootAt + 1, -1).filter(segment => !isGroup(segment) && !segment.startsWith('@'));
    return joinSegments(segments);
  }
  const relative = parts.slice(rootAt + 1);
  const name = relative[relative.length - 1] ?? '';
  if (!SOURCE_FILE.test(name) || name.startsWith('_') || relative[0] === 'api') return null;
  const segments = relative.map((segment, index) => index === relative.length - 1 ? segment.replace(SOURCE_FILE, '') : segment);
  if (segments[segments.length - 1] === 'index') segments.pop();
  return joinSegments(segments.filter(segment => !isGroup(segment)));
}

function isGroup(segment: string): boolean {
  return /^\(.*\)$/.test(segment);
}

function joinSegments(segments: readonly string[]): string | null {
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\'))) return null;
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function routesInText(file: string, text: string): RouteHit[] {
  if (!/Route|path\s*:|GoRoute/.test(text)) return [];
  const masked = maskComments(text);
  const consumed = new Set<number>();
  const hits: RouteHit[] = [];
  collectJsxRoutes(file, masked, hits, consumed);
  collectGoRoutes(file, masked, hits, consumed);
  collectObjectPaths(file, masked, hits, consumed);
  hits.sort((left, right) => left.index - right.index);
  return hits;
}

function collectJsxRoutes(file: string, masked: string, hits: RouteHit[], consumed: Set<number>): void {
  const opener = /<Route(?![A-Za-z0-9_])/g;
  let found: RegExpExecArray | null;
  while ((found = opener.exec(masked)) !== null) {
    const start = found.index;
    const tagEnd = endOfOpeningTag(masked, start);
    if (tagEnd < 0) continue;
    const tag = masked.slice(start, tagEnd);
    const pathMatch = /\bpath\s*=\s*(?:\{\s*)?(['"`])([^'"`]+)\1/.exec(tag);
    if (pathMatch === null || pathMatch.index === undefined) continue;
    const route = routeFromDeclaration(pathMatch[2] ?? '', tag);
    if (route === null) continue;
    const index = start + pathMatch.index;
    consumed.add(index);
    hits.push({file, route, line: lineAt(masked, index), index});
  }
}

function collectGoRoutes(file: string, masked: string, hits: RouteHit[], consumed: Set<number>): void {
  const opener = /GoRoute\s*\(/g;
  let found: RegExpExecArray | null;
  while ((found = opener.exec(masked)) !== null) {
    const from = found.index + found[0].length;
    const next = masked.indexOf('GoRoute', from);
    const limit = next === -1 ? Math.min(masked.length, from + 1200) : next;
    const window = masked.slice(from, limit);
    const pathMatch = /\bpath\s*:\s*(['"`])([^'"`]+)\1/.exec(window);
    if (pathMatch === null || pathMatch.index === undefined) continue;
    const route = routeFromDeclaration(pathMatch[2] ?? '', window);
    if (route === null) continue;
    const index = from + pathMatch.index;
    if (consumed.has(index)) continue;
    consumed.add(index);
    hits.push({file, route, line: lineAt(masked, index), index});
  }
}

function collectObjectPaths(file: string, masked: string, hits: RouteHit[], consumed: Set<number>): void {
  const pattern = /\bpath\s*:\s*(['"`])([^'"`]+)\1/g;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(masked)) !== null) {
    if (consumed.has(found.index)) continue;
    const route = routeFromDeclaration(found[2] ?? '', objectSlice(masked, found.index));
    if (route === null) continue;
    consumed.add(found.index);
    hits.push({file, route, line: lineAt(masked, found.index), index: found.index});
  }
}

function endOfOpeningTag(text: string, start: number): number {
  let quote: '"' | '\'' | '`' | null = null;
  let brace = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      brace += 1;
      continue;
    }
    if (char === '}') {
      brace = Math.max(0, brace - 1);
      continue;
    }
    if (char === '>' && brace === 0) return index;
  }
  return -1;
}

/** Apaga comentários sem mudar índices nem quebras de linha. Strings permanecem. */
function maskComments(text: string): string {
  const chars = text.split('');
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length && chars[index] !== '\n') {
        chars[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 2;
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) {
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      if (index < chars.length) {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 2;
      }
      continue;
    }
    if (char === '<' && chars[index + 1] === '!' && chars[index + 2] === '-' && chars[index + 3] === '-') {
      for (let step = 0; step < 4 && index + step < chars.length; step += 1) chars[index + step] = ' ';
      index += 4;
      while (index < chars.length && !(chars[index] === '-' && chars[index + 1] === '-' && chars[index + 2] === '>')) {
        if (chars[index] !== '\n') chars[index] = ' ';
        index += 1;
      }
      for (let step = 0; step < 3 && index + step < chars.length; step += 1) chars[index + step] = ' ';
      index += 3;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      index += 1;
      while (index < chars.length) {
        if (chars[index] === '\\') {
          index += 2;
          continue;
        }
        if (chars[index] === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

function routeFromDeclaration(pattern: string, declaration: string): string | null {
  const route = normalizeRoute(pattern);
  if (route === null) return null;
  if (!isDynamicRoute(route)) return route;
  const exampleRaw = declaredExample(declaration);
  if (exampleRaw === null) return null;
  const example = normalizeRoute(exampleRaw);
  if (example === null || isDynamicRoute(example)) return null;
  return example;
}

function isDynamicRoute(route: string): boolean {
  const path = route.split(/[?#]/)[0] ?? route;
  return /[:*]|\[[^\]]*\]/.test(path);
}

function declaredExample(source: string): string | null {
  const match = /\bexample\s*[:=]\s*(?:\{\s*)?(['"`])([^'"`]+)\1/.exec(source);
  return match?.[2] ?? null;
}

function objectSlice(text: string, index: number): string {
  const start = text.lastIndexOf('{', index);
  const from = start < 0 ? index : start;
  let depth = 0;
  for (let cursor = from; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, cursor + 1);
    }
  }
  return text.slice(from, Math.min(text.length, index + 500));
}

function normalizeRoute(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  if (/[\s\\]/.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('.') || trimmed.includes('${')) return null;
  if (/\.(?:tsx|ts|jsx|js|css|scss|png|svg|vue|dart|json|html|md)(?:$|[?#])/i.test(trimmed)) return null;
  if (trimmed === '*') return '/*';
  if (trimmed.startsWith('/')) return trimmed;
  if (!/^[A-Za-z0-9_\-\[\]*:@]+(?:\/[A-Za-z0-9_\-\[\]*:@]+)*$/.test(trimmed)) return null;
  return `/${trimmed}`;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(Math.max(index, 0), text.length);
  for (let cursor = 0; cursor < end; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const endRelative = text.indexOf('\n', index);
  const end = endRelative === -1 ? text.length : endRelative;
  return text.slice(start, end);
}

function routeSlug(route: string): string {
  if (route === '/' || route === '/*') return 'raiz';
  const body = route
    .replace(/[?#].*$/, '')
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return body.length > 0 ? body : 'rota';
}

function routeTitle(route: string): string {
  if (route === '/' || route === '/*') return 'Início';
  const pathOnly = route.split('?')[0]?.split('#')[0] ?? route;
  const last = pathOnly.split('/').filter(part => part.length > 0).pop() ?? 'Tela';
  const words = last.replace(/[[\]{}:.*@]+/g, ' ').replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return 'Tela';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
