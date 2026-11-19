import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {moduleCollectorArguments, parseModuleCollectorOutput, readPinnedModuleImage} from '../src/verification-modules.ts';

const fixture = fileURLToPath(new URL('./fixtures/module-qa-languages/', import.meta.url));
const languages = [
  {tool: 'python-unittest-coverage', testFile: 'test_arithmetic.py', source: 'arithmetic.py', error: ' - int(right > 1)'},
  {tool: 'go-test-cover', testFile: 'go/arithmetic_test.go', source: 'go/arithmetic.go', error: ' - 1'},
];

test('a imagem de QA executa e mede regressões de Python e Go nas três passadas', {
  skip: process.env.AC_MODULE_LAB !== '1', timeout: 360_000,
}, async () => {
  const image = await readPinnedModuleImage('qa');
  const working = await mkdtemp(join(tmpdir(), 'ac-qa-languages-'));
  const repo = join(working, 'repo');
  try {
    await chmod(working, 0o755);
    await cp(fixture, repo, {recursive: true});
    const [runtime, ...args] = moduleCollectorArguments({repository: repo, image});
    for (const corrected of [false, true]) {
      if (corrected) {
        for (const language of languages) {
          const path = join(repo, language.source);
          const source = await readFile(path, 'utf8');
          assert.ok(source.includes(language.error));
          await writeFile(path, source.replace(language.error, ''));
        }
      }
      const {stdout} = await promisify(execFile)(runtime!, args, {encoding: 'buffer', timeout: 175_000, maxBuffer: 8 * 1024 * 1024});
      const report = parseModuleCollectorOutput(stdout, {module: 'qa'});
      for (const {tool, testFile} of languages) {
        const passes = report.coverage.filter(row => row.tool === tool + '-execucao');
        assert.equal(passes.length, 3, tool);
        for (const pass of passes) {
          assert.equal(pass.status, 'ok', pass.detail);
          assert.match(pass.detail, corrected ? /2 aprovados, 0 reprovados/ : /1 aprovados, 1 reprovados/);
        }
        const coverage = report.coverage.find(row => row.tool === tool + '-cobertura');
        assert.equal(coverage?.status, 'ok', coverage?.detail);
        assert.match(coverage.detail, /statements \d+\/[1-9]\d*/);
        if (tool === 'python-unittest-coverage') assert.match(coverage.detail, /ramos \d+\/[1-9]\d*/);
        else assert.doesNotMatch(coverage.detail, /ramos/);
        const failures = report.findings.filter(item => item.tool === tool && item.rule === 'QA-TESTE-FALHOU');
        assert.deepEqual(failures.map(item => item.file), corrected ? [] : [testFile]);
        if (!corrected) assert.match(failures[0]!.evidence, /failed, failed, failed/);
      }
    }
  } finally {
    await rm(working, {recursive: true, force: true});
  }
});
