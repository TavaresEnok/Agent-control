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
  await rename(join(root,id),join(root,'old-home'));await mkdir(join(root,id),{mode:0o700});
  await assert.rejects(service.loadMetadata(principal,project,id),/ACCOUNT_HOME_IDENTITY_MISMATCH/);
 }finally{await db.close();await database.close();await rm(area,{recursive:true,force:true});}
});
