import {RuntimeIdentity,assertGenerationFence,assertGenerationIntent,enrollWorkflowAdmission,lockWorkflowProjectShared} from './workflow-generations.ts';
import {fenceInstallationContext,type InstallationFenceToken} from './installation-authority-fence.ts';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { acceptedCommandDigest, Authority, Checkpoint, Command, digest, Id, Refusal, Projection } from './contracts.ts';
import {CONVERSATION_CHANNEL} from './conversation-transport.ts';
import { workflowFor } from './workflows.ts';
import { Template } from './templates.ts';
import {freezeManagedExecution} from './managed-plan.ts';
import {cleanupModuleContainer, runBoundedCollectorProcess, type CollectorProcess} from './module-container-cleanup.ts';

export const VERIFICATION_MODULES = [
  'qa',
  'arquitetura',
  'dependencias',
  'banco',
  'prontidao',
  'desempenho',
  'documentacao',
  'conformidade',
] as const;
export type VerificationModule = (typeof VERIFICATION_MODULES)[number];
export type ExamModule = 'design' | 'verify' | VerificationModule;
const EXAM_MODULES: ReadonlySet<string> = new Set(['design', 'verify', ...VERIFICATION_MODULES]);
export type ExamContext = {
  contextId: string;
  mainContextId: string;
  policyRevision: number;
  capacityPolicyRevision: number | null;
  mainCapacityPolicyRevision: number | null;
};

export type Intent = { id: string; context_id: string; operation_id: string; run_id: string;
  manager_epoch: string; plan_revision: number; state: string; command: Command; parent_intent_id?:string|null;parent_unit_id?:string|null };
/** Leases a transaction proved with `fence`: the row value and the instant it was read, per context. Keyed by the client,
 * so a Ledger built without its constructor (test doubles) shares the same bookkeeping. */
/** Twice the heartbeat lease: the most a fence may lag the last heartbeat (pauses given back excluded) and still give the
 * lease back its pause. */
export const FENCED_EXTENSION_HEARTBEAT_SECONDS = 30;
/** Absolute ceiling of the time given back since the last real heartbeat: a manager whose heartbeat stopped cannot keep the
 * lease longer than this by chaining fenced transactions with short gaps. */
