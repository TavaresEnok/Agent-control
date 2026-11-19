import {Refusal} from './contracts.ts';
import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertModuleRepoRelativePath} from './verification-modules.ts';
import {isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {isDirectIdentifier, isModuleExamScript, moduleExamCall, scanModuleExamSource} from './module-exam-syntax.ts';

/** Inventory is based only on a caller-owned, immutable git archive, never the live tree. */
export type ModuleExamFile = {file: string; code: string | null; reason: string | null};
export type ModuleExamRoute = {file: string; line: number; method: string; path: string};
export type ModuleExamMap = {files: ModuleExamFile[]; routes: ModuleExamRoute[]; routeOmissions?: number};
const MAX_FILE_BYTES = 16000;
const MAX_TEXT_FILES = 10000;
const SKIP = new Set(['.git', 'node_modules', 'dist', '.ai', 'verificacoes', '.claude', '.codex', '.grok', '.aws', '.ssh', '.config']);
/** Drops secret previews while preserving original evidence line numbers. */
export function redactModuleExamText(text: string): string {
  return redactUnknownSecrets(text, match => '…' + match.replace(/[^\r\n]/g, ''));
}

const secretName = (file: string) => isSecretClassBasename(file) || /(^|[._-])(secret|secrets|credential|credentials|password|senha)([._-]|$)/i.test(file.split('/').at(-1)!) || /(^|\/)\.pypirc$/i.test(file);

const routeReceivers = new Set(['app', 'router', 'server']);
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
export const moduleExamRouteKey = ({file, line, method, path}: ModuleExamRoute) => JSON.stringify([file, line, method, path]);

/** Null means a source file had syntax outside the supported subset. */
function scanRoutes(file: string, code: string): ModuleExamRoute[] | null {
  if (!isModuleExamScript(file)) return [];
  const tokens = scanModuleExamSource(code);
  if (!tokens) return null;
  const routes: ModuleExamRoute[] = [];
  for (const [index, receiver] of tokens.entries()) {
    if (!routeReceivers.has(receiver.text) || !isDirectIdentifier(tokens, index) || tokens[index + 1]?.text !== '.') continue;
    const method = tokens[index + 2]?.text;
    if (!method || !routeMethods.has(method)) continue;
    const literal = tokens[index + 4];
    if (literal?.kind !== 'literal') continue;
    const path = literal.text.slice(1, -1);
    if (!(path.startsWith('/') || path === '*') || path.length > 200 || /[\\\u0000-\u001f\u007f…]/u.test(path)) continue;
    const call = moduleExamCall(tokens, index + 3);
    if (!call || call.commas[0] !== index + 5 || (call.commas[1] ?? call.close) <= index + 6) continue;
    routes.push({file, line: receiver.line, method: method.toUpperCase(), path});
  }
  return routes;
}

export function findModuleExamRoutes(file: string, code: string): ModuleExamRoute[] {
  return scanRoutes(file, code) ?? [];
}

export async function readModuleExamFile(absolute: string, file: string, includeRoutes = false): Promise<ModuleExamFile & {
  routeInventory?: ModuleExamRoute[] | null;
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
    if (!declarations?.length || decoded === code) return {file, code, reason: null, routeInventory: declarations};
    const visible = new Set(findModuleExamRoutes(file, code).map(moduleExamRouteKey));
    return {file, code, reason: null, routeInventory: declarations.filter(route => visible.has(moduleExamRouteKey(route)))};
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
      if (routeInventory === null) routeOmissions++;
      for (const route of routeInventory ?? []) routes.push(route);
    }
  }
  const root = await lstat(snapshot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('MODULE_EXAM_SNAPSHOT_INVALID');
  await walk(snapshot, '');
  return {files, routes, routeOmissions};
}
