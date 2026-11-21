import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a conversation session links to one context, idempotently and in one project only',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'sessionlink'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),principal='owner-'+randomUUID(),sessionId='synthetic/session-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Session link fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contexts=await Promise.all([db.createContext(principal,project,sessionId),db.createContext(principal,project,sessionId)]);
  assert.equal(contexts[0],contexts[1]);
  assert.equal(Number((await db.pool.query('SELECT count(*) n FROM ac_contexts WHERE project_id=$1',[project])).rows[0].n),1);
  const otherProject=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'Different project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[otherProject,principal]);
  await assert.rejects(db.createContext(principal,otherProject,sessionId),/SESSION_LINK_CONFLICT/);
 }finally{await db.close();await isolated.close();}
});
