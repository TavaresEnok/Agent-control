// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Ledger} from '../src/ledger.ts';
import {listModuleReports, parseModuleCollectorOutput, readModuleReport, reconcileModuleReports, requestModuleCorrection, runVerificationModule, writeModuleReport} from '../src/verification-modules.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const commit = 'a'.repeat(40);
const detail = (x: object) => JSON.stringify(x, null, 1).replaceAll('\n', '');
function artifact(name: 'api.json' | 'dependencias.mmd', content: string) {
  const bytes = Buffer.from(content);
  const parts = Math.ceil(bytes.length / 880);
  return Array.from({length: parts}, (_, i) => ({
    tool: name === 'api.json' ? 'typedoc:artefato' : 'dependency-cruiser:artefato', version: '1', status: 'ok' as const,
    detail: detail({artifact: name, encoding: 'hex-utf8-v1', part: i + 1, parts,
      data: bytes.subarray(i * 880, (i + 1) * 880).toString('hex').match(/.{1,16}/g)!.join(' ')}),
  }));
}
const other = {tool:'test', version:'1', status:'ok' as const, detail:'Concluído.'};
const finding = {tool:'gitleaks', rule:'generic-api-key', file:'.env', line:3, severity:'alta' as const,
  message:'Detected API key', evidence:'generic-api-key: match em .env:3 [REDACTED]'};

async function runRoot() { return mkdtemp(join(tmpdir(), 'interop-')); }

