// Minimal two-attempt physical correction bench: no Happier or planner service.
import {buildFlowImage} from './r3-flow-build-image.mjs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,open,readFile,rm,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
const root=resolve(import.meta.dirname,'..'),label='ac-r3-flow-correction-'+randomUUID().replaceAll('-','').slice(0,16);
let scratch,pgId,image,network,env;const errors=[];
function run(command,args,options={}){const result=spawnSync(command,args,{env,encoding:'utf8',timeout:120000,...options});if(result.error||result.status!==0)throw Error('R4_CORRECTION_COMMAND_FAILED '+command+' '+(result.error?.message??result.stderr??result.status));return result.stdout?.trim()??'';}
try{
 if(process.versions.node!=='22.23.3')throw Error('PINNED_NODE_22_23_3_REQUIRED');
 if(!process.env.AC_R3_FLOW_PUBLIC_CODEX_BINARY||!/^[a-f0-9]{64}$/.test(process.env.AC_R3_FLOW_PUBLIC_CODEX_SHA256??''))throw Error('R3_FLOW_PINNED_PUBLIC_CODEX_REQUIRED');
 scratch=await mkdtemp(join(tmpdir(),'ac-r4-correction-runner-'));const logs=await mkdtemp(join(process.env.AC_ISOLATED_LOG_DIR??tmpdir(),'ac-r4-correction-logs-'));
 env={HOME:scratch,PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'};
 console.log('R4_CORRECTION_LAB '+JSON.stringify({label,scratch,logs,officialAccounts:false,inference:'deterministic',happier:false}));
 for(const name of ['src','tests','db','adapters','upstream','node_modules','package.json','scripts','services'])await symlink(join(root,name),join(scratch,name));
 await mkdir(join(scratch,'.state/projects'),{recursive:true});
 pgId=run('docker',['run','-d','--pull=never','--name',label+'-pg','--label','agent-control.correction-lab='+label,'--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=256m','-e','POSTGRES_PASSWORD=synthetic-r4-correction','-e','POSTGRES_DB=ac_implementation_test','-p','127.0.0.1::5432','postgres:16-alpine']);
 const info=JSON.parse(run('docker',['inspect',pgId]))[0],port=info.NetworkSettings.Ports['5432/tcp'][0].HostPort,url='postgresql://postgres:synthetic-r4-correction@127.0.0.1:'+port+'/ac_implementation_test';
 let ready=false;for(let attempt=0;attempt<100;attempt++){const client=new pg.Client({connectionString:url,connectionTimeoutMillis:200});try{await client.connect();await client.query('SELECT 1');ready=true;break;}catch{}finally{await client.end().catch(()=>{});}await new Promise(resolve=>setTimeout(resolve,100));}if(!ready)throw Error('R4_CORRECTION_PG_TIMEOUT');
 image=await buildFlowImage({root,scratch,project:label,run,publicBinary:process.env.AC_R3_FLOW_PUBLIC_CODEX_BINARY,expectedSha256:process.env.AC_R3_FLOW_PUBLIC_CODEX_SHA256,fixtureDirectory:join(root,'tests/fixtures/r4-correction-worker')});
 const version=run('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--label','agent-control.synthetic-fixture='+label,'--entrypoint','/usr/local/bin/codex',image,'--version']);
 network=run('docker',['network','create','--internal','--subnet','10.251.248.0/28','--label','agent-control.synthetic-fixture='+label,label]);
 const log=await open(join(logs,'tests.log'),'w',0o600);
 try{const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1',join(root,'tests/r4-native-qa-correction.test.ts')],{cwd:scratch,env:{...env,AC_TEST_DATABASE_URL:url,AC_R3_FLOW_IMAGE:image,AC_R3_FLOW_NETWORK:network,AC_R3_FLOW_LABEL:label,AC_R3_FLOW_TOOLS_KIND:'codex-exec-server',AC_R3_FLOW_PUBLIC_CODEX_SHA256:process.env.AC_R3_FLOW_PUBLIC_CODEX_SHA256,AC_R3_FLOW_PUBLIC_CODEX_VERSION:version},stdio:['ignore',log.fd,log.fd],timeout:210000,killSignal:'SIGTERM'});if(result.error||result.status!==0)throw Error('R4_CORRECTION_TEST_FAILED '+(result.error?.message??result.status)+' '+join(logs,'tests.log'));}finally{await log.close();}
 const output=await readFile(join(logs,'tests.log'),'utf8');if(/^# skipped [1-9]/m.test(output)||/# SKIP\b/.test(output))throw Error('R4_CORRECTION_SKIPPED_CASES');
 console.log(output);console.log('R4_CORRECTION_PASSED '+JSON.stringify({label,logs,tools:version,toolsSha256:process.env.AC_R3_FLOW_PUBLIC_CODEX_SHA256}));
}catch(error){console.error(error);process.exitCode=1;}
finally{
 if(env){
  try{const ids=run('docker',['ps','-aq','--no-trunc','--filter','label=agent-control.synthetic-fixture='+label]).split('\n').filter(Boolean);for(const id of ids){const item=JSON.parse(run('docker',['inspect',id]))[0];if(item.Config.Labels['agent-control.synthetic-fixture']!==label||image&&item.Image!==image)throw Error('R4_CORRECTION_CONTAINER_IDENTITY_CHANGED');run('docker',['rm','-f',id]);}}catch(error){errors.push(error);}
  if(network)try{const item=JSON.parse(run('docker',['network','inspect',network]))[0];if(item.Id!==network||item.Labels['agent-control.synthetic-fixture']!==label)throw Error('R4_CORRECTION_NETWORK_IDENTITY_CHANGED');run('docker',['network','rm',network]);}catch(error){errors.push(error);}
  if(image)try{if(run('docker',['image','inspect','--format','{{.Id}}',label])!==image)throw Error('R4_CORRECTION_IMAGE_IDENTITY_CHANGED');run('docker',['image','rm',label]);}catch(error){errors.push(error);}
  if(pgId)try{const item=JSON.parse(run('docker',['inspect',pgId]))[0];if(item.Id!==pgId||item.Config.Labels['agent-control.correction-lab']!==label)throw Error('R4_CORRECTION_PG_IDENTITY_CHANGED');run('docker',['rm','-f',pgId]);}catch(error){errors.push(error);}
 }
 if(scratch)await rm(scratch,{recursive:true,force:true});if(errors.length){console.error(new AggregateError(errors,'R4_CORRECTION_CLEANUP_FAILED'));process.exitCode=1;}
}
