import {createConnection, createServer, type Server, type Socket} from 'node:net';
import {chmod, rm} from 'node:fs/promises';
import {posix} from 'node:path';

/**
 * A small Docker API filter between the gateway and the Docker socket. Docker access is root on the host; the gateway needs
 * only a handful of operations. Each request is checked before it reaches Docker:
 * - only the routes the product uses pass (containers, images inspect, networks, ping/version/info);
 * - a container create is read whole and refused when it asks for privilege (Privileged, CapAdd, devices, host namespaces,
 *   seccomp/apparmor off, VolumesFrom) or mounts a host path outside the allowed roots;
 * - every non-upgrade request is forced to `Connection: close`, so a second request on a kept-alive connection cannot skip
 *   the check; attach (an HTTP upgrade) is passed through as a raw stream after its request line was checked.
 * It protects only when the gateway cannot reach /var/run/docker.sock itself (its user outside the docker group).
 */
export type DockerFilterPolicy = {allowedRoots: readonly string[]};

const MAX_HEAD = 64 * 1024;
const MAX_BODY = 1024 * 1024;

const ROUTES: {method: string; path: RegExp}[] = [
  {method: 'GET', path: /^\/(?:_ping|version|info)$/},
  {method: 'HEAD', path: /^\/_ping$/},
  {method: 'GET', path: /^\/containers\/json$/},
  {method: 'GET', path: /^\/containers\/[^/]+\/(?:json|logs|top|stats)$/},
  {method: 'POST', path: /^\/containers\/create$/},
  {method: 'POST', path: /^\/containers\/[^/]+\/(?:start|stop|kill|wait|attach|resize|restart)$/},
  {method: 'DELETE', path: /^\/containers\/[^/]+$/},
  {method: 'GET', path: /^\/images\/json$/},
  {method: 'GET', path: /^\/images\/[^/]+(?:\/[^/]+)*\/json$/},
  {method: 'GET', path: /^\/networks$/},
  {method: 'GET', path: /^\/networks\/[^/]+$/},
  {method: 'POST', path: /^\/networks\/create$/},
  {method: 'POST', path: /^\/networks\/[^/]+\/(?:connect|disconnect)$/},
  {method: 'DELETE', path: /^\/networks\/[^/]+$/},
];

/** Host paths that are never mounted, whatever the roots say. */
const NEVER = ['/var/run/docker.sock', '/run/docker.sock', '/var/lib/docker', '/etc', '/root', '/proc', '/sys', '/dev', '/boot'];

function normalize(path: string): string {
  return posix.normalize(path).replace(/\/+$/, '') || '/';
}
function within(path: string, root: string): boolean {
  const p = normalize(path), r = normalize(root);
  return r !== '/' && (p === r || p.startsWith(r + '/'));
}

/** Route check on the method and the path without the `/v1.xx` prefix and without the query. Null means allowed. */
export function routeRefusal(method: string, rawPath: string): string | null {
  const path = rawPath.split('?')[0]!.replace(/^\/v\d+\.\d+(?=\/)/, '');
  if (path.includes('..') || path.includes('%2e') || path.includes('%2E')) return 'caminho inválido';
  return ROUTES.some(route => route.method === method && route.path.test(path)) ? null : `rota não permitida: ${method} ${path}`;
}

/** Host paths a container create would mount. */
function hostSources(body: Record<string, any>): string[] {
  const host = body.HostConfig ?? {};
  const sources: string[] = [];
  for (const bind of Array.isArray(host.Binds) ? host.Binds : []) {
    if (typeof bind !== 'string') { sources.push(''); continue; }
    const source = bind.split(':')[0]!;
    // A bind without a leading slash names a Docker volume, not a host path.
    if (source.startsWith('/')) sources.push(source);
  }
  for (const mount of Array.isArray(host.Mounts) ? host.Mounts : []) {
    if (mount?.Type === 'bind') sources.push(typeof mount.Source === 'string' ? mount.Source : '');
  }
  return sources;
}

