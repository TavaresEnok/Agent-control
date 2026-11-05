import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {projectRepositoryIdentity} from '../src/project-repository.ts';
import {reconcileWorkflowFile} from '../src/workflow-graph-files.ts';
const hash=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
test('immutable publication accepts identical replay and refuses foreign and symlink',async()=>{
 const root=await mkdtemp('/tmp/ac-workflow-files-');
 try{
  const repo=join(root,'repo');await mkdir(repo,{mode:0o700});execFileSync('git',['init',repo],{stdio:'ignore'});await chmod(join(repo,'.git'),0o700);
  for(const p of ['.ai','.ai/cezar','.ai/cezar/workflows'])await mkdir(join(repo,p),{mode:0o700});
  const identity=await projectRepositoryIdentity(repo),a=Buffer.from('first'),b=Buffer.from('second');
  const file=join(repo,`.ai/cezar/workflows/.managed/test/1-${hash(a)}.yaml`);
  await reconcileWorkflowFile(repo,identity,'test',1,hash(a),a);assert.deepEqual(await readFile(file),a);
  await reconcileWorkflowFile(repo,identity,'test',1,hash(a),a);
  await writeFile(file,'foreign',{mode:0o600});
  await assert.rejects(reconcileWorkflowFile(repo,identity,'test',1,hash(a),a),/WORKFLOW_FILE_CONFLICT/);
  await rm(file);await symlink(join(root,'outside'),file);
  await assert.rejects(reconcileWorkflowFile(repo,identity,'test',1,hash(a),a),/WORKFLOW_FILESYSTEM_UNAVAILABLE/);
 }finally{await rm(root,{recursive:true,force:true});}
});
