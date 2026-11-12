import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicPanelAsset} from '../src/api.ts';
import {createProjectGateway} from '../src/projects-api.ts';

test('the gateway serves a service worker with push handlers and no fetch handler',async()=>{
 let authenticated=false;
 const gateway=createProjectGateway({
  projects:undefined as never,runtimes:undefined as never,defaultProjectId:'00000000-0000-4000-8000-000000000001',
  authenticate:async()=>{authenticated=true;return null;},
  publicFetch:async()=>await publicPanelAsset('/sw.js')??new Response('missing',{status:404}),
  appFor:()=>{throw new Error('APP');},
 });
 const response=await gateway(new Request('http://127.0.0.1:18402/sw.js'));
 assert.equal(authenticated,false);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('content-type'),'text/javascript; charset=utf-8');
 const text=await response.text();
 assert.equal(text.includes('fetch'),false);
 assert.equal(text.includes('caches'),false);
 assert.equal(text.includes("addEventListener('push'"),true);
 assert.equal(text.includes("addEventListener('notificationclick'"),true);
 assert.equal(text.includes('/pwa/icon-192.png'),true);
 assert.equal(text.includes('showNotification'),true);
 const panelPath=new Function(`${text.slice(text.indexOf('function panelPath'),text.indexOf('self.addEventListener'))} return panelPath;`)() as (value:unknown)=>string;
 assert.equal(panelPath('/conversa'),'/conversa');
 assert.equal(panelPath('//evil'),'/');
 assert.equal(panelPath('/\\evil'),'/');
 assert.equal(panelPath('/a//b'),'/');
 assert.equal(panelPath('https://evil.example/path'),'/');
});
