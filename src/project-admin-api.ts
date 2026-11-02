import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {OperatorProof} from './operator.ts';
import {ProjectAdmin} from './project-admin.ts';

/** Caller authenticates the session and checks Origin before this global family. */
export function createProjectAdminApi(service:ProjectAdmin,options:{bodyTimeoutMs?:number}={}){
 return async(request:Request,principal:string):Promise<Response>=>{
  try{
   if(request.method==='GET')return Response.json(await service.view(principal),{headers:{'cache-control':'no-store'}});
   if(request.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
   const proofHeader=request.headers.get('x-ac-operator-proof');
   if(!proofHeader||proofHeader.length>2000)throw new Refusal('HUMAN_CONTROL_AUTH_REQUIRED',403);
   const proof=OperatorProof.parse(JSON.parse(Buffer.from(proofHeader,'base64url').toString('utf8')));
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return Response.json({error:'UNSUPPORTED_MEDIA_TYPE'},{status:415});
   if(!/^(?:identity)?$/i.test(request.headers.get('content-encoding')??''))return Response.json({error:'UNSUPPORTED_CONTENT_ENCODING'},{status:415});
   if(Number(request.headers.get('content-length')??0)>16384)return Response.json({error:'REQUEST_BODY_TOO_LARGE'},{status:413});
   const reader=request.body?.getReader();let total=0;const chunks:Uint8Array[]=[];
   if(reader){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=Symbol('body deadline');
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(deadline),options.bodyTimeoutMs??10000);});
    try{for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;total+=part.value.byteLength;if(total>16384){void reader.cancel().catch(()=>{});return Response.json({error:'REQUEST_BODY_TOO_LARGE'},{status:413});}chunks.push(part.value);}}
    catch(error){void reader.cancel().catch(()=>{});if(error===deadline)return Response.json({error:'REQUEST_BODY_TIMEOUT'},{status:408});throw error;}
    finally{clearTimeout(timer);}
   }
   const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const command=JSON.parse(new TextDecoder().decode(bytes));
   return Response.json(await service.execute(principal,command,proof),{headers:{'cache-control':'no-store'}});
  }catch(error){
   if(error instanceof Refusal)return Response.json({error:error.code},{status:error.status});
   if(error instanceof z.ZodError||error instanceof SyntaxError)return Response.json({error:'INVALID_CONTRACT'},{status:400});
   return Response.json({error:'INTERNAL_ERROR'},{status:500});
  }
 };
}
