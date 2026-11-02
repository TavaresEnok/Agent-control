import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,mkdir,rm,symlink,writeFile,rename,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {createProjectAdminApi} from '../src/project-admin-api.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {Projects} from '../src/projects.ts';

test('signed global registration is scoped, idempotent and refuses untrusted paths',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'projectadmin'),db=new Ledger(isolated.url),root=await mkdtemp(join(tmpdir(),'ac-project-admin-'));
 try{
  await db.migrate();const principal='synthetic-'+randomUUID(),outsider='outsider-'+randomUUID(),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const info={deviceId,expiresAt:Date.now()+120000};return {...info,signature:sign(null,Buffer.from(operatorMessage(principal,value,info,installation)),keys.privateKey).toString('hex')};};
  const repo=join(root,'repository');await mkdir(repo);execFileSync('git',['-C',repo,'init','-q']);
  const roots=[{id:'fixture',label:'Fixture root',path:root}],service=new ProjectAdmin(db,roots,join(root,'private'));
  const command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.register',payload:{projectId:randomUUID(),label:'Fixture',rootId:'fixture',relativePath:'repository'}};
  const result=await service.execute(principal,command,proof(command));
  assert.deepEqual(await service.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command)),result);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_admin_intents')).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[command.payload.projectId,principal])).rows[0].n,1);
  const changed={...command,payload:{...command.payload,label:'Changed'}};
  await assert.rejects(service.execute(principal,changed,proof(changed)),/PROJECT_ADMIN_INTENT_CONFLICT/);
  const repo2=join(root,'repository-two');await mkdir(repo2);execFileSync('git',['-C',repo2,'init','-q']);
  const reused={...command,intentId:randomUUID(),payload:{...command.payload,projectId:randomUUID(),relativePath:'repository-two'}};
  await assert.rejects(service.execute(principal,reused,proof(reused)),/PROJECT_ADMIN_DELIVERY_CONFLICT/);
  await assert.rejects(service.execute(outsider,{...command,intentId:randomUUID()},proof(command)),/CONTROL_ADMIN_REQUIRED/);
  const forged={...command,intentId:randomUUID()};
  await assert.rejects(service.execute(principal,forged,{...proof(forged),signature:'0'.repeat(128)}),/OPERATOR_SIGNATURE_INVALID/);
  const escaped={...command,intentId:randomUUID(),payload:{...command.payload,relativePath:'../outside'}};
  await assert.rejects(service.execute(principal,escaped,proof(escaped)));
  await symlink(repo,join(root,'link'));
  const link={...command,intentId:randomUUID(),payload:{...command.payload,relativePath:'link'}};
  await assert.rejects(service.execute(principal,link,proof(link)),/PROJECT_PATH_FORBIDDEN/);
  const gitfile=join(root,'gitfile');await mkdir(gitfile);await writeFile(join(gitfile,'.git'),`gitdir: ${repo}/.git\n`);
  const gitfileCommand={...command,intentId:randomUUID(),payload:{...command.payload,relativePath:'gitfile'}};
  await assert.rejects(service.execute(principal,gitfileCommand,proof(gitfileCommand)),/PROJECT_REPOSITORY_UNAVAILABLE/);
  const symlinkGit=join(root,'symlink-git');await mkdir(symlinkGit);await symlink(join(repo,'.git'),join(symlinkGit,'.git'));
  const gitLinkCommand={...command,intentId:randomUUID(),payload:{...command.payload,relativePath:'symlink-git'}};
  await assert.rejects(service.execute(principal,gitLinkCommand,proof(gitLinkCommand)),/PROJECT_REPOSITORY_UNAVAILABLE/);
  await chmod(repo2,0o777);
  const writable={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,relativePath:'repository-two'}};
  await assert.rejects(service.execute(principal,writable,proof(writable)),/PROJECT_PATH_FORBIDDEN/);
  await chmod(repo2,0o755);
  const privateRepo={...command,intentId:randomUUID(),payload:{...command.payload,relativePath:'private/child'}};
  await assert.rejects(service.execute(principal,privateRepo,proof(privateRepo)),/PROJECT_PRIVATE_DIRECTORY_CONFLICT/);
  const parentPrivate=new ProjectAdmin(db,roots,join(repo2,'private'));
  await assert.rejects(parentPrivate.execute(principal,writable,proof(writable)),/PROJECT_PRIVATE_DIRECTORY_CONFLICT/);
  const forbidden={...command,intentId:randomUUID(),payload:{...command.payload,rootId:'other'}};
  await assert.rejects(service.execute(principal,forbidden,proof(forbidden)),/PROJECT_ROOT_FORBIDDEN/);
  assert.equal((await service.view(outsider)).roots.length,0);
  const raceRepo=join(root,'race');await mkdir(raceRepo);execFileSync('git',['-C',raceRepo,'init','-q']);
  const race={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,projectId:randomUUID(),relativePath:'race'}};
  const otherDelivery=randomUUID(),second={...race,deliveryAttemptId:otherDelivery};
  // Hold both calls after their first transaction, before filesystem validation. Each therefore
  // observes no prior intent; exactly one must take the second-transaction replay branch.
  const originalTx=db.tx.bind(db);let firstTransactions=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve});
  db.tx=(async (fn:Parameters<typeof db.tx>[0])=>{const result=await originalTx(fn);if(++firstTransactions<=2){if(firstTransactions===2)release();await barrier;}return result;}) as typeof db.tx;
  try{const results=await Promise.all([service.execute(principal,race,proof(race)),service.execute(principal,second,proof(second))]);assert.deepEqual(results[0],results[1]);}
  finally{db.tx=originalTx;}
  const deliveries=await db.pool.query('SELECT id FROM ac_project_admin_deliveries WHERE intent_id=$1',[race.intentId]);
  assert.deepEqual(new Set(deliveries.rows.map(row=>row.id)),new Set([race.deliveryAttemptId,otherDelivery]));
  const laterRepo=join(root,'later');await mkdir(laterRepo);execFileSync('git',['-C',laterRepo,'init','-q']);
  const reuseLoser={...race,intentId:randomUUID(),deliveryAttemptId:otherDelivery,payload:{...race.payload,projectId:randomUUID(),relativePath:'later'}};
  await assert.rejects(service.execute(principal,reuseLoser,proof(reuseLoser)),/PROJECT_ADMIN_DELIVERY_CONFLICT/);
  const registry=new Projects(db,roots);assert.equal((await registry.authorized(principal,command.payload.projectId))?.repo,repo);
  await rename(join(repo,'.git'),join(repo,'.git-original'));await mkdir(join(repo,'.git'));
  await assert.rejects(registry.authorized(principal,command.payload.projectId),/PROJECT_REPOSITORY_IDENTITY_CHANGED/);
  const handler=createProjectAdminApi(service),missing=await handler(new Request('http://localhost/api/v1/ac/project-admin',{method:'POST',body:'{}'}),principal);
  assert.equal(missing.status,403);assert.equal((await missing.json()).error,'HUMAN_CONTROL_AUTH_REQUIRED');
 }finally{await db.close();await isolated.close();await rm(root,{recursive:true,force:true});}
});
