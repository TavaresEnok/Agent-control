// Isolated loopback adapter around Cezar's actual workflow routes and store.
import {serve} from '@hono/node-server'
import {RunStore} from '../upstream/cezar/packages/cezar/src/runs/store.ts'
import {createApp} from '../upstream/cezar/packages/cezar/src/server/server.ts'
import type {RunManager} from '../upstream/cezar/packages/cezar/src/workflows/run.ts'
import {join} from 'node:path'
const repo=process.argv[2]
if(!repo)throw Error('isolated repository required')
const store=RunStore.open(join(repo,'.ai/cezar'))
const app=createApp({repoRoot:repo,store,manager:{} as RunManager,version:'isolated-proof'})
const allowed=new Set(['/api/v1/workflows','/api/v1/workflows/nodes','/api/v1/workflows/validate','/api/v1/workflows/graph','/api/v1/skills'])
const server=serve({hostname:'127.0.0.1',port:Number(process.argv[3]??0),fetch:request=>allowed.has(new URL(request.url).pathname)?app.fetch(request):new Response('disabled',{status:403})},info=>console.log(`READY ${info.port}`))
process.on('SIGTERM',()=>server.close(()=>{store.flush();process.exit(0)}))
