import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { Ledger } from '../src/ledger.ts';
import { loadHappier, HappierEndpoint } from '../src/happier.ts';
import { CezarRuntime } from '../src/cezar.ts';
import { provisionCapacity } from './fixtures/provision-capacity.ts';
import { ContextKeys, keyFingerprint } from '../src/context-keys.ts';
import { Refusal } from '../src/contracts.ts';

test('C02/C04/C05/C06: two encrypted Happier conversations -> PG -> Cezar -> Git -> canonical history', { timeout: 120000 }, async () => {
  const database = process.env.AC_TEST_DATABASE_URL;
  if (!database?.includes('/ac_implementation_test')) throw Error('TEST_DATABASE_REQUIRED');
  const b = await loadHappier(), db = new Ledger(database); await db.migrate();
  const baseUrl = 'http://127.0.0.1:18401', key = randomBytes(32), kp = nacl.sign.keyPair.fromSeed(key), challenge = randomBytes(32);
  const b64 = (v: Uint8Array) => Buffer.from(v).toString('base64');
  const authResponse = await fetch(baseUrl + '/v1/auth', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(nacl.sign.detached(challenge, kp.secretKey)) }) });
  assert.equal(authResponse.status, 200);
  const { token } = z.object({ token: z.string() }).passthrough().parse(await authResponse.json());
  async function api(path: string, body?: unknown) {
    const response = await fetch(baseUrl + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, 'HAPPIER_HTTP_' + response.status + '_' + path); return response.json() as Promise<unknown>;
  }
  const { id: principal } = z.object({ id: z.string() }).passthrough().parse(await api('/v1/account/profile'));
  const seal = (v: unknown) => b.encodeBase64(b.encrypt(key, 'legacy', v));
  const machineId = randomUUID(); await api('/v1/machines', { id: machineId, metadata: seal({ host: 'isolated-implementation', platform: 'linux', happyCliVersion: '0.2.18', homeDir: '/tmp/synthetic' }), daemonState: seal({ status: 'running', startedAt: Date.now() }) });
  await mkdir('.state/projects', { recursive: true });
  const repo = await mkdtemp(resolve('.state/projects/ac-happier-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README.md'), 'Isolated integration fixture\n'); git('add', '.'); git('commit', '-qm', 'base'); git('branch','protected');
  await mkdir(join(repo, '.ai/cezar'), { recursive: true });
  await writeFile(join(repo, '.ai/cezar/config.json'), JSON.stringify({ baseBranch: 'main', skillsRepos: [], maxParallel: 2, worktreeRetention: 0 }));
  const project = randomUUID(); await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Two chats / one project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  const capacity = await provisionCapacity(db, principal, project);
  const runtime = new CezarRuntime(db, repo, project); await runtime.start();
  const endpoints: HappierEndpoint[] = [], sessions: string[] = [], contexts: string[] = [];
  let pendingFault = true;
  const user = io(baseUrl, { path: '/v1/updates', transports: ['websocket'], auth: { token, clientType: 'user-scoped' } });
  try {
    await new Promise<void>((resolve, reject) => { user.once('connect', resolve); user.once('connect_error', reject); });
    for (let i = 0; i < 2; i++) {
      const raw = z.object({ session: z.object({ id: z.string() }).passthrough() }).passthrough().parse(await api('/v1/sessions', {
        tag: 'ac-implementation-' + randomUUID(), encryptionMode: 'e2ee',
        metadata: seal({ machineId, path: repo, host: 'isolated-implementation', homeDir: '/tmp/synthetic', version: '0.2.18', name: `Conversa ${i + 1}`, flavor: 'claude', startedBy: 'terminal', startedFromDaemon: false }),
        agentState: seal({ controlledByUser: false, requests: {}, completedRequests: {} }),
      }));
      const sessionId = raw.session.id; sessions.push(sessionId);
      const contextId = await db.createContext(principal, project, sessionId); contexts.push(contextId);
      await capacity.service.assignPolicy(principal, contextId, capacity.revision);
      await new ContextKeys(db).authorize(principal,contextId,1,'legacy',keyFingerprint(key));
      const authority = await db.acquire(principal, contextId, randomUUID(), 'synthetic-sol-profile');
      const transportBoundary = i === 0 ? { ...b, materializeNextPendingQueueV2Message: async (options: Record<string, unknown>) => {
        const result = await b.materializeNextPendingQueueV2Message(options);
        if (pendingFault) throw Error('INJECTED_PENDING_POLL_ACK_LOSS');
        return result;
      } } : b;
      const endpoint = new HappierEndpoint(db, runtime, transportBoundary, { baseUrl, token, key, principal, sessionId, machineId, authority });
      await endpoint.start(); endpoints.push(endpoint);
    }
    async function send(index: number, text: string, localId: string) {
      const payload = seal({ text, localId });
      const raw: unknown = await new Promise((resolve, reject) => user.timeout(12000).emit('rpc-call',
        { method: sessions[index] + ':session.userMessage.send', params: payload, timeoutMs: 10000 },
        (error: Error | null, response: unknown) => error ? reject(error) : resolve(response)));
      const envelope = z.object({ ok: z.literal(true), result: z.string() }).passthrough().parse(raw);
      return z.object({ ok: z.literal(true), intentId: z.string() }).passthrough().parse(b.decrypt(key, 'legacy', b.decodeBase64(envelope.result)));
    }
    const texts = ['Implemente a primeira entrega do painel azul.', 'Implemente o módulo de relatórios verdes.'];
    const reusedLocalId = randomUUID();
    const localIds = [reusedLocalId, reusedLocalId];
    const forged = b.encrypt(key, 'legacy', { text: 'tampered' }); forged[forged.length - 1] ^= 1;
    assert.equal(b.decrypt(key, 'legacy', forged), null, 'ciphertext integrity is checked by the native implementation');
    const wrongLink = new HappierEndpoint(db, runtime, b, { baseUrl, token, key, principal, sessionId: sessions[1], machineId,
      authority: endpoints[0].options.authority });
    try { await assert.rejects(wrongLink.start(), /SESSION_CONTEXT_MISMATCH/); } finally { wrongLink.close(); }
    const accepted = [await send(0, texts[0], localIds[0]), await send(1, texts[1], localIds[1])];
    const replay = await send(0, texts[0], localIds[0]); assert.equal(replay.intentId, accepted[0].intentId);
    let progressedDuringPollFailure = false;
    for (let i = 0; i < 80; i++) {
      const result = await db.pool.query(`SELECT o.state FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id WHERE i.id=$1`, [accepted[0].intentId]);
      if (result.rows[0]?.state === 'completed') { progressedDuringPollFailure = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(progressedDuringPollFailure, 'an already committed intent must progress despite pending-poll acknowledgement loss');
    pendingFault = false;
    let finished = false;
    for (let i = 0; i < 500; i++) {
      const r = await db.pool.query("SELECT count(*) n FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id WHERE i.context_id=ANY($1::uuid[]) AND o.state='completed'", [contexts]);
      if (Number(r.rows[0].n) === 2 && endpoints.every(e => !e.lastError)) { finished = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(finished, 'integration pending: ' + JSON.stringify(endpoints.map(e => e.lastError)));
    // A paused context must still deliver already-persisted messages; it must
    // never start a new worker simply to update an existing run's status.
    await db.pause(principal,contexts[0],true);
    const pendingId=sessions[0]+'|paused-outbox-'+randomUUID();
    await db.pool.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext) VALUES($1,$2,$3)',
      [pendingId,sessions[0],seal({role:'agent',content:{type:'text',text:'fixture-paused-delivery'}})]);
    let deliveredWhilePaused=false;
    for(let i=0;i<100;i++){
      if((await db.pool.query('SELECT sent FROM ac_chat_messages WHERE id=$1',[pendingId])).rows[0]?.sent){deliveredWhilePaused=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(deliveredWhilePaused,'paused conversation must continue sending previously persisted messages');
    assert.equal(runtime.store.listRuns().length,2);
    await db.pause(principal,contexts[0],false);
    const dispatch=runtime.dispatch.bind(runtime);
    runtime.dispatch=async(intent,authority)=>{
      if(intent.context_id===contexts[0])throw new Refusal('CAPACITY_BUSY');
      return dispatch(intent,authority);
    };
    try{
      const waitId=sessions[0]+'|capacity-outbox-'+randomUUID();
      await db.pool.query('INSERT INTO ac_chat_messages(id,session_id,ciphertext) VALUES($1,$2,$3)',
        [waitId,sessions[0],seal({role:'agent',content:{type:'text',text:'fixture-capacity-delivery'}})]);
      let sent=false;
      for(let i=0;i<100;i++){
        if((await db.pool.query('SELECT sent FROM ac_chat_messages WHERE id=$1',[waitId])).rows[0]?.sent){sent=true;break;}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert(sent,'capacity wait must not block already persisted chat messages');
    }finally{runtime.dispatch=dispatch;}
    await new Promise(resolve => setTimeout(resolve, 1600));
    const histories: unknown[][] = [];
    for (let index = 0; index < 2; index++) {
      const response = z.object({ messages: z.array(z.object({ content: z.unknown() }).passthrough()) }).passthrough()
        .parse(await api(`/v1/sessions/${sessions[index]}/messages?scope=main&limit=150`));
      const decoded = response.messages.map(m => {
        const envelope = z.object({ t: z.literal('encrypted'), c: z.string() }).parse(typeof m.content === 'string' ? JSON.parse(m.content) : m.content);
        return b.decrypt(key, 'legacy', b.decodeBase64(envelope.c));
      });
      histories.push(decoded);
      const text = JSON.stringify(decoded);
      assert(text.includes(texts[index])); assert(!text.includes(texts[1 - index]));
      assert(text.includes('execução concluída') && text.includes('"kind":"completion"'), 'canonical history must include this conversation runtime completion');
      assert.equal(decoded.filter(m => typeof m === 'object' && m && 'role' in m && m.role === 'user').length, 1);
    }
    assert.notEqual(contexts[0], contexts[1]); assert.notEqual(sessions[0], sessions[1]);
    assert.equal(runtime.store.listRuns().length, 2);
    const previous = endpoints[0];
    await db.checkpoint(previous.options.authority, { schemaVersion: 1, planRevision: 1,
      objectiveRef: `happier:${sessions[0]}:${localIds[0]}`, constraintRefs: ['encrypted:fixture-constraints'],
      decisionRefs: ['encrypted:fixture-decisions'], artifactRefs: ['git:synthetic-candidate'], pendingIntentIds: [], historyCursor: histories[0].length });
    // Populate more than one native server page with encrypted fixture messages.
    for (let index = 0; index < 155; index++) await api(`/v2/sessions/${sessions[0]}/messages`, {
      ciphertext: seal({ role: 'agent', content: { type: 'text', text: `synthetic-history-${index}` } }), localId: randomUUID(),
    });
    previous.close(); await new Promise(resolve => setTimeout(resolve, 500));
    await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1", [contexts[0]]);
    const replacement = await db.acquire(principal, contexts[0], randomUUID(), 'synthetic-sol-profile');
    assert.equal(replacement.epoch, previous.options.authority.epoch + 1);
    const resumed = new HappierEndpoint(db, runtime, b, { baseUrl, token, key, principal, sessionId: sessions[0], machineId, authority: replacement });
    await resumed.start(); endpoints[0] = resumed;
    assert.deepEqual(resumed.recoveredCheckpoint?.constraintRefs, ['encrypted:fixture-constraints']);
    assert.deepEqual(resumed.recoveredCheckpoint?.decisionRefs, ['encrypted:fixture-decisions']);
    assert(JSON.stringify(resumed.recoveredMessages).includes(texts[0]));
    assert(JSON.stringify(resumed.recoveredMessages).includes('synthetic-history-0'));
    assert(JSON.stringify(resumed.recoveredMessages).includes('synthetic-history-154'));
    assert(resumed.recoveredMessages.length > 150, 'all pages recovered, including the original request');
    assert(!JSON.stringify(resumed.recoveredMessages).includes(texts[1]));
    await assert.rejects(previous.accept({ text: 'New effect from old manager', localId: randomUUID() }), /STALE_MANAGER/);
    assert.equal((await send(0, texts[0], localIds[0])).intentId, accepted[0].intentId);
    const records = await db.pool.query('SELECT command::text FROM ac_intents WHERE context_id=ANY($1::uuid[])', [contexts]);
    for (const text of texts) assert(!JSON.stringify(records.rows).includes(text), 'no plaintext transcript in ledger');
    await writeFile('.state/browser-fixture.json', JSON.stringify({ token, secret: key.toString('base64url'), sessions, contexts, project, principal, repo }), { mode: 0o600 });
    await writeFile('docs/validation/evidence/happier-integration.json', JSON.stringify({ result: 'passed', project, contexts, sessions,
      runs: runtime.store.listRuns().map(r => ({ id: r.id, status: r.status, workflow: r.workflow })),
      encryptedMessageCounts: histories.map(h => h.length), duplicateIntentId: replay.intentId, synthetic: true,
      progressedDuringPollFailure,
      sameProfileTakeover: { oldEpoch: previous.options.authority.epoch, newEpoch: replacement.epoch,
        checkpointRecovered: !!resumed.recoveredCheckpoint, historyRecoveredMessages: resumed.recoveredMessages.length, staleEffectRejected: true },
      limitations: ['Synthetic manager/executor; no real providers or physical devices.', 'Key revocation and native pairing not yet implemented.'] }, null, 2));
  } finally { endpoints.forEach(e => e.close()); user.disconnect(); await new Promise(r => setTimeout(r, 400)); await runtime.close(); await db.close(); }
});
