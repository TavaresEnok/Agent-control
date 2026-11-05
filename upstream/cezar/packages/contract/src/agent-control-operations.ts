import {z} from 'zod';
const providerState=z.enum(['available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error']);
export const agentControlProviderSnapshotSchema=z.object({schemaVersion:z.literal(1),status:providerState,source:z.string(),
 remainingPercent:z.number().min(0).max(100).nullable(),resetAt:z.iso.datetime().nullable(),failure:z.enum(['none','transport','invalid_response']),
 subscriptionBalance:z.enum(['reported','unknown'])}).strict();
export const agentControlProviderBindingSchema=z.object({account_id:z.uuid(),adapter_id:z.string(),adapter_version:z.string(),
 revision:z.number().int().positive(),minimum_interval_seconds:z.number().int().min(1).max(3600),probe_pending:z.boolean(),probe_uncertain:z.boolean(),
 snapshot:agentControlProviderSnapshotSchema.nullable(),completed_at:z.iso.datetime().nullable(),expires_at:z.iso.datetime().nullable(),fresh:z.boolean()}).strict();
export const agentControlProviderAdapterSchema=z.object({id:z.string(),version:z.string(),provider:z.string(),mode:z.literal('synthetic'),source:z.string()}).strict();
export const agentControlProviderBindInputSchema=z.object({accountId:z.uuid(),adapterId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),
 expectedRevision:z.number().int().nonnegative(),minimumIntervalSeconds:z.number().int().min(1).max(3600)}).strict();
const metricSampleSchema=z.object({labels:z.record(z.string(),z.string()),value:z.string().regex(/^\d+$/)}).strict();
export const agentControlOperationalSnapshotSchema=z.object({schemaVersion:z.literal(1),scope:z.literal('installation_aggregate'),
 observedAt:z.iso.datetime(),databaseReadOnly:z.literal(true),diskObservation:z.enum(['not_configured','observed','partially_unavailable']),
 metrics:z.array(z.object({name:z.string().regex(/^agent_control_[a-z_]+$/),help:z.string(),type:z.literal('gauge'),samples:z.array(metricSampleSchema)}).strict())}).strict();
const agentControlSloIdSchema=z.enum(['manager_availability','dispatch_latency','queue_backlog','pending_receipt_age','infrastructure_failure_rate']);
const agentControlSloResultSchema=z.object({
 id:agentControlSloIdSchema,
 version:z.literal(1),
 status:z.enum(['ok','violated','unknown']),
 reason:z.string(),
 margin:z.object({unit:z.enum(['ppm','count','seconds']),headroom:z.string()}).strict().nullable(),
 window:z.object({
  kind:z.literal('snapshot_point'),
  freshnessLimitSeconds:z.number().finite(),
  observedAt:z.string().nullable(),
  ageSeconds:z.string().nullable(),
 }).strict(),
}).strict();
/** Closed catalog (manager decision): valid only with exactly these five distinct ids, so a truncated report stays unavailable. freshnessLimitSeconds is any finite number. reason, headroom, observedAt and ageSeconds stay free strings. */
export const agentControlSloReportSchema=z.object({
 schemaVersion:z.literal(1),
 catalogVersion:z.literal(1),
 scope:z.literal('installation_aggregate'),
 results:z.array(agentControlSloResultSchema).length(5),
}).strict().superRefine((report,ctx)=>{
 if(new Set(report.results.map(result=>result.id)).size!==report.results.length){
  ctx.addIssue({code:'custom',path:['results'],message:'duplicate slo'});
 }
});
export const agentControlDiagnosticEvidenceSchema=z.object({kind:z.enum(['context','cancellation','capacity_wait','operation','sandbox_job','stage','integration','artifact','specialist','administrative_operation','semantic_planning','native_planning_job','native_execution_job','native_qa_job','remote_operation','intent']),id:z.uuid()}).strict();
/** Closed observation of a stored native terminal failure. Reading a receipt does not verify its signature. */
export const nativeTerminalFailureObservationSchema=z.object({
 cause:z.enum(['worker_exited_without_result','finalizer_exited_without_result','invalid_scope','no_changes','finalization_failed','execution_failed','execution_timeout','execution_canceled','execution_native_turn_failed','execution_output_too_large','execution_native_failed','unknown']),
 origin:z.enum(['stored_agreement','unreconciled']),
}).strict();
export const agentControlDiagnosticFindingSchema=z.object({code:z.enum(['context_paused','context_draining','cancellation_requested','cancellation_confirmed',
 'capacity_wait','effect_uncertain','managed_effect_uncertain','stage_uncertain','physical_receipt_unconfirmed','integration_uncertain','policy_unknown','approval_missing','admission_closed','manager_unavailable','specialist_uncertain','specialist_rejected','administrative_effect_uncertain','planning_pending','planning_result_uncertain','planning_publication_pending','planning_rejected','native_planning_uncertain','native_execution_failed','remote_effect_uncertain','remote_execution_failed','remote_execution_canceled','native_qa_uncertain','native_qa_failed','native_qa_canceled','native_qa_timeout','native_qa_missing_result','native_qa_unknown','task_diagnosis_unknown','intent_canceled']),
 meaning:z.string(),owner:z.string(),nextCondition:z.string(),evidence:z.array(agentControlDiagnosticEvidenceSchema),
 capacityWait:z.object({reason:z.enum(['NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','CAPACITY_BUSY','CAPACITY_QUEUED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT','unknown']),exclusions:z.array(z.object({profileId:z.uuid(),reason:z.enum(['profile_missing','access_removed','account_disabled','profile_disabled','not_synthetic','ineligible','quota_exhausted','quota_unknown'])}).strict())}).strict().optional(),
 nativeFailure:nativeTerminalFailureObservationSchema.optional()}).strict();
export const agentControlDiagnosticsSchema=z.object({contextId:z.uuid(),findings:z.array(agentControlDiagnosticFindingSchema),truncated:z.boolean(),
 assessment:z.enum(['observed','unknown']),explanation:z.string().optional()}).strict();
export type AgentControlProviderBinding=z.infer<typeof agentControlProviderBindingSchema>;
export type AgentControlProviderAdapter=z.infer<typeof agentControlProviderAdapterSchema>;
export type AgentControlProviderBindInput=z.infer<typeof agentControlProviderBindInputSchema>;
export type AgentControlOperationalSnapshot=z.infer<typeof agentControlOperationalSnapshotSchema>;
export type AgentControlSloReport=z.infer<typeof agentControlSloReportSchema>;
export type AgentControlDiagnosticFinding=z.infer<typeof agentControlDiagnosticFindingSchema>;
export type AgentControlDiagnostics=z.infer<typeof agentControlDiagnosticsSchema>;
