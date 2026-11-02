import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Hono} from 'hono';
import {Ledger} from '../src/ledger.ts';
import {Refusal} from '../src/contracts.ts';
import {createImportPreviewApi} from '../src/import-preview-api.ts';
import {IMPORT_PREVIEW_MAX_BYTES} from '../src/import-preview.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('preview is owner-scoped, immutable, bounded and never stages or exposes bundle material',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=await isolatedDatabase(base,'import_preview'),ledger=new Ledger(db.url);
 try{
  await ledger.migrate();const projectId=randomUUID(),otherProject=randomUUID();
  await ledger.pool.query('INSERT INTO ac_projects(id,label) VALUES($1,$2),($3,$4)',[projectId,'A',otherProject,'B']);
  await ledger.pool.query("INSERT INTO ac_memberships(project_id,principal_id,role) VALUES($1,'owner','owner'),($1,'viewer','viewer')",[projectId]);
  const app=new Hono<{Variables:{principal:string}}>();app.use('*',async(c,next)=>{c.set('principal',c.req.header('x-test-principal')??'');await next();});
  app.onError((error,c)=>error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'INVALID_CONTRACT'},400));app.route('/api/v1/ac',createImportPreviewApi(ledger,projectId));
  const bundle={schemaVersion:1,importId:randomUUID(),projectId,sourceNamespace:'synthetic-namespace',contexts:[{id:'external-private-id',sessionId:'private-session',sourcePaused:true,keyVariant:'legacy',keyFingerprint:'a'.repeat(64),messages:[{id:'private-message',ciphertext:'c2VjcmV0'}],runs:[]}]};
  const body=JSON.stringify(bundle),request=(body:string,principal='owner',extra:Record<string,string>={})=>app.request('/api/v1/ac/import/preview',{method:'POST',headers:{'content-type':'application/json','x-test-principal':principal,...extra},body});
  const response=await request(body);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const report=await response.json();
  assert.equal(report.inputSha256,createHash('sha256').update(body).digest('hex'));assert.equal(report.counts.messages,1);assert.equal(report.checks.keysVerified,false);assert.equal(report.executionEnabled,false);
  for(const secret of ['synthetic-namespace','private-session','external-private-id','private-message','c2VjcmV0','a'.repeat(64)])assert.ok(!JSON.stringify(report).includes(secret));
  assert.deepEqual(await (await request(body)).json(),report);
  assert.equal((await request(body,'viewer')).status,403);assert.equal((await request(JSON.stringify({...bundle,projectId:otherProject}))).status,403);
  assert.equal((await request(body,'owner',{'content-encoding':'gzip'})).status,400);assert.equal((await request('x'.repeat(IMPORT_PREVIEW_MAX_BYTES+1))).status,400);
  assert.equal((await request('{invalid')).status,400);assert.equal(Number((await ledger.pool.query('SELECT count(*) AS n FROM ac_import_batches')).rows[0].n),0);
 }finally{await ledger.close();await db.close();}
});
