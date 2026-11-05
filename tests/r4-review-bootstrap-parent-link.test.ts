import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Installation,readPrivateFile} from '../src/installation.ts';
test('review counterproof: lexical verifier custody accepts symlink parent into repository',async()=>{
 const area=await mkdtemp(join(tmpdir(),'ac-r4-review-key-'));
 try{
  const privateRoot=join(area,'private'),projects=join(area,'projects'),repo=join(projects,'one');
  await mkdir(privateRoot,{mode:0o700});await mkdir(repo,{recursive:true,mode:0o700});
  await writeFile(join(repo,'verifier'),Buffer.alloc(32,41),{mode:0o600});await symlink(repo,join(privateRoot,'link'));
  const projectId=randomUUID();
  const config={schemaVersion:1,mode:'administration-only',databaseUrl:'postgres://localhost/ac_implementation_test',dataDirectory:privateRoot,
   project:{id:projectId,label:'fixture',repo,owner:'owner'},projectRoots:[{id:'allowed',path:projects,label:'Projects'}],
   http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
   happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'},
   remoteDevelopment:{mode:'synthetic-fixed-task-v1',transport:{allowedHosts:['localhost'],credentials:[{id:randomUUID(),path:join(privateRoot,'ssh')}]},projects:[{projectId,verifierKeyFile:join(privateRoot,'link','verifier'),tmpfsRoot:'/dev/shm/ac-review-key',profiles:[{profileId:randomUUID(),hostId:randomUUID(),taskId:'fixed',writePaths:['src/']}]}]}};
  assert.equal(Installation.safeParse(config).success,true);
  assert.deepEqual(await readPrivateFile(config.remoteDevelopment.projects[0].verifierKeyFile,32),Buffer.alloc(32,41));
 }finally{await rm(area,{recursive:true,force:true});}
});
