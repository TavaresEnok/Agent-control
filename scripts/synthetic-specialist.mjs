// Fixed synthetic specialist: observes a private, read-only source snapshot.
import {existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const value=JSON.parse(Buffer.from(process.argv[2]??'','base64').toString('utf8'));
if(!value||typeof value!=='object'||!/^[a-f0-9]{40}$/.test(value.sourceBase??''))throw Error('INVALID_SPECIALIST_INPUT');
const visible=['/var/run/docker.sock','/run/ac-broker/control.sock','/run/ac-broker/key','/peer/secret','/control/.state/browser-fixture.json'].filter(existsSync);
let readOnlySnapshot=false;
try{writeFileSync('/work/.specialist-write-probe','forbidden',{flag:'wx'});}catch(error){
 if(['EROFS','EACCES'].includes(error.code))readOnlySnapshot=true;else throw error;
}
const isolation={readOnlySnapshot,uid:process.getuid(),visible};
if(!readOnlySnapshot||isolation.uid!==10001||visible.length)throw Error('SPECIALIST_ISOLATION_FAILED');
const head=execFileSync('git',['-C','/work','rev-parse','HEAD'],{encoding:'utf8',timeout:10000,
 env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();
if(head!==value.sourceBase)throw Error('SPECIALIST_SOURCE_MISMATCH');
const advice={...value,verdict:'proceed',summary:'Synthetic pre-implementation advice'};
writeFileSync('/output/advice-result.json',JSON.stringify({advice,isolation})+'\n',{mode:0o644,flag:'wx'});
