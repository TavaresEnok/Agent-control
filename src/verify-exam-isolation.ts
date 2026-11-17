import {constants} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Basenames removed from the exam copy. Match is case-insensitive. */
const EXAM_HOSTILE_NAMES = new Set(['.claude', '.mcp.json', '.codex', '.grok', '.cursor', 'claude.md', 'agents.md', 'grok.md']);

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
    if (isExamHostileName(entry.name)) {
      if (entry.isSymbolicLink()) await unlink(path);
      else await rm(path, {recursive: true, force: true});
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
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

/**
 * Copy an account home onto tmpfs. Regular files are new inodes. Symlinks are recreated and not followed,
 * so writing into the copy does not change the source.
 */
export async function prepareExamLoginCopy(source: string, tmpRoot = '/tmp'): Promise<string> {
  const rootInfo = await lstat(source);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw Error('EXAM_LOGIN_SOURCE_INVALID');
  const parent = await mkdtemp(join(tmpRoot, 'ac-exam-login-'));
  const dest = join(parent, 'home');
  await mkdir(dest, {mode: 0o700});
  await copyLoginChildren(source, dest);
  return dest;
}

async function copyLoginChildren(source: string, dest: string): Promise<void> {
  for (const name of await readdir(source)) {
    const from = join(source, name);
    const to = join(dest, name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      await symlink(await readlink(from), to);
      continue;
    }
    if (info.isDirectory()) {
      await mkdir(to, {mode: 0o700});
      await copyLoginChildren(from, to);
      continue;
    }
    if (!info.isFile()) continue;
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await chmod(to, info.mode & 0o777);
  }
}
