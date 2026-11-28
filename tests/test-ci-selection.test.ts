import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {fileVerdict,listTestFiles,planSelection,selectTests,selectionReport,tapSummary,unknownOnlyNames} from '../scripts/test-ci-selection.mjs';
// @ts-expect-error script em JavaScript puro
import {leakDiff,leakLocations,leakSnapshot} from '../scripts/test-ci.mjs';

const root=resolve(import.meta.dirname,'..');
const cleanEnv=()=>{const env={...process.env};delete env.AC_CI_ONLY;delete env.AC_CI_INCLUDE_HOST;return env;};
const base={executar:['a.test.ts','b.test.ts'],requer:{},laboratorio:{'c.test.ts':'precisa de Docker real'},excluido:{'d.test.ts':'obsoleto, substituído por a'}};

test('a classification that names every file has no errors and splits the files by class',()=>{
  const plan=planSelection(['a.test.ts','b.test.ts','c.test.ts','d.test.ts'],base);
  assert.deepEqual(plan.errors,[]);
  assert.deepEqual(plan.executed,['a.test.ts','b.test.ts']);
  assert.deepEqual(plan.laboratory,[{name:'c.test.ts',reason:'precisa de Docker real'}]);
  assert.deepEqual(plan.excluded,[{name:'d.test.ts',reason:'obsoleto, substituído por a'}]);
});

test('a new test file nobody classified is an error, never silently skipped',()=>{
  const plan=planSelection(['a.test.ts','b.test.ts','c.test.ts','d.test.ts','novo.test.ts'],base);
  assert.deepEqual(plan.errors,['UNCLASSIFIED_TEST novo.test.ts']);
  assert.ok(!plan.executed.includes('novo.test.ts'));
});

test('a classified file that no longer exists, a duplicate and a missing reason are errors',()=>{
  const plan=planSelection(['a.test.ts','b.test.ts'],{executar:['a.test.ts','b.test.ts','a.test.ts'],laboratorio:{'x.test.ts':'curto'},excluido:{}});
  assert.ok(plan.errors.includes('DUPLICATE_CLASSIFICATION a.test.ts'));
  assert.ok(plan.errors.includes('CLASSIFIED_FILE_MISSING x.test.ts'));
  assert.ok(plan.errors.includes('REASON_REQUIRED x.test.ts'));
});

test('a requirement that is unmet puts the file in the skipped list with its reason',()=>{
  const classification={...base,requer:{'a.test.ts':'env:AC_TEST_FIXTURE_URL','b.test.ts':'env:AC_TEST_OTHER_URL'}};
  const names=['a.test.ts','b.test.ts','c.test.ts','d.test.ts'];
  const without=planSelection(names,classification,{env:{}});
  assert.deepEqual(without.executed,[]);
  assert.deepEqual(without.skipped.map(item=>item.name),['a.test.ts','b.test.ts']);
  assert.match(without.skipped[0]!.reason,/AC_TEST_FIXTURE_URL/);
  assert.match(without.skipped[1]!.reason,/AC_TEST_OTHER_URL/);
  const withEverything=planSelection(names,classification,{env:{AC_TEST_FIXTURE_URL:'http://127.0.0.1:1',AC_TEST_OTHER_URL:'http://127.0.0.1:2'}});
  assert.deepEqual(withEverything.executed,['a.test.ts','b.test.ts']);
  assert.deepEqual(withEverything.skipped,[]);
});

test('laboratory files run only with the host option and never the excluded ones',()=>{
  const names=['a.test.ts','b.test.ts','c.test.ts','d.test.ts'];
  const plan=planSelection(names,base,{includeHost:true});
  assert.deepEqual(plan.executed,['a.test.ts','b.test.ts','c.test.ts']);
  assert.deepEqual(plan.laboratory,[]);
  assert.deepEqual(plan.excluded.map(item=>item.name),['d.test.ts']);
});

test('the report lists what ran, what was skipped and what depends on the laboratory',()=>{
  const plan=planSelection(['a.test.ts','b.test.ts','c.test.ts','d.test.ts'],{...base,requer:{'b.test.ts':'env:AC_TEST_FIXTURE_URL'}},{env:{}});
  const report=selectionReport(plan,{failed:['a.test.ts']});
  assert.match(report,/Executados: 1/);
  assert.match(report,/pulado b\.test\.ts: variável AC_TEST_FIXTURE_URL ausente/);
  assert.match(report,/laboratório c\.test\.ts: precisa de Docker real/);
  assert.match(report,/excluído d\.test\.ts: obsoleto/);
  assert.match(report,/Falharam: a\.test\.ts/);
});

