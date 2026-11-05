import { createHash,randomUUID,randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Id,Refusal,digest } from './contracts.ts';
import {HistoricalSnapshot,checkHistoricalRuns,stageHistoricalRecords,IMPORT_HISTORY_MAX_RECORDS} from './import-history.ts';
import { Ledger } from './ledger.ts';
import type pg from 'pg';
const External=z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const Message=z.object({id:External,ciphertext:z.string().min(1).max(1024*1024).regex(/^[A-Za-z0-9+/=_-]+$/)}).strict();
const Run=z.object({id:External,state:z.enum(['completed','failed','paused','unknown']),artifactRef:z.string().max(300).optional()}).strict();
const ContextBase=z.object({id:External,sessionId:z.string().min(1).max(200),sourcePaused:z.boolean(),
 keyVariant:z.enum(['legacy','dataKey']),keyFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
 messages:z.array(Message).max(1000),runs:z.array(Run).max(10000)}).strict();
function uniqueContext(v:{messages:{id:string}[];runs:{id:string}[]},c:z.RefinementCtx){for(const [key,values] of [['messages',v.messages],['runs',v.runs]] as const)if(new Set(values.map(x=>x.id)).size!==values.length)c.addIssue({code:'custom',path:[key],message:'DUPLICATE_EXTERNAL_ID'});}
const Context=ContextBase.superRefine(uniqueContext);
const RunV2=z.object({id:External,state:Run.shape.state,artifactRefDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
const ContextV2=ContextBase.extend({runs:z.array(RunV2).max(10000),history:HistoricalSnapshot}).superRefine((v,c)=>{uniqueContext(v,c);checkHistoricalRuns(v.history,v.runs,c);});
const fields={importId:Id,projectId:Id,sourceNamespace:External};
export const ImportBundleV1=z.object({schemaVersion:z.literal(1),...fields,contexts:z.array(Context).min(1).max(100)}).strict();
export const ImportBundleV2=z.object({schemaVersion:z.literal(2),...fields,contexts:z.array(ContextV2).min(1).max(100)}).strict();
export const ImportBundle=z.discriminatedUnion('schemaVersion',[ImportBundleV1,ImportBundleV2]).superRefine((v,c)=>{
 if(new Set(v.contexts.map(x=>x.id)).size!==v.contexts.length||new Set(v.contexts.map(x=>x.sessionId)).size!==v.contexts.length)c.addIssue({code:'custom',path:['contexts'],message:'DUPLICATE_CONTEXT_OR_SESSION'});
 if(v.schemaVersion===2&&v.contexts.reduce((total,item)=>total+item.history.plans.length+item.history.evidence.length+item.runs.length,0)>IMPORT_HISTORY_MAX_RECORDS)c.addIssue({code:'custom',message:'IMPORT_HISTORY_RECORD_LIMIT'});
 if(v.schemaVersion===2&&v.contexts.reduce((total,item)=>total+item.messages.length,0)>10000)c.addIssue({code:'custom',message:'IMPORT_MESSAGE_LIMIT'});
});
export interface ImportTransport{
 verifySession(principal:string,sessionId:string):Promise<boolean>;
 verifySessionKey(principal:string,sessionId:string,variant:'legacy'|'dataKey',fingerprint:string):Promise<boolean>;
 verifyCiphertext(principal:string,sessionId:string,ciphertext:string):Promise<boolean>;
 deliver(principal:string,sessionId:string,localId:string,ciphertext:string):Promise<void>;
}
function localId(namespace:string,contextId:string,messageId:string){
 return 'import-'+createHash('sha256').update(JSON.stringify([namespace,contextId,messageId])).digest('hex');
}
/** Stage ciphertext and durable identities before delivery. Import never creates a runnable job. */
export class IsolatedImport{
 constructor(readonly ledger:Ledger,readonly transport:ImportTransport){}
 private async owner(c:pg.PoolClient,principal:string,projectId:string){
  if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner' FOR SHARE",[projectId,principal])).rowCount)
   throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 }
 async stage(principal:string,raw:z.input<typeof ImportBundle>){
  let serialized:string;try{serialized=JSON.stringify(raw);}catch{throw new Refusal('IMPORT_BUNDLE_INVALID',400);}
  if(Buffer.byteLength(serialized)>32*1024*1024)throw new Refusal('IMPORT_BUNDLE_TOO_LARGE',400);
  const bundle=ImportBundle.parse(raw),hash=digest(bundle);
  await this.ledger.tx(c=>this.owner(c,principal,bundle.projectId));
  for(const context of bundle.contexts){
   if(!await this.transport.verifySession(principal,context.sessionId))throw new Refusal('SESSION_OWNERSHIP_UNVERIFIED',403);
   if(!await this.transport.verifySessionKey(principal,context.sessionId,context.keyVariant,context.keyFingerprint))throw new Refusal('IMPORT_SESSION_KEY_UNVERIFIED',403);
   for(const message of context.messages)if(!await this.transport.verifyCiphertext(principal,context.sessionId,message.ciphertext))
    throw new Refusal('IMPORT_CIPHERTEXT_INVALID',403);
  }
  return this.ledger.tx(async c=>{
   await this.owner(c,principal,bundle.projectId);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5))',[bundle.importId]);
   const prior=(await c.query('SELECT * FROM ac_import_batches WHERE id=$1',[bundle.importId])).rows[0];
   if(prior){if(prior.input_digest!==hash||prior.principal_id!==principal)throw new Refusal('IMPORT_ID_CONFLICT');return {importId:prior.id,state:prior.state};}
   await c.query("INSERT INTO ac_import_batches(id,project_id,source_namespace,input_digest,principal_id,state) VALUES($1,$2,$3,$4,$5,'staging')",
    [bundle.importId,bundle.projectId,bundle.sourceNamespace,hash,principal]);
   if(bundle.schemaVersion===2)await c.query('INSERT INTO ac_import_v2_batches(batch_id,cursor_key) VALUES($1,$2)',[bundle.importId,randomBytes(32)]);
   for(const [sourcePosition,item] of bundle.contexts.entries()){
    if('history' in item){
     await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,87))',[JSON.stringify([bundle.sourceNamespace,item.id])]);
     const existing=(await c.query(`SELECT e.*,h.context_digest,b.principal_id,b.project_id,b.state batch_state FROM ac_import_entries e JOIN ac_import_batches b ON b.id=e.batch_id LEFT JOIN ac_imported_history_contexts h ON h.entry_id=e.id WHERE e.source_namespace=$1 AND e.external_context_id=$2 FOR UPDATE OF e,b`,[bundle.sourceNamespace,item.id])).rows[0];
     if(existing){if(existing.project_id!==bundle.projectId||existing.principal_id!==principal||existing.context_digest!==digest(item))throw new Refusal('IMPORT_SOURCE_CONTEXT_CONFLICT');
      if(existing.batch_state!=='completed'||!existing.context_id)throw new Refusal('IMPORT_SOURCE_PENDING');
      await c.query('INSERT INTO ac_import_v2_entry_aliases(batch_id,entry_id,position) VALUES($1,$2,$3)',[bundle.importId,existing.id,sourcePosition]);continue;}
    }
    if((await c.query('SELECT 1 FROM ac_session_links WHERE session_id=$1',[item.sessionId])).rowCount)throw new Refusal('SESSION_ALREADY_LINKED');
    const entry=randomUUID();
    await c.query('INSERT INTO ac_import_entries(id,batch_id,source_namespace,external_context_id,session_id,source_paused,key_variant,key_fingerprint,message_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
     [entry,bundle.importId,bundle.sourceNamespace,item.id,item.sessionId,item.sourcePaused,item.keyVariant,item.keyFingerprint,item.messages.length]);
    for(const [position,message] of item.messages.entries())await c.query('INSERT INTO ac_import_messages(entry_id,local_id,position,ciphertext) VALUES($1,$2,$3,$4)',
     [entry,localId(bundle.sourceNamespace,item.id,message.id),position,message.ciphertext]);
    if('history' in item)await stageHistoricalRecords(c,entry,sourcePosition,item,item.history,item.runs);
    for(const run of item.runs)await c.query('INSERT INTO ac_imported_runs(entry_id,external_run_id,state,artifact_ref) VALUES($1,$2,$3,$4)',
     [entry,run.id,run.state,'artifactRefDigest' in run&&run.artifactRefDigest?'sha256:'+run.artifactRefDigest:'artifactRef' in run?run.artifactRef??null:null]);
   }
   return {importId:bundle.importId,state:'staging'};
  });
 }
 async deliver(principal:string,importId:string){
  const id=Id.parse(importId);
  const batch=(await this.ledger.pool.query('SELECT * FROM ac_import_batches WHERE id=$1 AND principal_id=$2',[id,principal])).rows[0];
  if(!batch)throw new Refusal('IMPORT_FORBIDDEN',403);
  await this.ledger.tx(c=>this.owner(c,principal,batch.project_id));
  if(batch.state!=='staging')return {importId:id,state:batch.state};
  const entries=(await this.ledger.pool.query('SELECT * FROM ac_import_entries WHERE batch_id=$1 ORDER BY id',[id])).rows;
  for(const entry of entries){
   if(!await this.transport.verifySession(principal,entry.session_id))throw new Refusal('SESSION_OWNERSHIP_UNVERIFIED',403);
   if(!await this.transport.verifySessionKey(principal,entry.session_id,entry.key_variant,entry.key_fingerprint))throw new Refusal('IMPORT_SESSION_KEY_UNVERIFIED',403);
   const pending=(await this.ledger.pool.query('SELECT * FROM ac_import_messages WHERE entry_id=$1 AND NOT delivered ORDER BY position',[entry.id])).rows;
   for(const message of pending){
    await this.ledger.tx(async c=>{
     await this.owner(c,principal,batch.project_id);
     const item=(await c.query('SELECT delivered FROM ac_import_messages WHERE entry_id=$1 AND local_id=$2 FOR UPDATE',[entry.id,message.local_id])).rows[0];
     if(!item||item.delivered)return;
     if(!await this.transport.verifySession(principal,entry.session_id))throw new Refusal('SESSION_OWNERSHIP_UNVERIFIED',403);
     if(!await this.transport.verifySessionKey(principal,entry.session_id,entry.key_variant,entry.key_fingerprint))throw new Refusal('IMPORT_SESSION_KEY_UNVERIFIED',403);
     if(!await this.transport.verifyCiphertext(principal,entry.session_id,message.ciphertext))throw new Refusal('IMPORT_CIPHERTEXT_INVALID',403);
     await this.transport.deliver(principal,entry.session_id,message.local_id,message.ciphertext);
     await c.query('UPDATE ac_import_messages SET delivered=true WHERE entry_id=$1 AND local_id=$2',[entry.id,message.local_id]);
    });
   }
  }
  return this.ledger.tx(async c=>{
   const locked=(await c.query('SELECT * FROM ac_import_batches WHERE id=$1 AND principal_id=$2 FOR UPDATE',[id,principal])).rows[0];
   await this.owner(c,principal,locked.project_id);
   if(locked.state!=='staging')return {importId:id,state:locked.state};
   if((await c.query('SELECT 1 FROM ac_import_messages m JOIN ac_import_entries e ON e.id=m.entry_id WHERE e.batch_id=$1 AND NOT m.delivered LIMIT 1',[id])).rowCount)
    throw new Refusal('IMPORT_DELIVERY_PENDING');
   const rows=(await c.query('SELECT * FROM ac_import_entries WHERE batch_id=$1 FOR UPDATE',[id])).rows;
   for(const entry of rows){
    const contextId=randomUUID();
    // All imported contexts are explicitly paused until a human chooses to resume.
    await c.query('INSERT INTO ac_contexts(id,project_id,paused) VALUES($1,$2,true)',[contextId,locked.project_id]);
    await c.query('INSERT INTO ac_session_links(session_id,context_id,principal_id) VALUES($1,$2,$3)',[entry.session_id,contextId,principal]);
    await c.query("INSERT INTO ac_context_keys(context_id,version,variant,fingerprint,state,authorized_by) VALUES($1,1,$2,$3,'active',$4)",[contextId,entry.key_variant,entry.key_fingerprint,principal]);
    await c.query('UPDATE ac_import_entries SET context_id=$2 WHERE id=$1',[entry.id,contextId]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'import.completed',$2)",[contextId,{importId:id,sourcePaused:entry.source_paused}]);
   }
   // Ciphertext was only a temporary outbox. Happier remains the single transcript authority.
   await c.query('DELETE FROM ac_import_messages WHERE entry_id IN (SELECT id FROM ac_import_entries WHERE batch_id=$1)',[id]);
   const aliases=(await c.query('SELECT e.message_count FROM ac_import_v2_entry_aliases a JOIN ac_import_entries e ON e.id=a.entry_id WHERE a.batch_id=$1',[id])).rows;
   await c.query("UPDATE ac_import_batches SET state='completed',receipt=$2 WHERE id=$1",[id,{contexts:rows.length+aliases.length,messages:rows.reduce((total,row)=>total+row.message_count,0),...(aliases.length?{reusedContexts:aliases.length,reusedMessages:aliases.reduce((total,row)=>total+row.message_count,0)}:{}),sourceDigest:locked.input_digest}]);
   return {importId:id,state:'completed'};
  });
 }
 async archive(principal:string,importId:string){
  return this.ledger.tx(async c=>{
   const batch=(await c.query('SELECT * FROM ac_import_batches WHERE id=$1 AND principal_id=$2 FOR UPDATE',[Id.parse(importId),principal])).rows[0];
   if(!batch||batch.state!=='completed')throw new Refusal('IMPORT_NOT_COMPLETED');
   await this.owner(c,principal,batch.project_id);
   const entries=(await c.query('SELECT context_id FROM ac_import_entries WHERE batch_id=$1',[importId])).rows;
   // A dependent completed batch must be archived before its source context.
   if((await c.query(`SELECT 1 FROM ac_import_v2_entry_aliases a JOIN ac_import_entries e ON e.id=a.entry_id JOIN ac_import_batches b ON b.id=a.batch_id WHERE e.batch_id=$1 AND b.state IN ('staging','completed') LIMIT 1`,[importId])).rowCount)throw new Refusal('IMPORT_SOURCE_IN_USE');
   for(const entry of entries){
    const context=await this.ledger.authorize(c,principal,entry.context_id);
    if(!context.paused||(await c.query('SELECT 1 FROM ac_intents WHERE context_id=$1 LIMIT 1',[entry.context_id])).rowCount||
      (await c.query('SELECT 1 FROM ac_managers WHERE context_id=$1 AND lease_until>clock_timestamp()',[entry.context_id])).rowCount)
      throw new Refusal('IMPORTED_CONTEXT_IN_USE');
   }
   for(const entry of entries)await c.query('UPDATE ac_contexts SET archived=true WHERE id=$1',[entry.context_id]);
   await c.query("UPDATE ac_import_batches SET state='reverted' WHERE id=$1",[importId]);
   return {importId,state:'reverted'};
  });
 }
}
