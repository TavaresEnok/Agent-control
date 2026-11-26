import type pg from 'pg';

/** Records an error of a session the server ended (idle-in-transaction timeout, restart) instead of letting it escape as an
 * unhandled 'error' event that takes the whole process down. The failing query still rejects for its caller. */
export function logLedgerSessionError(error: Error) {
  console.error('LEDGER_SESSION_ERROR', (error as {code?: string}).code ?? error.message);
}
/** The same for any pool built from the ledger's options (it inherits the idle-in-transaction timeout). */
export function watchLedgerSessions(pool: pg.Pool) {
  pool.on('connect', client => { client.on('error', logLedgerSessionError); });
  pool.on('error', logLedgerSessionError);
}
