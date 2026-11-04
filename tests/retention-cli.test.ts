import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {chmod,lstat,link,mkdir,mkdtemp,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planRetention} from '../src/retention-plan.ts';
import {RETENTION_DESCRIPTOR_MAX_BYTES} from '../src/retention-cli.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const sentinel='sentinel-retention-artifact';
const secret='synthetic-retention-secret-do-not-print';
const ages={cache:1_000,log:1_000,worktree:1_000,backup:1_000};
const policy=(availableBytes:number)=>({
 schemaVersion:1 as const,
 minAgeMs:ages,
 disk:{availableBytes,minFreeBytes:400,estimatedWriteBytes:600,additionalReservedBytes:0},
});
const cache=(id:string,ageMs:number,extra:Record<string,unknown>={})=>({
 id,kind:'cache',ageMs,sizeBytes:10,state:'idle',references:[],regenerable:true,...extra,
});
const evidence=(id:string,kind:'acceptance_evidence'|'evidence')=>({
 id,kind,ageMs:9_000,sizeBytes:4,state:'idle',references:[],...(kind==='acceptance_evidence'?{acceptance:true}:{}),
});
const admittedInventory=()=>({
 schemaVersion:1 as const,
 artifacts:[
  evidence('accept','acceptance_evidence'),
  evidence('generic','evidence'),
  cache('active-ref',9_000,{references:[{jobId:'job-1',status:'active'}]}),
  cache('uncertain-ref',9_000,{kind:'log',references:[{jobId:'job-2',status:'uncertain'}],regenerable:undefined}),
  cache('cache-old',5_000),
  cache('cache-young',1),
 ],
});
const descriptor=(inventory:unknown,rules:unknown)=>({schemaVersion:1 as const,inventory,policy:rules});

function cliEnv(extra?:NodeJS.ProcessEnv){
 const env:NodeJS.ProcessEnv={...process.env,NODE_NO_WARNINGS:'1',...extra};
 delete env.FORCE_COLOR;
 delete env.NO_COLOR;
 delete env.DATABASE_URL;
 delete env.AC_TEST_DATABASE_URL;
 if(!extra?.RETENTION_PLAN_OPEN_BARRIER)delete env.RETENTION_PLAN_OPEN_BARRIER;
 return env;
}
function gateway(args:string[],timeout=15000,extra?:NodeJS.ProcessEnv){
 return spawnSync(process.execPath,['--import','tsx','src/server-main.ts',...args],{cwd:root,encoding:'utf8',env:cliEnv(extra),timeout});
}
function startGateway(args:string[],extra:NodeJS.ProcessEnv,preload?:string){
 const imported=preload?['--import',preload]:[];
 const child=spawn(process.execPath,[...imported,'--import','tsx','src/server-main.ts',...args],{cwd:root,env:cliEnv(extra)});
 let stdout='';
 let stderr='';
 child.stdout?.setEncoding('utf8');
 child.stderr?.setEncoding('utf8');
 child.stdout?.on('data',(chunk:string)=>{stdout+=chunk;});
 child.stderr?.on('data',(chunk:string)=>{stderr+=chunk;});
 const done=new Promise<{status:number|null;stdout:string;stderr:string;error?:Error}>((resolve)=>{
  const timer=setTimeout(()=>{child.kill('SIGKILL');},15000);
  child.once('error',error=>{clearTimeout(timer);resolve({status:null,stdout,stderr,error});});
  child.once('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
 });
 return {child,done};
}
function raceLoaderSource(dir:string,held:string,leaf:string){
 return `import {registerHooks} from 'node:module';
import * as real from 'node:fs/promises';
import {sep} from 'node:path';
const dir=${JSON.stringify(dir)};
const held=${JSON.stringify(held)};
const leaf=${JSON.stringify(leaf)};
const self=import.meta.url;
let identified=false;
let swapped=false;
registerHooks({
 resolve(specifier,context,nextResolve){
  if(specifier==='node:fs/promises'&&context.parentURL?.endsWith('/src/retention-cli.ts'))return {url:self,shortCircuit:true};
  return nextResolve(specifier,context);
 },
});
export async function open(...args){
 const target=typeof args[0]==='string'?args[0]:'';
 if(identified&&!swapped&&target===sep){
  swapped=true;
  await real.rename(dir,held);
  await real.symlink(held,dir);
 }
 const handle=await real.open(...args);
 if(!identified&&target.endsWith('/'+leaf))identified=true;
 return handle;
}
`;
}
async function writeDescriptor(body:unknown,mode=0o600){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'retention-cli-')));
 const artifacts=join(dir,'artifacts');
 await mkdir(artifacts,{mode:0o700});
 const bait=join(artifacts,'sentinel.bin');
 await writeFile(bait,sentinel,{mode:0o600});
 const path=join(dir,'descriptor.json');
 const text=typeof body==='string'?body:JSON.stringify(body);
 await writeFile(path,text,{mode:0o600});
 await chmod(path,mode);
 return {dir,path,bait,artifacts,text,async cleanup(){await rm(dir,{recursive:true,force:true});}};
}
async function intact(file:{bait:string;path:string;text:string;artifacts:string}){
 assert.equal(await readFile(file.bait,'utf8'),sentinel);
 assert.equal(await readFile(file.path,'utf8'),file.text);
 assert.deepEqual((await lstat(file.artifacts)).isDirectory(),true);
}
function assertClosed(run:{status:number|null;stdout:string;stderr:string;error?:Error},file:{dir:string;path:string},code?:string){
 assert.equal(run.error,undefined);
 assert.equal(run.status,1);
 assert.equal(run.stdout,'');
 if(code)assert.equal(run.stderr,`${code}\n`);
 else assert.match(run.stderr,/^(RETENTION_COMMAND_INVALID|RETENTION_DESCRIPTOR_INVALID|RETENTION_INVENTORY_INVALID|RETENTION_POLICY_INVALID|RETENTION_DUPLICATE_ID|RETENTION_BYTES_UNSAFE|RETENTION_PLAN_INVALID)\n$/);
 assert.equal(run.stderr.includes(secret),false);
 assert.equal(run.stderr.includes(file.dir),false);
 assert.equal(run.stderr.includes(file.path),false);
 assert.equal(run.stdout.includes(secret),false);
 assert.equal(run.stderr.includes('Error'),false);
 assert.equal(run.stderr.includes(' at '),false);
}

