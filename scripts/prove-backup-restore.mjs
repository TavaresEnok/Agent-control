// End-to-end proof confined to the synthetic compose and a newly generated database.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,copyFile,open,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
if(process.cwd()!==root)throw Error('RUN_FROM_ISOLATED_REPOSITORY');
const compose=['compose','-f','deploy/compose.lab.yml'];
const run=(binary,args)=>execFileSync(binary,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1048576});
const sentinel=JSON.parse(await readFile('.state/backup-proof.json','utf8'));
if(sentinel.scope!=='isolated-restore-proof'||![sentinel.context,sentinel.grant,sentinel.account].every(x=>/^[a-f0-9-]{36}$/.test(x)))throw Error('ISOLATED_SENTINEL_REQUIRED');
const query=database=>JSON.parse(run('docker',[...compose,'exec','-T','db','psql','-U','ac_lab','-d',database,'-At','-v','ON_ERROR_STOP=1','-c',
 `SELECT json_build_object('paused',x.paused,'grantState',g.state,'quotaStatus',q.status,'leaseUntil',m.lease_until,'admission',a.enabled)
  FROM ac_contexts x JOIN ac_capacity_grants g ON g.id='${sentinel.grant}' JOIN ac_quota_observations q ON q.account_id='${sentinel.account}'
  JOIN ac_managers m ON m.context_id=x.id CROSS JOIN ac_admission_control a WHERE x.id='${sentinel.context}' AND a.id=1`]).trim());
const before=query('ac_implementation_test');assert.equal(before.paused,true);assert.equal(before.grantState,'uncertain');
run('docker',[...compose,'--profile','sandbox-test','--profile','ssh-test','stop']);
run('docker',[...compose,'up','-d','db']);
const backup=JSON.parse(run(process.execPath,['scripts/backup-lab.mjs']));
const tampered=backup.archive+'.tampered';
let archiveRejected=false,dumpRejected=false;
try{
 await copyFile(backup.archive,tampered);await copyFile(backup.archive+'.tag',tampered+'.tag');
 const file=await open(tampered,'r+'),stat=await file.stat(),byte=Buffer.alloc(1);
 await file.read(byte,0,1,stat.size-1);byte[0]^=1;await file.write(byte,0,1,stat.size-1);await file.close();
 try{run(process.execPath,['scripts/restore-lab.mjs',tampered,backup.keyFile]);}catch{archiveRejected=true;}
 assert(archiveRejected,'authenticated corruption must be rejected');
 const restored=JSON.parse(run(process.execPath,['scripts/restore-lab.mjs',backup.archive,backup.keyFile]));
 const dump=join(restored.destination,'database.dump'),original=await readFile(dump),changed=Buffer.from(original);changed[changed.length-1]^=1;
 await writeFile(dump,changed);
 try{run(process.execPath,['scripts/import-restored-lab-database.mjs',restored.destination]);}catch{dumpRejected=true;}
 finally{await writeFile(dump,original);}
 assert(dumpRejected,'modified dump must be refused before import');
 const imported=JSON.parse(run(process.execPath,['scripts/import-restored-lab-database.mjs',restored.destination]));
 assert(/^ac_restore_[a-f0-9]{16}$/.test(imported.database));
 const restoredState=query(imported.database),after=query('ac_implementation_test');
 assert.deepEqual(after,before,'source database must not change');
 assert.equal(restoredState.paused,true);assert.equal(restoredState.grantState,'uncertain');assert.equal(restoredState.quotaStatus,'unknown');assert.equal(restoredState.admission,false);
 const safety=JSON.parse(run('docker',[...compose,'exec','-T','db','psql','-U','ac_lab','-d',imported.database,'-At','-c',
  `SELECT json_build_object('liveManagers',(SELECT count(*) FROM ac_managers WHERE lease_until>clock_timestamp()),
   'availableQuotas',(SELECT count(*) FROM ac_quota_observations WHERE status='available'),
   'activeSessions',(SELECT count(*) FROM ac_browser_sessions WHERE NOT revoked),
   'unreconciledGrantsWronglyFreed',(SELECT count(*) FROM ac_capacity_grants WHERE state NOT IN ('uncertain','released')))`]).trim());
 assert.deepEqual(safety,{liveManagers:0,availableQuotas:0,activeSessions:0,unreconciledGrantsWronglyFreed:0});
 const result={result:'passed',synthetic:true,authenticatedArchive:true,archiveCorruptionRejected:archiveRejected,dumpModificationRejected:dumpRejected,
  pausePreserved:true,sourceDatabaseUnchanged:true,admissionClosed:true,activeGrantsRemainUncertain:true,safety,
  sourceFiles:backup.sourceFiles,archiveBytes:backup.size,nodeVersion:process.version,
  limitation:'No runtime was started from the copy. Worktree relocation, physical effect reconciliation, off-host key custody and production restore remain unverified.'};
 await writeFile('docs/validation/evidence/backup-restore-proof.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}finally{await rm(tampered,{force:true});await rm(tampered+'.tag',{force:true});}
