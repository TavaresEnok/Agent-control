// Runs the tests that scripts/test-ci-classification.json marks as "executar", one process per file.
// The classification is explicit and versioned: a test file nobody classified is an error, and every
// file left out is listed with its reason (laboratório, excluído, pulado), never silently dropped.
// Laboratory files drive Docker or SSH and belong to their own compose profiles.
import {spawn,spawnSync} from 'node:child_process';
import pg from 'pg';
import {lstatSync,readdirSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileVerdict,selectTests,selectionReport,tapSummary,unknownOnlyNames} from './test-ci-selection.mjs';

const root=resolve(import.meta.dirname,'..');
const timeoutMs=Number(process.env.AC_CI_TEST_TIMEOUT_MS??180_000);
const logDir=process.env.AC_CI_LOG_DIR?resolve(process.env.AC_CI_LOG_DIR):null;
const listOnly=process.argv.includes('--list');
// Opt-in: also run the laboratory files that start their own Docker or SSH fixtures.
const includeHost=process.env.AC_CI_INCLUDE_HOST==='1';
// Files that refuse the shared database and demand their own disposable one.
const privateDatabases={
  'diagnostics.test.ts':['AC_TEST_DATABASE_URL','ac_diagnostics_test_c1'],
  'r3-history.test.ts':['AC_R3_HISTORY_DATABASE_URL','ac_r3_history'],
  'r3-project-environments.test.ts':['AC_R3_ENVIRONMENTS_DATABASE_URL','ac_r3_environments'],
  'r3-usage-report.test.ts':['AC_R3_USAGE_DATABASE_URL','ac_r3_usage'],
  'r5-model-policy.test.ts':['AC_R5_GRAPH_DATABASE_URL','ac_r5_mobile_graph'],
  'r5-profile-revision.test.ts':['AC_R5_GRAPH_DATABASE_URL','ac_r5_mobile_graph'],
  'r5-workflow-graph-pg.test.ts':['AC_R5_GRAPH_DATABASE_URL','ac_r5_mobile_graph'],
};
async function databaseEnvironment(name){
  const entry=privateDatabases[name];
  if(!entry)return {};
  const [variable,database]=entry,base=new URL(process.env.AC_TEST_DATABASE_URL);
  if(!['127.0.0.1','localhost','db'].includes(base.hostname))throw Error('ISOLATED_DATABASE_REQUIRED');
  const client=new pg.Client({connectionString:base.href});
  await client.connect();
  try{
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${database}"`);
  }finally{await client.end();}
  base.pathname='/'+database;
  return {[variable]:base.href};
}

// Guarda de resíduos: a suíte não pode deixar nada em /tmp/ac-*, em .state/projects, nas referências
// compartilhadas do Docker, nem mudar arquivo do repositório. AC_CI_LEAK_GUARD=0 desliga, só para depuração.
const entries=directory=>{try{return readdirSync(directory);}catch{return [];}};
const statKey=path=>{try{const info=lstatSync(path);return info.isFile()?`${info.size} ${info.mtimeMs}`:info.isSymbolicLink()?'link':'dir';}catch{return 'ausente';}};
function gitChanges(root,ignored){
  const run=spawnSync('git',['-C',root,'status','--porcelain=v1','-z','--untracked-files=all','--no-renames'],{encoding:'utf8',maxBuffer:64*1024*1024});
  if(run.status!==0)return new Map([['(git status)',`falhou: ${String(run.stderr).trim()}`]]);
  const changes=new Map();
  for(const item of run.stdout.split('\0')){
    if(item.length<4)continue;
    const path=item.slice(3),absolute=join(root,path);
    if(ignored.some(directory=>absolute===directory||absolute.startsWith(directory+'/')))continue;
    changes.set(path,`${item.slice(0,2)} ${statKey(absolute)}`);
  }
  return changes;
}
export function leakLocations(root,env=process.env){
  return {
    root,
    // AC_CI_LEAK_TMP_DIRS troca as pastas temporárias olhadas (separadas por ':'), para o teste da própria guarda.
    temporary:env.AC_CI_LEAK_TMP_DIRS?env.AC_CI_LEAK_TMP_DIRS.split(':').filter(Boolean).map(directory=>resolve(directory)):[...new Set([tmpdir(),'/tmp'])],
    projects:join(root,'.state','projects'),
    dockerRefs:env.AC_DOCKER_REFS_DIR?resolve(env.AC_DOCKER_REFS_DIR):join(homedir(),'.agent-control-docker-refs'),
    ignored:[],
  };
}
/** Foto do que a suíte poderia deixar para trás. Só nomes e tamanhos, sem ler conteúdo. */
export function leakSnapshot(locations){
  const items=new Map();
  const uid=process.getuid?.();
  for(const directory of locations.temporary){
    for(const name of entries(directory)){
      if(!name.startsWith('ac-'))continue;
      const path=join(directory,name);
      try{if(uid!==undefined&&lstatSync(path).uid!==uid)continue;}catch{continue;}
      items.set(`tmp ${path}`,'');
    }
  }
  for(const name of entries(locations.projects))items.set(`projeto ${join(locations.projects,name)}`,'');
  for(const daemon of entries(locations.dockerRefs)){
    const directory=join(locations.dockerRefs,daemon);
    const inside=statKey(directory)==='dir'?entries(directory):[];
    if(inside.length===0)items.set(`referencia ${directory}`,'');
    for(const name of inside)items.set(`referencia ${join(directory,name)}`,'');
  }
  for(const [path,state] of gitChanges(locations.root,locations.ignored))items.set(`git ${path}`,state);
  return items;
}
/** O que apareceu ou mudou depois. O que já estava lá antes, igual, não conta; o que sumiu também não. */
export function leakDiff(before,after){
  return [...after].filter(([key,state])=>before.get(key)!==state).map(([key])=>key).sort();
}
export function leakReport(leaks){
  return ['A suíte deixou resíduos (cada teste deve apagar o que cria; AC_CI_LEAK_GUARD=0 desliga a guarda só para depuração):',
    ...leaks.map(({file,item})=>`  ${file}: ${item}`)].join('\n');
}

