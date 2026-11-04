/** Closed reasons a chain profile is skipped before any grant exists.
 * Quota observations are not an input this module writes. */
export const CAPACITY_EXCLUSION_REASONS = [
  'profile_missing',
  'access_removed',
  'account_disabled',
  'profile_disabled',
  'not_synthetic',
  'ineligible',
  'quota_exhausted',
  'quota_unknown',
] as const;
export type CapacityExclusionReason = (typeof CAPACITY_EXCLUSION_REASONS)[number];
export type ProfileExclusion = { profileId: string; reason: CapacityExclusionReason };

/** Facts already loaded for one chain profile. `freshQuotaStatus` is null when
 * the observation is missing or expired; an expired row is never exhausted. */
export type ChainProfileFacts = {
  profileId: string;
  profilePresent: boolean;
  projectAccess: boolean;
  mode: string | null;
  accountEnabled: boolean;
  profileEnabled: boolean;
  eligibility: string | null;
  freshQuotaStatus: string | null;
};

/** One reason, or null when this profile can take the reservation.
 * Precedence matches the reserve gates: identity and sharing, then synthetic
 * mode (a dormant provider account is also disabled), then enablement,
 * eligibility, then a fresh quota status. */
export function classifyProfileExclusion(facts: ChainProfileFacts): CapacityExclusionReason | null {
  if (!facts.profilePresent) return 'profile_missing';
  if (!facts.projectAccess) return 'access_removed';
  if (facts.mode !== 'synthetic') return 'not_synthetic';
  if (!facts.accountEnabled) return 'account_disabled';
  if (!facts.profileEnabled) return 'profile_disabled';
  if (facts.eligibility !== 'documented_supported') return 'ineligible';
  if (facts.freshQuotaStatus === 'available') return null;
  if (facts.freshQuotaStatus === 'exhausted') return 'quota_exhausted';
  return 'quota_unknown';
}

/** Chain order in, exclusion order out. A selectable profile is omitted. */
export function orderedProfileExclusions(chain: readonly ChainProfileFacts[]): ProfileExclusion[] {
  const exclusions: ProfileExclusion[] = [];
  for (const facts of chain) {
    const reason = classifyProfileExclusion(facts);
    if (reason) exclusions.push({ profileId: facts.profileId, reason });
  }
  return exclusions;
}
