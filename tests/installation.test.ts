import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Installation,initializeInstallation,sessionKey,loadInstallation,prepareInstallationOperator,readPrivateFile} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {Projects,ProjectRuntimes} from '../src/projects.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {projectsResponseSchema} from '../upstream/cezar/packages/contract/src/projects.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
test('private installation initializes without fixtures, manager or worker; keys survive restart and unsafe files are refused',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'installation'),ledger=new Ledger(isolated.url),root=await mkdtemp(join(tmpdir(),'ac-installation-'));
 try{
  const repo=join(root,'repo'),repo2=join(root,'repo2'),state=join(root,'private');await mkdir(repo);await mkdir(repo2);execFileSync('git',['-C',repo,'init','-q']);execFileSync('git',['-C',repo2,'init','-q']);
  const config=Installation.parse({schemaVersion:1,mode:'administration-only',databaseUrl:isolated.url,dataDirectory:state,
   project:{id:randomUUID(),label:'Disposable installation',repo,owner:'synthetic-installation-owner'},projects:[{id:randomUUID(),label:'Second project',repo:repo2,owner:'synthetic-second-owner'}],
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}});
  const file=join(root,'config.json');await writeFile(file,JSON.stringify(config),{mode:0o600});
  assert.deepEqual(await loadInstallation(file),config);
  await initializeInstallation(config,ledger);await initializeInstallation(config,ledger);
  assert.deepEqual((await ledger.pool.query('SELECT principal_id FROM ac_control_admins ORDER BY principal_id')).rows.map(r=>r.principal_id),['synthetic-installation-owner']);
  const projects=new Projects(ledger);assert.equal((await projects.list('synthetic-installation-owner')).length,1);assert.equal((await projects.list('synthetic-second-owner'))[0].id,config.projects[0].id);assert.equal(await projects.authorized('synthetic-installation-owner',config.projects[0].id),null);
  const runtimes=new ProjectRuntimes(async()=>{throw Error('must not start runtime for list');});
  const gateway=createProjectGateway({projects,runtimes,defaultProjectId:config.project.id,authenticate:async r=>r.headers.get('x-test-principal'),publicFetch:async()=>new Response(),appFor:()=>{throw Error('must not create app for list');}});
  const native=await gateway(new Request('http://localhost/api/v1/projects',{headers:{'x-test-principal':'synthetic-installation-owner'}}));
  const body=projectsResponseSchema.parse(await native.json());assert.equal(body.projects.length,1);assert.equal(body.projects[0].root,repo);assert.equal(body.projects[0].status,'ok');assert.equal(body.projects[0].id,config.project.id);assert.ok(!JSON.stringify(body).includes(repo2));assert.equal(body.projectsDir,'');
  const secondary=await gateway(new Request('http://localhost/api/v1/projects',{headers:{'x-test-principal':'synthetic-second-owner'}}));
  const other=projectsResponseSchema.parse(await secondary.json());assert.equal(other.projects.length,1);assert.equal(other.bootProject,config.projects[0].id);assert.equal(other.projects[0].root,repo2);assert.ok(!other.projects.some(p=>p.root===repo));
  assert.equal((await gateway(new Request('http://localhost/api/v1/projects'))).status,401);
  assert.equal((await gateway(new Request('http://localhost/api/v1/p/'+config.project.id+'/projects',{headers:{'x-test-principal':'synthetic-second-owner'}}))).status,403);
  await runtimes.close();
  assert.equal((await ledger.pool.query('SELECT 1 FROM ac_capacity_config')).rowCount,0);
  const runtime=new CezarRuntime(ledger,repo,config.project.id);
  try{await runtime.start('administration-only');}finally{await runtime.close();}
  const key=await sessionKey(config);assert.equal(key.length,32);assert.deepEqual(await sessionKey(config),key);
  const boot=await prepareInstallationOperator(config,ledger);assert.equal(boot.expiresInSeconds,600);assert.match((await readFile(boot.file,'utf8')).trim(),/^[a-f0-9]{64}$/);
  for(const table of ['ac_managers','ac_intents','ac_capacity_grants'])assert.equal(Number((await ledger.pool.query(`SELECT count(*) n FROM ${table}`)).rows[0].n),0);
  await chmod(file,0o644);await assert.rejects(loadInstallation(file),/UNSAFE_PRIVATE_FILE/);await chmod(file,0o600);
  const link=join(root,'link');await symlink(file,link);await assert.rejects(readPrivateFile(link));
  assert.throws(()=>Installation.parse({...config,http:{...config.http,publicOrigin:'http://public.invalid'}}));
  assert.throws(()=>Installation.parse({...config,dataDirectory:join(repo,'secrets')}));
  assert.throws(()=>Installation.parse({...config,mode:'execute-all'}));
  await assert.rejects(initializeInstallation({...config,project:{...config.project,label:'conflicting'}},ledger),/INSTALLATION_PROJECT_CONFLICT/);
 }finally{await ledger.close();await isolated.close();await rm(root,{recursive:true,force:true});}
});
