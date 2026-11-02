import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ContextVault} from '../src/context-vault.ts';
import {backupContextVault,restoreContextVault} from '../src/context-vault-backup.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('synthetic vault backup authenticates restore without changing source or PG',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'vaultbackup'),db=new Ledger(isolated.url),folder=await mkdtemp(join(tmpdir(),'ac-vault-backup-'));
 try{
  await db.migrate();const root=join(folder,'source'),masterFile=join(root,'master'),backupKeyFile=join(folder,'backup-key'),archiveFile=join(folder,'archive');
  await mkdir(root,{mode:0o700});await writeFile(masterFile,randomBytes(32),{mode:0o600});await writeFile(backupKeyFile,randomBytes(32),{mode:0o600});
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,project=randomUUID(),principal='synthetic-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic backup']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID()),sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[contextId])).rows[0].session_id;
  const key=randomBytes(32),keys=new ContextKeys(db);await keys.authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  const request={principal,contextId,sessionId,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy' as const};
  const vault=new ContextVault(db,installationId,root,masterFile,[]);await vault.importKey(request,key);
  const path=join(root,`${contextId}-1.vault`),beforeMaster=await readFile(masterFile),beforeEnvelope=await readFile(path);
  const beforeDb=(await db.pool.query('SELECT context_id,version,variant,fingerprint,state FROM ac_context_keys ORDER BY context_id,version')).rows;
  const common={installationId,backupKeyFile,archiveFile,repositories:[] as string[]};
  assert.equal((await backupContextVault({...common,root,masterFile})).state,'backed_up');
  const destinationDirectory=join(folder,'restored');
  assert.equal((await restoreContextVault({...common,sourceRoot:root,sourceMasterFile:masterFile,destinationDirectory})).state,'restored_inactive');
  const restoredRoot=join(destinationDirectory,'vault'),restored=new ContextVault(db,installationId,restoredRoot,join(restoredRoot,'master'),[]);
  const loaded=await restored.load(request);assert.deepEqual(Buffer.from(loaded),key);loaded.fill(0);
  await assert.rejects(restoreContextVault({...common,sourceRoot:root,sourceMasterFile:masterFile,destinationDirectory}),/EEXIST/);
  await assert.rejects(restoreContextVault({...common,installationId:randomUUID(),sourceRoot:root,sourceMasterFile:masterFile,destinationDirectory:join(folder,'wrong-installation')}),/VAULT_INSTALLATION_MISMATCH/);
  const altered=JSON.parse(await readFile(archiveFile,'utf8'));altered.tag='0'.repeat(32);const tampered=join(folder,'tampered');await writeFile(tampered,JSON.stringify(altered),{mode:0o600});
  await assert.rejects(restoreContextVault({...common,archiveFile:tampered,sourceRoot:root,sourceMasterFile:masterFile,destinationDirectory:join(folder,'tampered-restore')}),/VAULT_BACKUP_AUTHENTICATION_FAILED/);
  assert.deepEqual(await readFile(masterFile),beforeMaster);assert.deepEqual(await readFile(path),beforeEnvelope);
  assert.deepEqual((await db.pool.query('SELECT context_id,version,variant,fingerprint,state FROM ac_context_keys ORDER BY context_id,version')).rows,beforeDb);
  key.fill(0);beforeMaster.fill(0);beforeEnvelope.fill(0);
 }finally{await db.close();await isolated.close();await rm(folder,{recursive:true,force:true});}
});
