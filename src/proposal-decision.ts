import {createHash} from 'node:crypto';
import type pg from 'pg';
import {Refusal} from './contracts.ts';

/** Durable, unique decision on a manager proposal. The table key is (context, revision): one decision per proposal,
 * bound to the proposal digest. An approval fixes the id of its single execution intent, so recovery and concurrent
 * attempts all create or find the same one. */
export type ProposalDecision={contextId:string;revision:number;digest:string;decision:'approved'|'discarded';source:'manual'|'auto'|'api'|'legacy';intentId:string|null};

export function proposalStartIntentId(contextId:string,revision:number){
 const h=createHash('sha256').update(`proposal-start\0${contextId}\0${revision}`).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
type Row={context_id:string;revision:number;proposal_digest:string;decision:ProposalDecision['decision'];source:ProposalDecision['source'];intent_id:string|null};
const view=(row:Row):ProposalDecision=>({contextId:row.context_id,revision:row.revision,digest:row.proposal_digest,decision:row.decision,source:row.source,intentId:row.intent_id});

/** Records the decision unless one exists, and returns the one that stands. The primary key serializes concurrent
 * callers: the first writer decides, every other caller (same or opposite decision, or a repeat) reads its row. */
export async function decideProposal(c:pg.PoolClient,input:{contextId:string;revision:number;digest:string;decision:'approved'|'discarded';source:'manual'|'auto'}){
 const intentId=input.decision==='approved'?proposalStartIntentId(input.contextId,input.revision):null;
 const inserted=await c.query<Row>(`INSERT INTO ac_proposal_decisions(context_id,revision,proposal_digest,decision,source,intent_id)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(context_id,revision) DO NOTHING RETURNING *`,[input.contextId,input.revision,input.digest,input.decision,input.source,intentId]);
 if(inserted.rowCount)return {decision:view(inserted.rows[0]),created:true};
 const stored=(await c.query<Row>('SELECT * FROM ac_proposal_decisions WHERE context_id=$1 AND revision=$2',[input.contextId,input.revision])).rows[0];
 if(!stored)throw new Refusal('PROPOSAL_DECISION_UNAVAILABLE');
 if(stored.proposal_digest!==input.digest)throw new Refusal('PROPOSAL_DIGEST_CONFLICT');
 return {decision:view(stored),created:false};
}
/** Approved decisions whose execution intent is not in the ledger yet: a crash or a lost response left them unstarted. */
export async function unstartedProposals(pool:pg.Pool,contextId:string):Promise<ProposalDecision[]>{
 return (await pool.query<Row>(`SELECT d.* FROM ac_proposal_decisions d WHERE d.context_id=$1 AND d.decision='approved'
  AND NOT EXISTS(SELECT 1 FROM ac_intents i WHERE i.id=d.intent_id) ORDER BY d.revision`,[contextId])).rows.map(view);
}
export async function proposalDecisionOf(pool:pg.Pool,contextId:string,revision:number):Promise<ProposalDecision|null>{
 const row=(await pool.query<Row>('SELECT * FROM ac_proposal_decisions WHERE context_id=$1 AND revision=$2',[contextId,revision])).rows[0];
 return row?view(row):null;
}
