import {createConnection, createServer, type Server, type Socket} from 'node:net';
import {chmod, rm} from 'node:fs/promises';
import {readFileSync, realpathSync} from 'node:fs';
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
export type DockerFilterPolicy = {allowedRoots: readonly string[] | (() => readonly string[])};

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
  // pg_isready in the QA database probe (src/sandbox-broker.ts); the exec body is checked like a create.
  {method: 'POST', path: /^\/containers\/[^/]+\/exec$/},
  {method: 'POST', path: /^\/exec\/[^/]+\/(?:start|resize)$/},
  {method: 'GET', path: /^\/exec\/[^/]+\/json$/},
  {method: 'GET', path: /^\/images\/json$/},
  {method: 'GET', path: /^\/images\/[^/]+(?:\/[^/]+)*\/json$/},
  {method: 'GET', path: /^\/networks$/},
  {method: 'GET', path: /^\/networks\/[^/]+$/},
  {method: 'POST', path: /^\/networks\/create$/},
  {method: 'POST', path: /^\/networks\/[^/]+\/(?:connect|disconnect)$/},
  {method: 'DELETE', path: /^\/networks\/[^/]+$/},
];
/** The only requests that may switch the connection to a raw stream. */
const UPGRADE = /^\/(?:containers\/[^/]+\/attach|exec\/[^/]+\/start)$/;

/** Host paths that are never mounted, whatever the roots say. */
const NEVER = ['/var/run', '/run', '/var/lib/docker', '/etc', '/root', '/proc', '/sys', '/dev', '/boot'];

function normalize(path: string): string {
  return posix.normalize(path).replace(/\/+$/, '') || '/';
}
function within(path: string, root: string): boolean {
  const p = normalize(path), r = normalize(root);
  return r !== '/' && (p === r || p.startsWith(r + '/'));
}
/** The host path Docker would mount: symlinks resolved, and for a path that does not exist yet, its nearest existing parent. */
export function hostRealPath(path: string): string {
  let current = normalize(path), rest = '';
  for (;;) {
    try { return normalize(realpathSync(current) + rest); } catch { /* go up */ }
    if (current === '/') return normalize(path);
    rest = '/' + posix.basename(current) + rest;
    current = posix.dirname(current);
  }
}

export function routePath(rawPath: string): string {
  return rawPath.split('?')[0]!.replace(/^\/v\d+\.\d+(?=\/)/, '');
}
/** Route check on the method and the path without the `/v1.xx` prefix and without the query. Null means allowed. */
export function routeRefusal(method: string, rawPath: string): string | null {
  const path = routePath(rawPath);
  if (/\.\.|%2e|%2f|%5c/i.test(path)) return 'caminho inválido';
  return ROUTES.some(route => route.method === method && route.path.test(path)) ? null : `rota não permitida: ${method} ${path}`;
}

/**
 * JSON with no duplicate key and no two keys that differ only in case in the same object. Docker (Go) matches field names
 * case-insensitively and merges repeated objects, so `hostconfig` or a second `HostConfig` would reach it unchecked.
 */
export function strictJsonParse(text: string): unknown {
  let at = 0;
  const fail = (): never => { throw Error('JSON_NOT_STRICT'); };
  const space = () => { while (at < text.length && ' \t\r\n'.includes(text[at]!)) at++; };
  const string = (): string => {
    const start = at;
    if (text[at++] !== '"') fail();
    while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++; }
    if (text[at++] !== '"') fail();
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (): void => {
    space();
    const c = text[at];
    if (c === '{') {
      at++; space();
      const seen = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        space(); const key = string().toLowerCase();
        if (seen.has(key)) fail();
        seen.add(key); space();
        if (text[at++] !== ':') fail();
        value(); space();
        if (text[at] === ',') { at++; continue; }
        if (text[at++] !== '}') fail();
        return;
      }
    }
    if (c === '[') {
      at++; space();
      if (text[at] === ']') { at++; return; }
      for (;;) { value(); space(); if (text[at] === ',') { at++; continue; } if (text[at++] !== ']') fail(); return; }
    }
    if (c === '"') { string(); return; }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!literal) fail();
    at += literal![0].length;
  };
  value(); space();
  if (at !== text.length) fail();
  return JSON.parse(text);
}

const TOP_FIELDS = new Set(['Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd',
  'Image', 'Volumes', 'WorkingDir', 'Entrypoint', 'Labels', 'HostConfig', 'NetworkingConfig', 'ExposedPorts', 'StopSignal', 'StopTimeout', 'Healthcheck', 'NetworkDisabled']);
