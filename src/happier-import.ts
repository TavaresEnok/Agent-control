import { z } from 'zod';
import { Refusal } from './contracts.ts';
import type { ImportTransport } from './import.ts';

/** Reuses Happier's authenticated session/message APIs. Keys and tokens are supplied by the trusted endpoint. */
export class HappierImportTransport implements ImportTransport{
 constructor(private readonly origin:string,private readonly tokenFor:(principal:string)=>Promise<string>,
  private readonly sessionKeyVerifier:(principal:string,sessionId:string,variant:'legacy'|'dataKey',fingerprint:string)=>Promise<boolean>,
  private readonly ciphertextVerifier:(principal:string,sessionId:string,ciphertext:string)=>Promise<boolean>){}
 async verifySessionKey(principal:string,sessionId:string,variant:'legacy'|'dataKey',fingerprint:string){return this.sessionKeyVerifier(principal,sessionId,variant,fingerprint);}
 async verifyCiphertext(principal:string,sessionId:string,ciphertext:string){return this.ciphertextVerifier(principal,sessionId,ciphertext);}
 async verifySession(principal:string,sessionId:string){
  const token=await this.tokenFor(principal);
  const response=await fetch(new URL('/v2/sessions/'+encodeURIComponent(sessionId),this.origin),{headers:{authorization:'Bearer '+token}});
  if(!response.ok)return false;
  const result=z.object({session:z.object({id:z.string()}).passthrough()}).passthrough().parse(await response.json());
  return result.session.id===sessionId;
 }
 async deliver(principal:string,sessionId:string,localId:string,ciphertext:string){
  const token=await this.tokenFor(principal);
  const url=new URL('/v2/sessions/'+encodeURIComponent(sessionId)+'/messages',this.origin);
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
   body:JSON.stringify({ciphertext,localId})});
  if(!response.ok)throw new Refusal('IMPORT_DELIVERY_UNCERTAIN');
  z.object({didWrite:z.boolean(),message:z.object({localId:z.string().nullable()}).passthrough()}).passthrough().parse(await response.json());
  let before:number|undefined;
  for(let page=0;page<100;page++){
   const list=new URL('/v1/sessions/'+encodeURIComponent(sessionId)+'/messages',this.origin);
   list.searchParams.set('scope','main');list.searchParams.set('limit','150');if(before!==undefined)list.searchParams.set('beforeSeq',String(before));
   const res=await fetch(list,{headers:{authorization:'Bearer '+token}});if(!res.ok)throw new Refusal('IMPORT_DELIVERY_UNCERTAIN');
   const value=z.object({messages:z.array(z.object({seq:z.number().int(),localId:z.string().nullable(),content:z.unknown()}).passthrough()),
    hasMore:z.boolean(),nextBeforeSeq:z.number().int().positive().nullable()}).passthrough().parse(await res.json());
   let previous=before??Infinity;
   for(const message of value.messages){
    if(message.seq>=previous)throw new Refusal('HISTORY_ORDER_INVALID');previous=message.seq;
    if(message.localId===localId){
     const content=z.object({t:z.literal('encrypted'),c:z.string()}).parse(typeof message.content==='string'?JSON.parse(message.content):message.content);
     if(content.c!==ciphertext)throw new Refusal('IMPORT_MESSAGE_ID_CONFLICT');
     return;
    }
   }
   if(!value.hasMore)throw new Refusal('IMPORT_DELIVERY_UNCERTAIN');
   if(!value.messages.length||value.nextBeforeSeq!==previous)throw new Refusal('HISTORY_CURSOR_INVALID');
   before=value.nextBeforeSeq;
  }
  throw new Refusal('HISTORY_PAGE_LIMIT_EXCEEDED');
 }
}
