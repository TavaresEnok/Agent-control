import {onRunFrames} from '../upstream/cezar/packages/cezar/dist/server/run-frames.js';
import type {CezarRuntime} from './cezar.ts';
import {Ledger} from './ledger.ts';
import {Id,Refusal} from './contracts.ts';
const connections=new Map<string,number>();

/** Project-owned projection of native run frames. Never opens the native global
 * workspace stream, provider probes or an independent execution/history bus. */
export async function managedWorkspaceStream(ledger:Ledger,runtime:Pick<CezarRuntime,'projectId'|'store'>,
 principal:string,request:Request,revalidate:()=>Promise<string|null>,options:{flushMs?:number;heartbeatMs?:number}={}){
 const membership=()=>ledger.pool.query('SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[runtime.projectId,principal]);
 if(!(await membership()).rowCount)throw new Refusal('PROJECT_FORBIDDEN',403);
 const connectionKey=JSON.stringify([principal,runtime.projectId]);
 if((connections.get(connectionKey)??0)>=8)throw new Refusal('STREAM_CONNECTION_LIMIT',503);
 connections.set(connectionKey,(connections.get(connectionKey)??0)+1);
 const encoder=new TextEncoder(),pending=new Map<string,string>();
 let stop=()=>{};
 const stream=new ReadableStream<Uint8Array>({
  start(controller){
   let closed=false,busy=false;
   let timer:ReturnType<typeof setInterval>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
   const close=()=>{
    if(closed)return;closed=true;off();runtime.store.off('managed-runtime-close',close);clearInterval(timer);clearInterval(heartbeat);pending.clear();
    const remaining=(connections.get(connectionKey)??1)-1;
    if(remaining)connections.set(connectionKey,remaining);else connections.delete(connectionKey);
    request.signal.removeEventListener('abort',close);
    try{controller.close();}catch{}
   };
   const send=(event:string,data:string)=>{
    if(closed)return;
    if((controller.desiredSize??0)<=0){close();return;}
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
   };
   const off=onRunFrames(runtime.store,(run,frames)=>{
    if(closed||!Id.safeParse(run.id).success)return;
    const data=frames.workspace(runtime.projectId,true);
    if(encoder.encode(data).length>262144||(!pending.has(run.id)&&pending.size>=32)){close();return;}
    pending.set(run.id,data);
   });
   stop=close;
   runtime.store.on('managed-runtime-close',close);
   request.signal.addEventListener('abort',close,{once:true});
   const flush=async(ping=false)=>{
    if(closed||busy)return;busy=true;
    try{
     if(!(await membership()).rowCount){close();return;}
     if(await revalidate()!==principal){close();return;}
     if(closed)return;
     const batch=[...pending];for(const [id,data] of batch)if(pending.get(id)===data)pending.delete(id);
     if(batch.length){
      const rows=await ledger.pool.query(`SELECT i.run_id FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
       JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.project_id=$1 AND m.principal_id=$2
       AND NOT x.archived AND i.run_id=ANY($3::uuid[])`,[runtime.projectId,principal,batch.map(([id])=>id)]);
      const allowed=new Set(rows.rows.map(row=>row.run_id));
      for(const [id,data] of batch){if(closed)break;if(allowed.has(id))send('run',data);}
     }
     if(ping&&!closed)send('ping','');
    }catch{close();}finally{busy=false;}
   };
   timer=setInterval(()=>{if(pending.size)void flush();},options.flushMs??250);
   heartbeat=setInterval(()=>{void flush(true);},options.heartbeatMs??15000);
   void flush(true);
   if(request.signal.aborted)close();
  },
  cancel(){stop();},
 },{highWaterMark:1048576,size:chunk=>chunk.byteLength});
 return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no','x-content-type-options':'nosniff'}});
}
