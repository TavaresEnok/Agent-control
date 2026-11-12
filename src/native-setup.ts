import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {loadInstallation} from './installation.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';
/** Keeps the replaced planning images so a call left uncertain under one of them can still be reconciled. */
function retiredPlanning(previous:unknown,current:string):{retiredImageIds?:string[]}{
 const old=(previous as {state?:string;planning?:{imageId?:string;retiredImageIds?:string[]}}|undefined);
 if(old?.state!=='active'||!old.planning?.imageId)return {};
 const ids=[...(old.planning.retiredImageIds??[]),old.planning.imageId].filter((id,i,all)=>id!==current&&all.indexOf(id)===i).slice(-8);
 return ids.length?{retiredImageIds:ids}:{};
}
import {nativeQaContractDigest} from './native-qa-contract.ts';
import {defaultPersonalQaContract,resolvePersonalProjectQa,syncPersonalQaPolicy} from './personal-qa-config.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';
import {QualityPolicies,QualityPolicy} from './quality-policy.ts';
import {publishFirstPersonalPolicies,refreshPersonalTemplates,shareProjectAccounts} from './personal-policies.ts';
import {Capacity} from './capacity.ts';

const Image=z.string().regex(/^sha256:[a-f0-9]{64}$/);

function providerNetwork(){
 try{execFileSync('docker',['network','inspect','ac-native-provider'],{stdio:'ignore'});}
 catch{execFileSync('docker',['network','create','ac-native-provider'],{stdio:'ignore'});}
 const inspected=JSON.parse(execFileSync('docker',['network','inspect','ac-native-provider'],{encoding:'utf8'})) as {Id:string}[];
 const id=inspected[0]?.Id??'';
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('PROVIDER_NETWORK_UNAVAILABLE');
 return id;
}

async function keyFile(path:string){
 let pem:string;
 try{pem=await readFile(path,'utf8');}
 catch{const pair=generateKeyPairSync('ed25519');pem=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();await writeFile(path,pem,{mode:0o600,flag:'wx'});}
 const fingerprint=createHash('sha256').update(createPublicKey(pem).export({format:'der',type:'spki'})).digest('hex');
 return {file:path,fingerprint};
}

