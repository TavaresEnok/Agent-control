import {mkdtemp,mkdir,writeFile,stat,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {setQaSnapshotPermissions} from '../src/native-qa-snapshot.ts';
const prior=process.umask(0o077),root=await mkdtemp('/tmp/ac-r5-qa-uid-'),work=join(root,'work');
try {await mkdir(work);await mkdir(join(work,'src'));await writeFile(join(work,'src','input'),'proof\n');await writeFile(join(work,'src','run'),'#!/bin/sh\nexit 0\n',{mode:0o700});await setQaSnapshotPermissions(work,true);
 const out=execFileSync('docker',['run','--rm','--network=none','--user','10001:10001','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--mount',`type=bind,src=${work},dst=/work,readonly`,'--entrypoint','/bin/sh','ac-validation-runtime:ruby-20261104','-c','test "$(cat /work/src/input)" = proof && test -x /work/src/run && ! touch /work/src/forbidden && echo UID10001_READONLY_OK'],{encoding:'utf8'});console.log(JSON.stringify({proof:out.trim(),outer:(await stat(root)).mode&0o777,work:(await stat(work)).mode&0o777,file:(await stat(join(work,'src/input'))).mode&0o777,executable:(await stat(join(work,'src/run'))).mode&0o777}));
 await setQaSnapshotPermissions(work,false);
}finally{process.umask(prior);await chmod(work,0o700).catch(()=>{});await chmod(join(work,'src'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
