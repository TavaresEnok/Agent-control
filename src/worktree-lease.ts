import type pg from 'pg';
import { z } from 'zod';
import { Id, Refusal } from './contracts.ts';

const Key=z.object({
  parentIntentId:Id,
  runId:Id,
  intentId:Id,
  epoch:z.number().int().positive(),
}).strict();

/** The same intent may repeat. Another intent waits until the holder is explicitly neutralized.
 * This function does not delete, chmod, or kill a process. */
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
  if(current.state==='neutralized'){
    await c.query(`UPDATE ac_worktree_writers SET holder_intent_id=$3,manager_epoch=$4,state='held' WHERE parent_intent_id=$1 AND run_id=$2 AND state='neutralized'`,
      [key.parentIntentId,key.runId,key.intentId,key.epoch]);
    return {state:'held' as const,acquired:'reclaimed' as const};
  }
  throw new Refusal('WORKTREE_WRITER_BUSY');
}

/** Records that the holder released the copy. It does not remove the directory or imply the next writer may start
 * until a later claim. A different epoch or intent cannot neutralize the row. */
export async function neutralizeWorktreeWriter(c:pg.PoolClient,raw:z.input<typeof Key>){
  const key=Key.parse(raw);
  const updated=await c.query(`UPDATE ac_worktree_writers SET state='neutralized'
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held'`,
    [key.parentIntentId,key.runId,key.intentId,key.epoch]);
  if(!updated.rowCount)throw new Refusal('WORKTREE_WRITER_NOT_HELD');
  return {state:'neutralized' as const};
}
