import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {Ledger} from '../src/ledger.ts';
import {collectConfiguration,sealConfiguration,inspectConfiguration,writeConfiguration,readConfiguration} from '../src/config-export.ts';

test('configuration projection requires admin and owner, encrypts and reads without credential fields',{timeout:60000},async()=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const folder=await mkdtemp(join(tmpdir(),'ac-config-export-'));const keyPath=join(folder,'key'),out=join(folder,'artifact');await writeFile(keyPath,randomBytes(32),{mode:0o600});
 const base=process.env.AC_TEST_DATABASE_URL;assert(base);const fixture=await isolatedDatabase(base,'configexport'),db=new Ledger(fixture.url);await db.migrate();
 const project=randomUUID(),owner='owner-'+randomUUID(),key=randomBytes(32),secret='credential-canary-9ecfa';
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,secret]);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,owner]);
  await assert.rejects(collectConfiguration(db,owner,project),/CONFIG_EXPORT_FORBIDDEN/);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[owner]);
  await db.pool.query("INSERT INTO ac_project_templates(project_id,template_id,revision,name,snapshot,digest,published_by) VALUES($1,$2,1,$3,$4,$5,$6)",[project,randomUUID(),'Fixture',{workflow:'baseline-synthetic-v1'},(await import('../src/contracts.ts')).digest({workflow:'baseline-synthetic-v1'}),owner]);
  const dto=await collectConfiguration(db,owner,project),artifact=sealConfiguration(dto,key);assert(!JSON.stringify(artifact).includes(secret));assert(!JSON.stringify(artifact).includes('baseline-synthetic-v1'));const decoded=inspectConfiguration(artifact,key);assert.deepEqual(decoded,dto);assert(!JSON.stringify(decoded).includes(secret));assert.equal(decoded.restorable,false);assert.equal(decoded.templates[0].workflow,'baseline-synthetic-v1');
  const bad={...artifact,tag:'0'.repeat(32)};assert.throws(()=>inspectConfiguration(bad,key),/CONFIG_EXPORT_INVALID_ARTIFACT/);assert.throws(()=>inspectConfiguration(artifact,randomBytes(32)),/CONFIG_EXPORT_INVALID_ARTIFACT/);
  await writeConfiguration(db,owner,project,out,keyPath,[]);assert.deepEqual(await readConfiguration(out,keyPath),dto);const before=await readFile(out);await assert.rejects(writeConfiguration(db,owner,project,out,keyPath,[]),/EEXIST/);assert.deepEqual(await readFile(out),before);assert(!before.includes(Buffer.from(secret)));assert(!before.includes(Buffer.from('baseline-synthetic-v1')));
 }finally{key.fill(0);await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});
