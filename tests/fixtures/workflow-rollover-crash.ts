import {Ledger} from '../../src/ledger.ts';
import {WorkflowGenerations} from '../../src/workflow-generations.ts';
const [url,encoded,where]=process.argv.slice(2),input=JSON.parse(encoded);
const ledger=new Ledger(url,undefined,input.identity);
if(where==='before-commit'){
 const original=ledger.tx.bind(ledger);
 ledger.tx=fn=>original(async c=>{
  const query=c.query.bind(c);
  c.query=((...args:unknown[])=>{
   if(typeof args[0]==='string'&&args[0].startsWith('UPDATE ac_managers SET instance_id='))process.kill(process.pid,'SIGKILL');
   return (query as (...args:unknown[])=>unknown)(...args);
  }) as typeof c.query;
  return fn(c);
 });
}
await new WorkflowGenerations(ledger).rollover(input.principal,input.authority,input.request);
process.kill(process.pid,'SIGKILL');
