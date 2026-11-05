import {createHash} from 'node:crypto';
import {chmod,copyFile,lstat,mkdir,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
/** Offline, public ELF only. Never copies a HOME, CLI config or account file. */
export async function buildFlowImage({root,scratch,project,run,publicBinary,expectedSha256}){
 if(!publicBinary||!/^[a-f0-9]{64}$/.test(expectedSha256??''))throw Error('R3_FLOW_PINNED_PUBLIC_CODEX_REQUIRED');
 const binary=resolve(publicBinary),stat=await lstat(binary);
 if(!stat.isFile()||stat.isSymbolicLink()||await realpath(binary)!==binary||stat.size>512*1024*1024)throw Error('R3_FLOW_PUBLIC_CODEX_INVALID');
 const bytes=await readFile(binary);if(bytes[0]!==127||bytes.subarray(1,4).toString()!=='ELF'||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw Error('R3_FLOW_PUBLIC_CODEX_DIGEST_MISMATCH');
 const context=join(scratch,'image-context');await mkdir(context,{mode:0o700});
 const fixture=join(root,'tests/fixtures/r3-flow-worker');for(const name of ['Dockerfile','worker.mjs','planning.mjs','verify.mjs'])await copyFile(join(fixture,name),join(context,name));
 await copyFile(binary,join(context,'codex'));await chmod(join(context,'codex'),0o555);
 const esbuild=join(root,'upstream/cezar/node_modules/.bin/esbuild'),banner='--banner:js=import { createRequire as __acCreateRequire } from "node:module"; const require = __acCreateRequire(import.meta.url);';
 for(const [input,output] of [[join(root,'src/native-tools-worker.ts'),'native-tools-worker.mjs'],[join(fixture,'exec-client.mjs'),'exec-client.mjs']])run(esbuild,[input,'--bundle','--platform=node','--target=node22','--format=esm',banner,'--outfile='+join(context,output)]);
 run('docker',['image','inspect','agent-control-lab:0.1.0']);run('docker',['build','--pull=false','--network=none','--label',`agent-control.synthetic-fixture=${project}`,'-t',project,context]);
 return run('docker',['image','inspect','--format','{{.Id}}',project]);
}
