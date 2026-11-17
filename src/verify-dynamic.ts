import {Refusal} from './contracts.ts';

/** Local homologation only. Another host is VERIFY_EXTERNAL_TARGET; a different destination or port is VERIFY_TARGET_ESCAPE. */
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

function allowedName(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host.endsWith('.local');
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

function citedHosts(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)) {
    const slice = text.slice(match.index ?? 0);
    const end = slice.search(/[\s'"]/);
    const token = end === -1 ? slice : slice.slice(0, end);
    try { found.push(normalizeHost(new URL(token).hostname)); }
    catch { found.push('*'); }
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
      {name: 'zap', mode: 'baseline-passivo', args: ['zap-baseline.py', '-t', target.raw]},
      {name: 'schemathesis', args: ['schemathesis', 'run', schema, '--base-url', target.origin]},
      {name: 'nuclei', args: ['nuclei', '-u', target.raw, '-tags', 'cve,exposure,misconfig']},
    ],
  };
  const foreign = plan.tools.flatMap(tool => tool.args.flatMap(citedHosts)).filter(host => host !== target.host);
  if (foreign.length) throw new Refusal('VERIFY_TARGET_ESCAPE');
  return plan;
}
