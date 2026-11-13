import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {Capacity} from '../src/capacity.ts';
import {Ledger} from '../src/ledger.ts';
import {nativeReviewVerifierDigest} from '../src/native-review-contract.ts';
import {addPersonalProject} from '../src/personal-project-add.ts';
import type {PersonalHappierClient} from '../src/personal-connect.ts';
import {QualityPolicies} from '../src/quality-policy.ts';
import {Projects} from '../src/projects.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('adding a repository registers it once, shares accounts and publishes policies',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;
 if(!base)throw new Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'projadd');
 const area=await realpath(await mkdtemp(join(tmpdir(),'ac-proj-add-')));
 const data=join(area,'ispagent'),primary=join(area,'primary'),secondary=join(area,'secondary'),notGit=join(area,'not-git');
 const inside=join(data,'inside'),foreign=join(area,'foreign'),dbonly=join(area,'dbonly'),other=join(area,'other-install');
 const file=join(data,'installation.json');
 let setup:Ledger|undefined,check:Ledger|undefined;
 const sessions:{tag:string}[]=[],machines:string[]=[],sealed:unknown[]=[];
 const happier:PersonalHappierClient={
  async ready(){return true;},
  async authenticate(){return {token:'token-1'};},
  async profile(){return {id:'happier-profile'};},
  async createMachine(_origin,_token,body){machines.push(body.id);},
  async createSession(_origin,_token,body){sessions.push({tag:body.tag});return {sessionId:'session-'+sessions.length};},
  async seal(_secret,value){sealed.push(value);return 'sealed';},
 };
 try{
  await mkdir(data,{recursive:true,mode:0o700});await chmod(data,0o700);
  for(const path of [primary,secondary,notGit,inside,foreign,dbonly,other])await mkdir(path,{recursive:true,mode:0o700});
  const gitRepo=(repo:string)=>{
   execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});
   execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','base'],{stdio:'ignore'});
  };
  gitRepo(primary);gitRepo(secondary);gitRepo(inside);gitRepo(foreign);gitRepo(dbonly);
  const owner='owner@example.com',primaryId=randomUUID(),contextId=randomUUID(),managerAccount=randomUUID(),programmerAccount=randomUUID();
  const managerProfile=randomUUID(),programmerProfile=randomUUID(),dbProject=randomUUID();
  const installation={schemaVersion:1,mode:'administration-only',activation:'personal',databaseUrl:fixture.url,dataDirectory:data,
   project:{id:primaryId,label:'primary',repo:primary,owner},projects:[],
   http:{listen:'127.0.0.1',port:8765,publicOrigin:'http://127.0.0.1:8765'},
   happier:{upstreamOrigin:'http://127.0.0.1:8766',webOrigin:'http://127.0.0.1:8766',publicServerOrigin:'http://127.0.0.1:8765'},
   contextVault:{directory:join(data,'vault'),masterFile:join(data,'vault-master')},
   managerTransport:{principal:'happier-profile',tokenFile:join(data,'manager-token'),machineId:'machine-1',contexts:[{
    projectId:primaryId,contextId,sessionId:'session-primary',profileId:'personal-manager',keyVersion:1,encryptionVariant:'legacy'}]}};
  await writeFile(file,JSON.stringify(installation,null,2)+'\n',{mode:0o600});await chmod(file,0o600);
  await writeFile(join(other,'installation.json'),JSON.stringify({project:{repo:foreign},projects:[],dataDirectory:other})+'\n');
  setup=new Ledger(fixture.url);await setup.migrate();
  await new Projects(setup).register([{id:primaryId,label:'primary',repo:primary,owner}]);
  await setup.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  await setup.pool.query('INSERT INTO ac_projects(id,label) VALUES($1,$2)',[dbProject,'elsewhere']);
  await setup.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[dbProject,dbonly]);
  const capacity=new Capacity(setup);
  await capacity.registerModel(owner,{provider:'synthetic-personal',model:'manager-model',efforts:['medium'],roles:['manager'],source:'synthetic://personal-add'});
  await capacity.registerModel(owner,{provider:'synthetic-personal',model:'programmer-model',efforts:['medium'],roles:['programmer'],source:'synthetic://personal-add'});
  await capacity.addAccount(owner,primaryId,{id:managerAccount,provider:'synthetic-personal',label:'manager',resourceIdentity:'mgr-'+managerAccount,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://personal-add',maxConcurrent:1});
  await capacity.addAccount(owner,primaryId,{id:programmerAccount,provider:'synthetic-personal',label:'programmer',resourceIdentity:'prg-'+programmerAccount,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://personal-add',maxConcurrent:1});
  await capacity.addProfile(owner,primaryId,{id:managerProfile,accountId:managerAccount,model:'manager-model',effort:'medium',role:'manager'});
  await capacity.addProfile(owner,primaryId,{id:programmerProfile,accountId:programmerAccount,model:'programmer-model',effort:'medium',role:'programmer'});
  for(const provider of ['claude','grok','codex'] as const){
   const id=randomUUID();
   await capacity.addAccount(owner,primaryId,{id,provider,label:provider,resourceIdentity:provider+':'+id,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://personal-add',maxConcurrent:2});
  }
  await capacity.publish(owner,primaryId,0,{schemaVersion:1,roles:{manager:{regular:[managerProfile],emergency:[]},programmer:{regular:[programmerProfile],emergency:[]}},maxEvaluatorsPerContext:2,maxProgrammersPerContext:2});
  await new QualityPolicies(setup).publish(owner,primaryId,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,qaVerifierDigest:'a'.repeat(64)});
  await setup.close();setup=undefined;

  await assert.rejects(()=>addPersonalProject(file,notGit,'Nao',{happier}),/NOT_A_GIT_REPOSITORY/);
  await assert.rejects(()=>stat(join(data,'installation.json.before-add-Nao')),{code:'ENOENT'});
  await assert.rejects(()=>addPersonalProject(file,inside,'Dentro',{happier}),/DATA_DIRECTORY_PATH_FORBIDDEN/);
  await assert.rejects(()=>addPersonalProject(file,foreign,'Alheio',{happier}),/REPOSITORY_OF_ANOTHER_INSTALLATION/);
  await assert.rejects(()=>addPersonalProject(file,dbonly,'Banco',{happier}),/REPOSITORY_OF_ANOTHER_INSTALLATION/);

  const result=await addPersonalProject(file,secondary,'Segundo',{happier});
  assert.equal(result.repository,secondary);
  assert.equal(result.label,'Segundo');
  assert.equal(result.restart,`systemctl --user restart agent-control-gateway-${basename(data).replace(/[^A-Za-z0-9_-]/g,'-')}`);
  assert.equal(machines.length,0);
  assert.deepEqual(sessions.map(item=>item.tag),['agent-control-'+result.projectId]);
  assert.equal(sealed.some(value=>!!value&&typeof value==='object'&&(value as {name?:string}).name==='Segundo'),true);
  const saved=JSON.parse(await readFile(file,'utf8')) as {databaseUrl:string;projects:{id:string;label:string;repo:string;owner:string}[];managerTransport:{machineId:string;tokenFile:string;contexts:{projectId:string;profileId:string}[]}};
  assert.equal(saved.databaseUrl,fixture.url);
  assert.equal(saved.projects.length,1);
  assert.equal(saved.projects[0]?.id,result.projectId);
  assert.equal(saved.projects[0]?.repo,secondary);
  assert.equal(saved.projects[0]?.owner,owner);
  assert.equal(saved.managerTransport.machineId,'machine-1');
  assert.equal(saved.managerTransport.tokenFile,join(data,'manager-token'));
  assert.equal(saved.managerTransport.contexts.length,2);
  assert.equal(saved.managerTransport.contexts[1]?.projectId,result.projectId);
  const backup=await readFile(join(data,'installation.json.before-add-Segundo'),'utf8');
  assert.equal(backup.includes(secondary),false);
  assert.equal((await stat(join(data,'installation.json.before-add-Segundo'))).mode&0o077,0);
  assert.equal((await stat(file)).mode&0o077,0);
  const counts=async(ledger:Ledger)=>{
   const n=async(sql:string,params:unknown[]=[])=>Number((await ledger.pool.query(sql,params)).rows[0].n);
   return {
    projects:await n('SELECT count(*)::int n FROM ac_projects'),
    repositories:await n('SELECT count(*)::int n FROM ac_project_repositories WHERE repo=$1',[secondary]),
    owner:await n("SELECT count(*)::int n FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[result.projectId,owner]),
    access:await n('SELECT count(*)::int n FROM ac_account_access WHERE project_id=$1',[result.projectId]),
    policies:await n('SELECT count(*)::int n FROM ac_policy_revisions WHERE project_id=$1',[result.projectId]),
    quality:await n('SELECT count(*)::int n FROM ac_quality_policies WHERE project_id=$1',[result.projectId]),
    contexts:await n('SELECT count(*)::int n FROM ac_contexts WHERE project_id=$1 AND NOT archived',[result.projectId]),
    mode:String((await ledger.pool.query('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0].mode),
   };
  };
  check=new Ledger(fixture.url);
  const born=(await check.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[result.projectId])).rows[0].snapshot;
  assert.equal(born.combo,'intermediário');
  assert.equal(born.maxProgrammersPerContext,3);
  assert.equal(born.roles.programmer.regular.length,3);
  assert.equal(saved.managerTransport.contexts[1]?.profileId,born.roles.manager.regular[0]);
  assert.notEqual(saved.managerTransport.contexts[1]?.profileId,managerProfile);
  const first=await counts(check);
  assert.deepEqual(first,{projects:3,repositories:1,owner:1,access:5,policies:1,quality:1,contexts:1,mode:'locked'});
  await check.close();check=undefined;

  await assert.rejects(()=>addPersonalProject(file,secondary,'Segundo',{happier}),/REPOSITORY_ALREADY_IN_INSTALLATION/);
  assert.equal(sessions.length,1);
  assert.equal(machines.length,0);
  check=new Ledger(fixture.url);
  assert.deepEqual(await counts(check),first);
  const again=JSON.parse(await readFile(file,'utf8')) as {projects:unknown[];managerTransport:{contexts:unknown[]}};
  assert.equal(again.projects.length,1);
  assert.equal(again.managerTransport.contexts.length,2);
 }finally{
  await check?.close();
  await setup?.close();
  await fixture.close();
  await rm(area,{recursive:true,force:true});
 }
});
