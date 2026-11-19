import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {startObserverHttpLink} from '../deploy/modules/desempenho/http-link.mjs';
import {runPerformanceModule} from '../deploy/modules/desempenho/orchestrator.mjs';

const digest = (await readFile(new URL('../deploy/modules/desempenho/digest.txt', import.meta.url), 'utf8')).trim();

async function setup(t, mode = 'normal') {
  const temp = await mkdtemp(join(tmpdir(), 'ac-module-snapshot-'));
  const repo = join(temp, 'repo');
  const bin = join(temp, 'bin');
  const log = join(temp, 'calls');
  t.after(() => rm(temp, {recursive: true, force: true}));
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(log, '');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({
    server: {entry: 'server.mjs'}, routes: [{path: '/', file: 'server.mjs'}],
  }));
  await writeFile(join(repo, 'server.mjs'), '// servidor sintético');
  await writeFile(join(bin, 'docker'), `#!/usr/bin/node
const fs = require('node:fs');
const path = require('node:path');
const log = ${JSON.stringify(log)}, base = ${JSON.stringify(temp)};
const mode = ${JSON.stringify(mode)}, digest = ${JSON.stringify(digest)};
const args = process.argv.slice(2), [cmd, op] = args;
const last = args.at(-1), object = path.join(base, last + '.object');
const fail = message => { console.error(message); process.exit(1); };
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (cmd === 'image') {
  console.log(digest + (mode === 'old' ? ' <no value>' : ' 4'));
} else if (cmd === 'create' || (cmd === 'volume' && op === 'create')) {
  const id = cmd === 'volume' ? last : args[args.indexOf('--name') + 1];
  const mount = args.find(item => item.startsWith('type=bind,src='));
  if (mount) {
    const src = mount.split(',')[1].slice(4);
    if ((fs.statSync(path.join(src, 'server.mjs')).mode & 0o777) !== 0o444) fail('cópia gravável');
    for (const omitted of ['.env', '.git', 'link']) if (fs.existsSync(path.join(src, omitted))) fail('copiou entrada omitida');
  }
  fs.writeFileSync(path.join(base, id + '.object'), 'stopped');
  if (cmd === 'create' && mode === 'cancel-create') setTimeout(() => console.log(id), 350);
  else console.log(id);
} else if (cmd === 'start') {
  if (op !== '--attach') {
    if (mode === 'target-exits') process.exit(0);
    fs.writeFileSync(object, 'running');
  } else if (mode === 'cancel') {
    fs.writeFileSync(object, 'running');
    setInterval(() => {}, 1000);
  } else if (mode === 'invalid') {
    console.log('saída inválida');
  } else {
    if (mode === 'late-target-exit' && !last.endsWith('-static')) {
      fs.writeFileSync(path.join(base, last.slice(0,-4) + '.object'), 'stopped');
    }
    console.log(JSON.stringify({coverage: [], findings: []}));
  }
} else if (op === 'rm') {
  if (mode === 'unconfirmed') fail('daemon indisponível');
  if (mode === 'retry' && !fs.existsSync(object + '.retry')) {
    fs.writeFileSync(object + '.retry', '');
    fail('falha transitória');
  }
  fs.rmSync(object, {force: true});
} else if (op === 'inspect') {
  if (mode === 'unconfirmed' && !args.includes('--format')) fail('daemon indisponível');
  if (!fs.existsSync(object)) fail('Error: No such ' + cmd + ': ' + last);
  if (args.includes('--format')) {
    console.log((fs.readFileSync(object, 'utf8') === 'running') + ' ' + digest + ' 0');
  } else {
    console.log('ainda presente');
  }
} else fail('comando inesperado');
`, {mode: 0o755});
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    repo, calls,
    run(overrides = {}) {
      return runPerformanceModule({snapshotPath: repo, imageDigest: digest, timeoutMs: 20_000, ...overrides},
        {dockerBinary: join(bin, 'docker')});
    },
    async verifyCleanup() {
      const history = await calls();
      const removals = history.filter(args => args[1] === 'rm');
      for (const args of history.filter(args => args[0] === 'create' || args[0] === 'volume' && args[1] === 'create')) {
        const kind = args[0] === 'create' ? 'container' : 'volume';
        const name = kind === 'container' ? args[args.indexOf('--name') + 1] : args.at(-1);
        const lastRemoval = history.findLastIndex(call => call[0] === kind && call[1] === 'rm' && call.at(-1) === name);
        assert.ok(lastRemoval >= 0);
        assert.ok(history.slice(lastRemoval + 1).some(call => call[0] === kind && call[1] === 'inspect' && call.at(-1) === name));
        await assert.rejects(lstat(join(temp, name + '.object')), {code: 'ENOENT'});
      }
      for (const args of history.filter(args => args[0] === 'create')) {
        const mount = args.find(arg => arg.startsWith('type=bind,src=')).split(',')[1].slice(4);
        await assert.rejects(lstat(mount), {code: 'ENOENT'});
      }
      return removals;
    },
  };
}

