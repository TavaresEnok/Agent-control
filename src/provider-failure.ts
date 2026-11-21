import {classifyAgentFailure} from '../upstream/cezar/packages/cezar/dist/core/agent-failure-class.js';

/** A provider outage that passes (529 overloaded, upstream 5xx, a dropped stream). Not a verdict on the work. */
export const EXECUTION_PROVIDER_OVERLOADED = 'EXECUTION_PROVIDER_OVERLOADED';
export const PLANNING_PROVIDER_OVERLOADED = 'PLANNING_PROVIDER_OVERLOADED';

/** Cezar's classifier, narrow by design: a false "transient" only buys one retry against a provider that refuses again. */
export function isTransientProviderFailure(texts: readonly (string | null | undefined)[]): boolean {
  const text = texts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.slice(-4000)).join('\n');
  return text.length > 0 && classifyAgentFailure(text) === 'transient';
}

export const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000] as const;

/** Wait before retry `attempt` (0-based), with ±20% spread so parallel jobs do not retry in lockstep.
 * Null when there is no retry left or the wait would not leave a minute of the job's time. */
export function transientRetryDelay(attempt: number, remainingMs: number, random: () => number = Math.random): number | null {
  const base = TRANSIENT_RETRY_DELAYS_MS[attempt];
  if (base === undefined) return null;
  const delay = Math.round(base * (0.8 + 0.4 * random()));
  return remainingMs - delay >= 60_000 ? delay : null;
}

/**
 * Runs `once` again after a transient provider failure. Only for evaluators: a programmer's second session would start
 * over a half-edited checkout, so its overload is reported, never retried here. A thrown error is retried when its `code`
 * is the overload code; anything else propagates unchanged.
 */
export async function runWithTransientRetry<T extends {failure: string | null}>(input: {
  enabled: boolean;
  deadlineMs: number;
  aborted: () => boolean;
  once: () => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): Promise<T> {
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    let outcome: {value: T} | {error: unknown};
    try { outcome = {value: await input.once()}; } catch (error) { outcome = {error}; }
    const overloaded = 'value' in outcome ? outcome.value.failure === EXECUTION_PROVIDER_OVERLOADED : (outcome.error as {code?: unknown})?.code === EXECUTION_PROVIDER_OVERLOADED;
    const delay = input.enabled && overloaded && !input.aborted() ? transientRetryDelay(attempt, input.deadlineMs - now(), input.random) : null;
    if (delay === null) {
      if ('value' in outcome) return outcome.value;
      throw outcome.error;
    }
    await sleep(delay);
    if (input.aborted()) {
      if ('value' in outcome) return outcome.value;
      throw outcome.error;
    }
  }
}
