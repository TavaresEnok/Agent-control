import {lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hasKnownSecret, isSecretClassBasename, redactUnknownSecrets, secretPreview} from '../src/verify-redact.ts';

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
  if (secret.length < 16) return preview.preview;
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

test('redige chave sem aspas em env, YAML e JSON e preserva a frase solta', () => {
  const bare = 'valor-client-sem-aspas';
  const upper = 'valor-client-maiusculo';
  const password = 'valor-password-sem-aspas';
  const yaml = 'valor-yaml-secreto';
  const json = 'valor-json-secreto';
  const phrase = 'o token ficou no texto';
  const sample = [
    phrase,
    `client_secret=${bare}`,
    `CLIENT_SECRET=${upper}`,
    `password=${password}`,
    `password: ${password}`,
    `client_secret: ${yaml}`,
    `{"client_secret": "${json}"}`,
    `{"client_secret":"${json}"}`,
  ].join('\n');
  const once = redactUnknownSecrets(sample);
  for (const secret of [bare, upper, password, yaml, json]) assert.equal(once.includes(secret), false, secret);
  assert.equal(once.includes(phrase), true);
  assert.equal(redactUnknownSecrets(phrase), phrase);
  assert.equal(hasKnownSecret(phrase), false);
  assert.equal(hasKnownSecret('client_secret=valor-client-sem-aspas'), true);
  assert.equal(hasKnownSecret('CLIENT_SECRET=valor-client-maiusculo'), true);
  assert.equal(hasKnownSecret('password=valor-password-sem-aspas'), true);
  assert.equal(hasKnownSecret('client_secret: valor-yaml-secreto'), true);
  assert.equal(hasKnownSecret('{"client_secret": "valor-json-secreto"}'), true);
  assert.equal(hasKnownSecret(once), false);
  assert.equal(redactUnknownSecrets(once), once);
});

test('literal JSON null, true e false depois da chave não é segredo', () => {
  const untouched = [
    '"secretPreview": null',
    '"secretPreview":null',
    '{"secretPreview": null}',
    '"password": true',
    '"token": false',
    'client_secret: null',
    'password=null',
    'password=false',
  ];
  for (const line of untouched) {
    assert.equal(redactUnknownSecrets(line), line, line);
    assert.equal(hasKnownSecret(line), false, line);
  }
  const quotedNull = '{"password": "null"}';
  assert.equal(hasKnownSecret(quotedNull), true);
  assert.equal(redactUnknownSecrets(quotedNull).includes('"null"'), false);
  const nullifier = 'password=nullifier-secreto-longo';
  assert.equal(hasKnownSecret(nullifier), true);
  assert.equal(redactUnknownSecrets(nullifier).includes('nullifier-secreto-longo'), false);
  assert.equal(hasKnownSecret('{"client_secret": "valor-json-secreto"}'), true);
  assert.equal(redactUnknownSecrets('password=valor-password-sem-aspas').includes('valor-password-sem-aspas'), false);
});

