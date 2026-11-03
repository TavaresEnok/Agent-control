import {z} from 'zod';
import {QuotaInput} from './capacity.ts';
import type {ProviderProbeResult} from './providers.ts';

/** Versioned, offline parsers for subscription CLI stdout.
 * They never spawn a process or open a network connection.
 * A document that is incomplete, truncated, from another parser version,
 * or carrying a key this version does not name is unknown — never available
 * or exhausted. Transport and authentication failures are not quota.
 *
 * Bound quota schemas, both read from upstream/cezar and not from a live CLI:
 * - codex-rate-limits-v1: one JSON-RPC line for account/rateLimits/read
 *   (codex-usage-probe.ts, usage-windows.ts, __fixtures__/codex/usage-metadata.mjs).
 * - claude-rate-limit-event-v1: one rate_limit_event line
 *   (usage-windows.ts, __fixtures__/claude/partial-messages.ndjson).
 * - grok-billing-report-v1: one allowlisted summary from native/grok-billing.py
 *   (normalize_billing, normalize_topup, subscription_configuration_safe).
 *   Not grok CLI stdout and not grok.subscription.status.
 * Antigravity stays unknown. agy 1.4.0 stream-json is turn usage
 * (__fixtures__/antigravity/README.md). gemini_usage.py stores health text
 * with windows: [] and does not report a remaining fraction. */
export const PROVIDER_COLLECTOR_PARSERS = {
  codex: 'codex-rate-limits-v1',
  claude: 'claude-rate-limit-event-v1',
  grok: 'grok-billing-report-v1',
  antigravity: 'antigravity-quota-unproven-v1',
} as const;
/** `bound` may yield available, exhausted or recovery. `unproven` never does. */
export const PROVIDER_QUOTA_SCHEMA = {
  codex: 'bound',
  claude: 'bound',
  grok: 'bound',
  antigravity: 'unproven',
} as const;
export type ProviderCollectorProvider = keyof typeof PROVIDER_COLLECTOR_PARSERS;
export type ProviderCollectorClass = 'available' | 'exhausted' | 'recovery' | 'unknown';
export const COLLECTOR_TTL = {available: 120, exhausted: 120, unknown: 30, max: 3600} as const;

const Providers = ['codex', 'claude', 'grok', 'antigravity'] as const;
const ParserId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);
const ObservedAt = z.iso.datetime({offset: true});
const StdoutCapture = z.object({
  kind: z.literal('stdout'), provider: z.enum(Providers), parserId: ParserId,
  exitCode: z.number().int().min(0).max(255), stdout: z.string().max(8192),
  observedAt: ObservedAt, truncated: z.boolean().optional(),
}).strict();
const TransportCapture = z.object({
  kind: z.literal('transport_error'), provider: z.enum(Providers), parserId: ParserId, observedAt: ObservedAt,
}).strict();
const AuthCapture = z.object({
  kind: z.literal('auth_error'), provider: z.enum(Providers), parserId: ParserId, observedAt: ObservedAt,
}).strict();
const Capture = z.discriminatedUnion('kind', [StdoutCapture, TransportCapture, AuthCapture]);

export type ProviderCollectorObservation = {
  schemaVersion: 1;
  provider: ProviderCollectorProvider | 'unspecified';
  parserId: string;
  class: ProviderCollectorClass;
  status: z.infer<typeof QuotaInput>['status'];
  source: string;
  ttlSeconds: number;
  remainingPercent: number | null;
  resetAt: string | null;
  failure: 'none' | 'transport' | 'auth' | 'invalid_response';
};

const precise = (max: number) => z.number().gte(0).lte(max).refine(value =>
  Number.isFinite(value) && Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-6, 'PRECISION');
