import type {ProviderAdapter, ProviderProbeResult} from './providers.ts';
import {COLLECTOR_TTL, parseProviderCollector, PROVIDER_COLLECTOR_PARSERS, toProbeResult, type ProviderCollectorProvider} from './provider-collector-parsers.ts';

/** UTF-8 byte cap. `String.length` counts UTF-16 units and is not this limit. */
export const PROVIDER_COLLECTOR_STDOUT_MAX = 8192;

/** Raw provider CLI text. A string is exit 0. This module never spawns a process. */
export type ProviderCollectorRunnerOutput = string | {stdout: string; exitCode?: number};
export type ProviderCollectorRunner = (input: {accountId: string; signal: AbortSignal}) =>
  ProviderCollectorRunnerOutput | Promise<ProviderCollectorRunnerOutput>;

export type ProviderCollectorAdapterOptions = {
  provider: ProviderCollectorProvider;
  runner: ProviderCollectorRunner;
  /** Manifest bound used by ProviderCollectors.collect. The probe does not arm a second clock. */
  timeoutMs?: number;
  /** Capture clock. Tests pin the fixture instant. Production uses the wall clock. */
  now?: () => Date;
};

const transport = (): ProviderProbeResult => ({status: 'unreachable', ttlSeconds: COLLECTOR_TTL.unknown, remainingPercent: null, resetAt: null});
const uncertain = (): ProviderProbeResult => ({status: 'unknown', ttlSeconds: COLLECTOR_TTL.unknown, remainingPercent: null, resetAt: null});

/**
 * Wait until the runner settles or the caller aborts. No private timer: a result
 * delivered before ProviderCollectors.collect aborts is a normal completion, clears
 * the lease, and can overlap a runner that is still in flight. Quarantine happens
 * only when collect itself sets timedOut and aborts this signal.
 */
function awaitRunner(signal: AbortSignal, start: () => ProviderCollectorRunnerOutput | Promise<ProviderCollectorRunnerOutput>): Promise<ProviderCollectorRunnerOutput> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error('aborted')));
    signal.addEventListener('abort', onAbort, {once: true});
    let pending: Promise<ProviderCollectorRunnerOutput>;
    try {
      pending = Promise.resolve(start());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

function captured(raw: ProviderCollectorRunnerOutput): {stdout: string; exitCode: number} | undefined {
  if (typeof raw === 'string') return {stdout: raw, exitCode: 0};
  if (raw === null || typeof raw !== 'object') return undefined;
  if (typeof raw.stdout !== 'string') return undefined;
  const exitCode = raw.exitCode ?? 0;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) return undefined;
  return {stdout: raw.stdout, exitCode};
}

function withinStdoutCap(stdout: string): boolean {
  const bytes = Buffer.byteLength(stdout, 'utf8');
  return bytes > 0 && bytes <= PROVIDER_COLLECTOR_STDOUT_MAX;
}

/**
 * ProviderAdapter factory. The runner is injected and is the only source of CLI text.
 * No real collector is registered: account authorization is still required before any
 * process spawn, and this factory never imports child_process.
 * Runner throw and abort become unreachable. The probe stays pending while the runner
 * is in flight. Empty, oversize, malformed and unknown-version stdout become unknown.
 * Neither path is available or exhausted.
 * accountId is forwarded only to the runner and is never copied into the probe.
 */
export function createProviderCollectorAdapter(options: ProviderCollectorAdapterOptions): ProviderAdapter {
  const provider = options.provider;
  const parserId = PROVIDER_COLLECTOR_PARSERS[provider];
  if (parserId === undefined) throw new TypeError('PROVIDER_COLLECTOR_UNKNOWN');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30_000) throw new TypeError('PROVIDER_COLLECTOR_TIMEOUT');
  const now = options.now ?? (() => new Date());
  return {
    manifest: {
      id: `collector-${provider}`,
      version: parserId,
      provider,
      mode: 'synthetic',
      eligibility: 'documented_supported',
      source: `synthetic://collector/${provider}/${parserId}`,
      timeoutMs,
    },
    probe: async ({accountId, signal}) => {
      if (signal.aborted) return transport();
      let raw: ProviderCollectorRunnerOutput;
      try {
        raw = await awaitRunner(signal, () => options.runner({accountId, signal}));
      } catch {
        return transport();
      }
      if (signal.aborted) return transport();
      const output = captured(raw);
      if (!output || !withinStdoutCap(output.stdout)) return uncertain();
      let observedAt: string;
      try {
        observedAt = now().toISOString();
      } catch {
        return uncertain();
      }
      const observation = parseProviderCollector({
        kind: 'stdout', provider, parserId, exitCode: output.exitCode, stdout: output.stdout, observedAt,
      });
      if (observation.failure !== 'none') return uncertain();
      const probe = toProbeResult(observation);
      if (probe.status !== 'available' && probe.status !== 'exhausted' && probe.status !== 'rate_limited') return uncertain();
      return {status: probe.status, ttlSeconds: probe.ttlSeconds, remainingPercent: probe.remainingPercent, resetAt: probe.resetAt};
    },
  };
}

/** Opt-in probe only: it deliberately has no synthetic manifest and cannot be
 * registered in ProviderCollectors until real account activation exists. */
export function createCodexReadonlyQuotaProbe(source:import('./codex-readonly-quota-source.ts').CodexReadonlyQuotaSource,now:()=>Date=()=>new Date()):ProviderAdapter['probe']{
 return async input=>{
  const result=await source.read(input);
  if(result.kind==='auth')return {status:'auth_required',ttlSeconds:COLLECTOR_TTL.unknown,remainingPercent:null,resetAt:null};
  if(result.kind!=='stdout')return uncertain();
  let observedAt:string;try{observedAt=now().toISOString();}catch{return uncertain();}
  const observation=parseProviderCollector({kind:'stdout',provider:'codex',parserId:PROVIDER_COLLECTOR_PARSERS.codex,exitCode:0,stdout:result.stdout,observedAt});
  return observation.failure==='none'?toProbeResult(observation):uncertain();
 };
}