const HOST_FIELDS = new Set(['AutoRemove', 'Binds', 'BlkioDeviceReadBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteBps', 'BlkioDeviceWriteIOps', 'BlkioWeight',
  'BlkioWeightDevice', 'CapAdd', 'CapDrop', 'Cgroup', 'CgroupParent', 'CgroupnsMode', 'ConsoleSize', 'ContainerIDFile', 'CpuCount', 'CpuPercent', 'CpuPeriod',
  'CpuQuota', 'CpuRealtimePeriod', 'CpuRealtimeRuntime', 'CpuShares', 'CpusetCpus', 'CpusetMems', 'DeviceCgroupRules', 'DeviceRequests', 'Devices', 'Dns',
  'DnsOptions', 'DnsSearch', 'ExtraHosts', 'GroupAdd', 'IOMaximumBandwidth', 'IOMaximumIOps', 'IpcMode', 'Isolation', 'Links', 'LogConfig', 'MaskedPaths',
  'Memory', 'MemoryReservation', 'MemorySwap', 'MemorySwappiness', 'Mounts', 'NanoCpus', 'NetworkMode', 'OomKillDisable', 'OomScoreAdj', 'PidMode',
  'PidsLimit', 'PortBindings', 'Privileged', 'PublishAllPorts', 'ReadonlyPaths', 'ReadonlyRootfs', 'RestartPolicy', 'SecurityOpt', 'ShmSize', 'Tmpfs',
  'UTSMode', 'Ulimits', 'UsernsMode', 'VolumeDriver', 'VolumesFrom', 'Init', 'Runtime', 'Sysctls']);
const CAP_ADD = new Set(['DAC_OVERRIDE', 'FOWNER']);
const empty = (value: unknown) => value === undefined || value === null || value === '' || value === false || value === 0
  || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);

function rootsOf(policy: DockerFilterPolicy): string[] {
  const roots = typeof policy.allowedRoots === 'function' ? policy.allowedRoots() : policy.allowedRoots;
  return roots.filter(root => root.startsWith('/') && normalize(root) !== '/').map(hostRealPath);
}

function mountRefusal(source: unknown, roots: readonly string[]): string | null {
  if (typeof source !== 'string' || !source.startsWith('/')) return 'montagem sem caminho absoluto';
  const real = hostRealPath(source);
  if (real === '/' || NEVER.some(blocked => within(real, blocked))) return `montagem proibida: ${source}`;
  if (!roots.some(root => within(real, root))) return `montagem fora das raízes: ${source}`;
  return null;
}

