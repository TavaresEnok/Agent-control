import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../../src/ledger.ts';
import {configureRecoveryInventory} from '../../src/recovery-inventory.ts';
import {NativeResourceDockerDaemon} from '../../src/native-resource-envelope.ts';
import {RemoteOperations,OpenSshTransport} from '../../src/remote.ts';

const options=JSON.parse(await readFile(process.argv[2]!, 'utf8')),db=new Ledger(options.url);
try{
 await configureRecoveryInventory(db,options.catalog);
 await db.pause(options.principal,options.context,false);
 const authority=await db.acquire(options.principal,options.context,randomUUID(),'t30-source',60);
 const intent=await db.accept(options.principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:options.context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:t30-synthetic'}},authority,'api');
 const ssh=new OpenSshTransport(async id=>{if(id!==options.credentialId)throw Error('FIXTURE_CREDENTIAL_SCOPE');return options.credential;},new Set(['127.0.0.1']));
 const remote=new RemoteOperations(db,ssh),remoteId=randomUUID();
 await remote.start(options.principal,{operationId:remoteId,intentId:intent.id,contextId:options.context,hostId:options.hostId,taskId:'slow'},authority);
 const docker=new NativeResourceDockerDaemon(options.native);docker.bindRecoveryLedger(db);
 const name='ac-native-plan-'+randomUUID();await docker.admit([name],async()=>true);
 const id=await docker.create(name,{Image:options.image,Entrypoint:['/usr/bin/python3'],Cmd:['-c',"import pathlib,time; p=pathlib.Path('/output/native-writes');\nwhile True:\n p.open('a').write('x\\n'); time.sleep(.03)"],HostConfig:{Binds:[options.project+':/output:rw']}});
 await docker.start(id);
 await writeFile(options.ready,JSON.stringify({remoteId,nativeId:id,authority,intentId:intent.id}),{mode:0o600,flag:'wx'});
 await new Promise<void>(()=>{setInterval(()=>{},10000);});
}finally{await db.close();}
