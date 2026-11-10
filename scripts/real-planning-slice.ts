// Owner-authorized bench: one real model call through the product planning path.
// Runs only against a disposable database and the host CLI's existing login.
// The ledger row keeps mode='synthetic' because migration 042 stays in force, so
// this proves the planning contract and does not activate subscription_cli.
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Capacity} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {SemanticPlanning,planningReceiptMessage,type PlanningExecutor,type PlanningInvocation} from '../src/semantic-planning.ts';
import {isolatedDatabase} from '../tests/fixtures/isolated-database.ts';

const MODEL=process.env.AC_PLANNING_MODEL??'claude-haiku-5-5',EFFORT=process.env.AC_PLANNING_EFFORT??'low',PROVIDER='claude-code-bench';
const base=process.env.AC_TEST_DATABASE_URL;
if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
if(process.env.AC_REAL_INFERENCE_AUTHORIZED!=='1')throw Error('REAL_INFERENCE_NOT_AUTHORIZED');

function runClaude(prompt:string,cwd:string){
  return new Promise<{code:number;stdout:string}>((done,fail)=>{
    const child=spawn('claude',['-p','--model',MODEL,'--effort',EFFORT,'--max-turns','1','--tools','','--no-session-persistence','--output-format','json'],{cwd,stdio:['pipe','pipe','inherit']});
    let stdout='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),120_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.on('error',fail);
    child.on('close',code=>{clearTimeout(timer);done({code:code??1,stdout});});
    child.stdin.end(prompt);
  });
}
function plannerPrompt(input:PlanningInvocation){
  return `You are the planning manager of a software delivery system. Reply with one JSON object only, no markdown fences or commentary.
It must validate against this JSON Schema:
${JSON.stringify(input.outputSchema)}
Use exactly these values: schemaVersion=1, contextId="${input.contextId}", objectiveRef="${input.sourceMessageRef}", sourceMessageRef="${input.sourceMessageRef}", constraintRefs=[].
In every task: objectiveRef="${input.sourceMessageRef}", qualityRevision=${input.constraints.qualityRevision}, targetRef="${input.constraints.targetRef}", maxCorrections=1, acceptanceRefs must only use ${JSON.stringify(input.constraints.knownReferences)}, inputRefs=[] unless it names a prior task output, each outputRefs entry starts with "output:", writePaths are literal repository-relative files.
Request: ${input.text}`;
}

const isolated=await isolatedDatabase(base,'realslice'),db=new Ledger(isolated.url),capacity=new Capacity(db),scratch=await mkdtemp(join(tmpdir(),'ac-real-slice-'));
try{
  await db.migrate();
  const principal='bench-'+randomUUID(),project=randomUUID(),account=randomUUID(),profile=randomUUID(),source='owner-authorized://bench';
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Real planning bench']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:PROVIDER,model:MODEL,efforts:[EFFORT],roles:['manager'],source});
  await capacity.addAccount(principal,project,{id:account,provider:PROVIDER,label:'Host CLI login',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:source,maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:MODEL,effort:EFFORT,role:'manager'});
  await capacity.observeQuota(principal,account,{status:'available',source,ttlSeconds:300});
  const contextId=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,contextId,randomUUID(),'bench-manager',60);
  const policy=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{manager:{regular:[profile],emergency:[]}}});
  await capacity.assignPolicy(principal,contextId,policy);
  const qualityRevision=await new QualityPolicies(db).publish(principal,project,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)});
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:policy,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:bench'}},authority,'api');

  const pair=generateKeyPairSync('ed25519');
  let calls=0,costUsd=0;
  const executor:PlanningExecutor={id:'claude-cli-bench',digest:digest({bench:'claude-cli',MODEL,EFFORT}),publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),provider:PROVIDER,mode:'synthetic',
    async execute(input){
      await input.assertAuthorized();calls++;
      const run=await runClaude(plannerPrompt(input),scratch);
      const envelope=JSON.parse(run.stdout) as {result:string;session_id:string;total_cost_usd:number};
      costUsd+=envelope.total_cost_usd;
      const output=envelope.result.trim();
      // No container exists on this bench; the field carries a digest of the CLI session.
      const physical={jobId:input.callId,containerId:createHash('sha256').update(envelope.session_id).digest('hex'),exitCode:run.code,finishedAt:new Date().toISOString(),benchHostCli:true};
      await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
      const payload={callId:input.callId,intentId:input.intentId,contextId,grantId:input.grantId,profileId:input.profile.id,sessionId:input.sessionId,epoch:input.executionEpoch,executorDigest:this.digest,inputDigest:input.inputDigest,profileDigest:digest(input.profile),outputDigest:createHash('sha256').update(output).digest('hex'),physicalDigest:digest(physical),exitCode:run.code};
      return {output,receipt:{payload,signature:sign(null,planningReceiptMessage(payload),pair.privateKey).toString('hex')}};
    },
    async reconcile(){return null;},
  };
  const request={id:randomUUID(),intentId:intent.id,contextId,expectedRevision:0,sourceMessageRef:'message:bench-request',qualityRevision,targetRef:'refs/heads/main',knownReferences:['acceptance:docs-exist'],
    text:'Add a CONTRIBUTING.md explaining local setup, then link it from README.md.'};
  const service=new SemanticPlanning(db,executor);
  const first=await service.plan(principal,request,authority);
  const replay=await service.plan(principal,request,authority);
  const call=(await db.pool.query('SELECT state,failure_code,proposal FROM ac_semantic_planning_calls WHERE id=$1',[request.id])).rows[0];
  console.log(JSON.stringify({model:MODEL,effort:EFFORT,state:call.state,failure:call.failure_code,modelCalls:calls,replayMatches:digest(first)===digest(replay),costUsd,published:first,tasks:call.proposal?.tasks.map((task:{id:string;writePaths:string[];dependsOn:string[]})=>({id:task.id,writePaths:task.writePaths,dependsOn:task.dependsOn}))},null,1));
}finally{
  await db.pool.end?.();
  await isolated.close();
  await rm(scratch,{recursive:true,force:true});
}
