import {CapacityPolicy} from './capacity.ts';
import {Refusal} from './contracts.ts';
import {managedId} from './managed-plan.ts';
import {NativeReviewVerdict,nativeReviewOutputSchema} from './native-review-contract.ts';

/** The combo QA model runs only after the script runner passed. A model verdict is never script evidence. */
export function qaModelShouldRun(scriptStatus:string|undefined,qaModel:boolean|undefined){
 return scriptStatus==='passed'&&qaModel===true;
}
export const QA_MODEL_INSTRUCTION='You are the QA model. The script runner already finished. Read the diff, ownerRequest and testTail. ownerRequest holds the exact words of the owner for the whole plan; this change may be only one of several independent tasks, so judge it only for the files it touches and never reject because another part of the plan is absent here. Reject when the change should have a test and does not, or when the test does not really test the change. Documentation or other text-only changes need no test. Return only the reviewer verdict JSON with verdict pass or reject. Do not change files or claim that you executed the tests.';

export function qaModelIds(scriptStageId:string){
 return {stageId:managedId(scriptStageId,'qa-model','stage'),sessionId:managedId(scriptStageId,'qa-model','session'),attemptId:managedId(scriptStageId,'qa-model','attempt')};
}

type Queryable={query:(text:string,values?:unknown[])=>Promise<{rows:Array<Record<string,unknown>>}>};
/** Absent or unreadable policy means script QA only, which is the historical behavior. */
export async function contextQaModel(db:Queryable,contextId:string){
 const row=(await db.query(`SELECT r.snapshot FROM ac_contexts x JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision WHERE x.id=$1`,[contextId])).rows[0];
 if(!row)return false;
 const parsed=CapacityPolicy.safeParse(row.snapshot);
 return parsed.success&&parsed.data.qaModel===true;
}

/** Docker multiplex frames become text. A short or broken buffer is shown as plain text. */
export function qaLogTail(logs:Buffer,maxLines=40){
 const parts:Buffer[]=[];let offset=0,framed=logs.length>0;
 while(offset<logs.length){
  if(logs.length-offset<8||(logs[offset]!==1&&logs[offset]!==2)||logs[offset+1]!==0||logs[offset+2]!==0||logs[offset+3]!==0){framed=false;break;}
  const length=logs.readUInt32BE(offset+4);offset+=8;
  if(length>logs.length-offset){framed=false;break;}
  parts.push(logs.subarray(offset,offset+length));offset+=length;
 }
 const text=(framed?Buffer.concat(parts):logs).toString('utf8');
 return text.split('\n').slice(-maxLines).join('\n').slice(-8000);
}

/** Reviewer JSON, plus the owner's words, the diff and the last test lines. `fail` is accepted as `reject`. */
export function parseQaModelVerdict(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return NativeReviewVerdict.parse(raw);
 const copy={...(raw as Record<string,unknown>)};
 if(copy.verdict==='fail')copy.verdict='reject';
 if(!Object.hasOwn(copy,'kind'))copy.kind='review';
 return NativeReviewVerdict.parse(copy);
}

export function qaModelExecutionRequest(input:{stageId:string;sessionId:string;intentId:string;grantId:string;artifact:{id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string};diff:string;truncated?:boolean;ownerRequest?:string;testTail:string}){
 const task=JSON.stringify({instruction:QA_MODEL_INSTRUCTION,...(input.ownerRequest?{ownerRequest:input.ownerRequest}:{}),kind:'review',diff:input.diff.slice(0,20000),diffTruncated:Boolean(input.truncated),testTail:input.testTail.slice(0,8000),artifactId:input.artifact.id,policyRevision:input.artifact.policy_revision,commit:input.artifact.commit_id,tree:input.artifact.tree_id,base:input.artifact.base_id});
 return {jobId:input.stageId,intentId:input.intentId,grantId:input.grantId,sessionId:input.sessionId,base:input.artifact.commit_id,role:'qa' as const,task,writePaths:[] as string[],artifactId:input.artifact.id,outputSchema:structuredClone(nativeReviewOutputSchema)};
}

/** Calls the evaluator only when the script passed and the combo named a QA model. A throw skips the script record. */
export async function continueAfterScriptQa<T>(input:{scriptState:string;scriptStatus?:string;qaModel?:boolean;evaluate:()=>Promise<void>;record:()=>Promise<T>}){
 if(input.scriptState!=='completed'&&input.scriptState!=='failed')throw new Refusal('NATIVE_QA_RESULT_UNCONFIRMED');
 if(qaModelShouldRun(input.scriptStatus,input.qaModel))await input.evaluate();
 return input.record();
}
