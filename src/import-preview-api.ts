import {Hono} from 'hono';
import {Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {ImportedHistory} from './import-history.ts';
import {ImportPreview,IMPORT_PREVIEW_MAX_BYTES} from './import-preview.ts';

/** Attach under /api/v1/ac after authentication, origin checks and error handling. */
export function createImportPreviewApi(ledger:Ledger,projectId:string){
 const app=new Hono<{Variables:{principal:string}}>();
 app.get('/import/:importId/history',async c=>{const principal=c.get('principal');if(!principal)throw new Refusal('AUTH_REQUIRED',401);c.header('Cache-Control','no-store');return c.json(await new ImportedHistory(ledger).page(principal,projectId,c.req.param('importId'),c.req.query('cursor')));});
 return app.post('/import/preview',async c=>{
  const principal=c.get('principal');if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  c.header('Cache-Control','no-store');
  if((c.req.header('content-encoding')??'identity').toLowerCase()!=='identity')throw new Refusal('IMPORT_ENCODING_UNSUPPORTED',400);
  if(!/^application\/json(?:\s*;|\s*$)/i.test(c.req.header('content-type')??''))throw new Refusal('IMPORT_CONTENT_TYPE_UNSUPPORTED',400);
  const length=c.req.header('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>IMPORT_PREVIEW_MAX_BYTES))throw new Refusal('IMPORT_PREVIEW_TOO_LARGE',400);
  const reader=c.req.raw.body?.getReader();if(!reader)throw new Refusal('INVALID_IMPORT_JSON',400);
  const chunks:Uint8Array[]=[];let total=0,timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});reject(new Refusal('IMPORT_PREVIEW_TIMEOUT',400));},10000);});
  try{
   for(;;){const part=await Promise.race([reader.read(),deadline]);if(timedOut)throw new Refusal('IMPORT_PREVIEW_TIMEOUT',400);if(part.done)break;total+=part.value.byteLength;if(total>IMPORT_PREVIEW_MAX_BYTES){void reader.cancel().catch(()=>{});throw new Refusal('IMPORT_PREVIEW_TOO_LARGE',400);}chunks.push(part.value);}
  }finally{clearTimeout(timer);reader.releaseLock();}
  return c.json(await new ImportPreview(ledger,projectId).inspect(principal,Buffer.concat(chunks)));
 });
}
