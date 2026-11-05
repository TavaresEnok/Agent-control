// Isolated browser proof for the real workflow editor; API persistence is an in-memory fixture.
import {chromium} from '../upstream/cezar/node_modules/playwright-core/index.mjs'
import {spawn} from 'node:child_process'
import {writeFile,rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
const web=resolve('upstream/cezar/packages/web'), html=resolve(web,'r2-ui-proof.html'), entry=resolve(web,'r2-ui-proof.tsx')
let server,browser
try {
 await writeFile(html,'<div id="root"></div><script type="module" src="/r2-ui-proof.tsx"></script>')
 await writeFile(entry,`import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter,Routes,Route} from 'react-router'; import {QueryClientProvider} from '@tanstack/react-query'; import {createQueryClient} from './src/api/query-client'; import {WorkflowGraphRoute} from './src/routes/workflow-graph/workflow-graph'; import {Toaster} from './src/components/ui/toaster'; import './src/styles/index.css'; createRoot(document.getElementById('root')!).render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/workflows']}><Routes><Route path='/workflows' element={<WorkflowGraphRoute/>}/><Route path='/workflows/:name' element={<WorkflowGraphRoute/>}/></Routes><Toaster/></MemoryRouter></QueryClientProvider>);`)
 server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','packages/web/vite.config.ts','--host','127.0.0.1','--port','19173','--strictPort'],{cwd:resolve('upstream/cezar'),stdio:'pipe'})
 let ready=false;server.stdout.on('data',s=>{if(String(s).includes('Local:'))ready=true});let stderr='';server.stderr.on('data',s=>stderr+=s)
 for(let i=0;i<200&&!ready;i++){if(server.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,100))} assert(ready,'vite failed to start')
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})
 for(const width of [360,390,1280]){
  const ctx=await browser.newContext({viewport:{width,height:850},hasTouch:width<500});const page=await ctx.newPage();let saved=null, invalid=false
  await page.route('**/api/v1/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,method=req.method();let body={}
   if(path==='/api/v1/workflows/nodes')body={nodes:[{type:'start',category:'flow',label:'Start',description:'Entry point.',ports:['next'],outputs:[]},{type:'agent',category:'agents',label:'Agent',description:'One agent session.',ports:['done','failed'],outputs:[]},{type:'end',category:'flow',label:'End',description:'Finishes the run.',ports:[],outputs:[]}]}
   else if(path==='/api/v1/workflows'&&method==='GET')body={workflows:saved?[saved]:[],issues:[]}
   else if(path==='/api/v1/skills')body=[]
   else if(path==='/api/v1/workflows/validate')body={issues:invalid?['Synthetic validation failure']:[]}
   else if(path==='/api/v1/workflows/graph'&&method==='POST'){const data=req.postDataJSON();saved={name:data.name,source:'file',path:`.ai/cezar/workflows/${data.name}.yaml`,steps:[],graph:data.graph};body={name:data.name,path:saved.path}}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.goto('http://127.0.0.1:19173/r2-ui-proof.html');await page.getByLabel('Workflow name').fill(`proof-${width}`)
  await page.getByRole('button',{name:'Add node'}).click();await page.getByRole('button',{name:/One agent session/}).click()
  await page.getByLabel('name',{exact:true}).fill('Review');await page.getByRole('button',{name:'Close inspector'}).click();await page.getByRole('button',{name:'Close node palette'}).click()
  if(width<500){await page.getByLabel('work done destination').selectOption('agent');await page.getByLabel('agent done destination').selectOption('end');await page.getByLabel('agent failed destination').selectOption('work')}
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForTimeout(500);assert(saved,'save request missing');assert(saved.graph.nodes.some(n=>n.name==='Review'))
  if(width<500)assert.deepEqual(saved.graph.edges.filter(e=>e.from.startsWith('agent.')).map(e=>[e.from,e.to]).sort(),[['agent.done','end'],['agent.failed','work']])
  await page.reload();await page.getByLabel('Open workflow').selectOption(`proof-${width}`);await page.waitForTimeout(600)
  if(width<500){await page.getByRole('button',{name:'Edit agent'}).click();assert.equal(await page.getByLabel('name',{exact:true}).inputValue(),'Review');await page.getByLabel('name',{exact:true}).fill('Edited');await page.getByRole('button',{name:'Close inspector'}).click()}
  else {await page.locator('.react-flow__node').filter({hasText:'Review'}).click();await page.getByLabel('name',{exact:true}).fill('Edited');await page.getByRole('button',{name:'Close inspector'}).click()}
  await page.getByRole('button',{name:'Save',exact:true}).click();await page.waitForTimeout(400);assert(saved.graph.nodes.some(n=>n.name==='Edited'))
  invalid=true;if(width<500)await page.getByLabel('agent done destination').selectOption('');else await page.getByRole('button',{name:'Add node'}).click().then(()=>page.getByRole('button',{name:/One agent session/}).click())
  await page.getByRole('status').filter({hasText:'Synthetic validation failure'}).waitFor();assert(await page.getByRole('button',{name:'Save',exact:true}).isDisabled())
  const size=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.width+1,JSON.stringify(size))
  console.log(`PASS ${width}: create, edit, save, reopen, accessible validation${width<500?', branch wiring':''}`);await ctx.close()
 }
} finally {await browser?.close();server?.kill();await rm(html,{force:true});await rm(entry,{force:true})}
