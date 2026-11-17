import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {delimiter, join} from 'node:path';
import {test} from 'node:test';

const buildFile = 'deploy/Dockerfile.verify';
const fetchScript = 'deploy/verify-fetch-tools.py';
const installScript = 'deploy/verify-install-tools.py';

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

test('hadolint aceita o arquivo de build quando o binário está no PATH', t => {
  const binary = hadolintOnPath();
  if (!binary) {
    t.skip('hadolint não está no PATH; a análise foi pulada');
    return;
  }
  const result = spawnSync(binary, [buildFile], {encoding: 'utf8'});
  assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
});
