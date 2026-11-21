import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Installation} from '../src/installation.ts';

test('the public origin requires TLS outside loopback and carries no credentials, path or query',()=>{
 const base={schemaVersion:1 as const,mode:'administration-only' as const,databaseUrl:'postgresql://fixture@localhost/fixture',dataDirectory:'/tmp/private',
  project:{id:randomUUID(),label:'Origin fixture',repo:'/tmp/repo',owner:'synthetic-owner'},
  http:{listen:'127.0.0.1' as const,port:18405,publicOrigin:'https://cockpit.example'}};
 for(const origin of ['http://public.example','http://192.0.2.8','http://cockpit','http://127.0.0.1.evil.example',
  'https://user:password@cockpit.example','https://cockpit.example/path','https://cockpit.example?secret=fixture'])
  assert.throws(()=>Installation.parse({...base,http:{...base.http,publicOrigin:origin}}),origin);
 for(const origin of ['http://127.0.0.1:18401','http://localhost:18401','http://[::1]:18401','https://cockpit.example'])
  assert(Installation.parse({...base,http:{...base.http,publicOrigin:origin}}),origin);
});

test('an installation written before the conversation server was retired still loads, without that block',()=>{
 const base={schemaVersion:1 as const,mode:'administration-only' as const,databaseUrl:'postgresql://fixture@localhost/fixture',dataDirectory:'/tmp/private',
  project:{id:randomUUID(),label:'Legacy fixture',repo:'/tmp/repo',owner:'synthetic-owner'},
  http:{listen:'127.0.0.1' as const,port:18405,publicOrigin:'https://cockpit.example'}};
 const legacy=Installation.parse({...base,happier:{upstreamOrigin:'http://127.0.0.1:8081',webOrigin:'http://127.0.0.1:8082',publicServerOrigin:'http://127.0.0.1:8081'}});
 assert.equal('happier' in legacy,false);
 assert.deepEqual(legacy,Installation.parse(base));
 assert.throws(()=>Installation.parse({...base,unknownBlock:{}}));
});
