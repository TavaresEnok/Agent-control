import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {VERIFY_RUNTIME_BIN, verifyDatabaseArguments, verifyExamArguments} from '../src/verify-image.ts';

const image = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const pinned = 'ghcr.io/example/verify:1.2.3@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const base = {
  image,
  repository: '/var/verify/repo',
  databases: '/var/verify/databases',
  output: '/var/verify/output',
  memoryBytes: 268435456,
  nanoCpus: 500_000_000,
  pidsLimit: 128,
};
const refused = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, name);
  return args[index + 1] ?? '';
}

function mounts(args: readonly string[]): string[] {
  return args.filter((_value, index) => args[index - 1] === '--mount');
}

test('o exame fica sem rede, sem root e sem socket', () => {
  const args = verifyExamArguments(base);
  assert.equal(args[0], VERIFY_RUNTIME_BIN);
  assert.equal(flag(args, '--network'), 'none');
  assert.equal(flag(args, '--user'), '65532:65532');
  assert.equal(flag(args, '--memory'), '268435456');
  assert.equal(flag(args, '--memory-swap'), '268435456');
  assert.equal(flag(args, '--pids-limit'), '128');
  assert.equal(flag(args, '--cpus'), '0.5');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop') && flag(args, '--cap-drop') === 'ALL');
  assert.equal(flag(args, '--security-opt'), 'no-new-privileges');
  const bound = mounts(args);
  assert.equal(bound.length, 3);
  assert.equal(bound[0], 'type=bind,src=/var/verify/repo,dst=/repository,readonly');
  assert.equal(bound[1], 'type=bind,src=/var/verify/databases,dst=/databases,readonly');
  assert.equal(bound[2], 'type=bind,src=/var/verify/output,dst=/output');
  assert.equal(bound.some(item => item.includes('.sock')), false);
  assert.equal(args.some(item => item.includes('.sock')), false);
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.at(-1), image);
});

test('nano CPUs inteiros viram a cota de CPU', () => {
  assert.equal(flag(verifyExamArguments({...base, nanoCpus: 1_000_000_000}), '--cpus'), '1');
  assert.equal(flag(verifyExamArguments({...base, nanoCpus: 1_500_000_000}), '--cpus'), '1.5');
});

test('imagem com digest e tag fixa também é aceita', () => {
  const args = verifyExamArguments({...base, image: pinned});
  assert.equal(args.at(-1), pinned);
  assert.equal(args[0], VERIFY_RUNTIME_BIN);
});

test('o exame recusa imagem solta, caminho, socket e rede', () => {
  assert.throws(() => verifyExamArguments({...base, image: 'trivy:latest'}), refused('VERIFY_IMAGE_UNPINNED'));
  assert.throws(() => verifyExamArguments({...base, image: 'example/verify:1.2.3'}), refused('VERIFY_IMAGE_UNPINNED'));
  assert.throws(() => verifyExamArguments({...base, image: ''}), refused('VERIFY_IMAGE_UNPINNED'));
  assert.throws(() => verifyExamArguments({...base, repository: '/var/verify/../repo'}), refused('VERIFY_PATH_FORBIDDEN'));
  assert.throws(() => verifyExamArguments({...base, output: '/var/verify/repo/out'}), refused('VERIFY_PATH_FORBIDDEN'));
  assert.throws(() => verifyExamArguments({...base, databases: '/var/run/docker.sock'}), refused('VERIFY_SOCKET_FORBIDDEN'));
  assert.throws(() => verifyExamArguments({...base, output: '/tmp/out --network host'}), refused('VERIFY_NETWORK_FORBIDDEN'));
  assert.throws(() => verifyExamArguments({...base, memoryBytes: 0}), refused('VERIFY_LIMITS_INVALID'));
});

