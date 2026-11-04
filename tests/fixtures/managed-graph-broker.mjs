// Dedicated disposable broker for the synthetic managed graph proof.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {brokerMain} from '../../src/sandbox-broker.ts';
const databaseUrl=process.env.AC_SANDBOX_DATABASE_URL,tag=process.env.AC_MANAGED_LAB_TAG,root=process.env.AC_LAB_PROJECT_DIR;
if(!databaseUrl||!/^postgresql:\/\/ac_lab:synthetic-sandbox-only@sandbox-db:5432\/ac_managed_test_[a-f0-9]+$/.test(databaseUrl)||
 !tag||!/^[a-f0-9]{8,32}$/.test(tag)||!root||!isAbsolute(root)||resolve(root)!==root)throw Error('ISOLATED_MANAGED_LAB_CONFIG_REQUIRED');
const paths={probeHostPath:`${root}/scripts/sandbox-probe.mjs`,implementationPath:`${root}/scripts/synthetic-worker.mjs`,
 verificationPath:`${root}/scripts/sandbox-verifier.mjs`,verifierPath:`${root}/scripts/synthetic-verifier.mjs`};
const expected={probeHostPath:'ffbcfcb6bbaec702ff886ed0d72d4458265ad0e8410dd1d5d9b4c70eec2fba66',
 implementationPath:'f019c0cb891f6b1891e6f5589a007e41a95b4c83ae0d3468921417545d0fbc4b',
 verificationPath:'5f648bd2e30bd4188fc8c73cfd79bfdf0702759593e6046403234b6f49683015',
 verifierPath:'e43333eb2436790d76d3d37d9e5a27f140eba92b69804f5854f190a2663b3968'};
for(const key of Object.keys(paths))if(createHash('sha256').update(await readFile(paths[key])).digest('hex')!==expected[key])throw Error('MANAGED_FIXTURE_DIGEST_MISMATCH');
const instance=await brokerMain({...paths,hostRoot:`${root}/.state/sandbox/managed-graph-${tag}`,
 probeSha256:expected.probeHostPath,implementationSha256:expected.implementationPath,verificationSha256:expected.verificationPath,verifierSha256:expected.verifierPath,
 imageId:'sha256:9914706a4d692f9e87c9c17313efbf3f0544574e1ebc3ddf77512a54eb5cb7b3',socketPath:'/run/ac-broker/control.sock',keyPath:'/run/ac-broker/key',databaseUrl});
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));process.once('SIGTERM',stop);process.once('SIGINT',stop);
