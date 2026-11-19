import {randomUUID} from 'node:crypto';
import type {Capacity, Grant} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export type ExamSeat = {grantId: string; accountId: string; provider: string};
export type SpecialistExamSeat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};
export type SpecialistExamPlan = {
  hasClaude: boolean;
  createProfileId?: string;
  examinerProfileId?: string;
  reviewerProfileIds: string[];
  accountByProfileId: Record<string, string>;
};

export type ExamReservationChoice =
  | {kind: 'use'; seat: ExamSeat}
  | {kind: 'hold'; accountId: string; seat: ExamSeat}
  | {kind: 'skip'; accountId: string};

/** Read-only exams accept only Claude. Grok and Codex are never returned. */
export function acceptClaudeExamSeat<T extends {provider: string}>(seat: T): T {
  if (seat.provider !== 'claude') throw new Refusal('EXAM_PROVIDER_UNSUPPORTED', 409);
  return seat;
}

/**
 * Prefer another Claude account when `avoidAccountIds` lists that account.
 * The same Claude account remains acceptable. A non-claude seat is skipped.
 */
export function classifyExamReservation(
  seat: ExamSeat,
  avoidAccountIds: readonly string[] | undefined,
  attempt: number,
): ExamReservationChoice {
  if (seat.provider !== 'claude') return {kind: 'skip', accountId: seat.accountId};
  const accepted = acceptClaudeExamSeat(seat);
  if (avoidAccountIds?.includes(accepted.accountId) && attempt < 3) {
    return {kind: 'hold', accountId: accepted.accountId, seat: accepted};
  }
  return {kind: 'use', seat: accepted};
}

type PolicySnapshotRow = {snapshot?: {roles?: {specialist?: {regular?: unknown; emergency?: unknown}}}};
type SpecialistProfileRow = {id: string; model: string; provider: string; account_id?: string};

/** Inspects the active policy's `roles.specialist` chain so exams pick the prepared seats without touching `roles.reviewer`. */
export async function loadSpecialistExamPlan(
  pool: {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>},
  contextId: string,
): Promise<SpecialistExamPlan> {
  const row = (await pool.query(
    `SELECT r.snapshot
     FROM ac_contexts x
     JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision
     WHERE x.id=$1`,
    [contextId],
  )).rows[0] as PolicySnapshotRow | undefined;
  const specialist = row?.snapshot?.roles?.specialist;
  const regular = Array.isArray(specialist?.regular) ? specialist.regular.filter((id): id is string => typeof id === 'string') : [];
  const emergency = Array.isArray(specialist?.emergency) ? specialist.emergency.filter((id): id is string => typeof id === 'string') : [];
  const all = [...regular, ...emergency];
  if (all.length === 0) return {hasClaude: false, reviewerProfileIds: [], accountByProfileId: {}};
  const profiles = (await pool.query(
    `SELECT p.id::text AS id, p.model, a.provider, p.account_id::text AS account_id
     FROM ac_profiles p
     JOIN ac_accounts a ON a.id=p.account_id
     WHERE p.id = ANY($1::uuid[])`,
    [all],
  )).rows as SpecialistProfileRow[];
  const byId = new Map(profiles.map(item => [item.id, item]));
  const isClaude = (id: string) => byId.get(id)?.provider === 'claude';
  const claudeRegular = regular.filter(isClaude);
  const claudeEmergency = emergency.filter(isClaude);
  const accountByProfileId: Record<string, string> = {};
  for (const item of profiles) {
    if (typeof item.account_id === 'string' && item.account_id.length > 0) accountByProfileId[item.id] = item.account_id;
  }
  return {
    hasClaude: claudeRegular.length > 0 || claudeEmergency.length > 0,
    createProfileId: claudeRegular.find(id => byId.get(id)?.model === 'claude-opus-5-5'),
    examinerProfileId: claudeRegular.find(id => byId.get(id)?.model !== 'claude-opus-5-5'),
    reviewerProfileIds: claudeEmergency,
    accountByProfileId,
  };
}