test('o mount só aceita um caminho absoluto seguro', () => {
  assert.throws(() => verifyExamArguments({...base, repository: '/tmp/a,dst=/etc'}), refused('VERIFY_PATH_FORBIDDEN'));
  assert.throws(() => verifyDatabaseArguments({image: pinned, output: '/tmp/a,dst=/etc'}), refused('VERIFY_PATH_FORBIDDEN'));
  assert.throws(() => verifyExamArguments({...base, repository: '/tmp/../etc'}), refused('VERIFY_PATH_FORBIDDEN'));
  const args = verifyExamArguments({...base, repository: '/tmp/ok'});
  assert.equal(mounts(args)[0], 'type=bind,src=/tmp/ok,dst=/repository,readonly');
});

test('o limite de pids do exame é 512', () => {
  assert.equal(flag(verifyExamArguments({...base, pidsLimit: 256}), '--pids-limit'), '256');
  assert.equal(flag(verifyExamArguments({...base, pidsLimit: 512}), '--pids-limit'), '512');
  assert.throws(() => verifyExamArguments({...base, pidsLimit: 513}), refused('VERIFY_LIMITS_INVALID'));
});

test('o passo das bases escreve só o diretório de saída e não monta socket', () => {
  const args = verifyDatabaseArguments({image: pinned, output: '/var/verify/databases'});
  assert.equal(args[0], VERIFY_RUNTIME_BIN);
  assert.equal(flag(args, '--network'), 'bridge');
  assert.equal(flag(args, '--user'), '65532:65532');
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(mounts(args), ['type=bind,src=/var/verify/databases,dst=/databases']);
  assert.equal(args.some(item => item.includes('.sock') || item.includes('readonly')), false);
  assert.equal(flag(args, '--entrypoint'), '/usr/local/bin/verify-db-fetch.sh');
  assert.throws(() => verifyDatabaseArguments({image: 'library/trivy:latest', output: '/var/verify/databases'}), refused('VERIFY_IMAGE_UNPINNED'));
  assert.throws(() => verifyDatabaseArguments({image: pinned, output: '/var/verify/../databases'}), refused('VERIFY_PATH_FORBIDDEN'));
  assert.throws(() => verifyDatabaseArguments({image: pinned, output: '/run/containerd.sock'}), refused('VERIFY_SOCKET_FORBIDDEN'));
});

test('o lockfile fixa as oito ferramentas e o Dockerfile confere o checksum', () => {
  const lock = JSON.parse(readFileSync('deploy/verify-tools.lock.json', 'utf8')) as {
    baseImage: {digest: string; version: string};
    tools: {name: string; version: string; url: string; sha256: string; sourceUrl: string}[];
  };
  const dockerfile = readFileSync('deploy/Dockerfile.verify', 'utf8');
  const entry = readFileSync('deploy/verify-entrypoint.sh', 'utf8');
  const fetch = readFileSync('deploy/verify-db-fetch.sh', 'utf8');
  assert.deepEqual(lock.tools.map(tool => tool.name), [
    'gitleaks', 'osv-scanner', 'syft', 'grype', 'opengrep', 'hadolint', 'trivy', 'checkov',
  ]);
  for (const tool of lock.tools) {
    assert.match(tool.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    assert.match(tool.url, /^https:\/\/github\.com\/.+/);
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    assert.match(tool.sourceUrl, /^https:\/\/github\.com\/.+/);
    assert.equal(tool.url.toLowerCase().includes('latest'), false);
  }
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.split(lock.baseImage.digest).length - 1, 2);
  assert.match(dockerfile, /sha256sum -c checksums\.txt/);
  assert.match(dockerfile, /COPY verify-tools\.lock\.json/);
  assert.equal(/latest/i.test(dockerfile), false);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(entry, /VERIFY_NETWORK_FORBIDDEN/);
  assert.match(entry, /VERIFY_SOCKET_FORBIDDEN/);
  assert.match(entry, /VERIFY_PATH_FORBIDDEN/);
  assert.match(fetch, /VERIFY_SOCKET_FORBIDDEN/);
  assert.match(entry, /--network none|--offline/);
  assert.match(entry, /dst=\/repository|source \/repository|--source \/repository|dir:\/repository/);
});
