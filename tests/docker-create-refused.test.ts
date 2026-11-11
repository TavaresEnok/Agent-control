import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {Refusal} from '../src/contracts.ts';

const image='sha256:'+'ab'.repeat(32);

function refused(code:string){return (error:unknown)=>{assert.ok(error instanceof Refusal);assert.equal(error.code,code);return true;};}

test('a received Docker create 4xx is a refusal and a 409 stays uncertain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-docker-create-')),socket=join(dir,'docker.sock');
 const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
  req.resume();
  const url=req.url??'';
  if(url.startsWith('/v1.44/images/')){
   assert.equal(url.includes('%3A')||url.includes('%3a'),false);
   const missing=url.includes(image);
   const body=JSON.stringify({message:missing?'No such image: '+image:'unexpected image'});
   res.writeHead(missing?404:500,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);return;
  }
  const name=new URL(url,'http://docker').searchParams.get('name');
  const status=name==='missing'?404:name==='invalid'?400:name==='conflict'?409:name==='down'?500:name==='opaque'?404:500;
  if(name==='opaque'){res.writeHead(404,{'content-type':'text/plain'});res.end('not json');return;}
  const body=JSON.stringify({message:name==='missing'?`No such image: ${image}`:name==='invalid'?'invalid mount config':name==='conflict'?'Conflict. The container name is already in use':name==='down'?'server error':'unexpected'});
  res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);
 });
 await new Promise<void>((ok,fail)=>server.listen(socket,()=>ok()).on('error',fail));
 try{
  const docker=new DockerDaemon(socket);
  assert.equal(await docker.imagePresent(image),false);
  await assert.rejects(docker.imagePresent('missing'),refused('DOCKER_IMAGE_INVALID'));
  await assert.rejects(docker.create('missing',{Image:image}),refused('DOCKER_CREATE_REFUSED'));
  await assert.rejects(docker.create('invalid',{Image:image}),refused('DOCKER_CREATE_REFUSED'));
  await assert.rejects(docker.create('conflict',{Image:image}),refused('DOCKER_CREATE_UNCERTAIN'));
  await assert.rejects(docker.create('down',{Image:image}),refused('DOCKER_CREATE_UNCERTAIN'));
  await assert.rejects(docker.create('opaque',{Image:image}),refused('DOCKER_CREATE_UNCERTAIN'));
 }finally{await new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok()));await rm(dir,{recursive:true,force:true});}
});
