// Runs every tests/*.test.ts that has no host side effects, one process per file.
// Files that drive Docker, SSH or a live Happier server are listed as excluded,
// never silently dropped; they belong to their own compose profiles.
import {spawn} from 'node:child_process';
import pg from 'pg';
import {existsSync} from 'node:fs';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const timeoutMs=Number(process.env.AC_CI_TEST_TIMEOUT_MS??180_000);
const logDir=process.env.AC_CI_LOG_DIR?resolve(process.env.AC_CI_LOG_DIR):null;
const listOnly=process.argv.includes('--list');
const hostEffect=[
  /\bphysical\b/i,
  /['"`]docker['"`]/,
  /\bdocker\s+(?:run|rm|compose|exec|network|volume|inspect|ps|kill|stop)\b/,
  /['"`]ssh(?:d|-keygen)?['"`]/,
  /compose\.[a-z0-9-]+\.yml/,
  /remoteDevelopmentLab/,
  /AC_TEST_HAPPIER_URL/,
];
// These load the Happier boundary at runtime and need the built workspace packages.
const happierWorkspaceBuilt=existsSync(join(root,'upstream/happier/packages/cli-common/dist/providers/index.js'));
const needsHappierBuild=new Set(['notifications.test.ts','r3-secret-surfaces.test.ts','r4-notifications-cli-happier.test.ts']);
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

export async function classify(){
  const names=(await readdir(join(root,'tests'))).filter(name=>name.endsWith('.test.ts')).sort();
  const included=[],excluded=[];
  for(const name of names){
    const source=await readFile(join(root,'tests',name),'utf8');
    const blocked=hostEffect.some(pattern=>pattern.test(name)||pattern.test(source))||(needsHappierBuild.has(name)&&!happierWorkspaceBuilt);
    (blocked?excluded:included).push(name);
  }
  return {included,excluded};
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

const {included,excluded}=await classify();
if(listOnly){
  console.log(JSON.stringify({included,excluded},null,1));
  process.exit(0);
}
if(!process.env.AC_TEST_DATABASE_URL)throw Error('ISOLATED_DATABASE_REQUIRED');
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
console.log(JSON.stringify({passed:included.length-failures.length,failed:failures,excluded}));
process.exitCode=failures.length?1:0;
