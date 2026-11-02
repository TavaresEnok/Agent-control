import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join,sep} from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname);
if(process.cwd()!==root||!process.argv[2])throw Error('ISOLATED_RESTORE_DIRECTORY_REQUIRED');
const restored=await realpath(process.argv[2]),allowed=await realpath(join(root,'.state/restores'));
if(!restored.startsWith(allowed+sep))throw Error('RESTORE_OUTSIDE_ISOLATED_AREA');
const manifest=JSON.parse(await readFile(join(restored,'MANIFEST.json'),'utf8'));
const imported=JSON.parse(await readFile(join(restored,'DATABASE_IMPORT.json'),'utf8'));
if(manifest.scope!=='isolated-synthetic-lab'||manifest.root!==root||!/^ac_restore_[a-f0-9]{16}$/.test(imported.database))throw Error('NEW_LAB_IMPORT_REQUIRED');
const relocated=JSON.parse(execFileSync(process.execPath,['scripts/relocate-restored-worktrees.mjs',restored],{cwd:root,encoding:'utf8'}));
let verified=0;
async function verifyOriginal(){
let count=0;for(const item of manifest.files){
 const path=resolve(root,item.path);if(!path.startsWith(join(root,'.state')+sep))throw Error('INVALID_SOURCE_MANIFEST_PATH');
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
 assert.equal(hash.digest('hex'),item.sha256,'original source changed: '+item.path);count++;
}return count;}
verified=await verifyOriginal();
const smoke=JSON.parse(execFileSync('docker',['compose','-f','deploy/compose.lab.yml','run','--rm','--no-deps','-T',
 '-v',root+':'+root,'-e','AC_TEST_DATABASE_URL=postgresql://ac_lab:synthetic-lab-only@db:5432/'+imported.database,
 'runtime','node','--import','tsx','tests/fixtures/restored-runtime-smoke.ts',restored],{cwd:root,encoding:'utf8',maxBuffer:1048576}));
assert.equal(smoke.result,'passed');
assert.equal(await verifyOriginal(),verified);
const result={result:'passed',synthetic:true,...relocated,originalFilesVerified:verified,sourceVerifiedAfterStartup:true,restoredRuntime:smoke,
 limitation:'Restored pointer files and managed runtime only; full conversation UI, external effects and off-host recovery remain unverified.'};
await writeFile('docs/validation/evidence/restored-worktrees-proof.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
