import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {acquireRecoveryCatalogLease} from '../src/recovery-catalog-lease.ts';

const exec=promisify(execFile);
test('transport lease persists pending intent and rejects a stale epoch',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ac-t30-lease-ts-')),installationId=randomUUID(),modulePath=resolve('services/recovery/catalog.py');
 const run=async(code:string,args:string[])=>exec('/usr/bin/python3',['-c',`import importlib.util,sys,json\ns=importlib.util.spec_from_file_location('catalog',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n${code}`,modulePath,...args]);
 try{
  const init=await run("print(json.dumps(m.initialize(sys.argv[2],sys.argv[3],[{'kind':'ssh','id':'fixture','identity':{'hostKey':'fixture'}}])))",[directory,installationId]);
  const catalogId=JSON.parse(init.stdout).catalogId,request={directory,installationId,catalogId,epoch:1,kind:'ssh' as const,authority:'fixture',operation:'effect-1',requestDigest:'a'.repeat(64)};
  const lease=await acquireRecoveryCatalogLease(request);await lease.release();
  const state=await run("\nwith m.Catalog(sys.argv[2],sys.argv[3],sys.argv[4]) as c:\n print(json.dumps(c.state()))\n c.advance(1)",[directory,installationId,catalogId]);
  assert.ok(JSON.parse(state.stdout)[1]['effect-1']);
  await assert.rejects(acquireRecoveryCatalogLease({...request,operation:'late'}),/CATALOG_EPOCH_FENCED/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
