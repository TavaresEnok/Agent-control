import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {OffsiteCopyRefusal,offsiteFailedNotice,parseOffsiteDestination,personalBackupRotateStamp,personalOffsiteRsyncPlan,runPersonalBackupRotate,type RsyncPlan} from '../src/personal-backup-rotate.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'personal-rotate-'));
 const data=join(root,'data'),repo=join(root,'repo'),id=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 await mkdir(repo,{recursive:true});
 const file=join(data,'installation.json');
 const body={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://ac:s3cret@127.0.0.1:54329/agent_control',dataDirectory:data,
  accountHomesDirectory:join(data,'accounts'),
  project:{id,label:'IspAgent',repo,owner:'owner@example.com'},projects:[],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
  happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'}};
 await writeFile(file,JSON.stringify(body)+'\n',{mode:0o600});
 await chmod(file,0o600);
 await mkdir(join(data,'accounts'),{recursive:true});
 await writeFile(join(data,'marker.txt'),'s3cret-marker',{mode:0o600});
 return {root,data,file};
}

const dump=async(file:string)=>{await writeFile(file,'PGDMP-fake',{mode:0o600});};

async function stampDirs(directory:string){
 const names:string[]=[];
 for(const name of await readdir(directory)){
  const info=await lstat(join(directory,name));
  if(/^\d{8}-\d{6}$/.test(name)&&info.isDirectory()&&!info.isSymbolicLink())names.push(name);
 }
 names.sort();
 return names;
}

