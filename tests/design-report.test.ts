import assert from 'node:assert/strict';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {DESIGN_IMAGE, DESIGN_NETWORK, DESIGN_USER, designRunArguments} from '../src/design-image.ts';
import {readDesignReport, writeDesignReport} from '../src/design-report.ts';
import {DESIGN_ACCEPTANCE, DesignReportSummary, type DesignAchado, type DesignCoverageRow} from '../src/design-types.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '33333333-3333-4333-8333-333333333333';
const otherRunId = '55555555-5555-4555-8555-555555555555';
const createdAt = new Date(Date.UTC(2026, 10, 16, 3, 4, 5));
const commit = '0123456789abcdef0123456789abcdef01234567';
const note = 'Não foi possível verificar o tema escuro desta rodada.';
const mapMarkdown = '# Mapa\n\n- Rota: /contraste\n';
const preview = `AKIA\u2026 (sha256:${'ab'.repeat(32)})`;
const profileContraste = '22222222-2222-4222-8222-222222222222';
const profileBotao = '44444444-4444-4444-8444-444444444444';
const captureName = 'contraste-375-claro-padrao.png';
const captureBytes = Buffer.from('pixels-da-prova');
const fullKey = 'AKIAIOSFODNN7EXAMPLE';
const letterKey = 'AKIABCDEFGHIJKLMNOPQ';

const achados: DesignAchado[] = [
  {
    id: 'ACH-001',
    title: 'contraste abaixo de 4.5',
    severity: 'alta',
    status: 'confirmado',
    verifier: {model: 'modelo-revisor', provider: 'outro'},
    reference: 'WCAG-1-4-3-CONTRASTE',
    where: {file: 'html/contraste.html', line: 4},
    scenario: 'texto cinza claro sobre fundo branco',
    proof: 'capturas/contraste-375-claro-padrao.png',
    suggestion: 'usar #1b1b1b sobre #ffffff',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['axe', 'examinador da tela'],
    secretPreview: preview,
  },
  {
    id: 'ACH-002',
    title: 'preferencia de cor sem regra',
    severity: 'alta',
    status: 'descartado',
    verifier: {model: 'modelo-revisor', provider: 'outro'},
    reference: 'gosto',
    where: {file: 'css/boa.css', line: 2},
    scenario: 'o examinador preferiu outro azul',
    proof: 'o verificador nao reproduziu a falha',
    suggestion: 'nao abrir correcao',
    acceptance: 'o achado permanece descartado',
    sources: ['examinador da tela'],
    secretPreview: null,
  },
  {
    id: 'ACH-003',
    title: 'foco invisivel voltou depois da correcao',
    severity: 'media',
    status: 'reaberto',
    verifier: {model: 'modelo-b', provider: 'provedor-b'},
    reference: 'WCAG-2-4-7-FOCO-INVISIVEL',
    where: {file: 'css/foco.css', line: 8},
    scenario: 'a folha volta a apagar o contorno do foco',
    proof: 'a nova verificacao reproduziu a falha',
    suggestion: 'usar outline de 2px solid #0b57d0',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['teclado'],
    secretPreview: null,
  },
  {
    id: 'ACH-004',
    title: 'alvo possivelmente menor que 24 px',
    severity: 'baixa',
    status: 'provavel',
    verifier: null,
    reference: 'WCAG-2-5-8',
    where: {file: 'html/botao.html', line: null},
    scenario: 'o botao pode ficar abaixo de 24 px na tela estreita',
    proof: '',
    suggestion: 'definir min-height de 24px',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['examinador da tela'],
    secretPreview: null,
  },
  {
    id: 'ACH-005',
    title: 'comentario de estado vazio ja corrigido',
    severity: 'informativa',
    status: 'fechado',
    verifier: {model: 'modelo-c', provider: 'provedor-c'},
    reference: 'ESTADOS-VAZIO-AUSENTE',
    where: {file: 'src/Itens.tsx', line: 3},
    scenario: 'a lista passou a mostrar Nenhum item',
    proof: 'a nova verificacao nao reabriu',
    suggestion: 'manter o marcador data-empty',
    acceptance: DESIGN_ACCEPTANCE,
    sources: ['html'],
    secretPreview: null,
  },
];

