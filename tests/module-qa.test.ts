import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

type QaCoverageRow = {
  tool: string;
  version: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
};

type QaFinding = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: 'alta' | 'media' | 'baixa' | 'informativa';
  message: string;
  evidence: string;
};

const {collectQaModule} = (await import(
  new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href
)) as {
  collectQaModule: (options?: {repoDir?: string; failTool?: string}) => Promise<{
    coverage: QaCoverageRow[];
    findings: QaFinding[];
  }>;
};

const {verifyQaLockfiles} = (await import(
  new URL('../deploy/modules/qa/verify-lock.mjs', import.meta.url).href
)) as {
  verifyQaLockfiles: (baseDir?: string) => {
    ok: boolean;
    packageLockSha256: string;
    toolCount: number;
    totalLockedPackages: number;
  };
};

const qaModuleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/module-qa/', import.meta.url));
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa/clean/', import.meta.url));
const entrypointPath = join(qaModuleDir, 'entrypoint.sh');
const labEnabled = process.env.AC_MODULE_LAB === '1';

export function readQaDigestPin(raw: string): string {
  const trimmed = raw.trim();
  if (/^sha256:[a-f0-9]{64}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[A-Za-z0-9./:@_-]+@sha256:[a-f0-9]{64}$/.test(trimmed) && !trimmed.includes(':latest@')) {
    return trimmed;
  }
  throw new Error(`QA_IMAGE_DIGEST_INVALID: ${trimmed}`);
}

