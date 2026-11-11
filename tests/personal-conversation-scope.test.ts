import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApi} from '../src/api.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {ProjectRuntimes, type Projects} from '../src/projects.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Control} from '../src/control.ts';
import type {Ledger} from '../src/ledger.ts';

test('personal conversation and messages follow the project header and never cross projects', async () => {
 const a = randomUUID(), b = randomUUID();
 const reads: string[] = [], writes: string[] = [];
 const ledger = {pool: {query: async () => ({rowCount: 1, rows: []})}} as unknown as Ledger;
 const runtimes = new ProjectRuntimes(async project => ({projectId: project.id, nativeExecutionReady: false, close: async () => {}} as CezarRuntime));
 const projects = {
  list: async () => [{id: a, label: 'A', role: 'owner'}, {id: b, label: 'B', role: 'owner'}],
  authorized: async (_principal: string, id: string) => id === a || id === b ? {id, repo: '/synthetic/' + id} : null,
 } as unknown as Projects;
 const gateway = createProjectGateway({
  projects, runtimes, defaultProjectId: a,
  authenticate: async request => request.headers.get('authorization') ? 'owner' : null,
  publicFetch: async () => new Response('public'),
  appFor(runtime) {
   const app = createApi(ledger, runtime, async request => request.headers.get('authorization') ? 'owner' : null, () => undefined, {
    configurationControl: {ledger} as Control,
    personalAccounts: {
     add: async () => ({}),
     status: async () => ({}),
     readConversation: async () => {
      reads.push(runtime.projectId);
      return {messages: [{id: runtime.projectId, role: 'manager' as const, text: runtime.projectId, createdAt: '2026-11-11T00:00:00.000Z'}], next: null};
     },
     sendMessage: async () => {writes.push(runtime.projectId);},
    },
   });
   return {fetch: (request: Request) => app.fetch(request)};
  },
 });
 const call = (path: string, project: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer ok');
  headers.set('x-agent-control-project', project);
  return gateway(new Request('http://localhost' + path, {...init, headers}));
 };
 const read = async (project: string) => (await (await call('/api/v1/ac/personal/conversation', project)).json()) as {messages: {text: string}[]};
 assert.equal((await read(a)).messages[0]?.text, a);
 assert.equal((await read(b)).messages[0]?.text, b);
 assert.deepEqual(reads, [a, b]);
 const post = (project: string) => call('/api/v1/ac/personal/messages', project, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: 'ola', clientId: 'client-01'}),
 });
 assert.equal((await post(a)).status, 202);
 assert.deepEqual(writes, [a]);
 assert.equal((await post(b)).status, 202);
 assert.deepEqual(writes, [a, b]);
 await runtimes.close();
});
