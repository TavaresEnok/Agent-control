import {redactSecrets} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {Refusal} from './contracts.ts';

/** Docker non-TTY multiplex stream. Validate every frame before emitting any
 * bytes; redact on complete per-stream text so a value split across frames
 * cannot evade the check. Per-stream order is preserved; cross-stream order is
 * intentionally not asserted. The resulting frames, not raw logs, are signed. */
export function redactNativeDockerLogs(bytes:Buffer,secrets:readonly string[]):Buffer{
 if(bytes.length>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
 const streams:Buffer[][]=[[],[]],ordered:{stream:number;start:number;end:number;payload:Buffer}[]=[];let offset=0,total=0;
 while(offset<bytes.length){
  if(bytes.length-offset<8||![1,2].includes(bytes[offset])||bytes[offset+1]!==0||bytes[offset+2]!==0||bytes[offset+3]!==0)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
  const stream=bytes[offset]!-1,size=bytes.readUInt32BE(offset+4);offset+=8;
  if(size>bytes.length-offset)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
  const payload=bytes.subarray(offset,offset+size);streams[stream]!.push(payload);ordered.push({stream,start:total,end:total+size,payload});total+=size;offset+=size;
 }
 const combined=Buffer.concat(ordered.map(part=>part.payload)),boundaries:number[]=[];let previous:number|undefined;
 for(const part of ordered){if(part.start===part.end)continue;if(previous!==undefined&&part.stream!==previous)boundaries.push(part.start);previous=part.stream;}
 for(const secret of secrets){if(!secret)continue;const value=Buffer.from(secret);for(let index=combined.indexOf(value);index>=0;index=combined.indexOf(value,index+1)){
  let lo=0,hi=boundaries.length;while(lo<hi){const mid=(lo+hi)>>>1;if(boundaries[mid]!<=index)lo=mid+1;else hi=mid;}
  if(lo<boundaries.length&&boundaries[lo]!<index+value.length)return frameDiagnostic('NATIVE_LOGS_WITHHELD_CROSS_STREAM_SECRET');
 }}
 const result:Buffer[]=[],redactedStreams:string[]=[];
 for(let stream=0;stream<streams.length;stream++){
  if(!streams[stream]!.length)continue;
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(streams[stream]!));}catch{throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');}
  const redacted=redactSecrets(text,secrets);redactedStreams.push(redacted);const payload=Buffer.from(redacted),header=Buffer.alloc(8);header[0]=stream+1;header.writeUInt32BE(payload.length,4);result.push(header,payload);
 }
 if(secrets.some(secret=>secret.length>0&&redactedStreams.join('').includes(secret)))return frameDiagnostic('NATIVE_LOGS_WITHHELD_CROSS_STREAM_SECRET');
 const safe=Buffer.concat(result);if(safe.length>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return safe;
}

/** A missing/invalid redaction context (including legacy jobs) is never a
 * license to archive unredacted bytes. Preserve a bounded, explicit diagnostic. */
export async function redactNativeLogsOrWithhold(raw:Buffer,load:()=>Promise<readonly string[]>):Promise<Buffer>{
 let secrets:readonly string[];try{secrets=await load();}catch{return frameDiagnostic();}
 return redactNativeDockerLogs(raw,secrets);
}
function frameDiagnostic(reason='NATIVE_LOGS_WITHHELD_REDACTION_CONTEXT_UNAVAILABLE'){const value=Buffer.from(reason+'\n'),header=Buffer.alloc(8);header[0]=2;header.writeUInt32BE(value.length,4);return Buffer.concat([header,value]);}

/** Refuse known credentials before a task can be journaled or materialized. */
export function assertNoNativeTaskSecrets(task:string,secrets:readonly string[]){if(secrets.some(secret=>secret.length>0&&task.includes(secret)))throw new Refusal('NATIVE_EXECUTION_SECRET_IN_TASK');}
