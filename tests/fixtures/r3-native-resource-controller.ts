import {readFile} from 'node:fs/promises';
import {NativeResourceDockerDaemon} from '../../src/native-resource-envelope.ts';
import {Ledger} from '../../src/ledger.ts';
import {Capacity} from '../../src/capacity.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const db=new Ledger(input.database),capacity=new Capacity(db),docker=new NativeResourceDockerDaemon(input.envelope);
const grant=await capacity.reserve(input.principal,input.request,input.authority);
let id:string|undefined;
for(let i=0;i<80&&!id;i++){
 try{id=await docker.create(input.name,input.configuration);}catch(error){if((error as Error).message!=='RESOURCE_AUTHORITY_BUSY')throw error;await new Promise(r=>setTimeout(r,25));}
}
if(!id)throw Error('RESOURCE_CONTROLLER_BUSY');
for(let i=0;i<80;i++){
 try{await docker.start(id);break;}catch(error){if((error as Error).message!=='RESOURCE_AUTHORITY_BUSY'||i===79)throw error;await new Promise(r=>setTimeout(r,25));}
}
await capacity.transition(input.principal,grant.id,input.authority,'running');
process.stdout.write(JSON.stringify({id,grantId:grant.id})+'\n');setInterval(()=>{},1000);
