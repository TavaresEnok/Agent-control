import {z} from 'zod'

/** Closed reasons already stored by Capacity. This module only labels them. */
export const CAPACITY_EXCLUSION_REASONS = [
  'profile_missing',
  'access_removed',
  'account_disabled',
  'profile_disabled',
  'not_synthetic',
  'ineligible',
  'quota_exhausted',
  'quota_unknown',
  'quota_rate_limited',
  'authentication_required',
  'provider_unreachable',
  'provider_configuration_error',
  'quota_disabled',
] as const
export type CapacityExclusionReason = (typeof CAPACITY_EXCLUSION_REASONS)[number]

const exclusionSchema = z.object({
  profileId: z.string().uuid(),
  reason: z.enum(CAPACITY_EXCLUSION_REASONS),
}).strict()
export type CapacityWaitExclusion = z.infer<typeof exclusionSchema>

export const EXCLUSION_TEXT: Record<CapacityExclusionReason, string> = {
  profile_missing: 'Perfil removido',
  access_removed: 'Acesso ao projeto removido',
  account_disabled: 'Conta desativada',
  profile_disabled: 'Perfil desativado',
  not_synthetic: 'Conta fora do modo sintético',
  ineligible: 'Inelegível para o plano ou modo',
  quota_exhausted: 'Cota esgotada',
  quota_unknown: 'Cota desconhecida',
  quota_rate_limited: 'Limite temporário de requisições',
  authentication_required: 'Autenticação necessária',
  provider_unreachable: 'Provedor indisponível ou sem conexão',
  provider_configuration_error: 'Configuração do provedor inválida',
  quota_disabled: 'Fonte de cota desabilitada',
}

/** A missing or invalid list is omitted. It is not turned into a reason. */
export function acceptedCapacityExclusions(value: unknown): CapacityWaitExclusion[] | undefined {
  if (value == null) return undefined
  const parsed = z.array(exclusionSchema).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function sanitizeCapacityWait(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = {...(value as Record<string, unknown>)}
  if (!Object.hasOwn(row, 'exclusions')) return row
  const exclusions = acceptedCapacityExclusions(row.exclusions)
  if (exclusions) row.exclusions = exclusions
  else delete row.exclusions
  return row
}

const waitBase = {
  attempt_id: z.string(),
  role: z.string(),
  reason: z.string().nullable(),
  exclusions: z.array(exclusionSchema).optional(),
}
export const capacityWaitSchema = z.preprocess(sanitizeCapacityWait, z.discriminatedUnion('resource_kind', [
  z.object({...waitBase, resource_kind: z.literal('model'), desired_profile: z.string().uuid().nullable()}),
  z.object({...waitBase, resource_kind: z.literal('local_compositor'), desired_profile: z.null()}),
]))
export type CapacityWait = z.infer<typeof capacityWaitSchema>

export type VisibleProfile = {id: string; account_id: string; model: string; effort: string}
export type VisibleAccount = {id: string; label: string}

/** Label only when this authorized view already has the profile. Otherwise a short id. */
export function capacityExclusionIdentity(
  profileId: string,
  profiles: readonly VisibleProfile[],
  accounts: readonly VisibleAccount[],
): {label: string | null; safeId: string} {
  const safeId = profileId.slice(0, 8)
  const profile = profiles.find(item => item.id === profileId)
  if (!profile) return {label: null, safeId}
  const account = accounts.find(item => item.id === profile.account_id)
  const detail = `${profile.model} · ${profile.effort}`
  return {label: account ? `${account.label} · ${detail}` : detail, safeId}
}

/** Same headline the cockpit already used for queue, saturation and local composition. */
export function capacityWaitSummary(wait: {resource_kind: string; role: string; reason: string | null}): string {
  const subject = wait.resource_kind === 'local_compositor' ? 'Composição determinística local' : wait.role
  const state = wait.reason === 'CAPACITY_BUSY'
    ? 'Aguardando vaga'
    : wait.reason === 'CAPACITY_QUEUED'
      ? 'Aguardando sua vez'
      : wait.resource_kind === 'local_compositor'
        ? 'Aguardando capacidade local'
        : 'Nenhum perfil elegível disponível'
  return `${subject} · ${state}`
}

function showExclusions(wait: CapacityWait): wait is CapacityWait & {exclusions: CapacityWaitExclusion[]} {
  return wait.resource_kind === 'model'
    && wait.reason !== 'CAPACITY_BUSY'
    && wait.reason !== 'CAPACITY_QUEUED'
    && !!wait.exclusions
    && wait.exclusions.length > 0
}

export function AgentControlCapacityWaits({
  waits,
  profiles,
  accounts,
}: {
  waits: readonly CapacityWait[]
  profiles: readonly VisibleProfile[]
  accounts: readonly VisibleAccount[]
}) {
  return (
    <ul className="flex flex-col gap-2">
      {waits.map(wait => (
        <li key={wait.attempt_id} className="break-words rounded-md border p-3" data-slot="capacity-wait" data-attempt={wait.attempt_id}>
          {capacityWaitSummary(wait)}
          {showExclusions(wait) && (
            <ol data-slot="capacity-wait-exclusions">
              {wait.exclusions.map((item, index) => {
                const identity = capacityExclusionIdentity(item.profileId, profiles, accounts)
                const who = identity.label ?? `Perfil indisponível neste projeto (${identity.safeId})`
                return (
                  <li key={`${item.profileId}-${index}`} data-reason={item.reason}>
                    {who} · {EXCLUSION_TEXT[item.reason]}
                  </li>
                )
              })}
            </ol>
          )}
        </li>
      ))}
    </ul>
  )
}
