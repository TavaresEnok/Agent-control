import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {
 agentControlPushRef, assertRemotePath, assertSshOutsideMountRoots, bindSourceReaches, confirmPersonalHost,
 fingerprintOfKey, gitSshCommand, identitiesFromKeyscan, matchConfirmedFingerprint, personalSshPaths,
 pushRefspec, removePersonalHost, shellSingleQuote, sshOptionArgs, type ScannedIdentity,
} from '../src/personal-ssh.ts';

const keyA = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const keyB = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fingerprint(key: string) {
 return 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
}
function scanned(hostField: string, key: string): ScannedIdentity {
 return {hostField, type: 'ssh-ed25519', key, fingerprint: fingerprintOfKey(key)};
}

test('remote paths refuse traversal, quotes, dollars, backticks and semicolons', () => {
 assert.equal(assertRemotePath('/home/user/proj'), '/home/user/proj');
 assert.equal(assertRemotePath('/home/user/my proj'), '/home/user/my proj');
 for (const path of ['..', '/tmp/../etc', '/home/../etc', "/tmp/'x", '/tmp/$HOME', '/tmp/`id`', '/tmp/;rm', 'relative', '/tmp/foo;', '/tmp/a\\b', '', '/'])
  assert.throws(() => assertRemotePath(path), (error: unknown) => error instanceof Refusal && error.code === 'REMOTE_PATH_FORBIDDEN');
});

test('the push refspec only accepts refs/heads/agent-control/*', () => {
 const commit = 'abcdef0123456789abcdef0123456789abcdef01';
 const ref = agentControlPushRef(commit, new Date('2026-11-12T15:30:00Z'));
 assert.equal(ref, 'refs/heads/agent-control/20261112-1530-abcdef0');
 assert.equal(pushRefspec(commit, ref), `${commit}:${ref}`);
 assert.equal(pushRefspec(commit, 'refs/heads/agent-control/task'), `${commit}:refs/heads/agent-control/task`);
 for (const bad of ['refs/heads/main', 'refs/heads/master', 'refs/heads/agent-control', 'refs/heads/agent-control/',
  'refs/heads/agent-control/../main', 'refs/tags/agent-control/task', 'refs/heads/agent-control/task:refs/heads/main', commit])
  assert.throws(() => pushRefspec(commit, bad), (error: unknown) => error instanceof Refusal && error.code === 'REMOTE_PUSH_REF_FORBIDDEN');
 assert.throws(() => pushRefspec('not-a-commit', ref), (error: unknown) => error instanceof Refusal && error.code === 'REMOTE_PUSH_REF_FORBIDDEN');
});

test('a changed server identity is refused and known_hosts keeps the confirmed key', async () => {
 const shown = fingerprint(keyA);
 assert.equal(fingerprintOfKey(keyA), shown);
 assert.notEqual(fingerprintOfKey(keyA), fingerprintOfKey(keyB));
 const fresh = identitiesFromKeyscan(`[server.example]:2222 ssh-ed25519 ${keyB}\n`, 'server.example', 2222);
 assert.throws(() => matchConfirmedFingerprint(fresh, shown), (error: unknown) => error instanceof Refusal && error.code === 'HOST_IDENTITY_MISMATCH');
 const same = identitiesFromKeyscan(`[server.example]:2222 ssh-ed25519 ${keyA}\n# comment\n`, 'server.example', 2222);
 assert.equal(matchConfirmedFingerprint(same, shown).key, keyA);
 const options = sshOptionArgs('/data/ssh/known_hosts', '/data/ssh/id_ed25519');
 assert.deepEqual(options, ['-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=/data/ssh/known_hosts',
  '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=/data/ssh/id_ed25519', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']);
 const command = gitSshCommand('/data/ssh/known_hosts', '/data/ssh/id_ed25519');
 assert.equal(command.includes('StrictHostKeyChecking=yes'), true);
 assert.equal(command.includes("UserKnownHostsFile='/data/ssh/known_hosts'"), true);
 assert.equal(command.includes("IdentityFile='/data/ssh/id_ed25519'"), true);
 const directory = await realpath(await mkdtemp(join(tmpdir(), 'ac-ssh-')));
 await chmod(directory, 0o700);
 const scan = async () => [scanned('[server.example]:2222', keyB)];
 try {
  await assert.rejects(confirmPersonalHost(directory, {host: 'server.example', port: 2222, user: 'deploy', label: 'Lab', fingerprint: shown}, scan),
   (error: unknown) => error instanceof Refusal && error.code === 'HOST_IDENTITY_MISMATCH');
  await assert.rejects(readFile(personalSshPaths(directory).knownHosts, 'utf8'), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  const saved = await confirmPersonalHost(directory, {host: 'server.example', port: 2222, user: 'deploy', label: 'Lab', fingerprint: fingerprint(keyB)},
   async () => [scanned('[server.example]:2222', keyB)]);
  assert.equal(saved.fingerprint, fingerprint(keyB));
  const lines = (await readFile(personalSshPaths(directory).knownHosts, 'utf8')).trim().split('\n');
  assert.deepEqual(lines, [`[server.example]:2222 ssh-ed25519 ${keyB}`]);
  const info = await stat(personalSshPaths(directory).knownHosts);
  assert.equal(info.mode & 0o077, 0);
  await assert.rejects(confirmPersonalHost(directory, {host: 'server.example', port: 2222, user: 'deploy', label: 'Outra', fingerprint: fingerprint(keyA)},
   async () => [scanned('[server.example]:2222', keyA)]), (error: unknown) => error instanceof Refusal && error.code === 'HOST_ALREADY_PRESENT');
  assert.equal((await readFile(personalSshPaths(directory).knownHosts, 'utf8')).includes(keyA), false);
  await removePersonalHost(directory, saved.id);
  assert.equal((await readFile(personalSshPaths(directory).knownHosts, 'utf8')).trim(), '');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'remote-hosts.json'), 'utf8')), []);
 } finally { await rm(directory, {recursive: true, force: true}); }
});

test('ssh key directory is outside the worker, tools and qa bind roots', () => {
 const data = '/var/lib/agent-control/ispagent';
 const ssh = `${data}/ssh`;
 const roots = [`${data}/native/planning-host`, `${data}/native/planning-accounts`, `${data}/native/execution-host`, `${data}/native/execution-accounts`];
 assert.doesNotThrow(() => assertSshOutsideMountRoots(ssh, roots));
 assert.equal(bindSourceReaches(ssh, `${roots[2]}/job/work`), false);
 assert.equal(bindSourceReaches(ssh, `${roots[3]}/account`), false);
 assert.equal(bindSourceReaches(ssh, ssh), true);
 assert.equal(bindSourceReaches(ssh, `${ssh}/id_ed25519`), true);
 assert.equal(bindSourceReaches(ssh, data), true);
 assert.throws(() => assertSshOutsideMountRoots(ssh, [data]), (error: unknown) => error instanceof Refusal && error.code === 'SSH_KEY_MOUNT_OVERLAP');
 assert.equal(shellSingleQuote(`/home/a b`), `'/home/a b'`);
 assert.equal(shellSingleQuote(`/home/a'b`), `'/home/a'\\''b'`);
});
