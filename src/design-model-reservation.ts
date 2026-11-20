import {randomUUID} from 'node:crypto';
import type {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {DesignReserveOptions, DesignSeat} from './design-examine.ts';
import type {Ledger} from './ledger.ts';

/** A preparação coloca a conta Claude prioritária no início da cadeia regular. */
export async function reserveDesignModel(
  ledger: Ledger, capacity: Capacity, principal: string, authority: Authority,
  intentId: string, purpose: NonNullable<DesignReserveOptions['purpose']>,
): Promise<DesignSeat> {
  const model = 'claude-opus-5-5';
  const effort = purpose === 'reviewer' ? 'medium' : 'high';
  const profiles = await ledger.pool.query<{id: string; account: string; model: string; effort: string; enabled: boolean}>(`
    SELECT p.id, p.account_id AS account, p.model, p.effort, p.enabled
    FROM ac_contexts c
    JOIN ac_policy_revisions r ON r.project_id=c.project_id AND r.revision=c.capacity_policy_revision
    CROSS JOIN LATERAL jsonb_array_elements_text(r.snapshot->'roles'->'specialist'->'regular')
      WITH ORDINALITY AS member(id, position)
    JOIN ac_profiles p ON p.id=member.id::uuid
    JOIN ac_accounts a ON a.id=p.account_id AND a.provider='claude'
    WHERE c.id=$1 ORDER BY member.position`, [authority.contextId]);
  const primary = profiles.rows[0]?.account;
  const profile = profiles.rows.find(row => row.account === primary && row.model === model && row.effort === effort && row.enabled);
  if (!profile) throw new Refusal(purpose === 'reviewer' ? 'DESIGN_REVIEWER_UNAVAILABLE' : 'DESIGN_CREATE_MODEL_UNAVAILABLE', 409);

  const seat = await capacity.reserveWithSeat(principal, {
    attemptId: randomUUID(), intentId, contextId: authority.contextId, role: 'specialist',
    provider: 'claude', requiredProfileId: profile.id, allowedAccounts: [profile.account],
  }, authority);
  if (seat.grant.profile_id !== profile.id || seat.grant.account_id !== primary || seat.model !== model || seat.provider !== 'claude') {
    await capacity.transition(principal, seat.grant.id, authority, 'released', {processId: seat.grant.id, state: 'not_started'});
    throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  }
  return {provider: seat.provider, model: seat.model, accountId: profile.account, profileId: profile.id,
    grantId: seat.grant.id, grantRole: 'specialist'};
}
