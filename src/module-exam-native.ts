import {randomUUID} from 'node:crypto';
import {Capacity} from './capacity.ts';
import {Refusal, type Authority} from './contracts.ts';
import {releaseDesignGrant} from './design-command.ts';
import {reserveSpecialistExamSeat} from './exam-provider.ts';
import type {Ledger} from './ledger.ts';
import type {ModuleExamInput, ModuleExamSeat} from './module-exam.ts';

/** Uses the dedicated exam context and Capacity's project, profile and quota policy.
 * A reviewer is never silently downgraded to the examiner's provider. */
export function createModuleExamReservations(input: {
  ledger: Ledger; principal: string; authority: Authority; intentId: string;
  reviewerProviders: readonly string[];
}): Pick<Required<ModuleExamInput>, 'reserve'|'release'> {
  const capacity = new Capacity(input.ledger);
  const release = (seat: ModuleExamSeat, state: 'not_started'|'exited') =>
    releaseDesignGrant(input.ledger, input.principal, input.authority, seat.grantId, state);
  return {
    release,
    async reserve(purpose, avoid) {
      if (purpose === 'examiner') {
        const seat = await reserveSpecialistExamSeat({capacity, ledger: input.ledger, principal: input.principal,
          authority: input.authority, intentId: input.intentId, purpose: 'examiner',
          releaseGrant: grantId => releaseDesignGrant(input.ledger, input.principal, input.authority, grantId, 'not_started')});
        return {provider: seat.provider, model: seat.model, accountId: seat.accountId, profileId: seat.profileId, grantId: seat.grantId};
      }
      if (!avoid) throw new Refusal('MODULE_EXAM_EXAMINER_REQUIRED');
      const providers = [...new Set(input.reviewerProviders)].filter(provider => provider && provider !== avoid.provider);
      for (const provider of providers) {
        try {
          const seat = await capacity.reserveWithSeat(input.principal, {attemptId: randomUUID(), intentId: input.intentId,
            contextId: input.authority.contextId, role: 'specialist', provider, avoidProfiles: [avoid.profileId]}, input.authority);
          const result = {provider: seat.provider, model: seat.model, accountId: seat.grant.account_id, profileId: seat.grant.profile_id, grantId: seat.grant.id};
          if (result.provider === avoid.provider || result.profileId === avoid.profileId) {
            await release(result, 'not_started');
            throw new Refusal('MODULE_EXAM_PROVIDER_NOT_DISTINCT');
          }
          return result;
        } catch (error) {
          if (error instanceof Refusal && (error.code === 'NO_ELIGIBLE_CAPACITY' || error.code === 'ROLE_NOT_CONFIGURED')) continue;
          throw error;
        }
      }
      throw new Refusal('MODULE_EXAM_REVIEWER_UNAVAILABLE');
    },
  };
}
