import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {collectToolFindings} from '../src/verify-collect.ts';

test('o JSON do exame vira achado sem o segredo inteiro', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  try {
    await writeFile(join(directory, 'gitleaks.json'), JSON.stringify([{
      RuleID: 'aws-access-key', File: 'src/a.ts', StartLine: 3, Secret: secret, Description: `chave ${secret}`,
    }]));
    await writeFile(join(directory, 'hadolint.json'), JSON.stringify([{
      code: 'DL3002', file: 'Dockerfile', line: 2, level: 'error', message: 'Last user should not be root',
    }]));
    await writeFile(join(directory, 'nota.txt'), 'ignorado\n');
    await writeFile(join(directory, 'syft.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
    const result = await collectToolFindings(directory);
    assert.deepEqual(result.files, ['gitleaks.json', 'hadolint.json']);
    assert.equal(result.findings.length, 2);
    const blob = JSON.stringify(result.findings);
    assert.equal(blob.includes(secret), false);
    assert.match(blob, /AKIA…/);
    assert.ok(result.findings.some(finding => finding.tool === 'hadolint' && finding.file === 'Dockerfile' && finding.rule === 'DL3002'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
