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
const probeHostPath=file('sandbox-probe.mjs'),implementationPath=file('synthetic-worker.mjs'),verificationPath=file('sandbox-verifier.mjs'),verifierPath=`${root}/tests/fixtures/synthetic-correction-verifier.mjs`;
if(await sha(verifierPath)!=='106f888537a1c0ea4b6c70291987842993cb778808654893d17c7b013960efcb')throw Error('CORRECTION_VERIFIER_DIGEST_MISMATCH');
const config={hostRoot:`${root}/.state/sandbox/managed-${tag}`,probeHostPath,probeSha256:await sha(probeHostPath),
 implementationPath,implementationSha256:await sha(implementationPath),verificationPath,verificationSha256:await sha(verificationPath),
 verifierPath,verifierSha256:await sha(verifierPath),imageId:'sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3',
 socketPath:'/run/ac-broker/control.sock',keyPath:'/run/ac-broker/key',databaseUrl};
const instance=await brokerMain(config);
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));
process.once('SIGTERM',stop);process.once('SIGINT',stop);
