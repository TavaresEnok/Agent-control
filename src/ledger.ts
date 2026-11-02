import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Authority, Checkpoint, Command, digest, Refusal, Projection } from './contracts.ts';
import { workflowFor } from './workflows.ts';
import { Template } from './templates.ts';

export type Intent = { id: string; context_id: string; operation_id: string; run_id: string;
  manager_epoch: string; plan_revision: number; state: string; command: Command };
export class Ledger {
  readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString, max: 8 }); }
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const v = await fn(c); await c.query('COMMIT'); return v; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async migrate() {
    const folder = new URL('../db/migrations/', import.meta.url);
    const migrations = (await readdir(folder)).filter(n => /^\d+_.+\.sql$/.test(n)).sort();
    await this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(189234,1)');
      await c.query('CREATE TABLE IF NOT EXISTS ac_schema_migrations(version integer PRIMARY KEY, digest text NOT NULL)');
      for (const filename of migrations) {
        const version = Number(filename.split('_')[0]);
        const sql = await readFile(new URL(filename, folder), 'utf8');
        const prior = await c.query('SELECT digest FROM ac_schema_migrations WHERE version=$1', [version]);
        if (prior.rowCount) { if (prior.rows[0].digest !== digest(sql)) throw new Refusal('MIGRATION_CHANGED'); continue; }
        await c.query(sql); await c.query('INSERT INTO ac_schema_migrations VALUES($1,$2)', [version, digest(sql)]);
      }
    });
  }
  async authorize(c: pg.PoolClient, principal: string, contextId: string, write = true) {
    const r = await c.query(`SELECT x.*,m.role FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
      WHERE x.id=$1 AND m.principal_id=$2 AND NOT x.archived FOR UPDATE OF x`, [contextId, principal]);
    if (!r.rowCount || (write && r.rows[0].role === 'viewer')) throw new Refusal('CONTEXT_FORBIDDEN', 403);
    return r.rows[0];
  }
  async createContext(principal: string, projectId: string, sessionId: string) {
    return this.tx(async c => {
      const access = await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [projectId, principal]);
      if (!access.rowCount || access.rows[0].role === 'viewer') throw new Refusal('PROJECT_FORBIDDEN', 403);
      const id = randomUUID();
      await c.query('INSERT INTO ac_contexts(id,project_id) VALUES($1,$2)', [id, projectId]);
      await c.query('INSERT INTO ac_session_links(session_id,context_id,principal_id) VALUES($1,$2,$3)', [sessionId, id, principal]);
      return id;
    });
  }
  async acquire(principal: string, contextId: string, instanceId: string, profileId: string, leaseSeconds = 15): Promise<Authority> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60) throw new Refusal('INVALID_LEASE', 400);
    return this.tx(async c => {
      await this.authorize(c, principal, contextId);
      const r = await c.query(`INSERT INTO ac_managers VALUES($1,$2,$3,1,clock_timestamp()+$4*interval '1 second')
        ON CONFLICT(context_id) DO UPDATE SET instance_id=excluded.instance_id,profile_id=excluded.profile_id,
        epoch=ac_managers.epoch+1,lease_until=excluded.lease_until
        WHERE ac_managers.lease_until<=clock_timestamp() RETURNING epoch`, [contextId, instanceId, profileId, leaseSeconds]);
      if (!r.rowCount) throw new Refusal('MANAGER_ACTIVE');
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'manager.acquired',$2)",
        [contextId, { instanceId, profileId, epoch: Number(r.rows[0].epoch) }]);
      return Authority.parse({ contextId, instanceId, epoch: Number(r.rows[0].epoch) });
    });
  }
  async fence(c: pg.PoolClient, authority: Authority, allowPaused = false) {
    const a = Authority.parse(authority);
    const r = await c.query(`SELECT x.paused,m.epoch FROM ac_contexts x JOIN ac_managers m ON m.context_id=x.id
      WHERE x.id=$1 AND m.instance_id=$2 AND m.epoch=$3 AND m.lease_until>clock_timestamp() FOR UPDATE OF x,m`,
    [a.contextId, a.instanceId, a.epoch]);
    if (!r.rowCount) throw new Refusal('STALE_MANAGER');
    if (r.rows[0].paused && !allowPaused) throw new Refusal('HUMAN_PAUSED');
    const admission=(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0];
    if (!admission?.enabled && !allowPaused) throw new Refusal('ADMISSION_CLOSED');
  }
  async heartbeat(a: Authority) {
    await this.tx(async c => {
      await this.fence(c, a, true);
      await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '15 seconds' WHERE context_id=$1", [a.contextId]);
    });
  }
  async pause(principal: string, contextId: string, paused: boolean) {
    await this.tx(async c => { await this.authorize(c, principal, contextId);
      await c.query('UPDATE ac_contexts SET paused=$2,pause_revision=pause_revision+1 WHERE id=$1', [contextId, paused]);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'context.pause',$2)", [contextId, { paused }]);
    });
  }
  async checkpoint(a: Authority, snapshot: Checkpoint) {
    const parsed = Checkpoint.parse(snapshot);
    await this.tx(async c => { await this.fence(c, a, true);
      const r = await c.query('SELECT plan_revision FROM ac_contexts WHERE id=$1', [a.contextId]);
      if (parsed.planRevision !== r.rows[0].plan_revision) throw new Refusal('CHECKPOINT_REVISION_MISMATCH');
      await c.query(`INSERT INTO ac_checkpoints VALUES($1,$2,$3,now()) ON CONFLICT(context_id)
        DO UPDATE SET epoch=excluded.epoch,snapshot=excluded.snapshot,updated_at=now()`, [a.contextId, a.epoch, parsed]);
    });
  }
  async refreshPending(c: pg.PoolClient, contextId: string) {
    const pending=(await c.query("SELECT id FROM ac_intents WHERE context_id=$1 AND state NOT IN ('done','review','failed','canceled') ORDER BY created_at,id",[contextId])).rows.map(r=>r.id);
    await c.query("UPDATE ac_checkpoints SET snapshot=jsonb_set(snapshot,'{pendingIntentIds}',$2::jsonb),updated_at=now() WHERE context_id=$1",[contextId,JSON.stringify(pending)]);
  }
  async recoverCheckpoint(authority: Authority): Promise<Checkpoint|null> {
    return this.tx(async c=>{
      await this.fence(c,authority,true);
      const saved=(await c.query('SELECT k.snapshot,x.plan_revision FROM ac_contexts x LEFT JOIN ac_checkpoints k ON k.context_id=x.id WHERE x.id=$1',[authority.contextId])).rows[0];
      if(!saved?.snapshot)return null;
      const value=Checkpoint.parse(saved.snapshot);
      if(value.planRevision!==saved.plan_revision)throw new Refusal('CHECKPOINT_STALE');
      await this.refreshPending(c,authority.contextId);
      return Checkpoint.parse((await c.query('SELECT snapshot FROM ac_checkpoints WHERE context_id=$1',[authority.contextId])).rows[0].snapshot);
    });
  }
  async accept(principal: string, raw: Command, a: Authority, channel: string): Promise<Intent> {
    const command = Command.parse(raw);
    return this.tx(async c => {
      const context = await this.authorize(c, principal, command.contextId);
      if (command.contextId !== a.contextId) throw new Refusal('AUTHORITY_SCOPE_MISMATCH', 403);
      // Serialize duplicate intent IDs across contexts before binding their payload.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [command.intentId]);
      const { deliveryAttemptId, ...semantic } = command;
      const hash = digest({ principal, ...semantic });
      const old = await c.query<Intent & { digest: string }>('SELECT * FROM ac_intents WHERE id=$1', [command.intentId]);
      let intent: Intent;
      if (old.rowCount) {
        if (old.rows[0].digest !== hash) throw new Refusal('INTENT_PAYLOAD_CONFLICT');
        intent = old.rows[0];
      } else {
        await this.fence(c, a);
        if(context.draining)throw new Refusal('CONTEXT_DRAINING');
        if (context.policy_revision !== command.policyRevision) throw new Refusal('POLICY_REVISION_MISMATCH');
        const revision = context.plan_revision + 1;
        const saved = await c.query('SELECT snapshot FROM ac_checkpoints WHERE context_id=$1 FOR UPDATE', [command.contextId]);
        const checkpoint = saved.rowCount ? Checkpoint.parse(saved.rows[0].snapshot) : null;
        if (checkpoint && checkpoint.planRevision !== context.plan_revision) throw new Refusal('CHECKPOINT_STALE');
        await c.query('UPDATE ac_contexts SET plan_revision=$2 WHERE id=$1', [command.contextId, revision]);
        intent = (await c.query<Intent>(`INSERT INTO ac_intents
          (id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [command.intentId, command.contextId, principal, hash, command, randomUUID(), randomUUID(), a.epoch, revision])).rows[0];
        if(context.active_template_revision){
          const selected=(await c.query('SELECT snapshot,digest FROM ac_context_templates WHERE context_id=$1 AND revision=$2',
            [command.contextId,context.active_template_revision])).rows[0];
          if(!selected)throw new Refusal('TEMPLATE_NOT_FOUND');
          const template=Template.parse(selected.snapshot);
          if(digest(template)!==selected.digest)throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
          if(template.workflow!==command.payload.workflow)throw new Refusal('TEMPLATE_WORKFLOW_MISMATCH');
          await c.query('INSERT INTO ac_intent_templates VALUES($1,$2,$3,$4,$5)',
            [intent.id,command.contextId,context.active_template_revision,template,selected.digest]);
        }else if(command.payload.workflow==='engineering-synthetic-v1')throw new Refusal('TEMPLATE_REQUIRED');
        const workflow=workflowFor(command.payload.workflow);
        await c.query('INSERT INTO ac_frozen_plans VALUES($1,$2,$3,$4,$5)',[command.contextId,revision,intent.id,digest(workflow),workflow]);
        await c.query('INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,\'registered\',$3)', [intent.operation_id, intent.id, a.epoch]);
        await c.query('INSERT INTO ac_outbox(id,intent_id) VALUES($1,$2)', [randomUUID(), intent.id]);
        if (checkpoint) await c.query('UPDATE ac_checkpoints SET epoch=$2,snapshot=$3,updated_at=now() WHERE context_id=$1',
          [command.contextId, a.epoch, { ...checkpoint, planRevision: revision,
            pendingIntentIds: [...new Set([...checkpoint.pendingIntentIds, intent.id])] }]);
        else {
          const first=(await c.query('SELECT id FROM ac_intents WHERE context_id=$1 ORDER BY plan_revision LIMIT 1',[command.contextId])).rows[0];
          const initial=Checkpoint.parse({schemaVersion:1,planRevision:revision,objectiveRef:`intent:${first.id}`,
            constraintRefs:[],decisionRefs:[],artifactRefs:[],pendingIntentIds:[intent.id],historyCursor:0});
          await c.query('INSERT INTO ac_checkpoints VALUES($1,$2,$3,now())',[command.contextId,a.epoch,initial]);
        }
        await this.refreshPending(c,command.contextId);
        await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'intent.accepted',$2)", [a.contextId, { intentId: intent.id, epoch: a.epoch }]);
      }
      await c.query('INSERT INTO ac_deliveries(id,intent_id,channel) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [deliveryAttemptId, intent.id, channel]);
      const delivery = await c.query('SELECT intent_id FROM ac_deliveries WHERE id=$1', [deliveryAttemptId]);
      if (delivery.rows[0].intent_id !== intent.id) throw new Refusal('DELIVERY_ID_CONFLICT');
      return intent;
    });
  }
  async event(principal: string, value: Projection, authority: Authority) {
    const p = Projection.parse(value);
    await this.tx(async c => { await this.authorize(c, principal, p.contextId);
      if (authority.contextId !== p.contextId) throw new Refusal('AUTHORITY_SCOPE_MISMATCH', 403);
      await this.fence(c, authority, true);
      const bound = await c.query('SELECT 1 FROM ac_intents WHERE context_id=$1 AND run_id=$2 AND plan_revision=$3', [p.contextId, p.runId, p.planRevision]);
      if (!bound.rowCount) throw new Refusal('PROJECTION_SCOPE_MISMATCH');
      await c.query('INSERT INTO ac_events VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,seq) DO NOTHING',
        [p.eventId, p.contextId, p.runId, p.planRevision, p.seq, p.status]);
    });
  }
  async close() { await this.pool.end(); }
}
