import {workflowRuntimeParkingReason} from './workflow-generations.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Socket } from 'socket.io-client';
import type pg from 'pg';
import { Authority, Checkpoint, Command, digest, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
import { ContextKeys, type EncryptionVariant } from './context-keys.ts';
import { Template } from './templates.ts';
import type { CezarRuntime } from './cezar.ts';
import type { SemanticPlanning } from './semantic-planning.ts';
import { managerPlanPublishedSchema } from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';
import {chatConfigurationHandler} from './chat-control.ts';
import type {Control} from './control.ts';
import {keyFingerprint} from './context-keys.ts';
import {Notifications,NotificationPolicy,notificationReason,notificationStatus} from './notifications.ts';

type Rpc = {
  onSocketConnect(socket: Socket): void; onSocketDisconnect(): void;
  registerHandler?(method:string,handler:(data:unknown)=>Promise<unknown>):void;
  handleRequest(data: unknown): Promise<unknown>;
  invokeLocal(method: string, data: unknown): Promise<unknown>;
  waitForRegisteredHandlers(methods: string[], options: { timeoutMs: number }): Promise<{ status: string }>;
};
// Private imports are encapsulated here. The pinned bundle's contract is exercised with the actual server.
export type HappierBoundary = {
  encrypt(key: Uint8Array, variant: EncryptionVariant, value: unknown): Uint8Array;
  decrypt(key: Uint8Array, variant: EncryptionVariant, value: Uint8Array): unknown;
  encodeBase64(value: Uint8Array): string; decodeBase64(value: string): Uint8Array;
  createSessionSocketTransport(options: { token: string; sessionId: string; machineId: string; serverUrl: string; transports: string[] }):
    { socket: Socket; transport: { connect(): Promise<void> } };
  RpcHandlerManager: new (options: { scopePrefix: string; encryptionKey: Uint8Array; encryptionVariant: EncryptionVariant;
    logger: () => void; authorizeRequest: (q: { method: string }) => Promise<{ ok: true } | { ok: false; error: string }> }) => Rpc;
  registerSessionUserMessageSendHandler(rpc: Rpc, options: {
    workingDirectory: string; revalidateExplicitUserRequest: () => Promise<{ status: 'ready' }>;
    sessionRuntimeControls: { handleUserMessage(q: unknown): Promise<unknown> };
  }): void;
  materializeNextPendingQueueV2Message(options: Record<string, unknown>): Promise<unknown>;
  resolveAcceptedPendingQueueV2Delivery(options: Record<string, unknown>): Promise<unknown>;
  markPendingQueueV2DeliveryHandled(options: Record<string, unknown>): Promise<unknown>;
  SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT: string;
  SessionRuntimeActivitySnapshotRequestSchema: z.ZodType;
  SessionRuntimeActivitySnapshotAckSchema: z.ZodType;
};
export async function loadHappier(): Promise<HappierBoundary> {
  const value: unknown = await import(new URL('../upstream/happier/node_modules/.agent-control-boundary.mjs', import.meta.url).href);
  const parsed = z.object({ encrypt: z.function(), decrypt: z.function(), encodeBase64: z.function(), decodeBase64: z.function(),
    createSessionSocketTransport: z.function(), RpcHandlerManager: z.custom(value => typeof value === 'function'), registerSessionUserMessageSendHandler: z.function(),
    materializeNextPendingQueueV2Message: z.function(), resolveAcceptedPendingQueueV2Delivery: z.function(), markPendingQueueV2DeliveryHandled: z.function(),
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT: z.string(), SessionRuntimeActivitySnapshotRequestSchema: z.unknown(),
    SessionRuntimeActivitySnapshotAckSchema: z.unknown(), }).passthrough().parse(value);
  // Only this version-pinned external boundary needs a structural assertion; no unvalidated data escapes it.
  return parsed as unknown as HappierBoundary;
}
export function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const UserRequest = z.object({ text: z.string().min(1).max(100000), localId: z.string().min(1).max(200), meta: z.unknown().optional() });
const Pending = z.object({ didMaterialize: z.boolean(), deferredReason: z.string().optional(),
  message: z.object({ localId: z.string().nullable().optional(), content: z.object({ t: z.literal('encrypted'), c: z.string() }) }).nullable().optional() }).passthrough();
const UserRecord = z.object({ role: z.literal('user'), content: z.object({ type: z.literal('text'), text: z.string() }), meta: z.unknown().optional() });

async function boundedNetwork<T>(operation:(signal:AbortSignal)=>Promise<T>,timeoutMs:number,parent?:AbortSignal):Promise<T>{
  if(parent?.aborted)throw new Refusal('HAPPIER_TRANSPORT_CANCELED');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let aborted!:()=>void;
  const cancelled=new Promise<never>((_,reject)=>{
    aborted=()=>{controller.abort();reject(new Refusal('HAPPIER_TRANSPORT_CANCELED'));};
    if(parent?.aborted)aborted();else parent?.addEventListener('abort',aborted,{once:true});
    timer=setTimeout(()=>{controller.abort();reject(new Refusal('HAPPIER_TRANSPORT_TIMEOUT'));},timeoutMs);
  });
  try{return await Promise.race([Promise.resolve().then(()=>operation(controller.signal)),cancelled]);}
  finally{clearTimeout(timer);parent?.removeEventListener('abort',aborted);}
}

// Read only the linked session using Happier's native backward cursor. Never silently
// present a truncated or non-progressing traversal as a complete history.
export async function recoverHistory(baseUrl: string, sessionId: string, token: string,
  key: Uint8Array, boundary: HappierBoundary, fetchPage: typeof fetch = fetch, variant: EncryptionVariant = 'legacy',
  authorize: () => Promise<void> = async () => {},options:{signal?:AbortSignal;timeoutMs?:number}={}): Promise<unknown[]> {
  const messages: { seq: number; content: unknown }[] = [];
  let before: number | undefined;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, baseUrl);
    url.searchParams.set('scope', 'main'); url.searchParams.set('limit', '150');
    if (before !== undefined) url.searchParams.set('beforeSeq', String(before));
    await authorize();
    const data=await boundedNetwork(async signal=>{
      const response=await fetchPage(url,{headers:{authorization:'Bearer '+token},signal});
      if(!response.ok)throw new Refusal('AUTHORIZED_HISTORY_UNAVAILABLE');
      return response.json();
    },options.timeoutMs??10000,options.signal);
    const result = z.object({ messages: z.array(z.object({ seq: z.number().int().nonnegative(), content: z.unknown() }).passthrough()),
      hasMore: z.boolean(), nextBeforeSeq: z.number().int().positive().nullable() }).passthrough().parse(data);
    let previous = before ?? Infinity;
    for (const message of result.messages) {
      if (message.seq >= previous) throw new Refusal('HISTORY_ORDER_INVALID');
      previous = message.seq; messages.push(message);
    }
    if (!result.hasMore) {
      if (result.nextBeforeSeq !== null) throw new Refusal('HISTORY_CURSOR_INVALID');
      await authorize();
      return messages.reverse().map(message => {
        const envelope = z.object({ t: z.literal('encrypted'), c: z.string() }).parse(typeof message.content === 'string' ? JSON.parse(message.content) : message.content);
        const decrypted = boundary.decrypt(key, variant, boundary.decodeBase64(envelope.c));
        if (decrypted === null) throw new Refusal('INVALID_HISTORY_CIPHERTEXT');
        return decrypted;
      });
    }
    if (!result.messages.length || result.nextBeforeSeq !== previous || (before !== undefined && result.nextBeforeSeq >= before))
      throw new Refusal('HISTORY_CURSOR_INVALID');
    before = result.nextBeforeSeq;
  }
  throw new Refusal('HISTORY_PAGE_LIMIT_EXCEEDED');
}

