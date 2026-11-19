/** Trânsito HTTP local entre dois namespaces de rede sem interface externa. */
import {spawn} from 'node:child_process';
import {constants, fstatSync, openSync, closeSync} from 'node:fs';
import {createConnection, createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const socketPath = '/perf-link/http.sock';
const targetPort = 31873;
const linuxPathOnly = 0x200000; // O_PATH no Linux.

function connectToSocket(path) {
  // A entrada é escolhida pelo alvo. O descritor fixa o inode e impede
  // redirecionamento por links ou troca entre a validação e connect().
  const fd = openSync(path, linuxPathOnly | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isSocket()) throw new Error('canal do alvo indisponível');
    return createConnection({path: `/proc/self/fd/${fd}`});
  } finally { closeSync(fd); }
}

async function relay(address, connect) {
  const clients = new Set();
  const server = createServer({allowHalfOpen: true}, client => {
    let peer;
    try { peer = connect(); } catch { client.destroy(); return; }
    clients.add(client);
    const close = () => { clients.delete(client); client.destroy(); peer.destroy(); };
    for (const socket of [client, peer]) {
      socket.setTimeout(8000, close);
      socket.once('error', close);
      socket.once('close', close);
    }
    client.pipe(peer);
    peer.pipe(client);
  });
  server.maxConnections = 16;
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(address, ok);
  });
  return {address: () => server.address(), close: () => new Promise(ok => {
    server.close(ok);
    for (const client of clients) client.destroy();
  })};
}

export async function startObserverHttpLink(path = socketPath) {
  const server = await relay({host: '127.0.0.1', port: 0}, () => connectToSocket(path));
  return {origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , entry, portEnv] = process.argv;
  if (!entry?.startsWith('/repo/') || !/^[A-Z_][A-Z0-9_]{0,40}$/.test(portEnv)) process.exit(78);
  const bridge = await relay(socketPath, () => createConnection({host: '127.0.0.1', port: targetPort}));
  const target = spawn(process.execPath, [entry], {
    env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'test', [portEnv]: String(targetPort)},
    stdio: 'ignore',
  });
  target.once('error', () => { bridge.close(); process.exit(1); });
  target.once('exit', code => { bridge.close(); process.exit(code ?? 1); });
}
