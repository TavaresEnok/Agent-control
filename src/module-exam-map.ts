import {Refusal} from './contracts.ts';
import {goVendorPackages, isListedVendorFile, VENDORED_REASON} from './vendored-dirs.ts';
import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertModuleRepoRelativePath} from './verification-modules.ts';
import {hasKnownSecret, isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {isDirectIdentifier, isModuleExamScript, moduleExamCall, moduleExamDepths, scanModuleExamSource} from './module-exam-syntax.ts';

/** Inventory is based only on a caller-owned, immutable git archive, never the live tree. */
export type ModuleExamFile = {file: string; code: string | null; reason: string | null};
export type ModuleExamRoute = {file: string; line: number; column?: number; method: string; path: string};
type LocatedRoute = ModuleExamRoute & {column: number};
type RouteOmission = 'linguagem não inventariada' | 'sintaxe não reconhecida' | 'declaração fora do subconjunto'
  | 'declaração ocultada pelo saneamento' | 'acesso indexado ou dinâmico' | 'método do receptor sobrescrito';
type RouteInventory = {routes: LocatedRoute[]; omissions: RouteOmission[];
  ambiguousLegacyKeys?: Set<string>; ambiguousLegacyLines?: Set<number>};
export type ModuleExamMap = {files: ModuleExamFile[]; routes: ModuleExamRoute[]; fileOmissions?: number; routeOmissions?: number;
  routeOmissionDetails?: {file: string; reason: RouteOmission}[];
  /** Pastas vendor do Go conferidas com o go.mod e quantos arquivos de pacotes listados ficaram fora do exame. */
  vendored?: {dir: string; files: number}[]};
const MAX_FILE_BYTES = 16000;
const MAX_TEXT_FILES = 10000;
const SKIP = new Set(['.git', 'node_modules', 'dist', '.ai', 'verificacoes', '.claude', '.codex', '.grok', '.aws', '.ssh', '.config']);
/** Drops secret previews while preserving original evidence line numbers. */
export function redactModuleExamText(text: string): string {
  return redactUnknownSecrets(text, match => '…' + match.replace(/[^\r\n]/g, ''));
}

const secretName = (file: string) => isSecretClassBasename(file) || /(^|[._-])(secret|secrets|credential|credentials|password|senha)([._-]|$)/i.test(file.split('/').at(-1)!) || /(^|\/)\.pypirc$/i.test(file);

const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const legacyRouteKey = ({file, line, method, path}: ModuleExamRoute) => JSON.stringify([file, line, method, path]);
export const moduleExamRouteKey = ({file, line, column, method, path}: ModuleExamRoute) => JSON.stringify([file, line, column, method, path]);

/** Resolve a legacy key against the complete file, even when only one duplicate was sent. */
export function moduleExamRouteMatcher(file: string, code: string | null | undefined) {
  const {routes: declarations, ambiguousLegacyKeys, ambiguousLegacyLines} = code ? scanRoutes(file, code) : {routes: []};
  const byPosition = new Map(declarations.map(route => [moduleExamRouteKey(route), route]));
  const legacyAllowed = Boolean(code && !code.includes('…'));
  const byLegacyKey = new Map(declarations.filter(route => legacyAllowed && !ambiguousLegacyLines?.has(route.line)
    && !ambiguousLegacyKeys?.has(legacyRouteKey(route)))
    .map(route => [legacyRouteKey(route), route]));
  return (route: ModuleExamRoute) => route.column === undefined
    ? byLegacyKey.get(legacyRouteKey(route)) : byPosition.get(moduleExamRouteKey(route));
}

const unsupportedSource = /\.(?:[jt]sx|vue|svelte|astro|html?|py|rb|php|go|java|kt|kts|scala|cs|fs|rs|swift|exs?|clj[cs]?|dart|lua|pl|r|jl|[ch](?:pp|xx|c)?|m|mm|sh|bash|zsh|fish|ps1|sql|graphql|gql)$/i;
type Factory = 'express' | 'router' | 'hono' | 'fastify';
const defaultFactories = new Map<string, Factory>([['express', 'express'], ['fastify', 'fastify']]);
const namedFactories = new Map<string, Factory>([['express:Router', 'router'], ['hono:Hono', 'hono']]);
const singlePropertyWriters = new Set(['Object.defineProperty', 'Reflect.defineProperty', 'Reflect.set', 'Reflect.deleteProperty']);
const receiverWriters = new Set(['Object.assign', 'Object.defineProperties', 'Object.setPrototypeOf', 'Reflect.setPrototypeOf']);

type SourceTokens = NonNullable<ReturnType<typeof scanModuleExamSource>>;
function literalProperty(token: SourceTokens[number] | undefined) {
  return token?.kind === 'literal' && !token.text.includes('\\') ? token.text.slice(1, -1) : null;
}

function routeMember(tokens: SourceTokens, depths: number[], index: number) {
  let at = index + 1;
  const optional = tokens[at]?.text === '?' && tokens[at + 1]?.text === '.';
  if (optional) at += 2;
  if (tokens[at]?.text === '[') {
    // The depth check has already verified that every opening bracket closes.
    let close = at + 1;
    while (depths[close] > depths[at] + 1 || tokens[close]?.text !== ']') close++;
    return {method: close === at + 2 ? literalProperty(tokens[at + 1]) : null, next: close + 1, direct: false};
  }
  if (!optional && tokens[at++]?.text !== '.') return null;
  const property = tokens[at];
  return property?.kind === 'word' ? {method: property.text, next: at + 1, direct: !optional} : null;
}

function writesMember(tokens: SourceTokens, start: number, end: number) {
  if (tokens[start - 1]?.text === 'delete') return true;
  const operatorBefore = tokens.slice(Math.max(0, start - 2), start).map(token => token.text).join('');
  if (operatorBefore === '++' || operatorBefore === '--') return true;
  const operatorAfter = tokens.slice(end, end + 4).map(token => token.text).join('');
  return /^(?:=(?!=)|(?:[+%&|^*-]|&&|\|\||\?\?|\*\*|>{2,3})=(?!=)|\+\+|--)/u.test(operatorAfter);
}

function scanRoutes(file: string, code: string): RouteInventory {
  if (!isModuleExamScript(file)) return {routes: [], omissions: unsupportedSource.test(file) ? ['linguagem não inventariada'] : []};
  const tokens = scanModuleExamSource(code);
  const depths = tokens && moduleExamDepths(tokens);
  if (!tokens || !depths) return {routes: [], omissions: ['sintaxe não reconhecida']};
  const candidates: {route: LocatedRoute; receiver: string; method: string}[] = [];
  const seenLegacyKeys = new Set<string>();
  const ambiguousLegacyKeys = new Set<string>();
  const ambiguousLegacyLines = new Set<number>();
  const factories = new Map<string, Factory>();
  const receivers = new Set<string>();
  const mutations = new Map<string, Set<string | null>>();
  const omissions = new Set<RouteOmission>();
  const token = (index: number) => tokens[index]?.text;
  const word = (index: number) => tokens[index]?.kind === 'word' ? tokens[index]!.text : undefined;
  const startsStatement = (index: number) => depths[index] === 0 && (index === 0 || token(index - 1) === ';');
  const endsStatement = (index: number) => index === tokens.length || token(index) === ';';
  const recordMutation = (receiver: string, method: string | null) => {
    if (!mutations.has(receiver)) mutations.set(receiver, new Set());
    mutations.get(receiver)!.add(method);
  };
  for (let start = 0; start < tokens.length; start++) {
    if (token(start) !== 'import' || !startsStatement(start)) continue;
    const named = token(start + 1) === '{';
    const alias = named && token(start + 3) === 'as';
    const binding = word(start + (named ? alias ? 4 : 2 : 1));
    const from = start + (named ? alias ? 6 : 4 : 2);
    if (!binding || (named && token(from - 1) !== '}') || token(from) !== 'from' || !endsStatement(from + 2)) continue;
    const source = token(from + 1);
    if (!source || !/^['"](?:express|fastify|hono)['"]$/u.test(source)) continue;
    const module = source.slice(1, -1);
    const factory = named ? namedFactories.get(`${module}:${word(start + 2)}`) : defaultFactories.get(module);
    if (factory) factories.set(binding, factory);
  }
  for (const [index, receiver] of tokens.entries()) {
    const root = startsStatement(index);
    if (root && receiver.text === 'const' && word(index + 1) && token(index + 2) === '=') {
      const construct = token(index + 3) === 'new';
      const at = index + (construct ? 4 : 3);
      const factory = factories.get(token(at) ?? '');
      const router = factory === 'express' && token(at + 1) === '.' && token(at + 2) === 'Router';
      const open = at + (router ? 3 : 1);
      if (factory && construct === (factory === 'hono') && token(open) === '(' && token(open + 1) === ')' && endsStatement(open + 2)) {
        receivers.add(word(index + 1)!);
      }
    }
    if (!isDirectIdentifier(tokens, index)) continue;
    const helper = `${receiver.text}.${token(index + 2)}`;
    const writtenReceiver = word(index + 4);
    if (writtenReceiver && token(index + 1) === '.' && token(index + 3) === '(' && token(index + 5) === ',') {
      if (receiverWriters.has(helper)) recordMutation(writtenReceiver, null);
      if (singlePropertyWriters.has(helper)) {
        const property = token(index + 7) === ',' ? literalProperty(tokens[index + 6]) : null;
        recordMutation(writtenReceiver, property);
      }
    }
    const member = routeMember(tokens, depths, index);
    if (!member || (member.method !== null && !routeMethods.has(member.method))) continue;
    const {method, next} = member;
    if (writesMember(tokens, index, next)) recordMutation(receiver.text, method);
    const optionalCall = token(next) === '?' && token(next + 1) === '.';
    const open = next + (optionalCall ? 2 : 0);
    if (token(open) !== '(') continue;
    const known = receivers.has(receiver.text);
    const argument = tokens[open + 1];
    const path = argument?.kind === 'literal' ? argument.text.slice(1, -1) : '';
    const call = moduleExamCall(tokens, open);
    const handler = call && call.commas[0] === open + 2 && (call.commas[1] ?? call.close) > open + 3;
    const indirect = !member.direct || optionalCall;
    if (!(path.startsWith('/') || path === '*') || path.length > 200 || /[\\\u0000-\u001f\u007f…]/u.test(path) || !handler) {
      if (known) {
        omissions.add(indirect ? 'acesso indexado ou dinâmico' : 'declaração fora do subconjunto');
        if (indirect) ambiguousLegacyLines.add(receiver.line);
      }
      continue;
    }
    if (method === null) {
      omissions.add('acesso indexado ou dinâmico');
      ambiguousLegacyLines.add(receiver.line);
      continue;
    }
    const column = receiver.start - code.lastIndexOf('\n', receiver.start - 1);
    const route = {file, line: receiver.line, column, method: method.toUpperCase(), path};
    const key = legacyRouteKey(route);
    if (seenLegacyKeys.has(key)) ambiguousLegacyKeys.add(key);
    seenLegacyKeys.add(key);
    if (indirect) omissions.add('acesso indexado ou dinâmico');
    else if (!root || !known) omissions.add('declaração fora do subconjunto');
    else candidates.push({route, receiver: receiver.text, method});
  }
  // A write in a callback may run before registration, regardless of source order.
  const routes = candidates.filter(({receiver, method}) => {
    const written = mutations.get(receiver);
    if (!written?.has(null) && !written?.has(method)) return true;
    omissions.add('método do receptor sobrescrito');
    return false;
  }).map(({route}) => route);
  return {routes, omissions: [...omissions], ambiguousLegacyKeys, ambiguousLegacyLines};
}

export function findModuleExamRoutes(file: string, code: string): LocatedRoute[] {
  return scanRoutes(file, code).routes;
}

export async function readModuleExamFile(absolute: string, file: string, includeRoutes = false): Promise<ModuleExamFile & {
  routeInventory?: RouteInventory;
}> {
  if (secretName(file)) return {file, code: null, reason: 'arquivo de credenciais omitido'};
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return {file, code: null, reason: 'arquivo excede limite ou não é regular'};
    const buffer = await handle.readFile();
    if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) return {file, code: null, reason: 'arquivo binário ou excede limite'};
    // Keep the BOM so collectors can bind evidence to the exact UTF-8 bytes.
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer);
    const code = redactModuleExamText(decoded);
    if (!includeRoutes) return {file, code, reason: null};
    const declarations = scanRoutes(file, decoded);
    if (!declarations.routes.length || decoded === code) return {file, code, reason: null, routeInventory: declarations};
    const visible = new Set(findModuleExamRoutes(file, code).map(moduleExamRouteKey));
    const routes = declarations.routes.filter(route => visible.has(moduleExamRouteKey(route)));
    const omissions = [...declarations.omissions];
    if (routes.length !== declarations.routes.length) omissions.push('declaração ocultada pelo saneamento');
    return {file, code, reason: null, routeInventory: {routes, omissions}};
  } catch {
    return {file, code: null, reason: 'leitura indisponível'};
  } finally {
    await handle?.close();
  }
}

