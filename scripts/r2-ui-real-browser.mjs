// Real Cezar workflow routes, isolated repository and disabled execution routes.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs'
import {spawn,execFileSync} from 'node:child_process'
import {writeFile,rm,mkdtemp,mkdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parse as parseYaml} from '../upstream/cezar/node_modules/yaml/dist/index.js'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import assert from 'node:assert/strict'
const web=resolve('upstream/cezar/packages/web'), name=`r2-ui-proof-${randomUUID()}`, html=resolve(web,`${name}.html`), entry=resolve(web,`${name}.tsx`)
let server,browser,backend,failure,temporary
const created=[]
async function stop(child){if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited}}
async function startBackend(port=0){
 const child=spawn(process.execPath,['--import','tsx','scripts/r2-ui-real-server.ts',temporary,String(port)],{env:{PATH:process.env.PATH,HOME:temporary,CEZ_HOME:join(temporary,'home'),CEZ_DRY_RUN:'1',CEZ_NO_BANNER:'1'},stdio:['ignore','pipe','pipe']})
 let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v)
 for(let i=0;i<300&&!/READY (\d+)/.test(output);i++){if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,100))}
 const match=output.match(/READY (\d+)/);if(!match){await stop(child);throw Error(`backend startup timeout ${errors}`)}
 return {child,port:Number(match[1])}
}
try {
 temporary=await mkdtemp(join(tmpdir(),'r2-ui-real-'));execFileSync('git',['init','-q',temporary]);await mkdir(join(temporary,'.ai/cezar'),{recursive:true})
 backend=await startBackend()
 await writeFile(html,`<div id="root"></div><script type="module" src="/${name}.tsx"></script>`,{flag:'wx'});created.push(html)
 await writeFile(entry,`import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter,Routes,Route} from 'react-router'; import {QueryClientProvider} from '@tanstack/react-query'; import {createQueryClient} from './src/api/query-client'; import {WorkflowGraphRoute} from './src/routes/workflow-graph/workflow-graph'; import {Toaster} from './src/components/ui/toaster'; import './src/styles/index.css'; createRoot(document.getElementById('root')!).render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/workflows']}><Routes><Route path='/workflows' element={<WorkflowGraphRoute/>}/><Route path='/workflows/:name' element={<WorkflowGraphRoute/>}/></Routes><Toaster/></MemoryRouter></QueryClientProvider>);`,{flag:'wx'});created.push(entry)
 server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','packages/web/vite.config.ts','--host','127.0.0.1','--port','19173','--strictPort'],{cwd:resolve('upstream/cezar'),env:{PATH:process.env.PATH,HOME:temporary,CEZ_API_PORT:String(backend.port)},stdio:'pipe'})
 let ready=false;server.stdout.on('data',s=>{if(String(s).includes('Local:'))ready=true});let stderr='';server.stderr.on('data',s=>stderr+=s)
 for(let i=0;i<200&&!ready;i++){if(server.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,100))} assert(ready,'vite failed to start')
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})
 for(const width of [360,390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:850},hasTouch:width<500});const page=await ctx.newPage()
  // Vite proxy points to the current backend. Keep the same port across backend restart below.
  await page.goto(`http://127.0.0.1:19173/${name}.html`);await page.getByLabel('Workflow name').fill(`proof-${width}`)
  await page.getByRole('button',{name:'Add node'}).click();await page.getByRole('button',{name:/One agent session/}).click()
  await page.getByLabel('name',{exact:true}).fill('Review');await page.getByRole('button',{name:'Close inspector'}).click();await page.getByRole('button',{name:'Close node palette'}).click()
  if(width<500){await page.getByLabel('work done destination').selectOption('agent');await page.getByLabel('agent done destination').selectOption('end');await page.getByLabel('agent failed destination').selectOption('end')}
  const savedResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/workflows/graph')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await savedResponse).status(),201)
  const file=join(temporary,'.ai/cezar/workflows',`proof-${width}.yaml`),saved=parseYaml(await readFile(file,'utf8'));assert(saved.nodes.some(n=>n.name==='Review'))
  if(width<500)assert.deepEqual(saved.edges.filter(e=>e.from.startsWith('agent.')).map(e=>[e.from,e.to]).sort(),[['agent.done','end'],['agent.failed','end']])
  const port=backend.port;await stop(backend.child);backend=await startBackend(port);await page.reload();await page.getByLabel('Open workflow').selectOption(`proof-${width}`);await page.waitForTimeout(600)
  if(width<500){await page.getByRole('button',{name:'Edit agent'}).click();assert.equal(await page.getByLabel('name',{exact:true}).inputValue(),'Review');await page.getByLabel('name',{exact:true}).fill('Edited');await page.getByRole('button',{name:'Close inspector'}).click()}
  else {await page.locator('.react-flow__node').filter({hasText:'Review'}).click();await page.getByLabel('name',{exact:true}).fill('Edited');await page.getByRole('button',{name:'Close inspector'}).click()}
  const editedResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/workflows/graph')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save',exact:true}).click();assert.equal((await editedResponse).status(),201);assert(parseYaml(await readFile(file,'utf8')).nodes.some(n=>n.name==='Edited'))
  await stop(backend.child);backend=await startBackend(port);await page.reload();await page.getByLabel('Open workflow').selectOption(`proof-${width}`)
  if(width<500){await page.getByRole('button',{name:'Edit agent'}).click();assert.equal(await page.getByLabel('name',{exact:true}).inputValue(),'Edited');await page.getByRole('button',{name:'Close inspector'}).click()}else {await page.locator('.react-flow__node').filter({hasText:'Edited'}).waitFor()}
  if(width<500)await page.getByLabel('agent done destination').selectOption('agent');else {await page.getByRole('button',{name:'Add node'}).click();await page.getByRole('button',{name:/Entry point/}).click()}
  await page.getByRole('status').filter({hasText:'validation issues'}).waitFor();assert(await page.getByRole('button',{name:'Save',exact:true}).isDisabled())
  const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.width+1,JSON.stringify(size))
  console.log(`PASS ${width}: create, edit, save, reopen, accessible validation${width<500?', branch wiring':''}`);await ctx.close()
 }
} catch(error) { failure=error } finally {
 const errors=[]
 try { await browser?.close() } catch(error) { errors.push(error) }
 try { await stop(server);await stop(backend?.child) } catch(error) { errors.push(error) }
 for(const path of created)try { await rm(path) } catch(error) { errors.push(error) }
 if(temporary)try { await rm(temporary,{recursive:true}) } catch(error) { errors.push(error) }
 if(errors.length)throw new AggregateError(failure?[failure,...errors]:errors,'Browser proof cleanup failed')
}
if(failure)throw failure
