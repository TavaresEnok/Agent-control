import {readFile} from 'node:fs/promises';
import {admitNativeResources,NativeResourceDockerDaemon} from '../../src/native-resource-envelope.ts';
import {Ledger} from '../../src/ledger.ts';
import {Capacity} from '../../src/capacity.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const db=new Ledger(input.database),capacity=new Capacity(db),docker=new NativeResourceDockerDaemon(input.envelope);
const grant=await capacity.reserve(input.principal,input.request,input.authority);
if(input.prejournal){
 await admitNativeResources({docker,ledger:db,principal:input.principal,authority:input.authority,intentId:input.request.intentId,grantId:grant.id,jobId:input.jobId,names:input.names});
 process.stdout.write(JSON.stringify({grantId:grant.id,jobId:input.jobId})+'\n');
 await new Promise(()=>setInterval(()=>{},1000));
}
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