test('escritor valida, resume e publica apenas artefatos completos com acesso privado', async () => {
  const root = await runRoot();
  try {
    const coverage = [other, ...artifact('api.json', '[{"name":"exemplo"}]'), ...artifact('dependencias.mmd', 'flowchart LR\nA-->B\n')];
    const args = {dataDirectory:root, projectId:randomUUID(), module:'documentacao' as const, runId:randomUUID(), createdAt:new Date(), commit,
      toolCoverage:coverage, fileCoverage:[], achados:[], raw:{coverage, findings:[]}};
    const report = await writeModuleReport(args);
    assert.equal(await readFile(join(report.directory,'api.json'),'utf8'), '[{"name":"exemplo"}]');
    assert.equal(await readFile(join(report.directory,'dependencias.mmd'),'utf8'), 'flowchart LR\nA-->B\n');
    assert.equal((await lstat(join(report.directory,'api.json'))).mode & 0o777, 0o600);
    for (const file of ['README.md','cobertura.md','bruto/achados-brutos.json']) {
      const text = await readFile(join(report.directory,file),'utf8');
      assert.ok(!text.includes('hex-utf8-v1'));
      assert.match(text, /Artefato api\.json validado/);
    }
    const without = await writeModuleReport({...args, runId:randomUUID(), toolCoverage:[other], raw:{coverage:[other],findings:[]}});
    await assert.rejects(readFile(join(without.directory,'api.json')), {code:'ENOENT'});
    for (const broken of [artifact('dependencias.mmd', 'x'.repeat(900)).slice(0,1), artifact('api.json', '[{"x":"password = valor-sintetico"}]')]) {
      await assert.rejects(writeModuleReport({...args, runId:randomUUID(), toolCoverage:broken, raw:{coverage:broken,findings:[]}}));
    }
    const outside = join(root,'fora'); await mkdir(outside);
    const project = join(root,'verificacoes',args.projectId);
    const name = '20260101-000000-12345678-documentacao';
    const dir = join(project,name); await mkdir(dir); await symlink(outside,join(dir,'bruto'));
    await assert.rejects(writeModuleReport({...args,runId:randomUUID(),directoryName:name}));
    assert.deepEqual(await readdir(outside), []);
    await assert.rejects(readFile(join(dir,'run.json')), {code:'ENOENT'});
    const name2 = '20260101-000001-12345678-documentacao';
    const dir2 = join(project,name2); await mkdir(dir2); await symlink(join(outside,'target'),join(dir2,'api.json'));
    await assert.rejects(writeModuleReport({...args,runId:randomUUID(),directoryName:name2}));
    await assert.rejects(readFile(join(outside,'target')), {code:'ENOENT'});
    await assert.rejects(readFile(join(dir2,'run.json')), {code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('localização protegida aceita apenas registro estruturado de prontidão', () => {
  const parse = (item: object, module: 'prontidao' | 'qa' = 'prontidao') => parseModuleCollectorOutput(JSON.stringify({coverage:[{...other,tool:'gitleaks'}],findings:[item]}), {module});
  const metadata = {...finding, tool:'prontidao-audit', rule:'PRONTIDAO-SEGREDO-ARQUIVO-ENV',
    message:'Possível segredo em arquivo protegido.', evidence:'Localização informada pelo coletor; conteúdo protegido.'};
  assert.equal(parse(metadata).findings[0]?.file, '.env');
  assert.throws(() => parse({...metadata, evidence:'conteúdo arbitrário'}));
  assert.throws(() => parse({...metadata, rule:'regra-nao-autorizada'}));
  const result = parse(finding);
  assert.equal(result.findings[0]?.file,'.env');
  assert.doesNotMatch(JSON.stringify(result), /Detected API key|match em/);
  for (const item of [
    {...finding,file:'../.env'}, {...finding,file:'dir/../../.env'}, {...finding,file:'/tmp/.env'},
    {...finding,tool:'arbitrario'}, {...finding,evidence:'PASSWORD=valor-sintetico'},
    {...finding,message:'password=valor-sintetico'}, {...finding,rule:'a/b'},
  ]) assert.throws(() => parse(item));
  assert.throws(() => parse(finding,'qa'));
  const pem = {...finding,file:'deploy/server.key',evidence:'generic-api-key: match em deploy/server.key:3 [REDACTED]'};
  assert.equal(parse(pem).findings[0]?.file, 'deploy/server.key');
  assert.throws(() => parse(pem, 'qa'));
  assert.throws(() => parseModuleCollectorOutput(JSON.stringify({coverage:[{...other,files:['.env']}],findings:[]}),{module:'prontidao'}));
});

test('fluxo completo sintético publica, rejeita dados inválidos e cria correção manual idempotente', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'interop');
  const db = new Ledger(database.url);
  const root = await runRoot();
  try {
    await db.migrate();
    const principal = 'owner-interop', projectId = randomUUID();
    const repo = join(root,'repo'), data = join(root,'data');
    await mkdir(repo); await mkdir(data);
    await writeFile(join(repo,'src.ts'),'export const x = 1;\n');
    await writeFile(join(repo,'.env'),'CONTEUDO_SINTETICO\n');
    await symlink('src.ts', join(repo,'.env.link'));
    for (const args of [['init'],['add','.'],['-c','user.name=test','-c','user.email=test@localhost','commit','-m','fixture']])
      execFileSync('git',args,{cwd:repo,stdio:'ignore'});
    const sha = execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectId,'Projeto']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectId,principal]);
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[projectId,repo]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.createContext(principal,projectId,randomUUID());
    async function context(module:'documentacao'|'prontidao') {
      const {contextId} = await db.ensureExamContext(principal,projectId,module);
      return db.acquire(principal,contextId,randomUUID(),'interop',60);
    }
    const docAuth = await context('documentacao');
    const readyAuth = await context('prontidao');
    const api = '[{"name":"exemplo"}]', diagram = 'flowchart LR\nA-->B\n';
    const rows = [other,...artifact('api.json',api),...artifact('dependencias.mmd',diagram)];
    const common = {ledger:db,principal,projectId,repoPath:repo,dataDirectory:data,commit:sha};
    const doc = await runVerificationModule({...common, module:'documentacao',authority:docAuth,collectorOutput:{coverage:rows,findings:[]}});
    assert.equal(await readFile(join(doc.directory,'api.json'),'utf8'),api);
    await rename(join(doc.directory,'run.json'), join(doc.directory,'.run-pending.json'));
    assert.equal((await listModuleReports(data,projectId,'documentacao')).length,0);
    await reconcileModuleReports(db,principal,docAuth,data,projectId);
    assert.equal((await listModuleReports(data,projectId,'documentacao')).length,1);
    assert.equal(await readFile(join(doc.directory,'api.json'),'utf8'),api);
    const saved = await db.pool.query('SELECT detail FROM ac_verify_tool_coverage WHERE run_id=$1',[doc.runId]);
    assert.ok(!JSON.stringify(saved.rows).includes('hex-utf8-v1'));
    assert.ok(!JSON.stringify(await readModuleReport(data,projectId,doc.runId)).includes('hex-utf8-v1'));
    const bad = artifact('dependencias.mmd','a'.repeat(900)).slice(0,1);
    let rejectedCalls = 0;
    const failed = await runVerificationModule({...common,module:'documentacao',authority:docAuth,
      collectorOutput:{coverage:[...bad,{...other,files:['src.ts']}],findings:[{...finding,tool:'test',file:'src.ts',evidence:'prova'}]},
      worker:{run:async () => {rejectedCalls++; throw Error('não deve receber dados');}}});
    assert.equal(rejectedCalls,0);
    assert.equal(failed.hasToolFailure,true);
    assert.ok(!JSON.stringify(failed.toolCoverage).includes('hex-utf8-v1'));
    await assert.rejects(readFile(join(failed.directory,'dependencias.mmd')), {code:'ENOENT'});
    const secretRows = [other, ...artifact('api.json', '[{"x":"password = valor-sintetico"}]')];
    const secretRun = await runVerificationModule({...common,module:'documentacao',authority:docAuth,collectorOutput:{coverage:secretRows,findings:[]}});
    assert.equal(secretRun.hasToolFailure,true);
    assert.doesNotMatch(await readFile(join(secretRun.directory,'bruto','achados-brutos.json'),'utf8'), /valor-sintetico|hex-utf8-v1/);
    const omitted = {tool:'typedoc:artefato',version:'1',status:'skipped' as const,detail:detail({artifact:'api.json',encoding:'hex-utf8-v1',reason:'size-limit'})};
    const omission = await runVerificationModule({...common,module:'documentacao',authority:docAuth,collectorOutput:{coverage:[other,omitted],findings:[]}});
    assert.equal(omission.hasToolFailure,false);
    assert.match(JSON.stringify(omission.toolCoverage),/omitido por limite/);
    await assert.rejects(readFile(join(omission.directory,'api.json')), {code:'ENOENT'});
    let calls = 0;
    const ready = await runVerificationModule({...common,module:'prontidao',authority:readyAuth,
      collectorOutput:{coverage:[{...other,tool:'gitleaks'}],findings:[finding]},worker:{run:async () => {calls++; throw Error('impossível');}}});
    assert.equal(calls,0);
    assert.equal(ready.achados[0]?.where.file,'.env');
    assert.equal((await db.pool.query('SELECT provenance FROM ac_verify_coverage WHERE run_id=$1', [ready.runId])).rows[0]?.provenance, 'collector');
    assert.doesNotMatch(JSON.stringify(ready),/CONTEUDO_SINTETICO|Detected API key/);
    await readModuleReport(data,projectId,ready.runId);
    const correctionInput = {module:'prontidao' as const,runId:ready.runId,achadoIds:['ACH-001'],dataDirectory:data,projectId};
    assert.equal(ready.achados[0]?.status,'provavel');
    const symlinkFinding = {...finding,file:'.env.link',evidence:'generic-api-key: match em .env.link:3 [REDACTED]'};
    const symlinkRun = await runVerificationModule({...common,module:'prontidao',authority:readyAuth,collectorOutput:{coverage:[{...other,tool:'gitleaks'}],findings:[symlinkFinding]}});
    assert.equal(symlinkRun.hasToolFailure,true);
    assert.deepEqual(symlinkRun.achados,[]);
    await assert.rejects(requestModuleCorrection(db,principal,readyAuth,correctionInput), /VERIFY_FINDING_MISSING/);
    // A previously confirmed protected finding remains actionable without exposing its contents.
    await db.pool.query("UPDATE ac_verify_findings SET status='confirmado' WHERE run_id=$1 AND achado_id='ACH-001'", [ready.runId]);
    await db.pool.query(`INSERT INTO ac_verify_coverage(run_id,file,examiner_provider,examiner_model,checklist)
      VALUES($1,'src.ts','fixture','fixture','[]')`, [ready.runId]);
    await db.pool.query(`INSERT INTO ac_verify_findings(run_id,achado_id,status,severity,file,line,payload)
      VALUES($1,'ACH-002','confirmado','baixa','src.ts',1,'{"title":"Configuração sintética"}')`, [ready.runId]);
    const mixedInput = {...correctionInput, achadoIds: ['ACH-002', 'ACH-001']};
    const outside = join(root,'fora'); await mkdir(outside);
    await symlink(outside, join(repo,'tests'));
    await assert.rejects(requestModuleCorrection(db,principal,readyAuth,mixedInput), /VERIFY_PATH_FORBIDDEN/);
    assert.equal((await db.pool.query('SELECT 1 FROM ac_verify_remediations WHERE run_id=$1', [ready.runId])).rowCount, 0);
    await rm(join(repo,'tests'));
    const task = await requestModuleCorrection(db,principal,readyAuth,correctionInput);
    assert.deepEqual(task,await requestModuleCorrection(db,principal,readyAuth,correctionInput));
    await symlink(outside, join(repo,'tests'));
    await assert.rejects(requestModuleCorrection(db,principal,readyAuth,correctionInput), /VERIFY_PATH_FORBIDDEN/);
    await rm(join(repo,'tests'));
    assert.deepEqual(task.writePaths, ['tests/prontidao/ach-001.test.ts']);
    const mixed = await requestModuleCorrection(db,principal,readyAuth,mixedInput);
    assert.equal(mixed.messageLocalIds?.length, 2);
    assert.equal(mixed.messageLocalId, task.messageLocalId);
    const scopes = await db.pool.query('SELECT write_paths FROM ac_verify_remediations WHERE run_id=$1 ORDER BY finding_ids', [ready.runId]);
    assert.deepEqual(scopes.rows.map(row => row.write_paths), [
      ['tests/prontidao/ach-001.test.ts'], ['src.ts', 'tests/prontidao/ach-002.test.ts'],
    ]);
    const text = await db.pool.query('SELECT text FROM ac_personal_messages WHERE local_id=$1',[task.messageLocalId]);
    assert.match(JSON.stringify(text.rows),/Ação manual/);
    assert.doesNotMatch(JSON.stringify(text.rows),/src\.ts|ACH-002/);
    assert.doesNotMatch(JSON.stringify(text.rows),/CONTEUDO_SINTETICO|Detected API key/);
    await rm(join(repo,'.env'));
    await symlink(join(repo,'src.ts'), join(repo,'.env'));
    await assert.rejects(requestModuleCorrection(db,principal,readyAuth,mixedInput), /VERIFY_PATH_FORBIDDEN/);
  } finally { await db.pool.end(); await database.close(); await rm(root,{recursive:true,force:true}); }
});
