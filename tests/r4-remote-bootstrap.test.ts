import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Installation} from '../src/installation.ts';
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
