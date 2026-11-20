import {createHash} from 'node:crypto';
import {digest} from './contracts.ts';
import {loadSpecialistExamPlanAtRevision} from './exam-provider.ts';

/**
 * A high examiner finding is reviewed by Claude Opus 5.5 medium, usually on the same
 * account as the examiner. Account and profile do not prove independence there, so the
 * host requires two distinct native executions: each grant must be bound, by the ledger
 * journal the supervisor writes, to its session, account, profile and intent.
 * Identities reported by a worker or carried in a result are never enough on their own.
 *
 * Each job is also bound to the file it read. The host derives the session it assigns
 * to a native job from the job id and the digest of the request subject (purpose, module,
 * intent, commit, file and, for a reviewer, the finding line and identity). The journal keeps
 * job id and session immutable, so a job that read file B cannot be attested for file A, and a
 * reviewer that confirmed one finding cannot be attested for another finding on the same line.
 */
export const HIGH_REVIEWER_PROVIDER = 'claude';
export const HIGH_REVIEWER_MODEL = 'claude-opus-5-5';
export const HIGH_REVIEWER_EFFORT = 'medium';
export const HIGH_SESSION_UNPROVEN = 'MODULE_EXAM_HIGH_SESSION_UNPROVEN';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export type ExamSubject = {
  purpose: 'examiner' | 'reviewer';
  module: string;
  intentId: string;
  commit?: string | null;
  file: string;
  line?: number | null;
  /** Reviewer only: `examFindingIdentity` of the original finding. */
  finding?: string | null;
};

export type ExamFindingOrigin = {
  /** Report id of the finding, `ACH-NNN`, from its position in the original exam. */
  id: string;
  source: string;
  file: string;
  line: number;
  severity: string;
  evidence: string;
  hypothesis?: string | null;
};

/**
 * Stable identity of the original finding: only fields of the original request that no
 * confirmation changes (the title may be rewritten by the reviewer, so it is left out).
 */
export function examFindingIdentity(origin: ExamFindingOrigin): string {
  return digest({schema: 'module-exam-finding-v1', id: origin.id, source: origin.source, file: origin.file,
    line: origin.line, severity: origin.severity, evidence: origin.evidence, hypothesis: origin.hypothesis ?? null});
}

/** Report id of the finding at a 0-based position of the exam findings. */
export function examFindingId(index: number): string {
  return `ACH-${String(index + 1).padStart(3, '0')}`;
}

/** Digest of what one native job was asked to examine. Computed by the host only. */
export function examSubjectDigest(subject: ExamSubject): string {
  const base = {purpose: subject.purpose, module: subject.module, intentId: subject.intentId,
    commit: subject.commit ?? null, file: subject.file};
  // The examiner subject is unchanged, so journals of earlier examiner executions still attest.
  if (subject.purpose === 'examiner') return digest({schema: 'module-exam-subject-v1', ...base, line: null});
  if (!subject.finding || !DIGEST.test(subject.finding)) throw new Error('MODULE_EXAM_SUBJECT_INVALID');
  return digest({schema: 'module-exam-subject-v2', ...base, line: subject.line ?? null, finding: subject.finding});
}

