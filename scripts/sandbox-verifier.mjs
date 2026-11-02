// Fixed sandbox wrapper; reuses the original verifier mounted read-only.
import {spawnSync} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
const [operationId,role]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(operationId)||!['qa','review','judge'].includes(role))throw Error('INVALID_VERIFIER_ARGUMENT');
const visible=['/var/run/docker.sock','/run/ac-broker/control.sock','/run/ac-broker/key','/peer/secret','/control/.state/browser-fixture.json'].filter(existsSync);
let readOnlySnapshot=false;
try{writeFileSync('/work/.verifier-write-probe','forbidden',{flag:'wx'});}catch(error){
 if(['EROFS','EACCES'].includes(error.code))readOnlySnapshot=true;else throw error;
}
const isolation={readOnlySnapshot,uid:process.getuid(),visible};
if(!readOnlySnapshot||isolation.uid!==10001||visible.length)throw Error('VERIFIER_ISOLATION_FAILED');
const result=spawnSync(process.execPath,['/runner/verifier.mjs','/work',operationId,role],{
 env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp'},encoding:'utf8',timeout:15000,maxBuffer:65536});
if(result.error||result.status===null)throw Error('VERIFIER_INCOMPLETE');
writeFileSync('/output/verification-result.json',JSON.stringify({exitCode:result.status,output:result.stdout,
 nodeVersion:process.version,isolation,synthetic:true})+'\n',{mode:0o644,flag:'wx'});
process.exit(result.status);
