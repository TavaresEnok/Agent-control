// Disposable compose.lab fixture; rejects operational databases and paths.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {brokerMain} from '../../src/sandbox-broker.ts';
const databaseUrl=process.env.AC_SANDBOX_DATABASE_URL;
const tag=process.env.AC_MANAGED_LAB_TAG;
if(!databaseUrl||!/^postgresql:\/\/ac_lab:synthetic-sandbox-only@sandbox-db:5432\/ac_managed_test_[a-f0-9]+$/.test(databaseUrl)||
 !tag||!/^[a-f0-9]{8,32}$/.test(tag))throw Error('ISOLATED_MANAGED_LAB_CONFIG_REQUIRED');
const root='/home/app/projects/agent-control-implementation';
const file=path=>`${root}/scripts/${path}`;
const sha=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const probeHostPath=file('sandbox-probe.mjs'),implementationPath=file('synthetic-worker.mjs'),verificationPath=file('sandbox-verifier.mjs'),verifierPath=file('synthetic-verifier.mjs');
const specialistPath=`${root}/tests/fixtures/synthetic-specialist-policy.mjs`,specialistSha256='891336ced88111bc5c45ef4d4856869fc42b1a15743741ceeeffcb16ada4b0c5';
if(await sha(specialistPath)!==specialistSha256)throw Error('SPECIALIST_FIXTURE_DIGEST_MISMATCH');
const config={specialistPath,specialistSha256,hostRoot:`${root}/.state/sandbox/managed-${tag}`,probeHostPath,probeSha256:await sha(probeHostPath),
 implementationPath,implementationSha256:await sha(implementationPath),verificationPath,verificationSha256:await sha(verificationPath),
 verifierPath,verifierSha256:await sha(verifierPath),imageId:'sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3',
 socketPath:'/run/ac-broker/control.sock',keyPath:'/run/ac-broker/key',databaseUrl};
const instance=await brokerMain(config);
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));
process.once('SIGTERM',stop);process.once('SIGINT',stop);
