import assert from 'node:assert/strict';
import {ChildProcess, execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {lstat, mkdtemp, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {startHostHttpLink, startObserverHttpLink, startTargetHttpLink, watchHttpLink} from '../deploy/modules/desempenho/http-link.mjs';
import {reconcilePerformanceResources, runPerformanceModule} from '../deploy/modules/desempenho/orchestrator.mjs';

const runProcess = promisify(execFile);
const orchestrator = new URL('../deploy/modules/desempenho/orchestrator.mjs', import.meta.url).href;
const containerId = name => createHash('sha256').update(name).digest('hex');
const measurement = httpMode => ({httpMode, versions: {'lighthouse-ci': '0.16.1', k6: '2.4.0', pg_stat_statements: '16'},
  k6Routes: [], lighthouse: [], sqlQueries: []});
const digest = (await readFile(new URL('../deploy/modules/desempenho/digest.txt', import.meta.url), 'utf8')).trim();

async function setup(t, mode = 'normal', registryName = 'recovery') {
  const temp = await mkdtemp(join(tmpdir(), 'ac-module-snapshot-'));
  const repo = join(temp, 'repo');
  const bin = join(temp, 'bin');
  const log = join(temp, 'calls');
  const recoveryDirectory = join(temp, registryName);
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
const objectId = name => read(name).id ?? idFor(name);
const nameFor = id => fs.readdirSync(base).filter(file => file.endsWith('.object'))
  .map(file => file.slice(0, -7)).find(name => id === name || id === objectId(name));
fs.appendFileSync(log, JSON.stringify(args) + '\n');
if (cmd === 'image') {
  console.log(digest + (mode === 'old' ? ' 5' : ' 6'));
} else if (cmd === 'create') {
  const name = args[args.indexOf('--name') + 1];
  const record = {id: idFor(name), status: 'stopped', owner: args[args.indexOf('--label') + 1]?.split('=')[1],
    mode: args.includes('PERF_HTTP_MODE=static') ? 'static' : 'isolated'};
  if (!record.owner) fail('sem etiqueta de propriedade');
  const src = args.find(item => item.startsWith('type=bind,src=')).split(',')[1].slice(4);
  if ((fs.statSync(path.join(src, 'server.mjs')).mode & 0o777) !== 0o444) fail('cópia gravável');
  for (const omitted of ['.env', '.git', 'link']) if (fs.existsSync(path.join(src, omitted))) fail('copiou entrada omitida');
  const mount = args.find(item => item.startsWith('type=bind,"src='));
  if (record.mode === 'isolated') {
    const socket = mount?.match(/"src=(.*)",dst=\/perf-link\/(?:target|http)\.sock,readonly$/)?.[1];
    if (!socket || !fs.statSync(socket).isSocket()) fail('socket local ausente no bind');
  } else if (mount) fail('observador estático com socket');
  const late = mode === 'late-timeout' && record.mode === 'static' ||
    ['late-create', 'client-eagain'].includes(mode) && record.mode === 'isolated';
  if (late) {
    fs.writeFileSync(path.join(base, name + '.later'), JSON.stringify(record));
    if (mode === 'client-eagain') fail('spawn worker EAGAIN');
    if (mode !== 'late-timeout') fail('Error response from daemon: context canceled');
    setInterval(() => {}, 1000);
  } else if (mode.startsWith('cancel-output-')) {
    const id = record.id;
    if (mode === 'cancel-output-late' || mode === 'cancel-output-partial') {
      fs.writeFileSync(path.join(base, name + '.later'), JSON.stringify(record));
    } else {
      const owner = mode === 'cancel-output-foreign' ? 'outro-dono' : record.owner;
      write('renomeado', {...record, owner});
      write(name, {...record, id: idFor('substituto')});
    }
    console.log(mode === 'cancel-output-partial' ? id.slice(0, -1) : id);
    setInterval(() => {}, 1000);
  } else {
    if (mode === 'backend-create-failure' && record.mode === 'isolated') {
      fail('Error response from daemon: No such image: imagem-sintetica');
    }
    write(name, record);
    if (mode === 'cancel-create') setInterval(() => {}, 1000);
    else console.log(idFor(name));
  }
} else if (cmd === 'start') {
  const name = nameFor(last);
  if (!name || name === last) fail('contêiner precisa ser acionado por ID');
  const record = read(name);
  if (op !== '--attach') {
    if (mode === 'target-exits') process.exit(0);
    if (mode === 'target-start-error') fail('falha de partida');
    write(name, {...record, status: 'running'});
    if (mode === 'slow-recovery') setInterval(() => {}, 1000);
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
    const emit = () => console.log(JSON.stringify({coverage, findings: [], measurement}));
    if (mode === 'slow-recovery') setTimeout(emit, 270);
    else emit();
  }
} else if (op === 'rm') {
  const name = nameFor(last);
  if (mode === 'unconfirmed' && !fs.existsSync(path.join(base, 'recover'))) fail('daemon indisponível');
  if (cmd === 'container' && name === last) fail('remoção do contêiner precisa usar o ID');
  if (!name) fail('ausente');
  const object = path.join(base, name + '.object');
  if (mode === 'slow-recovery' && !name.endsWith('-static') && !fs.existsSync(path.join(base, 'recover'))) {
    setInterval(() => {}, 1000);
  } else if (mode === 'retry' && !fs.existsSync(object + '.retry')) {
    fs.writeFileSync(object + '.retry', '');
    fail('falha transitória');
  } else fs.rmSync(object);
} else if (op === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  const ownership = format.includes('performance.owner');
  const name = nameFor(last);
  if (!name) fail('Error: No such ' + cmd + ': ' + last);
  const record = read(name);
  if (ownership) {
    const id = mode === 'cancel-output-id-divergent' ? idFor('id-divergente') : objectId(name);
    if (mode === 'cancel-inspect-output' && last === name) {
      fs.renameSync(path.join(base, name + '.object'), path.join(base, 'renomeado.object'));
      write(name, {...record, id: idFor('substituto')});
      console.log(id + ' ' + record.owner);
      setInterval(() => {}, 1000);
      return;
    }
    console.log(id + ' ' + record.owner);
  }
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
      for (const args of history.filter(args => args[0] === 'create')) {
        const name = args[args.indexOf('--name') + 1];
        const id = containerId(name);
        const lastRemoval = history.findLastIndex(call => call[0] === 'container' && call[1] === 'rm' && call.at(-1) === id);
        assert.ok(lastRemoval >= 0);
        assert.ok(history.slice(lastRemoval + 1).some(call => call[0] === 'container' && call[1] === 'inspect' && call.at(-1) === id));
        await assert.rejects(lstat(join(temp, name + '.object')), {code: 'ENOENT'});
      }
      for (const args of history.filter(args => args[0] === 'create')) {
        const mount = args.find(arg => arg.startsWith('type=bind,src=')).split(',')[1].slice(4);
        await assert.rejects(lstat(mount), {code: 'ENOENT'});
      }
      assert.ok(!history.some(call => call[0] === 'volume'));
      return removals;
    },
  };
}

test('orquestra imagem fixada, cópia oficial imutável e namespaces separados sem sobrepor ferramentas', async t => {
  const fixture = await setup(t, 'normal', 'recovery'.repeat(9));
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
    assert.equal(args.filter(arg => arg.startsWith('type=bind,')).length, 2);
    assert.ok(args.some(arg => arg.startsWith('type=bind,') && arg.endsWith('dst=/repo,readonly')));
  }
  assert.ok(creates[0].some(arg => arg.endsWith('target.sock",dst=/perf-link/target.sock,readonly')));
  assert.ok(creates[1].some(arg => arg.endsWith('observer.sock",dst=/perf-link/http.sock,readonly')));
  assert.ok(!creates[1].includes('--entrypoint'));
  const socketPaths = creates.map(args => args.find(arg => arg.startsWith('type=bind,"src=')).split('"')[1].slice(4));
  for (const socket of socketPaths) {
    assert.ok(Buffer.byteLength(socket) > 108);
    await assert.rejects(lstat(socket), {code: 'ENOENT'});
  }
  const [observer, target] = await fixture.verifyCleanup();
  assert.equal(observer.at(-1), containerId(creates[1][creates[1].indexOf('--name') + 1]));
  assert.equal(target.at(-1), containerId(creates[0][creates[0].indexOf('--name') + 1]));
  assert.deepEqual(await fixture.pending(), []);
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

for (const mode of ['target-exits', 'late-target-exit', 'target-start-error', 'backend-create-failure']) {
  test(`backend indisponível (${mode}) dá lugar a observador estático sem canal compartilhado`, async t => {
    const fixture = await setup(t, mode);
    const output = await fixture.run();
    assert.equal(output.coverage.find(row => row.tool === 'isolamento-http')?.status, 'failed');
    assert.equal(output.coverage.find(row => row.tool === 'servidor-isolado')?.status, 'failed');
    assert.equal(output.coverage.find(row => row.tool === 'k6')?.detail, '3 requisições estáticas sintéticas');
    const observer = (await fixture.calls()).filter(args => args[0] === 'create').at(-1);
    assert.ok(observer.includes('PERF_HTTP_MODE=static'));
    assert.ok(!observer.some(arg => arg.includes('/perf-link')));
    assert.ok(!output.coverage.some(row => row.tool === 'limpeza-docker'));
    assert.deepEqual(await fixture.pending(), []);
    if (mode === 'backend-create-failure') {
      const calls = await fixture.calls();
      const target = calls.find(args => args[0] === 'create')[2];
      assert.ok(!calls.some(args => ['inspect', 'rm'].includes(args[1]) && [target, containerId(target)].includes(args.at(-1))));
    } else await fixture.verifyCleanup();
  });
}

test('reconcilia criação incerta publicada após a saída sem reter a medição estática', async t => {
  const fixture = await setup(t, 'late-create');
  const output = await fixture.run();
  assert.equal(output.measurement.httpMode, 'static');
  assert.equal(output.coverage.find(row => row.tool === 'limpeza-docker')?.status, 'failed');
  assert.equal((await fixture.pending()).length, 1);
  assert.equal((await fixture.reconcile()).pending, 1);
  const name = await fixture.materialize();
  assert.ok((await fixture.calls()).some(args => args[0] === 'container' && args[1] === 'inspect' && args.at(-1) === name));
  const outcomes = await Promise.all([fixture.reconcile(), fixture.reconcile()]);
  assert.equal(outcomes.reduce((count, outcome) => count + outcome.cleaned, 0), 1);
  assert.deepEqual(await fixture.pending(), []);
  assert.deepEqual(await fixture.reconcile(), {cleaned: 0, pending: 0, active: 0, invalid: 0});
  await fixture.verifyCleanup();
});

test('EAGAIN sem processo libera a reserva e permite a medição estática', async t => {
  const fixture = await setup(t);
  const spawn = ChildProcess.prototype.spawn;
  let refused;
  t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    if (options.file !== fixture.dockerBinary || options.args[1] !== 'create' || refused) {
      return spawn.call(this, options);
    }
    refused = options.args[3];
    assert.equal(this.pid, undefined);
    const error = Object.assign(new Error('spawn EAGAIN'), {code: 'EAGAIN', syscall: `spawn ${options.file}`});
    process.nextTick(() => this.emit('error', error));
  });
  const output = await fixture.run();
  assert.match(refused, /^ac-perf-/);
  assert.equal(output.measurement.httpMode, 'static');
  assert.ok(!output.coverage.some(row => row.tool === 'limpeza-docker'));
  const calls = await fixture.calls();
  assert.deepEqual(calls.filter(args => args[0] === 'create').map(args => args[2]), [`${refused}-obs-static`]);
  assert.ok(!calls.some(args => [refused, containerId(refused)].includes(args.at(-1))));
  assert.deepEqual(await fixture.pending(), []);
  await fixture.verifyCleanup();
});

