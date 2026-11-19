import type pg from 'pg';
import {Id, Refusal, type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export const MODULE_RUNTIME_BIN = 'docker';
export const MODULE_CONTAINER_LABEL = 'io.agent-control.module-owner';
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;

export type CollectorProcess = (
  args: readonly string[],
  options: {timeoutMs: number; maxStdoutBytes: number; signal?: AbortSignal},
) => Promise<{code: number; stdout: Buffer; stderr: string}>;

type ModuleContainerIdentity = {token: string; id: string | null};

export function moduleContainerName(token: string): string {
  return `ac-module-${Id.parse(token)}`;
}

function containerCleanupPending(): Refusal {
  return new Refusal('VERIFY_CONTAINER_CLEANUP_PENDING', 503);
}

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
): Promise<void> {
  const id = await findContainer(run, owner);
  if (!id) {
    // Without the ID, create may still be in flight or have lost its ACK.
    if (owner.id === null) throw containerCleanupPending();
    return;
  }
  if (owner.id === null) await rememberId(id);
  await dockerCommand(run, ['container', 'rm', '--force', id]);
  if (await findContainer(run, {...owner, id})) throw containerCleanupPending();
}

export async function assertOwnedModuleContainer(run: CollectorProcess, token: string, id: string): Promise<void> {
  if (!await findContainer(run, {token, id})) throw containerCleanupPending();
}

export function moduleContainerJournal(
  ledger: Ledger, principal: string, authority: Authority, runId: string, run: CollectorProcess,
) {
  async function rememberId(client: pg.Pool | pg.PoolClient, token: string, id: string): Promise<void> {
    const result = await client.query(
      `UPDATE ac_verify_runs SET collector_container_id=$3 WHERE id=$1 AND collector_container_token=$2
       AND (collector_container_id IS NULL OR collector_container_id=$3)`, [runId, token, id],
    );
    if (!result.rowCount) throw containerCleanupPending();
  }

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
    async beforeStart(token: string, id: string): Promise<void> {
      await rememberId(ledger.pool, token, id);
      await ledger.tx(async client => {
        await ledger.authorize(client, principal, authority.contextId);
        await ledger.fence(client, authority);
        const result = await client.query(
          `SELECT 1 FROM ac_verify_runs WHERE id=$1 AND context_id=$2 AND status='running'
           AND collector_container_token=$3 AND collector_container_id=$4`, [runId, authority.contextId, token, id],
        );
        if (!result.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      });
    },
    async cleanup(token: string, knownId?: string): Promise<void> {
      try {
        // The session lock outlives individual commits. A discovered ID is
        // committed before rm, including when the context lease has expired.
        const client = await ledger.pool.connect();
        let unlocked = false;
        try {
          await client.query('SELECT pg_advisory_lock(hashtextextended($1, 108))', [token]);
          const {rows: [row]} = await client.query<{collector_container_id: string | null}>(
            `SELECT collector_container_id FROM ac_verify_runs WHERE id=$1 AND context_id=$2
             AND collector_container_token=$3`, [runId, authority.contextId, token],
          );
          if (!row) return;
          if (knownId && row.collector_container_id && row.collector_container_id !== knownId) throw containerCleanupPending();
          const id = row.collector_container_id ?? knownId ?? null;
          if (id && !row.collector_container_id) await rememberId(client, token, id);
          await removeOwnedModuleContainer(run, {token, id}, foundId => rememberId(client, token, foundId));
          await client.query(
            'UPDATE ac_verify_runs SET collector_container_token=NULL, collector_container_id=NULL WHERE id=$1 AND collector_container_token=$2',
            [runId, token],
          );
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
        // If the journal is unavailable, a known ID still permits immediate
        // physical cleanup. Recovery will later reconcile the database entry.
        if (!(error instanceof Refusal) && knownId) {
          await removeOwnedModuleContainer(run, {token, id: knownId}, async () => {});
        }
        throw containerCleanupPending();
      }
    },
  };
}