test('the product CLI prints the supplied dry-run and leaves artifacts untouched',async()=>{
 const body=descriptor(admittedInventory(),policy(10_000));
 const forward=await writeDescriptor(body);
 const reverse=await writeDescriptor(descriptor({...admittedInventory(),artifacts:[...admittedInventory().artifacts].reverse()},policy(10_000)));
 const decoy=join(forward.dir,'installation.json');
 await writeFile(decoy,`{"databaseUrl":"${secret}"}`,{mode:0o600});
 try{
  const expected=planRetention(body.inventory,body.policy);
  const first=gateway(['retention-plan',forward.path]);
  const second=gateway(['retention-plan',forward.path]);
  const flipped=gateway(['retention-plan',reverse.path]);
  assert.equal(first.error,undefined);
  assert.equal(first.status,0);
  assert.equal(first.stderr,'');
  assert.equal(first.stdout,JSON.stringify(expected)+'\n');
  assert.equal(second.stdout,first.stdout);
  assert.equal(flipped.stdout,first.stdout);
  const plan=JSON.parse(first.stdout) as typeof expected;
  assert.equal(plan.mode,'dry-run');
  assert.equal(plan.deletesNothing,true);
  assert.equal(plan.admission.admitted,true);
  assert.equal(plan.admission.code,'ADMITTED');
  assert.equal(plan.decisions.find(item=>item.id==='accept')?.action,'keep');
  assert.equal(plan.decisions.find(item=>item.id==='generic')?.code,'EVIDENCE_PRESERVED');
  assert.equal(plan.decisions.find(item=>item.id==='active-ref')?.code,'REFERENCED_BY_ACTIVE_JOB');
  assert.equal(plan.decisions.find(item=>item.id==='uncertain-ref')?.code,'REFERENCED_BY_UNCERTAIN_JOB');
  assert.equal(plan.decisions.find(item=>item.id==='cache-old')?.action,'propose');
  assert.deepEqual(plan.proposalOrder,expected.proposalOrder);
  assert.equal(plan.digest,expected.digest);
  assert.equal(first.stdout.includes(secret),false);
  assert.equal(await readFile(decoy,'utf8'),`{"databaseUrl":"${secret}"}`);
  await intact(forward);
  assert.deepEqual((await readFile(join(forward.dir,'artifacts','sentinel.bin'),'utf8')),sentinel);
 }finally{await forward.cleanup();await reverse.cleanup();}
});

