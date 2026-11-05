import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm,readFile,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {Installation,initializeInstallation} from '../src/installation.ts';
import {inspectInstallationReadiness} from '../src/installation-readiness.ts';
import {digest} from '../src/contracts.ts';
import type {Ledger} from '../src/ledger.ts';
import type pg from 'pg';
import {createServer} from 'node:net';
import {Ledger as RealLedger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('readiness reports local facts without writing or exposing configuration',async()=>{
 const original=process.cwd(),root=await mkdtemp(join(tmpdir(),'ac-readiness-'));
 try{
  process.chdir(root);const repo=join(root,'repo'),privateDir=join(root,'private');await mkdir(repo);await mkdir(privateDir,{mode:0o700});
  execFileSync('/usr/bin/git',['-C',repo,'init','-q']);await chmod(repo,0o755);await chmod(join(repo,'.git'),0o755);
  const key=Buffer.alloc(32,61);await writeFile(join(privateDir,'browser-session.key'),key,{mode:0o600});
  const web=join(root,'upstream/cezar/packages/cezar/web/dist');await mkdir(join(web,'assets'),{recursive:true});
  await writeFile(join(web,'index.html'),'<script type="module" src="/assets/app.js"></script>');await writeFile(join(web,'assets/app.js'),'fixture');
  const config=Installation.parse({schemaVersion:1,mode:'administration-only',databaseUrl:'postgresql://private-user:private-password@localhost/private-db',dataDirectory:privateDir,
   project:{id:randomUUID(),label:'Secret label',repo,owner:'private-owner'},
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}});
  const folder=new URL('../db/migrations/',import.meta.url),files=(await readdir(folder)).filter(f=>/^\d+_.+\.sql$/.test(f));
  const migrations=await Promise.all(files.map(async file=>({version:Number(file.split('_')[0]),digest:digest(await readFile(new URL(file,folder),'utf8'))})));
  const calls:string[]=[];let altered=false,offline=false,registeredRepo=repo,closed=0;
  const ledger={pool:{options:{connectionString:config.databaseUrl}}} as unknown as Ledger;
  const clientFactory=()=>({connect:async()=>{},end:async()=>{closed++;},connection:{stream:{destroy(){}}},query:async(query:string|{text:string})=>{
   const text=typeof query==='string'?query:query.text;calls.push(text);if(offline)throw Error('secret database error');
   if(text==='SELECT 1')return {rows:[{'?column?':1}]};
   if(text.includes('ac_schema_migrations'))return {rows:altered?migrations.slice(1):migrations};
   if(text.includes('unnest('))return {rows:[{matched:1}]};
   if(text.includes('SELECT repo FROM'))return {rows:[{repo:registeredRepo}]};
   throw Error('unexpected query');
  }}) as unknown as pg.Client;
  const inspect=()=>inspectInstallationReadiness(ledger,config,{clientFactory}),status=(value:Awaited<ReturnType<typeof inspect>>,code:string)=>value.checks.find(c=>c.code===code)?.status;
  const initial=await inspect();assert(initial.checks.every(check=>check.status==='ok'),JSON.stringify(initial));
  const encoded=JSON.stringify(initial);for(const secret of [root,repo,privateDir,config.databaseUrl,config.project.owner,config.project.id,key.toString('hex')])assert(!encoded.includes(secret));
  assert(calls.every(sql=>/^SELECT\b/.test(sql.trim())));assert.deepEqual(await readFile(join(privateDir,'browser-session.key')),key);
  await chmod(join(privateDir,'browser-session.key'),0o644);assert.equal(status(await inspect(),'browser_session_key'),'blocked');
  await chmod(join(privateDir,'browser-session.key'),0o600);await rm(join(privateDir,'browser-session.key'));await symlink(join(repo,'missing'),join(privateDir,'browser-session.key'));
  assert.equal(status(await inspect(),'browser_session_key'),'blocked');
  altered=true;assert.equal(status(await inspect(),'migrations'),'blocked');altered=false;
  registeredRepo=join(root,'not-a-repository');assert.equal(status(await inspect(),'git_repositories'),'blocked');
  offline=true;const unavailable=await inspect();assert.equal(status(unavailable,'database'),'unknown');assert.equal(status(unavailable,'migrations'),'unknown');assert(!JSON.stringify(unavailable).includes('secret database error'));
  assert.equal(closed,6,'each inspection closes its own client');
  let destroyed=false,ended=false;
  const stuck=()=>({connect:()=>new Promise<void>(()=>{}),end:async()=>{ended=true;},connection:{stream:{destroy(){destroyed=true;}}},query:async()=>{throw Error('unexpected query');}}) as unknown as pg.Client;
  const timedOut=await inspectInstallationReadiness(ledger,config,{clientFactory:stuck});
  assert.equal(status(timedOut,'database'),'unknown');assert(destroyed);assert(ended);
  const sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const stalledUrl=`postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,actualConfig={...config,databaseUrl:stalledUrl},actualLedger=new RealLedger(stalledUrl);
  try{
   const actual=await inspectInstallationReadiness(actualLedger,actualConfig);
   assert.equal(status(actual,'database'),'unknown');
  }finally{await actualLedger.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }finally{process.chdir(original);await rm(root,{recursive:true,force:true});}
});

test('readiness and CLI inspect a newly initialized isolated PostgreSQL database without effects',
 {timeout:30000,skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const database=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'readiness'),ledger=new RealLedger(database.url);
 const root=await mkdtemp(join(tmpdir(),'ac-readiness-pg-'));
 try{
  const repo=join(root,'repo'),privateDir=join(root,'private');await mkdir(repo);await chmod(repo,0o755);
  execFileSync('/usr/bin/git',['-C',repo,'init','-q']);await chmod(join(repo,'.git'),0o755);
  const config=Installation.parse({schemaVersion:1,mode:'administration-only',databaseUrl:database.url,dataDirectory:privateDir,
   project:{id:randomUUID(),label:'Readiness fixture',repo,owner:'synthetic-readiness-owner'},
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}});
  await initializeInstallation(config,ledger);
  const counts=async()=>Object.fromEntries(await Promise.all(['ac_intents','ac_capacity_grants','ac_outbox'].map(async table=>
   [table,Number((await ledger.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)])));
  const before=await counts();assert.deepEqual(before,{ac_intents:0,ac_capacity_grants:0,ac_outbox:0});
  const report=await inspectInstallationReadiness(ledger,config);
  for(const code of ['database','migrations','registered_projects'])assert.equal(report.checks.find(check=>check.code===code)?.status,'ok',code);
  assert.deepEqual(await counts(),before);
  const configFile=join(root,'installation.json');await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const inspectCli=(expected:typeof report)=>{
   const result=spawnSync(process.execPath,['--import','tsx','src/server-main.ts','inspect',configFile],{encoding:'utf8',timeout:15000});
   assert.ifError(result.error);assert.equal(result.signal,null);
   assert.equal(result.status,expected.checks.every(check=>check.status==='ok')?0:2);
   assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),expected);
   for(const sensitive of [root,repo,privateDir,database.url,config.project.owner,config.project.id]){
    assert(!result.stdout.includes(sensitive));assert(!result.stderr.includes(sensitive));
   }
  };
  inspectCli(report);
  // A readable report with a blocked check is a diagnostic outcome (exit 2),
  // not a command failure; force one regardless of the checkout's web assets.
  await chmod(join(privateDir,'browser-session.key'),0o644);
  const blocked=await inspectInstallationReadiness(ledger,config);
  assert.equal(blocked.checks.find(check=>check.code==='browser_session_key')?.status,'blocked');
  inspectCli(blocked);
  assert.deepEqual(await counts(),before);
 }finally{await ledger.close();await database.close();await rm(root,{recursive:true,force:true});}
});
