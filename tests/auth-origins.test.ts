import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HappierAuthRelay} from '../src/auth-relay.ts';
import {Installation} from '../src/installation.ts';
import type {BrowserSessions} from '../src/sessions.ts';

test('credential-bearing origins require TLS outside loopback in both configuration and relay',()=>{
 const base={schemaVersion:1 as const,mode:'administration-only' as const,databaseUrl:'postgresql://fixture@localhost/fixture',dataDirectory:'/tmp/private',
  project:{id:randomUUID(),label:'Origin fixture',repo:'/tmp/repo',owner:'synthetic-owner'},
  http:{listen:'127.0.0.1' as const,port:18405,publicOrigin:'https://cockpit.example'},
  happier:{upstreamOrigin:'https://happier.example',webOrigin:'https://chat.example',publicServerOrigin:'https://happier.example'}};
 for(const origin of ['http://public.example','http://192.0.2.8','http://happier','http://127.0.0.1.evil.example',
  'https://user:password@happier.example','https://happier.example/path','https://happier.example?secret=fixture']){
  assert.throws(()=>Installation.parse({...base,happier:{...base.happier,upstreamOrigin:origin}}));
  assert.throws(()=>new HappierAuthRelay({} as BrowserSessions,{upstreamUrl:origin,webUrl:base.happier.webOrigin,publicServerUrl:base.happier.publicServerOrigin}));
 }
 for(const origin of ['http://127.0.0.1:18401','http://localhost:18401','http://[::1]:18401','https://happier.example']){
  assert(Installation.parse({...base,happier:{...base.happier,upstreamOrigin:origin}}));
  assert(new HappierAuthRelay({} as BrowserSessions,{upstreamUrl:origin,webUrl:base.happier.webOrigin,publicServerUrl:base.happier.publicServerOrigin}));
 }
});
