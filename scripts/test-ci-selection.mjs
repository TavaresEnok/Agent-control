// Explicit test classification for the CI runner. Every tests/*.test.ts and tests/*.test.mjs
// has to be named in scripts/test-ci-classification.json. A file nobody classified is an error,
// so a new test can never fall outside the suite by accident (the old selector guessed by regex).
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';

export const TEST_FILE=/\.test\.(?:ts|mjs)$/;
const CLASSES=['executar','laboratorio','excluido'];

/** Pure planning step. `context` says what this machine can satisfy: {includeHost,env}. */
export function planSelection(names,classification,context={}){
  const errors=[];
  const entries=new Map();
  const note=(name,klass,reason,requires)=>{
    if(entries.has(name))errors.push(`DUPLICATE_CLASSIFICATION ${name}`);
    else entries.set(name,{klass,reason,requires});
  };
  for(const name of classification.executar??[])note(name,'executar',undefined,classification.requer?.[name]);
  for(const [name,reason] of Object.entries(classification.laboratorio??{}))note(name,'laboratorio',reason,classification.requer?.[name]);
  for(const [name,reason] of Object.entries(classification.excluido??{}))note(name,'excluido',reason,undefined);
  for(const [name,reason] of [...Object.entries(classification.laboratorio??{}),...Object.entries(classification.excluido??{})]){
    if(typeof reason!=='string'||reason.trim().length<8)errors.push(`REASON_REQUIRED ${name}`);
  }
  const known=new Set(names);
  for(const name of names)if(!entries.has(name))errors.push(`UNCLASSIFIED_TEST ${name}`);
  for(const name of entries.keys())if(!known.has(name))errors.push(`CLASSIFIED_FILE_MISSING ${name}`);
  for(const name of Object.keys(classification.requer??{}))if(!entries.has(name))errors.push(`REQUIREMENT_WITHOUT_CLASS ${name}`);
  const executed=[],skipped=[],laboratory=[],excluded=[];
  const unmet=(name,requires)=>{
    if(typeof requires==='string'&&requires.startsWith('env:'))return (context.env??{})[requires.slice(4)]?null:`variável ${requires.slice(4)} ausente`;
    return null;
  };
  for(const name of [...entries.keys()].sort()){
    const entry=entries.get(name);
    if(entry.klass==='excluido'){excluded.push({name,reason:entry.reason});continue;}
    if(entry.klass==='laboratorio'&&!context.includeHost){laboratory.push({name,reason:entry.reason});continue;}
    const missing=unmet(name,entry.requires);
    if(missing){skipped.push({name,reason:missing});continue;}
    executed.push(name);
  }
  return {executed,skipped,laboratory,excluded,errors};
}

export async function loadClassification(file){
  return JSON.parse(await readFile(file,'utf8'));
}

export async function listTestFiles(root){
  return (await readdir(join(root,'tests'))).filter(name=>TEST_FILE.test(name)).sort();
}

export async function selectTests(root,context={}){
  const classification=await loadClassification(join(root,'scripts','test-ci-classification.json'));
  const names=await listTestFiles(root);
  return planSelection(names,classification,{env:process.env,...context});
}

/** Human summary for the CI log: what ran, what was skipped and why, what needs the laboratory. */
export function selectionReport(plan,results={}){
  const lines=[];
  lines.push(`Executados: ${results.ran??plan.executed.length}`);
  lines.push(`Pulados nesta máquina: ${plan.skipped.length}`);
  for(const item of plan.skipped)lines.push(`  pulado ${item.name}: ${item.reason}`);
  lines.push(`Dependentes de laboratório (rodam com AC_CI_INCLUDE_HOST=1 ou npm run test:all no laboratório): ${plan.laboratory.length}`);
  for(const item of plan.laboratory)lines.push(`  laboratório ${item.name}: ${item.reason}`);
  lines.push(`Excluídos com motivo: ${plan.excluded.length}`);
  for(const item of plan.excluded)lines.push(`  excluído ${item.name}: ${item.reason}`);
  if(results.skippedTests)lines.push(`Testes pulados dentro dos arquivos executados: ${results.skippedTests}${results.skippedFiles?.length?' ('+results.skippedFiles.join(', ')+')':''}`);
  if(results.empty?.length)lines.push(`Sem nenhum teste aprovado (VAZIO): ${results.empty.join(', ')}`);
  if(results.failed?.length)lines.push(`Falharam: ${results.failed.join(', ')}`);
  return lines.join('\n');
}

/** Counts from the node:test TAP summary (`# tests 5`, `# pass 5`, ...). Null when the file printed no summary. */
export function tapSummary(output){
  const read=key=>{
    const found=[...String(output).matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`,'gm'))].at(-1);
    return found?Number(found[1]):null;
  };
  const summary={tests:read('tests'),pass:read('pass'),fail:read('fail'),skipped:read('skipped'),todo:read('todo'),cancelled:read('cancelled')};
  return summary.tests===null||summary.pass===null?null:summary;
}

/** ok only when the process exited 0 and at least one test really passed. A file whose tests were all
 * skipped, or that printed no summary, is VAZIO: "exit 0" alone does not prove anything ran. */
export function fileVerdict(result){
  if(result.timedOut)return 'TIMEOUT';
  if(result.code!==0)return 'FAIL';
  const summary=tapSummary(result.output);
  if(!summary||summary.pass===0)return 'VAZIO';
  if(summary.fail||summary.cancelled)return 'FAIL';
  return 'ok';
}

/** AC_CI_ONLY names that are not executable files here. A typo must not turn into a green run of nothing. */
export function unknownOnlyNames(only,executed){
  if(!only)return [];
  const known=new Set(executed);
  return [...only].filter(name=>!known.has(name)).sort();
}
