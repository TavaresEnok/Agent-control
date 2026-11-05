import {Hono} from 'hono';
import {z} from 'zod';
import {Refusal,Id} from './contracts.ts';
import {OperatorProof} from './operator.ts';
import {ProjectEnvironments,environmentRefusal} from './project-environments.ts';
class EnvironmentBodyError extends Error{constructor(readonly status:408|413,code:string){super(code);}}

/** Root mounts this exact global family after session authentication and Origin
 * validation; it needs no project runtime or operational account activation. */
export function createProjectEnvironmentApi(service:ProjectEnvironments,options:{bodyTimeoutMs?:number}={}){
 const app=new Hono<{Bindings:{principal:string}}>();
 app.use('*',async(c,next)=>{if(!c.env.principal)return c.json({error:'AUTH_REQUIRED'},401);c.header('Cache-Control','no-store');await next();});
 app.onError((error,c)=>{
  if(error instanceof EnvironmentBodyError)return c.json({error:error.message},error.status);
  const refusal=error instanceof Refusal?error:environmentRefusal(error);
  if(refusal)return c.json({error:refusal.code},refusal.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError)return c.json({error:'INVALID_CONTRACT'},400);
  return c.json({error:'INTERNAL_ERROR'},500);
 });
 app.get('/api/v1/ac/project-admin/environments',async c=>c.json(await service.view(c.env.principal,Id.parse(c.req.query('projectId')))));
 app.post('/api/v1/ac/project-admin/environments',async c=>{
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(c.req.header('content-type')??''))return c.json({error:'UNSUPPORTED_MEDIA_TYPE'},415);
  if(!/^(?:identity)?$/i.test(c.req.header('content-encoding')??''))return c.json({error:'UNSUPPORTED_CONTENT_ENCODING'},415);
  const header=c.req.header('x-ac-operator-proof');if(!header||header.length>2000)throw new Refusal('HUMAN_CONTROL_AUTH_REQUIRED',403);
  const proof=OperatorProof.parse(JSON.parse(Buffer.from(header,'base64url').toString('utf8')));
  return c.json(await service.configure(c.env.principal,await readBoundedJson(c.req.raw,options.bodyTimeoutMs??10000),proof));
 });
 return async(request:Request,principal:string):Promise<Response>=>app.fetch(request,{principal});
}

async function readBoundedJson(request:Request,timeoutMs:number):Promise<unknown>{
 if(request.signal.aborted)throw new Refusal('REQUEST_ABORTED',400);
 if(Number(request.headers.get('content-length')??0)>16384)throw new EnvironmentBodyError(413,'REQUEST_BODY_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new SyntaxError('Missing body');
 let timer:ReturnType<typeof setTimeout>|undefined,onAbort=()=>{};
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new EnvironmentBodyError(408,'REQUEST_BODY_TIMEOUT')),timeoutMs);});
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(new Refusal('REQUEST_ABORTED',400));request.signal.addEventListener('abort',onAbort,{once:true});});
 const chunks:Uint8Array[]=[];let total=0;
 try{
  for(;;){const chunk=await Promise.race([reader.read(),deadline,aborted]);if(chunk.done)break;total+=chunk.value.byteLength;if(total>16384)throw new EnvironmentBodyError(413,'REQUEST_BODY_TOO_LARGE');chunks.push(chunk.value);}
  const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(data));
 }catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',onAbort);}
}
