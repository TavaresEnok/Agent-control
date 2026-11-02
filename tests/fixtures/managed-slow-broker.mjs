// Dedicated disposable broker for the slow-worker physical test only.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {brokerMain} from '../../src/sandbox-broker.ts';
const databaseUrl=process.env.AC_SANDBOX_DATABASE_URL,tag=process.env.AC_MANAGED_LAB_TAG;
if(!databaseUrl||!/^postgresql:\/\/ac_lab:synthetic-sandbox-only@sandbox-db:5432\/ac_managed_test_[a-f0-9]+$/.test(databaseUrl)||!tag||!/^[a-f0-9]{8,32}$/.test(tag))throw Error('ISOLATED_MANAGED_LAB_CONFIG_REQUIRED');
const root='/home/app/projects/agent-control-implementation',probeHostPath=`${root}/scripts/sandbox-probe.mjs`,implementationPath=`${root}/tests/fixtures/managed-slow-worker.mjs`;
const sha=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const implementationSha256='d3f15d54e2add5e3a996e9624da230d4c9fc9364ac20766872119ea0b705163a';
if(await sha(implementationPath)!==implementationSha256)throw Error('SLOW_WORKER_DIGEST_MISMATCH');
const instance=await brokerMain({hostRoot:`${root}/.state/sandbox/managed-slow-${tag}`,probeHostPath,probeSha256:await sha(probeHostPath),implementationPath,implementationSha256,
 imageId:'sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3',socketPath:'/run/ac-broker/control.sock',keyPath:'/run/ac-broker/key',databaseUrl});
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));process.once('SIGTERM',stop);process.once('SIGINT',stop);
