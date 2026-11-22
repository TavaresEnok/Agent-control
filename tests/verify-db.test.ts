import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Refusal} from '../src/contracts.ts';
import {
  claimVerifyDatabaseStamp,
  discardStampArguments,
  pruneVerifyDatabaseStamps,
  readCurrentVerifyDatabase,
  refreshVerifyDatabases,
  releaseVerifyDatabaseStamp,
  runVerifyDatabaseRetention,
  verifyDatabaseKeepRecent,
  verifyDatabaseStampPresent,
  verifyDatabaseStampsToDiscard,
} from '../src/verify-db.ts';

const execFileAsync = promisify(execFile);
const image = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const now = new Date('2026-11-17T15:04:05.678Z');
const later = new Date('2026-11-17T16:00:00.000Z');
const refused = (code: string) => (error: unknown) => error instanceof Refusal && error.code === code;

function mountedDatabase(args: readonly string[]): string {
  const mount = args.find((item) => item.includes('dst=/databases'));
  const source = mount?.split(',').find((part) => part.startsWith('src='))?.slice(4);
  if (!source) throw new Error('destino das bases ausente');
  return source;
}

function publishingSpawn(): (args: readonly string[]) => Promise<number> {
  return async (args) => {
    assert.ok(args.includes('/usr/local/bin/verify-db-fetch.sh'));
    const directory = mountedDatabase(args);
    await mkdir(join(directory, 'osv'), {recursive: true});
    await writeFile(join(directory, 'osv', 'npm.txt'), 'ok');
    return 0;
  };
}

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'verify-db-'));
  await chmod(directory, 0o700);
  return directory;
}

const runLive = '11111111-1111-4111-8111-111111111111';
const runOther = '22222222-2222-4222-8222-222222222222';
const runDead = '33333333-3333-4333-8333-333333333333';

