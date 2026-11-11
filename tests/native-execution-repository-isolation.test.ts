import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {Refusal,digest} from '../src/contracts.ts';
import {GitArtifacts} from '../src/git.ts';
import {Quality} from '../src/quality.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a job is admitted, recovered and imported only in its own allowlisted repository',{skip:!process.env.AC_TEST_DATABASE_URL},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'f2iso'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-exec-iso-'));
 try{
  await db.migrate();
  const capacity=new Capacity(db),principal='iso-'+randomUUID();
  const repoA=join(area,'repo-a'),repoB=join(area,'repo-b'),outside=join(area,'outside'),trap=join(area,'trap'),linkA=join(area,'link-a'),spool=join(area,'spool'),accounts=join(area,'accounts');
  for(const path of [repoA,repoB,outside,spool,accounts])await mkdir(path,{mode:0o700});
  await symlink(outside,trap);await symlink(repoA,linkA);
  const commit=(repo:string)=>{execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','base'],{stdio:'ignore'});};
  commit(repoA);commit(repoB);commit(outside);
  const stamp=(repo:string)=>({head:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),objects:execFileSync('git',['-C',repo,'count-objects'],{encoding:'utf8'})});
  const projectA=randomUUID(),projectB=randomUUID(),projectOutside=randomUUID(),projectLink=randomUUID();
  const admit=async(project:string,repo:string)=>{
   await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolation']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
   await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
   const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
   return {context,authority,intent};
  };
  await admit(projectA,repoA);
  const owned=await admit(projectB,repoB),escaped=await admit(projectOutside,trap),linked=await admit(projectLink,linkA);
  const account=randomUUID(),profile=randomUUID(),subject='a'.repeat(64);
  await capacity.addAccount(principal,projectB,{id:account,provider:'codex',label:'dormant fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  const keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const shared={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const pinned=new NativeExecutionSupervisor(db,{...shared,repository:repoA,protectedRepositories:[repoA,repoB]});
  const open=new NativeExecutionSupervisor(db,{...shared,protectedRepositories:[repoA,repoB]});
  const closed=new NativeExecutionSupervisor(db,{...shared,protectedRepositories:[repoA]});
  const request=(intent:{id:string;operation_id:string})=>NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:randomUUID(),sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  const grant=randomUUID(),session=randomUUID(),jobId=randomUUID();
  const planted=NativeExecutionRequest.parse({jobId,intentId:owned.intent.id,grantId:grant,sessionId:session,base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'reserved')`,[grant,randomUUID(),owned.intent.id,owned.context,owned.authority.epoch,account,profile,projectB,digest(planted)]);
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','uncertain')`,[jobId,grant,owned.intent.id,owned.context,owned.authority.epoch,session,account,profile,digest({fixture:true}),pinned.executorDigest,pinned.keyFingerprint,digest(planted),planted.base]);
  const root=join(spool,jobId);await mkdir(root,{mode:0o700});await chmod(root,0o700);await writeFile(join(root,'request.json'),JSON.stringify(planted),{mode:0o600});await chmod(join(root,'request.json'),0o600);
  const quality=new Quality(db,randomBytes(32),new GitArtifacts(repoA));
  const rejects=async(run:Promise<unknown>,expected:string)=>{
   await assert.rejects(run,(error:unknown)=>{assert.ok(error instanceof Refusal);assert.equal(error.code,expected);return true;});
  };
  const jobs=async(id:string)=>Number((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs WHERE id=$1',[id])).rows[0].n);
  const before={a:stamp(repoA),b:stamp(repoB)};
  const fresh=request(owned.intent);
  await rejects(pinned.start(principal,owned.authority,fresh),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  assert.equal(await jobs(fresh.jobId),0);
  await rejects(pinned.reconcileRegistered(principal,owned.authority,jobId),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(pinned.registerArtifact(principal,owned.authority,jobId,quality),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(open.start(principal,owned.authority,request(owned.intent)),'NATIVE_EXECUTION_NOT_ELIGIBLE');
  assert.equal(await jobs(owned.intent.operation_id),0);
  await rejects(closed.start(principal,owned.authority,request(owned.intent)),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(closed.reconcileRegistered(principal,owned.authority,jobId),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(closed.registerArtifact(principal,owned.authority,jobId,quality),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(closed.start(principal,escaped.authority,request(escaped.intent)),'NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  await rejects(closed.start(principal,linked.authority,request(linked.intent)),'NATIVE_EXECUTION_NOT_ELIGIBLE');
  assert.equal(await jobs(jobId),1);
  assert.deepEqual({a:stamp(repoA),b:stamp(repoB)},before);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
