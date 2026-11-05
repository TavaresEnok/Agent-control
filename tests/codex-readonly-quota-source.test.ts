import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexReadonlyQuotaSource,codexReadonlyIdentity} from '../src/codex-readonly-quota-source.ts';
import {createCodexReadonlyQuotaProbe} from '../src/provider-collector-adapter.ts';

const executable=fileURLToPath(new URL('./fixtures/codex-readonly/app-server.mjs',import.meta.url));
test('readonly Codex fixture binds identity and only emits metadata RPCs',async()=>{
 const home=await mkdtemp(join(tmpdir(),'ac-codex-ro-'));const accountId=randomUUID();
 try{
  const info=await stat(home,{bigint:true});const subjectDigest=codexReadonlyIdentity({type:'chatgpt',email:'fixture@example.invalid',accountId:'subject'})!;
  const binding={accountId,home,device:String(info.dev),inode:String(info.ino),uid:String(info.uid),subjectDigest};
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'valid'}));
  const source=new CodexReadonlyQuotaSource(executable,binding,2000),probe=createCodexReadonlyQuotaProbe(source,()=>new Date('2026-11-01T00:00:00Z'));
  const result=await probe({accountId,signal:new AbortController().signal});assert.equal(result.status,'available');assert.equal(result.remainingPercent,65);
  const trace=(await readFile(join(home,'trace'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(trace[0].argv,['app-server']);assert.equal(trace[0].home,'/proc/self/fd/3');assert.equal(trace[0].codeHome,'/proc/self/fd/3');assert.equal(trace[0].cwd,home);
  assert.deepEqual(trace[0].env,['CODEX_HOME','HOME','LANG','PATH']);
  assert.deepEqual(trace.slice(1).map(x=>x.method),['initialize','initialized','account/read','account/rateLimits/read']);
  assert.deepEqual(trace[2+1].params,{refreshToken:false});
  assert.equal((await source.read({accountId:randomUUID(),signal:new AbortController().signal})).kind,'unknown');
  const mismatch=new CodexReadonlyQuotaSource(executable,{...binding,subjectDigest:'0'.repeat(64)},2000);
  assert.equal((await mismatch.read({accountId,signal:new AbortController().signal})).kind,'auth');
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'auth'}));assert.equal((await probe({accountId,signal:new AbortController().signal})).status,'auth_required');
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'malformed'}));assert.equal((await probe({accountId,signal:new AbortController().signal})).status,'unknown');
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'overflow'}));assert.equal((await probe({accountId,signal:new AbortController().signal})).status,'unknown');
  await writeFile(join(home,'fixture.json'),JSON.stringify({mode:'hang'}));const timeout=new CodexReadonlyQuotaSource(executable,binding,100);
  const pending=timeout.read({accountId,signal:new AbortController().signal});const second=new CodexReadonlyQuotaSource(executable,binding,100);assert.equal((await second.read({accountId,signal:new AbortController().signal})).kind,'unknown');assert.equal((await pending).kind,'unknown');
  const controller=new AbortController();const aborted=timeout.read({accountId,signal:controller.signal});controller.abort();assert.equal((await aborted).kind,'unknown');
  await chmod(home,0o755);assert.equal((await source.read({accountId,signal:new AbortController().signal})).kind,'unknown');
 }finally{await rm(home,{recursive:true,force:true});}
});
