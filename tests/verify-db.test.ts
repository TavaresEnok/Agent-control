import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Refusal} from '../src/contracts.ts';
import {readCurrentVerifyDatabase, refreshVerifyDatabases} from '../src/verify-db.ts';

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
    assert.deepEqual(entries, [basename(first.directory), 'current.json']);
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

test('record_tool grava 127 só quando o binário não existe', async () => {
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
    assert.equal(await code('empty'), '0');
    assert.equal(await readFile(join(dir, 'empty.json'), 'utf8'), '[]');
    assert.equal(await code('found'), '2');
    assert.equal(await code('killed'), '1');
    assert.equal(await code('object'), '0');
    assert.equal(await code('blank'), '0');
    assert.equal(await code('absent'), '0');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
