// New labelled resources only; canonical source code/dependencies are read from the pinned local cache.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import pg from 'pg';
const exec=promisify(execFile),root=resolve(import.meta.dirname,'..'),label='ac-r5-t30-recovery-'+randomUUID().slice(0,8),home=await mkdtemp(join(tmpdir(),'ac-r5-t30-recovery-runner-'));
let container;
const env={HOME:home,PATH:'/tmp/node-v22.23.3-linux-x64/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC'};
try{
 if(process.versions.node!=='22.23.3')throw Error('PINNED_NODE_22_23_3_REQUIRED');
 container=(await exec('docker',['run','-d','--name',label,'--label','ac.r3.front=migration','--label','ac.disposable=true','-e','POSTGRES_PASSWORD=synthetic-r3-migration','-e','POSTGRES_DB=ac_implementation_test','-p','127.0.0.1:0:5432','postgres:16-alpine'],{env,timeout:30000})).stdout.trim();
 const info=JSON.parse((await exec('docker',['inspect',container],{env,timeout:5000})).stdout)[0],port=info.NetworkSettings.Ports['5432/tcp'][0].HostPort,url=`postgresql://postgres:synthetic-r3-migration@127.0.0.1:${port}/ac_implementation_test`;
 let ready=false;for(let attempt=0;attempt<60;attempt++){const client=new pg.Client({connectionString:url,connectionTimeoutMillis:300});try{await client.connect();await client.query('SELECT 1');ready=true;break;}catch{}finally{await client.end().catch(()=>{});}await new Promise(ok=>setTimeout(ok,100));}if(!ready)throw Error('R3_POSTGRES_START_TIMEOUT');
 console.log('T30_RECOVERY_RUNNER '+JSON.stringify({label,disposable:true,node:process.versions.node}));
 const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','tests/r5-recovery-physical.test.ts'],{cwd:root,env:{...env,AC_TEST_DATABASE_URL:url,AC_R3_MIGRATION_CONTAINER_ID:container},stdio:['ignore','pipe','inherit']});let output='';child.stdout.on('data',bytes=>{output+=bytes.toString('utf8');process.stdout.write(bytes);});
 const [code]=await once(child,'exit');if(code!==0)throw Error('T30_RECOVERY_TEST_FAILED');if(/^# skipped [1-9]/m.test(output)||/# SKIP\b/i.test(output))throw Error('T30_RECOVERY_SKIPPED_CASES');
}finally{
 if(container){const info=JSON.parse((await exec('docker',['inspect',container],{env,timeout:5000})).stdout)[0];if(info.Config.Labels['ac.r3.front']!=='migration'||info.Config.Labels['ac.disposable']!=='true')throw Error('R3_RESOURCE_IDENTITY_CHANGED');await exec('docker',['rm','-f','-v',container],{env,timeout:10000});}
 await rm(home,{recursive:true,force:true});
}