export class HappierEndpoint {
  readonly notifications:Notifications;
  readonly socket: Socket;
  readonly rpc: Rpc;
  readonly transport;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private readonly lifecycle = new AbortController();
  private runtimeReady = false;
  private revision: number | undefined;
  private lastPendingAt = 0;
  private pendingFailure: unknown;
  lastError: string | undefined;
  readonly transportEvents = new Set<string>();
  recoveredCheckpoint: Checkpoint | null = null;
  recoveredMessages: unknown[] = [];
  readonly seal: (value: unknown) => string;
  constructor(readonly ledger: Ledger, readonly runtime: CezarRuntime, readonly boundary: HappierBoundary,
    readonly options: { baseUrl: string; token: string; key: Uint8Array; principal: string; sessionId: string; machineId: string; authority: Authority; keyVersion?: number; encryptionVariant?: EncryptionVariant; notificationPolicy?:z.input<typeof NotificationPolicy>; transportTimeoutMs?:number; transportOnly?:boolean; configurationControl?:Control; semanticPlanning?:SemanticPlanning; administrativeHandler?:(contextId:string,raw:unknown)=>Promise<unknown> }) {
    if(options.semanticPlanning&&(options.semanticPlanning.ledger!==ledger||options.transportOnly))throw new Refusal('SEMANTIC_MANAGER_CONFIGURATION_INVALID');
    this.notifications=new Notifications(ledger,options.notificationPolicy);
    this.seal = value => boundary.encodeBase64(boundary.encrypt(options.key, options.encryptionVariant ?? 'legacy', value));
    const { socket, transport } = boundary.createSessionSocketTransport({ token: options.token, sessionId: options.sessionId,
      machineId: options.machineId, serverUrl: options.baseUrl, transports: ['websocket'] });
    this.socket = socket; this.transport = transport;
    socket.onAny((name: string) => { this.transportEvents.add(name); });
    this.rpc = new boundary.RpcHandlerManager({ scopePrefix: options.sessionId, encryptionKey: options.key, encryptionVariant: options.encryptionVariant ?? 'legacy', logger: () => {},
      authorizeRequest: async q => {
        if(!q.method.startsWith(options.sessionId+':'))return {ok:false,error:'scope_forbidden'};
        try{await this.validateLink();return {ok:true};}catch{return {ok:false,error:'context_key_unauthorized'};}
      } });
    boundary.registerSessionUserMessageSendHandler(this.rpc, { workingDirectory: runtime.repo,
      revalidateExplicitUserRequest: async () => ({ status: 'ready' }),
      sessionRuntimeControls: { handleUserMessage: raw => this.accept(raw) } });
    if(options.configurationControl){
      if(options.configurationControl.ledger!==ledger)throw new Refusal('CONFIGURATION_LEDGER_MISMATCH');
      if(!this.rpc.registerHandler)throw new Refusal('CONFIGURATION_RPC_UNAVAILABLE');
      const configure=chatConfigurationHandler(options.configurationControl,{authority:options.authority,principal:options.principal,
        sessionId:options.sessionId,keyVersion:options.keyVersion??1,encryptionVariant:options.encryptionVariant??'legacy',keyFingerprint:keyFingerprint(options.key)});
      this.rpc.registerHandler('agent-control.configure',async raw=>{
        try{
          if(this.lifecycle.signal.aborted)throw new Refusal('MANAGER_STOPPED');
          await this.validateLink();
          if(this.lifecycle.signal.aborted)throw new Refusal('MANAGER_STOPPED');
          return {ok:true,result:await configure(raw)};
        }catch{return {ok:false,error:'CONFIGURATION_REQUEST_FAILED'};}
      });
    }
    if(options.administrativeHandler){
      if(!this.rpc.registerHandler)throw new Refusal('ADMIN_RPC_UNAVAILABLE');
      this.rpc.registerHandler('agent-control.admin',async raw=>{
        try{
          if(this.lifecycle.signal.aborted)throw new Refusal('MANAGER_STOPPED');
          await this.validateLink();
          if(this.lifecycle.signal.aborted)throw new Refusal('MANAGER_STOPPED');
          return {ok:true,result:await options.administrativeHandler!(options.authority.contextId,raw)};
        }catch{return {ok:false,error:'ADMIN_REQUEST_FAILED'};}
      });
    }
    socket.on('rpc-request', async (data: unknown, callback: (value: unknown) => void) => callback(await this.rpc.handleRequest(data)));
    socket.on('connect', () => { if(this.lifecycle.signal.aborted){socket.disconnect();return;}this.runtimeReady = false; this.rpc.onSocketConnect(socket); });
    socket.on('disconnect', () => this.rpc.onSocketDisconnect());
  }
  async validateKey() {
    await new ContextKeys(this.ledger).validate(this.options.authority.contextId,this.options.keyVersion??1,this.options.encryptionVariant??'legacy',this.options.key);
  }
  async validateLink() {
    await this.validateKey();
    await this.ledger.tx(async c=>{
      const context=await this.ledger.authorize(c,this.options.principal,this.options.authority.contextId);
      if(context.project_id!==this.runtime.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
      await this.ledger.fence(c,this.options.authority,true);
      const row=await c.query('SELECT session_id,principal_id FROM ac_session_links WHERE context_id=$1',[this.options.authority.contextId]);
      if(row.rows[0]?.session_id!==this.options.sessionId||row.rows[0]?.principal_id!==this.options.principal)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
    });
  }
  private nativeSourceCleanup:(()=>void)|undefined;
  private bindNativeSource(){
    if(this.nativeSourceCleanup||!this.runtime.nativeImplementation||this.options.transportOnly)return;
    this.nativeSourceCleanup=this.runtime.nativeImplementation.bindSource(this.options.authority,async(intent,authority)=>{
      if(this.lifecycle.signal.aborted||authority.contextId!==this.options.authority.contextId||authority.epoch!==this.options.authority.epoch||authority.instanceId!==this.options.authority.instanceId)throw new Refusal('STALE_MANAGER');
      await this.validateLink();const payload=Command.parse(intent.command).payload;if(payload.workflow!=='engineering-native-v1')throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');
      const row=(await this.ledger.pool.query('SELECT ciphertext FROM ac_chat_messages WHERE id=$1 AND session_id=$2',[this.options.sessionId+'|'+payload.localId,this.options.sessionId])).rows[0];
      if(!row)throw new Refusal('NATIVE_TASK_SOURCE_MISSING');
      const record=UserRecord.parse(this.boundary.decrypt(this.options.key,this.options.encryptionVariant??'legacy',this.boundary.decodeBase64(row.ciphertext)));
      if(digest(record.content.text)!==payload.messageDigest||payload.messageRef!==`message:${stableId(intent.context_id+'\0'+payload.localId)}`)throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');return record.content.text;
    });
  }
  async start() {
    try{
    await this.validateLink();
    if(this.lifecycle.signal.aborted)throw new Refusal('HAPPIER_TRANSPORT_CANCELED');
    const timeout=this.options.transportTimeoutMs??10000;
    const profile = await boundedNetwork(async signal=>{
      const response=await fetch(this.options.baseUrl+'/v1/account/profile',{headers:{authorization:'Bearer '+this.options.token},signal});
      if(!response.ok)throw new Refusal('HAPPIER_PRINCIPAL_MISMATCH',403);
      return response.json();
    },timeout,this.lifecycle.signal);
    if (z.object({ id: z.string() }).passthrough().parse(profile).id !== this.options.principal)
      throw new Refusal('HAPPIER_PRINCIPAL_MISMATCH', 403);
    this.bindNativeSource();
    this.recoveredCheckpoint = await this.ledger.recoverCheckpoint(this.options.authority);
    this.recoveredMessages = await recoverHistory(this.options.baseUrl, this.options.sessionId, this.options.token, this.options.key, this.boundary, fetch, this.options.encryptionVariant??'legacy',()=>this.validateLink(),{signal:this.lifecycle.signal,timeoutMs:timeout});
    // Fetching authorized pages may take time; re-read current structured state before activating RPC.
    this.recoveredCheckpoint = await this.ledger.recoverCheckpoint(this.options.authority);
    if(this.lifecycle.signal.aborted)throw new Refusal('HAPPIER_TRANSPORT_CANCELED');
    const connecting=this.transport.connect();
    void connecting.then(()=>{if(this.lifecycle.signal.aborted)this.socket.disconnect();},()=>{});
    await boundedNetwork(()=>connecting,timeout,this.lifecycle.signal);
    const methods=['session.userMessage.send',...(this.options.configurationControl?['agent-control.configure']:[]),...(this.options.administrativeHandler?['agent-control.admin']:[])];
    const registered = await boundedNetwork(()=>this.rpc.waitForRegisteredHandlers(methods, { timeoutMs: timeout }),timeout,this.lifecycle.signal);
    if (registered.status !== 'ready') {
      this.socket.disconnect();
      throw new Refusal('HAPPIER_NOT_READY_' + registered.status + '_' + [...this.transportEvents].join(','));
    }
    this.timer = setInterval(() => { if (this.busy) return; this.busy = true;
      void this.tick().then(async() => {
        if(this.lastError)await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
          {entityId:this.options.authority.contextId,source:'manager',planRevision:0,seq:0,status:'recovered'});
        this.lastError = undefined;
      }).catch(async error => {
        const code = error instanceof Refusal ? error.code : error instanceof z.ZodError
          ? 'CONTRACT_ERROR:' + error.issues.map(issue => issue.path.join('.')).join(',') : error instanceof Error ? error.name : 'UNKNOWN_ERROR';
        if (code !== this.lastError) void this.ledger.pool.query(
          "INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'manager.blocked',$2)",
          [this.options.authority.contextId, { code }]).catch(() => {});
        this.lastError = code;
        if (['STALE_MANAGER','CONTEXT_FORBIDDEN','PROJECT_RUNTIME_MISMATCH','CONTEXT_KEY_UNAUTHORIZED','SESSION_CONTEXT_MISMATCH'].includes(this.lastError)) this.close();
        else if(!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED'].includes(code)){
          // Critical controller blockers do not wait for the completion window.
          // Failure to publish preserves the same encrypted outbox for retry.
          try{
            await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
              {entityId:this.options.authority.contextId,source:'manager',planRevision:0,seq:0,status:'blocked',reason:notificationReason(error)});
            await this.flushNotifications();await this.deliverQueuedMessages();
          }catch{}
        }
      }).finally(() => { this.busy = false; }); }, 300);
    }catch(error){this.close();throw error;}
  }
  async accept(raw: unknown) {
    if(this.options.transportOnly)throw new Refusal('EXECUTION_DISABLED');
    const q = UserRequest.parse(raw); await this.validateLink();
    const intentId = stableId(`${this.options.authority.contextId}\0${q.localId}`);
    const prior=(await this.ledger.pool.query('SELECT command FROM ac_intents WHERE id=$1 AND context_id=$2 AND principal_id=$3',
      [intentId,this.options.authority.contextId,this.options.principal])).rows[0];
    const current=(await this.ledger.pool.query(`SELECT t.snapshot,t.digest FROM ac_contexts c LEFT JOIN ac_context_templates t
      ON t.context_id=c.id AND t.revision=c.active_template_revision WHERE c.id=$1 AND NOT c.archived`,[this.options.authority.contextId])).rows[0];
    if(!current)throw new Refusal('CONTEXT_FORBIDDEN',403);
    const template=current.snapshot?Template.parse(current.snapshot):null;
    if(template&&digest(template)!==current.digest)throw new Refusal('TEMPLATE_DIGEST_MISMATCH');
    const selected=prior?.command?.payload?.workflow??template?.workflow??'baseline-synthetic-v1';
    if(selected==='semantic-proposal-v1'&&(!this.options.semanticPlanning||this.runtime.executionMode!=='execution'))throw new Refusal('SEMANTIC_PLANNING_DISABLED');
    let payload:Command['payload'];
    if(selected==='engineering-native-v1'&&(!this.runtime.nativeImplementation||this.runtime.executionMode!=='execution'))throw new Refusal('NATIVE_EXECUTION_NOT_CONFIGURED');
    if(selected==='engineering-native-v1')this.bindNativeSource();
    if(selected==='semantic-proposal-v1'||selected==='engineering-native-v1'){
      const existing=prior?Command.parse(prior.command):undefined;
      if(existing&&(existing.payload.workflow==='semantic-proposal-v1'||existing.payload.workflow==='engineering-native-v1')&&existing.payload.workflow===selected){
        if(existing.payload.localId!==q.localId||existing.payload.messageDigest!==digest(q.text))throw new Refusal('INTENT_PAYLOAD_CONFLICT');
        payload=existing.payload;
      }else{
        if(!template||(template.workflow!=='semantic-proposal-v1'&&template.workflow!=='engineering-native-v1')||template.workflow!==selected)throw new Refusal('TEMPLATE_REQUIRED');
        payload={workflow:selected,localId:q.localId,messageDigest:digest(q.text),messageRef:`message:${stableId(this.options.authority.contextId+'\0'+q.localId)}`,
          qualityRevision:template.qualityRevision,targetRef:template.targetRef,...(template.workflow==='engineering-native-v1'?{writePaths:template.writePaths}:{})} as Command['payload'];
      }
    }else{
      if(selected!=='baseline-synthetic-v1'&&selected!=='engineering-synthetic-v1')throw new Refusal('WORKFLOW_NOT_ADMITTED');
      payload={workflow:selected,messageRef:`${q.localId}:${digest(q.text)}`};
    }
    const command: Command = { schemaVersion: 1, contextId: this.options.authority.contextId, intentId,
      deliveryAttemptId: randomUUID(), policyRevision: 1, action: payload.workflow==='semantic-proposal-v1'?'plan.propose':'plan.start', payload };
    // Bind encrypted request and intention in the same transaction, so a lost
    // response cannot leave a runnable planning intention without its source.
    const ciphertext=this.seal({role:'user',content:{type:'text',text:q.text},localKey:q.localId,meta:q.meta??{}});
    const intent = await this.ledger.accept(this.options.principal, command, this.options.authority, 'happier',async c=>{
      const id=this.options.sessionId+'|'+q.localId;
      await c.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext,priority) VALUES($1,$2,$3,100) ON CONFLICT DO NOTHING',[id,this.options.sessionId,ciphertext]);
      const stored=(await c.query('SELECT session_id,ciphertext FROM ac_chat_messages WHERE id=$1',[id])).rows[0];
      if(!stored||stored.session_id!==this.options.sessionId)throw new Refusal('CHAT_MESSAGE_CONFLICT');
      const message=UserRecord.parse(this.boundary.decrypt(this.options.key,this.options.encryptionVariant??'legacy',this.boundary.decodeBase64(stored.ciphertext)));
      if(digest(message.content.text)!==digest(q.text))throw new Refusal('CHAT_MESSAGE_CONFLICT');
    });
    return { handled: true, result: { ok: true, providerAcceptancePending: true, intentId: intent.id } };
  }
  private async insertAgentMessage(c:pg.PoolClient,localId:string,value:unknown,priority:0|50){
    const id=this.options.sessionId+'|'+localId,ciphertext=this.seal(value);
    await c.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext,priority) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,this.options.sessionId,ciphertext,priority]);
    const stored=(await c.query('SELECT session_id,ciphertext FROM ac_chat_messages WHERE id=$1',[id])).rows[0];
    if(!stored||stored.session_id!==this.options.sessionId)throw new Refusal('CHAT_MESSAGE_CONFLICT');
    const decoded=this.boundary.decrypt(this.options.key,this.options.encryptionVariant??'legacy',this.boundary.decodeBase64(stored.ciphertext));
    if(decoded===null||digest(decoded)!==digest(value))throw new Refusal('CHAT_MESSAGE_CONFLICT');
  }
  async ack(event: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => this.socket.timeout(8000).emit(event, data,
      (error: Error | null, value: unknown) => error ? reject(error) : resolve(value)));
  }
  private async flushNotifications(){
    await this.validateLink();
    return this.notifications.flush(this.options.principal,this.options.authority,this.options.sessionId,this.seal);
  }
  private async deliverQueuedMessages(){
    return this.notifications.deliver(this.options.principal,this.options.authority,this.options.sessionId,
      message=>this.ack('message',{sid:this.options.sessionId,message:message.ciphertext,localId:message.localId,echoToSender:true}),()=>this.validateLink());
  }
  private async processSemanticProposal(intent:import('./ledger.ts').Intent){
    const planner=this.options.semanticPlanning,command=Command.parse(intent.command),payload=command.payload;
    if(!planner||this.runtime.executionMode!=='execution'||command.action!=='plan.propose'||payload.workflow!=='semantic-proposal-v1')throw new Refusal('SEMANTIC_PLANNING_DISABLED');
    if(intent.state==='done')return;
    await this.validateLink();
    const source=(await this.ledger.pool.query('SELECT ciphertext FROM ac_chat_messages WHERE id=$1 AND session_id=$2',
      [this.options.sessionId+'|'+payload.localId,this.options.sessionId])).rows[0];
    if(!source)throw new Refusal('PLANNING_SOURCE_MISSING');
    const record=UserRecord.parse(this.boundary.decrypt(this.options.key,this.options.encryptionVariant??'legacy',this.boundary.decodeBase64(source.ciphertext)));
    if(digest(record.content.text)!==payload.messageDigest||payload.messageRef!==`message:${stableId(intent.context_id+'\0'+payload.localId)}`)throw new Refusal('PLANNING_SOURCE_MISMATCH');
    const callId=stableId('semantic-proposal-v1\0'+intent.id);
    const previous=(await this.ledger.pool.query('SELECT expected_revision FROM ac_semantic_planning_calls WHERE id=$1 AND context_id=$2',[callId,intent.context_id])).rows[0];
    const revision=previous?.expected_revision??Number((await this.ledger.pool.query('SELECT COALESCE(max(revision),0) revision FROM ac_manager_plans WHERE context_id=$1',[intent.context_id])).rows[0].revision);
    // A long model call must not starve the manager lease. This is lease renewal,
    // not a second scheduler; the same callId remains authoritative after failure.
    let renewing=false;const timer=setInterval(()=>{if(!renewing&&!this.lifecycle.signal.aborted&&this.socket.connected){renewing=true;void this.ledger.heartbeat(this.options.authority).catch(()=>{}).finally(()=>{renewing=false;});}},4000);timer.unref?.();
    let result:z.infer<typeof managerPlanPublishedSchema>;
    try{result=managerPlanPublishedSchema.parse(await planner.plan(this.options.principal,{id:callId,intentId:intent.id,contextId:intent.context_id,
      expectedRevision:revision,sourceMessageRef:payload.messageRef,qualityRevision:payload.qualityRevision,targetRef:payload.targetRef,text:record.content.text},this.options.authority));}
    finally{clearInterval(timer);}
    await this.validateLink();
    const localId='proposal-'+callId;
    const message={role:'agent',content:{type:'output',data:{type:'assistant',uuid:localId,
      message:{role:'assistant',content:[{type:'text',text:`Proposta de plano ${result.revision} preparada. A distribuição das tarefas depende da configuração de execução.`}]}}},meta:{sentFrom:'cli',agentControl:{schemaVersion:1,kind:'proposal',callId}}};
    await this.ledger.tx(async c=>{
      await this.ledger.authorize(c,this.options.principal,intent.context_id);await this.ledger.fence(c,this.options.authority,true);
      await this.ledger.assertIntentActive(c,intent.context_id,intent.id);
      const saved=(await c.query('SELECT state,result FROM ac_semantic_planning_calls WHERE id=$1 AND intent_id=$2 FOR UPDATE',[callId,intent.id])).rows[0];
      if(!saved||saved.state!=='published'||digest(saved.result)!==digest(result))throw new Refusal('PLANNING_RESULT_CONFLICT');
      const row=(await c.query('SELECT command,state FROM ac_intents WHERE id=$1 AND context_id=$2 FOR UPDATE',[intent.id,intent.context_id])).rows[0];
      if(!row||digest(row.command)!==digest(intent.command))throw new Refusal('INTENT_IDENTITY_MISMATCH');
      await c.query("UPDATE ac_intents SET state='done' WHERE id=$1",[intent.id]);
      await c.query("UPDATE ac_outbox SET state='dispatched' WHERE intent_id=$1",[intent.id]);
      await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND state='registered'",[intent.operation_id,{kind:'semantic-proposal',callId,revision:result.revision,digest:result.digest}]);
      await this.insertAgentMessage(c,localId,message,0);
      await this.ledger.refreshPending(c,intent.context_id);
    });
  }
  async tick() {
    if (!this.socket.connected) return;
    await this.validateLink();
    await this.ledger.heartbeat(this.options.authority);
    if(this.options.transportOnly){this.socket.emit('session-alive',{sid:this.options.sessionId,time:Date.now(),thinking:false,mode:'remote'});return;}
    let recoveryFailure:unknown;
    try{await this.runtime.reconcileCancellations(this.options.authority,this.options.principal);}catch(error){if(!workflowRuntimeParkingReason(error))recoveryFailure=error;}
    try{await this.runtime.recoverManaged(this.options.authority);}catch(error){if(!workflowRuntimeParkingReason(error))recoveryFailure??=error;}
    this.socket.emit('session-alive', { sid: this.options.sessionId, time: Date.now(), thinking: false, mode: 'remote' });
    if (Date.now() - this.lastPendingAt >= 1000) {
      this.lastPendingAt = Date.now();
      try { await this.receivePending(); this.pendingFailure = undefined; }
      catch (error) { this.pendingFailure = error; }
    }
    const intents = await this.ledger.pool.query<import('./ledger.ts').Intent&{cancellation_state:string|null}>(`SELECT i.*,x.state cancellation_state
      FROM ac_intents i LEFT JOIN ac_plan_cancellations x ON x.intent_id=i.id
      WHERE i.context_id=$1 AND i.parent_intent_id IS NULL ORDER BY i.created_at`, [this.options.authority.contextId]);
    let capacityWait:Refusal|undefined;
    for (const intent of intents.rows) {
      if(intent.cancellation_state){
        await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
          {entityId:intent.run_id,source:'cancellation',planRevision:intent.plan_revision,seq:0,
            status:intent.cancellation_state==='confirmed'?'cancel_confirmed':'cancel_requested',reason:intent.cancellation_state==='confirmed'?'NONE':'PLAN_CANCELLATION_REQUESTED'});
        continue;
      }
      // A retained build can be absent while unrelated new admissions remain
      // runnable. Route checks precede planning as well as graph dispatch.
      try{await this.ledger.tx(async c=>{await this.ledger.fence(c,this.options.authority,true);await this.ledger.assertRuntimeRoute(c,intent.id);});}
      catch(error){if(!workflowRuntimeParkingReason(error))throw error;
        await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,{entityId:intent.run_id,source:'admission',planRevision:intent.plan_revision,seq:0,status:'waiting',reason:'RUNTIME_UNAVAILABLE'});continue;}
      if(intent.command.payload.workflow==='semantic-proposal-v1'){
        if(!['done','failed','canceled','cancelled'].includes(intent.state))try{await this.processSemanticProposal(intent);}catch(error){
          if(workflowRuntimeParkingReason(error)){await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,{entityId:intent.id,source:'manager',planRevision:intent.plan_revision,seq:0,status:'waiting',reason:'RECONCILIATION_REQUIRED'});continue;}
          if(error instanceof Refusal&&['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code)){capacityWait??=error;continue;}
          if(error instanceof Refusal&&['PLANNING_EXECUTOR_FAILED','PLANNING_OUTPUT_REJECTED'].includes(error.code)){
            const localId='proposal-failed-'+intent.id;
            const message={role:'agent',content:{type:'output',data:{type:'assistant',uuid:localId,message:{role:'assistant',content:[{type:'text',text:'A geração da proposta falhou. Consulte o diagnóstico desta conversa antes de continuar.'}]}}},meta:{sentFrom:'cli',agentControl:{schemaVersion:1,kind:'proposal-failed'}}};
            await this.ledger.tx(async c=>{
              await this.ledger.authorize(c,this.options.principal,intent.context_id);await this.ledger.fence(c,this.options.authority,true);await this.ledger.assertIntentActive(c,intent.context_id,intent.id);
              const callId=stableId('semantic-proposal-v1\0'+intent.id);
              const saved=(await c.query("SELECT failure_code FROM ac_semantic_planning_calls WHERE id=$1 AND intent_id=$2 AND state='rejected' FOR UPDATE",[callId,intent.id])).rows[0];
              if(!saved||saved.failure_code!==error.code)throw new Refusal('PLANNING_RESULT_UNCERTAIN');
              await c.query("UPDATE ac_intents SET state='failed' WHERE id=$1 AND context_id=$2",[intent.id,intent.context_id]);
              await c.query("UPDATE ac_outbox SET state='dispatched' WHERE intent_id=$1",[intent.id]);
              await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND state='registered'",[intent.operation_id,{kind:'semantic-proposal',callId,failureCode:error.code}]);
              await this.insertAgentMessage(c,localId,message,50);
              await this.ledger.refreshPending(c,intent.context_id);
            });
            continue;
          }
          if(error instanceof Refusal&&['PLANNING_RESULT_UNCERTAIN','PLANNING_CONTEXT_BUSY','PLANNING_RECEIPT_INVALID','PLANNING_SOURCE_MISSING','PLANNING_SOURCE_MISMATCH','QUALITY_POLICY_CONFLICT','MANAGER_PLAN_REVISION_CONFLICT'].includes(error.code)){
            await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,{entityId:intent.id,source:'manager',planRevision:intent.plan_revision,seq:0,status:'waiting',reason:'RECONCILIATION_REQUIRED'});
            continue;
          }
          throw error;
        }
        continue;
      }
      let run;
      try{
        run=await this.runtime.dispatch(intent,this.options.authority);
        await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
          {entityId:intent.run_id,source:'admission',planRevision:intent.plan_revision,seq:0,status:'recovered'});
      }
      catch(error){
        if(workflowRuntimeParkingReason(error)){await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,{entityId:intent.run_id,source:'admission',planRevision:intent.plan_revision,seq:0,status:'waiting',reason:'RECONCILIATION_REQUIRED'});continue;}
        if(!(error instanceof Refusal)||!['PLAN_CANCELLATION_REQUESTED','HUMAN_PAUSED','ADMISSION_CLOSED','CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED'].includes(error.code))throw error;
        if(['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED'].includes(error.code))capacityWait??=error;
        await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
          {entityId:intent.run_id,source:'admission',planRevision:intent.plan_revision,seq:0,status:'waiting',reason:notificationReason(error)});
        // Admission or capacity may block this intent; status projection and
        // queued chat delivery must still continue for existing work.
        run=await this.runtime.observe(intent,this.options.authority);
      }
      if (!run) continue;
      const seq = Number(run.lastSeq ?? 0);
      await this.ledger.tx(async c => { await this.ledger.fence(c, this.options.authority, true);
        await c.query(`UPDATE ac_intents SET state=$2 WHERE id=$1 AND context_id=$3
          AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1)`, [intent.id, run.status, this.options.authority.contextId]);
        await this.ledger.refreshPending(c,this.options.authority.contextId); });
      await this.ledger.event(this.options.principal, { schemaVersion: 1, eventId: randomUUID(), contextId: intent.context_id,
        runId: run.id, planRevision: intent.plan_revision, seq, status: run.status }, this.options.authority);
      const status=notificationStatus(run.status);
      await this.notifications.observe(this.options.principal,this.options.authority,this.options.sessionId,
        {entityId:run.id,source:'runtime',planRevision:intent.plan_revision,seq,status,
          reason:status==='failed'?'EXECUTION_FAILED':status==='waiting'?notificationReason(run.error):['cancelled','canceled'].includes(status)?'RECONCILIATION_REQUIRED':'NONE'});
    }
    await this.flushNotifications();await this.deliverQueuedMessages();
    if (this.pendingFailure !== undefined) throw this.pendingFailure;
    if (recoveryFailure !== undefined) throw recoveryFailure;
    if (capacityWait) throw capacityWait;
  }
  private async receivePending() {
    if (!this.runtimeReady) {
      const request = this.boundary.SessionRuntimeActivitySnapshotRequestSchema.parse({ sessionId: this.options.sessionId,
        mutationId: randomUUID(), snapshot: { state: 'idle', activeCount: 0 } });
      const result = z.object({ status: z.enum(['applied', 'unchanged']), projection: z.object({ revision: z.number() }).optional() }).passthrough()
        .parse(await this.ack(this.boundary.SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, request));
      this.revision = result.projection?.revision; this.runtimeReady = true;
    }
    const pending = Pending.parse(await this.boundary.materializeNextPendingQueueV2Message({ token: this.options.token,
      sessionId: this.options.sessionId, socket: this.socket, deliveryStateOptIn: true, deliveryTiming: 'after_runtime_idle',
      foregroundState: 'ready', expectedRuntimeActivityRevision: this.revision }));
    if (pending.deferredReason === 'runtime_activity_unknown') this.runtimeReady = false;
    if (pending.didMaterialize && pending.message?.localId) {
      const record = UserRecord.parse(this.boundary.decrypt(this.options.key, this.options.encryptionVariant??'legacy', this.boundary.decodeBase64(pending.message.content.c)));
      const accepted = z.object({ ok: z.literal(true) }).passthrough().parse(await this.rpc.invokeLocal('session.userMessage.send',
        { text: record.content.text, localId: pending.message.localId, meta: record.meta ?? {} }));
      await this.boundary.resolveAcceptedPendingQueueV2Delivery({ socket: this.socket, sessionId: this.options.sessionId, localId: pending.message.localId });
      await this.boundary.markPendingQueueV2DeliveryHandled({ token: this.options.token, sessionId: this.options.sessionId, localId: pending.message.localId });
      this.runtimeReady = false;
    }
  }
  connectionState(): 'connected'|'disconnected' {return this.socket.connected?'connected':'disconnected';}
  close() { this.nativeSourceCleanup?.();this.nativeSourceCleanup=undefined;this.lifecycle.abort();if (this.timer) clearInterval(this.timer); this.recoveredMessages=[];this.recoveredCheckpoint=null;this.socket.disconnect(); }
}
