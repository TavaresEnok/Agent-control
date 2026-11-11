import {listPersonalFolders,type PersonalFolderRoot} from './personal-folders.ts';
import {archivePersonalProject,createPersonalProject} from './personal-panel-projects.ts';
import {ownerRequest} from './personal-owner-request.ts';
import {claimPersonalSend,parseConversationQuery,personalMessageInput,releasePersonalSend} from './personal-panel-conversation.ts';
import {serverTiming} from './request-timing.ts';
import {nativeReviewVerifierDigest} from './native-verification.ts';
import type {AdministrativeOperations} from './administrative-operations.ts';
import { Hono } from 'hono';
import {bodyLimit} from 'hono/body-limit';
import { z } from 'zod';
import { Command, Authority, Id, Refusal, Projection } from './contracts.ts';
import { Ledger } from './ledger.ts';
import type { CezarRuntime } from './cezar.ts';
import { Control, ControlCommand } from './control.ts';
import { OperatorProof,Operators } from './operator.ts';
import type { BrowserSessions } from './sessions.ts';
import {Usage} from './usage.ts';
import {createUsageReportApi} from './usage-report-api.ts';
import {environmentRefusal} from './project-environments.ts';
import {GitArtifacts} from './git.ts';
import type {HappierAuthRelay} from './auth-relay.ts';
import {ProviderCollectors,type ProviderAdapter} from './providers.ts';
import {createPlanningApi} from './planning-api.ts';
import type {SemanticPlanning} from './semantic-planning.ts';
import {createObservabilityApi} from './observability-api.ts';
import {OperationalObservability} from './observability.ts';
import {diskPolicyFromEnvironment} from './disk-admission.ts';
import {managedWorkspaceStream} from './workspace-stream.ts';
import {createImportPreviewApi} from './import-preview-api.ts';
import {createDiagnosticsApi} from './diagnostics-api.ts';
import {createPortableExportApi} from './portable-export-api.ts';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

