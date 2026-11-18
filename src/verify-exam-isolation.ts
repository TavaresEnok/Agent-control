import {constants} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Basenames removed from the exam copy. Match is case-insensitive. */
const EXAM_HOSTILE_NAMES = new Set(['.claude', '.mcp.json', '.codex', '.grok', '.cursor', 'claude.md', 'agents.md', 'grok.md', 'claude.local.md', '.agents']);

export function isExamHostileName(name: string): boolean {
  return EXAM_HOSTILE_NAMES.has(name.toLowerCase());
}

/**
 * Remove hostile agent config from an exam copy. A symlink is unlinked and never followed,
 * whether or not its name is hostile. The original repository is not this tree.
 */
export async function stripExamHostileConfig(root: string): Promise<void> {
  const entries = await readdir(root, {withFileTypes: true});
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(path);
      continue;
    }
    if (isExamHostileName(entry.name)) {
      await rm(path, {recursive: true, force: true});
      continue;
    }
    if (!entry.isDirectory()) continue;
    await stripExamHostileConfig(path);
  }
}

/** Argv the exam wrapper execs. `--setting-sources user` is first; every `--mcp-config` pair is dropped. */
export function examClaudeArgv(runnerArgv: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < runnerArgv.length; i += 1) {
    if (runnerArgv[i] === '--mcp-config') {
      i += 1;
      continue;
    }
    filtered.push(runnerArgv[i]!);
  }
  return ['--setting-sources', 'user', ...filtered];
}

/** CommonJS wrapper. `/tmp` has no `"type":"module"`, and a `.cjs` file stays CommonJS inside this repo too. */
export function examClaudeWrapperSource(realBin: string): string {
  return `#!${process.execPath}
const {spawn} = require('node:child_process');
const real = ${JSON.stringify(realBin)};
const incoming = process.argv.slice(2);
const args = ['--setting-sources', 'user'];
for (let i = 0; i < incoming.length; i += 1) {
  if (incoming[i] === '--mcp-config') { i += 1; continue; }
  args.push(incoming[i]);
}
const child = spawn(real, args, {stdio: 'inherit'});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code == null ? 1 : code);
});
child.on('error', () => process.exit(127));
`;
}

/** Executable wrapper on the container tmpfs. Only the exam worker should pass this as Claude's bin. */
export async function installExamClaudeWrapper(directory: string, realBin: string): Promise<string> {
  const file = join(directory, 'ac-exam-claude.cjs');
  await writeFile(file, examClaudeWrapperSource(realBin), {mode: 0o700});
  await chmod(file, 0o700);
  return file;
}

const PROJECT_CODEX_CONFIG = /(?:^|\/)\.codex\/config\.toml$/i;

/**
 * Exam Codex argv. This repository documents `-c key=value`, `--sandbox` and `-C` for `codex exec`,
 * and no flag that disables a project config. Do not add one. Drop only arguments that name `.codex/config.toml`.
 */
export function examCodexArgv(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === '--config' && next !== undefined && PROJECT_CODEX_CONFIG.test(next)) {
      i += 1;
      continue;
    }
    if (PROJECT_CODEX_CONFIG.test(arg)) continue;
    out.push(arg);
  }
  return out;
}

export function examAccountMount(source: string, exam: boolean): {source: string; destination: '/account'; writable: boolean} {
  return {source, destination: '/account', writable: !exam};
}

/** Docker bind spec. The exam account mount uses `:ro`; every other mount keeps its own writable bit. */
export function describeBind(mount: {source: string; destination: string; writable: boolean}): string {
  return mount.source + ':' + mount.destination + (mount.writable ? ':rw' : ':ro');
}

/** `AC_VERIFY_EXAM=1` is added only for the exam. A non-exam list is returned unchanged. */
export function examWorkerEnv(base: readonly string[], exam: boolean): string[] {
  if (!exam) return [...base];
  if (base.some(entry => entry.startsWith('AC_VERIFY_EXAM='))) return [...base];
  return [...base, 'AC_VERIFY_EXAM=1'];
}

/** Homes inside the writable login copy. They replace `/account`, never the source directory. */
export function examLoginHomes(copyRoot: string): {claudeConfigDir: string; codexHome: string; grokHome: string} {
  return {claudeConfigDir: copyRoot, codexHome: join(copyRoot, '.codex'), grokHome: copyRoot};
}

/** Credential and config files the exam CLIs read. Caches, sessions and logs are left behind. */
const EXAM_LOGIN_FILES = [
  '.credentials.json', '.claude.json', 'settings.json', '.claude/settings.json',
  '.codex/auth.json', '.codex/config.toml', '.grok/auth.json', '.grok/config.toml',
] as const;

