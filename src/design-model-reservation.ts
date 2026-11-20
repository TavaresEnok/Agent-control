import {randomUUID} from 'node:crypto';
import type {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import type {DesignReserveOptions, DesignSeat} from './design-examine.ts';
import type {Ledger} from './ledger.ts';
import type {PoolClient} from 'pg';

type DesignPurpose = NonNullable<DesignReserveOptions['purpose']>;

/** A preparação coloca a conta Claude prioritária no início da cadeia regular. */
export async function requiredDesignProfile(db: Pick<PoolClient, 'query'>, contextId: string, purpose: DesignPurpose) {
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
  const primary = profiles.rows.find(row => row.regular)?.account;
  const profile = profiles.rows.find(row => row.account === primary && row.model === model && row.effort === effort && row.enabled && (row.regular || purpose === 'reviewer'));
  if (!profile) throw new Refusal(purpose === 'reviewer' ? 'DESIGN_REVIEWER_UNAVAILABLE' : 'DESIGN_CREATE_MODEL_UNAVAILABLE', 409);

  return profile;
}

export async function reserveDesignModel(
  ledger: Ledger, capacity: Capacity, principal: string, authority: Authority, intentId: string, purpose: DesignPurpose,
): Promise<DesignSeat> {
  const profile = await requiredDesignProfile(ledger.pool, authority.contextId, purpose);
  const seat = await capacity.reserveWithSeat(principal, {
    attemptId: randomUUID(), intentId, contextId: authority.contextId, role: 'specialist',
    provider: 'claude', requiredProfileId: profile.id, allowedAccounts: [profile.account],
  }, authority);
  if (seat.grant.profile_id !== profile.id || seat.grant.account_id !== profile.account || seat.model !== profile.model || seat.provider !== 'claude') {
    await capacity.transition(principal, seat.grant.id, authority, 'released', {processId: seat.grant.id, state: 'not_started'});
    throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  }
  return {provider: seat.provider, model: seat.model, accountId: profile.account, profileId: profile.id,
    grantId: seat.grant.id, grantRole: 'specialist'};
}
