import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {
  PACK_MIN_BYTES, claimVerifyDatabaseStamp, compactVerifyDatabaseStamps, expandVerifyDatabaseStamp, readStampPack,
  releaseVerifyDatabaseStamp, runVerifyDatabaseRetention, verifyDatabaseStampHasJava,
} from '../src/verify-db.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A large, very compressible "database" and a few small files, laid out like a published stamp. */
const contents: Record<string, Buffer> = {
  'grype/6/vulnerability.db': Buffer.alloc(PACK_MIN_BYTES + 4096, 'grype-row;'),
  'trivy/java-db/trivy-java.db': Buffer.alloc(PACK_MIN_BYTES + 1, 'java-row;'),
  'trivy/db/metadata.json': Buffer.from('{"Version":2}\n'),
  'osv/osv-scalibr/npm/small.zip': Buffer.from('small'),
};

async function lab() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ac-verify-db-pack-')));
  const data = join(base, 'data'), temp = join(base, 'tmp'), stamp = join(data, 'verify-db', '20261128-010000');
  await mkdir(temp, {mode: 0o700});
  for (const [path, bytes] of Object.entries(contents)) {
    await mkdir(dirname(join(stamp, path)), {recursive: true});
    await writeFile(join(stamp, path), bytes);
  }
  await chmod(data, 0o700);
  const files = Object.entries(contents).map(([path, bytes]) => ({path, sha256: sha(bytes), bytes: bytes.length})).sort((a, b) => a.path < b.path ? -1 : 1);
  await writeFile(join(stamp, 'manifest.json'), JSON.stringify({fetchedAt: '2026-11-28T01:00:00.000Z', files}, null, 2) + '\n');
  await writeFile(join(data, 'verify-db', 'current.json'), JSON.stringify({directory: stamp, fetchedAt: '2026-11-28T01:00:00.000Z', manifestSha256: 'x'.repeat(64)}));
  return {base, data, temp, stamp, close: () => rm(base, {recursive: true, force: true})};
}
const present = async (path: string) => stat(path).then(() => true, () => false);
const noSpawn = async () => { throw new Error('no chmod container expected'); };

test('a stamp is compressed at rest only on apply, its originals leave, and the space is what the archives take', async () => {
  const l = await lab();
  try {
    assert.match((await compactVerifyDatabaseStamps(l.data, false)).join('\n'), /1 seria\(m\) compactada\(s\): 20261128-010000/);
    assert.equal(await readStampPack(l.stamp), undefined);
    const lines = await compactVerifyDatabaseStamps(l.data, true, {image: 'sha256:' + 'a'.repeat(64), spawn: noSpawn});
    assert.match(lines.join('\n'), /Base 20261128-010000: compactada \(0\.02 GB em 0\.00 GB\)/);
    const pack = await readStampPack(l.stamp);
    assert.deepEqual(pack?.files.map(entry => entry.path).sort(), ['grype/6/vulnerability.db', 'trivy/java-db/trivy-java.db']);
    assert.equal(await present(join(l.stamp, 'grype/6/vulnerability.db')), false);
    assert.equal(await present(join(l.stamp, 'trivy/db/metadata.json')), true, 'small files stay as they are');
    assert.ok((await stat(join(l.stamp, '.compactado/grype/6/vulnerability.db.zst'))).size < 100_000);
    // The Java database still counts as present: it is inside the pack.
    assert.equal(await verifyDatabaseStampHasJava(l.stamp), true);
    // A second pass has nothing to do.
    assert.deepEqual(await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn}), []);
  } finally { await l.close(); }
});

test('an exam expands the stamp into its own registered temporary, byte for byte, and the release removes it', async () => {
  const l = await lab();
  try {
    // Uncompressed: the stamp itself is mounted.
    const plain = await expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp});
    assert.equal(plain.directory, l.stamp);
    await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    const tracked: string[] = [];
    const expanded = await expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp, track: async path => { tracked.push(path); }});
    assert.equal(dirname(expanded.directory), l.temp);
    assert.match(expanded.directory, /\/ac-verify-db-[^/]+$/);
    assert.deepEqual(tracked, [expanded.directory]);
    for (const [path, bytes] of Object.entries(contents)) assert.ok((await readFile(join(expanded.directory, path))).equals(bytes), path);
    assert.equal(await present(join(expanded.directory, '.compactado')), false);
    assert.equal((await stat(expanded.directory)).mode & 0o777, 0o755);
    assert.equal((await stat(join(expanded.directory, 'grype/6/vulnerability.db'))).mode & 0o777, 0o644);
    await expanded.release();
    assert.deepEqual(await readdir(l.temp), []);
  } finally { await l.close(); }
});

test('a corrupt archive or pack is refused and leaves nothing behind; a disk at 95% refuses the expansion', async () => {
  const l = await lab();
  try {
    await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp, freeAfter: async () => 95}), /PERSONAL_DISK_FULL/);
    assert.deepEqual(await readdir(l.temp), []);
    const archive = join(l.stamp, '.compactado/grype/6/vulnerability.db.zst');
    const bytes = await readFile(archive);
    bytes[bytes.length >> 1] ^= 0xff;
    await writeFile(archive, bytes);
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp}), /VERIFY_DB_CORRUPT/);
    assert.deepEqual(await readdir(l.temp), []);
    // A pack that no longer matches its manifest is refused as a whole.
    const pack = join(l.stamp, '.compactado/pacote.json');
    const parsed = JSON.parse(await readFile(pack, 'utf8'));
    parsed.files[0].sha256 = '0'.repeat(64);
    await writeFile(pack, JSON.stringify(parsed));
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp}), /VERIFY_DB_CORRUPT/);
    assert.match((await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn})).join('\n'), /pacote compactado inválido; preservada/);
  } finally { await l.close(); }
});

test('a stamp a live run holds keeps its originals until the run releases it; folders the host cannot write are opened once', async () => {
  const l = await lab();
  try {
    const run = randomUUID();
    await claimVerifyDatabaseStamp(l.data, l.stamp, run);
    assert.match((await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn})).join('\n'), /originais preservados enquanto um exame a usa/);
    assert.ok(await readStampPack(l.stamp));
    assert.equal(await present(join(l.stamp, 'grype/6/vulnerability.db')), true);
    await releaseVerifyDatabaseStamp(l.data, l.stamp, run);
    // The downloader's folders are read-only for the host user: the root chmod (here simulated) opens them, then the originals go.
    await chmod(join(l.stamp, 'grype/6'), 0o555);
    const spawned: (readonly string[])[] = [];
    const spawn = async (args: readonly string[]) => { spawned.push(args); await chmod(join(l.stamp, 'grype/6'), 0o777); return 0; };
    const lines = await runVerifyDatabaseRetention(l.data, true, {usedPercent: 10, image: 'sha256:' + 'b'.repeat(64), spawn});
    assert.match(lines.join('\n'), /Base 20261128-010000: compactada/);
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.includes('chmod -R a+rwX /databases'));
    assert.equal(await present(join(l.stamp, 'grype/6/vulnerability.db')), false);
  } finally { await l.close(); }
});
