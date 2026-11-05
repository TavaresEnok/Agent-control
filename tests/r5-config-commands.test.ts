import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));

test('configured CLI exports and reads private usable configuration without initialization or execution',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('AC_TEST_DATABASE_URL_REQUIRED');
 const fixture=await isolatedDatabase(base,'r5cfgcli'),ledger=new Ledger(fixture.url),folder=await mkdtemp(join(tmpdir(),'ac-r5-config-cli-'));
 try{
  await ledger.migrate();const projectId=randomUUID(),owner='synthetic-config-owner';
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectId,'CLI semantic label']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectId,owner]);await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  for(const dir of ['repo','private','keys','exports','empty-home'])await mkdir(join(folder,dir),{mode:0o700});
  const configPath=join(folder,'installation.json'),descriptor=join(folder,'descriptor.json'),artifactFile=join(folder,'exports','configuration.ac'),keyFile=join(folder,'keys','configuration.key');
  await writeFile(keyFile,randomBytes(32),{mode:0o600});
  const recoveryInventory={directory:join(folder,'external-catalog'),installationId:randomUUID(),catalogId:randomUUID(),manifestHash:'a'.repeat(64),epoch:2};
  const config={recoveryInventory,schemaVersion:1,mode:'administration-only',databaseUrl:fixture.url,dataDirectory:join(folder,'private'),projectRoots:[],
   project:{id:projectId,label:'CLI semantic label',repo:join(folder,'repo'),owner},
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const request=async(action:'export'|'read')=>writeFile(descriptor,JSON.stringify({action,projectId,artifactFile,keyFile}),{mode:0o600});
  const run=(command:string)=>execute(process.execPath,['--import','tsx','src/server-main.ts',command,configPath,descriptor],{cwd:root,env:{...process.env,HOME:join(folder,'empty-home'),DO_NOT_TRACK:'1'},timeout:15000,maxBuffer:4*1024*1024});
  await request('export');const exported=await run('config-export');assert.equal(JSON.parse(exported.stdout).state,'exported');assert.equal((await stat(artifactFile)).mode&0o777,0o600);
  const original=await readFile(artifactFile);assert(!original.includes(Buffer.from('CLI semantic label')));assert(!original.includes(Buffer.from('disposable_r4_only')));
  await assert.rejects(run('config-export'));assert.deepEqual(await readFile(artifactFile),original);
  await request('read');const inspected=await run('config-read'),dto=JSON.parse(inspected.stdout);assert.equal(dto.project.id,projectId);assert.equal(dto.project.label,'CLI semantic label');assert.equal(dto.restorable,false);assert.deepEqual(dto.installation.recoveryInventory,{...recoveryInventory,directory:{rebindNeeded:true,kind:'private_path',id:'installation.recoveryInventory.directory'}});assert(!inspected.stdout.includes(recoveryInventory.directory));assert(!inspected.stdout.includes(fixture.url));
  await ledger.pool.query('DELETE FROM ac_control_admins WHERE principal_id=$1',[owner]);await assert.rejects(run('config-read'));
  for(const table of ['ac_intents','ac_operations','ac_capacity_grants','ac_workflow_runtime_instances'])assert.equal((await ledger.pool.query('SELECT 1 FROM '+table)).rowCount,0,table);
 }finally{await ledger.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});
