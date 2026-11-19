import {Refusal} from './contracts.ts';
import {constants} from 'node:fs';
import {lstat, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertModuleRepoRelativePath} from './verification-modules.ts';
import {isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';

/** Inventory is based only on a caller-owned, immutable git archive, never the live tree. */
export type ModuleExamFile = {file: string; code: string | null; reason: string | null};
export type ModuleExamRoute = {file: string; line: number; method: string; path: string};
export type ModuleExamMap = {files: ModuleExamFile[]; routes: ModuleExamRoute[]};
const MAX_FILE_BYTES = 16000;
const MAX_TEXT_FILES = 10000;
const SKIP = new Set(['.git', 'node_modules', 'dist', '.ai', 'verificacoes', '.claude', '.codex', '.grok', '.aws', '.ssh', '.config']);
/** Drops secret previews while preserving original evidence line numbers. */
export function redactModuleExamText(text: string): string {
  return redactUnknownSecrets(text, match => '…' + match.replace(/[^\r\n]/g, ''));
}

const secretName = (file: string) => isSecretClassBasename(file) || /(^|[._-])(secret|secrets|credential|credentials|password|senha)([._-]|$)/i.test(file.split('/').at(-1)!) || /(^|\/)\.pypirc$/i.test(file);

/** Does not follow symlinks or open secret-class files. Oversize, binary and unsafe paths remain visible as unjudged. */
export async function mapModuleSnapshot(snapshot: string, signal?: AbortSignal): Promise<ModuleExamMap> {
  const files: ModuleExamFile[] = [];
  const routes: ModuleExamRoute[] = [];
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
      let handle;
      try {
        handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) { files.push({file, code: null, reason: 'arquivo excede limite ou não é regular'}); continue; }
        const buffer = await handle.readFile();
        if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) { files.push({file, code: null, reason: 'arquivo binário ou excede limite'}); continue; }
        const decoded = new TextDecoder('utf-8', {fatal: true}).decode(buffer);
        const code = redactModuleExamText(decoded);
        files.push({file, code, reason: null});
        textFiles++;
        const lines = code.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const match = /\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`$]{1,200})['"`]/i.exec(lines[i]!);
          if (match) routes.push({file, line: i + 1, method: match[1]!.toUpperCase(), path: match[2]!});
        }
      } catch { files.push({file, code: null, reason: 'leitura indisponível'}); }
      finally { await handle?.close(); }
    }
  }
  const root = await lstat(snapshot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('MODULE_EXAM_SNAPSHOT_INVALID');
  await walk(snapshot, '');
  return {files, routes};
}
