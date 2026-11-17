import assert from 'node:assert/strict';
import {lstat, mkdtemp, readFile, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {collectToolFindings} from '../src/verify-collect.ts';

const MAX_EXAM_FILE_BYTES = 50 * 1024 * 1024;

test('o JSON do exame vira achado sem o segredo inteiro', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const github = `ghp_${'a'.repeat(20)}`;
  try {
    await writeFile(join(directory, 'gitleaks.json'), JSON.stringify([{
      RuleID: 'aws-access-key', File: 'src/a.ts', StartLine: 3, Secret: secret, Description: `chave ${secret} ${github}`,
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
    assert.equal(blob.includes(github), false);
    assert.match(blob, /AKIA…/);
    assert.match(blob, /ghp_…/);
    const stored = await readFile(join(directory, 'gitleaks.json'), 'utf8');
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes(github), false);
    assert.match(stored, /AKIA…/);
    assert.match(stored, /ghp_…/);
    assert.equal((await lstat(join(directory, 'gitleaks.json'))).mode & 0o777, 0o600);
    assert.ok(result.findings.some(finding => finding.tool === 'hadolint' && finding.file === 'Dockerfile' && finding.rule === 'DL3002'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('arquivo regular entra; symlink e arquivo acima de 50 MB sao recusados', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const outside = await mkdtemp(join(tmpdir(), 'verify-collect-outside-'));
  const marker = 'OUTSIDE-OSV-MARKER-7c1e';
  try {
    await writeFile(join(directory, 'gitleaks.json'), '[]');
    await writeFile(join(outside, 'secret-osv.json'), JSON.stringify({
      results: [{
        source: {path: 'package.json'},
        packages: [{
          package: {name: 'pkg', version: '1.0.0'},
          vulnerabilities: [{id: 'GHSA-outside', summary: marker}],
        }],
      }],
    }));
    await symlink(join(outside, 'secret-osv.json'), join(directory, 'osv.json'));
    const huge = join(directory, 'grype.json');
    await writeFile(huge, '{"matches":[]}');
    await truncate(huge, MAX_EXAM_FILE_BYTES + 1);
    const hugeInfo = await lstat(huge);
    assert.equal(hugeInfo.isSymbolicLink(), false);
    assert.equal(hugeInfo.isFile(), true);
    assert.ok(hugeInfo.size > MAX_EXAM_FILE_BYTES);

    const outsideBefore = await readFile(join(outside, 'secret-osv.json'), 'utf8');
    const result = await collectToolFindings(directory);
    const blob = JSON.stringify(result);
    assert.equal(blob.includes(marker), false);
    assert.equal(await readFile(join(outside, 'secret-osv.json'), 'utf8'), outsideBefore);
    assert.deepEqual(result.files, ['gitleaks.json']);
    assert.deepEqual(result.findings, []);
    assert.equal(result.rejected, 2);
  } finally {
    await rm(directory, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});
