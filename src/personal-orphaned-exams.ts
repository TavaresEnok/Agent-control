import {Refusal} from './contracts.ts';
import {failureCode} from './failure-log.ts';
import type {Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';
import {orphanedExamIntentSql} from './native-execution-shared.ts';
import {composePersonalExecutionSupervisors} from './personal-runtime.ts';

type Selection = {jobId: string} | {contextId: string} | {limit: number; deadline: number};

/** One proof and one recovery path for maintenance and the personal exam CLIs. */
export async function recoverPersonalOrphanedExams(config: Installation, ledger: Ledger, selection: Selection, apply: boolean) {
 const manual = 'jobId' in selection;
 const boot = config.nativeBootstrap;
 if (boot?.state !== 'active') {
  if (manual) throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  return [];
 }
 const candidates = (await ledger.pool.query<{id:string;context_id:string;project_id:string;account_id:string;key_fingerprint:string}>(`
  SELECT j.id,j.context_id,x.project_id,j.account_id,j.key_fingerprint
  FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id JOIN ac_intents i ON i.id=j.intent_id
  JOIN ac_capacity_grants g ON g.id=j.grant_id
  WHERE ${manual ? 'j.id=$1' : `j.state IN ('running','uncertain') AND ${orphanedExamIntentSql}
   AND NOT EXISTS(SELECT 1 FROM ac_managers m WHERE m.context_id=j.context_id AND m.lease_until>clock_timestamp())`}
   ${'contextId' in selection ? 'AND j.context_id=$1' : ''}
  ORDER BY (g.state='released'),j.created_at,j.id ${'limit' in selection ? 'LIMIT $1' : ''}`,
  [manual ? selection.jobId : 'contextId' in selection ? selection.contextId : selection.limit])).rows;
 if (!candidates.length) {
  if (manual) throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
  return [];
 }
 const supervisors = await composePersonalExecutionSupervisors(config,ledger);
 const projects = [config.project,...config.projects];
 const lines: string[] = [];
 for (const job of candidates) {
  if ('limit' in selection && Date.now()>=selection.deadline) {
   lines.push('A recuperação de exames órfãos atingiu o prazo desta rodada.');
   break;
  }
  try {
   const project = projects.find(item=>item.id===job.project_id);
   const supervisor = supervisors.find(item=>item.keyFingerprint===boot.execution.keyFingerprint&&
    item.keyFingerprint===job.key_fingerprint&&item.supportsAccount(job.account_id));
   if (!project || !supervisor) throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   const result = await supervisor.recoverOrphanedExam(project.owner,job.id,{
    contextId:job.context_id,projectId:project.id,repository:project.repo,
   },apply);
   lines.push(`${job.id}: ${result==='eligible'?'exame órfão elegível para reconciliação':'exame órfão reconciliado, vaga liberada'}.`);
  } catch (error) {
   if (manual) throw error;
   lines.push(`${job.id}: exame preservado (${failureCode(error)}).`);
  }
 }
 return lines;
}
