import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Installation,initializeInstallation,sessionKey,loadInstallation,prepareInstallationOperator,readPrivateFile} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
test('private installation initializes without fixtures, manager or worker; keys survive restart and unsafe files are refused',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'installation'),ledger=new Ledger(isolated.url),root=await mkdtemp(join(tmpdir(),'ac-installation-'));
 try{
  const repo=join(root,'repo'),state=join(root,'private');await mkdir(repo);execFileSync('git',['-C',repo,'init','-q']);
  const config=Installation.parse({schemaVersion:1,mode:'administration-only',databaseUrl:isolated.url,dataDirectory:state,
   project:{id:randomUUID(),label:'Disposable installation',repo,owner:'synthetic-installation-owner'},
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}});
  const file=join(root,'config.json');await writeFile(file,JSON.stringify(config),{mode:0o600});
  assert.deepEqual(await loadInstallation(file),config);
  await initializeInstallation(config,ledger);await initializeInstallation(config,ledger);
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
