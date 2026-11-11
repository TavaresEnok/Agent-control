import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/api.ts';
import {claimPersonalSend} from '../src/personal-panel-conversation.ts';
import type {Control} from '../src/control.ts';
import type {Ledger} from '../src/ledger.ts';
import type {CezarRuntime} from '../src/cezar.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const runtime = {projectId, nativeExecutionReady: false} as CezarRuntime;

function api(personal: boolean, authenticate: (request: Request) => Promise<string | null> = async () => null) {
  const ledger = {pool: {query: async () => { throw new Error('postgres'); }}} as unknown as Ledger;
  return createApi(ledger, runtime, authenticate, () => undefined, {
    configurationControl: {ledger} as Control,
    ...(personal ? {personalAccounts: {add: async () => ({}), status: async () => ({}), readConversation: async () => ({messages: [], next: null}), sendMessage: async () => {}}} : {}),
  });
}

test('personal conversation routes refuse anonymous callers and are absent outside personal mode', async () => {
  const locked = api(false);
  const personal = api(false, async request => request.headers.get('authorization') === 'Bearer ok' ? 'owner' : null);
  assert.equal((await locked.request('/api/v1/ac/personal/conversation')).status, 401);
  assert.equal((await locked.request('/api/v1/ac/personal/messages', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})).status, 401);
  const missingGet = await personal.request('/api/v1/ac/personal/conversation', {headers: {authorization: 'Bearer ok'}});
  const missingPost = await personal.request('/api/v1/ac/personal/messages', {method: 'POST', headers: {authorization: 'Bearer ok', 'content-type': 'application/json'}, body: '{}'});
  assert.equal(missingGet.status, 404);
  assert.equal(missingPost.status, 404);
  assert.equal((await missingGet.json() as {error: string}).error, 'NOT_FOUND');
  assert.equal((await missingPost.json() as {error: string}).error, 'NOT_FOUND');
});

test('the same clientId produces one owner message', async () => {
  const seen = new Map<string, string>();
  const first = claimPersonalSend(seen, projectId, 'abcDEF_12');
  const second = claimPersonalSend(seen, projectId, 'abcDEF_12');
  assert.equal(first.fresh, true);
  assert.equal(second.fresh, false);
  assert.equal(first.id, second.id);
  assert.equal(seen.size, 1);
  const sent: {text: string; localId: string}[] = [];
  const ledger = {pool: {query: async () => ({rowCount: 1, rows: []})}} as unknown as Ledger;
  const app = createApi(ledger, runtime, async request => request.headers.get('authorization') === 'Bearer ok' ? 'owner' : null, () => undefined, {
    configurationControl: {ledger} as Control,
    personalAccounts: {
      add: async () => ({}), status: async () => ({}), readConversation: async () => ({messages: [], next: null}),
      sendMessage: async (_principal, input) => {sent.push(input);},
    },
  });
  const post = (text: string, clientId = 'abcDEF_12') => app.request('/api/v1/ac/personal/messages', {
    method: 'POST', headers: {authorization: 'Bearer ok', 'content-type': 'application/json'}, body: JSON.stringify({text, clientId}),
  });
  const created = await post('primeiro');
  const repeated = await post('segundo');
  const createdBody = await created.json() as {id: string};
  const repeatedBody = await repeated.json() as {id: string};
  assert.equal(created.status, 202);
  assert.equal(repeated.status, 202);
  assert.deepEqual(createdBody, repeatedBody);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, 'primeiro');
  assert.equal(sent[0]!.localId, createdBody.id);
  const [left, right] = await Promise.all([post('um', 'zzzzzzzz'), post('dois', 'zzzzzzzz')]);
  const leftBody = await left.json() as {id: string};
  const rightBody = await right.json() as {id: string};
  assert.equal(left.status, 202);
  assert.equal(right.status, 202);
  assert.equal(leftBody.id, rightBody.id);
  assert.equal(sent.filter(item => item.localId === leftBody.id).length, 1);
});
