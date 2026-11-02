import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { RunManager } from '../upstream/cezar/packages/cezar/dist/workflows/run.js';
import { RunStore } from '../upstream/cezar/packages/cezar/dist/runs/store.js';
import { createApp } from '../upstream/cezar/packages/cezar/dist/server/server.js';
import { workflowDefSchema } from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
import { requireManagedRunnerBoundary } from '../upstream/cezar/packages/cezar/dist/core/runner-factory.js';
import type { AgentRunner, AgentSession, AgentEvent, AgentRunResult } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
import { Authority, digest, Refusal } from './contracts.ts';
import { Ledger, type Intent } from './ledger.ts';

export const baselineWorkflow = workflowDefSchema.parse({
  name: 'baseline-synthetic-v1', source: 'built-in',
  steps: [{ id: 'implement', name: 'Synthetic implementation', prompt: 'Execute the fixed isolated baseline fixture.' }],
  graph: { version: 2, nodes: [
    { id: 'start', type: 'start' },
    { id: 'implement', type: 'agent', name: 'Synthetic implementation', prompt: 'Execute the fixed isolated baseline fixture.' },
    { id: 'done', type: 'end', status: 'success' },
  ], edges: [{ from: 'start', to: 'implement' }, { from: 'implement', to: 'done' }] },
});
const SyntheticReceipt = z.object({ operationId: z.uuid(), base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  exitCode: z.literal(0), synthetic: z.literal(true) }).strict();

