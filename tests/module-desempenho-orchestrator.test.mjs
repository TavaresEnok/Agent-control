import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {runIsolatedPerformanceHttp, snapshotRepository} from '../deploy/modules/desempenho/orchestrator.mjs';

const root = resolve('.');
const digest = readFileSync(new URL('../deploy/modules/desempenho/digest.txt', import.meta.url), 'utf8').trim();

test('snapshot não segue links, copia só arquivos regulares e falha no limite', () => {
  const temp = mkdtempSync(join(root, '.perf-test-'));
  try {
    const src = join(temp, 'src'), dst = join(temp, 'dst');
    mkdirSync(src); mkdirSync(join(src, '.git'));
    writeFileSync(join(src, 'server.mjs'), 'servidor sintético');
    writeFileSync(join(src, '.git', 'config'), 'privado');
    symlinkSync('/etc/passwd', join(src, 'link'));
    assert.deepEqual(snapshotRepository(src, dst), {files: 1, bytes: Buffer.byteLength('servidor sintético')});
    assert.equal(readFileSync(join(dst, 'server.mjs'), 'utf8'), 'servidor sintético');
    assert.throws(() => readFileSync(join(dst, 'link')));
    assert.throws(() => readFileSync(join(dst, '.git', 'config')));
    writeFileSync(join(src, '.env'), 'valor sintético');
    assert.throws(() => snapshotRepository(src, join(temp, 'dst-secret')), /potencialmente sensível/);
    rmSync(join(src, '.env'));
    writeFileSync(join(src, 'grande'), Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.throws(() => snapshotRepository(src, join(temp, 'dst2')), /limite/);
  } finally { rmSync(temp, {recursive: true, force: true}); }
});

test('orquestração usa imagem conferida, rede isolada, montagens separadas e limpa o alvo', () => {
  const temp = mkdtempSync(join(root, '.perf-test-'));
  const oldPath = process.env.PATH;
  try {
    const repo = join(temp, 'repo'), bin = join(temp, 'bin'), log = join(temp, 'chamadas');
    mkdirSync(repo); mkdirSync(bin);
    writeFileSync(join(repo, 'desempenho.config.json'), JSON.stringify({server: {entry: 'server.mjs'}, routes: [{path: '/', file: 'server.mjs'}]}));
    writeFileSync(join(repo, 'server.mjs'), '// sintético');
    const fake = `#!/usr/bin/node\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='image') console.log(${JSON.stringify(digest)});else if(a[0]==='inspect') console.log('true '+${JSON.stringify(digest)});else if(a[0]==='run' && a.includes('-d')) console.log('target');else if(a[0]==='run') console.log(JSON.stringify({coverage:[],findings:[]}));`;
    writeFileSync(join(bin, 'docker'), fake, {mode: 0o755});
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.throws(() => runIsolatedPerformanceHttp({repoPath: repo, imageDigest: `sha256:${'f'.repeat(64)}`}), /digest/);
    const out = runIsolatedPerformanceHttp({repoPath: repo, imageDigest: digest});
    assert.equal(out.coverage[0].tool, 'isolamento-http');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const runs = calls.filter(args => args[0] === 'run');
    assert.equal(runs.length, 2);
    assert.equal(runs[0][runs[0].indexOf('--network') + 1], 'none');
    assert.match(runs[1][runs[1].indexOf('--network') + 1], /^container:ac-perf-/);
    for (const args of runs) {
      for (const option of ['--read-only', '--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--tmpfs']) assert.ok(args.includes(option));
      assert.ok(!args.some(arg => /docker\.sock/.test(arg)));
    }
    assert.ok(runs[0].includes('none')); // logs do alvo não entram nos resultados
    assert.ok(!runs[0].some(arg => arg.includes('/opt/desempenho-tools/collector.mjs')));
    assert.ok(runs[1].some(arg => arg.includes('/opt/desempenho-tools/collector.mjs')));
    assert.equal(calls.at(-1)[0], 'rm');
  } finally {
    process.env.PATH = oldPath;
    rmSync(temp, {recursive: true, force: true});
  }
});

test('falha do observador remove ambos os contêineres sem consumir stdout do alvo', () => {
  const temp = mkdtempSync(join(root, '.perf-test-'));
  const oldPath = process.env.PATH;
  try {
    const repo = join(temp, 'repo'), bin = join(temp, 'bin'), log = join(temp, 'chamadas');
    mkdirSync(repo); mkdirSync(bin);
    writeFileSync(join(repo, 'desempenho.config.json'), JSON.stringify({server: {entry: 'server.mjs'}}));
    writeFileSync(join(repo, 'server.mjs'), '// sintético');
    const fake = `#!/usr/bin/node\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='image') console.log(${JSON.stringify(digest)});else if(a[0]==='run' && a.includes('-d')) console.log('stdout do alvo');else if(a[0]==='run') process.exit(3);`;
    writeFileSync(join(bin, 'docker'), fake, {mode: 0o755});
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    assert.throws(() => runIsolatedPerformanceHttp({repoPath: repo, imageDigest: digest}), /Docker falhou/);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const removals = calls.filter(args => args[0] === 'rm');
    assert.equal(removals.length, 2);
    assert.match(removals[0].at(-1), /-obs$/);
    assert.ok(!removals[1].at(-1).endsWith('-obs'));
  } finally {
    process.env.PATH = oldPath;
    rmSync(temp, {recursive: true, force: true});
  }
});
