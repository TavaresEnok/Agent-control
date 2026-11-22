import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {failAbandonedVerifyRuns, type VerifyRunLedger} from '../src/verify-abandon.ts';
import {trackRoundTemp} from '../src/personal-artifact-hooks.ts';

const delay = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

const project = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
const kept = '33333333-3333-4333-8333-333333333333';
const otherProject = '44444444-4444-4444-8444-444444444444';

function ledger(rows: {id: string; project_id: string}[], sql: {text: string}): VerifyRunLedger {
  return {pool: {async query(text: string) {
    sql.text = text;
    return {rows};
  }}};
}

test('runs running sem lease viram failed e o andamento é limpo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-abandon-'));
  try {
    const dir = join(root, 'verificacoes', project, 'andamento');
    const other = join(root, 'verificacoes', otherProject, 'andamento');
    await mkdir(dir, {recursive: true});
    await mkdir(other, {recursive: true});
    await writeFile(join(dir, `${run}.json`), JSON.stringify({id: run, status: 'running'}));
    await writeFile(join(dir, `${kept}.json`), JSON.stringify({id: kept, status: 'running'}));
    await writeFile(join(dir, '.running'), `${run}\n`);
    await writeFile(join(other, `${kept}.json`), 'ainda');
    await writeFile(join(other, '.running'), kept);
    const outside = join(root, 'fora.json');
    const linkRun = '55555555-5555-4555-8555-555555555555';
    await writeFile(outside, 'FORA\n');
    await symlink(outside, join(dir, `${linkRun}.json`));
    await symlink(outside, join(dir, '.running-link'));
    const sql = {text: ''};
    await failAbandonedVerifyRuns(ledger([{id: run, project_id: project}, {id: linkRun, project_id: project}], sql), root);
    assert.match(sql.text, /UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp\(\)/);
    assert.match(sql.text, /status='running'/);
    assert.match(sql.text, /NOT EXISTS \(SELECT 1 FROM ac_managers m WHERE m.context_id = ac_verify_runs.context_id AND m.lease_until > clock_timestamp\(\)\)/);
    assert.match(sql.text, /RETURNING id, project_id/);
    await assert.rejects(() => stat(join(dir, `${run}.json`)));
    await assert.rejects(() => stat(join(dir, `${linkRun}.json`)));
    await assert.rejects(() => stat(join(dir, '.running')));
    assert.equal(await readFile(join(dir, `${kept}.json`), 'utf8'), JSON.stringify({id: kept, status: 'running'}));
    assert.equal(await readFile(join(other, `${kept}.json`), 'utf8'), 'ainda');
    assert.equal(await readFile(join(other, '.running'), 'utf8'), kept);
    assert.equal(await readFile(outside, 'utf8'), 'FORA\n');
    assert.equal(await readFile(join(dir, '.running-link'), 'utf8'), 'FORA\n');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a recuperação fecha a rodada dos temporários de uma verificação abandonada', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const temp = await mkdtemp(join(tmpdir(), 'ac-verify-round-'));
  try {
    assert.equal(await trackRoundTemp({dataDirectory:root,projectId:project,roundId:run},temp),true);
    await failAbandonedVerifyRuns(ledger([{id:run,project_id:project}],{text:''}),root);
    const registry=JSON.parse(await readFile(join(root,'artifact-retention','registry.json'),'utf8'));
    assert.ok(registry.rounds.some((round:{roundId:string})=>round.roundId===run));
  } finally {
    await rm(root,{recursive:true,force:true});
    await rm(temp,{recursive:true,force:true});
  }
});

test('limpa o andamento quando o diretório de dados é acessado por um link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-abandon-link-'));
  try {
    const data = join(root, 'dados');
    const alias = join(root, 'atalho');
    const dir = join(data, 'verificacoes', project, 'andamento');
    await mkdir(dir, {recursive: true});
    await symlink(data, alias);
    await writeFile(join(dir, `${run}.json`), '{"status":"running"}');
    await writeFile(join(dir, '.running'), run);
    await failAbandonedVerifyRuns(ledger([{id: run, project_id: project}], {text: ''}), alias);
    await assert.rejects(stat(join(dir, `${run}.json`)), {code: 'ENOENT'});
    await assert.rejects(stat(join(dir, '.running')), {code: 'ENOENT'});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('marcador de outro run e lease ainda ativa não são apagados', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-abandon-keep-'));
  try {
    const dir = join(root, 'verificacoes', project, 'andamento');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, `${run}.json`), '{"status":"running"}');
    await writeFile(join(dir, '.running'), `${kept}\n`);
    const sql = {text: ''};
    await failAbandonedVerifyRuns(ledger([], sql), root);
    assert.equal(await readFile(join(dir, `${run}.json`), 'utf8'), '{"status":"running"}');
    assert.equal(await readFile(join(dir, '.running'), 'utf8'), `${kept}\n`);
    await failAbandonedVerifyRuns(ledger([{id: run, project_id: project}], sql), root);
    await assert.rejects(() => stat(join(dir, `${run}.json`)));
    assert.equal(await readFile(join(dir, '.running'), 'utf8'), `${kept}\n`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('lease ainda válido na primeira varredura permanece; a seguinte limpa o andamento sem reiniciar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-abandon-watch-'));
  let stop = () => {};
  const parked: Array<(rows: {id: string; project_id: string}[]) => void> = [];
  const releaseParked = () => { for (const wake of parked.splice(0)) wake([]); };
  try {
    const dir = join(root, 'verificacoes', project, 'andamento');
    await mkdir(dir, {recursive: true});
    const progress = join(dir, `${run}.json`);
    const marker = join(dir, '.running');
    await writeFile(progress, '{"status":"running"}');
    await writeFile(marker, `${run}\n`);
    let calls = 0;
    let releaseExpired!: (rows: {id: string; project_id: string}[]) => void;
    const expired = new Promise<{id: string; project_id: string}[]>(resolve => { releaseExpired = resolve; });
    const mock: VerifyRunLedger = {pool: {query() {
      const n = ++calls;
      if (n === 1) return Promise.resolve({rows: []});
      if (n === 2) return expired.then(rows => ({rows}));
      return new Promise(resolve => { parked.push(rows => resolve({rows})); });
    }}};
    const abandon = await import('../src/verify-abandon.ts');
    assert.equal(typeof abandon.watchAbandonedVerifyRuns, 'function');
    const started = Date.now();
    const gone = async (path: string) => {
      while (true) {
        try { await stat(path); } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? (error as {code: unknown}).code : undefined;
          if (code === 'ENOENT') return;
          throw error;
        }
        if (Date.now() - started > 800) throw new Error(`not removed: ${path}`);
        await delay(5);
      }
    };
    stop = abandon.watchAbandonedVerifyRuns(mock, root, 20);
    while (calls < 1) {
      if (Date.now() - started > 400) throw new Error('first sweep did not run');
      await delay(5);
    }
    assert.equal(await readFile(progress, 'utf8'), '{"status":"running"}');
    assert.equal(await readFile(marker, 'utf8'), `${run}\n`);
    releaseExpired([{id: run, project_id: project}]);
    await gone(progress);
    await gone(marker);
    assert.ok(calls >= 2);
    stop();
    const frozen = calls;
    await delay(80);
    assert.equal(calls, frozen);
  } finally {
    releaseParked();
    stop();
    await rm(root, {recursive: true, force: true});
  }
});
