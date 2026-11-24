import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';

const primaryProjectId = '00000000-0000-4000-8000-000000000010';
const otherProjectId = '00000000-0000-4000-8000-000000000001';
const url = '/api/v1/ac/personal/verificacoes-modulos';
const headers = {authorization: 'Bearer owner'};
const ORDER = ['seguranca', 'qa', 'arquitetura', 'dependencias', 'banco', 'prontidao', 'desempenho', 'documentacao', 'conformidade', 'design'];

type Row = {id: string; module: string; created_at: Date | string};
function api(root: string, options: {owner?: boolean; selected?: string; role?: string; running?: Row[]; panel?: boolean} = {}) {
  const {owner = true, selected = primaryProjectId, role, running = [], panel = true} = options;
  const ledger = {pool: {query: async (sql: string, params?: unknown[]) => {
    if (sql.includes("role='owner'")) return {rowCount: !panel || owner && params?.[0] === primaryProjectId ? 1 : 0, rows: []};
    if (sql.includes('ac_memberships')) return {rowCount: role ? 1 : 0, rows: role ? [{role}] : []};
    if (sql.includes('ac_verify_runs')) {
      assert.equal(params?.[0], selected);
      return {rowCount: running.length, rows: running};
    }
    throw new Error('consulta inesperada: ' + sql);
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

async function report(directory: string, name: string, extra: Record<string, unknown> = {}, raw?: string) {
  await mkdir(join(directory, name), {recursive: true});
  const body = raw ?? JSON.stringify({
    id: name.slice(0, 8) + '-0000-4000-8000-000000000000', directoryName: name, createdAt: '2026-11-24T10:00:00.000Z',
    counts: {alta: 1, media: 2, baixa: 3, informativa: 4}, note: 'x', ...extra,
  });
  await writeFile(join(directory, name, 'run.json'), body, {mode: 0o600});
}

async function progress(directory: string, id: string, state: Record<string, unknown> | string) {
  await writeFile(join(directory, 'andamento', `${id}.json`), typeof state === 'string' ? state : JSON.stringify({id, ...state}), {mode: 0o600});
}

test('rota de módulos: autenticação, dono e projeto', async () => {
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
    // só leitura
    const write = await api(root).request(url, {method: 'POST', headers, body: '{}'});
    assert.ok(write.status >= 400, 'a rota não aceita escrita');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: sem dados devolve os dez módulos vazios, em ordem', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-empty-')));
  try {
    const response = await api(root).request(url, {headers});
    assert.equal(response.status, 200);
    const body = await response.json() as {modulos: {modulo: string; atual: unknown; ultima: unknown}[]};
    assert.deepEqual(body.modulos.map(item => item.modulo), ORDER);
    assert.ok(body.modulos.every(item => item.atual === null && item.ultima === null));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: andamento da segurança, módulo rodando no banco e últimos relatórios', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-data-')));
  try {
    const directory = await projectDirectory(root);
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    await progress(directory, 'aaaaaaaa-0000-4000-8000-000000000001', {status: 'running', phase: 'exame', startedAt, modelCalls: 12, judged: 40, total: 100});
    await progress(directory, 'aaaaaaaa-0000-4000-8000-000000000002', {status: 'failed', phase: 'failed', startedAt: '2026-11-20T00:00:00.000Z', judged: 1, total: 100});
    await report(directory, '20261124-203731-c3403b26-seguranca', {tools: {limpa: 3, achado: 4, indisponivel: 1, truncada: 2}});
    await report(directory, '20261123-004136-82fc0ebbbb7844c8b28d3c9bdb2c72e0-qa', {toolFailures: 0});
    await report(directory, '20261124-025251-design');
    await report(directory, '20261123-093302-5a90818824f74aaeb9e3f94035bf68cb-arquitetura', {partial: true});
    const running = [{id: '11111111-0000-4000-8000-000000000001', module: 'banco', created_at: new Date(Date.now() - 30_000)}];
    const response = await api(root, {running}).request(url, {headers});
    assert.equal(response.status, 200);
    const {modulos} = await response.json() as {modulos: Record<string, any>[]};
    const by = Object.fromEntries(modulos.map(item => [item.modulo, item]));
    assert.deepEqual(by.seguranca.atual, {
      runId: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'running', phase: 'exame', startedAt,
      elapsedMs: by.seguranca.atual.elapsedMs, judged: 40, total: 100, modelCalls: 12,
    });
    assert.ok(by.seguranca.atual.elapsedMs >= 89_000 && by.seguranca.atual.elapsedMs < 120_000);
    assert.deepEqual(by.seguranca.ultima.counts, {alta: 1, media: 2, baixa: 3, informativa: 4});
    assert.equal(by.seguranca.ultima.toolFailures, 3);
    assert.equal(by.seguranca.ultima.situacao, 'com-falhas');
    assert.equal(by.qa.atual, null);
    assert.equal(by.qa.ultima.situacao, 'concluida');
    assert.equal(by.arquitetura.ultima.situacao, 'parcial');
    assert.equal(by.design.ultima.directoryName, '20261124-025251-design');
    assert.equal(by.banco.atual.runId, running[0]!.id);
    assert.equal(by.banco.atual.phase, null);
    assert.equal(by.banco.atual.judged, null);
    assert.equal(by.banco.ultima, null);
    assert.equal(by.prontidao.atual, null);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('rota de módulos: andamento ausente, corrompido ou inválido e relatório ilegível não derrubam a resposta', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-modules-broken-')));
  try {
    const directory = await projectDirectory(root);
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000001', '{"id": "corrompido"');
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000002', {status: 'running', phase: 'exame'}); // sem startedAt
    await progress(directory, 'bbbbbbbb-0000-4000-8000-000000000003', {status: 'running', phase: 'exame', startedAt: '2026-11-24T10:00:00.000Z', judged: 9, total: 3});
    // o relatório mais novo está corrompido: vale o anterior
    await report(directory, '20261124-100000-aaaaaaaa-seguranca', {}, '{nao e json');
    await report(directory, '20261123-100000-bbbbbbbb-seguranca', {counts: {alta: 0, media: 5, baixa: 0, informativa: 0}});
    // nome diferente do directoryName e contagem inválida são recusados
    await report(directory, '20261124-100000-cccccccc-qa', {directoryName: 'outro'});
    await report(directory, '20261124-110000-dddddddd-banco', {counts: {alta: -1, media: 0, baixa: 0, informativa: 0}});
    // symlink de relatório não é seguido
    const outside = join(root, 'fora');
    await report(outside, '20261124-120000-eeeeeeee-documentacao');
    await symlink(join(outside, '20261124-120000-eeeeeeee-documentacao'), join(directory, '20261124-120000-eeeeeeee-documentacao'));
    const response = await api(root).request(url, {headers});
    assert.equal(response.status, 200);
    const {modulos} = await response.json() as {modulos: Record<string, any>[]};
    const by = Object.fromEntries(modulos.map(item => [item.modulo, item]));
    assert.equal(by.seguranca.atual.runId, 'bbbbbbbb-0000-4000-8000-000000000003');
    assert.equal(by.seguranca.atual.judged, null, 'julgados maior que o total é descartado');
    assert.equal(by.seguranca.atual.total, null);
    assert.equal(by.seguranca.ultima.directoryName, '20261123-100000-bbbbbbbb-seguranca');
    assert.equal(by.qa.ultima, null);
    assert.equal(by.banco.ultima, null);
    assert.equal(by.documentacao.ultima, null);
  } finally { await rm(root, {recursive: true, force: true}); }
});
