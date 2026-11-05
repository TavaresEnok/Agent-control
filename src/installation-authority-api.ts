import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {OperatorProof} from './operator.ts';
import {InstallationAuthority} from './installation-authority.ts';
class HttpFailure extends Error{constructor(readonly code:string,readonly status:number){super(code);}}
/** Mount behind existing session + Origin guard. Service remains synthetic-only. */
export function createInstallationAuthorityApi(service:InstallationAuthority){
 return async(request:Request,principal:string):Promise<Response>=>{
  const headers={'cache-control':'no-store'};
  try{
   const url=new URL(request.url);
   if(url.pathname!=='/api/v1/ac/installation-authority')return Response.json({error:'NOT_FOUND'},{status:404,headers});
   if(request.method==='GET')return Response.json(await service.view(principal,z.uuid().parse(url.searchParams.get('domainId'))),{headers});
   if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405,headers});
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))throw new HttpFailure('UNSUPPORTED_MEDIA_TYPE',415);
   const encoded=request.headers.get('x-ac-operator-proof');if(!encoded||encoded.length>2000)throw new Refusal('HUMAN_CONTROL_AUTH_REQUIRED',403);
   const proof=OperatorProof.parse(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')));
   const reader=request.body?.getReader();let body='',bytes=0;
   if(reader){const decoder=new TextDecoder();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpFailure('REQUEST_BODY_TIMEOUT',408)),3000);});
    try{for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)throw new HttpFailure('REQUEST_BODY_TOO_LARGE',413);body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
    finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}}
   return Response.json(await service.execute(principal,JSON.parse(body),proof),{headers});
  }catch(error){const status=(error instanceof Refusal||error instanceof HttpFailure)?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500;
   return Response.json({error:(error instanceof Refusal||error instanceof HttpFailure)?error.code:status===400?'INVALID_CONTRACT':'INTERNAL_ERROR'},{status,headers});}
 };
}
