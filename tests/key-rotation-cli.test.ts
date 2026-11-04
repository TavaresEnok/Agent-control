import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdtemp,realpath,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {executeKeyRotationPlan} from '../src/key-rotation-cli.ts';
import {executeContextKeyRotatePlan} from '../src/context-vault-cli.ts';
import {KEY_ROTATION_PHASES} from '../src/key-rotation-plan.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const secret='synthetic-key-material-do-not-print';
const sealed=[
 {id:'b-entry',keyVersion:2,state:'sealed'},
 {id:'a-entry',keyVersion:1,state:'sealed'},
];

function inventory(entries:readonly {id:string;keyVersion:number;state:string}[]){
 return {schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries};
}

async function writeDescriptor(body:unknown,mode=0o600){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'key-rotation-cli-')));
 const path=join(dir,'descriptor.json');
 await writeFile(path,typeof body==='string'?body:JSON.stringify(body),{mode:0o600});
 await chmod(path,mode);
 return {dir,path,async cleanup(){await rm(dir,{recursive:true,force:true});}};
}

function gateway(args:string[]){
 const env={...process.env};
 delete env.FORCE_COLOR;
 delete env.NO_COLOR;
 return spawnSync(process.execPath,['--import','tsx','src/server-main.ts',...args],{cwd:root,encoding:'utf8',env});
}

function assertNoSecret(text:string){
 assert.equal(text.includes(secret),false);
 assert.equal(text.includes('plaintext'),false);
}

test('dry-run command prints a deterministic plan and does not write',async()=>{
 const forward=await writeDescriptor(inventory(sealed));
 const reverse=await writeDescriptor(inventory([...sealed].reverse()));
 try{
  const first=await executeKeyRotationPlan(forward.path);
  const second=await executeKeyRotationPlan(forward.path);
  const flipped=await executeContextKeyRotatePlan(reverse.path);
  assert.equal(first.exitCode,0);
  assert.equal(second.exitCode,0);
  assert.equal(flipped.exitCode,0);
  if(first.exitCode!==0||second.exitCode!==0||flipped.exitCode!==0)return;
  assert.deepEqual(first.plan,second.plan);
  assert.deepEqual(first.plan,flipped.plan);
  assert.deepEqual(first.plan.phases,[...KEY_ROTATION_PHASES]);
  assert.deepEqual(first.plan.entries.map(entry=>`${entry.id}:${entry.keyVersion}`),['a-entry:1','b-entry:2']);
  assert.equal(first.plan.dryRun,true);
  assert.equal(first.plan.applied,false);
  assert.equal(first.plan.batchSize,32);
  assert.deepEqual(first.plan.blockers,[]);
  assert.equal(first.plan.blockedReason,undefined);
  assert.equal('oldKeyFingerprint' in first.plan,false);
  assert.equal('newKeyFingerprint' in first.plan,false);
  const run=gateway(['context-key-rotate-plan',join(forward.dir,'unused-config.json'),forward.path]);
  assert.equal(run.status,0);
  assert.equal(run.stdout,JSON.stringify(first.plan)+'\n');
  assertNoSecret(run.stdout+run.stderr);
  assert.deepEqual(await readdir(forward.dir),['descriptor.json']);
 }finally{await forward.cleanup();await reverse.cleanup();}
});

test('corrupted or uncertain inventory blocks the plan',async()=>{
 const corrupted=await writeDescriptor(inventory([{id:'kept',keyVersion:1,state:'sealed'},{id:'broken',keyVersion:4,state:'corrupted'}]));
 const uncertain=await writeDescriptor(inventory([{id:'kept',keyVersion:1,state:'sealed'},{id:'maybe',keyVersion:3,state:'uncertain'}]));
 try{
  const direct=await executeKeyRotationPlan(corrupted.path);
  assert.equal(direct.exitCode,3);
  if(direct.exitCode!==3)return;
  assert.equal(direct.plan.blockedReason,'KEY_ROTATION_ENTRY_BLOCKED');
  assert.equal(direct.plan.applied,false);
  assert.deepEqual(direct.plan.blockers,[{id:'broken',keyVersion:4,state:'corrupted'}]);
  const run=gateway(['context-key-rotate-plan',join(corrupted.dir,'unused-config.json'),corrupted.path]);
  assert.equal(run.status,3);
  assert.equal(run.stdout,JSON.stringify(direct.plan)+'\n');
  const other=await executeKeyRotationPlan(uncertain.path);
  assert.equal(other.exitCode,3);
  if(other.exitCode!==3)return;
  assert.equal(other.plan.blockedReason,'KEY_ROTATION_ENTRY_BLOCKED');
  assert.deepEqual(other.plan.blockers,[{id:'maybe',keyVersion:3,state:'uncertain'}]);
  assert.deepEqual(await readdir(corrupted.dir),['descriptor.json']);
 }finally{await corrupted.cleanup();await uncertain.cleanup();}
});

