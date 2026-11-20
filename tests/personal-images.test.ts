import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {buildImages,discardContext,readProjectId,registerReplaced,replacedImages,type Run} from '../scripts/personal-images.mjs';

const root=join(import.meta.dirname,'..');
const id=(c:string)=>'sha256:'+c.repeat(64);

/** A fake Docker daemon shared with "another project": an untagged image and build cache that are not ours. */
function daemon(){
 const state={tags:new Map<string,string>(),images:new Set<string>([id('7')]),cache:new Set(['other-project-cache']),commands:[] as string[][],counter:0,failRegistration:false};
 const run:Run=(command,args)=>{
  state.commands.push([command,...args]);
  if(command==='docker'&&args[0]==='build'){
   const tag=args[2]!,next=id(String.fromCharCode(97+state.counter++));
   state.tags.set(tag,next);state.images.add(next);
   state.cache.add('layer-of-'+tag);
   return {status:0,stdout:''};
  }
  if(command==='docker'&&args[0]==='image'&&args[1]==='inspect'){
   const found=state.tags.get(args[2]!);
   return found?{status:0,stdout:found+'\n'}:{status:1,stdout:''};
  }
  // What the old script did, on the whole daemon: every untagged image and all cache older than the build.
  if(command==='docker'&&args[0]==='image'&&args[1]==='prune'){for(const image of [...state.images])if(![...state.tags.values()].includes(image))state.images.delete(image);return {status:0};}
  if(command==='docker'&&args[0]==='builder'&&args[1]==='prune'){state.cache.clear();return {status:0};}
  if(command===process.execPath&&args.includes('--registrar-imagem'))return {status:state.failRegistration?1:0,stdout:''};
  return {status:0,stdout:''};
 };
 return {state,run};
}

test('a rebuild removes only the build contexts this command created and never prunes the shared Docker daemon',()=>{
 const {state,run}=daemon();
 const stateRoot=mkdtempSync(join(tmpdir(),'personal-images-'));
 try{
  const mine=['native-planning-image-abc123','native-execution-image-def456','native-tools-image-0a1b2c'].map(name=>join(stateRoot,name));
  const foreign=join(stateRoot,'native-planning-image-with.dot'),otherRoot=mkdtempSync(join(tmpdir(),'elsewhere-')),outside=join(otherRoot,'native-planning-image-abc123');
  for(const dir of [...mine,foreign,outside])mkdirSync(dir,{recursive:true});
  const builds=[{tag:'ac-native-planning:personal',context:mine[0]!,kind:'planning'},{tag:'ac-native-execution:personal',context:mine[1]!,kind:'execution'},{tag:'ac-native-tools:personal',context:mine[2]!,kind:'tools'}];
  // Previous images of the three tags, left by an earlier rebuild.
  state.tags.set('ac-native-planning:personal',id('1'));state.tags.set('ac-native-execution:personal',id('2'));state.tags.set('ac-native-tools:personal',id('3'));
  for(const old of ['1','2','3'])state.images.add(id(old));
  const built=buildImages({builds,stateRoot,run});
  for(const dir of mine)assert.equal(existsSync(dir),false,'own contexts are removed');
  assert.equal(existsSync(foreign),true,'a name outside the pattern is never removed');
  assert.equal(discardContext(outside,stateRoot),false);
  assert.equal(existsSync(outside),true,'a directory outside the state root is never removed');
  // Nothing of the second project went away, and no global cleanup command was issued.
  assert.ok(state.images.has(id('7')),'untagged image of another project');
  assert.ok(state.cache.has('other-project-cache'),'build cache of another project');
  assert.deepEqual(state.commands.filter(cmd=>cmd.includes('prune')),[]);
  // The producer records what it replaced, so retention can later prove and remove exactly those ids.
  assert.deepEqual(replacedImages(built).map(item=>item.imageId).sort(),[id('1'),id('2'),id('3')]);
  rmSync(otherRoot,{recursive:true,force:true});
 }finally{rmSync(stateRoot,{recursive:true,force:true});}
});

test('an unchanged tag, a first build and a failed build register nothing, and a failed build still removes its context',()=>{
 const {state,run}=daemon();
 const stateRoot=mkdtempSync(join(tmpdir(),'personal-images-'));
 try{
  const context=join(stateRoot,'native-tools-image-zz');mkdirSync(context);
  const built=[{tag:'t',kind:'tools',previous:undefined,current:id('a')},{tag:'u',kind:'tools',previous:id('b'),current:id('b')},{tag:'v',kind:'tools',previous:id('c'),current:undefined}];
  assert.deepEqual(replacedImages(built),[]);
  const failing:Run=(command,args,options)=>command==='docker'&&args[0]==='build'?{status:1}:run(command,args,options);
  assert.throws(()=>buildImages({builds:[{tag:'x',context,kind:'tools'}],stateRoot,run:failing}),/BUILD_FAILED/);
  assert.equal(existsSync(context),false);
  assert.equal(state.commands.some(cmd=>cmd.includes('prune')),false);
 }finally{rmSync(stateRoot,{recursive:true,force:true});}
});

test('replaced images are registered by the product command for the installation project; a registration failure is reported, not fatal',()=>{
 const {state,run}=daemon();
 const base=mkdtempSync(join(tmpdir(),'personal-images-'));
 try{
  const file=join(base,'installation.json'),project=crypto.randomUUID();
  writeFileSync(file,JSON.stringify({project:{id:project,label:'x',repo:base,owner:'o'},projects:[]}));
  assert.equal(readProjectId(file),project);
  const replaced=[{tag:'ac-native-planning:personal',imageId:id('1')},{tag:'ac-native-tools:personal',imageId:id('3')}];
  const ok=registerReplaced({run,root,installationFile:file,projectId:project,replaced});
  assert.deepEqual(ok,{registered:[id('1'),id('3')],failed:[]});
  const calls=state.commands.filter(cmd=>cmd.includes('--registrar-imagem'));
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0]!.slice(-9),['src/personal-maintenance-cli.ts',file,'--registrar-imagem','--projeto',project,'--modulo','native-runtime','--imagem',id('1')]);
  state.failRegistration=true;
  assert.deepEqual(registerReplaced({run,root,installationFile:file,projectId:project,replaced}),{registered:[],failed:[id('1'),id('3')]});
  assert.throws(()=>readProjectId(join(base,'missing.json')));
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('manual and automatic rebuilds share one script and no Docker-wide prune remains in the code that runs',()=>{
 assert.match(readFileSync(join(root,'package.json'),'utf8'),/"personal:images": "node scripts\/personal-images\.mjs"/);
 assert.match(readFileSync(join(root,'src/personal-watch.ts'),'utf8'),/'run','personal:images'/);
 for(const file of ['scripts/personal-images.mjs','src/personal-watch.ts','src/personal-maintenance.ts']){
  const text=readFileSync(join(root,file),'utf8');
  assert.doesNotMatch(text,/'image','prune'|'builder','prune'|'system','prune'|image prune|builder prune|system prune/,file);
 }
});
