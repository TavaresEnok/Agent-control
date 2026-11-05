import {readFile} from 'node:fs/promises';
import {brokerMain} from '../../src/sandbox-broker.ts';
if(process.env.AC_R2_SANDBOX_PHYSICAL!=='1'||!process.argv[2]?.startsWith('/tmp/ac-r2-sandbox-')||!/^\/ac_r2_sandbox_[a-z0-9]+$/.test(new URL(process.env.AC_TEST_DATABASE_URL??'').pathname))throw Error('ISOLATED_ROOT_FIXTURE_REQUIRED');
const config=JSON.parse(await readFile(process.argv[2],'utf8'));config.databaseUrl=process.env.AC_TEST_DATABASE_URL;
const instance=await brokerMain(config);
if(process.env.AC_R2_CRASH_REMOVE==='1'){
 const remove=instance.broker.docker.remove.bind(instance.broker.docker);
 instance.broker.docker.remove=async id=>{
  await remove(id);
  const row=(await instance.broker.ledger.pool.query(`SELECT r.state,w.state writer FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id WHERE r.container_id=$1`,[id])).rows[0];
  if(!row||row.state!=='prepared'||row.writer!=='held')throw Error('JOURNAL_MISSING');
  process.stdout.write('REMOVED_ACK_LOST\n',()=>process.exit(77));await new Promise(()=>{});
 };
}
process.stdout.write('BROKER_READY\n');
process.on('SIGTERM',()=>void instance.stop().then(()=>process.exit(0)));
