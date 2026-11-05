import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,symlink,unlink,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Projects} from '../src/projects.ts';
import {ProjectEnvironments,requireProjectEnvironmentLaunch,requireProjectEnvironment,type ProjectEnvironmentConfig} from '../src/project-environments.ts';
import {createProjectEnvironmentApi} from '../src/project-environments-api.ts';
import {digest} from '../src/contracts.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('signed immutable project environments enforce real Git source, directories, admission and destination scope',async()=>{
 const url=process.env.AC_R3_ENVIRONMENTS_DATABASE_URL;if(!url?.endsWith('/ac_r3_environments'))throw Error('DISPOSABLE_R3_ENVIRONMENTS_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const root=await mkdtemp('/tmp/ac-r3-environments-');
 const principal='environments-'+randomUUID(),keys=generateKeyPairSync('ed25519'),deviceId=randomUUID();
 const git=(repo:string,...args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',repo,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
 try{
  const definitions=[];for(let i=0;i<2;i++){
   const repo=join(root,'project-'+i);await mkdir(repo,{mode:0o700});await mkdir(join(repo,'src'),{mode:0o700});await mkdir(join(repo,'tests'),{mode:0o700});await writeFile(join(repo,'src','a.txt'),'original');await writeFile(join(repo,'tests','a.txt'),'test');git(repo,'init','-b','main');await chmod(join(repo,'.git'),0o700);git(repo,'add','.');git(repo,'commit','-m','fixture');git(repo,'branch','protected');definitions.push({id:randomUUID(),label:'Project '+i,repo,owner:principal});
  }
  await mkdir(join(root,'private'),{mode:0o700});await new Projects(db).register(definitions,principal);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton')).rows[0].id;
  const proof=(command:Record<string,unknown>)=>{const p={deviceId,expiresAt:Date.now()+120000};return {...p,signature:sign(null,Buffer.from(operatorMessage(principal,command,p,installation)),keys.privateKey).toString('hex')};};
  const service=new ProjectEnvironments(db,[{id:'lab',path:root}],join(root,'private')),api=createProjectEnvironmentApi(service);
  const hostIds=[randomUUID(),randomUUID()];for(let index=0;index<2;index++)await db.pool.query(`INSERT INTO ac_remote_hosts(id,project_id,label,hostname,port,username,public_key,fingerprint,credential_ref,remote_root,allowed_tasks,max_concurrent,registration_digest) VALUES($1,$2,$3,'disposable.invalid',22,'fixture','fixture-key','fixture-fingerprint',$4,'/fixture',ARRAY['git-workspace','git-return'],1,'fixture-registration')`,[hostIds[index],definitions[index].id,'Remote lab '+index,randomUUID()]);
  const config:ProjectEnvironmentConfig={sourceBranch:'refs/heads/main',environments:[{id:'lab',label:'Lab',targetRef:'refs/heads/protected',authorizedDirectories:['src','tests'],destinations:[{id:'local',label:'Local repository',kind:'local_repository'},{id:'remote',label:'Remote lab',kind:'remote',hostId:hostIds[0],allowedPurposes:['remote-development','remote-return']}]}]};
  const secondConfig:ProjectEnvironmentConfig={...config,environments:[{...config.environments[0],destinations:[{id:'local',label:'Local repository',kind:'local_repository'},{id:'remote',label:'Remote lab 1',kind:'remote',hostId:hostIds[1],allowedPurposes:['remote-return']}]}]};
  const command=(projectId:string,expectedRevision=0,snapshot=config)=>({schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.environments.configure' as const,payload:{projectId,expectedRevision,config:snapshot}});
  const post=(value:ReturnType<typeof command>,auth=principal,p=proof(value))=>api(new Request('http://lab/api/v1/ac/project-admin/environments',{method:'POST',headers:{'Content-Type':'application/json','x-ac-operator-proof':Buffer.from(JSON.stringify(p)).toString('base64url')},body:JSON.stringify(value)}),auth);
  const first=command(definitions[0].id);assert.equal((await post(first,'stranger')).status,403);assert.equal((await post(first,'')).status,401);
  assert.equal((await post(first,principal,{...proof(first),signature:'0'.repeat(128)})).status,403);
  const saved=await post(first);if(saved.status!==200)await service.configure(principal,first,proof(first));assert.equal(saved.status,200);assert.equal((await saved.json()).revision,1);
  const replay=await post({...first,deliveryAttemptId:randomUUID()});assert.equal(replay.status,200);assert.equal((await replay.json()).revision,1);
  const conflict=await post({...first,payload:{...first.payload,config:{...config,sourceBranch:'refs/heads/protected'}}});assert.equal(conflict.status,409);
  assert.equal((await post(command(definitions[0].id))).status,409);
  assert.equal((await post(command(definitions[1].id,0,secondConfig))).status,200,'one central config API administers a second project');
  const view=await api(new Request('http://lab/api/v1/ac/project-admin/environments?projectId='+definitions[0].id),principal),body=await view.json();assert.equal(body.revision,1);assert.equal(body.canConfigure,true);assert(!JSON.stringify(body).includes(root));assert.deepEqual(body.remoteHosts,[{id:hostIds[0],label:'Remote lab 0',allowedPurposes:['remote-development','remote-return']}]);assert(!JSON.stringify(body).includes('fixture-fingerprint'));
  const encodedProof=Buffer.from(JSON.stringify(proof(first))).toString('base64url');
  const large=new Request('http://lab/api/v1/ac/project-admin/environments',{method:'POST',headers:{'Content-Type':'application/json','x-ac-operator-proof':encodedProof},body:'x'.repeat(16385)});assert.equal((await api(large,principal)).status,413);
  let canceled=false;const slowBody=new ReadableStream<Uint8Array>({start(){},cancel(){canceled=true;}});
  const slow=new Request('http://lab/api/v1/ac/project-admin/environments',{method:'POST',headers:{'Content-Type':'application/json','x-ac-operator-proof':encodedProof},body:slowBody,duplex:'half'} as RequestInit);
  assert.equal((await createProjectEnvironmentApi(service,{bodyTimeoutMs:10})(slow,principal)).status,408);assert.equal(canceled,true);
  const badBranch=command(definitions[1].id,1,{...config,sourceBranch:'refs/heads/missing'});assert.equal((await post(badBranch)).status,409);
  const traversal=command(definitions[1].id,1,{...config,environments:[{...config.environments[0],authorizedDirectories:['../private']}]});assert.equal((await post(traversal)).status,400);
  const external=join(root,'external');await mkdir(external,{mode:0o700});await symlink(external,join(definitions[1].repo,'escape'));
  const escaped=command(definitions[1].id,1,{...config,environments:[{...config.environments[0],authorizedDirectories:['escape']}]});assert.equal((await post(escaped)).status,403);
  await assert.rejects(db.pool.query("UPDATE ac_project_environment_revisions SET published_by='changed' WHERE project_id=$1",[definitions[0].id]),/POLICY_REVISION_IMMUTABLE/);

  const project=definitions[0],context=await db.createContext(principal,project.id,randomUUID()),capacity=await provisionCapacity(db,principal,project.id);
  const profile=(await db.pool.query('SELECT p.* FROM ac_profiles p JOIN ac_account_access a ON a.account_id=p.account_id WHERE a.project_id=$1',[project.id])).rows[0];
  await db.pool.query("INSERT INTO ac_quality_policies(project_id,revision,snapshot,digest) VALUES($1,1,'{}','fixture')",[project.id]);
  const intent=async(paths:string[],parentId?:string)=>{
   const id=randomUUID();await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id) VALUES($1,$2,$3,'fixture',$4,$5,$6,1,0,$7,$8)`,[id,context,principal,{payload:{writePaths:paths}},randomUUID(),randomUUID(),parentId??null,parentId?'unit-'+id:null]);return id;
  };
  const contract=async(id:string,target='refs/heads/protected')=>db.pool.query('INSERT INTO ac_execution_contracts VALUES($1,$2,1,$3,$4)',[id,project.id,target,digest({qualityRevision:1,targetRef:target})]);
  const bad=await intent(['outside/a.txt']);await assert.rejects(contract(bad),/PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN/);
  const traversalIntent=await intent(['src/../../private/a']);await assert.rejects(contract(traversalIntent),/PROJECT_ENVIRONMENT_DIRECTORY_FORBIDDEN/);
  const wrongTarget=await intent(['src/a.txt']);await assert.rejects(contract(wrongTarget,'refs/heads/main'),/PROJECT_ENVIRONMENT_TARGET_FORBIDDEN/);
  const parent=await intent([]),child=await intent(['src/a.txt'],parent);await contract(child);
  const pin=(await db.pool.query('SELECT * FROM ac_project_environment_bindings WHERE intent_id=$1',[child])).rows[0];assert.equal(pin.revision,1);assert.equal(pin.environment_id,'lab');
  assert.equal((await db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,intentId:child,hostId:hostIds[0],destinationRef:'refs/heads/protected',purpose:'remote-development'}))).environmentId,'lab');
  await assert.rejects(db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,intentId:wrongTarget,hostId:hostIds[0],purpose:'remote-development'})),/PROJECT_ENVIRONMENT_BINDING_REQUIRED/);
  await assert.rejects(db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,intentId:child,hostId:hostIds[0],destinationRef:'refs/heads/main',purpose:'remote-development'})),/PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN/);
  const original=git(project.repo,'rev-parse','refs/heads/main');
  await assert.rejects(db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:'f'.repeat(40)})),/PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH/);
  const source=await db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:original}));assert.equal(source!.sourceCommit,original);
  // Publication takes project then head locks. Effects must wait on project
  // before taking head; taking head first creates a publication/admission cycle.
  for(const gate of [
   (c:import('pg').PoolClient)=>requireProjectEnvironmentLaunch(c,{intentId:child,base:original}),
   (c:import('pg').PoolClient)=>requireProjectEnvironment(c,{projectId:project.id,intentId:child,hostId:hostIds[0],purpose:'remote-development'}),
  ]){
   const publisher=await db.pool.connect(),effect=await db.pool.connect();let pending:Promise<unknown>|undefined;
   try{
    await publisher.query('BEGIN');await effect.query('BEGIN');await effect.query("SET LOCAL statement_timeout='3s'");
    await publisher.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[project.id]);
    const pid=(await effect.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending=gate(effect);let blocked=false;
    for(let attempt=0;attempt<100;attempt++){
     blocked=(await publisher.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;
     if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert(blocked,'effect reached project publication lock');
    await publisher.query('SELECT project_id FROM ac_project_environment_heads WHERE project_id=$1 FOR UPDATE NOWAIT',[project.id]);
    await publisher.query('COMMIT');await pending;await effect.query('COMMIT');
   }finally{
    await publisher.query('ROLLBACK');await pending?.catch(()=>{});await effect.query('ROLLBACK');publisher.release();effect.release();
   }
  }
  // Branch movement cannot silently repin the accepted parent plan.
  await writeFile(join(project.repo,'src','a.txt'),'later');git(project.repo,'add','.');git(project.repo,'commit','-m','later');const later=git(project.repo,'rev-parse','HEAD');
  assert.equal((await db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:original})))!.sourceCommit,original);
  await assert.rejects(db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:later})),/PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH/);
  assert.equal((await post(command(project.id,1))).status,409,'unsettled immutable attempt blocks policy replacement');
  await rename(join(project.repo,'src'),join(project.repo,'src-old'));await symlink(external,join(project.repo,'src'));
  await assert.rejects(db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:original})),/PROJECT_ENVIRONMENT_FILESYSTEM_CHANGED/);
  await unlink(join(project.repo,'src'));await rename(join(project.repo,'src-old'),join(project.repo,'src'));
  const grantId=randomUUID();await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state) VALUES($1,$2,$3,$4,1,$5,$6,'programmer',$7,$8,1,'fixture',false,'reserved')`,[grantId,randomUUID(),child,context,profile.account_id,profile.id,project.id,capacity.revision]);
  await assert.rejects(db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state) VALUES($1,$2,$3,$4,1,$5,$6,'programmer',$7,$8,1,'fixture',false,'reserved')`,[randomUUID(),randomUUID(),bad,context,profile.account_id,profile.id,project.id,capacity.revision]),/PROJECT_ENVIRONMENT_BINDING_REQUIRED/);
  // Derived bases require registered immutable composition provenance, not
  // merely a descendant of the source branch. Git commits here are real; the
  // artifact/operation records are synthetic controller ledger fixtures.
  const composition=await intent([],parent),alteredComposition=await intent([],parent),gamma=await intent(['src/a.txt'],parent),badGamma=await intent(['src/a.txt'],parent),corrected=await intent(['src/a.txt'],parent),correctionComposition=await intent([],parent),correctionGamma=await intent(['src/a.txt'],parent);
  for(const id of [composition,alteredComposition,gamma,badGamma,corrected,correctionComposition,correctionGamma])await contract(id);
  git(project.repo,'checkout','-b','composed',original);await writeFile(join(project.repo,'src','a.txt'),'later');git(project.repo,'add','.');git(project.repo,'commit','-m','composition');const composed=git(project.repo,'rev-parse','HEAD');
  git(project.repo,'checkout','-b','altered-composed',original);await writeFile(join(project.repo,'src','a.txt'),'altered');git(project.repo,'add','.');git(project.repo,'commit','-m','altered composition');const altered=git(project.repo,'rev-parse','HEAD');
  const units=await db.pool.query('SELECT id,parent_unit_id FROM ac_intents WHERE id=ANY($1::uuid[])',[[child,composition,alteredComposition,gamma,badGamma,corrected,correctionComposition,correctionGamma]]);
  const unitId=(id:string)=>units.rows.find(row=>row.id===id).parent_unit_id as string;
  const recipe={schemaVersion:2,units:[{id:unitId(child),intentId:child,kind:'task',taskId:'alpha'},{id:unitId(corrected),intentId:corrected,kind:'task',taskId:'alpha',correctionRevision:1},{id:unitId(correctionComposition),intentId:correctionComposition,kind:'composition',sources:[unitId(child)]},{id:unitId(composition),intentId:composition,kind:'composition',sources:[unitId(child)]},{id:unitId(alteredComposition),intentId:alteredComposition,kind:'composition',sources:[unitId(child)]}]};
  await db.pool.query(`INSERT INTO ac_manager_plans(context_id,revision,manager_epoch,manager_instance_id,principal_id,digest,snapshot,compilation_digest,compilation) VALUES($1,1,1,$2,$3,$4,'{}',$4,'{}')`,[context,randomUUID(),principal,digest({})]);
  await db.pool.query('INSERT INTO ac_managed_executions VALUES($1,$2,1,$3,$4,$5)',[parent,context,digest({}),digest(recipe),recipe]);
  const artifact=async(id:string,commit:string,base:string)=>{
   const artifactId=randomUUID(),tree=git(project.repo,'rev-parse',commit+'^{tree}');
   await db.pool.query(`INSERT INTO ac_artifacts(id,context_id,intent_id,implementation_grant_id,implementation_session_id,project_id,policy_revision,commit_id,tree_id,base_id,identity_digest,risk) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'fixture','low')`,[artifactId,context,id,grantId,randomUUID(),project.id,commit,tree,base]);return {artifactId,commit,tree,base};
  };
  const sourceArtifact=await artifact(child,later,original);
  for(const [id,commit,corrupt] of [[composition,composed,false],[alteredComposition,altered,true]] as const){
   const input={parentIntentId:parent,unitId:unitId(id),kind:'composition',base:original,writePaths:[],acceptanceRefs:[],sources:[unitId(child)]};
   await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[id,original,input,digest(input)]);
   const sources=[{unitId:unitId(child),...sourceArtifact,...(corrupt?{tree:'f'.repeat(40)}:{})}];await db.pool.query('INSERT INTO ac_managed_composition_sources VALUES($1,$2,$3)',[id,JSON.stringify(sources),digest(sources)]);
   const composedArtifact=await artifact(id,commit,original),operation=(await db.pool.query('SELECT operation_id FROM ac_intents WHERE id=$1',[id])).rows[0].operation_id;
   await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch,receipt) VALUES($1,$2,'completed',1,$3)",[operation,id,{operationId:operation,commit,base:original,tree:composedArtifact.tree,exitCode:0,synthetic:true}]);
  }
  for(const [id,base] of [[gamma,composed],[badGamma,altered]]){const input={parentIntentId:parent,unitId:unitId(id),kind:'task',base,writePaths:['src/a.txt'],acceptanceRefs:[],sources:[]};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[id,base,input,digest(input)]);}
  git(project.repo,'checkout','-b','corrected',original);await writeFile(join(project.repo,'src','a.txt'),'corrected');git(project.repo,'add','.');git(project.repo,'commit','-m','corrected task');const correctedCommit=git(project.repo,'rev-parse','HEAD');
  git(project.repo,'checkout','-b','correction-composition',original);await writeFile(join(project.repo,'src','a.txt'),'corrected');git(project.repo,'add','.');git(project.repo,'commit','-m','correction composition');const correctedComposed=git(project.repo,'rev-parse','HEAD');
  const correctedArtifact=await artifact(corrected,correctedCommit,original);
  await db.pool.query(`INSERT INTO ac_managed_correction_decisions(parent_intent_id,context_id,task_id,revision,prior_intent_id,prior_artifact_id,failed_evidence_ids,prior_commit,prior_tree,base_id,next_intent_id,manager_epoch,decision_digest) VALUES($1,$2,'alpha',1,$3,$4,$5,$6,$7,$8,$9,1,$10)`,[parent,context,child,sourceArtifact.artifactId,[randomUUID()],sourceArtifact.commit,sourceArtifact.tree,original,corrected,'c'.repeat(64)]);
  const selection={parentIntentId:parent,contextId:context,taskId:'alpha',selectedIntentId:corrected,artifactId:correctedArtifact.artifactId,managerEpoch:1};
  await db.pool.query('INSERT INTO ac_managed_task_selections VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp())',[parent,context,'alpha',corrected,correctedArtifact.artifactId,digest(selection)]);
  const correctionInput={parentIntentId:parent,unitId:unitId(correctionComposition),kind:'composition',base:original,writePaths:[],acceptanceRefs:[],sources:[unitId(corrected)]};
  await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[correctionComposition,original,correctionInput,digest(correctionInput)]);
  const correctedSources=[{unitId:unitId(corrected),...correctedArtifact}];await db.pool.query('INSERT INTO ac_managed_composition_sources VALUES($1,$2,$3)',[correctionComposition,JSON.stringify(correctedSources),digest(correctedSources)]);
  const correctionArtifact=await artifact(correctionComposition,correctedComposed,original),correctionOperation=(await db.pool.query('SELECT operation_id FROM ac_intents WHERE id=$1',[correctionComposition])).rows[0].operation_id;
  await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch,receipt) VALUES($1,$2,'completed',1,$3)",[correctionOperation,correctionComposition,{operationId:correctionOperation,commit:correctedComposed,base:original,tree:correctionArtifact.tree,exitCode:0,synthetic:true}]);
  const gammaInput={parentIntentId:parent,unitId:unitId(correctionGamma),kind:'task',base:correctedComposed,writePaths:['src/a.txt'],acceptanceRefs:[],sources:[]};await db.pool.query('INSERT INTO ac_managed_delivery_inputs VALUES($1,$2,$3,$4)',[correctionGamma,correctedComposed,gammaInput,digest(gammaInput)]);
  assert.equal((await db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:correctionGamma,base:correctedComposed})))!.sourceCommit,original,'selected correction unit maps to frozen logical task and original source');
  const derived=await db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:gamma,base:composed}));assert.equal(derived!.sourceCommit,original);assert.equal(derived!.base,composed);
  await assert.rejects(db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:badGamma,base:altered})),/PROJECT_ENVIRONMENT_SOURCE_BASE_MISMATCH/,'altered registered source provenance is refused');
  await assert.rejects(db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,hostId:randomUUID(),destinationRef:'refs/heads/protected',purpose:'remote-return'})),/PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN/);
  assert.equal((await db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,hostId:hostIds[0],destinationRef:'refs/heads/protected',purpose:'remote-return'}))).environmentId,'lab');
  await assert.rejects(db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,contextId:context,hostId:hostIds[1],destinationRef:'refs/heads/protected',purpose:'remote-return'})),/PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN/);
  await db.pool.query("UPDATE ac_remote_hosts SET fingerprint='altered' WHERE id=$1",[hostIds[0]]);
  await assert.rejects(db.tx(c=>requireProjectEnvironment(c,{projectId:project.id,hostId:hostIds[0],purpose:'remote-return'})),/PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN/);
  await db.pool.query("UPDATE ac_remote_hosts SET fingerprint='fixture-fingerprint' WHERE id=$1",[hostIds[0]]);
  await assert.rejects(db.pool.query("INSERT INTO ac_integration_intents VALUES($1,$2,$3,1,'refs/heads/main','registered',NULL)",[randomUUID(),sourceArtifact.artifactId,context]),/PROJECT_ENVIRONMENT_TARGET_FORBIDDEN/);
  const integrationId=randomUUID();await db.pool.query("INSERT INTO ac_integration_intents VALUES($1,$2,$3,1,'refs/heads/protected','registered',NULL)",[integrationId,sourceArtifact.artifactId,context]);await db.pool.query("UPDATE ac_integration_intents SET state='integrated' WHERE id=$1",[integrationId]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='released' WHERE id=$1",[grantId]);
  await db.pool.query("UPDATE ac_intents SET state='canceled' WHERE context_id=$1",[context]);
  const remoteOnly={...config,environments:[{...config.environments[0],destinations:config.environments[0].destinations.filter(d=>d.kind==='remote')}]};
  assert.equal((await post(command(project.id,1,remoteOnly))).status,200);
  await assert.rejects(db.tx(c=>requireProjectEnvironmentLaunch(c,{intentId:child,base:original})),/PROJECT_ENVIRONMENT_BINDING_REQUIRED/,'new effects cannot use a stale environment revision');
  const newIntent=await intent(['src/a.txt']);await contract(newIntent);const remoteOnlyArtifact=await artifact(newIntent,later,original);
  await assert.rejects(db.pool.query("INSERT INTO ac_integration_intents VALUES($1,$2,$3,1,'refs/heads/protected','registered',NULL)",[randomUUID(),remoteOnlyArtifact.artifactId,context]),/PROJECT_ENVIRONMENT_DESTINATION_FORBIDDEN/);
  assert.equal((await db.pool.query('SELECT state FROM ac_integration_intents WHERE id=$1',[integrationId])).rows[0].state,'integrated','old terminal journal remains readable after configuration changes');
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
