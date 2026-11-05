import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Installation} from '../src/installation.ts';
import {RemoteReturnConfig} from '../src/remote-return-config.ts';
import {OpenSshTransport,type RemoteHost} from '../src/remote.ts';

test('SSH return configuration separates credentials from every writable project root',()=>{
 const id=randomUUID(),config={schemaVersion:1,mode:'administration-only',databaseUrl:'postgres://localhost/ac_implementation_test',dataDirectory:'/private/ac',
 project:{id,label:'fixture',repo:'/projects/one',owner:'owner'},projects:[],projectRoots:[{id:'allowed',path:'/projects',label:'Projects'}],
 http:{listen:'127.0.0.1',port:18405,publicOrigin:'http://127.0.0.1:18405'},
 happier:{upstreamOrigin:'http://127.0.0.1:18401',webOrigin:'http://127.0.0.1:18400',publicServerOrigin:'http://127.0.0.1:18401'}};
 const withKey=(path:string)=>({...config,remoteReturn:{allowedHosts:['localhost'],credentials:[{id:randomUUID(),path}]}});
 assert(Installation.safeParse(withKey('/private/ac/ssh-key')).success);
 for(const path of ['/projects/one/key','/projects/future/key','/projects','/private/ac/../key'])assert.equal(Installation.safeParse(withKey(path)).success,false,path);
 assert.equal(RemoteReturnConfig.safeParse({allowedHosts:['localhost'],credentials:[{id,path:'relative'}]}).success,false);
});

test('SSH transport refuses mutable aliases and shared or exposed credential files before exchange',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-r3-ssh-custody-')),key=join(root,'key');
 const host:RemoteHost={id:randomUUID(),hostname:'localhost',port:1,username:'fixture',public_key:'fixture-only',fingerprint:'fixture',credential_ref:randomUUID(),remote_root:'/fixture'};
 const exchange=(path:string)=>new OpenSshTransport(async()=>path,new Set(['localhost'])).exchange(host,{});
 try{
  await writeFile(key,'synthetic-key-only',{mode:0o600});
  const alias=join(root,'alias');await symlink(key,alias);await assert.rejects(exchange(alias),/SSH_CREDENTIAL_UNSAFE/);
  const parentAlias=root+'-alias';await symlink(root,parentAlias);
  try{await assert.rejects(exchange(join(parentAlias,'key')),/SSH_CREDENTIAL_UNSAFE/);}finally{await rm(parentAlias);}
  const hard=join(root,'hard');await link(key,hard);await assert.rejects(exchange(key),/SSH_CREDENTIAL_UNSAFE/);await rm(hard);
  await chmod(key,0o644);await assert.rejects(exchange(key),/SSH_CREDENTIAL_UNSAFE/);
  await chmod(key,0o600);await writeFile(key,Buffer.alloc(65537));await assert.rejects(exchange(key),/SSH_CREDENTIAL_UNSAFE/);
 }finally{await rm(root,{recursive:true,force:true});}
});
