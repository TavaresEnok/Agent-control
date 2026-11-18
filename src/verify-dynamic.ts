import {Refusal} from './contracts.ts';
import {VERIFY_RUNTIME_BIN} from './verify-image.ts';

/** Loopback or one container label. Another host is VERIFY_EXTERNAL_TARGET; a different destination or port is VERIFY_TARGET_ESCAPE. */
export type DynamicScanPlan = {
  network: 'verify-homologation';
  allowedHost: string;
  allowedPort: number;
  tools: readonly [
    {name: 'zap'; mode: 'baseline-passivo'; args: readonly string[]},
    {name: 'schemathesis'; args: readonly string[]},
    {name: 'nuclei'; args: readonly string[]},
  ];
};

type Endpoint = {raw: string; host: string; port: number; origin: string};

function normalizeHost(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

const SINGLE_LABEL = /^[a-z0-9]([a-z0-9-]{0,62})$/;

function isSingleLabel(value: string): boolean {
  return SINGLE_LABEL.test(value);
}

function allowedName(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || isSingleLabel(host);
}

function endpoint(targetUrl: string): Endpoint {
  let url: URL;
  try { url = new URL(targetUrl); }
  catch { throw new Refusal('VERIFY_EXTERNAL_TARGET'); }
  if (url.username || url.password || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Refusal('VERIFY_EXTERNAL_TARGET');
  const host = normalizeHost(url.hostname);
  if (!allowedName(host)) throw new Refusal('VERIFY_EXTERNAL_TARGET');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal('VERIFY_EXTERNAL_TARGET');
  return {raw: targetUrl, host, port, origin: `${url.protocol}//${host}:${port}`};
}

function destinationOf(value: string): {host: string; port: number | null} {
  const trimmed = value.trim();
  if (!trimmed) throw new Refusal('VERIFY_TARGET_ESCAPE');
  if (trimmed.includes('://')) {
    let url: URL;
    try { url = new URL(trimmed); }
    catch { throw new Refusal('VERIFY_TARGET_ESCAPE'); }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : null;
    return {host: normalizeHost(url.hostname), port};
  }
  const ipv6 = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) return {host: normalizeHost(ipv6[1]), port: ipv6[2] ? Number(ipv6[2]) : null};
  const hostPort = trimmed.match(/^([^:]+):(\d+)$/);
  if (hostPort) return {host: normalizeHost(hostPort[1]), port: Number(hostPort[2])};
  return {host: normalizeHost(trimmed), port: null};
}

function hostOfToken(token: string): string {
  const candidates = token.endsWith('.*') ? [token, token.slice(0, -2)] : [token];
  for (const candidate of candidates) {
    try { return normalizeHost(new URL(candidate).hostname); }
    catch { /* a trailing .* is the scanner include regex, not a second host */ }
  }
  return '*';
}

function citedHosts(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)) {
    const slice = text.slice(match.index ?? 0);
    const end = slice.search(/[\s'"]/);
    const token = end === -1 ? slice : slice.slice(0, end);
    found.push(hostOfToken(token));
  }
  for (const match of text.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) found.push(match[1]);
  return found;
}

export function assertTargetOnly(targetUrl: string, destinationHost: string): void {
  const target = endpoint(targetUrl);
  const destination = destinationOf(destinationHost);
  if (destination.host !== target.host || (destination.port !== null && destination.port !== target.port)) throw new Refusal('VERIFY_TARGET_ESCAPE');
}

export function dynamicScanPlan(targetUrl: string): DynamicScanPlan {
  const target = endpoint(targetUrl);
  const schema = `${target.origin}/openapi.json`;
  const plan: DynamicScanPlan = {
    network: 'verify-homologation',
    allowedHost: target.host,
    allowedPort: target.port,
    tools: [
      {name: 'zap', mode: 'baseline-passivo', args: ['zap-baseline.py', '-t', target.raw, '-z', `-config contexts.context.0.include=${target.origin}.*`]},
      {name: 'schemathesis', args: ['schemathesis', 'run', schema, '--base-url', target.origin]},
      {name: 'nuclei', args: ['nuclei', '-u', target.raw, '-tags', 'cve,exposure,misconfig', '-follow-redirects=false']},
    ],
  };
  const foreign = plan.tools.flatMap(tool => tool.args.flatMap(citedHosts)).filter(host => host !== target.host);
  if (foreign.length) throw new Refusal('VERIFY_TARGET_ESCAPE');
  return plan;
}

/** Create an internal network and attach only the target container. */
export async function attachInternalTarget({network, container, run}: {
  network: string;
  container: string;
  run: (args: readonly string[]) => Promise<{code: number; stdout: string}>;
}): Promise<void> {
  if (!isSingleLabel(network) || !isSingleLabel(container)) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
  const created = await run([VERIFY_RUNTIME_BIN, 'network', 'create', '--internal', network]);
  if (created.code !== 0) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
  const inspected = await run([VERIFY_RUNTIME_BIN, 'network', 'inspect', network, '--format', '{{.Internal}}']);
  if (inspected.code !== 0 || inspected.stdout.trim() !== 'true') throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
  const connected = await run([VERIFY_RUNTIME_BIN, 'network', 'connect', network, container]);
  if (connected.code !== 0) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
}
