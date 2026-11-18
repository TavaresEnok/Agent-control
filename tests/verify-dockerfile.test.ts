import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {delimiter, join} from 'node:path';
import {test} from 'node:test';

const buildFile = 'deploy/Dockerfile.verify';
const fetchScript = 'deploy/verify-fetch-tools.py';
const installScript = 'deploy/verify-install-tools.py';
const lockFile = 'deploy/verify-tools.lock.json';
const baseDigest = 'sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2';

function aptPackages(installLine: string): string[] {
  const after = installLine.split('apt-get install')[1] ?? '';
  return after
    .replace(/\\/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0 && !token.startsWith('-'));
}

function hadolintOnPath(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'hadolint');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

test('os scripts substituem o heredoc e a conferência de checksum permanece', () => {
  const source = readFileSync(buildFile, 'utf8');
  assert.equal(source.includes('<<'), false);
  assert.equal(source.includes("<<'PY'"), false);
  assert.match(source, /sha256sum -c checksums\.txt/);
  assert.match(source, /COPY verify-tools\.lock\.json/);
  assert.match(source, /COPY verify-fetch-tools\.py/);
  assert.match(source, /COPY verify-install-tools\.py/);
  assert.match(source, /python3\s+\/tmp\/verify-fetch-tools\.py/);
  assert.match(source, /python3\s+\/tmp\/verify-install-tools\.py/);
  for (const name of [fetchScript, installScript]) {
    assert.equal(existsSync(name), true, name);
    assert.equal(/latest/i.test(readFileSync(name, 'utf8')), false, name);
  }
});

test('apt fica com versão fixa e a origem de opengrep e checkov permanece conferida', () => {
  const source = readFileSync(buildFile, 'utf8');
  const installLines = source.split('\n').filter(line => line.includes('apt-get install'));
  assert.equal(installLines.length, 2);
  const [toolsStage, runtimeStage] = installLines;
  assert.deepEqual(
    aptPackages(toolsStage).map(pkg => pkg.split('=')[0]),
    ['ca-certificates', 'python3'],
  );
  assert.deepEqual(
    aptPackages(runtimeStage).map(pkg => pkg.split('=')[0]),
    ['ca-certificates', 'curl', 'findutils', 'git', 'zlib1g'],
  );
  for (const line of installLines) {
    const packages = aptPackages(line);
    assert.ok(packages.length > 0, line);
    for (const pkg of packages) {
      assert.match(pkg, /^[a-z0-9][a-z0-9+.-]*=\S+$/);
    }
  }
  const comments = source.split('\n').filter(line => /^\s*#/.test(line)).join('\n');
  assert.match(comments, /opengrep/i);
  assert.match(comments, /checkov/i);
  const lock = readFileSync(lockFile, 'utf8');
  assert.equal(lock.includes('37e93f4da5fd04a18c5c1febbdd12f7e98dfccd4d0c9cf2593bcb25eeb462da0'), true);
  assert.equal(lock.includes('8b088b4b7c0ffffa47c5c463978057187c457b62ccdcc2137697d5b3be3de79e'), true);
  assert.equal(source.split(baseDigest).length - 1, 2);
});

test('hadolint aceita o arquivo de build quando o binário está no PATH', t => {
  const binary = hadolintOnPath();
  if (!binary) {
    t.skip('hadolint não está no PATH; a análise foi pulada');
    return;
  }
  const result = spawnSync(binary, [buildFile], {encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
});