const coverage: DesignCoverageRow[] = [
  {
    file: 'html/contraste.html',
    examinerProvider: 'grok',
    examinerModel: 'especialista',
    profileId: profileContraste,
    checklist: ['DESIGN-CONTRASTE', 'WCAG-1-4-3'],
  },
  {
    file: 'html/botao.html',
    examinerProvider: 'claude',
    examinerModel: 'leitor',
    profileId: profileBotao,
    checklist: ['DESIGN-NOME-ACESSIVEL'],
  },
];

const raw = {
  ferramenta: 'axe',
  jaRedatado: preview,
  quase: 'AKIAIOSFODNN7EXAMPL',
  quaseLetras: 'AKIABCDEFGHIJKLMNOP',
  achados: [{regra: 'WCAG-1-4-3-CONTRASTE', trecho: 'contraste 2.1'}],
};

const captures = [{fileName: captureName, bytes: captureBytes}];

function reportInput(dataDirectory: string, overrides: Partial<Parameters<typeof writeDesignReport>[0]> = {}) {
  return {
    dataDirectory,
    projectId,
    runId,
    createdAt,
    commit,
    mapMarkdown,
    coverage,
    achados,
    raw,
    note,
    captures,
    ...overrides,
  };
}

async function withTemp(fn: (data: string) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'design-report-'));
  try {
    await fn(data);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
}

async function withPair(fn: (dirs: {data: string; outside: string}) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'design-report-'));
  const outside = await mkdtemp(join(tmpdir(), 'design-report-out-'));
  try {
    await fn({data, outside});
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}

function refused(code: string) {
  return (error: unknown) => error instanceof Refusal && error.code === code;
}

async function assertPrivateTree(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    assert.equal(info.mode & 0o777, 0o700, path);
    for (const name of await readdir(path)) await assertPrivateTree(join(path, name));
    return;
  }
  assert.equal(info.isFile(), true, path);
  assert.equal(info.mode & 0o777, 0o600, path);
}

async function assertNoExampleKey(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await assertNoExampleKey(join(path, name));
    return;
  }
  const text = await readFile(path);
  assert.equal(text.includes(fullKey), false, path);
  assert.equal(text.includes(letterKey), false, path);
}

test('o relatorio lista o estado vazio sem mexer na nota', async () => {
  await withTemp(async data => {
    const written = await writeDesignReport(reportInput(data, {
      emptyStates: [
        {route: '/itens', status: 'capturado'},
        {route: '/home', status: 'ausente'},
        {route: '/tasks/1', status: 'nao-capturado'},
      ],
    }));
    const readme = await readFile(join(written.directory, 'README.md'), 'utf8');
    assert.match(readme, /\/itens: capturado/);
    assert.match(readme, /\/home: ausente/);
    assert.match(readme, /\/tasks\/1: não capturado/);
    const run = JSON.parse(await readFile(join(written.directory, 'run.json'), 'utf8')) as {note: string};
    assert.equal(run.note, note);
  });
});

