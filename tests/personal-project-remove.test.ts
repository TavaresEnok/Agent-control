import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {Capacity} from '../src/capacity.ts';
import {digest,Refusal} from '../src/contracts.ts';
import {loadInstallation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {runPersonalArtifactRetention,type CommandResult} from '../src/personal-artifact-retention.ts';
import {PROJECT_LABEL,personalProjectRemoveFailureText,removePersonalProject,runPersonalProjectRemoveCli} from '../src/personal-project-remove.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const url=process.env.AC_TEST_DATABASE_URL;
const exists=(path:string)=>lstat(path).then(()=>true,()=>false);

/** Docker as a recorded fake: one daemon, labelled containers, volumes and images per project; `running` and `imageOf` say
 * which containers run and which image each one was created from. */
type Labelled={containers:string[];volumes:string[];images:string[]};
function fakeDocker(byProject:Record<string,Labelled>,registryImages:string[]){
 const calls:string[][]=[];
 const images=new Set([...registryImages,...Object.values(byProject).flatMap(item=>item.images)]);
 const containers=new Set(Object.values(byProject).flatMap(item=>item.containers));
 const volumes=new Set(Object.values(byProject).flatMap(item=>item.volumes));
 const running=new Set<string>(),imageOf=new Map<string,string>();
 const zero='sha256:'+'0'.repeat(64);
 const ok=(stdout='')=>({code:0,stdout}) as CommandResult;
 const docker=async(args:string[]):Promise<CommandResult>=>{
  calls.push(args);
  const joined=args.join(' ');
  const label=args.find(item=>item.startsWith(`label=${PROJECT_LABEL}=`))?.split('=').at(-1);
  const of=label?byProject[label]:undefined;
  const lines=(items:string[])=>ok(items.map(item=>item+'\n').join(''));
  if(joined==='info --format {{.ID}}')return ok('daemon-1\n');
  if(joined.startsWith('info'))return {code:1,stdout:''};
  if(args[0]==='container'&&args[1]==='ls'){
   if(label)return lines((of?.containers??[]).filter(item=>containers.has(item)));
   const ancestor=args.find(item=>item.startsWith('ancestor='))?.slice('ancestor='.length);
   if(ancestor)return lines([...containers].filter(item=>imageOf.get(item)===ancestor));
   return lines([...containers]);
  }
  if(args[0]==='container'&&args[1]==='inspect'){
   const ids=args.slice(4);
   if(joined.includes('.State.Running'))return lines(ids.map(id=>String(running.has(id))));
   if(joined.includes('.Mounts'))return ok('');
   if(joined.includes('.Image'))return lines(ids.map(id=>imageOf.get(id)??zero));
  }
  if(args[0]==='container'&&args[1]==='rm'){containers.delete(args[2]!);return ok();}
  if(args[0]==='volume'&&args[1]==='ls')return lines((of?.volumes??[]).filter(item=>volumes.has(item)));
  if(args[0]==='volume'&&args[1]==='rm'){volumes.delete(args[2]!);return ok();}
  if(args[0]==='image'&&args[1]==='ls'){
   if(label)return lines((of?.images??[]).filter(item=>images.has(item)));
   return lines([...images]);
  }
  if(args[0]==='image'&&args[1]==='inspect'){
   const id=args.at(-1)!;
   if(!images.has(id))return {code:1,stdout:'',stderr:'Error: No such image: '+id};
   if(joined.includes('{{.Id}}'))return ok(id+'\n');
   if(joined.includes('RepoDigests'))return ok('[]\n');
   return ok(JSON.stringify([{Id:id,RepoTags:['ac-candidate:'+id.slice(7,15)],RepoDigests:[],Size:1000}]));
  }
  if(args[0]==='image'&&args[1]==='rm'){images.delete(args[2]!);return ok();}
  return {code:1,stdout:'',stderr:'unexpected '+joined};
 };
 return {docker,calls,images,containers,volumes,running,imageOf};
}

test('removing a project: preview changes nothing, active work refuses, only the chosen project goes and its repository stays',{skip:!url,timeout:180000},async()=>{
 const database=await isolatedDatabase(url!,'projrm');
 const area=await realpath(await mkdtemp(join(tmpdir(),'ac-proj-rm-')));
 const ledger=new Ledger(database.url);
 try{
  await ledger.migrate();
  const data=join(area,'data'),hostRoot=join(data,'native','execution-host'),file=join(data,'installation.json');
  await mkdir(hostRoot,{recursive:true,mode:0o700});
  for(const path of [data,join(data,'native'),hostRoot])await chmod(path,0o700);
  const owner='owner@example.com';
  const gitRepo=(path:string)=>{
   execFileSync('git',['init','-q','-b','main',path],{stdio:'ignore'});
   execFileSync('git',['-C',path,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','base'],{stdio:'ignore'});
   return execFileSync('git',['-C',path,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  };
  const names=['primary','removed','other','dbonly'] as const;
  const projects:Record<string,{id:string;repo:string;head:string;context:string;jobs:string[];grants:string[]}>={};
  const authorities:Record<string,Awaited<ReturnType<Ledger['acquire']>>>={};
  const account=randomUUID(),profile=randomUUID();
  for(const name of names){
   const id=randomUUID(),repo=join(area,'repos',name);
   await mkdir(repo,{recursive:true,mode:0o700});
   projects[name]={id,repo,head:gitRepo(repo),context:'',jobs:[],grants:[]};
   await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[id,name]);
   await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[id,owner]);
   await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[id,repo]);
   await ledger.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[id,'b'.repeat(64),owner]);
  }
  await new Capacity(ledger).addAccount(owner,projects.primary!.id,{id:account,provider:'codex',label:'shared',resourceIdentity:'codex:'+'a'.repeat(64),mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:8});
  await ledger.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  for(const name of names){
   const p=projects[name]!;
   await ledger.pool.query('INSERT INTO ac_account_access VALUES($1,$2) ON CONFLICT DO NOTHING',[account,p.id]);
   p.context=await ledger.createContext(owner,p.id,randomUUID());
   const authority=await ledger.acquire(owner,p.context,randomUUID(),'fixture-manager',60);
   authorities[name]=authority;
   for(let index=0;index<2;index++){
    const intent=await ledger.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:p.context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
    const grant=randomUUID(),job=intent.operation_id as string,active=name==='removed'&&index===0?'running':undefined;
    await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,$10)`,[grant,randomUUID(),intent.id,p.context,authority.epoch,account,profile,p.id,digest({grant}),active??'released']);
    const input=NativeExecutionRequest.parse({jobId:job,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
    await ledger.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer',$14)`,
     [job,grant,intent.id,p.context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),'1'.repeat(64),'2'.repeat(64),digest(input),input.base,active??'completed']);
    p.jobs.push(job);p.grants.push(grant);
    await mkdir(join(hostRoot,job,'output'),{recursive:true,mode:0o700});
    await writeFile(join(hostRoot,job,'output','result.json'),'{"ok":true}\n'+'x'.repeat(5000),{mode:0o600});
   }
  }
  // Private data of the projects, and a shared detached checkout of each secondary repository.
  for(const name of ['removed','other'] as const){
   const p=projects[name]!;
   for(const path of [join(data,'qa-cache',p.id),join(data,'verificacoes',p.id)]){await mkdir(path,{recursive:true,mode:0o700});await writeFile(join(path,'report.md'),'# report\n');}
   const shared=join(data,'native','shared-worktrees',createHash('sha256').update(p.repo).digest('hex')+'-'+p.head);
   await mkdir(join(data,'native','shared-worktrees'),{recursive:true,mode:0o700});
   execFileSync('git',['-C',p.repo,'worktree','add','--quiet','--detach','--',shared,p.head],{stdio:'ignore'});
  }
  // Registry: one candidate image and one round of the removed project, one image of the other project.
  const image=(seed:string)=>'sha256:'+createHash('sha256').update(seed).digest('hex');
  // pinnedImage is a candidate of the removed project that an exam of the other project still uses.
  const removedImage=image('removed-registry'),otherImage=image('other-registry'),pinnedImage=image('removed-registry-pinned');
  const registryDir=join(data,'artifact-retention');await mkdir(registryDir,{mode:0o700});
  const old=Date.now()-60_000;
  await writeFile(join(registryDir,'registry.json'),JSON.stringify({schemaVersion:1,worktrees:[],temps:[],history:[],
   images:[{id:randomUUID(),projectId:projects.removed!.id,module:'qa',imageId:removedImage,daemonId:'daemon-1',registeredAt:old},
    {id:randomUUID(),projectId:projects.removed!.id,module:'qa',imageId:pinnedImage,daemonId:'daemon-1',registeredAt:old},
    {id:randomUUID(),projectId:projects.other!.id,module:'qa',imageId:otherImage,daemonId:'daemon-1',registeredAt:old}],
   rounds:[{projectId:projects.removed!.id,roundId:'round-1',endedAt:old},{projectId:projects.other!.id,roundId:'round-2',endedAt:old}]})+'\n',{mode:0o600});
  // Exams: the other project's run still uses pinnedImage; the removed project's own run of removedImage no longer pins it.
  const verifyRun=async(name:string,collector:string|null,status='done')=>{
   const p=projects[name]!;
   const intent=await ledger.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:p.context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authorities[name]!,'api');
   const id=randomUUID();
   await ledger.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir,collector_image)
    VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,[id,p.id,p.context,intent.id,owner,p.head,status,collector]);
   return id;
  };
  await verifyRun('other',pinnedImage);
  await verifyRun('removed',removedImage);
  const labelled=(name:string)=>({container:createHash('sha256').update('c'+name).digest('hex'),volume:'ac-vol-'+name,image:image('label-'+name)});
  const asLists=(item:{container:string;volume:string;image:string})=>({containers:[item.container],volumes:[item.volume],images:[item.image]});
  // The removed project also has a running labelled container, an image that container uses and two images pinned by the product.
  const runningContainer=createHash('sha256').update('c-removed-running').digest('hex');
  const usedImage=image('label-removed-used'),moduleImage=image('label-removed-module'),designImage=image('label-removed-design');
  const removedLabels=asLists(labelled('removed'));
  removedLabels.containers.push(runningContainer);
  removedLabels.images.push(usedImage,moduleImage,designImage);
  const fake=fakeDocker({[projects.removed!.id]:removedLabels,[projects.other!.id]:asLists(labelled('other')),[projects.primary!.id]:asLists(labelled('primary')),[projects.dbonly!.id]:asLists(labelled('dbonly'))},[removedImage,otherImage,pinnedImage]);
  fake.running.add(runningContainer);
  fake.imageOf.set(runningContainer,usedImage);
  const product=join(area,'product');
  const modulePin=join(product,'deploy','modules','qa','digest.txt'),designPin=join(product,'deploy','design-image-digest.txt');
  await mkdir(dirname(modulePin),{recursive:true});
  await writeFile(modulePin,moduleImage+'\n');
  await writeFile(designPin,designImage+'\n');
  // verifyRunImages is not stubbed: the exam pins come from ac_verify_runs in the test database.
  const deps={docker:fake.docker,sharedRefsRoot:join(area,'refs'),productRoot:product,tmpRoot:join(area,'tmp'),
   processPaths:async()=>[],processInside:async()=>false,mountInfo:async()=>'22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n'};
  await mkdir(join(area,'tmp'));

  const entry=(name:string)=>({id:projects[name]!.id,label:name,repo:projects[name]!.repo,owner});
  await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:database.url,dataDirectory:data,
   project:entry('primary'),projects:[entry('removed'),entry('other')],
   http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
   contextVault:{directory:join(data,'vault'),masterFile:join(data,'vault-master')},
   managerTransport:{principal:'conversation-owner',contexts:[
    {projectId:projects.primary!.id,contextId:projects.primary!.context,sessionId:'s-primary',profileId:'personal-manager',keyVersion:1,encryptionVariant:'legacy'},
    {projectId:projects.removed!.id,contextId:projects.removed!.context,sessionId:'s-removed',profileId:'personal-manager',keyVersion:1,encryptionVariant:'legacy'}]},
   remoteDevelopment:{mode:'synthetic-fixed-task-v1',transport:{allowedHosts:['remote.invalid'],credentials:[{id:randomUUID(),path:join(area,'ssh','id_fixture')}]},
    projects:(['removed','other'] as const).map(name=>({projectId:projects[name]!.id,verifierKeyFile:join(data,'remote-'+name+'.key'),tmpfsRoot:join(area,'tmpfs',name),
     profiles:[{profileId:randomUUID(),hostId:randomUUID(),taskId:'fixture',writePaths:['src/example.ts']}]}))}},null,2)+'\n',{mode:0o600});

  const count=async(sql:string,args:unknown[])=>Number((await ledger.pool.query(sql,args)).rows[0].n);
  // The shared per-daemon pins, file by file: a preview must not republish them.
  const tree=async(root:string)=>{
   const out:string[]=[];
   const walk=async(dir:string)=>{
    for(const name of (await readdir(dir).catch(()=>[] as string[])).sort()){
     const path=join(dir,name),info=await lstat(path);
     if(info.isDirectory()){out.push(path+'/');await walk(path);}else out.push(path+'='+await readFile(path,'utf8'));
    }
   };
   await walk(root);
   return out;
  };
  const snapshot=async()=>({refs:await tree(join(area,'refs')),file:await readFile(file,'utf8'),registry:await readFile(join(registryDir,'registry.json'),'utf8'),
   jobs:(await readdir(hostRoot)).sort().join(','),access:await count('SELECT count(*)::int n FROM ac_account_access',[]),
   archived:await count('SELECT count(*)::int n FROM ac_projects WHERE archived_at IS NOT NULL',[]),contexts:await count('SELECT count(*)::int n FROM ac_contexts WHERE archived',[]),
   repos:await count('SELECT count(*)::int n FROM ac_project_repositories',[]),entries:(await readdir(data)).sort().join(',')});
  const mutating=()=>fake.calls.filter(args=>args[1]==='rm');

  // 1. Preview: nothing changes, sizes are reported. A retention preview first publishes the installation's full pin set.
  await runPersonalArtifactRetention(await loadInstallation(file),false,deps);
  const before=await snapshot();
  assert.ok(before.refs.some(line=>line.includes(moduleImage)&&line.includes(pinnedImage)),before.refs.join('\n'));
  const preview=await removePersonalProject(file,'removed',{apply:false,deleteData:true,deps});
  assert.equal(preview.applied,false);
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(mutating(),[]);
  assert.match(preview.lines.join('\n'),/2 pasta\(s\) de job nativo .* [0-9.]+ (?:MB|GB)/);
  assert.match(preview.lines.join('\n'),/imagem sha256:.*seria removido/);
  assert.match(preview.lines.join('\n'),/Prévia, nada foi alterado/);

  // 2. The primary project is refused, by id and by label.
  await assert.rejects(()=>removePersonalProject(file,projects.primary!.id,{apply:true,deleteData:true,deps}),(error:unknown)=>error instanceof Refusal&&error.code==='PRIMARY_PROJECT_FORBIDDEN');
  await assert.rejects(()=>removePersonalProject(file,'primary',{apply:true,deleteData:true,deps}),(error:unknown)=>error instanceof Refusal&&error.code==='PRIMARY_PROJECT_FORBIDDEN');

  // 3. A running job, a held grant or an exam in progress refuses, and nothing changes.
  await assert.rejects(()=>removePersonalProject(file,'removed',{apply:true,deleteData:true,deps}),(error:unknown)=>{
   assert.ok(error instanceof Refusal&&error.code==='PROJECT_REMOVE_ACTIVE');
   assert.match(personalProjectRemoveFailureText(error),/job\(s\) nativo\(s\) ativo.*vaga/);return true;});
  await ledger.pool.query("UPDATE ac_capacity_grants SET state='released' WHERE id=$1",[projects.removed!.grants[0]]);
  await assert.rejects(()=>removePersonalProject(file,'removed',{apply:true,deleteData:true,deps}),/PROJECT_REMOVE_ACTIVE/);
  await ledger.pool.query("UPDATE ac_native_execution_jobs SET state='completed' WHERE id=$1",[projects.removed!.jobs[0]]);
  await mkdir(join(data,'verificacoes',projects.removed!.id,'andamento'),{recursive:true});
  await writeFile(join(data,'verificacoes',projects.removed!.id,'andamento','.running'),'{}');
  await assert.rejects(()=>removePersonalProject(file,'removed',{apply:true,deleteData:true,deps}),/PROJECT_REMOVE_ACTIVE/);
  await rm(join(data,'verificacoes',projects.removed!.id,'andamento'),{recursive:true});
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(mutating(),[]);
  // Work that starts between the first check and the archiving transaction refuses too, and installation.json is not rewritten.
  let lateExam='';
  await assert.rejects(()=>removePersonalProject(file,'removed',{apply:true,deleteData:true,deps:{...deps,beforeArchive:async()=>{
   lateExam=await verifyRun('removed',null,'running');}}}),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_REMOVE_ACTIVE'&&/exame/.test(personalProjectRemoveFailureText(error)));
  assert.ok(lateExam);
  await ledger.pool.query("UPDATE ac_verify_runs SET status='failed',finished_at=clock_timestamp() WHERE id=$1",[lateExam]);
  assert.deepEqual(await snapshot(),before);
  assert.deepEqual(mutating(),[]);
  assert.deepEqual((await readdir(data)).filter(name=>name.startsWith('installation.json.')),[]);

  // 4. Removal with data: only the chosen project goes.
  const result=await removePersonalProject(file,'removed',{apply:true,deleteData:true,deps,now:new Date('2026-11-28T10:00:00Z')});
  assert.equal(result.applied,true);
  const config=await loadInstallation(file);
  assert.deepEqual(config.projects.map(item=>item.label),['other']);
  assert.equal(config.project.id,projects.primary!.id);
  assert.deepEqual(config.managerTransport?.contexts.map(item=>item.projectId),[projects.primary!.id]);
  assert.deepEqual(config.remoteDevelopment?.projects.map(item=>item.projectId),[projects.other!.id]);
  assert.equal(await readFile(result.backupPath!,'utf8'),before.file);
  assert.ok(await exists(result.reportPath!));
  const report=await readFile(result.reportPath!,'utf8');
  // Kept: the running container, the image it uses and the two product pins. The registered candidate the other project's exam
  // uses stays in Docker under that pin without holding the removal; the image retention takes it once the pin goes.
  assert.ok(report.includes(`Remoção aplicada com 4 item(ns) preservado(s). Para tentar de novo: npm run personal:project -- --remover ${file} ${projects.removed!.id} --apagar-dados --sim`),report);
  assert.match(report,new RegExp(`contêiner ${runningContainer.slice(0,12)}: preservado \\(em execução`));
  assert.match(report,new RegExp(`imagem ${usedImage.slice(0,19)}: preservada \\(há contêiner usando a imagem\\)`));
  assert.match(report,new RegExp(`imagem ${moduleImage.slice(0,19)}: preservada \\(digest fixado`));
  assert.match(report,new RegExp(`imagem ${designImage.slice(0,19)}: preservada \\(digest fixado`));
  assert.match(report,new RegExp(`imagem ${pinnedImage.slice(0,19)} \\(qa\\): fica no Docker \\(digest fixado ou referenciado por exame\\); a retenção de imagens a retira quando o pin sair`));
  const row=(await ledger.pool.query('SELECT archived_at FROM ac_projects WHERE id=$1',[projects.removed!.id])).rows[0];
  assert.ok(row.archived_at instanceof Date);
  assert.equal(await count('SELECT count(*)::int n FROM ac_projects WHERE archived_at IS NOT NULL',[]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_contexts WHERE project_id=$1 AND archived',[projects.removed!.id]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_contexts WHERE archived',[]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_account_access WHERE project_id=$1',[projects.removed!.id]),0);
  assert.equal(await count('SELECT count(*)::int n FROM ac_account_access',[]),3);
  // Receipts and history stay; the repository link is freed.
  assert.equal(await count('SELECT count(*)::int n FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1',[projects.removed!.id]),2);
  // The repository link stays while something was kept, so the rerun still finds the repository.
  assert.equal(await count('SELECT count(*)::int n FROM ac_project_repositories WHERE project_id=$1',[projects.removed!.id]),1);
  for(const job of projects.removed!.jobs)assert.equal(await exists(join(hostRoot,job)),false);
  for(const name of ['primary','other','dbonly'])for(const job of projects[name]!.jobs)assert.ok(await exists(join(hostRoot,job,'output','result.json')));
  assert.equal(await exists(join(data,'qa-cache',projects.removed!.id)),false);
  assert.equal(await exists(join(data,'verificacoes',projects.removed!.id)),false);
  assert.ok(await exists(join(data,'qa-cache',projects.other!.id,'report.md')));
  assert.ok(await exists(join(data,'verificacoes',projects.other!.id,'report.md')));
  const sharedOf=(name:string)=>join(data,'native','shared-worktrees',createHash('sha256').update(projects[name]!.repo).digest('hex')+'-'+projects[name]!.head);
  assert.equal(await exists(sharedOf('removed')),false);
  assert.ok(await exists(sharedOf('other')));
  // The repository of the removed project is never touched.
  assert.ok(await exists(join(projects.removed!.repo,'.git','HEAD')));
  assert.equal(execFileSync('git',['-C',projects.removed!.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),projects.removed!.head);
  const registry=JSON.parse(await readFile(join(registryDir,'registry.json'),'utf8'));
  assert.deepEqual(registry.images.map((item:{imageId:string})=>item.imageId),[pinnedImage,otherImage]);
  assert.deepEqual(registry.rounds.map((item:{projectId:string})=>item.projectId),[projects.other!.id]);
  // Docker: only the removed project's labelled resources and registered image, by id and never forced.
  const removedDocker=labelled('removed');
  assert.deepEqual(mutating().map(args=>args.join(' ')).sort(),[`container rm ${removedDocker.container}`,`image rm ${removedImage}`,`image rm ${removedDocker.image}`,`volume rm ${removedDocker.volume}`].sort());
  assert.ok(fake.containers.has(runningContainer)&&[usedImage,moduleImage,designImage,pinnedImage].every(item=>fake.images.has(item)));
  assert.ok(fake.images.has(otherImage)&&fake.images.has(labelled('other').image)&&fake.containers.has(labelled('other').container)&&fake.volumes.has(labelled('other').volume));
  assert.ok(!fake.calls.some(args=>args.includes('-f')||args.includes('--force')||args.includes('prune')));

  // 5. Once nothing holds them any more, the rerun by id (the label no longer finds an archived project) removes the rest.
  await assert.rejects(()=>removePersonalProject(file,'removed',{apply:false,deleteData:true,deps}),/NOT_FOUND/);
  fake.running.delete(runningContainer);
  await rm(modulePin);await rm(designPin);
  await ledger.pool.query('DELETE FROM ac_verify_runs WHERE project_id=$1',[projects.other!.id]);
  const rerun=await removePersonalProject(file,projects.removed!.id,{apply:true,deleteData:true,deps});
  assert.match(rerun.lines.join('\n'),/Remoção aplicada\./);
  assert.deepEqual(mutating().map(args=>args.join(' ')).filter(line=>[runningContainer,usedImage,moduleImage,designImage,pinnedImage].some(item=>line.endsWith(item))).sort(),
   [`container rm ${runningContainer}`,`image rm ${usedImage}`,`image rm ${moduleImage}`,`image rm ${designImage}`,`image rm ${pinnedImage}`].sort());
  assert.equal(await count('SELECT count(*)::int n FROM ac_project_repositories WHERE project_id=$1',[projects.removed!.id]),0);
  assert.equal(await count('SELECT count(*)::int n FROM ac_project_repositories',[]),3);
  assert.deepEqual(JSON.parse(await readFile(join(registryDir,'registry.json'),'utf8')).images.map((item:{imageId:string})=>item.imageId),[otherImage]);

  // 5b. A further rerun is harmless.
  const calls=mutating().length;
  const again=await removePersonalProject(file,projects.removed!.id,{apply:true,deleteData:true,deps});
  assert.equal(again.applied,true);
  assert.equal(mutating().length,calls);
  assert.deepEqual((await loadInstallation(file)).projects.map(item=>item.label),['other']);

  // 6. A project already out of installation.json but still in the ledger is removed by its id.
  const fileBefore=await readFile(file,'utf8');
  await assert.rejects(()=>removePersonalProject(file,randomUUID(),{apply:false,deleteData:false,deps}),/NOT_FOUND/);
  const dbonly=await removePersonalProject(file,projects.dbonly!.id,{apply:true,deleteData:true,deps});
  assert.equal(dbonly.backupPath,undefined);
  assert.equal(await readFile(file,'utf8'),fileBefore);
  assert.equal(await count('SELECT count(*)::int n FROM ac_projects WHERE id=$1 AND archived_at IS NOT NULL',[projects.dbonly!.id]),1);
  for(const job of projects.dbonly!.jobs)assert.equal(await exists(join(hostRoot,job)),false);
  for(const name of ['primary','other'])for(const job of projects[name]!.jobs)assert.ok(await exists(join(hostRoot,job)));
  assert.ok(await exists(join(projects.dbonly!.repo,'.git','HEAD')));
  assert.ok(!fake.containers.has(labelled('dbonly').container));
  assert.ok(fake.containers.has(labelled('primary').container));

  // 7. Later artifact retention does not stumble on the removed projects.
  const retention=await runPersonalArtifactRetention(await loadInstallation(file),false,deps);
  assert.ok(!retention.some(line=>/falha ao verificar/.test(line)),retention.join('\n'));

  // 8. Without --apagar-dados the data stays; the CLI refuses unknown arguments.
  await assert.rejects(()=>runPersonalProjectRemoveCli(['--remover',file]),/PROJECT_REMOVE_USAGE/);
  await assert.rejects(()=>runPersonalProjectRemoveCli(['--remover',file,'other','--forcar']),/PROJECT_REMOVE_USAGE/);
  const kept=await runPersonalProjectRemoveCli(['--remover',file,'other','--sim'],{deps});
  assert.match(kept.join('\n'),/Reinicie o gateway/);
  for(const job of projects.other!.jobs)assert.ok(await exists(join(hostRoot,job)));
  assert.ok(await exists(join(data,'qa-cache',projects.other!.id)));
  assert.deepEqual((await loadInstallation(file)).projects,[]);
  // The other project was the last one with remote development: the block goes, and the file stays valid.
  assert.equal((await loadInstallation(file)).remoteDevelopment,undefined);
  assert.match(kept.join('\n'),/bloco remoteDevelopment/);
 }finally{
  await ledger.close();
  await database.close();
  await rm(area,{recursive:true,force:true});
 }
});

test('the archive migration is idempotent',{skip:!url,timeout:60000},async()=>{
 const database=await isolatedDatabase(url!,'projrmmig');
 const ledger=new Ledger(database.url);
 try{
  await ledger.migrate();
  await ledger.migrate();
  const sql=await readFile(new URL('../db/migrations/124_project_archived.sql',import.meta.url),'utf8');
  const client=new pg.Client({connectionString:database.url});await client.connect();
  try{await client.query(sql);await client.query(sql);}finally{await client.end();}
  const column=(await ledger.pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='ac_projects' AND column_name='archived_at'")).rows;
  assert.deepEqual(column.map(item=>item.data_type),['timestamp with time zone']);
 }finally{await ledger.close();await database.close();}
});
