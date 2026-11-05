import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Installation,readPrivateFile} from '../src/installation.ts';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredRemoteDevelopment} from '../src/remote-development-config.ts';

test('remote development bootstrap is explicit synthetic opt-in with isolated custody and fixed configured projects',()=>{
 const projectId=randomUUID(),profile={profileId:randomUUID(),hostId:randomUUID(),taskId:'fixed',writePaths:['src/']};
 const remoteDevelopment={mode:'synthetic-fixed-task-v1',transport:{allowedHosts:['localhost'],credentials:[{id:randomUUID(),path:'/private/ac/ssh-key'}]},projects:[{projectId,verifierKeyFile:'/private/ac/verifier',tmpfsRoot:'/dev/shm/ac-lab',profiles:[profile]}]};
 const config={schemaVersion:1,mode:'administration-only',databaseUrl:'postgres://localhost/ac_implementation_test',dataDirectory:'/private/ac',
  project:{id:projectId,label:'fixture',repo:'/projects/one',owner:'owner'},projectRoots:[{id:'allowed',path:'/projects',label:'Projects'}],
  http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
  happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}};
 assert.equal(Installation.parse(config).remoteDevelopment,undefined);
 assert.equal(configuredRemoteDevelopment({} as never,undefined,()=>undefined),undefined);
 assert(Installation.safeParse({...config,remoteDevelopment}).success);
 const change=(update:object)=>({...config,remoteDevelopment:{...remoteDevelopment,projects:[{...remoteDevelopment.projects[0],...update}]}});
 for(const update of [{projectId:randomUUID()},{verifierKeyFile:'/projects/one/key'},{verifierKeyFile:'/private/ac/../key'},
  {tmpfsRoot:'/projects/future'},{tmpfsRoot:'/private/ac/workspace'},{tmpfsRoot:'/private'},{tmpfsRoot:'/dev/shm/../other'}])assert.equal(Installation.safeParse(change(update)).success,false,JSON.stringify(update));
 for(const path of ['/projects/future/key','/dev/shm/ac-lab/key'])assert.equal(Installation.safeParse({...config,remoteDevelopment:{...remoteDevelopment,transport:{...remoteDevelopment.transport,credentials:[{id:randomUUID(),path}]}}}).success,false);
 assert.equal(Installation.safeParse({...config,remoteDevelopment:{...remoteDevelopment,mode:'real-provider'}}).success,false);
});


test('configured verifier custody binds the opened descriptor to its canonical path, rejecting parent aliases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-r4-verifier-'));
 try{
  const writable=join(root,'project'),privateRoot=join(root,'private');await mkdir(writable,{mode:0o700});await mkdir(privateRoot,{mode:0o700});
  const key=Buffer.alloc(32,7);await writeFile(join(writable,'key'),key,{mode:0o600});
  await symlink(writable,join(privateRoot,'alias'));
  await assert.rejects(readPrivateFile(join(privateRoot,'alias','key'),32,{canonical:true}),/NON_CANONICAL_PRIVATE_FILE/);
  await writeFile(join(privateRoot,'key'),key,{mode:0o600});
  assert.deepEqual(await readPrivateFile(join(privateRoot,'key'),32,{canonical:true}),key);
 }finally{await rm(root,{recursive:true,force:true});}
});
