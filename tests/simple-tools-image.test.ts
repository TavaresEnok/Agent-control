import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {availableSimpleToolsImage,commonToolTag} from '../src/simple-tools-image.ts';
import {selectModuleCollector} from '../src/verification-modules-run.ts';
import {moduleOwnerLabelArgs} from '../src/verification-modules-container.ts';
import {verifyExamArguments} from '../src/verify-image.ts';

const id=(c:string)=>'sha256:'+c.repeat(64);
const common=id('c'),own=id('1');

/** A fake `docker` first on PATH that knows only the given references (an image id resolves to itself, a tag to its id). */
async function withDocker(known:Record<string,string>,run:(dirs:{data:string;root:string})=>Promise<void>){
 const base=await mkdtemp(join(tmpdir(),'ac-simple-tools-'));
 const bin=join(base,'bin'),data=join(base,'data'),root=join(base,'product');
 await mkdir(bin);await mkdir(data,{mode:0o700});await mkdir(join(root,'deploy','modules','qa'),{recursive:true});
 await writeFile(join(root,'deploy','modules','qa','digest.txt'),own+'\n');
 const cases=Object.entries(known).map(([reference,image])=>`  '${reference}') echo '${image}'; exit 0;;`).join('\n');
 await writeFile(join(bin,'docker'),`#!/bin/sh\nfor last; do :; done\ncase "$last" in\n${cases}\nesac\nexit 1\n`);
 await chmod(join(bin,'docker'),0o755);
 const path=process.env.PATH;
 process.env.PATH=bin+':'+path;
 try{await run({data,root});}
 finally{process.env.PATH=path;await rm(base,{recursive:true,force:true});}
}

const input=(dirs:{data:string;root:string})=>({module:'qa',isolation:'simple',dataDirectory:dirs.data,rootDir:dirs.root}) as unknown as Parameters<typeof selectModuleCollector>[0];

test('a module in the simple isolation uses the pinned common image',async()=>{
 await withDocker({[common]:common,[own]:own},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  assert.deepEqual(await selectModuleCollector(input(dirs)),{image:common,commonTools:true});
 });
});

test('without the common pin the module uses its own pinned image, even when the common tag exists locally',async()=>{
 await withDocker({[commonToolTag]:common,[common]:common,[own]:own},async dirs=>{
  assert.equal(await availableSimpleToolsImage(dirs.data),undefined);
  assert.deepEqual(await selectModuleCollector(input(dirs)),{image:own});
 });
});

test('a pinned common image missing from Docker falls back to the module image',async()=>{
 await withDocker({[own]:own},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  assert.deepEqual(await selectModuleCollector(input(dirs)),{image:own});
 });
});

test('with the common image and the module image both gone from Docker the routing falls through to the host collector, then refuses cleanly',async()=>{
 await withDocker({},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  // Performance never has a host collector: the end of the order is a refusal, not a crash.
  await mkdir(join(dirs.root,'deploy','modules','desempenho'),{recursive:true});
  await writeFile(join(dirs.root,'deploy','modules','desempenho','digest.txt'),own+'\n');
  await assert.rejects(selectModuleCollector({...input(dirs),module:'desempenho'}),/SIMPLE_TOOLS_IMAGE_MISSING/);
  // Another module either finds the collector installed on this host or is refused the same way.
  const qa=await selectModuleCollector(input(dirs)).catch((error:Error)=>error);
  if(qa instanceof Error)assert.match(qa.message,/SIMPLE_TOOLS_IMAGE_MISSING/);
  else assert.ok(qa.hostCollector&&qa.image?.startsWith('host-qa@sha256:'),JSON.stringify(qa));
 });
});

test('a remeasurement keeps the image of its original run; once the retention removed it, the run is refused with a clear code, never a crash or another image',async()=>{
 const old=id('0');
 await withDocker({[common]:common,[own]:own,[old]:old},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  assert.deepEqual(await selectModuleCollector({...input(dirs),image:old}),{image:old,commonTools:false});
 });
 await withDocker({[common]:common,[own]:own},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:common}),{mode:0o600});
  await assert.rejects(selectModuleCollector({...input(dirs),image:old}),(error:unknown)=>error instanceof Refusal&&error.code==='VERIFY_RECHECK_IMAGE_GONE'&&error.status===409);
  // A new exam of the module still runs, on the current common image.
  assert.deepEqual(await selectModuleCollector(input(dirs)),{image:common,commonTools:true});
 });
 // Strict isolation: the same clear refusal, before any run row, never VERIFY_MODULE_IMAGE_MISSING at container creation.
 await withDocker({[own]:own,[old]:old},async dirs=>{
  assert.deepEqual(await selectModuleCollector({...input(dirs),isolation:'strict',image:old,remeasureOf:'5f1d2a8e-3c4b-4d6e-8f9a-0b1c2d3e4f50'}),{image:old});
 });
 await withDocker({[own]:own},async dirs=>{
  await assert.rejects(selectModuleCollector({...input(dirs),isolation:'strict',image:old,remeasureOf:'5f1d2a8e-3c4b-4d6e-8f9a-0b1c2d3e4f50'}),(error:unknown)=>error instanceof Refusal&&error.code==='VERIFY_RECHECK_IMAGE_GONE'&&error.status===409);
 });
});

test('a malformed common pin is refused, never replaced by a tag',async()=>{
 await withDocker({[commonToolTag]:common},async dirs=>{
  await writeFile(join(dirs.data,'simple-tools-image.json'),JSON.stringify({image:commonToolTag}),{mode:0o600});
  await assert.rejects(availableSimpleToolsImage(dirs.data),/VERIFY_IMAGE_UNPINNED/);
 });
});

test('module and verify exam containers carry the installation, project and kind labels',()=>{
 const project='61713a2a-3955-4b28-875a-e906d301a85d';
 const labels=moduleOwnerLabelArgs({dataDirectory:'/home/app/.agent-control/ispagent',projectId:project,roundId:project},'arquitetura');
 assert.deepEqual(labels,['--label','com.agent-control.installation=ispagent','--label',`com.agent-control.project=${project}`,'--label','com.agent-control.kind=exam-arquitetura']);
 assert.deepEqual(moduleOwnerLabelArgs(undefined,'qa'),[]);
 const args=verifyExamArguments({image:own,repository:'/srv/repo',databases:'/srv/db',output:'/srv/out',memoryBytes:1<<30,nanoCpus:1e9,pidsLimit:64,labels});
 const at=args.indexOf('--entrypoint');
 assert.deepEqual(args.slice(at-labels.length,at),labels);
 assert.ok(args.indexOf(own)>at);
});
