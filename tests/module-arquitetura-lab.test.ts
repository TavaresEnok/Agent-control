import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const enabled = process.env.AC_MODULE_LAB === '1';
const digestPath = fileURLToPath(new URL('../deploy/modules/arquitetura/digest.txt', import.meta.url));
const defectiveFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/defective/', import.meta.url));
const cleanFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/clean/', import.meta.url));

const SHA_ONLY = /^sha256:[a-f0-9]{64}$/i;
const PINNED_REF = /^[a-z0-9._:/-]+@sha256:[a-f0-9]{64}$/i;

function readPinnedImage(): string {
  const raw = readFileSync(digestPath, 'utf8').trim().split(/\s+/u)[0] ?? '';
  if (SHA_ONLY.test(raw) || PINNED_REF.test(raw)) return raw;
  throw new Error(`Digest inválido ou ausente em deploy/modules/arquitetura/digest.txt: "${raw}"`);
}

function ensureWorldReadable(targetPath: string): void {
  const st = lstatSync(targetPath);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(targetPath, 0o755);
    for (const entry of readdirSync(targetPath)) {
      ensureWorldReadable(join(targetPath, entry));
    }
  } else if (st.isFile()) {
    chmodSync(targetPath, 0o644);
  }
}

function runInContainer(
  image: string,
  repoPath: string,
  network: 'none' | 'bridge' = 'none',
  canaryDir?: string,
) {
  const args = [
    'run',
    '--rm',
    '--pull=never',
    '--network',
    network,
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1073741824',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
    '--mount',
    `type=bind,src=${repoPath},dst=/repo,readonly`,
  ];
  if (canaryDir) {
    args.push('--mount', `type=bind,src=${canaryDir},dst=/var/tmp`);
  }
  args.push(image);
  return spawnSync('docker', args, {encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024});
}

type CollectorOutput = {
  coverage: {tool: string; version: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
};

const CLEAN_ALL_SOURCE_FILES = [
  'src/domain/order.ts',
  'src/index.ts',
  'src/infra/memory-store.ts',
  'src/routes/orders.ts',
  'src/services/order-service.ts',
  'src/shared/format.ts',
];

const CLEAN_JSCPD_MEASURED_FILES = [
  'src/domain/order.ts',
  'src/infra/memory-store.ts',
  'src/services/order-service.ts',
];

const CLEAN_JSCPD_UNMEASURED_FILES = [
  'src/index.ts',
  'src/routes/orders.ts',
  'src/shared/format.ts',
];

function extractCoveredFiles(out: CollectorOutput, perFileTool: string): string[] {
  return out.coverage
    .filter(c => c.tool === perFileTool)
    .map(c => /^arquivo=([^;]+);/.exec(c.detail)?.[1] ?? '')
    .filter(Boolean);
}

function assertCleanPerFileCoverage(
  out: CollectorOutput,
  label: string,
  hasUntrustedConfigs: boolean,
): void {
  for (const perFileTool of ['knip:file', 'ast-complexity:file', 'jscpd:file', 'dependency-cruiser:file']) {
    const covered = extractCoveredFiles(out, perFileTool);
    for (const file of CLEAN_JSCPD_MEASURED_FILES) {
      assert.equal(
        covered.includes(file),
        true,
        `cobertura por arquivo ausente para ${perFileTool} (${file}) em ${label}`,
      );
    }
  }

  assert.deepEqual(
    extractCoveredFiles(out, 'knip:file').sort(),
    [...CLEAN_ALL_SOURCE_FILES].sort(),
    `knip:file deve cobrir apenas os arquivos analisados em ${label}`,
  );
  assert.deepEqual(
    extractCoveredFiles(out, 'jscpd:file').sort(),
    [...CLEAN_JSCPD_MEASURED_FILES].sort(),
    `jscpd:file deve refletir apenas os arquivos efetivamente medidos em ${label}`,
  );
  for (const shortFile of CLEAN_JSCPD_UNMEASURED_FILES) {
    assert.equal(
      extractCoveredFiles(out, 'jscpd:file').includes(shortFile),
      false,
      `jscpd:file não deve atribuir métricas ao arquivo não medido ${shortFile} em ${label}`,
    );
  }

  const astCovered = extractCoveredFiles(out, 'ast-complexity:file');
  for (const file of CLEAN_ALL_SOURCE_FILES) {
    assert.equal(
      astCovered.includes(file),
      true,
      `ast-complexity:file ausente para ${file} em ${label}`,
    );
  }

  const depCovered = extractCoveredFiles(out, 'dependency-cruiser:file');
  for (const file of CLEAN_ALL_SOURCE_FILES) {
    assert.equal(
      depCovered.includes(file),
      true,
      `dependency-cruiser:file ausente para ${file} em ${label}`,
    );
  }
  assert.equal(
    depCovered.includes('node:fs'),
    false,
    `dependency-cruiser:file não deve listar módulo nativo node:fs em ${label}`,
  );

  if (!hasUntrustedConfigs) {
    assert.deepEqual(
      astCovered.sort(),
      [...CLEAN_ALL_SOURCE_FILES].sort(),
      `ast-complexity:file inesperado em ${label}`,
    );
    assert.deepEqual(
      depCovered.sort(),
      [...CLEAN_ALL_SOURCE_FILES].sort(),
      `dependency-cruiser:file inesperado em ${label}`,
    );
  }
}

function assertSchema(out: CollectorOutput): void {
  assert.equal(Array.isArray(out.coverage), true);
  assert.equal(Array.isArray(out.findings), true);
  for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
    const row = out.coverage.find(c => c.tool === tool);
    assert.ok(row, `ferramenta ausente na cobertura: ${tool}`);
    assert.equal(row.status, 'ok', `${tool} falhou: ${row.detail}`);
    assert.ok(row.version && row.version !== 'desconhecida', `versão ausente para ${tool}`);
    assert.ok(row.detail.length > 0);
  }
  for (const f of out.findings) {
    assert.equal(typeof f.file, 'string');
    assert.ok(f.file.length > 0 && !f.file.startsWith('/') && !f.file.split('/').includes('..'), f.file);
    assert.equal(Number.isInteger(f.line) && f.line >= 1, true, `${f.rule} linha=${f.line}`);
    assert.equal(['alta', 'media', 'baixa', 'informativa'].includes(f.severity), true, f.severity);
  }
}

