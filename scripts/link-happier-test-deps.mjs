// Link only absent ignored dependencies from an existing local Happier workspace.
// install SOURCE_ROOT MANIFEST; remove MANIFEST. Run from the checkout to modify.
import {lstat, readdir, readFile, realpath, symlink, unlink, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=join(root,'upstream/happier');
const [action,...args]=process.argv.slice(2);
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
if(action==='install' && args.length===2){
 const source=await realpath(resolve(args[0])),manifest=resolve(args[1]);
 if(source===target || !source.endsWith('/upstream/happier'))throw Error('SOURCE_MUST_BE_ANOTHER_HAPPIER_WORKSPACE');
 const entries=[];
 async function add(from,to){if(!await exists(from))throw Error(`MISSING_SOURCE ${from}`);if(!await exists(to))entries.push({from,to});}
 for(const entry of await readdir(join(source,'node_modules'))){
  if(entry==='@happier-dev')continue;
  await add(join(source,'node_modules',entry),join(target,'node_modules',entry));
 }
 for(const entry of await readdir(join(source,'node_modules/@happier-dev')))await add(join(source,'node_modules/@happier-dev',entry),join(target,'node_modules/@happier-dev',entry));
 for(const name of ['node_modules','generated'])await add(join(source,'apps/server',name),join(target,'apps/server',name));
 // Exclusive manifest reserves the destination before any mutation. Entries are
 // recorded ahead of creation; removal verifies both path and link target.
 await writeFile(manifest,JSON.stringify({root,entries},null,2),{flag:'wx',mode:0o600});
 let count=0;
 try{for(const {from,to} of entries){await symlink(from,to);count++;}}
 catch(e){for(const {to} of entries.slice(0,count).reverse())await unlink(to);await unlink(manifest);throw e;}
 console.log(`Created ${count} links; remove with: node scripts/link-happier-test-deps.mjs remove ${manifest}`);
}else if(action==='remove' && args.length===1){
 const manifest=resolve(args[0]),data=JSON.parse(await readFile(manifest,'utf8'));
 if(data.root!==root || !Array.isArray(data.entries))throw Error('INVALID_MANIFEST');
 for(const {from,to} of data.entries){
  if(typeof from!=='string'||typeof to!=='string'||!to.startsWith(target+'/')||!await exists(to))throw Error('CHANGED_LINK');
  const st=await lstat(to);if(!st.isSymbolicLink() || await realpath(to)!==await realpath(from))throw Error('CHANGED_LINK');
 }
 for(const {to} of [...data.entries].reverse())await unlink(to);
 await unlink(manifest);console.log(`Removed ${data.entries.length} links`);
}else throw Error('Usage: install SOURCE_HAPPIER_ROOT MANIFEST | remove MANIFEST');
