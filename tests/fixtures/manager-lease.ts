import { Ledger } from '../../src/ledger.ts';
const [contextId,instanceId]=process.argv.slice(2);
const db=new Ledger(process.env.AC_TEST_DATABASE_URL!);
const authority=await db.acquire('owner',contextId,instanceId,'same-profile',1);
process.stdout.write(JSON.stringify(authority)+'\n');
setInterval(()=>{},1000);