export const FENCED_EXTENSION_TOTAL_SECONDS = 300;
const fencedLeases = new WeakMap<pg.PoolClient, Map<string, {instanceId: string; epoch: number; leaseUntil: string; fencedAt: string}>>();
export class Ledger {
  readonly pool: pg.Pool;
  constructor(connectionString: string,readonly installationAuthority?:InstallationFenceToken,readonly runtimeIdentity?:RuntimeIdentity,/** Volumes the installation writes to; the capacity gate measures these before admitting a new worker. */readonly launchVolumes?:readonly string[]) { if(runtimeIdentity)RuntimeIdentity.parse(runtimeIdentity);this.pool = new pg.Pool({ connectionString, max: 8 }); }
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      // A pooled client is reused: a fence made outside tx() on it never extends a later transaction.
      fencedLeases.delete(c); await c.query('BEGIN'); const v = await fn(c);
      // From fence to commit this transaction holds the context anchor and the manager row: acquire, heartbeat, orphan
      // recovery and key changes all wait on them, so nobody can take the lease over meanwhile. That time does not consume
      // the lease: a Docker call made under the fence (effect, reconcile, retirement) may outlive it on a saturated disk, and
      // the heartbeat queued behind it must not then find the lease expired. Skipped when the transaction changed the lease
      // itself (heartbeat, release, key change) and on rollback. The same pause moves heartbeat_at, so a later fence queued
      // behind this one does not count it against the heartbeat; the total given back since the last real heartbeat is capped.
      for (const [contextId, held] of fencedLeases.get(c) ?? []) {
        await c.query(`WITH g AS (SELECT LEAST(clock_timestamp()-$4::timestamptz,
            GREATEST(0, $6::double precision-m.extended_seconds)*interval '1 second') pause FROM ac_managers m WHERE m.context_id=$1)
          UPDATE ac_managers m SET lease_until=m.lease_until+g.pause,heartbeat_at=m.heartbeat_at+g.pause,
            extended_seconds=m.extended_seconds+extract(epoch FROM g.pause)
          FROM g WHERE m.context_id=$1 AND m.instance_id=$2 AND m.epoch=$3 AND m.lease_until=$5::timestamptz`,
        [contextId, held.instanceId, held.epoch, held.fencedAt, held.leaseUntil, FENCED_EXTENSION_TOTAL_SECONDS]);
      }
      await c.query('COMMIT'); return v;
    }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { fencedLeases.delete(c); c.release(); }
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
    await lockWorkflowProjectShared(c,contextId);
    const r = await c.query(`SELECT x.*,m.role FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
      WHERE x.id=$1 AND m.principal_id=$2 AND NOT x.archived FOR UPDATE OF x`, [contextId, principal]);
    if (!r.rowCount || (write && r.rows[0].role === 'viewer')) throw new Refusal('CONTEXT_FORBIDDEN', 403);
    return r.rows[0];
  }
  async createContext(principal: string, projectId: string, sessionId: string) {
    return this.tx(async c => {
      await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[projectId]);
      const access = await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [projectId, principal]);
      if (!access.rowCount || access.rows[0].role === 'viewer') throw new Refusal('PROJECT_FORBIDDEN', 403);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[sessionId]);
      const linked=(await c.query('SELECT s.context_id,s.principal_id,x.project_id,x.archived FROM ac_session_links s JOIN ac_contexts x ON x.id=s.context_id WHERE s.session_id=$1',[sessionId])).rows[0];
      if(linked){
        if(linked.principal_id!==principal||linked.project_id!==projectId||linked.archived)throw new Refusal('SESSION_LINK_CONFLICT');
        return linked.context_id as string;
      }
      const id = randomUUID();
      await c.query('INSERT INTO ac_contexts(id,project_id) VALUES($1,$2)', [id, projectId]);
      await c.query('INSERT INTO ac_session_links(session_id,context_id,principal_id) VALUES($1,$2,$3)', [sessionId, id, principal]);
      return id;
    });
  }
  /** Creates or reuses the dedicated per-project exam context for `design`, `verify`, or a verification module, keeping the main context untouched. */
  async ensureExamContext(principal: string, projectId: string, module: ExamModule): Promise<ExamContext> {
    const parsedProjectId = Id.parse(projectId);
    if (!EXAM_MODULES.has(module)) throw new Refusal('INVALID_CONTRACT', 400);
    const missingCode = module === 'design' ? 'DESIGN_CONTEXT_REQUIRED' : 'VERIFY_CONTEXT_REQUIRED';
    return this.tx(async c => {
      await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE', [parsedProjectId]);
      const access = await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [parsedProjectId, principal]);
      if (!access.rowCount || access.rows[0].role === 'viewer') throw new Refusal('PROJECT_FORBIDDEN', 403);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,102))', [`${parsedProjectId}:${module}`]);
      const main = (await c.query<{id: string; capacity_policy_revision: number | null}>(
        `SELECT x.id::text AS id, x.capacity_policy_revision
         FROM ac_contexts x
         WHERE x.project_id=$1 AND NOT x.archived
           AND NOT EXISTS (SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=x.id)
         ORDER BY x.created_at, x.id LIMIT 1`,
        [parsedProjectId],
      )).rows[0];
      if (!main) throw new Refusal(missingCode, 409);
      const mainCapacityPolicyRevision = main.capacity_policy_revision === null ? null : Number(main.capacity_policy_revision);
      const existing = (await c.query<{id: string; policy_revision: number | string; capacity_policy_revision: number | null; archived: boolean}>(
        `SELECT e.context_id::text AS id, x.policy_revision, x.capacity_policy_revision, x.archived
         FROM ac_exam_contexts e JOIN ac_contexts x ON x.id=e.context_id
         WHERE e.project_id=$1 AND e.module=$2 FOR UPDATE OF x`,
        [parsedProjectId, module],
      )).rows[0];
      if (existing) {
        if (existing.archived) throw new Refusal(missingCode, 409);
        return {
          contextId: existing.id,
          mainContextId: main.id,
          policyRevision: Number(existing.policy_revision),
          capacityPolicyRevision: existing.capacity_policy_revision === null ? null : Number(existing.capacity_policy_revision),
          mainCapacityPolicyRevision,
        };
      }
      const id = randomUUID();
      await c.query('INSERT INTO ac_contexts(id,project_id) VALUES($1,$2)', [id, parsedProjectId]);
      await c.query('INSERT INTO ac_exam_contexts(project_id,module,context_id) VALUES($1,$2,$3)', [parsedProjectId, module, id]);
      return {
        contextId: id,
        mainContextId: main.id,
        policyRevision: 1,
        capacityPolicyRevision: null,
        mainCapacityPolicyRevision,
      };
    });
  }
  async acquire(
    principal: string, contextId: string, instanceId: string, profileId: string, leaseSeconds = 15,
    executeContainerCleanup: CollectorProcess = runBoundedCollectorProcess,
  ): Promise<Authority> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60) throw new Refusal('INVALID_LEASE', 400);
    for (;;) {
      const attempt = await this.tx(async c => {
        await this.authorize(c, principal, contextId);
        await fenceInstallationContext(c,contextId,this.installationAuthority);
        const {rows: pending} = await c.query<{id: string; collector_container_token: string; collector_container_id: string}>(
          `SELECT id, collector_container_token, collector_container_id FROM ac_verify_runs
           WHERE context_id=$1 AND collector_start_pending ORDER BY id`, [contextId],
        );
        if (pending.length) {
          const active = await c.query(
            'SELECT 1 FROM ac_managers WHERE context_id=$1 AND lease_until>clock_timestamp()', [contextId],
          );
          if (active.rowCount) throw new Refusal('MANAGER_ACTIVE');
          return pending;
        }
        const r = await c.query(`INSERT INTO ac_managers VALUES($1,$2,$3,1,clock_timestamp()+$4*interval '1 second')
          ON CONFLICT(context_id) DO UPDATE SET instance_id=excluded.instance_id,profile_id=excluded.profile_id,
          epoch=ac_managers.epoch+1,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at,extended_seconds=0
          WHERE ac_managers.lease_until<=clock_timestamp() RETURNING epoch`, [contextId, instanceId, profileId, leaseSeconds]);
        if (!r.rowCount) throw new Refusal('MANAGER_ACTIVE');
        await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'manager.acquired',$2)",
          [contextId, { instanceId, profileId, epoch: Number(r.rows[0].epoch) }]);
        return Authority.parse({ contextId, instanceId, epoch: Number(r.rows[0].epoch) });
      });
      if (!Array.isArray(attempt)) return attempt;
      // Only cleanup is allowed during this gap. Recheck authorization and
      // authority under the context lock once the old start is neutralized.
      for (const row of attempt) {
        await cleanupModuleContainer(this, contextId, row.id, executeContainerCleanup, row.collector_container_token, row.collector_container_id);
      }
    }
  }
  async fence(c: pg.PoolClient, authority: Authority, allowPaused = false) {
    const a = Authority.parse(authority);
    await lockWorkflowProjectShared(c,a.contextId);
    // Context anchor precedes manager/domain locks in acquire and fence alike.
    await c.query('SELECT id FROM ac_contexts WHERE id=$1 FOR UPDATE',[a.contextId]);
    const r = await c.query(`SELECT x.paused,m.epoch,m.lease_until::text lease_until,clock_timestamp()::text fenced_at,
      clock_timestamp()-m.heartbeat_at<=$4*interval '1 second' heartbeat_recent FROM ac_contexts x JOIN ac_managers m ON m.context_id=x.id
      WHERE x.id=$1 AND m.instance_id=$2 AND m.epoch=$3 AND m.lease_until>clock_timestamp() FOR UPDATE OF x,m`,
    [a.contextId, a.instanceId, a.epoch, FENCED_EXTENSION_HEARTBEAT_SECONDS]);
    if (!r.rowCount) throw new Refusal('STALE_MANAGER');
    await assertGenerationFence(c,a.contextId,allowPaused);
    await fenceInstallationContext(c,a.contextId,this.installationAuthority,allowPaused);
    if (r.rows[0].paused && !allowPaused) throw new Refusal('HUMAN_PAUSED');
    const admission=(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0];
    if (!admission?.enabled && !allowPaused) throw new Refusal('ADMISSION_CLOSED');
    const held = fencedLeases.get(c) ?? new Map();
    // Only a manager whose heartbeat is recent gets the pause back; one whose heartbeat stopped loses the lease on time.
    if (r.rows[0].heartbeat_recent && !held.has(a.contextId)) held.set(a.contextId, {instanceId: a.instanceId, epoch: a.epoch, leaseUntil: r.rows[0].lease_until, fencedAt: r.rows[0].fenced_at});
    fencedLeases.set(c, held);
  }
  async heartbeat(a: Authority) {
    await this.tx(async c => {
      await this.fence(c, a, true);
      await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '15 seconds',heartbeat_at=clock_timestamp(),extended_seconds=0 WHERE context_id=$1", [a.contextId]);
    });
  }
  /** Ends this manager's lease without deleting the row or changing its epoch. */
  async releaseLease(authority: Authority): Promise<void> {
    const a = Authority.parse(authority);
    await this.pool.query('UPDATE ac_managers SET lease_until = clock_timestamp() WHERE context_id=$1 AND instance_id=$2 AND epoch=$3', [a.contextId, a.instanceId, a.epoch]);
  }
  /** Must run after fence/authorize has locked the context. Cancellation then
   * serializes with the physical-effect transaction, not only a UI flag. */
  async assertRuntimeRoute(c:pg.PoolClient,intentId:string){await assertGenerationIntent(c,intentId,this.runtimeIdentity);}
  async assertIntentActive(c:pg.PoolClient,contextId:string,intentId:string){
    await this.assertRuntimeRoute(c,intentId);
    if(!(await c.query('SELECT 1 FROM ac_intents WHERE id=$1 AND context_id=$2',[intentId,contextId])).rowCount)
      throw new Refusal('INTENT_SCOPE_MISMATCH',403);
    if((await c.query('SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 OR intent_id=(SELECT parent_intent_id FROM ac_intents WHERE id=$1)',[intentId])).rowCount)
      throw new Refusal('PLAN_CANCELLATION_REQUESTED');
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
    const pending=(await c.query("SELECT id FROM ac_intents WHERE context_id=$1 AND parent_intent_id IS NULL AND state NOT IN ('done','review','failed','canceled') ORDER BY created_at,id",[contextId])).rows.map(r=>r.id);
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
  async accept(principal: string, raw: Command, a: Authority, channel: string, afterAccept?:(c:pg.PoolClient,intent:Intent)=>Promise<void>): Promise<Intent> {
    const command = Command.parse(raw);
    // The owner CLI inserts this exam directly and does not call accept.
    if(command.payload.workflow==='design-readonly-v1')throw new Refusal('DESIGN_INTENT_NOT_PUBLIC',403);
    if(command.payload.workflow==='engineering-native-v1'&&(channel!==CONVERSATION_CHANNEL||!afterAccept))throw new Refusal('NATIVE_CANONICAL_MESSAGE_REQUIRED',403);
    return this.tx(async c => {
      if(command.payload.workflow==='security-verify-readonly-v1'){
        const personal=await c.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'");
        if(!personal.rowCount)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
      }
      const context = await this.authorize(c, principal, command.contextId);
      if (command.contextId !== a.contextId) throw new Refusal('AUTHORITY_SCOPE_MISMATCH', 403);
      // Serialize duplicate intent IDs across contexts before binding their payload.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [command.intentId]);
      const { deliveryAttemptId } = command;
      const hash = acceptedCommandDigest(principal, command);
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
        if(command.payload.workflow!=='managed-synthetic-v1'&&command.payload.workflow!=='security-verify-readonly-v1'&&context.active_template_revision){
          const selected=(await c.query('SELECT snapshot,digest FROM ac_context_templates WHERE context_id=$1 AND revision=$2',
            [command.contextId,context.active_template_revision])).rows[0];
          if(!selected)throw new Refusal('TEMPLATE_NOT_FOUND');
          const template=Template.parse(selected.snapshot);
          if(digest(template)!==selected.digest)throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
          if(template.workflow!==command.payload.workflow)throw new Refusal('TEMPLATE_WORKFLOW_MISMATCH');
          if(template.workflow==='semantic-proposal-v1'&&command.payload.workflow==='semantic-proposal-v1'&&
            (template.qualityRevision!==command.payload.qualityRevision||template.targetRef!==command.payload.targetRef))throw new Refusal('TEMPLATE_WORKFLOW_MISMATCH');
          if(template.workflow==='semantic-proposal-v1'||template.workflow==='engineering-native-v1'){
            await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[context.project_id]);
            const latest=(await c.query('SELECT max(revision) revision FROM ac_quality_policies WHERE project_id=$1',[context.project_id])).rows[0].revision;
            if(latest!==template.qualityRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
          }
          if(template.workflow==='engineering-native-v1'){
            const p=command.payload;if(p.workflow!=='engineering-native-v1'||p.qualityRevision!==template.qualityRevision||p.targetRef!==template.targetRef||digest(p.writePaths)!==digest(template.writePaths))throw new Refusal('TEMPLATE_WORKFLOW_MISMATCH');
            await c.query('INSERT INTO ac_execution_contracts VALUES($1,$2,$3,$4,$5)',[intent.id,context.project_id,template.qualityRevision,template.targetRef,digest({qualityRevision:template.qualityRevision,targetRef:template.targetRef})]);
          }
          await c.query('INSERT INTO ac_intent_templates VALUES($1,$2,$3,$4,$5)',
            [intent.id,command.contextId,context.active_template_revision,template,selected.digest]);
        }else if(command.payload.workflow==='engineering-synthetic-v1'||command.payload.workflow==='semantic-proposal-v1'||command.payload.workflow==='engineering-native-v1')throw new Refusal('TEMPLATE_REQUIRED');
        const workflow=command.payload.workflow==='managed-synthetic-v1'
          ?await freezeManagedExecution(this,c,intent,principal,a,command.payload.proposalRevision,command.payload.proposalDigest)
          :workflowFor(command.payload.workflow);
        await c.query('INSERT INTO ac_frozen_plans VALUES($1,$2,$3,$4,$5)',[command.contextId,revision,intent.id,digest(workflow),workflow]);
        await enrollWorkflowAdmission(c,intent.id,this.runtimeIdentity);
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
      if(afterAccept){await this.fence(c,a,true);await this.assertIntentActive(c,a.contextId,intent.id);await afterAccept(c,intent);}
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
      const inserted = await c.query('INSERT INTO ac_events VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,seq) DO NOTHING',
        [p.eventId, p.contextId, p.runId, p.planRevision, p.seq, p.status]);
      if (!inserted.rowCount) {
        // A replay must describe the same fact: same context, plan revision and status at that sequence. A different
        // status at an existing sequence is a conflict, never a silent no-op. The event id is not compared, because
        // the status projection is repeated every cycle and rows written before ids became deterministic differ.
        const prior = await c.query('SELECT context_id, plan_revision, status FROM ac_events WHERE run_id=$1 AND seq=$2', [p.runId, p.seq]);
        const r = prior.rows[0];
        if (!r || r.context_id !== p.contextId || Number(r.plan_revision) !== p.planRevision || r.status !== p.status)
          throw new Refusal('EVENT_SEQUENCE_CONFLICT', 409);
      }
    });
  }
  async close() { await this.pool.end(); }
}
