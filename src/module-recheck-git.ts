import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Refusal} from './contracts.ts';

const git = promisify(execFile);

function recheckGit(repo: string, args: string[], signal?: AbortSignal) {
  return git('/usr/bin/git', ['--no-replace-objects', '--literal-pathspecs', '-C', repo, ...args], {
    env: {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: ''},
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    signal,
  });
}

export async function recheckHead(repo: string, signal?: AbortSignal): Promise<string> {
  try {
    const {stdout} = await recheckGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], signal);
    const commit = stdout.trim();
    if (/^[a-f0-9]{40}$/.test(commit)) return commit;
  } catch {
    signal?.throwIfAborted();
  }
  throw new Refusal('VERIFY_COMMIT_INVALID', 400);
}

export async function readRecheckBlob(repo: string, commit: string, file: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40}$/.test(commit)) return;
  try {
    const {stdout: entry} = await recheckGit(repo, ['ls-tree', '--full-tree', '-z', commit, '--', file], signal);
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[2] !== file) return;
    const oid = match[1]!;
    const {stdout: text} = await recheckGit(repo, ['cat-file', 'blob', oid], signal);
    if (!text.includes('\0') && !text.includes('\uFFFD')) return {oid, text};
  } catch {
    signal?.throwIfAborted();
  }
}

export async function sameRecheckHistory(repo: string, original: string, head: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(original)) return false;
  try {
    await recheckGit(repo, ['merge-base', '--is-ancestor', original, head], signal);
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}
