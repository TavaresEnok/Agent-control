// Real cookie-authenticated browser, operator signature, gateway and PostgreSQL.
// Caller owns a disposable synthetic lab and cleanup. No operational migration.
import assert from 'node:assert/strict'
import {join} from 'node:path'
export async function proveProjectEnvironments({page,client,origin,projectId,db,outputDirectory,restart}){
 const selectedContext=await page.getByLabel('Conversa',{exact:true}).inputValue()
 const path='/api/v1/ac/project-admin/environments',url=origin+path,commands=[]
 const published=()=>page.getByRole('status').filter({hasText:'Ambientes e destinos publicados e persistidos.'})
 async function load(tab){await tab.getByRole('button',{name:'Carregar configuração de ambientes',exact:true}).click();await tab.getByLabel('Diretórios autorizados 1',{exact:true}).fill('src')}
 await load(page)
 await page.route('**'+path,async route=>{
  if(route.request().method()!=='POST')return route.continue()
  commands.push(route.request().postDataJSON())
  const response=await route.fetch();assert.equal(response.status(),200)
  // The real server committed; simulate losing its acknowledgement at this browser.
  await route.abort('failed');await page.unroute('**'+path)
 })
 await page.getByRole('button',{name:'Publicar ambientes e destinos',exact:true}).click()
 await page.getByRole('button',{name:'Confirmar configuração de ambientes pendente',exact:true}).waitFor()
 await page.reload()
 assert.equal(await page.getByRole('button',{name:'Carregar configuração de ambientes',exact:true}).isDisabled(),true)
 const replay=page.waitForResponse(response=>response.url()===url&&response.request().method()==='POST')
 await page.getByRole('button',{name:'Confirmar configuração de ambientes pendente',exact:true}).click()
 const replayResponse=await replay;assert.equal(replayResponse.status(),200)
 commands.push(replayResponse.request().postDataJSON());await published().waitFor()
 assert.equal(commands[0].intentId,commands[1].intentId);assert.notEqual(commands[0].deliveryAttemptId,commands[1].deliveryAttemptId);assert.deepEqual(commands[0].payload,commands[1].payload)
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_project_environment_revisions WHERE project_id=$1',[projectId])).rows[0].n,1)
 await load(page)
 const stale=await client.newPage();await stale.goto(page.url());await load(stale)
 await page.getByLabel('Nome do ambiente 1',{exact:true}).fill('R4 mobile published')
 const next=page.waitForResponse(response=>response.url()===url&&response.request().method()==='POST')
 await page.getByRole('button',{name:'Publicar ambientes e destinos',exact:true}).click();assert.equal((await next).status(),200);await published().waitFor()
 await stale.getByLabel('Nome do ambiente 1',{exact:true}).fill('R4 stale rejected')
 const conflict=stale.waitForResponse(response=>response.url()===url&&response.request().method()==='POST')
 await stale.getByRole('button',{name:'Publicar ambientes e destinos',exact:true}).click();assert.equal((await conflict).status(),409)
 await stale.getByRole('alert').filter({hasText:'PROJECT_ENVIRONMENT_REVISION_CONFLICT'}).waitFor()
 await stale.reload();await stale.getByRole('button',{name:'Descartar publicação recusada',exact:true}).click();await stale.close()
 await restart();await page.reload();await page.getByLabel('Conversa',{exact:true}).selectOption(selectedContext);await load(page)
 assert.equal(await page.getByLabel('Nome do ambiente 1',{exact:true}).inputValue(),'R4 mobile published')
 assert.equal(await page.getByLabel('Diretórios autorizados 1',{exact:true}).inputValue(),'src')
 const state=await (await client.request.get(url+'?projectId='+projectId)).json();assert.equal(state.revision,2);assert.equal(state.config.environments[0].label,'R4 mobile published')
 await page.getByRole('heading',{name:'Ambientes e destinos do projeto',exact:true}).scrollIntoViewIfNeeded()
 await page.screenshot({path:join(outputDirectory,'r4-ui-environments-360.png')})
 console.log('PASS environment079 actual signed publication, lost committed acknowledgement/reload/same-intent replay, real CAS 409, and revision2 persistence after gateway restart; existing tracked src only')
}