test('equal key versions block the plan',async()=>{
 const file=await writeDescriptor({schemaVersion:1,currentKeyVersion:4,nextKeyVersion:4,entries:sealed});
 try{
  const direct=await executeKeyRotationPlan(file.path);
  assert.equal(direct.exitCode,3);
  if(direct.exitCode!==3)return;
  assert.equal(direct.plan.blockedReason,'KEY_ROTATION_UNCHANGED');
  assert.equal(direct.plan.applied,false);
  assert.deepEqual(direct.plan.blockers,[]);
  const run=gateway(['context-key-rotate-plan',join(file.dir,'unused-config.json'),file.path]);
  assert.equal(run.status,3);
  assert.equal(run.stdout,JSON.stringify(direct.plan)+'\n');
  assertNoSecret(run.stdout+run.stderr);
 }finally{await file.cleanup();}
});

test('malformed descriptors are refused',async()=>{
 const broken=await writeDescriptor('{');
 const extra=await writeDescriptor({schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries:sealed,note:true});
 const loose=await writeDescriptor({schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries:sealed},0o644);
 try{
  for(const file of [broken,extra,loose]){
   const direct=await executeKeyRotationPlan(file.path);
   assert.equal(direct.exitCode,1);
   if(direct.exitCode!==1)continue;
   assert.equal(direct.code,'KEY_ROTATION_DESCRIPTOR_INVALID');
   const run=gateway(['context-key-rotate-plan',join(file.dir,'unused-config.json'),file.path]);
   assert.equal(run.status,1);
   assert.equal(run.stdout,'');
   assert.equal(run.stderr.includes('KEY_ROTATION_DESCRIPTOR_INVALID'),true);
   assertNoSecret(run.stdout+run.stderr);
  }
  const usage=gateway(['context-key-rotate-plan']);
  assert.equal(usage.status,1);
  assert.equal(usage.stdout,'');
 }finally{await broken.cleanup();await extra.cleanup();await loose.cleanup();}
});

test('a key field is refused and is not printed',async()=>{
 const bodies=[
  {schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries:sealed,key:secret},
  {schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries:sealed,currentKey:secret},
  {schemaVersion:1,currentKeyVersion:1,nextKeyVersion:2,entries:[...sealed,{id:'c-entry',keyVersion:1,state:'sealed',plaintext:secret}]},
 ];
 const files=[];
 try{
  for(const body of bodies){
   const file=await writeDescriptor(body);
   files.push(file);
   const direct=await executeKeyRotationPlan(file.path);
   assert.equal(direct.exitCode,1);
   if(direct.exitCode!==1)continue;
   assert.equal(direct.code,'KEY_ROTATION_MATERIAL_REJECTED');
   assert.equal(JSON.stringify(direct).includes(secret),false);
   const run=gateway(['context-key-rotate-plan',join(file.dir,'unused-config.json'),file.path]);
   assert.equal(run.status,1);
   assert.equal(run.stdout,'');
   assert.equal(run.stderr.trim(),'KEY_ROTATION_MATERIAL_REJECTED');
   assertNoSecret(run.stdout+run.stderr);
   assert.deepEqual(await readdir(file.dir),['descriptor.json']);
  }
 }finally{await Promise.all(files.map(file=>file.cleanup()));}
});