/** Sole DAG owner is Cezar. This adapter admits a frozen definition and projects its state. */
export class CezarRuntime {
  readonly store: RunStore;
  readonly manager: RunManager;
  readonly native;
  private readonly invocation = new AsyncLocalStorage<{ intent: Intent; authority: Authority }>();
  private readonly authorities = new Map<string, Authority>();
  private readonly children = new Set<ChildProcess>();
  private running = true;
  private lock: import('pg').PoolClient | undefined;
  constructor(readonly ledger: Ledger, readonly repo: string, readonly projectId: string) {
    this.store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    requireManagedRunnerBoundary();
    this.manager = new RunManager(this.store, repo, { managed: {
      authorizeStart: (workflow, input) => {
        if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
        const current = this.invocation.getStore();
        if (!current || digest(workflow) !== digest(baselineWorkflow) || input.task !== `Intent ${current.intent.id}` || input.dispatch)
          throw new Refusal('UNAPPROVED_PLAN');
        return current.intent.run_id;
      },
      runnerFactory: () => this.runner(),
      // Active-agent recovery must reconcile physical handles first (I5); never blindly respawn.
      authorizeRecovery: async () => false,
    } });
    this.native = createApp({ repoRoot: repo, store: this.store, manager: this.manager,
      bootProjectId: projectId, version: 'agent-control-0.1.0' });
  }
  async start() {
    const c = await this.ledger.pool.connect();
    const r = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS ok', [this.repo]);
    if (!r.rows[0].ok) { c.release(); throw new Refusal('RUNTIME_ALREADY_ACTIVE'); }
    this.lock = c;
    const lost = () => {
      this.running = false; for (const child of this.children) child.kill('SIGKILL');
      if (this.lock === c) { this.lock = undefined; c.release(true); }
    };
    c.on('error', lost); c.on('end', lost);
    await this.manager.recover();
  }
  async dispatch(intent: Intent, authority: Authority) {
    if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
    await this.ledger.tx(async c => {
      await this.ledger.fence(c, authority);
      if (intent.context_id !== authority.contextId) throw new Refusal('EFFECT_SCOPE_MISMATCH');
      const recorded = (await c.query<Intent>('SELECT * FROM ac_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0];
      if (!recorded || recorded.context_id !== intent.context_id || recorded.operation_id !== intent.operation_id ||
        recorded.run_id !== intent.run_id || recorded.plan_revision !== intent.plan_revision)
        throw new Refusal('INTENT_IDENTITY_MISMATCH', 403);
      const context = await c.query('SELECT project_id FROM ac_contexts WHERE id=$1', [intent.context_id]);
      if (context.rows[0]?.project_id !== this.projectId) throw new Refusal('PROJECT_RUNTIME_MISMATCH', 403);
      const current = await c.query('SELECT state FROM ac_operations WHERE id=$1 FOR UPDATE', [intent.operation_id]);
      if (!current.rowCount) throw new Refusal('OPERATION_MISSING');
      await c.query(`INSERT INTO ac_frozen_plans VALUES($1,$2,$3,$4,$5) ON CONFLICT(context_id,revision) DO NOTHING`,
        [intent.context_id, intent.plan_revision, intent.id, digest(baselineWorkflow), baselineWorkflow]);
      const snapshot = await c.query('SELECT digest FROM ac_frozen_plans WHERE intent_id=$1', [intent.id]);
      if (snapshot.rows[0]?.digest !== digest(baselineWorkflow)) throw new Refusal('FROZEN_PLAN_MISMATCH');
      const existing = this.store.getRun(intent.run_id);
      if (existing) return;
      if (current.rows[0].state !== 'registered') throw new Refusal('OPERATION_UNCERTAIN');
      this.authorities.set(intent.run_id, authority);
      // startRun persists a stable run ID before enqueue; the runner checks epoch again at spawn.
      this.invocation.run({ intent, authority }, () => this.manager.startRun(baselineWorkflow,
        { task: `Intent ${intent.id}`, runner: 'claude', worktree: true, generateFollowups: false }));
      this.store.flush({ throwOnError: true });
    });
    await this.ledger.tx(async c => { await this.ledger.fence(c, authority);
      await c.query("UPDATE ac_outbox SET state='dispatched',attempts=attempts+1 WHERE intent_id=$1", [intent.id]); });
    return this.store.getRun(intent.run_id);
  }
  async recordReceipt(intent: Intent, authority: Authority, receipt: unknown) {
    await this.ledger.tx(async c => {
      if (intent.context_id !== authority.contextId) throw new Refusal('EFFECT_SCOPE_MISMATCH');
      await this.ledger.fence(c, authority, true);
      const parsed = SyntheticReceipt.safeParse(receipt);
      if (!parsed.success || parsed.data.operationId !== intent.operation_id) throw new Refusal('INVALID_SYNTHETIC_RECEIPT');
      const updated = await c.query(`UPDATE ac_operations o SET state='completed',receipt=$2
        FROM ac_intents i WHERE o.id=$1 AND o.intent_id=i.id AND i.id=$4 AND i.context_id=$5
        AND o.state='running' AND o.manager_epoch=$3`,
        [intent.operation_id, parsed.data, authority.epoch, intent.id, authority.contextId]);
      if (!updated.rowCount) throw new Refusal('OPERATION_RECEIPT_STALE');
    });
  }
  private runner(): AgentRunner {
    const runtime = this;
    return {
      backend: 'claude',
      async run() { throw new Refusal('ONE_SHOT_DISABLED'); }, async interrupt() {},
      startSession(spec, onEvent): AgentSession {
        let child: ChildProcess | undefined, open = true, canceled = false;
        const result = (async (): Promise<AgentRunResult> => {
          const runId = spec.env?.CEZ_TASK_ID;
          const authority = runId && runtime.authorities.get(runId);
          if (!runId || !authority) throw new Refusal('EFFECT_AUTHORITY_MISSING');
          const row = await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE run_id=$1', [runId]);
          const intent = row.rows[0]; if (!intent) throw new Refusal('INTENT_MISSING');
          const receiptPath = join(spec.cwd, `receipt-${intent.operation_id}.json`);
          await runtime.ledger.tx(async c => {
            await runtime.ledger.fence(c, authority);
            if (!runtime.running || canceled) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
            const state = await c.query('SELECT state FROM ac_operations WHERE id=$1 FOR UPDATE', [intent.operation_id]);
            if (state.rows[0].state !== 'registered') throw new Refusal('OPERATION_UNCERTAIN');
            // Persist launch intent before the physical effect. Crash here stays uncertain, never blind retry.
            await c.query("UPDATE ac_operations SET state='uncertain',manager_epoch=$2 WHERE id=$1", [intent.operation_id, authority.epoch]);
          });
          // Lock the authority across this local spawn: takeover cannot cross the effect boundary.
          await runtime.ledger.tx(async c => {
            await runtime.ledger.fence(c, authority);
            if (!runtime.running || canceled) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
            child = spawn(process.execPath, [new URL('../scripts/synthetic-worker.mjs', import.meta.url).pathname, intent.operation_id], {
              cwd: spec.cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: spec.cwd,
                GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            runtime.children.add(child);
            // Observe spawn before recording a running handle; spawn errors remain uncertain.
            await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
            await c.query("UPDATE ac_operations SET state='running',handle=$2 WHERE id=$1", [intent.operation_id,
              { pid: child.pid, operationId: intent.operation_id, epoch: authority.epoch, synthetic: true }]);
          });
          if (!child) throw new Refusal('PROCESS_MISSING');
          const processChild = child;
          let output = '';
          processChild.stdout?.on('data', b => { output = (output + String(b)).slice(-4000); });
          processChild.stderr?.resume();
          const code = await new Promise<number | null>((resolve, reject) => { processChild.once('exit', resolve); processChild.once('error', reject); });
          runtime.children.delete(processChild); open = false;
          if (code !== 0) throw new Refusal('SYNTHETIC_PROCESS_FAILED');
          const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
          await runtime.recordReceipt(intent, authority, receipt);
          const events: AgentEvent[] = [{ type: 'text', text: output }, { type: 'done' }];
          events.forEach(e => onEvent?.(e));
          return { text: output, toolCalls: [], tokensUsed: 0 };
        })().finally(() => { open = false; });
        return { result, get open() { return open; }, get pid() { return child?.pid; },
          sendMessage() { return false; }, end() {}, interrupt() { canceled = true; child?.kill('SIGTERM'); },
          hardStop() { canceled = true; child?.kill('SIGKILL'); } };
      },
    };
  }
  async close() {
    this.running = false; for (const child of this.children) child.kill('SIGKILL');
    this.manager.dispose(); this.store.flush();
    if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(hashtextextended($1,1))', [this.repo]); this.lock.release(); this.lock = undefined; }
  }
}