test('every test file in this checkout is classified, and the examples the audit named now run',async()=>{
  const plan=await selectTests(root,{env:{}});
  assert.deepEqual(plan.errors,[]);
  const files=await listTestFiles(root);
  const accounted=new Set([...plan.executed,...plan.skipped.map(item=>item.name),...plan.laboratory.map(item=>item.name),...plan.excluded.map(item=>item.name)]);
  assert.deepEqual(files.filter(name=>!accounted.has(name)),[]);
  for(const name of ['manager-discipline.test.ts','personal-backup.test.ts','verify-db.test.ts'])assert.ok(plan.executed.includes(name),name);
  for(const item of [...plan.laboratory,...plan.excluded])assert.ok(item.reason.length>=8,item.name);
});

test('the runner refuses to start when a new test file has no classification',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'ac-ci-selection-'));
  try{
    mkdirSync(join(sandbox,'scripts'));mkdirSync(join(sandbox,'tests'));
    for(const file of ['test-ci.mjs','test-ci-selection.mjs','test-ci-classification.json'])copyFileSync(join(root,'scripts',file),join(sandbox,'scripts',file));
    symlinkSync(join(root,'node_modules'),join(sandbox,'node_modules'));
    writeFileSync(join(sandbox,'scripts','test-ci-classification.json'),JSON.stringify({executar:['conhecido.test.ts'],laboratorio:{},excluido:{}}));
    writeFileSync(join(sandbox,'tests','conhecido.test.ts'),'');
    writeFileSync(join(sandbox,'tests','novo.test.ts'),'');
    const result=spawnSync(process.execPath,[join(sandbox,'scripts','test-ci.mjs'),'--list'],{encoding:'utf8',env:cleanEnv()});
    assert.equal(result.status,2);
    assert.match(result.stderr,/UNCLASSIFIED_TEST novo\.test\.ts/);
    writeFileSync(join(sandbox,'scripts','test-ci-classification.json'),JSON.stringify({executar:['conhecido.test.ts','novo.test.ts'],laboratorio:{},excluido:{}}));
    const fixed=spawnSync(process.execPath,[join(sandbox,'scripts','test-ci.mjs'),'--list'],{encoding:'utf8',env:cleanEnv()});
    assert.equal(fixed.status,0);
    assert.deepEqual(JSON.parse(fixed.stdout).included,['conhecido.test.ts','novo.test.ts']);
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});

const tap=(pass:number,skipped=0,fail=0)=>`TAP version 13\nok 1 - x\n1..${pass+skipped+fail}\n# tests ${pass+skipped+fail}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n# duration_ms 5\n`;

test('a file counts as ok only when at least one test really passed',()=>{
 assert.deepEqual(tapSummary(tap(3,1)),{tests:4,pass:3,fail:0,skipped:1,todo:0,cancelled:0});
 assert.equal(fileVerdict({code:0,timedOut:false,output:tap(3,1)}),'ok');
 assert.equal(fileVerdict({code:0,timedOut:false,output:tap(0,2)}),'VAZIO');
 assert.equal(fileVerdict({code:0,timedOut:false,output:tap(0,0)}),'VAZIO');
 assert.equal(fileVerdict({code:0,timedOut:false,output:'no summary at all'}),'VAZIO');
 assert.equal(fileVerdict({code:1,timedOut:false,output:tap(2,0,1)}),'FAIL');
 assert.equal(fileVerdict({code:0,timedOut:false,output:tap(2,0,1)}),'FAIL');
 assert.equal(fileVerdict({code:null,timedOut:true,output:''}),'TIMEOUT');
 // A test that prints a fake summary line before the real one does not win: the last summary counts.
 assert.equal(fileVerdict({code:0,timedOut:false,output:'# pass 9\n'+tap(0,1)}),'VAZIO');
});

test('AC_CI_ONLY names outside the executable list are reported, so a typo cannot pass as a green run',()=>{
 assert.deepEqual(unknownOnlyNames(null,['a.test.ts']),[]);
 assert.deepEqual(unknownOnlyNames(new Set(['a.test.ts','typo.test.ts','c.test.ts']),['a.test.ts','b.test.ts']),['c.test.ts','typo.test.ts']);
});

test('the report sums skipped tests and names the empty files',()=>{
 const plan=planSelection(['a.test.ts','b.test.ts','c.test.ts','d.test.ts'],base,{});
 const report=selectionReport(plan,{ran:2,failed:['b.test.ts'],empty:['b.test.ts'],skippedTests:3,skippedFiles:['a.test.ts']});
 assert.match(report,/Testes pulados dentro dos arquivos executados: 3 \(a\.test\.ts\)/);
 assert.match(report,/Sem nenhum teste aprovado \(VAZIO\): b\.test\.ts/);
});

