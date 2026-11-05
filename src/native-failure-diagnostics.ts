import {agentControlDiagnosticFindingSchema, type AgentControlDiagnosticFinding} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';

export const NATIVE_TERMINAL_FAILURE_COPY={
 meaning:'Um job de execução nativa deste contexto está armazenado como falha terminal.',
 owner:'Supervisor de execução nativa',
 nextCondition:'Consultar o job e executor originais, conferir recibos e logs autorizados e conciliar a retirada física antes de decidir nova solicitação; não repetir um efeito incerto.',
} as const;

const STORED_CAUSE={
 WORKER_EXITED_WITHOUT_RESULT:'worker_exited_without_result',
 FINALIZER_EXITED_WITHOUT_RESULT:'finalizer_exited_without_result',
 INVALID_SCOPE:'invalid_scope',
 NO_CHANGES:'no_changes',
 FINALIZATION_FAILED:'finalization_failed',
 EXECUTION_FAILED:'execution_failed',
 EXECUTION_TIMEOUT:'execution_timeout',
 EXECUTION_CANCELED:'execution_canceled',
 EXECUTION_NATIVE_TURN_FAILED:'execution_native_turn_failed',
 EXECUTION_OUTPUT_TOO_LARGE:'execution_output_too_large',
 EXECUTION_NATIVE_FAILED:'execution_native_failed',
} as const;
type Cause=(typeof STORED_CAUSE)[keyof typeof STORED_CAUSE];
const FINALIZER_CAUSE=new Set<Cause>(['finalizer_exited_without_result','invalid_scope','no_changes','finalization_failed']);


export type NativeTerminalFailureSource={
 jobId:string;intentId:string;contextId:string;
 role:'programmer'|'qa'|'reviewer'|'judge'|'specialist';
 state:string;
 jobReceipt:unknown;
 operationId:string|null;
 operationReceipt:unknown;
 stageId:string|null;
 stageNode:string|null;
 stageReceipt:unknown;
 finalizerState:string|null;
 finalizerReceipt:unknown;
};

type Notes={broken:boolean;rejected:boolean;causes:Set<Cause>};

function record(value:unknown){return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function noteId(notes:Notes,value:unknown,expected:string){
 if(value===undefined||value===null)return;
 if(typeof value!=='string'||value!==expected)notes.broken=true;
}
function noteExit(notes:Notes,value:unknown){
 if(value===undefined||value===null)return;
 if(typeof value!=='number'||!Number.isInteger(value)||value===0)notes.broken=true;
}
function knownCause(value:unknown):Cause|undefined{
 if(typeof value!=='string'||!Object.hasOwn(STORED_CAUSE,value))return undefined;
 const cause=STORED_CAUSE[value as keyof typeof STORED_CAUSE];
 return typeof cause==='string'?cause:undefined;
}
function noteCause(notes:Notes,recordValue:Record<string,unknown>|null,allowFinalizer:boolean){
 if(!recordValue||!Object.hasOwn(recordValue,'failureCode'))return;
 const value=recordValue.failureCode;
 if(value===null)return;
 const cause=knownCause(value);
 if(!cause||(!allowFinalizer&&FINALIZER_CAUSE.has(cause)))notes.rejected=true;
 else notes.causes.add(cause);
}
/** Structural read only. A matching signature is not checked and is not reported as verified. */
function noteExecution(notes:Notes,receipt:unknown,source:NativeTerminalFailureSource,allowFinalizer:boolean){
 const root=receipt===null||receipt===undefined?null:record(receipt);
 if(receipt!==null&&receipt!==undefined&&!root){notes.broken=true;return;}
 if(!root)return;
 noteCause(notes,root,allowFinalizer);
 noteExit(notes,root.exitCode);
 noteId(notes,root.operationId,source.jobId);
 noteId(notes,root.jobId,source.jobId);
 const signed=root.nativeExecution;
 if(signed===undefined||signed===null)return;
 const envelope=record(signed);
 if(!envelope){notes.broken=true;return;}
 const payload=envelope.payload;
 if(payload===undefined||payload===null)return;
 const body=record(payload);
 if(!body){notes.broken=true;return;}
 noteId(notes,body.jobId,source.jobId);
 noteId(notes,body.intentId,source.intentId);
 noteId(notes,body.contextId,source.contextId);
 noteExit(notes,body.exitCode);
 noteCause(notes,body,allowFinalizer);
}
function finding(source:NativeTerminalFailureSource,notes:Notes,evidence:AgentControlDiagnosticFinding['evidence']){
 const conflict=notes.broken||notes.rejected||notes.causes.size>1;
 const cause=!conflict&&notes.causes.size===1?[...notes.causes][0]:'unknown';
 return agentControlDiagnosticFindingSchema.parse({
  code:'native_execution_failed',
  ...NATIVE_TERMINAL_FAILURE_COPY,
  evidence,
  nativeFailure:{cause,origin:conflict?'unreconciled':'stored_agreement'},
 });
}
export function projectNativeTerminalFailure(source:NativeTerminalFailureSource):AgentControlDiagnosticFinding|null{
 if(source.state!=='failed')return null;
 const notes:Notes={broken:false,rejected:false,causes:new Set()};
 const evidence:AgentControlDiagnosticFinding['evidence']=[{kind:'native_execution_job',id:source.jobId}];
 const job=source.jobReceipt===null||source.jobReceipt===undefined?null:record(source.jobReceipt);
 if(source.jobReceipt!==null&&source.jobReceipt!==undefined&&!job)notes.broken=true;
 const payload=job&&job.payload!==undefined&&job.payload!==null?record(job.payload):job?null:null;
 if(job&&job.payload!==undefined&&job.payload!==null&&!payload)notes.broken=true;
 if(payload){
  noteId(notes,payload.jobId,source.jobId);
  noteId(notes,payload.intentId,source.intentId);
  noteId(notes,payload.contextId,source.contextId);
  noteExit(notes,payload.exitCode);
 }
 const programmer=source.role==='programmer';
 const stageRole=source.role==='qa'||source.role==='reviewer'||source.role==='judge';
 if(programmer){
  if(source.stageId)notes.broken=true;
  if(!source.operationId||source.operationId!==source.jobId)notes.broken=true;
  else{
   evidence.push({kind:'operation',id:source.operationId});
   noteExecution(notes,source.operationReceipt,source,true);
  }
 }else if(stageRole){
  if(source.operationId)notes.broken=true;
  const expected=source.role==='qa'?'qa':source.role==='reviewer'?'review':'judge';
  if(!source.stageId||source.stageId!==source.jobId||source.stageNode!==expected)notes.broken=true;
  else{
   evidence.push({kind:'stage',id:source.stageId});
   noteExecution(notes,source.stageReceipt,source,false);
  }
 }else if(source.operationId||source.stageId)notes.broken=true;
 if(programmer&&source.finalizerState){
  if(source.finalizerState==='ready'||source.finalizerState==='uncertain'||source.finalizerState==='running')notes.broken=true;
  else if(source.finalizerState!=='failed')notes.broken=true;
  else{
   const stored=source.finalizerReceipt===null||source.finalizerReceipt===undefined?null:record(source.finalizerReceipt);
   if(!stored)notes.broken=true;
   else{
    noteId(notes,stored.jobId,source.jobId);
    if(stored.status!==undefined&&stored.status!=='failed')notes.broken=true;
    else noteCause(notes,stored,true);
   }
  }
 }else if(!programmer&&source.finalizerState)notes.broken=true;
 return finding(source,notes,evidence);
}