/** Unix seconds only. Milliseconds are a different unit and stay unknown. */
const unixSeconds = z.number().int().gte(1_000_000_000).lte(8_640_000_000);
const unixOrNull = unixSeconds.nullable();
const CodexWindow = z.object({
  usedPercent: precise(100), resetsAt: unixOrNull, windowDurationMins: z.number().int().gte(1).lte(10080),
}).strict();
const CodexDocument = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  result: z.object({
    rateLimits: z.object({primary: CodexWindow, secondary: CodexWindow.nullable()}).strict(),
  }).strict(),
}).strict();
const ClaudeStatus = z.enum(['allowed', 'allowed_warning', 'rejected']);
const ClaudeWindow = z.object({
  utilization: precise(1), resetsAt: unixOrNull, status: ClaudeStatus.optional(),
}).strict();
const ClaudeDocument = z.object({
  type: z.literal('rate_limit_event'),
  uuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  rate_limit_info: z.object({
    status: ClaudeStatus, resetsAt: unixOrNull, rateLimitType: z.enum(['five_hour', 'seven_day']),
    overageStatus: ClaudeStatus, overageResetsAt: unixOrNull, isUsingOverage: z.boolean(),
    unifiedWindows: z.object({five_hour: ClaudeWindow, seven_day: ClaudeWindow}).strict(),
  }).strict(),
}).strict();
const GrokInstant = z.iso.datetime({offset: true});
const GrokTopupInterpretation = z.enum([
  'Official Option<AutoTopupRule>: no configured rule',
  'Official enabled bool defaults false when omitted',
]);
/** Success-path summary only. `authentication` is the status dict, never a token. */
const GrokReport = z.object({
  timestamp_utc: GrokInstant,
  inference_performed: z.literal(false),
  credentials_saved: z.boolean(),
  source: z.literal('https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs'),
  credential_source: z.enum(['grok_cli', 'opencode']),
  authentication: z.object({
    status: z.enum(['valid', 'native_cli_refreshed', 'concurrent_refresh', 'refreshed']),
    expires_at: unixSeconds,
  }).strict(),
  subscription_only_evidence: z.boolean(),
  results: z.object({
    billing: z.object({
      http_status: z.number().int().gte(100).lte(599),
      used_percent: precise(100),
      remaining_percent: precise(100),
      period_start: GrokInstant.nullable(),
      period_end: GrokInstant.nullable(),
      unified_billing: z.boolean(),
      prepaid_cents: z.number().int().nullable(),
      on_demand_cap_present: z.boolean(),
      on_demand_cap_cents: z.number().int().nullable(),
      on_demand_enabled: z.boolean().nullable(),
    }).strict(),
    auto_topup: z.object({
      http_status: z.number().int().gte(100).lte(599),
      has_rule: z.boolean(),
      enabled: z.boolean(),
      interpretation: GrokTopupInterpretation,
    }).strict(),
  }).strict(),
}).strict();
type Fact = {kind: ProviderCollectorClass; used: number; resetMs: number | null};
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const round4 = (value: number) => Math.round(value * 10000) / 10000;

