import { request as httpRequest } from 'node:http';
import { lstat,readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Authority,Id,Refusal } from './contracts.ts';
import { signSandbox } from './sandbox-broker.ts';
const Action=z.enum(['start','reconcile','cleanup']);
/** Only the trusted controller receives this socket and key; worker containers receive neither. */
export class SandboxClient{
 constructor(private readonly socket='/run/ac-broker/control.sock',private readonly keyPath='/run/ac-broker/key'){}
 async perform(action:z.infer<typeof Action>,jobId:string,grantId:string,authority:Authority){
  Action.parse(action);Id.parse(jobId);Id.parse(grantId);Authority.parse(authority);
  const info=await lstat(this.keyPath);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==0||info.gid!==1000||(info.mode&0o037)!==0)throw new Refusal('UNSAFE_BROKER_KEY');
  const key=await readFile(this.keyPath);if(key.length!==32)throw new Refusal('INVALID_BROKER_KEY');
  const payload=JSON.stringify(signSandbox({schemaVersion:1,action,jobId,grantId,authority,profile:'synthetic-probe-v1',expiresAt:Date.now()+30000},key));
  return new Promise<unknown>((ok,fail)=>{
   const request=httpRequest({socketPath:this.socket,path:'/v1/jobs',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)},timeout:20000},response=>{
    let body='';response.on('data',chunk=>{body+=String(chunk);if(body.length>32768)request.destroy();});
    response.on('end',()=>{
     try{const result:unknown=JSON.parse(body);if(response.statusCode!==200){const error=z.object({error:z.string()}).parse(result);fail(new Refusal(error.error));}else ok(result);}
     catch{fail(new Refusal('SANDBOX_RESPONSE_INVALID'));}
    });response.on('error',()=>fail(new Refusal('SANDBOX_RESPONSE_UNCERTAIN')));
   });request.on('timeout',()=>request.destroy());request.on('error',()=>fail(new Refusal('SANDBOX_RESPONSE_UNCERTAIN')));request.end(payload);
  });
 }
}
