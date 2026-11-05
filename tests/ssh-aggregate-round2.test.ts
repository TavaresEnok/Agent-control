import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {OpenSshTransport,type RemoteHost} from '../src/remote.ts';

test('SSH aliases sharing a worker state serialize admission and retain uncertain capacity', {timeout:20000,skip:!process.env.AC_SSH_FIXTURE_ROOT},async()=>{
 const root=process.env.AC_SSH_FIXTURE_ROOT!,meta=JSON.parse(await readFile(root+'/metadata.json','utf8'));
 assert.equal(meta.scope,'isolated-ssh-fixture');
 const publicKey=(await readFile(root+'/host-a/host_key.pub','utf8')).trim();
 const fingerprint=execFileSync('ssh-keygen',['-lf',root+'/host-a/host_key.pub','-E','sha256'],{encoding:'utf8'}).trim().split(/\s+/)[1];
 const aliases=['ssh-host-a','ac-r2-remote-20261105-ssh-host-a-1'];
 const ssh=new OpenSshTransport(async()=>root+'/controller',new Set(aliases));
 const hosts:RemoteHost[]=aliases.map(hostname=>({id:randomUUID(),hostname,port:2222,username:'node',public_key:publicKey,fingerprint,credential_ref:randomUUID(),remote_root:'/projects/repo'}));
 const make=()=>({schemaVersion:1,action:'start',operationId:randomUUID(),projectId:meta.projectId,taskId:'slow',root:'/projects/repo',epoch:1});
 const requests=[make(),make()];
 const attempts=await Promise.allSettled(requests.map((r,i)=>ssh.exchange(hosts[i],r)));
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
 const winner=attempts.findIndex(x=>x.status==='fulfilled'),loser=1-winner;
 const replay:any=await ssh.exchange(hosts[loser],requests[winner]);assert.equal(replay.operationId,requests[winner].operationId);
 await assert.rejects(ssh.exchange(hosts[loser],requests[loser]));
 let finished:any;
 for(let i=0;i<60;i++){finished=await ssh.exchange(hosts[loser],{schemaVersion:1,action:'inspect',operationId:requests[winner].operationId});if(finished.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(finished.state,'completed');assert.equal(finished.exitCode,0);assert.match(finished.logSha256,/^[a-f0-9]{64}$/);
 const next:any=await ssh.exchange(hosts[loser],requests[loser]);assert.equal(next.operationId,requests[loser].operationId);
 for(let i=0;i<60;i++){finished=await ssh.exchange(hosts[winner],{schemaVersion:1,action:'inspect',operationId:requests[loser].operationId});if(finished.state==='completed')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(finished.state,'completed');
});
