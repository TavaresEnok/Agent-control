import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Id,Refusal} from './contracts.ts';
import {finishExamIntent,withExamSignals} from './exam-intent.ts';
import {EXAM_LOGIN_BUSY_TEXT,EXAM_LOGIN_RESTORE_FAILED_TEXT,EXAM_LOGIN_STALE_TEXT} from './exam-login.ts';
import {loadInstallation} from './installation.ts';
import {beginPersonalVerification,resolvePersonalVerification} from './verify-command.ts';
import {removeSecurityReport} from './verify-report.ts';
import {VERIFY_RECHECK_NEW_EXAM_GUIDANCE,VERIFY_RECHECK_NEW_EXAM_REQUIRED} from './verify-remediate.ts';

const messages:Record<string,string>={
 VERIFY_USAGE:'Uso: npm run personal:verify -- <instalação.json> <projectId> [--url <homologação>] [--descartar <runId>]',
 PERSONAL_ACTIVATION_REQUIRED:'A verificação só roda numa instalação pessoal.',
 NOT_FOUND:'Projeto não encontrado.',
 VERIFY_CONTEXT_REQUIRED:'O projeto não tem um contexto para verificar.',
 VERIFY_DB_REQUIRED:'As bases de vulnerabilidade ainda não estão no servidor.',
 VERIFY_WORKER_UNAVAILABLE:'O runtime pessoal não está ativo.',
 VERIFY_EXTERNAL_TARGET:'A homologação tem que ficar em localhost, 127.0.0.1 ou no contêiner-alvo.',
 VERIFY_TARGET_ESCAPE:'A homologação aponta para outro destino.',
 VERIFY_TOOLS_FAILED:'As ferramentas de verificação falharam.',
 VERIFY_COMMIT_INVALID:'Não foi possível ler o commit do repositório.',
 VERIFY_IMAGE_UNPINNED:'A imagem de verificação não está fixada.',
 VERIFY_ALREADY_RUNNING:'Já existe uma verificação em andamento neste projeto.',
 VERIFY_MODEL_BUDGET:'A verificação passou do limite de chamadas de modelo.',
 VERIFY_TARGET_FORBIDDEN:'O contêiner de homologação não está na lista da instalação.',
 VERIFY_LEASE_LOST:'A locação da verificação falhou.',
 VERIFY_TOO_MANY:'A reverificação aceita no máximo 20 achados.',
 DESIGN_REVIEWER_UNAVAILABLE:'Falta um segundo perfil Claude na cadeia specialist para o revisor; rode `npm run personal:design -- preparar <instalação.json> <projectId> --aplicar`.',
 [VERIFY_RECHECK_NEW_EXAM_REQUIRED]:VERIFY_RECHECK_NEW_EXAM_GUIDANCE,
 EXAM_PROVIDER_UNSUPPORTED:'O exame de leitura só aceita uma conta Claude.',
 EXAM_LOGIN_STALE:EXAM_LOGIN_STALE_TEXT,
 EXAM_LOGIN_BUSY:EXAM_LOGIN_BUSY_TEXT,
 EXAM_LOGIN_RESTORE_FAILED:EXAM_LOGIN_RESTORE_FAILED_TEXT,
 EXAM_INTERRUPTED:'O exame foi interrompido.',
};

export function verifyCliFailureText(error:unknown):string{
 const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'';
 return messages[code]??(code||'A verificação falhou.');
}

function fail(error:unknown):never{
 console.error(verifyCliFailureText(error));
 process.exit(1);
 throw error instanceof Error?error:new Error('A verificação falhou.');
}

/**
 * Renew the lease during long exams, skipping ticks while a heartbeat is pending.
 * Three consecutive failures abort once. A successful heartbeat clears the streak.
 */
export function keepPersonalVerifyLease<T>(ledger:{heartbeat:(authority:T)=>Promise<unknown>},authority:T,everyMs=5000,onAbort?:()=>void){
 let consecutive=0;
 let aborted=false;
 let inFlight=false;
 let stopped=false;
 const timer=setInterval(async()=>{
  if(stopped||inFlight)return;
  inFlight=true;
  try{
   await ledger.heartbeat(authority);
   consecutive=0;
  }catch{
   if(stopped)return;
   consecutive+=1;
   if(!aborted&&consecutive>=3){
    aborted=true;
    onAbort?.();
   }
  }finally{
   inFlight=false;
  }
 },everyMs);
 timer.unref();
 return ()=>{
  stopped=true;
  clearInterval(timer);
 };
}

const releaseLeaseSql='UPDATE ac_managers SET lease_until = clock_timestamp() WHERE context_id=$1 AND instance_id=$2 AND epoch=$3';

type LeaseAuthority={contextId:string;instanceId:string;epoch:number};
type LeasePool={pool:{query:(sql:string,params?:readonly unknown[])=>Promise<unknown>}};

/** Zero this epoch's lease and keep the manager row. A query error propagates. */
export async function releasePersonalVerifyLease(ledger:LeasePool,authority:LeaseAuthority):Promise<void>{
 await ledger.pool.query(releaseLeaseSql,[authority.contextId,authority.instanceId,authority.epoch]);
}

