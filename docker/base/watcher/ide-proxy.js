'use strict';

const net = require('node:net');
const { limitConnectionLifetime } = require('./connection-lease');

function proxyConnection(client, connectUpstream = () => net.connect({ host: '127.0.0.1', port: 8444 }), ttlMs) {
  const upstream = connectUpstream();
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.once('close', close);
  upstream.once('close', close);
  limitConnectionLifetime(client, close, ttlMs);
  client.pipe(upstream);
  upstream.pipe(client);
}

if (require.main === module) {
  net.createServer((client) => proxyConnection(client)).listen(8443, '0.0.0.0');
}

module.exports = { proxyConnection };