/**
 * Paths the exam must not read. A single leading slash in user settings anchors at CLAUDE_CONFIG_DIR,
 * so each path is also emitted with `//`, which Claude treats as absolute.
 */
const EXAM_DENY_PATHS = [
  '/account/.credentials.json', '/tmp/ac-exam-login-*', '/tmp/ac-exam-login-*/**',
  '/proc/self/environ', '/runner', '/runner/**',
] as const;

function examReadDenyRules(): string[] {
  const rules: string[] = [];
  for (const entry of EXAM_DENY_PATHS) {
    for (const tool of ['Read', 'Grep', 'Glob']) {
      rules.push(`${tool}(${entry})`, `${tool}(/${entry})`);
    }
  }
  return rules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeExamDeny(base: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = {...base};
  const permissions = isRecord(doc.permissions) ? {...doc.permissions} : {};
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  for (const rule of examReadDenyRules()) {
    if (!deny.includes(rule)) deny.push(rule);
  }
  permissions.deny = deny;
  doc.permissions = permissions;
  return doc;
}

/** Read a regular file. A symlink yields undefined and is not followed. */
async function readUnfollowed(file: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return undefined;
    throw error;
  }
  try { return await handle.readFile({encoding: 'utf8'}); }
  finally { await handle.close(); }
}

/** Merge Read, Grep and Glob denies into a settings file. Symlinks are not followed. Mode is 0600. */
async function writeSettingsWithDeny(file: string, create: boolean): Promise<void> {
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!info && !create) return;
  if (info?.isSymbolicLink()) {
    if (!create) return;
    await unlink(file);
    info = undefined;
  }
  if (info && !info.isFile()) return;
  let base: Record<string, unknown> = {};
  if (info?.isFile()) {
    const text = await readUnfollowed(file);
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) base = parsed;
      } catch { /* an unreadable settings file is replaced by the deny document */ }
    }
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(mergeExamDeny(base)));
    await handle.chmod(0o600);
  } finally { await handle.close(); }
}

const CODEX_CONTAINER_SANDBOX_LIMIT = [
  'Codex stays on the container sandbox.',
  'A read-only Codex sandbox cannot start inside the worker container, so the exam does not switch Codex off that sandbox.',
  'Reads of these paths are not denied by Codex: /account/.credentials.json, /tmp/ac-exam-login-*, /proc/self/environ, /runner.',
  '',
].join('\n');

/**
 * Copy credential and config files onto tmpfs. Regular files are new inodes.
 * Symlinks are recreated and not followed, so writing into the copy does not change the source.
 */
export async function prepareExamLoginCopy(source: string, tmpRoot = '/tmp'): Promise<string> {
  const rootInfo = await lstat(source);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw Error('EXAM_LOGIN_SOURCE_INVALID');
  const parent = await mkdtemp(join(tmpRoot, 'ac-exam-login-'));
  const dest = join(parent, 'home');
  await mkdir(dest, {mode: 0o700});
  for (const relative of EXAM_LOGIN_FILES) await copyLoginFile(source, dest, relative);
  await writeSettingsWithDeny(join(dest, 'settings.json'), true);
  const claudeDir = join(dest, '.claude');
  let claudeInfo;
  try { claudeInfo = await lstat(claudeDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (claudeInfo?.isDirectory()) await writeSettingsWithDeny(join(claudeDir, 'settings.json'), false);
  const limit = join(dest, 'codex-container-sandbox-limit.txt');
  const handle = await open(limit, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(CODEX_CONTAINER_SANDBOX_LIMIT);
    await handle.chmod(0o600);
  } finally { await handle.close(); }
  return dest;
}

/** Copy one allowlisted path. A symlink is recreated at the first link and not followed. */
async function copyLoginFile(sourceRoot: string, destRoot: string, relative: string): Promise<void> {
  const parts = relative.split('/');
  let fromDir = sourceRoot;
  let toDir = destRoot;
  for (let i = 0; i < parts.length; i += 1) {
    const from = join(fromDir, parts[i]!);
    const to = join(toDir, parts[i]!);
    let info;
    try { info = await lstat(from); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      let existing;
      try { existing = await lstat(to); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!existing) await symlink(await readlink(from), to);
      return;
    }
    const last = i === parts.length - 1;
    if (last) {
      if (!info.isFile()) return;
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, info.mode & 0o777);
      return;
    }
    if (!info.isDirectory()) return;
    try { await mkdir(to, {mode: 0o700}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const created = await lstat(to);
      if (!created.isDirectory()) return;
    }
    fromDir = from;
    toDir = to;
  }
}
