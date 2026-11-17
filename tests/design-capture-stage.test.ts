import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {stageDesignCapturesForJob} from '../src/design-capture-stage.ts';

test('copia png de capturas para planning e work e ignora o resto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-'));
  const planning = join(root, 'job', 'planning');
  const work = join(root, 'job', 'work');
  const run = randomUUID();
  const bytes = Buffer.from('png-da-tela');
  const name = createHash('sha256').update(bytes).digest('hex') + '.png';
  try {
    await mkdir(join(root, '.design-captures', run), {recursive: true});
    await mkdir(planning, {recursive: true});
    await mkdir(work, {recursive: true});
    await writeFile(join(root, '.design-captures', run, name), bytes, {mode: 0o600});
    await writeFile(join(root, '.design-captures', run, 'nota.txt'), 'nao');
    await symlink('/etc/hostname', join(root, '.design-captures', run, `${'ab'.repeat(32)}.png`));
    const copied = await stageDesignCapturesForJob(root, [planning, work]);
    assert.equal(copied, 2);
    assert.equal(await readFile(join(planning, 'capturas', name), 'utf8'), 'png-da-tela');
    assert.equal(await readFile(join(work, 'capturas', name), 'utf8'), 'png-da-tela');
    assert.equal(await stageDesignCapturesForJob(join(root, 'job'), [planning]), 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
