import {createHash} from 'node:crypto';
import {relative} from 'node:path';
import type pg from 'pg';
import {Id,Refusal,digest} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {Operators,type OperatorProof} from './operator.ts';
import {parseWorkflowGraphCommand,WorkflowGraphName} from './workflow-graph-contract.ts';
import {workflowGraphSchema,graphIssues,graphToSteps} from '../upstream/cezar/packages/cezar/dist/workflows/graph.js';
import {workflowRepository,reconcileWorkflowFile,readWorkflowFile,legacyWorkflowNames} from './workflow-graph-files.ts';

export class WorkflowGraphs{
 constructor(readonly ledger:Ledger,readonly roots:readonly {id:string;path:string}[],readonly privateDirectory:string){}
 private async authorize(c:pg.PoolClient,principal:string,projectId:string){
  const role=(await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 FOR SHARE',[projectId,principal])).rows[0]?.role;
  if(role!=='owner')throw new Refusal('WORKFLOW_GRAPH_FORBIDDEN',403);
 }
 private async repository(projectId:string){
  const registered=(await this.ledger.pool.query('SELECT r.repo,i.repo_dev,i.repo_ino,i.git_dev,i.git_ino,i.root_id,i.root_path,i.relative_path FROM ac_project_repositories r JOIN ac_project_repository_identity i USING(project_id) WHERE r.project_id=$1',[projectId])).rows[0];
  if(!registered)throw new Refusal('WORKFLOW_REPOSITORY_REQUIRED',409);
  const repo=await workflowRepository(registered.repo,this.roots,this.privateDirectory);
  if(repo.root.id!==registered.root_id||repo.root.path!==registered.root_path||relative(repo.root.path,repo.repo)!==registered.relative_path||
   digest(repo.identity)!==digest({repoDev:registered.repo_dev,repoIno:registered.repo_ino,gitDev:registered.git_dev,gitIno:registered.git_ino}))throw new Refusal('WORKFLOW_REPOSITORY_CHANGED',409);
  return repo;
 }
 async view(principal:string,projectId:string,name:string){
  Id.parse(projectId);
  const row=await this.ledger.tx(async c=>{await this.authorize(c,principal,projectId);
   if(!WorkflowGraphName.safeParse(name).success)return null;
   return (await c.query('SELECT r.revision,r.snapshot,r.file_digest FROM ac_workflow_graph_heads h JOIN ac_workflow_graph_revisions r USING(project_id,name,revision) WHERE h.project_id=$1 AND h.name=$2',[projectId,name])).rows[0]??null;});
  if(!row)return {projectId,name,revision:0,workflow:null};
  const repo=await this.repository(projectId);if((await legacyWorkflowNames(repo.repo,repo.identity)).has(name))throw new Refusal('WORKFLOW_CATALOG_AMBIGUOUS',409);
  const bytes=await readWorkflowFile(repo.repo,repo.identity,name,row.revision,row.file_digest);
  let document:unknown;try{document=JSON.parse(bytes.toString('utf8'));}catch{throw new Refusal('WORKFLOW_FILE_CONFLICT',409);}
  if(digest(document)!==digest({version:2,name,...(row.snapshot.description===undefined?{}:{description:row.snapshot.description}),...row.snapshot.graph}))throw new Refusal('WORKFLOW_FILE_CONFLICT',409);
  return {projectId,name,revision:row.revision,workflow:row.snapshot};
 }
 /** Resolves the logical head once to a verified immutable Cezar definition.
  * Callers that eventually launch must pin this returned definition and digest. */
 async resolve(principal:string,projectId:string,name:string){
  const projected=await this.view(principal,projectId,name);
  if(!projected.workflow)return null;
  const graph=workflowGraphSchema.parse(projected.workflow.graph);
  if(graphIssues(graph).length)throw new Refusal('WORKFLOW_GRAPH_INVALID',409);
  const definition={name,source:'file' as const,...(projected.workflow.description?{description:projected.workflow.description}:{}),graph,steps:graphToSteps(graph)};
  return {name,revision:projected.revision,digest:digest(definition),definition};
 }
 async list(principal:string,projectId:string){
  Id.parse(projectId);const names=await this.ledger.tx(async c=>{await this.authorize(c,principal,projectId);
   return (await c.query('SELECT name FROM ac_workflow_graph_heads WHERE project_id=$1 ORDER BY name LIMIT 1000',[projectId])).rows.map(row=>row.name as string);});
  const workflows=await Promise.all(names.map(name=>this.resolve(principal,projectId,name)));
  return {projectId,workflows:workflows.filter(item=>item!==null)};
 }
 async validate(principal:string,projectId:string,raw:unknown){
  Id.parse(projectId);await this.ledger.tx(c=>this.authorize(c,principal,projectId));
  const graph=workflowGraphSchema.parse(raw);
  if(graph.nodes.length>256||graph.edges.length>1024)throw new Refusal('WORKFLOW_GRAPH_TOO_LARGE',400);
  return {issues:graphIssues(graph)};
 }
 async save(principal:string,raw:unknown,proof:OperatorProof){
  const command=parseWorkflowGraphCommand(raw),{projectId,name,expectedRevision,graph,description}=command.payload;
  const {deliveryAttemptId,...semantic}=raw as typeof command,hash=digest({principal,...semantic});
  const bytes=Buffer.from(JSON.stringify({version:2,name,...(description===undefined?{}:{description}),...graph},null,2)+'\n');
  if(bytes.length>256*1024)throw new Refusal('WORKFLOW_GRAPH_TOO_LARGE',400);
  const desiredDigest=createHash('sha256').update(bytes).digest('hex');
  const authenticate=async(c:pg.PoolClient)=>{await this.authorize(c,principal,projectId);await new Operators(this.ledger).verify(c,principal,raw as Record<string,unknown>,proof);};
  await this.ledger.tx(authenticate);
  const repo=await this.repository(projectId);
  const lock=async(c:pg.PoolClient)=>{await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,88))',[command.intentId]);};
  await this.ledger.tx(async c=>{
   await authenticate(c);await lock(c);
   const prior=(await c.query('SELECT * FROM ac_workflow_graph_intents WHERE id=$1',[command.intentId])).rows[0];
   if(prior&&(prior.principal_id!==principal||prior.payload_digest!==hash))throw new Refusal('WORKFLOW_INTENT_CONFLICT',409);
   if(!prior){
    const legacyNames=await legacyWorkflowNames(repo.repo,repo.identity);
    if(legacyNames.has(name))throw new Refusal('SAVE_COPY_WITH_NEW_NAME',409);
    if((await c.query("SELECT 1 FROM ac_workflow_graph_intents WHERE project_id=$1 AND name=$2 AND state='pending'",[projectId,name])).rowCount)throw new Refusal('WORKFLOW_PUBLICATION_PENDING',409);
    const head=(await c.query('SELECT r.revision,r.file_digest FROM ac_workflow_graph_heads h JOIN ac_workflow_graph_revisions r USING(project_id,name,revision) WHERE h.project_id=$1 AND h.name=$2',[projectId,name])).rows[0];
    if((head?.revision??0)!==expectedRevision)throw new Refusal('WORKFLOW_REVISION_CONFLICT',409);
    await c.query(`INSERT INTO ac_workflow_graph_intents(id,principal_id,payload_digest,project_id,name,expected_revision,snapshot,repository_identity,desired_digest,desired_bytes,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,[command.intentId,principal,hash,projectId,name,expectedRevision,JSON.stringify({name,description,graph}),JSON.stringify(repo.identity),desiredDigest,bytes]);
   }
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,89))',[deliveryAttemptId]);
   const delivery=(await c.query('SELECT intent_id FROM ac_workflow_graph_deliveries WHERE id=$1',[deliveryAttemptId])).rows[0];
   if(delivery&&delivery.intent_id!==command.intentId)throw new Refusal('WORKFLOW_DELIVERY_CONFLICT',409);
   if(!delivery)await c.query('INSERT INTO ac_workflow_graph_deliveries VALUES($1,$2)',[deliveryAttemptId,command.intentId]);
  });
  return this.ledger.tx(async c=>{
   await authenticate(c);await lock(c);
   const item=(await c.query('SELECT * FROM ac_workflow_graph_intents WHERE id=$1 FOR UPDATE',[command.intentId])).rows[0];
   if(item.state==='applied')return item.result;
   if(digest(repo.identity)!==digest(item.repository_identity))throw new Refusal('WORKFLOW_REPOSITORY_CHANGED',409);
   if((await legacyWorkflowNames(repo.repo,repo.identity)).has(name))throw new Refusal('WORKFLOW_CATALOG_AMBIGUOUS',409);
   await reconcileWorkflowFile(repo.repo,item.repository_identity,name,expectedRevision+1,item.desired_digest,item.desired_bytes);
   if((await legacyWorkflowNames(repo.repo,repo.identity)).has(name))throw new Refusal('WORKFLOW_CATALOG_AMBIGUOUS',409);
   const revision=expectedRevision+1,result={state:'applied',projectId,name,revision,path:`.ai/cezar/workflows/.managed/${name}/${revision}-${item.desired_digest}.yaml`};
   await c.query('INSERT INTO ac_workflow_graph_revisions(project_id,name,revision,snapshot,file_digest,published_by) VALUES($1,$2,$3,$4,$5,$6)',[projectId,name,revision,JSON.stringify(item.snapshot),item.desired_digest,principal]);
   await c.query('INSERT INTO ac_workflow_graph_heads VALUES($1,$2,$3) ON CONFLICT(project_id,name) DO UPDATE SET revision=excluded.revision',[projectId,name,revision]);
   await c.query("UPDATE ac_workflow_graph_intents SET state='applied',result=$2 WHERE id=$1",[command.intentId,JSON.stringify(result)]);return result;
  });
 }
}
