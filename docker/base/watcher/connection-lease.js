'use strict';

const MAX_CONNECTION_AGE_MS = 300_000;

function limitConnectionLifetime(connection, expire, ttlMs = MAX_CONNECTION_AGE_MS) {
  const timer = setTimeout(expire, ttlMs);
  timer.unref();
  connection.once('close', () => clearTimeout(timer));
}

module.exports = { MAX_CONNECTION_AGE_MS, limitConnectionLifetime };
