import {createHash} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
/** Offline, public ELF only. Never copies a HOME, CLI config or account file. */
export async function buildFlowImage({root,scratch,project,run,publicBinary,expectedSha256,fixtureDirectory,r6PlanningFixture=false}){
 if(!publicBinary||!/^[a-f0-9]{64}$/.test(expectedSha256??''))throw Error('R3_FLOW_PINNED_PUBLIC_CODEX_REQUIRED');
 const binary=resolve(publicBinary),stat=await lstat(binary);
 if(!stat.isFile()||stat.isSymbolicLink()||await realpath(binary)!==binary||stat.size>512*1024*1024)throw Error('R3_FLOW_PUBLIC_CODEX_INVALID');
 const bytes=await readFile(binary);if(bytes[0]!==127||bytes.subarray(1,4).toString()!=='ELF'||createHash('sha256').update(bytes).digest('hex')!==expectedSha256)throw Error('R3_FLOW_PUBLIC_CODEX_DIGEST_MISMATCH');
 const context=join(scratch,'image-context');await mkdir(context,{mode:0o700});
 const fixture=join(root,'tests/fixtures/r3-flow-worker');
 // Test-only trusted fixture override. Runtime installation/commands cannot set
 // this option; auxiliary verification/tools retain the existing contract.
 const override=fixtureDirectory?resolve(fixtureDirectory):undefined;
 if(override&&(!override.startsWith(resolve(root,'tests/fixtures')+'/')||await realpath(override)!==override))throw Error('R3_FLOW_FIXTURE_DIRECTORY_INVALID');
 for(const name of ['Dockerfile','worker.mjs','planning.mjs','verify.mjs']){
  const source=join(name==='worker.mjs'&&override?override:fixture,name),entry=await lstat(source);
  if(!entry.isFile()||entry.isSymbolicLink()||await realpath(source)!==source)throw Error('R3_FLOW_FIXTURE_SOURCE_INVALID');
  await copyFile(source,join(context,name));
 }
 await writeFile(join(context,'codex'),bytes,{flag:'wx',mode:0o555});bytes.fill(0);
 const esbuild=join(root,'upstream/cezar/node_modules/.bin/esbuild'),banner='--banner:js=import { createRequire as __acCreateRequire } from "node:module"; const require = __acCreateRequire(import.meta.url);';
 for(const [input,output] of [[join(root,'src/native-tools-worker.ts'),'native-tools-worker.mjs'],[join(fixture,'exec-client.mjs'),'exec-client.mjs']])run(esbuild,[input,'--bundle','--platform=node','--target=node22','--format=esm',banner,'--outfile='+join(context,output)]);
 if(r6PlanningFixture){
  const source=join(root,'tests/fixtures/r6-planning-worker');await copyFile(join(source,'app-server.mjs'),join(context,'r6-app-server.mjs'));
  run(esbuild,[join(source,'planning.ts'),'--bundle','--platform=node','--target=node22','--format=esm',banner,'--external:/opt/fixture/*','--outfile='+join(context,'planning.mjs')]);
  await writeFile(join(context,'Dockerfile'),(await readFile(join(context,'Dockerfile'),'utf8'))+'\nCOPY r6-app-server.mjs /opt/fixture/r6-app-server.mjs\nRUN chmod 755 /opt/fixture/r6-app-server.mjs && printf 1 > /opt/fixture/r6-version\n');
 }
 run('docker',['image','inspect','agent-control-lab:0.1.0']);run('docker',['build','--pull=false','--network=none','--label',`agent-control.synthetic-fixture=${project}`,'-t',project,context]);
 return run('docker',['image','inspect','--format','{{.Id}}',project]);
}
