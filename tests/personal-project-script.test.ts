import {describe,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const script=join(import.meta.dirname,'..','scripts/personal-project.mjs');

/** Runs the real script with a fake `node` on PATH: the last step (personal-connect) behaves as `last` says. */
async function runScript(last:string){
 const base=await realpath(await mkdtemp(join(tmpdir(),'ac-pscript-')));
 try{
  const repo=join(base,'repo'),home=join(base,'home'),bin=join(base,'bin');
  await mkdir(repo);await mkdir(home);await mkdir(bin);
  const git=(...a:string[])=>spawnSync('git',['-C',repo,...a],{stdio:'ignore'});
  git('init','-q','-b','main');git('-c','user.name=F','-c','user.email=f@invalid','commit','--allow-empty','-m','base');
  const marker=join(base,'steps.log');
  await writeFile(join(bin,'node'),`#!/bin/sh
echo "$*" >> "${marker}"
case "$*" in
 *native-setup*) echo '{"state":"ready"}'; exit 0;;
 *personal-connect*) ${last};;
 *) exit 0;;
esac
`);
  await chmod(join(bin,'node'),0o755);
  const sha='sha256:'+'a'.repeat(64);
  const result=spawnSync(process.execPath,[script,repo,'--db','postgresql://u:p@127.0.0.1:1/x','--label','probe','--local'],{
   encoding:'utf8',env:{...process.env,HOME:home,PATH:`${bin}:${process.env.PATH}`,AC_NATIVE_PLANNING_IMAGE:sha,AC_NATIVE_WORKER_IMAGE:sha,AC_NATIVE_TOOLS_IMAGE:sha},
  });
  return {result,steps:await readFile(marker,'utf8').catch(()=>'')};
 }finally{await rm(base,{recursive:true,force:true});}
}

describe('personal-project script exit handling',{concurrency:false},()=>{
test('all steps with status 0 print the conclusion and exit 0',async()=>{
 const {result,steps}=await runScript('exit 0');
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/Pronto\./);
 assert.match(steps,/personal-connect/);
});
test('the last step exiting 4 prints no conclusion and exits non-zero',async()=>{
 const {result}=await runScript('exit 4');
 assert.equal(result.status,4);
 assert.doesNotMatch(result.stdout,/Pronto\./);
});
test('the last step killed by a signal (status null) prints no conclusion and exits non-zero',async()=>{
 const {result,steps}=await runScript('kill -KILL $$');
 assert.match(steps,/personal-connect/);
 assert.notEqual(result.status,0);
 assert.doesNotMatch(result.stdout,/Pronto\./);
});
});
