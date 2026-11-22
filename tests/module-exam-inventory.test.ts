import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';

test('mapa dos módulos 2 a 9: arquivo de texto até 64 kB é lido inteiro e o exame corta; acima disso fica fora', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-inventory-'));
  try {
    const big = Array.from({length: 1500}, (_, index) => `const v${index} = ${index};`).join('\n') + '\n';
    assert.ok(big.length > 16_000 && big.length < 64_000);
    await writeFile(join(root, 'service.ts'), big);
    await writeFile(join(root, 'huge.ts'), 'x'.repeat(64_001));
    const map = await mapModuleSnapshot(root);
    assert.equal(map.files.find(row => row.file === 'service.ts')?.code, big);
    const huge = map.files.find(row => row.file === 'huge.ts');
    assert.equal(huge?.code, null);
    assert.equal(huge?.reason, 'arquivo excede limite ou não é regular');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
