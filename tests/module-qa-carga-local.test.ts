import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {moduleCollectorArguments, parseModuleCollectorOutput} from '../src/verification-modules.ts';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

type Status = 'ok' | 'skipped' | 'failed';
type Row = {tool: string; version: string; status: Status; detail: string; files?: string[]};
type Report = {coverageRow: Row; extraRows: Row[]; findings: unknown[]};
type Input = {
  workspace: string;
  workRoot: string;
  copiedFiles: string[];
  enabled: boolean;
  binDir: string;
  row: (tool: string, version: string, status: Status, detail: string) => Row;
  key: (tool: string, path: string) => string;
};
const {runLocalLoadQa, localLoadTool} = (await import(
  new URL('../deploy/modules/qa/carga-local/index.mjs', import.meta.url).href
)) as {runLocalLoadQa: (input: Input) => Promise<Report>; localLoadTool: string};
const {readLoadPlan, startStaticFixture} = (await import(
  new URL('../deploy/modules/qa/carga-local/snapshot.mjs', import.meta.url).href
)) as {
  readLoadPlan: (workspace: string, files: string[]) => {routes: unknown[]};
  startStaticFixture: (routes: unknown[]) => Promise<{port: number; token: string; close: () => Promise<void>}>;
};
const fixture = fileURLToPath(new URL('./fixtures/module-qa-carga-local/snapshot/', import.meta.url));
const tools = new URL('./fixtures/module-qa-carga-local/tool-doubles.mjs', import.meta.url).href;
const manifestFile = 'qa-carga-local.json';
const catalogFile = 'public/catalogo.json';
const indexFile = 'public/index.html';
const copiedFiles = [manifestFile, catalogFile, indexFile];

async function withFixture(check: (input: {
  workspace: string;
  binDir: string;
  run: (overrides?: Partial<Input>) => Promise<Report>;
  configureTools: (mode?: string) => void;
}) => Promise<void>) {
  const workRoot = mkdtempSync(join(tmpdir(), 'qa-carga-teste-'));
  const workspace = join(workRoot, 'snapshot');
  const binDir = join(workRoot, 'bin');
  try {
    cpSync(fixture, workspace, {recursive: true});
    mkdirSync(binDir);
    const configureTools = (mode = '') => {
      for (const name of ['k6', 'toxiproxy-server']) {
        writeFileSync(join(binDir, name), `#!${process.execPath}\nimport(${JSON.stringify(tools)});\n`, {mode: 0o700});
      }
      writeFileSync(join(binDir, 'mode'), mode);
    };
    const run = (overrides: Partial<Input> = {}) => runLocalLoadQa({
      workspace, workRoot, copiedFiles, enabled: true, binDir,
      row: (tool, version, status, detail) => ({tool, version, status, detail}),
      key: (tool, path) => `${tool}:${path}`,
      ...overrides,
    });
    await check({workspace, binDir, run, configureTools});
    assert.deepEqual(readdirSync(workRoot).sort(), ['bin', 'snapshot']);
    const pidFile = join(binDir, 'proxy.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, 'proxy de fixture encerrado');
    }
  } finally {
    rmSync(workRoot, {recursive: true, force: true});
  }
}

function route(report: Report, path: string) {
  const found = report.extraRows.find(row => row.tool === `${localLoadTool}:${path}`);
  assert.ok(found);
  return found;
}

