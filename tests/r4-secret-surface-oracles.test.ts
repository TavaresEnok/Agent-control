import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectBundleObjects,reconstructedFields} from './fixtures/r4-secret-surface-oracles.ts';

const rejectSecret=(secret:string)=>(bytes:Buffer)=>assert.equal(bytes.includes(Buffer.from(secret)),false,'NEGATIVE_CANARY_DETECTED');
test('delta oracle rejects a credential split across events and retains separate fields',()=>{
 const secret='synthetic-negative-'+randomBytes(24).toString('hex');
 const events=[{type:'item.started',stepId:'s',item:{id:'i',kind:'assistant',text:'safe '}},
  {type:'item.delta',stepId:'s',itemId:'i',field:'text',delta:secret.slice(0,12)},
  {type:'item.delta',stepId:'s',itemId:'i',field:'text',delta:secret.slice(12)+' safe'},
  {type:'item.delta',stepId:'other',itemId:'i',field:'text',delta:'independent'}];
 assert.equal(JSON.stringify(events).includes(secret),false,'OLD_SERIALIZED_ORACLE_FALSE_NEGATIVE');
 const fields=reconstructedFields(events,'r');assert.equal(fields.get(JSON.stringify(['r','s','i','text'])),'safe '+secret+' safe');
 assert.equal(fields.get(JSON.stringify(['r','other','i','text'])),'independent');
 assert.throws(()=>rejectSecret(secret)(Buffer.from([...fields.values()].join('\n'))),/NEGATIVE_CANARY_DETECTED/);
});
for(const location of ['head-blob','previous-commit','exported-other-ref'] as const)test('Git bundle oracle rejects canary in '+location,async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-r4-bundle-negative-')),repo=join(root,'repo'),secret='synthetic-negative-'+randomBytes(24).toString('hex');
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const commit=()=>{git('add','safe.txt');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');};
 try{
  execFileSync('git',['init','-q','-b','main',repo]);await writeFile(join(repo,'safe.txt'),'safe baseline\n');commit();
  if(location==='exported-other-ref')git('checkout','-qb','exported-history');
  await writeFile(join(repo,'safe.txt'),secret+'\n');commit();
  if(location==='previous-commit'){await writeFile(join(repo,'safe.txt'),'safe current content\n');commit();}
  if(location==='exported-other-ref')git('checkout','-q','main');
  const bundle=join(root,'artifact.bundle');git('bundle','create',bundle,'--all');
  if(location!=='head-blob')assert.equal(git('show','HEAD:safe.txt').includes(secret),false);
  await assert.rejects(inspectBundleObjects(bundle,rejectSecret(secret)),/NEGATIVE_CANARY_DETECTED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
