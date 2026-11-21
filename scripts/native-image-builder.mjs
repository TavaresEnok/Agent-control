import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,realpath,copyFile,readFile,writeFile,chmod} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
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
 // Planning and execution workers also launch Claude and Grok. Optional ELF binaries, named by env, are copied into extra-bin/.
 const extra={};await mkdir(join(context,'extra-bin'),{mode:0o700});
 if(kind!=='tools')for(const [name,variable] of [['claude','AC_NATIVE_CLAUDE_BIN'],['grok','AC_NATIVE_GROK_BIN']]){
  const source=process.env[variable];if(!source)continue;
  const path=await realpath(resolve(source)),data=await readFile(path);
  if(data[0]!==127||data.subarray(1,4).toString()!=='ELF'||data.length>512*1024*1024)throw Error(variable+'_NOT_ELF');
  extra[name]=createHash('sha256').update(data).digest('hex');await writeFile(join(context,'extra-bin',name),data,{mode:0o555,flag:'wx'});data.fill(0);
 }
 // The Codex CLI runs its file tools through a companion binary that ships beside it; without it a reviewer cannot read the checkout.
 if(kind!=='tools'){
  const helper=join(dirname(binary),'codex-code-mode-host');
  const found=await lstat(helper).then(i=>i.isFile()&&!i.isSymbolicLink(),()=>false);
  if(found){const data=await readFile(helper);if(data[0]===127&&data.subarray(1,4).toString()==='ELF'&&data.length<=512*1024*1024){extra['codex-code-mode-host']=createHash('sha256').update(data).digest('hex');await writeFile(join(context,'extra-bin','codex-code-mode-host'),data,{mode:0o555,flag:'wx'});}data.fill(0);}
 }
 await copyFile(join(repo,'deploy',selected.dockerfile),join(context,'Dockerfile'));await chmod(join(context,'Dockerfile'),0o600);
 if(kind==='execution'){await copyFile(join(repo,'deploy','ac-exam-claude.cjs'),join(context,'ac-exam-claude.cjs'));await chmod(join(context,'ac-exam-claude.cjs'),0o755);}
 // Hardened Claude wrappers (src/claude-hardening.ts): the execution and planning images both run Claude.
 if(kind==='execution'||kind==='planning')for(const wrapper of ['ac-claude-evaluator.cjs','ac-claude-programmer.cjs']){await copyFile(join(repo,'deploy',wrapper),join(context,wrapper));await chmod(join(context,wrapper),0o755);}
 const bundle=await readFile(bundlePath),dockerfile=await readFile(join(context,'Dockerfile'));
 await writeFile(join(context,'MANIFEST.json'),JSON.stringify({schemaVersion:1,kind,publicCodexSha256:expected,extraBinarySha256:extra,bundleSha256:createHash('sha256').update(bundle).digest('hex'),
  dockerfileSha256:createHash('sha256').update(dockerfile).digest('hex'),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  worktreeChangesPresent:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim().length>0,credentialFilesIncluded:false,inferencePerformed:false},null,2)+'\n',{mode:0o600,flag:'wx'});
 return {context,prepared:true,built:false,activated:false};
}
