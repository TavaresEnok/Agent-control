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
    assert.match((await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn})).join('\n'), /pacote compactado inválido e sem os originais; os exames do módulo 1 com esta base são recusados \(VERIFY_DB_CORRUPT\)/);
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

test('the compaction checks the disk before each archive, counting the expansions in progress, and leaves the stamp whole when it would reach 95%', async () => {
  const l = await lab();
  try {
    // An expansion being written by this (live) process reserved 5 GB and wrote 1 KiB so far; a dead one is ignored.
    const live = join(l.temp, 'ac-verify-db-live'), dead = join(l.temp, 'ac-verify-db-dead');
    await mkdir(live); await mkdir(dead);
    await writeFile(join(live, '.reserva.json'), JSON.stringify({bytes: 5e9, pid: process.pid}));
    await writeFile(join(live, 'part'), Buffer.alloc(1024));
    await writeFile(join(dead, '.reserva.json'), JSON.stringify({bytes: 9e9, pid: 2 ** 22 + 12345}));
    const asked: number[] = [];
    const lines = await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn, tmpRoot: l.temp, freeAfter: async (_path, bytes) => { asked.push(bytes); return 95; }});
    assert.match(lines.join('\n'), /Base 20261128-010000: compactação adiada; o pacote levaria o disco a 95% ou mais \(PERSONAL_DISK_FULL\)/);
    assert.equal(asked.length, 1);
    assert.ok(asked[0]! >= PACK_MIN_BYTES + 5e9 - 1024 && asked[0]! < 6e9, String(asked[0]));
    assert.equal(await present(join(l.stamp, '.compactado')), false);
    for (const path of Object.keys(contents)) assert.equal(await present(join(l.stamp, path)), true, path);
    // Below the block the same pass goes ahead.
    assert.match((await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn, tmpRoot: l.temp, freeAfter: async () => 80})).join('\n'), /compactada \(/);
  } finally { await l.close(); }
});

test('two expansions see each other: the second counts what the first reserved and has not written yet', async () => {
  const l = await lab();
  try {
    await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    const total = Object.values(contents).reduce((sum, bytes) => sum + bytes.length, 0);
    const first = join(l.temp, 'ac-verify-db-first');
    await mkdir(first);
    await writeFile(join(first, '.reserva.json'), JSON.stringify({bytes: total, pid: process.pid}));
    const asked: number[] = [];
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp, freeAfter: async (_path, bytes) => { asked.push(bytes); return bytes > total ? 96 : 50; }}), /PERSONAL_DISK_FULL/);
    assert.deepEqual(asked, [2 * total]);
    assert.deepEqual(await readdir(l.temp), ['ac-verify-db-first']);
    await rm(first, {recursive: true});
    const expanded = await expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp, freeAfter: async (_path, bytes) => bytes > total ? 96 : 50});
    // The reservation goes once the copy is whole: it is never part of what the tools mount.
    assert.equal(await present(join(expanded.directory, '.reserva.json')), false);
    await expanded.release();
  } finally { await l.close(); }
});

test('a small file that no longer matches the manifest is refused on expansion, like an archive', async () => {
  const l = await lab();
  try {
    await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    await writeFile(join(l.stamp, 'trivy/db/metadata.json'), '{"Version":3}\n');
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp}), /VERIFY_DB_CORRUPT/);
    assert.deepEqual(await readdir(l.temp), []);
  } finally { await l.close(); }
});

test('a broken pack with every original still on the stamp: the exam mounts the checked originals and the retention rebuilds the pack', async () => {
  const l = await lab();
  try {
    const run = randomUUID();
    await claimVerifyDatabaseStamp(l.data, l.stamp, run);
    await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    assert.equal(await present(join(l.stamp, 'grype/6/vulnerability.db')), true);
    // The archive breaks at rest (truncated): its size no longer matches the pack.
    const archive = join(l.stamp, '.compactado/grype/6/vulnerability.db.zst');
    await writeFile(archive, (await readFile(archive)).subarray(0, 100));
    const mounted = await expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp});
    assert.equal(mounted.directory, l.stamp);
    assert.deepEqual(await readdir(l.temp), []);
    // An original that does not match the manifest is never mounted.
    const original = join(l.stamp, 'trivy/java-db/trivy-java.db');
    const kept = await readFile(original);
    const changed = Buffer.from(kept); changed[0] ^= 1;
    await writeFile(original, changed);
    await assert.rejects(expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp}), /VERIFY_DB_CORRUPT/);
    await writeFile(original, kept);
    await releaseVerifyDatabaseStamp(l.data, l.stamp, run);
    assert.match((await compactVerifyDatabaseStamps(l.data, false)).join('\n'), /pacote compactado inválido; os originais estão no disco e o pacote seria refeito/);
    const lines = await compactVerifyDatabaseStamps(l.data, true, {spawn: noSpawn});
    assert.match(lines.join('\n'), /o pacote é refeito[\s\S]*Base 20261128-010000: compactada \(/);
    assert.equal(await present(join(l.stamp, 'grype/6/vulnerability.db')), false);
    const expanded = await expandVerifyDatabaseStamp(l.stamp, {tmpRoot: l.temp});
    for (const [path, bytes] of Object.entries(contents)) assert.ok((await readFile(join(expanded.directory, path))).equals(bytes), path);
    await expanded.release();
  } finally { await l.close(); }
});
