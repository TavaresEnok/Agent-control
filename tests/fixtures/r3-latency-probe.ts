import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Ledger} from '../../src/ledger.ts';
import {report,timingHeader} from '../../scripts/r3-latency-report.mjs';

export async function measureCommandRequests(request:(command:Record<string,unknown>)=>Promise<Response>,command:Record<string,unknown>,samples=8){
 assert(Number.isInteger(samples)&&samples>=4&&samples<=40);
 const metrics={commandAcceptance:[] as number[],authentication:[] as number[],application:[] as number[]};
 let response:Response|undefined,first:unknown;
 for(let index=0;index<samples;index++){
  const started=performance.now();response=await request({...command,deliveryAttemptId:randomUUID()});
  const accepted=await response.clone().json();assert.equal(response.status,202);
  const identity={intentId:accepted.intentId,runId:accepted.runId};
  assert.equal(typeof identity.intentId,'string');assert.equal(typeof identity.runId,'string');
  assert.equal(typeof accepted.state,'string');
  if(index===0)first=identity;else assert.deepEqual(identity,first,'RETRY_CHANGED_ACCEPTED_EFFECT');
  metrics.commandAcceptance.push(performance.now()-started);
  const server=timingHeader(response.headers.get('server-timing'));
  metrics.authentication.push(server.authentication);metrics.application.push(server.application);
 }
 const measured=report(metrics,{transport:'production Hono handler → real Happier authentication → PostgreSQL',network:'in-process handler invocation; not a network benchmark',
  commandMix:{newIntents:1,idempotentDeliveryRetries:samples-1},thresholds:{commandAcceptanceMs:2000}});
 assert(measured.metrics.commandAcceptance.maxMs<=2000,'SYNTHETIC_COMMAND_ACCEPTANCE_OVER_2S');
 return {response:response!,report:measured};
}

/** Observe committed PG rows then the real API; do not alter production event writes. */
export function startCommittedEventProbe({ledger,contextId,fetchEvents,samples=10,timeoutMs=60000}:{ledger:Ledger;contextId:string;fetchEvents:()=>Promise<Response>;samples?:number;timeoutMs?:number}){
 assert(Number.isInteger(samples)&&samples>=4&&samples<=40);
 const committed=new Map<string,number>(),seen=new Set<string>(),dbSeen=new Set<string>(),metrics={committedEventUpdateUpperBound:[] as number[],eventReadAuthentication:[] as number[]};
 let stopped=false,previousQueryStarted=performance.now();const deadline=performance.now()+timeoutMs;
 const ready=(async()=>{const rows=await ledger.pool.query('SELECT event_id FROM ac_events WHERE context_id=$1',[contextId]);for(const row of rows.rows)dbSeen.add(row.event_id);})();
 const done=(async()=>{
  try{
   await ready;
   while(!stopped&&performance.now()<deadline&&metrics.committedEventUpdateUpperBound.length<samples){
    const queryStarted=performance.now();
    const rows=await ledger.pool.query('SELECT event_id FROM ac_events WHERE context_id=$1',[contextId]);
    for(const row of rows.rows){
     if(!dbSeen.has(row.event_id)&&committed.size<samples)committed.set(row.event_id,previousQueryStarted);
     dbSeen.add(row.event_id);
    }
    previousQueryStarted=queryStarted;
    const response=await fetchEvents();assert.equal(response.status,200);
    const body=await response.json() as {events:{eventId:string}[]},observed=performance.now();
    const server=timingHeader(response.headers.get('server-timing'));
    for(const event of body.events){
     const emitted=committed.get(event.eventId);
     if(emitted!==undefined&&!seen.has(event.eventId)){
      seen.add(event.eventId);metrics.committedEventUpdateUpperBound.push(observed-emitted);metrics.eventReadAuthentication.push(server.authentication);
     }
    }
    if(metrics.committedEventUpdateUpperBound.length<samples)await new Promise(resolve=>setTimeout(resolve,50));
   }
   if(metrics.committedEventUpdateUpperBound.length!==samples)console.error('R3_EVENT_PROBE_INCOMPLETE '+JSON.stringify({requested:samples,observed:metrics.committedEventUpdateUpperBound.length,dbEvents:dbSeen.size,candidates:committed.size,deadlineElapsed:performance.now()>=deadline,stopped}));
   const measured=metrics.committedEventUpdateUpperBound.length?report(metrics,{transport:'committed PostgreSQL projection → authenticated product events endpoint',
    network:'in-process Hono request; real authentication network; includes 50ms polling interval',
    eventClock:'conservative upper bound from start of previous PG snapshot query (which lacked the event) to authenticated API observation; includes DB query/auth/polling',
    thresholds:{committedEventUpdateMs:5000},requestedSamples:samples,complete:metrics.committedEventUpdateUpperBound.length===samples}):null;
   return {report:measured,error:metrics.committedEventUpdateUpperBound.length!==samples?'EVENT_SAMPLE_WINDOW_INCOMPLETE':null};
  }catch(error){return {report:null,error:error instanceof Error?error.message:'EVENT_PROBE_FAILED'};}
  finally{stopped=true;}
 })();
 return {ready,done,stop:()=>{stopped=true;}};
}
export function assertEventReport(value:Awaited<ReturnType<typeof startCommittedEventProbe>['done']>){
 assert.equal(value.error,null);assert(value.report);assert(value.report.metrics.committedEventUpdateUpperBound.maxMs<=5000,'SYNTHETIC_EVENT_UPDATE_OVER_5S');return value.report;
}
