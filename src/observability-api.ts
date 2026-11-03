import {Hono} from 'hono';
import {Refusal} from './contracts.ts';
import {OperationalObservability,prometheus} from './observability.ts';
import {evaluateOperationalSlos} from './slo-evaluation.ts';

type ObservabilityReader=Pick<OperationalObservability,'snapshot'>;

/** Mount behind the gateway authentication middleware at /api/v1/ac. An
 * authenticated nonadministrator still cannot scrape global operational data.
 * No mutation, inference, filesystem scan or automated recovery is exposed.
 * GET /observability/slo evaluates the same read-only snapshot. It does not
 * accept a client clock. A missing snapshot is a generic 500, never an ok report. */
export function createObservabilityApi(service:ObservabilityReader){
 const app=new Hono<{Variables:{principal:string}}>();
 // A routed sub-app middleware is flattened into the parent prefix by Hono.
 // Never use '*' here: public pairing/session routes share /api/v1/ac.
 for(const path of ['/observability','/observability/slo','/metrics'])app.use(path,async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
  if(!c.get('principal'))throw new Refusal('AUTH_REQUIRED',401);
  await next();
 });
 app.onError((error,c)=>{
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
  return error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'OBSERVABILITY_UNAVAILABLE'},500);
 });
 app.get('/observability',async c=>c.json(await service.snapshot(c.get('principal'))));
 app.get('/observability/slo',async c=>{
  const snapshot=await service.snapshot(c.get('principal'));
  if(snapshot==null)throw new Error('OBSERVABILITY_UNAVAILABLE');
  return c.json(evaluateOperationalSlos(snapshot,{now:new Date()}));
 });
 app.get('/metrics',async c=>{
  const output=prometheus(await service.snapshot(c.get('principal')));
  return c.body(output,200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8'});
 });
 return app;
}
