import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {OperatorProof} from './operator.ts';
import {ProjectAdmin} from './project-admin.ts';
import {readJsonBody} from './request-json.ts';

const PROJECT_ADMIN_BODY_LIMIT=16384;
/** Base64 of a 64 KiB bundle plus the signed command metadata. The decoded bundle cap stays 65536. */
const REMOTE_SOURCE_BODY_LIMIT=96*1024;
const REMOTE_SOURCE_PATH='/api/v1/ac/project-admin/remote-source';
const PROJECT_ADMIN_PATH='/api/v1/ac/project-admin';

function jsonError(error:string,status:number,noStore:boolean){
 return Response.json({error},{status,headers:noStore?{'cache-control':'no-store'}:undefined});
}
/** Caller authenticates the session and checks Origin before this global family. */
export function createProjectAdminApi(service:ProjectAdmin,options:{bodyTimeoutMs?:number}={}){
 return async(request:Request,principal:string):Promise<Response>=>{
  const path=new URL(request.url).pathname;
  const developing=path==='/api/v1/ac/project-admin/remote-development';
  const returning=path==='/api/v1/ac/project-admin/remote-return';
  const remote=path===REMOTE_SOURCE_PATH||returning||developing;
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
   const allowed=developing?['project.prepareRemoteDevelopment','project.launchRemoteDevelopment','project.registerRemoteArtifact']:[returning?'project.returnRemoteArtifact':'project.materializeRemoteSource'];
   if(remote&&(parsed===null||typeof parsed!=='object'||!allowed.includes(String((parsed as {action?:unknown}).action))))return fail(400,'INVALID_CONTRACT');
   return Response.json(await service.execute(principal,parsed,proof),{headers:{'cache-control':'no-store'}});
  }catch(error){
   if(error instanceof Refusal)return fail(error.status,error.code);
   if(error instanceof z.ZodError||error instanceof SyntaxError)return fail(400,'INVALID_CONTRACT');
   return fail(500,'INTERNAL_ERROR');
  }
 };
}
