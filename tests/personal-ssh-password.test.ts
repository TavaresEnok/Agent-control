import test from 'node:test';
import assert from 'node:assert/strict';
import {installKeyRemoteCommand,installKeyWithPassword,passwordSshArgs} from '../src/personal-ssh.ts';

test('the password never reaches ssh arguments, and the remote command only appends a valid public key',()=>{
 const args=passwordSshArgs('/data/ssh/known_hosts');
 assert.ok(args.includes('StrictHostKeyChecking=yes')&&args.includes('PubkeyAuthentication=no')&&args.includes('NumberOfPasswordPrompts=1'));
 assert.ok(!args.some(arg=>/password=|sshpass/i.test(arg)));
 const command=installKeyRemoteCommand('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBSIexample agent-control');
 assert.match(command,/authorized_keys/);
 assert.throws(()=>installKeyRemoteCommand("ssh-ed25519 AAAA'; rm -rf ~"),/SSH_KEY_INVALID/);
});

test('an unknown or unconfirmed host is refused before any connection',async()=>{
 await assert.rejects(installKeyWithPassword('/nonexistent-data','00000000-0000-4000-8000-000000000000','x'),/HOST_NOT_FOUND|REMOTE_FILE_INVALID/);
 await assert.rejects(installKeyWithPassword('/nonexistent-data','not-a-uuid','x'),/HOST_NOT_FOUND/);
});

test('parallel password installs reserve the failure budget and it renews after ten minutes',async t=>{
 const {mkdtemp,rm,writeFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const directory=await mkdtemp(join(tmpdir(),'ac-ssh-password-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const id='00000000-0000-4000-8000-000000000000';
 await writeFile(join(directory,'remote-hosts.json'),JSON.stringify([{
  id,host:'server.example',port:22,user:'deploy',label:'Test',
  fingerprint:'SHA256:'+'a'.repeat(43),
 }]));
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 let launched=0;
 const transport=async()=>{launched++;await held;return {code:5,stderr:''};};
 const now=Date.now();
 const settled=Promise.allSettled(Array.from({length:8},()=>installKeyWithPassword(directory,id,'synthetic',now,transport)));
 try{
  for(let count=0;count<100&&launched<5;count++)await new Promise(resolve=>setTimeout(resolve,5));
 }finally{release();}
 const codes=(await settled).map(result=>result.status==='rejected'?result.reason.code:null);
 assert.equal(launched,5);
 assert.equal(codes.filter(code=>code==='SSH_PASSWORD_LIMIT').length,3);
 assert.equal(codes.filter(code=>code==='SSH_PASSWORD_REJECTED').length,5);
 await assert.rejects(installKeyWithPassword(directory,id,'synthetic',now,transport),/SSH_PASSWORD_LIMIT/);
 await assert.rejects(installKeyWithPassword(directory,id,'synthetic',now+600_000,transport),/SSH_PASSWORD_REJECTED/);
 assert.equal(launched,6);
});