function unusedPid(): number {
  for (let pid = 1_000_000; pid < 1_000_050; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('nenhum pid livre');
}

function claimBody(stamp: string, pid: number): string {
  return JSON.stringify({stamp, pid, claimedAt: now.toISOString()}, null, 2) + '\n';
}

test('a atualização publica o manifest e o current.json sem abrir o pai', async () => {
  const data = await privateDirectory();
  try {
    assert.equal(await readCurrentVerifyDatabase(data), null);
    const result = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now});
    assert.equal(basename(result.directory), '20261117-150405');
    assert.equal(result.fetchedAt, now.toISOString());
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    const parent = join(data, 'verify-db');
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.notEqual((await stat(parent)).mode & 0o777, 0o777);
    assert.equal((await stat(result.directory)).mode & 0o777, 0o777);
    for (const name of ['grype', 'trivy', 'osv']) {
      const info = await stat(join(result.directory, name));
      assert.equal(info.isDirectory(), true);
      assert.equal(info.mode & 0o777, 0o777);
    }
    const manifestBytes = await readFile(join(result.directory, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      fetchedAt: string;
      files: {path: string; sha256: string; bytes: number}[];
    };
    assert.equal(manifest.fetchedAt, now.toISOString());
    assert.equal(manifest.files.some((file) => file.path === 'manifest.json'), false);
    const npm = manifest.files.find((file) => file.path === 'osv/npm.txt');
    assert.ok(npm);
    assert.equal(npm.bytes, 2);
    assert.equal(npm.sha256, createHash('sha256').update('ok').digest('hex'));
    assert.equal(npm.path.includes('\\'), false);
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), result.manifestSha256);
    const currentPath = join(parent, 'current.json');
    assert.equal((await stat(currentPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), result);
    assert.deepEqual(await readCurrentVerifyDatabase(data), result);
    const names = await readdir(parent);
    assert.equal(names.some((name) => name.includes('.tmp')), false);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('uma busca que falha conserva o current.json e não publica o carimbo novo', async () => {
  const data = await privateDirectory();
  try {
    const first = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now});
    const previous = await readFile(join(data, 'verify-db', 'current.json'), 'utf8');
    let calls = 0;
    await assert.rejects(
      () => refreshVerifyDatabases({
        dataDirectory: data,
        image,
        now: later,
        spawn: async () => {
          calls += 1;
          return 1;
        },
      }),
      (error: unknown) => error instanceof Error && error.message === 'VERIFY_DB_FETCH_FAILED',
    );
    assert.equal(calls, 1);
    assert.equal(await readFile(join(data, 'verify-db', 'current.json'), 'utf8'), previous);
    assert.deepEqual(await readCurrentVerifyDatabase(data), first);
    assert.equal(await readFile(join(first.directory, 'osv', 'npm.txt'), 'utf8'), 'ok');
    const entries = (await readdir(join(data, 'verify-db'))).sort();
    // in-use/ now exists because each fetch claims the stamp it downloads; no claim may be left behind.
    assert.deepEqual(entries, [basename(first.directory), 'current.json', 'in-use']);
    assert.deepEqual(await readdir(join(data, 'verify-db', 'in-use')), []);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('sem imagem fixada a busca não chega a criar o carimbo', async () => {
  const data = await privateDirectory();
  try {
    let calls = 0;
    await assert.rejects(
      () => refreshVerifyDatabases({dataDirectory: data, spawn: async () => {
        calls += 1;
        return 0;
      }, now}),
      refused('VERIFY_IMAGE_UNPINNED'),
    );
    assert.equal(calls, 0);
    await assert.rejects(readdir(join(data, 'verify-db')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    const pin = join(data, 'verify-image.json');
    await writeFile(pin, JSON.stringify({image}) + '\n', {mode: 0o600});
    await chmod(pin, 0o644);
    await assert.rejects(
      () => refreshVerifyDatabases({dataDirectory: data, spawn: async () => 0, now}),
      refused('VERIFY_IMAGE_UNPINNED'),
    );
    await chmod(pin, 0o600);
    const result = await refreshVerifyDatabases({dataDirectory: data, spawn: publishingSpawn(), now});
    assert.equal(result.fetchedAt, now.toISOString());
    assert.equal((await stat(join(data, 'verify-db', 'current.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

const DISCARD_FLAGS = ['--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', 'FOWNER', '--security-opt', 'no-new-privileges', '--read-only'] as const;

function assertDiscardFlags(args: readonly string[]): void {
  for (const token of DISCARD_FLAGS) assert.ok(args.includes(token), token);
  assert.equal(args[args.indexOf('--user') + 1], '0');
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--rm'));
  const mountAt = args.indexOf('--mount');
  const imageAt = args.indexOf(image);
  assert.ok(mountAt > 0 && imageAt > mountAt);
  for (const flag of ['--cap-drop', '--cap-add', '--security-opt', '--read-only']) {
    const at = args.indexOf(flag);
    assert.ok(at > 0 && at < mountAt, flag);
  }
  assert.ok(args.indexOf('--cap-drop') < args.indexOf('--cap-add'));
  assert.equal(args.at(-2), '-c');
  assert.equal(args.at(-1), 'chmod -R a+rwX /databases');
}

test('o descarte só devolve ao root as caps de chmod, sem privilégio novo', () => {
  const parent = '/tmp/verify-db-args';
  const stamp = `${parent}/20261117-150405`;
  const args = discardStampArguments(stamp, parent, image);
  assertDiscardFlags(args);
  assert.equal(args[0], 'docker');
  assert.ok(args.includes(`type=bind,src=${stamp},dst=/databases`));
  assert.equal(args.includes(image), true);
});

test('a poda conserva o current, os dois mais novos e o carimbo em uso', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    const names = [
      '20261117-120000',
      '20261117-130000',
      '20261117-140000',
      '20261117-150000',
      '20261117-160000',
    ];
    for (const name of names) {
      await mkdir(join(parent, name), {mode: 0o777});
      await writeFile(join(parent, name, 'marker'), name);
    }
    const currentBody = JSON.stringify({
      directory: join(parent, names[0]),
      fetchedAt: now.toISOString(),
      manifestSha256: 'abc',
    }, null, 2) + '\n';
    await writeFile(join(parent, 'current.json'), currentBody, {mode: 0o600});
    const heldBody = claimBody(join(parent, names[1]), process.pid);
    const missingBody = claimBody(join(parent, '20200101-000000'), process.pid);
    const claims = join(parent, 'in-use');
    await mkdir(claims, {mode: 0o700});
    await writeFile(join(claims, `${runLive}.json`), heldBody, {mode: 0o600});
    await chmod(join(claims, `${runLive}.json`), 0o600);
    await writeFile(join(claims, `${runOther}.json`), missingBody, {mode: 0o600});
    await chmod(join(claims, `${runOther}.json`), 0o600);
    await writeFile(join(parent, 'notes.txt'), 'keep');
    let dockerCalls = 0;
    await pruneVerifyDatabaseStamps(data, image, async () => {
      dockerCalls += 1;
      return 0;
    });
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20261117-120000', '20261117-130000', '20261117-150000', '20261117-160000']);
    assert.equal(dockerCalls, 0);
    assert.equal(await readFile(join(parent, 'current.json'), 'utf8'), currentBody);
    assert.equal(await readFile(join(claims, `${runLive}.json`), 'utf8'), heldBody);
    assert.equal(await readFile(join(claims, `${runOther}.json`), 'utf8'), missingBody);
    assert.equal(await readFile(join(parent, 'notes.txt'), 'utf8'), 'keep');
    await assert.rejects(stat(join(parent, '20261117-140000')));
    await assert.rejects(stat(join(parent, '20200101-000000')));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('dois claims de runs diferentes sobrevivem em arquivos 0600 exclusivos', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    const stamp = join(parent, '20261117-150405');
    const other = join(parent, '20261117-160000');
    await claimVerifyDatabaseStamp(data, stamp, runLive);
    const dir = join(parent, 'in-use');
    const pathA = join(dir, `${runLive}.json`);
    const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as {stamp: string; pid: number; claimedAt: string};
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(pathA)).mode & 0o777, 0o600);
    const first = await read(pathA);
    assert.equal(first.stamp, stamp);
    assert.equal(first.pid, process.pid);
    assert.equal(Number.isNaN(Date.parse(first.claimedAt)), false);
    await claimVerifyDatabaseStamp(data, stamp, runLive);
    assert.deepEqual(await readdir(dir), [`${runLive}.json`]);
    await claimVerifyDatabaseStamp(data, other, runOther);
    const pathB = join(dir, `${runOther}.json`);
    assert.equal((await read(pathA)).stamp, stamp);
    assert.equal((await read(pathB)).stamp, other);
    assert.equal((await read(pathB)).pid, process.pid);
    assert.equal((await stat(pathB)).mode & 0o777, 0o600);
    await assert.rejects(
      () => writeFile(pathB, 'nope', {flag: 'wx'}),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST',
    );
    await releaseVerifyDatabaseStamp(data, stamp, runLive);
    await assert.rejects(stat(pathA));
    assert.equal((await read(pathB)).stamp, other);
    await releaseVerifyDatabaseStamp(data, stamp, runLive);
    assert.equal((await read(pathB)).stamp, other);
    assert.equal((await readdir(parent)).some((name) => name.includes('.tmp')), false);
    assert.equal((await readdir(dir)).some((name) => name.includes('.tmp')), false);
    await assert.rejects(stat(join(parent, 'in-use.json')));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('claim de pid morto não segura o carimbo e a poda apaga o arquivo', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    const names = ['20261117-120000', '20261117-130000', '20261117-150000', '20261117-160000'];
    for (const name of names) await mkdir(join(parent, name), {mode: 0o777});
    const currentBody = JSON.stringify({
      directory: join(parent, names[0]),
      fetchedAt: now.toISOString(),
      manifestSha256: 'abc',
    }) + '\n';
    await writeFile(join(parent, 'current.json'), currentBody, {mode: 0o600});
    const dir = join(parent, 'in-use');
    await mkdir(dir, {mode: 0o700});
    const claim = join(dir, `${runDead}.json`);
    await writeFile(claim, claimBody(join(parent, '20261117-130000'), unusedPid()), {mode: 0o600});
    await chmod(claim, 0o600);
    await writeFile(join(dir, 'notes.json'), '{"stamp":"/tmp/nope"}');
    await pruneVerifyDatabaseStamps(data, image, async () => 0);
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20261117-120000', '20261117-150000', '20261117-160000']);
    await assert.rejects(stat(claim));
    assert.equal(await readFile(join(dir, 'notes.json'), 'utf8'), '{"stamp":"/tmp/nope"}');
    assert.equal(await readFile(join(parent, 'current.json'), 'utf8'), currentBody);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('nome fora de run ou caminho fora do carimbo não amplia a poda', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    const names = ['20261117-140000', '20261117-150000', '20261117-160000'];
    for (const name of names) await mkdir(join(parent, name), {mode: 0o777});
    await mkdir(join(parent, 'not-a-stamp'), {mode: 0o700});
    await writeFile(join(parent, 'notes.txt'), 'keep');
    const secret = join(data, 'secret.txt');
    await writeFile(secret, 'secret');
    const currentBody = JSON.stringify({
      directory: join(parent, names[2]),
      fetchedAt: now.toISOString(),
      manifestSha256: 'abc',
    }) + '\n';
    await writeFile(join(parent, 'current.json'), currentBody, {mode: 0o600});
    const dir = join(parent, 'in-use');
    await mkdir(dir, {mode: 0o700});
    const outside = JSON.stringify({
      stamp: secret,
      pid: process.pid,
      claimedAt: now.toISOString(),
    }, null, 2) + '\n';
    await writeFile(join(dir, 'not-a-run.json'), outside, {mode: 0o600});
    await writeFile(join(dir, `${runLive}.json`), JSON.stringify({
      stamp: join(parent, '..', 'secret.txt'),
      pid: process.pid,
      claimedAt: now.toISOString(),
    }) + '\n', {mode: 0o600});
    await writeFile(join(dir, `${runOther}.json`), '{', {mode: 0o600});
    await pruneVerifyDatabaseStamps(data, image, async () => 0);
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20261117-150000', '20261117-160000']);
    assert.equal(await readFile(secret, 'utf8'), 'secret');
    assert.equal(await readFile(join(parent, 'notes.txt'), 'utf8'), 'keep');
    assert.equal((await stat(join(parent, 'not-a-stamp'))).isDirectory(), true);
    assert.equal(await readFile(join(dir, 'not-a-run.json'), 'utf8'), outside);
    assert.equal((await stat(join(dir, `${runOther}.json`))).isFile(), true);
    await assert.rejects(stat(join(parent, '20261117-140000')));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('carimbo que não é filho direto e run inseguro são recusados', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    const stamp = join(parent, '20261117-150405');
    await assert.rejects(
      () => claimVerifyDatabaseStamp(data, stamp, '../20261117-150405'),
      refused('VERIFY_PATH_FORBIDDEN'),
    );
    await assert.rejects(
      () => claimVerifyDatabaseStamp(data, join(parent, '..', 'secret'), runLive),
      refused('VERIFY_PATH_FORBIDDEN'),
    );
    await assert.rejects(
      () => claimVerifyDatabaseStamp(data, join(parent, 'not-a-stamp'), runLive),
      refused('VERIFY_PATH_FORBIDDEN'),
    );
    await assert.rejects(
      () => claimVerifyDatabaseStamp(data, join(parent, stamp, 'child'), runLive),
      refused('VERIFY_PATH_FORBIDDEN'),
    );
    await assert.rejects(stat(join(data, 'secret')));
    await assert.rejects(stat(join(parent, 'in-use.json')));
    await assert.rejects(stat(join(parent, 'in-use')));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('depois de publicar, a poda apaga o que não é current, recente nem uso', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    const ancient = join(parent, '20200101-000000');
    const used = join(parent, '20200101-000001');
    const recent = join(parent, '20240101-000000');
    await mkdir(ancient, {mode: 0o777});
    await mkdir(used, {mode: 0o777});
    await mkdir(recent, {mode: 0o777});
    await writeFile(join(ancient, 'marker'), 'old');
    await claimVerifyDatabaseStamp(data, used, runLive);
    const result = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now, usedDiskPercent: async () => 50});
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20200101-000001', '20240101-000000', basename(result.directory)]);
    assert.equal(basename(result.directory), '20261117-150405');
    await assert.rejects(stat(ancient));
    assert.equal((await readFile(join(parent, 'current.json'), 'utf8')).includes(result.directory), true);
    assert.equal((await stat(join(parent, 'in-use', `${runLive}.json`))).mode & 0o777, 0o600);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a busca nova com o disco em 90% ou mais deixa só a atual e as em uso', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    const used = join(parent, '20200101-000001');
    const recent = join(parent, '20240101-000000');
    await mkdir(used, {mode: 0o777});
    await mkdir(recent, {mode: 0o777});
    await claimVerifyDatabaseStamp(data, used, runLive);
    const result = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now, usedDiskPercent: async () => 96});
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20200101-000001', basename(result.directory)]);
    await releaseVerifyDatabaseStamp(data, used, runLive);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('uma busca que falha não poda carimbos antigos', async () => {
  const data = await privateDirectory();
  try {
    const first = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now});
    const parent = join(data, 'verify-db');
    const ancient = join(parent, '20200101-000000');
    await mkdir(ancient, {mode: 0o777});
    await writeFile(join(ancient, 'marker'), 'old');
    const previous = await readFile(join(parent, 'current.json'), 'utf8');
    await assert.rejects(
      () => refreshVerifyDatabases({
        dataDirectory: data,
        image,
        now: later,
        spawn: async () => 1,
      }),
      (error: unknown) => error instanceof Error && error.message === 'VERIFY_DB_FETCH_FAILED',
    );
    assert.equal(await readFile(join(parent, 'current.json'), 'utf8'), previous);
    assert.equal(await readFile(join(ancient, 'marker'), 'utf8'), 'old');
    assert.equal((await stat(first.directory)).isDirectory(), true);
    await assert.rejects(stat(join(parent, '20261117-160000')));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('um carimbo que resiste não desfaz o current e o seguinte ainda sai', async () => {
  const data = await privateDirectory();
  const parent = join(data, 'verify-db');
  const stuck = join(parent, '20261117-140000');
  try {
    await mkdir(parent, {mode: 0o700});
    const names = ['20261117-120000', '20261117-140000', '20261117-145000', '20261117-150000', '20261117-160000'];
    for (const name of names) await mkdir(join(parent, name), {mode: 0o777});
    await writeFile(join(stuck, 'owned'), 'x');
    await chmod(stuck, 0o000);
    const currentBody = JSON.stringify({
      directory: join(parent, names[0]),
      fetchedAt: now.toISOString(),
      manifestSha256: 'abc',
    }) + '\n';
    await writeFile(join(parent, 'current.json'), currentBody, {mode: 0o600});
    const calls: string[][] = [];
    await pruneVerifyDatabaseStamps(data, image, async (args) => {
      calls.push([...args]);
      return 1;
    });
    assert.equal(calls.length, 1);
    assertDiscardFlags(calls[0] ?? []);
    assert.equal(await readFile(join(parent, 'current.json'), 'utf8'), currentBody);
    await chmod(stuck, 0o700);
    assert.equal((await stat(stuck)).isDirectory(), true);
    await assert.rejects(stat(join(parent, '20261117-145000')));
    assert.equal((await stat(join(parent, '20261117-120000'))).isDirectory(), true);
    assert.equal((await stat(join(parent, '20261117-160000'))).isDirectory(), true);
  } finally {
    await chmod(stuck, 0o700).catch(() => undefined);
    await rm(data, {recursive: true, force: true});
  }
});

test('record_tool guarda o código real da ferramenta e nunca troca erro por zero', async () => {
  const entry = await readFile('deploy/verify-entrypoint.sh', 'utf8');
  const start = entry.indexOf('# record_tool\n');
  const end = entry.indexOf('# end record_tool');
  assert.ok(start >= 0 && end > start);
  const fn = entry.slice(start, end);
  assert.match(entry, /record_tool hadolint /);
  assert.match(entry, /VERIFY_NETWORK_FORBIDDEN/);
  assert.match(entry, /VERIFY_SOCKET_FORBIDDEN/);
  assert.match(entry, /VERIFY_PATH_FORBIDDEN/);
  assert.match(entry, /--offline|--network none/);
  assert.match(entry, /dir:\/repository|--source \/repository/);
  const fetch = await readFile('deploy/verify-db-fetch.sh', 'utf8');
  assert.match(fetch, /set -eu/);
  assert.match(fetch, /VERIFY_SOCKET_FORBIDDEN/);
  assert.match(fetch, /find \/databases -mindepth 1 -user 65532 -exec chmod a\+rX \{\} \+/);
  assert.equal(fetch.includes('chmod -R a+rX /databases'), false);
  assert.match(fetch, /mkdir -p \/tmp\/empty \/databases\/tmp /);
  assert.match(fetch, /export TMPDIR=\/databases\/tmp/);
  assert.equal(fetch.includes('export TMPDIR=/tmp'), false);
  const maintenance = await readFile('src/personal-maintenance.ts', 'utf8');
  assert.match(maintenance, /refreshVerifyDatabases/);
  assert.match(maintenance, /Bases de vulnerabilidade atualizadas\./);
  assert.match(maintenance, /Bases de vulnerabilidade não atualizadas\. A base anterior permanece\./);
  const dir = await mkdtemp(join(tmpdir(), 'verify-record-'));
  try {
    const script = join(dir, 'run.sh');
    await writeFile(script, `#!/bin/sh
set -eu
cd "$1"
OUT=$1
export VERIFY_OUTPUT="$OUT"
${fn}
cat > "$OUT/write-empty.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s' '[]' > "$1"
exit 127
EOF
cat > "$OUT/write-found.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s' '[{"id":1}]' > "$1"
exit "$2"
EOF
cat > "$OUT/write-object.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s' '{}' > "$1"
exit 127
EOF
chmod 0700 "$OUT/write-empty.sh" "$OUT/write-found.sh" "$OUT/write-object.sh"
record_tool missing /no/such/verify-tool "$OUT/missing.json" "$OUT/write-found.sh" "$OUT/should-not-exist.json" 2
record_tool empty /bin/true "$OUT/empty.json" "$OUT/write-empty.sh" "$OUT/empty.json"
record_tool found /bin/true "$OUT/found.json" "$OUT/write-found.sh" "$OUT/found.json" 2
record_tool killed /bin/true "$OUT/killed.json" "$OUT/write-found.sh" "$OUT/killed.json" 127
record_tool object /bin/true "$OUT/object.json" "$OUT/write-object.sh" "$OUT/object.json"
printf '%s' ' \n\t' > "$OUT/blank.json"
record_tool blank /bin/true "$OUT/blank.json" sh -c 'exit 3'
record_tool absent /bin/true "$OUT/nope.json" sh -c 'exit 4'
`, {mode: 0o700});
    await chmod(script, 0o700);
    await execFileAsync('/bin/sh', [script, dir]);
    const code = async (name: string) => (await readFile(join(dir, `${name}.code`), 'utf8')).trim();
    assert.equal(await code('missing'), '127');
    await assert.rejects(stat(join(dir, 'should-not-exist.json')));
    // Relatório vazio com saída 127 era trocado por 0 e virava "execução limpa". Agora o código real fica.
    assert.equal(await code('empty'), '127');
    assert.equal(await readFile(join(dir, 'empty.json'), 'utf8'), '[]');
    assert.equal(await code('found'), '2');
    assert.equal(await code('killed'), '1');
    assert.equal(await code('object'), '127');
    assert.equal(await code('blank'), '3');
    assert.equal(await code('absent'), '4');
    // A versão e a saída original acompanham o código.
    assert.equal(typeof (await readFile(join(dir, 'found.version'), 'utf8')), 'string');
    await stat(join(dir, 'blank.stdout'));
    await stat(join(dir, 'blank.stderr'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('sob pressão de disco a poda guarda só a base atual e as em uso', async () => {
  assert.equal(verifyDatabaseKeepRecent(89.99), 2);
  assert.equal(verifyDatabaseKeepRecent(90), 0);
  assert.equal(verifyDatabaseKeepRecent(97), 0);
  assert.equal(verifyDatabaseKeepRecent(undefined), 2);
  assert.equal(verifyDatabaseKeepRecent(Number.NaN), 2);
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {recursive: true, mode: 0o700});
    const names = ['20261120-052924', '20261121-040000', '20261122-040008', '20261122-050000'];
    for (const name of names) {
      await mkdir(join(parent, name), {mode: 0o777});
      await writeFile(join(parent, name, 'marker'), name);
    }
    // A atual não é a mais recente: sob pressão, a mais recente também sai.
    await writeFile(join(parent, 'current.json'), JSON.stringify({
      directory: join(parent, names[2]), fetchedAt: new Date().toISOString(), manifestSha256: 'abc',
    }) + '\n', {mode: 0o600});
    // Sem pressão ficam a atual e as 2 mais recentes (a atual é uma delas): saem as de 20/11 e 21/11.
    assert.deepEqual(await verifyDatabaseStampsToDiscard(data, 2), ['20261120-052924', '20261121-040000']);
    const preview = await runVerifyDatabaseRetention(data, false, {usedPercent: 50, image});
    assert.match(preview[0]!, /as 2 mais recentes\): 2 elegível\(is\): 20261120-052924, 20261121-040000\./);
    // Uma rodada viva ainda usa a de 21/11.
    await claimVerifyDatabaseStamp(data, join(parent, names[1]), runLive);
    const pressured = await runVerifyDatabaseRetention(data, false, {usedPercent: 96, image});
    assert.match(pressured[0]!, /disco em 90% ou mais: fica só a base atual e as em uso\): 2 elegível\(is\): 20261120-052924, 20261122-050000\./);
    const left = async () => (await readdir(parent)).filter((name) => /^\d{8}-\d{6}$/.test(name)).sort();
    assert.deepEqual(await left(), names, 'a prévia não apaga nada');
    let dockerCalls = 0;
    const spawn = async () => { dockerCalls += 1; return 0; };
    const applied = await runVerifyDatabaseRetention(data, true, {usedPercent: 96, image, spawn});
    assert.match(applied[0]!, /removida\(s\) 2 de 2: 20261120-052924, 20261122-050000\./);
    assert.deepEqual(await left(), ['20261121-040000', '20261122-040008']);
    assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith('.descarte-')), [], 'nada fica de lado');
    // Liberada a rodada, sob pressão sobra só a atual.
    await releaseVerifyDatabaseStamp(data, join(parent, names[1]), runLive);
    await runVerifyDatabaseRetention(data, true, {usedPercent: 96, image, spawn});
    assert.deepEqual(await left(), ['20261122-040008']);
    assert.equal(dockerCalls, 0, 'as pastas de teste são graváveis: o contêiner de chmod não é necessário');
    const nothing = await runVerifyDatabaseRetention(data, true, {usedPercent: 96, image});
    assert.match(nothing[0]!, /nada a remover\./);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a prévia da retenção das bases não apaga claims de processos mortos', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(join(parent, '20261120-052924'), {recursive: true, mode: 0o777});
    await mkdir(join(parent, '20261122-040008'), {mode: 0o777});
    await writeFile(join(parent, 'current.json'), JSON.stringify({
      directory: join(parent, '20261122-040008'), fetchedAt: new Date().toISOString(), manifestSha256: 'abc',
    }) + '\n', {mode: 0o600});
    const claims = join(parent, 'in-use');
    await mkdir(claims, {mode: 0o700});
    const dead = claimBody(join(parent, '20261120-052924'), 2 ** 22 + 12345);
    await writeFile(join(claims, `${runOther}.json`), dead, {mode: 0o600});
    await runVerifyDatabaseRetention(data, false, {usedPercent: 96, image});
    assert.equal(await readFile(join(claims, `${runOther}.json`), 'utf8'), dead);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('sob pressão, um claim ilegível impede qualquer poda', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(join(parent, '20261120-052924'), {recursive: true, mode: 0o777});
    await mkdir(join(parent, '20261122-040008'), {mode: 0o777});
    await writeFile(join(parent, 'current.json'), JSON.stringify({
      directory: join(parent, '20261122-040008'), fetchedAt: new Date().toISOString(), manifestSha256: 'abc',
    }) + '\n', {mode: 0o600});
    const claims = join(parent, 'in-use');
    await mkdir(claims, {mode: 0o700});
    await writeFile(join(claims, `${runLive}.json`), '{ilegível', {mode: 0o600});
    await assert.rejects(runVerifyDatabaseRetention(data, true, {usedPercent: 96, image}), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_DB_PRUNE_FAILED');
    assert.equal(await pruneVerifyDatabaseStamps(data, image, undefined, {keepRecent: 0}), null);
    assert.ok((await stat(join(parent, '20261120-052924'))).isDirectory());
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a base que ainda está sendo baixada não é podada por outra busca', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    let during: string[] = [];
    const base = publishingSpawn();
    const result = await refreshVerifyDatabases({
      dataDirectory: data, image, now, usedDiskPercent: async () => 96,
      spawn: async (args) => {
        // Outra poda, sob pressão, enquanto esta busca baixa: a pasta nova está reivindicada.
        await pruneVerifyDatabaseStamps(data, image, undefined, {keepRecent: 0});
        during = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name));
        return base(args);
      },
    });
    assert.deepEqual(during, [basename(result.directory)]);
    assert.deepEqual((await readdir(join(parent, 'in-use'))).filter((name) => name.endsWith('.json')), [], 'o claim do download sai no fim');
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a busca nova com a medição do disco falhando mantém a regra das 2 recentes', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(parent, {mode: 0o700});
    await mkdir(join(parent, '20240101-000000'), {mode: 0o777});
    const result = await refreshVerifyDatabases({dataDirectory: data, image, spawn: publishingSpawn(), now, usedDiskPercent: async () => undefined});
    const left = (await readdir(parent)).filter((name) => /^\d{8}-\d{6}/.test(name)).sort();
    assert.deepEqual(left, ['20240101-000000', basename(result.directory)]);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('o exame confere a base depois de reivindicá-la', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    const stamp = join(parent, '20261122-040008');
    await mkdir(stamp, {recursive: true, mode: 0o777});
    assert.equal(await verifyDatabaseStampPresent(stamp), false);
    await writeFile(join(stamp, 'manifest.json'), '{}');
    assert.equal(await verifyDatabaseStampPresent(stamp), true);
    assert.equal(await verifyDatabaseStampPresent(join(parent, '20261120-052924')), false);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a retenção das bases recusa quando não consegue ler current.json', async () => {
  const data = await privateDirectory();
  try {
    const parent = join(data, 'verify-db');
    await mkdir(join(parent, '20261120-052924'), {recursive: true, mode: 0o777});
    await writeFile(join(parent, 'current.json'), '{quebrado', {mode: 0o600});
    await assert.rejects(runVerifyDatabaseRetention(data, true, {usedPercent: 96, image}), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_DB_PRUNE_FAILED');
    assert.ok((await stat(join(parent, '20261120-052924'))).isDirectory());
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
