import { Hono } from 'hono';
import { z } from 'zod';
import { Command, Authority, Id, Refusal, Projection } from './contracts.ts';
import { Ledger } from './ledger.ts';
import type { CezarRuntime } from './cezar.ts';

export type Authenticator = (request: Request) => Promise<string | null>;
export function createApi(ledger: Ledger, runtime: CezarRuntime, authenticate: Authenticator,
  manager: (contextId: string) => Authority | undefined, happierWebUrl = 'http://127.0.0.1:18400',
  verifySessionAccess: (principal: string, sessionId: string) => Promise<boolean> = async () => false) {
  const app = new Hono<{ Variables: { principal: string } }>();
  app.use('*', async (c, next) => {
    const principal = await authenticate(c.req.raw);
    if (!principal) return c.json({ error: 'AUTH_REQUIRED' }, 401);
    c.set('principal', principal); await next();
  });
  app.onError((e, c) => {
    if (e instanceof Refusal) return c.json({ error: e.code }, e.status);
    if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: 'INVALID_CONTRACT' }, 400);
    // Do not disclose SQL, paths, tokens or raw upstream errors.
    return c.json({ error: 'INTERNAL_ERROR' }, 500);
  });
  const family = app
    .get('/api/v1/ac/health', c => c.json({ schemaVersion: 1, mode: 'isolated-synthetic' }))
    .post('/api/v1/ac/contexts', async c => {
      const body = z.object({ projectId: Id, happierSessionId: z.string().min(1) }).strict().parse(await c.req.json());
      if (!await verifySessionAccess(c.get('principal'), body.happierSessionId)) throw new Refusal('SESSION_OWNERSHIP_UNVERIFIED', 403);
      const contextId = await ledger.createContext(c.get('principal'), body.projectId, body.happierSessionId);
      return c.json({ contextId }, 201);
    })
    .post('/api/v1/ac/commands', async c => {
      const command = Command.parse(await c.req.json());
      const authority = manager(command.contextId);
      if (!authority) throw new Refusal('MANAGER_UNAVAILABLE');
      const intent = await ledger.accept(c.get('principal'), command, authority, 'cockpit');
      return c.json({ intentId: intent.id, runId: intent.run_id, state: intent.state }, 202);
    })
    .post('/api/v1/ac/contexts/:id/pause', async c => {
      const contextId = Id.parse(c.req.param('id'));
      const { paused } = z.object({ paused: z.boolean() }).strict().parse(await c.req.json());
      await ledger.pause(c.get('principal'), contextId, paused);
      return c.json({ contextId, paused });
    })
    .get('/api/v1/ac/contexts/:id', async c => {
      const contextId = Id.parse(c.req.param('id'));
      const data = await ledger.tx(async db => {
        await ledger.authorize(db, c.get('principal'), contextId, false);
        const context = await db.query(`SELECT x.id,x.project_id,x.paused,x.plan_revision,s.session_id
          FROM ac_contexts x JOIN ac_session_links s ON s.context_id=x.id WHERE x.id=$1`, [contextId]);
        const intents = await db.query('SELECT id,run_id,state,plan_revision FROM ac_intents WHERE context_id=$1 ORDER BY created_at', [contextId]);
        return { ...context.rows[0], intents: intents.rows };
      });
      return c.json(data);
    })
    .get('/api/v1/ac/contexts/:id/events', async c => {
      const contextId = Id.parse(c.req.param('id'));
      const events = await ledger.tx(async db => {
        await ledger.authorize(db, c.get('principal'), contextId, false);
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
      await ledger.tx(db => ledger.authorize(db, c.get('principal'), row.rows[0].context_id, false));
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
      await ledger.tx(db => ledger.authorize(db, c.get('principal'), bound.rows[0].context_id, false));
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
