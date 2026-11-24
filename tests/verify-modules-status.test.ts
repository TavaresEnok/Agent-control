import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import {Ledger, VERIFICATION_MODULES} from '../src/ledger.ts';
import {readModuleStatuses, type ModuleStatusInput} from '../src/verify-modules-status.ts';
import {writeModuleReport} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const primaryProjectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000001';
const url = '/api/v1/ac/personal/verificacoes-modulos';
const headers = {authorization: 'Bearer owner'};
const ORDER = ['seguranca', 'qa', 'arquitetura', 'dependencias', 'banco', 'prontidao', 'desempenho', 'documentacao', 'conformidade', 'design'];

type Row = {id: string; module: string; status?: string; created_at: Date | string; alive?: boolean};
type Seen = {running: unknown[][]; published?: number};

function fakeLedger(running: Row[], seen?: Seen) {
  return {pool: {query: async (sql: string, params?: unknown[]) => {
    if (sql.includes('ac_managers')) {
      seen?.running.push(params ?? []);
      return {rowCount: running.length, rows: running.map(row => ({status: 'running', alive: true, ...row}))};
    }
    throw new Error('consulta inesperada: ' + sql);
  }}} as unknown as Ledger;
}

function api(root: string, options: {owner?: boolean; selected?: string; role?: string; running?: Row[]; panel?: boolean; seen?: Seen} = {}) {
  const {owner = true, selected = primaryProjectId, role, running = [], panel = true, seen} = options;
  const ledger = {pool: {query: async (sql: string, params?: unknown[]) => {
    if (sql.includes("role='owner'")) return {rowCount: !panel || owner && params?.[0] === primaryProjectId ? 1 : 0, rows: []};
    if (sql.includes('ac_memberships')) return {rowCount: role ? 1 : 0, rows: role ? [{role}] : []};
    if (sql.includes('JOIN ac_exam_contexts')) { // nenhum relatório de módulo publicado
      if (seen) seen.published = (seen.published ?? 0) + 1;
      return {rowCount: 0, rows: []};
    }
    return fakeLedger(running, seen).pool.query(sql, params);
  }}} as unknown as Ledger;
  return createApi(ledger, {projectId: selected, nativeExecutionReady: false} as CezarRuntime, async request => request.headers.get('authorization') === 'Bearer owner' ? 'owner' : null, () => undefined, {
    configurationControl: {ledger} as Control,
    ...(panel ? {personalPanel: {roots: [], projectRepos: [], installationPath: root, dataDirectory: root, projectId: primaryProjectId, scheduleRestart() {}}} : {}),
  });
}

async function projectDirectory(root: string, projectId = primaryProjectId) {
  const directory = join(root, 'verificacoes', projectId);
  await mkdir(join(directory, 'andamento'), {recursive: true});
  for (const path of [join(root, 'verificacoes'), directory, join(directory, 'andamento')]) await chmod(path, 0o700);
  return directory;
}

async function progress(directory: string, id: string, state: Record<string, unknown> | string) {
  await writeFile(join(directory, 'andamento', `${id}.json`), typeof state === 'string' ? state : JSON.stringify({id, ...state}), {mode: 0o600});
}

type StatusBody = {modulos: Record<string, any>[]};
const byModule = (body: StatusBody) => Object.fromEntries(body.modulos.map(item => [item.modulo, item]));

