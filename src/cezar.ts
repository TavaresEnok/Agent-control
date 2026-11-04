import type {NativeImplementation} from './native-implementation.ts';
import type {NativeExecutionSupervisor} from './native-execution-supervisor.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join,sep } from 'node:path';
import { mkdir, readFile,realpath } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RunManager } from '../upstream/cezar/packages/cezar/dist/workflows/run.js';
import {WorkspaceSemaphore} from '../upstream/cezar/packages/cezar/dist/workspace/semaphore.js';
import { RunStore } from '../upstream/cezar/packages/cezar/dist/runs/store.js';
import { createApp } from '../upstream/cezar/packages/cezar/dist/server/server.js';
import { requireManagedRunnerBoundary } from '../upstream/cezar/packages/cezar/dist/core/runner-factory.js';
import {childTaskEnvelope} from '../upstream/cezar/packages/cezar/dist/dispatch/engine.js';
import type { AgentRunner, AgentSession, AgentEvent, AgentRunResult } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
import { Authority, Command, digest, Refusal } from './contracts.ts';
import { refuseCurrentProtectedGate } from './quality.ts';
import { Ledger, type Intent } from './ledger.ts';
import { Capacity } from './capacity.ts';
import { baselineWorkflow,workflowFor } from './workflows.ts';
import { EngineeringStages,type EngineeringOptions } from './engineering.ts';
import { Template } from './templates.ts';
import {IsolatedImplementation} from './isolated-implementation.ts';
import {IsolatedVerification} from './isolated-verification.ts';
import {IsolatedAdvice} from './isolated-advice.ts';
import {Cancellations} from './cancellation.ts';
import type {RemoteOperations} from './remote.ts';
import type {NativePlanningSupervisor} from './native-planning-supervisor.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
import {assertNativeBootstrapAttachment,type NativeBootstrapAttachment} from './native-bootstrap.ts';
import {ManagedExecutionInput,readManagedInput,readManagedUnit,readManagedRecipe,syntheticManagedCorrectionsAuthorized,syntheticSpecialistAdviceAuthorized,type ManagedRecipe} from './managed-plan.ts';
export { baselineWorkflow } from './workflows.ts';

