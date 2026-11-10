import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {loadInstallation} from './installation.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';
import {nativeQaContractDigest,NativeQaContract} from './native-qa-contract.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';

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
  const accounts=(await ledger.pool.query("SELECT id,provider,resource_identity FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.mode='subscription_cli' AND a.provider IN ('codex','claude')",[config.project.id])).rows;
  if(!accounts.length)return {state:'account_required',directory:root,next:'Rode account-add para codex e claude antes de native-setup.'};
  const context=(await ledger.pool.query('SELECT id FROM ac_contexts WHERE project_id=$1 AND NOT archived ORDER BY created_at LIMIT 1',[config.project.id])).rows[0];
  const qa=NativeQaContract.parse({schemaVersion:1,id:'personal-qa',image:images.tools,argv:['/usr/bin/node','--version'],environment:['PATH=/usr/local/bin:/usr/bin:/bin'],timeoutMs:120000,memoryBytes:268435456,pids:64,nanoCpus:500000000});
  const block={state:'active',contract:'native-bootstrap-configured-v1',projectId:config.project.id,contextId:context?.id??randomUUID(),epoch:1,instanceId:randomUUID(),source:'authorized-endpoint',
   accounts:accounts.map(account=>({accountId:account.id,subjectDigest:String(account.resource_identity).slice(account.provider.length+1)})),
   planning:{id:'personal-planning',imageId:images.planning,executorDigest:nativePlanningExecutorDigest(images.planning!),signingKeyFile:planningKey.file,keyFingerprint:planningKey.fingerprint,hostRoot:join(root,'planning-host'),accountRoot:config.accountHomesDirectory??join(root,'planning-accounts')},
   execution:{id:'personal-execution',workerImage:images.worker,toolsImage:images.tools,executorDigest:nativeExecutionExecutorDigest(images.worker!,images.tools!),signingKeyFile:executionKey.file,keyFingerprint:executionKey.fingerprint,hostRoot:join(root,'execution-host'),accountRoot:config.accountHomesDirectory??join(root,'execution-accounts'),providerNetworkId:providerNetwork(),workerEnv:['PATH=/usr/local/bin:/usr/bin:/bin'],toolsEnv:['PATH=/usr/local/bin:/usr/bin:/bin']},
   qa,qaDigest:nativeQaContractDigest(qa),review:{signingKeyFile:reviewKey.file,keyFingerprint:reviewKey.fingerprint,verifierDigest:nativeReviewVerifierDigest}};
  const raw=JSON.parse((await readFile(path,'utf8')).toString()) as Record<string,unknown>;
  raw.nativeBootstrap=block;
  await writeFile(path,JSON.stringify(raw,null,2)+'\n',{mode:0o600});
  return {state:'active',accounts:accounts.length};
 }finally{await ledger.close();}
}
