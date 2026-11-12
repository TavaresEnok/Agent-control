import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {readPrivateFile} from './installation.ts';
import type {Ledger} from './ledger.ts';
import type {BrowserSessions,BearerVerifier} from './sessions.ts';

type LoginInstallation={
 dataDirectory:string;
 project:{id:string;owner:string};
 managerTransport?:{principal:string;transport?:'happier'|'local';tokenFile:string};
 happier:{upstreamOrigin:string};
 http:{publicOrigin:string};
};

/** True only when the installation file selects local. An absent field stays happier. */
export function localManagerTransport(config:{managerTransport?:{transport?:'happier'|'local'}|undefined}){
 return config.managerTransport?.transport==='local';
}

/** Happier account id for a bearer. Old cookies keep using this until they expire. */
export function happierProfileVerifier(upstreamOrigin:string,fetchPage:typeof fetch=fetch):BearerVerifier{
 return async request=>{
  const authorization=request.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return null;
  try{
   const response=await fetchPage(upstreamOrigin+'/v1/account/profile',{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!response.ok)return null;return z.object({id:z.string().min(1).max(200)}).parse(await response.json()).id;
  }catch{return null;}
 };
}

/** Direct bearer on the API. Local transport answers without calling Happier. */
export function apiBearerVerifier(config:{managerTransport?:{transport?:'happier'|'local'}|undefined;happier:{upstreamOrigin:string}},fetchPage:typeof fetch=fetch):BearerVerifier{
 if(localManagerTransport(config))return async()=>null;
 return happierProfileVerifier(config.happier.upstreamOrigin,fetchPage);
}

/** Owner of the primary project. Prefer the linked Happier principal, then the conversation, then the project owner. */
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

/** Password login. Local transport issues the cookie from the ledger owner and does not read the token. */
export function personalPasswordLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions,verify:BearerVerifier){
 return async(request:Request)=>{
  sessions.checkOrigin(request);
  const input=z.object({user:z.string().min(1).max(40),password:z.string().min(1).max(200)}).strict().parse(await request.json());
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const {verifyPanelLogin,panelLoginDenied,panelSessionSeconds}=await import('./personal-password.ts');
  const {pairClientIp}=await import('./personal-pair.ts');
  const ip=pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address'));
  if(localManagerTransport(config)){
   const principal=await personalOwnerPrincipal(ledger,config);
   const verdict=await verifyPanelLogin(config.dataDirectory,input.user,input.password,Date.now(),ip);
   if(verdict!=='accepted')return panelLoginDenied(verdict);
   return sessions.issuePrincipal(new Request(request.url,{method:'POST',headers:request.headers}),principal,panelSessionSeconds);
  }
  const raw=await readPrivateFile(config.managerTransport.tokenFile,16384);
  try{
   const token=raw.toString('utf8').trim();
   if(!token||/[\s\x00-\x1f\x7f]/.test(token))throw new Refusal('MANAGER_TOKEN_INVALID',400);
   const headers=new Headers();headers.set('authorization','Bearer '+token);
   const principal=await verify(new Request(config.http.publicOrigin+'/',{headers}));
   const owns=principal?(await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[config.project.id,principal])).rowCount:0;
   if(!principal||!owns)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const verdict=await verifyPanelLogin(config.dataDirectory,input.user,input.password,Date.now(),ip);
   if(verdict!=='accepted')return panelLoginDenied(verdict);
   const issuedHeaders=new Headers(request.headers);issuedHeaders.set('authorization','Bearer '+token);
   return await sessions.issue(new Request(request.url,{method:'POST',headers:issuedHeaders}),panelSessionSeconds);
  }finally{raw.fill(0);}
 };
}

/** Pair-code login. The local branch spends the code and skips the Happier token. */
export function personalCodeLogin(config:LoginInstallation,ledger:Ledger,sessions:BrowserSessions,verify:BearerVerifier){
 return async(request:Request)=>{
  sessions.checkOrigin(request);
  const input=z.object({code:z.string().min(1).max(40)}).strict().parse(await request.json());
  if(!config.managerTransport)throw new Refusal('PERSONAL_CONNECT_REQUIRED',503);
  const {redeemPairCode,pairClientIp}=await import('./personal-pair.ts');
  const ip=pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address'));
  if(localManagerTransport(config)){
   const principal=await personalOwnerPrincipal(ledger,config);
   const verdict=await redeemPairCode(config.dataDirectory,input.code,Date.now(),ip);
   if(verdict==='limited')return Response.json({error:'PAIR_CODE_LIMIT'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});
   if(verdict!=='accepted')return Response.json({error:'PAIR_CODE_INVALID'},{status:401,headers:{'cache-control':'no-store'}});
   return sessions.issuePrincipal(new Request(request.url,{method:'POST',headers:request.headers}),principal);
  }
  const raw=await readPrivateFile(config.managerTransport.tokenFile,16384);
  try{
   const token=raw.toString('utf8').trim();
   if(!token||/[\s\x00-\x1f\x7f]/.test(token))throw new Refusal('MANAGER_TOKEN_INVALID',400);
   const headers=new Headers();headers.set('authorization','Bearer '+token);
   const principal=await verify(new Request(config.http.publicOrigin+'/',{headers}));
   const owns=principal?(await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[config.project.id,principal])).rowCount:0;
   if(!principal||!owns)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const verdict=await redeemPairCode(config.dataDirectory,input.code,Date.now(),ip);
   if(verdict==='limited')return Response.json({error:'PAIR_CODE_LIMIT'},{status:429,headers:{'cache-control':'no-store','retry-after':'60'}});
   if(verdict!=='accepted')return Response.json({error:'PAIR_CODE_INVALID'},{status:401,headers:{'cache-control':'no-store'}});
   const issuedHeaders=new Headers(request.headers);issuedHeaders.set('authorization','Bearer '+token);
   return await sessions.issue(new Request(request.url,{method:'POST',headers:issuedHeaders}));
  }finally{raw.fill(0);}
 };
}
