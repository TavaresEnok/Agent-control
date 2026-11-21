import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Provider endpoints found in the Claude 2.1.329, Codex 0.166.0 and Grok 1.0.70 binaries (21/11/2026). */
export const PERSONAL_EGRESS_HOSTS = [
  'api.anthropic.com', 'platform.claude.com', 'claude.ai',
  'chatgpt.com', 'auth.openai.com', 'api.openai.com',
  'cli-chat-proxy.grok.com', 'api.x.ai', 'accounts.x.ai',
] as const;

/** Installation `egress`: off keeps the shared provider network as it is; observe learns destinations; enforce blocks the rest. */
export const EgressConfig = z.object({mode: z.enum(['off', 'observe', 'enforce']).default('off'), allow: z.array(z.string().regex(HOST)).min(1).max(64).optional()}).strict();
export type EgressConfig = z.infer<typeof EgressConfig>;

export const PROVIDER_NETWORK = 'ac-native-provider';
export const EGRESS_CONTAINER = 'ac-provider-egress';

type Run = (command: string, args: string[]) => string;
const defaultRun: Run = (command, args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

/** Image tag bound to the proxy source and its Dockerfile, so a changed proxy is rebuilt and an unchanged one is reused. */
export function egressImageTag(root: string): string {
  const hash = createHash('sha256');
  for (const file of ['services/provider-egress/proxy.py', 'deploy/Dockerfile.provider-egress']) hash.update(readFileSync(join(root, file)));
  return 'agent-control-provider-egress:' + hash.digest('hex').slice(0, 16);
}

/**
 * Makes the provider network internal and runs the allowlist proxy on it, reachable as `provider-egress`. Workers keep the
 * network but lose direct internet; only the proxy has a second, outbound network. Refuses to recreate the network while a
 * container is attached to it, so a running job is never cut off. Returns what it did.
 */
export function ensurePersonalEgress(root: string, egress: EgressConfig, run: Run = defaultRun): string[] {
  if (egress.mode === 'off') return [];
  const done: string[] = [];
  const allow = (egress.allow ?? [...PERSONAL_EGRESS_HOSTS]).join(',');
  const tag = egressImageTag(root);
  try { run('docker', ['image', 'inspect', tag]); }
  catch { run('docker', ['build', '-q', '-f', join(root, 'deploy/Dockerfile.provider-egress'), '-t', tag, root]); done.push('imagem ' + tag); }
  let network: {Internal: boolean; Containers?: Record<string, {Name?: string}>} | undefined;
  try { network = JSON.parse(run('docker', ['network', 'inspect', PROVIDER_NETWORK]))[0]; } catch { network = undefined; }
  const attached = Object.values(network?.Containers ?? {}).map(item => item.Name).filter(name => name !== EGRESS_CONTAINER);
  if (network && !network.Internal) {
    if (attached.length) throw Error('PROVIDER_NETWORK_BUSY ' + attached.join(','));
    try { run('docker', ['rm', '-f', EGRESS_CONTAINER]); } catch { /* absent */ }
    run('docker', ['network', 'rm', PROVIDER_NETWORK]);
    network = undefined;
  }
  if (!network) { run('docker', ['network', 'create', '--internal', '--label', 'agent-control.provider-network=1', PROVIDER_NETWORK]); done.push('rede interna ' + PROVIDER_NETWORK); }
  const label = createHash('sha256').update(JSON.stringify({tag, allow, mode: egress.mode})).digest('hex').slice(0, 16);
  let current = '';
  try { current = run('docker', ['inspect', '--format', '{{index .Config.Labels "agent-control.egress"}} {{.State.Running}}', EGRESS_CONTAINER]).trim(); } catch { current = ''; }
  if (current !== `${label} true`) {
    try { run('docker', ['rm', '-f', EGRESS_CONTAINER]); } catch { /* absent */ }
    run('docker', ['run', '-d', '--name', EGRESS_CONTAINER, '--restart', 'unless-stopped', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128', '--memory', '256m', '--network', 'bridge', '--label', 'agent-control.egress=' + label,
      '-e', 'AC_EGRESS_ALLOW=' + allow, '-e', 'AC_EGRESS_MODE=' + egress.mode, tag]);
    run('docker', ['network', 'connect', '--alias', 'provider-egress', PROVIDER_NETWORK, EGRESS_CONTAINER]);
    done.push(`proxy ${EGRESS_CONTAINER} (${egress.mode})`);
  }
  return done;
}
