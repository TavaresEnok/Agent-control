import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {canonical,digest} from '../src/contracts.ts';
import {defaultPersonalQaContract,parsePersonalQaConfig,personalQaContractFromConfig} from '../src/personal-qa-config.ts';
import {nativeQaContractDigest} from '../src/native-qa-contract.ts';
import {redactQaDatabaseSecrets,withNativeQaDatabase} from '../src/native-qa-database.ts';
import {assertCompleteQaLogs} from '../src/native-qa.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';

const image='sha256:'+'ab'.repeat(32);
const projectId='11111111-1111-4111-8111-111111111111';

function frame(payload:string){
 const body=Buffer.from(payload),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(body.length,4);return Buffer.concat([header,body]);
}
function inspected(id:string,containerImage:string,running:boolean){
 return {Id:id,Image:containerImage,Config:{User:'',Labels:{},Entrypoint:null,Cmd:null,Env:[],WorkingDir:''},
  State:{Status:running?'running':'exited',Running:running,ExitCode:0,FinishedAt:running?'0001-01-01T00:00:00Z':'2026-01-01T00:00:00Z'},
  HostConfig:{NetworkMode:'none',ReadonlyRootfs:false,Privileged:false,CapDrop:null,SecurityOpt:null,PidsLimit:64,Memory:268435456,NanoCpus:500000000},
  Mounts:[]};
}

