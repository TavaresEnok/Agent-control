import {lstat, readdir, realpath} from 'node:fs/promises';
import {basename, extname, isAbsolute, join, relative, sep} from 'node:path';
import type {ChecklistItem} from './verify-types.ts';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', '.ai', 'verificacoes']);
const SLICE_SIZE = 15;
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

export async function listExamFiles(repo: string): Promise<string[]> {
  const root = await realpath(repo);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error('REPOSITORIO_INVALIDO');
  const found: string[] = [];
  await walk(root, root, found);
  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return found;
}

async function walk(root: string, dir: string, found: string[]): Promise<void> {
  const entries = await readdir(dir, {withFileTypes: true});
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, absolute, found);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const listed = await linkedFileInside(root, absolute);
      if (listed) found.push(listed);
      continue;
    }
    if (entry.isFile()) found.push(toPosix(relative(root, absolute)));
  }
}

/** Symlinks that resolve outside the repo are dropped. Directory links are not walked. */
async function linkedFileInside(root: string, absolute: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return null;
  }
  if (!isInside(root, real)) return null;
  const fromRoot = relative(root, real);
  if (fromRoot.split(sep).some(part => SKIP_DIRECTORIES.has(part))) return null;
  const target = await lstat(real);
  if (!target.isFile()) return null;
  return toPosix(relative(root, absolute));
}

function isInside(root: string, real: string): boolean {
  const rel = relative(root, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function sliceExamFiles(files: readonly string[], checklist: readonly ChecklistItem[]): {id: string; files: string[]; checklist: string[]}[] {
  const slices: {id: string; files: string[]; checklist: string[]}[] = [];
  for (let start = 0; start < files.length; start += SLICE_SIZE) {
    const chunk = [...files.slice(start, start + SLICE_SIZE)];
    const kinds = new Set<string>();
    for (const file of chunk) for (const kind of kindsOf(file)) kinds.add(kind);
    slices.push({
      id: `fatia-${slices.length + 1}`,
      files: chunk,
      checklist: checklist.filter(item => kinds.has(item.appliesTo)).map(item => item.id),
    });
  }
  return slices;
}

function kindsOf(file: string): Set<string> {
  const kinds = new Set<string>(['any']);
  const base = basename(file);
  const extension = extname(base).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) {
    kinds.add('code');
    if (/(api|route|server)/i.test(file)) kinds.add('route');
  }
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) kinds.add('dockerfile');
  if (isDependency(base)) kinds.add('dependency');
  if ((extension === '.yml' || extension === '.yaml') && /compose/i.test(file)) kinds.add('config');
  if (isSecretName(base)) kinds.add('secret');
  return kinds;
}

function isDependency(base: string): boolean {
  if (base === 'package.json' || base === 'npm-shrinkwrap.json') return true;
  return base.endsWith('.lock') || /(?:^|[.-])lock\.(?:json|ya?ml)$/i.test(base);
}

function isSecretName(base: string): boolean {
  const name = base.toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.pypirc' || name === '.netrc' || name === '.pgpass') return true;
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i.test(name)) return true;
  return /(^|[._-])(secret|secrets|credential|credentials|password|senha)([._-]|$)/i.test(name);
}