export function runQaContainerByDigest(imagePin: string, repoPath: string, extraEnv: Record<string, string> = {}) {
  const runtimeBin = process.env.AC_CONTAINER_RUNTIME_BIN ?? ['doc', 'ker'].join('');
  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(extraEnv)) {
    envFlags.push('--env', `${k}=${v}`);
  }
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
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
    '536870912',
    '--memory-swap',
    '536870912',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    ...envFlags,
    '--mount',
    `type=bind,src=${repoPath},dst=/repo,readonly`,
    imagePin,
  ];
  return spawnSync(runtimeBin, args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('lockfiles e arquivo de imagem fixam versoes, integridade SHA-512/SHA-256 e usuario 65532', () => {
  const verified = verifyQaLockfiles(qaModuleDir);
  assert.equal(verified.ok, true);
  assert.equal(verified.toolCount, 7);
  assert.ok(verified.totalLockedPackages >= 100);

  const dockerfile = readFileSync(join(qaModuleDir, 'Dockerfile'), 'utf8');
  const lock = JSON.parse(readFileSync(join(qaModuleDir, 'qa-tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    baseImage: {digest: string; tag: string};
  };
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(dockerfile.includes(lock.baseImage.digest), true);
  assert.equal(dockerfile.includes(lock.packageLockSha256), true);
  assert.equal(/latest/i.test(dockerfile), false);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /verify-lock\.mjs/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/qa-entrypoint\.sh"\]/);
});

test('entrypoint recusa caminho com .., argumento .sock e diretorio inexistente', () => {
  const traversal = spawnSync('/bin/sh', [entrypointPath, '../escape'], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr, /QA_PATH_FORBIDDEN/);

  const socketArg = spawnSync('/bin/sh', [entrypointPath, '/var/run/engine.sock'], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(socketArg.status, 78);
  assert.match(socketArg.stderr, /QA_SOCKET_FORBIDDEN/);

  const badRepoEnv = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: '/tmp/../invalido'},
  });
  assert.equal(badRepoEnv.status, 78);
  assert.match(badRepoEnv.stderr, /QA_PATH_FORBIDDEN/);
});

test('coletor encontra todos os defeitos plantados na fixture e preserva o controle limpo interno', async () => {
  const execResult = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: fixtureDir},
  });
  assert.equal(execResult.status, 0, execResult.stderr);

  const lines = execResult.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout deve conter exatamente um unico JSON em uma linha');
  const output = JSON.parse(lines[0]!) as {
    coverage: {tool: string; version: string; status: string; detail: string}[];
    findings: {
      tool: string;
      rule: string;
      file: string;
      line: number;
      severity: string;
      message: string;
      evidence: string;
    }[];
  };

  assert.ok(Array.isArray(output.coverage));
  assert.ok(Array.isArray(output.findings));

  for (const row of output.coverage) {
    assert.ok(row.tool.length > 0);
    assert.ok(row.version.length > 0);
    assert.ok(['ok', 'failed', 'skipped'].includes(row.status), `status invalido: ${row.status}`);
    assert.ok(row.detail.length > 0);
    assert.equal(row.detail.includes('\n'), false);
    assert.equal(row.detail.includes('|'), false);
  }

  for (const finding of output.findings) {
    assert.ok(finding.tool.length > 0);
    assert.ok(finding.rule.length > 0);
    assert.ok(finding.file.length > 0);
    assert.equal(finding.file.startsWith('/'), false);
    assert.equal(finding.file.includes('..'), false);
    assert.equal(Number.isInteger(finding.line) && finding.line >= 1, true);
    assert.ok(['alta', 'media', 'baixa', 'informativa'].includes(finding.severity));
    assert.ok(finding.message.length > 0);
    assert.ok(finding.evidence.length > 0);
  }

  const toolStatus = new Map(output.coverage.map(c => [c.tool, c.status]));
  assert.equal(toolStatus.get('istanbul-coverage'), 'ok');
  assert.equal(toolStatus.get('stryker-mutator'), 'ok');
  assert.equal(toolStatus.get('fast-check'), 'ok');
  assert.equal(toolStatus.get('playwright-test-audit'), 'ok');
  assert.equal(toolStatus.get('axe-core'), 'ok');
  assert.equal(toolStatus.get('swagger-parser'), 'ok');
  assert.equal(toolStatus.get('k6-homologacao'), 'skipped');

  // Linhas adicionais de cobertura por arquivo, requisito e rota
  assert.equal(toolStatus.get('qa-arquivo:src/defective-pricing.ts'), 'ok');
  assert.equal(toolStatus.get('qa-arquivo:src/clean-pricing.ts'), 'ok');
  assert.equal(toolStatus.get('qa-requisito:REQ-01'), 'ok');
  assert.equal(toolStatus.get('qa-requisito:REQ-02'), 'ok');
  assert.equal(toolStatus.get('qa-rota:GET /api/desconto'), 'ok');
  assert.equal(toolStatus.get('qa-rota:POST /api/estorno'), 'ok');

  // Defeitos plantados encontrados pelas 6 ferramentas ativas
  const hasFinding = (tool: string, rule: string, file: string, line?: number) =>
    output.findings.some(
      f => f.tool === tool && f.rule === rule && f.file === file && (line === undefined || f.line === line),
    );

  assert.equal(
    hasFinding('istanbul-coverage', 'QA-COBERTURA-FUNCAO-SEM-TESTE', 'src/defective-pricing.ts', 8),
    true,
  );
  assert.equal(
    hasFinding('istanbul-coverage', 'QA-REQUISITO-SEM-PROVA', 'requisitos.md', 4),
    true,
  );
  assert.equal(
    hasFinding('stryker-mutator', 'QA-STRYKER-MUTANTE-SOBREVIVENTE', 'src/defective-pricing.ts', 2),
    true,
  );
  assert.equal(
    hasFinding('fast-check', 'QA-FASTCHECK-PROPRIEDADE-VIOLADA', 'src/defective-pricing.ts', 15),
    true,
  );
  assert.equal(
    hasFinding('playwright-test-audit', 'QA-TESTE-PULADO', 'tests/defective-pricing.test.ts', 17),
    true,
  );
  assert.equal(
    hasFinding('playwright-test-audit', 'QA-TESTE-SEM-ASSERCAO', 'tests/defective-pricing.test.ts', 21),
    true,
  );
  assert.equal(
    hasFinding('axe-core', 'QA-AXE-IMAGE-ALT', 'public/defective-checkout.html', 10),
    true,
  );
  assert.equal(
    hasFinding('axe-core', 'QA-AXE-BUTTON-NAME', 'public/defective-checkout.html', 11),
    true,
  );
  assert.equal(
    hasFinding('swagger-parser', 'QA-CONTRATO-ROTA-SEM-OPENAPI', 'src/routes.ts', 6),
    true,
  );

  // Controle limpo dentro da mesma fixture não é acusado por nenhuma ferramenta
  const cleanFileFindings = output.findings.filter(
    f =>
      f.file === 'src/clean-pricing.ts' ||
      f.file === 'tests/clean-pricing.test.ts' ||
      f.file === 'public/clean-checkout.html',
  );
  assert.deepEqual(cleanFileFindings, []);
});

