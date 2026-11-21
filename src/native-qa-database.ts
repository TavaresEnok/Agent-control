import {redactUnknownSecrets} from './verify-redact.ts';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {QaServices} from './native-qa-contract.ts';
import {DockerDaemon} from './sandbox-broker.ts';

const JobId=z.uuid();
export type QaDatabaseLimits={memoryBytes:number;pids:number;nanoCpus:number};
export const qaNetworkName=(jobId:string)=>`ac-native-qa-net-${JobId.parse(jobId)}`;
export const qaDatabaseName=(jobId:string)=>`ac-native-qa-db-${JobId.parse(jobId)}`;

/** Controller lines may name the network and the container. They never carry the URL or the password. */
function safeQaLog(log:(line:string)=>void,line:string){
 if(/postgres(ql)?:\/\//i.test(line)||/password/i.test(line))throw new Refusal('QA_SECRET_LOG_REFUSED');
 log(line);
}

/** Remove the ephemeral database and its internal network by the job's fixed names. Missing objects are success. */
export async function removeNativeQaService(docker:DockerDaemon,jobId:string){
 const container=qaDatabaseName(jobId),network=qaNetworkName(jobId);
 const physical=await docker.inspect(container);
 if(physical){if(physical.State.Running)await docker.stop(physical.Id);await docker.remove(physical.Id);}
 await docker.removeQaNetwork(network);
}

async function dropLeftoverQaService(docker:DockerDaemon,jobId:string){
 const container=await docker.inspect(qaDatabaseName(jobId));
 const network=await docker.inspectQaNetwork(qaNetworkName(jobId));
 if(container||network)await removeNativeQaService(docker,jobId);
}

async function waitQaDatabase(docker:DockerDaemon,container:string,user:string,database:string,log:(line:string)=>void){
 const deadline=Date.now()+60_000;
 safeQaLog(log,'qa-service wait '+container);
 while(Date.now()<=deadline){
  try{if(await docker.execPgIsReady(container,user,database)===0)return;}
  catch(error){if(!(error instanceof Refusal)||error.code!=='DOCKER_EXEC_UNCERTAIN')throw error;}
  if(Date.now()>=deadline)break;
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw new Refusal('QA_DATABASE_NOT_READY');
}

/** Create the internal network and the database, then wait until it accepts connections. Returns the test URL. */
export async function provisionNativeQaDatabase(docker:DockerDaemon,jobId:string,service:QaServices['postgres'],limits:QaDatabaseLimits,log:(line:string)=>void=()=>{}){
 const container=qaDatabaseName(jobId),network=qaNetworkName(jobId);
 const user='u'+randomBytes(8).toString('hex'),password=randomBytes(18).toString('hex');
 await dropLeftoverQaService(docker,jobId);
 safeQaLog(log,'qa-service create network '+network);
 await docker.createQaNetwork(network,{'agent-control.contract':'native-qa-net-v1','agent-control.job':jobId});
 try{
  safeQaLog(log,'qa-service create database '+container);
  const id=await docker.create(container,{Image:service.image,Env:[`POSTGRES_USER=${user}`,`POSTGRES_PASSWORD=${password}`,`POSTGRES_DB=${service.database}`],
   Labels:{'agent-control.contract':'native-qa-db-v1','agent-control.job':jobId},
   HostConfig:{NetworkMode:network,Privileged:false,PublishAllPorts:false,PidsLimit:limits.pids,Memory:limits.memoryBytes,NanoCpus:limits.nanoCpus,
    Tmpfs:{'/var/lib/postgresql/data':'rw,nosuid,nodev,size=512m'}}});
  await docker.start(id);
  await waitQaDatabase(docker,container,user,service.database,log);
  safeQaLog(log,'qa-service ready '+container);
  return `postgresql://${user}:${password}@${container}:5432/${service.database}`;
 }catch(error){await removeNativeQaService(docker,jobId).catch(()=>{});throw error;}
}

/** Provision, run the test, and always remove the database and the network. */
export async function withNativeQaDatabase<T>(docker:DockerDaemon,jobId:string,service:QaServices['postgres'],limits:QaDatabaseLimits,test:(environment:string[])=>Promise<T>,log:(line:string)=>void=()=>{}){
 const url=await provisionNativeQaDatabase(docker,jobId,service,limits,log);
 try{return await test([`QA_DATABASE_URL=${url}`]);}
 finally{safeQaLog(log,'qa-service remove '+qaDatabaseName(jobId));await removeNativeQaService(docker,jobId);}
}

/** Rewrite multiplexed Docker logs so a printed database URL does not keep its password. */
export function redactQaDatabaseSecrets(logs:Buffer){
 const parts:Buffer[]=[];let offset=0;
 // The database URL and POSTGRES_PASSWORD first, then the shared secret patterns (src/verify-redact.ts).
 // The ellipsis marks a value as already masked, so the shared patterns leave it; it becomes *** at the end.
 const hide=(text:string)=>redactUnknownSecrets(text.replace(/postgresql:\/\/([^:\s/]+):([^@\s/]+)@/g,'postgresql://$1:\u2026@').replace(/POSTGRES_PASSWORD=\S+/g,'POSTGRES_PASSWORD=\u2026'))
  .replace(/(postgresql:\/\/[^:\s/]+:)\u2026@/g,'$1***@').replace(/POSTGRES_PASSWORD=\u2026/g,'POSTGRES_PASSWORD=***');
 while(offset+8<=logs.length){
  const length=logs.readUInt32BE(offset+4);
  if(length>logs.length-offset-8)return logs;
  const payload=logs.subarray(offset+8,offset+8+length),text=payload.toString('utf8'),redacted=hide(text);
  if(redacted===text)parts.push(logs.subarray(offset,offset+8+length));
  else{const body=Buffer.from(redacted),header=Buffer.alloc(8);header[0]=logs[offset]!;header.writeUInt32BE(body.length,4);parts.push(header,body);}
  offset+=8+length;
 }
 return offset===logs.length?Buffer.concat(parts):logs;
}
