import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
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
  const grok=await add('grok','Grok'),claude=await add('claude','Claude');
  const profile=randomUUID();
  await ledger.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'grok-4.6','medium','programmer',true)",[profile,grok]);
  await new AccountHomes(ledger,accounts,[repo]).initialize(owner,project,grok);
  const home=join(accounts,grok),outside=join(area,'outside.txt');
  await mkdir(join(home,'.grok'),{mode:0o700});
  await writeFile(join(home,'.grok','auth.json'),'{}',{mode:0o600});
  await writeFile(outside,'keep');
  await symlink(outside,join(home,'link-out'));
  await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:database.url,dataDirectory:data,
   accountHomesDirectory:accounts,project:{id:project,label:'primary',repo,owner,allowedAccountIds:[grok,claude]},
   http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}},null,1)+'\n',{mode:0o600});
  const original=await readFile(file,'utf8');

  // Preview: nothing changes.
  const preview=await runAccountRemoveCli(file,['Grok']);
  assert.match(preview.join('\n'),/Conta Grok \(grok, /);
  assert.match(preview.join('\n'),/Prévia, nada foi alterado/);
  assert.match(preview.join('\n'),/allowedAccountIds/);
  assert.equal(await readFile(file,'utf8'),original);
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[grok])).rows[0].enabled,true);
  assert.equal(await exists(home),true);
  await assert.rejects(runAccountRemoveCli(file,['Grok','--sim','--x']),refused('ACCOUNT_REMOVE_USAGE'));
  await assert.rejects(removeProviderAccount(file,'Ninguém',{apply:false}),refused('ACCOUNT_NOT_FOUND'));

  // A vigente policy naming the account's profile, with no other enabled Grok account, refuses.
  await ledger.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)",
   [project,'b'.repeat(64),{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[profile],emergency:[]}}},owner]);
  await assert.rejects(removeProviderAccount(file,grok,{apply:true}),(error:unknown)=>refused('ACCOUNT_REMOVE_POLICY_IN_USE')(error)&&/primary/.test(accountRemoveFailureText(error)));
  await ledger.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,2,$2,$3,$4)",
   [project,'c'.repeat(64),{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{}},owner]);

  // Live work (a grant not released) refuses and changes nothing.
  const context=await ledger.createContext(owner,project,randomUUID());
  const authority=await ledger.acquire(owner,context,randomUUID(),'fixture-manager',60);
  const intent=await ledger.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID();
  await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,grok,profile,project,digest({grant})]);
  await assert.rejects(removeProviderAccount(file,grok,{apply:true}),refused('ACCOUNT_REMOVE_ACTIVE'));
  assert.equal(await readFile(file,'utf8'),original);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[grok])).rows[0].n,1);
  await ledger.pool.query("UPDATE ac_capacity_grants SET state='released' WHERE id=$1",[grant]);

  // Apply.
  const now=new Date('2026-11-28T12:00:00Z');
  const applied=await runAccountRemoveCli(file,[grok,'--sim'],{now});
  assert.match(applied.join('\n'),/Home .*: removida\./);
  assert.match(applied.join('\n'),/Reinicie o gateway/);
  const row=(await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[grok])).rows[0];
  assert.equal(row.enabled,false);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[grok])).rows[0].n,0);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_access WHERE account_id=$1',[claude])).rows[0].n,1);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE account_id=$1',[grok])).rows[0].n,1);
  assert.equal((await ledger.pool.query('SELECT count(*)::int n FROM ac_account_homes WHERE account_id=$1',[grok])).rows[0].n,1);
  const audit=(await ledger.pool.query("SELECT detail FROM ac_audit WHERE kind='account.retired'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].detail.accountId,grok);assert.deepEqual(audit[0].detail.revokedProjects,[project]);
  assert.equal(await exists(home),false);
  assert.equal(await readFile(outside,'utf8'),'keep');
  assert.deepEqual((await readdir(accounts)).filter(name=>name.startsWith('.retired-')),[]);
  const config=await loadInstallation(file);
  assert.deepEqual(config.project.allowedAccountIds,[claude]);
  const backups=(await readdir(data)).filter(name=>name.startsWith('installation.json.before-account-remove-'));
  assert.equal(backups.length,1);
  assert.equal(await readFile(join(data,backups[0]!),'utf8'),original);
  assert.equal((await lstat(join(data,backups[0]!))).mode&0o777,0o600);
  // Health ignores the retired account: its missing home is not read.
  const status=await personalAccountStatus(ledger.pool,project,data,file,now);
  assert.deepEqual(status.map(item=>item.id),[claude]);

  // Running again is harmless: the account is already disabled and its home already gone.
  const again=await removeProviderAccount(file,grok,{apply:true,now});
  assert.match(again.lines.join('\n'),/já não existe/);
  assert.equal((await ledger.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='account.retired'")).rows[0].n,2);

  // The last allowed account of a project is refused before any change.
  await assert.rejects(removeProviderAccount(file,claude,{apply:true}),refused('ACCOUNT_REMOVE_LAST_ALLOWED'));
  assert.equal((await ledger.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[claude])).rows[0].enabled,true);
 }finally{
  await ledger.close();await database.close();
  await rm(area,{recursive:true,force:true});
 }
});
