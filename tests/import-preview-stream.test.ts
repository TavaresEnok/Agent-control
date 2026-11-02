import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import type {Ledger} from '../src/ledger.ts';
import {Refusal} from '../src/contracts.ts';
import {createImportPreviewApi} from '../src/import-preview-api.ts';
import {IMPORT_PREVIEW_MAX_BYTES} from '../src/import-preview.ts';

test('oversized streaming upload handles rejected source cancellation',async()=>{
 const app=new Hono<{Variables:{principal:string}}>();app.use('*',async(c,next)=>{c.set('principal','synthetic-owner');await next();});
 app.onError((error,c)=>error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'UNEXPECTED'},500));
 app.route('/api/v1/ac',createImportPreviewApi({} as Ledger,'00000000-0000-4000-8000-000000000000'));
 let cancelled=false;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(IMPORT_PREVIEW_MAX_BYTES+1));},cancel(){cancelled=true;return Promise.reject(Error('synthetic cancellation failure'));}});
 const req=new Request('http://localhost/api/v1/ac/import/preview',{method:'POST',headers:{'content-type':'application/json'},body,duplex:'half'} as RequestInit & {duplex:'half'});
 const response=await app.fetch(req);assert.equal(response.status,400);assert.equal((await response.json()).error,'IMPORT_PREVIEW_TOO_LARGE');assert.equal(cancelled,true);
 await new Promise(resolve=>setImmediate(resolve));
});