test('redige bearer, ghs, gho, npm, ASIA, rk_live, SendGrid e chave AWS sem comer sha1', () => {
  const bearerToken = 'super-token-ficticio-123';
  const ghs = `ghs_${'a'.repeat(20)}`;
  const gho = `gho_${'b'.repeat(20)}`;
  const npm = `npm_${'c'.repeat(36)}`;
  const asia = `ASIA${'D'.repeat(16)}`;
  const rk = `rk_live_${'e'.repeat(24)}`;
  const sg = `SG.${'f'.repeat(22)}.${'g'.repeat(43)}`;
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const shaUpper = '0123456789ABCDEF0123456789ABCDEF01234567';
  const mixed = `${'wJalrXUtn'.padEnd(19, 'Q')}/${'b'.repeat(20)}`;
  const plusKey = `${'n'.repeat(19)}+${'m'.repeat(20)}`;
  const letterKey = `${'A'.repeat(39)}G`;
  assert.equal(sha.length, 40);
  assert.equal(shaUpper.length, 40);
  assert.equal(mixed.length, 40);
  assert.equal(plusKey.length, 40);
  assert.equal(letterKey.length, 40);
  const assigned = `aws_secret_access_key = ${sha}`;
  const assignedEnv = `AWS_SECRET_ACCESS_KEY=${shaUpper}`;
  const assignedJson = `{"aws_secret_access_key": "${sha}"}`;
  const sample = [
    `Authorization: Bearer ${bearerToken}`,
    `authorization: bearer ${bearerToken}`,
    ghs,
    gho,
    npm,
    asia,
    rk,
    sg,
    `commit ${sha}`,
    `commit ${shaUpper}`,
    mixed,
    plusKey,
    letterKey,
    assigned,
    assignedEnv,
    assignedJson,
  ].join('\n');
  const once = redactUnknownSecrets(sample);
  for (const secret of [bearerToken, ghs, gho, npm, asia, rk, sg, mixed, plusKey, letterKey]) {
    assert.equal(once.includes(secret), false, secret.slice(0, 16));
  }
  for (const secret of [ghs, gho, npm, asia, rk, sg, mixed, plusKey, letterKey, `Authorization: Bearer ${bearerToken}`, assigned, assignedEnv, assignedJson]) {
    assert.equal(hasKnownSecret(secret), true, secret.slice(0, 24));
  }
  assert.equal(once.includes(assigned), false);
  assert.equal(once.includes(assignedEnv), false);
  assert.equal(once.includes(assignedJson), false);
  assert.equal(once.includes(`commit ${sha}`), true);
  assert.equal(once.includes(`commit ${shaUpper}`), true);
  assert.equal(redactUnknownSecrets(sha), sha);
  assert.equal(redactUnknownSecrets(shaUpper), shaUpper);
  assert.equal(hasKnownSecret(sha), false);
  assert.equal(hasKnownSecret(shaUpper), false);
  assert.equal(hasKnownSecret(once), false);
  assert.equal(redactUnknownSecrets(once), once);
});

test('sha256 fica de fora abaixo de 16 caracteres e entra em 16 ou mais', () => {
  const short = 'password=abcdeX';
  const long = 'password=abcdeXY';
  assert.equal(short.length, 15);
  assert.equal(long.length, 16);
  const shortOut = redactUnknownSecrets(short);
  const longOut = redactUnknownSecrets(long);
  assert.equal(shortOut, mask(short));
  assert.equal(shortOut.includes('sha256:'), false);
  assert.equal(shortOut.includes(short), false);
  assert.equal(shortOut.includes('abcdeX'), false);
  assert.equal(secretPreview(short).sha256, '');
  assert.equal(secretPreview('123456789012345').preview, `1234${'\u2026'}`);
  assert.equal(secretPreview('123456789012345').sha256, '');
  assert.equal(longOut, mask(long));
  assert.match(longOut, /^pass\u2026 \(sha256:[a-f0-9]{64}\)$/);
  assert.equal(longOut.includes('abcdeXY'), false);
  assert.equal(secretPreview(long).sha256.length, 64);
  assert.equal(secretPreview('1234567890123456').sha256.length, 64);
  assert.equal(hasKnownSecret(shortOut), false);
  assert.equal(hasKnownSecret(longOut), false);
  assert.equal(hasKnownSecret(short), true);
  assert.equal(redactUnknownSecrets(shortOut), shortOut);
  assert.equal(redactUnknownSecrets(longOut), longOut);
});

test('basename secreto cobre npmrc, certificados, terraform, credentials, service-account e kubeconfig', () => {
  for (const name of [
    '.npmrc', '.NPMRC', 'dir/.npmrc', '.netrc', '.pgpass',
    'cert.p12', 'cert.P12', 'a.pfx', 'a.PFX', 'store.jks', 'store.JKS',
    'terraform.tfstate', 'prod.tfvars', 'PROD.TFVARS',
    'credentials', 'credentials.json', 'CREDENTIALS.txt',
    'service-account.json', 'Service-Account-x.json', 'dir/service-account-prod.json',
    'kubeconfig', 'KUBECONFIG', '.kubeconfig', 'prod-kubeconfig.yaml', 'dir/kubeconfig',
    'id_rsa', '.env', '.env.local', 'cert.pem', 'server.key',
  ]) {
    assert.equal(isSecretClassBasename(name), true, name);
  }
  for (const name of ['identity.ts', 'notes.txt', 'not.id_rsa', 'service-account.yaml', 'my-credentials']) {
    assert.equal(isSecretClassBasename(name), false, name);
  }
});
