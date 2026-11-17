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
 */
export function discoverRoutesFromSource(files: readonly {path: string; text: string}[]): DiscoveredRoute[] {
  const hits: RouteHit[] = [];
  for (const file of files) {
    const next = nextRoute(file.path);
    if (next !== null) {
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

/** Regra ESTADOS-VAZIO-AUSENTE: ul, ol, data-list ou role=list sem ramo de vazio no mesmo arquivo. */
export function missingEmptyStateFindings(file: string, text: string): DesignRawFinding[] {
  if (EMPTY_MARKER.test(text)) return [];
  const match = LIST_MARKER.exec(text);
  if (match === null || match.index === undefined) return [];
  const rawLine = lineText(text, match.index);
  const snippet = rawLine.trim().length <= 200 ? rawLine : text.slice(match.index, match.index + 120);
  return [designRawFinding({
    tool: 'html',
    rule: DESIGN_PLANTED_RULES.empty,
    cwe: null,
    file,
    line: lineAt(text, match.index),
    severity: 'alta',
    snippet,
  })];
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
    const route = normalizeRoute(pathMatch[2] ?? '');
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
    const route = normalizeRoute(pathMatch[2] ?? '');
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
    const route = normalizeRoute(found[2] ?? '');
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
