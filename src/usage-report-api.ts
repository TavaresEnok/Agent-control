import {Hono} from 'hono';
import {Refusal,Id} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {UsageReports,usageReportCsv,UsageReportQuerySchema} from './usage-report.ts';

/** Mounted after the shared authentication/origin boundary. */
export function createUsageReportApi(ledger:Ledger,projectId:string){
 const app=new Hono<{Variables:{principal:string}}>(),reports=new UsageReports(ledger);
 for(const suffix of ['', '.csv'])app.get('/contexts/:contextId/usage/report'+suffix,async c=>{
  const principal=c.get('principal');if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const query=c.req.query();
  const report=await reports.report(principal,projectId,Id.parse(c.req.param('contextId')),UsageReportQuerySchema.parse(query));
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');
  if(suffix){
   c.header('X-Usage-Export-Scope','page');
   c.header('X-Usage-Page-Complete',String(report.page.complete));if(report.nextCursor)c.header('X-Next-Cursor',report.nextCursor);
   c.header('Content-Disposition',`attachment; filename="usage-page-${report.contextId}.csv"`);
   return c.body(usageReportCsv(report),200,{'Content-Type':'text/csv; charset=utf-8'});
  }
  return c.json(report);
 });
 return app;
}