/** Lease loss stops the in-flight exam, then fails as VERIFY_LEASE_LOST. A stop error must not replace that code. */
export async function abortPersonalVerifyForLeaseLoss(hooks:{stopLease:()=>void;stopJob:()=>Promise<void>;rejectAbort:(error:unknown)=>void}):Promise<void>{
 hooks.stopLease();
 try{await hooks.stopJob();}
 catch{/* a stop failure must not replace VERIFY_LEASE_LOST */}
 hooks.rejectAbort(new Refusal('VERIFY_LEASE_LOST'));
}

function parseDiscardArgs(argv:readonly string[]):{installationPath:string;projectId:string;runId:string}|undefined{
 if(!argv.includes('--descartar'))return undefined;
 const positional:string[]=[];
 let runId:string|undefined;
 for(let index=0;index<argv.length;index+=1){
  const arg=argv[index]??'';
  if(arg==='--descartar'){
   const value=argv[index+1];
   if(runId!==undefined||value===undefined||value.startsWith('--'))throw new Refusal('VERIFY_USAGE');
   runId=value;
   index+=1;
   continue;
  }
  if(arg.startsWith('--'))throw new Refusal('VERIFY_USAGE');
  positional.push(arg);
 }
 const installationPath=positional[0];
 const projectId=positional[1];
 if(!installationPath||!projectId||!runId||positional.length!==2)throw new Refusal('VERIFY_USAGE');
 if(!Id.safeParse(projectId).success)throw new Refusal('NOT_FOUND',404);
 if(!Id.safeParse(runId).success)throw new Refusal('VERIFY_USAGE');
 return {installationPath,projectId,runId};
}

/** Remove the saved report for --descartar. Returns false when the flag is absent. The exam starter is not called. */
export async function discardPersonalVerification(argv:readonly string[],beginPersonalVerification?:(...args:never[])=>Promise<unknown>):Promise<boolean>{
 const parsed=parseDiscardArgs(argv);
 if(!parsed)return false;
 const config=await loadInstallation(resolve(parsed.installationPath));
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const project=[config.project,...config.projects].find(item=>item.id===parsed.projectId);
 if(!project)throw new Refusal('NOT_FOUND',404);
 await removeSecurityReport(config.dataDirectory,project.id,parsed.runId);
 void beginPersonalVerification;
 return true;
}

export async function runPersonalVerifySession(
 resolved:Awaited<ReturnType<typeof resolvePersonalVerification>>,
 deps?:{begin?:typeof beginPersonalVerification},
):Promise<string>{
 if(!resolved.input.ledger||!resolved.input.authority)throw new Refusal('VERIFY_CONTEXT_REQUIRED',409);
 const ledger=resolved.input.ledger;
 const authority=resolved.input.authority;
 const worker=resolved.input.worker;
 let job=Promise.resolve();
 let runId:string|undefined;
 let rejectAbort:(error:unknown)=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 void aborted.catch(()=>undefined);
 let stopLease:()=>void=()=>{};
 stopLease=keepPersonalVerifyLease(ledger,authority,5000,()=>{
  void abortPersonalVerifyForLeaseLoss({
   stopLease(){stopLease();},
   async stopJob(){await worker?.stop?.();},
   rejectAbort,
  });
 });
 let failed:unknown;
 try{
  return await withExamSignals(
   async()=>{
    const started=await (deps?.begin??beginPersonalVerification)({
     ...resolved.input,
     observe(pending){
      job=pending;
      void job.catch(()=>undefined);
     },
    });
    runId=started.id;
    console.log('Verificação '+started.id+' começou.');
    await Promise.race([job,aborted]);
    console.log('Verificação '+started.id+' concluída.');
    return started.id;
   },
   ()=>{
    void worker?.stop?.().catch(()=>undefined);
   },
  );
 }catch(error){
  failed=error;
  throw error;
 }finally{
  stopLease();
  if(failed&&runId){
   try{
    const updated=(await ledger.pool.query<{intent_id:string}>(
     "UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE id=$1 AND status='running' RETURNING intent_id::text AS intent_id",
     [runId],
    )).rows[0];
    const intentId=updated?.intent_id??(await ledger.pool.query<{intent_id:string}>(
     'SELECT intent_id::text AS intent_id FROM ac_verify_runs WHERE id=$1',
     [runId],
    )).rows[0]?.intent_id;
    if(intentId){
     await finishExamIntent(ledger,{intentId,contextId:authority.contextId},'failed');
    }
   }catch{/* status cleanup must not replace the original failure */}
  }
  try{
   await releasePersonalVerifyLease({pool:{query:(sql,params)=>ledger.pool.query(sql,(params??[]) as never[])}},authority);
  }catch{/* release must not mask the exam error; the exit code is already chosen */}
  try{await resolved.close();}
  catch(error){if(!failed)throw error;}
 }
}

async function main(){
 if(await discardPersonalVerification(process.argv.slice(2))){
  console.log('Relatório descartado.');
  process.exit(0);
 }
 try{
  const resolved=await resolvePersonalVerification(process.argv.slice(2));
  await runPersonalVerifySession(resolved);
 }catch(error){
  fail(error);
 }
 process.exit(0);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(fail);
}
