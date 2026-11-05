import {Ledger} from '../../src/ledger.ts';
import {Refusal} from '../../src/contracts.ts';
const [url,encoded]=process.argv.slice(2),authority=JSON.parse(encoded),ledger=new Ledger(url);
let ready=false;
try{for(;;){
 try{await ledger.tx(async c=>{await ledger.fence(c,authority);await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'synthetic.generation.writer',$2)",[authority.contextId,{epoch:authority.epoch}]);});}
 catch(error){if(error instanceof Refusal){console.log(JSON.stringify({stopped:error.code}));break;}throw error;}
 if(!ready){console.log('READY');ready=true;}
 await new Promise(resolve=>setTimeout(resolve,20));
}}finally{await ledger.close();}
