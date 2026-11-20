import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {Ledger} from '../src/ledger.ts';
import {assertDiskSpaceForLaunch, diskUsedPercent, installationVolumes, usedDiskPercent} from '../src/personal-disk.ts';
import {diskNotice} from '../src/personal-health.ts';

test('limites do volume consideram os blocos reservados e permitem retomar assim que há espaço', async () => {
  assert.equal(usedDiskPercent({blocks:1100,bfree:150,bavail:50}),95);
  assert.equal(diskNotice(89.99),null);
  assert.ok(diskNotice(90));
  assert.match(diskNotice(95)!.text,/bloqueados/);
  await assert.rejects(assertDiskSpaceForLaunch('/',async()=>95),{code:'PERSONAL_DISK_FULL'});
  await assert.rejects(assertDiskSpaceForLaunch('/',async()=>100),{code:'PERSONAL_DISK_FULL'});
  await assertDiskSpaceForLaunch('/',async()=>94.99);
  assert.throws(()=>usedDiskPercent({blocks:0,bfree:0,bavail:0}),{code:'PERSONAL_DISK_UNAVAILABLE'});
});

test('os volumes da instalação cobrem dados, raízes nativas, contas e temporário, sem repetir', async () => {
  const volumes = installationVolumes({dataDirectory: '/srv/ac/data', accountHomesDirectory: '/srv/ac/homes', nativeBootstrap: {
    planning: {hostRoot: '/srv/ac/plan', accountRoot: '/srv/ac/accounts'}, execution: {hostRoot: '/srv/ac/exec', accountRoot: '/srv/ac/accounts'}}});
  assert.deepEqual(volumes, ['/srv/ac/data', '/srv/ac/homes', '/srv/ac/plan', '/srv/ac/accounts', '/srv/ac/exec', resolve(tmpdir())]);
  assert.deepEqual(installationVolumes({dataDirectory: '/srv/ac/data', nativeBootstrap: {state: 'disabled'}}), ['/srv/ac/data', resolve(tmpdir())]);
});

test('a medição vale pelo volume mais cheio e uma lista vazia ou ilegível não admite', async () => {
  const seen: string[] = [];
  const full = (paths: string | readonly string[]) => { seen.push(...[paths].flat()); return Promise.resolve(95); };
  await assert.rejects(assertDiskSpaceForLaunch(['/a', '/b'], full), {code: 'PERSONAL_DISK_FULL'});
  assert.deepEqual(seen, ['/a', '/b']);
  await assert.rejects(diskUsedPercent([]), {code: 'PERSONAL_DISK_UNAVAILABLE'});
  await assert.rejects(assertDiskSpaceForLaunch('/a', async () => Number.NaN), {code: 'PERSONAL_DISK_UNAVAILABLE'});
  const root = await mkdtemp(join(tmpdir(), 'personal-disk-'));
  try {
    const ok = await diskUsedPercent([root, join(root, 'ausente', 'ainda')]);
    assert.ok(Number.isFinite(ok) && ok >= 0 && ok <= 100);
    await writeFile(join(root, 'arquivo'), 'x');
    await assert.rejects(diskUsedPercent(join(root, 'arquivo', 'filho')), {code: 'PERSONAL_DISK_UNAVAILABLE'});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('o Ledger carrega os volumes que o portão de capacidade mede', () => {
  const ledger = new Ledger('postgres://ac@127.0.0.1:1/ac', undefined, undefined, ['/srv/ac/data', '/srv/ac/exec']);
  try { assert.deepEqual(ledger.launchVolumes, ['/srv/ac/data', '/srv/ac/exec']); }
  finally { void ledger.pool.end(); }
});

test('os portões medem os volumes do Ledger e só caem para o diretório de dados quando não há lista', async () => {
  const {launchVolumesOf} = await import('../src/personal-disk.ts');
  assert.deepEqual(launchVolumesOf({launchVolumes: ['/a', '/b']}, '/dados'), ['/a', '/b']);
  assert.deepEqual(launchVolumesOf({launchVolumes: []}, '/dados'), ['/dados']);
  assert.deepEqual(launchVolumesOf(undefined, '/dados'), ['/dados']);
  const seen: (string | readonly string[])[] = [];
  await assertDiskSpaceForLaunch(launchVolumesOf({launchVolumes: ['/a', '/b']}, '/dados'), async paths => { seen.push(paths); return 10; });
  assert.deepEqual(seen, [['/a', '/b']]);
});
