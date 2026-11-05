import {z} from 'zod';
import {Projects,ProjectRuntimes,ProjectUnavailable} from './projects.ts';
import {Refusal} from './contracts.ts';
import type {CezarRuntime} from './cezar.ts';

type ProjectGatewayOptions={projects:Projects;runtimes:ProjectRuntimes;defaultProjectId:string;
 authenticate:(request:Request)=>Promise<string|null>;
 /** Existing gateway handles public assets, login and session issuance. */
 publicFetch:(request:Request)=>Promise<Response>;
 appFor:(runtime:CezarRuntime)=>{fetch:(request:Request)=>Response|Promise<Response>};
 projectAdmin?:(request:Request,principal:string)=>Promise<Response>;
 verifyConversationAccess?:(request:Request,principal:string,sessionId:string)=>Promise<boolean>;
 projectEnvironments?:(request:Request,principal:string)=>Promise<Response>;
 installationAuthority?:(request:Request,principal:string)=>Promise<Response>;
};
const id=z.uuid();
const publicRequest=(request:Request)=>{
 const path=new URL(request.url).pathname;
 return request.method==='GET'&&(path==='/'||path==='/icon.svg'||path.startsWith('/assets/')||/^\/(?:tasks|p|settings)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(path)||path==='/api/v1/ac/auth/config')||
 request.method==='POST'&&['/api/v1/ac/auth/pair','/api/v1/ac/auth/pair/claim','/api/v1/ac/auth/session'].includes(path);
};
/** Mount in front of the existing authenticated gateway. Selection never grants access. */
export function createProjectGateway(options:ProjectGatewayOptions){
 const apps=new WeakMap<CezarRuntime,ReturnType<ProjectGatewayOptions['appFor']>>();
 return async(request:Request):Promise<Response>=>{
  try{
   if(publicRequest(request))return options.publicFetch(request);
   const principal=await options.authenticate(request);if(!principal)return Response.json({error:'AUTH_REQUIRED'},{status:401});
   const path=new URL(request.url).pathname;
   if(path==='/api/v1/ac/conversation-entry'){
    if(request.method!=='GET')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405,headers:{allow:'GET','cache-control':'no-store'}});
    const parsed=z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/).safeParse(new URL(request.url).searchParams.get('sessionId'));
    if(!parsed.success)return Response.json({error:'INVALID_SESSION_ID'},{status:400,headers:{'cache-control':'no-store'}});
    const matches=await options.verifyConversationAccess?.(request,principal,parsed.data)?await options.projects.conversationEntry(principal,parsed.data):[];
    return Response.json({matches},{headers:{'cache-control':'no-store'}});
   }
   if(path==='/api/v1/ac/project-admin/environments' &&options.projectEnvironments)return options.projectEnvironments(request,principal);
   if(path==='/api/v1/ac/installation-authority'&&options.installationAuthority)return options.installationAuthority(request,principal);
   if((path==='/api/v1/ac/project-admin'||path==='/api/v1/ac/project-admin/remote-source'||path==='/api/v1/ac/project-admin/remote-return')&&options.projectAdmin)return options.projectAdmin(request,principal);
   const scoped=path.match(/^\/api\/v1\/p\/([^/]+)(?:\/|$)/);
   const header=request.headers.get('x-agent-control-project');
   const selected=header??(scoped&&scoped[1]!=='default'?scoped[1]:options.defaultProjectId);
   if(!id.safeParse(selected).success)return Response.json({error:'INVALID_PROJECT_ID'},{status:400});
   if(path==='/api/v1/ac/projects'&&request.method==='GET'){
    const projects=await options.projects.list(principal);
    return Response.json({projects,selectedProjectId:projects.some(p=>p.id===selected)?selected:null},{headers:{'cache-control':'no-store'}});
   }
   if(scoped&&scoped[1]!=='default'&&scoped[1]!==selected)throw new Refusal('PROJECT_FORBIDDEN',403);
   if((path==='/api/v1/projects'||/^\/api\/v1\/p\/[^/]+\/projects$/.test(path))&&request.method==='GET'){
    const projects=await options.projects.listNative(principal);
    if(scoped&&!projects.some(p=>p.id===selected))throw new Refusal('PROJECT_FORBIDDEN',403);
    const bootProject=projects.some(p=>p.id===selected)?selected:projects[0]?.id??'';
    return Response.json({projects,bootProject,projectsDir:''},{headers:{'cache-control':'no-store'}});
   }
   const project=await options.projects.authorized(principal,selected);
   if(!project)throw new Refusal('PROJECT_FORBIDDEN',403);
   const runtime=await options.runtimes.get(project);
   let app=apps.get(runtime);if(!app){app=options.appFor(runtime);apps.set(runtime,app);}
   return await app.fetch(request);
  }catch(error){
   if(error instanceof ProjectUnavailable)return Response.json({error:error.message},{status:503});
   if(error instanceof Refusal)return Response.json({error:error.code},{status:error.status});
   return Response.json({error:'INTERNAL_ERROR'},{status:500});
  }
 };
}
