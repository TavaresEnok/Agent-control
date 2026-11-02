import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('synthetic correction consumes rejected blob and decision while preserving the original base',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ac-correction-')),worker=resolve('scripts/synthetic-worker.mjs');
 const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
 try{
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(dir,'base.txt'),'base\n');git('add','base.txt');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  mkdirSync(join(dir,'src'));const prior='failed synthetic candidate\n';writeFileSync(join(dir,'src/result.txt'),prior);
  git('add','src/result.txt');git('commit','-qm','candidate');const priorCommit=git('rev-parse','HEAD'),priorTree=git('rev-parse','HEAD^{tree}');
  git('update-ref','refs/agent-control/correction-source',priorCommit);git('checkout','-q','--detach',base);
  const operation=randomUUID(),decisionDigest='a'.repeat(64),payload={outputPath:'src/result.txt',priorCommit,priorTree,decisionDigest};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64');
  const run=spawnSync(process.execPath,[worker,operation,'src/result.txt','--correction',encoded],{cwd:dir,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(git('rev-parse','HEAD^'),base);
  assert.equal(readFileSync(join(dir,'src/result.txt'),'utf8'),`Synthetic corrected effect ${operation}\nPrior content sha256 ${createHash('sha256').update(prior).digest('hex')}\nDecision ${decisionDigest}\n`);
  assert.notEqual(git('rev-parse','HEAD^{tree}'),priorTree);
  git('checkout','-q','--detach',base);
  const bad=Buffer.from(JSON.stringify({...payload,priorTree:'0'.repeat(40)})).toString('base64');
  assert.notEqual(spawnSync(process.execPath,[worker,randomUUID(),'src/result.txt','--correction',bad],{cwd:dir}).status,0);
  assert.equal(git('rev-parse','HEAD'),base);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
