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
