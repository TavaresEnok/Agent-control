import {Hono} from 'hono';
import {Id,Refusal,canonical} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {PortableExport} from './portable-export.ts';

/** Metadata only. Mounted after the central authentication/origin boundary. */
export function createPortableExportApi(ledger:Ledger,projectId:string){
 const app=new Hono<{Variables:{principal:string}}>();
 return app.get('/contexts/:contextId/export/metadata',async c=>{
  const principal=c.get('principal');if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const contextId=Id.parse(c.req.param('contextId'));
  const result=await new PortableExport(ledger).export(principal,projectId,contextId);
  return c.body(canonical(result),200,{
   'Content-Type':'application/json; charset=utf-8',
   'Content-Disposition':`attachment; filename="agent-control-metadata-${contextId}.json"`,
   'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  });
 });
}