test('rota de módulos: autenticação, dono, projeto e só leitura', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-auth-')));
  try {
    assert.equal((await api(root).request(url)).status, 401);
    assert.equal((await api(root, {owner: false}).request(url, {headers})).status, 403);
    assert.equal((await api(root, {panel: false}).request(url, {headers})).status, 404);
    // projeto escolhido diferente do primário: exige papel no projeto
    assert.equal((await api(root, {selected: otherProjectId}).request(url, {headers})).status, 403);
    const member = await api(root, {selected: otherProjectId, role: 'viewer'}).request(url, {headers});
    assert.equal(member.status, 200);
    assert.equal(member.headers.get('cache-control'), 'no-store');
    // só GET está registrado para o caminho
    const app = api(root) as unknown as {routes: {method: string; path: string}[]};
    assert.deepEqual([...new Set(app.routes.filter(route => route.path === url).map(route => route.method))], ['GET']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: sem dados devolve os dez módulos vazios, em ordem, com o design sem andamento ao vivo', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-empty-')));
  try {
    const response = await api(root).request(url, {headers});
    assert.equal(response.status, 200);
    const body = await response.json() as StatusBody;
    assert.deepEqual(body.modulos.map(item => item.modulo), ORDER);
    assert.ok(body.modulos.every(item => item.atual === null && item.ultima === null));
    assert.deepEqual(body.modulos.filter(item => !item.andamentoDisponivel).map(item => item.modulo), ['design']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: andamento ausente, corrompido ou inválido não derruba a resposta', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-broken-')));
  try {
    const directory = await projectDirectory(root);
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000001', '{"id": "corrompido"');
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000002', {status: 'running', phase: 'exame'}); // sem startedAt
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000003', {status: 'running', phase: 'exame', startedAt: '2026-11-24T10:00:00.000Z', judged: 9, total: 3});
    const response = await api(root).request(url, {headers});
    assert.equal(response.status, 200);
    const {seguranca} = byModule(await response.json() as StatusBody);
    assert.equal(seguranca.atual.runId, 'bbbbbbbb-0000-4000-8000-000000000003');
    assert.equal(seguranca.atual.judged, null, 'julgados maior que o total é descartado');
    assert.equal(seguranca.atual.total, null);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: a segurança segue o projeto das rotas de segurança, o resto segue o do gateway', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-project-')));
  try {
    const directory = await projectDirectory(root, primaryProjectId);
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await progress(directory, 'cccccccc-0000-4000-8000-000000000001', {status: 'running', phase: 'mapa', startedAt, judged: 1, total: 4});
    const seen: Seen = {running: []};
    const running = [{id: '11111111-0000-4000-8000-000000000001', module: 'banco', created_at: new Date(Date.now() - 1_000)}];
    const response = await api(root, {selected: otherProjectId, role: 'viewer', running, seen}).request(url, {headers});
    assert.equal(response.status, 200);
    const body = byModule(await response.json() as StatusBody);
    assert.equal(body.seguranca.atual.phase, 'mapa', 'o andamento vem do projeto primário');
    assert.equal(body.banco.atual.runId, running[0]!.id);
    assert.equal(seen.running[0]![0], otherProjectId, 'módulos: projeto do gateway');
    assert.equal(seen.running[0]![2], primaryProjectId, 'segurança: projeto do painel');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: a lista de relatórios publicados é reaproveitada por um tempo, o andamento não', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-cache-')));
  try {
    const seen: Seen = {running: []};
    const app = api(root, {seen});
    for (let index = 0; index < 3; index += 1) assert.equal((await app.request(url, {headers})).status, 200);
    assert.equal(seen.published, 1);
    assert.equal(seen.running.length, 3);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: verificacoes do projeto como symlink é recusado', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-link-')));
  try {
    const outside = join(root, 'fora');
    await mkdir(outside);
    await mkdir(join(root, 'verificacoes'), {mode: 0o700});
    await symlink(outside, join(root, 'verificacoes', primaryProjectId));
    const response = await api(root).request(url, {headers});
    assert.equal(response.status, 403);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('estado: arquivo de andamento só vale com o gerente vivo e a linha ainda em execução', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-alive-')));
  try {
    const directory = await projectDirectory(root);
    const id = 'dddddddd-0000-4000-8000-000000000001';
    await progress(directory, id, {status: 'running', phase: 'exame', startedAt: new Date(Date.now() - 60_000).toISOString(), judged: 2, total: 5, modelCalls: 3});
    const input: ModuleStatusInput = {dataDirectory: root, projectId: primaryProjectId, securityProjectId: primaryProjectId, security: [], modules: [], design: []};
    const seguranca = async (rows: Row[]) => (await readModuleStatuses(fakeLedger(rows), input)).find(item => item.modulo === 'seguranca')!;
    const created_at = new Date();
    // ainda sem linha no banco (fase de ferramentas): vale
    assert.equal((await seguranca([])).atual?.judged, 2);
    // linha em execução com gerente vivo: vale
    assert.equal((await seguranca([{id, module: 'verify', created_at}])).atual?.total, 5);
    // gerente sem licença ou linha já encerrada por outro processo: não vale
    assert.equal((await seguranca([{id, module: 'verify', created_at, alive: false}])).atual, null);
    assert.equal((await seguranca([{id, module: 'verify', status: 'failed', created_at}])).atual, null);
    // módulos 2 a 9: linha running sem gerente vivo não conta
    const modulos = await readModuleStatuses(fakeLedger([
      {id: randomUUID(), module: 'qa', created_at, alive: false}, {id: randomUUID(), module: 'banco', created_at},
    ]), input);
    assert.equal(modulos.find(item => item.modulo === 'qa')!.atual, null);
    assert.ok(modulos.find(item => item.modulo === 'banco')!.atual);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('estado: o relatório mais novo de cada módulo e a situação', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-last-')));
  try {
    const counts = {alta: 1, media: 2, baixa: 3, informativa: 4};
    const base = {createdAt: '2026-11-24T10:00:00.000Z', counts, note: ''};
    const module = (name: string, directoryName: string, toolFailures: number) => ({
      ...base, id: randomUUID(), module: name, directoryName, commit: 'a'.repeat(40), toolFailures,
    }) as unknown as ModuleStatusInput['modules'][number];
    const input: ModuleStatusInput = {
      dataDirectory: root, projectId: primaryProjectId, securityProjectId: primaryProjectId,
      security: [
        {...base, id: 'old', directoryName: '20261122-000000-seguranca'},
        {...base, id: 'new', directoryName: '20261124-203731-c3403b26-seguranca', tools: {limpa: 3, achado: 4, indisponivel: 1, truncada: 2}},
      ] as unknown as ModuleStatusInput['security'],
      modules: [
        module('qa', '20261123-004136-82fc0ebbbb7844c8b28d3c9bdb2c72e0-qa', 0),
        module('qa', '20261120-004136-82fc0ebbbb7844c8b28d3c9bdb2c72e0-qa', 9),
        module('arquitetura', '20261123-093302-5a90818824f74aaeb9e3f94035bf68cb-arquitetura', 2),
      ],
      design: [{...base, id: 'design', directoryName: '20261124-025251-design'}] as unknown as ModuleStatusInput['design'],
    };
    const by = Object.fromEntries((await readModuleStatuses(fakeLedger([]), input)).map(item => [item.modulo, item]));
    assert.equal(by.seguranca!.ultima?.runId, 'new');
    assert.equal(by.seguranca!.ultima?.toolFailures, 3);
    assert.equal(by.seguranca!.ultima?.situacao, 'com-falhas');
    assert.equal(by.qa!.ultima?.toolFailures, 0);
    assert.equal(by.qa!.ultima?.situacao, 'concluida');
    assert.equal(by.arquitetura!.ultima?.situacao, 'com-falhas');
    assert.equal(by.design!.ultima?.directoryName, '20261124-025251-design');
    assert.equal(by.design!.andamentoDisponivel, false);
    assert.equal(by.banco!.ultima, null);
    const partial = await readModuleStatuses(fakeLedger([]), {...input, security: [{...input.security[1]!, partial: true}]});
    assert.equal(partial[0]!.ultima?.situacao, 'parcial');
  } finally { await rm(root, {recursive: true, force: true}); }
});

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
test('rota de módulos: relatório preparado e não publicado não aparece como último concluído', {
  skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset',
}, async () => {
  const fixture = await isolatedDatabase(databaseUrl!, 'panelstatus');
  const ledger = new Ledger(fixture.url);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-published-')));
  const dataDirectory = join(root, 'data');
  const owner = 'synthetic-installation-owner';
  const commit = 'a'.repeat(40);
  const toolCoverage = [{tool: 'fixture', version: '1', status: 'ok' as const, detail: 'Medição sintética.'}];
  const report = (module: typeof VERIFICATION_MODULES[number], runId: string, createdAt: string) => writeModuleReport({
    dataDirectory, projectId: primaryProjectId, module, runId, createdAt: new Date(createdAt), commit, toolCoverage,
    fileCoverage: [{file: 'src/a.ts', examinerProvider: 'ferramenta', examinerModel: 'fixture', profileId: null, checklist: ['FIXTURE']}],
    achados: [], raw: {coverage: toolCoverage, findings: []},
  });
  try {
    await mkdir(dataDirectory, {mode: 0o700});
    await ledger.migrate();
    await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await ledger.pool.query("INSERT INTO ac_projects VALUES($1,'Principal')", [primaryProjectId]);
    await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [primaryProjectId, owner]);
    const published = randomUUID();
    const prepared = randomUUID();
    await ledger.createContext(owner, primaryProjectId, randomUUID());
    const {contextId} = await ledger.ensureExamContext(owner, primaryProjectId, 'qa');
    const {directory} = await report('qa', published, '2026-11-19T01:02:03.000Z');
    await report('qa', prepared, '2026-11-20T01:02:03.000Z'); // mais nova, sem linha no banco
    const intentId = randomUUID();
    await ledger.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
      VALUES($1,$2,$3,'synthetic','{}',$4,$5,1,0,'done')`, [intentId, contextId, owner, randomUUID(), randomUUID()]);
    await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
      VALUES($1,$2,$3,$4,$5,$6,'done',$7,'qa')`, [published, primaryProjectId, contextId, intentId, owner, commit, directory]);
    const app = createApi(ledger, {projectId: primaryProjectId, nativeExecutionReady: false} as CezarRuntime, async request => request.headers.get('authorization') === 'Bearer owner' ? owner : null, () => undefined, {
      configurationControl: {ledger} as Control,
      personalPanel: {roots: [], projectRepos: [], installationPath: root, dataDirectory, projectId: primaryProjectId, scheduleRestart() {}},
    });
    const response = await app.request(url, {headers});
    assert.equal(response.status, 200);
    const {qa} = byModule(await response.json() as StatusBody);
    assert.equal(qa.ultima.runId, published);
    assert.equal(qa.atual, null);
  } finally {
    await ledger.close();
    await fixture.close();
    await rm(root, {recursive: true, force: true});
  }
});