test('orquestra imagem fixada, cópia oficial imutável e namespaces separados sem sobrepor ferramentas', async t => {
  const fixture = await setup(t);
  await mkdir(join(fixture.repo, '.git'));
  await writeFile(join(fixture.repo, '.env'), 'valor sintético');
  await symlink('server.mjs', join(fixture.repo, 'link'));
  await assert.rejects(fixture.run({imageDigest: `sha256:${'f'.repeat(64)}`}), /digest/);
  await assert.rejects(fixture.run({snapshotPath: process.cwd()}), /snapshot oficial/);
  const output = await fixture.run();
  assert.match(output.coverage[0].detail, /3 entrada\(s\) excluída/);
  assert.equal(output.coverage[1].status, 'ok');
  const creates = (await fixture.calls()).filter(args => args[0] === 'create');
  assert.equal(creates.length, 2);
  for (const args of creates) {
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    for (const option of ['--read-only', '--user', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--tmpfs']) assert.ok(args.includes(option));
    assert.equal(args[args.indexOf('--log-driver') + 1], 'none');
    assert.ok(!args.includes('--pid'));
    assert.ok(!args.some(arg => /(?:docker\.sock|dst=\/opt|dst=\/usr\/local)/.test(arg)));
    assert.equal(args.filter(arg => arg.startsWith('type=bind,')).length, 1);
    assert.ok(args.some(arg => arg.startsWith('type=bind,') && arg.endsWith('dst=/repo,readonly')));
  }
  assert.ok(creates[0].some(arg => arg.endsWith('dst=/perf-link,volume-nocopy')));
  assert.ok(creates[1].some(arg => arg.endsWith('dst=/perf-link,volume-nocopy,readonly')));
  assert.ok(!creates[1].includes('--entrypoint'));
  const [observer, target, volume] = await fixture.verifyCleanup();
  assert.match(observer.at(-1), /-obs$/);
  assert.match(target.at(-1), /^ac-perf-[a-f0-9-]{36}$/);
  assert.equal(volume[0], 'volume');
});

test('imagem antiga é recusada antes de criar contêiner', async t => {
  const fixture = await setup(t, 'old');
  await assert.rejects(fixture.run(), /imagem .* incompatível/);
  assert.deepEqual((await fixture.calls()).map(args => args[0]), ['image']);
});

test('limite da cópia é aplicado antes de acessar Docker', async t => {
  const fixture = await setup(t);
  await writeFile(join(fixture.repo, 'grande'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(fixture.run(), /limite/);
  assert.deepEqual(await fixture.calls(), []);
});

for (const mode of ['target-exits', 'late-target-exit']) {
  test(`backend indisponível (${mode}) dá lugar a observador estático sem canal compartilhado`, async t => {
    const fixture = await setup(t, mode);
    const output = await fixture.run();
    assert.equal(output.coverage.find(row => row.tool === 'isolamento-http')?.status, 'skipped');
    const observer = (await fixture.calls()).filter(args => args[0] === 'create').at(-1);
    assert.ok(observer.includes('PERF_HTTP_MODE=static'));
    assert.ok(!observer.some(arg => arg.includes('/perf-link')));
    await fixture.verifyCleanup();
  });
}

async function abortWhile(fixture, reached) {
  const controller = new AbortController();
  const result = assert.rejects(fixture.run({signal: controller.signal}), /autoridade perdida/);
  try {
    for (let ticks = 0; ; ticks++) {
      assert.ok(ticks < 250, 'heartbeat não observou o início da coleta');
      const [last] = (await fixture.calls()).slice(-1);
      if (last && reached(last)) break;
      await delay(20);
    }
  } finally {
    controller.abort(new Error('autoridade perdida'));
    await result;
  }
  await fixture.verifyCleanup();
}

test('aguarda Docker sem bloquear o heartbeat e confirma a limpeza após perda de autoridade', async t => {
  const fixture = await setup(t, 'cancel');
  await abortWhile(fixture, args => args[0] === 'start' && args[1] === '--attach');
});

test('perda de autoridade durante docker create aguarda o daemon e nunca inicia o alvo', async t => {
  const fixture = await setup(t, 'cancel-create');
  await abortWhile(fixture, args => args[0] === 'create');
  assert.ok(!(await fixture.calls()).some(args => args[0] === 'start'));
});

test('saída malformada passa pela limpeza verificável', async t => {
  const fixture = await setup(t, 'invalid');
  await assert.rejects(fixture.run(), SyntaxError);
  await fixture.verifyCleanup();
});

test('repete remoção transitória e recusa saída quando o daemon não confirma ausência', async t => {
  await t.test('remoção transitória', async subtest => {
    const fixture = await setup(subtest, 'retry');
    await fixture.run();
    assert.equal((await fixture.verifyCleanup()).length, 6);
  });
  await t.test('ausência não confirmada', async subtest => {
    const fixture = await setup(subtest, 'unconfirmed');
    await assert.rejects(fixture.run(), /remoção Docker sem confirmação/);
    const removals = (await fixture.calls()).filter(args => args[1] === 'rm');
    assert.equal(removals.length, 9);
  });
});

test('canal HTTP local encaminha GET por socket validado e recusa link simbólico', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ac-perf-link-test-'));
  const socket = join(temp, 'http.sock');
  const target = createServer((req, res) => { res.end(`${req.method} ${req.url}`); });
  await new Promise(ok => target.listen(socket, ok));
  const observer = await startObserverHttpLink(socket);
  t.after(async () => {
    await observer.close();
    await new Promise(ok => target.close(ok));
    await rm(temp, {recursive: true, force: true});
  });
  const response = await fetch(observer.origin + '/teste', {signal: AbortSignal.timeout(1000)});
  assert.equal(await response.text(), 'GET /teste');
  await symlink(socket, join(temp, 'alias'));
  const refused = await startObserverHttpLink(join(temp, 'alias'));
  try { await assert.rejects(fetch(refused.origin, {signal: AbortSignal.timeout(1000)})); }
  finally { await refused.close(); }
});
