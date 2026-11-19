import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {startObserverHttpLink} from '../deploy/modules/desempenho/http-link.mjs';
import {reconcilePerformanceResources, runPerformanceModule} from '../deploy/modules/desempenho/orchestrator.mjs';

const runProcess = promisify(execFile);
const orchestrator = new URL('../deploy/modules/desempenho/orchestrator.mjs', import.meta.url).href;
const containerId = name => createHash('sha256').update(name).digest('hex');
const measurement = httpMode => ({httpMode, versions: {'lighthouse-ci': '0.16.1', k6: '2.4.0', pg_stat_statements: '16'},
  k6Routes: [], lighthouse: [], sqlQueries: []});
const digest = (await readFile(new URL('../deploy/modules/desempenho/digest.txt', import.meta.url), 'utf8')).trim();

async function setup(t, mode = 'normal') {
  const temp = await mkdtemp(join(tmpdir(), 'ac-module-snapshot-'));
  const repo = join(temp, 'repo');
  const bin = join(temp, 'bin');
  const log = join(temp, 'calls');
  const recoveryDirectory = join(temp, 'recovery');
  const dockerBinary = join(bin, 'docker');
  t.after(() => rm(temp, {recursive: true, force: true}));
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(log, '');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({
    server: {entry: 'server.mjs'}, routes: [{path: '/', file: 'server.mjs'}],
  }));
  await writeFile(join(repo, 'server.mjs'), '// servidor sintético');
  await writeFile(dockerBinary, String.raw`#!/usr/bin/node
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const log = ${JSON.stringify(log)}, base = ${JSON.stringify(temp)};
const mode = ${JSON.stringify(mode)}, digest = ${JSON.stringify(digest)};
const args = process.argv.slice(2), [cmd, op] = args;
const last = args.at(-1), fail = message => { console.error(message); process.exit(1); };
const read = name => JSON.parse(fs.readFileSync(path.join(base, name + '.object'), 'utf8'));
const write = (name, record) => fs.writeFileSync(path.join(base, name + '.object'), JSON.stringify(record));
const idFor = name => createHash('sha256').update(name).digest('hex');
const nameFor = id => fs.readdirSync(base).filter(file => file.endsWith('.object'))
  .map(file => file.slice(0, -7)).find(name => id === name || id === idFor(name));
fs.appendFileSync(log, JSON.stringify(args) + '\n');
if (cmd === 'image') {
  console.log(digest + (mode === 'old' ? ' 4' : ' 5'));
} else if (cmd === 'create' || (cmd === 'volume' && op === 'create')) {
  const volume = cmd === 'volume', name = volume ? last : args[args.indexOf('--name') + 1];
  const mount = args.find(item => item.startsWith('type=bind,src='));
  if (mount) {
    const src = mount.split(',')[1].slice(4);
    if ((fs.statSync(path.join(src, 'server.mjs')).mode & 0o777) !== 0o444) fail('cópia gravável');
    for (const omitted of ['.env', '.git', 'link']) if (fs.existsSync(path.join(src, omitted))) fail('copiou entrada omitida');
  }
  const record = {status: 'stopped', owner: args[args.indexOf('--label') + 1]?.split('=')[1],
    mode: args.includes('PERF_HTTP_MODE=static') ? 'static' : 'isolated'};
  if (!record.owner) fail('sem etiqueta de propriedade');
  const late = ['late-volume', 'late-timeout'].includes(mode) ? volume
    : mode === 'late-create' && !volume && !name.endsWith('-static');
  if (late) {
    fs.writeFileSync(path.join(base, name + '.later'), JSON.stringify(record));
    if (mode !== 'late-timeout') fail('cliente terminou sem confirmar a criação');
    setTimeout(() => fail('cliente terminou sem confirmar a criação'), 1300);
  } else {
    if ((mode === 'volume-failure' && volume) || (mode === 'backend-create-failure' && !volume && !name.endsWith('-static'))) {
      fail('Error response from daemon: preparação simulada indisponível');
    }
    write(name, record);
    if (!volume && mode === 'cancel-create') setTimeout(() => console.log(idFor(name)), 350);
    else console.log(volume ? name : idFor(name));
  }
} else if (cmd === 'start') {
  const name = nameFor(last);
  if (!name || name === last) fail('contêiner precisa ser acionado por ID');
  const record = read(name);
  if (op !== '--attach') {
    if (mode === 'target-exits') process.exit(0);
    if (mode === 'target-start-error') fail('falha de partida');
    write(name, {...record, status: 'running'});
  } else if (mode === 'cancel') {
    write(name, {...record, status: 'running'});
    setInterval(() => {}, 1000);
  } else if (mode === 'invalid') {
    console.log('saída inválida');
  } else {
    if (mode === 'late-target-exit' && record.mode === 'isolated') {
      const target = name.slice(0, -4);
      write(target, {...read(target), status: 'stopped'});
    }
    const measurement = (${measurement.toString()})(record.mode);
    if (mode === 'historical') measurement.k6Routes.push({route: '/api/ping', file: 'server.mjs', p95: 85,
      source: {kind: 'declaration', file: 'desempenho.config.json', line: 1}});
    const coverage = record.mode === 'static' ? [{tool: 'k6', version: '2.4.0', status: 'ok', detail: '3 requisições estáticas sintéticas'}] : [];
    console.log(JSON.stringify({coverage, findings: [], measurement}));
  }
} else if (op === 'rm') {
  const name = nameFor(last);
  if (mode === 'unconfirmed') fail('daemon indisponível');
  if (cmd === 'container' && name === last) fail('remoção do contêiner precisa usar o ID');
  if (!name) fail('ausente');
  const object = path.join(base, name + '.object');
  if (mode === 'retry' && !fs.existsSync(object + '.retry')) {
    fs.writeFileSync(object + '.retry', '');
    fail('falha transitória');
  }
  fs.rmSync(object);
} else if (op === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  const ownership = format.includes('performance.owner');
  const name = nameFor(last);
  if (!name) fail('Error: No such ' + cmd + ': ' + last);
  const record = read(name);
  if (ownership) console.log((cmd === 'container' ? idFor(name) : name) + ' ' + record.owner);
  else console.log((record.status === 'running') + ' ' + digest + ' 0');
} else fail('comando inesperado');
`, {mode: 0o755});
  const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    repo, calls, temp, recoveryDirectory, dockerBinary,
    pending: () => readdir(recoveryDirectory),
    reconcile(overrides = {}) {
      return reconcilePerformanceResources({recoveryDirectory, ...overrides}, {dockerBinary});
    },
    async materialize({foreign = false} = {}) {
      const names = (await readdir(temp)).filter(file => file.endsWith('.later'));
      assert.equal(names.length, 1);
      const name = names[0].slice(0, -6);
      const later = join(temp, names[0]);
      if (foreign) {
        const obj = JSON.parse(await readFile(later, 'utf8'));
        await writeFile(later, JSON.stringify({...obj, owner: 'outro-dono'}));
      }
      await rename(later, join(temp, name + '.object'));
      return name;
    },
    run(overrides = {}) {
      return runPerformanceModule({snapshotPath: repo, imageDigest: digest, timeoutMs: 20_000, recoveryDirectory, ...overrides}, {dockerBinary});
    },
    async verifyCleanup() {
      const history = await calls();
      const removals = history.filter(args => args[1] === 'rm');
      for (const args of history.filter(args => args[0] === 'create' || args[0] === 'volume' && args[1] === 'create')) {
        const kind = args[0] === 'create' ? 'container' : 'volume';
        const name = kind === 'container' ? args[args.indexOf('--name') + 1] : args.at(-1);
        const lastRemoval = history.findLastIndex(call => call[0] === kind && call[1] === 'rm' && call.at(-1) === (kind === 'container' ? containerId(name) : name));
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
  assert.equal(observer.at(-1), containerId(creates[1][creates[1].indexOf('--name') + 1]));
  assert.equal(target.at(-1), containerId(creates[0][creates[0].indexOf('--name') + 1]));
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

for (const mode of ['target-exits', 'late-target-exit', 'target-start-error', 'volume-failure', 'backend-create-failure']) {
  test(`backend indisponível (${mode}) dá lugar a observador estático sem canal compartilhado`, async t => {
    const fixture = await setup(t, mode);
    const output = await fixture.run();
    assert.equal(output.coverage.find(row => row.tool === 'isolamento-http')?.status, 'failed');
    assert.equal(output.coverage.find(row => row.tool === 'servidor-isolado')?.status, 'failed');
    assert.equal(output.coverage.find(row => row.tool === 'k6')?.detail, '3 requisições estáticas sintéticas');
    const observer = (await fixture.calls()).filter(args => args[0] === 'create').at(-1);
    assert.ok(observer.includes('PERF_HTTP_MODE=static'));
    assert.ok(!observer.some(arg => arg.includes('/perf-link')));
    if (mode.endsWith('failure')) {
      assert.equal(output.coverage.find(row => row.tool === 'limpeza-docker')?.status, 'failed');
      assert.equal((await fixture.reconcile()).pending, 1);
    } else await fixture.verifyCleanup();
  });
}

for (const mode of ['late-volume', 'late-create']) {
  test(`reconcilia ${mode} mesmo quando o daemon publica após as inspeções e a saída`, async t => {
    const fixture = await setup(t, mode);
    const output = await fixture.run();
    assert.equal(output.measurement.httpMode, 'static');
    assert.equal(output.coverage.find(row => row.tool === 'limpeza-docker')?.status, 'failed');
    assert.equal((await fixture.pending()).length, 1);
    assert.equal((await fixture.reconcile()).pending, 1);
    const name = await fixture.materialize();
    const kind = mode === 'late-volume' ? 'volume' : 'container';
    assert.ok((await fixture.calls()).filter(args => args[0] === kind && args[1] === 'inspect' && args.at(-1) === name).length >= 3);
    const outcomes = await Promise.all([fixture.reconcile(), fixture.reconcile()]);
    assert.equal(outcomes.reduce((count, outcome) => count + outcome.cleaned, 0), 1);
    assert.deepEqual(await fixture.pending(), []);
    assert.deepEqual(await fixture.reconcile(), {cleaned: 0, pending: 0, active: 0, invalid: 0});
    await fixture.verifyCleanup();
  });
}

test('prazo expirado preserva a intenção para um reconciliador em outro processo', async t => {
  const fixture = await setup(t, 'late-timeout');
  await assert.rejects(fixture.run({timeoutMs: 900}), {name: 'TimeoutError'});
  const before = await fixture.calls();
  assert.ok(!before.some(args => args[0] === 'start'));
  assert.equal(before.filter(args => args[0] === 'volume' && args[1] === 'inspect').length, 3);
  await fixture.materialize();
  const invocation = `import {reconcilePerformanceResources} from ${JSON.stringify(orchestrator)};
    const [recoveryDirectory, dockerBinary] = process.argv.slice(1);
    console.log(JSON.stringify(await reconcilePerformanceResources({recoveryDirectory}, {dockerBinary})));`;
  const {stdout} = await runProcess(process.execPath,
    ['--input-type=module', '-e', invocation, fixture.recoveryDirectory, fixture.dockerBinary]);
  assert.deepEqual(JSON.parse(stdout), {cleaned: 1, pending: 0, active: 0, invalid: 0});
  await fixture.verifyCleanup();
});

test('a reconciliação preserva volume homônimo com etiqueta divergente', async t => {
  const fixture = await setup(t, 'late-volume');
  await fixture.run();
  const foreign = await fixture.materialize({foreign: true});
  assert.equal((await fixture.reconcile()).pending, 1);
  assert.ok((await lstat(join(fixture.temp, foreign + '.object'))).isFile());
  assert.ok(!(await fixture.calls()).some(args => args[0] === 'volume' && args[1] === 'rm'));
});

test('a reconciliação preserva a execução ativa e respeita cancelamento', async t => {
  const fixture = await setup(t, 'cancel');
  const controller = new AbortController();
  const result = assert.rejects(fixture.run({signal: controller.signal}), /autoridade perdida/);
  void result.catch(() => {});
  try {
    for (let ticks = 0; ; ticks++) {
      assert.ok(ticks < 250, 'observador não iniciou');
      if ((await fixture.calls()).some(args => args[0] === 'start' && args[1] === '--attach')) break;
      await delay(20);
    }
    assert.deepEqual(await fixture.reconcile(), {cleaned: 0, pending: 0, active: 1, invalid: 0});
    assert.ok(!(await fixture.calls()).some(args => args[1] === 'rm'));
    await assert.rejects(fixture.reconcile({signal: AbortSignal.abort(new Error('reconciliação cancelada'))}), /reconciliação cancelada/);
  } finally {
    controller.abort(new Error('autoridade perdida'));
    await result;
  }
  assert.deepEqual(await fixture.pending(), []);
  await fixture.verifyCleanup();
});

test('a base pode passar e receber medição fora do snapshot pelo contrato do orquestrador', async t => {
  const fixture = await setup(t, 'historical');
  const first = await fixture.run();
  assert.ok(!first.findings.some(f => f.rule.includes('REGRESSAO')));
  const prior = {...first.measurement, k6Routes: first.measurement.k6Routes.map(route => ({...route, p95: 20}))};
  const second = await fixture.run({previousMeasurement: {examId: 'exame-1', measurement: prior}});
  assert.equal(second.findings[0]?.rule, 'DESEMPENHO-REGRESSAO-ROTA');
  assert.match(second.findings[0].evidence, /exame anterior=exame-1/);
  assert.equal(second.measurement.imageDigest, digest);
});

async function abortWhile(fixture, reached) {
  const controller = new AbortController();
  const result = assert.rejects(fixture.run({signal: controller.signal}), /autoridade perdida/);
  void result.catch(() => {});
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
    assert.equal((await fixture.reconcile()).pending, 1);
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
