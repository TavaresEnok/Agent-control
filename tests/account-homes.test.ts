import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,link,mkdir,mkdtemp,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('private account homes are immutable owner-scoped physical identities',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'homes'),db=new Ledger(database.url),capacity=new Capacity(db);
 const area=await mkdtemp(join(tmpdir(),'ac-home-test-')),root=join(area,'private'),repo=join(area,'repo');
 try{
  await mkdir(root,{mode:0o700});await mkdir(repo,{mode:0o700});await db.migrate();
  const project=randomUUID(),principal='fixture-owner-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'home fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'viewer')",[project,principal,'fixture-viewer']);
  const create=async()=>{const id=randomUUID();await capacity.addAccount(principal,project,{id,provider:'fixture',label:'fixture',resourceIdentity:randomUUID(),
   mode:'subscription_cli',eligibility:'not_assessed',eligibilitySource:'synthetic://fixture',maxConcurrent:1});return id;};
  const id=await create(),service=new AccountHomes(db,root,[repo]);
  await assert.rejects(service.initialize('fixture-viewer',project,id),/ACCOUNT_FORBIDDEN/);
  const first=await service.initialize(principal,project,id),second=await service.initialize(principal,project,id);
  assert.deepEqual(second,first);await writeFile(join(root,id,'secret'),'DO_NOT_EXPORT_SECRET');
  const observed=await service.inspect(principal,project,id);assert.deepEqual(observed,first);
  assert(!JSON.stringify(observed).includes('DO_NOT_EXPORT_SECRET'));assert(!JSON.stringify(observed).includes(root));
  assert.equal((await db.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1',[id])).rows[0].enabled,false);
  await assert.rejects(db.pool.query('UPDATE ac_account_homes SET home_inode=$2 WHERE account_id=$1',[id,'1']),/POLICY_REVISION_IMMUTABLE/);
  await assert.rejects(new AccountHomes(db,repo,[repo]).initialize(principal,project,await create()),/ACCOUNT_HOME_REPOSITORY_OVERLAP/);
  const linked=await create();await symlink(repo,join(root,linked));
  await assert.rejects(service.initialize(principal,project,linked),/ACCOUNT_HOME_UNREGISTERED/);
  const file=join(area,'file');await writeFile(file,'fixture');const hardlinked=await create();await link(file,join(root,hardlinked));
  await assert.rejects(service.initialize(principal,project,hardlinked),/ACCOUNT_HOME_UNREGISTERED/);
  await chmod(join(root,id),0o755);await assert.rejects(service.inspect(principal,project,id),/ACCOUNT_HOME_IDENTITY_MISMATCH/);await chmod(join(root,id),0o700);
  // A shared account keeps one physical HOME while the authorized project and
  // intent principal change. Sharing must not duplicate or reveal credentials.
  const sharedProject=randomUUID(),sharedPrincipal='shared-owner-'+randomUUID(),syntheticAccount=randomUUID(),sharedProfile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[sharedProject,'Shared-home scope']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'owner'),($1,$4,'viewer')",[sharedProject,principal,sharedPrincipal,'shared-viewer']);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);await capacity.configure(principal,{programmingLimit:8,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'home-fixture',model:'home-model',efforts:['medium'],roles:['manager'],source:'synthetic://home-fixture'});
  await capacity.addAccount(principal,project,{id:syntheticAccount,provider:'home-fixture',label:'Shared synthetic HOME',resourceIdentity:syntheticAccount,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://home-fixture',maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:sharedProfile,accountId:syntheticAccount,model:'home-model',effort:'medium',role:'manager'});
  const original=await service.initialize(principal,project,syntheticAccount);await capacity.shareAccount(principal,syntheticAccount,sharedProject);
  await capacity.observeQuota(principal,syntheticAccount,{status:'available',source:'synthetic://home-fixture',ttlSeconds:300});
  const revision=await capacity.publish(sharedPrincipal,sharedProject,0,{schemaVersion:1,maxProgrammersPerContext:8,maxEvaluatorsPerContext:2,roles:{manager:{regular:[sharedProfile],emergency:[]}}});
  const contextId=await db.createContext(sharedPrincipal,sharedProject,randomUUID()),authority=await db.acquire(sharedPrincipal,contextId,randomUUID(),'home-manager',60);
  await capacity.assignPolicy(sharedPrincipal,contextId,revision);
  const intent=await db.accept(sharedPrincipal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:home-test'}},authority,'api');
  const grant=await capacity.reserve(sharedPrincipal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'manager'},authority);
  const granted=await service.inspectGranted(sharedPrincipal,grant.id,authority);assert.equal(granted.projectId,sharedProject);assert.equal(granted.ownerId,principal);assert.equal(granted.inode,original.inode);
  await assert.rejects(service.inspectGranted('shared-viewer',grant.id,authority),/CONTEXT_FORBIDDEN/);
  await assert.rejects(service.inspectGranted(sharedPrincipal,grant.id,{...authority,epoch:authority.epoch+1}),/STALE_MANAGER/);
  await capacity.setEnabled(principal,project,'account',{id:syntheticAccount,enabled:false,expectedRevision:1});
  await assert.rejects(service.inspectGranted(sharedPrincipal,grant.id,authority),/ACCOUNT_HOME_GRANT_FORBIDDEN/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'reserved');
  await rename(join(root,id),join(root,'old-home'));await mkdir(join(root,id),{mode:0o700});
  await assert.rejects(service.loadMetadata(principal,project,id),/ACCOUNT_HOME_IDENTITY_MISMATCH/);
 }finally{await db.close();await database.close();await rm(area,{recursive:true,force:true});}
});
