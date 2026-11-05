import assert from 'node:assert/strict';
import {cpus,platform,release,totalmem} from 'node:os';
export function summarize(samples){
 assert(samples.length>0,'LATENCY_SAMPLES_REQUIRED');
 assert(samples.every(value=>Number.isFinite(value)&&value>=0),'LATENCY_DURATION_INVALID');
 const ordered=[...samples].sort((a,b)=>a-b),quantile=p=>ordered[Math.max(0,Math.ceil(p*ordered.length)-1)];
 return {samples:ordered.length,p50Ms:quantile(.5),p95Ms:quantile(.95),maxMs:ordered.at(-1)};
}
export function report(metrics,extra={}){
 return {schemaVersion:1,scope:'synthetic-local-benchmark',homologated:false,clock:'monotonic performance.now',
  environment:{node:process.version,platform:platform(),kernel:release(),logicalCpus:cpus().length,memoryBytes:totalmem()},
  externalProvider:{exercised:false,latencyMs:null,reason:'deterministic synthetic fixtures; no external inference'},
  metrics:Object.fromEntries(Object.entries(metrics).map(([key,values])=>[key,summarize(values)])),...extra};
}
export function timingHeader(encoded){
 const values={};for(const metric of String(encoded??'').split(',')){
  const match=metric.trim().match(/^(authentication|application|total);dur=(\d+(?:\.\d+)?)$/);
  if(match)values[match[1]]=Number(match[2]);
 }
 for(const key of ['authentication','application','total'])assert(Number.isFinite(values[key]),'SERVER_TIMING_MISSING_'+key);
 return values;
}