function assertProof(report: Report) {
  assert.equal(report.coverageRow.status, 'ok', JSON.stringify(report));
  assert.equal(report.coverageRow.version, 'k6 2.4.0 / Toxiproxy 2.12.0');
  assert.match(report.coverageRow.detail, /2\/2 rotas.*250 ms.*2 VUs.*8 GET.*4 KiB/);
  assert.deepEqual(report.coverageRow.files, [indexFile, catalogFile]);
  for (const [path, file] of [['/', indexFile], ['/catalogo', catalogFile]] as const) {
    const evidence = route(report, path);
    assert.equal(evidence.status, 'ok');
    assert.deepEqual(evidence.files, [file]);
    const points = [...evidence.detail.matchAll(/(controle|degradada|recuperação) p95=(\d+\.\d) ms, 8 GET, 0\.0% falhas/g)];
    assert.deepEqual(points.map(point => point[1]), ['controle', 'degradada', 'recuperação']);
    const [control, degraded, recovery] = points.map(point => Number(point[2]));
    assert.ok(control <= 150);
    assert.ok(degraded - control >= 150);
    assert.ok(degraded - recovery >= 150);
    assert.ok(recovery <= control + 75);
  }
  assert.deepEqual(report.findings, []);
  assert.doesNotMatch(JSON.stringify(report), /FIXTURE-CARGA|127\.0\.0\.1|qa-carga-teste-/);
}

type Artifact = {url: string; sha256: string};
type Pin<T> = {version: string; linuxAmd64: T; linuxArm64: T};
type LoadToolLock = {
  k6: Pin<Artifact & {member: string}>;
  'toxiproxy-server': Pin<Artifact>;
};

