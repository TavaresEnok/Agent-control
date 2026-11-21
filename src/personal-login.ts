import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import type {BrowserSessions} from './sessions.ts';

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
 sessions.bindCredentialEpoch(async()=>(await import('./personal-password.ts')).panelCredentialEpoch(dataDirectory));
}

/** Password login. Issues the cookie for the ledger owner; no token is read. */
export function personalPasswordLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions){
 bindPasswordEpoch(config.dataDirectory,sessions);
 return async(request:Request)=>{
  sessions.checkOrigin(request);
  const input=z.object({user:z.string().min(1).max(40),password:z.string().min(1).max(200)}).strict().parse(await request.json());
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const {verifyPanelLogin,panelLoginDenied,panelSessionSeconds,panelCredentialEpoch}=await import('./personal-password.ts');
  const {pairClientIp}=await import('./personal-pair.ts');
  const ip=pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address'));
  const principal=await personalOwnerPrincipal(ledger,config);
  const epoch=await panelCredentialEpoch(config.dataDirectory);
  const verdict=await verifyPanelLogin(config.dataDirectory,input.user,input.password,Date.now(),ip);
  if(verdict!=='accepted')return panelLoginDenied(verdict);
  const issued=await sessions.issuePrincipal(new Request(request.url,{method:'POST',headers:request.headers}),principal,panelSessionSeconds);
  // A password change that landed while this login was being verified: the old credential must not leave a cookie behind.
  return await panelCredentialEpoch(config.dataDirectory)===epoch?issued:panelLoginDenied('invalid');
 };
}

/** Pair-code login. Spends the code and issues a cookie for the project owner. */
export function personalCodeLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions){
 bindPasswordEpoch(config.dataDirectory,sessions);
 return async(request:Request)=>{
  sessions.checkOrigin(request);
  const input=z.object({code:z.string().min(1).max(40)}).strict().parse(await request.json());
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const {redeemPairCode,pairClientIp}=await import('./personal-pair.ts');
  const ip=pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address'));
  const principal=await personalOwnerPrincipal(ledger,config);
  const verdict=await redeemPairCode(config.dataDirectory,input.code,Date.now(),ip);
  if(verdict==='limited')return Response.json({error:'PAIR_CODE_LIMIT'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});
  if(verdict!=='accepted')return Response.json({error:'PAIR_CODE_INVALID'},{status:401,headers:{'cache-control':'no-store'}});
  return sessions.issuePrincipal(new Request(request.url,{method:'POST',headers:request.headers}),principal);
 };
}
