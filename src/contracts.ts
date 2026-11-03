import { createHash } from 'node:crypto';
import { z } from 'zod';

export const Id = z.uuid();
export const Authority = z.object({ contextId: Id, instanceId: Id, epoch: z.number().int().positive() }).strict();
export type Authority = z.infer<typeof Authority>;
export const Command = z.object({
  schemaVersion: z.literal(1), intentId: Id, deliveryAttemptId: Id,
  contextId: Id, policyRevision: z.number().int().positive(),
  action: z.enum(['plan.start','plan.propose']),
  payload: z.discriminatedUnion('workflow',[
   z.object({workflow:z.enum(['baseline-synthetic-v1','engineering-synthetic-v1']),messageRef:z.string().min(1).max(200)}).strict(),
   z.object({workflow:z.literal('semantic-proposal-v1'),messageRef:z.string().min(1).max(200),localId:z.string().min(1).max(200),messageDigest:z.string().regex(/^[a-f0-9]{64}$/),qualityRevision:z.number().int().positive(),targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)}).strict(),
   z.object({workflow:z.literal('engineering-native-v1'),messageRef:z.string().min(1).max(200),localId:z.string().min(1).max(200),messageDigest:z.string().regex(/^[a-f0-9]{64}$/),qualityRevision:z.number().int().positive(),targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/),writePaths:z.array(z.string().min(1).max(240)).min(1).max(64)}).strict(),
   z.object({workflow:z.literal('managed-synthetic-v1'),messageRef:z.string().min(1).max(200),proposalRevision:z.number().int().positive(),proposalDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  ]),
}).strict().superRefine((value,ctx)=>{
 if((value.action==='plan.propose')!==(value.payload.workflow==='semantic-proposal-v1'))ctx.addIssue({code:'custom',message:'ACTION_WORKFLOW_MISMATCH',path:['action']});
});
export type Command = z.infer<typeof Command>;
export const Checkpoint = z.object({
  schemaVersion: z.literal(1), planRevision: z.number().int().nonnegative(),
  // References resolve only inside the authorized E2EE endpoint; no plaintext transcript.
  objectiveRef: z.string(), constraintRefs: z.array(z.string()), decisionRefs: z.array(z.string()),
  artifactRefs: z.array(z.string()), pendingIntentIds: z.array(Id), historyCursor: z.number().int().nonnegative(),
}).strict();
export type Checkpoint = z.infer<typeof Checkpoint>;
export const Projection = z.object({
  schemaVersion: z.literal(1), eventId: Id, contextId: Id, runId: Id,
  planRevision: z.number().int().positive(), seq: z.number().int().nonnegative(), status: z.string(),
}).strict();
export type Projection = z.infer<typeof Projection>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('NON_JSON_VALUE');
  return result;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export class Refusal extends Error {
  constructor(public readonly code: string, public readonly status: 400 | 401 | 403 | 404 | 409 | 503 = 409) { super(code); }
}
