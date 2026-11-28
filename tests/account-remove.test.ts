import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AccountHomes} from '../src/account-homes.ts';
import {accountRemoveFailureText,removeProviderAccount,runAccountRemoveCli} from '../src/account-remove.ts';
import {Capacity} from '../src/capacity.ts';
import {digest,Refusal} from '../src/contracts.ts';
import {loadInstallation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {personalAccountStatus} from '../src/personal-accounts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const url=process.env.AC_TEST_DATABASE_URL;
const exists=(path:string)=>lstat(path).then(()=>true,()=>false);
const refused=(code:string)=>(error:unknown)=>error instanceof Refusal&&error.code===code;
/** Docker as a fake: `mounts` maps running container ids to their mount sources; `down` makes every call fail. */
function fakeDocker(mounts:Record<string,string[]>={},down=false){
 return async(args:string[])=>{
  if(down)return {code:1,stdout:''};
  if(args[0]==='container'&&args[1]==='ls')return {code:0,stdout:Object.keys(mounts).map(id=>id+'\n').join('')};
  if(args[0]==='container'&&args[1]==='inspect')return {code:0,stdout:args.slice(4).map(id=>[id,...mounts[id]!].join(' ')+'\n').join('')};
  return {code:1,stdout:''};
 };
}
const noDocker=fakeDocker();

test('retiring an account: preview changes nothing, live work and a vigente policy refuse, then the account, access and home go and history stays',{skip:!url,timeout:120000},async()=>{
 const database=await isolatedDatabase(url!,'accrm');
 const area=await realpath(await mkdtemp(join(tmpdir(),'ac-account-rm-')));
 const ledger=new Ledger(database.url);
 try{
  await ledger.migrate();
  await ledger.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const data=join(area,'data'),accounts=join(data,'accounts'),repo=join(area,'repo'),file=join(data,'installation.json');
  await mkdir(accounts,{recursive:true,mode:0o700});await mkdir(repo,{mode:0o700});
  for(const path of [data,accounts])await chmod(path,0o700);
  const owner='owner@example.com',project=randomUUID();
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'primary']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  const capacity=new Capacity(ledger);
  await capacity.configure(owner,{programmingLimit:4,evaluationLimit:2});
  const add=async(provider:string,label:string)=>{
   const id=randomUUID();
   await capacity.addAccount(owner,project,{id,provider,label,resourceIdentity:provider+':'+digest({id}),mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'personal://owner',maxConcurrent:2});
   return id;
  };
  const grok=await add('grok','Grok'),claude=await add('claude','Claude'),grok2=await add('grok','Grok 2');
  const profile=randomUUID();
  await ledger.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'grok-4.6','medium','programmer',true)",[profile,grok]);
  const profile2=randomUUID();
  await ledger.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'grok-4.6','medium','programmer',true)",[profile2,grok2]);
  await new AccountHomes(ledger,accounts,[repo]).initialize(owner,project,grok);
  const home=join(accounts,grok),outside=join(area,'outside.txt');
  await mkdir(join(home,'.grok'),{mode:0o700});
  await writeFile(join(home,'.grok','auth.json'),'{}',{mode:0o600});
  await writeFile(outside,'keep');
  await symlink(outside,join(home,'link-out'));
  await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:database.url,dataDirectory:data,
   accountHomesDirectory:accounts,project:{id:project,label:'primary',repo,owner,allowedAccountIds:[grok,claude]},
   codexQuota:{state:'configured-inactive',bindings:[{accountId:grok,subjectDigest:'d'.repeat(64),home,device:'1',inode:'2',uid:'3'}]},
   http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}},null,1)+'\n',{mode:0o600});
  const original=await readFile(file,'utf8');

  // Preview: nothing changes.
  const preview=await runAccountRemoveCli(file,['Grok'],{docker:noDocker});
  assert.match(preview.join('\n'),/Conta Grok \(grok, /);
  assert.match(preview.join('\n'),/Prévia, nada foi alterado/);
  assert.match(preview.join('\n'),/allowedAccountIds/);
  assert.match(preview.join('\n'),/codexQuota/);
  assert.equal(await readFile(file,'utf8'),original);
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[grok])).rows[0].enabled,true);
  assert.equal(await exists(home),true);
  await assert.rejects(runAccountRemoveCli(file,['Grok','--sim','--x']),refused('ACCOUNT_REMOVE_USAGE'));
  await assert.rejects(removeProviderAccount(file,'Ninguém',{apply:false,docker:noDocker}),refused('ACCOUNT_NOT_FOUND'));

  // A vigente policy naming the account's profile refuses, even with another enabled Grok account on the project,
  // because the policy does not name that account's profile.
  await ledger.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)",
   [project,'b'.repeat(64),{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[profile],emergency:[]}}},owner]);
  await assert.rejects(removeProviderAccount(file,grok,{apply:true,docker:noDocker}),(error:unknown)=>refused('ACCOUNT_REMOVE_POLICY_IN_USE')(error)&&/primary/.test(accountRemoveFailureText(error))&&/personal:combo/.test(accountRemoveFailureText(error)));
  await ledger.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,2,$2,$3,$4)",
   [project,'c'.repeat(64),{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{}},owner]);

  // Live work (a grant not released) refuses and changes nothing.
  const context=await ledger.createContext(owner,project,randomUUID());
  const authority=await ledger.acquire(owner,context,randomUUID(),'fixture-manager',60);
  const intent=await ledger.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID();
  await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,grok,profile,project,digest({grant})]);
  await assert.rejects(removeProviderAccount(file,grok,{apply:true,docker:noDocker}),refused('ACCOUNT_REMOVE_ACTIVE'));
  assert.equal(await readFile(file,'utf8'),original);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[grok])).rows[0].n,1);
  await ledger.pool.query("UPDATE ac_capacity_grants SET state='released' WHERE id=$1",[grant]);

  // An uncertain planning job whose grant is already released still refuses.
  const planGrant=randomUUID(),planJob=randomUUID();
  await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'released')`,[planGrant,randomUUID(),intent.id,context,authority.epoch,grok,profile,project,digest({planGrant})]);
  await ledger.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,state)
   VALUES($1,$2,$3,$4,$5,'fixture',$5,0,$6,$7,'uncertain')`,[planJob,context,intent.id,owner,'a'.repeat(64),randomUUID(),randomUUID()]);
  await ledger.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$4,$5,'uncertain')`,[planJob,planGrant,context,'a'.repeat(64),'fixture-'+planJob]);
  await assert.rejects(removeProviderAccount(file,grok,{apply:true,docker:noDocker}),(error:unknown)=>refused('ACCOUNT_REMOVE_ACTIVE')(error)&&/planejamento/.test(accountRemoveFailureText(error)));
  await ledger.pool.query("UPDATE ac_native_planning_jobs SET state='failed' WHERE id=$1",[planJob]);

  // A running container that mounts the home refuses, and so does a Docker that cannot answer.
  await assert.rejects(removeProviderAccount(file,grok,{apply:true,docker:fakeDocker({['f'.repeat(64)]:[join(home,'.grok')]})}),refused('ACCOUNT_REMOVE_HOME_MOUNTED'));
  await assert.rejects(removeProviderAccount(file,grok,{apply:true,docker:fakeDocker({},true)}),refused('ACCOUNT_REMOVE_HOME_MOUNTED'));
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[grok])).rows[0].enabled,true);
  assert.equal(await exists(home),true);

  // Apply.
  const now=new Date('2026-11-28T12:00:00Z');
  const applied=await runAccountRemoveCli(file,[grok,'--sim'],{now,docker:fakeDocker({['e'.repeat(64)]:[join(area,'elsewhere')]})});
  assert.match(applied.join('\n'),/Home .*: credenciais e arquivos removidos/);
  assert.match(applied.join('\n'),/Reinicie o gateway/);
  const row=(await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[grok])).rows[0];
  assert.equal(row.enabled,false);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[grok])).rows[0].n,0);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[claude])).rows[0].n,1);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE account_id=$1',[grok])).rows[0].n,2);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_homes WHERE account_id=$1',[grok])).rows[0].n,1);
  const audit=(await ledger.pool.query("SELECT detail FROM ac_audit WHERE kind='account.retired'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].detail.accountId,grok);assert.deepEqual(audit[0].detail.revokedProjects,[project]);
  // The empty home stays: its registration is immutable and its inode must not be handed to another account's home.
  assert.equal((await lstat(home)).isDirectory(),true);
  assert.deepEqual(await readdir(home),[]);
  assert.equal(await readFile(outside,'utf8'),'keep');
  assert.deepEqual((await readdir(accounts)).filter(name=>name.startsWith('.retired-')),[]);
  const config=await loadInstallation(file);
  assert.deepEqual(config.project.allowedAccountIds,[claude]);
  assert.deepEqual(config.codexQuota,{state:'disabled'});
  const backups=(await readdir(data)).filter(name=>name.startsWith('installation.json.before-account-remove-'));
  assert.equal(backups.length,1);
  assert.equal(await readFile(join(data,backups[0]!),'utf8'),original);
  assert.equal((await lstat(join(data,backups[0]!))).mode&0o777,0o600);
  // Health ignores the retired account: its missing home is not read.
  const status=await personalAccountStatus(ledger.pool,project,data,file,now);
  assert.deepEqual(status.map(item=>item.id).sort(),[claude,grok2].sort());

  // Running again is harmless: the account is already disabled and its home already empty.
  const again=await removeProviderAccount(file,grok,{apply:true,now,docker:noDocker});
  assert.match(again.lines.join('\n'),/credenciais e arquivos removidos/);
  assert.equal((await ledger.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='account.retired'")).rows[0].n,2);

  // The last allowed account of a project is refused before any change.
  await assert.rejects(removeProviderAccount(file,claude,{apply:true,docker:noDocker}),refused('ACCOUNT_REMOVE_LAST_ALLOWED'));
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[claude])).rows[0].enabled,true);

  // A home replaced by a link is kept, and its target is untouched.
  const linked=await add('grok','Grok link');
  await new AccountHomes(ledger,accounts,[repo]).initialize(owner,project,linked);
  const target=join(area,'target');
  await mkdir(target,{mode:0o700});await writeFile(join(target,'auth.json'),'keep');
  await rename(join(accounts,linked),join(area,'linked-original'));await symlink(target,join(accounts,linked));
  const viaLink=await removeProviderAccount(file,linked,{apply:true,now,docker:noDocker});
  assert.match(viaLink.lines.join('\n'),/não é um diretório \(link ou arquivo\)/);
  assert.equal((await lstat(join(accounts,linked))).isSymbolicLink(),true);
  assert.equal(await readFile(join(target,'auth.json'),'utf8'),'keep');
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[linked])).rows[0].enabled,false);

  // A home recreated with another inode is not the registered one and is kept.
  const swapped=await add('grok','Grok swapped');
  await new AccountHomes(ledger,accounts,[repo]).initialize(owner,project,swapped);
  await rename(join(accounts,swapped),join(area,'swapped-original'));await mkdir(join(accounts,swapped),{mode:0o700});
  await writeFile(join(accounts,swapped,'note'),'keep');
  const viaSwap=await removeProviderAccount(file,swapped,{apply:true,now,docker:noDocker});
  assert.match(viaSwap.lines.join('\n'),/não é o diretório que o banco registrou/);
  assert.equal(await readFile(join(accounts,swapped,'note'),'utf8'),'keep');
 }finally{
  await ledger.close();await database.close();
  await rm(area,{recursive:true,force:true});
 }
});
