import {Hono} from 'hono';
import {Refusal} from './contracts.ts';
import {OperationalObservability,prometheus} from './observability.ts';

/** Mount behind the gateway authentication middleware at /api/v1/ac. An
 * authenticated nonadministrator still cannot scrape global operational data.
 * No mutation, inference, filesystem scan or automated recovery is exposed. */
export function createObservabilityApi(service:OperationalObservability){
 const app=new Hono<{Variables:{principal:string}}>();
 // A routed sub-app middleware is flattened into the parent prefix by Hono.
 // Never use '*' here: public pairing/session routes share /api/v1/ac.
 for(const path of ['/observability','/metrics'])app.use(path,async(c,next)=>{
  if(!c.get('principal'))throw new Refusal('AUTH_REQUIRED',401);
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');await next();
 });
 app.onError((error,c)=>error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'OBSERVABILITY_UNAVAILABLE'},500));
 app.get('/observability',async c=>c.json(await service.snapshot(c.get('principal'))));
 app.get('/metrics',async c=>{
  const output=prometheus(await service.snapshot(c.get('principal')));
  return c.body(output,200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8'});
 });
 return app;
}
