import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {VERIFY_RUNTIME_BIN, verifyExamArguments} from '../src/verify-image.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('a imagem examina um repositório mínimo sem rede', t => {
  assert.equal(VERIFY_RUNTIME_BIN, 'docker');
  const probe = spawnSync(VERIFY_RUNTIME_BIN, ['version'], {encoding: 'utf8'});
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('binário de contêiner ausente');
    return;
  }
  const build = spawnSync(VERIFY_RUNTIME_BIN, ['build', '-f', 'deploy/Dockerfile.verify', '-q', 'deploy'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(build.status, 0, (build.stderr ?? '').slice(-4000));
  const image = (build.stdout ?? '').trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const directory = mkdtempSync(join(tmpdir(), 'verify-lab-'));
  const repository = join(directory, 'repo');
  const databases = join(directory, 'databases');
  const output = join(directory, 'output');
  try {
    mkdirSync(repository);
    mkdirSync(join(databases, 'grype'), {recursive: true});
    mkdirSync(join(databases, 'trivy'), {recursive: true});
    mkdirSync(join(databases, 'osv'), {recursive: true});
    mkdirSync(output);
    chmodSync(output, 0o777);
    writeFileSync(join(repository, 'Dockerfile'), 'FROM debian:bookworm\nUSER root\n');
    writeFileSync(join(repository, 'app.js'), 'function f(x){ return eval(x); }\n');
    writeFileSync(join(repository, 'package.json'), '{"name":"tiny","version":"1.0.0"}\n');
    const args = verifyExamArguments({
      image,
      repository,
      databases,
      output,
      memoryBytes: 2_147_483_648,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
    });
    assert.equal(args[0], VERIFY_RUNTIME_BIN);
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    const exam = spawnSync(args[0]!, args.slice(1), {encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024});
    assert.equal(exam.status, 0, `${exam.stdout ?? ''}\n${exam.stderr ?? ''}`.slice(-4000));
    const status = JSON.parse(readFileSync(join(output, 'status.json'), 'utf8')) as Record<string, number>;
    assert.equal(status.gitleaks, 0);
    assert.equal(status.syft, 0);
    assert.equal(status.opengrep, 0);
    assert.equal(status.hadolint, 0);
    assert.equal(status.checkov, 0);
    assert.equal(status['trivy-config'], 0);
    assert.equal(status['trivy-fs'], 0);
    const opengrep = JSON.parse(readFileSync(join(output, 'opengrep.json'), 'utf8')) as {results: unknown[]};
    assert.ok(opengrep.results.length >= 1);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