test('EAGAIN relatado por cliente já iniciado conserva a criação incerta', async t => {
  const fixture = await setup(t, 'client-eagain');
  const output = await fixture.run();
  assert.equal(output.measurement.httpMode, 'static');
  assert.equal(output.coverage.find(row => row.tool === 'limpeza-docker')?.status, 'failed');
  const [name] = await fixture.pending();
  const state = JSON.parse(await readFile(join(fixture.recoveryDirectory, name, 'state.json'), 'utf8'));
  assert.deepEqual(state.resources, {[name]: false});
  assert.equal((await fixture.reconcile()).pending, 1);
  await fixture.materialize();
  assert.equal((await fixture.reconcile()).cleaned, 1);
  await fixture.verifyCleanup();
});

async function interceptSync(t, fixture, beforeSync) {
  const handle = await open(fixture.temp, 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = prototype.sync;
  t.mock.method(prototype, 'sync', async function () {
    const path = await readlink(`/proc/self/fd/${this.fd}`);
    if (path.startsWith(fixture.recoveryDirectory)) await beforeSync(path);
    return sync.call(this);
  });
}

for (const stage of ['antes do rename', 'depois do rename']) {
  test(`falha na reserva ${stage} desvincula apenas a criação não enviada`, async t => {
    const fixture = await setup(t, 'unconfirmed');
    const controller = new AbortController();
    let failed;
    await interceptSync(t, fixture, async path => {
      if (failed || !path.startsWith(join(fixture.recoveryDirectory, 'ac-perf-'))) return;
      const beforeRename = stage === 'antes do rename';
      if (beforeRename ? !path.endsWith('/state.next') : path.endsWith('/state.next')) return;
      const statePath = beforeRename ? path : join(path, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      failed = Object.keys(state.resources).find(name => name.endsWith('-obs') && state.resources[name] === null);
      if (failed) {
        controller.abort(new Error('autoridade perdida após a falha de gravação'));
        throw new Error('falha sintética de fsync na reserva');
      }
    });
    await assert.rejects(fixture.run({signal: controller.signal}), /autoridade perdida após a falha de gravação/);
    const [name] = await fixture.pending();
    assert.equal(failed, `${name}-obs`);
    const state = JSON.parse(await readFile(join(fixture.recoveryDirectory, name, 'state.json'), 'utf8'));
    assert.deepEqual(state.resources, {[name]: containerId(name)});
    const calls = await fixture.calls();
    assert.deepEqual(calls.filter(args => args[0] === 'create').map(args => args[2]), [name]);
    assert.ok(!calls.some(args => [failed, containerId(failed)].includes(args.at(-1))));
    await writeFile(join(fixture.temp, 'recover'), '');
    assert.deepEqual(await fixture.reconcile(), {cleaned: 1, pending: 0, active: 0, invalid: 0});
    await fixture.verifyCleanup();
  });
}

test('falha de fsync após publicar o diretório do diário desfaz a criação do registro', async t => {
  const fixture = await setup(t);
  await mkdir(fixture.recoveryDirectory, {mode: 0o700});
  let failed = false;
  await interceptSync(t, fixture, async path => {
    if (failed || path !== fixture.recoveryDirectory) return;
    const [name] = await fixture.pending();
    assert.match(name, /^ac-perf-/);
    const state = JSON.parse(await readFile(join(path, name, 'state.json'), 'utf8'));
    assert.deepEqual(state.resources, {});
    failed = true;
    throw new Error('falha sintética de fsync na publicação');
  });
  await assert.rejects(fixture.run(), /falha sintética de fsync na publicação/);
  assert.ok(failed);
  assert.deepEqual(await fixture.pending(), []);
  assert.deepEqual((await fixture.calls()).map(args => args[0]), ['image']);
});

async function reconcileInAnotherProcess(fixture) {
  const invocation = `import {reconcilePerformanceResources} from ${JSON.stringify(orchestrator)};
    const [recoveryDirectory, dockerBinary] = process.argv.slice(1);
    console.log(JSON.stringify(await reconcilePerformanceResources({recoveryDirectory}, {dockerBinary})));`;
  const {stdout} = await runProcess(process.execPath,
    ['--input-type=module', '-e', invocation, fixture.recoveryDirectory, fixture.dockerBinary]);
  return JSON.parse(stdout);
}

test('prazo expirado preserva a intenção para um reconciliador em outro processo', async t => {
  const fixture = await setup(t, 'late-timeout');
  await writeFile(join(fixture.repo, 'desempenho.config.json'), '{}');
  await assert.rejects(fixture.run({timeoutMs: 1800}), {name: 'TimeoutError'});
  const before = await fixture.calls();
  assert.ok(!before.some(args => args[0] === 'start'));
  assert.ok(!before.some(args => args[0] === 'container' && args[1] === 'inspect'));
  await fixture.materialize();
  assert.deepEqual(await reconcileInAnotherProcess(fixture), {cleaned: 1, pending: 0, active: 0, invalid: 0});
  await fixture.verifyCleanup();
});

test('reconcilia contêiner legado e preserva a intenção e os volumes legados por nome', async t => {
  const fixture = await setup(t);
  await mkdir(fixture.recoveryDirectory, {mode: 0o700});
  for (const legacyConfirmed of [true, false]) {
    const name = 'ac-perf-' + randomUUID();
    const volumeName = name + '-link';
    const owner = randomUUID();
    const directory = join(fixture.recoveryDirectory, name);
    const volume = join(fixture.temp, volumeName + '.object');
    const statePath = join(directory, 'state.json');
    await mkdir(directory, {mode: 0o700});
    await writeFile(statePath, JSON.stringify({owner, resources: {[volumeName]: legacyConfirmed, [name]: true}}));
    await writeFile(join(fixture.temp, name + '.object'), JSON.stringify({owner}));
    if (legacyConfirmed) await writeFile(volume, JSON.stringify({owner}));
    assert.equal((await fixture.reconcile()).pending, legacyConfirmed ? 1 : 2);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), {owner, resources: {[volumeName]: legacyConfirmed}});
    await assert.rejects(lstat(join(fixture.temp, name + '.object')), {code: 'ENOENT'});
    await writeFile(volume, JSON.stringify({owner: 'outro-dono'}));
    assert.equal((await fixture.reconcile()).pending, legacyConfirmed ? 1 : 2);
    assert.deepEqual(JSON.parse(await readFile(volume, 'utf8')), {owner: 'outro-dono'});
  }
  assert.ok(!(await fixture.calls()).some(args => args[0] === 'volume'));
});

