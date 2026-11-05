import {DockerDaemon} from '../../src/sandbox-broker.ts';
import type {Ledger} from '../../src/ledger.ts';

/** Clean only resources journaled by this disposable test database. Errors are
 * collected so a failed cleanup cannot mask the original test failure. */
export async function cleanupGraphResources(db:Ledger,image:string){
 const docker=new DockerDaemon(),errors:unknown[]=[];
 const jobs=(await db.pool.query('SELECT id,worker_id,tools_id,network_id FROM ac_native_execution_jobs')).rows;
 for(const job of jobs){
  for(const id of [job.worker_id,job.tools_id])if(id)try{
   const container=await docker.inspect(id);if(!container)continue;
   if(container.Config.Labels['agent-control.job']!==job.id||container.Image!==image)throw Error('FIXTURE_CONTAINER_IDENTITY_MISMATCH');
   if(container.State.Running)await docker.stop(id);await docker.remove(id);
   if(await docker.inspect(id))throw Error('FIXTURE_CONTAINER_REMAINS');
  }catch(error){errors.push(error);}
  if(job.network_id)try{
   const network=await docker.inspectPrivateNetwork(job.network_id);if(!network)continue;
   if(network.Labels?.['agent-control.job']!==job.id||Object.keys(network.Containers??{}).length)throw Error('FIXTURE_NETWORK_IDENTITY_MISMATCH');
   await docker.removePrivateNetwork(job.network_id);if(await docker.inspectPrivateNetwork(job.network_id))throw Error('FIXTURE_NETWORK_REMAINS');
  }catch(error){errors.push(error);}
 }
 if(errors.length)throw new AggregateError(errors,'NATIVE_GRAPH_CLEANUP_FAILED');
}