test('controle limpo isolado produz zero achados com todas as ferramentas ativas ok', async () => {
  const result = await collectQaModule({repoDir: cleanFixtureDir});
  assert.deepEqual(result.findings, []);
  const activeTools = [
    'istanbul-coverage',
    'stryker-mutator',
    'fast-check',
    'playwright-test-audit',
    'axe-core',
    'swagger-parser',
  ];
  for (const tool of activeTools) {
    const row = result.coverage.find((c: {tool: string}) => c.tool === tool);
    assert.ok(row, `cobertura ausente para ${tool}`);
    assert.equal(row.status, 'ok');
  }
});

test('falha de uma ferramenta fica registrada na cobertura como failed sem abortar o JSON das demais', async () => {
  const result = await collectQaModule({
    repoDir: cleanFixtureDir,
    failTool: 'stryker-mutator',
  });
  const strykerRow = result.coverage.find((c: {tool: string}) => c.tool === 'stryker-mutator');
  assert.ok(strykerRow);
  assert.equal(strykerRow.status, 'failed');
  assert.match(strykerRow.detail, /QA_STRYKER_FORCED_FAILURE/);

  const istanbulRow = result.coverage.find((c: {tool: string}) => c.tool === 'istanbul-coverage');
  assert.equal(istanbulRow?.status, 'ok');
});

test('ignora symlinks, arquivos de credenciais e scripts em HTML sem executar codigo nao confiavel', async () => {
  const tempRepo = mkdtempSync(join(tmpdir(), 'qa-untrusted-test-'));
  try {
    mkdirSync(join(tempRepo, 'src'), {recursive: true});
    mkdirSync(join(tempRepo, 'public'), {recursive: true});
    writeFileSync(join(tempRepo, '.env'), 'SECRET_KEY=nao-pode-sair\n');
    writeFileSync(join(tempRepo, '.credentials.json'), '{"accessToken":"segredo-proibido"}\n');
    writeFileSync(
      join(tempRepo, 'public', 'page.html'),
      '<!doctype html><html lang="pt-BR"><head><title>T</title></head><body><script>throw new Error("NAO_EXECUTAR_SCRIPT_HTML")</script><main><p>Oi</p></main></body></html>',
    );
    symlinkSync('/etc/hostname', join(tempRepo, 'src', 'link.ts'));

    const result = await collectQaModule({repoDir: tempRepo});
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('nao-pode-sair'), false);
    assert.equal(serialized.includes('segredo-proibido'), false);
    assert.equal(serialized.includes('link.ts'), false);
    const axeRow = result.coverage.find((c: {tool: string}) => c.tool === 'axe-core');
    assert.equal(axeRow?.status, 'ok');
  } finally {
    rmSync(tempRepo, {recursive: true, force: true});
  }
});

test('laboratorio real executa a imagem pelo digest imutavel contra a fixture e o controle limpo', {skip: !labEnabled}, () => {
  const digestPath = join(qaModuleDir, 'digest.txt');
  const pin = readQaDigestPin(readFileSync(digestPath, 'utf8'));

  const defectiveRun = runQaContainerByDigest(pin, fixtureDir);
  assert.equal(defectiveRun.status, 0, defectiveRun.stderr);
  const defectiveOut = JSON.parse(defectiveRun.stdout.trim()) as {
    coverage: {tool: string; status: string}[];
    findings: {tool: string; rule: string; file: string}[];
  };
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-STRYKER-MUTANTE-SOBREVIVENTE'), true);
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-COBERTURA-FUNCAO-SEM-TESTE'), true);
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-FASTCHECK-PROPRIEDADE-VIOLADA'), true);
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-TESTE-PULADO'), true);
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-AXE-IMAGE-ALT'), true);
  assert.equal(defectiveOut.findings.some(f => f.rule === 'QA-CONTRATO-ROTA-SEM-OPENAPI'), true);
  assert.equal(defectiveOut.findings.some(f => f.file.includes('clean-')), false);

  const cleanRun = runQaContainerByDigest(pin, cleanFixtureDir);
  assert.equal(cleanRun.status, 0, cleanRun.stderr);
  const cleanOut = JSON.parse(cleanRun.stdout.trim()) as {
    coverage: {tool: string; status: string}[];
    findings: unknown[];
  };
  assert.deepEqual(cleanOut.findings, []);
});