test('preserva o orçamento estático quando a partida e a remoção do backend demoram', async t => {
  const fixture = await setup(t, 'slow-recovery');
  const output = await fixture.run({timeoutMs: 2000});
  assert.equal(output.measurement.httpMode, 'static');
  assert.match(output.coverage.find(row => row.tool === 'isolamento-http')?.detail, /prazo.*isolada/);
  assert.equal(output.coverage.find(row => row.tool === 'k6')?.status, 'ok');
  assert.equal(output.coverage.find(row => row.tool === 'limpeza-docker')?.status, 'failed');
  const calls = await fixture.calls();
  const staticStart = calls.findIndex(args => args[0] === 'start' && args[1] === '--attach');
  const firstRemoval = calls.findIndex(args => args[1] === 'rm');
  assert.ok(staticStart >= 0 && staticStart < firstRemoval);
  assert.equal((await fixture.pending()).length, 1);
  await writeFile(join(fixture.temp, 'recover'), '');
  assert.equal((await fixture.reconcile()).cleaned, 1);
  await fixture.verifyCleanup();
});

test('criação incerta conserva a intenção se o nome aparecer com outra etiqueta', async t => {
  const fixture = await setup(t, 'late-create');
  await fixture.run();
  const foreign = await fixture.materialize({foreign: true});
  assert.equal((await fixture.reconcile()).pending, 1);
  assert.ok((await lstat(join(fixture.temp, foreign + '.object'))).isFile());
  assert.ok(!(await fixture.calls()).some(args => args[1] === 'rm' && args.at(-1) === containerId(foreign)));
});