/** Writes a ready nativeBootstrap block. Image digests come from the environment so the owner does not type them. */
export async function nativeSetup(path:string){
 const config=await loadInstallation(path);
 if(config.activation!=='personal')throw new Error('PERSONAL_ACTIVATION_REQUIRED');
 const root=join(config.dataDirectory,'native');
 await mkdir(root,{recursive:true,mode:0o700});
 const planningKey=await keyFile(join(root,'planning.pem'));
 const executionKey=await keyFile(join(root,'execution.pem'));
 const reviewKey=await keyFile(join(root,'review.pem'));
 for(const name of ['planning-host','planning-accounts','execution-host','execution-accounts'])await mkdir(join(root,name),{recursive:true,mode:0o700});
 const images={planning:process.env.AC_NATIVE_PLANNING_IMAGE,worker:process.env.AC_NATIVE_WORKER_IMAGE,tools:process.env.AC_NATIVE_TOOLS_IMAGE};
 if(!Image.safeParse(images.planning).success||!Image.safeParse(images.worker).success||!Image.safeParse(images.tools).success)
  return {state:'images_required',directory:root,next:'Exporte AC_NATIVE_PLANNING_IMAGE, AC_NATIVE_WORKER_IMAGE e AC_NATIVE_TOOLS_IMAGE (sha256:...) e rode native-setup de novo.'};
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const accounts=(await ledger.pool.query("SELECT id,provider,resource_identity FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.mode='subscription_cli' AND a.provider IN ('codex','claude','grok')",[config.project.id])).rows;
  if(!accounts.length)return {state:'account_required',directory:root,next:'Rode account-add para codex e claude antes de native-setup.'};
  const context=(await ledger.pool.query('SELECT id FROM ac_contexts WHERE project_id=$1 AND NOT archived ORDER BY created_at LIMIT 1',[config.project.id])).rows[0];
  // Projects without qa/<id>.json keep this contract. AC_PERSONAL_QA_ARGV still replaces its argv.
  const qaArgv=process.env.AC_PERSONAL_QA_ARGV?z.array(z.string()).min(1).parse(JSON.parse(process.env.AC_PERSONAL_QA_ARGV)):undefined;
  const qa=defaultPersonalQaContract(images.tools!,qaArgv);
  const block={state:'active',contract:'native-bootstrap-configured-v1',projectId:config.project.id,contextId:config.managerTransport?.contexts.find(item=>item.projectId===config.project.id)?.contextId??context?.id??randomUUID(),epoch:1,instanceId:randomUUID(),source:'authorized-endpoint',
   accounts:accounts.map(account=>({accountId:account.id,subjectDigest:String(account.resource_identity).slice(account.provider.length+1)})),
   planning:{id:'personal-planning',imageId:images.planning,...retiredPlanning(config.nativeBootstrap,images.planning!),executorDigest:nativePlanningExecutorDigest(images.planning!),signingKeyFile:planningKey.file,keyFingerprint:planningKey.fingerprint,hostRoot:join(root,'planning-host'),accountRoot:config.accountHomesDirectory??join(root,'planning-accounts')},
   execution:{id:'personal-execution',workerImage:images.worker,toolsImage:images.tools,executorDigest:nativeExecutionExecutorDigest(images.worker!,images.tools!),signingKeyFile:executionKey.file,keyFingerprint:executionKey.fingerprint,hostRoot:join(root,'execution-host'),accountRoot:config.accountHomesDirectory??join(root,'execution-accounts'),providerNetworkId:providerNetwork(),workerEnv:['PATH=/usr/local/bin:/usr/bin:/bin'],toolsEnv:['PATH=/usr/local/bin:/usr/bin:/bin']},
   qa,qaDigest:nativeQaContractDigest(qa),review:{signingKeyFile:reviewKey.file,keyFingerprint:reviewKey.fingerprint,verifierDigest:nativeReviewVerifierDigest}};
  // The QA stage refuses a policy whose QA verifier digest differs from this contract, so keep the latest revision in step with it.
  const qaDigestFor=async(projectId:string)=>nativeQaContractDigest(await resolvePersonalProjectQa({dataDirectory:config.dataDirectory,projectId,image:images.tools!,fallback:qa}));
  const primaryDigest=await qaDigestFor(config.project.id);
  const latest=(await ledger.pool.query('SELECT revision,snapshot FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[config.project.id])).rows[0];
  const base=latest?QualityPolicy.parse(latest.snapshot):QualityPolicy.parse({schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false});
  if(base.verifierDigest!==nativeReviewVerifierDigest||base.qaVerifierDigest!==primaryDigest)
   await new QualityPolicies(ledger).publish(config.project.owner,config.project.id,Number(latest?.revision??0),{...base,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:primaryDigest});
  // A new project has no capacity policy yet, and a conversation cannot be created without one: publish the
  // obvious first one, each role served by the profiles the owner registered for it. An existing policy is left alone.
  if(!(await ledger.pool.query('SELECT 1 FROM ac_policy_revisions WHERE project_id=$1 LIMIT 1',[config.project.id])).rowCount){
   const profiles=(await ledger.pool.query(`SELECT p.id,p.role FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id WHERE x.project_id=$1 AND p.enabled ORDER BY p.role,p.id`,[config.project.id])).rows;
   const roles:Record<string,{regular:string[];emergency:string[]}>={};
   for(const profile of profiles)(roles[String(profile.role)]??={regular:[],emergency:[]}).regular.push(String(profile.id));
   if(roles.manager&&roles.programmer)await new Capacity(ledger).publish(config.project.owner,config.project.id,0,{schemaVersion:1,roles,maxEvaluatorsPerContext:2,maxProgrammersPerContext:2} as never);
  }
  // Conversations plan against the latest quality revision, so move their templates forward with it.
  await refreshPersonalTemplates(ledger,config.project.id);
  // Other projects on this installation share the same accounts and get their own first policies.
  for(const project of config.projects){
   if(project.id===config.project.id)continue;
   if(!(await ledger.pool.query('SELECT 1 FROM ac_projects WHERE id=$1',[project.id])).rowCount)continue;
   await shareProjectAccounts(ledger,config.project.owner,config.project.id,project.id);
   const projectDigest=await qaDigestFor(project.id);
   await publishFirstPersonalPolicies(ledger,config.project.owner,project.id,config.project.id,{qaVerifierDigest:projectDigest});
   await syncPersonalQaPolicy(ledger,project.owner,project.id,projectDigest);
   await refreshPersonalTemplates(ledger,project.id);
  }
  const raw=JSON.parse((await readFile(path,'utf8')).toString()) as Record<string,unknown>;
  raw.nativeBootstrap=block;
  await writeFile(path,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
  return {state:'active',accounts:accounts.length};
 }finally{await ledger.close();}
}
