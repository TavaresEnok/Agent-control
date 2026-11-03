// Build context contains only a worker bundle and a checksum-pinned public CLI.
// No Docker build, credentials, authentication, network or model call is performed.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,realpath,copyFile,readFile,writeFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.length!==4)throw Error('Usage: prepare-native-planning-image.mjs PUBLIC_CODEX_ELF EXPECTED_SHA256');
const binary=resolve(process.argv[2]),expected=process.argv[3];if(!/^[a-f0-9]{64}$/.test(expected))throw Error('PUBLIC_BINARY_DIGEST_REQUIRED');
const info=await lstat(binary);if(!info.isFile()||info.isSymbolicLink()||await realpath(binary)!==binary||info.size>512*1024*1024)throw Error('PUBLIC_BINARY_INVALID');
const bytes=await readFile(binary);if(bytes[0]!==127||bytes.subarray(1,4).toString()!=='ELF'||createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('PUBLIC_BINARY_DIGEST_MISMATCH');
const root=join(repo,'.state');await mkdir(root,{mode:0o700,recursive:true});
const rootInfo=await lstat(root);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||(rootInfo.mode&0o022)!==0||rootInfo.uid!==process.getuid?.()||await realpath(root)!==root)throw Error('UNSAFE_BUILD_CONTEXT_ROOT');
// Private exclusive directory prevents overwriting a prior code/binary build.
const context=await mkdtemp(join(root,'native-planning-image-'));await chmod(context,0o700);
execFileSync(join(repo,'upstream/cezar/node_modules/.bin/esbuild'),[join(repo,'src/native-planning-worker.ts'),'--bundle','--platform=node','--target=node22','--format=esm',
 '--banner:js=import { createRequire as __acCreateRequire } from "node:module"; const require = __acCreateRequire(import.meta.url);',
 '--outfile='+join(context,'native-planning-worker.mjs')],{cwd:repo,stdio:'inherit',timeout:30000});
await writeFile(join(context,'codex'),bytes,{mode:0o555,flag:'wx'});bytes.fill(0);
await copyFile(join(repo,'deploy/Dockerfile.native-planning'),join(context,'Dockerfile'));await chmod(join(context,'Dockerfile'),0o600);
const bundle=await readFile(join(context,'native-planning-worker.mjs')),dockerfile=await readFile(join(context,'Dockerfile'));
await writeFile(join(context,'MANIFEST.json'),JSON.stringify({schemaVersion:1,publicCodexSha256:expected,bundleSha256:createHash('sha256').update(bundle).digest('hex'),
 dockerfileSha256:createHash('sha256').update(dockerfile).digest('hex'),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),worktreeChangesPresent:execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim().length>0,
 credentialFilesIncluded:false,inferencePerformed:false},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({context,prepared:true,built:false,activated:false}));
