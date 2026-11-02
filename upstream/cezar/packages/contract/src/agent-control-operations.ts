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
export const agentControlDiagnosticEvidenceSchema=z.object({kind:z.enum(['context','cancellation','capacity_wait','operation','sandbox_job','stage','integration','artifact','specialist','administrative_operation']),id:z.uuid()}).strict();
export const agentControlDiagnosticFindingSchema=z.object({code:z.enum(['context_paused','context_draining','cancellation_requested','cancellation_confirmed',
 'capacity_wait','effect_uncertain','managed_effect_uncertain','stage_uncertain','physical_receipt_unconfirmed','integration_uncertain','policy_unknown','approval_missing','admission_closed','manager_unavailable','specialist_uncertain','specialist_rejected','administrative_effect_uncertain']),
 meaning:z.string(),owner:z.string(),nextCondition:z.string(),evidence:z.array(agentControlDiagnosticEvidenceSchema)}).strict();
export const agentControlDiagnosticsSchema=z.object({contextId:z.uuid(),findings:z.array(agentControlDiagnosticFindingSchema),truncated:z.boolean(),
 assessment:z.enum(['observed','unknown']),explanation:z.string().optional()}).strict();
export type AgentControlProviderBinding=z.infer<typeof agentControlProviderBindingSchema>;
export type AgentControlProviderAdapter=z.infer<typeof agentControlProviderAdapterSchema>;
export type AgentControlProviderBindInput=z.infer<typeof agentControlProviderBindInputSchema>;
export type AgentControlOperationalSnapshot=z.infer<typeof agentControlOperationalSnapshotSchema>;
export type AgentControlDiagnosticFinding=z.infer<typeof agentControlDiagnosticFindingSchema>;
export type AgentControlDiagnostics=z.infer<typeof agentControlDiagnosticsSchema>;