test('reconcilia o ID confirmado após renomeação e preserva o novo ocupante do nome', async t => {
  const fixture = await setup(t, 'unconfirmed');
  await assert.rejects(fixture.run(), /remoção Docker sem confirmação/);
  const [name] = await fixture.pending();
  const state = JSON.parse(await readFile(join(fixture.recoveryDirectory, name, 'state.json'), 'utf8'));
  assert.equal(state.resources[name], containerId(name));
  const original = join(fixture.temp, name + '.object');
  const renamed = join(fixture.temp, 'renomeado.object');
  await rename(original, renamed);
  const other = {owner: 'outro-dono', id: containerId('outro-id')};
  await writeFile(original, JSON.stringify(other));
  await writeFile(join(fixture.temp, 'recover'), '');
  assert.equal((await fixture.reconcile()).cleaned, 1);
  await assert.rejects(lstat(renamed), {code: 'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')), other);
  assert.deepEqual(await fixture.pending(), []);
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
  assert.equal(second.comparedExamId, 'exame-1');
  const disjoint = {examId: 'exame-2', measurement: {...prior,
    k6Routes: prior.k6Routes.map(route => ({...route, route: '/outra-rota'})), lighthouse: [], sqlQueries: []}};
  async function* history() {
    yield disjoint;
    yield {examId: 'exame-1', measurement: prior};
    assert.fail('a comparação já encontrou o exame compatível');
  }
  const third = await fixture.run({previousMeasurements: history()});
  assert.equal(third.comparedExamId, 'exame-1');
  assert.equal(third.findings[0]?.rule, 'DESEMPENHO-REGRESSAO-ROTA');
  assert.match(third.findings[0].evidence, /exame anterior=exame-1/);
  let reads = 0;
  const exhausted = await fixture.run({previousMeasurements: {
    [Symbol.asyncIterator]() { return this; },
    async next() { return ++reads === 1 ? {done: false, value: disjoint} : {done: true}; },
    async return() { assert.fail('return() chamado após esgotar o histórico'); },
  }});
  assert.equal(reads, 2);
  assert.equal(exhausted.comparedExamId, undefined);
  assert.ok(!exhausted.findings.some(row => row.rule.includes('REGRESSAO')));
});

