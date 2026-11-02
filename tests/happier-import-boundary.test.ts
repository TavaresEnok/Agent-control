import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HappierImportTransport} from '../src/happier-import.ts';

test('import transport refuses unsafe origins and mismatched acknowledgements; confirms exact ciphertext',async()=>{
 assert.throws(()=>new HappierImportTransport('http://remote.example',async()=>'',async()=>true,async()=>true),/IMPORT_ORIGIN_UNSAFE/);
 const original=globalThis.fetch;let wrong=true,calls=0;
 globalThis.fetch=(async(input,init)=>{
  calls++;assert.equal(init?.redirect,'error');assert(init?.signal instanceof AbortSignal);
  const url=new URL(String(input));assert.equal(url.origin,'https://fixture.invalid');
  if(init?.method==='POST')return Response.json({didWrite:true,message:{localId:wrong?'wrong':'stable-id'}});
  return Response.json({messages:[{seq:1,localId:'stable-id',content:{t:'encrypted',c:'encrypted-fixture'}}],hasMore:false,nextBeforeSeq:null});
 }) as typeof fetch;
 try{
  const transport=new HappierImportTransport('https://fixture.invalid',async()=>'synthetic-token',async()=>true,async()=>true);
  await assert.rejects(transport.deliver('owner','session','stable-id','encrypted-fixture'),/IMPORT_MESSAGE_ID_CONFLICT/);
  assert.equal(calls,1);wrong=false;
  await transport.deliver('owner','session','stable-id','encrypted-fixture');assert.equal(calls,3);
  await assert.rejects(transport.deliver('owner','session','stable-id','different-ciphertext'),/IMPORT_MESSAGE_ID_CONFLICT/);
 }finally{globalThis.fetch=original;}
});