/** Container create check: an allowlist of fields, each with its safe values. Null means allowed. */
export function createRefusal(body: unknown, policy: DockerFilterPolicy): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'corpo inválido';
  const value = body as Record<string, any>;
  const unknownTop = Object.keys(value).find(key => !TOP_FIELDS.has(key));
  if (unknownTop) return `campo não permitido: ${unknownTop}`;
  const host = value.HostConfig ?? {};
  if (typeof host !== 'object' || Array.isArray(host)) return 'HostConfig inválido';
  const unknownHost = Object.keys(host).find(key => !HOST_FIELDS.has(key));
  if (unknownHost) return `campo não permitido: HostConfig.${unknownHost}`;
  if (host.Privileged === true) return 'Privileged';
  if (Array.isArray(host.CapAdd) && host.CapAdd.some((cap: unknown) => typeof cap !== 'string' || !CAP_ADD.has(cap.replace(/^CAP_/, '')))) return 'CapAdd';
  for (const key of ['Devices', 'DeviceRequests', 'DeviceCgroupRules', 'GroupAdd', 'VolumesFrom', 'Links', 'Sysctls', 'PortBindings', 'CgroupParent', 'Isolation', 'VolumeDriver', 'Cgroup'])
    if (!empty(host[key])) return key;
  if (host.PublishAllPorts === true) return 'PublishAllPorts';
  if (!empty(host.Runtime) && host.Runtime !== 'runc') return 'Runtime';
  // An empty list unmasks /proc and /sys paths (systempaths=unconfined); only the default (null) is allowed.
  for (const key of ['MaskedPaths', 'ReadonlyPaths']) if (host[key] !== undefined && host[key] !== null) return key;
  for (const key of ['NetworkMode', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'])
    if (typeof host[key] === 'string' && (host[key] === 'host' || host[key].startsWith('container:'))) return `${key}=${host[key]}`;
  if (host.SecurityOpt !== undefined && host.SecurityOpt !== null &&
    (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.some((opt: unknown) => typeof opt !== 'string' || !/^no-new-privileges(?:[:=]true)?$/.test(opt)))) return 'SecurityOpt';
  const roots = rootsOf(policy);
  for (const bind of Array.isArray(host.Binds) ? host.Binds : []) {
    if (typeof bind !== 'string') return 'Binds inválido';
    const [source = '', , options = ''] = bind.split(':');
    // A bind without a leading slash names a Docker volume, not a host path.
    if (!source.startsWith('/')) continue;
    if (/(?:^|,)r?shared|(?:^|,)r?slave/.test(options)) return 'propagação de montagem';
    const refusal = mountRefusal(source, roots);
    if (refusal) return refusal;
  }
  for (const mount of Array.isArray(host.Mounts) ? host.Mounts : []) {
    if (!mount || typeof mount !== 'object') return 'Mounts inválido';
    if (!['bind', 'tmpfs', 'volume'].includes(mount.Type)) return `montagem do tipo ${mount.Type}`;
    if (mount.Type === 'volume' && mount.VolumeOptions?.DriverConfig) return 'volume com opções de driver';
    if (mount.Type === 'bind') {
      if (mount.BindOptions?.Propagation && !['private', 'rprivate'].includes(mount.BindOptions.Propagation)) return 'propagação de montagem';
      const refusal = mountRefusal(mount.Source, roots);
      if (refusal) return refusal;
    }
  }
  return null;
}

/** Exec check: only the QA database probe, never privileged. */
export function execRefusal(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'corpo inválido';
  const value = body as Record<string, any>;
  const allowed = new Set(['AttachStdin', 'AttachStdout', 'AttachStderr', 'Tty', 'Cmd', 'Env', 'User', 'WorkingDir', 'ConsoleSize', 'DetachKeys']);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) return `campo não permitido: ${unknown}`;
  if (!Array.isArray(value.Cmd) || value.Cmd[0] !== 'pg_isready') return 'exec permitido só para pg_isready';
  return null;
}
function refuse(client: Socket, reason: string) {
  const body = JSON.stringify({message: 'agent-control docker filter: ' + reason});
  client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Rewrites the head: no keep-alive for ordinary requests. Upgrade requests keep their own Connection header. */
export function closeHead(head: string): string {
  const lines = head.split('\r\n');
  const [method = '', path = ''] = (lines[0] ?? '').split(' ');
  // Only attach and exec start may become a raw stream. Anywhere else an Upgrade header is dropped and the connection
  // closes after one request, so nothing can follow the checked request on the same connection.
  if (method === 'POST' && UPGRADE.test(routePath(path)) && lines.some(line => /^upgrade\s*:/i.test(line))) return head;
  const kept = lines.filter((line, index) => index === 0 || !/^(?:connection|keep-alive|proxy-connection|upgrade)\s*:/i.test(line));
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
    const route_ = routePath(path);
    const isCreate = route_ === '/containers/create';
    const isExec = /^\/containers\/[^/]+\/exec$/.test(route_);
    const needsBody = isCreate || isExec;
    const lengthHeader = /\r\ncontent-length\s*:\s*(\d+)/i.exec('\r\n' + head.split('\r\n').slice(1).join('\r\n'));
    const chunked = /\r\ntransfer-encoding\s*:\s*chunked/i.test('\r\n' + head);
    if (chunked && !needsBody) { decided = true; refuse(client, 'corpo em chunks'); return; }
    if (needsBody) {
      if (chunked || !lengthHeader) { decided = true; refuse(client, 'corpo sem Content-Length'); return; }
      const length = Number(lengthHeader[1]);
      if (length > MAX_BODY) { decided = true; refuse(client, 'corpo grande demais'); return; }
      if (buffered.length < end + 4 + length) return;
      const body = buffered.subarray(end + 4, end + 4 + length);
      let parsed: unknown;
      try { parsed = strictJsonParse(body.toString('utf8')); } catch { decided = true; refuse(client, 'corpo inválido ou com chaves repetidas'); return; }
      const refusal = isCreate ? createRefusal(parsed, policy) : execRefusal(parsed);
      if (refusal) { decided = true; log(`docker-filter recusou ${isCreate ? 'create' : 'exec'}: ${refusal}`); refuse(client, refusal); return; }
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

/** Host roots a container of this installation may mount: its data and account folders, /tmp, project roots and repositories. */
export function installationRoots(config: Record<string, any>): string[] {
  return [...new Set([config.dataDirectory, config.accountHomesDirectory, '/tmp', ...(config.projectRoots ?? []).map((root: any) => root?.path),
    config.project?.repo, ...(config.projects ?? []).map((project: any) => project?.repo)]
    .filter((value): value is string => typeof value === 'string' && value.startsWith('/') && normalize(value) !== '/'))];
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
  // `@<installation.json>`: the roots are read again on every check, so a project added later is allowed without a reinstall.
  const allowedRoots = roots.startsWith('@') ? () => installationRoots(JSON.parse(readFileSync(roots.slice(1), 'utf8'))) : roots.split(':').filter(Boolean);
  const list = typeof allowedRoots === 'function' ? allowedRoots() : allowedRoots;
  if (!list.length || list.some(root => !root.startsWith('/') || normalize(root) === '/')) { console.error('raízes devem ser absolutas e diferentes de /'); process.exit(2); }
  await startDockerFilter(listen, upstream, {allowedRoots});
  console.error(`docker-filter ouvindo em ${listen}`);
}
