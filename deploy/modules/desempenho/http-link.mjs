/** Trânsito HTTP local entre dois namespaces de rede sem interface externa. */
import {spawn} from 'node:child_process';
import {constants, fstatSync, openSync, closeSync} from 'node:fs';
import {chmod} from 'node:fs/promises';
import {createConnection, createServer} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const socketPath = '/perf-link/http.sock';
const targetSocketPath = '/perf-link/target.sock';
const targetPort = 31873;
const linuxPathOnly = 0x200000; // O_PATH no Linux.
const channels = 16;
const watch = 0;
const stream = 1;
const dispatch = 2;

function connectToSocket(path) {
  // A entrada é escolhida pelo alvo. O descritor fixa o inode e impede
  // redirecionamento por links ou troca entre a validação e connect().
  const fd = openSync(path, linuxPathOnly | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isSocket()) throw new Error('canal do alvo indisponível');
    return createConnection({path: `/proc/self/fd/${fd}`, allowHalfOpen: true});
  } finally { closeSync(fd); }
}

function pair(left, right) {
  const close = () => { left.destroy(); right.destroy(); };
  for (const socket of [left, right]) {
    socket.setTimeout(8000, close);
    socket.once('error', close);
    socket.once('close', close);
  }
  left.pipe(right);
  right.pipe(left);
}

function destroyOnEnd() {
  this.destroy();
}

function connectToChannel(path, type) {
  const socket = connectToSocket(path);
  socket.once('error', () => socket.destroy());
  socket.write(Buffer.from([type]));
  return socket;
}

export function watchHttpLink(path, onClose) {
  const socket = connectToChannel(path, watch);
  socket.once('end', () => socket.destroy());
  socket.once('close', onClose);
  socket.resume();
  return {close() {
    socket.removeListener('close', onClose);
    socket.destroy();
  }};
}

export function watchObserverHttpLink(onClose) {
  return watchHttpLink(socketPath, onClose);
}

/** O host monta só os inodes dos sockets, um para cada contêiner, sem diretório gravável. */
export async function startHostHttpLink(targetPath, observerPath) {
  const waiting = {target: new Set(), observer: new Set()};
  const sockets = new Set();
  const listeners = [];
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(listeners.map(server => new Promise(ok => server.close(ok))));
  };
  async function listen(path, role, other) {
    let monitor;
    const server = createServer({allowHalfOpen: true}, socket => {
      sockets.add(socket);
      socket.once('close', () => {
        sockets.delete(socket);
        waiting[role].delete(socket);
        if (monitor === socket) monitor = undefined;
      });
      socket.once('error', () => socket.destroy());
      socket.once('end', destroyOnEnd);
      socket.setTimeout(8000, () => socket.destroy());
      socket.once('readable', () => {
        const type = socket.read(1)?.[0];
        if (type === watch && !monitor) {
          monitor = socket;
          socket.setTimeout(0);
          socket.resume();
          return;
        }
        if (type !== stream) { socket.destroy(); return; }
        socket.setTimeout(role === 'target' ? 0 : 8000);
        let peer;
        for (const candidate of waiting[other]) {
          waiting[other].delete(candidate);
          if (!candidate.destroyed) { peer = candidate; break; }
        }
        if (!peer) { waiting[role].add(socket); return; }
        peer.removeListener('end', destroyOnEnd);
        socket.removeListener('end', destroyOnEnd);
        const target = role === 'target' ? socket : peer;
        target.write(Buffer.from([dispatch]));
        pair(socket, peer);
      });
    });
    server.maxConnections = channels + 1;
    await new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(path, ok);
    });
    listeners.push(server);
    await chmod(path, 0o666);
  }
  try {
    await listen(targetPath, 'target', 'observer');
    await listen(observerPath, 'observer', 'target');
    return {close};
  } catch (error) {
    await close();
    throw error;
  }
}

export function startTargetHttpLink(path, port) {
  const sockets = new Set();
  let closed = false;
  function connect() {
    if (closed) return;
    let socket;
    try { socket = connectToChannel(path, stream); }
    catch { return; }
    sockets.add(socket);
    const end = () => socket.destroy();
    socket.once('end', end);
    socket.once('close', () => {
      sockets.delete(socket);
      if (!closed) setTimeout(connect, 25);
    });
    socket.once('readable', () => {
      if (socket.read(1)?.[0] !== dispatch) { socket.destroy(); return; }
      socket.removeListener('end', end);
      pair(socket, createConnection({host: '127.0.0.1', port, allowHalfOpen: true}));
    });
  }
  for (let slot = 0; slot < channels; slot++) connect();
  return {close() {
    closed = true;
    for (const socket of sockets) socket.destroy();
  }};
}

async function relay(address, connect) {
  const clients = new Set();
  const server = createServer({allowHalfOpen: true}, client => {
    let peer;
    try { peer = connect(); } catch { client.destroy(); return; }
    clients.add(client);
    client.once('close', () => clients.delete(client));
    pair(client, peer);
  });
  server.maxConnections = channels;
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
  const server = await relay({host: '127.0.0.1', port: 0}, () => connectToChannel(path, stream));
  return {origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , entry, portEnv] = process.argv;
  if (!entry?.startsWith('/repo/') || !/^[A-Z_][A-Z0-9_]{0,40}$/.test(portEnv)) process.exit(78);
  const monitor = watchHttpLink(targetSocketPath, () => process.exit(1));
  const bridge = startTargetHttpLink(targetSocketPath, targetPort);
  const target = spawn(process.execPath, [entry], {
    env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'test', [portEnv]: String(targetPort)},
    stdio: 'ignore',
  });
  const finish = code => { monitor.close(); bridge.close(); process.exit(code ?? 1); };
  target.once('error', () => finish(1));
  target.once('exit', finish);
}
