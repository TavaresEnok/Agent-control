import assert from 'node:assert/strict';
import {test} from 'node:test';
import {claudeLimitFromText,codexLimitFromText,futureResetMs,noteProviderExhaustion,resetFromUsage} from '../src/quota-exhaustion.ts';

const MIN=60*1000,HOUR=60*MIN;
const windows=(...items:Array<{resetsAt:number|string|null;status?:string;usedPercent?:number|null}>)=>({provider:'claude',windows:items.map((item,index)=>({id:'w'+index,kind:'other',applicability:'all',models:[],durationMinutes:null,usedPercent:null,status:'unknown',...item}))});
const near=(actual:Date,expected:number,slack=2000)=>assert(Math.abs(actual.getTime()-expected)<=slack,`expected ${new Date(expected).toISOString()} got ${actual.toISOString()}`);

test('a usable reset in 20 minutes is kept',()=>{
 const now=Date.now();
 near(resetFromUsage(windows({resetsAt:now+20*MIN,status:'blocked',usedPercent:100}),now),now+20*MIN);
});

test('a usable reset in 6 hours is kept and no longer shortened to one hour',()=>{
 const now=Date.now();
 near(resetFromUsage(windows({resetsAt:now+6*HOUR,status:'blocked',usedPercent:100}),now),now+6*HOUR);
 // The same through the text parsers that feed the persisted observation.
 const parsed=claudeLimitFromText(['Claude usage limit reached. Try again in 6 hours.'],now);
 near(resetFromUsage(parsed?.usageWindows,now),now+6*HOUR);
 const codex=codexLimitFromText(["You've hit your usage limit. Try again in 6 hours."],now);
 near(resetFromUsage(codex?.usageWindows,now),now+6*HOUR);
});

test('one hour applies only when no usable reset exists',()=>{
 const now=Date.now();
 for(const usage of [undefined,null,{},windows({resetsAt:null}),windows({resetsAt:'not a date'}),windows({resetsAt:now-5*MIN}),windows({resetsAt:now+8*24*HOUR}),windows({resetsAt:Number.NaN})]){
  near(resetFromUsage(usage,now),now+HOUR);
  assert.equal(futureResetMs(usage,now),null);
 }
});

test('several windows: the blocked ones decide, past and invalid ones are ignored',()=>{
 const now=Date.now();
 // A 5 hour window that is fine and resets soon does not release an account blocked by the weekly window.
 near(resetFromUsage(windows({resetsAt:now+20*MIN,status:'allowed',usedPercent:30},{resetsAt:now+30*HOUR,status:'blocked',usedPercent:100}),now),now+30*HOUR);
 // Two blocked windows: the limit lifts when the last one resets.
 near(resetFromUsage(windows({resetsAt:now+2*HOUR,status:'blocked',usedPercent:100},{resetsAt:now+5*HOUR,status:'blocked',usedPercent:100}),now),now+5*HOUR);
 // A blocked window already past or invalid does not count; the usable blocked one does.
 near(resetFromUsage(windows({resetsAt:now-HOUR,status:'blocked'},{resetsAt:'garbage',status:'blocked'},{resetsAt:now+3*HOUR,status:'blocked'}),now),now+3*HOUR);
 // Without any blocked window the earliest usable reset is used, as before.
 near(resetFromUsage(windows({resetsAt:now+4*HOUR},{resetsAt:now+90*MIN},{resetsAt:now-HOUR}),now),now+90*MIN);
});

test('noteProviderExhaustion persists the observed reset, not one hour',async()=>{
 const now=Date.now(),written:Date[]=[];
 const ledger={pool:{query:async(_sql:string,params:any[])=>{written.push(new Date(params[1]));return {rows:[]};}}} as any;
 await noteProviderExhaustion(ledger,'a',windows({resetsAt:now+6*HOUR,status:'blocked',usedPercent:100}),now);
 await noteProviderExhaustion(ledger,'a',windows({resetsAt:null}),now);
 await noteProviderExhaustion(ledger,'a',undefined,now);
 near(written[0]!,now+6*HOUR);near(written[1]!,now+HOUR);near(written[2]!,now+HOUR);
});
