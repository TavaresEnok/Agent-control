import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile as execFileCallback,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const execFile=promisify(execFileCallback);
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

test('concurrent synthetic CLIs cannot read the other container credential through shell, links or proc', {timeout:60000},async()=>{
 if(process.env.AC_CREDENTIAL_ISOLATION_PHYSICAL!=='1')throw Error('ISOLATED_CREDENTIAL_TEST_OPT_IN_REQUIRED');
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid)throw Error('NON_ROOT_TEST_REQUIRED');
 const image=docker('image','inspect','node:22-alpine','--format','{{.Id}}');assert.match(image,/^sha256:[a-f0-9]{64}$/);
 const root=await mkdtemp(join(tmpdir(),'ac-credential-physical-')),id=randomUUID(),names=[`ac-credential-${id}-a`,`ac-credential-${id}-b`];
 const secrets=[`SYNTHETIC_A_${randomUUID()}`,`SYNTHETIC_B_${randomUUID()}`];
 let originalError:unknown;
 try{
  for(let i=0;i<2;i++){
   const account=join(root,`account-${i}`);await mkdir(join(account,'.codex'),{recursive:true,mode:0o700});
   await writeFile(join(account,'.codex','auth.json'),secrets[i],{mode:0o600});
   const containerId=docker('run','-d','--name',names[i],'--label',`agent-control.test=${id}`,'--network','none','--user',`${uid}:${gid}`,
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','96','--memory','512m','--cpus','1',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--mount',`type=bind,src=${account},dst=/account`,
    '--env','HOME=/account','--env','CODEX_HOME=/account/.codex','--entrypoint','/bin/sh',image,'-c','exec sleep 90');
   assert.equal(docker('ps','-aq','--no-trunc','--filter',`name=^/${names[i]}$`,'--filter',`label=agent-control.test=${id}`),containerId);
  }
  const pids=names.map(name=>Number(docker('inspect','--format','{{.State.Pid}}',name)));assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>1));assert.notEqual(pids[0],pids[1]);
  const namespaces=names.map(name=>docker('exec',name,'readlink','/proc/1/ns/pid'));assert.notEqual(namespaces[0],namespaces[1]);
  const script=`set -eu
printf 'CONTROL:'; cat /account/.codex/auth.json; printf '\\n'
for path in "$1/.codex/auth.json" "/proc/$2/root/account/.codex/auth.json"; do
  cat "$path" 2>/dev/null || :
  ln -s "$path" /tmp/foreign-link; cat /tmp/foreign-link 2>/dev/null || :; rm /tmp/foreign-link
done
for path in /proc/[0-9]*/root/account/.codex/auth.json; do cat "$path" 2>/dev/null || :; done`;
  const results=await Promise.all(names.map((name,i)=>execFile('docker',['exec',name,'/bin/sh','-c',script,'attack',join(root,`account-${1-i}`),String(pids[1-i])],{encoding:'utf8',timeout:15000})));
  for(let i=0;i<2;i++){
   const output=results[i].stdout+results[i].stderr;
   assert.ok(output.includes(`CONTROL:${secrets[i]}`),'own credential must be readable');
   assert.equal(output.includes(secrets[1-i]),false,'foreign credential leaked');
  }
 }catch(error){originalError=error;}
 finally{
  const cleanupErrors:unknown[]=[];
  for(const name of names){
   try{
    const find=()=>docker('ps','-aq','--filter',`name=^/${name}$`,'--filter',`label=agent-control.test=${id}`);
    const ids=find().split('\n').filter(Boolean);
    for(const containerId of ids)docker('rm','-f',containerId);
    if(find())throw Error(`TEST_CONTAINER_CLEANUP_INCOMPLETE: ${name}`);
   }catch(error){cleanupErrors.push(error);}
  }
  try{await rm(root,{recursive:true,force:true});}catch(error){cleanupErrors.push(error);}
  if(cleanupErrors.length)throw new AggregateError(originalError===undefined?cleanupErrors:[originalError,...cleanupErrors],'TEST_CLEANUP_FAILED');
 }
 if(originalError!==undefined)throw originalError;
});