function uniqueReservationIds(...groups: (string | readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    const list = typeof group === 'string' ? [group] : group;
    for (const id of list) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function readSpecialistExamSeat(ledger: Ledger, grant: Grant): Promise<SpecialistExamSeat> {
  const row = (await ledger.pool.query<{provider: string; model: string}>(
    'SELECT a.provider, p.model FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id WHERE g.id=$1',
    [grant.id],
  )).rows[0];
  if (!row?.provider || !row.model || !grant.account_id || !grant.profile_id) throw new Refusal('GRANT_FORBIDDEN', 403);
  return {
    provider: String(row.provider),
    model: String(row.model),
    accountId: grant.account_id,
    profileId: grant.profile_id,
    grantId: grant.id,
  };
}

async function acceptReservedSeat(input: {
  ledger: Ledger;
  grant: Grant;
  purpose: 'create' | 'examiner' | 'reviewer';
  releaseGrant: (grantId: string) => Promise<void>;
}): Promise<SpecialistExamSeat> {
  try {
    const seat = await readSpecialistExamSeat(input.ledger, input.grant);
    if (input.purpose === 'reviewer') {
      if (seat.provider !== 'claude') throw new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409);
      return seat;
    }
    return acceptClaudeExamSeat(seat);
  } catch (error) {
    try {
      await input.releaseGrant(input.grant.id);
    } catch {
      // Preserve the original validation or lookup failure after attempting cleanup.
    }
    throw error;
  }
}

/** Reserves a Claude `specialist` profile for read-only exams (and create), keeping the reviewer on a distinct profile. */
export async function reserveSpecialistExamSeat(input: {
  capacity: Capacity;
  ledger: Ledger;
  principal: string;
  authority: Authority;
  intentId: string;
  purpose: 'create' | 'examiner' | 'reviewer';
  avoidProfileId?: string;
  avoidProfileIds?: readonly string[];
  avoidAccountId?: string;
  avoidAccountIds?: readonly string[];
  releaseGrant: (grantId: string) => Promise<void>;
}): Promise<SpecialistExamSeat> {
  const plan = await loadSpecialistExamPlan(input.ledger.pool, input.authority.contextId);
  if (input.purpose === 'reviewer') {
    const avoidProfiles = uniqueReservationIds(input.avoidProfileId, input.avoidProfileIds).slice(0, 20);
    const avoidAccounts = uniqueReservationIds(input.avoidAccountId, input.avoidAccountIds).slice(0, 8);
    const avoidProfileSet = new Set(avoidProfiles);
    const avoidAccountSet = new Set(avoidAccounts);
    const candidateReviewers = plan.reviewerProfileIds.filter(id => !avoidProfileSet.has(id));
    const orderedReviewers = [
      ...candidateReviewers.filter(id => {
        const accountId = plan.accountByProfileId[id];
        return accountId !== undefined && !avoidAccountSet.has(accountId);
      }),
      ...candidateReviewers.filter(id => {
        const accountId = plan.accountByProfileId[id];
        return accountId === undefined || avoidAccountSet.has(accountId);
      }),
    ];
    const preferredProfileId = orderedReviewers[0];
    const preferredProfiles = orderedReviewers.length > 1 ? orderedReviewers.slice(0, 20) : undefined;
    let grant: Grant;
    try {
      grant = await input.capacity.reserve(input.principal, {
        attemptId: randomUUID(),
        intentId: input.intentId,
        contextId: input.authority.contextId,
        role: 'specialist',
        provider: 'claude',
        ...(preferredProfileId ? {preferredProfileId} : {}),
        ...(preferredProfiles ? {preferredProfiles} : {}),
        ...(avoidProfiles.length ? {avoidProfiles} : {}),
        ...(avoidAccounts.length ? {avoidAccounts} : {}),
      }, input.authority);
    } catch (error) {
      if (error instanceof Refusal && (error.code === 'NO_ELIGIBLE_CAPACITY' || error.code === 'ROLE_NOT_CONFIGURED')) {
        throw new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409);
      }
      throw error;
    }
    return acceptReservedSeat({ledger: input.ledger, grant, purpose: 'reviewer', releaseGrant: input.releaseGrant});
  }
  const preferredProfileId = input.purpose === 'create' ? plan.createProfileId : plan.examinerProfileId;
  const grant = await input.capacity.reserve(input.principal, {
    attemptId: randomUUID(),
    intentId: input.intentId,
    contextId: input.authority.contextId,
    role: 'specialist',
    ...(plan.hasClaude ? {provider: 'claude'} : {}),
    ...(preferredProfileId ? {preferredProfileId} : {}),
  }, input.authority);
  return acceptReservedSeat({ledger: input.ledger, grant, purpose: input.purpose, releaseGrant: input.releaseGrant});
}
