import {spawn} from 'node:child_process';
import type pg from 'pg';
import {Id, Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export const MODULE_RUNTIME_BIN = 'docker';
export const MODULE_CONTAINER_LABEL = 'io.agent-control.module-owner';
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;

export type BoundedProcessResult = {code: number; stdout: Buffer; stderr: string};
export type CollectorProcess = (
  args: readonly string[],
  options: {timeoutMs: number; maxStdoutBytes: number; signal?: AbortSignal},
) => Promise<BoundedProcessResult>;

type CleanupOptions = {creationRejected?: boolean; startAuthorized?: boolean; recovering?: boolean};

type ModuleContainerIdentity = {token: string; id: string | null};

export function moduleContainerName(token: string): string {
  return `ac-module-${Id.parse(token)}`;
}

function containerCleanupPending(): Refusal {
  return new Refusal('VERIFY_CONTAINER_CLEANUP_PENDING', 503);
}

export const runBoundedCollectorProcess: CollectorProcess = (args, options) => {
  if (options.signal?.aborted) return Promise.reject(new Refusal('VERIFY_TOOLS_FAILED', 503));
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] ?? '', [...args.slice(1)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent'},
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const fail = (error: Refusal) => {
      if (!settle()) return;
      // A broken or blocked client may never emit close. The daemon operation
      // has its own lifetime and is reconciled through the durable journal.
      reject(error);
      child.unref();
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const onAbort = () => fail(new Refusal('VERIFY_TOOLS_FAILED', 503));
    const timer = setTimeout(onAbort, options.timeoutMs);
    child.once('error', onAbort);
    child.once('close', code => {
      if (code === null) {
        onAbort();
        return;
      }
      if (settle()) resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, 1000),
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) fail(new Refusal('VERIFY_STDOUT_LIMIT', 400));
      else stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      const sampleRemaining = 4096 - stderrBytes;
      if (sampleRemaining <= 0) return;
      const sample = chunk.subarray(0, sampleRemaining);
      stderrBytes += sample.byteLength;
      stderrChunks.push(sample);
    });
    child.stdout?.once('error', onAbort);
    child.stderr?.once('error', onAbort);
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) onAbort();
  });
};

export function createdContainerId(stdout: Buffer): string {
  const id = stdout.toString('utf8').trim();
  if (!FULL_CONTAINER_ID.test(id)) throw containerCleanupPending();
  return id;
}

async function dockerCommand(run: CollectorProcess, args: string[]): Promise<string> {
  try {
    const result = await run([MODULE_RUNTIME_BIN, ...args], {timeoutMs: 10_000, maxStdoutBytes: 4096});
    if (result.code === 0) return result.stdout.toString('utf8').trim();
  } catch {
    // Command errors and timeout leave physical state unknown.
  }
  throw containerCleanupPending();
}

async function findContainer(run: CollectorProcess, owner: ModuleContainerIdentity): Promise<string | null> {
  const name = moduleContainerName(owner.token);
  if (owner.id !== null && !FULL_CONTAINER_ID.test(owner.id)) throw containerCleanupPending();
  const filter = owner.id === null ? `label=${MODULE_CONTAINER_LABEL}=${owner.token}` : `id=${owner.id}`;
  const output = await dockerCommand(run, ['container', 'ls', '--all', '--no-trunc', '--filter', filter,
    '--format', `{{.ID}} {{.Names}} {{.Label "${MODULE_CONTAINER_LABEL}"}}`]);
  if (!output) return null;
  const [id, foundName, label, extra] = output.split(/\s+/);
  if (!id || !FULL_CONTAINER_ID.test(id) || (owner.id !== null && owner.id !== id)
    || foundName !== name || label !== owner.token || extra !== undefined) throw containerCleanupPending();
  return id;
}

export async function removeOwnedModuleContainer(
  run: CollectorProcess, owner: ModuleContainerIdentity, rememberId: (id: string) => Promise<void>,
  options: CleanupOptions = {},
): Promise<'removed' | 'deferred'> {
  const id = await findContainer(run, owner);
  if (!id) {
    // Without the ID, create may still be in flight or have lost its ACK.
    if (owner.id !== null || options.creationRejected) return 'removed';
    // A successor fenced the previous run. Without a durable ID that run
    // cannot start anything. Keep its token to collect a late create on a later pass.
    if (options.recovering) return 'deferred';
    throw containerCleanupPending();
  }
  if (owner.id === null) await rememberId(id);
  // A lost rm response also leaves the physical outcome unknown. Only a
  // successful lookup confirming that the immutable ID is gone clears it.
  await dockerCommand(run, ['container', 'rm', '--force', id]).catch(() => undefined);
  if (await findContainer(run, {...owner, id})) throw containerCleanupPending();
  return 'removed';
}

export async function assertOwnedModuleContainer(run: CollectorProcess, token: string, id: string): Promise<void> {
  if (!await findContainer(run, {token, id})) throw containerCleanupPending();
}

