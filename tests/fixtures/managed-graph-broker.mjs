// Dedicated disposable broker for the synthetic managed graph proof.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {brokerMain} from '../../src/sandbox-broker.ts';
import {Refusal} from '../../src/contracts.ts';
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
if(['remove-ack-lost','remove-crash'].includes(process.env.AC_MANAGED_RETIREMENT_FAULT)){
 const docker=instance.broker['docker'],remove=docker.remove.bind(docker);let injected=false;
 docker.remove=async id=>{
  await remove(id);
  if(!injected){
   const rows=(await instance.broker.ledger.pool.query(`SELECT w.state writer_state,r.state retirement_state FROM ac_sandbox_writer_retirements r
    JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.container_id=$1`,[id])).rows;
   if(rows.length){
    if(rows[0].writer_state!=='held'||rows[0].retirement_state!=='prepared')throw Error('RETIREMENT_RELEASED_TOO_EARLY');
    injected=true;console.log('SYNTHETIC_RETIREMENT_REMOVE_ACK_LOST; writer=held; retirement=prepared');
    if(process.env.AC_MANAGED_RETIREMENT_FAULT==='remove-crash'){
     process.stdout.write('SYNTHETIC_BROKER_CRASH_AFTER_REMOVAL\n',()=>process.exit(77));
     return new Promise(()=>{});
    }
    throw new Refusal('DOCKER_REMOVE_UNCERTAIN');
   }
  }
 };
}
const stop=()=>void instance.stop().then(()=>process.exit(0)).catch(()=>process.exit(1));process.once('SIGTERM',stop);process.once('SIGINT',stop);
