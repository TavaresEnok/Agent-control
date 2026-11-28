import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

/** Docker as a recorded fake: one daemon, a few images, one labelled container and volume per project. */
function fakeDocker(byProject:Record<string,{container:string;volume:string;image:string}>,registryImages:string[]){
 const calls:string[][]=[];
 const images=new Set([...registryImages,...Object.values(byProject).map(item=>item.image)]);
 const containers=new Set(Object.values(byProject).map(item=>item.container));
 const volumes=new Set(Object.values(byProject).map(item=>item.volume));
 const ok=(stdout='')=>({code:0,stdout}) as CommandResult;
 const docker=async(args:string[]):Promise<CommandResult>=>{
  calls.push(args);
  const joined=args.join(' ');
  const label=args.find(item=>item.startsWith(`label=${PROJECT_LABEL}=`))?.split('=').at(-1);
  const of=label?byProject[label]:undefined;
  if(joined==='info --format {{.ID}}')return ok('daemon-1\n');
  if(joined.startsWith('info'))return {code:1,stdout:''};
  if(args[0]==='container'&&args[1]==='ls'){
   if(label)return ok(of&&containers.has(of.container)?of.container+'\n':'');
   if(args.some(item=>item.startsWith('ancestor=')))return ok('');
   return ok([...containers].join('\n'));
  }
  if(args[0]==='container'&&args[1]==='inspect'){
   if(joined.includes('.State.Running'))return ok('false\n');
   if(joined.includes('.Mounts'))return ok('');
   if(joined.includes('.Image'))return ok([...containers].map(()=> 'sha256:'+'0'.repeat(64)).join('\n'));
  }
  if(args[0]==='container'&&args[1]==='rm'){containers.delete(args[2]!);return ok();}
  if(args[0]==='volume'&&args[1]==='ls')return ok(of&&volumes.has(of.volume)?of.volume+'\n':'');
  if(args[0]==='volume'&&args[1]==='rm'){volumes.delete(args[2]!);return ok();}
  if(args[0]==='image'&&args[1]==='ls'){
   if(label)return ok(of&&images.has(of.image)?of.image+'\n':'');
   return ok([...images].join('\n'));
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
 return {docker,calls,images,containers,volumes};
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
  const removedImage=image('removed-registry'),otherImage=image('other-registry');
  const registryDir=join(data,'artifact-retention');await mkdir(registryDir,{mode:0o700});
  const old=Date.now()-60_000;
  await writeFile(join(registryDir,'registry.json'),JSON.stringify({schemaVersion:1,worktrees:[],temps:[],history:[],
   images:[{id:randomUUID(),projectId:projects.removed!.id,module:'qa',imageId:removedImage,daemonId:'daemon-1',registeredAt:old},
    {id:randomUUID(),projectId:projects.other!.id,module:'qa',imageId:otherImage,daemonId:'daemon-1',registeredAt:old}],
   rounds:[{projectId:projects.removed!.id,roundId:'round-1',endedAt:old},{projectId:projects.other!.id,roundId:'round-2',endedAt:old}]})+'\n',{mode:0o600});
  const labelled=(name:string)=>({container:createHash('sha256').update('c'+name).digest('hex'),volume:'ac-vol-'+name,image:image('label-'+name)});
  const fake=fakeDocker({[projects.removed!.id]:labelled('removed'),[projects.other!.id]:labelled('other'),[projects.primary!.id]:labelled('primary'),[projects.dbonly!.id]:labelled('dbonly')},[removedImage,otherImage]);
  const product=join(area,'product');await mkdir(product);
  const deps={docker:fake.docker,verifyRunImages:async()=>[],sharedRefsRoot:join(area,'refs'),productRoot:product,tmpRoot:join(area,'tmp'),
   processPaths:async()=>[],processInside:async()=>false,mountInfo:async()=>'22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n'};
  await mkdir(join(area,'tmp'));

  const entry=(name:string)=>({id:projects[name]!.id,label:name,repo:projects[name]!.repo,owner});
  await writeFile(file,JSON.stringify({schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:database.url,dataDirectory:data,
   project:entry('primary'),projects:[entry('removed'),entry('other')],
   http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
   contextVault:{directory:join(data,'vault'),masterFile:join(data,'vault-master')},
   managerTransport:{principal:'conversation-owner',contexts:[
    {projectId:projects.primary!.id,contextId:projects.primary!.context,sessionId:'s-primary',profileId:'personal-manager',keyVersion:1,encryptionVariant:'legacy'},
    {projectId:projects.removed!.id,contextId:projects.removed!.context,sessionId:'s-removed',profileId:'personal-manager',keyVersion:1,encryptionVariant:'legacy'}]}},null,2)+'\n',{mode:0o600});

  const count=async(sql:string,args:unknown[])=>Number((await ledger.pool.query(sql,args)).rows[0].n);
  const snapshot=async()=>({file:await readFile(file,'utf8'),registry:await readFile(join(registryDir,'registry.json'),'utf8'),
   jobs:(await readdir(hostRoot)).sort().join(','),access:await count('SELECT count(*)::int n FROM ac_account_access',[]),
   archived:await count('SELECT count(*)::int n FROM ac_projects WHERE archived_at IS NOT NULL',[]),contexts:await count('SELECT count(*)::int n FROM ac_contexts WHERE archived',[]),
   repos:await count('SELECT count(*)::int n FROM ac_project_repositories',[]),entries:(await readdir(data)).sort().join(',')});
  const mutating=()=>fake.calls.filter(args=>args[1]==='rm');

  // 1. Preview: nothing changes, sizes are reported.
  const before=await snapshot();
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

  // 4. Removal with data: only the chosen project goes.
  const result=await removePersonalProject(file,'removed',{apply:true,deleteData:true,deps,now:new Date('2026-11-28T10:00:00Z')});
  assert.equal(result.applied,true);
  const config=await loadInstallation(file);
  assert.deepEqual(config.projects.map(item=>item.label),['other']);
  assert.equal(config.project.id,projects.primary!.id);
  assert.deepEqual(config.managerTransport?.contexts.map(item=>item.projectId),[projects.primary!.id]);
  assert.equal(await readFile(result.backupPath!,'utf8'),before.file);
  assert.ok(await exists(result.reportPath!));
  assert.match(await readFile(result.reportPath!,'utf8'),/Remoção aplicada\./);
  const row=(await ledger.pool.query('SELECT archived_at FROM ac_projects WHERE id=$1',[projects.removed!.id])).rows[0];
  assert.ok(row.archived_at instanceof Date);
  assert.equal(await count('SELECT count(*)::int n FROM ac_projects WHERE archived_at IS NOT NULL',[]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_contexts WHERE project_id=$1 AND archived',[projects.removed!.id]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_contexts WHERE archived',[]),1);
  assert.equal(await count('SELECT count(*)::int n FROM ac_account_access WHERE project_id=$1',[projects.removed!.id]),0);
  assert.equal(await count('SELECT count(*)::int n FROM ac_account_access',[]),3);
  // Receipts and history stay; the repository link is freed.
  assert.equal(await count('SELECT count(*)::int n FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1',[projects.removed!.id]),2);
  assert.equal(await count('SELECT count(*)::int n FROM ac_project_repositories WHERE project_id=$1',[projects.removed!.id]),0);
  assert.equal(await count('SELECT count(*)::int n FROM ac_project_repositories',[]),3);
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
  assert.deepEqual(registry.images.map((item:{imageId:string})=>item.imageId),[otherImage]);
  assert.deepEqual(registry.rounds.map((item:{projectId:string})=>item.projectId),[projects.other!.id]);
  // Docker: only the removed project's labelled resources and registered image, by id and never forced.
  const removedDocker=labelled('removed');
  assert.deepEqual(mutating().map(args=>args.join(' ')).sort(),[`container rm ${removedDocker.container}`,`image rm ${removedImage}`,`image rm ${removedDocker.image}`,`volume rm ${removedDocker.volume}`].sort());
  assert.ok(fake.images.has(otherImage)&&fake.images.has(labelled('other').image)&&fake.containers.has(labelled('other').container)&&fake.volumes.has(labelled('other').volume));
  assert.ok(!fake.calls.some(args=>args.includes('-f')||args.includes('--force')||args.includes('prune')));

  // 5. A rerun on the archived project, by id, is harmless.
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
