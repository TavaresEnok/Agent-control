import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setQaSnapshotPermissions} from '../src/native-qa-snapshot.ts';

test('QA snapshot is readable under restrictive umask without following links; restore only directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qa-perms-')),work=join(root,'work'),outside=join(root,'outside');
 try{
  await mkdir(work,{mode:0o700});await mkdir(join(work,'src'),{mode:0o700});await writeFile(join(work,'src','plain'),'ok',{mode:0o600});await writeFile(join(work,'src','run'),'ok',{mode:0o700});await writeFile(outside,'safe',{mode:0o600});await symlink(outside,join(work,'link'));
  await setQaSnapshotPermissions(work,true);
  for(const path of [work,join(work,'src')])assert.equal((await lstat(path)).mode&0o777,0o555);
  assert.equal((await lstat(join(work,'src','plain'))).mode&0o777,0o444);assert.equal((await lstat(join(work,'src','run'))).mode&0o777,0o555);
  assert.equal((await lstat(outside)).mode&0o777,0o600);assert.equal(await readFile(outside,'utf8'),'safe');
  await setQaSnapshotPermissions(work,false);assert.equal((await lstat(work)).mode&0o777,0o700);assert.equal((await lstat(join(work,'src'))).mode&0o777,0o700);assert.equal((await lstat(join(work,'src','plain'))).mode&0o777,0o444);
  await link(outside,join(work,'hard'));await assert.rejects(setQaSnapshotPermissions(work,true),/NATIVE_QA_SNAPSHOT_UNSAFE/);assert.equal((await lstat(outside)).mode&0o777,0o600);
 }finally{await chmod(work,0o700).catch(()=>{});await chmod(join(work,'src'),0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
