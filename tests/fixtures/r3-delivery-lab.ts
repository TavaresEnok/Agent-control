import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {chmod,copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../../src/ledger.ts';
import {Operators,operatorMessage} from '../../src/operator.ts';
import {Control} from '../../src/control.ts';
import {RemoteOperations,OpenSshTransport} from '../../src/remote.ts';
import {ProjectAdmin} from '../../src/project-admin.ts';
import {RemoteDevelopment} from '../../src/remote-development.ts';
import {Capacity} from '../../src/capacity.ts';
import {GitArtifacts} from '../../src/git.ts';
import {Quality} from '../../src/quality.ts';
import {NativeQaContract,nativeQaContractDigest} from '../../src/native-qa.ts';
import {nativeReviewVerifierDigest} from '../../src/native-verification.ts';
import {digest} from '../../src/contracts.ts';
import {ProjectEnvironments} from '../../src/project-environments.ts';
import {Templates} from '../../src/templates.ts';
import {isolatedDatabase} from './isolated-database.ts';

const command=(binary:string,args:string[])=>execFileSync(binary,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const labGit=(repo:string,...args:string[])=>command('git',['-C',repo,...args]);
/** New disposable resources only; no inherited accounts, credentials or daemon changes. */
export async function remoteDevelopmentLab(base:string,options:{requireJudge?:boolean;configureEnvironment?:boolean}={}){
 const isolated=await isolatedDatabase(base,'r3dev'),db=new Ledger(isolated.url),root=await mkdtemp(join(tmpdir(),'ac-r3-dev-')),scratch=await mkdtemp('/dev/shm/ac-r3-dev-');
 const name='ac-r3-delivery-dev-'+randomUUID().slice(0,8),installationId='ac-r3-delivery-dev-'+randomUUID();let container=false,mounted=false;
 const close=async()=>{
  const errors:unknown[]=[];const cleanup=async(fn:()=>unknown|Promise<unknown>)=>{try{await fn();}catch(error){errors.push(error);}};
  // Stop only containers whose immutable labels name this new installation.
  await cleanup(()=>{
   const ids=command('docker',['ps','-aq','--filter','label=ac.remote.installation='+installationId]);
   if(ids)for(const id of ids.split('\n'))command('docker',['rm','-f',id]);
  });
  if(container)await cleanup(()=>command('docker',['rm','-f',name]));
  await cleanup(()=>db.close());await cleanup(()=>isolated.close());await cleanup(()=>rm(root,{recursive:true,force:true}));
  let unmounted=!mounted;if(mounted)await cleanup(()=>{command('sudo',['-n','umount',scratch]);unmounted=true;});
  if(unmounted)await cleanup(()=>rm(scratch,{recursive:true,force:true}));
  if(errors.length)throw new AggregateError(errors,'R3_DEVELOPMENT_LAB_CLEANUP_FAILED');
 };
 try{
  command('sudo',['-n','mount','-t','tmpfs','-o',`size=64m,mode=0700,uid=${process.getuid?.()},gid=${process.getgid?.()}`,'ac-r3-delivery-dev',scratch]);mounted=true;await chmod(root,0o755);
  const original=join(root,'original'),bare=join(root,'destination.git'),workspaceRoot=join(root,'workspaces'),state=join(root,'state'),installed=join(root,'installed');
  for(const path of [workspaceRoot,state,installed])await mkdir(path,{mode:0o700});
  command('git',['init','-q','-b','agent-control-export',original]);await mkdir(join(original,'src'));await writeFile(join(original,'src/example.ts'),'export const value = 1;\n');
  labGit(original,'add','.');labGit(original,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
  const source=labGit(original,'rev-parse','HEAD'),sourceTree=labGit(original,'rev-parse','HEAD^{tree}');command('git',['clone','--bare','-q',original,bare]);
  const projectId=randomUUID(),hostId=randomUUID(),credentialId=randomUUID(),principal='r3-development-'+randomUUID(),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,'controller')]);command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,'host')]);
  await writeFile(join(root,'authorized_keys'),await readFile(join(root,'controller.pub')),{mode:0o600});
  for(const [sourcePath,target] of [['services/remote-worker/worker.py','worker.py'],['services/remote-worker/remote_supervisor.py','remote_supervisor.py'],['services/remote-git/helper.py','remote_git.py'],['services/remote-git/return_helper.py','remote_git_return.py'],['services/remote-git/workspace_helper.py','remote_git_workspace.py']])await copyFile(resolve(sourcePath),join(installed,target));
  const task="import pathlib,subprocess;pathlib.Path('src/example.ts').write_text('export const value = 2;\\n');pathlib.Path('private-untracked-secret').write_text('synthetic-private-canary');subprocess.run(['git','add','--update','src/example.ts'],check=True);subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','remote implementation'],check=True);print('remote implementation committed',flush=True)";
  const config={stateDirectory:state,projects:{[projectId]:bare},gitExportProjects:[projectId],gitReturnProjects:[projectId],gitReturnRefs:{[projectId]:['refs/heads/agent-control-export']},gitWorkspaceProjects:[projectId],gitWorkspaceRoot:workspaceRoot,
   tasks:{implement:['/usr/bin/python3','-c',task]},maxConcurrent:2,maxSeconds:15,maxLogBytes:4096,executionBackend:'docker',installationId,authorityEpoch:1,dockerImage:'agent-control-ssh-lab:0.1.0'};
  await writeFile(join(root,'worker.json'),JSON.stringify(config));
  await writeFile(join(root,'sshd.conf'),`Port 2222\nListenAddress 0.0.0.0\nHostKey /fixtures/host\nPidFile /tmp/sshd.pid\nAuthorizedKeysFile /fixtures/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes yes\nAllowUsers node\nAllowTcpForwarding no\nAllowAgentForwarding no\nPermitTTY no\nForceCommand /usr/bin/python3 /usr/local/lib/agent-control/worker.py --config ${root}/worker.json\nLogLevel ERROR\n`);
  const socketGid=command('stat',['-c','%g','/var/run/docker.sock']);assert.match(socketGid,/^[0-9]+$/);
  command('docker',['run','-d','--name',name,'--label','ac.scope=ac-r3-delivery','-p','127.0.0.1::2222','-v',`${root}:${root}`,'-v',`${root}:/fixtures`,'-v',`${installed}:/usr/local/lib/agent-control:ro`,'-v','/var/run/docker.sock:/var/run/docker.sock','--entrypoint','/bin/sh','ac-r3-remote-ssh:20261105','-ec',`addgroup -g ${socketGid} acdocker; addgroup node acdocker; exec /usr/sbin/sshd -D -e -f ${root}/sshd.conf`]);container=true;
  const port=Number(command('docker',['port',name,'2222/tcp']).split(':').at(-1)),fingerprint=command('ssh-keygen',['-lf',join(root,'host.pub'),'-E','sha256']).split(/\s+/)[1];
  await db.migrate();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectId,'R3 direct remote development']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectId,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const info={deviceId,expiresAt:Date.now()+120000};return {...info,signature:sign(null,Buffer.from(operatorMessage(principal,value,info,installation)),keys.privateKey).toString('hex')};};
  const capacity=new Capacity(db);await capacity.configure(principal,{programmingLimit:4,evaluationLimit:4});const accountId=randomUUID();
  await capacity.addAccount(principal,projectId,{id:accountId,provider:'r3-delivery-fixed',label:'Disposable deterministic executor',resourceIdentity:'r3-delivery:'+accountId,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-delivery',maxConcurrent:4});
  await capacity.observeQuota(principal,accountId,{status:'available',source:'synthetic://r3-delivery',ttlSeconds:3600});
  const profiles={programmer:randomUUID(),qa:randomUUID(),reviewer:randomUUID(),judge:randomUUID()};
  for(const role of ['programmer','qa','reviewer','judge'] as const){await capacity.registerModel(principal,{provider:'r3-delivery-fixed',model:'fixed-'+role,efforts:['medium'],roles:[role],source:'synthetic://r3-delivery'});await capacity.addProfile(principal,projectId,{id:profiles[role],accountId,model:'fixed-'+role,effort:'medium',role});}
  await capacity.publish(principal,projectId,0,{schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profiles.programmer],emergency:[]},qa:{regular:[profiles.qa],emergency:[]},reviewer:{regular:[profiles.reviewer],emergency:[]},judge:{regular:[profiles.judge],emergency:[]}}});
  const contextId=await db.createContext(principal,projectId,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  await capacity.assignPolicy(principal,contextId,1);
  const ssh=new OpenSshTransport(async id=>{assert.equal(id,credentialId);return join(root,'controller');},new Set(['127.0.0.1'])),remote=new RemoteOperations(db,ssh);
  await remote.registerHost(principal,projectId,{id:hostId,label:'Disposable workspace host',hostname:'127.0.0.1',port,username:'node',publicKey:(await readFile(join(root,'host.pub'),'utf8')).trim(),fingerprint,credentialRef:credentialId,remoteRoot:bare,allowedTasks:['git-export','git-return','git-workspace','implement'],maxConcurrent:2});
  const local=join(root,'remote-sources',projectId),verifierKey=randomBytes(32),git=new GitArtifacts(local),quality=new Quality(db,verifierKey,git);
  const image=JSON.parse(command('docker',['image','inspect','agent-control-ssh-lab:0.1.0']))[0];
  const qaContract=NativeQaContract.parse({schemaVersion:1,id:'r3-delivery-value',image:image.Id,argv:['/usr/local/bin/node','--experimental-strip-types','--input-type=module','-e',"import assert from 'node:assert/strict'; const {value}=await import('/work/src/example.ts'); assert.equal(value,2); console.log('independent functional value=2');"],environment:[...image.Config.Env,'HOME=/tmp','CI=1'],timeoutMs:15000,memoryBytes:268435456,pids:64,nanoCpus:1000000000});
  const qualityRevision=await quality.publish(principal,projectId,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:options.requireJudge??false,requireHumanIntegration:true,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:nativeQaContractDigest(qaContract)});
  await new Templates(db).publish(principal,contextId,0,{workflow:'engineering-synthetic-v1',qualityRevision,targetRef:'refs/heads/agent-control-export'});
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:r3-delivery-fixed-task'}},authority,'api');
  const authorization={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit:source,tree:sourceTree}};await new Control(db).execute(principal,authorization,proof(authorization));
  const operationId=randomUUID(),exported=await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit:source,tree:sourceTree},authority);
  const admin=new ProjectAdmin(db,[{id:'fixture',label:'Disposable root',path:root}],join(root,'private'),{remoteSourceTmpfs:scratch,remoteReturnTransport:ssh});
  const materialize={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource',payload:{projectId,contextId,hostId,operationId,commit:source,tree:sourceTree,bundle:exported.bundle.toString('base64')}};await admin.execute(principal,materialize,proof(materialize));
  const environments=new ProjectEnvironments(db,[{id:'fixture',path:root}],join(root,'private'));
  const environmentCommand={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure',payload:{projectId,expectedRevision:0,config:{sourceBranch:'refs/heads/agent-control-export',environments:[{id:'lab',label:'Disposable lab',targetRef:'refs/heads/agent-control-export',authorizedDirectories:['src'],destinations:[{id:'local',label:'Local repository',kind:'local_repository'},{id:'remote',label:'Disposable remote',kind:'remote',hostId,allowedPurposes:['remote-development','remote-return']}]}]}}};
  const configureEnvironment=()=>environments.configure(principal,environmentCommand,proof(environmentCommand));
  if(options.configureEnvironment!==false)await configureEnvironment();
  const development=new RemoteDevelopment(db,ssh,{implementationProfiles:new Map([[profiles.programmer,{hostId,taskId:'implement',writePaths:['src/example.ts']}]])});
  return {db,root,scratch,source,sourceTree,original,bare,local,workspaceRoot,state,config,projectId,hostId,principal,profiles,contextId,authority,intent,sourceOperationId:operationId,development,remote,ssh,admin,quality,git,verifierKey,qaContract,proof,configureEnvironment,close};
 }catch(error){await close();throw error;}
}
