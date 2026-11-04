import type pg from 'pg';
import { z } from 'zod';
import { Id, Refusal } from './contracts.ts';

const Key=z.object({
  parentIntentId:Id,
  runId:Id,
  intentId:Id,
  epoch:z.number().int().positive(),
}).strict();

/** A managed copy is permanently bound to its first writer identity. */
export async function claimWorktreeWriter(c:pg.PoolClient,raw:z.input<typeof Key>){
  const key=Key.parse(raw);
  const current=(await c.query('SELECT holder_intent_id,manager_epoch,state FROM ac_worktree_writers WHERE parent_intent_id=$1 AND run_id=$2 FOR UPDATE',
    [key.parentIntentId,key.runId])).rows[0];
  if(!current){
    await c.query(`INSERT INTO ac_worktree_writers(parent_intent_id,run_id,holder_intent_id,manager_epoch,state) VALUES($1,$2,$3,$4,'held')`,
      [key.parentIntentId,key.runId,key.intentId,key.epoch]);
    return {state:'held' as const,acquired:'new' as const};
  }
  if(current.state==='held'&&current.holder_intent_id===key.intentId&&Number(current.manager_epoch)===key.epoch)
    return {state:'held' as const,acquired:'same' as const};
  throw new Refusal('WORKTREE_WRITER_BUSY');
}

/** A database update alone cannot establish that a physical writer lost access. */
export async function neutralizeWorktreeWriter(c:pg.PoolClient,raw:z.input<typeof Key>){
  const key=Key.parse(raw);
  const held=await c.query(`SELECT 1 FROM ac_worktree_writers
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held' FOR UPDATE`,
    [key.parentIntentId,key.runId,key.intentId,key.epoch]);
  if(!held.rowCount)throw new Refusal('WORKTREE_WRITER_NOT_HELD');
  throw new Refusal('WORKTREE_TERMINAL_PROOF_REQUIRED');
}