test('rotation keeps seven dated backups and deletes only real directories inside the destination',async()=>{
 const env=await fixture();
 const dest=join(env.root,'backups');
 const outside=join(env.root,'outside');
 await mkdir(dest,{recursive:true});
 await mkdir(outside,{recursive:true});
 await writeFile(join(outside,'keep'),'stay');
 await writeFile(join(dest,'notes.txt'),'keep-me');
 await symlink(outside,join(dest,'19990101-000000'));
 const planted=join(dest,'20190101-000000');
 await mkdir(planted);
 await symlink(join(outside,'keep'),join(planted,'leak'));
 try{
  let last='';
  for(let second=0;second<8;second++){
   const now=new Date(2026,0,1,3,30,second);
   last=personalBackupRotateStamp(now);
   const lines=await runPersonalBackupRotate([env.file,dest],{now,dump});
   assert.equal(lines.some(line=>line.includes('s3cret')),false);
   assert.match(lines.at(-1)??'',/^Mantidos: \d+$/);
  }
  const kept=await stampDirs(dest);
  assert.equal(kept.length,7);
  assert.equal(kept.includes('20190101-000000'),false);
  assert.equal(kept.includes(personalBackupRotateStamp(new Date(2026,0,1,3,30,0))),false);
  assert.equal(kept.includes(last),true);
  assert.equal((await lstat(join(dest,'19990101-000000'))).isSymbolicLink(),true);
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'stay');
  assert.equal(await readFile(join(dest,'notes.txt'),'utf8'),'keep-me');
  const newest=await readdir(join(dest,last));
  const backup=newest.find(name=>name.startsWith('agent-control-'));
  assert.ok(backup);
  assert.match(await readFile(join(dest,last,backup,'MANIFEST.txt'),'utf8'),/database\.dump/);
  assert.equal(await readFile(join(dest,last,backup,'database.dump'),'utf8'),'PGDMP-fake');
  await assert.rejects(runPersonalBackupRotate([env.file,join(env.data,'inside')],{now:new Date(2026,0,1,4,0,0),dump}),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DESTINATION_INSIDE_DATA');
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a failed offsite copy notifies and deletes nothing',async()=>{
 const env=await fixture();
 const dest=join(env.root,'backups');
 const outside=join(env.root,'outside');
 await mkdir(dest,{recursive:true});
 await mkdir(outside,{recursive:true});
 await writeFile(join(outside,'keep'),'stay');
 await symlink(outside,join(dest,'19990101-000000'));
 for(let day=1;day<=7;day++)await mkdir(join(dest,`2020010${day}-000000`));
 await writeFile(join(env.data,'backup-offsite'),'usuario@backup.example:/srv/agent-control\n',{mode:0o600});
 await mkdir(join(env.data,'ssh'),{mode:0o700});
 await writeFile(join(env.data,'ssh/id_ed25519'),'BEGIN KEY s3cret',{mode:0o600});
 await writeFile(join(env.data,'ssh/known_hosts'),'backup.example ssh-ed25519 AAAA\n',{mode:0o600});
 const sent:string[]=[];
 let rsyncs=0;
 const now=new Date(2026,10,13,3,30,5);
 try{
  await assert.rejects(runPersonalBackupRotate([env.file,dest],{now,dump,rsync:async()=>{rsyncs+=1;throw new Error('ssh down');},notify:async(_dir,body)=>{sent.push(body);}}),(error:unknown)=>error instanceof OffsiteCopyRefusal&&error.code==='BACKUP_OFFSITE_FAILED'&&error.lines.every(line=>!line.includes('backup.example')&&!line.includes('s3cret')));
  assert.equal(rsyncs,1);
  assert.deepEqual(sent,[offsiteFailedNotice]);
  const kept=await stampDirs(dest);
  assert.equal(kept.length,8);
  assert.equal(kept.includes('20200101-000000'),true);
  assert.equal(kept.includes(personalBackupRotateStamp(now)),true);
  assert.equal((await lstat(join(dest,'19990101-000000'))).isSymbolicLink(),true);
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'stay');
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('a successful offsite copy prunes to seven and the rsync plan carries the installation key',async()=>{
 const env=await fixture();
 const dest=join(env.root,'backups');
 await mkdir(dest,{recursive:true});
 for(let day=1;day<=7;day++)await mkdir(join(dest,`2020010${day}-000000`));
 await writeFile(join(env.data,'backup-offsite'),'usuario@backup.example:/srv/agent-control\n',{mode:0o600});
 await mkdir(join(env.data,'ssh'),{mode:0o700});
 await writeFile(join(env.data,'ssh/id_ed25519'),'BEGIN KEY',{mode:0o600});
 await writeFile(join(env.data,'ssh/known_hosts'),'host-line\n',{mode:0o600});
 const plans:RsyncPlan[]=[];
 const now=new Date(2026,10,13,3,30,5);
 try{
  const lines=await runPersonalBackupRotate([env.file,dest],{now,dump,rsync:async plan=>{plans.push(plan);},notify:async()=>{throw new Error('should not notify');}});
  assert.equal(lines.some(line=>line.includes('backup.example')||line.includes('BEGIN KEY')),false);
  assert.equal(lines.at(-1),`Mantidos: 7`);
  assert.equal(lines.includes('Cópia externa feita.'),true);
  const kept=await stampDirs(dest);
  assert.deepEqual(kept,[...[2,3,4,5,6,7].map(day=>`2020010${day}-000000`),personalBackupRotateStamp(now)]);
  assert.equal(plans.length,1);
  const plan=plans[0]!;
  assert.equal(plan.command,'rsync');
  assert.equal(plan.args[0],'-a');
  assert.equal(plan.args.includes('--'),true);
  assert.equal(plan.args.at(-1),'usuario@backup.example:/srv/agent-control/');
  assert.match(plan.args[2]??'',/IdentityFile=/);
  assert.match(plan.args[2]??'',/known_hosts/);
  assert.equal(plan.args.some(arg=>arg.includes('BEGIN KEY')||arg.includes('s3cret')),false);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('offsite destination parsing rejects paths that leave the remote folder',()=>{
 assert.deepEqual(parseOffsiteDestination('usuario@host.example:/caminho'),{user:'usuario',host:'host.example',path:'/caminho'});
 assert.equal(parseOffsiteDestination('usuario@host:caminho'),null);
 assert.equal(parseOffsiteDestination('usuario@host:/caminho/../../etc'),null);
 assert.equal(parseOffsiteDestination('usuario@host:/ok/'),null);
 assert.equal(parseOffsiteDestination('a b@host:/ok'),null);
 assert.equal(personalOffsiteRsyncPlan('/srv/backup','user@host:/x/../../etc','/keys/id','/keys/known_hosts'),null);
 const plan=personalOffsiteRsyncPlan('/srv/backup','usuario@host.example:/caminho','/keys/my id','/known hosts');
 assert.ok(plan);
 assert.equal(plan.args[0],'-a');
 assert.equal(plan.args[4],'/srv/backup');
 assert.equal(plan.args[5],'usuario@host.example:/caminho/');
 assert.ok(plan.args[2].includes("'IdentityFile=/keys/my id'"));
 assert.ok(plan.args[2].includes("'UserKnownHostsFile=/known hosts'"));
});

test('an invalid offsite file notifies and deletes nothing',async()=>{
 const env=await fixture();
 const dest=join(env.root,'backups');
 await mkdir(dest,{recursive:true});
 await mkdir(join(dest,'20200101-000000'));
 await symlink(join(env.root,'elsewhere'),join(env.data,'backup-offsite'));
 const sent:string[]=[];
 try{
  await assert.rejects(runPersonalBackupRotate([env.file,dest],{now:new Date(2026,10,13,3,30,9),dump,notify:async(_dir,body)=>{sent.push(body);}}),(error:unknown)=>error instanceof OffsiteCopyRefusal);
  assert.deepEqual(sent,[offsiteFailedNotice]);
  assert.equal((await stampDirs(dest)).includes('20200101-000000'),true);
  assert.equal((await stampDirs(dest)).length,2);
 }finally{await rm(env.root,{recursive:true,force:true});}
});
