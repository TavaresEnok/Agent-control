import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,linkSync,lstatSync,readFileSync,renameSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {chmod,lstat,mkdir,mkdtemp,readdir,readFile,readlink,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Refusal} from '../src/contracts.ts';
import {keyFingerprint} from '../src/context-keys.ts';
import {loadCustodyPlaintext,sealCustodyEnvelope} from '../src/context-vault.ts';
import {applyContextKeyRotation,KeyRotationInterrupted,type KeyRotationApplyEvent,type KeyRotationApplyRequest} from '../src/key-rotation-apply.ts';
import {executeKeyRotationApply} from '../src/key-rotation-cli.ts';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));

function encodings(secret:Buffer){
 return [secret.toString('hex'),secret.toString('base64'),secret.toString('base64url')];
}
function assertNoSecrets(text:string,secrets:readonly Buffer[]){
 for(const secret of secrets)for(const encoding of encodings(secret))assert.equal(text.includes(encoding),false);
}
async function snapshot(dir:string){
 const hash=createHash('sha256');
 const walk=async(current:string,prefix:string)=>{
  const names=(await readdir(current,{withFileTypes:true})).map(entry=>entry.name).sort();
  for(const name of names){
   const path=join(current,name),info=await lstat(path);
   hash.update(prefix+name);hash.update(String(info.mode&0o777));hash.update(String(info.nlink));
   if(info.isSymbolicLink())hash.update(await readlink(path));
   else if(info.isDirectory())await walk(path,`${prefix}${name}/`);
   else hash.update(await readFile(path));
  }
 };
 await walk(dir,'');
 return hash.digest('hex');
}
function gateway(args:string[]){
 const env={...process.env};
 delete env.FORCE_COLOR;delete env.NO_COLOR;
 return spawnSync(process.execPath,['--import','tsx','src/server-main.ts',...args],{cwd:projectRoot,encoding:'utf8',env});
}

async function fixture(count=3){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'key-rot-apply-')));
 const root=join(parent,'vault');
 await mkdir(root,{mode:0o700});
 const masterFile=join(root,'master'),nextMasterFile=join(parent,'next-master'),checkpointFile=join(parent,'checkpoint');
 const current=randomBytes(32),next=randomBytes(32),installationId=randomUUID();
 await writeFile(masterFile,current,{mode:0o600});await writeFile(nextMasterFile,next,{mode:0o600});
 await chmod(masterFile,0o600);await chmod(nextMasterFile,0o600);
 const entries: {contextId:string;keyVersion:number;plain:Buffer;path:string}[]=[];
 for(let index=0;index<count;index++){
  const contextId=randomUUID(),plain=randomBytes(32);
  const body=sealCustodyEnvelope(current,{schemaVersion:1,installationId,contextId,principal:'owner',version:1,variant:'legacy',fingerprint:keyFingerprint(plain)},plain);
  const path=join(root,`${contextId}-1.vault`);
  await writeFile(path,body,{mode:0o600});await chmod(path,0o600);body.fill(0);
  entries.push({contextId,keyVersion:1,plain,path});
 }
 const request=(extra:Partial<KeyRotationApplyRequest>={}):KeyRotationApplyRequest=>({
  root,masterFile,nextKeyVersion:2,nextMasterFile,checkpointFile,batchSize:2,confirm:true,...extra,
 });
 return {
  parent,root,masterFile,nextMasterFile,checkpointFile,current,next,entries,installationId,request,
  async readable(){
   for(const entry of entries){
    const loaded=await loadCustodyPlaintext(masterFile,entry.path);
    try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
   }
  },
  secrets(){
   return [current,next,...entries.map(entry=>entry.plain)];
  },
  async cleanup(){
   current.fill(0);next.fill(0);for(const entry of entries)entry.plain.fill(0);
   await rm(parent,{recursive:true,force:true});
  },
 };
}