async function fakeDocker(){
 const dir=await mkdtemp(join(tmpdir(),'ac-qa-db-')),socket=join(dir,'docker.sock'),events:string[]=[],calls:{method:string;path:string;body?:any}[]=[];
 const containers=new Map<string,{id:string;name:string;running:boolean;image:string}>(),networks=new Set<string>(),execs=new Set<string>();
 let sequence=0;const next=()=>(++sequence).toString(16).padStart(64,'0');
 const server=createServer((req,res)=>{
  const chunks:Buffer[]=[];
  req.on('data',(chunk:Buffer)=>chunks.push(chunk));
  req.on('end',()=>{
   const raw=Buffer.concat(chunks).toString('utf8'),body=raw?JSON.parse(raw):undefined,path=req.url??'',method=req.method??'';
   calls.push({method,path,body});
   const url=new URL(path,'http://docker');
   const send=(status:number,payload?:unknown)=>{const encoded=payload===undefined?undefined:JSON.stringify(payload);res.writeHead(status,encoded?{'content-type':'application/json'}:{});res.end(encoded);};
   if(method==='POST'&&url.pathname==='/v1.44/networks/create'){events.push('network');networks.add(String(body.Name));send(201,{Id:next()});return;}
   if(url.pathname.startsWith('/v1.44/networks/')){
    const name=decodeURIComponent(url.pathname.slice('/v1.44/networks/'.length));
    if(method==='GET'){if(!networks.has(name))send(404,{message:'missing'});else send(200,{Id:'a'.repeat(64),Name:name,Internal:true});return;}
    if(method==='DELETE'){events.push('remove-network');if(!networks.delete(name))send(404,{message:'missing'});else send(204);return;}
   }
   if(method==='POST'&&url.pathname==='/v1.44/containers/create'){
    const name=url.searchParams.get('name')??'',id=next();
    const record={id,name,running:false,image:String(body.Image)};containers.set(name,record);containers.set(id,record);
    events.push(name.includes('-db-')?'database':'container');send(201,{Id:id});return;
   }
   if(method==='POST'&&url.pathname.startsWith('/v1.44/exec/')&&url.pathname.endsWith('/start')){send(200,{});return;}
   if(method==='GET'&&url.pathname.startsWith('/v1.44/exec/')&&url.pathname.endsWith('/json')){send(200,{Running:false,ExitCode:0});return;}
   const container=/^\/v1\.44\/containers\/([^/]+)(?:\/(json|start|stop|exec))?$/.exec(url.pathname);
   if(!container){send(500,{message:path});return;}
   const key=decodeURIComponent(container[1]!),action=container[2],found=containers.get(key);
   if(action==='exec'&&method==='POST'){const execId=next();execs.add(execId);events.push('wait');send(201,{Id:execId});return;}
   if(!found){send(404,{message:'missing'});return;}
   if(method==='GET'&&action==='json'){send(200,inspected(found.id,found.image,found.running));return;}
   if(method==='POST'&&action==='start'){found.running=true;events.push(found.name.includes('-db-')?'start':'start-container');send(204);return;}
   if(method==='POST'&&action==='stop'){found.running=false;events.push('stop');send(204);return;}
   if(method==='DELETE'){events.push(found.name.includes('-db-')?'remove-database':'remove-container');containers.delete(found.name);containers.delete(found.id);send(204);return;}
   send(500,{message:path});
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 return {docker:new DockerDaemon(socket),events,calls,async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}};
}

test('a QA service creates an internal network, waits for postgres, tests, and removes both',async()=>{
 const fake=await fakeDocker(),jobId=randomUUID(),logs:string[]=[];
 const service={image:'postgres:16-alpine' as const,database:'qa_test'};
 try{
  const seen=await withNativeQaDatabase(fake.docker,jobId,service,{memoryBytes:268435456,pids:64,nanoCpus:500000000},async environment=>{
   fake.events.push('test');return environment;
  },line=>logs.push(line));
  assert.deepEqual(fake.events,['network','database','start','wait','test','stop','remove-database','remove-network']);
  const network=fake.calls.find(call=>call.path==='/v1.44/networks/create');
  assert.equal(network?.body.Internal,true);
  assert.equal(network?.body.Driver,'bridge');
  assert.equal(network?.body.Attachable,false);
  assert.equal(network?.body.Name,'ac-native-qa-net-'+jobId);
  const database=fake.calls.find(call=>call.method==='POST'&&call.path.startsWith('/v1.44/containers/create'));
  assert.equal(database?.body.Image,'postgres:16-alpine');
  assert.equal(database?.body.HostConfig.NetworkMode,'ac-native-qa-net-'+jobId);
  assert.equal(database?.body.HostConfig.Privileged,false);
  assert.equal(database?.body.HostConfig.PublishAllPorts,false);
  assert.equal(database?.body.HostConfig.PortBindings,undefined);
  assert.equal(database?.body.HostConfig.Memory,268435456);
  assert.equal(database?.body.HostConfig.PidsLimit,64);
  assert.match(database?.body.HostConfig.Tmpfs['/var/lib/postgresql/data'],/^rw,/);
  const env=database?.body.Env as string[],password=env.find(entry=>entry.startsWith('POSTGRES_PASSWORD='))!.slice('POSTGRES_PASSWORD='.length);
  const user=env.find(entry=>entry.startsWith('POSTGRES_USER='))!.slice('POSTGRES_USER='.length);
  assert.equal(seen[0],`QA_DATABASE_URL=postgresql://${user}:${password}@ac-native-qa-db-${jobId}:5432/qa_test`);
  const probe=fake.calls.find(call=>call.path.endsWith('/exec'));
  assert.deepEqual(probe?.body.Cmd,['pg_isready','-h','127.0.0.1','-p','5432','-U',user,'-d','qa_test']);
  assert.equal(JSON.stringify(probe?.body).includes(password),false);
  assert.equal(JSON.stringify(database?.body.Labels).includes(password),false);
  assert.equal(JSON.stringify(network?.body.Labels).includes(password),false);
  const config=parsePersonalQaConfig({test:['npm','test'],services:{postgres:service}});
  const contract=personalQaContractFromConfig(projectId,image,config,name=>'/usr/bin/'+name);
  assert.equal(JSON.stringify(contract).includes(password),false);
  assert.equal(canonical(contract).includes(password),false);
  assert.equal(nativeQaContractDigest(contract).includes(password),false);
  assert.equal(logs.join('\n').includes(password),false);
  assert.equal(nativeQaContractDigest(defaultPersonalQaContract(image)),digest({contract:'native-qa-v1',definition:defaultPersonalQaContract(image)}));
  const redacted=redactQaDatabaseSecrets(frame(`postgresql://${user}:${password}@ac-native-qa-db-${jobId}:5432/qa_test\n`));
  assert.equal(redacted.toString('utf8').includes(password),false);
  assert.match(redacted.toString('utf8'),/postgresql:\/\/[^:]+:\*\*\*@/);
  assertCompleteQaLogs(redacted);
  fake.events.length=0;
  await assert.rejects(withNativeQaDatabase(fake.docker,randomUUID(),service,{memoryBytes:268435456,pids:64,nanoCpus:500000000},async()=>{fake.events.push('test');throw Error('boom');},line=>logs.push(line)));
  assert.deepEqual(fake.events,['network','database','start','wait','test','stop','remove-database','remove-network']);
  assert.equal(logs.join('\n').includes(password),false);
 }finally{await fake.close();}
});