async function rememberId(client: pg.PoolClient, runId: string, token: string, id: string): Promise<void> {
  const result = await client.query(
    `UPDATE ac_verify_runs SET collector_container_id=$3 WHERE id=$1 AND collector_container_token=$2
     AND (collector_container_id IS NULL OR collector_container_id=$3)`, [runId, token, id],
  );
  if (!result.rowCount) throw containerCleanupPending();
}

export async function cleanupModuleContainer(
  ledger: Ledger, contextId: string, runId: string, run: CollectorProcess, token: string, knownId?: string,
  options: CleanupOptions = {},
): Promise<void> {
  try {
    // Use only the token lock here. A candidate manager can clean up before
    // acquiring the context, even when the previous owner's lease expired.
    const client = await ledger.pool.connect();
    let unlocked = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 108))', [token]);
      const {rows: [row]} = await client.query<{collector_container_id: string | null}>(
        `SELECT collector_container_id FROM ac_verify_runs WHERE id=$1 AND context_id=$2
         AND collector_container_token=$3`, [runId, contextId, token],
      );
      if (!row) return;
      if (knownId && row.collector_container_id && row.collector_container_id !== knownId) throw containerCleanupPending();
      const id = row.collector_container_id ?? knownId ?? null;
      let persistedId = row.collector_container_id;
      const persistId = async (foundId: string) => {
        await rememberId(client, runId, token, foundId);
        persistedId = foundId;
      };
      if (id && !persistedId) await persistId(id);
      const outcome = await removeOwnedModuleContainer(run, {token, id}, persistId, options);
      if (outcome === 'deferred') return;
      const cleared = await client.query(
        `UPDATE ac_verify_runs SET collector_container_token=NULL, collector_container_id=NULL, collector_start_pending=false
         WHERE id=$1 AND context_id=$2 AND collector_container_token=$3 AND collector_container_id IS NOT DISTINCT FROM $4`,
        [runId, contextId, token, persistedId],
      );
      if (!cleared.rowCount) throw containerCleanupPending();
    } finally {
      try {
        const {rows: [row]} = await client.query<{unlocked: boolean}>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 108)) AS unlocked', [token],
        );
        unlocked = row?.unlocked === true;
      } finally {
        client.release(!unlocked);
      }
    }
  } catch (error) {
    // An authorized start implies the ID was stored durably. Otherwise
    // leave the stopped container discoverable until the database recovers.
    if (!(error instanceof Refusal) && knownId && options.startAuthorized) {
      await removeOwnedModuleContainer(run, {token, id: knownId}, async () => {});
    }
    throw containerCleanupPending();
  }
}

export function moduleContainerJournal(
  ledger: Ledger, principal: string, authority: Authority, runId: string, run: CollectorProcess,
) {
  return {
    async register(token: string): Promise<void> {
      await ledger.tx(async client => {
        await ledger.authorize(client, principal, authority.contextId);
        await ledger.fence(client, authority);
        const result = await client.query(
          `UPDATE ac_verify_runs SET collector_container_token=$3 WHERE id=$1 AND context_id=$2
           AND status='running' AND collector_container_token IS NULL`, [runId, authority.contextId, token],
        );
        if (!result.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      });
    },
    async start<T>(token: string, id: string, launch: () => Promise<T>): Promise<T> {
      // Commit before sending start. A process crash, a lost response or a
      // rollback in the launch transaction must leave the transfer guard armed.
      await ledger.tx(async client => {
        await ledger.authorize(client, principal, authority.contextId);
        await ledger.fence(client, authority);
        const result = await client.query(
          `UPDATE ac_verify_runs SET collector_container_id=$4, collector_start_pending=true
           WHERE id=$1 AND context_id=$2 AND status='running' AND collector_container_token=$3
           AND collector_container_id IS NULL`, [runId, authority.contextId, token, id],
        );
        if (!result.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      });
      return ledger.tx(async client => {
        await ledger.authorize(client, principal, authority.contextId);
        await ledger.fence(client, authority);
        const params = [runId, authority.contextId, token, id];
        const result = await client.query(
          `SELECT 1 FROM ac_verify_runs WHERE id=$1 AND context_id=$2 AND status='running'
           AND collector_container_token=$3 AND collector_container_id=$4 AND collector_start_pending FOR UPDATE`, params,
        );
        if (!result.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT', 409);
        const started = await launch();
        await client.query(
          `UPDATE ac_verify_runs SET collector_start_pending=false
           WHERE id=$1 AND context_id=$2 AND collector_container_token=$3 AND collector_container_id=$4`, params,
        );
        return started;
      });
    },
    async cleanup(token: string, knownId?: string, options: CleanupOptions = {}): Promise<void> {
      await cleanupModuleContainer(ledger, authority.contextId, runId, run, token, knownId, options);
    },
  };
}