const SyntheticReceipt = z.object({ operationId: z.uuid(), base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), tree: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  exitCode: z.literal(0), synthetic: z.literal(true) }).strict();
const NativeTaskReceipt=z.object({operationId:z.uuid(),base:z.string().regex(/^[a-f0-9]{40}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
 tree:z.string().regex(/^[a-f0-9]{40}$/),exitCode:z.literal(0),synthetic:z.literal(false)}).passthrough();
const execFileAsync=promisify(execFile);
const recoveryStateDigest=(run:{workflowDef?:unknown;graphState?:unknown;steps:unknown})=>digest(JSON.parse(JSON.stringify({workflow:run.workflowDef,graphState:run.graphState,steps:run.steps})));
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
  private readonly managedPlans = new Map<string,{recipe:ManagedRecipe;used:Set<string>}>();
  private readonly managedRecoveryPermits=new Map<string,{intentId:string;epoch:number;stateDigest:string}>();
  private readonly managedReplayLaunches=new Map<string,number>();
  private readonly specialistPreparedLaunches=new Map<string,number>();
  private readonly children = new Set<ChildProcess>();
  private readonly recovering = new Set<string>();
  private readonly recoveryAt = new Map<string,number>();
  private readonly semaphore:WorkspaceSemaphore;
  private budgetRefresh:Promise<void>|undefined;
  private budgetRefreshAt=0;
  private running = true;
  private executionEnabled = true;
  private readonly diskGuard:DiskGuard|undefined;
  private readonly nativePlanning:readonly NativePlanningSupervisor[];
  private readonly nativeExecutions:readonly NativeExecutionSupervisor[];
  readonly nativeImplementation:NativeImplementation|undefined;
  private readonly nativeBootstrapAttachment:NativeBootstrapAttachment|undefined;
  private lock: import('pg').PoolClient | undefined;
  constructor(readonly ledger: Ledger, readonly repo: string, readonly projectId: string, private readonly engineeringOptions?:EngineeringOptions,
    private readonly isolated?:IsolatedImplementation,private readonly remote?:RemoteOperations,
    admissionOptions?:{diskGuard?:DiskGuard;nativePlanning?:NativePlanningSupervisor|readonly NativePlanningSupervisor[];nativeExecutions?:readonly NativeExecutionSupervisor[];nativeImplementation?:NativeImplementation;nativeBootstrap?:NativeBootstrapAttachment}) {
    this.nativeImplementation=admissionOptions?.nativeImplementation;
    if(this.nativeImplementation&&(this.nativeImplementation.ledger!==ledger||this.nativeImplementation.repository!==repo||this.nativeImplementation.quality!==engineeringOptions?.quality))throw new Refusal('NATIVE_IMPLEMENTATION_CONFIGURATION_INVALID');
    this.nativeExecutions=Object.freeze([...(admissionOptions?.nativeExecutions??[])]);
    if(this.nativeExecutions.length>32||this.nativeExecutions.some(s=>s.ledger!==ledger)||new Set(this.nativeExecutions.map(s=>s.executorDigest+'@'+s.keyFingerprint)).size!==this.nativeExecutions.length)throw new Refusal('NATIVE_EXECUTION_REGISTRY_INVALID');
    const native=admissionOptions?.nativePlanning;this.nativePlanning=Object.freeze(native?(Array.isArray(native)?[...native]:[native as NativePlanningSupervisor]):[]);
    if(this.nativePlanning.some(supervisor=>supervisor.ledger!==ledger))throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
    if(this.nativePlanning.length>32||new Set(this.nativePlanning.map(supervisor=>supervisor.executor.id+'@'+supervisor.executor.digest)).size!==this.nativePlanning.length)throw new Refusal('PLANNING_EXECUTOR_REGISTRY_INVALID');
    this.nativeBootstrapAttachment=admissionOptions?.nativeBootstrap;
    if(this.nativeBootstrapAttachment){
      assertNativeBootstrapAttachment(projectId,this.nativeBootstrapAttachment,{implementation:Boolean(this.nativeImplementation),executions:this.nativeExecutions.length,planning:this.nativePlanning.length});
      this.executionEnabled=false;
    }
    this.diskGuard=admissionOptions?.diskGuard??diskGuardFromEnvironment();
    if(isolated&&isolated.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
    isolated?.bindManagedRepository(repo);
    if(remote&&remote.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
    this.capacity = new Capacity(ledger);
    this.semaphore=new WorkspaceSemaphore({initial:{maxParallel:1,memoryLimitMb:null,autoResumeOnUsageLimit:false},load:async()=>{
      const config=(await ledger.pool.query('SELECT programming_limit,evaluation_limit FROM ac_capacity_config WHERE id=1')).rows[0];
      if(!config)throw new Refusal('CAPACITY_NOT_CONFIGURED');
      // Native flow slots must not silently impose the standalone default of
      // two. Physical workers still require transactional per-role PG grants.
      return {maxParallel:config.programming_limit+config.evaluation_limit,memoryLimitMb:null,autoResumeOnUsageLimit:false};
    }});
    this.engineering=engineeringOptions?new EngineeringStages(ledger,projectId,{...engineeringOptions,
      onAdmissionWait:(runId,key,reason)=>{this.manager.setManagedAdmissionWait(runId,key,reason);},
      ...(isolated?{isolatedVerification:new IsolatedVerification(ledger,isolated.client),isolatedAdvice:new IsolatedAdvice(ledger,isolated.client)}:{})}):undefined;
    if(isolated&&this.engineering)isolated.bindSpecialistGuard(async(c,intent,authority,writer)=>{await this.engineering!.assertSpecialistApproved(c,intent.id,authority,writer);});
    this.store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    requireManagedRunnerBoundary();
    this.manager = new RunManager(this.store, repo, { semaphore:this.semaphore,managed: {
      authorizeStart: (workflow, input, graphOwned) => {
        if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
        if(input.dispatch){
          if(!graphOwned||input.dispatch.rootRunId!==input.dispatch.parentRunId)throw new Refusal('UNAPPROVED_PLAN');
          const parentId=input.dispatch.parentRunId,entry=this.managedPlans.get(parentId),parent=this.store.getRun(parentId);
          if(!entry||!parent)throw new Refusal('UNAPPROVED_PLAN');
          const unit=entry.recipe.units.find(u=>input.task===childTaskEnvelope({objective:`AC_MANAGED_UNIT:${u.id}`},
            {id:parentId,branch:parent.branch},['{{TREE_PATHS}}']));
          if(!unit||entry.used.has(unit.id))throw new Refusal('UNAPPROVED_PLAN');
          const launch=Object.entries(entry.recipe.launches).find(([,ids])=>ids.includes(unit.id));
          if(!launch||parent.graphState?.cursor!==launch[0])throw new Refusal('UNAPPROVED_PLAN');
          const isFork=launch[1].length>1;
          const expected={name:isFork?'(fork branch)':'(planned)',source:'built-in',steps:[{id:'task',name:unit.id,prompt:'{{task}}'}]};
          if(digest(workflow)!==digest(expected))throw new Refusal('UNAPPROVED_PLAN');
          entry.used.add(unit.id);const authority=this.authorities.get(parentId);
          if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
          this.authorities.set(unit.runId,authority);return unit.runId;
        }
        const current = this.invocation.getStore();
        const expected=current?.intent.command.payload.workflow==='managed-synthetic-v1'
          ?this.managedPlans.get(current.intent.run_id)?.recipe.workflow:current?workflowFor(current.intent.command.payload.workflow):undefined;
        if (!current || !expected || digest(workflow) !== digest(expected) || input.task !== `Intent ${current.intent.id}`)
          throw new Refusal('UNAPPROVED_PLAN');
        return current.intent.run_id;
      },
      runnerFactory: () => this.runner(),
      beforeNode: (runId,nodeId,cancelled)=>this.awaitNodeAdmission(runId,nodeId,cancelled),
      // Active-agent recovery must reconcile physical handles first (I5); never blindly respawn.
      authorizeRecovery: async run => {
        const current=this.invocation.getStore();
        if(!current||!run.workflowDef||run.id!==current.intent.run_id)return false;
        const permit=this.managedRecoveryPermits.get(run.id);
        if(permit){
          if(permit.intentId!==current.intent.id||permit.epoch!==current.authority.epoch||
             permit.stateDigest!==recoveryStateDigest(run))return false;
          return this.ledger.tx(async c=>{
            await this.ledger.fence(c,current.authority);await this.ledger.assertIntentActive(c,current.authority.contextId,current.intent.id);
            const row=(await c.query('SELECT principal_id,context_id,run_id,operation_id,command FROM ac_intents WHERE id=$1',[current.intent.id])).rows[0];
            if(!row||row.context_id!==current.authority.contextId||row.run_id!==run.id||row.operation_id!==current.intent.operation_id||
              digest(row.command)!==digest(current.intent.command))return false;
            await this.ledger.authorize(c,row.principal_id,current.authority.contextId);return true;
          });
        }
        const cursor=run.graphState?.cursor;
        if(cursor==='implement'){if(current.intent.command.payload.workflow==='engineering-native-v1'){if(!this.nativeImplementation||!await this.nativeImplementation.prepareRecovery(current.intent,current.authority))return false;return true;}if(!this.isolated)return false;}
        else{
          const session=run.steps.find(step=>step.id===cursor)?.sessionId;
          if(!this.engineering||!cursor||!session)return false;
          if(!await this.engineering.canReplayCompleted(current.intent,current.authority,cursor,session)&&
             !await this.engineering.prepareUnstartedNode(current.intent,current.authority,cursor,session))return false;
        }
        return this.ledger.tx(async c=>{
          await this.ledger.fence(c,current.authority);
          await this.ledger.assertIntentActive(c,current.authority.contextId,current.intent.id);
          const bound=(await c.query(`SELECT i.principal_id,i.command,i.plan_revision,o.state,g.state grant_state,j.state job_state,f.digest
            FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
            JOIN ac_capacity_grants g ON g.id=o.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=o.id
            JOIN ac_frozen_plans f ON f.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id
            WHERE i.id=$1 AND i.run_id=$2 AND i.context_id=$3 AND x.project_id=$4 AND o.id=$5`,
            [current.intent.id,run.id,current.authority.contextId,this.projectId,current.intent.operation_id])).rows[0];
          if(!bound)return false;
          await this.ledger.authorize(c,bound.principal_id,current.authority.contextId);
          return bound.state==='completed'&&bound.grant_state==='released'&&(cursor!=='implement'||bound.job_state==='completed')&&
            bound.plan_revision===current.intent.plan_revision&&digest(bound.command)===digest(current.intent.command)&&
            bound.digest===digest(workflowFor(current.intent.command.payload.workflow))&&
            digest(run.workflowDef)===bound.digest;
        });
      },
    } });
    this.native = createApp({ repoRoot: repo, store: this.store, manager: this.manager,
      bootProjectId: projectId, semaphore:this.semaphore,version: 'agent-control-0.1.0' });
  }
  async start(mode:'execution'|'administration-only'='execution') {
    if(this.nativeBootstrapAttachment&&mode==='execution')throw new Refusal('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
    this.executionEnabled=mode==='execution';
    if(this.executionEnabled)await this.refreshSchedulerBudget();
    const c = await this.ledger.pool.connect();
    const r = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,1)) AS ok', [this.repo]);
    if (!r.rows[0].ok) { c.release(); throw new Refusal('RUNTIME_ALREADY_ACTIVE'); }
    this.lock = c;
    const lost = () => {
      this.running = false; for (const child of this.children) terminate(child,'SIGKILL');
      this.engineering?.close();
      this.isolated?.close();
    this.nativeImplementation?.close();
      if (this.lock === c) { this.lock = undefined; c.release(true); }
    };
    c.on('error', lost); c.on('end', lost);
    if(this.executionEnabled){
      if(this.nativeBootstrapAttachment)throw new Refusal('NATIVE_BOOTSTRAP_REPLAY_FORBIDDEN');
      await this.manager.recover();
    }
  }
  get nativeBootstrapReport(){return this.nativeBootstrapAttachment?.report;}
  /** Authorized bench source only. A missing or closed registry, takeover, or mismatched context, epoch or instance never reaches the resolver. */
  async readAuthorizedBootstrapSource(authority:Authority){
    Authority.parse(authority);
    if(!this.nativeBootstrapAttachment?.readSource)throw new Refusal('NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED',403);
    return this.nativeBootstrapAttachment.readSource(authority);
  }
  get nativeExecutionReady(){return this.executionEnabled&&Boolean(this.nativeImplementation&&this.engineering?.options.nativeQa&&this.engineering?.options.nativeVerification);}
  get executionMode():'administration-only'|'execution'{return this.executionEnabled?'execution':'administration-only';}
  private managedExecutionReady():boolean{return this.executionEnabled&&Boolean(this.isolated)&&Boolean(this.engineering);}
  async readManagedSourceArtifacts(intent:Intent,authority:Authority):Promise<readonly {unitId:string;artifactId:string;cwd:string}[]>{
    const bound=await readManagedUnit(this.ledger,intent),input=await readManagedInput(this.ledger,intent.id);
    if(!bound||bound.unit.kind!=='composition'||intent.context_id!==authority.contextId)throw new Refusal('MANAGED_UNIT_MISMATCH');
    const identities=await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      const parent=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[bound.parentIntentId,authority.contextId])).rows[0];
      if(!parent)throw new Refusal('MANAGED_UNIT_MISMATCH');await this.ledger.authorize(c,parent.principal_id,authority.contextId);
      const rows: {unitId:string;artifactId:string;runId:string}[]=[];
      for(const id of input.sources){
        const unit=bound.recipe.units.find(u=>u.id===id);
        if(!unit||unit.kind!=='task')throw new Refusal('MANAGED_SOURCE_MISMATCH');
        const result=(await c.query(`SELECT a.id FROM ac_artifacts a JOIN ac_operations o ON o.intent_id=a.intent_id
          JOIN ac_intents i ON i.id=a.intent_id WHERE i.id=$1 AND i.parent_intent_id=$2 AND i.parent_unit_id=$3
          AND i.context_id=$4 AND o.state='completed' AND o.receipt->>'commit'=a.commit_id
          AND o.receipt->>'tree'=a.tree_id AND o.receipt->>'base'=a.base_id`,
          [unit.intentId,bound.parentIntentId,id,authority.contextId])).rows;
        if(result.length!==1)throw new Refusal('MANAGED_SOURCE_MISMATCH');
        rows.push({unitId:id,artifactId:result[0].id,runId:unit.runId});
      }
      return rows;
    });
    const root=await realpath(join(this.repo,'.ai/cezar/managed'));
    const result=[];
    for(const source of identities){
      const expected=join(root,bound.parentIntentId,source.runId),cwd=await realpath(expected);
      if(cwd!==expected||!cwd.startsWith(root+sep))throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
      result.push({unitId:source.unitId,artifactId:source.artifactId,cwd});
    }
    return result;
  }
  async dispatch(intent: Intent, authority: Authority) {
    if(!this.executionEnabled)throw new Refusal('ADMINISTRATION_ONLY');
    if(intent.command.payload.workflow==='engineering-native-v1'&&(!this.nativeImplementation||!this.engineering?.options.nativeQa||!this.engineering?.options.nativeVerification||!this.nativeImplementation.hasSource(authority)))throw new Refusal('NATIVE_EXECUTION_NOT_CONFIGURED');
    if(intent.command.payload.workflow==='semantic-proposal-v1')throw new Refusal('PLANNING_INTENT_NOT_EXECUTION');
    if (!this.running || !this.lock) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
    const delivery=(await this.ledger.pool.query('SELECT parent_intent_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0];
    if(!delivery)throw new Refusal('INTENT_MISSING');
    if(delivery.parent_intent_id)throw new Refusal('SUBDELIVERY_DISPATCH_FORBIDDEN',403);
    await this.refreshSchedulerBudget();
    const recipe=intent.command.payload.workflow==='managed-synthetic-v1'?await readManagedRecipe(this.ledger,intent.id):undefined;
    if(recipe?.schemaVersion===3&&!syntheticSpecialistAdviceAuthorized(this.ledger))throw new Refusal('MANAGED_SPECIALIST_EXECUTOR_UNAVAILABLE');
    if(recipe&&recipe.mode!=='native'&&recipe.units.some(unit=>(unit.correctionRevision??0)>0)&&!syntheticManagedCorrectionsAuthorized(this.ledger))throw new Refusal('MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE');
    // A native plan uses the programmer, QA and review adapters. It does not require the synthetic sandbox.
    if(recipe?.mode==='native'){if(!this.nativeExecutionReady)throw new Refusal('NATIVE_EXECUTION_NOT_CONFIGURED');}
    else if(recipe&&!this.managedExecutionReady())throw new Refusal('MANAGED_RUNTIME_NOT_READY');
    const workflow=recipe?.workflow??workflowFor(intent.command.payload.workflow);
    if(['engineering-synthetic-v1','engineering-native-v1'].includes(workflow.name)&&!this.engineering)throw new Refusal('ENGINEERING_NOT_CONFIGURED');
    const identity = (await this.ledger.pool.query(`SELECT i.*,o.execution_attempt_id,o.state operation_state,x.project_id
      FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[intent.id])).rows[0];
    if (!identity || identity.operation_id!==intent.operation_id || identity.context_id!==intent.context_id || identity.run_id!==intent.run_id || identity.plan_revision!==intent.plan_revision || digest(identity.command)!==digest(intent.command))
      throw new Refusal('INTENT_IDENTITY_MISMATCH',403);
    if (identity.project_id!==this.projectId) throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
    const grant = !recipe&&identity.operation_state === 'registered' ? await this.capacity.reserve(identity.principal_id,
      {attemptId:identity.execution_attempt_id,intentId:intent.id,contextId:intent.context_id,role:'programmer'},authority) : null;
    await this.ledger.tx(async c => {
      await this.ledger.fence(c, authority);
      await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
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
      if(workflow.name==='engineering-synthetic-v1'||workflow.name==='engineering-native-v1'){
        const chosen=(await c.query('SELECT snapshot,digest FROM ac_intent_templates WHERE intent_id=$1',[intent.id])).rows[0];
        if(!chosen)throw new Refusal('TEMPLATE_REQUIRED');
        const template=Template.parse(chosen.snapshot);
        if(digest(template)!==chosen.digest||template.workflow!==workflow.name)throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
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
      if(recipe)this.managedPlans.set(intent.run_id,{recipe,used:new Set()});
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
    let waitingReason:string|undefined;
    for(;;){
      if(!this.running||!this.lock||cancelled())return;
      const authority=this.authorities.get(runId);
      if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
      try{
        const intent=await this.ledger.tx(async c=>{
          await this.ledger.fence(c,authority);
          const intent=(await c.query<Intent>('SELECT * FROM ac_intents WHERE run_id=$1 AND context_id=$2',[runId,authority.contextId])).rows[0];
          if(!intent)throw new Refusal('INTENT_MISSING');
          await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
          return intent;
        });
        if(this.diskGuard&&!await this.canReplayWithoutDiskAdmission(intent,authority,nodeId))await this.diskGuard.assertAdmission();
        const entry=this.managedPlans.get(runId);
        if(entry?.recipe.launches[nodeId]){
          const requires=entry.recipe.schemaVersion===3&&entry.recipe.launches[nodeId]!.some(id=>entry.recipe.units.find(unit=>unit.id===id)?.requiresSpecialist);
          if(requires){
            if(!this.engineering)throw new Refusal('PREIMPLEMENTATION_ADVICE_REQUIRED');
            if(this.specialistPreparedLaunches.get(`${runId}:${nodeId}`)!==authority.epoch)
              await this.verifyPreparedSpecialistBatch(intent,authority,entry.recipe,nodeId);
            await this.ledger.tx(async c=>{
              await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
              for(const id of entry.recipe.launches[nodeId]!){const unit=entry.recipe.units.find(item=>item.id===id)!;
                if(unit.requiresSpecialist)await this.engineering!.assertSpecialistApproved(c,unit.intentId,authority);}
            });
            this.specialistPreparedLaunches.delete(`${runId}:${nodeId}`);
          }else await this.freezeManagedBatch(intent,authority,entry.recipe,nodeId);
        }
        if(waitingReason)this.manager.setManagedAdmissionWait(runId,'context-admission',null);
        return;
      }catch(error){
        if(error instanceof Refusal&&error.code==='PLAN_CANCELLATION_REQUESTED'){this.manager.cancel(runId);return;}
        if(!(error instanceof Refusal)||!['HUMAN_PAUSED','ADMISSION_CLOSED','STORAGE_LOW_SPACE','DISK_OBSERVATION_UNAVAILABLE'].includes(error.code))throw error;
        if(waitingReason!==error.code){
          this.manager.setManagedAdmissionWait(runId,'context-admission',`${error.code} before ${nodeId}`);waitingReason=error.code;
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
  }
  /** Recover only a fully frozen, untouched batch. No directory is recreated and
   * no writer is adopted from a launch or an uncertain process. */
  private async verifyPreparedSpecialistBatch(parent:Intent,authority:Authority,recipe:ManagedRecipe,nodeId:string){
    if(!this.engineering||recipe.schemaVersion!==3)throw new Refusal('PREIMPLEMENTATION_ADVICE_REQUIRED');
    const ids=recipe.launches[nodeId];if(!ids?.length)throw new Refusal('MANAGED_UNIT_MISMATCH');
    const units=ids.map(id=>recipe.units.find(unit=>unit.id===id));
    if(units.some(unit=>!unit||unit.kind!=='task'))throw new Refusal('MANAGED_UNIT_MISMATCH');
    const inputs=await Promise.all(units.map(unit=>readManagedInput(this.ledger,unit!.intentId)));
    if(inputs.some(input=>input.base!==inputs[0]!.base))throw new Refusal('MANAGED_BASE_CHANGED');
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);
      for(const unit of units){
        const row=(await c.query(`SELECT o.state,o.grant_id,o.handle,o.receipt,o.native_session_id,
          EXISTS(SELECT 1 FROM ac_execution_launches l WHERE l.operation_id=o.id) launched,
          EXISTS(SELECT 1 FROM ac_capacity_grants g WHERE g.intent_id=i.id AND g.role='programmer') granted
          FROM ac_intents i JOIN ac_operations o ON o.id=i.operation_id WHERE i.id=$1 AND i.parent_intent_id=$2 AND i.context_id=$3 FOR UPDATE OF o`,
          [unit!.intentId,parent.id,authority.contextId])).rows[0];
        if(!row||row.state!=='registered'||row.grant_id||row.handle||row.receipt||row.native_session_id||row.launched||row.granted)
          throw new Refusal('MANAGED_BATCH_RECONCILIATION_REQUIRED');
        if(unit!.requiresSpecialist)await this.engineering!.assertSpecialistApproved(c,unit!.intentId,authority);
      }
    });
    const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'};
    for(const [index,unit] of units.entries()){
      const cwd=await this.engineeringOptions!.git.managedPath(parent.id,unit!.runId),input=inputs[index]!;
      const head=await execFileAsync('/usr/bin/git',['-C',cwd,'rev-parse','--verify','HEAD^{commit}'],{env,timeout:10000});
      const status=await execFileAsync('/usr/bin/git',['-C',cwd,'status','--porcelain=v1','--untracked-files=all'],{env,timeout:10000});
      if(head.stdout.trim()!==input.base||status.stdout)throw new Refusal('MANAGED_SOURCE_MISMATCH');
      if(input.correction){const ref=await execFileAsync('/usr/bin/git',['-C',cwd,'rev-parse','--verify','refs/agent-control/correction-source^{commit}'],{env,timeout:10000});
        if(ref.stdout.trim()!==input.correction.priorCommit)throw new Refusal('MANAGED_SOURCE_MISMATCH');}
    }
  }
  private async freezeManagedBatch(parent:Intent,authority:Authority,recipe:ManagedRecipe,nodeId:string){
    if(recipe.schemaVersion>=2)return this.freezeCorrectionBatch(parent,authority,recipe,nodeId);
    const ids=recipe.launches[nodeId];if(!ids?.length)throw new Refusal('MANAGED_UNIT_MISMATCH');
    const units=ids.map(id=>recipe.units.find(u=>u.id===id));
    if(units.some(u=>!u))throw new Refusal('MANAGED_UNIT_MISMATCH');
    const members=units.map(u=>u!);
    const composition=recipe.units.find(u=>u.kind==='composition'&&digest(u.sources)===digest(ids));
    const all=composition?[...members,composition]:members;
    const existing=(await this.ledger.pool.query('SELECT intent_id FROM ac_managed_delivery_inputs WHERE intent_id=ANY($1::uuid[])',[all.map(u=>u.intentId)])).rows;
    if(this.managedReplayLaunches.get(`${parent.run_id}:${nodeId}`)===authority.epoch){
      if(existing.length!==all.length)throw new Refusal('MANAGED_BATCH_PARTIAL');
      const inputs=await Promise.all(all.map(u=>readManagedInput(this.ledger,u.intentId)));
      if(inputs.some(input=>input.base!==inputs[0]!.base))throw new Refusal('MANAGED_BASE_CHANGED');
      // Only an already reconciled batch may revisit the launch node. In
      // particular an existing directory is never proof of an unstarted writer.
      for(const unit of members){
        const operation=(await this.ledger.pool.query('SELECT state FROM ac_operations WHERE id=$1 AND intent_id=$2',[unit.operationId,unit.intentId])).rows[0];
        if(operation?.state!=='completed')throw new Refusal('MANAGED_BATCH_RECONCILIATION_REQUIRED');
      }
      this.managedReplayLaunches.delete(`${parent.run_id}:${nodeId}`);
      return;
    }
    const target=recipe.targetRef,allowed=this.engineeringOptions?.allowedTargets??(this.engineeringOptions?.targetRef?[this.engineeringOptions.targetRef]:[]);
    if(!allowed.includes(target))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
    const result=await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',this.repo,'rev-parse','--verify',`${target}^{commit}`],
      {env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000});
    const base=result.stdout.trim();if(!/^[a-f0-9]{40}$/.test(base))throw new Refusal('MANAGED_BASE_INVALID');
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);
      const current=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[parent.id,authority.contextId])).rows[0];
      if(!current)throw new Refusal('INTENT_SCOPE_MISMATCH',403);await this.ledger.authorize(c,current.principal_id,authority.contextId);
      for(const unit of all){
        const input=ManagedExecutionInput.parse({parentIntentId:parent.id,unitId:unit.id,kind:unit.kind,base,
          writePaths:unit.writePaths,acceptanceRefs:unit.acceptanceRefs,sources:unit.sources});
        await c.query('INSERT INTO ac_managed_delivery_inputs(intent_id,base_id,snapshot,digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [unit.intentId,base,input,digest(input)]);
        const saved=(await c.query('SELECT digest FROM ac_managed_delivery_inputs WHERE intent_id=$1',[unit.intentId])).rows[0];
        if(saved?.digest!==digest(input))throw new Refusal('MANAGED_BASE_CHANGED');
      }
      if(recipe.mode==='native'){
        const projectId=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[authority.contextId])).rows[0]?.project_id;
        if(!projectId)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
        for(const unit of members){
          if(unit.kind!=='task')continue;
          const child=(await c.query('SELECT command FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
          const command=Command.parse(child?.command);
          const payload=command.payload;
          if(payload.workflow!=='engineering-native-v1'||payload.targetRef!==unit.targetRef||payload.qualityRevision!==unit.qualityRevision||digest(payload.writePaths)!==digest(unit.writePaths))throw new Refusal('NATIVE_TASK_INPUT_MISMATCH');
          await refuseCurrentProtectedGate(c,projectId,payload.writePaths);
          const frozen={schemaVersion:1,intentId:unit.intentId,contextId:authority.contextId,base,writePaths:payload.writePaths,qualityRevision:payload.qualityRevision,targetRef:payload.targetRef,messageRef:payload.messageRef,messageDigest:payload.messageDigest};
          await c.query('INSERT INTO ac_native_task_inputs VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[unit.intentId,base,frozen,digest(frozen)]);
          const row=(await c.query('SELECT base_id,snapshot,digest FROM ac_native_task_inputs WHERE intent_id=$1',[unit.intentId])).rows[0];
          if(!row||row.base_id!==base||row.digest!==digest(frozen)||digest(row.snapshot)!==row.digest)throw new Refusal('NATIVE_TASK_INPUT_MISMATCH');
        }
      }
    });
    const managedRoot=join(this.repo,'.ai/cezar/managed');await mkdir(managedRoot,{recursive:true,mode:0o700});
    const root=await realpath(managedRoot),repoRoot=await realpath(this.repo);
    if(root!==join(repoRoot,'.ai/cezar/managed'))throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
    const parentDir=join(root,parent.id);await mkdir(parentDir,{recursive:true,mode:0o700});
    if(await realpath(parentDir)!==parentDir)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
    for(const unit of members){
      if(unit.kind!=='task')continue;
      const cwd=join(parentDir,unit.runId);await mkdir(cwd,{mode:0o700});
      const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
      await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','clone','--no-local','--no-hardlinks','--',repoRoot,cwd],{env,timeout:30000});
      await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'checkout','--detach',base],{env,timeout:10000});
      if(await realpath(cwd)!==cwd)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
      await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);});
    }
  }
  private async freezeCorrectionBatch(parent:Intent,authority:Authority,recipe:ManagedRecipe,nodeId:string){
    const ids=recipe.launches[nodeId];if(!ids?.length)throw new Refusal('MANAGED_UNIT_MISMATCH');
    const members=ids.map(id=>{const unit=recipe.units.find(item=>item.id===id);if(!unit)throw new Refusal('MANAGED_UNIT_MISMATCH');return unit;});
    const existing=(await this.ledger.pool.query('SELECT intent_id FROM ac_managed_delivery_inputs WHERE intent_id=ANY($1::uuid[])',[members.map(unit=>unit.intentId)])).rows;
    if(this.managedReplayLaunches.get(`${parent.run_id}:${nodeId}`)===authority.epoch){
      if(existing.length!==members.length)throw new Refusal('MANAGED_BATCH_PARTIAL');
      const inputs=await Promise.all(members.map(unit=>readManagedInput(this.ledger,unit.intentId)));
      if(inputs.some(input=>input.base!==inputs[0]!.base))throw new Refusal('MANAGED_BASE_CHANGED');
      for(const unit of members){const row=(await this.ledger.pool.query('SELECT state FROM ac_operations WHERE id=$1 AND intent_id=$2',
        [unit.operationId,unit.intentId])).rows[0];if(row?.state!=='completed')throw new Refusal('MANAGED_BATCH_RECONCILIATION_REQUIRED');}
      this.managedReplayLaunches.delete(`${parent.run_id}:${nodeId}`);return;
    }
    if(existing.length)throw new Refusal('MANAGED_BATCH_RECONCILIATION_REQUIRED');
    const target=recipe.targetRef,allowed=this.engineeringOptions?.allowedTargets??(this.engineeringOptions?.targetRef?[this.engineeringOptions.targetRef]:[]);
    if(!allowed.includes(target))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
    let base:string,correction:ManagedExecutionInput['correction']|undefined,sources:string[]=[];
    if(members.length===1&&members[0]!.kind==='composition'){
      const composition=members[0]!,selected=[];
      for(const logicalId of composition.sources){
        const logical=recipe.units.find(unit=>unit.id===logicalId);
        if(!logical?.taskId)throw new Refusal('MANAGED_SELECTION_MISMATCH');
        const row=(await this.ledger.pool.query('SELECT selected_intent_id FROM ac_managed_task_selections WHERE parent_intent_id=$1 AND task_id=$2',
          [parent.id,logical.taskId])).rows[0];
        const unit=recipe.units.find(item=>item.intentId===row?.selected_intent_id&&item.taskId===logical.taskId);
        if(!unit)throw new Refusal('MANAGED_SELECTION_MISMATCH');selected.push(unit);
      }
      const inputs=await Promise.all(selected.map(unit=>readManagedInput(this.ledger,unit.intentId)));
      if(!inputs.length||inputs.some(input=>input.base!==inputs[0]!.base))throw new Refusal('MANAGED_BASE_CHANGED');
      base=inputs[0]!.base;sources=selected.map(unit=>unit.id);
    }else if(members.length===1&&(members[0]!.correctionRevision??0)>0){
      const unit=members[0]!,row=(await this.ledger.pool.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1 AND task_id=$2 AND revision=$3',
        [parent.id,unit.taskId,unit.correctionRevision])).rows[0];
      if(!row||row.next_intent_id!==unit.intentId||row.context_id!==authority.contextId)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      base=row.base_id;correction={taskId:row.task_id,revision:row.revision,priorIntentId:row.prior_intent_id,priorArtifactId:row.prior_artifact_id,
        failedEvidenceIds:row.failed_evidence_ids,priorCommit:row.prior_commit,priorTree:row.prior_tree,decisionDigest:row.decision_digest};
    }else{
      const result=await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',this.repo,'rev-parse','--verify',`${target}^{commit}`],
        {env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000});
      base=result.stdout.trim();
    }
    if(!/^[a-f0-9]{40}$/.test(base))throw new Refusal('MANAGED_BASE_INVALID');
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);
      const owner=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[parent.id,authority.contextId])).rows[0];
      if(!owner)throw new Refusal('INTENT_SCOPE_MISMATCH',403);await this.ledger.authorize(c,owner.principal_id,authority.contextId);
      for(const unit of members){
        const input=ManagedExecutionInput.parse({parentIntentId:parent.id,unitId:unit.id,kind:unit.kind,base,writePaths:unit.writePaths,
          acceptanceRefs:unit.acceptanceRefs,sources:unit.kind==='composition'?sources:unit.sources,...(correction?{correction}:{})});
        await c.query('INSERT INTO ac_managed_delivery_inputs(intent_id,base_id,snapshot,digest) VALUES($1,$2,$3,$4)',[unit.intentId,base,input,digest(input)]);
      }
      if(recipe.mode==='native'){
        const projectId=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[authority.contextId])).rows[0]?.project_id;
        if(!projectId)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
        for(const unit of members){
          if(unit.kind!=='task')continue;
          const child=(await c.query('SELECT command FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
          const command=Command.parse(child?.command),payload=command.payload;
          if(payload.workflow!=='engineering-native-v1'||payload.targetRef!==unit.targetRef||payload.qualityRevision!==unit.qualityRevision||digest(payload.writePaths)!==digest(unit.writePaths))throw new Refusal('NATIVE_TASK_INPUT_MISMATCH');
          await refuseCurrentProtectedGate(c,projectId,payload.writePaths);
          const frozen={schemaVersion:1,intentId:unit.intentId,contextId:authority.contextId,base,writePaths:payload.writePaths,qualityRevision:payload.qualityRevision,targetRef:payload.targetRef,messageRef:payload.messageRef,messageDigest:payload.messageDigest};
          await c.query('INSERT INTO ac_native_task_inputs VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[unit.intentId,base,frozen,digest(frozen)]);
          const saved=(await c.query('SELECT base_id,snapshot,digest FROM ac_native_task_inputs WHERE intent_id=$1',[unit.intentId])).rows[0];
          if(!saved||saved.base_id!==base||saved.digest!==digest(frozen)||digest(saved.snapshot)!==saved.digest)throw new Refusal('NATIVE_TASK_INPUT_MISMATCH');
        }
      }
    });
    for(const unit of members)await readManagedInput(this.ledger,unit.intentId);
    const repoRoot=await realpath(this.repo),managedRoot=join(repoRoot,'.ai/cezar/managed');await mkdir(managedRoot,{recursive:true,mode:0o700});
    if(await realpath(managedRoot)!==managedRoot)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
    const parentDir=join(managedRoot,parent.id);await mkdir(parentDir,{recursive:true,mode:0o700});
    if(await realpath(parentDir)!==parentDir)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
    for(const unit of members){
      if(unit.kind!=='task')continue;
      const cwd=join(parentDir,unit.runId);await mkdir(cwd,{mode:0o700});
      const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
      await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','clone','--no-local','--no-hardlinks','--',repoRoot,cwd],{env,timeout:30000});
      await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'checkout','--detach',base],{env,timeout:10000});
      if(correction){
        await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'fetch','--no-tags',repoRoot,correction.priorCommit],{env,timeout:10000});
        await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'update-ref','refs/agent-control/correction-source',correction.priorCommit],{env,timeout:10000});
      }
      if(await realpath(cwd)!==cwd)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN',403);
      await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);});
    }
  }
  /** A disk gate admits new writes, never suppresses an authenticated completed
   * result replay. The actual runner still validates its durable receipt and
   * artifact identity; no uncertain effect is converted to completed here. */
  private async canReplayWithoutDiskAdmission(intent:Intent,authority:Authority,nodeId:string){
    if(nodeId==='implement'){
      const saved=await this.ledger.pool.query(`SELECT 1 FROM ac_operations o JOIN ac_capacity_grants g ON g.id=o.grant_id
        WHERE o.id=$1 AND o.intent_id=$2 AND o.state='completed' AND g.state='released'`,[intent.operation_id,intent.id]);
      return Boolean(saved.rowCount);
    }
    const sessionId=this.store.getRun(intent.run_id)?.steps.find(step=>step.id===nodeId)?.sessionId;
    return Boolean(sessionId&&this.engineering&&await this.engineering.canReplayCompleted(intent,authority,nodeId,sessionId));
  }
  private async refreshSchedulerBudget(){
    if(this.budgetRefresh)return this.budgetRefresh;
    if(Date.now()-this.budgetRefreshAt<1000)return;
    this.budgetRefresh=this.semaphore.refresh();
    try{await this.budgetRefresh;this.budgetRefreshAt=Date.now();}finally{this.budgetRefresh=undefined;}
  }
  async reconcileCancellations(authority:Authority,principal?:string){
    if(!this.running||!this.lock)throw new Refusal('RUNTIME_NOT_AUTHORIZED');
    const service=new Cancellations(this.ledger);
    await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    if(this.engineering){
      const canceled=(await this.ledger.pool.query<Intent>(`SELECT i.* FROM ac_intents i JOIN ac_plan_cancellations k ON k.intent_id=i.id
        WHERE i.context_id=$1 AND k.state='requested'`,[authority.contextId])).rows;
      for(const intent of canceled)await this.engineering.reconcileIntegrationResult(intent,authority);
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    }
    if(this.isolated){
      await service.reconcileSandbox(authority,this.isolated.client);
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    }
    if(this.engineering?.options.nativeQa){
      if(!principal)throw new Refusal('NATIVE_QA_PRINCIPAL_REQUIRED');
      await this.engineering.options.nativeQa.reconcileContext(principal,authority);
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    }
    if(this.nativePlanning.length){
      if(!principal)throw new Refusal('PLANNING_PRINCIPAL_REQUIRED');
      const calls=(await this.ledger.pool.query(`SELECT s.id FROM ac_semantic_planning_calls s
        JOIN ac_plan_cancellations x ON x.intent_id=s.intent_id AND x.context_id=s.context_id
        JOIN ac_native_planning_jobs j ON j.id=s.id WHERE s.context_id=$1 AND x.state='requested' AND s.state='uncertain'
        ORDER BY s.created_at,s.id LIMIT 100`,[authority.contextId])).rows;
      for(const call of calls)for(const supervisor of this.nativePlanning)await supervisor.reconcileCancellation(principal,authority,call.id);
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    }
    if(this.nativeExecutions.length){
      if(!principal)throw new Refusal('NATIVE_EXECUTION_PRINCIPAL_REQUIRED');
      const jobs=(await this.ledger.pool.query(`SELECT j.id,j.role,j.account_id,j.executor_digest,j.key_fingerprint,x.state cancellation_state FROM ac_native_execution_jobs j
        LEFT JOIN ac_plan_cancellations x ON x.intent_id=j.intent_id AND x.context_id=j.context_id
        WHERE j.context_id=$1 AND (j.state IN ('uncertain','running') OR x.state='requested' OR
         (j.state='completed' AND j.role='programmer' AND j.receipt->'payload'->'artifact'->>'commit' IS NOT NULL AND
          NOT EXISTS(SELECT 1 FROM ac_artifacts a WHERE a.intent_id=j.intent_id AND a.commit_id=j.receipt->'payload'->'artifact'->>'commit')) OR
         (j.state='completed' AND j.role IN ('reviewer','judge') AND EXISTS(SELECT 1 FROM ac_stage_operations s WHERE s.id=j.id AND s.state<>'completed')))
        ORDER BY j.created_at,j.id LIMIT 32`,[authority.contextId])).rows;
      for(const job of jobs){
        const supervisor=this.nativeExecutions.find(s=>s.supportsAccount(job.account_id)&&s.executorDigest===job.executor_digest&&s.keyFingerprint===job.key_fingerprint);
        if(!supervisor)throw new Refusal('NATIVE_EXECUTION_SUPERVISOR_UNAVAILABLE');
        await this.ledger.heartbeat(authority);
        if(job.cancellation_state==='requested')await supervisor.reconcileCancellation(principal,authority,job.id);
        else{
          const outcome=await supervisor.reconcileRegistered(principal,authority,job.id);
          if(outcome.state==='completed'&&job.role==='programmer'&&'artifact' in outcome&&outcome.artifact){
            if(!this.engineering)throw new Refusal('NATIVE_ARTIFACT_REGISTRY_UNAVAILABLE');
            await supervisor.registerArtifact(principal,authority,job.id,this.engineering.options.quality);
          }else if(outcome.state==='completed'&&['reviewer','judge'].includes(job.role)){
            const verifier=this.engineering?.options.nativeVerification;if(!verifier)throw new Refusal('NATIVE_VERIFICATION_EXECUTOR_REQUIRED');
            await verifier.record(principal,authority,job.id);
          }
        }
      }
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
    }
    if(this.remote){
      if(!principal)throw new Refusal('REMOTE_PRINCIPAL_REQUIRED');
      await this.remote.reconcileCancellationRequests(principal,authority);
      await service.reconcile(authority,runId=>{this.manager.cancel(runId);});
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
      const run=this.store.getRun(intent.run_id);
      if(intent.command.payload.workflow==='managed-synthetic-v1'&&run?.status==='done'){
        const recipe=await readManagedRecipe(this.ledger,intent.id);
        if(digest(run.workflowDef)!==digest(recipe.workflow))throw new Refusal('FROZEN_PLAN_MISMATCH');
        const children=(await c.query(`SELECT i.id,i.parent_unit_id,o.id operation_id,o.state,o.receipt,o.grant_id,o.handle,o.native_session_id FROM ac_intents i
          JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1 AND i.context_id=$2 ORDER BY i.parent_unit_id`,
          [intent.id,authority.contextId])).rows;
        if(children.length!==recipe.units.length||children.some(child=>{
          const unit=recipe.units.find(item=>item.id===child.parent_unit_id&&item.intentId===child.id&&item.operationId===child.operation_id);
          if(recipe.schemaVersion>=2&&child.state==='registered'&&!child.grant_id&&!child.handle&&!child.native_session_id&&!child.receipt)return !unit;
          const receipt=recipe.mode==='native'&&unit?.kind==='task'?NativeTaskReceipt.safeParse(child.receipt):SyntheticReceipt.safeParse(child.receipt);
          return !unit||child.state!=='completed'||!receipt.success||receipt.data.operationId!==child.operation_id;
        }))throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
        let selectedIds:Set<string>|undefined;
        if(recipe.schemaVersion>=2){
          if(!this.engineering)throw new Refusal('ENGINEERING_NOT_CONFIGURED');selectedIds=new Set();
          const unused=children.filter(child=>child.state==='registered').map(child=>child.id);
          if(unused.length&&(await c.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM ac_capacity_grants WHERE intent_id=ANY($1::uuid[])) OR
            EXISTS(SELECT 1 FROM ac_stage_operations WHERE intent_id=ANY($1::uuid[])) OR
            EXISTS(SELECT 1 FROM ac_sandbox_jobs j JOIN ac_operations o ON o.id=j.id WHERE o.intent_id=ANY($1::uuid[]))`,[unused])).rowCount)
            throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
          const tasks=recipe.units.filter(unit=>unit.kind==='task'&&unit.correctionRevision===0);
          for(const task of tasks){
            const selection=(await c.query('SELECT * FROM ac_managed_task_selections WHERE parent_intent_id=$1 AND task_id=$2',[intent.id,task.taskId])).rows[0];
            if(!selection||selection.context_id!==authority.contextId||selection.selection_digest!==digest({parentIntentId:intent.id,contextId:selection.context_id,
              taskId:selection.task_id,selectedIntentId:selection.selected_intent_id,artifactId:selection.artifact_id,managerEpoch:Number(selection.manager_epoch)}))
              throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
            const unit=recipe.units.find(item=>item.intentId===selection.selected_intent_id&&item.taskId===task.taskId);
            const artifact=await this.engineering.options.quality.assertReady(c,selection.artifact_id,authority);
            if(!unit||artifact.intent_id!==unit.intentId)throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');selectedIds.add(unit.id);
          }
          for(const child of children.filter(value=>value.state==='completed')){
            const unit=recipe.units.find(item=>item.id===child.parent_unit_id)!;
            if(unit.kind==='composition'||selectedIds.has(unit.id))continue;
            const decision=(await c.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1 AND prior_intent_id=$2',[intent.id,child.id])).rows[0];
            const next=recipe.units.find(item=>item.intentId===decision?.next_intent_id);
            if(!decision||decision.context_id!==authority.contextId||decision.task_id!==unit.taskId||
              decision.revision!==(unit.correctionRevision??0)+1||!next||next.taskId!==unit.taskId||next.correctionRevision!==decision.revision||
              Number(decision.manager_epoch)>authority.epoch||decision.decision_digest!==digest({parentIntentId:intent.id,contextId:decision.context_id,
               taskId:decision.task_id,revision:decision.revision,priorIntentId:decision.prior_intent_id,priorArtifactId:decision.prior_artifact_id,
               failedEvidenceIds:decision.failed_evidence_ids,priorCommit:decision.prior_commit,priorTree:decision.prior_tree,baseId:decision.base_id,
               nextIntentId:decision.next_intent_id,managerEpoch:Number(decision.manager_epoch)}))throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
            const rejected=await this.engineering.options.quality.assertCorrectionFailures(c,decision.prior_artifact_id,decision.failed_evidence_ids,authority);
            if(rejected.intent_id!==unit.intentId||rejected.commit_id!==decision.prior_commit||rejected.tree_id!==decision.prior_tree||rejected.base_id!==decision.base_id)
              throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
          }
        }
        for(const unitId of new Set(Object.values(recipe.bindings).filter(binding=>binding.phase==='integrate'&&
          (!selectedIds||selectedIds.has(binding.unitId)||recipe.units.find(unit=>unit.id===binding.unitId)?.kind==='composition')).map(binding=>binding.unitId))){
          const child=children.find(value=>value.parent_unit_id===unitId);if(!child)throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
          const integrated=(await c.query(`SELECT 1 FROM ac_artifacts a JOIN ac_integration_intents t ON t.artifact_id=a.id
            WHERE a.intent_id=$1 AND a.commit_id=$2 AND a.tree_id=$3 AND a.base_id=$4 AND t.target_ref=$5 AND t.state='integrated'`,
            [child.id,child.receipt.commit,child.receipt.tree,child.receipt.base,recipe.targetRef])).rowCount;
          if(!integrated)throw new Refusal('MANAGED_AGGREGATE_INCOMPLETE');
        }
        const receipt={kind:'managed-aggregate-v1',recipeDigest:digest(recipe),children:children.filter(child=>child.state==='completed').map(child=>({intentId:child.id,unitId:child.parent_unit_id,receiptDigest:digest(child.receipt)}))};
        const updated=await c.query("UPDATE ac_operations SET state='completed',receipt=$2,manager_epoch=$3 WHERE id=$1 AND state='registered' AND grant_id IS NULL RETURNING id",
          [intent.operation_id,receipt,authority.epoch]);
        if(!updated.rowCount){const existing=(await c.query('SELECT state,receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0];
          if(existing?.state!=='completed'||digest(existing.receipt)!==digest(receipt))throw new Refusal('MANAGED_AGGREGATE_MISMATCH');}
      }
      return run;
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
  private async resumeManagedRecord(intent:Intent,authority:Authority,system:boolean){
    const run=this.store.getRun(intent.run_id);
    if(!run?.workflowDef||!run.graphState?.cursor)return false;
    const permit={intentId:intent.id,epoch:authority.epoch,stateDigest:recoveryStateDigest(run)};
    this.managedRecoveryPermits.set(run.id,permit);
    try{return await this.invocation.run({intent,authority},()=>system?this.manager.resumeConfirmedGraphNode(run.id):this.manager.resumeConfirmedNode(run.id));}
    finally{this.managedRecoveryPermits.delete(run.id);}
  }
  private async adoptUnstartedManagedOperation(intent:Intent,authority:Authority){
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      const row=(await c.query(`SELECT i.principal_id,o.* FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
        WHERE i.id=$1 AND i.context_id=$2 AND i.parent_intent_id IS NOT NULL AND o.id=$3 FOR UPDATE OF o`,
        [intent.id,authority.contextId,intent.operation_id])).rows[0];
      if(!row)throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
      await this.ledger.authorize(c,row.principal_id,authority.contextId);
      if(Number(row.manager_epoch)===authority.epoch||row.state==='completed')return;
      if(Number(row.manager_epoch)>authority.epoch||row.state!=='registered'||row.grant_id||row.handle||row.receipt||row.native_session_id)
        throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
      const advice=(await c.query("SELECT grant_id FROM ac_specialist_advice WHERE intent_id=$1 AND state='completed'",[intent.id])).rows[0];
      if(advice){if(!this.engineering)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
        await this.engineering.assertSpecialistApproved(c,intent.id,authority);}
      const evidence=(await c.query(`SELECT EXISTS(SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND id IS DISTINCT FROM $3::uuid) OR
        EXISTS(SELECT 1 FROM ac_execution_launches WHERE operation_id=$2) OR
        EXISTS(SELECT 1 FROM ac_sandbox_jobs WHERE id=$2) OR
        EXISTS(SELECT 1 FROM ac_stage_operations WHERE intent_id=$1) OR
        EXISTS(SELECT 1 FROM ac_managed_composition_sources WHERE intent_id=$1) OR
        EXISTS(SELECT 1 FROM ac_remote_operations WHERE intent_id=$1) AS found`,[intent.id,intent.operation_id,advice?.grant_id??null])).rows[0];
      if(evidence.found)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
      await c.query('UPDATE ac_operations SET manager_epoch=$2 WHERE id=$1',[intent.operation_id,authority.epoch]);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'managed.operation_adopted',$2)",
        [authority.contextId,{intentId:intent.id,operationId:intent.operation_id,previousEpoch:Number(row.manager_epoch),epoch:authority.epoch,proof:advice?'no-writer-launch-or-grant; advice-verified':'no-launch-or-grant'}]);
    });
  }
  private async recoverManagedGraph(parent:Intent,authority:Authority){
    const recipe=await readManagedRecipe(this.ledger,parent.id);
    const native=recipe.mode==='native';
    if(native){if(!this.nativeImplementation||!this.engineering)return;}
    else if(!this.isolated||!this.engineering)return;
    const run=this.store.getRun(parent.run_id);if(!run?.workflowDef||!run.graphState?.cursor)return;
    if(recipe.schemaVersion===3&&!syntheticSpecialistAdviceAuthorized(this.ledger))return;
    if(recipe.mode!=='native'&&recipe.units.some(unit=>(unit.correctionRevision??0)>0)&&!syntheticManagedCorrectionsAuthorized(this.ledger))return;
    await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,parent.id);
      const row=(await c.query(`SELECT i.principal_id,i.context_id,i.run_id,i.command,i.operation_id,f.digest,x.project_id
        FROM ac_intents i JOIN ac_frozen_plans f ON f.intent_id=i.id JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1`,[parent.id])).rows[0];
      if(!row||row.context_id!==authority.contextId||row.run_id!==run.id||row.operation_id!==parent.operation_id||row.project_id!==this.projectId||
         digest(row.command)!==digest(parent.command)||row.digest!==digest(recipe.workflow)||digest(run.workflowDef)!==row.digest)
        throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
      await this.ledger.authorize(c,row.principal_id,authority.contextId);
    });
    const used=new Set<string>();
    for(const unit of recipe.units){
      const child=this.store.getRun(unit.runId);if(!child)continue;
      if(child.dispatch?.parentRunId!==run.id||child.dispatch.rootRunId!==run.id)throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
      const launch=Object.entries(recipe.launches).find(([,ids])=>ids.includes(unit.id));
      const workflow={name:(launch?.[1].length??0)>1?'(fork branch)':'(planned)',source:'built-in',steps:[{id:'task',name:unit.id,prompt:'{{task}}'}]};
      if(!launch||!child.workflowDef||digest(child.workflowDef)!==digest(workflow))throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
      const output=run.graphState.outputs?.[launch[0]],raw=launch[1].length>1?output?.runIds:output?.runId;
      const persisted=typeof raw==='string'?(launch[1].length>1?raw.split(','):[raw]):[];
      if(persisted[launch[1].indexOf(unit.id)]!==unit.runId)return;
      const intent=(await this.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
      if(!intent||!await readManagedUnit(this.ledger,intent))throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
      used.add(unit.id);this.authorities.set(unit.runId,authority);
    }
    this.managedPlans.set(run.id,{recipe,used});this.authorities.set(run.id,authority);
    const cursor=run.graphState.cursor,ids=recipe.launches[cursor];
    if(ids){
      const output=run.graphState.outputs?.[cursor];
      const raw=ids.length>1?output?.runIds:output?.runId;
      const saved=typeof raw==='string'?(ids.length>1?raw.split(','):[raw]):[];
      const expected=ids.map(id=>recipe.units.find(unit=>unit.id===id)?.runId);
      // A partially persisted fork or orphan is intentionally not repaired.
      if(saved.length!==expected.length||saved.some((id,index)=>!id||id!==expected[index]))return;
      for(const id of ids){
        const unit=recipe.units.find(value=>value.id===id)!;
        const child=this.store.getRun(unit.runId);if(!child)return;
        const intent=(await this.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
        if(!intent)return;
        const session=child.steps.find(step=>step.id==='task')?.sessionId;
        const operation=(await this.ledger.pool.query('SELECT native_session_id FROM ac_operations WHERE id=$1 AND intent_id=$2',[unit.operationId,intent.id])).rows[0];
        if(!session||!operation||operation.native_session_id!==session)throw new Refusal('MANAGED_RECOVERY_SESSION_MISMATCH');
        if(unit.kind==='composition'){
          if(!await this.engineering.replayManagedComposition(intent,authority,unit))return;
        }else if(native){
          if(!await this.nativeImplementation!.prepareRecovery(intent,authority))return;
        }else if(await this.isolated!.reconcileManagedTask(intent,authority,unit)!=='completed')return;
        if(child.status==='waiting'&&child.error==='Managed execution awaiting authoritative reconciliation'){
          if(child.graphState?.cursor!=='task')return;
          await this.resumeManagedRecord(intent,authority,false);return;
        }
        if(child.status!=='done')return;
      }
      this.managedReplayLaunches.set(`${run.id}:${cursor}`,authority.epoch);
      if(!await this.resumeManagedRecord(parent,authority,true))this.managedReplayLaunches.delete(`${run.id}:${cursor}`);
      return;
    }
    const binding=recipe.bindings[cursor];
    if(binding?.phase==='specialist'){
      const unit=recipe.units.find(value=>value.id===binding.unitId),session=run.steps.find(step=>step.id===cursor)?.sessionId;
      const launch=Object.entries(recipe.launches).find(([,members])=>members.includes(binding.unitId));
      if(!unit||!session||!launch)return;
      const advice=(await this.ledger.pool.query('SELECT state,session_id FROM ac_specialist_advice WHERE intent_id=$1 AND context_id=$2',[unit.intentId,authority.contextId])).rows[0];
      if(advice?.state!=='completed'||advice.session_id!==session)return;
      // The entire batch must already have durable approved advice. This keeps
      // incomplete, rejected and uncertain specialist processes parked.
      await this.verifyPreparedSpecialistBatch(parent,authority,recipe,launch[0]);
      await this.resumeManagedRecord(parent,authority,false);return;
    }
    if(!binding||binding.phase==='implement'||binding.phase==='select'||binding.phase==='prepare')return;
    const unit=recipe.units.find(value=>value.id===binding.unitId),session=run.steps.find(step=>step.id===cursor)?.sessionId;
    if(!unit||!session)return;
    const child=(await this.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
    if(!child||!await readManagedUnit(this.ledger,child))throw new Refusal('MANAGED_RECOVERY_IDENTITY_MISMATCH');
    await readManagedInput(this.ledger,child.id);
    if(binding.phase==='integrate')await this.engineering.reconcileIntegrationResult(child,authority);
    await this.engineering.reconcileVerifierResults(child,authority,binding.phase,session);
    if(!await this.engineering.canReplayCompleted(child,authority,binding.phase,session)&&
       !await this.engineering.prepareUnstartedNode(child,authority,binding.phase,session))return;
    await this.resumeManagedRecord(parent,authority,false);
  }
  /** Rejoin the native graph only after reconciling the interrupted implementation.
   * Called by the existing conversation heartbeat, never by a second scheduler. */
  async recoverManaged(authority:Authority){
    if((!this.isolated&&!this.engineering)||!this.running||!this.lock||this.recovering.has(authority.contextId)||
       Date.now()-(this.recoveryAt.get(authority.contextId)??0)<1000)return;
    this.recovering.add(authority.contextId);this.recoveryAt.set(authority.contextId,Date.now());
    try{
      const intents=(await this.ledger.pool.query<Intent>(`SELECT i.* FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
        WHERE i.context_id=$1 AND x.project_id=$2 AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=i.id) ORDER BY i.created_at`,[authority.contextId,this.projectId])).rows;
      for(const intent of intents){
        const run=this.store.getRun(intent.run_id);
        if(run?.status!=='waiting'||run.error!=='Managed execution awaiting authoritative reconciliation'||run.askParked||run.attentionRequest)continue;
        try{
          if(intent.command.payload.workflow==='managed-synthetic-v1'){
            await this.recoverManagedGraph(intent,authority);continue;
          }
          if(intent.parent_intent_id)continue;
          const cursor=run.graphState?.cursor;
          if(cursor==='implement'){
            if(intent.command.payload.workflow==='engineering-native-v1'){if(!this.nativeImplementation||!await this.nativeImplementation.prepareRecovery(intent,authority))continue;}
            else if(!this.isolated||await this.reconcileIsolated(intent,authority)!=='completed')continue;
          }else{
            if(!run.worktreePath)throw new Refusal('RECOVERY_WORKTREE_MISSING');
            const root=await realpath(join(this.repo,'.ai/cezar/worktrees')),worktree=await realpath(run.worktreePath);
            if(!worktree.startsWith(root+sep))throw new Refusal('RECOVERY_WORKTREE_FORBIDDEN',403);
            const session=run.steps.find(step=>step.id===cursor)?.sessionId;
            if(!cursor||!session||!this.engineering)continue;
            if(cursor==='integrate')await this.engineering.reconcileIntegrationResult(intent,authority);
            if(intent.command.payload.workflow!=='engineering-native-v1')await this.engineering.reconcileVerifierResults(intent,authority,cursor,session);
            if(!await this.engineering.canReplayCompleted(intent,authority,cursor,session)&&
               !await this.engineering.prepareUnstartedNode(intent,authority,cursor,session))continue;
          }
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
        const parentRunId=run?.dispatch?.parentRunId??runId;
        const managed=parentRunId?runtime.managedPlans.get(parentRunId):undefined;
        if(managed&&runId&&nodeId){
          let active:AgentSession|undefined,opened=true,canceled=false;
          const result=(async()=>{
            const authority=runtime.authorities.get(runId)??runtime.authorities.get(parentRunId!);
            if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
            const binding=runId===parentRunId?managed.recipe.bindings[nodeId]:undefined;
            const unit=binding?managed.recipe.units.find(u=>u.id===binding.unitId):managed.recipe.units.find(u=>u.runId===runId);
            if(!unit||(runId===parentRunId&&!binding)||(runId!==parentRunId&&nodeId!=='task'))throw new Refusal('MANAGED_UNIT_MISMATCH');
            const intent=(await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1',[unit.intentId])).rows[0];
            if(!intent)throw new Refusal('INTENT_MISSING');
            const verified=await readManagedUnit(runtime.ledger,intent);
            if(!verified||digest(verified.unit)!==digest(unit))throw new Refusal('MANAGED_UNIT_MISMATCH');
            if(binding?.phase==='prepare'){
              const launch=binding.launchId;
              if(managed.recipe.schemaVersion!==3||!launch||!managed.recipe.launches[launch]?.includes(unit.id))throw new Refusal('MANAGED_UNIT_MISMATCH');
              const parent=(await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE id=$1 AND run_id=$2',[verified.parentIntentId,runId])).rows[0];
              if(!parent||canceled)throw new Refusal('STAGE_CANCELED');
              await runtime.freezeManagedBatch(parent,authority,managed.recipe,launch);
              if(canceled)throw new Refusal('STAGE_CANCELED');
              runtime.specialistPreparedLaunches.set(`${runId}:${launch}`,authority.epoch);
              const text='Frozen source prepared for specialist advice.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
            }
            await readManagedInput(runtime.ledger,intent.id);
            if(!binding)await runtime.adoptUnstartedManagedOperation(intent,authority);
            const root=await realpath(join(runtime.repo,'.ai/cezar/managed'));
            const cwd=join(root,verified.parentIntentId,unit.runId);
            if(binding){
              if(!runtime.engineering||binding.phase==='implement'||await realpath(cwd)!==cwd)throw new Refusal('ENGINEERING_NODE_NOT_ADMITTED');
              if(binding.phase==='select'){
                const row=(await runtime.ledger.pool.query('SELECT id FROM ac_artifacts WHERE intent_id=$1',[intent.id])).rows;
                const principal=(await runtime.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;
                if(row.length!==1||!principal)throw new Refusal('MANAGED_SELECTION_MISMATCH');
                await runtime.engineering.selectManagedTask(principal,intent,authority,row[0].id);
                const text='Managed task artifact selected.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
              }
              if(binding.phase==='specialist'){
                if(!unit.requiresSpecialist)throw new Refusal('MANAGED_UNIT_MISMATCH');
                active=runtime.engineering.startSpecialist(intent,authority,unit,{...spec,cwd},onEvent);
                if(canceled)active.hardStop?.();return active.result;
              }
              active=runtime.engineering.start(intent,authority,binding.phase,{...spec,cwd},onEvent,false,
                managed.recipe.schemaVersion>=2&&unit.kind==='task'&&(binding.phase==='qa'||binding.phase==='review'));
            }else if(unit.kind==='composition'){
              if(!runtime.engineering)throw new Refusal('ENGINEERING_NOT_CONFIGURED');
              const operation=(await runtime.ledger.pool.query('SELECT state,receipt FROM ac_operations WHERE id=$1 AND intent_id=$2',[intent.operation_id,intent.id])).rows[0];
              if(operation?.state==='completed'){
                if(!await runtime.engineering.replayManagedComposition(intent,authority,unit))throw new Refusal('MANAGED_COMPOSITION_RECONCILIATION_REQUIRED');
                const text=`Managed composition reconciled: ${operation.receipt.commit}`;onEvent?.({type:'text',text});onEvent?.({type:'done'});
                return {text,toolCalls:[],tokensUsed:0};
              }
              const sources=await runtime.readManagedSourceArtifacts(intent,authority);
              if(canceled)throw new Refusal('STAGE_CANCELED');
              const receipt=await runtime.engineering.composeManaged(intent,authority,unit,z.uuid().parse(spec.sessionId),cwd,sources,spec.env?.CEZ_TASK_ID);
              const text=`Managed composition completed: ${receipt.commit}`;onEvent?.({type:'text',text});onEvent?.({type:'done'});
              return {text,toolCalls:[],tokensUsed:0};
            }else if(managed.recipe.mode==='native'){
              if(unit.kind!=='task'||!runtime.nativeImplementation)throw new Refusal('NATIVE_IMPLEMENTATION_NOT_CONFIGURED');
              if(await realpath(cwd)!==cwd)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN');
              active=runtime.nativeImplementation.start(intent,authority,spec,onEvent);
            }else{
              if(!runtime.isolated||await realpath(cwd)!==cwd)throw new Refusal('MANAGED_SOURCE_PATH_FORBIDDEN');
              const principal=(await runtime.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;
              if(!principal)throw new Refusal('INTENT_MISSING');
              const operation=(await runtime.ledger.pool.query('SELECT state FROM ac_operations WHERE id=$1 AND intent_id=$2',[intent.operation_id,intent.id])).rows[0];
              if(operation?.state==='completed'){
                active=runtime.isolated.start(intent,authority,{...spec,cwd},onEvent,unit);
                if(canceled)active.hardStop?.();return active.result;
              }
              let grant;
              for(;;){
                if(canceled||!runtime.running)throw new Refusal('STAGE_CANCELED');
                try{grant=await runtime.capacity.reserve(principal,{attemptId:unit.attemptId,intentId:intent.id,contextId:intent.context_id,role:'programmer'},authority);break;}
                catch(error){if(!(error instanceof Refusal)||!['NO_ELIGIBLE_CAPACITY','CAPACITY_QUEUED','CAPACITY_BUSY','ORIGINAL_RESERVE_NOT_NEEDED'].includes(error.code))throw error;
                  await new Promise(resolve=>setTimeout(resolve,250));}
              }
              await runtime.ledger.tx(async c=>{await runtime.ledger.fence(c,authority);await runtime.ledger.assertIntentActive(c,authority.contextId,intent.id);
                const saved=await c.query("UPDATE ac_operations SET grant_id=$2 WHERE id=$1 AND intent_id=$3 AND state='registered' AND (grant_id IS NULL OR grant_id=$2)",
                  [intent.operation_id,grant.id,intent.id]);if(!saved.rowCount)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');});
              active=runtime.isolated.start(intent,authority,{...spec,cwd},onEvent,unit);
            }
            if(canceled)active.hardStop?.();return active.result;
          })().finally(()=>{opened=false;});
          return {result,get open(){return opened;},get pid(){return active?.pid;},sendMessage(){return false;},end(){active?.end();},
            interrupt(){canceled=true;return active?.interrupt();},hardStop(){canceled=true;active?.hardStop?.();}};
        }
        if((run?.workflow==='engineering-synthetic-v1'||run?.workflow==='engineering-native-v1')&&nodeId!=='implement'){
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
        if(run?.workflow==='engineering-native-v1'){
          if(!runtime.nativeImplementation||!runId||nodeId!=='implement')throw new Refusal('NATIVE_IMPLEMENTATION_NOT_CONFIGURED');
          const authority=runtime.authorities.get(runId);if(!authority)throw new Refusal('EFFECT_AUTHORITY_MISSING');
          let active:AgentSession|undefined,opened=true,canceled=false;
          const result=(async()=>{const intent=(await runtime.ledger.pool.query<Intent>('SELECT * FROM ac_intents WHERE run_id=$1',[runId])).rows[0];if(!intent)throw new Refusal('INTENT_MISSING');
            active=runtime.nativeImplementation!.start(intent,authority,spec,onEvent);if(canceled)active.hardStop?.();return active.result;})().finally(()=>{opened=false;});
          return {result,get open(){return opened;},sendMessage(){return false;},end(){},interrupt(){canceled=true;active?.interrupt();},hardStop(){canceled=true;active?.hardStop?.();}};
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
            await runtime.ledger.fence(c, authority);await runtime.ledger.assertIntentActive(c,authority.contextId,intent.id);
            if (!runtime.running || canceled) throw new Refusal('RUNTIME_NOT_AUTHORIZED');
            const state = await c.query('SELECT state FROM ac_operations WHERE id=$1 FOR UPDATE', [intent.operation_id]);
            if (state.rows[0].state !== 'registered') throw new Refusal('OPERATION_UNCERTAIN');
            // Persist launch intent before the physical effect. Crash here stays uncertain, never blind retry.
            await c.query("UPDATE ac_operations SET state='uncertain',manager_epoch=$2 WHERE id=$1", [intent.operation_id, authority.epoch]);
          });
          // Lock the authority across this local spawn: takeover cannot cross the effect boundary.
          await runtime.ledger.tx(async c => {
            await runtime.ledger.fence(c, authority);await runtime.ledger.assertIntentActive(c,authority.contextId,intent.id);
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
    this.store.emit('managed-runtime-close');
    this.running = false; for (const child of this.children) terminate(child,'SIGKILL');
    this.engineering?.close();
    this.isolated?.close();
    this.nativeImplementation?.close();
    this.manager.dispose(); this.store.flush();
    if (this.lock) { await this.lock.query('SELECT pg_advisory_unlock(hashtextextended($1,1))', [this.repo]); this.lock.release(); this.lock = undefined; }
  }
}