test('the leak guard flags only new ac-* temp entries, new projects, new docker refs and changed repository files',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'ac-ci-guard-'));
  try{
    const repo=join(sandbox,'repo'),temporary=join(sandbox,'tmp'),refs=join(sandbox,'refs');
    for(const directory of [repo,temporary,join(refs,'daemon')])mkdirSync(directory,{recursive:true});
    const git=(...args:string[])=>spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
    git('init','-q');writeFileSync(join(repo,'versionado.txt'),'a');git('add','.');
    git('-c','user.name=t','-c','user.email=t@example.invalid','commit','-qm','base');
    mkdirSync(join(temporary,'ac-antigo'));writeFileSync(join(refs,'daemon','antigo.json'),'{}');
    writeFileSync(join(repo,'sujo-antes.txt'),'x');
    const locations={...leakLocations(repo,{AC_DOCKER_REFS_DIR:refs}),temporary:[temporary]};
    const before=leakSnapshot(locations);
    assert.deepEqual(leakDiff(before,leakSnapshot(locations)),[],'nada mudou');
    mkdirSync(join(temporary,'ac-novo'));mkdirSync(join(temporary,'outro-projeto'));
    mkdirSync(join(repo,'.state','projects','ac-repo'),{recursive:true});
    writeFileSync(join(refs,'daemon','novo.json'),'{}');
    writeFileSync(join(repo,'versionado.txt'),'mudou');
    assert.deepEqual(leakDiff(before,leakSnapshot(locations)),[
      `git versionado.txt`,
      `projeto ${join(repo,'.state','projects','ac-repo')}`,
      `referencia ${join(refs,'daemon','novo.json')}`,
      `tmp ${join(temporary,'ac-novo')}`,
    ],'o que já existia antes (ac-antigo, antigo.json, sujo-antes.txt) e o que não é ac-* ficam de fora');
    // .state é ignorado pelo git do produto; aqui não, mas o diretório só entra como projeto, nunca apagado pela guarda.
    assert.ok(existsSync(join(temporary,'ac-antigo')));
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});

test('the runner fails when a test file leaves residue and names the file; AC_CI_LEAK_GUARD=0 only warns',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'ac-ci-guard-run-'));
  try{
    mkdirSync(join(sandbox,'scripts'));mkdirSync(join(sandbox,'tests'));
    for(const file of ['test-ci.mjs','test-ci-selection.mjs'])copyFileSync(join(root,'scripts',file),join(sandbox,'scripts',file));
    symlinkSync(join(root,'node_modules'),join(sandbox,'node_modules'));
    writeFileSync(join(sandbox,'.gitignore'),'node_modules\n');
    writeFileSync(join(sandbox,'scripts','test-ci-classification.json'),JSON.stringify({executar:['limpo.test.ts','sujo.test.ts'],laboratorio:{},excluido:{}}));
    writeFileSync(join(sandbox,'tests','limpo.test.ts'),"import test from 'node:test';test('limpo',()=>{});\n");
    writeFileSync(join(sandbox,'tests','sujo.test.ts'),"import test from 'node:test';import {mkdirSync,writeFileSync} from 'node:fs';"+
      "test('sujo',()=>{mkdirSync('.state/projects/ac-sobra',{recursive:true});writeFileSync('versionado.txt','mudou');});\n");
    writeFileSync(join(sandbox,'versionado.txt'),'original');
    const git=(...args:string[])=>spawnSync('git',['-C',sandbox,...args],{encoding:'utf8'});
    git('init','-q');git('add','.');git('-c','user.name=t','-c','user.email=t@example.invalid','commit','-qm','base');
    mkdirSync(join(sandbox,'tmp'));
    const env:Record<string,string|undefined>={...cleanEnv(),AC_TEST_DATABASE_URL:'postgresql://unused@127.0.0.1:1/ac_unused',
      AC_DOCKER_REFS_DIR:join(sandbox,'refs'),AC_CI_LEAK_TMP_DIRS:join(sandbox,'tmp')};
    // Rodando dentro de node --test, o filho herdaria o contexto do executor e não imprimiria o TAP.
    delete env.NODE_TEST_CONTEXT;
    const run=(extra:Record<string,string>={})=>spawnSync(process.execPath,[join(sandbox,'scripts','test-ci.mjs')],{cwd:sandbox,encoding:'utf8',env:{...env,...extra}});
    const dirty=run();
    assert.equal(dirty.status,1,dirty.stdout+dirty.stderr);
    assert.match(dirty.stderr,/sujo\.test\.ts: projeto .*ac-sobra/);
    assert.match(dirty.stderr,/sujo\.test\.ts: git versionado\.txt/);
    assert.doesNotMatch(dirty.stderr,/limpo\.test\.ts:/);
    const off=run({AC_CI_LEAK_GUARD:'0'});
    assert.equal(off.status,0,off.stdout+off.stderr);
    assert.match(off.stdout,/guarda de resíduos desligada/);
    // O resíduo que já estava lá antes da suíte não é culpa dela.
    git('checkout','--','versionado.txt');
    writeFileSync(join(sandbox,'tests','sujo.test.ts'),"import test from 'node:test';test('agora limpo',()=>{});\n");
    git('-c','user.name=t','-c','user.email=t@example.invalid','commit','-qam','limpo');
    const clean=run();
    assert.equal(clean.status,0,clean.stdout+clean.stderr);
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});
