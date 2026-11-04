import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Capacity, CapacityPolicy, AccountInput, ProfileInput, QuotaInput } from './capacity.ts';
import { digest, Id, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
import { Operators,type OperatorProof } from './operator.ts';
import { Admission } from './admission.ts';
import { Templates,Template } from './templates.ts';
import { ProjectTemplateApply, ProjectTemplatePublish, ProjectTemplates, readProjectTemplates } from './project-templates.ts';
import { QualityPolicies,QualityPolicy } from './quality-policy.ts';
import {ProviderCollectors,ProviderBinding,projectProviderSnapshot,type ProviderAdapter} from './providers.ts';
import {IntegrationApproval,approveIntegration} from './approvals.ts';
import {authorizeRemoteSource,RemoteSourcePayload} from './remote-source-authorizations.ts';
import {ProviderEligibility,ProviderEligibilityInput} from './provider-eligibility.ts';
import {AdministrativeOperations,AdministrativePolicy} from './administrative-operations.ts';
import {capacityWaitExclusions} from './observability.ts';
const base={schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,contextId:Id};
export const ControlCommand=z.discriminatedUnion('action',[
 z.object({...base,action:z.literal('administrative.policy.publish'),payload:z.object({expectedRevision:z.number().int().nonnegative(),policy:AdministrativePolicy}).strict()}).strict(),
 z.object({...base,action:z.literal('provider.eligibility.publish'),payload:ProviderEligibilityInput}).strict(),
 z.object({...base,action:z.literal('remote.source.authorize'),payload:RemoteSourcePayload}).strict(),
 z.object({...base,action:z.literal('integration.approve'),payload:IntegrationApproval}).strict(),
 z.object({...base,action:z.literal('quality.publish'),payload:z.object({expectedRevision:z.number().int().nonnegative(),policy:QualityPolicy}).strict()}).strict(),
 z.object({...base,action:z.literal('template.publish'),payload:z.object({expectedRevision:z.number().int().nonnegative(),template:Template}).strict()}).strict(),
 z.object({...base,action:z.literal('template.assign'),payload:z.object({revision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('project-template.publish'),payload:ProjectTemplatePublish}).strict(),
 z.object({...base,action:z.literal('project-template.apply'),payload:ProjectTemplateApply}).strict(),
 z.object({...base,action:z.literal('device.enroll'),payload:z.object({deviceId:Id,publicKey:z.string().min(40).max(200)}).strict()}).strict(),
 z.object({...base,action:z.literal('device.revoke'),payload:z.object({deviceId:Id}).strict()}).strict(),
 z.object({...base,action:z.literal('admission.set'),payload:z.object({enabled:z.boolean(),expectedRevision:z.number().int().positive(),reason:z.string().min(1).max(200)}).strict()}).strict(),
 z.object({...base,action:z.literal('context.pause'),payload:z.object({paused:z.boolean(),expectedRevision:z.number().int().nonnegative()}).strict()}).strict(),
 z.object({...base,action:z.literal('context.drain'),payload:z.object({draining:z.boolean(),expectedRevision:z.number().int().nonnegative()}).strict()}).strict(),
 z.object({...base,action:z.literal('plan.cancel'),payload:z.object({intentId:Id,planRevision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('provider.bind'),payload:ProviderBinding}).strict(),
 z.object({...base,action:z.literal('account.add'),payload:AccountInput}).strict(),
 z.object({...base,action:z.literal('account.share'),payload:z.object({accountId:Id}).strict()}).strict(),
 z.object({...base,action:z.literal('account.state'),payload:z.object({id:Id,enabled:z.boolean(),expectedRevision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('profile.state'),payload:z.object({id:Id,enabled:z.boolean(),expectedRevision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('profile.add'),payload:ProfileInput}).strict(),
 z.object({...base,action:z.literal('policy.publish'),payload:z.object({expectedRevision:z.number().int().nonnegative(),policy:CapacityPolicy}).strict()}).strict(),
 z.object({...base,action:z.literal('policy.assign'),payload:z.object({revision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('capacity.configure'),payload:z.object({programmingLimit:z.number().int().min(1).max(128),evaluationLimit:z.number().int().min(1).max(128),expectedRevision:z.number().int().nonnegative(),originalFallback:z.object({accountId:Id,programmingLimit:z.number().int().min(1).max(128),evaluationLimit:z.number().int().min(1).max(128)}).strict().nullable().optional()}).strict()}).strict(),
 z.object({...base,action:z.literal('quota.observe'),payload:z.object({accountId:Id,observation:QuotaInput}).strict()}).strict(),
]);
/** Human administration has a separate intent identity but uses the same PG/RBAC authority.
 * A nested Capacity view shares this transaction: effect and dedupe commit together. */
export class Control {
 constructor(readonly ledger:Ledger,readonly providerAdapters:readonly ProviderAdapter[]=[],private readonly projectScope?:string,readonly administrative=new AdministrativeOperations(ledger,[]),private readonly qualityExecutors:{reviewDigest?:string;qaDigest?:string;nativeExecutionEnabled?:boolean}={}){
  this.qualityExecutors=Object.freeze({...qualityExecutors});
  for(const value of [this.qualityExecutors.reviewDigest,this.qualityExecutors.qaDigest])if(value!==undefined&&!/^[a-f0-9]{64}$/.test(value))throw new Refusal('QUALITY_EXECUTOR_CONFIGURATION_INVALID');
  if(administrative.ledger!==ledger)throw new Refusal('ADMIN_SERVICE_LEDGER_MISMATCH',403);
 }
 async execute(principal:string,raw:z.input<typeof ControlCommand>,proof:OperatorProof){
  const command=ControlCommand.parse(raw);
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,command.contextId);
   if(this.projectScope&&context.project_id!==this.projectScope)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   await new Operators(this.ledger).verify(c,principal,raw,proof);
   if(command.action==='remote.source.authorize'&&context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const admission=(await c.query(command.action==='admission.set'
    ?'SELECT enabled FROM ac_admission_control WHERE id=1 FOR UPDATE'
    :'SELECT enabled FROM ac_admission_control WHERE id=1 FOR SHARE')).rows[0];
   const allowedWhileClosed=command.action==='admission.set'||command.action==='device.revoke'||command.action==='plan.cancel'||
    (command.action==='context.pause'&&command.payload.paused)||
    (command.action==='context.drain'&&command.payload.draining)||
    ((command.action==='account.state'||command.action==='profile.state')&&!command.payload.enabled);
   if(!admission?.enabled&&!allowedWhileClosed)throw new Refusal('ADMISSION_CLOSED');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
   const {deliveryAttemptId,...semantic}=command;
   const hash=digest({principal,...semantic});
   const prior=(await c.query('SELECT * FROM ac_control_intents WHERE id=$1',[command.intentId])).rows[0];
   let result:unknown;
   if(prior){if(prior.payload_digest!==hash)throw new Refusal('CONTROL_INTENT_CONFLICT');result=prior.result;}
   else{
    const service=new Capacity(this.ledger,c);
    switch(command.action){
     case 'administrative.policy.publish':result=await this.administrative.publish(c,principal,command.contextId,command.payload.expectedRevision,command.payload.policy);break;
     case 'provider.eligibility.publish':result=await new ProviderEligibility(this.ledger,c).publish(principal,context.project_id,command.payload);break;
     case 'remote.source.authorize':result=await authorizeRemoteSource(c,principal,context.project_id,command,proof);break;
     case 'integration.approve':result=await approveIntegration(this.ledger,c,principal,command.contextId,command.payload);break;
     case 'quality.publish':result={revision:await new QualityPolicies(this.ledger,c).publish(principal,context.project_id,command.payload.expectedRevision,command.payload.policy)};break;
     case 'template.publish':result=await new Templates(this.ledger,c).publish(principal,command.contextId,command.payload.expectedRevision,command.payload.template);break;
     case 'template.assign':result=await new Templates(this.ledger,c).assign(principal,command.contextId,command.payload.revision);break;
     case 'project-template.publish':result=await new ProjectTemplates(this.ledger,c).publish(principal,command.contextId,command.payload);break;
     case 'project-template.apply':result=await new ProjectTemplates(this.ledger,c).apply(principal,command.contextId,command.payload);break;
     case 'device.enroll':await new Operators(this.ledger).enrollFromDevice(c,principal,command.payload.deviceId,command.payload.publicKey);result={deviceId:command.payload.deviceId};break;
     case 'device.revoke':await new Operators(this.ledger).revokeFromDevice(c,principal,command.payload.deviceId);result={deviceId:command.payload.deviceId};break;
     case 'admission.set':result=await new Admission(this.ledger,c).set(principal,command.payload);break;
     case 'context.pause':{
      if(context.pause_revision!==command.payload.expectedRevision)throw new Refusal('PAUSE_REVISION_CONFLICT');
      const updated=await c.query('UPDATE ac_contexts SET paused=$2,pause_revision=pause_revision+1 WHERE id=$1 RETURNING paused,pause_revision',
       [command.contextId,command.payload.paused]);
      result={paused:updated.rows[0].paused,revision:updated.rows[0].pause_revision};break;
     }
     case 'context.drain':{
      if(context.drain_revision!==command.payload.expectedRevision)throw new Refusal('DRAIN_REVISION_CONFLICT');
      const updated=await c.query('UPDATE ac_contexts SET draining=$2,drain_revision=drain_revision+1 WHERE id=$1 RETURNING draining,drain_revision',
       [command.contextId,command.payload.draining]);
      result={draining:updated.rows[0].draining,revision:updated.rows[0].drain_revision};break;
     }
     case 'plan.cancel':{
      const target=(await c.query('SELECT state,plan_revision,parent_intent_id FROM ac_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',
       [command.payload.intentId,command.contextId])).rows[0];
      if(!target)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
      if(target.parent_intent_id)throw new Refusal('MANAGED_SUBDELIVERY_CONTROL_ROOT_REQUIRED',403);
      if(target.plan_revision!==command.payload.planRevision)throw new Refusal('PLAN_REVISION_MISMATCH');
      const prior=(await c.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[command.payload.intentId])).rows[0];
      if(!prior&&['done','review','failed','canceled','cancelled'].includes(target.state))throw new Refusal('PLAN_ALREADY_TERMINAL');
      if(!prior&&(await c.query(`SELECT 1 FROM ac_integration_intents x JOIN ac_artifacts a ON a.id=x.artifact_id
       WHERE a.intent_id=$1 AND x.state IN ('integrated','rejected')`,[command.payload.intentId])).rowCount)throw new Refusal('PLAN_ALREADY_TERMINAL');
      if(!prior){
       await c.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',
        [command.payload.intentId,command.contextId,principal,command.payload.planRevision]);
       await c.query("UPDATE ac_intents SET state='cancellation_requested' WHERE id=$1",[command.payload.intentId]);
      }
      // A canceled attempt must not remain the FIFO head for other work.
      // Remove only admission waits, never its running/uncertain grants.
      await c.query('DELETE FROM ac_capacity_waits WHERE intent_id=$1',[command.payload.intentId]);
      result={intentId:command.payload.intentId,cancellationState:prior?.state??'requested'};break;
     }
     case 'provider.bind':result=await new ProviderCollectors(this.ledger,this.providerAdapters,c).bind(principal,context.project_id,command.payload);break;
     case 'account.add':await service.addAccount(principal,context.project_id,command.payload);result={accountId:command.payload.id};break;
     case 'account.share':await service.shareAccount(principal,command.payload.accountId,context.project_id);result={accountId:command.payload.accountId};break;
     case 'account.state':await service.setEnabled(principal,context.project_id,'account',command.payload);result={id:command.payload.id,enabled:command.payload.enabled,revision:command.payload.expectedRevision+1};break;
     case 'profile.state':await service.setEnabled(principal,context.project_id,'profile',command.payload);result={id:command.payload.id,enabled:command.payload.enabled,revision:command.payload.expectedRevision+1};break;
     case 'profile.add':await service.addProfile(principal,context.project_id,command.payload);result={profileId:command.payload.id};break;
     case 'policy.publish':result={revision:await service.publish(principal,context.project_id,command.payload.expectedRevision,command.payload.policy)};break;
     case 'policy.assign':await service.assignPolicy(principal,command.contextId,command.payload.revision);result={revision:command.payload.revision};break;
     case 'capacity.configure':await service.configure(principal,command.payload);result={applied:true};break;
     case 'quota.observe':await service.observeQuota(principal,command.payload.accountId,command.payload.observation);result={observed:true};break;
    }
    await c.query('INSERT INTO ac_control_intents(id,context_id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5,$6)',
     [command.intentId,command.contextId,principal,hash,command.action,result]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'control.applied',$2)",[command.contextId,{intentId:command.intentId,action:command.action}]);
   }
   await c.query('INSERT INTO ac_control_deliveries(id,intent_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[deliveryAttemptId,command.intentId]);
   if((await c.query('SELECT intent_id FROM ac_control_deliveries WHERE id=$1',[deliveryAttemptId])).rows[0].intent_id!==command.intentId)
    throw new Refusal('CONTROL_DELIVERY_CONFLICT');
   return {intentId:command.intentId,state:'applied' as const,result};
  });
 }
 async view(principal:string,contextId:string){
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId),false);
   if(this.projectScope&&context.project_id!==this.projectScope)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const accounts=(await c.query(`SELECT a.id,a.provider,a.label,a.mode,a.eligibility,a.enabled,a.revision,a.max_concurrent,
    (a.mode='synthetic') can_activate,
    (a.owner_id=$2 AND $3::boolean) can_manage,
    CASE WHEN q.expires_at>clock_timestamp() THEN q.status ELSE 'unknown' END quota_status,
    q.source quota_source,q.observed_at,q.expires_at
    FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id LEFT JOIN ac_quota_observations q ON q.account_id=a.id
    WHERE x.project_id=$1 ORDER BY a.id`,[context.project_id,principal,context.role==='owner'])).rows;
   const providerBindings=(await c.query(`SELECT b.account_id,b.adapter_id,b.adapter_version,b.revision,b.minimum_interval_seconds,
    (b.lease_id IS NOT NULL) probe_pending,b.probe_uncertain,o.snapshot,o.digest,o.completed_at,o.expires_at,
    COALESCE(o.expires_at>clock_timestamp(),false) fresh
    FROM ac_provider_bindings b JOIN ac_account_access x ON x.account_id=b.account_id
    LEFT JOIN LATERAL(SELECT snapshot,digest,completed_at,expires_at FROM ac_provider_observations
     WHERE account_id=b.account_id AND binding_revision=b.revision AND adapter_digest=b.adapter_digest AND state='completed'
     ORDER BY completed_at DESC LIMIT 1) o ON true WHERE x.project_id=$1 ORDER BY b.account_id`,[context.project_id])).rows.map(row=>{const {digest:storedDigest,...binding}=row;return {...binding,
     snapshot:row.snapshot?projectProviderSnapshot(row.snapshot,storedDigest,row.fresh===true):null};});
   const providerAdapters=this.providerAdapters.map(adapter=>({id:adapter.manifest.id,version:adapter.manifest.version,provider:adapter.manifest.provider,mode:adapter.manifest.mode,source:adapter.manifest.source}));
   const profiles=(await c.query(`SELECT p.*,(a.mode='synthetic') can_activate,(a.owner_id=$2 AND $3::boolean) can_manage FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id
    JOIN ac_account_access x ON x.account_id=p.account_id WHERE x.project_id=$1 ORDER BY p.id`,[context.project_id,principal,context.role==='owner'])).rows;
   const catalog=(await c.query(`SELECT m.provider,m.model,m.efforts,m.roles,m.source FROM ac_model_catalog m
    WHERE EXISTS(SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE a.provider=m.provider AND x.project_id=$1)
    ORDER BY m.provider,m.model`,[context.project_id])).rows;
   const administrative={recentOperations:(await c.query(
    `SELECT id,operation_name AS name,operation_version AS version,state,manager_epoch AS epoch,created_at
     FROM ac_administrative_operations WHERE context_id=$1 ORDER BY created_at DESC,id LIMIT 50`,[contextId])).rows,managerProfileIds:(await c.query(
    'SELECT DISTINCT profile_id FROM ac_managers WHERE context_id=$1',[contextId])).rows.map(row=>row.profile_id),operations:this.administrative.catalog(),policies:(await c.query(
    'SELECT revision,digest,snapshot,created_at AS published_at FROM ac_administrative_policies WHERE context_id=$1 ORDER BY revision DESC LIMIT 100',[contextId])).rows};
   const providerEligibility=await new ProviderEligibility(this.ledger,c).viewProject(principal,context.project_id);
   const policies=(await c.query('SELECT revision,digest,snapshot,published_at FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision',[context.project_id])).rows;
   const grants=(await c.query(`SELECT id,attempt_id,intent_id,resource_kind,profile_id,account_id,role,policy_revision,emergency,state,created_at
    FROM ac_capacity_grants WHERE context_id=$1 ORDER BY created_at DESC LIMIT 100`,[contextId])).rows;
   const waits=(await c.query(`SELECT attempt_id,resource_kind,role,reason,desired_profile,priority,sequence,exclusions
    FROM ac_capacity_waits WHERE context_id=$1 ORDER BY priority DESC,sequence`,[contextId])).rows.map(row=>{
    const exclusions=capacityWaitExclusions(row.exclusions);
    const {exclusions:_stored,...rest}=row;
    return exclusions?{...rest,exclusions}:rest;
   });
   const plans=(await c.query(`SELECT i.id,i.run_id,i.plan_revision,i.state,c.state cancellation_state
    FROM ac_intents i LEFT JOIN ac_plan_cancellations c ON c.intent_id=i.id WHERE i.context_id=$1 AND i.parent_intent_id IS NULL ORDER BY i.created_at DESC LIMIT 100`,[contextId])).rows;
   const approvals=(await c.query(`SELECT a.id,a.commit_id,a.tree_id,a.base_id,a.identity_digest,a.policy_revision,x.target_ref,
    EXISTS(SELECT 1 FROM ac_integration_approvals h WHERE h.artifact_id=a.id AND h.target_ref=x.target_ref) approved,
    EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=a.intent_id) canceled
    FROM ac_artifacts a JOIN ac_execution_contracts x ON x.intent_id=a.intent_id
    JOIN ac_quality_policies p ON p.project_id=a.project_id AND p.revision=a.policy_revision
    WHERE a.context_id=$1 AND p.snapshot->>'requireHumanIntegration'='true' ORDER BY a.id LIMIT 100`,[contextId])).rows;
   const remoteOperations=(await c.query(`SELECT r.id,r.intent_id,r.task_id,r.state,h.label host_label
    FROM ac_remote_operations r JOIN ac_remote_hosts h ON h.id=r.host_id WHERE r.context_id=$1 ORDER BY r.created_at DESC LIMIT 100`,[contextId])).rows;
   const qualityPolicies=(await c.query('SELECT revision,snapshot,digest FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision',[context.project_id])).rows;
   const remoteSourceHosts=(await c.query(`SELECT id,label FROM ac_remote_hosts WHERE project_id=$1 AND enabled
    AND 'git-export'=ANY(allowed_tasks) ORDER BY label,id LIMIT 100`,[context.project_id])).rows;
   const remoteSourceAuthorizations=(await c.query(`SELECT control_intent_id AS "authorizationId",intent_id AS "intentId",host_id AS "hostId",
    commit_id AS commit,tree_id AS tree,'source_read_authorization'::text AS kind FROM ac_remote_source_authorizations
    WHERE context_id=$1 AND project_id=$2 ORDER BY created_at DESC,control_intent_id LIMIT 100`,[contextId,context.project_id])).rows;
   const templates=(await c.query('SELECT revision,snapshot,digest FROM ac_context_templates WHERE context_id=$1 ORDER BY revision',[contextId])).rows;
   const projectTemplateCatalog=await readProjectTemplates(c,context.project_id);
   const canConfigureCapacity=context.role!=='viewer'&&!!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount;
   const config=(await c.query('SELECT * FROM ac_capacity_config WHERE id=1')).rows[0];
   const capacity=config?{revision:config.revision,programmingLimit:config.programming_limit,evaluationLimit:config.evaluation_limit,
    originalFallback:canConfigureCapacity&&config.original_account_id?{accountId:config.original_account_id,programmingLimit:config.original_programming_limit,
     evaluationLimit:config.original_evaluation_limit}:null}:null;
   const installation=(await c.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
   const operatorDeviceIds=(await c.query("SELECT id FROM ac_operator_keys WHERE principal_id=$1 AND state='active'",[principal])).rows.map(row=>row.id);
   if(!installation)throw new Refusal('INSTALLATION_IDENTITY_MISSING');
   const verifierDigest=this.qualityExecutors.reviewDigest??createHash('sha256').update(await readFile(new URL('../scripts/synthetic-verifier-wide.mjs',import.meta.url))).digest('hex');
   const specialistVerifierDigest=createHash('sha256').update(await readFile(new URL('../scripts/synthetic-specialist.mjs',import.meta.url))).digest('hex');
   return {schemaVersion:1,installationId:installation.id,principalId:principal,nativeExecutionEnabled:this.qualityExecutors.nativeExecutionEnabled===true,verifierDigest,qaVerifierDigest:this.qualityExecutors.qaDigest??null,specialistVerifierDigest,contextId,waits,templates,projectTemplates:projectTemplateCatalog.templates,projectTemplatesTruncated:projectTemplateCatalog.truncated,canManageProjectTemplates:context.role==='owner',qualityPolicies,capacity,canConfigureCapacity,activeTemplateRevision:context.active_template_revision,projectId:context.project_id,assignedPolicyRevision:context.capacity_policy_revision,
    accounts,providerBindings,providerAdapters,providerEligibility,administrative,profiles,catalog,policies,grants,plans,approvals,remoteOperations,
    remoteSourceHosts,remoteSourceAuthorizations,canAuthorizeRemoteSource:context.role==='owner',operatorDeviceIds,canApproveIntegration:context.role==='owner'};
  });
 }
}
