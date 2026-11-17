import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepPersonalVerifyLease, releasePersonalVerifyLease} from '../src/personal-verify-cli.ts';

async function until(done: () => boolean) {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 1000) throw new Error('a renovação não aconteceu a tempo');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('a locação do comando é renovada enquanto o exame corre e um erro de renovação não derruba o processo', async () => {
  let beats = 0;
  const stop = keepPersonalVerifyLease({
    async heartbeat() {
      beats += 1;
      if (beats === 1) throw new Error('lease ocupada');
    },
  }, {contextId: 'contexto'}, 20);
  await new Promise(resolve => setTimeout(resolve, 70));
  stop();
  const settled = beats;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(settled >= 2);
  assert.equal(beats, settled);
});

test('três falhas seguidas de renovação abortam uma vez e a quarta não aborta de novo', async () => {
  let beats = 0;
  let aborts = 0;
  let abortsAtBeat3 = -1;
  let abortsAtBeat4 = -1;
  let stop = () => {};
  try {
    stop = keepPersonalVerifyLease({
      async heartbeat() {
        beats += 1;
        if (beats === 3) abortsAtBeat3 = aborts;
        if (beats === 4) abortsAtBeat4 = aborts;
        if (beats >= 4) stop();
        throw new Error('lease ocupada');
      },
    }, {contextId: 'contexto'}, 20, () => { aborts += 1; });
    await until(() => beats >= 4);
    assert.equal(abortsAtBeat3, 0);
    assert.equal(abortsAtBeat4, 1);
    assert.equal(aborts, 1);
    assert.ok(beats >= 4);
  } finally {
    stop();
  }
});

test('falha, falha, sucesso, falha e falha não abortam a locação', async () => {
  const steps = ['fail', 'fail', 'ok', 'fail', 'fail'];
  const seen: string[] = [];
  let aborts = 0;
  let stop = () => {};
  try {
    stop = keepPersonalVerifyLease({
      async heartbeat() {
        const step = steps[seen.length] ?? 'ok';
        seen.push(step);
        if (seen.length >= steps.length) stop();
        if (step === 'fail') throw new Error('lease ocupada');
      },
    }, {contextId: 'contexto'}, 20, () => { aborts += 1; });
    await until(() => seen.length >= steps.length);
    assert.deepEqual(seen.slice(0, steps.length), steps);
    assert.equal(aborts, 0);
  } finally {
    stop();
  }
});

test('soltar a locação zera lease_until filtrando contexto, instância e época', async () => {
  const seen: {sql: string; params: readonly unknown[] | undefined}[] = [];
  const authority = {contextId: 'contexto', instanceId: 'instancia', epoch: 4};
  await releasePersonalVerifyLease({
    pool: {
      async query(sql: string, params?: readonly unknown[]) {
        seen.push({sql, params});
      },
    },
  }, authority);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sql, 'UPDATE ac_managers SET lease_until = clock_timestamp() WHERE context_id=$1 AND instance_id=$2 AND epoch=$3');
  assert.deepEqual(seen[0].params, [authority.contextId, authority.instanceId, authority.epoch]);
  await assert.rejects(
    releasePersonalVerifyLease({
      pool: {async query() { throw new Error('db fora'); }},
    }, authority),
    /db fora/,
  );
});
