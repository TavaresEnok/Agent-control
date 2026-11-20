/**
 * A high examiner finding is reviewed by Claude Opus 5.5 medium, usually on the same
 * account as the examiner. Account and profile do not prove independence there, so the
 * host requires two distinct native executions: each grant must be bound, by the ledger
 * journal the supervisor writes, to its session, account, profile and intent.
 * Identities reported by a worker or carried in a result are never enough on their own.
 */
export const HIGH_REVIEWER_PROVIDER = 'claude';
export const HIGH_REVIEWER_MODEL = 'claude-opus-5-5';
export const HIGH_REVIEWER_EFFORT = 'medium';
export const HIGH_SESSION_UNPROVEN = 'MODULE_EXAM_HIGH_SESSION_UNPROVEN';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  grant_id: string; session_id: string; account_id: string; profile_id: string; intent_id: string; context_id: string;
  role: string; state: string; model: string; effort: string; provider: string;
};

/**
 * Ledger check for a high examiner finding. The examiner and the reviewer must be completed
 * specialist jobs of this context, each with the reported grant, session, account and profile,
 * and the reviewer must be Claude Opus 5.5 medium. Any missing or divergent field fails closed.
 */
export async function attestDistinctExamSessions(db: Queryable, input: {
  contextId: string;
  examiner: ExamExecutionIdentity | null | undefined;
  examinerIntentId: string;
  reviewer: ExamExecutionIdentity | null | undefined;
  reviewerIntentId: string;
}): Promise<boolean> {
  const {examiner, reviewer} = input;
  if (!distinctExamSessions(examiner, reviewer)) return false;
  if (![input.contextId, input.examinerIntentId, input.reviewerIntentId].every(value => UUID.test(value))) return false;
  if (reviewer!.provider !== HIGH_REVIEWER_PROVIDER || reviewer!.model !== HIGH_REVIEWER_MODEL) return false;
  const rows = (await db.query(
    `SELECT j.grant_id::text AS grant_id, j.session_id::text AS session_id, j.account_id::text AS account_id,
            j.profile_id::text AS profile_id, j.intent_id::text AS intent_id, j.context_id::text AS context_id,
            j.role, j.state, p.model, p.effort, a.provider
     FROM ac_native_execution_jobs j
     JOIN ac_profiles p ON p.id=j.profile_id
     JOIN ac_accounts a ON a.id=j.account_id
     WHERE j.grant_id = ANY($1::uuid[])`,
    [[examiner!.grantId, reviewer!.grantId]],
  )).rows as JobRow[];
  const byGrant = new Map(rows.map(row => [row.grant_id, row]));
  const matches = (identity: BoundExamExecution, intentId: string, row: JobRow | undefined) => Boolean(row
    && row.state === 'completed' && row.role === 'specialist' && row.context_id === input.contextId
    && row.intent_id === intentId && row.session_id === identity.sessionId && row.account_id === identity.accountId
    && row.profile_id === identity.profileId && row.provider === identity.provider && row.model === identity.model);
  const examinerRow = byGrant.get(examiner!.grantId!);
  const reviewerRow = byGrant.get(reviewer!.grantId!);
  return matches(examiner as BoundExamExecution, input.examinerIntentId, examinerRow)
    && matches(reviewer as BoundExamExecution, input.reviewerIntentId, reviewerRow)
    && reviewerRow!.effort === HIGH_REVIEWER_EFFORT
    && examinerRow!.session_id !== reviewerRow!.session_id;
}
