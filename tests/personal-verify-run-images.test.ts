import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Installation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {defaultVerifyRunImages,protectedDigests} from '../src/personal-artifact-retention.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const image=(seed:string)=>'sha256:'+createHash('sha256').update(seed).digest('hex');
const url=process.env.AC_TEST_DATABASE_URL;

test('the verification runs keep the image of every open run and, per project and module not covered by the common image, of the latest finished one',{skip:!url,timeout:120000},async()=>{
 const fixture=await isolatedDatabase(url!,'runimages');
 const ledger=new Ledger(fixture.url);
 try{
  await ledger.migrate();
  const one=randomUUID(),two=randomUUID();
  const client=await ledger.pool.connect();
  try{
   // Only ac_verify_runs is read: its parents (projects, contexts, intents) and the context guard are left out for this session.
   await client.query("SET session_replication_role='replica'");
   let minute=0;
   const run=async(project:string,module:string,status:string,collector:string|null,pending=false)=>{
    minute+=1;
    await client.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,module,collector_image,collector_container_token,collector_container_id,collector_start_pending,created_at)
     VALUES($1,$2,$3,$4,'owner',$5,$6,'pending',$7,$8,$9,$10,$11,timestamptz '2026-11-01T00:00:00Z'+$12*interval '1 minute')`,
     [randomUUID(),project,randomUUID(),randomUUID(),'a'.repeat(40),status,module,collector,pending?randomUUID():null,pending?'c'.repeat(64):null,pending,minute]);
   };
   // Project one, module qa: an open run first, a finished one waiting for its container removal, an older and a newer finished run.
   await run(one,'qa','running',image('qa-open'));
   await run(one,'qa','done',image('qa-container'),true);
   await run(one,'qa','done',image('qa-older'));
   await run(one,'qa','failed',image('qa-latest'));
   await run(one,'qa','done',null);
   // Project one, module 1 (never covered by the common image) and project two, module qa.
   await run(one,'verify','done',image('verify-older'));
   await run(one,'verify','done',image('verify-latest'));
   await run(two,'qa','done',image('two-qa-latest'));
   await client.query("SET session_replication_role='origin'");
  }finally{client.release();}
  const config={databaseUrl:fixture.url} as Installation;
  const sorted=(list:string[])=>[...list].sort();
  // Not covered: open runs, the run with a pending container and the latest finished run of each project and module.
  assert.deepEqual(sorted(await defaultVerifyRunImages(config)),sorted([image('qa-open'),image('qa-container'),image('qa-latest'),image('verify-latest'),image('two-qa-latest')]));
  // Covered by the common image: the finished runs of the modules 2 to 9 keep nothing; module 1 keeps its latest.
  assert.deepEqual(sorted(await defaultVerifyRunImages(config,undefined,true)),sorted([image('qa-open'),image('qa-container'),image('verify-latest')]));
  // The project being removed keeps nothing of its own.
  assert.deepEqual(sorted(await defaultVerifyRunImages(config,one)),[image('two-qa-latest')]);
  assert.deepEqual(sorted(await defaultVerifyRunImages(config,two)),sorted([image('qa-open'),image('qa-container'),image('qa-latest'),image('verify-latest')]));
 }finally{await ledger.close();await fixture.close();}
});

test('the image retention tells the run query whether the common image covers the modules: simple isolation, a valid pin and the image on the daemon',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-run-images-')));
 try{
  const data=join(root,'data');
  await mkdir(data,{mode:0o700});
  const common=image('common');
  const known=new Set<string>();
  const docker=async(args:string[])=>{
   if(args[0]==='info')return {code:0,stdout:'daemon-run-images\n',stderr:''};
   if(args[0]==='image'&&args[1]==='inspect'&&known.has(args.at(-1)!))return {code:0,stdout:args.at(-1)+'\n',stderr:''};
   return {code:1,stdout:'',stderr:'No such image'};
  };
  const seen:boolean[]=[];
  const deps={productRoot:join(root,'no-product'),sharedRefsRoot:join(root,'refs'),verifyRunImages:async(_config:Installation,options:{commonCovers:boolean})=>{seen.push(options.commonCovers);return [];}};
  const config=(isolation?:string)=>({activation:'personal',dataDirectory:data,databaseUrl:'postgres://invalid.example/none',project:{id:randomUUID(),label:'p',repo:join(root,'repo'),owner:'owner'},projects:[],...(isolation?{isolation}:{})}) as unknown as Installation;
  await protectedDigests(config(),deps,docker);
  await writeFile(join(data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  await protectedDigests(config(),deps,docker);
  known.add(common);
  await protectedDigests(config('strict'),deps,docker);
  await protectedDigests(config(),deps,docker);
  assert.deepEqual(seen,[false,false,false,true]);
 }finally{await rm(root,{recursive:true,force:true});}
});