test('grava o relatorio privado, a contagem e a leitura', async () => {
  assert.equal(createdAt.toISOString(), '2026-11-16T03:04:05.000Z');
  assert.ok(preview.length <= 80);
  await withTemp(async data => {
    const written = await writeDesignReport(reportInput(data));
    const dataReal = await realpath(data);
    const directoryName = '20261116-030405-design';
    assert.equal(written.directoryName, directoryName);
    assert.match(written.directoryName, /^\d{8}-\d{6}-design$/);
    assert.equal(written.directory, join(dataReal, 'verificacoes', projectId, directoryName));
    await assertPrivateTree(join(dataReal, 'verificacoes'));
    const runStat = await stat(join(written.directory, 'run.json'));
    assert.equal(runStat.isFile(), true);
    assert.equal(runStat.mode & 0o777, 0o600);
    const captureStat = await stat(join(written.directory, 'capturas', captureName));
    assert.equal(captureStat.isFile(), true);
    assert.equal(captureStat.mode & 0o777, 0o600);
    assert.deepEqual(await readFile(join(written.directory, 'capturas', captureName)), captureBytes);
    assert.equal((await stat(join(written.directory, 'capturas'))).mode & 0o777, 0o700);

    const readme = await readFile(join(written.directory, 'README.md'), 'utf8');
    assert.match(readme, /# Relatório de verificação de design/);
    assert.match(readme, /## Resumo/);
    assert.match(readme, /## Nota geral\n\nNão foi possível verificar o tema escuro desta rodada\./);
    assert.match(readme, /## O que não foi possível verificar\n\nNão foi possível verificar o tema escuro desta rodada\./);
    assert.match(readme, /## Imagem de design/);
    assert.match(readme, /não executou o contêiner/);
    assert.match(readme, /65532:65532/);
    assert.match(readme, /design-homologation/);
    assert.match(readme, /--read-only/);
    assert.match(readme, /--cap-drop/);
    assert.match(readme, /no-new-privileges/);
    assert.match(readme, /--network design-homologation/);
    assert.match(readme, /## Estado vazio/);
    assert.match(readme, /Não houve registro de estado vazio: a captura não aconteceu\./);
    assert.match(readme, /A contagem abaixo inclui só achados com situação confirmado ou reaberto\./);
    assert.match(readme, /\| alta \| 1 \|/);
    assert.match(readme, /\| média \| 1 \|/);
    assert.match(readme, /\| baixa \| 0 \|/);
    assert.match(readme, /\| informativa \| 0 \|/);
    assert.match(readme, /Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta\./);
    assert.match(readme, /Há 1 achado descartado\. Essa contagem fica à parte e não entra na nota de falha\./);
    assert.ok(readme.includes(commit));
    assert.ok(readme.includes(runId));

    assert.equal(await readFile(join(written.directory, 'mapa.md'), 'utf8'), mapMarkdown);
    const coverageText = await readFile(join(written.directory, 'cobertura.md'), 'utf8');
    assert.match(coverageText, /\| Arquivo \| Examinador \(provedor\/modelo\) \| Itens da lista \|/);
    for (const row of coverage) {
      const line = coverageText.split('\n').find(item => item.includes(row.file));
      assert.ok(line);
      assert.equal(line.includes(`${row.examinerProvider}/${row.examinerModel}`), true);
      for (const item of row.checklist) assert.equal(line.includes(item), true);
    }

    const achado = await readFile(join(written.directory, 'achados', 'ACH-001.md'), 'utf8');
    assert.match(achado, /^# ACH-001: contraste abaixo de 4\.5\n/);
    assert.match(achado, /^- Gravidade: alta$/m);
    assert.match(achado, /^- Situação: confirmado \(verificador: modelo-revisor, outro\)$/m);
    assert.match(achado, /^- Referência: WCAG-1-4-3-CONTRASTE$/m);
    assert.match(achado, /^- Onde: html\/contraste\.html:4$/m);
    assert.match(achado, /^- Cenário: texto cinza claro sobre fundo branco$/m);
    assert.match(achado, /^- Prova: capturas\/contraste-375-claro-padrao\.png$/m);
    assert.match(achado, /^- Correção sugerida: usar #1b1b1b sobre #ffffff$/m);
    assert.match(achado, new RegExp(`^- Critério de aceite: ${DESIGN_ACCEPTANCE.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(achado, /^- Fontes: axe, examinador da tela$/m);
    assert.equal(achado.includes('sha256'), false);
    const provavel = await readFile(join(written.directory, 'achados', 'ACH-004.md'), 'utf8');
    assert.match(provavel, /^- Gravidade: baixa$/m);
    assert.match(provavel, /^- Situação: provável$/m);
    assert.match(provavel, /^- Onde: html\/botao\.html$/m);
    const reaberto = await readFile(join(written.directory, 'achados', 'ACH-003.md'), 'utf8');
    assert.match(reaberto, /^- Gravidade: média$/m);
    assert.match(reaberto, /^- Situação: reaberto \(verificador: modelo-b, provedor-b\)$/m);

    const storedAchados = JSON.parse(await readFile(join(written.directory, 'achados.json'), 'utf8')) as {achados: DesignAchado[]};
    assert.deepEqual(storedAchados, {achados});
    const storedRaw = await readFile(join(written.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const storedRawBody: unknown = JSON.parse(storedRaw);
    assert.deepEqual(storedRawBody, raw);
    assert.equal(storedRaw.includes(preview), true);
    assert.equal(storedRaw.includes('AKIAIOSFODNN7EXAMPL'), true);
    await assertNoExampleKey(written.directory);

    const summary = DesignReportSummary.parse(JSON.parse(await readFile(join(written.directory, 'run.json'), 'utf8')));
    assert.deepEqual(summary, {
      id: runId,
      directoryName,
      createdAt: '2026-11-16T03:04:05.000Z',
      counts: {alta: 1, media: 1, baixa: 0, informativa: 0},
      note,
    });
    const read = await readDesignReport(data, projectId, runId);
    assert.deepEqual(read.summary, summary);
    assert.deepEqual(read.achados, achados);
    assert.equal(read.coverageMarkdown, coverageText);
    await assert.rejects(readDesignReport(data, projectId, otherRunId), refused('DESIGN_REPORT_NOT_FOUND'));
  });
});

test('descartado nao entra na contagem e a pasta existente e recusada', async () => {
  await withTemp(async data => {
    const discarded = achados.filter(item => item.id === 'ACH-002');
    const first = await writeDesignReport(reportInput(data, {
      runId,
      createdAt,
      achados: discarded,
      coverage: [coverage[0]],
    }));
    const summary = DesignReportSummary.parse(JSON.parse(await readFile(join(first.directory, 'run.json'), 'utf8')));
    assert.deepEqual(summary.counts, {alta: 0, media: 0, baixa: 0, informativa: 0});
    const readme = await readFile(join(first.directory, 'README.md'), 'utf8');
    assert.match(readme, /\| alta \| 0 \|/);
    assert.match(readme, /\| média \| 0 \|/);
    assert.match(readme, /Nota de falha: sem falha confirmada ou reaberta\./);
    assert.match(readme, /Há 1 achado descartado\. Essa contagem fica à parte e não entra na nota de falha\./);
    assert.equal((await readFile(join(first.directory, 'achados', 'ACH-002.md'), 'utf8')).includes('descartado'), true);

    await assert.rejects(writeDesignReport(reportInput(data, {runId: otherRunId, createdAt})), refused('DESIGN_REPORT_EXISTS'));
    const kept = DesignReportSummary.parse(JSON.parse(await readFile(join(first.directory, 'run.json'), 'utf8')));
    assert.equal(kept.id, runId);

    const later = new Date(createdAt.getTime() + 1000);
    const second = await writeDesignReport(reportInput(data, {runId: otherRunId, createdAt: later, achados: discarded}));
    assert.equal(second.directoryName, '20261116-030406-design');
    assert.match(second.directoryName, /^\d{8}-\d{6}-design$/);
    const read = await readDesignReport(data, projectId, otherRunId);
    assert.equal(read.summary.directoryName, '20261116-030406-design');
    assert.equal(read.achados.length, 1);
    assert.deepEqual(read.summary.counts, {alta: 0, media: 0, baixa: 0, informativa: 0});
  });
});

test('recusa segredo AKIA e nao cria arquivo', async () => {
  const leaks: Partial<Parameters<typeof writeDesignReport>[0]>[] = [
    {raw: {saida: `token ${fullKey} encontrado`}},
    {raw: `prefixo ${letterKey} sufixo`},
    {raw: {[fullKey]: 'x'}},
    {mapMarkdown: `mapa ${fullKey}`},
    {note: `nota ${letterKey}`},
    {achados: [{...achados[0], title: `vazou ${letterKey}`}]},
    {captures: [{fileName: captureName, bytes: Buffer.from(`bytes ${fullKey}`)}]},
  ];
  for (const leak of leaks) {
    await withTemp(async data => {
      await assert.rejects(writeDesignReport(reportInput(data, leak)), refused('DESIGN_SECRET_IN_REPORT'));
      assert.deepEqual(await readdir(data), []);
    });
  }
});

test('recusa segmento com ponto duplo, barra ou symlink', async () => {
  await withTemp(async data => {
    for (const project of ['../fora', 'a/b', '..', 'foo..bar']) {
      await assert.rejects(writeDesignReport(reportInput(data, {projectId: project})), refused('DESIGN_PATH_FORBIDDEN'));
      await assert.rejects(readDesignReport(data, project, runId), refused('DESIGN_PATH_FORBIDDEN'));
    }
    await assert.rejects(writeDesignReport(reportInput(data, {runId: `../${runId}`})), refused('DESIGN_PATH_FORBIDDEN'));
    await assert.rejects(readDesignReport(data, projectId, 'a/b'), refused('DESIGN_PATH_FORBIDDEN'));
    await assert.rejects(writeDesignReport(reportInput(data, {captures: [{fileName: '../x.png', bytes: captureBytes}]})), refused('DESIGN_PATH_FORBIDDEN'));
    await assert.rejects(writeDesignReport(reportInput(data, {captures: [{fileName: 'a/b.png', bytes: captureBytes}]})), refused('DESIGN_PATH_FORBIDDEN'));
    await assert.rejects(writeDesignReport(reportInput(data, {captures: [{fileName: 'a..b.png', bytes: captureBytes}]})), refused('DESIGN_PATH_FORBIDDEN'));
    await assert.rejects(writeDesignReport(reportInput(data, {achados: [{...achados[0], id: 'ACH-1'}]})), refused('DESIGN_REPORT_INVALID'));
    assert.deepEqual(await readdir(data), []);
  });

  await withPair(async ({data, outside}) => {
    await symlink(outside, join(data, 'verificacoes'));
    await assert.rejects(writeDesignReport(reportInput(data)), refused('DESIGN_PATH_FORBIDDEN'));
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await lstat(join(data, 'verificacoes'))).isSymbolicLink(), true);
  });

  await withPair(async ({data, outside}) => {
    await mkdir(join(data, 'verificacoes'), {mode: 0o700});
    await symlink(outside, join(data, 'verificacoes', projectId));
    await assert.rejects(writeDesignReport(reportInput(data)), refused('DESIGN_PATH_FORBIDDEN'));
    assert.equal((await lstat(join(data, 'verificacoes', projectId))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(outside), []);
  });

  await withPair(async ({data, outside}) => {
    await mkdir(join(data, 'verificacoes', projectId), {recursive: true, mode: 0o700});
    await symlink(outside, join(data, 'verificacoes', projectId, '20261116-030405-design'));
    await assert.rejects(writeDesignReport(reportInput(data)), refused('DESIGN_PATH_FORBIDDEN'));
    assert.deepEqual(await readdir(outside), []);
  });

  await withPair(async ({data, outside}) => {
    const written = await writeDesignReport(reportInput(data));
    const hidden = join(outside, 'escondido.txt');
    await writeFile(hidden, 'NAO-LER', {mode: 0o600});
    const coveragePath = join(written.directory, 'cobertura.md');
    await rm(coveragePath);
    await symlink(hidden, coveragePath);
    await assert.rejects(readDesignReport(data, projectId, runId), refused('DESIGN_PATH_FORBIDDEN'));
    assert.equal(await readFile(hidden, 'utf8'), 'NAO-LER');
  });
});

function limitArgs(memoryBytes: number, nanoCpus: number, pidsLimit: number): readonly string[] | null {
  try {
    return designRunArguments({
      image: DESIGN_IMAGE,
      repository: '/var/lib/design/repo',
      output: '/var/lib/design/out',
      targetUrl: 'http://127.0.0.1:9/',
      memoryBytes,
      nanoCpus,
      pidsLimit,
    });
  } catch (error) {
    assert.equal(error instanceof Refusal && error.code === 'DESIGN_LIMITS_INVALID', true);
    return null;
  }
}

function flag(args: readonly string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  assert.equal(typeof value, 'string');
  return value;
}

test('registra usuário, limites e rede da imagem sem afirmar execução', async () => {
  await withTemp(async data => {
    const written = await writeDesignReport(reportInput(data));
    const readme = await readFile(join(written.directory, 'README.md'), 'utf8');
    const proof = readme.match(/O usuário da imagem é (\S+) e não é root\. Os limites são memória de (\d+) a (\d+) bytes, pids de (\d+) a (\d+) e CPU de (\S+) a (\S+)\. A única rede é (\S+)\./);
    assert.ok(proof);
    const [, user, memoryMin, memoryMax, pidsMin, pidsMax, cpuMin, cpuMax, network] = proof;
    assert.equal(user, DESIGN_USER);
    assert.equal(user.split(':').some(part => part === '0' || part.toLowerCase() === 'root'), false);
    assert.equal(network, DESIGN_NETWORK);
    assert.match(readme, /## Estado vazio/);
    assert.match(readme, /Não houve registro de estado vazio: a captura não aconteceu\./);
    assert.equal(readme.includes('capturado'), false);
    assert.equal(readme.includes('não deu'), false);
    assert.match(readme, /não executou o contêiner/);
    assert.match(readme, /docker run --rm --network design-homologation/);
    assert.doesNotMatch(readme, /o contêiner (?:foi|executou)|foi executad/i);

    let nano = 1;
    let seed: readonly string[] | null = null;
    while (nano <= Number.MAX_SAFE_INTEGER / 2) {
      seed = limitArgs(Number(memoryMin), nano, Number(pidsMin));
      if (seed) break;
      nano *= 2;
    }
    assert.ok(seed);
    assert.equal(limitArgs(Number(memoryMin) - 1, nano, Number(pidsMin)), null);
    assert.ok(limitArgs(Number(memoryMax), nano, Number(pidsMin)));
    assert.equal(limitArgs(Number(memoryMax) + 1, nano, Number(pidsMin)), null);
    assert.equal(limitArgs(Number(memoryMin), nano, Number(pidsMin) - 1), null);
    assert.ok(limitArgs(Number(memoryMin), nano, Number(pidsMax)));
    assert.equal(limitArgs(Number(memoryMin), nano, Number(pidsMax) + 1), null);
    assert.equal(flag(seed, '--user'), DESIGN_USER);
    assert.equal(flag(seed, '--network'), DESIGN_NETWORK);
    assert.equal(seed.filter(item => item === '--network').length, 1);
    assert.equal(flag(seed, '--memory'), memoryMin);
    assert.equal(flag(seed, '--pids-limit'), pidsMin);
    assert.throws(
      () => designRunArguments({
        image: DESIGN_IMAGE,
        repository: '/var/lib/design/repo',
        output: '/var/lib/design/out',
        targetUrl: 'http://127.0.0.1:9/',
        memoryBytes: Number(memoryMin),
        nanoCpus: nano,
        pidsLimit: Number(pidsMin),
        network: `${DESIGN_NETWORK}-extra`,
      }),
      refused('DESIGN_NETWORK_FORBIDDEN'),
    );

    const cpuOk = (value: number) => limitArgs(Number(memoryMin), value, Number(pidsMin)) !== null;
    let cpuLo = 0;
    let cpuHi = nano;
    while (cpuHi - cpuLo > 1) {
      const mid = cpuLo + Math.floor((cpuHi - cpuLo) / 2);
      if (cpuOk(mid)) cpuHi = mid;
      else cpuLo = mid;
    }
    const lowCpu = limitArgs(Number(memoryMin), cpuHi, Number(pidsMin));
    assert.ok(lowCpu);
    assert.equal(flag(lowCpu, '--cpus'), cpuMin);
    let cpuTop = Number.MAX_SAFE_INTEGER;
    cpuLo = nano;
    while (cpuTop - cpuLo > 1) {
      const mid = cpuLo + Math.floor((cpuTop - cpuLo) / 2);
      if (cpuOk(mid)) cpuLo = mid;
      else cpuTop = mid;
    }
    const highCpu = limitArgs(Number(memoryMin), cpuLo, Number(pidsMax));
    assert.ok(highCpu);
    assert.equal(flag(highCpu, '--cpus'), cpuMax);

    const summary = DesignReportSummary.parse(JSON.parse(await readFile(join(written.directory, 'run.json'), 'utf8')));
    assert.equal(summary.note, note);

    const captured = await writeDesignReport(reportInput(data, {
      runId: otherRunId,
      createdAt: new Date(createdAt.getTime() + 1000),
      emptyState: 'capturado',
    }));
    const capturedText = await readFile(join(captured.directory, 'README.md'), 'utf8');
    assert.match(capturedText, /## Estado vazio\n\ncapturado\n/);
    assert.match(capturedText, new RegExp(`O usuário da imagem é ${DESIGN_USER} e não é root`));
    assert.equal(capturedText.includes('não deu'), false);

    const missed = await writeDesignReport(reportInput(data, {
      runId: '66666666-6666-4666-8666-666666666666',
      createdAt: new Date(createdAt.getTime() + 2000),
      emptyState: 'não deu',
    }));
    const missedText = await readFile(join(missed.directory, 'README.md'), 'utf8');
    assert.match(missedText, /## Estado vazio\n\nnão deu\n/);
    assert.equal(missedText.includes('capturado'), false);
  });

  await withTemp(async data => {
    const invalid = reportInput(data);
    await assert.rejects(
      writeDesignReport({...invalid, emptyState: 'talvez'} as unknown as Parameters<typeof writeDesignReport>[0]),
      refused('DESIGN_REPORT_INVALID'),
    );
    assert.deepEqual(await readdir(data), []);
  });
});
