import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {Ledger} from '../src/ledger.ts';
import type {CezarRuntime} from '../src/cezar.ts';

const projectId = '00000000-0000-4000-8000-000000000001';
const runtime = {projectId, nativeExecutionReady: false} as CezarRuntime;

function api(personal: boolean, authenticate: (request: Request) => Promise<string | null> = async () => null) {
  const ledger = {pool: {query: async () => { throw new Error('postgres'); }}} as unknown as Ledger;
  return createApi(ledger, runtime, authenticate, () => undefined, {
    configurationControl: {ledger} as Control,
    ...(personal ? {personalAccounts: {add: async () => ({}), status: async () => ({}), readConversation: async () => ({messages: [], next: null})}} : {}),
  });
}

test('personal conversation routes refuse anonymous callers and are absent outside personal mode', async () => {
  const locked = api(false);
  const personal = api(false, async request => request.headers.get('authorization') === 'Bearer ok' ? 'owner' : null);
  const path = '/api/v1/ac/personal/conversation';
  assert.equal((await locked.request(path)).status, 401);
  const missing = await personal.request(path, {headers: {authorization: 'Bearer ok'}});
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as {error: string}).error, 'NOT_FOUND');
});
