import {z} from 'zod';
import {workflowDefSchema} from './workflows.ts';

const TaskId=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
// References to content held at the authorized E2EE endpoint, not another transcript store.
const ContentRef=z.string().min(1).max(240).regex(/^[a-z][a-z0-9-]*:[^\s]+$/);
const RepoPath=z.string().min(1).max(240).refine(path=>!path.startsWith('/')&&!path.includes('\\')&&
 !path.split('/').some(p=>p===''||p==='.'||p==='..'||p==='.git'||p==='.ai')&&!/[\x00-\x1f*?\[\]{}]/.test(path),'literal repository-relative path required');
const Target=z.string().max(240).regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).refine(ref=>!ref.includes('//')&&!ref.endsWith('/'));
export const ManagerTask=z.object({id:TaskId,objectiveRef:ContentRef,acceptanceRefs:z.array(ContentRef).min(1).max(32),
 inputRefs:z.array(ContentRef).max(32),outputRefs:z.array(ContentRef).min(1).max(32),dependsOn:z.array(TaskId).max(63),
 writePaths:z.array(RepoPath).min(1).max(64),qualityRevision:z.number().int().positive(),targetRef:Target,
 maxCorrections:z.number().int().min(0).max(5)}).strict();
export const ManagerPlan=z.object({schemaVersion:z.literal(1),contextId:z.uuid(),objectiveRef:ContentRef,
 sourceMessageRef:ContentRef,parallelism:z.number().int().min(1).max(10).optional(),constraintRefs:z.array(ContentRef).max(64),tasks:z.array(ManagerTask).min(1).max(64)}).strict();

/** Structural output contract; controller also applies refinements after generation. */
export function managerPlanOutputJsonSchema(){const schema=z.toJSONSchema(ManagerPlan);schema.required=Object.keys(schema.properties??{});return schema;}

export const managerPlanBindingSchema=z.object({nodeId:z.string(),taskId:TaskId,role:z.enum(['programmer','qa','reviewer','judge','integrator']),
 artifactSource:z.string(),freshSession:z.literal(true),reviewIndex:z.number().int().min(0).max(2).optional(),
 qualityRevision:z.number().int().positive(),maxCorrections:z.number().int().min(0).max(5)}).strict();
export const compiledManagerPlanSchema=z.object({schemaVersion:z.literal(1),planDigest:z.string().regex(/^[a-f0-9]{64}$/),
 workflow:workflowDefSchema,bindings:z.array(managerPlanBindingSchema),admission:z.literal('managed-delivery-adapter-required'),batches:z.array(z.array(TaskId))}).strict();
export const managerPlanProposalSchema=z.object({expectedRevision:z.number().int().nonnegative(),plan:ManagerPlan}).strict();
export const managerPlanPublishedSchema=z.object({revision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/),
 compilationDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const managerPlanSummarySchema=z.object({revision:z.number().int().positive(),epoch:z.number().int().positive(),
 digest:z.string().regex(/^[a-f0-9]{64}$/),taskCount:z.number().int().positive(),createdAt:z.iso.datetime()}).strict();
export const managerPlanListSchema=z.object({proposals:z.array(managerPlanSummarySchema),hasMore:z.boolean()}).strict();
export const managerPlanPreviewSchema=managerPlanPublishedSchema.extend({parentRevision:z.number().int().positive().nullable(),
 epoch:z.number().int().positive(),plan:ManagerPlan,compilation:compiledManagerPlanSchema}).strict();
export type ManagerPlan=z.infer<typeof ManagerPlan>;
export type ManagerTask=z.infer<typeof ManagerTask>;
export type PlanBinding=z.infer<typeof managerPlanBindingSchema>;
export type CompiledManagerPlan=z.infer<typeof compiledManagerPlanSchema>;

export const managerPlanRestoreSchema=z.object({expectedRevision:z.number().int().positive()}).strict();
export const managerPlanComparisonSchema=z.object({fromRevision:z.number().int().positive(),toRevision:z.number().int().positive(),
 fromDigest:z.string().regex(/^[a-f0-9]{64}$/),toDigest:z.string().regex(/^[a-f0-9]{64}$/),
 objectiveChanged:z.boolean(),constraintsChanged:z.boolean(),sourceMessageChanged:z.boolean(),added:z.array(TaskId),removed:z.array(TaskId),
 changed:z.array(z.object({taskId:TaskId,fields:z.array(z.enum(['objectiveRef','acceptanceRefs','inputRefs','outputRefs','dependsOn','writePaths','qualityRevision','targetRef','maxCorrections']))}).strict()),
 executionImpact:z.literal('proposal-only')}).strict();
