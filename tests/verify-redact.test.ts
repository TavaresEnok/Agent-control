import {lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactUnknownSecrets, secretPreview} from '../src/verify-redact.ts';

const ghp = `ghp_${'a'.repeat(20)}`;
const glpat = `glpat-${'b'.repeat(20)}`;
const live = `sk_live_${'c'.repeat(24)}`;
const aiza = `AIza${'D'.repeat(35)}`;
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const url = 'https://usuario:segredo@example.com/recurso';
const pem = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7example',
  '-----END PRIVATE KEY-----',
].join('\n');
const assignments = [
  'password = "hunter2-ficticio"',
  "secret='valor-curto'",
  'token = "abc123xyz"',
  'password="sem-espaco"',
];

function mask(secret: string): string {
  const preview = secretPreview(secret);
  return `${preview.preview} (sha256:${preview.sha256})`;
}

test('ghp de 20 caracteres some e a máscara não casa de novo', async () => {
  const once = redactUnknownSecrets(ghp);
  assert.equal(once.includes(ghp), false);
  assert.equal(once, mask(ghp));
  assert.equal(redactUnknownSecrets(once), once);
  const redact = await import('../src/verify-redact.ts');
  assert.equal(typeof redact.hasKnownSecret, 'function');
  assert.equal(redact.hasKnownSecret(once), false);
  assert.equal(redact.hasKnownSecret(ghp), true);
});

test('redige url, glpat, sk_live, AIza, jwt e atribuição sem pegar a palavra token', async () => {
  const sample = [
    `antes ${url} depois`,
    glpat,
    live,
    aiza,
    jwt,
    ...assignments,
    pem,
  ].join('\n');
  const once = redactUnknownSecrets(sample);
  for (const secret of [url, glpat, live, aiza, jwt, pem, 'segredo', 'hunter2-ficticio', 'valor-curto', 'abc123xyz', 'sem-espaco']) {
    assert.equal(once.includes(secret), false, secret.slice(0, 12));
  }
  assert.equal(once.includes('example.com/recurso'), true);
  assert.equal(redactUnknownSecrets('o token ficou no texto'), 'o token ficou no texto');
  assert.equal(redactUnknownSecrets('veja https://example.com/a'), 'veja https://example.com/a');
  assert.equal(redactUnknownSecrets(once), once);
  const redact = await import('../src/verify-redact.ts');
  assert.equal(typeof redact.hasKnownSecret, 'function');
  assert.equal(redact.hasKnownSecret(once), false);
  for (const secret of [glpat, live, aiza, jwt, url, pem, assignments[0]]) {
    assert.equal(redact.hasKnownSecret(secret), true, secret.slice(0, 12));
  }
  assert.equal(redact.hasKnownSecret('o token ficou no texto'), false);
});

test('classe segredo é o basename e o stub não leva o conteúdo', async () => {
  const redact = await import('../src/verify-redact.ts');
  assert.equal(typeof redact.isSecretClassBasename, 'function');
  assert.equal(typeof redact.secretFileStub, 'function');
  assert.equal(typeof redact.replaceSecretClassFiles, 'function');
  const isSecret = redact.isSecretClassBasename as (name: string) => boolean;
  const stub = redact.secretFileStub as (relativePath: string, line?: number | null) => string;
  assert.equal(isSecret('identity.ts'), false);
  assert.equal(isSecret('id_rsa'), true);
  assert.equal(isSecret('src/id_rsa'), true);
  assert.equal(isSecret('.env'), true);
  assert.equal(isSecret('.env.local'), true);
  assert.equal(isSecret('.environment'), true);
  assert.equal(isSecret('cert.pem'), true);
  assert.equal(isSecret('server.key'), true);
  assert.equal(isSecret('notes.txt'), false);
  assert.equal(isSecret('not.id_rsa'), false);
  assert.equal(stub('.env', 2), 'nome: .env\nlinha: 2\n');
  assert.equal(stub('keys/id_rsa', null), 'nome: keys/id_rsa\n');

  const root = await mkdtemp(join(tmpdir(), 'verify-redact-'));
  const outside = await mkdtemp(join(tmpdir(), 'verify-redact-out-'));
  try {
    await writeFile(join(root, 'identity.ts'), 'export const nome = "identidade-publica";\n');
    await writeFile(join(root, '.env'), 'SENHA_ENV=super-secreto-nao-enviar\n');
    await mkdir(join(root, 'keys'));
    await writeFile(join(root, 'keys', 'id_rsa'), 'conteudo-privado-id-rsa\n');
    await writeFile(join(root, 'keys', 'id_ed25519'), 'conteudo-somente-leitura\n', {mode: 0o444});
    await writeFile(join(root, 'real.txt'), 'MANTER-REAL\n');
    await symlink(join(root, 'real.txt'), join(root, '.env.symlink'));
    await symlink('real.txt', join(root, '.env-link'));
    await writeFile(join(outside, 'id_rsa'), 'fora-do-copia\n');
    await symlink(outside, join(root, 'fora'));
    await (redact.replaceSecretClassFiles as (dir: string) => Promise<void>)(root);
    assert.equal(await readFile(join(root, 'identity.ts'), 'utf8'), 'export const nome = "identidade-publica";\n');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'nome: .env\n');
    assert.equal(await readFile(join(root, 'keys', 'id_rsa'), 'utf8'), 'nome: keys/id_rsa\n');
    assert.equal(await readFile(join(root, 'keys', 'id_ed25519'), 'utf8'), 'nome: keys/id_ed25519\n');
    assert.equal((await lstat(join(root, 'keys', 'id_ed25519'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(root, 'real.txt'), 'utf8'), 'MANTER-REAL\n');
    assert.equal((await lstat(join(root, '.env-link'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(outside, 'id_rsa'), 'utf8'), 'fora-do-copia\n');
    assert.equal((await lstat(join(root, 'fora'))).isSymbolicLink(), true);
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});