test('cancelar durante uma página pendente libera os recursos de desempenho', {timeout: 10000}, async t => {
  const fixture = await setup(t, 'historical');
  const controller = new AbortController();
  const reached = Promise.withResolvers(), release = Promise.withResolvers();
  let historySignal;
  try {
    const pending = fixture.run({signal: controller.signal, previousMeasurements: async function* (signal) {
      historySignal = signal;
      reached.resolve();
      await release.promise;
    }});
    const rejected = assert.rejects(pending, /cancelamento do histórico/);
    await reached.promise;
    controller.abort(new Error('cancelamento do histórico'));
    await rejected;
    assert.equal(historySignal.aborted, true);
    assert.deepEqual(await fixture.pending(), []);
  } finally { release.resolve(); }
});

test('o prazo interrompe a espera pelo fechamento do histórico após uma comparação', {timeout: 10000}, async t => {
  const fixture = await setup(t, 'historical');
  const prior = {examId: 'exame-1', measurement: {...measurement('isolated'), imageDigest: digest,
    k6Routes: [{route: '/api/ping', file: 'server.mjs', p95: 20,
      source: {kind: 'declaration', file: 'desempenho.config.json', line: 1}}]}};
  const close = Promise.withResolvers();
  const watchdog = new AbortController();
  let returns = 0;
  const rejected = assert.rejects(fixture.run({timeoutMs: 3000, previousMeasurements: {
    [Symbol.asyncIterator]() { return this; },
    async next() { return {done: false, value: prior}; },
    return() {
      returns++;
      return close.promise;
    },
  }}), {name: 'TimeoutError'});
  try {
    await Promise.race([
      rejected,
      delay(6000, undefined, {signal: watchdog.signal}).then(() => assert.fail('o orquestrador continuou aguardando return()')),
    ]);
    assert.equal(returns, 1);
    close.reject(new Error('fechamento tardio da fonte sintética'));
    assert.deepEqual(await fixture.reconcile(), {cleaned: 1, pending: 0, active: 0, invalid: 0});
    await fixture.verifyCleanup();
  } finally {
    watchdog.abort();
    close.resolve({done: true});
    await rejected.catch(() => {});
  }
});

