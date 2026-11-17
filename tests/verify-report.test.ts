import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {listSecurityReports, readAchadoMarkdown, readSecurityReport, writeSecurityReport} from '../src/verify-report.ts';
import {Achado, CoverageRow, ReportSummary} from '../src/verify-types.ts';

const previousUmask = process.umask(0o022);
after(() => {
  process.umask(previousUmask);
});

const projectId = '11111111-1111-4111-8111-111111111111';
const runId = '33333333-3333-4333-8333-333333333333';
const otherRunId = '55555555-5555-4555-8555-555555555555';
const createdAt = new Date(Date.UTC(2026, 10, 16, 3, 4, 5));
const commit = '0123456789abcdef0123456789abcdef01234567';
const note = 'Não foi possível verificar o módulo nativo fechado.';
const mapMarkdown = '# Mapa\n\n- Rota: POST /pedidos\n';
const preview = `AKIA\u2026 (sha256:${'ab'.repeat(32)})`;
const profilePedidos = randomUUID();
const profilePainel = randomUUID();

const achados: Achado[] = [
  {
    id: 'ACH-001',
    title: 'rota de pedidos aceita projeto de outro dono',
    severity: 'alta',
    status: 'confirmado',
    verifier: {model: 'modelo-revisor', provider: 'outro'},
    reference: 'OWASP ASVS 5.0 V8 (autorização), CWE-862',
    where: {file: 'src/rotas/pedidos.ts', line: 120},
    scenario: 'quem tem sessão no projeto A envia POST /pedidos com o id do projeto B e cria um pedido em B',
    proof: 'teste tests/seguranca/ach-001.test.ts (falha hoje)',
    suggestion: 'conferir o dono do projeto antes de criar o pedido',
    acceptance: 'o teste passa; a nova verificação não reabre',
    sources: ['regra opengrep X', 'examinador da fatia 3'],
    secretPreview: preview,
  },
  {
    id: 'ACH-002',
    title: 'alerta de segredo que é exemplo de documentação',
    severity: 'alta',
    status: 'descartado',
    verifier: {model: 'modelo-revisor', provider: 'outro'},
    reference: 'CWE-798',
    where: {file: 'src/rotas/pedidos.ts', line: 40},
    scenario: 'a ferramenta marcou um literal que não é credencial de produção',
    proof: 'o verificador não reproduziu a falha',
    suggestion: 'não abrir correção',
    acceptance: 'o achado permanece descartado',
    sources: ['regra gitleaks exemplo'],
    secretPreview: null,
  },
  {
    id: 'ACH-003',
    title: 'consulta sem limite voltou depois da correção',
    severity: 'media',
    status: 'reaberto',
    verifier: {model: 'modelo-b', provider: 'provedor-b'},
    reference: 'CWE-770',
    where: {file: 'src/painel.tsx', line: 8},
    scenario: 'a listagem volta a carregar a tabela inteira',
    proof: 'a nova verificação reproduziu a falha',
    suggestion: 'repor o limite da consulta',
    acceptance: 'o teste passa; a nova verificação não reabre',
    sources: ['examinador da fatia 1'],
    secretPreview: null,
  },
  {
    id: 'ACH-004',
    title: 'cabeçalho de cache possivelmente ausente',
    severity: 'baixa',
    status: 'provavel',
    verifier: null,
    reference: 'OWASP ASVS 5.0 V14',
    where: {file: 'src/sem-linha.ts', line: null},
    scenario: 'a resposta pode ser reutilizada por outro usuário',
    proof: '',
    suggestion: 'definir o cabeçalho de cache como privado',
    acceptance: 'o teste passa; a nova verificação não reabre',
    sources: ['examinador da fatia 2'],
    secretPreview: null,
  },
  {
    id: 'ACH-005',
    title: 'comentário interno já corrigido',
    severity: 'informativa',
    status: 'fechado',
    verifier: {model: 'modelo-c', provider: 'provedor-c'},
    reference: 'CWE-1188',
    where: {file: 'src/painel.tsx', line: 2},
    scenario: 'o comentário antigo descrevia um fluxo que não existe mais',
    proof: 'a nova verificação não reabriu',
    suggestion: 'manter o teste de regressão',
    acceptance: 'o teste passa; a nova verificação não reabre',
    sources: ['re verificação'],
    secretPreview: null,
  },
];

