import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

// Contract between the product adapters and the compiled Cezar artifact that is actually distributed.
// Every value import from upstream/cezar/packages/cezar/dist in src/ must resolve to an export that exists.
// Without the compiled dist (a bare checkout) the load test is skipped with a visible reason.
const root=resolve(import.meta.dirname,'..');
const distRoot=join(root,'upstream/cezar/packages/cezar/dist');
const IMPORT=/import\s+(type\s+)?\{([^}]+)\}\s+from\s+'(\.\.\/upstream\/cezar\/packages\/cezar\/dist\/[^']+\.js)'/g;

export function cezarDistImports(source:string){
  const found:{file:string;names:string[]}[]=[];
  for(const match of source.matchAll(IMPORT)){
    if(match[1])continue;
    const names=match[2]!.split(',').map(part=>part.trim()).filter(Boolean).filter(part=>!part.startsWith('type ')).map(part=>part.split(/\s+as\s+/)[0]!.trim());
    found.push({file:match[3]!.replace('../upstream/cezar/packages/cezar/dist/',''),names});
  }
  return found;
}

function adapterImports(){
  const merged=new Map<string,Set<string>>();
  for(const name of readdirSync(join(root,'src')).filter(file=>file.endsWith('.ts'))){
    for(const entry of cezarDistImports(readFileSync(join(root,'src',name),'utf8'))){
      const set=merged.get(entry.file)??new Set<string>();
      for(const exported of entry.names)set.add(exported);
      merged.set(entry.file,set);
    }
  }
  return merged;
}

test('the extractor reads value imports and ignores type-only imports and aliases',()=>{
  const source=[
    "import { RunManager } from '../upstream/cezar/packages/cezar/dist/workflows/run.js';",
    "import type { AgentRunner } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';",
    "import {a as b,type C,d} from '../upstream/cezar/packages/cezar/dist/x/y.js';",
  ].join('\n');
  assert.deepEqual(cezarDistImports(source),[{file:'workflows/run.js',names:['RunManager']},{file:'x/y.js',names:['a','d']}]);
});

test('the product adapters import a known set of Cezar modules',()=>{
  const imports=adapterImports();
  assert.ok(imports.size>=8,`só ${imports.size} módulos do Cezar encontrados em src/`);
  assert.ok(imports.get('workflows/run.js')?.has('RunManager'));
});

test('every value import from the compiled Cezar artifact exists in the distributed build',{skip:existsSync(join(distRoot,'workflows/run.js'))?false:`artefato compilado ausente (${distRoot}); rode npm run build em upstream/cezar para habilitar este contrato`},async()=>{
  const problems:string[]=[];
  for(const [file,names] of adapterImports()){
    const path=join(distRoot,file);
    if(!existsSync(path)){problems.push(`${file}: arquivo ausente no artefato`);continue;}
    let loaded:Record<string,unknown>;
    try{loaded=await import(pathToFileURL(path).href) as Record<string,unknown>;}
    catch(error){problems.push(`${file}: não carrega (${(error as Error).message.slice(0,120)})`);continue;}
    for(const name of names)if(!(name in loaded))problems.push(`${file}: exportação ${name} ausente`);
  }
  assert.deepEqual(problems,[]);
});