test('laboratório módulo 3 encontra os defeitos plantados e não acusa o controle limpo', {skip: !enabled}, () => {
  const image = readPinnedImage();

  const defectiveRun = runInContainer(image, defectiveFixture, 'none');
  assert.equal(defectiveRun.status, 0, `${defectiveRun.stdout ?? ''}\n${defectiveRun.stderr ?? ''}`);
  const defectiveOut = JSON.parse(defectiveRun.stdout.trim()) as CollectorOutput;
  assertSchema(defectiveOut);

  const has = (rule: string, filePart?: string) =>
    defectiveOut.findings.some(f => f.rule === rule && (!filePart || f.file.includes(filePart)));

  assert.equal(has('KNIP-UNUSED-FILE', 'src/legacy-dead.ts'), true);
  for (const file of ['src/unused.mts', 'src/unused.cts']) {
    assert.equal(has('KNIP-UNUSED-FILE', file), true);
    assert.ok(defectiveOut.coverage.some(c =>
      c.tool === 'knip:file' && c.detail === `arquivo=${file}; papel=nao_alcancado; problemas=1`));
  }
  assert.equal(has('KNIP-UNUSED-EXPORT', 'src/shared/format.ts'), true);
  assert.equal(has('JSCPD-DUPLICATION', 'billing-'), true);
  assert.equal(has('DEPCRUISE-NO-CIRCULAR', 'cycle-'), true);
  assert.equal(has('DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION', 'src/domain/order.ts'), true);
  assert.equal(has('DEPCRUISE-LAYER-DOMAIN-TO-INFRA', 'src/domain/order.ts'), true);
  const domainFindings = defectiveOut.findings.filter(f => f.file === 'src/domain/order.ts');
  assert.equal(domainFindings.filter(f => f.rule === 'DEPCRUISE-NO-CIRCULAR').length, 1);
  assert.ok(domainFindings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION' && f.line === 2));
  assert.equal(has('COMPLEXITY-CYCLOMATIC-HIGH', 'src/services/complex-engine.ts'), true);
  assert.equal(has('COMPLEXITY-NESTING-DEEP', 'src/services/complex-engine.ts'), true);

  assert.equal(defectiveOut.coverage.some(c => c.tool === 'knip:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'jscpd:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'dependency-cruiser:file'), true);
  assert.equal(defectiveOut.coverage.some(c => c.tool === 'ast-complexity:file'), true);

  const cleanRun = runInContainer(image, cleanFixture, 'none');
  assert.equal(cleanRun.status, 0, `${cleanRun.stdout ?? ''}\n${cleanRun.stderr ?? ''}`);
  const cleanOut = JSON.parse(cleanRun.stdout.trim()) as CollectorOutput;
  assertSchema(cleanOut);
  assert.equal(cleanOut.findings.length, 0, `controle limpo acusou achados: ${JSON.stringify(cleanOut.findings)}`);
  assertCleanPerFileCoverage(cleanOut, 'cleanFixture', false);

  // Prova de segurança: rede ativa é recusada, raiz ilegível falha explicitamente,
  // projeto acessível sem JS/TS declara skipped e configs maliciosas não executam.
  const netRefusal = runInContainer(image, cleanFixture, 'bridge');
  assert.equal(netRefusal.status, 78);
  assert.match(netRefusal.stderr ?? '', /ARQUITETURA_NETWORK_FORBIDDEN/);

  const unreadableRepo = mkdtempSync(join(tmpdir(), 'arch-unreadable-'));
  try {
    mkdirSync(join(unreadableRepo, 'src'), {recursive: true});
    writeFileSync(join(unreadableRepo, 'src', 'index.ts'), 'export const value = 1;\n');
    chmodSync(unreadableRepo, 0o000);
    const unreadableRun = runInContainer(image, unreadableRepo, 'none');
    assert.equal(unreadableRun.status, 78);
    assert.equal((unreadableRun.stdout ?? '').trim(), '');
    assert.match(unreadableRun.stderr ?? '', /ARQUITETURA_REPO_UNREADABLE/);
  } finally {
    chmodSync(unreadableRepo, 0o700);
    rmSync(unreadableRepo, {recursive: true, force: true});
  }

  const noJsTsRepo = mkdtempSync(join(tmpdir(), 'arch-no-jsts-'));
  try {
    writeFileSync(join(noJsTsRepo, 'README.md'), '# Projeto sem código JS/TS\n');
    ensureWorldReadable(noJsTsRepo);
    const noJsTsRun = runInContainer(image, noJsTsRepo, 'none');
    assert.equal(noJsTsRun.status, 0, `${noJsTsRun.stdout ?? ''}\n${noJsTsRun.stderr ?? ''}`);
    const noJsTsOut = JSON.parse(noJsTsRun.stdout.trim()) as CollectorOutput;
    assert.equal(noJsTsOut.findings.length, 0);
    for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
      const row = noJsTsOut.coverage.find(c => c.tool === tool);
      assert.ok(row, `ferramenta ausente na cobertura: ${tool}`);
      assert.equal(row.status, 'skipped', `${tool} deveria declarar skipped: ${row.detail}`);
    }
    const knipSkipped = noJsTsOut.coverage.find(c => c.tool === 'knip');
    assert.match(knipSkipped?.detail ?? '', /arquivos copiados=1/);
  } finally {
    rmSync(noJsTsRepo, {recursive: true, force: true});
  }

  const untrustedRepo = mkdtempSync(join(tmpdir(), 'arch-untrusted-'));
  const canaryDir = mkdtempSync(join(tmpdir(), 'arch-canary-'));
  try {
    cpSync(cleanFixture, untrustedRepo, {recursive: true});
    writeFileSync(
      join(untrustedRepo, 'vite.config.ts'),
      [
        "import {writeFileSync} from 'node:fs';",
        "writeFileSync('/var/tmp/pwned-vite.txt', '1');",
        "process.stderr.write('UNTRUSTED_VITE_EXECUTED\\n');",
        "throw new Error('UNTRUSTED_VITE_EXECUTED');",
      ].join('\n'),
    );
    writeFileSync(
      join(untrustedRepo, 'knip.ts'),
      [
        "import {writeFileSync} from 'node:fs';",
        "writeFileSync('/var/tmp/pwned-knip.txt', '1');",
        "process.stderr.write('UNTRUSTED_KNIP_EXECUTED\\n');",
        "throw new Error('UNTRUSTED_KNIP_EXECUTED');",
      ].join('\n'),
    );
    writeFileSync(
      join(untrustedRepo, '.dependency-cruiser.js'),
      [
        "require('node:fs').writeFileSync('/var/tmp/pwned-depcruise.txt', '1');",
        "process.stderr.write('UNTRUSTED_DEPCRUISE_EXECUTED\\n');",
        "throw new Error('UNTRUSTED_DEPCRUISE_EXECUTED');",
      ].join('\n'),
    );
    writeFileSync(
      join(untrustedRepo, 'package.json'),
      JSON.stringify({name: 'untrusted', version: '1.0.0', type: 'module', main: 'src/index.ts', devDependencies: {vite: '6.0.0'}}),
    );
    ensureWorldReadable(untrustedRepo);
    chmodSync(canaryDir, 0o777);

    const untrustedRun = runInContainer(image, untrustedRepo, 'none', canaryDir);
    assert.equal(untrustedRun.status, 0, untrustedRun.stderr ?? '');
    assert.doesNotMatch(untrustedRun.stderr ?? '', /UNTRUSTED_.*_EXECUTED/);
    assert.doesNotMatch(untrustedRun.stdout ?? '', /UNTRUSTED_.*_EXECUTED/);
    assert.deepEqual(readdirSync(canaryDir), []);

    const untrustedOut = JSON.parse(untrustedRun.stdout.trim()) as CollectorOutput;
    assertSchema(untrustedOut);
    assertCleanPerFileCoverage(untrustedOut, 'untrustedRepo', true);
  } finally {
    rmSync(untrustedRepo, {recursive: true, force: true});
    rmSync(canaryDir, {recursive: true, force: true});
  }
});
