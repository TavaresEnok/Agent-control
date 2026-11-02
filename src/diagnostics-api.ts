import {Hono} from 'hono';
import {Id,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {ContextDiagnostics} from './diagnostics.ts';
import {agentControlDiagnosticsSchema} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';

/** Mounted behind the shared gateway authentication; this family owns one route. */
export function createDiagnosticsApi(ledger:Ledger,projectId:string){
 const app=new Hono<{Variables:{principal:string}}>(),service=new ContextDiagnostics(ledger,projectId);
 app.use('/contexts/:id/diagnostics',async(c,next)=>{
  if(!c.get('principal'))throw new Refusal('AUTH_REQUIRED',401);
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');await next();
 });
 app.onError((error,c)=>error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'DIAGNOSTICS_UNAVAILABLE'},500));
 app.get('/contexts/:id/diagnostics',async c=>{
  const id=Id.safeParse(c.req.param('id'));if(!id.success)throw new Refusal('INVALID_CONTEXT_ID',400);
  return c.json(agentControlDiagnosticsSchema.parse(await service.read(c.get('principal'),id.data)));
 });
 return app;
}
