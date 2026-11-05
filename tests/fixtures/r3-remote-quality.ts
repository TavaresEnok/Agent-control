import {execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID,randomBytes} from 'node:crypto';
import {copyFile,mkdir,writeFile,rm,readFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeExecutionSupervisor} from '../../src/native-execution-supervisor.ts';
import {NativeVerification} from '../../src/native-verification.ts';
import {authorizeNativeSyntheticFixture} from '../../src/native-synthetic-fixture.ts';
import {AccountHomes} from '../../src/account-homes.ts';
import {Capacity} from '../../src/capacity.ts';
import {ProviderEligibility} from '../../src/provider-eligibility.ts';
import {type Ledger} from '../../src/ledger.ts';
import {type Quality} from '../../src/quality.ts';
import {digest} from '../../src/contracts.ts';
import {cleanupGraphResources} from './native-graph-cleanup.ts';
const run=(binary:string,args:string[])=>execFileSync(binary,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
/** Reuses the existing injection-only capability; production native guards stay intact. */
export async function remoteQualityReviewer(lab:{db:Ledger;root:string;local:string;projectId:string;contextId:string;principal:string;quality:Quality;verifierKey:Uint8Array},options:{emitCanary?:boolean;realNativeWorker?:boolean}={}){
 const label='ac-r3-flow-remote-quality-'+randomUUID().slice(0,8),context=join(lab.root,'review-image'),spool=join(lab.root,'review-spool'),homes=join(lab.root,'review-homes');
 for(const path of [context,spool,homes])await mkdir(path,{mode:0o700});
 await copyFile(resolve(options.emitCanary?'tests/fixtures/r3-remote-quality-worker/worker-canary.mjs':'tests/fixtures/r3-remote-quality-worker/worker.mjs'),join(context,'worker.mjs'));await copyFile(resolve('tests/fixtures/r3-flow-worker/verify.mjs'),join(context,'verify.mjs'));
 const publicBinary='/home/app/.local/share/node24/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',publicSha256='b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8';
 const binary=await readFile(publicBinary);if(createHash('sha256').update(binary).digest('hex')!==publicSha256)throw Error('REMOTE_QUALITY_PUBLIC_CODEX_PIN_CHANGED');await copyFile(publicBinary,join(context,'codex'));await chmod(join(context,'codex'),0o555);
 const esbuild=resolve('upstream/cezar/node_modules/.bin/esbuild'),banner='--banner:js=import { createRequire as __acCreateRequire } from "node:module"; const require = __acCreateRequire(import.meta.url);';
 for(const [input,output] of [[resolve('src/native-tools-worker.ts'),'native-tools-worker.mjs'],[resolve('tests/fixtures/r3-remote-quality-worker/exec-client.mjs'),'exec-client.mjs']])run(esbuild,[input!,'--bundle','--platform=node','--target=node22','--format=esm',banner,'--outfile='+join(context,output!)]);
 // esbuild respects the caller's umask; the image runs as a non-root UID.
 for(const name of ['native-tools-worker.mjs','exec-client.mjs'])await chmod(join(context,name),0o644);
 if(options.realNativeWorker){run(esbuild,[resolve('src/native-execution-worker.ts'),'--bundle','--platform=node','--target=node22','--format=esm',banner,'--outfile='+join(context,'worker.mjs')]);await chmod(join(context,'worker.mjs'),0o644);await copyFile(resolve('tests/fixtures/r5-native-real-worker/codex.mjs'),join(context,'codex-fixture'));await chmod(join(context,'codex-fixture'),0o555);}
 await writeFile(join(context,'Dockerfile'),'FROM agent-control-lab:0.1.0\nCOPY worker.mjs /opt/agent-control/dist/src/native-execution-worker.mjs\nCOPY native-tools-worker.mjs /opt/agent-control/dist/src/native-tools-worker.mjs\nCOPY exec-client.mjs /opt/fixture/exec-client.mjs\n'+(options.realNativeWorker?'COPY codex /opt/fixture/public-codex\nCOPY codex-fixture /usr/local/bin/codex\n':'COPY codex /usr/local/bin/codex\n')+'COPY verify.mjs /opt/fixture/verify.mjs\n');
 let image='',network='';try{
 run('docker',['build','--pull=false','--network=none','--label','agent-control.synthetic-fixture='+label,'-t',label,context]);image=run('docker',['image','inspect','--format','{{.Id}}',label]);
 network=run('docker',['network','create','--internal','--label','agent-control.synthetic-fixture='+label,label]);
 const fixture=await authorizeNativeSyntheticFixture({contract:'native-synthetic-fixture-v1',projectId:lab.projectId,contextId:lab.contextId,provider:'synthetic-engineering',label,workerImage:image,toolsImage:image,providerNetworkId:network});
 const capacity=new Capacity(lab.db),accountId=randomUUID(),syntheticAccount='fixture-'+randomUUID(),accessToken='synthetic-access-'+randomBytes(24).toString('hex'),refreshToken='synthetic-refresh-'+randomBytes(24).toString('hex'),subject=options.realNativeWorker?digest({provider:'codex',subject:syntheticAccount}):'e'.repeat(64),reviewer=randomUUID(),judge=randomUUID();
 await capacity.addAccount(lab.principal,lab.projectId,{id:accountId,provider:'synthetic-engineering',label:'R3 independent deterministic reviewer',resourceIdentity:'synthetic-engineering:'+subject,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-remote-quality',maxConcurrent:2});
 for(const [id,role] of [[reviewer,'reviewer'],[judge,'judge']] as const){await capacity.registerModel(lab.principal,{provider:'synthetic-engineering',model:'fixed-'+role,efforts:['medium'],roles:[role],source:'synthetic://r3-remote-quality'});await capacity.addProfile(lab.principal,lab.projectId,{id,accountId,model:'fixed-'+role,effort:'medium',role});}
 await capacity.observeQuota(lab.principal,accountId,{status:'available',source:'synthetic://r3-remote-quality',ttlSeconds:3600});await new AccountHomes(lab.db,homes,[lab.local]).initialize(lab.principal,lab.projectId,accountId);await writeFile(join(homes,accountId,'r3-secret-canary'),'synthetic-remote-quality-'+randomUUID(),{mode:0o600,flag:'wx'});
 if(options.realNativeWorker){await mkdir(join(homes,accountId,'.codex'),{mode:0o700});await writeFile(join(homes,accountId,'.codex','auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:syntheticAccount,access_token:accessToken,refresh_token:refreshToken,id_token:'synthetic-id-'+randomBytes(24).toString('hex')}}),{mode:0o600,flag:'wx'});}
 const keys=generateKeyPairSync('ed25519'),supervisor=new NativeExecutionSupervisor(lab.db,{id:'r3-remote-quality-native',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:homes,repository:lab.local,protectedRepositories:[],signingKeyPem:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),providerNetworkId:network,accountSubjects:[{accountId,subjectDigest:subject}],workerEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],toolsEnv:['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','NODE_VERSION=22.23.3','YARN_VERSION=1.22.22'],syntheticFixture:fixture});
 await new ProviderEligibility(lab.db).publish(lab.principal,lab.projectId,{accountId,expectedRevision:0,plan:'Deterministic isolated independent reviewer',adapterId:'r3-remote-quality-native',adapterVersion:supervisor.executorDigest,authenticationMode:'synthetic',executionMode:'synthetic',sourceURL:'https://example.invalid/r3-remote-quality',status:'documented_supported',reason:'Explicit disposable inference fixture; actual isolated execution',reviewedAt:new Date().toISOString(),validForSeconds:3600});
 const verification=new NativeVerification(lab.db,lab.quality,[supervisor],lab.verifierKey);
 const close=async()=>{
  await cleanupGraphResources(lab.db,image);
  const details=JSON.parse(run('docker',['network','inspect',network]))[0];if(details.Labels['agent-control.synthetic-fixture']!==label)throw Error('REMOTE_QUALITY_NETWORK_IDENTITY');run('docker',['network','rm',network]);const pinned=JSON.parse(run('docker',['image','inspect',image]))[0];if(pinned.Config.Labels['agent-control.synthetic-fixture']!==label)throw Error('REMOTE_QUALITY_IMAGE_IDENTITY');run('docker',['image','rm',label]);await rm(context,{recursive:true,force:true});
 };
 return {capacity,verification,supervisor,reviewer,judge,accountId,image,network,spool,accessToken,refreshToken,close};
 }catch(error){const failures:unknown[]=[error];if(network)try{run('docker',['network','rm',network]);}catch(cleanup){failures.push(cleanup);}if(image)try{run('docker',['image','rm',label]);}catch(cleanup){failures.push(cleanup);}throw new AggregateError(failures,'REMOTE_QUALITY_FIXTURE_SETUP_FAILED');}
}
