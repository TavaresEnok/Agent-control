import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join,sep } from 'node:path';
import { mkdir, readFile,realpath } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { RunManager } from '../upstream/cezar/packages/cezar/dist/workflows/run.js';
import { RunStore } from '../upstream/cezar/packages/cezar/dist/runs/store.js';
import { createApp } from '../upstream/cezar/packages/cezar/dist/server/server.js';
import { requireManagedRunnerBoundary } from '../upstream/cezar/packages/cezar/dist/core/runner-factory.js';
import type { AgentRunner, AgentSession, AgentEvent, AgentRunResult } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
import { Authority, digest, Refusal } from './contracts.ts';
import { Ledger, type Intent } from './ledger.ts';
import { Capacity } from './capacity.ts';
import { baselineWorkflow,workflowFor } from './workflows.ts';
import { EngineeringStages,type EngineeringOptions } from './engineering.ts';
import { Template } from './templates.ts';
import {IsolatedImplementation} from './isolated-implementation.ts';
import {IsolatedVerification} from './isolated-verification.ts';
export { baselineWorkflow } from './workflows.ts';

const SyntheticReceipt = z.object({ operationId: z.uuid(), base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  exitCode: z.literal(0), synthetic: z.literal(true) }).strict();
function terminate(child:ChildProcess,signal:NodeJS.Signals){
  if(child.exitCode!==null||child.signalCode!==null)return;
  try{if(child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{child.kill(signal);}
}

/** Sole DAG owner is Cezar. This adapter admits a frozen definition and projects its state. */
export class CezarRuntime {
  readonly capacity: Capacity;
  readonly engineering:EngineeringStages|undefined;
  readonly store: RunStore;
  readonly manager: RunManager;
  readonly native;
  private readonly invocation = new AsyncLocalStorage<{ intent: Intent; authority: Authority }>();
  private readonly authorities = new Map<string, Authority>();
  private readonly children = new Set<ChildProcess>();
  private readonly recovering = new Set<string>();
  private readonly recoveryAt = new Map<string,number>();
  private running = true;
  private lock: import('pg').PoolClient | undefined;
  constructor(readonly ledger: Ledger, readonly repo: string, readonly projectId: string, private readonly engineeringOptions?:EngineeringOptions,
    private readonly isolated?:IsolatedImplementation) {
    if(isolated&&isolated.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
    this.capacity = new Capacity(ledger);
    this.engineering=engineeringOptions?new EngineeringStages(ledger,projectId,{...engineeringOptions,
      ...(isolated?{isolatedVerification:new IsolatedVerification(ledger,isolated.client)}:{})}):undefined;
    this.store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    requireManagedRunnerBoundary();
    this.manager = new RunManager(this.store, repo, { managed: {
      authorizeStart: (workflow, input) => {
        if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
        const current = this.invocation.getStore();
        if (!current || digest(workflow) !== digest(workflowFor(current.intent.command.payload.workflow)) || input.task !== `Intent ${current.intent.id}` || input.dispatch)
          throw new Refusal('UNAPPROVED_PLAN');
        return current.intent.run_id;
      },
      runnerFactory: () => this.runner(),
      beforeNode: (runId,nodeId,cancelled)=>this.awaitNodeAdmission(runId,nodeId,cancelled),
      // Active-agent recovery must reconcile physical handles first (I5); never blindly respawn.
      authorizeRecovery: async run => {
        const current=this.invocation.getStore();
        if(!current||!this.isolated||!run.workflowDef||run.id!==current.intent.run_id||run.graphState?.cursor!=='implement')return false;
        return this.ledger.tx(async c=>{
          await this.ledger.fence(c,current.authority);
          const bound=(await c.query(`SELECT i.principal_id,i.command,i.plan_revision,o.state,g.state grant_state,j.state job_state,f.digest
            FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
            JOIN ac_capacity_grants g ON g.id=o.grant_id JOIN ac_sandbox_jobs j ON j.id=o.id
            JOIN ac_frozen_plans f ON f.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id
            WHERE i.id=$1 AND i.run_id=$2 AND i.context_id=$3 AND x.project_id=$4 AND o.id=$5`,
            [current.intent.id,run.id,current.authority.contextId,this.projectId,current.intent.operation_id])).rows[0];
          if(!bound)return false;
          await this.ledger.authorize(c,bound.principal_id,current.authority.contextId);
          return bound.state==='completed'&&bound.grant_state==='released'&&bound.job_state==='completed'&&
            bound.plan_revision===current.intent.plan_revision&&digest(bound.command)===digest(current.intent.command)&&
            bound.digest===digest(workflowFor(current.intent.command.payload.workflow))&&
            digest(run.workflowDef)===bound.digest;
        });
      },
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
      this.running = false; for (const child of this.children) terminate(child,'SIGKILL');
      this.engineering?.close();
      this.isolated?.close();
      if (this.lock === c) { this.lock = undefined; c.release(true); }
    };
    c.on('error', lost); c.on('end', lost);
    await this.manager.recover();
  }
  async dispatch(intent: Intent, authority: Authority) {
    if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
    const workflow=workflowFor(intent.command.payload.workflow);
    if(workflow.name==='engineering-synthetic-v1'&&!this.engineering)throw new Refusal('ENGINEERING_NOT_CONFIGURED');
    const identity = (await this.ledger.pool.query(`SELECT i.*,o.execution_attempt_id,o.state operation_state,x.project_id
      FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[intent.id])).rows[0];
    if (!identity || identity.operation_id!==intent.operation_id || identity.context_id!==intent.context_id || identity.run_id!==intent.run_id || identity.plan_revision!==intent.plan_revision || digest(identity.command)!==digest(intent.command))
      throw new Refusal('INTENT_IDENTITY_MISMATCH',403);
    if (identity.project_id!==this.projectId) throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
    const grant = identity.operation_state === 'registered' ? await this.capacity.reserve(identity.principal_id,
      {attemptId:identity.execution_attempt_id,intentId:intent.id,contextId:intent.context_id,role:'programmer'},authority) : null;
    await this.ledger.tx(async c => {
      await this.ledger.fence(c, authority);
      if (intent.context_id !== authority.contextId) throw new Refusal('EFFECT_SCOPE_MISMATCH');
      const recorded = (await c.query<Intent>('SELECT * FROM ac_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0];
      if (!recorded || recorded.context_id !== intent.context_id || recorded.operation_id !== intent.operation_id ||
        recorded.run_id !== intent.run_id || recorded.plan_revision !== intent.plan_revision || digest(recorded.command)!==digest(intent.command))
        throw new Refusal('INTENT_IDENTITY_MISMATCH', 403);
      const context = await c.query('SELECT project_id FROM ac_contexts WHERE id=$1', [intent.context_id]);
      if (context.rows[0]?.project_id !== this.projectId) throw new Refusal('PROJECT_RUNTIME_MISMATCH', 403);
      const current = await c.query('SELECT state FROM ac_operations WHERE id=$1 FOR UPDATE', [intent.operation_id]);
      if (!current.rowCount) throw new Refusal('OPERATION_MISSING');
      if (grant) {
        if (Number(grant.manager_epoch)!==authority.epoch || grant.state!=='reserved') throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
        await c.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1 AND (grant_id IS NULL OR grant_id=$2)',[intent.operation_id,grant.id]);
      }
      await c.query(`INSERT INTO ac_frozen_plans VALUES($1,$2,$3,$4,$5) ON CONFLICT(context_id,revision) DO NOTHING`,
        [intent.context_id, intent.plan_revision, intent.id, digest(workflow), workflow]);
      const snapshot = await c.query('SELECT digest FROM ac_frozen_plans WHERE intent_id=$1', [intent.id]);
      if (snapshot.rows[0]?.digest !== digest(workflow)) throw new Refusal('FROZEN_PLAN_MISMATCH');
      if(workflow.name==='engineering-synthetic-v1'){
        const chosen=(await c.query('SELECT snapshot,digest FROM ac_intent_templates WHERE intent_id=$1',[intent.id])).rows[0];
        if(!chosen)throw new Refusal('TEMPLATE_REQUIRED');
        const template=Template.parse(chosen.snapshot);
        if(digest(template)!==chosen.digest||template.workflow!=='engineering-synthetic-v1')throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
        const contract={qualityRevision:template.qualityRevision,targetRef:template.targetRef};
        const allowed=this.engineeringOptions!.allowedTargets??(this.engineeringOptions!.targetRef?[this.engineeringOptions!.targetRef]:[]);
        if(!allowed.includes(contract.targetRef))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
        await c.query('INSERT INTO ac_execution_contracts VALUES($1,$2,$3,$4,$5) ON CONFLICT(intent_id) DO NOTHING',
          [intent.id,this.projectId,contract.qualityRevision,contract.targetRef,digest(contract)]);
        const stored=(await c.query('SELECT digest FROM ac_execution_contracts WHERE intent_id=$1',[intent.id])).rows[0];
        if(stored.digest!==digest(contract))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
      }
      const existing = this.store.getRun(intent.run_id);
      if (existing) return;
      if (current.rows[0].state !== 'registered') throw new Refusal('OPERATION_UNCERTAIN');
      this.authorities.set(intent.run_id, authority);
      // startRun persists a stable run ID before enqueue; the runner checks epoch again at spawn.
      this.invocation.run({ intent, authority }, () => this.manager.startRun(workflow,
        { task: `Intent ${intent.id}`, runner: 'claude', worktree: true, generateFollowups: false }));
      this.store.flush({ throwOnError: true });
    });
    await this.ledger.tx(async c => { await this.ledger.fence(c, authority);
      await c.query("UPDATE ac_outbox SET state='dispatched',attempts=attempts+1 WHERE intent_id=$1", [intent.id]); });
    return this.store.getRun(intent.run_id);
  }
  /** Hold the native cursor, without launching a session or rewriting its plan.
   * No transaction/row lock is held during the wait, so human resume can proceed. */
  private async awaitNodeAdmission(runId:string,nodeId:string,cancelled:()=>boolean){
    let waiting=false;
    for(;;){
      if(!this.running||!this.lock||cancelled())return;
      const authority=this.authorities.get(runId);
      if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
      try{
        await this.ledger.tx(c=>this.ledger.fence(c,authority));
        if(waiting){this.store.updateRun(runId,{status:'running',error:undefined});this.store.flush({throwOnError:true});}
        return;
      }catch(error){
        if(!(error instanceof Refusal)||!['HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
        if(!waiting){
          this.store.updateRun(runId,{status:'waiting',error:`Managed admission waiting before ${nodeId}`});
          this.store.flush({throwOnError:true});waiting=true;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
  }
  /** Read an already persisted run while admission is paused. This cannot start a run. */
  async observe(intent:Intent,authority:Authority){
    return this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      const row=(await c.query(`SELECT i.context_id,i.run_id,i.operation_id,i.plan_revision,i.command,x.project_id
        FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[intent.id])).rows[0];
      if(!row||row.context_id!==authority.contextId||row.context_id!==intent.context_id||row.run_id!==intent.run_id||
         row.operation_id!==intent.operation_id||row.plan_revision!==intent.plan_revision||row.project_id!==this.projectId||
         digest(row.command)!==digest(intent.command))throw new Refusal('INTENT_IDENTITY_MISMATCH',403);
      return this.store.getRun(intent.run_id);
    });
  }
  /** Reconcile a previous isolated launch in the original Cezar worktree.
   * No native run is restarted and no new worker is launched by this method. */
  async reconcileIsolated(intent:Intent,authority:Authority){
    if(!this.running||!this.lock||!this.isolated)throw new Refusal('ISOLATED_RECOVERY_NOT_CONFIGURED');
    const run=this.store.getRun(intent.run_id);
    if(!run?.worktreePath)throw new Refusal('RECOVERY_WORKTREE_MISSING');
    const root=await realpath(join(this.repo,'.ai/cezar/worktrees'));
    const worktree=await realpath(run.worktreePath);
    if(!worktree.startsWith(root+sep))throw new Refusal('RECOVERY_WORKTREE_FORBIDDEN',403);
    return this.isolated.reconcileExisting(intent,authority,worktree);
  }
  /** Rejoin the native graph only after reconciling the interrupted implementation.
   * Called by the existing conversation heartbeat, never by a second scheduler. */
  async recoverManaged(authority:Authority){
    if(!this.isolated||!this.running||!this.lock||this.recovering.has(authority.contextId)||
       Date.now()-(this.recoveryAt.get(authority.contextId)??0)<1000)return;
    this.recovering.add(authority.contextId);this.recoveryAt.set(authority.contextId,Date.now());
    try{
      const intents=(await this.ledger.pool.query<Intent>(`SELECT i.* FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
        WHERE i.context_id=$1 AND x.project_id=$2 ORDER BY i.created_at`,[authority.contextId,this.projectId])).rows;
      for(const intent of intents){
        const run=this.store.getRun(intent.run_id);
        if(run?.status!=='waiting'||run.error!=='Managed execution awaiting authoritative reconciliation'||
           run.graphState?.cursor!=='implement'||run.askParked||run.attentionRequest)continue;
        try{
          if(await this.reconcileIsolated(intent,authority)!=='completed')continue;
          this.authorities.set(intent.run_id,authority);
          await this.invocation.run({intent,authority},()=>this.manager.resumeConfirmedNode(intent.run_id));
        }catch(error){
          if(error instanceof Refusal&&['HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))continue;
          throw error;
        }
      }
    }finally{this.recovering.delete(authority.contextId);}
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
      const released=await c.query(`UPDATE ac_capacity_grants g SET state='released',physical_receipt=$3
        FROM ac_operations o WHERE o.id=$1 AND o.grant_id=g.id AND g.manager_epoch=$2 AND g.state='running'`,
        [intent.operation_id,authority.epoch,{operationId:intent.operation_id,state:'exited',source:'fixed-synthetic-worker'}]);
      if (!released.rowCount) throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    });
  }
  private async recordFailedExit(intent:Intent,authority:Authority,pid:number|undefined,code:number|null,signal:string|null){
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      const receipt={operationId:intent.operation_id,pid:pid??null,exitCode:code,signal,physicalExited:true,synthetic:true,success:false};
      const operation=await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND state='running' AND manager_epoch=$3 RETURNING grant_id",
        [intent.operation_id,receipt,authority.epoch]);
      if(!operation.rowCount)throw new Refusal('OPERATION_RECEIPT_STALE');
      const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='running' AND manager_epoch=$3",
        [operation.rows[0].grant_id,{operationId:intent.operation_id,processId:String(pid),state:'exited',exitCode:code,signal,source:'fixed-synthetic-worker'},authority.epoch]);
      if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    });
  }
  private runner(): AgentRunner {
    const runtime = this;
    return {
      backend: 'claude',
      async run() { throw new Refusal('ONE_SHOT_DISABLED'); }, async interrupt() {},
      startSession(spec, onEvent): AgentSession {
        const runId=spec.env?.CEZ_TASK_ID;
        const run=runId?runtime.store.getRun(runId):undefined;
        const nodeId=spec.env?.AC_MANAGED_NODE_ID;
        if(run?.workflow==='engineering-synthetic-v1'&&nodeId!=='implement'){
          if(!runtime.engineering||!runId||!nodeId)throw new Refusal('ENGINEERING_NODE_NOT_ADMITTED');
          const authority=runtime.authorities.get(runId);if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
          const result=(async()=>{
            const intent=(await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE run_id=$1',[runId])).rows[0];
            if(!intent)throw new Refusal('INTENT_MISSING');
            return runtime.engineering!.start(intent,authority,nodeId,spec,onEvent);
          })();
          let active:AgentSession|undefined,opened=true,cancelled=false;
          return {result:result.then(session=>{active=session;if(cancelled)session.hardStop?.();return session.result;}).finally(()=>{opened=false;}),
            get open(){return opened;},get pid(){return active?.pid;},sendMessage(){return false;},end(){active?.end();},
            interrupt(){cancelled=true;return active?.interrupt();},hardStop(){cancelled=true;active?.hardStop?.();}};
        }
        if(runtime.isolated){
          if(!runId)throw new Refusal('EFFECT_AUTHORITY_MISSING');
          const authority=runtime.authorities.get(runId);if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
          let active:AgentSession|undefined,opened=true,canceled=false;
          const result=(async()=>{
            const intent=(await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE run_id=$1',[runId])).rows[0];
            if(!intent)throw new Refusal('INTENT_MISSING');
            active=runtime.isolated!.start(intent,authority,spec,onEvent);if(canceled)active.hardStop?.();return active.result;
          })().finally(()=>{opened=false;});
          return {result,get open(){return opened;},sendMessage(){return false;},end(){active?.end();},
            interrupt(){canceled=true;return active?.interrupt();},hardStop(){canceled=true;active?.hardStop?.();}};
        }
        let child: ChildProcess | undefined, open = true, canceled = false;
        let monitor:ReturnType<typeof setInterval>|undefined;
        let completion:Promise<number|null>|undefined;
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
            const eligible=await c.query(`SELECT g.id FROM ac_operations o JOIN ac_capacity_grants g ON g.id=o.grant_id
              JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id
              JOIN ac_quota_observations q ON q.account_id=a.id
              WHERE o.id=$1 AND g.context_id=$2 AND g.manager_epoch=$3 AND g.state='reserved'
              AND a.enabled AND p.enabled AND a.eligibility='documented_supported'
              AND q.status='available' AND q.expires_at>clock_timestamp() FOR UPDATE OF g`,
              [intent.operation_id,authority.contextId,authority.epoch]);
            if (!eligible.rowCount) throw new Refusal('GRANT_NOT_ELIGIBLE');
            await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[eligible.rows[0].id]);
            child = spawn(process.execPath, [new URL('../scripts/synthetic-worker.mjs', import.meta.url).pathname, intent.operation_id], {
              cwd: spec.cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: spec.cwd,
                GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
              stdio: ['ignore', 'pipe', 'pipe'], detached: true,
            });
            completion=new Promise<number|null>((resolve,reject)=>{
              child!.once('exit',resolve);child!.once('error',reject);
            });
            void completion.catch(()=>{});
            runtime.children.add(child);
            child.once('exit',()=>runtime.children.delete(child!));
            // Observe spawn before recording a running handle; spawn errors remain uncertain.
            await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
            const proc=await readFile(`/proc/${child.pid}/stat`,'utf8');
            const startTime=proc.slice(proc.lastIndexOf(')')+2).split(' ')[19];
            if(!/^\d+$/.test(startTime??''))throw new Refusal('PROCESS_IDENTITY_UNAVAILABLE');
            const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
            await c.query("UPDATE ac_operations SET state='running',handle=$2,native_session_id=$3 WHERE id=$1", [intent.operation_id,
              { pid: child.pid, startTime, bootId, operationId: intent.operation_id, epoch: authority.epoch, synthetic: true },z.uuid().parse(spec.sessionId)]);
          });
          if (!child) throw new Refusal('PROCESS_MISSING');
          const processChild = child;
          let checking=false;
          monitor=setInterval(()=>{
            if(checking||!open)return;checking=true;
            void runtime.ledger.tx(c=>runtime.ledger.fence(c,authority,true)).catch(()=>{
              canceled=true;terminate(processChild,'SIGKILL');
            }).finally(()=>{checking=false;});
          },500);
          let output = '';
          processChild.stdout?.on('data', b => { output = (output + String(b)).slice(-4000); });
          processChild.stderr?.resume();
          if(!completion)throw new Refusal('PROCESS_COMPLETION_MISSING');
          const code = await completion;
          runtime.children.delete(processChild); open = false;
          if (code !== 0) {
            await runtime.recordFailedExit(intent,authority,processChild.pid,code,processChild.signalCode);
            throw new Refusal('SYNTHETIC_PROCESS_FAILED');
          }
          const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
          await runtime.recordReceipt(intent, authority, receipt);
          const events: AgentEvent[] = [{ type: 'text', text: output }, { type: 'done' }];
          events.forEach(e => onEvent?.(e));
          return { text: output, toolCalls: [], tokensUsed: 0 };
        })().catch(error=>{
          if(child)terminate(child,'SIGKILL');
          throw error;
        }).finally(() => { open = false; if(monitor)clearInterval(monitor); });
        return { result, get open() { return open; }, get pid() { return child?.pid; },
          sendMessage() { return false; }, end() {}, interrupt() { canceled = true; if(child)terminate(child,'SIGTERM'); },
          hardStop() { canceled = true; if(child)terminate(child,'SIGKILL'); } };
      },
    };
  }
  async close() {
    this.running = false; for (const child of this.children) terminate(child,'SIGKILL');
    this.engineering?.close();
    this.isolated?.close();
    this.manager.dispose(); this.store.flush();
    if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(hashtextextended($1,1))', [this.repo]); this.lock.release(); this.lock = undefined; }
  }
}