/** Container create check. Null means allowed. */
export function createRefusal(body: unknown, policy: DockerFilterPolicy): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'corpo inválido';
  const value = body as Record<string, any>;
  const host = value.HostConfig ?? {};
  if (host.Privileged === true) return 'Privileged';
  if (Array.isArray(host.CapAdd) && host.CapAdd.length) return 'CapAdd';
  if (Array.isArray(host.Devices) && host.Devices.length) return 'Devices';
  if (Array.isArray(host.DeviceCgroupRules) && host.DeviceCgroupRules.length) return 'DeviceCgroupRules';
  if (Array.isArray(host.VolumesFrom) && host.VolumesFrom.length) return 'VolumesFrom';
  // A volume mount with driver options can bind any host path (volume-opt=o=bind,device=/etc).
  if (Array.isArray(host.Mounts) && host.Mounts.some((mount: any) => mount?.Type === 'volume' && mount?.VolumeOptions?.DriverConfig)) return 'volume com opções de driver';
  for (const key of ['NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) {
    if (typeof host[key] === 'string' && host[key] === 'host') return `${key}=host`;
  }
  if (Array.isArray(host.SecurityOpt) && host.SecurityOpt.some((opt: unknown) => typeof opt !== 'string' || /unconfined|label[:=]disable|systempaths=unconfined/i.test(opt))) return 'SecurityOpt';
  for (const source of hostSources(value)) {
    if (!source.startsWith('/')) return 'montagem sem caminho absoluto';
    if (NEVER.some(blocked => within(source, blocked)) || normalize(source) === '/') return `montagem proibida: ${source}`;
    if (!policy.allowedRoots.some(root => within(source, root))) return `montagem fora das raízes: ${source}`;
  }
  return null;
}

function refuse(client: Socket, reason: string) {
  const body = JSON.stringify({message: 'agent-control docker filter: ' + reason});
  client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Rewrites the head: no keep-alive for ordinary requests. Upgrade requests keep their own Connection header. */
export function closeHead(head: string): string {
  const lines = head.split('\r\n');
  const upgrade = lines.some(line => /^upgrade\s*:/i.test(line));
  if (upgrade) return head;
  const kept = lines.filter((line, index) => index === 0 || !/^(?:connection|keep-alive|proxy-connection)\s*:/i.test(line));
  return [...kept, 'Connection: close'].join('\r\n');
}

function handle(client: Socket, upstreamSocket: string, policy: DockerFilterPolicy, log: (line: string) => void) {
  let buffered = Buffer.alloc(0);
  let decided = false;
  const onData = (chunk: Buffer) => {
    if (decided) return;
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end < 0) { if (buffered.length > MAX_HEAD) { decided = true; refuse(client, 'cabeçalho grande demais'); } return; }
    const head = buffered.subarray(0, end).toString('latin1');
    const [requestLine] = head.split('\r\n');
    const [method = '', path = ''] = (requestLine ?? '').split(' ');
    const route = routeRefusal(method, path);
    if (route) { decided = true; log(`docker-filter recusou ${route}`); refuse(client, route); return; }
    const isCreate = /^\/(?:v\d+\.\d+\/)?containers\/create(?:\?|$)/.test(path);
    const lengthHeader = /\r\ncontent-length\s*:\s*(\d+)/i.exec('\r\n' + head.split('\r\n').slice(1).join('\r\n'));
    const chunked = /\r\ntransfer-encoding\s*:\s*chunked/i.test('\r\n' + head);
    if (isCreate) {
      if (chunked || !lengthHeader) { decided = true; refuse(client, 'create sem Content-Length'); return; }
      const length = Number(lengthHeader[1]);
      if (length > MAX_BODY) { decided = true; refuse(client, 'corpo grande demais'); return; }
      if (buffered.length < end + 4 + length) return;
      const body = buffered.subarray(end + 4, end + 4 + length);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { decided = true; refuse(client, 'corpo inválido'); return; }
      const refusal = createRefusal(parsed, policy);
      if (refusal) { decided = true; log(`docker-filter recusou create: ${refusal}`); refuse(client, refusal); return; }
    }
    decided = true;
    client.off('data', onData);
    client.pause();
    // Half-open on both sides: the CLI closes its write side after stdin (attach), and output must still flow back.
    const upstream = createConnection({path: upstreamSocket, allowHalfOpen: true});
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('connect', () => {
      upstream.write(Buffer.concat([Buffer.from(closeHead(head) + '\r\n\r\n', 'latin1'), buffered.subarray(end + 4)]));
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}

/** Listens on `listen` (mode 0660) and forwards allowed requests to `upstream`. */
export async function startDockerFilter(listen: string, upstream: string, policy: DockerFilterPolicy, log: (line: string) => void = line => console.error(line)): Promise<Server> {
  await rm(listen, {force: true});
  const server = createServer({allowHalfOpen: true}, client => handle(client, upstream, policy, log));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(listen, () => resolve()); });
  await chmod(listen, 0o660);
  return server;
}

/** `node --import tsx src/docker-filter.ts <listen> <upstream> <root>[:<root>...]` */
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const [listen, upstream, roots] = process.argv.slice(2);
  if (!listen || !upstream || !roots) { console.error('uso: docker-filter <socket> <docker.sock> <raiz>[:<raiz>...]'); process.exit(2); }
  const allowedRoots = roots.split(':').filter(Boolean);
  if (allowedRoots.some(root => !root.startsWith('/') || normalize(root) === '/')) { console.error('raízes devem ser absolutas e diferentes de /'); process.exit(2); }
  await startDockerFilter(listen, upstream, {allowedRoots});
  console.error(`docker-filter ouvindo em ${listen}`);
}
