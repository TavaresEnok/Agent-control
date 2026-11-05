import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {assertCompleteQaLogs,collectQaLogs} from '../src/native-qa.ts';

function frame(stream:number,payload:string){
 const body=Buffer.from(payload),header=Buffer.alloc(8);header[0]=stream;header.writeUInt32BE(body.length,4);return Buffer.concat([header,body]);
}

test('QA refuses incomplete or malformed Docker logs returned over a disposable socket',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-qa-log-socket-')),socket=join(dir,'docker.sock');
 const stdout=frame(1,'synthetic stdout'),stderr=frame(2,'synthetic stderr');let response=Buffer.concat([stdout,stderr]);
 const server=createServer((req,res)=>{assert.equal(req.url,`/v1.44/containers/${'a'.repeat(64)}/logs?stdout=1&stderr=1&timestamps=0`);res.writeHead(200);res.end(response);});
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  const docker=new DockerDaemon(socket),fetch=()=>docker.logs('a'.repeat(64));
  const complete=await collectQaLogs(fetch);assert.equal(complete.logsAvailable,true);assert.deepEqual(complete.logs,response);
  for(const invalid of [stdout.subarray(0,7),stdout.subarray(0,stdout.length-1),Buffer.concat([stdout,stderr.subarray(0,9)]),Buffer.from([3,0,0,0,0,0,0,0]),Buffer.from([1,1,0,0,0,0,0,0])]){
   response=invalid;assert.throws(()=>assertCompleteQaLogs(invalid),/NATIVE_QA_LOGS_INVALID/);
   const received=await collectQaLogs(fetch);assert.equal(received.logsAvailable,false);assert.notDeepEqual(received.logs,invalid);
  }
  assert.doesNotThrow(()=>assertCompleteQaLogs(Buffer.alloc(0)));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
