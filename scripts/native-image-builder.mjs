import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,realpath,copyFile,readFile,writeFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
const kinds={planning:{entry:'native-planning-worker',dockerfile:'Dockerfile.native-planning'},execution:{entry:'native-execution-worker',dockerfile:'Dockerfile.native-execution'},tools:{entry:'native-tools-worker',dockerfile:'Dockerfile.native-tools'}};
/** Creates an exclusive private Docker context, without building or executing it. */
export async function prepareNativeImage(kind,binaryPath,expected){
 const selected=Object.hasOwn(kinds,kind)?kinds[kind]:undefined;if(!selected||!binaryPath||!/^[a-f0-9]{64}$/.test(expected??''))throw Error('PUBLIC_BINARY_DIGEST_REQUIRED');
 const binary=resolve(binaryPath),info=await lstat(binary);
 if(!info.isFile()||info.isSymbolicLink()||await realpath(binary)!==binary||info.size>512*1024*1024)throw Error('PUBLIC_BINARY_INVALID');
 const bytes=await readFile(binary);if(bytes[0]!==127||bytes.subarray(1,4).toString()!=='ELF'||createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('PUBLIC_BINARY_DIGEST_MISMATCH');
 const root=join(repo,'.state');await mkdir(root,{mode:0o700,recursive:true});const rootInfo=await lstat(root);
 if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||(rootInfo.mode&0o022)!==0||rootInfo.uid!==process.getuid?.()||await realpath(root)!==root)throw Error('UNSAFE_BUILD_CONTEXT_ROOT');
 const context=await mkdtemp(join(root,`native-${kind}-image-`));await chmod(context,0o700);
 const bundlePath=join(context,selected.entry+'.mjs');
 execFileSync(join(repo,'upstream/cezar/node_modules/.bin/esbuild'),[join(repo,'src',selected.entry+'.ts'),'--bundle','--platform=node','--target=node22','--format=esm',
  '--banner:js=import { createRequire as __acCreateRequire } from "node:module"; const require = __acCreateRequire(import.meta.url);','--outfile='+bundlePath],{cwd:repo,stdio:'inherit',timeout:30000});
 await writeFile(join(context,'codex'),bytes,{mode:0o555,flag:'wx'});bytes.fill(0);
 await copyFile(join(repo,'deploy',selected.dockerfile),join(context,'Dockerfile'));await chmod(join(context,'Dockerfile'),0o600);
 const bundle=await readFile(bundlePath),dockerfile=await readFile(join(context,'Dockerfile'));
 await writeFile(join(context,'MANIFEST.json'),JSON.stringify({schemaVersion:1,kind,publicCodexSha256:expected,bundleSha256:createHash('sha256').update(bundle).digest('hex'),
  dockerfileSha256:createHash('sha256').update(dockerfile).digest('hex'),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  worktreeChangesPresent:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim().length>0,credentialFilesIncluded:false,inferencePerformed:false},null,2)+'\n',{mode:0o600,flag:'wx'});
 return {context,prepared:true,built:false,activated:false};
}
