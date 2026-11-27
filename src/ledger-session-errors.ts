import type pg from 'pg';

const knownCodes=new Set(['25P03','25P04','57P01','57P02','57P03','08006','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE']);

/** Records an error of a session the server ended (idle-in-transaction timeout, restart) instead of letting it escape as an
 * unhandled 'error' event that takes the whole process down. The failing query still rejects for its caller. */
export function logLedgerSessionError(error: Error) {
  const code=(error as {code?: string}).code;
  console.error('LEDGER_SESSION_ERROR', code&&knownCodes.has(code)?code:'UNKNOWN');
}
/** The same for any pool built from the ledger's options (it inherits the idle-in-transaction timeout). */
export function watchLedgerSessions(pool: pg.Pool) {
  pool.on('connect', client => { client.on('error', logLedgerSessionError); });
  pool.on('error', logLedgerSessionError);
}
