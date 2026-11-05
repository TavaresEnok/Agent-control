import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {InstallationAuthority,type InstallationToken} from '../src/installation-authority.ts';
import {createInstallationAuthorityApi} from '../src/installation-authority-api.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('R3 laboratory old/new authority, durable execution, pause, renewal, rollback and signed route',{timeout:30000},async()=>{
 const database=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'r3migration'),db=new Ledger(database.url);
 const principal='r3-migration-'+randomUUID(),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
 const children=new Map<string,ChildProcess>();
 const service=new InstallationAuthority(db,async(identity,evidence)=>evidence==='child-exit-observed'&&children.has(identity)&&children.get(identity)!.exitCode!==null);
 const api=createInstallationAuthorityApi(service);
 try{
  await db.migrate();await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID(),accountId=randomUUID();
  await db.pool.query("INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent) VALUES($1,$2,'synthetic','R3 disposable',$3,'synthetic','documented_supported','fixture',1)",[accountId,principal,randomUUID()]);
  let token=await service.initializeLaboratory(principal,{domainId,label:'ac-r3-migration-disposable',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'});
  const command=(action:string,payload:unknown)=>({schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),domainId,action,payload});
  const proof=(cmd:Record<string,unknown>)=>{const unsigned={deviceId,expiresAt:Date.now()+60000};return {...unsigned,signature:sign(null,Buffer.from(operatorMessage(principal,cmd,unsigned,installation)),keys.privateKey).toString('hex')};};
  const execute=async(cmd:Record<string,unknown>)=>{
   const response=await api(new Request('http://localhost/api/v1/ac/installation-authority',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':Buffer.from(JSON.stringify(proof(cmd))).toString('base64url')},body:JSON.stringify(cmd)}),principal);
   const result=await response.json() as any;if(response.status!==200)throw Error(result.error);return result;
  };
  const reserve=()=>({id:randomUUID(),operationId:randomUUID(),accountId,executionIdentity:randomUUID(),leaseSeconds:60});
  await assert.rejects(service.reserve(principal,token,reserve()),/INSTALLATION_PAUSED/);
  await assert.rejects(service.view('foreign',domainId),/CONTROL_ADMIN_REQUIRED/);
  await execute(command('installation.pause',{expectedEpoch:1,paused:false}));
  const input=reserve(),reservation=await service.reserve(principal,token,input);
  const launches=await Promise.allSettled([0,1].map(()=>service.start(principal,token,reservation.id,async identity=>{
   const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});children.set(identity,child);await once(child,'spawn');
  })));
  assert.equal(launches.filter(x=>x.status==='fulfilled').length,1);assert.equal(children.size,1);
  await service.renew(principal,token,input.id);
  await execute(command('installation.pause',{expectedEpoch:1,paused:true}));
  await service.renew(principal,token,input.id);
  await assert.rejects(service.start(principal,token,input.id,async()=>{}),/INSTALLATION_PAUSED/);
  await assert.rejects(execute(command('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId})),/WORK_NOT_RECONCILED/);
  await db.pool.query("UPDATE ac_installation_reservations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[input.id]);
  await assert.rejects(service.renew(principal,token,input.id),/RENEWAL_REFUSED/);
  await assert.rejects(execute(command('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId})),/WORK_NOT_RECONCILED/);
  await assert.rejects(service.release(principal,token,input.id,{executionIdentity:input.executionIdentity,state:'absent',evidence:'child-exit-observed'}),/ABSENCE_UNPROVEN/);
  const child=children.get(input.executionIdentity)!;child.kill('SIGTERM');await once(child,'exit');
  // signal exit has exitCode null; physical verifier also checks signalCode.
  const restart=new InstallationAuthority(db,async(identity,evidence)=>evidence==='child-exit-observed'&&identity===input.executionIdentity&&child.signalCode==='SIGTERM');
  await restart.release(principal,token,input.id,{executionIdentity:input.executionIdentity,state:'absent',evidence:'child-exit-observed'});
  const transfer=command('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId});
  const transferred=await execute(transfer);token=transferred.token;
  assert.equal(token.epoch,2);assert.equal(transferred.paused,true);
  assert.deepEqual(await execute({...transfer,deliveryAttemptId:randomUUID()}),transferred);
  const stale={domainId,installationId:oldInstallationId,epoch:1};
  await assert.rejects(restart.renew(principal,stale,input.id),/STALE_INSTALLATION_AUTHORITY/);
  await assert.rejects(restart.reserve(principal,stale,reserve()),/STALE_INSTALLATION_AUTHORITY/);
  await execute(command('installation.pause',{expectedEpoch:2,paused:false}));
  const second=reserve();await restart.reserve(principal,token,second);
  // Crash after durable start claim: callback failure leaves uncertainty; expiry cannot transfer.
  await assert.rejects(restart.start(principal,token,second.id,async()=>{throw Error('synthetic lost acknowledgement');}),/lost acknowledgement/);
  await execute(command('installation.pause',{expectedEpoch:2,paused:true}));
  await assert.rejects(execute(command('installation.rollback',{expectedEpoch:2,targetInstallationId:oldInstallationId})),/WORK_NOT_RECONCILED/);
  await assert.rejects(restart.release(principal,token,second.id,{executionIdentity:second.executionIdentity,state:'not_started',evidence:'false'}),/IDENTITY_MISMATCH/);
  const reconciler=new InstallationAuthority(db,async(identity,evidence)=>identity===second.executionIdentity&&evidence==='lab-no-spawn-proof');
  await reconciler.release(principal,token,second.id,{executionIdentity:second.executionIdentity,state:'absent',evidence:'lab-no-spawn-proof'});
  const rolled=await execute(command('installation.rollback',{expectedEpoch:2,targetInstallationId:oldInstallationId}));
  assert.equal(rolled.token.epoch,3);assert.equal(rolled.token.installationId,oldInstallationId);assert.equal(rolled.paused,true);
  await assert.rejects(restart.reserve(principal,stale,reserve()),/STALE_INSTALLATION_AUTHORITY/);
  await assert.rejects(restart.reserve(principal,token,reserve()),/STALE_INSTALLATION_AUTHORITY/);
  const view=await restart.view(principal,domainId);assert.equal(view.operationalActivation,'blocked');assert.equal(view.reservations.length,2);
  assert.ok(view.history.some(item=>item.kind==='reservation.renewed'));assert.ok(view.history.some(item=>item.kind==='installation.rollback'));
  const bad=command('installation.pause',{expectedEpoch:3,paused:false});
  const response=await api(new Request('http://localhost/api/v1/ac/installation-authority',{method:'POST',headers:{'content-type':'application/json','x-ac-operator-proof':Buffer.from(JSON.stringify(proof({...bad,domainId:randomUUID()}))).toString('base64url')},body:JSON.stringify(bad)}),principal);
  assert.equal(response.status,403);
 }finally{for(const child of children.values())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await db.pool.end();await database.close();}
});

test('R3 shared authority fences real Capacity and credential refresh across restart/transfer/rollback',{timeout:30000},async()=>{
 const {Capacity}=await import('../src/capacity.ts');
 const database=await isolatedDatabase(process.env.AC_TEST_DATABASE_URL!,'r3migratecap'),db=new Ledger(database.url);
 const principal='r3-migration-capacity',project=randomUUID(),domainId=randomUUID(),oldInstallationId=randomUUID(),newInstallationId=randomUUID();
 const service=new InstallationAuthority(db),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
 let old:Ledger|undefined,newer:Ledger|undefined;
 try{
  await db.migrate();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R3 migration synthetic']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const signingInstallation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const execute=async(action:string,payload:unknown)=>{
   const cmd={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),domainId,action,payload},proof={deviceId,expiresAt:Date.now()+60000};
   return await service.execute(principal,cmd,{...proof,signature:sign(null,Buffer.from(operatorMessage(principal,cmd,proof,signingInstallation)),keys.privateKey).toString('hex')}) as any;
  };
  const token=await service.initializeLaboratory(principal,{domainId,label:'ac-r3-real-capacity',oldInstallationId,newInstallationId,mode:'synthetic-laboratory'});
  const capacity=new Capacity(db),account=randomUUID(),programmer=randomUUID(),manager=randomUUID();
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:'synthetic',model:'fixture',efforts:['medium'],roles:['programmer','manager'],source:'fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'synthetic',label:'migration fixture',resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'fixture',maxConcurrent:1});
  for(const [id,role] of [[programmer,'programmer'],[manager,'manager']] as const)await capacity.addProfile(principal,project,{id,accountId:account,model:'fixture',effort:'medium',role});
  await capacity.observeQuota(principal,account,{status:'available',source:'fixture',ttlSeconds:3600});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[programmer],emergency:[]},manager:{regular:[manager],emergency:[]}}});
  const context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);
  await service.bindLaboratoryProject(principal,domainId,project);
  await assert.rejects(db.acquire(principal,context,randomUUID(),'fixture',60),/STALE_INSTALLATION_AUTHORITY/);
  await execute('installation.pause',{expectedEpoch:1,paused:false});
  old=new Ledger(database.url,token);const realCapacity=new Capacity(old);
  const authority=await old.acquire(principal,context,randomUUID(),'fixture',60);
  const intent=await old.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const request={attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer' as const};
  let admitted!:()=>void,commitAdmission!:()=>void;const admissionReady=new Promise<void>(resolve=>{admitted=resolve;}),admissionRelease=new Promise<void>(resolve=>{commitAdmission=resolve;});
  const admission=old.tx(async c=>{const grant=await new Capacity(old!,c).reserve(principal,request,authority);admitted();await admissionRelease;return grant;});await admissionReady;
  let pauseSettled=false,transferSettled=false;
  const pausing=execute('installation.pause',{expectedEpoch:1,paused:true}).then(value=>{pauseSettled=true;return value;});
  const transferring=execute('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId}).then(()=>{throw Error('transfer bypassed in-flight Capacity');},error=>{transferSettled=true;assert.match(String(error),/WORK_NOT_RECONCILED|MUST_BE_PAUSED/);});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(pauseSettled,false);assert.equal(transferSettled,false);commitAdmission();
  const grant=await admission;await pausing;await transferring;
  await execute('installation.pause',{expectedEpoch:1,paused:false});
  await realCapacity.transition(principal,grant.id,authority,'running');
  await execute('installation.pause',{expectedEpoch:1,paused:true});
  await assert.rejects(execute('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId}),/WORK_NOT_RECONCILED/);
  await old.heartbeat(authority); // current holder can reconcile while paused.
  await realCapacity.transition(principal,grant.id,authority,'released',{processId:'synthetic-running-fixture',state:'exited'});
  // Lost credential refresh ACK is durable uncertainty and blocks transfer.
  const refresh=randomUUID();let refreshCalls=0;
  await assert.rejects(service.refreshCredentials(principal,token,account,refresh,async()=>{refreshCalls++;throw Error('refresh ACK lost');}),/ACK lost/);
  await assert.rejects(execute('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId}),/REFRESH_NOT_RECONCILED/);
  await assert.rejects(service.refreshCredentials(principal,token,account,randomUUID(),async()=>{}),/REFRESH_ACCOUNT_BUSY/);
  const otherDomainId=randomUUID(),otherOld=randomUUID(),otherNew=randomUUID();
  const otherToken=await service.initializeLaboratory(principal,{domainId:otherDomainId,label:'ac-r3-cross-domain',oldInstallationId:otherOld,newInstallationId:otherNew,mode:'synthetic-laboratory'});
  let crossDomainCalls=0;await assert.rejects(service.refreshCredentials(principal,otherToken,account,randomUUID(),async()=>{crossDomainCalls++;}),/ACCOUNT_DOMAIN_MISMATCH/);assert.equal(crossDomainCalls,0);
  const otherProject=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'cross-domain lab']);await db.pool.query('INSERT INTO ac_account_access VALUES($1,$2)',[account,otherProject]);
  await assert.rejects(service.bindLaboratoryProject(principal,otherDomainId,otherProject),/ACCOUNT_DOMAIN_CONFLICT/);
  const recovery=new InstallationAuthority(db,async(identity,evidence)=>identity===refresh&&evidence==='synthetic-refresh-proved-idle');
  await recovery.reconcileRefresh(principal,token,refresh,'synthetic-refresh-proved-idle');
  let entered!:()=>void,unblock!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{unblock=resolve;});
  const activeRefresh=service.refreshCredentials(principal,token,account,randomUUID(),async()=>{entered();await release;});await started;
  let transferred=false;const moving=execute('installation.transfer',{expectedEpoch:1,targetInstallationId:newInstallationId}).then(value=>{transferred=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(transferred,false,'transfer must wait for in-flight fenced refresh');unblock();await activeRefresh;
  const moved=await moving;
  await assert.rejects(old.heartbeat(authority),/STALE_INSTALLATION_AUTHORITY/);
  await assert.rejects(realCapacity.reserve(principal,{...request,attemptId:randomUUID()},authority),/STALE_INSTALLATION_AUTHORITY/);
  await assert.rejects(service.refreshCredentials(principal,token,account,randomUUID(),async()=>{refreshCalls++;}),/STALE_INSTALLATION_AUTHORITY/);assert.equal(refreshCalls,1);
  newer=new Ledger(database.url,moved.token);
  // Existing manager identity remains valid only with current installation authority.
  await newer.heartbeat(authority);
  await execute('installation.pause',{expectedEpoch:2,paused:false});
  const next=await new Capacity(newer).reserve(principal,{...request,attemptId:randomUUID()},authority);
  await new Capacity(newer).transition(principal,next.id,authority,'released',{processId:'fixture',state:'not_started'});
  await execute('installation.pause',{expectedEpoch:2,paused:true});
  const rolled=await execute('installation.rollback',{expectedEpoch:2,targetInstallationId:oldInstallationId});assert.equal(rolled.token.epoch,3);
  await assert.rejects(old.heartbeat(authority),/STALE_INSTALLATION_AUTHORITY/);await assert.rejects(newer.heartbeat(authority),/STALE_INSTALLATION_AUTHORITY/);
  assert.equal((await service.view(principal,domainId)).domain.paused,true);
 }finally{await old?.pool.end();await newer?.pool.end();await db.pool.end();await database.close();}
});