/** The session the host assigns to a job for one subject, as a UUIDv8. */
export function examSessionFor(jobId: string, subjectDigest: string): string {
  if (!UUID.test(jobId) || !DIGEST.test(subjectDigest)) throw new Error('MODULE_EXAM_SUBJECT_INVALID');
  const h = createHash('sha256').update(`agent-control:module-exam-session:v1\n${jobId}\n${subjectDigest}`).digest('hex');
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type ExamExecutionIdentity = {
  provider: string;
  model: string;
  accountId?: string | null;
  profileId?: string | null;
  grantId?: string | null;
  sessionId?: string | null;
};
export type BoundExamExecution = ExamExecutionIdentity & {accountId: string; profileId: string; grantId: string; sessionId: string};

function bound(identity: ExamExecutionIdentity | null | undefined): identity is BoundExamExecution {
  return Boolean(identity && [identity.accountId, identity.profileId, identity.grantId, identity.sessionId]
    .every(value => typeof value === 'string' && UUID.test(value)));
}

/** Shape check only: both sides carry host grant and session, and neither is shared. */
export function distinctExamSessions(
  examiner: ExamExecutionIdentity | null | undefined,
  reviewer: ExamExecutionIdentity | null | undefined,
): boolean {
  return bound(examiner) && bound(reviewer)
    && examiner.grantId !== reviewer.grantId
    && examiner.sessionId !== reviewer.sessionId
    && examiner.profileId !== reviewer.profileId;
}

type Queryable = {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>};
type JobRow = {
  job_id: string; grant_id: string; session_id: string; account_id: string; profile_id: string; intent_id: string;
  context_id: string; role: string; state: string; model: string; effort: string; provider: string;
  grant_account_id: string; grant_profile_id: string; grant_context_id: string; project_id: string; policy_revision: number;
};

async function loadJobs(db: Queryable, grantIds: string[]): Promise<Map<string, JobRow>> {
  const rows = (await db.query(
    `SELECT j.id::text AS job_id, j.grant_id::text AS grant_id, j.session_id::text AS session_id,
            j.account_id::text AS account_id, j.profile_id::text AS profile_id, j.intent_id::text AS intent_id,
            j.context_id::text AS context_id, j.role, j.state, p.model, p.effort, a.provider,
            g.account_id::text AS grant_account_id, g.profile_id::text AS grant_profile_id,
            g.context_id::text AS grant_context_id, g.project_id::text AS project_id, g.policy_revision
     FROM ac_native_execution_jobs j
     JOIN ac_capacity_grants g ON g.id=j.grant_id
     JOIN ac_profiles p ON p.id=j.profile_id
     JOIN ac_accounts a ON a.id=j.account_id
     WHERE j.grant_id = ANY($1::uuid[])`,
    [grantIds],
  )).rows as JobRow[];
  return new Map(rows.map(row => [row.grant_id, row]));
}

/**
 * The job matches the claimed identity, its subject and the Claude account the policy
 * chose when the grant was reserved: the first Claude account of the specialist chain of
 * the grant's own policy revision. A later policy or a later account of the chain fails.
 */
async function matchesJob(db: Queryable, row: JobRow | undefined, identity: BoundExamExecution, claim: {
  contextId: string; intentId: string; subject: string;
}): Promise<boolean> {
  if (!row || row.state !== 'completed' || row.role !== 'specialist' || row.context_id !== claim.contextId
    || row.grant_context_id !== claim.contextId || row.intent_id !== claim.intentId
    || row.session_id !== identity.sessionId || row.account_id !== identity.accountId || row.profile_id !== identity.profileId
    || row.grant_account_id !== row.account_id || row.grant_profile_id !== row.profile_id
    || row.provider !== identity.provider || row.model !== identity.model) return false;
  if (row.session_id !== examSessionFor(row.job_id, claim.subject)) return false;
  // Both seats are reserved on the first Claude account only (`firstAccountOnly`).
  if (row.provider !== HIGH_REVIEWER_PROVIDER) return false;
  const plan = await loadSpecialistExamPlanAtRevision(db, row.project_id, Number(row.policy_revision));
  return plan.primaryClaudeAccountId === row.account_id;
}

function validClaim(contextId: string, intentId: string, subject: string): boolean {
  return UUID.test(contextId) && UUID.test(intentId) && DIGEST.test(subject);
}

/**
 * Ledger check for the examiner execution alone, before a recheck reserves a reviewer seat.
 * Without it, an original that can never be attested would still spend an Opus round.
 */
export async function attestExamExecution(db: Queryable, input: {
  contextId: string; intentId: string; execution: ExamExecutionIdentity | null | undefined; subject: string;
}): Promise<boolean> {
  const {execution} = input;
  if (!bound(execution) || !validClaim(input.contextId, input.intentId, input.subject)) return false;
  const jobs = await loadJobs(db, [execution.grantId]);
  return matchesJob(db, jobs.get(execution.grantId), execution, input);
}

/**
 * Ledger check for a high examiner finding. The examiner and the reviewer must be completed
 * specialist jobs of this context, each with the reported grant, session, account and profile,
 * each bound to its own subject digest and to the policy's account at reservation, and the
 * reviewer must be Claude Opus 5.5 medium. Any missing or divergent field fails closed.
 */
export async function attestDistinctExamSessions(db: Queryable, input: {
  contextId: string;
  examiner: ExamExecutionIdentity | null | undefined;
  examinerIntentId: string;
  examinerSubject: string;
  reviewer: ExamExecutionIdentity | null | undefined;
  reviewerIntentId: string;
  reviewerSubject: string;
}): Promise<boolean> {
  if (!distinctExamSessions(input.examiner, input.reviewer)) return false;
  const examiner = input.examiner as BoundExamExecution, reviewer = input.reviewer as BoundExamExecution;
  if (!validClaim(input.contextId, input.examinerIntentId, input.examinerSubject)
    || !validClaim(input.contextId, input.reviewerIntentId, input.reviewerSubject)
    || input.examinerSubject === input.reviewerSubject) return false;
  if (reviewer.provider !== HIGH_REVIEWER_PROVIDER || reviewer.model !== HIGH_REVIEWER_MODEL) return false;
  const jobs = await loadJobs(db, [examiner.grantId, reviewer.grantId]);
  const examinerRow = jobs.get(examiner.grantId);
  const reviewerRow = jobs.get(reviewer.grantId);
  return Boolean(examinerRow && reviewerRow && reviewerRow.effort === HIGH_REVIEWER_EFFORT
    && examinerRow.job_id !== reviewerRow.job_id && examinerRow.session_id !== reviewerRow.session_id)
    && await matchesJob(db, examinerRow, examiner, {contextId: input.contextId, intentId: input.examinerIntentId, subject: input.examinerSubject})
    && await matchesJob(db, reviewerRow, reviewer, {contextId: input.contextId, intentId: input.reviewerIntentId, subject: input.reviewerSubject});
}