async function abortWhile(fixture, reached) {
  const controller = new AbortController();
  const result = assert.rejects(fixture.run({signal: controller.signal}), /autoridade perdida/);
  void result.catch(() => {});
  try {
    for (let ticks = 0; ; ticks++) {
      assert.ok(ticks < 250, 'heartbeat não observou o início da coleta');
      const [last] = (await fixture.calls()).slice(-1);
      if (last && await reached(last)) break;
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

test('perda de autoridade durante docker create mantém a recuperação e nunca inicia o alvo', async t => {
  const fixture = await setup(t, 'cancel-create');
  await abortWhile(fixture, async args => args[0] === 'create' && (await readdir(fixture.temp)).includes(args[2] + '.object'));
  assert.ok(!(await fixture.calls()).some(args => args[0] === 'start'));
});

async function cancelAfterCreateOutput(t, fixture, expectedError = /autoridade perdida após stdout/) {
  const controller = new AbortController();
  const spawn = ChildProcess.prototype.spawn;
  let stdout = '';
  t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    const child = spawn.call(this, options);
    if (options.file === fixture.dockerBinary && options.args[1] === 'create') {
      this.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.endsWith('\n')) queueMicrotask(() => controller.abort(new Error('autoridade perdida após stdout')));
      });
    }
    return child;
  });
  await assert.rejects(fixture.run({signal: controller.signal}), expectedError);
  return stdout.trim();
}

