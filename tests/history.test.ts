import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverHistory, type HappierBoundary } from '../src/happier.ts';

const boundary = { decodeBase64: (v: string) => Buffer.from(v), decrypt: (_k: Uint8Array, _v: string, bytes: Uint8Array) => Buffer.from(bytes).toString() } as unknown as HappierBoundary;
const message = (seq: number) => ({ seq, content: { t: 'encrypted', c: String(seq) } });
const call = (response: object) => (async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch;

test('history refuses a non-progressing cursor rather than silently truncating', async () => {
  await assert.rejects(recoverHistory('http://local', 'session', 'fixture', new Uint8Array(), boundary,
    call({ messages: [message(4)], hasMore: true, nextBeforeSeq: 5 })), /HISTORY_CURSOR_INVALID/);
});
test('history rejects duplicate or reversed sequence numbers', async () => {
  await assert.rejects(recoverHistory('http://local', 'session', 'fixture', new Uint8Array(), boundary,
    call({ messages: [message(4), message(4)], hasMore: false, nextBeforeSeq: null })), /HISTORY_ORDER_INVALID/);
});
