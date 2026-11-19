import {Refusal} from './contracts.ts';
import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertModuleRepoRelativePath} from './verification-modules.ts';
import {isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {isDirectIdentifier, isModuleExamScript, moduleExamCall, moduleExamDepths, scanModuleExamSource} from './module-exam-syntax.ts';

/** Inventory is based only on a caller-owned, immutable git archive, never the live tree. */
export type ModuleExamFile = {file: string; code: string | null; reason: string | null};
export type ModuleExamRoute = {file: string; line: number; column?: number; method: string; path: string};
type LocatedRoute = ModuleExamRoute & {column: number};
type RouteOmission = 'linguagem não inventariada' | 'sintaxe não reconhecida' | 'declaração fora do subconjunto' | 'declaração ocultada pelo saneamento';
type RouteInventory = {routes: LocatedRoute[]; omissions: RouteOmission[]; ambiguousLegacyKeys?: Set<string>};
export type ModuleExamMap = {files: ModuleExamFile[]; routes: ModuleExamRoute[]; routeOmissions?: number;
  routeOmissionDetails?: {file: string; reason: RouteOmission}[]};
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
  const {routes: declarations, ambiguousLegacyKeys} = code ? scanRoutes(file, code) : {routes: []};
  const byPosition = new Map(declarations.map(route => [moduleExamRouteKey(route), route]));
  const legacyAllowed = Boolean(code && !code.includes('…'));
  const byLegacyKey = new Map(declarations.filter(route => legacyAllowed && !ambiguousLegacyKeys?.has(legacyRouteKey(route)))
    .map(route => [legacyRouteKey(route), route]));
  return (route: ModuleExamRoute) => route.column === undefined
    ? byLegacyKey.get(legacyRouteKey(route)) : byPosition.get(moduleExamRouteKey(route));
}

const unsupportedSource = /\.(?:[jt]sx|vue|svelte|astro|html?|py|rb|php|go|java|kt|kts|scala|cs|fs|rs|swift|exs?|clj[cs]?|dart|lua|pl|r|jl|[ch](?:pp|xx|c)?|m|mm|sh|bash|zsh|fish|ps1|sql|graphql|gql)$/i;
type Factory = 'express' | 'router' | 'hono' | 'fastify';
const defaultFactories = new Map<string, Factory>([['express', 'express'], ['fastify', 'fastify']]);
const namedFactories = new Map<string, Factory>([['express:Router', 'router'], ['hono:Hono', 'hono']]);

function scanRoutes(file: string, code: string): RouteInventory {
  if (!isModuleExamScript(file)) return {routes: [], omissions: unsupportedSource.test(file) ? ['linguagem não inventariada'] : []};
  const tokens = scanModuleExamSource(code);
  const depths = tokens && moduleExamDepths(tokens);
  if (!tokens || !depths) return {routes: [], omissions: ['sintaxe não reconhecida']};
  const routes: LocatedRoute[] = [];
  const seenLegacyKeys = new Set<string>();
  const ambiguousLegacyKeys = new Set<string>();
  const factories = new Map<string, Factory>();
  const receivers = new Set<string>();
  let omitted = false;
  const token = (index: number) => tokens[index]?.text;
  const word = (index: number) => tokens[index]?.kind === 'word' ? tokens[index]!.text : undefined;
  const startsStatement = (index: number) => depths[index] === 0 && (index === 0 || token(index - 1) === ';');
  const endsStatement = (index: number) => index === tokens.length || token(index) === ';';
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
    if (!isDirectIdentifier(tokens, index) || token(index + 1) !== '.') continue;
    const method = token(index + 2);
    if (!method || !routeMethods.has(method) || token(index + 3) !== '(') continue;
    const known = receivers.has(receiver.text);
    const argument = tokens[index + 4];
    const path = argument?.kind === 'literal' ? argument.text.slice(1, -1) : '';
    const call = moduleExamCall(tokens, index + 3);
    const handler = call && call.commas[0] === index + 5 && (call.commas[1] ?? call.close) > index + 6;
    if (!(path.startsWith('/') || path === '*') || path.length > 200 || /[\\\u0000-\u001f\u007f…]/u.test(path) || !handler) {
      if (known) omitted = true;
      continue;
    }
    const column = receiver.start - code.lastIndexOf('\n', receiver.start - 1);
    const route = {file, line: receiver.line, column, method: method.toUpperCase(), path};
    const key = legacyRouteKey(route);
    if (seenLegacyKeys.has(key)) ambiguousLegacyKeys.add(key);
    seenLegacyKeys.add(key);
    if (!root || !known) { omitted = true; continue; }
    routes.push(route);
  }
  return {routes, omissions: omitted ? ['declaração fora do subconjunto'] : [], ambiguousLegacyKeys};
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
    const decoded = new TextDecoder('utf-8', {fatal: true}).decode(buffer);
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

/** Does not follow symlinks or open secret-class files. Oversize, binary and unsafe paths remain visible as unjudged. */
export async function mapModuleSnapshot(snapshot: string, signal?: AbortSignal): Promise<ModuleExamMap> {
  const files: ModuleExamFile[] = [];
  const routes: ModuleExamRoute[] = [];
  const routeOmissionDetails: NonNullable<ModuleExamMap['routeOmissionDetails']> = [];
  let routeOmissions = 0;
  let textFiles = 0;
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && SKIP.has(entry.name)) {
        files.push({file, code: null, reason: 'diretório não examinado'});
        continue;
      }
      try { assertModuleRepoRelativePath(file); }
      catch { files.push({file: file.slice(0, 400), code: null, reason: 'caminho não permitido'}); continue; }
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) { files.push({file, code: null, reason: 'link não seguido'}); continue; }
      if (entry.isDirectory()) { await walk(absolute, file); continue; }
      if (!entry.isFile()) { files.push({file, code: null, reason: 'tipo não examinado'}); continue; }
      if (secretName(file)) { files.push({file, code: null, reason: 'arquivo de credenciais omitido'}); continue; }
      if (textFiles >= MAX_TEXT_FILES) { files.push({file, code: null, reason: 'limite de arquivos textuais atingido'}); continue; }
      const {routeInventory, ...mapped} = await readModuleExamFile(absolute, file, true);
      files.push(mapped);
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
  return {files, routes, routeOmissions, routeOmissionDetails};
}
