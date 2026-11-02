import { chromium } from '../upstream/cezar/node_modules/playwright-core/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
const fixture=JSON.parse(readFileSync('.state/browser-fixture.json','utf8'));
const db=new pg.Pool({connectionString:process.env.AC_TEST_DATABASE_URL});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
const credentials={token:fixture.token,secret:fixture.secret};
const credentialsKeys=['127.0.0.1-18401','localhost-18401',...['http://127.0.0.1:18401','http://localhost:18401'].map(s=>createHash('sha256').update(s).digest('base64url'))];
const failedRequests=[];
async function client(index,width){
 const ctx=await browser.newContext({viewport:{width,height:844},isMobile:width<500,hasTouch:width<500});
 await ctx.addInitScript(({credentials,credentialsKeys})=>{if(location.origin==='http://127.0.0.1:18400')for(const k of credentialsKeys)localStorage.setItem('auth_credentials__srv_'+k,JSON.stringify(credentials));},{credentials,credentialsKeys});
 const page=await ctx.newPage();page.on('response',r=>{if(r.status()>=400)failedRequests.push({path:new URL(r.url()).pathname,status:r.status()})});
 await page.goto('http://127.0.0.1:18400/session/'+fixture.sessions[index]);
 await page.getByTestId('session-composer-input').waitFor({timeout:60000});return{ctx,page};
}
try{
 const desktop=await client(0,1365),mobile=await client(0,390),other=await client(1,390);
 await other.page.getByText('Implemente o módulo de relatórios verdes.',{exact:false}).waitFor({timeout:30000});
 assert.equal(await other.page.getByText('Implemente a primeira entrega do painel azul.',{exact:false}).count(),0);
 const before=Number((await db.query('SELECT count(*) n FROM ac_intents WHERE context_id=$1',[fixture.contexts[0]])).rows[0].n);
 const text='Adicione um card de auditoria ao painel, rodada '+new Date().toISOString()+'.';
 await desktop.page.getByTestId('session-composer-input').fill(text);await desktop.page.getByTestId('session-composer-send').click();
 await mobile.page.getByText(text,{exact:false}).waitFor({timeout:45000});
 let row;
 for(let i=0;i<300;i++){
  const r=await db.query(`SELECT i.*,o.state AS physical_state FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.context_id=$1 ORDER BY i.created_at DESC LIMIT 1`,[fixture.contexts[0]]);
  if(r.rows[0]?.physical_state==='completed'&&Number((await db.query('SELECT count(*) n FROM ac_intents WHERE context_id=$1',[fixture.contexts[0]])).rows[0].n)===before+1){row=r.rows[0];break}
  await new Promise(r=>setTimeout(r,100));
 }
 assert(row,'new browser message must produce a real completed Cezar operation');
 await mobile.ctx.setOffline(true);await new Promise(r=>setTimeout(r,500));await mobile.ctx.setOffline(false);await mobile.page.reload();
 await mobile.page.getByText(text,{exact:false}).waitFor({timeout:45000});
 assert.equal(Number((await db.query('SELECT count(*) n FROM ac_intents WHERE context_id=$1',[fixture.contexts[0]])).rows[0].n),before+1);
 assert.equal(await other.page.getByText(text,{exact:false}).count(),0);
 await desktop.page.screenshot({path:'docs/validation/evidence/happier-desktop.png',fullPage:true});
 await mobile.page.screenshot({path:'docs/validation/evidence/happier-mobile-390.png',fullPage:true});
 const cockpit=await browser.newContext({viewport:{width:1365,height:900},extraHTTPHeaders:{authorization:'Bearer '+fixture.token}});
 const graph=await cockpit.newPage();graph.on('response',r=>{if(r.status()>=400)failedRequests.push({path:new URL(r.url()).pathname,status:r.status()})});
 await graph.goto('http://127.0.0.1:18402/tasks/'+row.run_id+'/graph');
 await graph.locator('.react-flow__node').first().waitFor({timeout:45000});
 await graph.screenshot({path:'docs/validation/evidence/cezar-graph.png',fullPage:true});
 await graph.goto('http://127.0.0.1:18402/tasks/'+row.run_id);
 await graph.getByTestId('canonical-happier-conversation').waitFor({timeout:30000});
 assert.equal(await graph.locator('textarea').count(),0);
 await graph.screenshot({path:'docs/validation/evidence/cezar-canonical-chat-link.png',fullPage:true});
 const response=await graph.request.post('http://127.0.0.1:18402/api/v1/runs/'+row.run_id+'/messages',{data:{text:'bypass'}});assert.equal(response.status(),403);
 writeFileSync('docs/validation/evidence/browser-acceptance.json',JSON.stringify({result:'passed',contexts:fixture.contexts,sessions:fixture.sessions,runId:row.run_id,
  beforeIntents:before,afterIntents:before+1,reconnectionDuplicated:false,nativeCezarWriteStatus:response.status(),failedRequests,
  limitations:['Synthetic identity pre-authorized in browser storage; this does not test native device pairing.','Mobile browser emulation; no physical Android/iOS.','The UI sends a fixed synthetic workflow; no live model inference.']},null,2));
}catch(error){writeFileSync('docs/validation/evidence/browser-acceptance-failure.json',JSON.stringify({error:String(error),failedRequests},null,2));throw error}
finally{await browser.close();await db.end()}
