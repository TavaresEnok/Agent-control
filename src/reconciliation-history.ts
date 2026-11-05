import type {Ledger} from './ledger.ts';
import {Refusal,type Authority} from './contracts.ts';

export const historyPageSql=`SELECT row_id,seq::text,revision::text FROM (
     (SELECT e.row_id,e.seq,e.revision FROM ac_reconciliation_entries e
      WHERE e.context_id=$1 AND e.source=$2 AND e.seq>greatest($3::bigint,$7::bigint) AND e.seq<=$4 AND NOT $6::boolean ORDER BY e.seq LIMIT $5)
     UNION
     (SELECT e.row_id,e.seq,e.revision FROM ac_reconciliation_visits v JOIN ac_reconciliation_entries e ON e.seq=v.seq
      WHERE v.context_id=$1 AND v.lane=$8 AND v.active AND e.source=$2 AND v.seq>$3 AND v.seq<=$4 AND NOT $6::boolean ORDER BY e.seq LIMIT $5)
     UNION
     (SELECT e.row_id,e.seq,e.revision FROM ac_reconciliation_entries e
      WHERE e.context_id=$1 AND e.source=$2 AND e.seq>$3 AND e.seq<=$4 AND $6::boolean ORDER BY e.seq LIMIT $5)
    ) candidates ORDER BY candidates.seq LIMIT $5`;

export type HistoryPage={ids:string[];source:string;lane:string;revision:string;cursor:string;ceiling:string;floor:string;sweep:string;entries:{row_id:string;revision:string}[];retain:string[]};
/** One finite page per tick. Fixed sweep ceilings prevent new arrivals extending a
 * sweep forever. Every membership is revisited, including unchanged uncertain
 * rows and rows whose eligibility changed through a different table. A crash
 * before acknowledgement replays the page; physical effects remain idempotent. */
export class ReconciliationHistory{
 constructor(readonly ledger:Ledger,readonly pageSize=32){
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>256)throw new Refusal('INVALID_RECONCILIATION_PAGE_SIZE');
 }
 async page(authority:Authority,lane:string,source:string):Promise<HistoryPage>{
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   await c.query(`INSERT INTO ac_reconciliation_progress(context_id,lane,manager_epoch) VALUES($1,$2,$3)
    ON CONFLICT(context_id,lane) DO NOTHING`,[authority.contextId,lane,authority.epoch]);
   const p=(await c.query(`SELECT * FROM ac_reconciliation_progress WHERE context_id=$1 AND lane=$2 FOR UPDATE`,[authority.contextId,lane])).rows[0];
   let cursor=p.cursor_seq as string,ceiling=p.ceiling_seq as string,sweep=p.sweep as string,floor=p.floor_seq as string;
   if(BigInt(cursor)>=BigInt(ceiling)){
    cursor='0';floor=ceiling;sweep=(BigInt(sweep)+1n).toString();ceiling=(await c.query(`SELECT coalesce(max(seq),0)::text ceiling FROM ac_reconciliation_entries WHERE context_id=$1 AND source=$2`,[authority.contextId,source])).rows[0].ceiling;
   }
   const audit=BigInt(sweep)%16n===0n;
   // Normal sweeps merge two indexed sets: previously active entries and new
   // membership beyond the preceding sweep ceiling. Inactive history is read
   // only by the periodic audit, not searched on every tick.
   const rows=(await c.query(historyPageSql,[authority.contextId,source,cursor,ceiling,this.pageSize,audit,floor,lane])).rows;
   return {ids:rows.map(r=>r.row_id),source,lane,revision:p.revision,cursor:rows.length?rows[rows.length-1].seq:ceiling,ceiling,floor,sweep,entries:rows,retain:[]};
  });
 }
 async run<T>(authority:Authority,lane:string,source:string,work:(ids:string[],retain:(ids:string[])=>void)=>Promise<T>):Promise<T>{
  const page=await this.page(authority,lane,source);
  page.retain=page.ids;
  try{return await work(page.ids,ids=>{page.retain=ids;});}finally{await this.acknowledge(authority,page);}
 }
 async acknowledge(authority:Authority,page:HistoryPage){
  await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   // CAS also prevents an older concurrent invocation of this manager from
   // moving progress backwards after another invocation finished first.
   const r=await c.query(`UPDATE ac_reconciliation_progress SET cursor_seq=$4,ceiling_seq=$5,
    revision=revision+1,manager_epoch=$6,sweep=$7,floor_seq=$8,updated_at=clock_timestamp()
    WHERE context_id=$1 AND lane=$2 AND revision=$3`,[authority.contextId,page.lane,page.revision,page.cursor,page.ceiling,authority.epoch,page.sweep,page.floor]);
   if(!r.rowCount)throw new Refusal('RECONCILIATION_PAGE_SUPERSEDED');
   // Rows changed while effects were running stay dirty. Eligible uncertain rows
   // stay dirty too. Every sixteenth sweep audits all membership, covering
   // eligibility changes caused solely by related tables.
   await c.query(`INSERT INTO ac_reconciliation_visits(context_id,lane,seq,revision,active)
    SELECT e.context_id,$5,e.seq,p.revision,(e.row_id=ANY($3::uuid[]) OR e.revision<>p.revision)
    FROM ac_reconciliation_entries e JOIN jsonb_to_recordset($2::jsonb) AS p(row_id uuid,revision bigint) ON e.row_id=p.row_id
    WHERE e.context_id=$1 AND e.source=$4
    ON CONFLICT(context_id,lane,seq) DO UPDATE SET revision=excluded.revision,active=excluded.active`,
    [authority.contextId,JSON.stringify(page.entries),page.retain,page.source,page.lane]);
  });
 }
}
