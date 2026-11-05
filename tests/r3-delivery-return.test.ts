import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Control} from '../src/control.ts';
import {RemoteOperations,OpenSshTransport,type RemoteTransport} from '../src/remote.ts';
import {ProjectEnvironments} from '../src/project-environments.ts';
import {Templates} from '../src/templates.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const command=(binary:string,args:string[])=>execFileSync(binary,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const git=(repo:string,...args:string[])=>command('git',['-C',repo,...args]);

test('R3 signed approved artifact returns over pinned real SSH with CAS and durable lost-ACK replay', {timeout:120000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'r3delivery'),db=new Ledger(isolated.url);
 const root=await mkdtemp(join(tmpdir(),'ac-r3-delivery-')),scratch=await mkdtemp('/dev/shm/ac-r3-delivery-');
 const name='ac-r3-delivery-'+randomUUID().slice(0,8);let container=false,mounted=false;
 try{
  command('sudo',['-n','mount','-t','tmpfs','-o',`size=64m,mode=0700,uid=${process.getuid?.()},gid=${process.getgid?.()}`,'ac-r3-delivery',scratch]);mounted=true;
  await chmod(root,0o755);
  const repo=join(root,'original'),bare=join(root,'destination.git'),config=join(root,'worker.json');
  command('git',['init','-q','-b','agent-control-export',repo]);await mkdir(join(repo,'src'));await writeFile(join(repo,'src/file.txt'),'source\n');
  git(repo,'add','.');git(repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','source');
  const source=git(repo,'rev-parse','HEAD'),sourceTree=git(repo,'rev-parse','HEAD^{tree}');
  command('git',['clone','--bare','-q',repo,bare]);
  const projectId=randomUUID(),hostId=randomUUID(),credentialId=randomUUID(),principal='r3-delivery-'+randomUUID();
  command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,'controller')]);
  command('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,'host')]);
  await writeFile(join(root,'authorized_keys'),await readFile(join(root,'controller.pub')),{mode:0o600});
  await writeFile(config,JSON.stringify({projects:{[projectId]:bare},gitExportProjects:[projectId],gitReturnProjects:[projectId],gitReturnRefs:{[projectId]:['refs/heads/agent-control-export']}}));
  // Fixed installed RPC fixture invokes the production export and return helpers;
  // no request can choose a Python path or shell command.
  await writeFile(join(root,'rpc.py'),`import importlib.util,json,sys\nsys.stderr=open('${root}/rpc-errors','a')\nr=json.load(sys.stdin)\nc=json.load(open('${config}'))\np='/return_helper.py' if r['action']=='git-return' else '/helper.py'\ns=importlib.util.spec_from_file_location('rpc',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.return_artifact(c,r) if r['action']=='git-return' else m.export(c,r)))\n`);
  await writeFile(join(root,'sshd.conf'),`Port 2222\nListenAddress 0.0.0.0\nHostKey /fixtures/host\nPidFile /tmp/sshd.pid\nAuthorizedKeysFile /fixtures/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes yes\nAllowUsers node\nAllowTcpForwarding no\nAllowAgentForwarding no\nPermitTTY no\nForceCommand /usr/bin/python3 ${root}/rpc.py\nLogLevel ERROR\n`);
  command('docker',['run','-d','--name',name,'--label','ac.scope=ac-r3-delivery','-p','127.0.0.1::2222','-v',`${root}:${root}`,'-v',`${root}:/fixtures`,'-v',`${resolve('services/remote-git/helper.py')}:/helper.py:ro`,'-v',`${resolve('services/remote-git/return_helper.py')}:/return_helper.py:ro`,'ac-r3-remote-ssh:20261105','/usr/sbin/sshd','-D','-e','-f',join(root,'sshd.conf')]);container=true;
  const port=Number(command('docker',['port',name,'2222/tcp']).split(':').at(-1));
  const fingerprint=command('ssh-keygen',['-lf',join(root,'host.pub'),'-E','sha256']).split(/\s+/)[1];
  await db.migrate();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectId,'R3 disposable delivery']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectId,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const info={deviceId,expiresAt:Date.now()+120000};return {...info,signature:sign(null,Buffer.from(operatorMessage(principal,value,info,installation)),keys.privateKey).toString('hex')};};
  const contextId=await db.createContext(principal,projectId,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture',60);
  const quality={schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:false,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)};
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[projectId,quality,digest(quality)]);
  await new Templates(db).publish(principal,contextId,0,{workflow:'engineering-synthetic-v1',qualityRevision:1,targetRef:'refs/heads/agent-control-export'});
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'engineering-synthetic-v1',messageRef:'encrypted:r3-delivery'}},authority,'api');
  const ssh=new OpenSshTransport(async id=>{assert.equal(id,credentialId);return join(root,'controller');},new Set(['127.0.0.1']));
  const remote=new RemoteOperations(db,ssh);
  await remote.registerHost(principal,projectId,{id:hostId,label:'Disposable return host',hostname:'127.0.0.1',port,username:'node',publicKey:(await readFile(join(root,'host.pub'),'utf8')).trim(),fingerprint,credentialRef:credentialId,remoteRoot:bare,allowedTasks:['git-export','git-return'],maxConcurrent:2});
  const authorization={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'remote.source.authorize' as const,payload:{schemaVersion:1 as const,intentId:intent.id,hostId,commit:source,tree:sourceTree}};
  await new Control(db).execute(principal,authorization,proof(authorization));
  const operationId=randomUUID(),exported=await remote.exportGit(principal,{operationId,intentId:intent.id,contextId,hostId,commit:source,tree:sourceTree},authority);
  let calls=0,loseAck=true,firstRequest:Record<string,unknown>|undefined;
  const transport:RemoteTransport={async exchange(host,request){assert.equal(host.id,hostId);firstRequest??=request as Record<string,unknown>;calls++;const reply=await ssh.exchange(host,request);if(loseAck){loseAck=false;throw Error('SYNTHETIC_ACK_LOSS_AFTER_REMOTE_CAS');}return reply;}};
  const service=new ProjectAdmin(db,[{id:'fixture',label:'Disposable root',path:root}],join(root,'private'),{remoteSourceTmpfs:scratch,remoteReturnTransport:transport});
  const materialize={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.materializeRemoteSource',payload:{projectId,contextId,hostId,operationId,commit:source,tree:sourceTree,bundle:exported.bundle.toString('base64')}};
  await service.execute(principal,materialize,proof(materialize));
  const environments=new ProjectEnvironments(db,[{id:'fixture',path:root}],join(root,'private'));
  const environmentCommand={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure',payload:{projectId,expectedRevision:0,config:{sourceBranch:'refs/heads/agent-control-export',environments:[{id:'lab',label:'Disposable lab',targetRef:'refs/heads/agent-control-export',authorizedDirectories:['src'],destinations:[{id:'local',label:'Local repository',kind:'local_repository'},{id:'remote',label:'Disposable return',kind:'remote',hostId,allowedPurposes:['remote-return']}]}]}}};
  await environments.configure(principal,environmentCommand,proof(environmentCommand));
  const fixedScope={schemaVersion:1,source:'remote-fixed-task',hostId,taskId:'fixture',writePaths:['src/file.txt']};
  await db.pool.query('INSERT INTO ac_project_environment_write_scopes VALUES($1,$2,$3)',[intent.id,fixedScope,digest(fixedScope)]);
  await db.pool.query('INSERT INTO ac_execution_contracts VALUES($1,$2,1,$3,$4)',[intent.id,projectId,'refs/heads/agent-control-export',digest({qualityRevision:1,targetRef:'refs/heads/agent-control-export'})]);
  const local=join(root,'remote-sources',projectId);await writeFile(join(local,'src/file.txt'),'approved change\n');git(local,'add','.');git(local,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','approved');
  const commit=git(local,'rev-parse','HEAD'),tree=git(local,'rev-parse','HEAD^{tree}'),artifactId=randomUUID(),account=randomUUID(),profile=randomUUID(),grant=randomUUID();
  // Durable synthetic artifact/review/integration fixture. No model call or QA
  // execution is claimed: this test exercises the downstream authorization gate.

  await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)',[projectId,digest({schemaVersion:1}),{schemaVersion:1},principal]);
  await db.pool.query(`INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent) VALUES($1,$2,'fixture','fixture',$3,'synthetic','documented_supported','synthetic://r3-delivery',1)`,[account,principal,account]);
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture','medium','programmer')",[profile,account]);
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state) VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'released')`,[grant,randomUUID(),intent.id,contextId,authority.epoch,account,profile,projectId,digest(grant)]);
  await db.pool.query('INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,\'low\')',[artifactId,contextId,intent.id,grant,randomUUID(),projectId,commit,tree,source,digest({commit,tree,base:source})]);
  const returnCommand={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.returnRemoteArtifact',payload:{projectId,contextId,hostId,artifactId,destinationRef:'refs/heads/agent-control-export'}};
  await assert.rejects(service.execute(principal,returnCommand,proof(returnCommand)),/REMOTE_RETURN_APPROVED_ARTIFACT_REQUIRED/);assert.equal(calls,0);
  await db.pool.query("INSERT INTO ac_integration_intents VALUES($1,$2,$3,$4,$5,'integrated',$6,now())",[randomUUID(),artifactId,contextId,authority.epoch,returnCommand.payload.destinationRef,{status:'integrated',commit,tree}]);
  await assert.rejects(service.execute(principal,returnCommand,proof(returnCommand)),/REMOTE_RETURN_APPROVED_ARTIFACT_REQUIRED/);assert.equal(calls,0);
  await db.pool.query('INSERT INTO ac_integration_approvals VALUES($1,$2,$3,$4,1,now())',[artifactId,returnCommand.payload.destinationRef,principal,digest({commit,tree,base:source})]);
  const handler=createProjectAdminApi(service);
  const gateway=createProjectGateway({projects:{} as never,runtimes:{} as never,defaultProjectId:projectId,appFor:()=>{throw Error('unexpected runtime')},publicFetch:async()=>new Response('public'),authenticate:async request=>request.headers.get('x-test-principal'),projectAdmin:handler});
  const post=(value:Record<string,unknown>,valid=true)=>new Request('http://localhost/api/v1/ac/project-admin/remote-return',{method:'POST',headers:{'content-type':'application/json','x-test-principal':principal,'x-ac-operator-proof':Buffer.from(JSON.stringify(valid?proof(value):{...proof(value),signature:'0'.repeat(128)})).toString('base64url')},body:JSON.stringify(value)});
  assert.equal((await gateway(new Request('http://localhost/api/v1/ac/project-admin/remote-return',{method:'POST'}))).status,401);
  assert.equal((await gateway(post(returnCommand,false))).status,403);assert.equal(calls,0);
  const crossed={...returnCommand,intentId:randomUUID(),payload:{...returnCommand.payload,hostId:randomUUID()}};
  assert.equal((await gateway(post(crossed))).status,403);assert.equal(calls,0);
  const wrongRef={...returnCommand,intentId:randomUUID(),payload:{...returnCommand.payload,destinationRef:'refs/heads/other'}};
  assert.equal((await gateway(post(wrongRef))).status,403);assert.equal(calls,0);
  await assert.rejects(service.execute(principal,returnCommand,proof(returnCommand)),/SYNTHETIC_ACK_LOSS_AFTER_REMOTE_CAS/);assert.equal(calls,1);
  assert.equal(git(bare,'rev-parse','refs/heads/agent-control-export'),commit);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_artifact_returns')).rows[0].n,0);
  // A third-party change after lost ACK must survive replay/recovery.
  await writeFile(join(repo,'third.txt'),'concurrent\n');git(repo,'add','.');git(repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','concurrent');
  const concurrent=git(repo,'rev-parse','HEAD');git(bare,'fetch',repo,`${concurrent}:refs/heads/other`);git(bare,'update-ref','refs/heads/agent-control-export',concurrent,commit);
  const recovered=await gateway(post({...returnCommand,deliveryAttemptId:randomUUID()}));assert.equal(recovered.status,200);const receipt=await recovered.json();assert.equal(receipt.commit,commit);assert.equal(receipt.tree,tree);assert.equal(calls,2);
  assert.equal(git(bare,'rev-parse','refs/heads/agent-control-export'),concurrent);
  const replay=await gateway(post({...returnCommand,deliveryAttemptId:randomUUID()}));assert.equal(replay.status,200);assert.equal(calls,2);
  const conflict={...returnCommand,intentId:randomUUID(),deliveryAttemptId:randomUUID()};assert.equal((await gateway(post(conflict))).status,409);assert.equal(git(bare,'rev-parse','refs/heads/agent-control-export'),concurrent);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_remote_artifact_returns')).rows[0].n,1);
  const registered=(await db.pool.query('SELECT * FROM ac_remote_hosts WHERE id=$1',[hostId])).rows[0];
  assert(firstRequest);
  for(const mutation of [{artifactId:randomUUID()},{destinationRef:'refs/heads/forbidden'},{bundleSha256:'0'.repeat(64)},{tree:'0'.repeat(40)},{projectId:randomUUID()}]){
   await assert.rejects(ssh.exchange(registered,{...firstRequest,...mutation}),/REMOTE_TRANSPORT_UNCERTAIN/);
   assert.equal(git(bare,'rev-parse','refs/heads/agent-control-export'),concurrent);
  }
  await assert.rejects(db.pool.query('UPDATE ac_remote_artifact_returns SET principal_id=$1',[principal+'-changed']),/IMMUTABLE|immutable/);
  git(bare,'fsck','--strict');assert.equal(git(bare,'rev-parse',commit+'^{tree}'),tree);
  assert.equal(git(bare,'show',commit+':src/file.txt'),'approved change');assert.equal(git(bare,'show',source+':src/file.txt'),'source');
  console.log(JSON.stringify({proof:'r3-delivery-ssh',source,commit,tree,concurrent,sshCalls:calls,returnReceipts:1,scope:'disposable synthetic artifact; real Git/SSH/PG and signatures'}));
 }finally{
  const failures:unknown[]=[];
  const cleanup=async(fn:()=>unknown|Promise<unknown>)=>{try{await fn();}catch(error){failures.push(error);}};
  if(container)await cleanup(()=>command('docker',['rm','-f',name]));
  await cleanup(()=>db.close());await cleanup(()=>isolated.close());
  await cleanup(()=>rm(root,{recursive:true,force:true}));
  if(mounted)await cleanup(()=>command('sudo',['-n','umount',scratch]));
  // A failed unmount is never followed by recursive deletion of a mount.
  if(!mounted||!failures.length)await cleanup(()=>rm(scratch,{recursive:true,force:true}));
  if(failures.length)throw new AggregateError(failures,'R3_DELIVERY_CLEANUP_FAILED');
 }
});
