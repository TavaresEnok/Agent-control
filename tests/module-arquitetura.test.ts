import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs, {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Refusal, type Authority} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule} from '../src/module-exam.ts';
import {
  assertModuleRepoRelativePath,
  parseModuleCollectorOutput,
  prepareModuleSnapshot,
  readModuleReport,
  removeModuleSnapshot,
  runVerificationModule,
  writeModuleReport,
} from '../src/verification-modules.ts';
import {hasKnownSecret, redactUnknownSecrets} from '../src/verify-redact.ts';
import {REMEDIATION_ACCEPTANCE} from '../src/verify-types.ts';
import {
  analyzeAstComplexity,
  buildKnipConfig,
  clampLine,
  copyRepoSafely,
  findImportLine,
  normalizeRepoPath,
  parseDepcruiseReport,
  parseJscpdComplexityReport,
  parseJscpdReport,
  parseKnipReport,
  runCollector,
} from '../deploy/modules/arquitetura/collect.mjs';

const moduleDir = fileURLToPath(new URL('../deploy/modules/arquitetura/', import.meta.url));
const cleanFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/clean/', import.meta.url));
const defectiveFixture = fileURLToPath(new URL('./fixtures/module-arquitetura/defective/', import.meta.url));

const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);

function assertValidOutputContract(output: {
  coverage: {tool: string; version: string; status: string; detail: string; files?: string[]}[];
  findings: {tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string}[];
}): void {
  assert.equal(Array.isArray(output.coverage), true);
  assert.equal(Array.isArray(output.findings), true);
  assert.ok(output.coverage.length >= 1);
  for (const row of output.coverage) {
    assert.equal(typeof row.tool, 'string');
    assert.ok(row.tool.length > 0);
    assert.equal(typeof row.version, 'string');
    assert.ok(row.version.length > 0);
    assert.equal(VALID_STATUSES.has(row.status), true, `status inválido: ${row.status}`);
    assert.equal(typeof row.detail, 'string');
    assert.ok(row.detail.length > 0);
  }
  for (const item of output.findings) {
    assert.equal(typeof item.tool, 'string');
    assert.ok(item.tool.length > 0);
    assert.equal(typeof item.rule, 'string');
    assert.ok(item.rule.length > 0);
    assert.equal(typeof item.file, 'string');
    assert.ok(item.file.length > 0);
    assert.equal(item.file.startsWith('/'), false, item.file);
    assert.equal(item.file.split('/').includes('..'), false, item.file);
    assert.equal(Number.isInteger(item.line), true);
    assert.ok(item.line >= 1);
    assert.equal(VALID_SEVERITIES.has(item.severity), true, `severidade inválida: ${item.severity}`);
    assert.equal(typeof item.message, 'string');
    assert.ok(item.message.length > 0);
    assert.equal(typeof item.evidence, 'string');
    assert.ok(item.evidence.length > 0);
  }
}

function hadolintOnPath(): string | undefined {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, 'hadolint');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

test('Dockerfile e lockfiles fixam base, ferramentas e integridade sem tags mutáveis', () => {
  const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM\s+--platform=linux\/amd64\s+node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d/m);
  assert.match(dockerfile, /USER\s+65532:65532/);
  assert.match(dockerfile, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\/usr\/local\/bin\/arquitetura-entrypoint\.sh"\]/);
  assert.equal(/\blatest\b/i.test(dockerfile), false);
  assert.equal(dockerfile.includes('<<'), false);

  const pkg = JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const name of ['knip', 'jscpd', 'dependency-cruiser', 'typescript']) {
    const version = pkg.dependencies[name];
    assert.ok(version, `dependência ausente: ${name}`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `versão não fixada para ${name}: ${version}`);
  }

  const lockRaw = readFileSync(join(moduleDir, 'package-lock.json'));
  const lockSha = createHash('sha256').update(lockRaw).digest('hex');
  const toolsLock = JSON.parse(readFileSync(join(moduleDir, 'tools.lock.json'), 'utf8')) as {
    packageLockSha256: string;
    dependencies: Record<string, {version: string; integrity: string}>;
  };
  assert.equal(toolsLock.packageLockSha256, lockSha);

  const npmLock = JSON.parse(lockRaw.toString('utf8')) as {
    packages: Record<string, {version: string; integrity: string}>;
  };
  for (const [name, meta] of Object.entries(toolsLock.dependencies)) {
    assert.equal(pkg.dependencies[name], meta.version);
    const lockEntry = npmLock.packages[`node_modules/${name}`];
    assert.ok(lockEntry, `ausente no package-lock: ${name}`);
    assert.equal(lockEntry.version, meta.version);
    assert.equal(lockEntry.integrity, meta.integrity);
  }
});

