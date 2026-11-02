// Isolated, synthetic fixture launcher. Production bootstrap and key custody remain I2/I7 gates.
import { readFile,writeFile,mkdir,lstat,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { serve } from '@hono/node-server';
import { Ledger } from './ledger.ts';
import { CezarRuntime } from './cezar.ts';
import { HappierEndpoint, loadHappier } from './happier.ts';
import { createApi } from './api.ts';
import { randomBytes,randomUUID } from 'node:crypto';
import { GitArtifacts } from './git.ts';
import { Quality } from './quality.ts';
import { Operators } from './operator.ts';
import { digest } from './contracts.ts';
import { BrowserSessions } from './sessions.ts';
const fixture = z.object({ token: z.string(), secret: z.string(), sessions: z.array(z.string()), contexts: z.array(z.uuid()),
  project: z.uuid(), principal: z.string(), repo: z.string() }).parse(JSON.parse(await readFile('.state/browser-fixture.json', 'utf8')));
if (!process.env.AC_TEST_DATABASE_URL?.includes('/ac_implementation_test')) throw Error('ISOLATED_DATABASE_REQUIRED');
const ledger = new Ledger(process.env.AC_TEST_DATABASE_URL); await ledger.migrate();
await mkdir('.state/keys',{recursive:true,mode:0o700});
const verifierPath=join('.state/keys','fixture-verifier-'+fixture.project);
let verifierKey:Buffer;
try{
 const info=await lstat(verifierPath);
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('UNSAFE_FIXTURE_VERIFIER_KEY');
 verifierKey=await readFile(verifierPath);
}catch(error){
 if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
 verifierKey=randomBytes(32);await writeFile(verifierPath,verifierKey,{mode:0o600,flag:'wx'});
}
if(verifierKey.length!==32)throw Error('INVALID_FIXTURE_VERIFIER_KEY');
const git=new GitArtifacts(fixture.repo),quality=new Quality(ledger,verifierKey,git);
const runtime = new CezarRuntime(ledger, fixture.repo, fixture.project,
 {git,quality,verifierKey,allowedTargets:['refs/heads/protected']}); await runtime.start();
// The lab bootstrap is separate from provider credentials and is never emitted to logs.
const enrolled=(await ledger.pool.query("SELECT 1 FROM ac_operator_keys WHERE principal_id=$1 AND state='active' LIMIT 1",[fixture.principal])).rowCount;
const pending=(await ledger.pool.query("SELECT 1 FROM ac_operator_bootstrap WHERE principal_id=$1 AND NOT used AND failed_attempts<5 AND expires_at>clock_timestamp()",[fixture.principal])).rowCount;
if(!enrolled&&!pending){
 const admin='synthetic-fixture-bootstrap-admin';
 await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[admin]);
 const token=randomBytes(32).toString('hex');
 await new Operators(ledger).prepareBootstrap(admin,fixture.principal,token);
 const path=join('.state/keys','lab-operator-bootstrap-'+digest(fixture.principal));
 const temporary=path+'.'+randomUUID();await writeFile(temporary,token+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);
}

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
const verifyBearer = async (request:Request) => {
  const authorization = request.headers.get('authorization'); if (!authorization) return null;
  const response = await fetch('http://127.0.0.1:18401/v1/account/profile', { headers: { authorization } });
  if (!response.ok) return null;
  return z.object({ id: z.string() }).passthrough().parse(await response.json()).id;
};
const browserKeyPath=join('.state/keys','fixture-browser-session-key');
let browserKey:Buffer;
try{const info=await lstat(browserKeyPath);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw Error('UNSAFE_BROWSER_KEY');browserKey=await readFile(browserKeyPath);}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;browserKey=randomBytes(32);await writeFile(browserKeyPath,browserKey,{mode:0o600,flag:'wx'});}
const sessions=new BrowserSessions(ledger,browserKey,verifyBearer,{origin:'http://127.0.0.1:18402',secure:false,maxAgeSeconds:86400});
const api=createApi(ledger,runtime,verifyBearer,context=>endpoints.find(e=>e.options.authority.contextId===context)?.options.authority,
 'http://127.0.0.1:18400',undefined,sessions);
const server = serve({ fetch: api.fetch, hostname: '127.0.0.1', port: 18402 }, () => console.log('ISOLATED_AGENT_CONTROL_READY'));
process.on('SIGTERM', () => {
  endpoints.forEach(e => e.close()); server.close();
  void runtime.close().then(() => ledger.close()).then(() => process.exit(0));
});
