import {randomUUID} from 'node:crypto';
import type {Capacity, ReservedSeatGrant} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {Ledger, VerificationModule} from './ledger.ts';

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
export type SpecialistProfileDetail = {
  id: string;
  provider: string;
  model: string;
  effort: string;
  accountId: string;
  chain: 'regular' | 'emergency';
};
export type SpecialistExamPlan = {
  hasClaude: boolean;
  primaryClaudeAccountId?: string;
  createProfileId?: string;
  examinerProfileId?: string;
  reviewerProfileIds: string[];
  accountByProfileId: Record<string, string>;
  profiles: SpecialistProfileDetail[];
};

const MODULE_EXAMINER_EFFORT: Record<VerificationModule, 'medium' | 'high'> = {
  qa: 'medium',
  arquitetura: 'medium',
  dependencias: 'medium',
  banco: 'high',
  prontidao: 'medium',
  desempenho: 'medium',
  documentacao: 'medium',
  conformidade: 'high',
};

/** Passive quality exam model and effort per functional module (2 to 9). */
export function moduleExaminerRequirement(module: VerificationModule): {
  provider: 'claude';
  model: 'claude-sonnet-5-5';
  effort: 'medium' | 'high';
} {
  return {
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    effort: MODULE_EXAMINER_EFFORT[module],
  };
}

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
  allowedAccountIds?: readonly string[],
): ExamReservationChoice {
  if (seat.provider !== 'claude') return {kind: 'skip', accountId: seat.accountId};
  if (allowedAccountIds && !allowedAccountIds.includes(seat.accountId)) {
    return {kind: 'skip', accountId: seat.accountId};
  }
  const accepted = acceptClaudeExamSeat(seat);
  const canAvoid = !allowedAccountIds || allowedAccountIds.some(id => !avoidAccountIds?.includes(id));
  if (canAvoid && avoidAccountIds?.includes(accepted.accountId) && attempt < 3) {
    return {kind: 'hold', accountId: accepted.accountId, seat: accepted};
  }
  return {kind: 'use', seat: accepted};
}

type PolicySnapshotRow = {snapshot?: {roles?: {specialist?: {regular?: unknown; emergency?: unknown}}}};
type SpecialistProfileRow = {id: string; model: string; effort?: string; provider: string; account_id?: string};

/**
 * The priority Claude account is the account of the first Claude profile in the raw policy
 * order (regular, then emergency). Profiles of other providers may come before it. A policy
 * entry whose profile or account cannot be resolved before that point leaves no priority
 * account, so callers that require it refuse instead of moving on to a later Claude account.
 * When `allowedAccounts` is set, only Claude accounts in that set are eligible.
 */
function firstClaudeAccountInPolicy(
  order: readonly string[],
  byId: ReadonlyMap<string, SpecialistProfileRow>,
  allowedAccounts?: ReadonlySet<string>,
): string | undefined {
  for (const id of order) {
    const item = byId.get(id);
    if (!item || typeof item.provider !== 'string') return undefined;
    if (item.provider !== 'claude') continue;
    if (typeof item.account_id !== 'string' || item.account_id.length === 0) return undefined;
    if (allowedAccounts && !allowedAccounts.has(item.account_id)) continue;
    return item.account_id;
  }
  return undefined;
}

/** Inspects the active policy's `roles.specialist` chain so exams pick the prepared seats without touching `roles.reviewer`. */
export async function loadSpecialistExamPlan(
  pool: {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>},
  contextId: string,
  allowedAccounts?: readonly string[],
): Promise<SpecialistExamPlan> {
  const row = (await pool.query(
    `SELECT r.snapshot
     FROM ac_contexts x
     JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision
     WHERE x.id=$1`,
    [contextId],
  )).rows[0] as PolicySnapshotRow | undefined;
  return specialistExamPlanFrom(pool, row, allowedAccounts);
}

/** The plan of an immutable policy revision, such as the one a grant was reserved under. */
export async function loadSpecialistExamPlanAtRevision(
  pool: {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>},
  projectId: string,
  revision: number,
  allowedAccounts?: readonly string[],
): Promise<SpecialistExamPlan> {
  const row = (await pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',
    [projectId, revision])).rows[0] as PolicySnapshotRow | undefined;
  return specialistExamPlanFrom(pool, row, allowedAccounts);
}

