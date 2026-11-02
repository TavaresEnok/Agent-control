// Isolated, synthetic fixture launcher. Production bootstrap and key custody remain I2/I7 gates.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { serve } from '@hono/node-server';
import { Ledger } from './ledger.ts';
import { CezarRuntime } from './cezar.ts';
import { HappierEndpoint, loadHappier } from './happier.ts';
import { createApi } from './api.ts';
import { randomUUID } from 'node:crypto';
const fixture = z.object({ token: z.string(), secret: z.string(), sessions: z.array(z.string()), contexts: z.array(z.uuid()),
  project: z.uuid(), principal: z.string(), repo: z.string() }).parse(JSON.parse(await readFile('.state/browser-fixture.json', 'utf8')));
if (!process.env.AC_TEST_DATABASE_URL?.includes('/ac_implementation_test')) throw Error('ISOLATED_DATABASE_REQUIRED');
const ledger = new Ledger(process.env.AC_TEST_DATABASE_URL); await ledger.migrate();
const runtime = new CezarRuntime(ledger, fixture.repo, fixture.project); await runtime.start();
const boundary = await loadHappier();
const endpoints: HappierEndpoint[] = [];
const metadataResponse = await fetch('http://127.0.0.1:18401/v2/sessions/' + fixture.sessions[0], { headers: { authorization: 'Bearer ' + fixture.token } });
const metadataBody = z.object({ session: z.object({ metadata: z.string() }).passthrough() }).passthrough().parse(await metadataResponse.json());
const key = Buffer.from(fixture.secret, 'base64url');
const { machineId } = z.object({ machineId: z.string() }).passthrough().parse(boundary.decrypt(key, 'legacy', boundary.decodeBase64(metadataBody.session.metadata)));
for (let i = 0; i < fixture.contexts.length; i++) {
  const instanceId = randomUUID();
  let authority: import('./contracts.ts').Authority | undefined;
  for (let retry = 0; retry < 60; retry++) {
    try { authority = await ledger.acquire(fixture.principal, fixture.contexts[i], instanceId, 'synthetic-sol-profile'); break; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'MANAGER_ACTIVE') throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!authority) throw Error('MANAGER_STILL_ACTIVE_AFTER_BOUNDED_WAIT');
  const endpoint = new HappierEndpoint(ledger, runtime, boundary, { baseUrl: 'http://127.0.0.1:18401', token: fixture.token,
    key, principal: fixture.principal, sessionId: fixture.sessions[i], machineId, authority });
  await endpoint.start(); endpoints.push(endpoint);
}
const api = createApi(ledger, runtime, async request => {
  const authorization = request.headers.get('authorization'); if (!authorization) return null;
  const response = await fetch('http://127.0.0.1:18401/v1/account/profile', { headers: { authorization } });
  if (!response.ok) return null;
  return z.object({ id: z.string() }).passthrough().parse(await response.json()).id;
}, context => endpoints.find(e => e.options.authority.contextId === context)?.options.authority);
const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 18402 }, () => console.log('ISOLATED_AGENT_CONTROL_READY'));
process.on('SIGTERM', () => {
  endpoints.forEach(e => e.close()); server.close();
  void runtime.close().then(() => ledger.close()).then(() => process.exit(0));
});
