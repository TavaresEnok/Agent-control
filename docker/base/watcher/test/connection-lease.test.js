'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const { test } = require('node:test');
const { MAX_CONNECTION_AGE_MS } = require('../connection-lease');
const { attachWatcherLease } = require('../index');
const { proxyConnection } = require('../ide-proxy');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('watcher closes at an absolute deadline even while messages arrive', { timeout: 3000 }, async () => {
  assert.equal(MAX_CONNECTION_AGE_MS, 300_000);
  const ws = new EventEmitter();
  ws.terminate = () => ws.emit('close');
  attachWatcherLease(ws, 100);
  const activity = setInterval(() => ws.emit('message', 'active'), 10);
  try {
    await once(ws, 'close');
  } finally {
    clearInterval(activity);
  }
});

test('IDE proxy closes both active sockets at the absolute deadline and remains available', { timeout: 3000 }, async () => {
  const upstreamConnections = new Set();
  let firstClosed;
  const firstUpstreamClosed = new Promise((resolve) => { firstClosed = resolve; });
  let firstConnection = true;
  const upstream = net.createServer((socket) => {
    upstreamConnections.add(socket);
    if (firstConnection) {
      firstConnection = false;
      socket.once('close', firstClosed);
    }
    socket.on('error', () => {});
    socket.on('close', () => upstreamConnections.delete(socket));
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);
  const proxy = net.createServer((client) => {
    proxyConnection(client, () => net.connect(upstreamPort, '127.0.0.1'), 150);
  });
  const proxyPort = await listen(proxy);
  const client = net.connect(proxyPort, '127.0.0.1');
  client.on('error', () => {});
  let packets = 0;
  client.on('data', () => { packets += 1; });
  await once(client, 'connect');
  const activity = setInterval(() => client.write('active'), 10);
  try {
    await new Promise((resolve) => client.once('close', resolve));
    assert.ok(packets > 0, 'proxy relays traffic before expiry');
    await firstUpstreamClosed;
    const replacement = net.connect(proxyPort, '127.0.0.1');
    replacement.on('error', () => {});
    await once(replacement, 'connect');
    replacement.destroy();
  } finally {
    clearInterval(activity);
    client.destroy();
    for (const socket of upstreamConnections) socket.destroy();
    await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  }
});
