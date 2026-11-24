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

test('gitleaks e checkov no formato real continuam JSON legivel depois da redacao', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const secret = 'AbCdEf0123456789xyzXYZabcdef0123456789Q';
  try {
    // Formato real do gitleaks 8.30: lista de objetos com Match e Secret, mais Author e Email vazios.
    const leaks = Array.from({length: 40}, (_, index) => ({
      RuleID: 'generic-api-key', Description: 'Detected a Generic API Key', StartLine: index + 1, EndLine: index + 1,
      StartColumn: 3, EndColumn: 44, Match: `AppSecret = "${secret}${index}"`, Secret: `${secret}${index}`,
      File: `/repository/backend/shared_${index}_test.go`, SymlinkFile: '', Commit: '', Entropy: 3.55,
      Author: '', Email: '', Date: '', Message: '', Tags: [], Fingerprint: `/repository/backend/shared_${index}_test.go:generic-api-key:${index + 1}`,
    }));
    await writeFile(join(directory, 'gitleaks.json'), `${JSON.stringify(leaks, null, 1)}\n`);
    // Formato real do checkov 3.4: uma linha so, varios check_type, "passed": 5 ao lado de "failed" e valores numericos.
    const failed = Array.from({length: 12000}, (_, index) => ({
      check_id: 'CKV_DOCKER_5', bc_check_id: null, check_name: `Ensure update instructions are not use alone ${index}`,
      check_result: {result: 'FAILED', evaluated_keys: []}, code_block: [[1, 'FROM node:20\n'], [2, `ENV PASSWORD=${secret}${index}\n`]],
      file_path: '/Dockerfile', file_line_range: [1, 2], resource: '/Dockerfile.RUN', check_class: 'x', fixed_definition: null,
      guideline: 'https://docs.prismacloud.io/', details: [], check_len: null,
    }));
    const document = [
      {check_type: 'dockerfile', results: {failed_checks: failed}, summary: {passed: 5, failed: 12000, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: '3.4.5'}},
      {check_type: 'gitlab_ci', results: {failed_checks: []}, summary: {passed: 0, failed: 0, skipped: 0, parsing_errors: 0, resource_count: 0, checkov_version: '3.4.5'}},
    ];
    const raw = JSON.stringify(document);
    assert.ok(raw.length > 3 * 1024 * 1024);
    await writeFile(join(directory, 'results_json.json'), raw);
    for (const name of ['gitleaks', 'checkov']) await writeFile(join(directory, `${name}.code`), '0\n');
    await writeFile(join(directory, 'status.json'), '{}\n');
    const result = await collectToolFindings(directory);
    for (const name of ['gitleaks', 'checkov']) {
      const tool = result.tools.find(item => item.name === name);
      assert.notEqual(tool?.state, 'truncada', `${name}: ${tool?.reason}`);
      assert.equal(tool?.formatValid, true, name);
    }
    assert.equal(result.tools.find(item => item.name === 'gitleaks')?.findings, 40);
    for (const name of ['gitleaks.json', 'results_json.json']) {
      const stored = await readFile(join(directory, name), 'utf8');
      assert.equal(stored.includes(secret), false, name);
      assert.doesNotThrow(() => JSON.parse(stored), name);
    }
    const kept = JSON.parse(await readFile(join(directory, 'results_json.json'), 'utf8')) as typeof document;
    assert.equal(kept[0]!.summary.passed, 5);
    assert.equal(kept[0]!.summary.failed, 12000);
    assert.equal(kept[0]!.results.failed_checks.length, 12000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('JSON de verdade cortado continua truncado, e sem o segredo no arquivo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  try {
    await writeFile(join(directory, 'gitleaks.json'), `[{"RuleID":"aws","Secret":"${secret}","File":"a.ts"},{"RuleID":"aws","Sec`);
    await writeFile(join(directory, 'gitleaks.code'), '0\n');
    await writeFile(join(directory, 'status.json'), '{}\n');
    const result = await collectToolFindings(directory);
    const tool = result.tools.find(item => item.name === 'gitleaks');
    assert.equal(tool?.state, 'truncada');
    assert.equal((await readFile(join(directory, 'gitleaks.json'), 'utf8')).includes(secret), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
