import {randomUUID} from 'node:crypto';
import type {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {DesignReserveOptions, DesignSeat} from './design-examine.ts';
import type {Ledger} from './ledger.ts';
import type {PoolClient} from 'pg';

type DesignPurpose = NonNullable<DesignReserveOptions['purpose']>;

/**
 * The project restriction recorded in a design grant, or undefined when the project has none. Without it the launch
 * check resolves the priority account exactly as before, so a priority change between reservation and launch refuses.
 */
export function designGrantProjectAccounts(selection: unknown): string[] | undefined {
  const value = (selection as {projectAllowedAccounts?: unknown} | null | undefined)?.projectAllowedAccounts;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id: unknown): id is string => typeof id === 'string');
}

/** A preparação coloca a conta Claude prioritária no início da cadeia regular. */
export async function requiredDesignProfile(
  db: Pick<PoolClient, 'query'>,
  contextId: string,
  purpose: DesignPurpose,
  allowedAccountIds?: readonly string[],
) {
  if (allowedAccountIds !== undefined && allowedAccountIds.length === 0) {
    throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
  }
  const model = 'claude-opus-5-5';
  const effort = purpose === 'reviewer' ? 'medium' : 'high';
  const profiles = await db.query<{id: string; account: string; model: string; effort: string; enabled: boolean; regular: boolean}>(`
    SELECT p.id, p.account_id AS account, p.model, p.effort, p.enabled AND EXISTS (
      SELECT 1 FROM ac_model_catalog m WHERE m.provider = 'claude' AND m.model = p.model
        AND p.effort = ANY(m.efforts) AND 'specialist' = ANY(m.roles)
    ) AS enabled, chain.regular
    FROM ac_contexts c
    JOIN ac_policy_revisions r ON r.project_id=c.project_id AND r.revision=c.capacity_policy_revision
    CROSS JOIN LATERAL (VALUES
      (true, r.snapshot->'roles'->'specialist'->'regular'),
      (false, r.snapshot->'roles'->'specialist'->'emergency')
    ) AS chain(regular, ids)
    CROSS JOIN LATERAL jsonb_array_elements_text(chain.ids)
      WITH ORDINALITY AS member(id, position)
    JOIN ac_profiles p ON p.id=member.id::uuid
    JOIN ac_accounts a ON a.id=p.account_id AND a.provider='claude'
    WHERE c.id=$1 ORDER BY chain.regular DESC, member.position`, [contextId]);
  const allowedSet = allowedAccountIds ? new Set(allowedAccountIds) : undefined;
  const eligibleRows = allowedSet ? profiles.rows.filter(row => allowedSet.has(row.account)) : profiles.rows;
  if (allowedSet && eligibleRows.length === 0) {
    throw new Refusal('PROJECT_ACCOUNTS_UNAVAILABLE', 409);
  }
  const primary = eligibleRows.find(row => row.regular)?.account ?? (allowedSet ? eligibleRows[0]?.account : undefined);
  const profile = eligibleRows.find(row => row.account === primary && row.model === model && row.effort === effort && row.enabled && (row.regular || purpose === 'reviewer'));
  if (!profile) throw new Refusal(purpose === 'reviewer' ? 'DESIGN_REVIEWER_UNAVAILABLE' : 'DESIGN_CREATE_MODEL_UNAVAILABLE', 409);

  return profile;
}

export async function reserveDesignModel(
  ledger: Ledger,
  capacity: Capacity,
  principal: string,
  authority: Authority,
  intentId: string,
  purpose: DesignPurpose,
  allowedAccountIds?: readonly string[],
): Promise<DesignSeat> {
  const profile = await requiredDesignProfile(ledger.pool, authority.contextId, purpose, allowedAccountIds);
  const seat = await capacity.reserveWithSeat(principal, {
    attemptId: randomUUID(), intentId, contextId: authority.contextId, role: 'specialist',
    provider: 'claude', requiredProfileId: profile.id, designPurpose: purpose, allowedAccounts: [profile.account],
    ...(allowedAccountIds ? {projectAllowedAccounts: [...allowedAccountIds]} : {}),
  }, authority);
  if (
    seat.grant.profile_id !== profile.id
    || seat.grant.account_id !== profile.account
    || seat.model !== profile.model
    || seat.provider !== 'claude'
    || (allowedAccountIds && !allowedAccountIds.includes(seat.grant.account_id))
  ) {
    await capacity.transition(principal, seat.grant.id, authority, 'released', {processId: seat.grant.id, state: 'not_started'});
    throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  }
  return {provider: seat.provider, model: seat.model, accountId: profile.account, profileId: profile.id,
    grantId: seat.grant.id, grantRole: 'specialist'};
}
