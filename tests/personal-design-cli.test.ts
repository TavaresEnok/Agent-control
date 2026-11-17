import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, symlink, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Refusal} from '../src/contracts.ts';
import {parseDesignArgs, readDesignLoginFile, readDesignRepository} from '../src/design-command.ts';
import {keepPersonalDesignLease} from '../src/personal-design-cli.ts';

const password = 'senha-que-nao-pode-vazar-9f3a';

test('a locação do comando é renovada enquanto o exame corre e um erro de renovação não derruba o processo', async () => {
  let beats = 0;
  const stop = keepPersonalDesignLease({
    async heartbeat() {
      beats += 1;
      if (beats === 1) throw new Error('lease ocupada');
    },
  }, {contextId: 'contexto'}, 20);
  await new Promise(resolve => setTimeout(resolve, 70));
  stop();
  const settled = beats;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(settled >= 2);
  assert.equal(beats, settled);
});

test('falta de argumento recusa o uso e a URL externa também', () => {
  assert.throws(() => parseDesignArgs([]), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE');
  assert.throws(() => parseDesignArgs(['instalacao.json']), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE');
  assert.throws(
    () => parseDesignArgs(['instalacao.json', randomUUID()]),
    (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE',
  );
  assert.throws(
    () => parseDesignArgs(['instalacao.json', 'nao-e-uuid', '--url', 'http://127.0.0.1:4173']),
    (error: unknown) => error instanceof Refusal && error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => parseDesignArgs(['instalacao.json', randomUUID(), '--url', 'https://example.com']),
    (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_EXTERNAL_TARGET',
  );
  const projectId = randomUUID();
  const parsed = parseDesignArgs(['instalacao.json', projectId, '--url', 'http://127.0.0.1:4173', '--login-file', 'login.json']);
  assert.equal(parsed.projectId, projectId);
  assert.equal(parsed.url, 'http://127.0.0.1:4173');
  assert.equal(parsed.loginFile, 'login.json');
  assert.equal(JSON.stringify(parsed).includes(password), false);
});

test('login mais aberto que 0600 recusa sem colocar a senha no erro', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-login-'));
  try {
    const path = join(directory, 'login.json');
    await writeFile(path, JSON.stringify({
      username: 'pessoa',
      password,
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
    }), {mode: 0o644});
    await chmod(path, 0o644);
    await assert.rejects(readDesignLoginFile(path), (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'DESIGN_LOGIN_MODE');
      assert.equal(String(error).includes(password), false);
      assert.equal(JSON.stringify(error).includes(password), false);
      return true;
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('login 0600 é aceito e a senha fica fora do objeto público', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-login-'));
  try {
    const path = join(directory, 'login.json');
    await writeFile(path, JSON.stringify({
      username: 'pessoa',
      password,
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
    }), {mode: 0o600});
    await chmod(path, 0o600);
    const opened = await readDesignLoginFile(path);
    assert.equal(opened.publicLogin.username, 'pessoa');
    assert.equal(opened.publicLogin.usernameSelector, '#user');
    assert.equal(opened.publicLogin.passwordSelector, '#pass');
    assert.equal(opened.publicLogin.submitSelector, '#go');
    assert.equal(JSON.stringify(opened.publicLogin).includes(password), false);
    assert.equal(Object.hasOwn(opened.publicLogin, 'password'), false);
    assert.equal(opened.login.password, password);
    opened.wipe();
    assert.equal(opened.login.password, '');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('o leitor do repositório ignora node_modules, .git, .env, chave e symlink para fora', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'design-repo-'));
  const outside = await mkdtemp(join(tmpdir(), 'design-fora-'));
  try {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'node_modules', 'lib'), {recursive: true});
    await mkdir(join(directory, '.git'));
    await mkdir(join(directory, '.design-captures'));
    await writeFile(join(directory, 'src', 'Tela.tsx'), 'export const tela = 1;\n', {mode: 0o644});
    await writeFile(join(directory, 'node_modules', 'lib', 'index.js'), 'module.exports = 1;\n', {mode: 0o644});
    await writeFile(join(directory, '.git', 'config'), 'segredo-git\n', {mode: 0o644});
    await writeFile(join(directory, '.env'), `SENHA=${password}\n`, {mode: 0o600});
    await writeFile(join(directory, 'src', 'id_rsa.tsx'), 'chave\n', {mode: 0o600});
    await writeFile(join(outside, 'segredo.tsx'), `export const v = '${password}';\n`, {mode: 0o644});
    await symlink(join(outside, 'segredo.tsx'), join(directory, 'src', 'fora.tsx'));
    const files = await readDesignRepository(directory);
    const paths = files.map(file => file.path).sort();
    assert.deepEqual(paths, ['src/Tela.tsx']);
    assert.equal(files.some(file => file.text.includes(password)), false);
    assert.equal(JSON.stringify(files).includes('segredo-git'), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});