// Only immutable public UI files are served without a session. Never delegate an
// unauthenticated request to the embedded server, which owns privileged routes.
// Lets a phone install the cockpit as an app (home-screen icon, full screen). No service worker:
// the cockpit needs the server anyway, and nothing private is cached.
const manifest=JSON.stringify({name:'Agent Control',short_name:'Agent Control',start_url:'/',scope:'/',display:'standalone',
  background_color:'#000000',theme_color:'#000000',icons:[{src:'/pwa/icon-192.png',sizes:'192x192',type:'image/png'},
  {src:'/pwa/icon-512.png',sizes:'512x512',type:'image/png'},{src:'/pwa/icon-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]});
const installTags='<link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="#000000" />'+
  '<meta name="apple-mobile-web-app-capable" content="yes" /><meta name="mobile-web-app-capable" content="yes" />'+
  '<meta name="apple-mobile-web-app-title" content="Agent Control" /><link rel="apple-touch-icon" href="/pwa/icon-180.png" />';
// A plan run is titled "Intent <id>" because admission checks that exact task text. In the cockpit,
// show the owner's own request instead (personal mode binds it; elsewhere the title stays).
function localNativeRequest(url:URL,raw:Request){
  const local=new URL(url.pathname+url.search,'http://127.0.0.1');
  const headers=new Headers(raw.headers);headers.set('host','127.0.0.1');headers.delete('origin');
  return new Request(local,{method:raw.method,headers,signal:raw.signal});
}
const seenRuns=new Map<string,string>();
async function ownerTitled<T extends {title?:unknown}>(ledger:Ledger,run:T):Promise<T>{
  const id=(run as {id?:unknown}).id;if(typeof id==='string'&&seenRuns.has(id))run={...run,seenAt:seenRuns.get(id)};
  const match=typeof run.title==='string'?/^Intent ([0-9a-f-]{36})$/.exec(run.title):null;
  if(!match)return run;
  const row=(await ledger.pool.query('SELECT context_id FROM ac_intents WHERE id=$1',[match[1]]).catch(()=>({rows:[]}))).rows[0];
  const text=row?await ownerRequest(String(row.context_id),match[1]):undefined;
  if(!text)return run;
  const line=text.trim().split('\n')[0]!.trim();
  return {...run,title:line.length>90?line.slice(0,90).trimEnd()+'…':line};
}
async function publicUi(path:string):Promise<Response|null>{
  let file:string, type:string;
  if(path==='/manifest.webmanifest')return new Response(manifest,{headers:{'content-type':'application/manifest+json','cache-control':'no-cache','x-content-type-options':'nosniff'}});
  if(/^\/pwa\/icon-(?:180|192|512)\.png$/.test(path)){
    try{return new Response(await readFile(resolve('deploy',path.slice(1))),{headers:{'content-type':'image/png','cache-control':'max-age=86400','x-content-type-options':'nosniff'}});}catch{return null;}
  }
  if(path==='/icon.svg'){file='icon.svg';type='image/svg+xml';}
  else if(/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2|png|svg)$/.test(path)){
    file=path.slice(1);const ext=file.split('.').pop();
    type=({js:'text/javascript',css:'text/css',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml'} as Record<string,string>)[ext!];
  }else if(path==='/'||/^\/(?:tasks|p|settings|conversa|tarefas|novo-projeto|new)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(path)){
    file='index.html';type='text/html; charset=utf-8';
  }else return null;
  try{
    const root=await realpath(resolve('upstream/cezar/packages/cezar/web/dist'));
    const actual=await realpath(resolve(root,file));
    if(!actual.startsWith(root+sep))return null;
    const body=file==='index.html'?(await readFile(actual,'utf8')).replace('</head>',installTags+'</head>'):await readFile(actual);
    return new Response(body,{headers:{'content-type':type,'cache-control':'no-cache','x-content-type-options':'nosniff'}});
  }catch{return null;}
}

export type Authenticator = (request: Request) => Promise<string | null>;
export type ApiOptions = {
  happierWebUrl?: string;
  verifySessionAccess?: (principal: string, sessionId: string, request?: Request) => Promise<boolean>;
  sessions?: BrowserSessions;
  authRelay?: HappierAuthRelay;
  providerAdapters?: readonly ProviderAdapter[];
  administrative?: AdministrativeOperations;
  managerStatus?: (contextId: string) => Promise<unknown> | undefined;
  semanticPlanning?: SemanticPlanning;
  quotaRegistry?: {
    configurationDigest: string;
    reconcile(accountId?: string): Promise<number>;
    report: { state: string; realActivation: 'blocked' | 'personal'; inferenceEnabled: false; registered: number };
  };
  configurationControl?: Control;
  personalAccounts?: {
    add(principal:string,input:{provider:string;label:string;authFile?:string}):Promise<unknown>;
    status(principal:string,accountId:string):Promise<unknown>;
    readConversation(principal:string,query:{after?:string;limit:number}):Promise<{messages:{id:string;role:'owner'|'manager';text:string;createdAt:string}[];next:string|null}>;
    sendMessage(principal:string,input:{text:string;localId:string}):Promise<void>;
  };
  personalPanel?:{roots:readonly PersonalFolderRoot[];projectRepos:readonly string[];installationPath:string;scheduleRestart:()=>void};
};
export function createApi(ledger: Ledger, runtime: CezarRuntime, authenticate: Authenticator,
  manager: (contextId: string) => Authority | undefined, options: ApiOptions = {}) {
  const {happierWebUrl = 'http://127.0.0.1:18400', verifySessionAccess = async () => false, sessions, authRelay, providerAdapters = [],
    administrative, managerStatus, semanticPlanning, quotaRegistry, configurationControl, personalAccounts, personalPanel} = options;
  const projectMembership = (principal: string) => ledger.pool.query('SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [runtime.projectId, principal]);
  const projectOwnership = (principal: string) => ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'", [runtime.projectId, principal]);
  const app = new Hono<{ Variables: { principal: string; timingStarted:number; authenticationMs:number } }>();
  const control = configurationControl??new Control(ledger,providerAdapters,runtime.projectId,administrative,{reviewDigest:runtime.engineering?.options.nativeVerification?nativeReviewVerifierDigest:undefined,qaDigest:runtime.engineering?.options.nativeQa?.verifierDigest,nativeExecutionEnabled:runtime.nativeExecutionReady});
  if(control.ledger!==ledger)throw new Refusal('CONFIGURATION_LEDGER_MISMATCH');
  app.use('/api/v1/ac/*',async(c,next)=>{
    c.set('timingStarted',performance.now());c.set('authenticationMs',0);
    try{await next();}finally{
      c.header('Server-Timing',serverTiming(c.get('timingStarted'),c.get('authenticationMs')));
    }
  });
  app.use('*', async (c, next) => {
    if(sessions&&c.req.method==='GET'){
      const ui=await publicUi(c.req.path);if(ui)return ui;
    }
    if(c.req.path==='/api/v1/ac/auth/config'&&c.req.method==='GET'){c.header('Cache-Control','no-store');return c.json(authRelay?.config??{enabled:false});}
    if(authRelay&&c.req.method==='POST'&&['/api/v1/ac/auth/pair','/api/v1/ac/auth/pair/claim'].includes(c.req.path))return next();
    if(c.req.path==='/api/v1/ac/auth/session'&&c.req.method==='POST'&&sessions)return next();
    const authenticationStarted=performance.now();
    const bearer=c.req.raw.headers.get('authorization');
    let principal:string|null|undefined;
    try{principal=bearer?await authenticate(c.req.raw):await sessions?.authenticate(c.req.raw)??await authenticate(c.req.raw);}
    finally{c.set('authenticationMs',performance.now()-authenticationStarted);}
    if(principal&&!bearer&&sessions)sessions.checkOrigin(c.req.raw);
    if (!principal) return c.json({ error: 'AUTH_REQUIRED' }, 401);
    c.set('principal', principal); await next();
  });
  app.use('/api/v1/ac/*',bodyLimit({maxSize:256*1024,onError:c=>c.json({error:'REQUEST_BODY_TOO_LARGE'},413)}));
  app.onError((e, c) => {
    const refusal=e instanceof Refusal?e:environmentRefusal(e);
    if (refusal) return c.json({ error: refusal.code }, refusal.status);
    if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: 'INVALID_CONTRACT' }, 400);
    // Do not disclose SQL, paths, tokens or raw upstream errors.
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });
  app.post('/api/v1/ac/personal/projects',async c=>{
    if(!personalPanel)return c.json({error:'NOT_FOUND'},404);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const input=z.object({root:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),path:z.string().max(512).default(''),label:z.string().min(1).max(200)}).strict().parse(await c.req.json());
    const body=await createPersonalProject({installationPath:personalPanel.installationPath,roots:personalPanel.roots,rootId:input.root,relativePath:input.path,label:input.label,underSystemd:Boolean(process.env.INVOCATION_ID),addPersonalProject:(file,repository,label)=>import('./personal-project-add.ts').then(module=>module.addPersonalProject(file,repository,label))});
    if(body.restarting)personalPanel.scheduleRestart();
    c.header('Cache-Control','no-store');
    return c.json(body,202);
  });
  app.post('/api/v1/ac/personal/projects/:id/archive',async c=>{
    if(!personalPanel)return c.json({error:'NOT_FOUND'},404);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const body=await archivePersonalProject({installationPath:personalPanel.installationPath,projectId:Id.parse(c.req.param('id')),ledger,underSystemd:Boolean(process.env.INVOCATION_ID)});
    if(body.restarting)personalPanel.scheduleRestart();
    c.header('Cache-Control','no-store');
    return c.json(body,202);
  });
  app.get('/api/v1/ac/personal/folders',async c=>{
    if(!personalPanel)return c.json({error:'NOT_FOUND'},404);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    c.header('Cache-Control','no-store');
    return c.json(await listPersonalFolders({roots:personalPanel.roots,projectRepos:personalPanel.projectRepos,root:c.req.query('root'),path:c.req.query('path')}));
  });
  app.post('/api/v1/ac/personal/accounts',async c=>{
    if(!personalAccounts)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const input=z.object({provider:z.enum(['codex','claude','grok']),label:z.string().min(1).max(100),authFile:z.string().optional()}).strict().parse(await c.req.json());
    c.header('Cache-Control','no-store');
    return c.json(await personalAccounts.add(c.get('principal'),input));
  });
  app.get('/api/v1/ac/personal/accounts/:id',async c=>{
    if(!personalAccounts)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const accountId=Id.parse(c.req.param('id'));
    c.header('Cache-Control','no-store');
    return c.json(await personalAccounts.status(c.get('principal'),accountId)??{accountId,state:'unknown'});
  });
  const panelSends=new Map<string,string>();
  app.get('/api/v1/ac/personal/conversation',async c=>{
    if(!personalAccounts)return c.json({error:'NOT_FOUND'},404);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const query=parseConversationQuery({after:c.req.query('after'),limit:c.req.query('limit')});
    c.header('Cache-Control','no-store');
    const page=await personalAccounts.readConversation(c.get('principal'),query);
    return c.json({messages:page.messages.map(message=>({id:message.id,role:message.role,text:message.text,createdAt:message.createdAt})),next:page.next});
  });
  app.post('/api/v1/ac/personal/messages',async c=>{
    if(!personalAccounts)return c.json({error:'NOT_FOUND'},404);
    const input=personalMessageInput.parse(await c.req.json());
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const claim=claimPersonalSend(panelSends,runtime.projectId,input.clientId);
    if(!claim.fresh){c.header('Cache-Control','no-store');return c.json({id:claim.id},202);}
    try{
      await personalAccounts.sendMessage(c.get('principal'),{text:input.text,localId:claim.id});
    }catch(error){releasePersonalSend(panelSends,runtime.projectId,input.clientId,claim.id);throw error;}
    c.header('Cache-Control','no-store');
    return c.json({id:claim.id},202);
  });
  app.post('/api/v1/ac/personal/auto-approve',async c=>{
    if(!personalAccounts)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
    if(!(await projectOwnership(c.get('principal'))).rowCount)throw new Refusal('PROJECT_OWNER_REQUIRED',403);
    const input=z.object({enabled:z.boolean()}).strict().parse(await c.req.json());
    await ledger.pool.query('UPDATE ac_projects SET auto_approve_plans=$2 WHERE id=$1',[runtime.projectId,input.enabled]);
    c.header('Cache-Control','no-store');
    return c.json({enabled:input.enabled});
  });
  app.get('/api/v1/ac/quota-registry',async c=>{
    const owner=(await projectOwnership(c.get('principal'))).rowCount;
    if(!owner)throw new Refusal('PROJECT_FORBIDDEN',403);
    const registered=quotaRegistry?(await ledger.pool.query('SELECT count(*)::int n FROM ac_readonly_quota_registrations r JOIN ac_account_access x ON x.account_id=r.account_id JOIN ac_accounts a ON a.id=r.account_id WHERE x.project_id=$1 AND a.owner_id=$2 AND r.configuration_digest=$3',[runtime.projectId,c.get('principal'),quotaRegistry.configurationDigest])).rows[0].n:0;
    c.header('Cache-Control','no-store');return c.json({...quotaRegistry?.report??{state:'disabled',realActivation:'blocked',inferenceEnabled:false},registered});
  });
  app.post('/api/v1/ac/quota/:accountId/collect',async c=>{
    const accountId=Id.parse(c.req.param('accountId'));
    const input=z.object({observationId:z.uuid()}).strict().parse(await c.req.json());
    const permitted=(await ledger.pool.query("SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id JOIN ac_memberships m ON m.project_id=x.project_id WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3 AND m.principal_id=$2 AND m.role='owner'",[c.req.param('accountId'),c.get('principal'),runtime.projectId])).rowCount;
    if(!permitted)throw new Refusal('ACCOUNT_FORBIDDEN',403);
    // Recovery is bounded and never retires another collector's live lease.
    await quotaRegistry?.reconcile(accountId);
    c.header('Cache-Control','no-store');return c.json(await new ProviderCollectors(ledger,providerAdapters).collect(c.get('principal'),runtime.projectId,c.req.param('accountId'),input.observationId));
  });
  app.route('/api/v1/ac',createPlanningApi(ledger,runtime.projectId,manager,semanticPlanning));
  app.route('/api/v1/ac',createObservabilityApi(new OperationalObservability(ledger,{diskPolicy:diskPolicyFromEnvironment()})));
  app.route('/api/v1/ac',createImportPreviewApi(ledger,runtime.projectId));
  app.route('/api/v1/ac',createDiagnosticsApi(ledger,runtime.projectId));
  app.route('/api/v1/ac',createPortableExportApi(ledger,runtime.projectId));
  app.route('/api/v1/ac',createUsageReportApi(ledger,runtime.projectId));
  const family = app
    .get('/api/v1/ac/contexts/:id/manager',async c=>{
      const id=Id.parse(c.req.param('id'));await ledger.tx(async db=>{const scope=await ledger.authorize(db,c.get('principal'),id,false);
       if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);});
      c.header('Cache-Control','no-store');return c.json(await managerStatus?.(id)??{contextId:id,state:'unavailable'});
    })
    .get('/api/v1/ac/auth/status',c=>c.json({authenticated:true,principalId:c.get('principal')}))
    .get('/api/v1/ac/operator/identity',async c=>{
      const principal=c.get('principal');
      const membership=await projectMembership(principal);
      if(!membership.rowCount)throw new Refusal('PROJECT_FORBIDDEN',403);
      const installation=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
      if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
      const ids=(await ledger.pool.query("SELECT id FROM ac_operator_keys WHERE principal_id=$1 AND state='active'",[principal])).rows.map(row=>row.id);
      c.header('Cache-Control','no-store');return c.json({principalId:principal,projectId:runtime.projectId,installationId:installation.id,operatorDeviceIds:ids});
    })
    .post('/api/v1/ac/auth/pair',async c=>{if(!authRelay)throw new Refusal('INGRESS_DISABLED',403);return authRelay.forward(c.req.raw,'begin');})
    .post('/api/v1/ac/auth/pair/claim',async c=>{if(!authRelay)throw new Refusal('INGRESS_DISABLED',403);return authRelay.forward(c.req.raw,'claim');})
    .post('/api/v1/ac/auth/session',async c=>{
      if(!sessions)throw new Refusal('INGRESS_DISABLED',403);const started=performance.now();
      try{return await sessions.issue(c.req.raw);}finally{c.set('authenticationMs',performance.now()-started);}
    })
    .post('/api/v1/ac/auth/logout',async c=>{if(!sessions)throw new Refusal('INGRESS_DISABLED',403);return sessions.revoke(c.req.raw);})
    .get('/api/v1/ac/health', c => c.json({ schemaVersion: 1, mode: runtime.executionMode }))
    .get('/api/v1/ac/projects',async c=>{
      const projects=(await ledger.pool.query(`SELECT p.id,p.label,m.role FROM ac_projects p JOIN ac_memberships m ON m.project_id=p.id
       WHERE p.id=$1 AND m.principal_id=$2`,[runtime.projectId,c.get('principal')])).rows;
      c.header('Cache-Control','no-store');return c.json({projects,selectedProjectId:projects.length?runtime.projectId:null});
    })
    .post('/api/v1/ac/operator/bootstrap',async c=>{
      const value=z.object({deviceId:Id,publicKey:z.string().min(40).max(200),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await c.req.json());
      await new Operators(ledger).bootstrap(c.get('principal'),value);
      return c.json({state:'active'});
    })
    .get('/api/v1/ac/contexts', async c => {
      const rows=await ledger.pool.query(`SELECT x.id,x.paused,x.pause_revision,x.draining,x.drain_revision,x.plan_revision,x.policy_revision,x.capacity_policy_revision,s.session_id
        FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
        JOIN ac_session_links s ON s.context_id=x.id WHERE x.project_id=$1 AND m.principal_id=$2 AND NOT x.archived ORDER BY x.created_at`,
        [runtime.projectId,c.get('principal')]);
      return c.json({contexts:rows.rows});
    })
    .get('/api/v1/ac/contexts/:id/resources', async c => c.json(await control.view(c.get('principal'),Id.parse(c.req.param('id')))))
    .get('/api/v1/ac/contexts/:id/usage', async c => {
      const contextId=Id.parse(c.req.param('id'));
      await ledger.tx(async db=>{
        const scope=await ledger.authorize(db,c.get('principal'),contextId,false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      });
      return c.json(await new Usage(ledger).context(c.get('principal'),contextId));
    })
    .get('/api/v1/ac/contexts/:id/artifacts/:artifactId/diff',async c=>{
      const contextId=Id.parse(c.req.param('id')),artifactId=Id.parse(c.req.param('artifactId'));
      const artifact=await ledger.tx(async db=>{
        const context=await ledger.authorize(db,c.get('principal'),contextId,false);
        if(context.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
        const value=(await db.query('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[artifactId,contextId])).rows[0];
        if(!value)throw new Refusal('ARTIFACT_FORBIDDEN',403);
        return value;
      });
      const observed=await new GitArtifacts(runtime.repo).diff(artifact.commit_id,artifact.base_id);
      if(observed.tree!==artifact.tree_id)throw new Refusal('ARTIFACT_TREE_MISMATCH');
      c.header('Cache-Control','no-store');
      return c.json({...observed,artifactId,artifactDigest:artifact.identity_digest});
    })
    .post('/api/v1/ac/control', async c => {
      const encoded=c.req.header('x-ac-operator-proof');
      if(!encoded||encoded.length>2000)throw new Refusal('HUMAN_CONTROL_AUTH_REQUIRED',403);
      const proof=OperatorProof.parse(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')));
      const command=await c.req.json();
      return c.json(await control.execute(c.get('principal'),command,proof));
    })
    .post('/api/v1/ac/contexts', async c => {
      const body = z.object({ projectId: Id, happierSessionId: z.string().min(1).max(200) }).strict().parse(await c.req.json());
      if(body.projectId!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      if (!await verifySessionAccess(c.get('principal'), body.happierSessionId,c.req.raw)) throw new Refusal('SESSION_OWNERSHIP_UNVERIFIED', 403);
      const contextId = await ledger.createContext(c.get('principal'), body.projectId, body.happierSessionId);
      return c.json({ contextId }, 201);
    })
    .post('/api/v1/ac/commands', async c => {
      const command = Command.parse(await c.req.json());
      await ledger.tx(async db=>{
        const context=await ledger.authorize(db,c.get('principal'),command.contextId);
        if(context.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      });
      const authority = manager(command.contextId);
      if (!authority) throw new Refusal('MANAGER_UNAVAILABLE');
      const intent = await ledger.accept(c.get('principal'), command, authority, 'cockpit');
      return c.json({ intentId: intent.id, runId: intent.run_id, state: intent.state }, 202);
    })
    .post('/api/v1/ac/contexts/:id/pause', c => c.json({error:'SIGNED_CONTROL_REQUIRED'},403))
    .get('/api/v1/ac/contexts/:id', async c => {
      const contextId = Id.parse(c.req.param('id'));
      const data = await ledger.tx(async db => {
        const scope=await ledger.authorize(db, c.get('principal'), contextId, false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
        const context = await db.query(`SELECT x.id,x.project_id,x.paused,x.plan_revision,x.policy_revision,s.session_id
          FROM ac_contexts x JOIN ac_session_links s ON s.context_id=x.id WHERE x.id=$1`, [contextId]);
        const intents = await db.query('SELECT id,run_id,state,plan_revision FROM ac_intents WHERE context_id=$1 AND parent_intent_id IS NULL ORDER BY created_at', [contextId]);
        return { ...context.rows[0], intents: intents.rows };
      });
      return c.json(data);
    })
    .get('/api/v1/ac/contexts/:id/events', async c => {
      const contextId = Id.parse(c.req.param('id'));
      const events = await ledger.tx(async db => {
        const scope=await ledger.authorize(db, c.get('principal'), contextId, false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
        const rows = (await db.query('SELECT * FROM ac_events WHERE context_id=$1 ORDER BY run_id,seq', [contextId])).rows;
        return rows.map(row => Projection.parse({ schemaVersion: 1, eventId: row.event_id,
          contextId: row.context_id, runId: row.run_id, planRevision: row.plan_revision,
          seq: Number(row.seq), status: row.status }));
      });
      return c.json({ events });
    })
    .get('/api/v1/ac/runs/:id/conversation', async c => {
      const runId = Id.parse(c.req.param('id'));
      const row = await ledger.pool.query(`SELECT i.context_id,s.session_id FROM ac_intents i
        JOIN ac_session_links s ON s.context_id=i.context_id WHERE i.run_id=$1`, [runId]);
      if (!row.rowCount) throw new Refusal('RUN_FORBIDDEN', 403);
      await ledger.tx(async db => {
        const scope=await ledger.authorize(db,c.get('principal'),row.rows[0].context_id,false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      });
      const target = new URL('/session/' + encodeURIComponent(row.rows[0].session_id), happierWebUrl);
      if (!['https:', 'http:'].includes(target.protocol)) throw new Refusal('INVALID_CHAT_ORIGIN');
      return c.redirect(target.href, 303);
    });
  // Default-deny all native mutations, WebSocket/terminal/MCP and undocumented aliases.
  // Cezar is embedded, never exposed as a second private-port API.
  family.all('*', async c => {
    if (c.req.header('upgrade')) return c.json({ error: 'INGRESS_DISABLED' }, 403);
    // The cockpit is read-only. Its bookkeeping calls change nothing in the project and are answered
    // here, so the page does not retry them in a loop; every real mutation still goes through Happier.
    const plain=new URL(c.req.url).pathname.replace(/^\/api\/v1\/p\/[^/]+/,'/api/v1');
    // "Read" marks live in this process only; the page needs the receipt back or it retries forever.
    const read=/^\/api\/v1\/runs\/([a-f0-9-]{36})\/(read|unread)$/.exec(plain);
    if(c.req.method==='POST'&&read){const at=read[2]==='read'?new Date().toISOString():undefined;if(at)seenRuns.set(read[1]!,at);else seenRuns.delete(read[1]!);return c.json({id:read[1],seenAt:at??null});}
    if(c.req.method==='POST'&&/^\/api\/v1\/telemetry\/[a-z-]+$/.test(plain))return c.body(null,204);
    // View preferences are kept by the browser for the session; echo them instead of storing them.
    if(c.req.method==='PUT'&&plain==='/api/v1/workspace/ui-state'){const text=await c.req.text();if(text.length>65536)return c.json({error:'UI_STATE_TOO_LARGE'},413);
     try{return c.json(JSON.parse(text||'{}'));}catch{return c.json({error:'UI_STATE_INVALID'},400);}}
    if(c.req.method==='GET'&&/^\/api\/v1\/runs\/[a-f0-9-]{36}\/(?:drafts|history-context)$/.test(plain))return c.json(plain.endsWith('drafts')?{drafts:[]}:{});
    // The managed page polls these and only needs a quiet empty answer. Writes stay refused below.
    if(personalAccounts&&c.req.method==='GET'&&plain==='/api/v1/star-count')return c.json({available:false,url:'https://github.com/open-mercato/cezar'});
    if(personalAccounts&&c.req.method==='GET'&&plain==='/api/v1/workspace/agent-profiles')return c.json({editable:false,profiles:[],profileCapableProviders:[],selections:{},defaults:{}});
    if(personalAccounts&&c.req.method==='GET'&&plain==='/api/v1/workspace/agent-profiles/fallback-policy')return c.json({enabled:false,candidates:[],revision:0,incarnation:null,revocation:null});
    if(personalAccounts&&c.req.method==='GET'&&plain==='/api/v1/workspace/skills-update')return c.json({status:'current',available:false,autoUpdateEnabled:false,inherited:false,checkedAt:null,updatedAt:null,scopes:[],needsUpgradeNotes:false});
    if (c.req.method !== 'GET') return c.json({ error: 'CANONICAL_HAPPIER_REQUIRED' }, 403);
    const url = new URL(c.req.url);
    let path = url.pathname;
    const scoped = path.match(/^\/api\/v1\/p\/([^/]+)(\/.*)$/);
    if (scoped) {
      if (![runtime.projectId, 'default'].includes(scoped[1])) throw new Refusal('PROJECT_FORBIDDEN', 403);
      path = '/api/v1' + scoped[2]; url.pathname = path;
    }
    // Behind the public proxy the Host is the public name; the embedded Cezar only answers its own
    // machine (DNS-rebinding guard). Only GETs reach it, already authenticated above.
    const nativeRequest = localNativeRequest(url, c.req.raw);
    const membership = await projectMembership(c.get('principal'));
    if (!membership.rowCount) throw new Refusal('PROJECT_FORBIDDEN', 403);
    if(path==='/api/v1/workspace/events')return managedWorkspaceStream(ledger,runtime,c.get('principal'),c.req.raw,async()=>{
      const authenticationStarted=performance.now();
    const bearer=c.req.raw.headers.get('authorization');
      return bearer?authenticate(c.req.raw):await sessions?.authenticate(c.req.raw)??await authenticate(c.req.raw);
    });
    if(runtime.executionMode==='administration-only'&&/^\/api\/v1\/(?:providers(?:\/status)?|models)$/.test(path))
      return c.json({error:'PROVIDER_RUNTIME_NOT_ACTIVATED'},403);
    if (path === '/api/v1/runs') {
      const allowed = await ledger.pool.query(`SELECT i.run_id FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
        JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.project_id=$1 AND m.principal_id=$2`, [runtime.projectId, c.get('principal')]);
      const ids = new Set(allowed.rows.map(row => row.run_id));
      return c.json(await Promise.all(runtime.store.listRuns().filter(run => ids.has(run.id)).map(run=>ownerTitled(ledger,run))));
    }
    const run = path.match(/^\/api\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|history|diff|layouts|usage|dispatch|todos|git\/status|changes))?$/);
    if (run) {
      const bound = await ledger.pool.query('SELECT context_id FROM ac_intents WHERE run_id=$1', [run[1]]);
      if (!bound.rowCount) throw new Refusal('RUN_FORBIDDEN', 403);
      await ledger.tx(async db => {
        const scope=await ledger.authorize(db,c.get('principal'),bound.rows[0].context_id,false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      });
      if(!run[2]){
        const native=await runtime.native.fetch(nativeRequest);
        if(!native.ok||!native.headers.get('content-type')?.includes('json'))return native;
        return c.json(await ownerTitled(ledger,await native.json() as {title?:unknown}),native.status as 200);
      }
      return runtime.native.fetch(nativeRequest);
    }
    if (/^\/api\/v1\/(health|capabilities|ui-state|repo|config|open-targets|workflows(?:\/[^/]+)?|providers(?:\/status)?|models|telemetry\/consent|workspace\/(ui-state|config|events|capabilities))$/.test(path))
      return runtime.native.fetch(nativeRequest);
    if (path === '/api/v1/projects') {
      const native = await runtime.native.fetch(nativeRequest);
      const body = z.object({ projects: z.array(z.object({ id: z.string() }).passthrough()), bootProject: z.string(), projectsDir: z.string() }).parse(await native.json());
      return c.json({ ...body, projects: body.projects.filter(project => project.id === runtime.projectId) });
    }
    if (!path.startsWith('/api/') && !/^\/(terminal|mcp|ws)(?:\/|$)/.test(path)) return runtime.native.fetch(localNativeRequest(new URL(c.req.url), c.req.raw));
    return c.json({ error: 'INGRESS_DISABLED' }, 403);
  });
  return family;
}
