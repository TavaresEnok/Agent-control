import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

export const expectedSecretSurfaces = [
 'native-events-live','native-events-live-reconstructed','native-history-readEvents','native-history-reconstructed',
 'native-runs-json','native-event-ndjson','native-event-ndjson-reconstructed','managed-SSE-native-frame',
 'managed-api-/api/v1/runs','managed-api-/api/v1/runs/:runId','managed-api-/api/v1/runs/:runId/history',
 'private-route-denied-/api/v1/runs/:runId/logs','private-route-denied-/api/v1/ac/private/vault/master',
 'private-route-denied-/api/v1/workspace/secrets','portable-metadata','metadata-download-API',
 'encrypted-conversation-export','provider-failure-public-code','execution-user-and-system-prompts',
 'git-artifact-bundle-reachable-objects','durable-history-after-reopen','durable-history-reconstructed-after-reopen','durable-run-after-reopen',
].sort();

/** Reproduce the client-facing item reduction, keeping each run/step/item/field
 * separate. Snapshot events replace a field; delta events append to that field. */
export function reconstructedFields(input:unknown[],defaultRunId:string){
 const fields=new Map<string,string>();
 for(const raw of input){
  assert.ok(raw&&typeof raw==='object');const wrapper=raw as Record<string,unknown>;
  const event=(wrapper.event&&typeof wrapper.event==='object'?wrapper.event:wrapper) as Record<string,unknown>;
  const runId=typeof wrapper.runId==='string'?wrapper.runId:defaultRunId;
  if(event.type==='item.started'||event.type==='item.updated'){
   const item=event.item as Record<string,unknown>|undefined;if(!item||typeof item.id!=='string')continue;
   const field=item.kind==='tool'?'output':item.kind==='reasoning'?'reasoning':'text';
   const value=item[field==='reasoning'?'text':field];
   if(typeof value==='string')fields.set(JSON.stringify([runId,event.stepId,item.id,field]),value);
  }else if(event.type==='item.delta'){
   assert.equal(typeof event.itemId,'string');assert.equal(typeof event.field,'string');assert.equal(typeof event.delta,'string');
   const key=JSON.stringify([runId,event.stepId,event.itemId,event.field]);fields.set(key,(fields.get(key)??'')+event.delta);
  }
 }
 return fields;
}

/** Inspect decompressed contents of every object reachable from every exported
 * ref, including previous commits/trees and tag/commit text. Raw bundle bytes
 * cannot establish this property because pack objects are compressed. */
export async function inspectBundleObjects(bundle:string,inspect:(bytes:Buffer)=>void){
 const directory=await mkdtemp(join(tmpdir(),'ac-r4-bundle-inspection-'));
 try{
  const git=(...args:string[])=>execFileSync('git',['--git-dir',directory,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024});
  execFileSync('git',['clone','--mirror','--quiet',bundle,directory],{stdio:['ignore','pipe','pipe']});
  const refs=git('for-each-ref','--format=%(refname)');assert.ok(refs.length>0,'BUNDLE_HAS_NO_REFS');inspect(refs);
  const objects=git('rev-list','--objects','--all').toString('utf8').trim().split('\n');
  assert.ok(objects.length>0,'BUNDLE_HAS_NO_OBJECTS');let count=0;
  for(const row of objects){const id=row.split(' ')[0];assert.match(id,/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);inspect(Buffer.from(row));inspect(git('cat-file','-p',id));count++;}
  return {objectCount:count,refCount:refs.toString('utf8').trim().split('\n').length};
 }finally{await rm(directory,{recursive:true,force:true});}
}
