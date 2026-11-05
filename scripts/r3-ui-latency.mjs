import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {report,timingHeader} from './r3-latency-report.mjs';
/** Reuse the authenticated browser fixture; preserve initial pause state. */
export async function measureBrowserLatency({page,contextId,client,origin,projectId,samples=12,output}){
 assert(Number.isInteger(samples)&&samples>=4&&samples<=40&&samples%2===0,'FINITE_EVEN_SAMPLE_COUNT_REQUIRED');
 const metrics={signedControlAcceptance:[],browserProjection:[],authentication:[],application:[],httpTotal:[]};
 for(let index=0;index<samples;index++){
  const current=await (await client.request.get(`${origin}/api/v1/ac/contexts`,{headers:{'X-Agent-Control-Project':projectId}})).json();
  const context=current.contexts.find(value=>value.id===contextId);assert(context,'CONTEXT_REQUIRED');
  const action=context.paused?'Retomar etapas':'Pausar novas etapas',next=context.paused?'Pausar novas etapas':'Retomar etapas';
  const response=page.waitForResponse(value=>value.url().endsWith('/api/v1/ac/control')&&value.request().method()==='POST',{timeout:10000});
  const started=performance.now();await page.getByRole('button',{name:action,exact:true}).click({timeout:10000});
  const accepted=await response;await accepted.finished();assert.equal(accepted.status(),200);
  const acceptance=performance.now()-started,server=timingHeader((await accepted.allHeaders())['server-timing']);
  metrics.signedControlAcceptance.push(acceptance);metrics.authentication.push(server.authentication);metrics.application.push(server.application);metrics.httpTotal.push(server.total);
  await page.getByRole('button',{name:next,exact:true}).waitFor({timeout:10000});metrics.browserProjection.push(performance.now()-started);
 }
 const result=report(metrics,{transport:'real Chromium → loopback HTTP → production authenticated API → PostgreSQL',
  thresholds:{signedControlAcceptanceMs:2000,browserProjectionMs:5000},
  eventScope:'DOM refresh after real signed command; separate committed-event probe required for event-channel latency'});
 // Persist observations before enforcing synthetic benchmark thresholds.
 if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log('RNF12_BROWSER '+JSON.stringify(result));
 assert(result.metrics.signedControlAcceptance.maxMs<=2000,'SYNTHETIC_COMMAND_ACCEPTANCE_OVER_2S');
 assert(result.metrics.browserProjection.maxMs<=5000,'SYNTHETIC_BROWSER_PROJECTION_OVER_5S');
 return result;
}
