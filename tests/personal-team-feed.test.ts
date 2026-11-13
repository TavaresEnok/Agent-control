import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {dockerLogText,teamMessage} from '../src/personal-team-feed.ts';
import {personalComboRequest,personalControlWord} from '../src/personal-conversation.ts';
import {builtinCombos,describeAppliedCombo} from '../src/personal-combos.ts';

const frame=(text:string)=>{const body=Buffer.from(text);const head=Buffer.alloc(8);head[0]=1;head.writeUInt32BE(body.length,4);return Buffer.concat([head,body]);};

test('docker multiplexed QA logs become plain text',()=>{
 assert.equal(dockerLogText(Buffer.concat([frame('a\n'),frame('b\n')])),'a\nb\n');
 assert.equal(dockerLogText(Buffer.from('plain')),'plain');
});

test('each role reports who ran it and what it produced',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-')),repo=root;
 const reviewer=randomUUID(),programmer=randomUUID(),qa=randomUUID();
 await mkdir(join(root,reviewer,'output'),{recursive:true});await mkdir(join(root,programmer,'output'),{recursive:true});await mkdir(join(root,qa),{recursive:true});
 await writeFile(join(root,reviewer,'output','execution-result.json'),JSON.stringify({output:JSON.stringify({verdict:'reject',findings:[{severity:'high',summary:'falta teste'}]})}));
 await writeFile(join(root,programmer,'output','execution-result.json'),JSON.stringify({output:'Adicionei a seção.'}));
 await writeFile(join(root,qa,'qa-logs.bin'),frame('QA files checked: 3, failures: 0\n'));
 const base={provider:'claude',model:'claude-sonnet-5-5',effort:'medium',base:null};
 const review=await teamMessage({...base,id:reviewer,kind:'reviewer',state:'completed',receipt:{}},{executionHost:root,repo});
 assert.match(review!.text,/^Revisor \(claude · claude-sonnet-5-5 · medium\) rejeitou:\n• \[high\] falta teste/);
 const prog=await teamMessage({...base,provider:'grok',model:'grok-4.7',id:programmer,kind:'programmer',state:'completed',receipt:{payload:{artifact:null}}},{executionHost:root,repo});
 assert.match(prog!.text,/Programador \(grok · grok-4.7 · medium\) terminou\.\n«Adicionei a seção\.»/);
 const check=await teamMessage({id:qa,kind:'qa',state:'completed',provider:null,model:null,effort:null,base:null,receipt:{status:'passed'}},{executionHost:root,repo});
 assert.equal(check!.text,'QA passou: QA files checked: 3, failures: 0.');
 const running=await teamMessage({...base,id:programmer,kind:'programmer',state:'running',receipt:null},{executionHost:root,repo});
 assert.equal(running!.id,'team-'+programmer+'-running');
 assert.equal(await teamMessage({...base,id:'../x',kind:'reviewer',state:'completed',receipt:{}},{executionHost:root,repo}).then(m=>m!.text),'Revisor (claude · claude-sonnet-5-5 · medium) não concluiu a revisão.');
});

test('the programmer report diffs only the intent repository',async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-repo-')),repoA=join(root,'a'),repoB=join(root,'b');
 const prepare=async(repo:string,file:string)=>{
  await mkdir(repo);
  execFileSync('git',['init','-q','-b','main',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--allow-empty','-m','base'],{stdio:'ignore'});
  const base=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  await writeFile(join(repo,file),file+'\n');
  execFileSync('git',['-C',repo,'add',file],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','change'],{stdio:'ignore'});
  return {base,commit:execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim()};
 };
 try{
  const a=await prepare(repoA,'only-a.txt'),b=await prepare(repoB,'only-b.txt'),intent=randomUUID();
  const job={id:randomUUID(),kind:'programmer' as const,state:'completed',provider:'grok',model:'grok-4.7',effort:'medium',base:null,intentId:intent,receipt:{payload:{artifact:{base:b.base,commit:b.commit}}}};
  const pool=(repo?:string)=>({query:async()=>({rows:repo?[{repo}]:[]})}) as never;
  const shown=await teamMessage(job,{executionHost:root,repo:repoA,pool:pool(repoB)});
  assert.match(shown!.text,/only-b\.txt/);
  assert.doesNotMatch(shown!.text,/only-a\.txt/);
  const hidden=await teamMessage({...job,receipt:{payload:{artifact:{base:a.base,commit:a.commit}}}},{executionHost:root,repo:repoA,pool:pool()});
  assert.match(hidden!.text,/Commit /);
  assert.doesNotMatch(hidden!.text,/arquivos/);
  assert.doesNotMatch(hidden!.text,/only-a\.txt/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('equipe and status ask for the team panel',()=>{
 assert.equal(personalControlWord(' Equipe '),'team');assert.equal(personalControlWord('status'),'team');assert.equal(personalControlWord('aprovar'),'approve');
 assert.equal(personalComboRequest('use o combo padrão'),'padrão');
 assert.equal(personalComboRequest('Use o combo  Megapoderoso'),'Megapoderoso');
 assert.equal(personalComboRequest('equipe'),null);
 const mega=builtinCombos.find(item=>item.name==='megapoderoso')!;
 const text=describeAppliedCombo({name:mega.name,revision:3,maxProgrammersPerContext:6,qaModel:true,manager:[],reviewer:[],programmerStandard:[],programmerBasic:[],qa:[],combo:mega});
 assert.match(text,/Combo megapoderoso em uso/);
 assert.match(text,/Programadores padrão: 4 × codex · gpt-6.1-sol · high/);
 assert.match(text,/Programadores básicos: 2 × grok · grok-4.7 · high/);
 assert.match(text,/Programadores por contexto: 6/);
});

test('the app model picker lists the team, once',async()=>{
 const {teamModelsMetadata}=await import('../src/personal-team-feed.ts');
 const pool={query:async()=>({rows:[{role:'manager',model:'claude-sonnet-5-5',effort:'medium'},{role:'programmer',model:'grok-4.7',effort:'medium'}]})} as any;
 const next=await teamModelsMetadata(pool,{name:'ispagent',flavor:'claude'},1);
 assert.equal((next as Record<string,unknown>).name,'ispagent');
 assert.deepEqual(next!.sessionModelsV1,{v:1,provider:'claude',updatedAt:1,currentModelId:'agent-control-team',availableModels:[{id:'agent-control-team',name:'Equipe Agent Control',description:'Gerente claude-sonnet-5-5 medium · Programador grok-4.7 medium'}]});
 assert.equal(await teamModelsMetadata(pool,next!,2),null);
});
