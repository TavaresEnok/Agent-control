import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {databaseDumpPlan,databaseEndpoint,databaseListPlan,dumpProcessEnv,personalPgContainer,runPersonalBackup,runPersonalRestoreCheck} from '../src/personal-backup.ts';

const now=new Date(2026,10,12,9,5,30);

async function tree(){
 const root=await mkdtemp(join(tmpdir(),'personal-backup-'));
 const data=join(root,'data'),repo=join(root,'repo'),id=randomUUID();
 await mkdir(data,{recursive:true,mode:0o700});
 const file=join(data,'installation.json');
 const body={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:'postgresql://ac:s3cret@127.0.0.1:54329/agent_control',dataDirectory:data,
  accountHomesDirectory:join(data,'accounts'),
  project:{id,label:'IspAgent',repo,owner:'owner@example.com'},projects:[],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
  happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'}};
 await writeFile(file,JSON.stringify(body,null,2)+'\n',{mode:0o600});
 await chmod(file,0o600);
 const secrets:Record<string,string>={
  'happier-account.key':'happier-secret',
  'vault/item.txt':'vault-secret',
  'vault-master':'master-secret',
  'ssh/id_ed25519':'ssh-secret',
  'push/vapid.json':'{"privateKey":"vapid-secret"}\n',
  'qa/check.json':'{"test":["npm","test"]}\n',
  'remote-hosts.json':'{"hosts":[]}\n',
  'remote-projects.json':'{"projects":[]}\n',
  'happier/server.sqlite':'sqlite-secret',
  'accounts/claude/.credentials.json':'login-secret',
  'browser-session.key':'session-secret',
 };
 for(const [rel,content] of Object.entries(secrets)){
  await mkdir(join(data,rel,'..'),{recursive:true,mode:0o700});
  await writeFile(join(data,rel),content,{mode:0o644});
  await chmod(join(data,rel),0o644);
 }
 await mkdir(join(data,'native'),{recursive:true});
 await mkdir(join(data,'qa-cache'),{recursive:true});
 await mkdir(join(data,'remote','proj'),{recursive:true});
 await writeFile(join(data,'native','blob'),'NATIVE-SHOULD-STAY');
 await writeFile(join(data,'qa-cache','blob'),'CACHE-SHOULD-STAY');
 await writeFile(join(data,'remote','proj','blob'),'REMOTE-SHOULD-STAY');
 await symlink(join(data,'native','blob'),join(data,'leak'));
 return {root,data,repo,file};
}

test('database dump plan keeps the password in the environment',()=>{
 const db=databaseEndpoint('postgresql://ac:s3cret@127.0.0.1:54329/agent_control');
 assert.equal(db.password,'s3cret');
 const ps='ac-personal-pg\t127.0.0.1:54329->5432/tcp\nother\t127.0.0.1:5432->5432/tcp\n';
 assert.equal(personalPgContainer(ps,'54329'),'ac-personal-pg');
 assert.equal(personalPgContainer(ps,'5432'),null);
 const docker=databaseDumpPlan('ac-personal-pg',db);
 assert.deepEqual(docker.args,['exec','-e','PGPASSWORD','ac-personal-pg','pg_dump','-Fc','-w','-U','ac','-d','agent_control']);
 assert.equal(docker.args.some(arg=>arg.includes('s3cret')||arg.includes('postgresql://')),false);
 const local=databaseDumpPlan(null,db);
 assert.deepEqual(local,{command:'pg_dump',args:['-Fc','-w','-h','127.0.0.1','-p','54329','-U','ac','-d','agent_control']});
 assert.equal(dumpProcessEnv({PATH:'/usr/bin'},db).PGPASSWORD,'s3cret');
 assert.equal(databaseEndpoint('postgresql://ac:a%2Fb@127.0.0.1/agent_control').password,'a/b');
 assert.throws(()=>databaseEndpoint('postgresql://-ac:s3cret@127.0.0.1/agent_control'),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DATABASE_URL');
 const list=databaseListPlan('ac-personal-pg');
 assert.deepEqual(list,{command:'docker',args:['exec','-i','ac-personal-pg','pg_restore','--list']});
 assert.equal(list.args.some(arg=>arg.includes('s3cret')||arg.endsWith('.dump')),false);
 assert.deepEqual(databaseListPlan(null),{command:'pg_restore',args:['--list']});
});

test('personal backup copies secrets, skips disposable directories and refuses a destination inside the data directory',async()=>{
 const env=await tree();
 const seen:string[]=[];
 const dump=async(file:string,db:{password:string;user:string;database:string;port:string})=>{
  seen.push(db.password,db.user,db.database,db.port);
  await writeFile(file,'PGDMP-fake',{mode:0o644});
 };
 try{
  await assert.rejects(runPersonalBackup([env.file,join(env.data,'out')],{now,dump}),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DESTINATION_INSIDE_DATA');
  await assert.equal(await stat(join(env.data,'out')).then(()=>true,()=>false),false);
  await assert.rejects(runPersonalBackup([env.file,join(env.repo,'out')],{now,dump}),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DESTINATION_INSIDE_REPOSITORY');
  const dirty=join(env.root,'dirty');
  await mkdir(dirty,{mode:0o700});
  await writeFile(join(dirty,'already'),'x');
  await assert.rejects(runPersonalBackup([env.file,dirty],{now,dump}),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DESTINATION_NOT_EMPTY');
  const destination=join(env.root,'empty');
  const lines=await runPersonalBackup([env.file,destination],{now,dump});
  const backup=join(destination,'agent-control-IspAgent-20261112-0905');
  assert.equal(lines[0],`Backup em ${backup}`);
  assert.match(lines[1]??'',/^Tamanho: \d+ bytes$/);
  assert.equal((await stat(backup)).mode&0o777,0o700);
  assert.deepEqual(seen,['s3cret','ac','agent_control','54329']);
  const manifest=await readFile(join(backup,'MANIFEST.txt'),'utf8');
  assert.match(manifest,/data\/happier-account\.key/);
  assert.match(manifest,/data\/vault\/item\.txt/);
  assert.match(manifest,/data\/vault-master/);
  assert.match(manifest,/data\/ssh\/id_ed25519/);
  assert.match(manifest,/data\/push\/vapid\.json/);
  assert.match(manifest,/data\/qa\/check\.json/);
  assert.match(manifest,/data\/remote-hosts\.json/);
  assert.match(manifest,/data\/remote-projects\.json/);
  assert.match(manifest,/data\/happier\/server\.sqlite/);
  assert.match(manifest,/data\/accounts\/claude\/\.credentials\.json/);
  assert.doesNotMatch(manifest,/native\/|qa-cache\/|data\/remote\/|\/leak/);
  assert.equal(await readFile(join(backup,'database.dump'),'utf8'),'PGDMP-fake');
  assert.match(await readFile(join(backup,'RESTAURAR.md'),'utf8'),/chave da conta Happier/);
  const files=manifest.trim().split('\n');
  for(const line of files){
   const hash=line.slice(0,64),rel=line.slice(66);
   const absolute=join(backup,rel);
   assert.equal((await stat(absolute)).mode&0o777,0o600);
   assert.equal(createHash('sha256').update(await readFile(absolute)).digest('hex'),hash);
   assert.equal((await readFile(absolute)).includes(Buffer.from('NATIVE-SHOULD-STAY')),false);
   assert.equal((await readFile(absolute)).includes(Buffer.from('CACHE-SHOULD-STAY')),false);
   assert.equal((await readFile(absolute)).includes(Buffer.from('REMOTE-SHOULD-STAY')),false);
  }
  const directories=['data','data/ssh','data/vault','data/push','data/qa','data/happier','data/accounts','data/accounts/claude'];
  for(const rel of directories)assert.equal((await stat(join(backup,rel))).mode&0o777,0o700);
  await assert.rejects(runPersonalBackup([env.file,destination],{now,dump}),(error:unknown)=>error instanceof Refusal&&error.code==='BACKUP_DESTINATION_NOT_EMPTY');
  assert.equal((await readdir(destination)).length,1);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('personal backup omits happier data that belongs to another installation',async()=>{
 const env=await tree();
 await writeFile(join(env.data,'happier-shared-from'),'/other/installation.json\n',{mode:0o600});
 const dump=async(file:string)=>{await writeFile(file,'PGDMP-fake',{mode:0o600});};
 try{
  const destination=join(env.root,'empty');
  await runPersonalBackup([env.file,destination],{now,dump});
  const manifest=await readFile(join(destination,'agent-control-IspAgent-20261112-0905','MANIFEST.txt'),'utf8');
  assert.match(manifest,/happier-shared-from/);
  assert.doesNotMatch(manifest,/data\/happier\//);
 }finally{await rm(env.root,{recursive:true,force:true});}
});

test('restore check matches every sha256 and does not restore when the dump is unreadable or a file changes',async()=>{
 const env=await tree();
 const dump=async(file:string)=>{await writeFile(file,'PGDMP-fake',{mode:0o600});};
 const destination=join(env.root,'empty');
 try{
  await runPersonalBackup([env.file,destination],{now,dump});
  const backup=join(destination,'agent-control-IspAgent-20261112-0905');
  const listed:string[]=[];
  await assert.rejects(runPersonalRestoreCheck([backup],{listDump:async()=>{throw new Error('bad archive');}}),(error:unknown)=>error instanceof Refusal&&error.code==='RESTORE_DUMP_UNREADABLE');
  assert.equal(listed.length,0);
  const lines=await runPersonalRestoreCheck([backup],{listDump:async file=>{listed.push(file);}});
  assert.match(lines[0]??'',/MANIFEST\.txt confere \(\d+ arquivos\)\./);
  assert.equal(lines[1],'database.dump é legível.');
  assert.deepEqual(listed,[join(backup,'database.dump')]);
  await writeFile(join(backup,'data','happier-account.key'),'tampered\n',{mode:0o600});
  await assert.rejects(runPersonalRestoreCheck([backup],{listDump:async()=>{listed.push('again');}}),(error:unknown)=>error instanceof Refusal&&error.code==='RESTORE_MANIFEST_MISMATCH');
  assert.deepEqual(listed,[join(backup,'database.dump')]);
  await assert.rejects(runPersonalRestoreCheck([join(env.root,'missing')]),(error:unknown)=>error instanceof Refusal&&error.code==='RESTORE_NOT_A_BACKUP');
 }finally{await rm(env.root,{recursive:true,force:true});}
});
