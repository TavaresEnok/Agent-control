import {spawn} from 'node:child_process';
import {Refusal} from './contracts.ts';

/** One Git environment for every exam snapshot: no system or global config, no lazy fetch from a promisor remote, no transport. */
export const GIT_ARCHIVE_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

export const ARCHIVE_TIMEOUT_MS = 60_000;

/**
 * `git archive <commit> | tar -x` into `destination`. `--no-replace-objects` keeps a `refs/replace` entry in the
 * examined repository from swapping the commit's content while the report still names the original commit.
 * `keepPermissions` pins `tar.umask=0022` and `--same-permissions` (the personal static exam reads as another user).
 * A failed archive or extraction is VERIFY_COMMIT_INVALID; a spawn error or the timeout is VERIFY_TOOLS_FAILED.
 */
export function extractGitArchive(repo: string, commit: string, destination: string, options: {keepPermissions?: boolean; timeoutMs?: number} = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const git = spawn('/usr/bin/git', ['--no-replace-objects', '-C', repo, '-c', 'core.hooksPath=/dev/null', ...(options.keepPermissions ? ['-c', 'tar.umask=0022'] : []), 'archive', '--format=tar', commit], {
      env: GIT_ARCHIVE_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tar = spawn('/usr/bin/tar', ['-x', ...(options.keepPermissions ? ['--same-permissions'] : []), '-C', destination, '-f', '-'], {
      env: {PATH: '/usr/bin:/bin'},
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        git.kill('SIGKILL');
        tar.kill('SIGKILL');
        reject(error);
      } else resolvePromise();
    };
    timer = setTimeout(() => finish(new Refusal('VERIFY_TOOLS_FAILED')), options.timeoutMs ?? ARCHIVE_TIMEOUT_MS);
    git.stdout?.pipe(tar.stdin);
    git.once('error', () => finish(new Refusal('VERIFY_TOOLS_FAILED')));
    tar.once('error', () => finish(new Refusal('VERIFY_TOOLS_FAILED')));
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    const maybe = () => {
      if (gitCode === null || tarCode === null) return;
      finish(gitCode === 0 && tarCode === 0 ? undefined : new Refusal('VERIFY_COMMIT_INVALID', 400));
    };
    git.once('close', code => { gitCode = code ?? 1; maybe(); });
    tar.once('close', code => { tarCode = code ?? 1; maybe(); });
  });
}

/**
 * Files in the examined tree that tell a scanner to hide findings: a repository must not grade itself.
 * Inline markers (gitleaks:allow, nosemgrep) are turned off by the entrypoint flags; these are the files.
 */
const SUPPRESSION_NAMES = new Set([
  '.gitleaks.toml', '.gitleaksignore', '.semgrepignore', '.trivyignore', '.trivyignore.yaml', 'trivy.yaml', 'trivy-secret.yaml',
  'osv-scanner.toml', '.checkov.yml', '.checkov.yaml', '.hadolint.yaml', '.hadolint.yml', '.grype.yaml', '.grype.yml', '.syft.yaml',
]);

export function isScannerSuppressionName(name: string): boolean {
  return SUPPRESSION_NAMES.has(name.toLowerCase());
}

/** Removes suppression files at any depth from an exam copy and returns their paths, `/`-separated, sorted. Symlinks are not followed. */
export async function stripScannerSuppressions(root: string): Promise<string[]> {
  const {readdir, rm} = await import('node:fs/promises');
  const {join, relative, sep} = await import('node:path');
  const removed: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (isScannerSuppressionName(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
        await rm(path, {force: true});
        removed.push(relative(root, path).split(sep).join('/'));
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
    }
  };
  await walk(root);
  return removed.sort();
}

/** Portuguese report note. Undefined when nothing was removed. */
export function suppressionNote(removed: readonly string[]): string | undefined {
  if (!removed.length) return undefined;
  const shown = removed.slice(0, 20).join(', ');
  return `Arquivos de supressão do próprio projeto foram ignorados no exame (${removed.length}): ${shown}${removed.length > 20 ? ` e mais ${removed.length - 20}` : ''}. As marcas gitleaks:allow e nosemgrep também não valem.`;
}