/** Does not follow symlinks or open secret-class files. Can aggregate unavailable entries by count. */
export async function mapModuleSnapshot(snapshot: string, signal?: AbortSignal,
  options?: {aggregateOmissions?: boolean}): Promise<ModuleExamMap> {
  const files: ModuleExamFile[] = [];
  const routes: ModuleExamRoute[] = [];
  const routeOmissionDetails: NonNullable<ModuleExamMap['routeOmissionDetails']> = [];
  let fileOmissions = 0;
  let routeOmissions = 0;
  let textFiles = 0;
  function addFile(row: ModuleExamFile): void {
    if (options?.aggregateOmissions && row.code === null) fileOmissions++;
    else files.push(row);
  }
  const vendored: {dir: string; files: number}[] = [];
  type VendorScope = {prefix: string; packages: ReadonlySet<string>; bucket: {dir: string; files: number}};
  async function walk(dir: string, prefix: string, scope?: VendorScope): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && SKIP.has(entry.name)) {
        addFile({file, code: null, reason: 'diretório não examinado'});
        continue;
      }
      try { assertModuleRepoRelativePath(file); }
      catch { addFile({file: file.slice(0, 400), code: null, reason: 'caminho não permitido'}); continue; }
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) { addFile({file, code: null, reason: 'link não seguido'}); continue; }
      if (((entry.isFile() || options?.aggregateOmissions) && secretName(file))
        || (options?.aggregateOmissions && hasKnownSecret(file))) {
        addFile({file, code: null, reason: 'arquivo de credenciais omitido'});
        continue;
      }
      if (entry.isDirectory()) {
        const packages = scope === undefined ? await goVendorPackages(absolute, entry.name) : undefined;
        if (packages !== undefined) {
          const bucket = {dir: file, files: 0};
          await walk(absolute, file, {prefix: file, packages, bucket});
          addFile({file, code: null, reason: `${VENDORED_REASON} (${bucket.files} arquivos)`});
          if (bucket.files) vendored.push(bucket);
          continue;
        }
        await walk(absolute, file, scope);
        continue;
      }
      // Arquivo de pacote listado no modules.txt: não entra no inventário nem no limite de arquivos textuais.
      if (scope !== undefined && entry.isFile() && isListedVendorFile(file.slice(scope.prefix.length + 1), scope.packages)) {
        scope.bucket.files += 1;
        continue;
      }
      if (!entry.isFile()) { addFile({file, code: null, reason: 'tipo não examinado'}); continue; }
      if (textFiles >= MAX_TEXT_FILES) { addFile({file, code: null, reason: 'limite de arquivos textuais atingido'}); continue; }
      const {routeInventory, ...mapped} = await readModuleExamFile(absolute, file, true);
      addFile(mapped);
      if (mapped.code === null) continue;
      textFiles++;
      if (routeInventory?.omissions.length) routeOmissions++;
      for (const reason of routeInventory?.omissions ?? []) routeOmissionDetails.push({file, reason});
      for (const route of routeInventory?.routes ?? []) routes.push(route);
    }
  }
  const root = await lstat(snapshot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('MODULE_EXAM_SNAPSHOT_INVALID');
  await walk(snapshot, '');
  return {files, routes, ...(fileOmissions ? {fileOmissions} : {}), routeOmissions, routeOmissionDetails, ...(vendored.length ? {vendored} : {})};
}