for (const scenario of ['renamed', 'late', 'partial', 'foreign', 'id-divergent']) {
  test(`cancelamento após stdout de docker create (${scenario})`, async t => {
    const fixture = await setup(t, `cancel-output-${scenario}`);
    const stdout = await cancelAfterCreateOutput(t, fixture);
    const calls = await fixture.calls();
    const [create] = calls.filter(args => args[0] === 'create');
    const name = create[2];
    const id = containerId(name);
    const partial = scenario === 'partial';
    assert.equal(stdout, partial ? id.slice(0, -1) : id);
    assert.ok(!calls.some(args => args[0] === 'start'));
    const containerCalls = calls.filter(args => args[0] === 'container');
    assert.ok(containerCalls.length);
    assert.ok(containerCalls.every(args => args.at(-1) === (partial ? name : id)));

    const renamed = join(fixture.temp, 'renomeado.object');
    if (scenario === 'renamed') {
      assert.deepEqual(containerCalls.map(args => args[1]), ['inspect', 'rm', 'inspect']);
      await assert.rejects(lstat(renamed), {code: 'ENOENT'});
      const replacement = JSON.parse(await readFile(join(fixture.temp, name + '.object'), 'utf8'));
      assert.equal(replacement.id, containerId('substituto'));
      assert.deepEqual(await fixture.pending(), []);
    } else {
      assert.ok(!containerCalls.some(args => args[1] === 'rm'));
      assert.deepEqual(await fixture.pending(), [name]);
      const state = JSON.parse(await readFile(join(fixture.recoveryDirectory, name, 'state.json'), 'utf8'));
      assert.deepEqual(state.resources, {[name]: partial ? false : {id}});
      assert.equal((await fixture.reconcile()).pending, 1);
      if (scenario === 'late' || partial) {
        assert.equal(await fixture.materialize(), name);
        assert.equal((await fixture.reconcile()).cleaned, 1);
        await fixture.verifyCleanup();
      } else {
        assert.ok((await lstat(renamed)).isFile());
        assert.ok(!(await fixture.calls()).some(args => args[1] === 'rm'));
      }
    }
  });
}

