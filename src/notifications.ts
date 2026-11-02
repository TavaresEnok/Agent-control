import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {Authority,Id,Refusal,digest} from './contracts.ts';
import {Ledger} from './ledger.ts';

export const NotificationPolicy=z.object({completionWindowMs:z.number().int().min(0).max(30000).default(2000),
 maxBatchSize:z.number().int().min(1).max(100).default(20),maxDeliveriesPerTick:z.number().int().min(1).max(100).default(50)}).strict();
const Source=z.enum(['runtime','admission','cancellation','manager']);
const Status=z.enum(['pending','queued','running','waiting','done','review','failed','cancelled','canceled','cancel_requested','cancel_confirmed','blocked','recovered','unknown']);
const Reason=z.enum(['NONE','CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','HUMAN_PAUSED','ADMISSION_CLOSED',
 'STORAGE_LOW_SPACE','DISK_OBSERVATION_UNAVAILABLE','PLAN_CANCELLATION_REQUESTED','RECONCILIATION_REQUIRED','EXECUTION_FAILED','EXECUTION_WAITING','RUNTIME_UNAVAILABLE']);
const Observation=z.object({entityId:Id,source:Source,planRevision:z.number().int().nonnegative(),seq:z.number().int().nonnegative().safe(),status:Status,reason:Reason.default('NONE')}).strict();
type Observation=z.infer<typeof Observation>;
type Item={id:string;entity_id:string;source:z.infer<typeof Source>;plan_revision:number;kind:'completion'|'blocker';status:z.infer<typeof Status>;reason:z.infer<typeof Reason>};
const Acknowledgement=z.object({ok:z.literal(true),id:z.string().min(1).max(200),seq:z.number().int().positive().safe(),localId:z.string().min(1).max(200),didWrite:z.boolean()}).passthrough();
export type OutgoingMessage={id:string;ciphertext:string;localId:string};

export function notificationStatus(status:string):z.infer<typeof Status>{const parsed=Status.safeParse(status);return parsed.success?parsed.data:'unknown';}
export function notificationReason(value:unknown):z.infer<typeof Reason>{
 const code=value instanceof Refusal?value.code:typeof value==='string'?value:'';
 for(const reason of Reason.options)if(reason!=='NONE'&&code.includes(reason))return reason;
 return 'RUNTIME_UNAVAILABLE';
}
function kind(input:Observation):'completion'|'blocker'|null{
 if(['done','review','cancel_confirmed'].includes(input.status))return 'completion';
 if(input.status==='waiting'&&input.reason==='HUMAN_PAUSED')return null;
 return ['failed','waiting','cancelled','canceled','cancel_requested','blocked','unknown'].includes(input.status)?'blocker':null;
}
const descriptions:Record<z.infer<typeof Reason>,string>={NONE:'',CAPACITY_BUSY:'aguardando capacidade',CAPACITY_QUEUED:'na fila de capacidade',
 NO_ELIGIBLE_CAPACITY:'nenhuma conta elegível disponível',ORIGINAL_RESERVE_NOT_NEEDED:'aguardando trabalhador regular',HUMAN_PAUSED:'pausa preservada',
 ADMISSION_CLOSED:'admissão fechada',STORAGE_LOW_SPACE:'aguardando espaço em disco',DISK_OBSERVATION_UNAVAILABLE:'medição de disco indisponível',
 PLAN_CANCELLATION_REQUESTED:'cancelamento solicitado; parada física ainda não confirmada',RECONCILIATION_REQUIRED:'reconciliação necessária',
 EXECUTION_FAILED:'execução falhou; consultar diagnóstico',EXECUTION_WAITING:'execução aguardando resolução',RUNTIME_UNAVAILABLE:'controlador requer atenção'};
function line(item:Item){
 const target=item.source==='manager'?'Gerência':`Plano ${item.plan_revision}`;
 if(item.status==='cancel_confirmed')return `${target}: cancelamento confirmado após reconciliação.`;
 if(item.status==='done')return `${target}: execução concluída; confira o artefato e a integração.`;
 if(item.status==='review')return `${target}: execução concluída para revisão; confira o parecer.`;
 return `${target}: ${descriptions[item.reason]||'bloqueio identificado; consultar diagnóstico'}.`;
}