test('hadolint aceita o Dockerfile do módulo quando disponível no PATH', t => {
  const binary = hadolintOnPath();
  if (!binary) {
    t.skip('hadolint ausente no PATH');
    return;
  }
  const res = spawnSync(binary, [join(moduleDir, 'Dockerfile')], {encoding: 'utf8'});
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`);
});

test('publicação preserva rotas Git medidas e achados válidos com omissões agregadas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arch-publication-'));
  const repo = join(root, 'repo');
  const route = 'app/(portal)/[identificadorInternacionalDaTransacao]/page.ts';
  const peer = 'app/(portal)/[id]/peer.ts';
  const reserved = ['.env.example', 'app/.CoDeX/config.ts', 'app/credentials-example.ts', 'app/chave.key'];
  const unlisted = 'app/ausente.ts';
  const link = 'app/link.ts';
  const syntheticValue = 'SYNTHETIC_FIXTURE_VALUE_ONLY';
  let snapshot: string | undefined;
  try {
    for (const file of [route, peer, ...reserved]) {
      mkdirSync(dirname(join(repo, file)), {recursive: true});
      writeFileSync(join(repo, file), 'export const synthetic = 1;\n');
    }
    symlinkSync('../.env.example', join(repo, link));
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
        encoding: 'utf8',
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '-f', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    snapshot = await prepareModuleSnapshot(repo, commit);
    const output = runCollector({
      repoDir: snapshot,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args, options) => {
        const argv = args as string[];
        const {cwd} = options as {cwd: string};
        for (const file of [...reserved, link]) assert.equal(existsSync(join(cwd, file)), false);
        const ok = {status: 0, stdout: '', stderr: ''};
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          const files = [route, peer, reserved[2], link, unlisted];
          const issues = files.map(file => ({file, exports: [{name: 'synthetic', line: 1}],
            unresolved: file === route ? [{name: '../../credentials-example.ts', line: 1}] : []}));
          return {...ok, stdout: JSON.stringify({issues, analyzedFiles: files})};
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [
            {source: route, rules: [{name: 'no-orphans'}], dependencies: [
              {module: './omitido', resolved: reserved[2], circular: true},
              {module: './peer', resolved: peer, circular: true, cycle: [{name: peer}, {name: unlisted}]},
            ]},
            {source: peer},
            {source: reserved[2], rules: [{name: 'no-orphans'}]},
          ]}));
        } else {
          const out = argv[argv.indexOf('--output') + 1];
          if (argv.includes('--complexity')) {
            const files = [route, peer, reserved[0], link].map(path => ({path, lines: 1, complexity: 26}));
            writeFileSync(join(out, 'jscpd-complexity.json'), JSON.stringify({summary: {files}}));
          } else {
            const duplicates = [peer, reserved[0], link].map(file => ({
              firstFile: {name: route, start: 1},
              secondFile: {name: file, start: 1},
              fragment: `password=${syntheticValue}`,
            }));
            const statistics = {total: {clones: 3, sources: 4, duplicatedLines: 3, percentage: 50}};
            writeFileSync(join(out, 'jscpd-report.json'), JSON.stringify({duplicates, statistics}));
          }
        }
        return ok;
      },
    });
    const stdout = JSON.stringify(output);
    const parsed = parseModuleCollectorOutput(Buffer.from(stdout), {module: 'arquitetura'});
    assert.match(parsed.coverage.find(row => row.tool === 'snapshot')!.detail, /omissoes_conhecidas=5/);
    for (const [tool, omissions] of [['jscpd', 2], ['knip', 3], ['dependency-cruiser', 2]] as const) {
      assert.ok(parsed.coverage.find(row => row.tool === tool)?.detail.includes(`fora_do_snapshot=${omissions}`));
    }
    const depSummary = parsed.coverage.find(row => row.tool === 'dependency-cruiser')!;
    assert.match(depSummary.detail, /dependencias=1,/);
    assert.match(depSummary.detail, /metricas_grafo=parciais/);
    assert.match(parsed.coverage.find(row => row.tool === 'jscpd')!.detail,
      /clones=1; totais de duplicação indisponíveis; min_linhas=8; mínimo de tokens 40/);
    const perFile = parsed.coverage.filter(row => row.files?.includes(route));
    assert.deepEqual(perFile.map(row => row.tool), ['ast-complexity:file', 'jscpd:file', 'dependency-cruiser:file', 'knip:file']);
    assert.match(perFile.find(row => row.tool === 'jscpd:file')!.detail, /tokens medidos 0/);
    assert.equal(
      perFile.find(row => row.tool === 'dependency-cruiser:file')!.detail,
      `arquivo=${route}; deps=1; dependentes=0; instabilidade=n/a; ciclo=nao; violacao_camada=nao; metricas_parciais=sim`,
    );
    assert.equal(parsed.findings.filter(finding => finding.file === route).length, 3);
    assert.equal(parsed.findings.filter(finding => finding.file === peer).length, 1);
    assert.ok(parsed.findings.some(finding => finding.rule === 'JSCPD-DUPLICATION' && finding.evidence.includes('…')));
    assert.ok(!JSON.stringify(parsed).includes(syntheticValue));

    const map = await mapModuleSnapshot(snapshot, undefined, {aggregateOmissions: true});
    assert.equal(map.fileOmissions, 5);
    assert.deepEqual(map.files.map(file => file.file).sort(), [route, peer].sort());
    const exam = await examineFunctionalModule({intentId: 'fixture', module: 'arquitetura', map, findings: parsed.findings});
    const report = await writeModuleReport({
      dataDirectory: root, projectId: 'projeto-sintetico', runId: '33333333-3333-4333-8333-333333333333',
      createdAt: new Date('2026-11-19T00:00:00Z'), module: 'arquitetura', commit,
      toolCoverage: parsed.coverage, raw: parsed, exam,
      fileCoverage: [{file: route, examinerProvider: 'ferramenta', examinerModel: 'ast-complexity:file@fixture', profileId: null, checklist: ['ast-complexity:file']}],
      achados: parsed.findings.map((finding, index) => ({
        id: `ACH-${String(index + 1).padStart(3, '0')}`, title: finding.message, severity: finding.severity,
        status: 'provavel', verifier: null, reference: finding.rule, where: {file: finding.file, line: finding.line},
        scenario: finding.message, proof: finding.evidence, suggestion: 'Revisar o trecho.', acceptance: REMEDIATION_ACCEPTANCE,
        sources: [finding.tool, finding.rule], secretPreview: null,
      })),
    });
    const mapa = readFileSync(join(report.directory, 'mapa.md'), 'utf8');
    const coverage = readFileSync(join(report.directory, 'cobertura.md'), 'utf8');
    const achado001 = readFileSync(join(report.directory, 'achados', 'ACH-001.md'), 'utf8');
    assert.ok(mapa.includes(`- ${route}`));
    assert.ok(mapa.includes(`| ${route} |`));
    assert.ok(coverage.includes(route));
    assert.ok(achado001.includes(`- Onde: ${route}:`));
    assert.ok(achado001.includes(route));
    assert.match(coverage, /Entradas omitidas do inventário de arquivos: 5/);
    const artifacts = ['mapa.md', 'cobertura.md', 'achados.json', 'bruto/achados-brutos.json', 'achados/ACH-001.md']
      .map(file => readFileSync(join(report.directory, file), 'utf8'));
    assert.equal(mapa.includes('[removido: alta entropia]'), false);
    assert.equal(achado001.includes('[removido: alta entropia]'), false);
    for (const file of [...reserved, '.CoDeX', link, unlisted]) {
      assert.ok(!stdout.includes(file));
      assert.ok(artifacts.every(artifact => !artifact.includes(file)));
    }
    assert.ok(artifacts.every(artifact => !artifact.includes(syntheticValue)));
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    rmSync(root, {recursive: true, force: true});
  }
});

test('parser continua recusando relatório misto com caminho inválido em cobertura ou achado', () => {
  const valid = 'app/(portal)/[[...slug]]/page.ts';
  const coverage = {tool: 'knip', version: '1', status: 'ok', detail: 'controle', files: [valid]};
  const finding = {tool: 'knip', rule: 'KNIP-UNUSED-FILE', file: valid, line: 1,
    severity: 'media', message: 'arquivo sem referência', evidence: 'resultado sintético'};
  const parse = (output: unknown) => parseModuleCollectorOutput(JSON.stringify(output), {module: 'arquitetura'});
  assert.deepEqual(parse({coverage: [coverage], findings: [finding]}).coverage[0]?.files, [valid]);
  const invalid = ['app/(portal)/../fora.ts', '/app/[id].ts', 'app\\[id].ts', 'app//[id].ts', 'app/[id] .ts\n',
    '.git/[id].ts', 'app/.env.example', 'app/.CoDeX/[id].ts', 'app/.npmrc', 'app/credentials-example.ts', 'app/controle(1);.ts',
    'app/(portal)/.npmrc/[id].ts', 'app/(portal)/.netrc/[id].ts', 'app/(portal)/.pgpass/[id].ts', 'app/(portal)/.ENV/[id].ts',
    'app/(portal)/credentials/[id].ts', 'app/(portal)/id_rsa/[id].ts', 'app/(portal)/server.key/[id].ts',
    'app/AKIAIOSFODNN7EXAMPLE.ts', `app/ghp_${'a'.repeat(20)}.ts`, 'app/AKIAIOSFODNN7EXAMPLE/[id].ts'];
  for (const file of invalid) {
    const forbidden = (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN';
    assert.throws(() => parse({coverage: [coverage, {...coverage, files: [valid, file]}], findings: [finding]}), forbidden);
    assert.throws(() => parse({coverage: [coverage], findings: [finding, {...finding, file}]}), forbidden);
  }
});

test('entrypoint recusa rede ativa, socket, path traversal e raiz ilegível', () => {
  const entrypoint = readFileSync(join(moduleDir, 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /ARQUITETURA_PATH_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_REPO_UNREADABLE/);
  assert.match(entrypoint, /ARQUITETURA_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /ARQUITETURA_NETWORK_FORBIDDEN/);
  assert.match(entrypoint, /\[ ! -r \/repo \] \|\| \[ ! -x \/repo \]/);
  assert.match(entrypoint, /\/sys\/class\/net\/\*/);
  assert.match(entrypoint, /\/var\/run\/docker\.sock/);
  assert.match(entrypoint, /unset\s+"\$name"/);
  assert.match(entrypoint, /^export AC_REPO_DIR=\/repo$/m);

  const shSyntax = spawnSync('/bin/sh', ['-n', join(moduleDir, 'entrypoint.sh')], {encoding: 'utf8'});
  assert.equal(shSyntax.status, 0, shSyntax.stderr ?? '');

  const traversal = spawnSync('/bin/sh', [join(moduleDir, 'entrypoint.sh'), '../fora'], {encoding: 'utf8'});
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr ?? '', /ARQUITETURA_PATH_FORBIDDEN/);

  const sockArg = spawnSync('/bin/sh', [join(moduleDir, 'entrypoint.sh'), '/tmp/x.sock'], {encoding: 'utf8'});
  assert.equal(sockArg.status, 78);
  assert.match(sockArg.stderr ?? '', /ARQUITETURA_SOCKET_FORBIDDEN/);
});

test('normalização de caminhos, linhas e cópia segura ignoram symlinks e travessia', () => {
  assert.equal(normalizeRepoPath('/tmp/work/repo/src/a.ts', '/tmp/work/repo'), 'src/a.ts');
  assert.equal(normalizeRepoPath('./src/../src/b.ts', '/tmp/work/repo'), 'src/b.ts');
  assert.equal(normalizeRepoPath('../../etc/passwd', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath('/src/main.ts', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath(' draft.ts', '/tmp/work/repo'), ' draft.ts');
  assert.equal(normalizeRepoPath('./..draft.ts', '/tmp/work/repo'), '..draft.ts');
  assert.equal(normalizeRepoPath('/tmp/work\\repo/src/a.ts', '/tmp/work/repo'), '.');
  assert.equal(normalizeRepoPath('src/a\\b.ts', '/tmp/work/repo'), '.');
  assert.equal(clampLine(0), 1);
  assert.equal(clampLine(-5), 1);
  assert.equal(clampLine(14.9), 14);

  const src = mkdtempSync(join(tmpdir(), 'arch-copy-src-'));
  const dst = mkdtempSync(join(tmpdir(), 'arch-copy-dst-'));
  try {
    mkdirSync(join(src, 'src'), {recursive: true});
    mkdirSync(join(src, 'node_modules', 'evil'), {recursive: true});
    writeFileSync(join(src, 'src', 'ok.ts'), 'export const ok = 1;\n');
    writeFileSync(join(src, 'node_modules', 'evil', 'bad.js'), 'console.log(1);\n');
    const outside = join(dst, 'outside.txt');
    writeFileSync(outside, 'outside synthetic content');
    symlinkSync(outside, join(src, 'src', 'escape.ts'));

    chmodSync(join(src, 'src', 'ok.ts'), 0o444);
    const res = copyRepoSafely(src, dst);
    assert.equal(statSync(join(dst, 'src', 'ok.ts')).mode & 0o777, 0o600);
    assert.deepEqual(res.copiedFiles, ['src/ok.ts']);
    assert.deepEqual(res.skipped, [
      {file: 'node_modules', reason: 'diretorio_excluido'},
      {file: 'src/escape.ts', reason: 'symlink'},
    ]);
    symlinkSync(src, join(dst, 'alias'));
    assert.throws(() => copyRepoSafely(join(dst, 'alias', 'src'), dst), /ARQUITETURA_REPO_UNREADABLE/);
    assert.throws(() => copyRepoSafely(dst + '/alias/../src', dst), /ARQUITETURA_REPO_UNREADABLE/);
    const refusedDestination = copyRepoSafely(src, join(dst, 'alias', 'uncreated'));
    assert.ok(refusedDestination.failure);
    assert.equal(existsSync(join(src, 'uncreated')), false);
    const target = join(dst, 'busca');
    mkdirSync(target);
    const nested = join(target, 'legivel');
    mkdirSync(nested);
    writeFileSync(join(nested, 'controle.ts'), 'export const controle = 1;');
    chmodSync(target, 0o111);
    try {
      assert.deepEqual(copyRepoSafely(nested, join(dst, 'novo')).copiedFiles, ['controle.ts']);
    } finally { chmodSync(target, 0o700); }
    const limited = copyRepoSafely(src, dst, {maxFiles: 0});
    assert.equal(limited.stoppedAt, 'node_modules');
    assert.equal(existsSync(join(dst, 'src', 'escape.ts')), false);
    assert.equal(existsSync(join(dst, 'node_modules', 'evil', 'bad.js')), false);
  } finally {
    rmSync(src, {recursive: true, force: true});
    rmSync(dst, {recursive: true, force: true});
  }
});

test('origem e destino relativos usam a âncora local mesmo sem process.cwd()', t => {
  const root = mkdtempSync(join(tmpdir(), 'ac-arq-rel-'));
  const previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync('entrada');
    writeFileSync('entrada/controle.ts', 'export const ok = 1;');
    assert.equal(copyRepoSafely('entrada', '').failure?.code, 'ENOENT');
    assert.equal(existsSync('controle.ts'), false);
    assert.throws(() => copyRepoSafely('', 'saida'), /ARQUITETURA_REPO_UNREADABLE/);
    const cwd = t.mock.method(process, 'cwd', () => {
      throw new Error('a cópia relativa deve abrir o diretório atual diretamente');
    });
    const nativeOpen = fs.openSync;
    const anchors: number[] = [];
    let reserved: number | undefined;
    const open = t.mock.method(fs, 'openSync', (...args: Parameters<typeof nativeOpen>) => {
      const [path, flags] = args;
      // A primeira âncora já pode estar fechada. Reserve seu número para distinguir os dois retornos.
      if (path === '.' && anchors.length === 1) reserved = nativeOpen('.', flags);
      const fd = nativeOpen(...args);
      if (path === '.') anchors.push(fd);
      return fd;
    });
    syncBuiltinESMExports();
    try {
      const snapshot = copyRepoSafely('entrada', 'saida');
      const opened = open.mock.calls.map(call => call.arguments[0]);
      assert.deepEqual(opened.filter(path => path === '.' || path === '/'), ['.', '.']);
      assert.equal(anchors.length, 2);
      assert.notEqual(anchors[0], anchors[1]);
      assert.deepEqual(opened.filter(path => typeof path === 'string' && /\/(entrada|saida)$/.test(path)), [
        `/proc/self/fd/${anchors[0]}/entrada`,
        `/proc/self/fd/${anchors[1]}/saida`,
      ]);
      assert.equal(snapshot.failure, undefined);
      assert.deepEqual(snapshot.copiedFiles, ['controle.ts']);
      assert.equal(readFileSync('saida/controle.ts', 'utf8'), 'export const ok = 1;');
    } finally {
      open.mock.restore();
      if (reserved !== undefined) fs.closeSync(reserved);
      syncBuiltinESMExports();
      cwd.mock.restore();
    }
  } finally {
    process.chdir(previous);
    rmSync(root, {recursive: true, force: true});
  }
});

test('parsers de knip, jscpd e dependency-cruiser extraem todos os 5 tipos de achado com evidência e linha >= 1', () => {
  const knipOut = parseKnipReport(
    {
      analyzedFiles: ['src/index.ts', 'src/shared/format.ts'],
      entryFiles: ['src/index.ts'],
      issues: [
        {
          file: 'src/legacy-dead.ts',
          files: [{name: 'src/legacy-dead.ts'}],
          exports: [],
          dependencies: [],
        },
        {
          file: 'src/shared/format.ts',
          files: [],
          exports: [{name: 'unusedFormatter', line: 5}],
          dependencies: [{name: 'unused-dep', line: 9}],
        },
      ],
    },
    '/tmp/repo',
    new Set(['src/index.ts', 'src/legacy-dead.ts', 'src/shared/format.ts', 'src/unmeasured.mts']),
  );
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-FILE' && f.file === 'src/legacy-dead.ts' && f.line === 1), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-EXPORT' && f.file === 'src/shared/format.ts' && f.line === 5), true);
  assert.equal(knipOut.findings.some(f => f.rule === 'KNIP-UNUSED-DEPENDENCY' && f.line === 9), true);
  assert.deepEqual(knipOut.perFileCoverage.map(({file, role}) => [file, role]), [
    ['src/index.ts', 'entrada'],
    ['src/legacy-dead.ts', 'nao_alcancado'],
    ['src/shared/format.ts', 'modulo'],
  ]);

  const dupOut = parseJscpdReport(
    {
      duplicates: [
        {
          kind: 'exact',
          lines: 14,
          tokens: 68,
          fragment: 'let subtotal = 0;\nfor (const item of items) {}',
          firstFile: {name: 'src/services/billing-legacy.ts', startLoc: {line: 7}, endLoc: {line: 20}},
          secondFile: {name: 'src/services/billing-modern.ts', startLoc: {line: 7}, endLoc: {line: 20}},
        },
      ],
      statistics: {total: {clones: 1, sources: 10, lines: 120, duplicatedLines: 14, percentage: 11.67}},
    },
    '/tmp/repo',
    null,
  );
  assert.equal(dupOut.findings.length, 1);
  assert.equal(dupOut.findings[0]?.rule, 'JSCPD-DUPLICATION');
  assert.equal(dupOut.findings[0]?.file, 'src/services/billing-legacy.ts');
  assert.equal(dupOut.findings[0]?.line, 7);
  assert.equal(dupOut.findings[0]?.severity, 'media');

  const compOut = parseJscpdComplexityReport(
    {
      summary: {
        totalFiles: 2,
        files: [
          {path: 'scripts/heavy.py', complexity: 31, lines: 180, tokens: 900, format: 'python'},
          {path: 'src/index.ts', complexity: 3, lines: 12, tokens: 45, format: 'typescript'},
        ],
      },
    },
    '/tmp/repo',
    null,
    new Set(['src/index.ts']),
  );
  assert.equal(compOut.findings.length, 1);
  assert.equal(compOut.findings[0]?.rule, 'JSCPD-COMPLEXITY-HIGH');
  assert.equal(compOut.findings[0]?.file, 'scripts/heavy.py');

  const sourceMap: Record<string, string> = {
    'src/domain/order.ts': "// import '../routes/orders.js'\nconst ref = '../routes/orders.js';\nimport {buildRoutePrefix} from\n  '../routes/orders.js';\nimport {readStoredFactor} from '../infra/memory-store.js';\n",
    'src/services/cycle-alpha.ts': "// comentario\nimport {continueCycleChain} from './cycle-beta.js';\n",
  };
  assert.equal(findImportLine(sourceMap['src/services/cycle-alpha.ts'], './cycle-beta.js'), 2);
  assert.equal(findImportLine(sourceMap['src/domain/order.ts'], '../infra/memory-store.js'), 5);
  assert.equal(findImportLine(sourceMap['src/domain/order.ts'], '../routes/orders.js'), 4);

  const depOut = parseDepcruiseReport(
    {
      modules: [
        {
          source: 'src/domain/order.ts',
          instability: 1,
          dependents: ['src/routes/orders.ts'],
          dependencies: [
            {
              module: '../routes/orders.js',
              resolved: 'src/routes/orders.ts',
              circular: true,
              rules: [{name: 'layer-domain-to-presentation'}, {name: 'no-circular'}],
            },
            {
              module: '../infra/memory-store.js',
              resolved: 'src/infra/memory-store.ts',
              circular: false,
              rules: [{name: 'layer-domain-to-infra', severity: 'error'}],
            },
          ],
        },
        {
          source: 'src/services/cycle-alpha.ts',
          instability: 0.5,
          dependents: ['src/services/cycle-beta.ts'],
          dependencies: [
            {
              module: './cycle-beta.js',
              resolved: 'src/services/cycle-beta.ts',
              circular: true,
              cycle: [{name: 'src/services/cycle-beta.ts'}, {name: 'src/services/cycle-alpha.ts'}],
              rules: [{name: 'no-circular', severity: 'error'}],
            },
          ],
        },
      ],
    },
    '/tmp/repo',
    rel => sourceMap[rel] ?? '',
  );
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-PRESENTATION' && f.line === 4 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-INFRA' && f.line === 5 && f.severity === 'alta'), true);
  assert.equal(depOut.findings.some(f => f.rule === 'DEPCRUISE-NO-CIRCULAR' && f.line === 2 && f.severity === 'alta'), true);
  assert.equal(depOut.stats.cycles, 2);
  assert.equal(depOut.findings.filter(f => f.rule === 'DEPCRUISE-NO-CIRCULAR' && f.file === 'src/domain/order.ts').length, 1);
  assert.equal(depOut.stats.layerViolations, 2);
});

test('Knip conserva os achados de produção quando a chamada omite o inventário', () => {
  const result = parseKnipReport({
    analyzedFiles: ['./src/billing.ts', '/synthetic/src/billing.ts', 'src/tests/helper.ts'],
    entryFiles: ['./src/billing.ts'],
    issues: [{file:'src/billing.ts', exports:[{name:'old', line:3}]},
      {file:'src/tests/helper.ts', exports:[{name:'fixture', line:1}]}],
  }, '/synthetic');
  assert.deepEqual(result.findings.map(f => f.file), ['src/billing.ts']);
  assert.equal(result.stats.totalFiles, 1);
  assert.deepEqual(result.perFileCoverage.map(({file, role, issues}) => [file, role, issues]), [['src/billing.ts', 'entrada', 1]]);
});

test('Knip aplica a elegibilidade aos achados e mantém problemas por arquivo e manifesto', () => {
  const result = parseKnipReport({
    analyzedFiles: ['src/main.ts', 'src/tests/ignored.ts', 'src/fixtures/ignored.ts'],
    entryFiles: ['src/main.ts'],
    issues: [
      {file: 'src/main.ts', exports: [{name: 'unused', line: 3}], unresolved: [{name: 'missing', line: 4}]},
      {file: 'src/dead.ts', files: [{name: 'src/dead.ts'}, {name: 'src/tests/dead.ts'}, {name: 'src/fixtures/dead.ts'}]},
      {file: 'src/tests/ignored.ts', exports: [{name: 'ignored', line: 1}], unresolved: [{name: 'ignored', line: 1}]},
      {file: 'src/fixtures/ignored.ts', exports: [{name: 'ignored', line: 1}]},
      {file: 'package.json', dependencies: [{name: 'unused-package', line: 1}]},
      {file: 'src/fixtures/package.json', dependencies: [{name: 'ignored-package', line: 1}]},
    ],
  }, '/synthetic', new Set(['src/main.ts', 'src/dead.ts']));
  assert.deepEqual(result.findings.map(item => item.file), ['src/main.ts', 'src/main.ts', 'src/dead.ts', 'package.json']);
  assert.deepEqual(result.perFileCoverage.map(({file, role, issues}) => [file, role, issues]), [
    ['src/dead.ts', 'nao_alcancado', 1], ['src/main.ts', 'entrada', 2],
  ]);
  assert.deepEqual(result.stats, {totalFiles: 2, entries: 1, unusedFiles: 1, unusedExports: 1, unusedDeps: 2});
});

test('complexidade e buildKnipConfig distinguem a fixture com defeito da fixture limpa', () => {
  const defectiveAst = analyzeAstComplexity(defectiveFixture, [
    'src/index.ts',
    'src/domain/order.ts',
    'src/services/complex-engine.ts',
  ]);
  assert.equal(defectiveAst.findings.some(f => f.file === 'src/services/complex-engine.ts' && f.rule === 'COMPLEXITY-CYCLOMATIC-HIGH'), true);
  assert.equal(defectiveAst.findings.some(f => f.file === 'src/services/complex-engine.ts' && f.rule === 'COMPLEXITY-NESTING-DEEP'), true);

  const cleanAst = analyzeAstComplexity(cleanFixture, [
    'src/index.ts',
    'src/routes/orders.ts',
    'src/services/order-service.ts',
    'src/domain/order.ts',
    'src/infra/memory-store.ts',
    'src/shared/format.ts',
  ]);
  assert.equal(cleanAst.findings.length, 0);
  assert.equal(cleanAst.perFile.length, 6);

  const knipCfg = buildKnipConfig(cleanFixture, ['package.json', 'src/index.ts', 'src/routes/orders.ts']);
  assert.deepEqual(knipCfg.entry, ['src/index.ts']);
  assert.deepEqual(knipCfg.project, ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}']);
});

test('falha de ferramenta aparece na cobertura como failed sem abortar o JSON e repositório vazio vira skipped', () => {
  const emptyRepo = mkdtempSync(join(tmpdir(), 'arch-empty-'));
  try {
    const emptyRes = runCollector({
      repoDir: emptyRepo,
      toolsRoot: moduleDir,
    });
    assertValidOutputContract(emptyRes);
    assert.equal(emptyRes.findings.length, 0);
    for (const row of emptyRes.coverage) {
      assert.equal(row.status, row.tool === 'snapshot' ? 'ok' : 'skipped');
    }
  } finally {
    rmSync(emptyRepo, {recursive: true, force: true});
  }

  const failedTools = runCollector({
    repoDir: defectiveFixture,
    toolsRoot: moduleDir,
    spawnSync: () => ({
      status: 2,
      stdout: '',
      stderr: 'TOOL_BINARY_CRASHED',
      error: undefined,
    }),
  });
  assertValidOutputContract(failedTools);
  for (const tool of ['knip', 'jscpd', 'dependency-cruiser']) {
    const row = failedTools.coverage.find(c => c.tool === tool);
    assert.ok(row, `cobertura ausente para ${tool}`);
    assert.equal(row.status, 'failed');
    assert.match(row.detail, /falha ao executar/i);
  }
  const astRow = failedTools.coverage.find(c => c.tool === 'ast-complexity');
  assert.equal(astRow?.status, 'ok');
});

test('raiz presente porém ilegível falha explicitamente, enquanto projeto acessível sem JS/TS declara skipped', t => {
  const noJsTsRepo = mkdtempSync(join(tmpdir(), 'arch-docs-only-'));
  try {
    writeFileSync(join(noJsTsRepo, 'README.md'), '# Apenas documentação\n');
    chmodSync(noJsTsRepo, 0o755);
    chmodSync(join(noJsTsRepo, 'README.md'), 0o644);
    const docsRes = runCollector({
      repoDir: noJsTsRepo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        const outDir = argv[argv.indexOf('--output') + 1];
        writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
        writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: []}}));
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    assertValidOutputContract(docsRes);
    assert.equal(docsRes.findings.length, 0);
    for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
      const row = docsRes.coverage.find(c => c.tool === tool);
      assert.ok(row, `cobertura ausente para ${tool}`);
      assert.equal(row.status, 'skipped');
    }
    assert.match(docsRes.coverage.find(c => c.tool === 'knip')?.detail ?? '', /arquivos copiados=1/);
  } finally {
    rmSync(noJsTsRepo, {recursive: true, force: true});
  }

  if (process.getuid?.() === 0) {
    t.skip('usuário root ignora modo 0000 no teste unitário sem contêiner');
    return;
  }

  for (const mode of [0o000, 0o400, 0o100]) {
    const unreadableRepo = mkdtempSync(join(tmpdir(), 'arch-unreadable-'));
    const copyDst = mkdtempSync(join(tmpdir(), 'arch-unreadable-dst-'));
    try {
      mkdirSync(join(unreadableRepo, 'src'), {recursive: true});
      writeFileSync(join(unreadableRepo, 'src', 'index.ts'), 'export const x = 1;\n');
      chmodSync(unreadableRepo, mode);

      assert.throws(() => copyRepoSafely(unreadableRepo, copyDst), /ARQUITETURA_REPO_UNREADABLE/);
      assert.throws(
        () => runCollector({repoDir: unreadableRepo, toolsRoot: moduleDir}),
        /ARQUITETURA_REPO_UNREADABLE/,
      );

      const cliRun = spawnSync(process.execPath, [join(moduleDir, 'collect.mjs')], {
        encoding: 'utf8',
        env: {...process.env, AC_REPO_DIR: unreadableRepo},
      });
      assert.equal(cliRun.status, 1);
      assert.equal((cliRun.stdout ?? '').trim(), '');
      assert.match(cliRun.stderr ?? '', /ARQUITETURA_REPO_UNREADABLE/);
    } finally {
      chmodSync(unreadableRepo, 0o700);
      rmSync(unreadableRepo, {recursive: true, force: true});
      rmSync(copyDst, {recursive: true, force: true});
    }
  }
});

test('cobertura por arquivo reflete apenas os arquivos efetivamente medidos sem atribuir métricas aos ignorados ou não medidos', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-coverage-exact-'));
  try {
    cpSync(cleanFixture, repo, {recursive: true});
    writeFileSync(join(repo, 'vite.config.ts'), "import {writeFileSync} from 'node:fs';\nexport default {};\n");
    writeFileSync(join(repo, 'knip.ts'), "import {writeFileSync} from 'node:fs';\nexport default {};\n");
    writeFileSync(join(repo, '.dependency-cruiser.js'), "const fs = require('node:fs');\nmodule.exports = {};\n");

    const measuredByJscpd = ['src/domain/order.ts', 'src/infra/memory-store.ts', 'src/services/order-service.ts'];
    const cleanSrcFiles = [
      'src/domain/order.ts',
      'src/index.ts',
      'src/infra/memory-store.ts',
      'src/routes/orders.ts',
      'src/services/order-service.ts',
      'src/shared/format.ts',
    ];

    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (cmd, args) => {
        const argList = Array.isArray(args) ? args.map(String) : [];
        const bin = String(cmd);
        if (argList[0]?.endsWith('/knip-worker.mjs')) {
          const stdout = JSON.stringify({issues: [], analyzedFiles: cleanSrcFiles, entryFiles: ['src/index.ts']});
          return {status: 0, stdout, stderr: ''};
        }
        if (bin.endsWith('jscpd') || argList.includes('--reporters')) {
          const outIdx = argList.indexOf('--output');
          const outDir = outIdx >= 0 ? argList[outIdx + 1] : '';
          if (argList.includes('--complexity')) {
            writeFileSync(
              join(outDir, 'jscpd-complexity.json'),
              JSON.stringify({
                summary: {
                  totalFiles: measuredByJscpd.length,
                  files: measuredByJscpd.map(file => ({
                    path: file,
                    complexity: 2,
                    lines: 10,
                    tokens: 45,
                    format: 'typescript',
                  })),
                },
              }),
            );
          } else {
            writeFileSync(
              join(outDir, 'jscpd-report.json'),
              JSON.stringify({
                duplicates: [],
                statistics: {total: {clones: 0, sources: measuredByJscpd.length, lines: 32, duplicatedLines: 0, percentage: 0}},
              }),
            );
          }
          return {status: 0, stdout: '', stderr: '', error: undefined};
        }
        const depOutIdx = argList.indexOf('--output-to');
        const depOutPath = depOutIdx >= 0 ? argList[depOutIdx + 1] : '';
        if (depOutPath) {
          writeFileSync(
            depOutPath,
            JSON.stringify({
              modules: [
                ...cleanSrcFiles.map(source => ({source, instability: 0.5, dependencies: [], dependents: []})),
                {source: 'node:fs', coreModule: true, instability: 0, dependencies: [], dependents: ['vite.config.ts']},
                {source: 'pkg-externo', couldNotResolve: true, instability: 0, dependencies: [], dependents: []},
                {source: 'node_modules/x/index.js', matchesDoNotFollow: true, instability: 0, dependencies: [], dependents: []},
              ],
            }),
          );
        }
        return {status: 0, stdout: '', stderr: '', error: undefined};
      },
    });

    assertValidOutputContract(out);
    const filesFor = (tool: string) =>
      out.coverage
        .filter(c => c.tool === tool)
        .map(c => /^arquivo=([^;]+);/.exec(c.detail)?.[1] ?? '')
        .filter(Boolean)
        .sort();

    assert.deepEqual(filesFor('knip:file'), [...cleanSrcFiles].sort());
    assert.deepEqual(filesFor('jscpd:file'), [...measuredByJscpd].sort());
    assert.deepEqual(filesFor('dependency-cruiser:file'), [...cleanSrcFiles].sort());
    assert.equal(filesFor('ast-complexity:file').includes('src/index.ts'), true);
    assert.match(out.coverage.find(c => c.tool === 'knip')?.detail ?? '', /arquivos=6,/);
    assert.match(out.coverage.find(c => c.tool === 'dependency-cruiser')?.detail ?? '', /modulos=6,/);
    assert.match(out.coverage.find(c => c.tool === 'jscpd')?.detail ?? '', /arquivos_medidos=3,/);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('arquivo ilegível com raiz acessível mantém o JSON da falha na cobertura', {skip: process.getuid?.() === 0}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-copy-failure-'));
  try {
    const file = join(repo, 'unreadable.ts');
    writeFileSync(file, 'export const synthetic = 1;\n', {mode: 0o000});
    const child = spawnSync(process.execPath, [join(moduleDir, 'collect.mjs')], {
      encoding: 'utf8',
      env: {...process.env, AC_REPO_DIR: repo},
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout) as ReturnType<typeof runCollector>;
    assertValidOutputContract(result);
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.length, 1);
    assert.equal(result.coverage[0]?.tool, 'snapshot');
    assert.equal(result.coverage[0]?.status, 'failed');
    assert.match(result.coverage[0]?.detail ?? '', /falha_copia=EACCES; analise_interrompida=sim/);
    assert.ok(!result.coverage[0]?.detail.includes('unreadable.ts'));
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('snapshot registra omissões e cobertura sinaliza o corte de 500 linhas em cada ferramenta', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-coverage-limit-'));
  try {
    const files = Array.from({length: 501}, (_, index) => `module-${index}.ts`);
    for (const file of files) {
      writeFileSync(join(repo, file), 'export const synthetic = 1;\n');
    }
    writeFileSync(join(repo, 'large.ts'), '');
    truncateSync(join(repo, 'large.ts'), 2 * 1024 * 1024 + 1);
    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {status: 0, stderr: '', stdout: JSON.stringify({issues: [], analyzedFiles: files, entryFiles: []})};
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: files.map(source => ({source}))}));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: files.map(path => ({path}))}}));
        }
        return {status: 0, stderr: '', stdout: ''};
      },
    });
    const snapshot = out.coverage.find(row => row.tool === 'snapshot');
    assert.equal(snapshot?.status, 'skipped');
    assert.match(snapshot?.detail ?? '', /limite_arquivos=10000; limite_bytes_por_arquivo=2097152; cobertura_parcial=sim/);
    assert.match(snapshot?.detail ?? '', /omissoes_por_motivo: limite_bytes=1/);
    assert.ok(!JSON.stringify(out).includes('large.ts'));
    for (const tool of ['knip', 'ast-complexity', 'jscpd', 'dependency-cruiser']) {
      assert.match(out.coverage.find(row => row.tool === tool)?.detail ?? '', /linhas_por_arquivo=500\/501; limite_linhas=500; cobertura_truncada=sim/);
      assert.equal(out.coverage.filter(row => row.tool === `${tool}:file`).length, 500);
    }
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('snapshot delimita as omissões conhecidas quando a travessia atinge o limite de arquivos', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-snapshot-limit-'));
  try {
    const scanned = join(repo, 'src');
    mkdirSync(join(scanned, 'tail'), {recursive: true});
    for (let index = 0; index < 10_000; index++) {
      writeFileSync(join(scanned, `file-${index}.txt`), '');
    }
    writeFileSync(join(scanned, 'm\\q.ts'), '');
    writeFileSync(join(scanned, 'tail', 'a\\q.ts'), '');
    writeFileSync(join(scanned, 'tail', 'controle.txt'), '');
    writeFileSync(join(scanned, 'z\\q.ts'), '');
    writeFileSync(join(repo, 'z\\q.ts'), '');

    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: () => ({status: 1, stdout: '', stderr: 'ferramenta simulada'}),
    });
    const snapshot = out.coverage.find(row => row.tool === 'snapshot');
    assert.equal(snapshot?.status, 'skipped');
    assert.match(snapshot.detail, /^copiados=10000; omissoes_conhecidas=1;/);
    assert.match(snapshot.detail, /cobertura_parcial=sim; omissoes_por_motivo: nome_nao_suportado=1;/);
    assert.match(snapshot.detail, /limite_arquivos_atingido=sim; restante_nao_inventariado=sim; fora_do_inventario=entrada_do_corte_e_restante_da_travessia$/);
    assert.ok(!snapshot.detail.includes('src/'));
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('dependency-cruiser mantém a falha quando o processo deixa um JSON válido', () => {
  const out = runCollector({
    repoDir: cleanFixture,
    toolsRoot: moduleDir,
    spawnSync: (_cmd, args) => {
      const argv = args as string[];
      if (argv.includes('--output-to')) {
        writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: 'src/index.ts'}]}));
      }
      return {status: 2, stdout: '', stderr: 'falha sintética'};
    },
  });
  const row = out.coverage.find(item => item.tool === 'dependency-cruiser');
  assert.equal(row?.status, 'failed');
  assert.match(row?.detail ?? '', /status 2$/);
  assert.ok(!row?.detail.includes('falha sintética'));
  assert.equal(out.coverage.some(item => item.tool === 'dependency-cruiser:file'), false);
});

test('AST mede getters, setters e decisões nos parâmetros sem contar funções aninhadas duas vezes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-accessors-'));
  try {
    const file = 'accessors.ts';
    writeFileSync(join(repo, file), [
      'class Example {',
      '  get value() { return a && b && c; }',
      '  set value(next) { if (next) this.target = next ?? other; }',
      '}',
      'function defaults(x = a ? b : c, y = () => d && e && f) { if (x) return y(); }',
    ].join('\n'));
    const result = analyzeAstComplexity(repo, [file], {fnCyclomaticMedia: 3});
    assert.equal(result.perFile[0]?.functions, 4);
    assert.equal(result.perFile[0]?.fileCyclomatic, 9);
    const findings = result.findings.filter(f => f.rule === 'COMPLEXITY-CYCLOMATIC-HIGH');
    assert.deepEqual(findings.map(({line}) => line).sort(), [2, 3, 5, 5]);
    assert.equal(findings.every(({evidence}) => evidence.includes('complexidade_ciclomatica=3;')), true);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('configuração do grafo preserva extends locais com e sem extensão dentro da cópia', () => {
  const temp = mkdtempSync(join(tmpdir(), 'arch-tsconfig-'));
  const repo = join(temp, 'repo');
  try {
    mkdirSync(join(repo, 'config'), {recursive: true});
    writeFileSync(join(temp, 'outside.json'), '{}');
    writeFileSync(join(repo, 'index.ts'), 'export const synthetic = 1;\n');
    writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({
      extends: ['.\\config\\base', './config/other.json', '..\\outside', 'outside-package', '.\\config\\link'],
    }));
    writeFileSync(join(repo, 'config', 'base.json'), JSON.stringify({extends: '..\\shared'}));
    writeFileSync(join(repo, 'shared.json'), JSON.stringify({extends: '..\\outside'}));
    writeFileSync(join(repo, 'config', 'other.json'), '{}');
    symlinkSync(join(temp, 'outside.json'), join(repo, 'config', 'link.json'));
    const output = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args, options) => {
        const argv = args as string[];
        if (!argv.includes('--output-to')) return {status: 2, stdout: '', stderr: ''};
        const {cwd} = options as {cwd: string};
        const root = JSON.parse(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'));
        assert.deepEqual(root.extends, ['./config/base', './config/other.json']);
        const base = JSON.parse(readFileSync(join(cwd, 'config', 'base.json'), 'utf8'));
        assert.equal(base.extends, '../shared');
        const shared = JSON.parse(readFileSync(join(cwd, 'shared.json'), 'utf8'));
        assert.equal(shared.extends, undefined);
        const config = JSON.parse(readFileSync(argv[argv.indexOf('--config') + 1], 'utf8'));
        assert.equal(config.options.tsConfig.fileName, 'tsconfig.json');
        writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: 'index.ts'}]}));
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    assert.equal(output.coverage.find(row => row.tool === 'dependency-cruiser')?.status, 'ok', JSON.stringify(output.coverage));
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});

test('binários fixados medem .mts e .cts no Knip e resolvem alias TS herdado no grafo', {
  skip: !existsSync(join(moduleDir, 'node_modules', '.bin', 'depcruise')) ||
    !existsSync(join(moduleDir, 'node_modules', 'knip', 'package.json')),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-pinned-tools-'));
  try {
    cpSync(defectiveFixture, repo, {recursive: true});
    const tsconfigPath = join(repo, 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    writeFileSync(tsconfigPath, JSON.stringify({...tsconfig, extends: '.\\tsconfig.base'}));
    writeFileSync(join(repo, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: {paths: {'@storage': ['./src/infra/memory-store.ts']}},
    }));
    const packagePath = join(repo, 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    writeFileSync(packagePath, JSON.stringify({...manifest, knip: {entry: ['ignored.ts']}}));
    const pnpmPath = join(repo, 'pnpm-workspace.yaml');
    writeFileSync(pnpmPath, 'packages: []\ninclude: synthetic.yaml\n');
    const originals = [tsconfigPath, join(repo, 'tsconfig.base.json'), packagePath, pnpmPath]
      .map(path => ({path, content: readFileSync(path, 'utf8')}));
    for (const {path} of originals) chmodSync(path, 0o444);
    mkdirSync(join(repo, 'src/tests'), {recursive: true});
    mkdirSync(join(repo, 'src/fixtures'), {recursive: true});
    writeFileSync(join(repo, 'src/tests/ignored.ts'), 'export const ignoredTest = 1;\n');
    writeFileSync(join(repo, 'src/fixtures/ignored.ts'), 'export const ignoredFixture = 1;\n');
    const orderPath = join(repo, 'src/domain/order.ts');
    const order = readFileSync(orderPath, 'utf8').replace('../infra/memory-store.js', '@storage');
    writeFileSync(orderPath, order);

    const route = 'app/(portal)/[id]/page.ts';
    mkdirSync(join(repo, dirname(route)), {recursive: true});
    writeFileSync(join(repo, route), 'export function syntheticRoute() { return 1; }\n');
    writeFileSync(join(repo, '.env.example'), 'SYNTHETIC_EXAMPLE=fixture\n');
    const out = runCollector({repoDir: repo, toolsRoot: moduleDir});
    assert.equal(out.coverage.find(row => row.tool === 'knip')?.status, 'ok');
    for (const file of ['src/unused.mts', 'src/unused.cts']) {
      assert.ok(out.findings.some(f => f.rule === 'KNIP-UNUSED-FILE' && f.file === file));
      assert.ok(out.coverage.some(row => row.tool === 'knip:file' &&
        row.detail === `arquivo=${file}; papel=nao_alcancado; problemas=1`));
    }
    assert.ok(out.findings.some(f => f.rule === 'DEPCRUISE-LAYER-DOMAIN-TO-INFRA' &&
      f.evidence.includes('src/infra/memory-store.ts') && f.evidence.includes('@storage')));
    const parsed = parseModuleCollectorOutput(JSON.stringify(out), {module: 'arquitetura'});
    assert.ok(parsed.coverage.some(row => row.tool === 'dependency-cruiser:file' && row.files?.includes(route)));
    assert.ok(parsed.findings.some(f => f.file === route && f.rule === 'KNIP-UNUSED-FILE'));
    assert.ok(!JSON.stringify(out).includes('.env.example'));
    assert.equal(out.findings.some(f => /src\/(tests|fixtures)\//.test(f.file)), false);
    assert.equal(out.coverage.some(row => row.tool === 'knip:file' && /src\/(tests|fixtures)\//.test(row.detail)), false);
    for (const {path, content} of originals) {
      assert.equal(readFileSync(path, 'utf8'), content);
      assert.equal(statSync(path).mode & 0o777, 0o444);
    }
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('jscpd mede SQL em um projeto que contém apenas SQL', {
  skip: !existsSync(join(moduleDir, 'node_modules', '.bin', 'jscpd')),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-sql-only-'));
  try {
    writeFileSync(join(repo, 'schema.sql'), [
      'CREATE TABLE synthetic_orders (',
      '  id INTEGER PRIMARY KEY,',
      '  account_id INTEGER NOT NULL,',
      '  city VARCHAR(40) NOT NULL,',
      '  created_at TIMESTAMP NOT NULL,',
      '  status VARCHAR(12) NOT NULL,',
      '  delivery_address VARCHAR(80),',
      '  CONSTRAINT valid_status CHECK (status IN (\'sent\', \'pending\'))',
      ');',
      'CREATE INDEX synthetic_orders_status ON synthetic_orders (account_id, status);',
    ].join('\n'));
    const out = runCollector({repoDir: repo, toolsRoot: moduleDir});
    assert.equal(out.coverage.find(row => row.tool === 'jscpd')?.status, 'ok', JSON.stringify(out.coverage));
    assert.ok(out.coverage.some(row => row.tool === 'jscpd:file' && row.detail.startsWith('arquivo=schema.sql;')));
    assert.equal(out.coverage.find(row => row.tool === 'knip')?.status, 'skipped');
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('coletor exclui arquivos e diretórios com segredo reconhecido por hasKnownSecret antes do JSON e o mapa agrega a omissão', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-secret-names-'));
  try {
    const safe = 'src/app.ts';
    const secretFiles = [
      'src/AKIAIOSFODNN7EXAMPLE.ts',
      `src/ghp_${'a'.repeat(20)}.ts`,
      'src/password=valor_sintetico/index.ts',
      'app/(portal)/AKIAIOSFODNN7EXAMPLE/page.ts',
    ];
    for (const file of [safe, ...secretFiles]) {
      mkdirSync(dirname(join(repo, file)), {recursive: true});
      writeFileSync(join(repo, file), 'export const synthetic = 1;\n');
    }
    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args, options) => {
        const argv = args as string[];
        const {cwd} = options as {cwd: string};
        for (const file of secretFiles) assert.equal(existsSync(join(cwd, file)), false);
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {status: 0, stdout: JSON.stringify({issues: [], analyzedFiles: [safe]}), stderr: ''};
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: safe}]}));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: [{path: safe, lines: 1, complexity: 1}]}}));
        }
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    const rawJson = JSON.stringify(out);
    for (const fragment of ['AKIAIOSFODNN7EXAMPLE', `ghp_${'a'.repeat(20)}`, 'password=valor_sintetico']) {
      assert.equal(rawJson.includes(fragment), false, fragment);
    }
    const astFiles = out.coverage.filter(row => row.tool === 'ast-complexity:file').flatMap(row => row.files ?? []);
    assert.deepEqual(astFiles, [safe]);
    assert.match(out.coverage.find(row => row.tool === 'snapshot')!.detail, /omissoes_conhecidas=4;/);
    const parsed = parseModuleCollectorOutput(rawJson, {module: 'arquitetura'});
    assert.deepEqual(parsed.coverage.find(row => row.tool === 'ast-complexity:file')?.files, [safe]);

    const map = await mapModuleSnapshot(repo, undefined, {aggregateOmissions: true});
    assert.equal(map.fileOmissions, 4);
    assert.deepEqual(map.files.map(item => item.file), [safe]);
    for (const secretPath of secretFiles) {
      assert.throws(() => assertModuleRepoRelativePath(secretPath), (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN');
    }
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('parser recusa ancestrais protegidos em caminhos comuns e de prontidão preservando exceção de folha e correspondência com cobertura', () => {
  for (const forbidden of [
    'app/(portal)/.npmrc/[id].ts',
    'app/(portal)/.netrc/[id].ts',
    'app/(portal)/.pgpass/[id].ts',
    'app/(portal)/.ENV/[id].ts',
    'app/(portal)/credentials/[id].ts',
    'app/(portal)/id_rsa/[id].ts',
    'app/(portal)/server.key/[id].ts',
    'app/.npmrc/.env',
  ]) {
    assert.throws(() => assertModuleRepoRelativePath(forbidden), (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN', forbidden);
    assert.throws(() => parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'gitleaks', version: '1', status: 'ok', detail: 'ok', files: [forbidden]}],
      findings: [{tool: 'gitleaks', rule: 'generic-api-key', file: forbidden, line: 1, severity: 'alta',
        message: 'Possível segredo em arquivo protegido.', evidence: 'Localização informada pelo coletor; conteúdo protegido.'}],
    }), {module: 'prontidao'}), (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN', forbidden);
  }
  for (const validProtected of ['.env', 'app/.npmrc', 'deploy/server.key']) {
    const parsed = parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'gitleaks', version: '1', status: 'ok', detail: 'ok', files: [validProtected]}],
      findings: [{tool: 'gitleaks', rule: 'generic-api-key', file: validProtected, line: 1, severity: 'alta',
        message: 'Possível segredo em arquivo protegido.', evidence: 'Localização informada pelo coletor; conteúdo protegido.'}],
    }), {module: 'prontidao'});
    assert.equal(parsed.findings[0]?.file, validProtected);
    assert.throws(() => parseModuleCollectorOutput(JSON.stringify({
      coverage: [{tool: 'gitleaks', version: '1', status: 'ok', detail: 'ok', files: [validProtected]}],
      findings: [],
    }), {module: 'prontidao'}), (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN');
  }
});

test('Knip suprime importação relativa não resolvida sem extensão, ESM .js ou índice para arquivo omitido da cópia', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-knip-omitted-'));
  try {
    const page = 'app/(portal)/[id]/page.ts';
    const omittedTargets = [
      'app/(portal)/[id]/credentials-config.ts',
      'app/(portal)/[id]/credentials-esm.tsx',
      'app/(portal)/[id]/credentials-dir/index.ts',
    ];
    mkdirSync(dirname(join(repo, page)), {recursive: true});
    writeFileSync(join(repo, page), 'export const page = 1;\n');
    for (const target of omittedTargets) {
      mkdirSync(dirname(join(repo, target)), {recursive: true});
      writeFileSync(join(repo, target), 'export const secret = 1;\n');
    }
    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              analyzedFiles: [page],
              entryFiles: [page],
              issues: [{
                file: page,
                unresolved: [
                  {name: './credentials-config', line: 1},
                  {name: './credentials-config?raw', line: 2},
                  {name: './credentials-esm.jsx', line: 3},
                  {name: './credentials-dir', line: 4},
                  {name: './realmente-ausente', line: 5},
                ],
              }],
            }),
          };
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({modules: [{source: page}]}));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({summary: {files: [{path: page, lines: 1, complexity: 1}]}}));
        }
        return {status: 0, stdout: '', stderr: ''};
      },
    });
    const unresolved = out.findings.filter(f => f.rule === 'KNIP-UNRESOLVED-IMPORT');
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0]!.message, /\.\/realmente-ausente/);
    assert.equal(unresolved[0]!.line, 5);
    assert.match(out.coverage.find(row => row.tool === 'knip')!.detail, /fora_do_snapshot=3; cobertura_parcial=sim/);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('dependency-cruiser restringe arestas e instabilidade ao conjunto copiado e explicita métricas parciais', () => {
  const copied = new Set(['app/a.ts', 'app/b.ts', 'app/c.ts']);
  const omitted = new Set<string>();
  const includesFile = (file: string) => {
    if (copied.has(file)) return true;
    omitted.add(file);
    return false;
  };
  const partialReport = parseDepcruiseReport(
    {
      modules: [
        {
          source: 'app/a.ts',
          instability: 0.99,
          dependents: ['app/b.ts', 'app/credentials-oculto.ts'],
          dependencies: [
            {module: './b', resolved: 'app/b.ts'},
            {module: './credentials-oculto', resolved: 'app/credentials-oculto.ts'},
            {module: 'node:fs', resolved: 'node:fs', coreModule: true},
            {module: 'pkg', resolved: 'node_modules/pkg/index.js', matchesDoNotFollow: true},
          ],
        },
        {
          source: 'app/b.ts',
          instability: 0.95,
          dependents: ['app/a.ts'],
          dependencies: [{module: './a', resolved: 'app/a.ts'}, {module: './c', resolved: 'app/c.ts'}],
        },
        {
          source: 'app/c.ts',
          instability: 0.88,
          dependents: ['app/b.ts'],
          dependencies: [],
        },
        {
          source: 'app/credentials-oculto.ts',
          instability: 0.5,
          dependents: ['app/a.ts'],
          dependencies: [{module: './a', resolved: 'app/a.ts'}],
        },
      ],
    },
    '/tmp/repo',
    () => '',
    includesFile,
  );
  assert.equal(partialReport.stats.totalModules, 3);
  assert.equal(partialReport.stats.totalDependencies, 3);
  assert.equal(partialReport.stats.partial, true);
  assert.deepEqual([...omitted], ['app/credentials-oculto.ts']);
  const rowA = partialReport.perFileCoverage.find(row => row.file === 'app/a.ts')!;
  assert.equal(rowA.deps, 1);
  assert.equal(rowA.dependents, 1);
  assert.equal(rowA.instability, 'n/a');
  assert.equal(rowA.partial, true);
  const rowB = partialReport.perFileCoverage.find(row => row.file === 'app/b.ts')!;
  assert.equal(rowB.deps, 2);
  assert.equal(rowB.dependents, 1);
  assert.equal(rowB.instability, '0.67');
  assert.equal(rowB.partial, false);
  const rowC = partialReport.perFileCoverage.find(row => row.file === 'app/c.ts')!;
  assert.equal(rowC.deps, 0);
  assert.equal(rowC.dependents, 1);
  assert.equal(rowC.instability, '0.00');
  assert.equal(rowC.partial, false);
});

test('publicação normal via runVerificationModule renderiza caminhos de framework literalmente em mapa.md, cobertura.md e achados', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arch-normal-pub-'));
  const repo = join(root, 'repo');
  const dataDirectory = join(root, 'data');
  const routeLong = 'app/(portal)/[identificadorInternacionalDaTransacao]/page.ts';
  const routeCatchAll = 'app/(portal)/[[...slug]]/page.ts';
  const peer = 'app/(portal)/[id]/peer.ts';
  const secretTs = 'app/AKIAIOSFODNN7EXAMPLE.ts';
  const protectedAncestor = 'app/(portal)/.npmrc/[id].ts';
  let snapshot: string | undefined;
  try {
    mkdirSync(dataDirectory, {recursive: true, mode: 0o700});
    for (const file of [routeLong, routeCatchAll, peer, secretTs, protectedAncestor]) {
      mkdirSync(dirname(join(repo, file)), {recursive: true});
      writeFileSync(join(repo, file), 'export const routeHandler = 1;\n');
    }
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
        encoding: 'utf8',
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '-f', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');

    const projectId = '11111111-1111-4111-8111-111111111111';
    const contextId = '22222222-2222-4222-8222-222222222222';
    const runId = '33333333-3333-4333-8333-333333333333';
    const authority: Authority = {contextId, instanceId: 'synthetic-instance', epoch: 1};
    const runs = new Map<string, {id: string; module: string; commit_id: string; status: string;
      report_dir: string; report_prepared_dir: string; report_legacy_missing: boolean}>();
    const findingsRows: {achado_id: string; status: string; severity: string; file: string; line: number; payload: unknown}[] = [];
    const client = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('FROM ac_project_repositories')) return {rowCount: 1, rows: [{repo}]};
        if (sql.includes('FROM ac_exam_contexts')) return {rowCount: 1, rows: [{module: 'arquitetura'}]};
        if (sql.includes('pg_advisory_xact_lock')) return {rowCount: 0, rows: []};
        if (sql.includes('INSERT INTO ac_intents') || sql.includes('UPDATE ac_intents')) return {rowCount: 1, rows: []};
        if (sql.includes('SELECT 1 FROM ac_verify_runs') && sql.includes("status='running' AND report_prepared_dir")) {
          const row = runs.get(String(params[0]));
          return {rowCount: row && row.status === 'running' && row.report_prepared_dir === params[2] ? 1 : 0, rows: []};
        }
        if (sql.includes('FROM ac_verify_runs') && sql.includes("status IN ('done','failed')")) {
          const idFilter = params[2] ? String(params[2]) : null;
          const rows = [...runs.values()].filter(r => ['done', 'failed'].includes(r.status) && (!idFilter || r.id === idFilter));
          return {rowCount: rows.length, rows};
        }
        if (sql.includes('FROM ac_verify_runs')) return {rowCount: 0, rows: []};
        if (sql.includes('INSERT INTO ac_verify_runs')) {
          runs.set(String(params[0]), {
            id: String(params[0]), module: String(params[6]), commit_id: String(params[5]),
            status: 'running', report_dir: 'pending', report_prepared_dir: String(params[7]), report_legacy_missing: false,
          });
          return {rowCount: 1, rows: []};
        }
        if (sql.includes('UPDATE ac_verify_runs r SET status=')) return {rowCount: 0, rows: []};
        if (sql.includes('UPDATE ac_verify_runs SET status=')) {
          const row = runs.get(String(params[0]))!;
          row.status = String(params[1]);
          row.report_dir = String(params[2]);
          return {rowCount: 1, rows: []};
        }
        if (sql.includes('UPDATE ac_verify_runs SET exam_origin_sha256=')) return {rowCount: 1, rows: []};
        if (sql.includes('INSERT INTO ac_verify_findings')) {
          findingsRows.push({
            achado_id: String(params[1]), status: String(params[2]), severity: String(params[3]),
            file: String(params[4]), line: Number(params[5]), payload: JSON.parse(String(params[6])),
          });
          return {rowCount: 1, rows: []};
        }
        if (sql.includes('SELECT achado_id, status, severity, file, line, payload FROM ac_verify_findings')) {
          return {rowCount: findingsRows.length, rows: findingsRows};
        }
        if (sql.includes('INSERT INTO ac_verify_coverage') || sql.includes('INSERT INTO ac_verify_tool_coverage')) {
          return {rowCount: 1, rows: []};
        }
        throw new Error(`Unexpected SQL in synthetic ledger: ${sql}`);
      },
    };
    const ledger = {
      pool: {
        async query(sql: string) {
          if (sql.includes('ac_installation_activation')) return {rowCount: 1, rows: [{1: 1}]};
          throw new Error(`Unexpected pool SQL: ${sql}`);
        },
      },
      async authorize() { return {project_id: projectId, policy_revision: 0, plan_revision: 0}; },
      async fence() { return; },
      async refreshPending() { return; },
      async tx<T>(fn: (c: typeof client) => Promise<T>) { return fn(client); },
    } as unknown as Ledger;

    const result = await runVerificationModule({
      module: 'arquitetura',
      ledger,
      principal: 'owner-arch',
      authority,
      projectId,
      repoPath: repo,
      dataDirectory,
      commit,
      runId,
      createdAt: new Date('2026-11-19T00:00:00Z'),
      runCollector: async () => {
        snapshot = await prepareModuleSnapshot(repo, commit);
        return runCollector({
          repoDir: snapshot,
          toolsRoot: moduleDir,
          spawnSync: (_cmd, args) => {
            const argv = args as string[];
            if (argv[0]?.endsWith('/knip-worker.mjs')) {
              return {
                status: 0,
                stderr: '',
                stdout: JSON.stringify({
                  analyzedFiles: [routeLong, routeCatchAll, peer],
                  entryFiles: [peer],
                  issues: [
                    {file: routeLong, files: [{name: routeLong}], exports: [], unresolved: []},
                    {file: routeCatchAll, files: [{name: routeCatchAll}], exports: [], unresolved: []},
                  ],
                }),
              };
            }
            if (argv.includes('--output-to')) {
              writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({
                modules: [
                  {source: routeLong, instability: 1, dependencies: [{module: './peer', resolved: peer}], dependents: []},
                  {source: routeCatchAll, instability: 0, dependencies: [], dependents: []},
                  {source: peer, instability: 0, dependencies: [], dependents: [routeLong]},
                ],
              }));
            } else {
              const outDir = argv[argv.indexOf('--output') + 1];
              writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
              writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({
                summary: {files: [routeLong, routeCatchAll, peer].map(path => ({path, lines: 1, tokens: 8, complexity: 1}))},
              }));
            }
            return {status: 0, stdout: '', stderr: ''};
          },
        });
      },
      examinar: async req => {
        const map = await mapModuleSnapshot(req.snapshot, req.signal, {aggregateOmissions: true});
        assert.equal(map.fileOmissions, 2);
        return examineFunctionalModule({intentId: req.intentId, module: req.module, map, findings: req.findings, commit, signal: req.signal});
      },
    });

    const published = await readModuleReport(dataDirectory, projectId, result.runId, 'arquitetura');
    assert.equal(published.summary.id, runId);
    const mapa = readFileSync(join(result.directory, 'mapa.md'), 'utf8');
    const cobertura = readFileSync(join(result.directory, 'cobertura.md'), 'utf8');
    const achadosMd = published.achados.map(item => readFileSync(join(result.directory, 'achados', `${item.id}.md`), 'utf8'));
    const achadosJson = readFileSync(join(result.directory, 'achados.json'), 'utf8');
    const rawJson = readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const runJson = readFileSync(join(result.directory, 'run.json'), 'utf8');

    assert.equal(existsSync(join(result.directory, 'run.json')), true);
    assert.equal(JSON.parse(runJson).id, runId);
    for (const frameworkRoute of [routeLong, routeCatchAll]) {
      assert.ok(mapa.includes(`- ${frameworkRoute}`), `mapa.md exames missing ${frameworkRoute}`);
      assert.ok(mapa.includes(`| ${frameworkRoute} |`), `mapa.md inventário missing ${frameworkRoute}`);
      assert.ok(cobertura.includes(`arquivo=${frameworkRoute};`), `cobertura.md ferramenta missing ${frameworkRoute}`);
      assert.ok(cobertura.includes(`| ${frameworkRoute} |`), `cobertura.md tabela missing ${frameworkRoute}`);
      assert.ok(achadosMd.some(md => md.includes(`- Onde: ${frameworkRoute}:1`) && md.includes(`- Cenário: `) && md.includes(frameworkRoute)));
      assert.ok(achadosJson.includes(frameworkRoute));
      assert.ok(rawJson.includes(frameworkRoute));
    }
    const namedArtifacts: [string, string][] = [
      ['mapa.md', mapa],
      ['cobertura.md', cobertura],
      ['achados.json', achadosJson],
      ['bruto/achados-brutos.json', rawJson],
      ...achadosMd.map((md, idx): [string, string] => [`achados/ACH-00${idx + 1}.md`, md]),
    ];
    for (const [name, content] of namedArtifacts) {
      if (name === 'mapa.md' || name.startsWith('achados/')) {
        assert.equal(content.includes('[removido: alta entropia]'), false, `${name} unexpectedly redacted:\n${content}`);
      }
      assert.equal(content.includes('AKIAIOSFODNN7EXAMPLE'), false, `${name} leaked secret name`);
      assert.equal(content.includes('.npmrc'), false, `${name} leaked protected ancestor`);
    }
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    rmSync(root, {recursive: true, force: true});
  }
});

test('binários fixados suprimem import sem extensão de arquivo omitido no Knip e marcam grafo parcial no dependency-cruiser', {
  skip: !existsSync(join(moduleDir, 'node_modules', '.bin', 'depcruise')) ||
    !existsSync(join(moduleDir, 'node_modules', 'knip', 'package.json')),
}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-pinned-omitted-'));
  try {
    const page = 'app/(portal)/[id]/page.ts';
    const secretMod = 'app/(portal)/[id]/credentials-config.ts';
    const helper = 'app/(portal)/[id]/helper.ts';
    mkdirSync(dirname(join(repo, page)), {recursive: true});
    writeFileSync(join(repo, 'package.json'), JSON.stringify({name: 'pinned-omitted', private: true, main: page}));
    writeFileSync(join(repo, page), "import {secret} from './credentials-config';\nimport {ok} from './helper';\nexport const run = () => ok + secret;\n");
    writeFileSync(join(repo, helper), 'export const ok = 1;\n');
    writeFileSync(join(repo, secretMod), 'export const secret = 2;\n');

    const out = runCollector({repoDir: repo, toolsRoot: moduleDir});
    assert.equal(out.coverage.find(row => row.tool === 'knip')?.status, 'ok');
    assert.equal(out.findings.some(f => f.rule === 'KNIP-UNRESOLVED-IMPORT'), false);
    assert.match(out.coverage.find(row => row.tool === 'knip')?.detail ?? '', /fora_do_snapshot=1; cobertura_parcial=sim/);

    const depSummary = out.coverage.find(row => row.tool === 'dependency-cruiser')!;
    assert.equal(depSummary.status, 'ok');
    assert.match(depSummary.detail, /dependencias=1,/);
    assert.match(depSummary.detail, /metricas_grafo=parciais/);
    const pageDepRow = out.coverage.find(row => row.tool === 'dependency-cruiser:file' && row.files?.includes(page))!;
    assert.equal(
      pageDepRow.detail,
      `arquivo=${page}; deps=1; dependentes=0; instabilidade=n/a; ciclo=nao; violacao_camada=nao; metricas_parciais=sim`,
    );
    assert.ok(!JSON.stringify(out).includes('credentials-config'));
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

function createSyntheticArchLedger(repo: string, projectId: string): Ledger {
  const runs = new Map<string, {id: string; module: string; commit_id: string; status: string;
    report_dir: string; report_prepared_dir: string; report_legacy_missing: boolean}>();
  const findingsRows: {achado_id: string; status: string; severity: string; file: string; line: number; payload: unknown}[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM ac_project_repositories')) return {rowCount: 1, rows: [{repo}]};
      if (sql.includes('FROM ac_exam_contexts')) return {rowCount: 1, rows: [{module: 'arquitetura'}]};
      if (sql.includes('pg_advisory_xact_lock')) return {rowCount: 0, rows: []};
      if (sql.includes('INSERT INTO ac_intents') || sql.includes('UPDATE ac_intents')) return {rowCount: 1, rows: []};
      if (sql.includes('SELECT 1 FROM ac_verify_runs') && sql.includes("status='running' AND report_prepared_dir")) {
        const row = runs.get(String(params[0]));
        return {rowCount: row && row.status === 'running' && row.report_prepared_dir === params[2] ? 1 : 0, rows: []};
      }
      if (sql.includes('FROM ac_verify_runs') && sql.includes("status IN ('done','failed')")) {
        const idFilter = params[2] ? String(params[2]) : null;
        const rows = [...runs.values()].filter(r => ['done', 'failed'].includes(r.status) && (!idFilter || r.id === idFilter));
        return {rowCount: rows.length, rows};
      }
      if (sql.includes('FROM ac_verify_runs')) return {rowCount: 0, rows: []};
      if (sql.includes('INSERT INTO ac_verify_runs')) {
        runs.set(String(params[0]), {
          id: String(params[0]), module: String(params[6]), commit_id: String(params[5]),
          status: 'running', report_dir: 'pending', report_prepared_dir: String(params[7]), report_legacy_missing: false,
        });
        return {rowCount: 1, rows: []};
      }
      if (sql.includes('UPDATE ac_verify_runs r SET status=')) return {rowCount: 0, rows: []};
      if (sql.includes('UPDATE ac_verify_runs SET status=')) {
        const row = runs.get(String(params[0]))!;
        row.status = String(params[1]);
        row.report_dir = String(params[2]);
        return {rowCount: 1, rows: []};
      }
      if (sql.includes('UPDATE ac_verify_runs SET exam_origin_sha256=')) return {rowCount: 1, rows: []};
      if (sql.includes('INSERT INTO ac_verify_findings')) {
        findingsRows.push({
          achado_id: String(params[1]), status: String(params[2]), severity: String(params[3]),
          file: String(params[4]), line: Number(params[5]), payload: JSON.parse(String(params[6])),
        });
        return {rowCount: 1, rows: []};
      }
      if (sql.includes('SELECT achado_id, status, severity, file, line, payload FROM ac_verify_findings')) {
        return {rowCount: findingsRows.length, rows: findingsRows};
      }
      if (sql.includes('INSERT INTO ac_verify_coverage') || sql.includes('INSERT INTO ac_verify_tool_coverage')) {
        return {rowCount: 1, rows: []};
      }
      throw new Error(`Unexpected SQL in synthetic ledger: ${sql}`);
    },
  };
  return {
    pool: {
      async query(sql: string) {
        if (sql.includes('ac_installation_activation')) return {rowCount: 1, rows: [{1: 1}]};
        throw new Error(`Unexpected pool SQL: ${sql}`);
      },
    },
    async authorize() { return {project_id: projectId, policy_revision: 0, plan_revision: 0}; },
    async fence() { return; },
    async refreshPending() { return; },
    async tx<T>(fn: (c: typeof client) => Promise<T>) { return fn(client); },
  } as unknown as Ledger;
}

test('host e coletor alinham contrato global de redação entre caminho recusado, caminho comum longo suportado, componente protegido, ancestrais e token em texto livre', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arch-global-redact-compat-'));
  const repo = join(root, 'repo');
  const dataDirectory = join(root, 'data');
  const globalRefusedPath = 'src/international/payment/reconciliation.ts';
  const supportedLongPath = 'src/international/payments/reconciliation.ts';
  const protectedComponent = `src/token_${'A'.repeat(39)}G.ts`;
  const protectedAncestor = 'app/(portal)/.npmrc/[id].ts';
  const freeTextToken = `${'wJalrXUtn'.padEnd(19, 'Q')}/${'b'.repeat(20)}`;
  let snapshot: string | undefined;

  assert.equal(hasKnownSecret(globalRefusedPath), true);
  assert.equal(hasKnownSecret(supportedLongPath), false);
  assert.equal(hasKnownSecret(protectedComponent), true);
  assert.equal(hasKnownSecret(freeTextToken), true);
  assert.equal(redactUnknownSecrets(freeTextToken).includes(freeTextToken), false);

  for (const blocked of [globalRefusedPath, protectedComponent, protectedAncestor, freeTextToken]) {
    assert.throws(() => assertModuleRepoRelativePath(blocked), (err: unknown) => err instanceof Refusal && err.code === 'VERIFY_PATH_FORBIDDEN', blocked);
  }
  assert.equal(assertModuleRepoRelativePath(supportedLongPath), supportedLongPath);
  const redactedFinding = parseModuleCollectorOutput(JSON.stringify({
    coverage: [{tool: 'knip', version: '1', status: 'ok', detail: 'ok', files: [supportedLongPath]}],
    findings: [{
      tool: 'knip', rule: 'KNIP-UNUSED-EXPORT', file: supportedLongPath, line: 1, severity: 'baixa',
      message: `Token ${freeTextToken}`, evidence: `token=${freeTextToken}`,
    }],
  }), {module: 'arquitetura'});
  assert.equal(redactedFinding.findings[0]?.message.includes(freeTextToken), false);
  assert.equal(redactedFinding.findings[0]?.evidence.includes(freeTextToken), false);
  assert.equal(hasKnownSecret(redactedFinding.findings[0]?.message ?? ''), false);
  assert.equal(hasKnownSecret(redactedFinding.findings[0]?.evidence ?? ''), false);

  try {
    mkdirSync(dataDirectory, {recursive: true, mode: 0o700});
    for (const file of [globalRefusedPath, supportedLongPath, protectedComponent, protectedAncestor]) {
      mkdirSync(dirname(join(repo, file)), {recursive: true});
      writeFileSync(join(repo, file), 'export const synthetic = 1;\n');
    }
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
        encoding: 'utf8',
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '-f', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');

    const projectId = '44444444-4444-4444-8444-444444444444';
    const contextId = '55555555-5555-4555-8555-555555555555';
    const runId = '66666666-6666-4666-8666-666666666666';
    const authority: Authority = {contextId, instanceId: 'synthetic-instance', epoch: 1};

    const result = await runVerificationModule({
      module: 'arquitetura',
      ledger: createSyntheticArchLedger(repo, projectId),
      principal: 'owner-arch',
      authority,
      projectId,
      repoPath: repo,
      dataDirectory,
      commit,
      runId,
      createdAt: new Date('2026-11-19T00:00:00Z'),
      runCollector: async () => {
        snapshot = await prepareModuleSnapshot(repo, commit);
        return runCollector({
          repoDir: snapshot,
          toolsRoot: moduleDir,
          spawnSync: (_cmd, args, options) => {
            const argv = args as string[];
            const {cwd} = options as {cwd: string};
            for (const blocked of [globalRefusedPath, protectedComponent, protectedAncestor]) {
              assert.equal(existsSync(join(cwd, blocked)), false, blocked);
            }
            assert.equal(existsSync(join(cwd, supportedLongPath)), true);
            if (argv[0]?.endsWith('/knip-worker.mjs')) {
              return {
                status: 0,
                stderr: '',
                stdout: JSON.stringify({
                  analyzedFiles: [supportedLongPath],
                  entryFiles: [],
                  issues: [{file: supportedLongPath, files: [{name: supportedLongPath}], exports: [], unresolved: []}],
                }),
              };
            }
            if (argv.includes('--output-to')) {
              writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({
                modules: [{source: supportedLongPath, instability: 0, dependencies: [], dependents: []}],
              }));
            } else {
              const outDir = argv[argv.indexOf('--output') + 1];
              writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
              writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({
                summary: {files: [{path: supportedLongPath, lines: 1, tokens: 8, complexity: 1}]},
              }));
            }
            return {status: 0, stdout: '', stderr: ''};
          },
        });
      },
      examinar: async req => {
        const map = await mapModuleSnapshot(req.snapshot, req.signal, {aggregateOmissions: true});
        assert.equal(map.fileOmissions, 3);
        assert.deepEqual(map.files.map(item => item.file), [supportedLongPath]);
        return examineFunctionalModule({intentId: req.intentId, module: req.module, map, findings: req.findings, commit, signal: req.signal});
      },
    });

    const published = await readModuleReport(dataDirectory, projectId, result.runId, 'arquitetura');
    assert.equal(published.summary.id, runId);
    const mapa = readFileSync(join(result.directory, 'mapa.md'), 'utf8');
    const cobertura = readFileSync(join(result.directory, 'cobertura.md'), 'utf8');
    const achadosJson = readFileSync(join(result.directory, 'achados.json'), 'utf8');
    const rawJson = readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const achadosMd = published.achados.map(item => readFileSync(join(result.directory, 'achados', `${item.id}.md`), 'utf8'));

    assert.ok(mapa.includes(`| ${supportedLongPath} |`));
    assert.ok(cobertura.includes('omissoes_conhecidas=3;'));
    assert.ok(cobertura.includes('metricas_grafo=parciais; cobertura_parcial=sim'));
    assert.ok(cobertura.includes(`arquivo=${supportedLongPath}; deps=0; dependentes=0; instabilidade=n/a; ciclo=nao; violacao_camada=nao; metricas_parciais=sim`));
    assert.ok(achadosMd.some(md => md.includes(`- Onde: ${supportedLongPath}:1`)));

    for (const content of [mapa, cobertura, achadosJson, rawJson, ...achadosMd]) {
      assert.equal(content.includes('payment/reconciliation.ts'), false);
      assert.equal(content.includes('token_' + 'A'.repeat(39) + 'G'), false);
      assert.equal(content.includes('.npmrc'), false);
    }
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    rmSync(root, {recursive: true, force: true});
  }
});

test('diretório omitido com ponto no nome (src/credentials.v1) marca métricas e instabilidade do grafo como parciais', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-omitted-dot-dir-'));
  try {
    const omittedEntry = 'src/credentials.v1/index.ts';
    const helper = 'src/helper.ts';
    mkdirSync(dirname(join(repo, omittedEntry)), {recursive: true});
    writeFileSync(join(repo, omittedEntry), "import {helper} from '../helper';\nexport const run = () => helper();\n");
    writeFileSync(join(repo, helper), 'export const helper = () => 1;\n');

    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args, options) => {
        const argv = args as string[];
        const {cwd} = options as {cwd: string};
        assert.equal(existsSync(join(cwd, 'src/credentials.v1')), false);
        assert.equal(existsSync(join(cwd, helper)), true);
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {status: 0, stdout: JSON.stringify({analyzedFiles: [helper], entryFiles: [], issues: []}), stderr: ''};
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({
            modules: [{source: helper, instability: 0, dependencies: [], dependents: []}],
          }));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({
            summary: {files: [{path: helper, lines: 1, tokens: 6, complexity: 1}]},
          }));
        }
        return {status: 0, stdout: '', stderr: ''};
      },
    });

    const depSummary = out.coverage.find(row => row.tool === 'dependency-cruiser')!;
    assert.equal(depSummary.status, 'ok');
    assert.match(depSummary.detail, /metricas_grafo=parciais; cobertura_parcial=sim/);
    const helperDep = out.coverage.find(row => row.tool === 'dependency-cruiser:file' && row.files?.includes(helper))!;
    assert.equal(
      helperDep.detail,
      `arquivo=${helper}; deps=0; dependentes=0; instabilidade=n/a; ciclo=nao; violacao_camada=nao; metricas_parciais=sim`,
    );
    assert.equal(JSON.stringify(out).includes('credentials.v1'), false);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('Knip suprime importação relativa para index na raiz omitido (../, .., ./) sem suprimir fuga da raiz (../../)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arch-knip-root-index-'));
  try {
    const rootIndex = 'index.ts';
    const srcPage = 'src/page.ts';
    const rootPage = 'page.ts';
    mkdirSync(dirname(join(repo, srcPage)), {recursive: true});
    writeFileSync(join(repo, srcPage), 'export const srcPage = 1;\n');
    writeFileSync(join(repo, rootPage), 'export const rootPage = 1;\n');
    const outside = join(repo, '.env.outside');
    writeFileSync(outside, 'SECRET=1\n');
    symlinkSync(outside, join(repo, rootIndex));

    const out = runCollector({
      repoDir: repo,
      toolsRoot: moduleDir,
      spawnSync: (_cmd, args) => {
        const argv = args as string[];
        if (argv[0]?.endsWith('/knip-worker.mjs')) {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              analyzedFiles: [srcPage, rootPage],
              entryFiles: [rootPage],
              issues: [
                {
                  file: srcPage,
                  unresolved: [
                    {name: '../', line: 1},
                    {name: '..', line: 2},
                    {name: '../?raw', line: 3},
                    {name: '../../', line: 4},
                    {name: './ausente', line: 5},
                  ],
                },
                {
                  file: rootPage,
                  unresolved: [{name: './', line: 1}],
                },
              ],
            }),
          };
        }
        if (argv.includes('--output-to')) {
          writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({
            modules: [{source: srcPage}, {source: rootPage}],
          }));
        } else {
          const outDir = argv[argv.indexOf('--output') + 1];
          writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
          writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({
            summary: {files: [{path: srcPage, lines: 1, complexity: 1}, {path: rootPage, lines: 1, complexity: 1}]},
          }));
        }
        return {status: 0, stdout: '', stderr: ''};
      },
    });

    const unresolved = out.findings.filter(f => f.rule === 'KNIP-UNRESOLVED-IMPORT');
    assert.deepEqual(unresolved.map(f => ({line: f.line, msg: f.message})), [
      {line: 4, msg: 'Importação local não resolvida: ../../'},
      {line: 5, msg: 'Importação local não resolvida: ./ausente'},
    ]);
    assert.match(out.coverage.find(row => row.tool === 'knip')!.detail, /fora_do_snapshot=1; cobertura_parcial=sim/);

    const nonOmitted = parseKnipReport(
      {
        analyzedFiles: [srcPage],
        issues: [{file: srcPage, unresolved: [{name: '../', line: 1}]}],
      },
      '/tmp/repo',
      new Set([srcPage]),
      file => file === srcPage,
      () => false,
    );
    assert.equal(nonOmitted.findings.length, 1);
    assert.equal(nonOmitted.findings[0]?.rule, 'KNIP-UNRESOLVED-IMPORT');
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('publicação preserva rotas de interceptação longas em Markdown sem eximir segmento genérico de alta entropia', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arch-intercept-route-'));
  const repo = join(root, 'repo');
  const dataDirectory = join(root, 'data');
  const interceptRoutes = [
    'app/(.)[identificadorInternacionalDaTransacao]/page.ts',
    'app/(..)[identificadorInternacionalDaTransacao]/page.ts',
    'app/(..)(..)[identificadorInternacionalDaTransacao]/page.ts',
    'app/(...)[identificadorInternacionalDaTransacao]/page.ts',
    'app/(.)detalhesDoPagamentoInternacionalDaConta/page.ts',
    'src/app/(.)[[...identificadorInternacionalDaTransacao]]/page.tsx',
    'packages/checkout/app/(.)[identificadorInternacionalDaTransacao]/page.ts',
    'app/(.)[identificadorInternacionalDaTransacaoV2]/page.tsx',
  ];
  const lowercaseBase64Opaque = 'bcdefghijklmnopqrsbcdefghijklmnopqrsbcdefg'; // 42 chars, entropy ~4.06
  const lowercaseShortOpaque = 'bcdefghijklmnopqrstuvwxyzbcdefgh'; // 32 chars, 1 word
  const negativeCases = [
    'app/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/page.ts',
    'app/[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]/page.ts',
    'app/[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]]/page.ts',
    'app/(.)AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/page.ts',
    'app/(.)[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]/page.ts',
    'app/(.)[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]]/page.ts',
    'app/(AbCdEfGhIjKlMnOpQrStUvWxYz0123456789)/page.ts',
    `app/(.)[${lowercaseBase64Opaque}]/page.ts`,
    `app/(${lowercaseBase64Opaque})/page.ts`,
    `app/(.)${lowercaseBase64Opaque}/page.ts`,
    `packages/${lowercaseBase64Opaque}/app/(.)[identificadorInternacionalDaTransacao]/page.ts`,
    lowercaseBase64Opaque,
    `app/(.)[${lowercaseShortOpaque}]/page.ts`,
    'identificadorInternacionalDaTransacaoV2',
    'app/(.)[identificadorInternacionalDaTransacao]/[id]]/page.tsx:12',
    'app/(.)[identificadorInternacionalDaTransacao]/(grupo))/page.ts',
    'packages/checkout/app/(.)[identificadorInternacionalDaTransacao]/[id]]/page.tsx',
    'packages/checkout/app/(.)[identificadorInternacionalDaTransacao]/x.ts',
    'src/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x.ts',
    'src/(.)AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x.ts',
    'src/(.)[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]/x.ts',
    'src/(.)[AbCdEfGhIjKlMnOpQrStUvWxYz0123456789]]/x.ts',
    'app/(.)[identificadorInternacionalDaTransacao]]/page.ts',
    'src/(.)detalhesDoPagamentoInternacionalDaConta/x.ts',
  ];
  let snapshot: string | undefined;

  try {
    mkdirSync(dataDirectory, {recursive: true, mode: 0o700});
    for (const file of interceptRoutes) {
      mkdirSync(dirname(join(repo, file)), {recursive: true});
      writeFileSync(join(repo, file), 'export const routeHandler = 1;\n');
    }
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
        encoding: 'utf8',
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('add', '-f', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');

    const projectId = '77777777-7777-4777-8777-777777777777';
    const contextId = '88888888-8888-4888-8888-888888888888';
    const runId = '99999999-9999-4999-8999-999999999999';
    const authority: Authority = {contextId, instanceId: 'synthetic-instance', epoch: 1};

    const result = await runVerificationModule({
      module: 'arquitetura',
      ledger: createSyntheticArchLedger(repo, projectId),
      principal: 'owner-arch',
      authority,
      projectId,
      repoPath: repo,
      dataDirectory,
      commit,
      runId,
      createdAt: new Date('2026-11-19T00:00:00Z'),
      runCollector: async () => {
        snapshot = await prepareModuleSnapshot(repo, commit);
        return runCollector({
          repoDir: snapshot,
          toolsRoot: moduleDir,
          spawnSync: (_cmd, args) => {
            const argv = args as string[];
            if (argv[0]?.endsWith('/knip-worker.mjs')) {
              return {
                status: 0,
                stderr: '',
                stdout: JSON.stringify({
                  analyzedFiles: interceptRoutes,
                  entryFiles: [],
                  issues: interceptRoutes.map((route, idx) => ({
                    file: route,
                    files: [{name: route}],
                    exports: [],
                    unresolved: idx === 0 ? negativeCases.map((name, i) => ({name, line: i + 1})) : [],
                  })),
                }),
              };
            }
            if (argv.includes('--output-to')) {
              writeFileSync(argv[argv.indexOf('--output-to') + 1], JSON.stringify({
                modules: interceptRoutes.map(route => ({source: route, instability: 0, dependencies: [], dependents: []})),
              }));
            } else {
              const outDir = argv[argv.indexOf('--output') + 1];
              writeFileSync(join(outDir, 'jscpd-report.json'), JSON.stringify({duplicates: []}));
              writeFileSync(join(outDir, 'jscpd-complexity.json'), JSON.stringify({
                summary: {files: interceptRoutes.map(path => ({path, lines: 1, tokens: 8, complexity: 1}))},
              }));
            }
            return {status: 0, stdout: '', stderr: ''};
          },
        });
      },
      examinar: async req => {
        const map = await mapModuleSnapshot(req.snapshot, req.signal, {aggregateOmissions: true});
        return examineFunctionalModule({intentId: req.intentId, module: req.module, map, findings: req.findings, commit, signal: req.signal});
      },
    });

    const published = await readModuleReport(dataDirectory, projectId, result.runId, 'arquitetura');
    const mapa = readFileSync(join(result.directory, 'mapa.md'), 'utf8');
    const cobertura = readFileSync(join(result.directory, 'cobertura.md'), 'utf8');
    const achadosMd = published.achados.map(item => readFileSync(join(result.directory, 'achados', `${item.id}.md`), 'utf8'));
    const achadosJson = readFileSync(join(result.directory, 'achados.json'), 'utf8');
    const rawJson = readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8');

    for (const route of interceptRoutes) {
      assert.ok(mapa.includes(`| ${route} |`), `mapa.md missing ${route}`);
      assert.ok(cobertura.includes(`arquivo=${route};`), `cobertura.md missing ${route}`);
      assert.ok(cobertura.includes(`| ${route} |`), `cobertura.md table missing ${route}`);
      assert.ok(achadosMd.some(md => md.includes(`- Onde: ${route}:`) && md.includes(route)), `achado missing ${route}`);
      assert.ok(achadosJson.includes(route));
    }
    assert.equal(mapa.includes('[removido: alta entropia]'), false);
    for (const artifact of [mapa, cobertura, achadosJson, rawJson, ...achadosMd]) {
      assert.equal(artifact.includes('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), false);
      assert.equal(artifact.includes(lowercaseBase64Opaque), false);
      assert.equal(artifact.includes(lowercaseShortOpaque), false);
      assert.equal(artifact.includes('[identificadorInternacionalDaTransacao]]'), false);
      assert.equal(artifact.includes('[identificadorInternacionalDaTransacao]/[id]]'), false);
      assert.equal(artifact.includes('packages/checkout/app/(.)[identificadorInternacionalDaTransacao]/x.ts'), false);
      assert.equal(artifact.includes('src/(.)detalhesDoPagamentoInternacionalDaConta/x.ts'), false);
    }
    const unresolvedAchados = published.achados.filter(item => item.reference === 'knip:KNIP-UNRESOLVED-IMPORT');
    assert.equal(unresolvedAchados.length, negativeCases.length);
    for (const item of unresolvedAchados) {
      assert.ok(item.scenario.includes('[removido: alta entropia]'), `scenario not redacted: ${item.scenario}`);
      assert.ok(item.proof.includes('[removido: alta entropia]'), `proof not redacted: ${item.proof}`);
    }
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
    rmSync(root, {recursive: true, force: true});
  }
});