function assertLoadPackaging(dockerfile: string, lock: LoadToolLock) {
  const stages = dockerfile.split(/^FROM /m);
  const selection = stages.find(stage => stage.startsWith('qa-carga-${TARGETARCH} AS qa-carga\n'));
  const image = stages.find(stage => stage.startsWith('mcr.microsoft.com/playwright:'));
  assert.ok(selection);
  assert.ok(image);
  assert.match(image, /^COPY --from=qa-carga \/opt\/qa-carga\/ \/usr\/local\/bin\/$/m);

  const commonInstructions = selection.split('\n').slice(1)
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n').replace(/[ \t]*\\[ \t]*\n[ \t]*/g, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean);

  for (const [arch, key] of [['amd64', 'linuxAmd64'], ['arm64', 'linuxArm64']] as const) {
    const stage = stages.find(candidate => candidate.startsWith(`qa-python AS qa-carga-${arch}\n`));
    assert.ok(stage, arch);
    const k6 = lock.k6[key];
    const proxy = lock['toxiproxy-server'][key];
    const k6Name = `k6-v${lock.k6.version}-linux-${arch}`;
    assert.equal(k6.url, `https://github.com/grafana/k6/releases/download/v${lock.k6.version}/${k6Name}.tar.gz`);
    assert.equal(k6.member, `${k6Name}/k6`);
    assert.equal(proxy.url, `https://github.com/Shopify/toxiproxy/releases/download/v${lock['toxiproxy-server'].version}/toxiproxy-server-linux-${arch}`);
    assert.match(k6.sha256, /^[a-f0-9]{64}$/);
    assert.match(proxy.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(stage.split('\n').filter(line => line.startsWith('ADD ')), [
      `ADD --checksum=sha256:${k6.sha256} ${k6.url} /tmp/k6.tar.gz`,
      `ADD --checksum=sha256:${proxy.sha256} ${proxy.url} /opt/qa-carga/toxiproxy-server`,
    ], arch);
    assert.deepEqual(commonInstructions.map(instruction => instruction.replaceAll('${TARGETARCH}', arch)), [
      'ARG TARGETARCH',
      `RUN tar -xzOf /tmp/k6.tar.gz "${k6.member}" > /opt/qa-carga/k6`
        + ' && chmod 0555 /opt/qa-carga/k6 /opt/qa-carga/toxiproxy-server',
    ], `instruções da etapa comum para linux/${arch}`);
  }
}

test('a imagem de QA seleciona os artefatos fixados para linux/amd64 e linux/arm64', async t => {
  const qaDir = new URL('../deploy/modules/qa/', import.meta.url);
  const dockerfile = readFileSync(new URL('Dockerfile', qaDir), 'utf8');
  const lock = JSON.parse(readFileSync(new URL('carga-local/tools.lock.json', qaDir), 'utf8')) as LoadToolLock;
  assertLoadPackaging(dockerfile, lock);

  const guard = 'test "${TARGETARCH}" = amd64';
  const mutations = [
    ['comando extra no RUN de extração', `RUN ${guard} && tar -xzOf`],
    ['instrução RUN extra antes da extração', `RUN ${guard}\nRUN tar -xzOf`],
  ];
  for (const [description, replacement] of mutations) {
    await t.test(`rejeita trava amd64 como ${description}`, () => {
      const restricted = dockerfile.replace('RUN tar -xzOf', replacement);
      assert.throws(() => assertLoadPackaging(restricted, lock), {
        code: 'ERR_ASSERTION',
        message: /instruções da etapa comum para linux\//,
      });
    });
  }
});

test('prova as três fases por rota com trocas HTTP locais e ferramentas sintéticas', async t => {
  await withFixture(async ({run, configureTools}) => {
    configureTools();
    const result = await run();
    assertProof(result);
    for (const row of result.extraRows) t.diagnostic(row.detail);
  });
});

test('falha quando o proxy local não introduz a degradação ou mantém a latência', async t => {
  for (const [mode, message] of [['no-delay', /degradação insuficiente/], ['sticky-delay', /recuperação insuficiente/]] as const) {
    await t.test(mode, async () => {
      await withFixture(async ({run, configureTools}) => {
        configureTools(mode);
        const result = await run();
        assert.equal(result.coverageRow.status, 'failed');
        assert.match(route(result, '/catalogo').detail, message);
      });
    });
  }
});

test('mantém a medição completa de uma rota e acusa série parcial da outra', async () => {
  await withFixture(async ({run, configureTools}) => {
    configureTools('partial');
    const result = await run();
    assert.equal(result.coverageRow.status, 'failed');
    assert.match(result.coverageRow.detail, /1\/2 rotas/);
    assert.equal(route(result, '/').status, 'ok');
    assert.equal(route(result, '/catalogo').status, 'failed');
    assert.match(route(result, '/catalogo').detail, /degradada sem medida \(série incompleta ou inválida\)/);
  });
});

test('retira o proxy local mesmo se a remoção da latência falhar', async () => {
  await withFixture(async ({run, configureTools}) => {
    configureTools('delete-fails');
    const result = await run();
    assert.equal(result.coverageRow.status, 'failed');
    assert.match(route(result, '/catalogo').detail, /remoção de latência.*recuperação sem medida/);
  });
});

test('informa ausência de manifesto, insumo, ferramentas e versão fixada', async () => {
  await withFixture(async ({run, configureTools}) => {
    const noManifest = await run({copiedFiles: [indexFile]});
    assert.equal(noManifest.coverageRow.status, 'skipped');
    assert.match(noManifest.coverageRow.detail, /qa-carga-local\.json ausente/);

    const noSource = await run({copiedFiles: [manifestFile, indexFile]});
    assert.equal(noSource.coverageRow.status, 'skipped');
    assert.match(route(noSource, '/catalogo').detail, /arquivo ausente do snapshot/);

    const disabled = await run({enabled: false});
    assert.equal(disabled.coverageRow.status, 'skipped');
    assert.match(disabled.coverageRow.detail, /homologação local isolada/);

    const missing = await run();
    assert.equal(missing.coverageRow.status, 'skipped');
    assert.match(route(missing, '/').detail, /k6 ausente, toxiproxy-server ausente/);

    configureTools('wrong-version');
    const wrongVersion = await run();
    assert.equal(wrongVersion.coverageRow.status, 'skipped');
    assert.match(wrongVersion.coverageRow.detail, /versão fixada 2\.4\.0 indisponível/);
  });
});

test('restringe as declarações a GETs estáticos exatos do snapshot público', async () => {
  await withFixture(async ({workspace, run, binDir}) => {
    const file = join(workspace, manifestFile);
    const write = (routes: object[]) => writeFileSync(file, JSON.stringify({version: 1, routes}));
    const valid = {path: '/catalogo', file: catalogFile};
    for (const routes of [
      [{...valid, path: 'http://example.invalid/catalogo'}],
      [{...valid, path: '/catalogo?pagina=1'}],
      [{...valid, method: 'POST'}],
      [{...valid, file: 'privado/catalogo.json'}],
      [valid, valid],
      Array.from({length: 4}, (_, i) => ({...valid, path: `/catalogo-${i}`})),
    ]) {
      write(routes);
      const result = await run();
      assert.equal(result.coverageRow.status, 'failed');
      assert.match(result.coverageRow.detail, /declaração inválida/);
      assert.doesNotMatch(JSON.stringify(result), /example\.invalid|privado/);
    }
    write([valid]);
    writeFileSync(join(workspace, catalogFile), 'x'.repeat(4097));
    assert.match(route(await run(), '/catalogo').detail, /acima de 4 KiB/);
    const alias = 'public/alias.json';
    symlinkSync('index.html', join(workspace, alias));
    write([{...valid, file: alias}]);
    assert.equal(route(await run({copiedFiles: [...copiedFiles, alias]}), '/catalogo').status, 'failed');
    assert.equal(existsSync(join(binDir, 'proxy.pid')), false);
  });
});

test('a fixture responde só aos GETs declarados e limita os corpos servidos', async () => {
  await withFixture(async ({workspace}) => {
    const {routes} = readLoadPlan(workspace, copiedFiles);
    const server = await startStaticFixture(routes);
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const declaredGet = (path: string, method = 'GET') => fetch(origin + path, {
        method, headers: {'x-qa-carga-fixture': server.token}, signal: AbortSignal.timeout(1000),
      });
      assert.equal((await declaredGet('/public/index.html')).status, 404);
      assert.equal((await declaredGet('/catalogo', 'HEAD')).status, 405);
      assert.equal((await fetch(origin + '/catalogo', {signal: AbortSignal.timeout(1000)})).status, 404);
      const expected = readFileSync(join(workspace, catalogFile), 'utf8');
      for (let i = 0; i < 24; i++) {
        const result = await declaredGet('/catalogo');
        assert.equal(result.status, 200);
        assert.equal(await result.text(), expected);
      }
      assert.equal((await declaredGet('/catalogo')).status, 429);
    } finally {
      await server.close();
    }
  });
});

