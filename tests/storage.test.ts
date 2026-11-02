import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,symlink,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.ts';
import {StoragePool} from '../src/storage.ts';
import {Capacity} from '../src/capacity.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('storage pool refuses low-space admission and preserves active, changed, held and unknown data',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(url,'storage'),ledger=new Ledger(database.url),capacity=new Capacity(ledger);
 const path=await mkdtemp(join(tmpdir(),'ac-storage-')),principal='storage-'+randomUUID(),project=randomUUID(),poolId=randomUUID();
 const storage=new StoragePool(ledger,poolId,path),account=randomUUID(),profile=randomUUID();
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Storage synthetic fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'storage-fixture',model:'worker',efforts:['medium'],roles:['programmer'],source:'synthetic://storage'});
  await capacity.addAccount(principal,project,{id:account,provider:'storage-fixture',label:'Storage fixture',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://storage',maxConcurrent:8});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'worker',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://storage',ttlSeconds:3600});
  const policy=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profile],emergency:[]}}});
  const context=await ledger.createContext(principal,project,randomUUID()),authority=await ledger.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await capacity.assignPolicy(principal,context,policy);
  const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:storage'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority);
  const input={id:randomUUID(),grantId:grant.id,category:'disposable_cache' as const,bytes:16,retainSeconds:0};
  const measured=await statfs(path,{bigint:true}),available=Number(measured.bavail*measured.bsize);
  await storage.configure(principal,{minFreeBytes:available+1024*1024,budgetBytes:32,maxObjectBytes:16},0);
  await assert.rejects(storage.reserve(principal,authority,input),/STORAGE_LOW_SPACE/);
  assert.equal((await ledger.pool.query('SELECT count(*)::int count FROM ac_storage_allocations')).rows[0].count,0);
  await storage.configure(principal,{minFreeBytes:0,budgetBytes:32,maxObjectBytes:16},1);
  const second={...input,id:randomUUID()},third={...input,id:randomUUID()};
  const result=await Promise.allSettled([storage.reserve(principal,authority,input),storage.reserve(principal,authority,second),storage.reserve(principal,authority,third)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(result.filter(r=>r.status==='rejected'&&/STORAGE_BUDGET_EXHAUSTED/.test(String(r.reason))).length,1);
  const admitted=[input,second,third].filter((_,i)=>result[i].status==='fulfilled');
  assert.equal((await storage.reserve(principal,authority,admitted[0])).id,admitted[0].id);
  for(const item of admitted)await storage.publish(principal,authority,item.id,Buffer.from('synthetic-cache'));
  await storage.publish(principal,authority,admitted[0].id,Buffer.from('synthetic-cache'));
  await assert.rejects(storage.releaseForRetention(principal,admitted[0].id),/STORAGE_ACTIVE_GRANT/);
  assert.equal((await storage.plan(principal)).candidates.length,0);
  await writeFile(join(path,'unknown.txt'),'preserve unknown file');
  const external=join(tmpdir(),'ac-storage-outside-'+randomUUID());await writeFile(external,'outside marker');
  try{
   await capacity.transition(principal,grant.id,authority,'released',{processId:'synthetic-never-started',state:'not_started'});
   await storage.releaseForRetention(principal,admitted[0].id);
   const plan=await storage.plan(principal);assert.equal(plan.candidates.length,1);
   await writeFile(join(path,admitted[0].id+'.blob'),'changed-content');
   await assert.rejects(storage.apply(principal,plan),/STORAGE_OBJECT_CHANGED|STORAGE_OBJECT_UNSAFE/);
   await rm(join(path,admitted[0].id+'.blob'));await symlink(external,join(path,admitted[0].id+'.blob'));
   await assert.rejects(storage.apply(principal,plan),/ELOOP|STORAGE_OBJECT/);
   assert.equal(await readFile(external,'utf8'),'outside marker');
   await rm(join(path,admitted[0].id+'.blob'));await writeFile(join(path,admitted[0].id+'.blob'),'synthetic-cache',{mode:0o600});
   assert.deepEqual(await storage.apply(principal,plan),{removed:1});
   assert.equal(await readFile(join(path,'unknown.txt'),'utf8'),'preserve unknown file');
   assert.equal(await readFile(join(path,admitted[1].id+'.blob'),'utf8'),'synthetic-cache');
   assert.equal((await storage.status(principal)).allocations.find(row=>row.state==='deleted').objects,1);
   await assert.rejects(storage.plan('not-an-admin'),/CONTROL_ADMIN_REQUIRED/);
  }finally{await rm(external,{force:true});}
 }finally{await ledger.close();await database.close();await rm(path,{recursive:true,force:true});}
});
