import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {databaseEndpoint,databaseRestorePlan,resolvePgInstance,runPersonalBackup} from '../src/personal-backup.ts';
import {restoreProofCleanupFailedNotice,restoreProofFailedNotice,runPersonalRestoreProof,type ProofServer} from '../src/personal-restore-proof.ts';

const ps='ac-personal-pg\t0.0.0.0:54329->5432/tcp\nother\t0.0.0.0:9->9/tcp\n';

async function fixture(databaseUrl:string){
 const root=await mkdtemp(join(tmpdir(),'restore-proof-test-'));
 const data=join(root,'data'),repo=join(root,'repo');
 await mkdir(data,{recursive:true,mode:0o700});await mkdir(repo);
 const file=join(data,'installation.json');
 const body={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl,dataDirectory:data,accountHomesDirectory:join(data,'accounts'),
  project:{id:randomUUID(),label:'Prova',repo,owner:'owner@example.com'},projects:[],
  http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'}};
 await writeFile(file,JSON.stringify(body,null,2)+'\n',{mode:0o600});await chmod(file,0o600);
 const backups=join(root,'backups');
 await runPersonalBackup([file,join(backups,'20261112-090530')],{now:new Date(2026,10,12,9,5,30),dump:async dumpFile=>{await writeFile(dumpFile,'PGDMP-test');}});
 return {root,data,file,backups};
}

function stubServer(events:string[],options:{dropFails?:boolean}={}):ProofServer{
 return {
  create:async database=>{events.push('create:'+database);},
  count:async database=>{events.push('count:'+database);return {projects:2,contexts:3,intents:4};},
  drop:async database=>{events.push('drop:'+database);if(options.dropFails)throw new Error('cannot drop');},
  close:async()=>{events.push('close');},
 };
}

test('o contêiner local só vale para endereço loopback; servidor remoto na mesma porta usa a rede',async()=>{
 const local=databaseEndpoint('postgresql://ac:pw@127.0.0.1:54329/agent_control');
 const remote=databaseEndpoint('postgresql://ac:pw@db.remoto.example:54329/agent_control');
 assert.equal(await resolvePgInstance(local,async()=>ps),'ac-personal-pg');
 assert.equal(await resolvePgInstance(remote,async()=>ps),null);
 const plan=databaseRestorePlan(null,remote,'ac_proof');
 assert.equal(plan.command,'pg_restore');
 assert.deepEqual(plan.args.slice(plan.args.indexOf('-h'),plan.args.indexOf('-h')+4),['-h','db.remoto.example','-p','54329']);
 assert.equal(databaseRestorePlan('ac-personal-pg',local,'ac_proof').command,'docker');
});

test('a prova restaura no servidor remoto e não no contêiner local de mesma porta',async()=>{
 const f=await fixture('postgresql://ac:pw@db.remoto.example:54329/agent_control');
 try{
  const events:string[]=[],commands:{command:string;args:string[]}[]=[];
  const lines=await runPersonalRestoreProof([f.file,f.backups],{
   now:()=>new Date(Date.UTC(2026,10,20,3,0,0)),dockerPs:async()=>ps,notify:async()=>{},server:stubServer(events),
   run:async(command,args)=>{commands.push({command,args});return {code:0,stderr:''};},
  });
  assert.equal(commands.length,1);
  assert.equal(commands[0]?.command,'pg_restore');
  assert.ok(commands[0]?.args.includes('db.remoto.example'));
  assert.equal(commands.some(item=>item.command==='docker'),false);
  assert.deepEqual(events,['create:ac_restore_proof_20261120030000','count:ac_restore_proof_20261120030000','drop:ac_restore_proof_20261120030000','close']);
  assert.match(lines[0]??'',/restaurado/);
  const result=JSON.parse(await readFile(join(f.data,'restore-proof.json'),'utf8'));
  assert.equal(result.ok,true);assert.deepEqual(result.cleanup,{ok:true});
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('o mesmo endereço em loopback usa o contêiner local',async()=>{
 const f=await fixture('postgresql://ac:pw@127.0.0.1:54329/agent_control');
 try{
  const commands:{command:string;args:string[]}[]=[];
  await runPersonalRestoreProof([f.file,f.backups],{
   now:()=>new Date(Date.UTC(2026,10,20,3,0,0)),dockerPs:async()=>ps,notify:async()=>{},server:stubServer([]),
   run:async(command,args)=>{commands.push({command,args});return {code:0,stderr:''};},
  });
  assert.equal(commands[0]?.command,'docker');
  assert.ok(commands[0]?.args.includes('ac-personal-pg'));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('falha ao excluir o banco temporário é registrada à parte e avisada',async()=>{
 const f=await fixture('postgresql://ac:pw@db.remoto.example:54329/agent_control');
 try{
  const notices:string[]=[];
  const lines=await runPersonalRestoreProof([f.file,f.backups],{
   now:()=>new Date(Date.UTC(2026,10,20,3,0,0)),notify:async(_dir,body)=>{notices.push(body);},server:stubServer([],{dropFails:true}),
   run:async()=>({code:0,stderr:''}),
  });
  const result=JSON.parse(await readFile(join(f.data,'restore-proof.json'),'utf8'));
  assert.equal(result.ok,true);
  assert.deepEqual(result.cleanup,{ok:false,database:'ac_restore_proof_20261120030000',code:'RESTORE_PROOF_CLEANUP_FAILED'});
  assert.deepEqual(notices,[restoreProofCleanupFailedNotice]);
  assert.ok(lines.some(line=>line.includes('não foi removido')));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('restauração que falha também registra a limpeza que falhou, com um só aviso',async()=>{
 const f=await fixture('postgresql://ac:pw@db.remoto.example:54329/agent_control');
 try{
  const notices:string[]=[];
  await assert.rejects(runPersonalRestoreProof([f.file,f.backups],{
   now:()=>new Date(Date.UTC(2026,10,20,3,0,0)),notify:async(_dir,body)=>{notices.push(body);},server:stubServer([],{dropFails:true}),
   run:async()=>({code:1,stderr:'x'}),
  }),(error:any)=>error.code==='RESTORE_PROOF_RESTORE_FAILED');
  const result=JSON.parse(await readFile(join(f.data,'restore-proof.json'),'utf8'));
  assert.equal(result.ok,false);assert.equal(result.code,'RESTORE_PROOF_RESTORE_FAILED');assert.equal(result.cleanup.ok,false);
  assert.deepEqual(notices,[restoreProofFailedNotice]);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
