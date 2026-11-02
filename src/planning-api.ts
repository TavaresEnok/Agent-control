import {Hono,type MiddlewareHandler} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {Ledger} from './ledger.ts';
import {Id,Refusal,type Authority} from './contracts.ts';
import {ManagerPlans} from './planning.ts';
import {managerPlanProposalSchema,managerPlanPublishedSchema,managerPlanPreviewSchema,managerPlanRestoreSchema}
 from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';

/** Mounted after the parent's session/bearer middleware and before native fallback.
 * Native execution is deliberately not an endpoint of this proposal family. */
export function createPlanningApi(ledger:Ledger,projectId:string,manager:(contextId:string)=>Authority|undefined){
 const plans=new ManagerPlans(ledger),app=new Hono<{Variables:{principal:string}}>();
 const authorize:MiddlewareHandler<{Variables:{principal:string}}>=async(c,next)=>{
  if(!c.get('principal'))throw new Refusal('AUTH_REQUIRED',401);c.header('Cache-Control','no-store');await next();
 };
 // Mounting this family must not claim public login routes under the same API prefix.
 app.use('/contexts/:id/manager-plans',authorize);
 app.use('/contexts/:id/manager-plans/*',authorize);
 const limit=bodyLimit({maxSize:128*1024,onError:c=>c.json({error:'MANAGER_PLAN_BODY_TOO_LARGE'},400)});
 const scope=async(principal:string,contextId:string)=>ledger.tx(async db=>{
  const context=await ledger.authorize(db,principal,contextId,false);
  if(context.project_id!==projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
 });
 return app
  .get('/contexts/:id/manager-plans',async c=>{
   const id=Id.parse(c.req.param('id')),principal=c.get('principal');await scope(principal,id);
   return c.json(await plans.list(principal,id));
  })
  .get('/contexts/:id/manager-plans/:revision',async c=>{
   const id=Id.parse(c.req.param('id')),revision=z.coerce.number().int().positive().parse(c.req.param('revision')),principal=c.get('principal');
   await scope(principal,id);return c.json(managerPlanPreviewSchema.parse(await plans.read(principal,id,revision)));
  })
  .get('/contexts/:id/manager-plans/:revision/compare/:other',async c=>{
   const id=Id.parse(c.req.param('id')),principal=c.get('principal');await scope(principal,id);
   const revision=z.coerce.number().int().positive().parse(c.req.param('revision')),other=z.coerce.number().int().positive().parse(c.req.param('other'));
   return c.json(await plans.compare(principal,id,revision,other));
  })
  .post('/contexts/:id/manager-plans/:revision/restore',limit,async c=>{
   const id=Id.parse(c.req.param('id')),principal=c.get('principal');await scope(principal,id);
   const revision=z.coerce.number().int().positive().parse(c.req.param('revision')),input=managerPlanRestoreSchema.parse(await c.req.json());
   const authority=manager(id);if(!authority)throw new Refusal('MANAGER_UNAVAILABLE');
   return c.json(managerPlanPublishedSchema.parse(await plans.restore(principal,authority,input.expectedRevision,revision)),201);
  })
  .post('/contexts/:id/manager-plans',limit,async c=>{
   const id=Id.parse(c.req.param('id')),principal=c.get('principal');await scope(principal,id);
   const input=managerPlanProposalSchema.parse(await c.req.json());
   if(input.plan.contextId!==id)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
   const authority=manager(id);if(!authority)throw new Refusal('MANAGER_UNAVAILABLE');
   return c.json(managerPlanPublishedSchema.parse(await plans.publish(principal,authority,input.expectedRevision,input.plan)),201);
  });
}
