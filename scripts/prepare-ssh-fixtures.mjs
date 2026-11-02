// Disposable keys and hosts, never operational SSH identities.
import {mkdir,readFile,writeFile,chown,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const root='/fixtures';await mkdir(root,{recursive:true});await chown(root,1000,1000);await chmod(root,0o755);
let projectId;
try{projectId=JSON.parse(await readFile(root+'/metadata.json','utf8')).projectId;}catch{projectId=randomUUID();}
try{await readFile(root+'/controller');}catch{execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',root+'/controller']);}
await chown(root+'/controller',1000,1000);await chmod(root+'/controller',0o600);
const publicKey=(await readFile(root+'/controller.pub','utf8')).trim();
for(const name of ['a','b']){
 const dir=root+'/host-'+name;await mkdir(dir,{recursive:true,mode:0o755});await chown(dir,1000,1000);
 try{await readFile(dir+'/host_key');}catch{execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',dir+'/host_key']);}
 await writeFile(dir+'/authorized_keys',publicKey+'\n',{mode:0o600});await chown(dir+'/authorized_keys',1000,1000);
 await writeFile(dir+'/worker.json',JSON.stringify({stateDirectory:'/projects/journal',projects:{[projectId]:'/projects/repo'},
  tasks:{count:['/usr/bin/python3','-c',"import pathlib;print(len(pathlib.Path('launches').read_text()))"],fixture:['/usr/bin/python3','-c',"import pathlib,time;p=pathlib.Path('launches');p.open('a').write('x');time.sleep(.4)"],
   slow:['/usr/bin/python3','-c',"import pathlib,time;p=pathlib.Path('slow-launches');p.open('a').write('x');time.sleep(2)"]},maxSeconds:5,maxLogBytes:4096}));
 await writeFile(dir+'/sshd_config',`Port 2222\nListenAddress 0.0.0.0\nHostKey /fixtures/host-${name}/host_key\nPidFile /run/sshd.pid\nAuthorizedKeysFile /fixtures/host-${name}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers node\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitTTY no\nForceCommand /usr/bin/python3 /usr/local/lib/agent-control/worker.py --config /fixtures/host-${name}/worker.json\nLogLevel ERROR\n`);
}
await writeFile(root+'/metadata.json',JSON.stringify({projectId,scope:'isolated-ssh-fixture'}));
console.log('Isolated SSH fixtures prepared; private keys are not logged.');