test('low space exits 3 with the plan and still deletes nothing',async()=>{
 const body=descriptor(admittedInventory(),policy(10));
 const file=await writeDescriptor(body);
 try{
  const expected=planRetention(body.inventory,body.policy);
  const run=gateway(['retention-plan',file.path]);
  assert.equal(run.error,undefined);
  assert.equal(run.status,3);
  assert.equal(run.stderr,'');
  assert.equal(run.stdout,JSON.stringify(expected)+'\n');
  const plan=JSON.parse(run.stdout) as typeof expected;
  assert.equal(plan.admission.admitted,false);
  assert.equal(plan.admission.code,'STORAGE_LOW_SPACE');
  assert.equal(plan.deletesNothing,true);
  assert.equal(plan.mode,'dry-run');
  assert.equal(plan.decisions.find(item=>item.id==='accept')?.action,'keep');
  assert.equal(plan.decisions.find(item=>item.id==='cache-young')?.code,'DISK_FULL_REGENERABLE_CACHE');
  await intact(file);
 }finally{await file.cleanup();}
});

test('invalid inventory, age, refs, and path-like fields are closed refusals',async()=>{
 const baitPathPlaceholder='';
 const base=cache('cache-old',5_000);
 const cases:[unknown,string][]=[
  [descriptor({schemaVersion:1,artifacts:[base,base]},policy(10_000)),'RETENTION_DUPLICATE_ID'],
  [descriptor({schemaVersion:1,artifacts:[{...base,ageMs:-1}]},policy(10_000)),'RETENTION_INVENTORY_INVALID'],
  [descriptor({schemaVersion:1,artifacts:[{...base,ageMs:1.5}]},policy(10_000)),'RETENTION_INVENTORY_INVALID'],
  [descriptor({schemaVersion:1,artifacts:[{...evidence('accept','acceptance_evidence'),acceptance:false}]},policy(10_000)),'RETENTION_INVENTORY_INVALID'],
  [descriptor({schemaVersion:1,artifacts:[{...base,references:[{jobId:'job-1',status:'gone'}]}]},policy(10_000)),'RETENTION_INVENTORY_INVALID'],
  [descriptor({schemaVersion:1,artifacts:[{...base,references:[{jobId:'../artifacts/sentinel.bin',status:'active'}]}]},policy(10_000)),'RETENTION_INVENTORY_INVALID'],
  [{schemaVersion:1,inventory:{schemaVersion:1,artifacts:[base]},policy:{schemaVersion:1,minAgeMs:ages,disk:{availableBytes:10,minFreeBytes:0,estimatedWriteBytes:0}}},'RETENTION_POLICY_INVALID'],
  [{schemaVersion:1,inventory:{schemaVersion:1,artifacts:[base]},policy:policy(10),artifactPath:baitPathPlaceholder,secret},'RETENTION_DESCRIPTOR_INVALID'],
  ['{', 'RETENTION_DESCRIPTOR_INVALID'],
  [{schemaVersion:2,inventory:{schemaVersion:1,artifacts:[base]},policy:policy(10)},'RETENTION_DESCRIPTOR_INVALID'],
 ];
 const files=[];
 try{
  for(const [body,code] of cases){
   const payload=body&&typeof body==='object'&&'artifactPath' in body?{...body,artifactPath:'pending'}:body;
   const file=await writeDescriptor(payload);
   if(payload&&typeof payload==='object'&&'artifactPath' in payload){
    const text=JSON.stringify({...payload,artifactPath:file.bait});
    await writeFile(file.path,text,{mode:0o600});
    await chmod(file.path,0o600);
    file.text=text;
   }
   files.push(file);
   const run=gateway(['retention-plan',file.path]);
   assertClosed(run,file,code);
   await intact(file);
   assert.equal(run.stdout.includes(file.bait),false);
   assert.equal(run.stderr.includes(file.bait),false);
  }
 }finally{await Promise.all(files.map(file=>file.cleanup()));}
});

test('the byte cap is inclusive and an over-limit stream is not parsed as a plan',async()=>{
 const body=JSON.stringify(descriptor(admittedInventory(),policy(10_000)));
 const exact=await writeDescriptor(body+' '.repeat(RETENTION_DESCRIPTOR_MAX_BYTES-body.length));
 const over=await writeDescriptor(body+' '.repeat(RETENTION_DESCRIPTOR_MAX_BYTES-body.length+1));
 try{
  assert.equal(exact.text.length,RETENTION_DESCRIPTOR_MAX_BYTES);
  assert.equal(over.text.length,RETENTION_DESCRIPTOR_MAX_BYTES+1);
  const admitted=gateway(['retention-plan',exact.path]);
  assert.equal(admitted.status,0);
  assert.equal(admitted.stdout,JSON.stringify(planRetention(admittedInventory(),policy(10_000)))+'\n');
  const refused=gateway(['retention-plan',over.path]);
  assertClosed(refused,over,'RETENTION_DESCRIPTOR_INVALID');
  assert.equal(refused.stdout.includes('dry-run'),false);
  assert.equal(refused.stdout.includes('cache-old'),false);
  await intact(exact);
  await intact(over);
 }finally{await exact.cleanup();await over.cleanup();}
});

