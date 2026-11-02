import {lstatSync,readlinkSync,readdirSync,symlinkSync,unlinkSync,mkdirSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=join(root,'dist');
function info(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function ownedLink(target,source){
 if(resolve(dirname(target),readlinkSync(target))!==source)throw Error('UNEXPECTED_BUILD_SYMLINK');
}
function assertOutput(){
 const entry=info(output);
 if(entry&&(!entry.isDirectory()||entry.isSymbolicLink()))throw Error('BUILD_OUTPUT_ROOT_UNSAFE');
 mkdirSync(output,{recursive:true});
}
function removeRuntimeLinks(target,source){
 const entry=info(target);if(!entry)return;
 if(entry.isSymbolicLink()){ownedLink(target,source);unlinkSync(target);return;}
 if(entry.isDirectory())for(const name of readdirSync(target))removeRuntimeLinks(join(target,name),join(source,name));
 else if(!entry.isFile())throw Error('BUILD_OUTPUT_ENTRY_UNSAFE');
}
function parents(target){
 const names=relative(output,dirname(target)).split('/').filter(Boolean);let cursor=output;
 for(const name of names){cursor=join(cursor,name);const entry=info(cursor);
  if(entry&&(!entry.isDirectory()||entry.isSymbolicLink()))throw Error('BUILD_PARENT_SYMLINK');
  if(!entry)mkdirSync(cursor);
 }
}
function overlayRuntime(source,target){
 const origin=info(source);if(!origin)throw Error('BUILD_RUNTIME_SOURCE_MISSING');
 parents(target);const entry=info(target);
 if(!entry){symlinkSync(relative(dirname(target),source),target,origin.isDirectory()?'dir':'file');return;}
 if(entry.isSymbolicLink()){ownedLink(target,source);return;}
 if(entry.isDirectory()&&origin.isDirectory()){
  for(const name of readdirSync(source))overlayRuntime(join(source,name),join(target,name));
 }else if(!entry.isFile()||!origin.isFile())throw Error('BUILD_RUNTIME_COLLISION');
 // Real emitted files always win over runtime resource overlays.
}
assertOutput();
if(process.argv[2]==='--before'){
 // Never let TypeScript follow a runtime link back into the checkout.
 for(const name of ['upstream','db','scripts','services'])removeRuntimeLinks(join(output,name),join(root,name));
}else if(process.argv.length===2){
 for(const name of ['upstream/cezar/packages/cezar','upstream/happier','db','scripts','services'])
  overlayRuntime(join(root,name),join(output,name));
}else throw Error('BUILD_PREPARATION_MODE_INVALID');
