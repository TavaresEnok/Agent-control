import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertRepositoryInsideRoot,listPersonalFolders} from '../src/personal-folders.ts';

test('personal folder listing refuses escape paths and accepts a symlink that stays inside',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'ac-folders-')));
 const root=join(parent,'root'),outside=join(parent,'outside');
 await mkdir(join(root,'inside','inside-only'),{recursive:true});
 await mkdir(join(outside,'outside-only'),{recursive:true});
 await symlink(outside,join(root,'escape'));
 await symlink(join(root,'inside'),join(root,'inbound'));
 const roots=[{id:'projects',label:'Projetos',path:root}];
 try{
  await assert.rejects(listPersonalFolders({roots,projectRepos:[],root:'projects',path:'..'}),/PROJECT_PATH_FORBIDDEN/);
  await assert.rejects(listPersonalFolders({roots,projectRepos:[],root:'projects',path:outside}),/PROJECT_PATH_FORBIDDEN/);
  await assert.rejects(listPersonalFolders({roots,projectRepos:[],root:'projects',path:'escape'}),/PROJECT_PATH_FORBIDDEN/);
  const accepted=await listPersonalFolders({roots,projectRepos:[],root:'projects',path:'inbound'});
  assert.ok('folders' in accepted);
  assert.equal(accepted.root,'projects');
  assert.equal(accepted.path,'inbound');
  assert.equal(accepted.folders.some(folder=>folder.name==='inside-only'),true);
  assert.equal(accepted.folders.some(folder=>folder.name==='outside-only'),false);
 }finally{await rm(parent,{recursive:true,force:true});}
});

test('a later realpath check still refuses a path that has left the root',async()=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'ac-inside-')));
 const root=join(parent,'root'),sibling=join(parent,'root-evil'),outside=join(parent,'outside');
 await mkdir(join(root,'project'),{recursive:true});
 await mkdir(sibling,{recursive:true});
 await mkdir(outside,{recursive:true});
 await symlink(outside,join(root,'escape'));
 try{
  await assertRepositoryInsideRoot(root,join(root,'project'));
  await assert.rejects(assertRepositoryInsideRoot(root,sibling),/PROJECT_PATH_FORBIDDEN/);
  await assert.rejects(assertRepositoryInsideRoot(root,join(root,'escape')),/PROJECT_PATH_FORBIDDEN/);
  await assert.rejects(assertRepositoryInsideRoot(root,join(root,'missing')),/PROJECT_PATH_FORBIDDEN/);
 }finally{await rm(parent,{recursive:true,force:true});}
});
