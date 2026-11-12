import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {importPersonalConversation} from '../src/import-conversation.ts';
import type {HappierBoundary} from '../src/happier.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

function encrypted(record: unknown) {
  return {t: 'encrypted', c: Buffer.from(JSON.stringify(record)).toString('base64')};
}
function owner(text: string) {
  return {role: 'user', content: {type: 'text', text}};
}
function manager(text: string) {
  return {role: 'agent', content: {type: 'output', data: {message: {content: [{type: 'text', text}]}}}};
}

test('importing a Happier transcript twice does not duplicate messages', async () => {
  const base = process.env.AC_TEST_DATABASE_URL;
  if (!base) throw Error('ISOLATED_DATABASE_REQUIRED');
  const fixture = await isolatedDatabase(base, 'importconv');
  const db = new Ledger(fixture.url);
  const folder = await mkdtemp(join(tmpdir(), 'ac-import-'));
  const key = randomBytes(32);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw Error('HAPPIER_FETCH_FORBIDDEN'); };
  try {
    await db.migrate();
    const project = randomUUID(), principal = 'owner-' + randomUUID(), sessionId = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Import']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    const context = await db.createContext(principal, project, sessionId);
    const installation = join(folder, 'installation.json');
    await writeFile(installation, JSON.stringify({
      schemaVersion: 1, mode: 'administration-only', activation: 'personal', databaseUrl: fixture.url, dataDirectory: folder,
      project: {id: project, label: 'Import', repo: '/srv/ac-import-repo', owner: principal},
      contextVault: {directory: join(folder, 'vault'), masterFile: join(folder, 'vault-master')},
      managerTransport: {principal, tokenFile: join(folder, 'token'), machineId: 'machine', contexts: [{projectId: project, contextId: context, sessionId, profileId: 'profile', keyVersion: 1, encryptionVariant: 'legacy'}]},
      http: {listen: '127.0.0.1', port: 8080, publicOrigin: 'http://127.0.0.1:8080'},
      happier: {upstreamOrigin: 'http://127.0.0.1:8081', webOrigin: 'http://127.0.0.1:8082', publicServerOrigin: 'http://127.0.0.1:8083'},
    }), {mode: 0o600});
    await chmod(installation, 0o600);
    const pages = [
      {messages: [
        {id: 'm3', seq: 30, createdAt: 1_700_000_030_000, content: encrypted(manager('Resposta do gerente.'))},
        {id: 'm-skip', seq: 20, createdAt: 1_700_000_020_000, content: encrypted({role: 'system', content: {type: 'event'}})},
      ], hasMore: true, nextBeforeSeq: 20, nextAfterSeq: null},
      {messages: [
        {id: 'm2', seq: 12, createdAt: 1_700_000_012_000, content: encrypted(owner('segunda frase'))},
        {id: 'm1', seq: 10, createdAt: 1_700_000_010_000, content: encrypted(owner('primeira frase'))},
      ], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null},
    ];
    const seen: (string | null)[] = [];
    const fetchPage: typeof fetch = async input => {
      const url = new URL(String(input));
      const before = url.searchParams.get('beforeSeq');
      seen.push(before);
      const body = before === null ? pages[0] : pages[1];
      return new Response(JSON.stringify(body), {status: 200});
    };
    const boundary = {decrypt: (_key: Uint8Array, _variant: string, bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8')), decodeBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))} as unknown as HappierBoundary;
    const loadKey = () => Uint8Array.from(key);
    const first = await importPersonalConversation(installation, {fetchPage, loadKey, token: 'import-token', boundary});
    const second = await importPersonalConversation(installation, {fetchPage, loadKey, token: 'import-token', boundary});
    assert.deepEqual(first, {inserted: 3, existing: 0, contexts: 1});
    assert.deepEqual(second, {inserted: 0, existing: 3, contexts: 1});
    assert.deepEqual(seen, [null, '20', null, '20']);
    const rows = await db.pool.query('SELECT id,role,text,local_id,accepted FROM ac_personal_messages WHERE context_id=$1 ORDER BY seq', [context]);
    assert.deepEqual(rows.rows, [
      {id: context + '|m1', role: 'owner', text: 'primeira frase', local_id: 'm1', accepted: true},
      {id: context + '|m2', role: 'owner', text: 'segunda frase', local_id: 'm2', accepted: true},
      {id: context + '|m3', role: 'manager', text: 'Resposta do gerente.', local_id: 'm3', accepted: true},
    ]);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2', [context, 'm-skip'])).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_intents WHERE context_id=$1', [context])).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_chat_messages')).rows[0].n, 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    key.fill(0);
    await db.close();
    await fixture.close();
    await rm(folder, {recursive: true, force: true});
  }
});