async function runFile(name){
  const env={...process.env,...await databaseEnvironment(name)};
  return new Promise(done=>{
    const child=spawn(process.execPath,['--import','tsx','--test','--test-reporter=tap',join('tests',name)],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
    let output='',timedOut=false;
    const collect=chunk=>{output+=chunk;};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},timeoutMs);
    child.on('close',code=>{clearTimeout(timer);done({name,code,timedOut,output});});
  });
}

async function main(){
  const plan=await selectTests(root,{includeHost});
  if(plan.errors.length){
    console.error('Classificação de testes inválida (scripts/test-ci-classification.json):');
    for(const error of plan.errors)console.error('  '+error);
    console.error('Classifique cada arquivo novo como executar, laboratorio ou excluido (os dois últimos com motivo).');
    process.exit(2);
  }
  // AC_CI_ONLY=a.test.ts,b.test.ts runs just those files (still checked against the classification), to validate a candidate before promoting it.
  const only=process.env.AC_CI_ONLY?new Set(process.env.AC_CI_ONLY.split(',').map(name=>name.trim()).filter(Boolean)):null;
  const included=only?plan.executed.filter(name=>only.has(name)):plan.executed;
  const unknown=unknownOnlyNames(only,plan.executed);
  if(unknown.length){
    console.error('AC_CI_ONLY cita arquivos que não estão na lista "executar" desta máquina: '+unknown.join(', '));
    process.exit(2);
  }
  const excluded=[...plan.skipped,...plan.laboratory,...plan.excluded].map(item=>item.name).sort();
  if(listOnly){
    console.log(JSON.stringify({included,excluded,skipped:plan.skipped,laboratory:plan.laboratory,excludedWithReason:plan.excluded},null,1));
    process.exit(0);
  }
  if(!process.env.AC_TEST_DATABASE_URL){
    console.error('Defina AC_TEST_DATABASE_URL com um Postgres descartável (postgresql://usuario:senha@127.0.0.1:porta/banco).');
    console.error('Os arquivos que precisam do laboratório (Docker, SSH, sudo) ficam fora e aparecem em "excluded"; rode-os com npm run test:all no laboratório.');
    process.exit(1);
  }
  // Project admission refuses group-writable paths, so a permissive host umask fails valid fixtures.
  process.umask(0o022);
  if(logDir)await mkdir(logDir,{recursive:true});
  const failures=[],empty=[],skippedFiles=[];
  let skippedTests=0,testsPassed=0;
  const guard=process.env.AC_CI_LEAK_GUARD!=='0';
  if(!guard)console.log('AVISO guarda de resíduos desligada (AC_CI_LEAK_GUARD=0): só para depuração.');
  const locations=leakLocations(root);
  if(logDir)locations.ignored.push(logDir);
  const leaks=[];
  for(const name of included){
    const before=guard?leakSnapshot(locations):null;
    const started=Date.now(),result=await runFile(name);
    if(guard)for(const item of leakDiff(before,leakSnapshot(locations)))leaks.push({file:name,item});
    const status=fileVerdict(result),summary=tapSummary(result.output);
    const counts=summary?` (${summary.pass}/${summary.tests} aprovados${summary.skipped||summary.todo?`, ${summary.skipped+summary.todo} pulados`:''})`:'';
    console.log(`${status} ${name} ${Math.round((Date.now()-started)/1000)}s${counts}`);
    if(logDir)await writeFile(join(logDir,name+'.log'),result.output);
    if(summary){testsPassed+=summary.pass;if(summary.skipped+summary.todo){skippedTests+=summary.skipped+summary.todo;skippedFiles.push(name);}}
    if(status==='VAZIO')empty.push(name);
    if(status!=='ok')failures.push(name);
  }
  console.log(selectionReport(plan,{failed:failures,ran:included.length,empty,skippedTests,skippedFiles}));
  console.log(JSON.stringify({passed:included.length-failures.length,failed:failures,empty,testsPassed,skippedTests,excluded,skipped:plan.skipped.map(item=>item.name),laboratory:plan.laboratory.map(item=>item.name)}));
  // Só conta o que continua lá no fim. Outra suíte rodando ao mesmo tempo também cria /tmp/ac-* e costuma
  // apagar logo depois; por isso a guarda espera até 10 s antes de culpar esta suíte.
  let left=[];
  if(guard){
    for(let attempt=0;attempt<6;attempt++){
      if(attempt>0)await new Promise(done=>setTimeout(done,2000));
      const remaining=leakSnapshot(locations);
      left=leaks.filter(({item})=>remaining.has(item));
      if(left.length===0)break;
    }
  }
  if(left.length)console.error(leakReport(left));
  process.exitCode=failures.length||left.length?1:0;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
