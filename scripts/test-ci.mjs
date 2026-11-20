// Runs the tests that scripts/test-ci-classification.json marks as "executar", one process per file.
// The classification is explicit and versioned: a test file nobody classified is an error, and every
// file left out is listed with its reason (laboratório, excluído, pulado), never silently dropped.
// Laboratory files drive Docker, SSH or a live Happier server and belong to their own compose profiles.
import {spawn} from 'node:child_process';
import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {selectTests,selectionReport} from './test-ci-selection.mjs';

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
const excluded=[...plan.skipped,...plan.laboratory,...plan.excluded].map(item=>item.name).sort();
if(listOnly){
  console.log(JSON.stringify({included,excluded,skipped:plan.skipped,laboratory:plan.laboratory,excludedWithReason:plan.excluded},null,1));
  process.exit(0);
}
if(!process.env.AC_TEST_DATABASE_URL){
  console.error('Defina AC_TEST_DATABASE_URL com um Postgres descartável (postgresql://usuario:senha@127.0.0.1:porta/banco).');
  console.error('Os arquivos que precisam do laboratório (Docker, SSH, Happier, sudo) ficam fora e aparecem em "excluded"; rode-os com npm run test:all no laboratório.');
  process.exit(1);
}
// Project admission refuses group-writable paths, so a permissive host umask fails valid fixtures.
process.umask(0o022);
if(logDir)await mkdir(logDir,{recursive:true});
const failures=[];
for(const name of included){
  const started=Date.now(),result=await runFile(name);
  const status=result.timedOut?'TIMEOUT':result.code===0?'ok':'FAIL';
  console.log(`${status} ${name} ${Math.round((Date.now()-started)/1000)}s`);
  if(logDir)await writeFile(join(logDir,name+'.log'),result.output);
  if(status!=='ok')failures.push(name);
}
console.log(selectionReport(plan,{failed:failures,ran:included.length}));
console.log(JSON.stringify({passed:included.length-failures.length,failed:failures,excluded,skipped:plan.skipped.map(item=>item.name),laboratory:plan.laboratory.map(item=>item.name)}));
process.exitCode=failures.length?1:0;
