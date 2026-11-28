import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

test('redacao de JSON: hash do achado, Match, numeros, chaves, __proto__, Author e tamanho', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-collect-'));
  const secret = 'Zq9xLm2PwR7tKv4BnY8c';
  const sha = createHash('sha256').update(secret, 'utf8').digest('hex');
  const github = `ghp_${'b'.repeat(24)}`;
  try {
    const row = {
      RuleID: 'generic-api-key', File: 'a.go', StartLine: 4, Secret: secret, Match: `apiKey := "${secret}"`,
      Author: 'Fulano de Tal', Email: '', Tags: ['keywords'], evaluated_keys: ['a'],
    };
    const raw = JSON.stringify([row, {RuleID: 'x', File: 'b.go', StartLine: 1, password: 12345678, [github]: 'valor', db: JSON.parse('{"__proto__": {"x": 1}, "y": 2}')}]);
    await writeFile(join(directory, 'gitleaks.json'), raw);
    await writeFile(join(directory, 'gitleaks.code'), '0\n');
    await writeFile(join(directory, 'status.json'), '{}\n');
    const result = await collectToolFindings(directory);
    // 1. o hash do achado e o do segredo, nao o da mascara.
    const first = result.findings.find(finding => finding.file?.endsWith("a.go"));
    assert.ok(first?.snippet.includes(`sha256:${sha}`), JSON.stringify(result.findings));
    const storedText = await readFile(join(directory, 'gitleaks.json'), 'utf8');
    // 2. Match nao guarda o segredo, mesmo com nome de variavel que o padrao de texto nao pega.
    assert.equal(storedText.includes(secret), false);
    const stored = JSON.parse(storedText) as Record<string, unknown>[];
    assert.match(String(stored[0]!.Match), /^apiKey := "Zq9x… \(sha256:[0-9a-f]{64}\)"$/);
    // 3. numero sob chave de segredo e chave que parece segredo.
    assert.notEqual(stored[1]!.password, 12345678);
    assert.equal(storedText.includes('12345678'), false);
    assert.equal(storedText.includes(github), false);
    // 4. __proto__ sobrevive.
    assert.deepEqual(Object.keys(stored[1]!.db as object), ['__proto__', 'y']);
    // 5. campos que nao sao segredo ficam como estao.
    assert.equal(stored[0]!.Author, 'Fulano de Tal');
    assert.deepEqual(stored[0]!.evaluated_keys, ['a']);
    assert.deepEqual(stored[0]!.Tags, ['keywords']);
    // 6. sem indentacao: uma linha so, mais o fim de linha.
    assert.equal(storedText.trim().includes('\n'), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('sem a base Java o trivy-fs segue válido e relata cobertura reduzida para Java', async () => {
  const entry = await readFile('deploy/verify-entrypoint.sh', 'utf8');
  assert.equal(entry.match(/record_tool trivy-fs /g)?.length, 1, 'uma só chamada do trivy fs');
  assert.match(entry, /if \[ ! -f \/databases\/trivy\/java-db\/trivy-java\.db \]; then\n  : > \/output\/trivy-fs\.sem-java-db\n  set -- --skip-files '\*\*\/\*\.jar'/);
  assert.match(entry, /--skip-java-db-update "\$@" \\/);
  const fetch = await readFile('deploy/verify-db-fetch.sh', 'utf8');
  assert.match(fetch, /if \[ "\$\{AC_VERIFY_JAVA_DB:-1\}" != 0 \]; then\n  trivy fs --cache-dir \/databases\/trivy --download-java-db-only/);
  for (const missing of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'verify-collect-java-'));
    try {
      await writeFile(join(directory, 'status.json'), '{}\n');
      await writeFile(join(directory, 'trivy-fs.code'), '0\n');
      await writeFile(join(directory, 'trivy-fs.json'), JSON.stringify({SchemaVersion: 2, Results: []}));
      if (missing) await writeFile(join(directory, 'trivy-fs.sem-java-db'), '');
      const result = await collectToolFindings(directory);
      const trivy = result.tools.find(tool => tool.name === 'trivy-fs');
      assert.equal(trivy?.state, 'limpa');
      if (missing) assert.match(trivy?.reason ?? '', /cobertura reduzida para Java/);
      else assert.equal(trivy?.reason, null);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
});
