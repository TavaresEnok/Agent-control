import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {OperatorProof} from './operator.ts';
import {ProjectAdmin} from './project-admin.ts';

const PROJECT_ADMIN_BODY_LIMIT=16384;
/** Base64 of a 64 KiB bundle plus the signed command metadata. The decoded bundle cap stays 65536. */
const REMOTE_SOURCE_BODY_LIMIT=96*1024;
const REMOTE_SOURCE_PATH='/api/v1/ac/project-admin/remote-source';
const PROJECT_ADMIN_PATH='/api/v1/ac/project-admin';

function jsonError(error:string,status:number,noStore:boolean){
 return Response.json({error},{status,headers:noStore?{'cache-control':'no-store'}:undefined});
}
/**
 * Shared JSON reader. The limit is chosen by the exact route.
 * A declared Content-Length above the limit is refused, and the stream is still counted
 * when the header is absent or smaller than the bytes that arrive. The reader is cancelled
 * on overflow, deadline and caller abort.
 */
async function readJsonBody(request:Request,limit:number,timeoutMs:number,noStore:boolean):Promise<unknown|Response>{
 if(request.signal.aborted)return jsonError('REQUEST_ABORTED',400,noStore);
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return jsonError('UNSUPPORTED_MEDIA_TYPE',415,noStore);
 if(!/^(?:identity)?$/i.test(request.headers.get('content-encoding')??''))return jsonError('UNSUPPORTED_CONTENT_ENCODING',415,noStore);
 if(Number(request.headers.get('content-length')??0)>limit)return jsonError('REQUEST_BODY_TOO_LARGE',413,noStore);
 const reader=request.body?.getReader();let total=0;const chunks:Uint8Array[]=[];
 if(reader){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=Symbol('body deadline'),aborted=Symbol('body aborted');
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(deadline),timeoutMs);});
  let onAbort=()=>{};
  const cancellation=new Promise<never>((_,reject)=>{
   onAbort=()=>reject(aborted);
   if(request.signal.aborted)reject(aborted);
   else request.signal.addEventListener('abort',onAbort,{once:true});
  });
  void cancellation.catch(()=>{});
  try{
   for(;;){
    if(request.signal.aborted){void reader.cancel().catch(()=>{});return jsonError('REQUEST_ABORTED',400,noStore);}
    const part=await Promise.race([reader.read(),timeout,cancellation]);
    if(part.done)break;
    total+=part.value.byteLength;
    if(total>limit){void reader.cancel().catch(()=>{});return jsonError('REQUEST_BODY_TOO_LARGE',413,noStore);}
    chunks.push(part.value);
   }
  }catch(error){
   void reader.cancel().catch(()=>{});
   if(error===deadline)return jsonError('REQUEST_BODY_TIMEOUT',408,noStore);
   if(error===aborted)return jsonError('REQUEST_ABORTED',400,noStore);
   throw error;
  }finally{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);}
 }
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return JSON.parse(new TextDecoder().decode(bytes));
}

/** Caller authenticates the session and checks Origin before this global family. */
export function createProjectAdminApi(service:ProjectAdmin,options:{bodyTimeoutMs?:number}={}){
 return async(request:Request,principal:string):Promise<Response>=>{
  const path=new URL(request.url).pathname;
  const remote=path===REMOTE_SOURCE_PATH;
  const legacy=path===PROJECT_ADMIN_PATH;
  const fail=(status:number,error:string)=>jsonError(error,status,remote);
  try{
   if(!remote&&!legacy)return fail(404,'NOT_FOUND');
   if(remote){if(request.method!=='POST')return fail(405,'METHOD_NOT_ALLOWED');}
   else if(request.method==='GET')return Response.json(await service.view(principal),{headers:{'cache-control':'no-store'}});
   else if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
   const proofHeader=request.headers.get('x-ac-operator-proof');
   if(!proofHeader||proofHeader.length>2000)throw new Refusal('HUMAN_CONTROL_AUTH_REQUIRED',403);
   const proof=OperatorProof.parse(JSON.parse(Buffer.from(proofHeader,'base64url').toString('utf8')));
   const parsed=await readJsonBody(request,remote?REMOTE_SOURCE_BODY_LIMIT:PROJECT_ADMIN_BODY_LIMIT,options.bodyTimeoutMs??10000,remote);
   if(parsed instanceof Response)return parsed;
   if(remote&&(parsed===null||typeof parsed!=='object'||(parsed as {action?:unknown}).action!=='project.materializeRemoteSource'))return fail(400,'INVALID_CONTRACT');
   return Response.json(await service.execute(principal,parsed,proof),{headers:{'cache-control':'no-store'}});
  }catch(error){
   if(error instanceof Refusal)return fail(error.status,error.code);
   if(error instanceof z.ZodError||error instanceof SyntaxError)return fail(400,'INVALID_CONTRACT');
   return fail(500,'INTERNAL_ERROR');
  }
 };
}
