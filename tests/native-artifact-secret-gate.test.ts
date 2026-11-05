import {test} from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {join} from 'node:path';import {GitArtifacts} from '../src/git.ts';

test('new-object gate refuses uncompressed current and historical blobs without reclassifying base',async()=>{
 const repo=await mkdtemp('/tmp/ac-artifact-secret-'),secret='synthetic-'+randomBytes(24).toString('hex');const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim(),commit=(message:string)=>{git('add','-A');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm',message);return git('rev-parse','HEAD');};
 try{execFileSync('git',['init','-q','-b','main',repo]);await writeFile(join(repo,'old.txt'),secret);const base=commit('base');await writeFile(join(repo,'new.txt'),'safe');const safe=commit('safe');const artifacts=new GitArtifacts(repo);await artifacts.assertNoNewArtifactSecrets(safe,base,[secret]);
  await writeFile(join(repo,'new.txt'),secret);const bad=commit('contains secret');await assert.rejects(artifacts.assertNoNewArtifactSecrets(bad,safe,[secret]),/NATIVE_ARTIFACT_CONTAINS_SECRET/);
  await writeFile(join(repo,'new.txt'),'clean later');const cleaned=commit('later clean');await assert.rejects(artifacts.assertNoNewArtifactSecrets(cleaned,safe,[secret]),/NATIVE_ARTIFACT_CONTAINS_SECRET/);assert.equal(git('show',cleaned+':new.txt'),'clean later');
 }finally{await rm(repo,{recursive:true,force:true});}
});
