import {randomUUID} from 'node:crypto';
import type {Capacity, ReservedSeatGrant} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';

const MAX_AVOID_PROFILES = 20;
const MAX_AVOID_EXAMINER_ACCOUNTS = 20;
const MAX_AVOID_REVIEWER_ACCOUNTS = 8;
const MAX_PREPARED_PROFILES = 20;
const MAX_RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 15;

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

function isPermanentReleaseError(error: unknown): boolean {
  return error instanceof Refusal || (error instanceof Error && error.name === 'ZodError');
}

async function releaseReservedGrant(
  releaseGrant: (grantId: string) => Promise<void>,
  grantId: string,
  originalError: unknown,
): Promise<never> {
  let lastReleaseError: unknown;
  for (let attempt = 1; attempt <= MAX_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await releaseGrant(grantId);
      lastReleaseError = undefined;
      break;
    } catch (releaseError) {
      lastReleaseError = releaseError;
      if (isPermanentReleaseError(releaseError) || attempt >= MAX_RELEASE_ATTEMPTS) {
        throw new AggregateError([originalError, lastReleaseError], 'EXAM_SEAT_RELEASE_FAILED');
      }
      await new Promise(resolve => setTimeout(resolve, RELEASE_RETRY_DELAY_MS * attempt));
    }
  }
  throw originalError;
}

function seatFromReservedGrant(reserved: ReservedSeatGrant): SpecialistExamSeat {
  if (!reserved.provider || !reserved.model || !reserved.grant.account_id || !reserved.grant.profile_id) {
    throw new Refusal('GRANT_FORBIDDEN', 403);
  }
  return {
    provider: reserved.provider,
    model: reserved.model,
    accountId: reserved.grant.account_id,
    profileId: reserved.grant.profile_id,
    grantId: reserved.grant.id,
  };
}

async function acceptReservedSeat(input: {
  reserved: ReservedSeatGrant;
  purpose: 'create' | 'examiner' | 'reviewer';
  releaseGrant: (grantId: string) => Promise<void>;
}): Promise<SpecialistExamSeat> {
  try {
    const seat = seatFromReservedGrant(input.reserved);
    if (input.purpose === 'reviewer') {
      if (seat.provider !== 'claude') throw new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409);
      return seat;
    }
    return acceptClaudeExamSeat(seat);
  } catch (error) {
    return releaseReservedGrant(input.releaseGrant, input.reserved.grant.id, error);
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
  allowedAccounts?: readonly string[];
  avoidProfileId?: string;
  avoidProfileIds?: readonly string[];
  avoidAccountId?: string;
  avoidAccountIds?: readonly string[];
  avoidReviewerAccountIds?: readonly string[];
  releaseGrant: (grantId: string) => Promise<void>;
}): Promise<SpecialistExamSeat> {
  const avoidProfiles = uniqueReservationIds(input.avoidProfileId, input.avoidProfileIds);
  if (avoidProfiles.length > MAX_AVOID_PROFILES) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
  const avoidExaminerAccounts = uniqueReservationIds(input.avoidAccountId, input.avoidAccountIds);
  if (avoidExaminerAccounts.length > MAX_AVOID_EXAMINER_ACCOUNTS) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
  const avoidReviewerAccounts = uniqueReservationIds(input.avoidReviewerAccountIds);
  if (avoidReviewerAccounts.length > MAX_AVOID_REVIEWER_ACCOUNTS) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);

  const plan = await loadSpecialistExamPlan(input.ledger.pool, input.authority.contextId);
  if (input.purpose === 'reviewer') {
    const avoidProfileSet = new Set(avoidProfiles);
    const avoidExaminerSet = new Set(avoidExaminerAccounts);
    const avoidReviewerSet = new Set(avoidReviewerAccounts);
    const candidateReviewers = plan.reviewerProfileIds.filter(id => !avoidProfileSet.has(id));
    if (candidateReviewers.length > MAX_PREPARED_PROFILES) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
    const orderedReviewers = [
      ...candidateReviewers.filter(id => {
        const accountId = plan.accountByProfileId[id];
        return accountId !== undefined && !avoidReviewerSet.has(accountId) && !avoidExaminerSet.has(accountId);
      }),
      ...candidateReviewers.filter(id => {
        const accountId = plan.accountByProfileId[id];
        return accountId !== undefined && !avoidReviewerSet.has(accountId) && avoidExaminerSet.has(accountId);
      }),
      ...candidateReviewers.filter(id => {
        const accountId = plan.accountByProfileId[id];
        return accountId === undefined || avoidReviewerSet.has(accountId);
      }),
    ];
    let reserved: ReservedSeatGrant;
    try {
      reserved = await input.capacity.reserveWithSeat(input.principal, {
        attemptId: randomUUID(),
        intentId: input.intentId,
        contextId: input.authority.contextId,
        role: 'specialist',
        provider: 'claude',
        ...(input.allowedAccounts ? {allowedAccounts: [...input.allowedAccounts]} : {}),
        examReviewer: {
          preparedProfiles: orderedReviewers,
          ...(avoidExaminerAccounts.length ? {avoidExaminerAccounts} : {}),
        },
        ...(avoidProfiles.length ? {avoidProfiles} : {}),
        ...(avoidReviewerAccounts.length ? {avoidAccounts: avoidReviewerAccounts} : {}),
      }, input.authority);
    } catch (error) {
      if (error instanceof Refusal && (error.code === 'NO_ELIGIBLE_CAPACITY' || error.code === 'ROLE_NOT_CONFIGURED')) {
        throw new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409);
      }
      throw error;
    }
    return acceptReservedSeat({reserved, purpose: 'reviewer', releaseGrant: input.releaseGrant});
  }
  const preferredProfileId = input.purpose === 'create' ? plan.createProfileId : plan.examinerProfileId;
  const reserved = await input.capacity.reserveWithSeat(input.principal, {
    attemptId: randomUUID(),
    intentId: input.intentId,
    contextId: input.authority.contextId,
    role: 'specialist',
    ...(plan.hasClaude || input.allowedAccounts ? {provider: 'claude'} : {}),
    ...(input.allowedAccounts ? {allowedAccounts: [...input.allowedAccounts]} : {}),
    ...(preferredProfileId ? {preferredProfileId} : {}),
  }, input.authority);
  return acceptReservedSeat({reserved, purpose: input.purpose, releaseGrant: input.releaseGrant});
}
