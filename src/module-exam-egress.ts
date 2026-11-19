import {lookup} from 'node:dns/promises';
import {BlockList, createConnection, createServer, type Server, type Socket} from 'node:net';
import {Refusal} from './contracts.ts';

export const moduleExamProviders = ['claude', 'codex'] as const;
export type ModuleExamProvider = typeof moduleExamProviders[number];
export const moduleExamSocket = '/runner/module-exam-egress.sock';
const proxyPort = 19493;
const lifetimeRequest = 'MODULE-EXAM-LIFETIME';
const lifetimeAck = 'READY';
const destinations: Record<ModuleExamProvider, readonly string[]> = {
  claude: ['api.anthropic.com'],
  codex: ['chatgpt.com'],
};

const reserved = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) reserved.addSubnet(subnet, prefix);

export function moduleExamConnectHost(header: string, provider: ModuleExamProvider): string | undefined {
  const [request, ...headers] = header.split('\r\n');
  const host = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]$/.exec(request ?? '')?.[1];
  if (!host || !destinations[provider].includes(host)) return;
  if (headers.some(line => line && !/^[a-z0-9-]+:[\x20-\x7e]*$/i.test(line))) return;
  if (headers.some(line => /^(content-length|transfer-encoding|proxy-authorization)\s*:/i.test(line))) return;
  if (headers.some(line => /^host:/i.test(line) && line.slice(5).trim().toLowerCase() !== host + ':443')) return;
  return host;
}

function listen(server: Server, binding: {path: string} | {host: string; port: number}): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(binding, () => {
      server.removeListener('error', reject);
      server.on('error', () => server.close());
      resolve();
    });
  });
}

function scopedServer(handler: (client: Socket, track: (socket: Socket) => void) => void) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('timeout', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(120_000);
  };
  const server = createServer(client => {
    if (sockets.size >= 16) { client.destroy(); return; }
    track(client);
    handler(client, track);
  });
  return {server, close() { for (const socket of sockets) socket.destroy(); server.close(); }};
}

/** Host-side CONNECT relay. The worker receives only this private Unix socket,
 * with Docker networking disabled. HTTPS and provider credentials stay inside TLS. */
export async function startModuleExamEgress(path: string, provider: ModuleExamProvider) {
  const relay = scopedServer((client, track) => {
    let header = Buffer.alloc(0);
    const reject = () => client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    const read = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end === -1 && header.length <= 8192) return;
      client.removeListener('data', read);
      client.pause();
      const message = end >= 0 && end <= 8192 ? header.subarray(0, end).toString('latin1') : '';
      if (message === lifetimeRequest && header.length === end + 4) {
        client.setTimeout(0);
        client.write(lifetimeAck);
        return;
      }
      const host = moduleExamConnectHost(message, provider);
      if (!host) { reject(); return; }
      void lookup(host, {all: true, family: 4}).then(addresses => {
        if (client.destroyed) return;
        const destination = addresses.find(address => !reserved.check(address.address));
        if (!destination) { reject(); return; }
        const remote = createConnection({host: destination.address, port: 443, family: 4});
        track(remote);
        remote.once('error', () => client.destroy());
        client.once('close', () => remote.destroy());
        remote.once('close', () => client.destroy());
        remote.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          remote.write(header.subarray(end + 4));
          client.pipe(remote).pipe(client);
        });
      }).catch(() => reject());
    };
    client.on('data', read);
  });
  try { await listen(relay.server, {path}); }
  catch { relay.close(); throw new Refusal('MODULE_EXAM_EGRESS_UNAVAILABLE'); }
  return relay.close;
}

/** Loss of the owning controller cuts off inference and interrupts its child CLI. */
export function monitorModuleExamEgress(path: string, onLost: () => void): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let closedByWorker = false;
    socket.setTimeout(5000);
    socket.once('connect', () => socket.write(lifetimeRequest + '\r\n\r\n'));
    socket.on('error', () => socket.destroy());
    socket.on('timeout', () => socket.destroy());
    socket.once('close', () => {
      if (!closedByWorker) onLost();
      reject(new Refusal('MODULE_EXAM_EGRESS_UNAVAILABLE'));
    });
    let ack = '';
    socket.on('data', chunk => {
      ack += chunk.toString('ascii');
      if (!lifetimeAck.startsWith(ack)) { socket.destroy(); return; }
      if (ack !== lifetimeAck) return;
      socket.setTimeout(0);
      resolve(() => { closedByWorker = true; socket.destroy(); });
    });
  });
}

/** Worker-side loopback socket for the CLIs' standard HTTPS proxy support. */
export async function startModuleExamLoopback() {
  const relay = scopedServer((client, track) => {
    const remote = createConnection(moduleExamSocket);
    track(remote);
    client.once('close', () => remote.destroy());
    remote.once('close', () => client.destroy());
    client.pipe(remote).pipe(client);
  });
  await listen(relay.server, {host: '127.0.0.1', port: proxyPort});
  return {url: 'http://127.0.0.1:' + proxyPort, close: relay.close};
}
