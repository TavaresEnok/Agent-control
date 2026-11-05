import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertNativeSyntheticFixture,authorizeNativeSyntheticFixture} from '../src/native-synthetic-fixture.ts';

test('serialized fixture opt-in cannot issue a native execution capability',async()=>{
 const token={contract:'native-synthetic-fixture-v1' as const,projectId:randomUUID(),contextId:randomUUID(),provider:'synthetic-engineering' as const,label:'ac-r3-flow-test',workerImage:'sha256:'+'a'.repeat(64),toolsImage:'sha256:'+'a'.repeat(64),providerNetworkId:'b'.repeat(64)};
 assert.throws(()=>assertNativeSyntheticFixture(token,token),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
 assert.throws(()=>assertNativeSyntheticFixture(Object.freeze(JSON.parse(JSON.stringify(token))),token),/SYNTHETIC_FIXTURE_CAPABILITY_INVALID/);
 await assert.rejects(authorizeNativeSyntheticFixture({...token,provider:'codex'} as never));
 await assert.rejects(authorizeNativeSyntheticFixture({...token,label:'operational'}));
});