for (const operation of ['writeFile', 'sync']) {
  test(`reconciliação após falha persistente de ${operation} com ID completo preserva o substituto`, async t => {
    const fixture = await setup(t, 'cancel-output-renamed');
    const handle = await open(fixture.temp, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const original = prototype[operation];
    t.mock.method(prototype, operation, async function (...args) {
      const path = await readlink(`/proc/self/fd/${this.fd}`);
      if (path.startsWith(fixture.recoveryDirectory) && path.endsWith('/state.next')) {
        const state = JSON.parse(operation === 'writeFile' ? args[0] : await readFile(path, 'utf8'));
        if (Object.values(state.resources).some(value => typeof value === 'string' || value?.id)) {
          if (operation === 'writeFile') await original.call(this, args[0].slice(0, -1));
          throw new Error(`falha persistente de ${operation}`);
        }
      }
      return original.apply(this, args);
    });
    const id = await cancelAfterCreateOutput(t, fixture, new RegExp(`falha persistente de ${operation}`));
    const [name] = await fixture.pending();
    assert.equal(id, containerId(name));
    const statePath = join(fixture.recoveryDirectory, name, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.resources[name], null);
    const staged = await readFile(join(fixture.recoveryDirectory, name, 'state.next'), 'utf8');
    if (operation === 'writeFile') assert.throws(() => JSON.parse(staged), SyntaxError);
    else {
      const candidate = JSON.parse(staged).resources[name];
      assert.equal(typeof candidate === 'string' ? candidate : candidate.id, id);
    }
    const replacementPath = join(fixture.temp, name + '.object');
    const replacement = JSON.parse(await readFile(replacementPath, 'utf8'));
    assert.equal(replacement.id, containerId('substituto'));
    assert.equal(replacement.owner, state.owner);
    const renamed = join(fixture.temp, 'renomeado.object');
    assert.equal(JSON.parse(await readFile(renamed, 'utf8')).id, id);
    const before = await fixture.calls();
    assert.ok(!before.some(args => args[0] === 'start' || args[1] === 'rm'));
    if (operation === 'sync') {
      assert.deepEqual(await fixture.reconcile(), {cleaned: 0, pending: 0, active: 0, invalid: 1});
      assert.equal(await readFile(join(fixture.recoveryDirectory, name, 'state.next'), 'utf8'), staged);
      assert.deepEqual(await fixture.calls(), before);
    }
    assert.deepEqual(await reconcileInAnotherProcess(fixture),
      {cleaned: operation === 'sync' ? 1 : 0, pending: operation === 'sync' ? 0 : 1, active: 0, invalid: 0});
    const recoveryCalls = (await fixture.calls()).slice(before.length);
    if (operation === 'sync') {
      assert.deepEqual(recoveryCalls.map(args => [args[1], args.at(-1)]), [['inspect', id], ['rm', id], ['inspect', id]]);
      await assert.rejects(lstat(renamed), {code: 'ENOENT'});
    } else {
      assert.deepEqual(recoveryCalls, []);
      assert.ok((await lstat(renamed)).isFile());
    }
    assert.deepEqual(JSON.parse(await readFile(replacementPath, 'utf8')), replacement);
  });
}

test('inspeção por nome interrompida após confirmar o ID fixa a identidade no diário', async t => {
  const fixture = await setup(t, 'cancel-inspect-output');
  const name = 'ac-perf-' + randomUUID();
  const owner = randomUUID();
  const id = containerId(name);
  const directory = join(fixture.recoveryDirectory, name);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, JSON.stringify({owner, resources: {[name]: false}}));
  const original = join(fixture.temp, name + '.object');
  await writeFile(original, JSON.stringify({id, owner}));

  const controller = new AbortController();
  const spawn = ChildProcess.prototype.spawn;
  t.mock.method(ChildProcess.prototype, 'spawn', function (options) {
    const child = spawn.call(this, options);
    if (options.file === fixture.dockerBinary && options.args[2] === 'inspect' && options.args.at(-1) === name) {
      let output = '';
      this.stdout.on('data', chunk => {
        output += chunk;
        if (output === `${id} ${owner}\n`) queueMicrotask(() => controller.abort(new Error('inspeção interrompida')));
      });
    }
    return child;
  });
  await assert.rejects(fixture.reconcile({signal: controller.signal}), /inspeção interrompida/);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).resources, {[name]: {id}});
  const before = await fixture.calls();
  assert.deepEqual(before.map(args => [args[1], args.at(-1)]), [['inspect', name]]);
  assert.deepEqual(await reconcileInAnotherProcess(fixture), {cleaned: 1, pending: 0, active: 0, invalid: 0});
  assert.deepEqual((await fixture.calls()).slice(before.length).map(args => [args[1], args.at(-1)]),
    [['inspect', id], ['rm', id], ['inspect', id]]);
  await assert.rejects(lstat(join(fixture.temp, 'renomeado.object')), {code: 'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(original, 'utf8')), {owner, id: containerId('substituto')});
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
    assert.equal((await fixture.verifyCleanup()).length, 4);
  });
  await t.test('ausência não confirmada', async subtest => {
    const fixture = await setup(subtest, 'unconfirmed');
    await assert.rejects(fixture.run(), /remoção Docker sem confirmação/);
    const removals = (await fixture.calls()).filter(args => args[1] === 'rm');
    assert.equal(removals.length, 6);
    assert.equal((await fixture.reconcile()).pending, 1);
  });
});

test('canal HTTP local encaminha requisições pelos dois sockets e encerra a vigilância', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ac-perf-link-test-'));
  const targetSocket = join(temp, 'target.sock');
  const observerSocket = join(temp, 'observer.sock');
  const target = createServer((req, res) => { res.end(`${req.method} ${req.url}`); });
  await new Promise(ok => target.listen(0, '127.0.0.1', ok));
  const host = await startHostHttpLink(targetSocket, observerSocket);
  const link = startTargetHttpLink(targetSocket, target.address().port);
  const observer = await startObserverHttpLink(observerSocket);
  let disconnected = false;
  const monitor = watchHttpLink(observerSocket, () => { disconnected = true; });
  t.after(async () => {
    monitor.close();
    link.close();
    await observer.close();
    await host.close();
    await new Promise(ok => target.close(ok));
    await rm(temp, {recursive: true, force: true});
  });
  const paths = ['/teste', '/outro?x=1'];
  const responses = await Promise.all(paths.map(path => fetch(observer.origin + path, {signal: AbortSignal.timeout(2000)})));
  assert.deepEqual(await Promise.all(responses.map(response => response.text())), paths.map(path => 'GET ' + path));
  await symlink(observerSocket, join(temp, 'alias'));
  const refused = await startObserverHttpLink(join(temp, 'alias'));
  try { await assert.rejects(fetch(refused.origin, {signal: AbortSignal.timeout(1000)})); }
  finally { await refused.close(); }
  await host.close();
  for (let tick = 0; !disconnected && tick < 50; tick++) await delay(10);
  assert.ok(disconnected);
});