test('symlink, fifo, and hardlink are refused without blocking or edits',async()=>{
 const file=await writeDescriptor(descriptor(admittedInventory(),policy(10_000)));
 try{
  const leaf=join(file.dir,'leaf.json');
  await symlink(file.path,leaf);
  const leafRun=gateway(['retention-plan',leaf]);
  assertClosed(leafRun,{dir:file.dir,path:leaf},'RETENTION_DESCRIPTOR_INVALID');
  const via=join(file.dir,'via');
  await symlink(file.dir,via);
  const ancestor=gateway(['retention-plan',join(via,'descriptor.json')]);
  assertClosed(ancestor,{dir:file.dir,path:join(via,'descriptor.json')},'RETENTION_DESCRIPTOR_INVALID');
  const fifoDir=join(file.dir,'fifo-real');
  await mkdir(fifoDir,{mode:0o700});
  const fifo=join(fifoDir,'descriptor.json');
  const made=spawnSync('mkfifo',[fifo],{timeout:2000});
  assert.equal(made.status,0);
  const fifoLink=join(file.dir,'fifo-via');
  await symlink(fifoDir,fifoLink);
  const fifoRun=gateway(['retention-plan',fifo],2000);
  assertClosed(fifoRun,{dir:file.dir,path:fifo},'RETENTION_DESCRIPTOR_INVALID');
  const ancestorFifo=gateway(['retention-plan',join(fifoLink,'descriptor.json')],2000);
  assertClosed(ancestorFifo,{dir:file.dir,path:join(fifoLink,'descriptor.json')},'RETENTION_DESCRIPTOR_INVALID');
  const alias=join(file.dir,'alias.json');
  await link(file.path,alias);
  assert.equal((await lstat(file.path)).nlink,2);
  assert.equal((await lstat(alias)).nlink,2);
  const linked=gateway(['retention-plan',file.path]);
  assertClosed(linked,file,'RETENTION_DESCRIPTOR_INVALID');
  assert.equal((await lstat(file.path)).nlink,2);
  assert.equal((await lstat(file.path)).mode&0o777,0o600);
  assert.equal(await readFile(alias,'utf8'),file.text);
  await intact(file);
 }finally{await file.cleanup();}
});

test('mode 0644 is refused on a regular single-link file owned by the current uid',async()=>{
 const file=await writeDescriptor(descriptor(admittedInventory(),policy(10_000)),0o644);
 try{
  const info=await lstat(file.path);
  assert.equal(info.isSymbolicLink(),false);
  assert.equal(info.isFile(),true);
  assert.equal(info.nlink,1);
  assert.equal(info.uid,process.getuid?.());
  assert.equal(info.mode&0o777,0o644);
  const run=gateway(['retention-plan',file.path]);
  assertClosed(run,file,'RETENTION_DESCRIPTOR_INVALID');
  const after=await lstat(file.path);
  assert.equal(after.nlink,1);
  assert.equal(after.mode&0o777,0o644);
  await intact(file);
 }finally{await file.cleanup();}
});

test('an ancestor swapped for a symlink after validation is not read',async()=>{
 const file=await writeDescriptor(descriptor(admittedInventory(),policy(10_000)));
 const moved=`${file.dir}-held`;
 const loaderPath=`${file.dir}.loader.mjs`;
 let started:{child:ChildProcess;done:ReturnType<typeof startGateway>['done']}|undefined;
 try{
  await writeFile(loaderPath,raceLoaderSource(file.dir,moved,'descriptor.json'),{mode:0o600});
  const before=await lstat(file.path);
  assert.equal(before.isFile(),true);
  assert.equal(before.isSymbolicLink(),false);
  assert.equal(before.nlink,1);
  started=startGateway(['retention-plan',file.path],{},loaderPath);
  const run=await started.done;
  started=undefined;
  assertClosed(run,file,'RETENTION_DESCRIPTOR_INVALID');
  assert.equal(run.stdout.includes('dry-run'),false);
  assert.equal(run.stdout.includes('cache-old'),false);
  assert.equal(run.stdout.includes(file.text),false);
  assert.equal((await lstat(file.dir)).isSymbolicLink(),true);
  const through=await lstat(join(file.dir,'descriptor.json'));
  assert.equal(through.isSymbolicLink(),false);
  assert.equal(through.isFile(),true);
  assert.equal(through.nlink,1);
  assert.equal(through.dev,before.dev);
  assert.equal(through.ino,before.ino);
  assert.deepEqual((await readdir(moved)).sort(),['artifacts','descriptor.json']);
  assert.equal(await readFile(join(moved,'descriptor.json'),'utf8'),file.text);
  assert.equal(await readFile(join(moved,'artifacts','sentinel.bin'),'utf8'),sentinel);
  assert.equal(await readFile(join(file.dir,'artifacts','sentinel.bin'),'utf8'),sentinel);
  assert.equal((await lstat(join(moved,'descriptor.json'))).ino,before.ino);
 }finally{
  if(started){started.child.kill('SIGKILL');await started.done;}
  await rm(loaderPath,{force:true});
  await rm(moved,{recursive:true,force:true});
  await rm(file.dir,{recursive:true,force:true});
 }
});