async function specialistExamPlanFrom(
  pool: {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>},
  row: PolicySnapshotRow | undefined,
  allowedAccounts?: readonly string[],
): Promise<SpecialistExamPlan> {
  const specialist = row?.snapshot?.roles?.specialist;
  const regular = Array.isArray(specialist?.regular) ? specialist.regular.filter((id): id is string => typeof id === 'string') : [];
  const emergency = Array.isArray(specialist?.emergency) ? specialist.emergency.filter((id): id is string => typeof id === 'string') : [];
  const all = [...regular, ...emergency];
  if (all.length === 0) return {hasClaude: false, reviewerProfileIds: [], accountByProfileId: {}, profiles: []};
  const profiles = (await pool.query(
    `SELECT p.id::text AS id, p.model, p.effort, a.provider, p.account_id::text AS account_id
     FROM ac_profiles p
     JOIN ac_accounts a ON a.id=p.account_id
     WHERE p.id = ANY($1::uuid[])`,
    [all],
  )).rows as SpecialistProfileRow[];
  const byId = new Map(profiles.map(item => [item.id, item]));
  const allowedSet = allowedAccounts ? new Set(allowedAccounts) : undefined;
  const isClaude = (id: string) => {
    const item = byId.get(id);
    return item?.provider === 'claude' && (!allowedSet || (typeof item.account_id === 'string' && allowedSet.has(item.account_id)));
  };
  const claudeRegular = regular.filter(isClaude);
  const claudeEmergency = emergency.filter(isClaude);
  const accountByProfileId: Record<string, string> = {};
  for (const item of profiles) {
    if (typeof item.account_id === 'string' && item.account_id.length > 0) accountByProfileId[item.id] = item.account_id;
  }
  const primaryClaudeAccountId = firstClaudeAccountInPolicy(all, byId, allowedSet);
  const orderedProfiles: SpecialistProfileDetail[] = [];
  for (const [chain, list] of [['regular', regular], ['emergency', emergency]] as const) {
    for (const id of list) {
      const item = byId.get(id);
      const accountId = accountByProfileId[id];
      if (!item || !accountId) continue;
      orderedProfiles.push({
        id,
        provider: item.provider,
        model: item.model,
        effort: item.effort ?? '',
        accountId,
        chain,
      });
    }
  }
  return {
    hasClaude: claudeRegular.length > 0 || claudeEmergency.length > 0,
    ...(primaryClaudeAccountId ? {primaryClaudeAccountId} : {}),
    createProfileId: claudeRegular.find(id => byId.get(id)?.model === 'claude-opus-5-5'),
    examinerProfileId: claudeRegular.find(id => byId.get(id)?.model !== 'claude-opus-5-5'),
    reviewerProfileIds: claudeEmergency,
    accountByProfileId,
    profiles: orderedProfiles,
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
  /** Active runtime Claude accounts when passed separately from project `allowedAccountIds`. */
  runtimeAccounts?: readonly string[];
  /** Explicit project `allowedAccountIds` restriction when `allowedAccounts` carries runtime accounts. */
  projectAllowedAccounts?: readonly string[];
  avoidProfileId?: string;
  avoidProfileIds?: readonly string[];
  avoidAccountId?: string;
  avoidAccountIds?: readonly string[];
  avoidReviewerAccountIds?: readonly string[];
  requiredModel?: string;
  requiredEffort?: string;
  firstAccountOnly?: boolean;
  allowSameAccount?: boolean;
  preferEmergencyFirst?: boolean;
  unavailableCode?: string;
  releaseGrant: (grantId: string) => Promise<void>;
}): Promise<SpecialistExamSeat> {
  const avoidProfiles = uniqueReservationIds(input.avoidProfileId, input.avoidProfileIds);
  if (avoidProfiles.length > MAX_AVOID_PROFILES) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
  const avoidExaminerAccounts = uniqueReservationIds(input.avoidAccountId, input.avoidAccountIds);
  if (avoidExaminerAccounts.length > MAX_AVOID_EXAMINER_ACCOUNTS) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
  const avoidReviewerAccounts = uniqueReservationIds(input.avoidReviewerAccountIds);
  if (avoidReviewerAccounts.length > MAX_AVOID_REVIEWER_ACCOUNTS) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);

  const projectRestriction = input.projectAllowedAccounts
    ?? (input.runtimeAccounts === undefined ? input.allowedAccounts : undefined);
  const runtimeRestriction = input.runtimeAccounts
    ?? (input.projectAllowedAccounts !== undefined ? input.allowedAccounts : undefined);

  if (projectRestriction !== undefined) {
    if (projectRestriction.length === 0) throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
    if (runtimeRestriction !== undefined) {
      const runtimeSet = new Set(runtimeRestriction);
      if (!projectRestriction.some(id => runtimeSet.has(id))) {
        throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
      }
    }
  }
  const effectiveAllowed = projectRestriction !== undefined && runtimeRestriction !== undefined
    ? projectRestriction.filter(id => runtimeRestriction.includes(id))
    : projectRestriction !== undefined
      ? [...projectRestriction]
      : runtimeRestriction !== undefined
        ? [...runtimeRestriction]
        : undefined;
  if (effectiveAllowed !== undefined && effectiveAllowed.length === 0) {
    throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
  }

  const plan = await loadSpecialistExamPlan(
    input.ledger.pool,
    input.authority.contextId,
    projectRestriction !== undefined ? effectiveAllowed : undefined,
  );
  if (
    projectRestriction !== undefined
    && plan.profiles.some(p => p.provider === 'claude')
    && !plan.hasClaude
  ) {
    throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
  }

  if (input.requiredModel !== undefined || input.requiredEffort !== undefined || input.firstAccountOnly) {
    const unavailableCode = input.unavailableCode
      ?? (input.purpose === 'reviewer' ? 'DESIGN_REVIEWER_UNAVAILABLE' : 'MODULE_EXAM_EXAMINER_UNAVAILABLE');
    const primaryAccountId = plan.primaryClaudeAccountId;
    if (input.firstAccountOnly) {
      if (!primaryAccountId) throw new Refusal(unavailableCode, 409);
      if (effectiveAllowed && !effectiveAllowed.includes(primaryAccountId)) {
        throw new Refusal(unavailableCode, 409);
      }
    }
    const targetAccounts = input.firstAccountOnly && primaryAccountId
      ? [primaryAccountId]
      : effectiveAllowed;
    const ordered = input.preferEmergencyFirst
      ? [...plan.profiles.filter(p => p.chain === 'emergency'), ...plan.profiles.filter(p => p.chain === 'regular')]
      : plan.profiles;
    const avoidProfileSet = new Set(avoidProfiles);
    const matching = ordered.filter(p =>
      p.provider === 'claude'
      && (!targetAccounts || targetAccounts.includes(p.accountId))
      && (input.requiredModel === undefined || p.model === input.requiredModel)
      && (input.requiredEffort === undefined || p.effort === input.requiredEffort)
      && !avoidProfileSet.has(p.id),
    );
    if (matching.length === 0) throw new Refusal(unavailableCode, 409);
    const matchingIds = new Set(matching.map(p => p.id));
    const nonMatchingOnTarget = plan.profiles
      .filter(p => (!targetAccounts || targetAccounts.includes(p.accountId)) && !matchingIds.has(p.id))
      .map(p => p.id);
    const combinedAvoidProfiles = uniqueReservationIds(avoidProfiles, nonMatchingOnTarget).slice(0, MAX_AVOID_PROFILES);
    let reserved: ReservedSeatGrant;
    try {
      reserved = await input.capacity.reserveWithSeat(input.principal, {
        attemptId: randomUUID(),
        intentId: input.intentId,
        contextId: input.authority.contextId,
        role: 'specialist',
        provider: 'claude',
        ...(targetAccounts ? {allowedAccounts: targetAccounts} : {}),
        preferredProfileId: matching[0]!.id,
        ...(combinedAvoidProfiles.length ? {avoidProfiles: combinedAvoidProfiles} : {}),
        ...(!input.allowSameAccount && avoidReviewerAccounts.length ? {avoidAccounts: avoidReviewerAccounts} : {}),
      }, input.authority);
    } catch (error) {
      if (
        input.purpose === 'reviewer'
        && error instanceof Refusal
        && (error.code === 'NO_ELIGIBLE_CAPACITY' || error.code === 'ROLE_NOT_CONFIGURED')
      ) {
        throw new Refusal(unavailableCode, 409);
      }
      throw error;
    }
    const seat = await acceptReservedSeat({reserved, purpose: input.purpose, releaseGrant: input.releaseGrant});
    if (
      seat.provider !== 'claude'
      || (input.requiredModel !== undefined && seat.model !== input.requiredModel)
      || (targetAccounts && !targetAccounts.includes(seat.accountId))
      || !matchingIds.has(seat.profileId)
    ) {
      return releaseReservedGrant(input.releaseGrant, seat.grantId, new Refusal(unavailableCode, 409));
    }
    return seat;
  }

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
        ...(effectiveAllowed ? {allowedAccounts: [...effectiveAllowed]} : {}),
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
    const seat = await acceptReservedSeat({reserved, purpose: 'reviewer', releaseGrant: input.releaseGrant});
    if (effectiveAllowed && !effectiveAllowed.includes(seat.accountId)) {
      return releaseReservedGrant(input.releaseGrant, seat.grantId, new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409));
    }
    return seat;
  }
  const preferredProfileId = input.purpose === 'create' ? plan.createProfileId : plan.examinerProfileId;
  const reserved = await input.capacity.reserveWithSeat(input.principal, {
    attemptId: randomUUID(),
    intentId: input.intentId,
    contextId: input.authority.contextId,
    role: 'specialist',
    ...(plan.hasClaude || effectiveAllowed ? {provider: 'claude'} : {}),
    ...(effectiveAllowed ? {allowedAccounts: [...effectiveAllowed]} : {}),
    ...(preferredProfileId ? {preferredProfileId} : {}),
  }, input.authority);
  const seat = await acceptReservedSeat({reserved, purpose: input.purpose, releaseGrant: input.releaseGrant});
  if (effectiveAllowed && !effectiveAllowed.includes(seat.accountId)) {
    return releaseReservedGrant(input.releaseGrant, seat.grantId, new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409));
  }
  return seat;
}
