import type {PoolClient} from 'pg';
import {Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export type ExamIntentTarget = {intentId: string; contextId: string};
export type ExamIntentLedger = Pick<Ledger, 'tx' | 'refreshPending'>;

/**
 * Finalize an exam intent inside an existing transaction (`done` on success, `failed` on failure).
 * Only transitions from `accepted`, and updates any checkpoint `pendingIntentIds`.
 */
export async function finishExamIntentTx(
  c: PoolClient,
  ledger: Pick<Ledger, 'refreshPending'>,
  target: ExamIntentTarget,
  state: 'done' | 'failed',
): Promise<void> {
  await c.query(
    "UPDATE ac_intents SET state=$3 WHERE id=$1 AND context_id=$2 AND state='accepted'",
    [target.intentId, target.contextId, state],
  );
  await ledger.refreshPending(c, target.contextId);
}

/** Shared finalizer for design exam, design create, and security verification intents. */
export async function finishExamIntent(
  ledger: ExamIntentLedger,
  target: ExamIntentTarget,
  state: 'done' | 'failed',
): Promise<void> {
  await ledger.tx(async c => {
    await finishExamIntentTx(c, ledger, target, state);
  });
}

/**
 * Run `work` while intercepting `SIGINT` (Ctrl-C) and `SIGTERM` so the caller's `finally`
 * finishes the exam intent as `failed` and releases leases instead of dying with an orphaned `accepted` row.
 */
export async function withExamSignals<T>(
  work: (signal: AbortSignal) => Promise<T>,
  onSignal?: () => Promise<void> | void,
): Promise<T> {
  const controller = new AbortController();
  let rejectInterrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupt = reject;
  });
  void interrupted.catch(() => undefined);
  const trigger = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (onSignal) void Promise.resolve(onSignal()).catch(() => undefined);
    rejectInterrupt(new Refusal('EXAM_INTERRUPTED'));
  };
  process.on('SIGINT', trigger);
  process.on('SIGTERM', trigger);
  try {
    const task = work(controller.signal);
    void task.catch(() => undefined);
    return await Promise.race([task, interrupted]);
  } finally {
    process.off('SIGINT', trigger);
    process.off('SIGTERM', trigger);
  }
}
