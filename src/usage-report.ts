import {z} from 'zod';
import {Id,Refusal,digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export const UsageReportQuerySchema=z.object({from:z.iso.datetime(),to:z.iso.datetime(),profileId:Id.optional(),rework:z.enum(['all','only','exclude']).default('all'),
 limit:z.coerce.number().int().min(1).max(200).default(100),cursor:z.string().min(1).max(2000).optional()}).strict().superRefine((v,ctx)=>{
 const duration=Date.parse(v.to)-Date.parse(v.from);
 if(duration<=0||duration>93*86400000||Date.parse(v.from)-duration<0)ctx.addIssue({code:'custom',message:'Window must be positive, at most 93 days, and its comparison start must be after 1970'});
});
const Cursor=z.object({createdAt:z.string().regex(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)$/),id:Id,binding:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type UsageReportQuery=z.input<typeof UsageReportQuerySchema>;
export type UsageCounter='input'|'output'|'cache'|'reasoning';
export type CounterSummary={knownSubtotal:string;completeTotal:string|null;knownAttempts:number;unknownAttempts:number};
export type UsageSummary={attempts:number;wallMilliseconds:CounterSummary;counters:Record<UsageCounter,CounterSummary>};
export type UsageAttempt={grantId:string;intentId:string;profileId:string;model:string;effort:string;role:string;createdAt:string;rework:boolean;
 time:{wallMilliseconds:string|null;source:'stage_lifecycle_timestamps'|'unknown';activeModelMilliseconds:null};baseline:'previous_observation'|'attempt_started_in_window'|'missing';observedAt:string|null;counters:Record<UsageCounter,string|null>};
export type UsageComparison={profileId:string;model:string;effort:string;rework:boolean;current:UsageSummary;previous:UsageSummary;delta:Record<UsageCounter,string|null>;deltaWallMilliseconds:string|null};
export type UsageReport={schemaVersion:1;consistency:'per_request_snapshot';counterAttribution:'server_observation_windows';scope:'reported_attempt_usage_deltas';source:'cumulative_adapter_observations';profileMetadata:'current';reworkDefinition:'recorded_correction_decision';
 subscriptionBalance:'unknown';monetaryCost:'unknown';timeDefinition:'completed_stage_lifecycle_wall_including_reconciliation_delay';overlappingCounters:true;contextId:string;periods:{current:{from:string;to:string};previous:{from:string;to:string}};
 attempts:UsageAttempt[];comparison:UsageComparison[];nextCursor:string|null;page:{limit:number;complete:boolean}};
const counters:UsageCounter[]=['input','output','cache','reasoning'];

// A delta needs a baseline. A new attempt has a known initial zero; an older
// attempt with no observation before the window keeps its counters unknown.
const reportCte=`WITH periods AS (
 SELECT 'current'::text period,$2::timestamptz start_at,$3::timestamptz end_at
 UNION ALL SELECT 'previous',$4::timestamptz,$2::timestamptz
), measured AS (
 SELECT w.period,g.id,g.intent_id,g.profile_id,g.role,g.created_at,g.created_at::text cursor_created_at,p.model,p.effort,
  EXISTS(SELECT 1 FROM ac_managed_correction_decisions d WHERE d.context_id=g.context_id AND d.next_intent_id=g.intent_id) rework,
  CASE WHEN s.matches=1 AND s.terminal AND s.started_at IS NOT NULL AND s.finished_at IS NOT NULL AND isfinite(s.started_at) AND isfinite(s.finished_at) AND s.finished_at>=s.started_at
   THEN floor(greatest(0,extract(epoch FROM (least(s.finished_at,w.end_at)-greatest(s.started_at,w.start_at))))*1000) ELSE NULL END wall_ms,
  u.observed_at,CASE WHEN b.seq IS NOT NULL THEN 'previous_observation' WHEN g.created_at>=w.start_at THEN 'attempt_started_in_window' ELSE 'missing' END baseline,
  ${counters.map(k=>`CASE WHEN u.counters->>'${k}' IS NULL THEN NULL
   WHEN b.seq IS NOT NULL AND b.counters->>'${k}' IS NOT NULL AND (u.counters->>'${k}')::numeric>=(b.counters->>'${k}')::numeric
    THEN (u.counters->>'${k}')::numeric-(b.counters->>'${k}')::numeric
   WHEN b.seq IS NULL AND g.created_at>=w.start_at THEN (u.counters->>'${k}')::numeric ELSE NULL END ${k}`).join(',\n')}
 FROM periods w JOIN ac_capacity_grants g ON g.context_id=$1 AND g.resource_kind='model' AND g.created_at<w.end_at
 JOIN ac_profiles p ON p.id=g.profile_id
 LEFT JOIN LATERAL(SELECT count(*) matches,bool_and(state='completed') terminal,min(started_at) started_at,min(finished_at) finished_at
  FROM ac_stage_operations WHERE grant_id=g.id) s ON true
 LEFT JOIN LATERAL(SELECT seq,counters,observed_at FROM ac_usage_observations WHERE grant_id=g.id AND observed_at<w.end_at ORDER BY seq DESC LIMIT 1) u ON true
 LEFT JOIN LATERAL(SELECT seq,counters FROM ac_usage_observations WHERE grant_id=g.id AND observed_at<w.start_at ORDER BY seq DESC LIMIT 1) b ON true
 WHERE ($5::uuid IS NULL OR g.profile_id=$5) AND (g.created_at>=w.start_at OR EXISTS(SELECT 1 FROM ac_usage_observations o WHERE o.grant_id=g.id AND o.observed_at>=w.start_at AND o.observed_at<w.end_at) OR EXISTS(SELECT 1 FROM ac_stage_operations t WHERE t.grant_id=g.id AND t.started_at<w.end_at AND (t.finished_at>w.start_at OR t.finished_at IS NULL)))
), filtered AS (SELECT * FROM measured WHERE $6='all' OR ($6='only' AND rework) OR ($6='exclude' AND NOT rework))`;
const summarySql=reportCte+` SELECT period,profile_id,model,effort,rework,count(*)::int attempts,
 ${counters.map(k=>`coalesce(sum(${k}),0)::text ${k}_sum,count(${k})::int ${k}_known,(count(*)-count(${k}))::int ${k}_unknown`).join(',')}
,coalesce(sum(wall_ms),0)::text wall_ms_sum,count(wall_ms)::int wall_ms_known,(count(*)-count(wall_ms))::int wall_ms_unknown
 FROM filtered GROUP BY period,profile_id,model,effort,rework ORDER BY profile_id,rework,period`;
const attemptSql=reportCte+` SELECT *,wall_ms::text,${counters.map(k=>`${k}::text`).join(',')} FROM filtered
 WHERE period='current' AND ($7::timestamptz IS NULL OR (created_at,id)>($7::timestamptz,$8::uuid)) ORDER BY created_at,id LIMIT $9`;
function emptySummary():UsageSummary{return {attempts:0,wallMilliseconds:{knownSubtotal:'0',completeTotal:'0',knownAttempts:0,unknownAttempts:0},counters:Object.fromEntries(counters.map(k=>[k,{knownSubtotal:'0',completeTotal:'0',knownAttempts:0,unknownAttempts:0}])) as UsageSummary['counters']};}

export class UsageReports{
 constructor(readonly ledger:Ledger){}
 async report(principal:string,projectId:string,contextId:string,raw:UsageReportQuery):Promise<UsageReport>{
  Id.parse(contextId);Id.parse(projectId);const value=UsageReportQuerySchema.parse(raw),from=new Date(value.from).toISOString(),to=new Date(value.to).toISOString();
  const previousFrom=new Date(2*Date.parse(from)-Date.parse(to)).toISOString();
  const binding=digest({projectId,contextId,from,to,profileId:value.profileId??null,rework:value.rework});
  let cursor:z.output<typeof Cursor>|undefined;
  if(value.cursor){try{cursor=Cursor.parse(JSON.parse(Buffer.from(value.cursor,'base64url').toString('utf8')));}catch{throw new Refusal('INVALID_USAGE_CURSOR',400);}if(cursor.binding!==binding)throw new Refusal('USAGE_CURSOR_FILTER_MISMATCH',400);}
  return this.ledger.tx<UsageReport>(async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   await c.query("SET LOCAL statement_timeout='10s'");
   const context=await this.ledger.authorize(c,principal,contextId,false);
   if(context.project_id!==projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const args=[contextId,from,to,previousFrom,value.profileId??null,value.rework];
   const summary=(await c.query(summarySql,args)).rows;
   const rows=(await c.query(attemptSql,[...args,cursor?.createdAt??null,cursor?.id??null,value.limit+1])).rows;
   const hasMore=rows.length>value.limit,pageRows=rows.slice(0,value.limit),last=pageRows.at(-1);
   const grouped=new Map<string,UsageComparison>();
   for(const row of summary){
    const key=row.profile_id+':'+row.rework;let pair=grouped.get(key);
    if(!pair){pair={profileId:row.profile_id,model:row.model,effort:row.effort,rework:row.rework,current:emptySummary(),previous:emptySummary(),delta:{input:null,output:null,cache:null,reasoning:null},deltaWallMilliseconds:null};grouped.set(key,pair);}
    const metrics:UsageSummary={attempts:row.attempts,wallMilliseconds:{knownSubtotal:row.wall_ms_sum,completeTotal:row.wall_ms_unknown===0?row.wall_ms_sum:null,knownAttempts:row.wall_ms_known,unknownAttempts:row.wall_ms_unknown},counters:Object.fromEntries(counters.map(k=>[k,{knownSubtotal:row[k+'_sum'],completeTotal:row[k+'_unknown']===0?row[k+'_sum']:null,knownAttempts:row[k+'_known'],unknownAttempts:row[k+'_unknown']}])) as UsageSummary['counters']};
    if(row.period==='current')pair.current=metrics;else pair.previous=metrics;
   }
   for(const pair of grouped.values())for(const k of counters){const current=pair.current.counters[k].completeTotal,previous=pair.previous.counters[k].completeTotal;pair.delta[k]=current!==null&&previous!==null?(BigInt(current)-BigInt(previous)).toString():null;}
   for(const pair of grouped.values()){const current=pair.current.wallMilliseconds.completeTotal,previous=pair.previous.wallMilliseconds.completeTotal;pair.deltaWallMilliseconds=current!==null&&previous!==null?(BigInt(current)-BigInt(previous)).toString():null;}
   return {schemaVersion:1,consistency:'per_request_snapshot',counterAttribution:'server_observation_windows',timeDefinition:'completed_stage_lifecycle_wall_including_reconciliation_delay',scope:'reported_attempt_usage_deltas',source:'cumulative_adapter_observations',profileMetadata:'current',reworkDefinition:'recorded_correction_decision',subscriptionBalance:'unknown',monetaryCost:'unknown',overlappingCounters:true,contextId,
    periods:{current:{from,to},previous:{from:previousFrom,to:from}},comparison:[...grouped.values()],
    attempts:pageRows.map(row=>({grantId:row.id,intentId:row.intent_id,profileId:row.profile_id,model:row.model,effort:row.effort,role:row.role,createdAt:row.cursor_created_at,rework:row.rework,time:{wallMilliseconds:row.wall_ms,source:row.wall_ms===null?'unknown':'stage_lifecycle_timestamps',activeModelMilliseconds:null},baseline:row.baseline,observedAt:row.observed_at?.toISOString()??null,counters:Object.fromEntries(counters.map(k=>[k,row[k]])) as UsageAttempt['counters']})),
    nextCursor:hasMore?Buffer.from(JSON.stringify({createdAt:last.cursor_created_at,id:last.id,binding})).toString('base64url'):null,page:{limit:value.limit,complete:!hasMore}};
  }).catch((error:unknown)=>{if(error&&typeof error==='object'&&'code' in error&&error.code==='57014')throw new Refusal('USAGE_REPORT_TIMEOUT',503);throw error;});
 }
}

/** Quote every field and neutralize spreadsheet formula prefixes, including
 * leading whitespace/control characters. CSV is a page, never a silent truncation. */
export function usageReportCsv(report:UsageReport):string{
 const field=(value:unknown)=>{let text=value===null||value===undefined?'':String(value);if(/^[\s\u0000-\u001f]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
 const header=['period_from','period_to','grant_id','intent_id','profile_id','model_current','effort_current','role','created_at','recorded_correction','baseline','observed_at',...counters,'stage_lifecycle_wall_ms','time_source','active_model_ms','page_complete','next_cursor'];
 const lines=[header,...report.attempts.map(row=>[report.periods.current.from,report.periods.current.to,row.grantId,row.intentId,row.profileId,row.model,row.effort,row.role,row.createdAt,row.rework,row.baseline,row.observedAt,...counters.map(k=>row.counters[k]),row.time.wallMilliseconds,row.time.source,row.time.activeModelMilliseconds,report.page.complete,report.nextCursor])];
 return lines.map(row=>row.map(field).join(',')).join('\r\n')+'\r\n';
}