function blank(provider: ProviderCollectorObservation['provider'], parserId: string, failure: ProviderCollectorObservation['failure']): ProviderCollectorObservation {
  return {schemaVersion: 1, provider, parserId, class: 'unknown', status: 'unknown', source: `collector:${parserId}`,
    ttlSeconds: COLLECTOR_TTL.unknown, remainingPercent: null, resetAt: null, failure};
}
function declared(raw: unknown): {provider: ProviderCollectorObservation['provider']; parserId: string} {
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const provider = Providers.find(item => item === record.provider) ?? 'unspecified';
  const parserId = typeof record.parserId === 'string' && ParserId.safeParse(record.parserId).success ? record.parserId : 'unspecified';
  return {provider, parserId};
}
function futureReset(resetsAt: number | null, observedAtMs: number): number | null {
  if (resetsAt === null) return null;
  const resetMs = resetsAt * 1000;
  return resetMs >= observedAtMs + 1000 && resetMs - observedAtMs <= HORIZON_MS ? resetMs : null;
}
/** `blocked` is an explicit quota fact. A stale reset, or a full window that is not blocked, is not. */
function fact(used: number, resetsAt: number | null, blocked: boolean, observedAtMs: number): Fact {
  const resetMs = futureReset(resetsAt, observedAtMs);
  if (resetsAt !== null && resetMs === null) return {kind: 'unknown', used, resetMs: null};
  if (blocked) return used === 100 ? {kind: resetMs === null ? 'exhausted' : 'recovery', used, resetMs} : {kind: 'unknown', used, resetMs: null};
  if (used >= 100) return {kind: 'unknown', used, resetMs: null};
  return {kind: 'available', used, resetMs};
}
function combine(facts: readonly Fact[]): {class: ProviderCollectorClass; remaining: number | null; resetMs: number | null} {
  if (facts.length === 0 || facts.some(item => item.kind === 'unknown')) return {class: 'unknown', remaining: null, resetMs: null};
  if (facts.some(item => item.kind === 'exhausted')) return {class: 'exhausted', remaining: 0, resetMs: null};
  if (facts.some(item => item.kind === 'recovery')) {
    const resets = facts.filter(item => item.kind === 'recovery').map(item => item.resetMs ?? 0);
    return {class: 'recovery', remaining: 0, resetMs: Math.max(...resets)};
  }
  const used = Math.max(...facts.map(item => item.used));
  const resets = facts.flatMap(item => item.resetMs === null ? [] : [item.resetMs]);
  const remaining = round4(100 - used);
  if (remaining <= 0 || remaining > 100) return {class: 'unknown', remaining: null, resetMs: null};
  return {class: 'available', remaining, resetMs: resets.length === facts.length ? Math.min(...resets) : null};
}
function finish(provider: ProviderCollectorProvider, parserId: string, observedAtMs: number, facts: readonly Fact[]): ProviderCollectorObservation {
  const combined = combine(facts);
  if (combined.class === 'unknown') return blank(provider, parserId, 'invalid_response');
  const ttlSeconds = combined.class === 'recovery'
    ? Math.min(COLLECTOR_TTL.max, Math.max(1, Math.floor(((combined.resetMs ?? observedAtMs) - observedAtMs) / 1000)))
    : COLLECTOR_TTL[combined.class];
  const status = combined.class === 'recovery' ? 'rate_limited' : combined.class;
  return {schemaVersion: 1, provider, parserId, class: combined.class, status, source: `collector:${parserId}`, ttlSeconds,
    remainingPercent: combined.remaining, resetAt: combined.resetMs === null ? null : new Date(combined.resetMs).toISOString(), failure: 'none'};
}
function jsonDocument(stdout: string): unknown {
  const text = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (text.length === 0 || text.includes('\n') || text.trim() !== text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
function codexFacts(stdout: string, observedAtMs: number): Fact[] | null {
  const parsed = CodexDocument.safeParse(jsonDocument(stdout));
  if (!parsed.success) return null;
  // A null secondary bucket is explicit loss of knowledge, not an empty quota.
  if (parsed.data.result.rateLimits.secondary === null) return null;
  const windows = [parsed.data.result.rateLimits.primary, parsed.data.result.rateLimits.secondary];
  return windows.map(window => fact(window.usedPercent, window.resetsAt, window.usedPercent === 100, observedAtMs));
}
function claudeFacts(stdout: string, observedAtMs: number): Fact[] | null {
  const parsed = ClaudeDocument.safeParse(jsonDocument(stdout));
  if (!parsed.success || parsed.data.rate_limit_info.isUsingOverage) return null;
  const info = parsed.data.rate_limit_info;
  const windows = ['five_hour', 'seven_day'] as const;
  const facts: Fact[] = [];
  for (const id of windows) {
    const window = info.unifiedWindows[id];
    const named = info.rateLimitType === id;
    if (named && window.resetsAt !== info.resetsAt) return null;
    if (window.status !== undefined && named && window.status !== info.status) return null;
    const status = window.status ?? (named ? info.status : undefined);
    if (status === undefined) return null;
    facts.push(fact(round4(window.utilization * 100), window.resetsAt, status === 'rejected', observedAtMs));
  }
  return facts;
}
/** Allowlisted Grok billing summary. 0% with a future period_end is recovery so the proven reset is kept. */
function grokFacts(stdout: string, observedAtMs: number): Fact[] | null {
  const parsed = GrokReport.safeParse(jsonDocument(stdout));
  if (!parsed.success) return null;
  const report = parsed.data;
  const stamp = Date.parse(report.timestamp_utc);
  if (!Number.isFinite(stamp) || stamp > observedAtMs || observedAtMs - stamp > 300_000) return null;
  if (report.authentication.expires_at * 1000 < observedAtMs + 60_000) return null;
  const billing = report.results.billing;
  const topup = report.results.auto_topup;
  const interpretation = topup.has_rule
    ? 'Official enabled bool defaults false when omitted'
    : 'Official Option<AutoTopupRule>: no configured rule';
  if (topup.interpretation !== interpretation) return null;
  const configSafe = billing.http_status === 200 && billing.unified_billing === true
    && billing.prepaid_cents === 0 && (billing.on_demand_cap_cents === null || billing.on_demand_cap_cents === 0)
    && billing.on_demand_enabled !== true && topup.http_status === 200 && topup.enabled === false;
  if (!configSafe) return null;
  if (round4(billing.used_percent + billing.remaining_percent) !== 100) return null;
  const positive = billing.remaining_percent > 0;
  if (report.subscription_only_evidence !== positive) return null;
  let resetsAt: number | null = null;
  if (billing.period_end !== null) {
    const resetMs = Date.parse(billing.period_end);
    if (!Number.isFinite(resetMs) || resetMs % 1000 !== 0) return null;
    resetsAt = resetMs / 1000;
  }
  const blocked = billing.remaining_percent === 0;
  if (blocked !== (billing.used_percent === 100)) return null;
  return [fact(billing.used_percent, resetsAt, blocked, observedAtMs)];
}
/** No versioned subscription-quota document is accepted for this CLI. */
function unprovenQuotaFacts(): Fact[] | null {
  return null;
}

const parsers: Record<ProviderCollectorProvider, (stdout: string, observedAtMs: number) => Fact[] | null> = {
  codex: codexFacts, claude: claudeFacts, grok: grokFacts, antigravity: unprovenQuotaFacts,
};

/** Pure parser. Malformed input returns an unknown observation and does not throw. */
export function parseProviderCollector(raw: unknown): ProviderCollectorObservation {
  try {
    const parsed = Capture.safeParse(raw);
    if (!parsed.success) return blank(declared(raw).provider, declared(raw).parserId, 'invalid_response');
    const capture = parsed.data;
    if (capture.parserId !== PROVIDER_COLLECTOR_PARSERS[capture.provider]) return blank(capture.provider, capture.parserId, 'invalid_response');
    if (capture.kind === 'transport_error') return blank(capture.provider, capture.parserId, 'transport');
    if (capture.kind === 'auth_error') return blank(capture.provider, capture.parserId, 'auth');
    if (capture.truncated === true || capture.exitCode !== 0) return blank(capture.provider, capture.parserId, 'invalid_response');
    const observedAtMs = Date.parse(capture.observedAt);
    if (!Number.isFinite(observedAtMs)) return blank(capture.provider, capture.parserId, 'invalid_response');
    const facts = parsers[capture.provider](capture.stdout, observedAtMs);
    if (!facts) return blank(capture.provider, capture.parserId, 'invalid_response');
    return finish(capture.provider, capture.parserId, observedAtMs, facts);
  } catch {
    return blank('unspecified', 'unspecified', 'invalid_response');
  }
}
export function toQuotaInput(observation: ProviderCollectorObservation) {
  return QuotaInput.parse({status: observation.status, source: observation.source, ttlSeconds: observation.ttlSeconds});
}
export function toProbeResult(observation: ProviderCollectorObservation): ProviderProbeResult {
  return {status: observation.status, ttlSeconds: observation.ttlSeconds, remainingPercent: observation.remainingPercent, resetAt: observation.resetAt};
}