/** The existing heartbeat calls this service. It owns no timer, runner or
 * scheduler. PG keeps only status metadata; canonical text remains in Happier. */
export class Notifications{
 readonly policy:z.infer<typeof NotificationPolicy>;
 constructor(readonly ledger:Ledger,raw:z.input<typeof NotificationPolicy>={}){this.policy=NotificationPolicy.parse(raw);}
 private async scope(c:pg.PoolClient,principal:string,authority:Authority,sessionId:string){
  await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
  if(!(await c.query('SELECT 1 FROM ac_session_links WHERE session_id=$1 AND context_id=$2 AND principal_id=$3',[sessionId,authority.contextId,principal])).rowCount)
   throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
 }
 async observe(principal:string,authority:Authority,sessionId:string,raw:z.input<typeof Observation>){
  const value=Observation.parse(raw),semantic=digest({status:value.status,reason:value.reason,planRevision:value.planRevision});
  return this.ledger.tx(async c=>{
   await this.scope(c,principal,authority,sessionId);
   await c.query('INSERT INTO ac_notification_cursors(context_id,entity_id,source) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[authority.contextId,value.entityId,value.source]);
   const prior=(await c.query('SELECT * FROM ac_notification_cursors WHERE context_id=$1 AND entity_id=$2 AND source=$3 FOR UPDATE',[authority.contextId,value.entityId,value.source])).rows[0];
   if(BigInt(prior.observed_seq)>BigInt(value.seq))return {duplicate:true,stale:true};
   if(prior.semantic_digest===semantic){
    if(BigInt(prior.observed_seq)<BigInt(value.seq))await c.query('UPDATE ac_notification_cursors SET observed_seq=$4,manager_epoch=$5 WHERE context_id=$1 AND entity_id=$2 AND source=$3',[authority.contextId,value.entityId,value.source,value.seq,authority.epoch]);
    return {duplicate:true,stale:false};
   }
   const revision=BigInt(prior.revision)+1n;
   await c.query('UPDATE ac_notification_cursors SET revision=$4,observed_seq=$5,semantic_digest=$6,manager_epoch=$7 WHERE context_id=$1 AND entity_id=$2 AND source=$3',
    [authority.contextId,value.entityId,value.source,String(revision),value.seq,semantic,authority.epoch]);
   // A newer phase can supersede a not-yet-published observation. Never touch
   // an assigned message, ciphertext, sent flag or immutable publication receipt.
   await c.query('UPDATE ac_notification_items SET superseded=true WHERE context_id=$1 AND entity_id=$2 AND source=$3 AND message_id IS NULL AND NOT superseded',[authority.contextId,value.entityId,value.source]);
   const type=kind(value);if(!type)return {duplicate:false,queued:false};
   const id=digest({contextId:authority.contextId,entityId:value.entityId,source:value.source,revision:String(revision)});
   await c.query(`INSERT INTO ac_notification_items(id,context_id,session_id,entity_id,source,revision,plan_revision,observed_seq,kind,status,reason,manager_epoch,available_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+$13*interval '1 millisecond')`,
    [id,authority.contextId,sessionId,value.entityId,value.source,String(revision),value.planRevision,value.seq,type,value.status,value.reason,authority.epoch,type==='completion'?this.policy.completionWindowMs:0]);
   return {duplicate:false,queued:true};
  });
 }
 async flush(principal:string,authority:Authority,sessionId:string,seal:(value:unknown)=>string){
  return this.ledger.tx(async c=>{
   await this.scope(c,principal,authority,sessionId);
   const items=(await c.query<Item>(`SELECT n.* FROM ac_notification_items n WHERE n.context_id=$1 AND n.session_id=$2 AND n.message_id IS NULL AND NOT n.superseded
    AND (n.kind='blocker' OR EXISTS(SELECT 1 FROM ac_notification_items due WHERE due.context_id=n.context_id AND due.session_id=n.session_id
      AND due.kind='completion' AND due.message_id IS NULL AND NOT due.superseded AND due.available_at<=clock_timestamp()))
    ORDER BY CASE WHEN n.kind='blocker' THEN 0 ELSE 1 END,n.created_at,n.id LIMIT $3 FOR UPDATE OF n`,[authority.contextId,sessionId,this.policy.maxBatchSize*2])).rows;
   let messages=0,observations=0;
   for(const type of ['blocker','completion'] as const){
    const group=items.filter(item=>item.kind===type).slice(0,this.policy.maxBatchSize);if(!group.length)continue;
    const localId='notice-'+randomUUID(),id=sessionId+'|'+localId;
    const text=(type==='completion'?`Atualização agrupada — ${group.length} conclusão(ões):`:`Atenção — ${group.length} bloqueio(s):`)+'\n'+group.map(item=>'- '+line(item)).join('\n');
    const ciphertext=z.string().min(1).max(100000).parse(seal({role:'agent',content:{type:'output',data:{type:'assistant',uuid:localId,
     message:{role:'assistant',content:[{type:'text',text}]}}},meta:{sentFrom:'cli',agentControl:{schemaVersion:1,kind:type,itemIds:group.map(item=>item.id)}}}));
    await c.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext,priority) VALUES($1,$2,$3,$4)',[id,sessionId,ciphertext,type==='blocker'?50:0]);
    await c.query('UPDATE ac_notification_items SET message_id=$2 WHERE id=ANY($1::text[]) AND message_id IS NULL',[group.map(item=>item.id),id]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'notifications.batched',$2)",[authority.contextId,{kind:type,count:group.length,messageId:id,epoch:authority.epoch}]);
    messages++;observations+=group.length;
   }
   return {messages,observations};
  });
 }
 /** ACK loss retries the same immutable ciphertext/localId. A missing or
  * negative ACK is not delivery. The provider's id/seq form an immutable receipt. */
 async deliver(principal:string,authority:Authority,sessionId:string,publish:(message:OutgoingMessage)=>Promise<unknown>,revalidate:()=>Promise<void>=async()=>{}){
  const outgoing=await this.ledger.tx(async c=>{
   await this.scope(c,principal,authority,sessionId);
   return (await c.query<{id:string;ciphertext:string}>('SELECT id,ciphertext FROM ac_chat_messages WHERE session_id=$1 AND NOT sent ORDER BY priority DESC,sequence LIMIT $2',[sessionId,this.policy.maxDeliveriesPerTick])).rows;
  });
  let sent=0;
  for(const message of outgoing){
   await revalidate();
   await this.ledger.heartbeat(authority);
   await this.ledger.tx(async c=>{await this.scope(c,principal,authority,sessionId);});
   const localId=message.id.slice(sessionId.length+1),raw=await publish({...message,localId});
   const parsed=Acknowledgement.safeParse(raw);
   if(!parsed.success||parsed.data.localId!==localId)throw new Refusal('HAPPIER_PUBLICATION_UNCONFIRMED');
   const identity={id:parsed.data.id,seq:parsed.data.seq,localId},hash=digest(identity);
   await this.ledger.tx(async c=>{
    await this.scope(c,principal,authority,sessionId);
    await c.query(`INSERT INTO ac_chat_publication_receipts(message_id,session_id,provider_message_id,provider_seq,local_id,identity_digest,acknowledged_epoch)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[message.id,sessionId,identity.id,identity.seq,localId,hash,authority.epoch]);
    const saved=(await c.query('SELECT identity_digest,session_id FROM ac_chat_publication_receipts WHERE message_id=$1',[message.id])).rows[0];
    if(saved.identity_digest!==hash||saved.session_id!==sessionId)throw new Refusal('HAPPIER_PUBLICATION_RECEIPT_CONFLICT');
    await c.query('UPDATE ac_chat_messages SET sent=true WHERE id=$1 AND session_id=$2 AND NOT sent',[message.id,sessionId]);
   });sent++;
  }
  return {sent};
 }
}
