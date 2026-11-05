import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,unlink,lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('partial installation is removable; duplicate and non-normalized destinations fail before deletion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-link-test-')),target=join(dir,'checkout'),source=join(dir,'source/upstream/happier');
 try{
  for(const path of ['scripts','upstream/happier/node_modules/@happier-dev','upstream/happier/apps/server'])await mkdir(join(target,path),{recursive:true});
  for(const path of ['node_modules/@happier-dev','apps/server/node_modules','apps/server/generated'])await mkdir(join(source,path),{recursive:true});
  await copyFile(resolve('scripts/link-happier-test-deps.mjs'),join(target,'scripts/link-happier-test-deps.mjs'));
  for(const path of ['node_modules/a','node_modules/b','node_modules/@happier-dev/pkg'])await writeFile(join(source,path),'fixture');
  const invoke=(...args)=>spawnSync(process.execPath,[join(target,'scripts/link-happier-test-deps.mjs'),...args],{encoding:'utf8'});
  const manifest=join(dir,'manifest.json');assert.equal(invoke('install',source,manifest).status,0);
  const data=JSON.parse(await readFile(manifest,'utf8'));await unlink(data.entries.at(-1).to);
  const duplicate=join(dir,'duplicate.json');await writeFile(duplicate,JSON.stringify({...data,entries:[data.entries[0],data.entries[0]]}));assert.notEqual(invoke('remove',duplicate).status,0);
  const traversal=join(dir,'traversal.json');await writeFile(traversal,JSON.stringify({...data,entries:[{...data.entries[0],to:join(target,'upstream/happier/node_modules')+'/../escape'}]}));assert.notEqual(invoke('remove',traversal).status,0);
  assert((await lstat(data.entries[0].to)).isSymbolicLink());assert.equal(invoke('remove',manifest).status,0);
  for(const entry of data.entries)await assert.rejects(lstat(entry.to),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
