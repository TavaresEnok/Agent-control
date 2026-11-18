import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  DESIGN_IMAGE,
  DESIGN_RUNTIME_BIN,
  assertDesignDestination,
  assertDesignTarget,
  designRunArguments,
  pinnedDesignImage,
  type DesignRunInput,
} from '../src/design-image.ts';

const digest = '0123456789abcdef'.repeat(4);
const pinned = `mcr.microsoft.com/playwright:v1.65.1-noble@sha256:${digest}`;

function refusal(code: string) {
  return (error: unknown): boolean => error instanceof Refusal && error.code === code;
}

function input(over: Partial<DesignRunInput> = {}): DesignRunInput {
  return {
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    output: '/var/lib/design/out',
    targetUrl: 'http://127.0.0.1:4173/inicio',
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    ...over,
  };
}

test('URL externa, usuário na URL e IP disfarçado são recusados', () => {
  assert.throws(() => assertDesignTarget('https://example.com/tela'), refusal('DESIGN_EXTERNAL_TARGET'));
  assert.throws(() => assertDesignTarget('http://user:segredo@127.0.0.1:4173/'), refusal('DESIGN_EXTERNAL_TARGET'));
  assert.throws(() => assertDesignTarget('http://2130706433/'), refusal('DESIGN_EXTERNAL_TARGET'));
  assert.throws(() => assertDesignTarget('http://127.0.0.1.example.com/'), refusal('DESIGN_EXTERNAL_TARGET'));
  assert.throws(() => assertDesignTarget('file:///tmp/tela'), refusal('DESIGN_EXTERNAL_TARGET'));
  assert.throws(() => designRunArguments(input({targetUrl: 'https://example.com'})), refusal('DESIGN_EXTERNAL_TARGET'));
});

test('localhost, 127.0.0.1 e sufixo .local devolvem origem sem caminho', () => {
  assert.deepEqual(assertDesignTarget('http://127.0.0.1:4173/inicio'), {
    host: '127.0.0.1', port: 4173, origin: 'http://127.0.0.1:4173',
  });
  assert.deepEqual(assertDesignTarget('http://localhost/tela'), {
    host: 'localhost', port: 80, origin: 'http://localhost',
  });
  assert.deepEqual(assertDesignTarget('https://homologacao.local/tela'), {
    host: 'homologacao.local', port: 443, origin: 'https://homologacao.local',
  });
});

test('outro host ou outra porta é escape; o mesmo destino passa', () => {
  assert.throws(
    () => assertDesignDestination('http://127.0.0.1:4173/a', 'http://127.0.0.1:4174/a'),
    refusal('DESIGN_TARGET_ESCAPE'),
  );
  assert.throws(
    () => assertDesignDestination('http://localhost:4173/', 'http://example.com:4173/'),
    refusal('DESIGN_TARGET_ESCAPE'),
  );
  assert.throws(
    () => assertDesignDestination('http://127.0.0.1:4173/', 'https://127.0.0.1:4173/'),
    refusal('DESIGN_TARGET_ESCAPE'),
  );
  assert.doesNotThrow(() => assertDesignDestination('http://127.0.0.1:4173/a', 'http://127.0.0.1:4173/b'));
});

test('os argumentos trazem usuário, limites, rede e imagem com digest', () => {
  const memory = String(512 * 1024 * 1024);
  const args = designRunArguments(input());
  assert.deepEqual(args, [
    DESIGN_RUNTIME_BIN,
    'run',
    '--rm',
    '--network',
    'design-homologation',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--env',
    'DESIGN_TARGET_URL=http://127.0.0.1:4173',
    '--mount',
    'type=bind,source=/var/lib/design/repo,destination=/repository,readonly',
    '--mount',
    'type=bind,source=/var/lib/design/out,destination=/output',
    '--entrypoint',
    '/usr/local/bin/design-entrypoint.sh',
    DESIGN_IMAGE,
  ]);
  assert.equal(args[0], DESIGN_RUNTIME_BIN);
  assert.match(String(args.at(-1)), /@sha256:[a-f0-9]{64}$/);
  assert.equal(args.some(item => item.includes('.sock')), false);
  assert.equal(args.includes('--privileged'), false);
});

test('fração de CPU entra nos limites', () => {
  const args = designRunArguments(input({nanoCpus: 1_500_000_000}));
  assert.equal(args[args.indexOf('--cpus') + 1], '1.5');
});

test('imagem latest ou sem digest é recusada', () => {
  assert.throws(
    () => designRunArguments(input({image: 'mcr.microsoft.com/playwright:latest'})),
    refusal('DESIGN_IMAGE_UNPINNED'),
  );
  assert.throws(
    () => designRunArguments(input({image: `mcr.microsoft.com/playwright:latest@sha256:${digest}`})),
    refusal('DESIGN_IMAGE_UNPINNED'),
  );
  assert.throws(
    () => designRunArguments(input({image: 'mcr.microsoft.com/playwright:v1.65.1-noble'})),
    refusal('DESIGN_IMAGE_UNPINNED'),
  );
  assert.throws(() => pinnedDesignImage('FROM mcr.microsoft.com/playwright:latest\n'), refusal('DESIGN_IMAGE_UNPINNED'));
  assert.equal(pinnedDesignImage(`# comentário\nFROM ${pinned} AS design\n`), pinned);
});

test('caminho com .., espaço ou socket é recusado', () => {
  assert.throws(() => designRunArguments(input({repository: '/tmp/../repo'})), refusal('DESIGN_PATH_FORBIDDEN'));
  assert.throws(() => designRunArguments(input({output: '/var/lib/design/pasta saida'})), refusal('DESIGN_PATH_FORBIDDEN'));
  assert.throws(() => designRunArguments(input({repository: '/var/run/engine.sock'})), refusal('DESIGN_SOCKET_FORBIDDEN'));
});

test('rede errada e limites inválidos são recusados', () => {
  assert.throws(() => designRunArguments(input({network: 'bridge'})), refusal('DESIGN_NETWORK_FORBIDDEN'));
  assert.throws(() => designRunArguments(input({memoryBytes: 1024})), refusal('DESIGN_LIMITS_INVALID'));
  assert.throws(() => designRunArguments(input({pidsLimit: 1})), refusal('DESIGN_LIMITS_INVALID'));
  assert.throws(() => designRunArguments(input({nanoCpus: 0})), refusal('DESIGN_LIMITS_INVALID'));
});

test('o Dockerfile usa a tag fixa e o digest que a constante publica', () => {
  const dockerfile = readFileSync(new URL('../deploy/Dockerfile.design', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../deploy/design-entrypoint.sh', import.meta.url), 'utf8');
  const network = readFileSync(new URL('../deploy/design-network.sh', import.meta.url), 'utf8');
  assert.equal(pinnedDesignImage(dockerfile), DESIGN_IMAGE);
  assert.match(DESIGN_IMAGE, /^mcr\.microsoft\.com\/playwright:v1\.65\.1-noble@sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.includes('latest'), false);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(entry, /DESIGN_TARGET_URL/);
  assert.match(entry, /\/output\/achados-brutos\.json/);
  assert.match(entry, /Não executa código do repositório/);
  assert.match(network, /design-homologation/);
  assert.match(network, /--internal/);
});