test('RETENTION_PLAN_OPEN_BARRIER does not write or open another file',async()=>{
 const body=descriptor(admittedInventory(),policy(10_000));
 const file=await writeDescriptor(body);
 const barrier=join(file.dir,'barrier');
 const expected=JSON.stringify(planRetention(body.inventory,body.policy))+'\n';
 try{
  await mkdir(barrier,{mode:0o700});
  const admitted=gateway(['retention-plan',file.path],15000,{RETENTION_PLAN_OPEN_BARRIER:barrier});
  assert.equal(admitted.error,undefined);
  assert.equal(admitted.status,0);
  assert.equal(admitted.stderr,'');
  assert.equal(admitted.stdout,expected);
  assert.deepEqual(await readdir(barrier),[]);
  const refused=gateway(['retention-plan',file.path,'--apply'],15000,{RETENTION_PLAN_OPEN_BARRIER:barrier});
  assertClosed(refused,file,'RETENTION_COMMAND_INVALID');
  assert.deepEqual(await readdir(barrier),[]);
  await chmod(barrier,0o000);
  const blocked=gateway(['retention-plan',file.path],15000,{RETENTION_PLAN_OPEN_BARRIER:barrier});
  assert.equal(blocked.error,undefined);
  assert.equal(blocked.status,0);
  assert.equal(blocked.stderr,'');
  assert.equal(blocked.stdout,expected);
  await chmod(barrier,0o700);
  assert.deepEqual(await readdir(barrier),[]);
  assert.deepEqual(await readdir(file.artifacts),['sentinel.bin']);
  await intact(file);
 }finally{
  await chmod(barrier,0o700).catch(()=>{});
  await file.cleanup();
 }
});

test('apply, extra flags, and a relative path are refused',async()=>{
 const file=await writeDescriptor(descriptor(admittedInventory(),policy(10_000)),0o400);
 try{
  const readOnly=gateway(['retention-plan',file.path]);
  assert.equal(readOnly.status,0);
  assert.equal(readOnly.stderr,'');
  for(const args of [
   ['retention-plan',file.path,'--apply'],
   ['retention-plan','--apply',file.path],
   ['retention-plan',file.path,file.path],
   ['retention-plan'],
   ['retention-plan','descriptor.json'],
   ['retention-plan',file.dir],
   ['retention-plan',join(file.dir,'missing.json')],
  ]){
   const run=gateway(args);
   assertClosed(run,file);
  }
  await intact(file);
  assert.equal((await lstat(file.path)).mode&0o777,0o400);
 }finally{await file.cleanup();}
});

test('the CLI module does not walk, stat disks, or schedule work',async()=>{
 const source=await readFile(new URL('../src/retention-cli.ts',import.meta.url),'utf8');
 const main=await readFile(new URL('../src/server-main.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/statfs|readdir|unlink|rmSync|measureDiskCapacity|loadInstallation|child_process|setInterval|setTimeout|scheduler|O_CREAT|process\.env|RETENTION_PLAN_OPEN_BARRIER/);
 assert.equal(source.includes('O_NOFOLLOW'),true);
 assert.equal(source.includes('O_NONBLOCK'),true);
 assert.equal(source.includes('O_DIRECTORY'),true);
 assert.equal(source.includes('/proc/self/fd/'),true);
 assert.equal(source.includes('open(descriptorPath'),false);
 assert.equal(main.includes('RETENTION_PLAN_OPEN_BARRIER'),false);
 const command=main.indexOf("command==='retention-plan'");
 const load=main.indexOf('loadInstallation(');
 assert.equal(command>0&&command<load,true);
});
