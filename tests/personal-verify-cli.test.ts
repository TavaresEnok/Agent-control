import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keepPersonalVerifyLease} from '../src/personal-verify-cli.ts';

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
