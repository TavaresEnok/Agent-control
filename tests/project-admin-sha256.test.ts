import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {chmod,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {ProjectAdmin} from '../src/project-admin.ts';
import {GitArtifacts} from '../src/git.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a SHA-256 repository is refused at registration, a SHA-1 one is accepted',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'projectsha'),db=new Ledger(isolated.url),root=await mkdtemp(join(tmpdir(),'ac-project-sha-'));
 try{
  await db.migrate();
  const principal='synthetic-'+randomUUID(),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({type:'spki',format:'der'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const info={deviceId,expiresAt:Date.now()+120000};return {...info,signature:sign(null,Buffer.from(operatorMessage(principal,value,info,installation)),keys.privateKey).toString('hex')};};
  const service=new ProjectAdmin(db,[{id:'fixture',label:'Fixture root',path:root}],join(root,'private'));
  const command=(relativePath:string)=>({schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),action:'project.register',payload:{projectId:randomUUID(),label:'Fixture',rootId:'fixture',relativePath}});
  const wide=join(root,'wide');await mkdir(wide);await chmod(wide,0o755);
  execFileSync('git',['-C',wide,'init','-q','--object-format=sha256']);await chmod(join(wide,'.git'),0o755);
  assert.equal(execFileSync('git',['-C',wide,'rev-parse','--show-object-format'],{encoding:'utf8'}).trim(),'sha256');
  const refused=command('wide');
  await assert.rejects(service.execute(principal,refused,proof(refused)),/PROJECT_REPOSITORY_SHA1_REQUIRED/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_projects WHERE id=$1',[refused.payload.projectId])).rows[0].n,0);
  const narrow=join(root,'narrow');await mkdir(narrow);await chmod(narrow,0o755);
  execFileSync('git',['-C',narrow,'init','-q','--object-format=sha1']);await chmod(join(narrow,'.git'),0o755);
  const accepted=command('narrow');
  assert.equal((await service.execute(principal,accepted,proof(accepted)) as {state:string}).state,'applied');
  // The contract is 40 hex everywhere: a 64-character id never reaches the helper.
  const git=new GitArtifacts(narrow);
  await assert.rejects(git.identity('a'.repeat(64),'b'.repeat(64)));
 }finally{await db.close();await isolated.close();await rm(root,{recursive:true,force:true});}
});
