import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import {Refusal} from '../src/contracts.ts';
import {readVerificationProgress} from '../src/verify-command.ts';
import {VERIFY_RECHECK_NEW_EXAM_GUIDANCE, VERIFY_RECHECK_NEW_EXAM_REQUIRED} from '../src/verify-remediate.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import {Ledger, VERIFICATION_MODULES, type VerificationModule} from '../src/ledger.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {Projects, ProjectRuntimes} from '../src/projects.ts';
import {writeModuleReport} from '../src/verification-modules.ts';
import type {Achado} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const projectId='00000000-0000-4000-8000-000000000001';
const primaryProjectId='00000000-0000-4000-8000-000000000010';

function api(root:string,ownerOf:'primary'|'selected'|'none',start?:(principal:string,panel:{dataDirectory:string;projectId:string;installationPath:string},body:{url?:string})=>Promise<{id:string;status:'running';phase:string}>){
 const ledger={pool:{query:async(_sql:string,params?:unknown[])=>{
  const asked=params?.[0];
  const rowCount=ownerOf==='primary'&&asked===primaryProjectId||ownerOf==='selected'&&asked===projectId?1:0;
  return {rowCount,rows:[]};
 }}} as unknown as Ledger;
 return createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>undefined,{
  configurationControl:{ledger} as Control,
  personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
  ...(start?{personalVerification:{start}}:{}),
 });
}

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
test('relatórios funcionais seguem o projeto do gateway e corrigem com a reserva dedicada', {
 skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset',
}, async () => {
 const fixture = await isolatedDatabase(databaseUrl!, 'panelmodules');
 const ledger = new Ledger(fixture.url);
 const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-functional-panel-')));
 const dataDirectory = join(root, 'data');
 const owner = 'synthetic-installation-owner';
 const selectedOwner = 'synthetic-project-owner';
 const commit = 'a'.repeat(40);
 const file = 'src/exemplo.ts';
 const fixed: Achado = {
  id: 'ACH-001', title: 'Regressão confirmada', severity: 'alta', status: 'confirmado', verifier: null,
  reference: 'fixture', where: {file, line: 1}, scenario: 'Cenário sintético.', proof: 'Prova sintética em teste local.',
  suggestion: 'Corrigir a regressão.', acceptance: 'O teste passa.', sources: ['fixture'], secretPreview: null,
 };
 const likely: Achado = {...fixed, id: 'ACH-002', status: 'provavel'};
 const reopened: Achado = {...fixed, id: 'ACH-003', status: 'reaberto'};
 const fourth: Achado = {...likely, id: 'ACH-004'};
 const findings = [fixed, likely, reopened, fourth];
 const toolCoverage = [{tool: 'fixture', version: '1', status: 'ok' as const, detail: 'Medição sintética.'}];
 const fileCoverage = [{file, examinerProvider: 'ferramenta', examinerModel: 'fixture', profileId: null, checklist: ['FIXTURE']}];

 async function publish(project: string, module: VerificationModule, achados: Achado[] = []) {
  const id = randomUUID();
  const intentId = randomUUID();
  const {contextId} = await ledger.ensureExamContext(owner, project, module);
  const {directory} = await writeModuleReport({
   dataDirectory, projectId: project, module, runId: id, createdAt: new Date('2026-11-19T01:02:03.000Z'), commit,
   toolCoverage, fileCoverage, achados, raw: {coverage: toolCoverage, findings: []},
  });
  await ledger.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
    VALUES($1,$2,$3,'synthetic','{}',$4,$5,1,0,'done')`, [intentId, contextId, owner, randomUUID(), randomUUID()]);
  await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module)
    VALUES($1,$2,$3,$4,$5,$6,'done',$7,$8)`, [id, project, contextId, intentId, owner, commit, directory, module]);
  await ledger.pool.query(`INSERT INTO ac_verify_coverage(run_id,file,examiner_provider,examiner_model,checklist)
    VALUES($1,$2,'ferramenta','fixture','["FIXTURE"]')`, [id, file]);
  for (const item of achados) {
   await ledger.pool.query(`INSERT INTO ac_verify_findings(run_id,achado_id,status,severity,file,line,payload)
     VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, item.id, item.status, item.severity, file, item.where.line, item]);
  }
  return {id, contextId, directory};
 }

 try {
  const repo = join(root, 'selected');
  const mainRepo = join(root, 'primary');
  await mkdir(join(repo, 'src'), {recursive: true});
  await mkdir(mainRepo);
  await mkdir(dataDirectory, {mode: 0o700});
  await writeFile(join(repo, file), 'export const fixture = 42;\n');
  await ledger.migrate();
  await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await ledger.pool.query("INSERT INTO ac_projects VALUES($1,'Principal'),($2,'Selecionado')", [primaryProjectId, projectId]);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$3,'owner'),($2,$3,'operator'),($2,$4,'owner')", [primaryProjectId, projectId, owner, selectedOwner]);
  await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$3),($2,$4)', [primaryProjectId, projectId, mainRepo, repo]);
  await ledger.createContext(owner, primaryProjectId, randomUUID());
  const mainContext = await ledger.createContext(owner, projectId, randomUUID());
  const mainAuthority = await ledger.acquire(owner, mainContext, randomUUID(), 'fixture-main', 60);
  const selected = await publish(projectId, 'qa', findings);
  const foreign = await publish(primaryProjectId, 'qa');
  const discarded = await publish(projectId, 'qa');
  await ledger.pool.query("UPDATE ac_verify_runs SET report_dir='discarded:'||report_dir WHERE id=$1", [discarded.id]);
  for (const module of VERIFICATION_MODULES) {
   if (module !== 'qa') await publish(projectId, module);
  }

  // Simula campos históricos sensíveis no relatório lido, sem credenciais reais.
  const protectedFile = 'fixtures/.env';
  const protectedMarker = 'conteudo-protegido-sintetico';
  const preview = 'previa-protegida-sintetica';
  const fakePassword = 'valor-sintetico-para-redigir';
  const onlyInCoverage = 'data/.env.historico';
  await ledger.pool.query(`INSERT INTO ac_verify_coverage(run_id,file,examiner_provider,examiner_model,checklist)
    VALUES($1,$2,'fixture','fixture',$3::jsonb)`, [selected.id, onlyInCoverage, JSON.stringify(['marcador-privado-da-cobertura'])]);
  const coverageFile = join(selected.directory, 'cobertura.md');
  await writeFile(coverageFile, (await readFile(coverageFile, 'utf8')) + `\npassword=${fakePassword}\n| ${protectedFile} | ${protectedMarker} |\n`);
  await writeFile(join(selected.directory, 'achados.json'), JSON.stringify({achados: [
   {...fixed, proof: `${fixed.proof} token=${fakePassword}`}, likely, reopened,
   {...fourth, where: {file: protectedFile, line: 1}, title: protectedMarker, proof: protectedMarker, secretPreview: preview},
  ]}));

  const authenticate = async (request: Request) => {
   const token = request.headers.get('authorization');
   return token === 'Bearer fixture-owner' ? owner : token === 'Bearer fixture-project-owner' ? selectedOwner : null;
  };
  const runtimes = new ProjectRuntimes(async ({id}) => ({projectId: id, nativeExecutionReady: false, close: async () => {}} as CezarRuntime));
  const gateway = createProjectGateway({
   defaultProjectId: primaryProjectId, projects: new Projects(ledger), runtimes, authenticate,
   publicFetch: async () => { throw Error('NOT_A_PUBLIC_ROUTE'); },
   appFor: runtime => createApi(ledger, runtime, authenticate, () => { throw Error('NOT_A_LEGACY_CORRECTION'); }, {
    configurationControl: {ledger} as Control,
    personalPanel: {roots: [], projectRepos: [], installationPath: root, dataDirectory, projectId: primaryProjectId, scheduleRestart() {}},
   }),
  });
  const basePath = '/api/v1/ac/personal/verificacoes-funcionais';
  const detailPath = `${basePath}/qa/${selected.id}`;
  const foreignPath = `${basePath}/qa/${foreign.id}`;
  const request = (path: string, achadoIds?: string[], token = 'fixture-owner', project = projectId) => gateway(new Request('http://localhost' + path, {
   method: achadoIds ? 'POST' : 'GET',
   headers: {authorization: `Bearer ${token}`, 'x-agent-control-project': project, 'content-type': 'application/json'},
   body: achadoIds ? JSON.stringify({achadoIds}) : undefined,
  }));

  assert.equal((await request(basePath, undefined, 'unknown')).status, 401);
  assert.deepEqual(await (await request(detailPath, undefined, 'fixture-project-owner')).json(), {error: 'PROJECT_OWNER_REQUIRED'});
  assert.equal((await request(`${detailPath}/corrigir`, [fixed.id], 'fixture-project-owner')).status, 403);
  const all = await request(basePath);
  assert.equal(all.status, 200);
  assert.deepEqual((await all.json()).verificacoes.map((item: {module: string}) => item.module).sort(), [...VERIFICATION_MODULES].sort());
  const listed = await request(`${basePath}?modulo=qa`);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await listed.json()).verificacoes.map((item: {id: string}) => item.id), [selected.id]);
  assert.deepEqual((await (await request(`${basePath}?modulo=qa`, undefined, 'fixture-owner', primaryProjectId)).json())
   .verificacoes.map((item: {id: string}) => item.id), [foreign.id]);
  assert.equal((await request(foreignPath)).status, 404);
  assert.equal((await request(`${foreignPath}/corrigir`, [fixed.id])).status, 404);
  assert.equal((await request(`${basePath}/banco/${selected.id}`)).status, 404);
  assert.equal((await request(`${basePath}?modulo=verify`)).status, 400);

  const detail = await request(detailPath);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  const body = await detail.text();
  for (const privateText of [protectedMarker, preview, fakePassword, 'secretPreview', selected.directory, 'mapa', 'bruto', onlyInCoverage, 'marcador-privado-da-cobertura']) {
   assert.ok(!body.includes(privateText), `unexpected field or text in functional report: ${privateText}`);
  }
  const parsed = JSON.parse(body);
  assert.match(parsed.cobertura, /Medição sintética\./);
  assert.match(parsed.cobertura, /Registro de arquivo protegido omitido/);
  assert.equal(parsed.achados[0].proof, `${fixed.proof} [redigido]`);
  assert.equal(parsed.achados[3].proof, 'Conteúdo protegido. Consulte a localização indicada.');

  const correction = `${detailPath}/corrigir`;
  assert.equal((await request(correction, [])).status, 400);
  assert.equal((await request(correction, [fixed.id, likely.id])).status, 404);
  const occupied = await ledger.acquire(owner, selected.contextId, randomUUID(), 'fixture-exam', 60);
  const busy = await request(correction, [fixed.id, reopened.id]);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), {error: 'VERIFY_ALREADY_RUNNING'});
  await ledger.tx(client => ledger.fence(client, occupied));
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_verify_remediations')).rowCount, 0);
  await ledger.releaseLease(occupied);

  const simultaneous = await Promise.all([
   request(correction, [fixed.id, reopened.id]), request(correction, [reopened.id, fixed.id]),
  ]);
  const corrected = simultaneous.find(response => response.status === 200);
  assert.ok(corrected);
  assert.equal(corrected.headers.get('cache-control'), 'no-store');
  const result = await corrected.json();
  assert.deepEqual(Object.keys(result), ['messageLocalId']);
  for (const response of simultaneous.filter(response => response !== corrected)) {
   if (response.status === 200) assert.deepEqual(await response.json(), result);
   else {
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {error: 'VERIFY_ALREADY_RUNNING'});
   }
  }
  const duplicate = await request(correction, [reopened.id, fixed.id]);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), result);
  const remediations = (await ledger.pool.query('SELECT finding_ids, write_paths, message_local_id FROM ac_verify_remediations')).rows;
  assert.deepEqual(remediations, [{finding_ids: [fixed.id, reopened.id],
   write_paths: [file, 'tests/qa/ach-001.test.ts', 'tests/qa/ach-003.test.ts'], message_local_id: result.messageLocalId}]);
  const messages = (await ledger.pool.query('SELECT context_id, text FROM ac_personal_messages WHERE local_id=$1', [result.messageLocalId])).rows;
  assert.deepEqual(new Set(messages.map(message => message.context_id)), new Set([mainContext, selected.contextId]));
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /Caminhos de escrita:[\s\S]*Teste de regressão exigido:[\s\S]*Critério de aceite:/);
  await ledger.tx(client => ledger.fence(client, mainAuthority));
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_managers WHERE context_id=$1 AND lease_until>clock_timestamp()', [selected.contextId])).rowCount, 0);

  await writeFile(join(selected.directory, 'achados.json'), `{"${protectedMarker}":`);
  const invalidReport = await request(detailPath);
  assert.equal(invalidReport.status, 400);
  assert.deepEqual(await invalidReport.json(), {error: 'INVALID_CONTRACT'});
  await runtimes.close();
 } finally {
  await ledger.close();
  await fixture.close();
  await rm(root, {recursive: true, force: true});
 }
});

test('the installation owner lists verifications and a stranger cannot',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-route-')));
 try{
  const app=api(root,'primary');
  const headers={authorization:'Bearer owner'};
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes')).status,401);
  const listed=await app.request('/api/v1/ac/personal/verificacoes',{headers});
  assert.equal(listed.status,200);
  assert.equal(listed.headers.get('cache-control'),'no-store');
  assert.deepEqual(await listed.json(),{verificacoes:[]});
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/verificacoes',{headers})).status,403);
  assert.equal((await api(root,'selected').request('/api/v1/ac/personal/verificacoes',{headers})).status,403);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes',{headers})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the installation owner starts a verification and strangers cannot',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-start-')));
 try{
  const seen:{projectId?:string;url?:string}={};
  const start=async(_principal:string,panel:{projectId:string},body:{url?:string})=>{
   seen.projectId=panel.projectId;seen.url=body.url;
   return {id:'00000000-0000-4000-8000-0000000000aa',status:'running' as const,phase:'mapa'};
  };
  const app=api(root,'primary',start);
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const started=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'});
  assert.equal(started.status,202);
  assert.equal(started.headers.get('cache-control'),'no-store');
  assert.deepEqual(await started.json(),{id:'00000000-0000-4000-8000-0000000000aa',status:'running',phase:'mapa'});
  assert.equal(seen.projectId,primaryProjectId);
  assert.equal(seen.url,undefined);
  const withUrl=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:JSON.stringify({url:'http://127.0.0.1:9'})});
  assert.equal(withUrl.status,202);
  assert.equal(seen.url,'http://127.0.0.1:9');
  const extra=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:JSON.stringify({url:'http://127.0.0.1:9',extra:true})});
  assert.equal(extra.status,400);
  assert.equal((await api(root,'none',start).request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'})).status,403);
  const unavailable=await api(root,'primary').request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'});
  assert.equal(unavailable.status,503);
  assert.deepEqual(await unavailable.json(),{error:'VERIFY_WORKER_UNAVAILABLE'});
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control,personalVerification:{start}});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('verification progress is the literal andamento route',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-progress-')));
 try{
  const app=api(root,'primary');
  const headers={authorization:'Bearer owner'};
  const missing=await app.request('/api/v1/ac/personal/verificacoes/andamento',{headers});
  assert.equal(missing.status,200);
  assert.notEqual(missing.status,400);
  assert.deepEqual(await missing.json(),{runs:[]});
  const id='00000000-0000-4000-8000-0000000000bb';
  const dir=join(root,'verificacoes',primaryProjectId,'andamento');
  await mkdir(dir,{recursive:true});
  await chmod(join(root,'verificacoes'),0o700);
  await chmod(join(root,'verificacoes',primaryProjectId),0o700);
  await chmod(dir,0o700);
  const record={id,status:'running',phase:'mapa',startedAt:'2026-11-17T03:04:05.000Z'};
  await writeFile(join(dir,`${id}.json`),JSON.stringify(record),{mode:0o600});
  await chmod(join(dir,`${id}.json`),0o600);
  const listed=await app.request('/api/v1/ac/personal/verificacoes/andamento',{headers});
  assert.equal(listed.status,200);
  const expected=await readVerificationProgress(root,primaryProjectId);
  assert.deepEqual(await listed.json(),{runs:expected});
  assert.equal(expected.some(run=>run.id===id),true);
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes/andamento')).status,401);
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/verificacoes/andamento',{headers})).status,403);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes/andamento',{headers})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reverificar chama o worker injetado e não existe sem ele',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-recheck-')));
 try{
  const runId='00000000-0000-4000-8000-0000000000cc';
  const contextId='00000000-0000-4000-8000-0000000000dd';
  const authority={contextId,instanceId:'00000000-0000-4000-8000-0000000000ee',epoch:1};
  const ledger={pool:{query:async(sql:string,params?:unknown[])=>{
   if(sql.includes('ac_verify_runs'))return {rowCount:1,rows:[{context_id:contextId}]};
   const asked=params?.[0];
   return {rowCount:asked===primaryProjectId?1:0,rows:[]};
  }}} as unknown as Ledger;
  const seen:{achadoIds?:string[];epoch?:number}={};
  const recheck=async(_principal:string,auth:{epoch:number},input:{achadoIds:string[]})=>{
   seen.achadoIds=input.achadoIds;seen.epoch=auth.epoch;
   return {results:[{id:'ACH-001',status:'fechado' as const}]};
  };
  const runtime={projectId,nativeExecutionReady:false} as CezarRuntime;
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  const body=JSON.stringify({achadoIds:['ACH-001']});
  const path=`/api/v1/ac/personal/verificacoes/${runId}/reverificar`;
  const absent=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
  });
  const hidden=await absent.request(path,{method:'POST',headers,body});
  assert.equal(hidden.status,403);
  assert.deepEqual(await hidden.json(),{error:'CANONICAL_HAPPIER_REQUIRED'});
  const app=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
   personalVerification:{recheck},
  });
  const done=await app.request(path,{method:'POST',headers,body});
  assert.equal(done.status,200);
  assert.equal(done.headers.get('cache-control'),'no-store');
  assert.deepEqual(await done.json(),{results:[{id:'ACH-001',status:'fechado'}]});
  assert.deepEqual(seen.achadoIds,['ACH-001']);
  assert.equal(seen.epoch,1);
  assert.equal((await app.request(path,{method:'POST',headers,body:'{}'})).status,400);
  const tooMany=Array.from({length:21},(_,index)=>`ACH-${String(index+1).padStart(3,'0')}`);
  let called=false;
  const limited=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
   personalVerification:{recheck:async()=>{called=true;return {results:[]};}},
  });
  const overflow=await limited.request(path,{method:'POST',headers,body:JSON.stringify({achadoIds:tooMany})});
  assert.equal(overflow.status,400);
  assert.deepEqual(await overflow.json(),{error:'INVALID_CONTRACT'});
  assert.equal(called,false);
  const historical=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
   personalVerification:{recheck:async()=>{throw new Refusal(VERIFY_RECHECK_NEW_EXAM_REQUIRED,409);}},
  });
  const historicalRes=await historical.request(path,{method:'POST',headers,body});
  assert.equal(historicalRes.status,409);
  assert.deepEqual(await historicalRes.json(),{
   error:VERIFY_RECHECK_NEW_EXAM_REQUIRED,
   guidance:VERIFY_RECHECK_NEW_EXAM_GUIDANCE,
  });
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a rota propaga Refusal 409 de uma execução já em andamento',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-conflict-')));
 try{
  let started=false;
  const start=async()=>{
   started=true;
   throw new Refusal('VERIFY_ALREADY_RUNNING',409);
  };
  const app=api(root,'primary',start);
  const response=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:'{}'});
  assert.equal(started,true);
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'VERIFY_ALREADY_RUNNING'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DELETE descarta o relatório e o diretório de ferramentas, recusa outro dono e um symlink',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-discard-')));
 const runId='00000000-0000-4000-8000-0000000000ab';
 const directoryName='20261117-010203-00000000-seguranca';
 const outside=join(root,'fora');
 try{
  const project=join(root,'verificacoes',primaryProjectId);
  const report=join(project,directoryName);
  const tools=join(project,'ferramentas',runId);
  await mkdir(report,{recursive:true,mode:0o700});
  await mkdir(tools,{recursive:true,mode:0o700});
  await chmod(join(root,'verificacoes'),0o700);
  await chmod(project,0o700);
  await chmod(join(project,'ferramentas'),0o700);
  await writeFile(join(report,'run.json'),`${JSON.stringify({
   id:runId,directoryName,createdAt:'2026-11-17T01:02:03.000Z',
   counts:{alta:0,media:0,baixa:0,informativa:0},note:'descartar',
  })}\n`,{mode:0o600});
  await writeFile(join(tools,'gitleaks.json'),'{"secret":"x"}\n',{mode:0o600});
  const headers={authorization:'Bearer owner'};
  const path=`/api/v1/ac/personal/verificacoes/${runId}`;
  const app=api(root,'primary');
  const stranger=await api(root,'none').request(path,{method:'DELETE',headers});
  assert.equal(stranger.status,403);
  assert.deepEqual(await stranger.json(),{error:'PROJECT_OWNER_REQUIRED'});
  assert.equal((await stat(report)).isDirectory(),true);
  assert.equal((await stat(tools)).isDirectory(),true);
  assert.equal((await app.request(path,{method:'DELETE'})).status,401);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request(path,{method:'DELETE',headers})).status,404);
  const removed=await app.request(path,{method:'DELETE',headers});
  assert.equal(removed.status,200);
  assert.equal(removed.headers.get('cache-control'),'no-store');
  assert.deepEqual(await removed.json(),{removed:true});
  await assert.rejects(stat(report));
  await assert.rejects(stat(tools));
  const again=await app.request(path,{method:'DELETE',headers});
  assert.equal(again.status,200);
  assert.deepEqual(await again.json(),{removed:true});
  await mkdir(outside,{recursive:true});
  await writeFile(join(outside,'gitleaks.json'),'fora\n');
  await mkdir(join(project,'ferramentas'),{recursive:true});
  await symlink(outside,join(project,'ferramentas',runId));
  const refused=await app.request(path,{method:'DELETE',headers});
  assert.equal(refused.status,403);
  assert.deepEqual(await refused.json(),{error:'VERIFY_PATH_FORBIDDEN'});
  assert.equal(await readFile(join(outside,'gitleaks.json'),'utf8'),'fora\n');
  assert.equal((await lstat(join(project,'ferramentas',runId))).isSymbolicLink(),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