const masterNames=(masterFile:string)=>[masterFile,`${masterFile}.new`,`${masterFile}.old`];
function assertUnlinkedMastersSync(masterFile:string){
 for(const path of masterNames(masterFile)){
  try{
   const info=lstatSync(path);
   assert.equal(info.isFile(),true);
   assert.equal(info.isSymbolicLink(),false);
   assert.equal(info.nlink,1);
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
 }
}
async function assertUnlinkedMasters(masterFile:string){
 for(const path of masterNames(masterFile)){
  try{
   const info=await lstat(path);
   assert.equal(info.isFile(),true);
   assert.equal(info.isSymbolicLink(),false);
   assert.equal(info.nlink,1);
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
 }
}
function stageMaster(path:string,bytes:Buffer){
 writeFileSync(path,bytes,{mode:0o600});
 chmodSync(path,0o600);
}

function matches(event:KeyRotationApplyEvent,expected:Partial<KeyRotationApplyEvent>){
 return event.point===expected.point
  &&(expected.phase===undefined||event.phase===expected.phase)
  &&(expected.index===undefined||event.index===expected.index);
}

test('full rotation rewraps every entry and leaves only the new master',async()=>{
 const fx=await fixture(5);
 try{
  const preview=applyContextKeyRotation(fx.request({confirm:false}));
  assert.equal(preview.exitCode,0);
  assert.equal(preview.report.dryRun,true);
  assert.equal(preview.report.applied,false);
  assert.equal(await snapshot(fx.parent),await snapshot(fx.parent));
  const before=await snapshot(fx.parent);
  const dry=applyContextKeyRotation(fx.request({confirm:false}));
  assert.equal(dry.exitCode,0);
  assert.equal(await snapshot(fx.parent),before);
  const done=applyContextKeyRotation(fx.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.applied,true);
  assert.equal(done.report.phase,'complete');
  assert.equal(done.report.promoted,true);
  assert.equal(done.report.retired,true);
  assert.deepEqual(await readFile(fx.masterFile),fx.next);
  await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await assert.rejects(lstat(`${fx.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.equal((await readdir(fx.root)).some(name=>name.startsWith('.rot-')),false);
  await fx.readable();
  const again=applyContextKeyRotation(fx.request());
  assert.equal(again.exitCode,0);
  assert.equal(again.report.phase,'complete');
  assert.deepEqual(await readFile(fx.masterFile),fx.next);
  const checkpoint=await readFile(fx.checkpointFile);
  const info=await lstat(fx.checkpointFile);
  assert.equal(info.mode&0o777,0o600);
  assertNoSecrets(checkpoint.toString('utf8')+JSON.stringify(done.report)+JSON.stringify(again.report),fx.secrets());
  const envelopes=await Promise.all(fx.entries.map(async entry=>JSON.parse(await readFile(entry.path,'utf8')) as {nonce:string;ciphertext:string;tag:string}));
  const persisted=checkpoint.toString('utf8')+JSON.stringify(done.report);
  for(const envelope of envelopes){
   assert.equal(persisted.includes(envelope.nonce),false);
   assert.equal(persisted.includes(envelope.ciphertext),false);
   assert.equal(persisted.includes(envelope.tag),false);
  }
 }finally{await fx.cleanup();}
});

test('a crash before or after each phase and mid-batch resumes with entries readable',async()=>{
 const cases:Partial<KeyRotationApplyEvent>[]=[
  {point:'before-prepare'},
  {point:'before-publish-rename',phase:'prepare'},
  {point:'after-new-master'},
  {point:'before-step',phase:'prepare'},
  {point:'before-step',phase:'reenvelope'},
  {point:'before-publish-rename',phase:'reenvelope',index:0},
  {point:'after-reenvelope',index:0},
  {point:'before-publish-rename',phase:'reenvelope',index:1},
  {point:'after-reenvelope',index:1},
  {point:'before-step',phase:'verify'},
  {point:'after-verify',index:0},
  {point:'before-step',phase:'promote'},
  {point:'before-promote'},
  {point:'before-retired-copy-write'},
  {point:'after-master-copied'},
  {point:'after-master-renamed'},
  {point:'before-promote',index:0},
  {point:'after-promote-entry',index:0},
  {point:'before-promote',index:1},
  {point:'after-promote-entry',index:1},
  {point:'after-promote'},
  {point:'before-step',phase:'retire'},
  {point:'before-retire'},
  {point:'after-retire'},
  {point:'after-step',phase:'complete'},
 ];
 for(const expected of cases){
  const fx=await fixture(3);
  try{
   assert.throws(()=>applyContextKeyRotation(fx.request({interrupt(event){if(matches(event,expected))throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted&&matches(error.event,expected));
   await assertUnlinkedMasters(fx.masterFile);
   await fx.readable();
   const done=applyContextKeyRotation(fx.request());
   assert.equal(done.exitCode,0);
   assert.equal(done.report.applied,true);
   await fx.readable();
   assert.deepEqual(await readFile(fx.masterFile),fx.next);
   assert.equal((await readdir(fx.root)).some(name=>name.startsWith('.rot-')),false);
  }finally{await fx.cleanup();}
 }
});

async function plantForeignResidue(directory:string,name:string,body:Buffer){
 await writeFile(join(directory,name),body,{mode:0o600});
 await chmod(join(directory,name),0o600);
}

test('a crash during publish leaves a residue and resume replaces it',async()=>{
 const masterCrash=await fixture(2);
 const foreignBody=Buffer.from('foreign-residue-not-this-rotation');
 const foreignName=`.other-work.${randomUUID()}.part`;
 const alienName=`..rot-${'ab'.repeat(32)}-${randomUUID()}-1.${randomUUID()}.part`;
 const checkpointForeign=`.scratch.${randomUUID()}.part`;
 try{
  await plantForeignResidue(masterCrash.root,foreignName,foreignBody);
  await plantForeignResidue(masterCrash.root,alienName,foreignBody);
  await plantForeignResidue(masterCrash.parent,checkpointForeign,foreignBody);
  assert.throws(()=>applyContextKeyRotation(masterCrash.request({interrupt(event){if(event.point==='before-publish-rename'&&event.phase==='prepare')throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted);
  const residue=(await readdir(masterCrash.root)).find(name=>name.startsWith('.master.new.')&&name.endsWith('.part'));
  assert.ok(residue);
  assert.notEqual(residue,foreignName);
  await assert.rejects(lstat(`${masterCrash.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await writeFile(join(masterCrash.root,residue),Buffer.alloc(4),{mode:0o600});
  await chmod(join(masterCrash.root,residue),0o600);
  await masterCrash.readable();
  const done=applyContextKeyRotation(masterCrash.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.applied,true);
  const names=await readdir(masterCrash.root);
  assert.equal(names.includes(residue!),false);
  assert.equal(names.some(name=>name.startsWith('.master.new.')&&name.endsWith('.part')),false);
  assert.deepEqual(await readFile(join(masterCrash.root,foreignName)),foreignBody);
  assert.deepEqual(await readFile(join(masterCrash.root,alienName)),foreignBody);
  assert.deepEqual(await readFile(join(masterCrash.parent,checkpointForeign)),foreignBody);
  assert.deepEqual(await readFile(masterCrash.masterFile),masterCrash.next);
  await masterCrash.readable();
 }finally{foreignBody.fill(0);await masterCrash.cleanup();}
 const candidateCrash=await fixture(2);
 const candidateForeign=Buffer.from('foreign-candidate-residue');
 const candidateForeignName=`.other-work.${randomUUID()}.part`;
 const candidateAlien=`..rot-${'cd'.repeat(32)}-${randomUUID()}-1.${randomUUID()}.part`;
 try{
  await plantForeignResidue(candidateCrash.root,candidateForeignName,candidateForeign);
  await plantForeignResidue(candidateCrash.root,candidateAlien,candidateForeign);
  assert.throws(()=>applyContextKeyRotation(candidateCrash.request({interrupt(event){if(event.point==='before-publish-rename'&&event.index===0)throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted);
  assert.equal((await readdir(candidateCrash.root)).some(name=>name.startsWith('.rot-')),false);
  const residue=(await readdir(candidateCrash.root)).find(name=>name.includes('.rot-')&&name.endsWith('.part')&&name!==candidateAlien);
  assert.ok(residue);
  await writeFile(join(candidateCrash.root,residue),Buffer.from('{'),{mode:0o600});
  await chmod(join(candidateCrash.root,residue),0o600);
  await candidateCrash.readable();
  const done=applyContextKeyRotation(candidateCrash.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.applied,true);
  const names=await readdir(candidateCrash.root);
  assert.equal(names.includes(residue!),false);
  assert.deepEqual(await readFile(join(candidateCrash.root,candidateForeignName)),candidateForeign);
  assert.deepEqual(await readFile(join(candidateCrash.root,candidateAlien)),candidateForeign);
  await candidateCrash.readable();
  assert.deepEqual(await readFile(candidateCrash.masterFile),candidateCrash.next);
 }finally{candidateForeign.fill(0);await candidateCrash.cleanup();}
 const torn=await fixture(2);
 try{
  assert.throws(()=>applyContextKeyRotation(torn.request({interrupt(event){if(event.point==='after-reenvelope'&&event.index===0)throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted);
  const candidate=(await readdir(torn.root)).find(name=>name.startsWith('.rot-'));
  assert.ok(candidate);
  await writeFile(join(torn.root,candidate),Buffer.from('{'),{mode:0o600});
  await chmod(join(torn.root,candidate),0o600);
  await writeFile(`${torn.masterFile}.new`,Buffer.alloc(8),{mode:0o600});
  await chmod(`${torn.masterFile}.new`,0o600);
  await assert.rejects(loadCustodyPlaintext(torn.masterFile,torn.entries[0]!.path),/VAULT_MASTER_INVALID/);
  const done=applyContextKeyRotation(torn.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.applied,true);
  await torn.readable();
  assert.deepEqual(await readFile(torn.masterFile),torn.next);
 }finally{await torn.cleanup();}
 const planted=await fixture(1);
 try{
  await writeFile(`${planted.masterFile}.new`,Buffer.alloc(8),{mode:0o600});
  await chmod(`${planted.masterFile}.new`,0o600);
  const done=applyContextKeyRotation(planted.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.phase,'complete');
  await planted.readable();
 }finally{await planted.cleanup();}
 const wrong=await fixture(1);
 try{
  const other=randomBytes(32);
  await writeFile(`${wrong.masterFile}.new`,other,{mode:0o600});
  await chmod(`${wrong.masterFile}.new`,0o600);
  await wrong.readable();
  assert.throws(()=>applyContextKeyRotation(wrong.request()),error=>error instanceof Refusal&&error.code==='VAULT_MASTER_INVALID');
  assert.deepEqual(await readFile(wrong.masterFile),wrong.current);
  assert.deepEqual(await readFile(`${wrong.masterFile}.new`),other);
  await wrong.readable();
  other.fill(0);
 }finally{await wrong.cleanup();}
});

test('the same mid-batch interrupt does not rewrite an adopted candidate',async()=>{
 const fx=await fixture(3);
 try{
  const interrupt=(event:KeyRotationApplyEvent)=>{if(event.point==='after-reenvelope'&&event.index===0)throw new KeyRotationInterrupted(event);};
  assert.throws(()=>applyContextKeyRotation(fx.request({interrupt})),error=>error instanceof KeyRotationInterrupted);
  await fx.readable();
  const done=applyContextKeyRotation(fx.request({interrupt}));
  assert.equal(done.exitCode,0);
  await fx.readable();
  assert.deepEqual(await readFile(fx.masterFile),fx.next);
 }finally{await fx.cleanup();}
});

test('a corrupted entry blocks promotion and keeps the old master',async()=>{
 const fx=await fixture(2);
 try{
  const before=await snapshot(fx.parent);
  const target=fx.entries[0]!;
  const body=JSON.parse(await readFile(target.path,'utf8')) as {ciphertext:string};
  body.ciphertext=`${body.ciphertext.slice(0,4)==='0000'?'1111':'0000'}${body.ciphertext.slice(4)}`;
  await writeFile(target.path,JSON.stringify(body),{mode:0o600});
  const blocked=applyContextKeyRotation(fx.request());
  assert.equal(blocked.exitCode,3);
  assert.equal(blocked.report.blockedReason,'KEY_ROTATION_ENTRY_BLOCKED');
  assert.equal(blocked.report.promoted,false);
  assert.deepEqual(await readFile(fx.masterFile),fx.current);
  await assert.rejects(lstat(`${fx.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.notEqual(await snapshot(fx.parent),before);
  const healthy=fx.entries[1]!;
  const loaded=await loadCustodyPlaintext(fx.masterFile,healthy.path);
  try{assert.deepEqual(Buffer.from(loaded),healthy.plain);}finally{loaded.fill(0);}
 }finally{await fx.cleanup();}
});

test('a tampered candidate is corrupted and the old master stays',async()=>{
 const fx=await fixture(2);
 try{
  assert.throws(()=>applyContextKeyRotation(fx.request({interrupt(event){if(event.point==='before-step'&&event.phase==='verify')throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted);
  const candidate=(await readdir(fx.root)).find(name=>name.startsWith('.rot-'));
  assert.ok(candidate);
  const body=JSON.parse(await readFile(join(fx.root,candidate),'utf8')) as {ciphertext:string};
  body.ciphertext=`${body.ciphertext.slice(0,2)==='aa'?'bb':'aa'}${body.ciphertext.slice(2)}`;
  await writeFile(join(fx.root,candidate),JSON.stringify(body),{mode:0o600});
  await chmod(join(fx.root,candidate),0o600);
  const blocked=applyContextKeyRotation(fx.request());
  assert.equal(blocked.exitCode,3);
  assert.equal(blocked.report.blockedReason,'KEY_ROTATION_VERIFICATION_FAILED');
  assert.equal((await readFile(fx.checkpointFile,'utf8')).includes('"result":"corrupted"'),true);
  assert.equal(blocked.report.promoted,false);
  assert.deepEqual(await readFile(fx.masterFile),fx.current);
  await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await fx.readable();
  assertNoSecrets(JSON.stringify(blocked.report)+(await readFile(fx.checkpointFile,'utf8')),fx.secrets());
 }finally{await fx.cleanup();}
});

test('an equal new master is refused and unsafe files are refused',async()=>{
 const equal=await fixture(1);
 try{
  await writeFile(equal.nextMasterFile,equal.current,{mode:0o600});
  const before=await snapshot(equal.parent);
  const blocked=applyContextKeyRotation(equal.request());
  assert.equal(blocked.exitCode,3);
  assert.equal(blocked.report.blockedReason,'KEY_ROTATION_UNCHANGED');
  assert.equal(await snapshot(equal.parent),before);
 }finally{await equal.cleanup();}
 const unsafe=await fixture(1);
 try{
  await chmod(unsafe.entries[0]!.path,0o644);
  assert.throws(()=>applyContextKeyRotation(unsafe.request()),error=>error instanceof Refusal&&error.code==='VAULT_FILE_UNSAFE');
  await chmod(unsafe.entries[0]!.path,0o600);
  await chmod(unsafe.root,0o755);
  assert.throws(()=>applyContextKeyRotation(unsafe.request()),error=>error instanceof Refusal&&error.code==='VAULT_ROOT_UNSAFE');
  await chmod(unsafe.root,0o700);
  await chmod(unsafe.masterFile,0o640);
  assert.throws(()=>applyContextKeyRotation(unsafe.request()),error=>error instanceof Refusal&&error.code==='VAULT_FILE_UNSAFE');
  await chmod(unsafe.masterFile,0o600);
  symlinkSync(unsafe.entries[0]!.path,join(unsafe.root,`${randomUUID()}-2.vault`));
  assert.throws(()=>applyContextKeyRotation(unsafe.request()),error=>error instanceof Refusal&&error.code==='VAULT_PATH_UNSAFE');
  await assert.rejects(lstat(`${unsafe.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.deepEqual(await readFile(unsafe.masterFile),unsafe.current);
 }finally{await unsafe.cleanup();}
 const linked=await fixture(1);
 try{
  linkSync(linked.entries[0]!.path,join(linked.root,'hardlink'));
  assert.throws(()=>applyContextKeyRotation(linked.request()),error=>error instanceof Refusal&&(error.code==='VAULT_FILE_UNSAFE'||error.code==='KEY_ROTATION_ENTRY_INVALID'));
  await assert.rejects(lstat(`${linked.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.deepEqual(await readFile(linked.masterFile),linked.current);
 }finally{await linked.cleanup();}
});

test('without --confirm-apply the command changes nothing and prints no key',async()=>{
 const fx=await fixture(2);
 try{
  const descriptorPath=join(fx.parent,'descriptor.json');
  await writeFile(descriptorPath,JSON.stringify({schemaVersion:1,root:fx.root,masterFile:fx.masterFile,nextKeyVersion:2,nextMasterFile:fx.nextMasterFile,checkpointFile:fx.checkpointFile,batchSize:2}),{mode:0o600});
  await chmod(descriptorPath,0o600);
  const before=await snapshot(fx.parent);
  const direct=await executeKeyRotationApply(descriptorPath,false);
  assert.equal(direct.exitCode,0);
  if(direct.exitCode!==0)return;
  assert.equal(direct.report.dryRun,true);
  assert.equal(direct.report.applied,false);
  assert.equal(await snapshot(fx.parent),before);
  const run=gateway(['context-key-rotate-apply',descriptorPath]);
  assert.equal(run.status,0);
  assert.equal(run.stdout,JSON.stringify(direct.report)+'\n');
  assertNoSecrets(run.stdout+run.stderr,fx.secrets());
  assert.equal(await snapshot(fx.parent),before);
  const extraArgument=gateway(['context-key-rotate-apply',join(fx.parent,'unused-config.json'),descriptorPath]);
  assert.equal(extraArgument.status,1);
  assert.equal(extraArgument.stdout,'');
  assert.equal(await snapshot(fx.parent),before);
  const extraConfirmed=gateway(['context-key-rotate-apply',join(fx.parent,'unused-config.json'),descriptorPath,'--confirm-apply']);
  assert.equal(extraConfirmed.status,1);
  assert.equal(extraConfirmed.stdout,'');
  assert.equal(await snapshot(fx.parent),before);
  const confirmed=gateway(['context-key-rotate-apply',descriptorPath,'--confirm-apply']);
  assert.equal(confirmed.status,0);
  const report=JSON.parse(confirmed.stdout) as {applied:boolean;phase:string};
  assert.equal(report.applied,true);
  assert.equal(report.phase,'complete');
  assertNoSecrets(confirmed.stdout+confirmed.stderr+(await readFile(fx.checkpointFile,'utf8')),fx.secrets());
  await fx.readable();
  assert.deepEqual(await readFile(fx.masterFile),fx.next);
  const usage=gateway(['context-key-rotate-apply']);
  assert.equal(usage.status,1);
  assert.equal(usage.stdout,'');
  const flagged=gateway(['context-key-rotate-apply',descriptorPath,'--apply']);
  assert.equal(flagged.status,1);
  assert.equal(flagged.stdout,'');
 }finally{await fx.cleanup();}
});

test('load reads whichever present master authenticates',async()=>{
 const fx=await fixture(1);
 try{
  const entry=fx.entries[0]!,wrong=randomBytes(32),older=randomBytes(32);
  await writeFile(fx.masterFile,wrong,{mode:0o600});
  await writeFile(`${fx.masterFile}.new`,fx.current,{mode:0o600});
  const fromNew=await loadCustodyPlaintext(fx.masterFile,entry.path);
  try{assert.deepEqual(Buffer.from(fromNew),entry.plain);}finally{fromNew.fill(0);}
  await writeFile(`${fx.masterFile}.new`,wrong,{mode:0o600});
  await writeFile(`${fx.masterFile}.old`,fx.current,{mode:0o600});
  const fromOld=await loadCustodyPlaintext(fx.masterFile,entry.path);
  try{assert.deepEqual(Buffer.from(fromOld),entry.plain);}finally{fromOld.fill(0);}
  await writeFile(fx.masterFile,fx.current,{mode:0o600});
  const fromActive=await loadCustodyPlaintext(fx.masterFile,entry.path);
  try{assert.deepEqual(Buffer.from(fromActive),entry.plain);}finally{fromActive.fill(0);}
  await writeFile(fx.masterFile,wrong,{mode:0o600});
  await writeFile(`${fx.masterFile}.new`,older,{mode:0o600});
  await writeFile(`${fx.masterFile}.old`,older,{mode:0o600});
  await assert.rejects(loadCustodyPlaintext(fx.masterFile,entry.path),/VAULT_AUTHENTICATION_FAILED/);
  await writeFile(fx.masterFile,fx.current,{mode:0o600});
  await chmod(`${fx.masterFile}.new`,0o644);
  await assert.rejects(loadCustodyPlaintext(fx.masterFile,entry.path),/VAULT_FILE_UNSAFE/);
  wrong.fill(0);older.fill(0);
 }finally{await fx.cleanup();}
});

test('promotion keeps masterFile present and resumes between the new master and each envelope',async()=>{
 const points:Partial<KeyRotationApplyEvent>[]=[
  {point:'before-promote'},
  {point:'before-retired-copy-write'},
  {point:'after-master-copied'},
  {point:'after-master-renamed'},
  {point:'before-promote',index:0},
  {point:'after-promote-entry',index:0},
  {point:'before-promote',index:1},
  {point:'after-promote-entry',index:1},
  {point:'before-promote',index:2},
 ];
 for(const expected of points){
  const fx=await fixture(3);
  try{
   assert.throws(()=>applyContextKeyRotation(fx.request({interrupt(event){if(matches(event,expected))throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted&&matches(error.event,expected));
   await assertUnlinkedMasters(fx.masterFile);
   const beforeCopy=expected.point==='before-promote'&&expected.index===undefined||expected.point==='before-retired-copy-write';
   const afterCopy=expected.point==='after-master-copied';
   if(beforeCopy){
    assert.deepEqual(await readFile(fx.masterFile),fx.current);
    assert.deepEqual(await readFile(`${fx.masterFile}.new`),fx.next);
    await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
   }else if(afterCopy){
    const active=await lstat(fx.masterFile),retired=await lstat(`${fx.masterFile}.old`),staged=await lstat(`${fx.masterFile}.new`);
    assert.equal(new Set([active.ino,retired.ino,staged.ino]).size,3);
    assert.deepEqual(await readFile(fx.masterFile),fx.current);
    assert.deepEqual(await readFile(`${fx.masterFile}.old`),fx.current);
    assert.deepEqual(await readFile(`${fx.masterFile}.new`),fx.next);
   }else{
    const active=await lstat(fx.masterFile),retired=await lstat(`${fx.masterFile}.old`);
    assert.notEqual(active.ino,retired.ino);
    assert.deepEqual(await readFile(fx.masterFile),fx.next);
    assert.deepEqual(await readFile(`${fx.masterFile}.old`),fx.current);
    await assert.rejects(lstat(`${fx.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
   }
   await fx.readable();
   const done=applyContextKeyRotation(fx.request());
   assert.equal(done.exitCode,0);
   assert.equal(done.report.phase,'complete');
   assert.deepEqual(await readFile(fx.masterFile),fx.next);
   await fx.readable();
   assertNoSecrets(JSON.stringify(done.report),fx.secrets());
  }finally{await fx.cleanup();}
 }
});

test('a load racing each promotion point still opens and a foreign hardlink stays unsafe',async()=>{
 const fx=await fixture(1);
 try{
  const entry=fx.entries[0]!;
  stageMaster(`${fx.masterFile}.new`,fx.next);
  let sawActive=false;
  const beforeCopy=await loadCustodyPlaintext(fx.masterFile,entry.path,(_path,index)=>{
   assertUnlinkedMastersSync(fx.masterFile);
   if(index===0)sawActive=true;
   assert.throws(()=>lstatSync(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  });
  try{assert.deepEqual(Buffer.from(beforeCopy),entry.plain);}finally{beforeCopy.fill(0);}
  assert.equal(sawActive,true);
 }finally{await fx.cleanup();}

 const copied=await fixture(1);
 try{
  const entry=copied.entries[0]!;
  stageMaster(`${copied.masterFile}.new`,copied.next);
  const loaded=await loadCustodyPlaintext(copied.masterFile,entry.path,(_path,index)=>{
   if(index!==0)return;
   stageMaster(`${copied.masterFile}.old`,copied.current);
   assertUnlinkedMastersSync(copied.masterFile);
  });
  try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
  const active=lstatSync(copied.masterFile),retired=lstatSync(`${copied.masterFile}.old`),staged=lstatSync(`${copied.masterFile}.new`);
  assert.equal(new Set([active.ino,retired.ino,staged.ino]).size,3);
  assert.deepEqual(readFileSync(`${copied.masterFile}.old`),copied.current);
  assert.deepEqual(readFileSync(copied.masterFile),copied.current);
  assert.deepEqual(readFileSync(`${copied.masterFile}.new`),copied.next);
 }finally{await copied.cleanup();}

 const renamed=await fixture(1);
 try{
  const entry=renamed.entries[0]!;
  stageMaster(`${renamed.masterFile}.new`,renamed.next);
  const loaded=await loadCustodyPlaintext(renamed.masterFile,entry.path,(_path,index)=>{
   if(index!==0)return;
   stageMaster(`${renamed.masterFile}.old`,renamed.current);
   renameSync(`${renamed.masterFile}.new`,renamed.masterFile);
   assertUnlinkedMastersSync(renamed.masterFile);
  });
  try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
  assert.deepEqual(readFileSync(renamed.masterFile),renamed.next);
  assert.deepEqual(readFileSync(`${renamed.masterFile}.old`),renamed.current);
  assert.equal(lstatSync(renamed.masterFile).nlink,1);
  assert.equal(lstatSync(`${renamed.masterFile}.old`).nlink,1);
  await assert.rejects(lstat(`${renamed.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
 }finally{await renamed.cleanup();}

 const resealed=await fixture(1);
 try{
  const entry=resealed.entries[0]!;
  stageMaster(`${resealed.masterFile}.new`,resealed.next);
  let masterReads=0;
  const loaded=await loadCustodyPlaintext(resealed.masterFile,entry.path,(_path,index)=>{
   assertUnlinkedMastersSync(resealed.masterFile);
   if(index!==0)return;
   masterReads+=1;
   if(masterReads>1)return;
   stageMaster(`${resealed.masterFile}.old`,resealed.current);
   const header=JSON.parse(readFileSync(entry.path,'utf8')).header;
   const nextEnvelope=sealCustodyEnvelope(resealed.next,header,entry.plain);
   try{writeFileSync(entry.path,nextEnvelope,{mode:0o600});chmodSync(entry.path,0o600);}finally{nextEnvelope.fill(0);}
   renameSync(`${resealed.masterFile}.new`,resealed.masterFile);
   assertUnlinkedMastersSync(resealed.masterFile);
  });
  try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
  assert.equal(masterReads,2);
  assert.deepEqual(readFileSync(resealed.masterFile),resealed.next);
  assert.deepEqual(readFileSync(`${resealed.masterFile}.old`),resealed.current);
  assert.equal(lstatSync(resealed.masterFile).nlink,1);
  assert.equal(lstatSync(`${resealed.masterFile}.old`).nlink,1);
 }finally{await resealed.cleanup();}

 const linked=await fixture(1);
 try{
  const entry=linked.entries[0]!;
  for(const suffix of ['','.new','.old']){
   const path=suffix?`${linked.masterFile}${suffix}`:linked.masterFile;
   if(suffix)stageMaster(path,suffix==='.new'?linked.next:linked.current);
   const extra=join(linked.parent,`extra${suffix||'-active'}`);
   linkSync(path,extra);
   await assert.rejects(loadCustodyPlaintext(linked.masterFile,entry.path),(error:unknown)=>error instanceof Refusal&&error.code==='VAULT_FILE_UNSAFE');
   assert.throws(()=>applyContextKeyRotation(linked.request()),error=>error instanceof Refusal&&error.code==='VAULT_FILE_UNSAFE');
   unlinkSync(extra);
   if(suffix)unlinkSync(path);
  }
  await linked.readable();
  assert.deepEqual(await readFile(linked.masterFile),linked.current);
  await assert.rejects(lstat(`${linked.masterFile}.new`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await assert.rejects(lstat(`${linked.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
 }finally{await linked.cleanup();}
});

test('a short retired temporary stays invisible and resume publishes a complete old master',async()=>{
 const fx=await fixture(2);
 try{
  assert.throws(()=>applyContextKeyRotation(fx.request({interrupt(event){if(event.point==='before-retired-copy-write')throw new KeyRotationInterrupted(event);}})),error=>error instanceof KeyRotationInterrupted&&error.event.point==='before-retired-copy-write');
  const bundle=JSON.parse(await readFile(fx.checkpointFile,'utf8')) as {checkpoint:{planDigest:string}};
  const temporary=`${fx.masterFile}.old.tmp-${bundle.checkpoint.planDigest.slice(0,16)}`;
  const info=await lstat(temporary);
  assert.equal(info.isSymbolicLink(),false);
  assert.equal(info.nlink,1);
  assert.equal(info.mode&0o777,0o600);
  assert.ok(info.size>0&&info.size<32);
  await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.deepEqual(await readFile(fx.masterFile),fx.current);
  await assertUnlinkedMasters(fx.masterFile);
  const before=await snapshot(fx.parent);
  const dry=applyContextKeyRotation(fx.request({confirm:false}));
  assert.equal(dry.exitCode,0);
  assert.equal(dry.report.dryRun,true);
  assert.equal(await snapshot(fx.parent),before);
  const entry=fx.entries[0]!;
  const loaded=await loadCustodyPlaintext(fx.masterFile,entry.path,()=>{
   assertUnlinkedMastersSync(fx.masterFile);
   assert.throws(()=>lstatSync(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
   const pending=lstatSync(temporary);
   assert.ok(pending.size<32);
   assert.equal(pending.nlink,1);
  });
  try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
  await fx.readable();
  const done=applyContextKeyRotation(fx.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.phase,'complete');
  await assert.rejects(lstat(temporary),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await assert.rejects(lstat(`${fx.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.deepEqual(await readFile(fx.masterFile),fx.next);
  await fx.readable();
  assertNoSecrets(JSON.stringify(done.report)+JSON.stringify(dry.report),fx.secrets());
 }finally{await fx.cleanup();}

 const parked=await fixture(1);
 try{
  let temporary='';
  assert.throws(()=>applyContextKeyRotation(parked.request({interrupt(event){
   if(event.point!=='before-retire')return;
   const bundle=JSON.parse(readFileSync(parked.checkpointFile,'utf8')) as {checkpoint:{planDigest:string}};
   temporary=`${parked.masterFile}.old.tmp-${bundle.checkpoint.planDigest.slice(0,16)}`;
   writeFileSync(temporary,Buffer.from([1]),{mode:0o600});
   chmodSync(temporary,0o600);
   throw new KeyRotationInterrupted(event);
  }})),error=>error instanceof KeyRotationInterrupted&&error.event.point==='before-retire');
  assert.equal(lstatSync(temporary).size,1);
  assert.equal(lstatSync(`${parked.masterFile}.old`).size,32);
  assert.equal(lstatSync(parked.masterFile).nlink,1);
  assert.equal(lstatSync(`${parked.masterFile}.old`).nlink,1);
  const entry=parked.entries[0]!;
  const loaded=await loadCustodyPlaintext(parked.masterFile,entry.path,()=>{
   assert.equal(lstatSync(`${parked.masterFile}.old`).size,32);
   assert.equal(lstatSync(temporary).size,1);
   assertUnlinkedMastersSync(parked.masterFile);
  });
  try{assert.deepEqual(Buffer.from(loaded),entry.plain);}finally{loaded.fill(0);}
  const done=applyContextKeyRotation(parked.request());
  assert.equal(done.exitCode,0);
  assert.equal(done.report.phase,'complete');
  assert.throws(()=>lstatSync(temporary),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  assert.throws(()=>lstatSync(`${parked.masterFile}.old`),(error:NodeJS.ErrnoException)=>error.code==='ENOENT');
  await parked.readable();
  assertNoSecrets(JSON.stringify(done.report),parked.secrets());
 }finally{await parked.cleanup();}
});

test('context vault load tries present masters',{skip:process.env.AC_TEST_DATABASE_URL?false:'AC_TEST_DATABASE_URL ausente: teste de ledger reservado à administração'},async()=>{
 const {isolatedDatabase}=await import('./fixtures/isolated-database.ts');
 const {Ledger}=await import('../src/ledger.ts');
 const {ContextKeys}=await import('../src/context-keys.ts');
 const {ContextVault}=await import('../src/context-vault.ts');
 const base=process.env.AC_TEST_DATABASE_URL;
 if(!base)throw Error('AC_TEST_DATABASE_URL ausente');
 const dbFixture=await isolatedDatabase(base,'rotapply'),db=new Ledger(dbFixture.url),folder=await mkdtemp(join(tmpdir(),'ac-rot-load-'));
 try{
  await db.migrate();
  const root=join(folder,'vault'),master=join(folder,'master');
  await mkdir(root,{mode:0o700});
  const current=randomBytes(32);
  await writeFile(master,current,{mode:0o600});
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id as string;
  const project=randomUUID(),principal='vault-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic rotation']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[contextId])).rows[0].session_id as string;
  const key=randomBytes(32);
  await new ContextKeys(db).authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  const request={principal,contextId,sessionId,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy' as const};
  const vault=new ContextVault(db,installationId,root,master,[]);
  await vault.importKey(request,key);
  const opened=await vault.load(request);
  try{assert.deepEqual(Buffer.from(opened),key);}finally{opened.fill(0);}
  const wrong=randomBytes(32);
  await writeFile(master,wrong,{mode:0o600});
  await writeFile(`${master}.new`,current,{mode:0o600});
  const fromNew=await vault.load(request);
  try{assert.deepEqual(Buffer.from(fromNew),key);}finally{fromNew.fill(0);}
  await writeFile(`${master}.new`,wrong,{mode:0o600});
  await writeFile(`${master}.old`,current,{mode:0o600});
  const fromOld=await vault.load(request);
  try{assert.deepEqual(Buffer.from(fromOld),key);}finally{fromOld.fill(0);}
  await writeFile(`${master}.old`,wrong,{mode:0o600});
  await assert.rejects(vault.load(request),/VAULT_AUTHENTICATION_FAILED/);
  await writeFile(master,current,{mode:0o600});
  await chmod(`${master}.new`,0o644);
  await assert.rejects(vault.load(request),/VAULT_FILE_UNSAFE/);
  await rm(`${master}.new`,{force:true});await rm(`${master}.old`,{force:true});
  const restored=await vault.load(request);
  try{assert.deepEqual(Buffer.from(restored),key);}finally{restored.fill(0);}
  wrong.fill(0);key.fill(0);current.fill(0);
 }finally{await db.close();await dbFixture.close();await rm(folder,{recursive:true,force:true});}
});