const coverage: CoverageRow[] = [
  {
    file: 'src/rotas/pedidos.ts',
    examinerProvider: 'grok',
    examinerModel: 'especialista',
    profileId: profilePedidos,
    checklist: ['ASVS-V8', 'CWE-862'],
  },
  {
    file: 'src/painel.tsx',
    examinerProvider: 'claude',
    examinerModel: 'leitor',
    profileId: profilePainel,
    checklist: ['ASVS-V14'],
  },
];

const raw = {
  ferramenta: 'opengrep',
  jaRedatado: preview,
  quase: 'AKIAIOSFODNN7EXAMPL',
  achados: [{regra: 'regra-x', trecho: 'comparação de dono ausente'}],
};

function reportInput(dataDirectory: string, overrides: Partial<Parameters<typeof writeSecurityReport>[0]> = {}) {
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
    ...overrides,
  };
}

async function withTemp(fn: (data: string) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'verify-report-'));
  try {
    await fn(data);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
}

async function withPair(fn: (dirs: {data: string; outside: string}) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'verify-report-'));
  const outside = await mkdtemp(join(tmpdir(), 'verify-report-out-'));
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
  const text = await readFile(path, 'utf8');
  assert.equal(text.includes('AKIAIOSFODNN7EXAMPLE'), false, path);
}

