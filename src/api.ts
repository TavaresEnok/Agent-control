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
import {GitArtifacts} from './git.ts';
import type {HappierAuthRelay} from './auth-relay.ts';
import type {ProviderAdapter} from './providers.ts';
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
async function publicUi(path:string):Promise<Response|null>{
  let file:string, type:string;
  if(path==='/icon.svg'){file='icon.svg';type='image/svg+xml';}
  else if(/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2|png|svg)$/.test(path)){
    file=path.slice(1);const ext=file.split('.').pop();
    type=({js:'text/javascript',css:'text/css',woff2:'font/woff2',png:'image/png',svg:'image/svg+xml'} as Record<string,string>)[ext!];
  }else if(path==='/'||/^\/(?:tasks|p|settings)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(path)){
    file='index.html';type='text/html; charset=utf-8';
  }else return null;
  try{
    const root=await realpath(resolve('upstream/cezar/packages/cezar/web/dist'));
    const actual=await realpath(resolve(root,file));
    if(!actual.startsWith(root+sep))return null;
    return new Response(await readFile(actual),{headers:{'content-type':type,'cache-control':'no-cache','x-content-type-options':'nosniff'}});
  }catch{return null;}
}

export type Authenticator = (request: Request) => Promise<string | null>;
export function createApi(ledger: Ledger, runtime: CezarRuntime, authenticate: Authenticator,
  manager: (contextId: string) => Authority | undefined, happierWebUrl = 'http://127.0.0.1:18400',
  verifySessionAccess: (principal: string, sessionId: string, request?:Request) => Promise<boolean> = async () => false,
  sessions?: BrowserSessions,authRelay?:HappierAuthRelay,providerAdapters:readonly ProviderAdapter[]=[],administrative?:AdministrativeOperations,managerStatus?:(contextId:string)=>Promise<unknown>|undefined,semanticPlanning?:SemanticPlanning) {
  const app = new Hono<{ Variables: { principal: string } }>();
  const control = new Control(ledger,providerAdapters,runtime.projectId,administrative,{reviewDigest:runtime.engineering?.options.nativeVerification?nativeReviewVerifierDigest:undefined,qaDigest:runtime.engineering?.options.nativeQa?.verifierDigest,nativeExecutionEnabled:runtime.nativeExecutionReady});
  app.use('*', async (c, next) => {
    if(sessions&&c.req.method==='GET'){
      const ui=await publicUi(c.req.path);if(ui)return ui;
    }
    if(c.req.path==='/api/v1/ac/auth/config'&&c.req.method==='GET'){c.header('Cache-Control','no-store');return c.json(authRelay?.config??{enabled:false});}
    if(authRelay&&c.req.method==='POST'&&['/api/v1/ac/auth/pair','/api/v1/ac/auth/pair/claim'].includes(c.req.path))return next();
    if(c.req.path==='/api/v1/ac/auth/session'&&c.req.method==='POST'&&sessions)return next();
    const bearer=c.req.raw.headers.get('authorization');
    const principal = bearer?await authenticate(c.req.raw):await sessions?.authenticate(c.req.raw)??await authenticate(c.req.raw);
    if(principal&&!bearer&&sessions)sessions.checkOrigin(c.req.raw);
    if (!principal) return c.json({ error: 'AUTH_REQUIRED' }, 401);
    c.set('principal', principal); await next();
  });
  app.use('/api/v1/ac/*',bodyLimit({maxSize:256*1024,onError:c=>c.json({error:'REQUEST_BODY_TOO_LARGE'},413)}));
  app.onError((e, c) => {
    if (e instanceof Refusal) return c.json({ error: e.code }, e.status);
    if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: 'INVALID_CONTRACT' }, 400);
    // Do not disclose SQL, paths, tokens or raw upstream errors.
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });
  app.route('/api/v1/ac',createPlanningApi(ledger,runtime.projectId,manager,semanticPlanning));
  app.route('/api/v1/ac',createObservabilityApi(new OperationalObservability(ledger,{diskPolicy:diskPolicyFromEnvironment()})));
  app.route('/api/v1/ac',createImportPreviewApi(ledger,runtime.projectId));
  app.route('/api/v1/ac',createDiagnosticsApi(ledger,runtime.projectId));
  app.route('/api/v1/ac',createPortableExportApi(ledger,runtime.projectId));
  const family = app
    .get('/api/v1/ac/contexts/:id/manager',async c=>{
      const id=Id.parse(c.req.param('id'));await ledger.tx(async db=>{const scope=await ledger.authorize(db,c.get('principal'),id,false);
       if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);});
      c.header('Cache-Control','no-store');return c.json(await managerStatus?.(id)??{contextId:id,state:'unavailable'});
    })
    .get('/api/v1/ac/auth/status',c=>c.json({authenticated:true,principalId:c.get('principal')}))
    .get('/api/v1/ac/operator/identity',async c=>{
      const principal=c.get('principal');
      const membership=await ledger.pool.query('SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[runtime.projectId,principal]);
      if(!membership.rowCount)throw new Refusal('PROJECT_FORBIDDEN',403);
      const installation=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
      if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
      const ids=(await ledger.pool.query("SELECT id FROM ac_operator_keys WHERE principal_id=$1 AND state='active'",[principal])).rows.map(row=>row.id);
      c.header('Cache-Control','no-store');return c.json({principalId:principal,projectId:runtime.projectId,installationId:installation.id,operatorDeviceIds:ids});
    })
    .post('/api/v1/ac/auth/pair',async c=>{if(!authRelay)throw new Refusal('INGRESS_DISABLED',403);return authRelay.forward(c.req.raw,'begin');})
    .post('/api/v1/ac/auth/pair/claim',async c=>{if(!authRelay)throw new Refusal('INGRESS_DISABLED',403);return authRelay.forward(c.req.raw,'claim');})
    .post('/api/v1/ac/auth/session',async c=>{if(!sessions)throw new Refusal('INGRESS_DISABLED',403);return sessions.issue(c.req.raw);})
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
    if (c.req.method !== 'GET') return c.json({ error: 'CANONICAL_HAPPIER_REQUIRED' }, 403);
    const url = new URL(c.req.url);
    let path = url.pathname;
    const scoped = path.match(/^\/api\/v1\/p\/([^/]+)(\/.*)$/);
    if (scoped) {
      if (![runtime.projectId, 'default'].includes(scoped[1])) throw new Refusal('PROJECT_FORBIDDEN', 403);
      path = '/api/v1' + scoped[2]; url.pathname = path;
    }
    const nativeRequest = new Request(url, c.req.raw);
    if (path.startsWith('/api/')) {
      const membership = await ledger.pool.query('SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',
        [runtime.projectId, c.get('principal')]);
      if (!membership.rowCount) throw new Refusal('PROJECT_FORBIDDEN', 403);
    }
    if(path==='/api/v1/workspace/events')return managedWorkspaceStream(ledger,runtime,c.get('principal'),c.req.raw,async()=>{
      const bearer=c.req.raw.headers.get('authorization');
      return bearer?authenticate(c.req.raw):await sessions?.authenticate(c.req.raw)??await authenticate(c.req.raw);
    });
    if(runtime.executionMode==='administration-only'&&/^\/api\/v1\/(?:providers(?:\/status)?|models)$/.test(path))
      return c.json({error:'PROVIDER_RUNTIME_NOT_ACTIVATED'},403);
    if (path === '/api/v1/runs') {
      const allowed = await ledger.pool.query(`SELECT i.run_id FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
        JOIN ac_memberships m ON m.project_id=x.project_id WHERE x.project_id=$1 AND m.principal_id=$2`, [runtime.projectId, c.get('principal')]);
      const ids = new Set(allowed.rows.map(row => row.run_id));
      return c.json(runtime.store.listRuns().filter(run => ids.has(run.id)));
    }
    const run = path.match(/^\/api\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|history|diff|layouts|usage|dispatch|todos|git\/status|changes))?$/);
    if (run) {
      const bound = await ledger.pool.query('SELECT context_id FROM ac_intents WHERE run_id=$1', [run[1]]);
      if (!bound.rowCount) throw new Refusal('RUN_FORBIDDEN', 403);
      await ledger.tx(async db => {
        const scope=await ledger.authorize(db,c.get('principal'),bound.rows[0].context_id,false);
        if(scope.project_id!==runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      });
      return runtime.native.fetch(nativeRequest);
    }
    if (/^\/api\/v1\/(health|capabilities|ui-state|repo|config|open-targets|workflows(?:\/[^/]+)?|providers(?:\/status)?|models|telemetry\/consent|workspace\/(ui-state|config|events|capabilities))$/.test(path))
      return runtime.native.fetch(nativeRequest);
    if (path === '/api/v1/projects') {
      const native = await runtime.native.fetch(nativeRequest);
      const body = z.object({ projects: z.array(z.object({ id: z.string() }).passthrough()), bootProject: z.string(), projectsDir: z.string() }).parse(await native.json());
      return c.json({ ...body, projects: body.projects.filter(project => project.id === runtime.projectId) });
    }
    if (!path.startsWith('/api/') && !/^\/(terminal|mcp|ws)(?:\/|$)/.test(path)) return runtime.native.fetch(c.req.raw);
    return c.json({ error: 'INGRESS_DISABLED' }, 403);
  });
  return family;
}
