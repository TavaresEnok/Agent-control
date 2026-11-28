import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {buildCommonImage,builderName,candidateTag,COMMON_TAG,PROVED_COLLECTORS,REPLACED_MODULES} from '../scripts/personal-tools-image.mjs';
import {buildImages} from '../scripts/personal-images.mjs';
import {LABEL_INSTALLATION,LABEL_KIND,LABEL_PROJECT,installationName,ownerLabelArgs,ownerLabels} from '../scripts/ac-labels.mjs';

const id=(c:string)=>'sha256:'+c.repeat(64);
const project='61713a2a-3955-4b28-875a-e906d301a85d';
type Call={command:string;args:string[];env?:Record<string,string|undefined>};

/** A temporary installation and product root, with module pins in deploy/modules/<m>/digest.txt. */
function layout(){
 const base=mkdtempSync(join(tmpdir(),'ac-tools-image-'));
 const data=join(base,'minha-inst');mkdirSync(data);
 const file=join(data,'installation.json');
 writeFileSync(file,JSON.stringify({dataDirectory:data,project:{id:project}}));
 const product=join(base,'product');
 REPLACED_MODULES.forEach((module,index)=>{mkdirSync(join(product,'deploy','modules',module),{recursive:true});writeFileSync(join(product,'deploy','modules',module,'digest.txt'),id(String(index+1))+'\n');});
 return {base,data,file,product,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}

/** A fake shared daemon: the default builder and another project's builder exist; only the calls are recorded. */
function daemon(options:{failProof?:string;builderExists?:boolean;failBuild?:boolean}={}){
 const calls:Call[]=[];
 const tags=new Map<string,string>(REPLACED_MODULES.map((_,index)=>[id(String(index+1)),id(String(index+1))]));
 let builder=options.builderExists??false;
 const run=(command:string,args:string[],opts?:{env?:Record<string,string|undefined>})=>{
  calls.push({command,args,env:opts?.env});
  if(command!=='docker')return {status:0,stdout:''};
  if(args[0]==='buildx'&&args[1]==='inspect')return {status:builder?0:1,stdout:''};
  if(args[0]==='buildx'&&args[1]==='create'){builder=true;return {status:0,stdout:''};}
  if(args[0]==='buildx'&&args[1]==='bake'){if(options.failBuild)return {status:1};tags.set(opts!.env!.AC_TOOLS_TAG!,id('c'));return {status:0,stdout:''};}
  if(args[0]==='image'&&args[1]==='inspect'){
   const reference=args.at(-1)!;
   if(args[3]?.includes('simple-tools'))return {status:0,stdout:'1 6\n'};
   const found=tags.get(reference);return found?{status:0,stdout:found+'\n'}:{status:1,stdout:''};
  }
  if(args[0]==='run'){const collector=args.at(-2);return {status:collector===options.failProof?1:0};}
  if(args[0]==='tag'){tags.set(args[2]!,args[1]!);return {status:0};}
  return {status:0,stdout:''};
 };
 return {run,calls};
}

const docker=(calls:Call[],...prefix:string[])=>calls.filter(call=>call.command==='docker'&&prefix.every((item,index)=>call.args[index]===item));
const registrations=(calls:Call[])=>calls.filter(call=>call.command===process.execPath&&call.args.includes('--registrar-imagem')).map(call=>[call.args[call.args.indexOf('--modulo')+1],call.args[call.args.indexOf('--imagem')+1]]);

test('the common image is built on the dedicated builder, proved, and only then pinned; old module images become candidates',()=>{
 const l=layout(),{run,calls}=daemon();
 try{
  const result=buildCommonImage({run,installationFile:l.file,productRoot:l.product,now:new Date('2026-11-28T05:00:00Z')});
  assert.equal(result.pinned,true);
  const builder=builderName(l.file);
  assert.equal(builder,'agent-control-minha-inst');
  // The builder is created when missing, never selected as default.
  assert.deepEqual(docker(calls,'buildx','create')[0]!.args,['buildx','create','--name',builder,'--driver','docker-container','--bootstrap']);
  assert.ok(!calls.some(call=>call.args.includes('--use')));
  const bake=docker(calls,'buildx','bake');
  assert.equal(bake.length,1);
  assert.deepEqual(bake[0]!.args.slice(0,4),['buildx','bake','--builder',builder]);
  assert.equal(bake[0]!.env!.AC_TOOLS_TAG,candidateTag(l.file));
  assert.equal(bake[0]!.env!.AC_INSTALLATION,'minha-inst');
  // Every collector is proved offline and unprivileged, and the proof containers carry the ownership labels.
  const proofs=docker(calls,'run');
  assert.deepEqual(proofs.map(call=>call.args.at(-2)),PROVED_COLLECTORS);
  for(const proof of proofs){
   assert.ok(proof.args.includes('none')&&proof.args.includes('--read-only')&&proof.args.includes('65532:65532'));
   assert.ok(proof.args.includes(`${LABEL_INSTALLATION}=minha-inst`)&&proof.args.includes(`${LABEL_KIND}=exam-tools-proof`));
  }
  // The pin is written after the last proof, private, and the tag follows it.
  const pin=join(l.data,'simple-tools-image.json');
  assert.deepEqual(JSON.parse(readFileSync(pin,'utf8')),{image:id('c'),builder,provedAt:'2026-11-28T05:00:00.000Z'});
  assert.equal(statSync(pin).mode&0o777,0o600);
  const tagAt=calls.findIndex(call=>call.args[0]==='tag'),lastProof=calls.lastIndexOf(proofs.at(-1)!);
  assert.ok(tagAt>lastProof);
  assert.deepEqual(calls[tagAt]!.args,['tag',id('c'),COMMON_TAG]);
  // Only the dedicated builder's cache is pruned; nothing is removed from the daemon.
  assert.deepEqual(docker(calls,'buildx','prune').map(call=>call.args),[['buildx','prune','--builder',builder,'--all','--force']]);
  assert.ok(!calls.some(call=>['rmi','rm','prune'].includes(call.args[0]!)||(call.args[0]==='image'&&call.args[1]!=='inspect')||call.args[0]==='builder'||call.args[0]==='system'));
  assert.deepEqual(registrations(calls),REPLACED_MODULES.map((module,index)=>[module,id(String(index+1))]));
 }finally{l.cleanup();}
});

test('a failed proof pins nothing, keeps the previous pin and only registers the rejected candidate',()=>{
 const l=layout(),{run,calls}=daemon({failProof:'banco',builderExists:true});
 try{
  writeFileSync(join(l.data,'simple-tools-image.json'),JSON.stringify({image:id('9')}),{mode:0o600});
  const result=buildCommonImage({run,installationFile:l.file,productRoot:l.product});
  assert.equal(result.pinned,false);
  assert.deepEqual(result.failures,['banco']);
  assert.deepEqual(JSON.parse(readFileSync(join(l.data,'simple-tools-image.json'),'utf8')),{image:id('9')});
  assert.equal(docker(calls,'buildx','create').length,0);
  assert.equal(docker(calls,'tag').length,0);
  // The module images stay as they are: they are still the reserve.
  assert.deepEqual(registrations(calls),[['simple-tools',id('c')]]);
 }finally{l.cleanup();}
});

test('a failed build pins nothing and still prunes only the dedicated builder',()=>{
 const l=layout(),{run,calls}=daemon({failBuild:true,builderExists:true});
 try{
  assert.throws(()=>buildCommonImage({run,installationFile:l.file,productRoot:l.product}),/BUILD_FAILED/);
  assert.equal(existsSync(join(l.data,'simple-tools-image.json')),false);
  assert.equal(docker(calls,'run').length,0);
  assert.deepEqual(docker(calls,'buildx','prune').map(call=>call.args[3]),[builderName(l.file)]);
 }finally{l.cleanup();}
});

test('--manter-cache keeps the dedicated cache; a rebuild registers the previous common pin',()=>{
 const l=layout(),{run,calls}=daemon({builderExists:true});
 try{
  writeFileSync(join(l.data,'simple-tools-image.json'),JSON.stringify({image:id('9')}),{mode:0o600});
  assert.equal(buildCommonImage({run,installationFile:l.file,productRoot:l.product,keepCache:true}).pinned,true);
  assert.equal(docker(calls,'buildx','prune').length,0);
  assert.deepEqual(registrations(calls)[0],['simple-tools',id('9')]);
 }finally{l.cleanup();}
});

test('ownership labels name installation, project and kind, and refuse malformed values',()=>{
 assert.equal(installationName('/home/app/.agent-control/ispagent'),'ispagent');
 assert.deepEqual(ownerLabels({installation:'ispagent',project,kind:'exam-qa'}),{[LABEL_INSTALLATION]:'ispagent',[LABEL_PROJECT]:project,[LABEL_KIND]:'exam-qa'});
 assert.deepEqual(ownerLabelArgs({installation:'ispagent',kind:'native-tools'}),['--label',`${LABEL_INSTALLATION}=ispagent`,'--label',`${LABEL_KIND}=native-tools`]);
 for(const bad of ['a=b','x\ny','','../x'])assert.throws(()=>ownerLabels({installation:bad,kind:'k'}),/AC_LABEL_INVALID/);
});

test('native image builds carry the installation labels',()=>{
 const stateRoot=mkdtempSync(join(tmpdir(),'ac-labels-build-'));
 try{
  const commands:string[][]=[];
  buildImages({stateRoot,owner:{installation:'ispagent'},builds:[{tag:'ac-native-tools:personal',context:join(stateRoot,'native-tools-image-x'),kind:'tools'}],
   run:(command,args)=>{commands.push(args);return {status:0,stdout:args[0]==='image'?id('a'):''};}});
  const build=commands.find(args=>args[0]==='build')!;
  assert.deepEqual(build,['build','-t','ac-native-tools:personal','--label',`${LABEL_INSTALLATION}=ispagent`,'--label',`${LABEL_KIND}=native-tools`,join(stateRoot,'native-tools-image-x')]);
 }finally{rmSync(stateRoot,{recursive:true,force:true});}
});
