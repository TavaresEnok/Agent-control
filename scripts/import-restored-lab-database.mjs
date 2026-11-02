// Imports only into a NEW database, then leaves admission closed. Never selects the source database as a target.
import { execFileSync,spawn } from 'node:child_process';
import { readFile,realpath,writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve,join,sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
const root=resolve(new URL('..',import.meta.url).pathname),candidate=process.argv[2];
if(!candidate)throw Error('RESTORED_DIRECTORY_REQUIRED');
const restored=await realpath(candidate),allowed=await realpath(join(root,'.state/restores'));
if(!restored.startsWith(allowed+sep))throw Error('RESTORE_OUTSIDE_ISOLATED_AREA');
const manifest=JSON.parse(await readFile(join(restored,'MANIFEST.json'),'utf8'));
if(manifest.scope!=='isolated-synthetic-lab')throw Error('NOT_A_LAB_BACKUP');
const compose=['compose','-f',join(root,'deploy/compose.lab.yml')];
const active=execFileSync('docker',[...compose,'ps','--status','running','--services'],{encoding:'utf8'}).trim().split('\n');
if(active.includes('runtime')||!active.includes('db'))throw Error('STOP_LAB_RUNTIME_AND_KEEP_ONLY_DB');
const database='ac_restore_'+randomBytes(8).toString('hex');
execFileSync('docker',[...compose,'exec','-T','db','createdb','-U','ac_lab',database],{stdio:['ignore','pipe','pipe']});
try{
 const child=spawn('docker',[...compose,'exec','-T','db','pg_restore','-U','ac_lab','--no-owner','--no-acl','--exit-on-error','-d',database],{stdio:['pipe','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 const done=new Promise((ok,fail)=>{child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('RESTORE_IMPORT_FAILED')));});
 await Promise.all([pipeline(createReadStream(join(restored,'database.dump')),child.stdin),done]);
 execFileSync('docker',[...compose,'exec','-T','db','psql','-U','ac_lab','-d',database,'-v','ON_ERROR_STOP=1','-c',
  "UPDATE ac_admission_control SET enabled=false,revision=revision+1,reason='restored-awaiting-reconciliation',updated_at=now() WHERE id=1"],{stdio:['ignore','pipe','pipe']});
 const summary={database,admission:'closed',runtime:'not_started',sourceDatabaseChanged:false,worktreeRelocation:'pending',physicalReconciliation:'pending'};
 await writeFile(join(restored,'DATABASE_IMPORT.json'),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary));
}catch(error){
 // Do not connect a partially restored database to an executor; retain it for diagnosis.
 await writeFile(join(restored,'DATABASE_IMPORT_FAILED.json'),JSON.stringify({database,status:'failed-do-not-start-runtime'}),{mode:0o600});throw error;
}