test('grava o relatório privado, a nota de falha e a leitura', async () => {
  assert.equal(createdAt.toISOString(), '2026-11-16T03:04:05.000Z');
  await withTemp(async data => {
    assert.deepEqual(await listSecurityReports(data, projectId), []);
    const written = await writeSecurityReport(reportInput(data));
    const dataReal = await realpath(data);
    const directoryName = '20261116-030405-seguranca';
    assert.equal(written.directoryName, directoryName);
    assert.equal(written.directory, join(dataReal, 'verificacoes', projectId, directoryName));
    assert.match(written.directoryName, /^\d{8}-\d{6}-seguranca$/);
    await assertPrivateTree(join(dataReal, 'verificacoes'));
    const runStat = await stat(join(written.directory, 'run.json'));
    assert.equal(runStat.isFile(), true);
    assert.equal(runStat.mode & 0o777, 0o600);

    const readme = await readFile(join(written.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Resumo/);
    assert.match(readme, /## Nota geral\n\nNão foi possível verificar o módulo nativo fechado\./);
    assert.match(readme, /## O que não foi possível verificar\n\nNão foi possível verificar o módulo nativo fechado\./);
    assert.match(readme, /A contagem abaixo inclui só achados com situação confirmado ou reaberto\./);
    assert.match(readme, /\| alta \| 1 \|/);
    assert.match(readme, /\| média \| 1 \|/);
    assert.match(readme, /\| baixa \| 0 \|/);
    assert.match(readme, /\| informativa \| 0 \|/);
    assert.match(readme, /Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta\./);
    assert.match(readme, /Achados descartados não entram na nota de falha\./);
    assert.match(readme, /Há 1 achado descartado\. Essa contagem fica à parte e não entra na nota de falha\./);
    assert.ok(readme.includes(commit));
    assert.ok(readme.includes(runId));

    assert.equal(await readFile(join(written.directory, 'mapa.md'), 'utf8'), mapMarkdown);
    const coverageText = await readFile(join(written.directory, 'cobertura.md'), 'utf8');
    assert.match(coverageText, /\| Arquivo \| Examinador \(provedor\/modelo\) \| Itens da lista \|/);
    for (const row of coverage) {
      assert.equal(coverageText.includes(row.file), true, row.file);
      const line = coverageText.split('\n').find(item => item.includes(row.file));
      assert.ok(line);
      assert.equal(line.includes(`${row.examinerProvider}/${row.examinerModel}`), true);
      for (const item of row.checklist) assert.equal(line.includes(item), true);
    }

    const achado = await readFile(join(written.directory, 'achados', 'ACH-001.md'), 'utf8');
    assert.match(achado, /^# ACH-001: rota de pedidos aceita projeto de outro dono\n/);
    assert.match(achado, /^- Gravidade: alta$/m);
    assert.match(achado, /^- Situação: confirmado \(verificador: modelo-revisor, outro\)$/m);
    assert.match(achado, /^- Referência: OWASP ASVS 5\.0 V8 \(autorização\), CWE-862$/m);
    assert.match(achado, /^- Onde: src\/rotas\/pedidos\.ts:120$/m);
    assert.match(achado, /^- Cenário: quem tem sessão no projeto A envia POST \/pedidos com o id do projeto B e cria um pedido em B$/m);
    assert.match(achado, /^- Prova: teste tests\/seguranca\/ach-001\.test\.ts \(falha hoje\)$/m);
    assert.match(achado, /^- Correção sugerida: conferir o dono do projeto antes de criar o pedido$/m);
    assert.match(achado, /^- Critério de aceite: o teste passa; a nova verificação não reabre$/m);
    assert.match(achado, /^- Fontes: regra opengrep X, examinador da fatia 3$/m);
    const provavel = await readFile(join(written.directory, 'achados', 'ACH-004.md'), 'utf8');
    assert.match(provavel, /^- Gravidade: baixa$/m);
    assert.match(provavel, /^- Situação: provável$/m);
    assert.match(provavel, /^- Onde: src\/sem-linha\.ts$/m);
    const reaberto = await readFile(join(written.directory, 'achados', 'ACH-003.md'), 'utf8');
    assert.match(reaberto, /^- Gravidade: média$/m);
    assert.match(reaberto, /^- Situação: reaberto \(verificador: modelo-b, provedor-b\)$/m);

    const storedAchados = JSON.parse(await readFile(join(written.directory, 'achados.json'), 'utf8')) as {achados: Achado[]};
    assert.deepEqual(storedAchados, {achados});
    const storedRaw = await readFile(join(written.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    assert.deepEqual(JSON.parse(storedRaw), raw);
    assert.equal(storedRaw.includes(preview), true);
    assert.equal(storedRaw.includes('AKIAIOSFODNN7EXAMPL'), true);
    await assertNoExampleKey(written.directory);

    const summary = ReportSummary.parse(JSON.parse(await readFile(join(written.directory, 'run.json'), 'utf8')));
    assert.deepEqual(summary, {
      id: runId,
      directoryName,
      createdAt: '2026-11-16T03:04:05.000Z',
      counts: {alta: 1, media: 1, baixa: 0, informativa: 0},
      note,
    });
    assert.deepEqual(await listSecurityReports(data, projectId), [summary]);
    const read = await readSecurityReport(data, projectId, runId);
    assert.deepEqual(read.summary, summary);
    assert.deepEqual(read.achados, achados);
    assert.equal(read.coverageMarkdown, coverageText);
    assert.equal(await readAchadoMarkdown(data, projectId, runId, 'ACH-001'), achado);
    await assert.rejects(readSecurityReport(data, projectId, otherRunId), refused('VERIFY_REPORT_NOT_FOUND'));
    await assert.rejects(readAchadoMarkdown(data, projectId, runId, 'ACH-099'), refused('VERIFY_ACHADO_NOT_FOUND'));
  });
});

test('descartado não entra na nota de falha e o mesmo segundo não ganha sufixo', async () => {
  await withTemp(async data => {
    const discarded = achados.filter(item => item.id === 'ACH-002');
    const first = await writeSecurityReport(reportInput(data, {
      runId,
      createdAt,
      achados: discarded,
      coverage: [coverage[0]],
    }));
    const summary = ReportSummary.parse(JSON.parse(await readFile(join(first.directory, 'run.json'), 'utf8')));
    assert.deepEqual(summary.counts, {alta: 0, media: 0, baixa: 0, informativa: 0});
    const readme = await readFile(join(first.directory, 'README.md'), 'utf8');
    assert.match(readme, /\| alta \| 0 \|/);
    assert.match(readme, /Nota de falha: sem falha confirmada ou reaberta\./);
    assert.match(readme, /Há 1 achado descartado\. Essa contagem fica à parte e não entra na nota de falha\./);
    assert.equal(await readFile(join(first.directory, 'achados', 'ACH-002.md'), 'utf8').then(text => text.includes('descartado')), true);

    await assert.rejects(writeSecurityReport(reportInput(data, {runId: otherRunId, createdAt})), refused('VERIFY_REPORT_EXISTS'));
    assert.deepEqual(await listSecurityReports(data, projectId), [summary]);
    assert.equal(await readFile(join(first.directory, 'run.json'), 'utf8').then(text => JSON.parse(text).id), runId);

    const later = new Date(createdAt.getTime() + 1000);
    const second = await writeSecurityReport(reportInput(data, {runId: otherRunId, createdAt: later, achados: discarded}));
    assert.equal(second.directoryName, '20261116-030406-seguranca');
    assert.match(second.directoryName, /^\d{8}-\d{6}-seguranca$/);
    const listed = await listSecurityReports(data, projectId);
    assert.deepEqual(listed.map(item => item.id), [runId, otherRunId]);
    assert.deepEqual(listed.map(item => item.directoryName), ['20261116-030405-seguranca', '20261116-030406-seguranca']);
    const read = await readSecurityReport(data, projectId, otherRunId);
    assert.equal(read.summary.directoryName, '20261116-030406-seguranca');
    assert.equal(read.achados.length, 1);
  });
});

test('recusa raw com chave AKIA e não cria arquivo', async () => {
  const leaks = [
    {saida: 'token AKIAIOSFODNN7EXAMPLE encontrado'},
    'prefixo AKIAIOSFODNN7EXAMPLE sufixo',
    {AKIAIOSFODNN7EXAMPLE: 'x'},
  ];
  for (const leak of leaks) {
    await withTemp(async data => {
      await assert.rejects(writeSecurityReport(reportInput(data, {raw: leak})), refused('VERIFY_SECRET_IN_REPORT'));
      assert.deepEqual(await readdir(data), []);
      await assert.rejects(stat(join(data, 'verificacoes', projectId, '20261116-030405-seguranca', 'bruto', 'achados-brutos.json')));
    });
  }
});

test('recusa caminho que escapa de verificacoes', async () => {
  await withTemp(async data => {
    for (const project of ['../fora', 'a/b', '..', 'foo..bar']) {
      await assert.rejects(writeSecurityReport(reportInput(data, {projectId: project})), refused('VERIFY_PATH_FORBIDDEN'));
      await assert.rejects(listSecurityReports(data, project), refused('VERIFY_PATH_FORBIDDEN'));
      await assert.rejects(readSecurityReport(data, project, runId), refused('VERIFY_PATH_FORBIDDEN'));
    }
    await assert.rejects(writeSecurityReport(reportInput(data, {runId: '../33333333-3333-4333-8333-333333333333'})), refused('VERIFY_PATH_FORBIDDEN'));
    await assert.rejects(readSecurityReport(data, projectId, 'a/b'), refused('VERIFY_PATH_FORBIDDEN'));
    await assert.rejects(readAchadoMarkdown(data, projectId, runId, '../ACH-001'), refused('VERIFY_PATH_FORBIDDEN'));
    await assert.rejects(readAchadoMarkdown(data, projectId, runId, 'ACH-001/../../etc/passwd'), refused('VERIFY_PATH_FORBIDDEN'));
    assert.deepEqual(await readdir(data), []);
  });

  await withPair(async ({data, outside}) => {
    await symlink(outside, join(data, 'verificacoes'));
    await assert.rejects(writeSecurityReport(reportInput(data)), refused('VERIFY_PATH_FORBIDDEN'));
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await lstat(join(data, 'verificacoes'))).isSymbolicLink(), true);
  });

  await withPair(async ({data, outside}) => {
    const before = await readdir(outside);
    await mkdir(join(outside, '20261116-030405-seguranca'), {mode: 0o700});
    await writeFile(join(outside, '20261116-030405-seguranca', 'run.json'), `${JSON.stringify({
      id: runId,
      directoryName: '20261116-030405-seguranca',
      createdAt: createdAt.toISOString(),
      counts: {alta: 9, media: 0, baixa: 0, informativa: 0},
      note: 'vazou',
    })}\n`, {mode: 0o600});
    await mkdir(join(data, 'verificacoes'), {mode: 0o700});
    await symlink(outside, join(data, 'verificacoes', projectId));
    await assert.rejects(writeSecurityReport(reportInput(data)), refused('VERIFY_PATH_FORBIDDEN'));
    await assert.rejects(listSecurityReports(data, projectId), refused('VERIFY_PATH_FORBIDDEN'));
    await assert.rejects(readSecurityReport(data, projectId, runId), refused('VERIFY_PATH_FORBIDDEN'));
    assert.equal((await lstat(join(data, 'verificacoes', projectId))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(outside), [...before, '20261116-030405-seguranca']);
  });

  await withPair(async ({data, outside}) => {
    const written = await writeSecurityReport(reportInput(data));
    const secretFile = join(outside, 'segredo.txt');
    await writeFile(secretFile, 'NAO-LER', {mode: 0o600});
    const achadoPath = join(written.directory, 'achados', 'ACH-004.md');
    await rm(achadoPath);
    await symlink(secretFile, achadoPath);
    await assert.rejects(readAchadoMarkdown(data, projectId, runId, 'ACH-004'), refused('VERIFY_PATH_FORBIDDEN'));
    assert.equal(await readFile(secretFile, 'utf8'), 'NAO-LER');
  });
});