const nativeBin = resolve(process.env.QA_CARGA_TEST_BIN_DIR ?? '/usr/local/bin');
const missingNative = ['k6', 'toxiproxy-server'].filter(name => !existsSync(join(nativeBin, name)));
test('prova controle, Toxiproxy e recuperação com os binários fixados e o snapshot sintético', {
  skip: missingNative.length ? `binários ausentes (${missingNative.join(', ')})` : false,
}, async t => {
  await withFixture(async ({run}) => {
    const result = await run({binDir: nativeBin});
    assertProof(result);
    for (const row of result.extraRows) t.diagnostic(row.detail);
  });
});

test('a imagem de QA mede a degradação e a recuperação de cada rota declarada', {
  skip: process.env.AC_MODULE_LAB !== '1',
  timeout: 100_000,
}, () => {
  const image = readFileSync(join(import.meta.dirname, '../deploy/modules/qa/digest.txt'), 'utf8').trim();
  const repository = join(import.meta.dirname, 'fixtures/module-qa-carga-local/snapshot');
  const [runtime, ...args] = moduleCollectorArguments({image, repository});
  const stdout = execFileSync(runtime!, args, {encoding: 'utf8', timeout: 80_000, maxBuffer: 16 * 1024 * 1024});
  const report = parseModuleCollectorOutput(stdout, {module: 'qa'});
  const summary = report.coverage.filter(row => row.tool === 'qa-carga');
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.status, 'ok');
  assert.match(summary[0]!.detail, /2\/2 rotas com controle, degradação e recuperação comprovados/);
  const routes = report.coverage.filter(row => row.tool.startsWith('qa-carga:'));
  assert.deepEqual(routes.map(row => row.tool).sort(), ['qa-carga:/', 'qa-carga:/catalogo']);
  for (const row of routes) {
    assert.equal(row.status, 'ok');
    assert.match(row.detail, /controle p95=.*degradada p95=.*recuperação p95=/);
  }
});
