import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import type {BrowserSessions} from './sessions.ts';
import {pairClientIp,redeemPairCode} from './personal-pair.ts';
import {panelCredentialState,panelLoginDenied,panelSessionSeconds,verifyPanelLogin} from './personal-password.ts';
import {readJsonBody} from './request-json.ts';

const admission=new WeakMap<BrowserSessions,{count:number;clients:Map<string,number>}>();
const loginBodyLimit=4096;
const loginBodyTimeout=3000;

/** Both public credential routes share an in-flight budget, including bodies still being read. */
function admittedLogin(sessions:BrowserSessions,limit:()=>Response,login:(request:Request,ip:string)=>Promise<Response>){
 let budget=admission.get(sessions);
 if(!budget){budget={count:0,clients:new Map()};admission.set(sessions,budget);}
 const active=budget;
 return async(request:Request)=>{
  sessions.checkOrigin(request);
  const ip=pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address'));
  const count=active.clients.get(ip)??0;
  if(active.count>=8||count>=2){
   void request.body?.cancel().catch(()=>{/* A disconnected request still leaves no slot reserved. */});
   return limit();
  }
  active.count++;
  active.clients.set(ip,count+1);
  try{return await login(request,ip);}
  finally{
   active.count--;
   const remaining=active.clients.get(ip)!-1;
   if(remaining)active.clients.set(ip,remaining);
   else active.clients.delete(ip);
  }
 };
}
const pairLimit=()=>Response.json({error:'PAIR_CODE_LIMIT'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});


type LoginInstallation={
 dataDirectory:string;
 project:{id:string;owner:string};
 managerTransport?:{principal:string};
};

/** Owner of the primary project. Prefer the configured conversation principal, then the conversation, then the project owner. */
export async function personalOwnerPrincipal(ledger:Ledger,config:Pick<LoginInstallation,'project'|'managerTransport'>){
 const transport=config.managerTransport;if(!transport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
 const candidates:string[]=[];
 const push=(value:string|undefined)=>{if(value&&!candidates.includes(value))candidates.push(value);};
 push(transport.principal);
 const linked=(await ledger.pool.query(`SELECT s.principal_id FROM ac_contexts x JOIN ac_session_links s ON s.context_id=x.id
  WHERE x.project_id=$1 AND NOT x.archived ORDER BY x.created_at LIMIT 1`,[config.project.id])).rows[0];
 push(linked?.principal_id?String(linked.principal_id):undefined);
 push(config.project.owner);
 for(const principal of candidates){
  const owns=(await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[config.project.id,principal])).rowCount;
  if(owns)return principal;
 }
 throw new Refusal('PROJECT_OWNER_REQUIRED',403);
}

/** Sessions issued before the last password change or removal stop working, whichever route the server mounts first. */
function bindPasswordEpoch(dataDirectory:string,sessions:BrowserSessions){
 sessions.bindCredentialEpoch(()=>panelCredentialState(dataDirectory));
}

/** Password login. Issues the cookie for the ledger owner; no token is read. */
export function personalPasswordLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions){
 bindPasswordEpoch(config.dataDirectory,sessions);
 return admittedLogin(sessions,()=>panelLoginDenied('limited'),async(request,ip)=>{
  const parsed=await readJsonBody(request,loginBodyLimit,loginBodyTimeout,true);
  if(parsed instanceof Response)return parsed;
  const input=z.object({user:z.string().min(1).max(40),password:z.string().min(1).max(200)}).strict().parse(parsed);
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const {changedAt:epoch}=await panelCredentialState(config.dataDirectory);
  if(!Number.isFinite(epoch))return panelLoginDenied('invalid');
  const verdict=await verifyPanelLogin(config.dataDirectory,input.user,input.password,Date.now(),ip);
  if(verdict!=='accepted')return panelLoginDenied(verdict);
  const principal=await personalOwnerPrincipal(ledger,config);
  const issued=await sessions.issuePrincipal(request,principal,panelSessionSeconds,epoch);
  return (await panelCredentialState(config.dataDirectory)).changedAt===epoch?issued:panelLoginDenied('invalid');
 });
}

/** Pair-code login. Spends the code and issues a cookie for the project owner. */
export function personalCodeLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions){
 bindPasswordEpoch(config.dataDirectory,sessions);
 return admittedLogin(sessions,pairLimit,async(request,ip)=>{
  const parsed=await readJsonBody(request,loginBodyLimit,loginBodyTimeout,true);
  if(parsed instanceof Response)return parsed;
  const input=z.object({code:z.string().min(1).max(40)}).strict().parse(parsed);
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const verdict=await redeemPairCode(config.dataDirectory,input.code,Date.now(),ip);
  if(verdict==='limited')return pairLimit();
  if(verdict!=='accepted')return Response.json({error:'PAIR_CODE_INVALID'},{status:401,headers:{'cache-control':'no-store'}});
  const principal=await personalOwnerPrincipal(ledger,config);
  return sessions.issuePrincipal(request,principal);
 });
}
