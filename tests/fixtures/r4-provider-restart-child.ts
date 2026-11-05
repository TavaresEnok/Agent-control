import {appendFile,readFile} from 'node:fs/promises';
import {Ledger} from '../../src/ledger.ts';
import {ProviderCollectors,type ProviderAdapter,type ProviderProbeResult} from '../../src/providers.ts';
import {Refusal} from '../../src/contracts.ts';
const config=JSON.parse(await readFile(process.argv[2],'utf8')) as {url:string;principal:string;project:string;account:string;counter:string;version:string;observation:string;mode:'throw'|'timeout'|'crash'|'available'|'incompatible'|'auth'};
const db=new Ledger(config.url);
const adapter:ProviderAdapter={manifest:{id:'r4-restart-fixture',version:config.version,provider:'synthetic',mode:'synthetic',eligibility:'documented_supported',source:'synthetic://r4-restart-contract',timeoutMs:30},probe:async()=>{
 await appendFile(config.counter,JSON.stringify({pid:process.pid,version:config.version,mode:config.mode})+'\n',{mode:0o600});
 if(config.mode==='crash')process.exit(17);
 if(config.mode==='timeout')return await new Promise<ProviderProbeResult>(()=>{});
 if(config.mode==='throw')throw Error('synthetic persistent transport failure');
 return {status:config.mode==='auth'?'auth_required':config.mode==='incompatible'?'unknown':'available',ttlSeconds:3600,remainingPercent:config.mode==='available'?50:null,resetAt:null};
}};
try{const result=await new ProviderCollectors(db,[adapter]).collect(config.principal,config.project,config.account,config.observation);console.log(JSON.stringify({kind:'result',duplicate:result.duplicate,status:result.snapshot.status}));}
catch(error){if(!(error instanceof Refusal))throw error;console.log(JSON.stringify({kind:'refused',code:error.code}));}
finally{await db.close();}
