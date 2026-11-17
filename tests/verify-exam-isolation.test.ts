import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codexPersonalCommand} from '../src/codex-personal.ts';
import {grokProgrammerArgs} from '../src/grok-execution-adapter.ts';
import {
  describeBind, examAccountMount, examClaudeArgv, examCodexArgv, examLoginHomes, examWorkerEnv,
  installExamClaudeWrapper, prepareExamLoginCopy, stripExamHostileConfig,
} from '../src/verify-exam-isolation.ts';

async function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(bin, args, {cwd, env, stdio: ['ignore', 'inherit', 'inherit']});
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

test('o exame não executa o hook hostil e o argv não carrega mcp de projeto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-exam-hook-'));
  const marker = join(root, 'marker');
  const argvOut = join(root, 'argv.json');
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  try {
    await mkdir(join(repo, '.claude'), {recursive: true});
    const hook = `node -e "require('node:fs').writeFileSync(process.env.MARKER,'hook')"`;
    await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
      hooks: {SessionStart: [{hooks: [{type: 'command', command: hook}]}]},
    }));
    await writeFile(join(repo, 'README.md'), 'keep\n');
    const fake = join(root, 'fake-claude.cjs');
    await writeFile(fake, `#!${process.execPath}
const {existsSync, readFileSync, writeFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const {join} = require('node:path');
const argv = process.argv.slice(2);
writeFileSync(process.env.ARGV_OUT, JSON.stringify(argv));
const idx = argv.indexOf('--setting-sources');
const user = idx >= 0 && argv[idx + 1] === 'user';
const settings = join(process.cwd(), '.claude', 'settings.json');
if (!user || existsSync(settings)) {
  if (existsSync(settings)) {
    const doc = JSON.parse(readFileSync(settings, 'utf8'));
    const command = doc.hooks && doc.hooks.SessionStart && doc.hooks.SessionStart[0] && doc.hooks.SessionStart[0].hooks && doc.hooks.SessionStart[0].hooks[0] && doc.hooks.SessionStart[0].hooks[0].command;
    if (command) spawnSync(command, {shell: true, stdio: 'inherit', env: process.env});
  }
  writeFileSync(process.env.MARKER, 'executed\\n');
}
`, {mode: 0o700});
    await chmod(fake, 0o700);
    const env = {...process.env, MARKER: marker, ARGV_OUT: argvOut};
    assert.equal(await run(fake, ['--print', '--permission-mode', 'dontAsk'], repo, env), 0);
    assert.equal(await readFile(marker, 'utf8'), 'executed\n');
    await rm(marker);

    await stripExamHostileConfig(repo);
    await assert.rejects(lstat(join(repo, '.claude')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    await assert.rejects(lstat(join(repo, '.claude', 'settings.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'keep\n');

    const runnerArgv = ['--print', '--permission-mode', 'dontAsk', '--mcp-config', join(outside, 'mcp.json'), '--model', 'claude-sonnet-5-5'];
    const wrapper = await installExamClaudeWrapper(root, fake);
    assert.equal(await run(wrapper, runnerArgv, repo, env), 0);
    await assert.rejects(access(marker, constants.F_OK), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    const seen = JSON.parse(await readFile(argvOut, 'utf8')) as string[];
    assert.deepEqual(seen, examClaudeArgv(runnerArgv));
    assert.deepEqual(seen.slice(0, 2), ['--setting-sources', 'user']);
    assert.equal(seen.includes('--mcp-config'), false);
    assert.equal(seen.includes(join(outside, 'mcp.json')), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a cópia do exame perde config hostil e não segue symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-exam-strip-'));
  const outside = await mkdtemp(join(tmpdir(), 'ac-exam-outside-'));
  try {
    await mkdir(join(outside, '.claude'), {recursive: true});
    await writeFile(join(outside, '.claude', 'settings.json'), '{"hooks":true}\n');
    await writeFile(join(outside, '.mcp.json'), '{"mcp":true}\n');
    await writeFile(join(outside, 'kept.txt'), 'outside\n');
    await mkdir(join(root, '.Claude', 'hooks'), {recursive: true});
    await writeFile(join(root, '.Claude', 'settings.json'), '{}\n');
    await mkdir(join(root, 'nested', '.Codex'), {recursive: true});
    await writeFile(join(root, 'nested', '.Codex', 'config.toml'), 'sandbox_mode="danger-full-access"\n');
    await mkdir(join(root, 'nested', '.Grok'), {recursive: true});
    await writeFile(join(root, 'nested', '.Grok', 'hooks.json'), '{}\n');
    await writeFile(join(root, 'GROK.md'), 'hooks\n');
    await writeFile(join(root, 'CLAUDE.md'), 'project\n');
    await writeFile(join(root, 'CLAUDE.local.md'), 'local\n');
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'Agents.md'), 'project\n');
    await writeFile(join(root, 'docs', 'Claude.local.md'), 'nested local\n');
    await writeFile(join(root, '.mcp.json'), '{}\n');
    await writeFile(join(root, '.MCP.JSON'), '{}\n');
    await mkdir(join(root, 'lib', '.cursor'), {recursive: true});
    await writeFile(join(root, 'lib', '.cursor', 'rules'), 'x\n');
    await mkdir(join(root, '.agents'));
    await writeFile(join(root, '.agents', 'x.md'), 'a\n');
    await mkdir(join(root, 'nested', '.Agents'));
    await writeFile(join(root, 'nested', '.Agents', 'y.md'), 'b\n');
    await writeFile(join(root, 'claude.md.bak'), 'not hostile\n');
    await symlink(outside, join(root, '.codex'));
    await symlink(join(outside, 'kept.txt'), join(root, 'CLAUDE.md.link'));
    await symlink(outside, join(root, 'vendor'));
    await mkdir(join(root, 'sub'));
    await symlink(join(outside, '.claude'), join(root, 'sub', 'alias'));

    await stripExamHostileConfig(root);

    for (const path of [
      join(root, '.Claude'), join(root, 'nested', '.Codex'), join(root, 'nested', '.Codex', 'config.toml'),
      join(root, 'nested', '.Grok'), join(root, 'GROK.md'), join(root, 'CLAUDE.md'), join(root, 'docs', 'Agents.md'),
      join(root, '.mcp.json'), join(root, '.MCP.JSON'), join(root, 'lib', '.cursor'), join(root, '.codex'),
      join(root, 'CLAUDE.local.md'), join(root, 'docs', 'Claude.local.md'),
      join(root, '.agents'), join(root, '.agents', 'x.md'), join(root, 'nested', '.Agents'), join(root, 'nested', '.Agents', 'y.md'),
      join(root, 'CLAUDE.md.link'), join(root, 'vendor'), join(root, 'sub', 'alias'),
    ]) await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.equal(await readFile(join(root, 'claude.md.bak'), 'utf8'), 'not hostile\n');
    assert.equal((await lstat(join(root, 'sub'))).isDirectory(), true);
    assert.equal(await readFile(join(outside, 'kept.txt'), 'utf8'), 'outside\n');
    assert.equal(await readFile(join(outside, '.mcp.json'), 'utf8'), '{"mcp":true}\n');
    assert.equal(await readFile(join(outside, '.claude', 'settings.json'), 'utf8'), '{"hooks":true}\n');
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});

test('a origem da conta não muda e só o mount do exame é somente leitura', async () => {
  const source = await mkdtemp(join(tmpdir(), 'ac-exam-account-'));
  const tmpRoot = await mkdtemp(join(tmpdir(), 'ac-exam-tmp-'));
  const sourceLink = await mkdtemp(join(tmpdir(), 'ac-exam-account-link-'));
  try {
    const credential = join(source, '.credentials.json');
    await writeFile(credential, '{"token":"exam-login"}\n', {mode: 0o600});
    await mkdir(join(source, '.codex'), {mode: 0o700});
    await writeFile(join(source, '.codex', 'auth.json'), '{"token":"exam-login"}\n', {mode: 0o600});
    await writeFile(join(source, '.codex', 'config.toml'), 'model = "gpt-6.1-sol"\n', {mode: 0o600});
    await mkdir(join(source, '.codex', 'sessions'), {mode: 0o700});
    await writeFile(join(source, '.codex', 'sessions', 'chat.json'), '{"big":true}\n');
    await mkdir(join(source, '.grok'), {mode: 0o700});
    await writeFile(join(source, '.grok', 'auth.json'), '{"token":"grok"}\n', {mode: 0o600});
    await writeFile(join(source, '.grok', 'config.toml'), 'model = "grok-4.7"\n', {mode: 0o600});
    await mkdir(join(source, '.grok', 'sessions'), {mode: 0o700});
    await writeFile(join(source, '.grok', 'sessions', 'chat.json'), '{"big":true}\n');
    await writeFile(join(source, '.claude.json'), '{"user":"exam"}\n', {mode: 0o600});
    await mkdir(join(source, '.claude'), {mode: 0o700});
    await writeFile(join(source, '.claude', 'settings.json'), JSON.stringify({permissions: {deny: ['Bash(curl *)']}}), {mode: 0o644});
    await mkdir(join(source, '.claude', 'cache'), {mode: 0o700});
    await writeFile(join(source, '.claude', 'cache', 'blob.bin'), 'cache');
    await mkdir(join(source, 'cache'), {mode: 0o700});
    await writeFile(join(source, 'cache', 'blob.bin'), 'unrelated');
    await writeFile(join(source, 'auth.json'), '{"token":"not-a-credential-path"}\n', {mode: 0o600});
    await writeFile(join(source, 'settings.json'), JSON.stringify({
      theme: 'dark',
      permissions: {allow: ['Bash(npm test)'], deny: ['Read(./.env)']},
    }), {mode: 0o644});
    const outsideSettings = join(tmpRoot, 'linked-settings.json');
    await writeFile(outsideSettings, JSON.stringify({theme: 'from-link', secret: 'keep-out'}));
    await symlink(outsideSettings, join(sourceLink, 'settings.json'));
    const before = await readFile(credential);
    const beforeIno = (await lstat(credential)).ino;
    const copy = await prepareExamLoginCopy(source, tmpRoot);
    const homes = examLoginHomes(copy);
    assert.equal(homes.claudeConfigDir, copy);
    assert.equal(homes.grokHome, copy);
    assert.equal(homes.codexHome, join(copy, '.codex'));
    const copiedPath = join(copy, '.credentials.json');
    const copiedStat = await lstat(copiedPath);
    assert.equal(copiedStat.isSymbolicLink(), false);
    assert.notEqual(copiedStat.ino, beforeIno);
    const copied = await readFile(copiedPath);
    assert.deepEqual(copied, before);
    await writeFile(copiedPath, Buffer.concat([copied, Buffer.from([0x58])]));
    assert.deepEqual(await readFile(credential), before);
    assert.deepEqual(await readFile(join(source, '.codex', 'auth.json')), Buffer.from('{"token":"exam-login"}\n'));
    assert.equal(await readFile(join(copy, '.codex', 'auth.json'), 'utf8'), '{"token":"exam-login"}\n');
    assert.equal(await readFile(join(copy, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-6.1-sol"\n');
    assert.equal(await readFile(join(copy, '.grok', 'auth.json'), 'utf8'), '{"token":"grok"}\n');
    assert.equal(await readFile(join(copy, '.grok', 'config.toml'), 'utf8'), 'model = "grok-4.7"\n');
    assert.equal(await readFile(join(copy, '.claude.json'), 'utf8'), '{"user":"exam"}\n');
    for (const absent of [
      join(copy, 'cache', 'blob.bin'), join(copy, 'cache'), join(copy, 'auth.json'),
      join(copy, '.codex', 'sessions', 'chat.json'), join(copy, '.codex', 'sessions'),
      join(copy, '.grok', 'sessions', 'chat.json'), join(copy, '.grok', 'sessions'),
      join(copy, '.claude', 'cache', 'blob.bin'), join(copy, '.claude', 'cache'),
    ]) await assert.rejects(lstat(absent), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    const settingsStat = await lstat(join(copy, 'settings.json'));
    assert.equal(settingsStat.isSymbolicLink(), false);
    assert.equal(settingsStat.mode & 0o777, 0o600);
    const settings = JSON.parse(await readFile(join(copy, 'settings.json'), 'utf8')) as {
      theme: string; permissions: {allow: string[]; deny: string[]};
    };
    assert.equal(settings.theme, 'dark');
    assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
    assert.ok(settings.permissions.deny.includes('Read(./.env)'));
    const claudeSettingsStat = await lstat(join(copy, '.claude', 'settings.json'));
    assert.equal(claudeSettingsStat.isSymbolicLink(), false);
    assert.equal(claudeSettingsStat.mode & 0o777, 0o600);
    const claudeSettings = JSON.parse(await readFile(join(copy, '.claude', 'settings.json'), 'utf8')) as {permissions: {deny: string[]}};
    assert.ok(claudeSettings.permissions.deny.includes('Bash(curl *)'));
    for (const deny of [settings.permissions.deny, claudeSettings.permissions.deny]) {
      for (const path of [
        '/account/.credentials.json', '/tmp/ac-exam-login-*', '/tmp/ac-exam-login-*/**',
        '/proc/self/environ', '/runner', '/runner/**',
      ]) {
        for (const tool of ['Read', 'Grep', 'Glob']) {
          assert.ok(deny.includes(`${tool}(${path})`), `${tool}(${path})`);
          assert.ok(deny.includes(`${tool}(/${path})`), `${tool}(/${path})`);
        }
      }
    }
    const limit = await readFile(join(copy, 'codex-container-sandbox-limit.txt'), 'utf8');
    assert.match(limit, /Codex stays on the container sandbox/);
    for (const path of ['/account/.credentials.json', '/tmp/ac-exam-login-*', '/proc/self/environ', '/runner']) {
      assert.equal(limit.includes(path), true, path);
    }
    const linkedCopy = await prepareExamLoginCopy(sourceLink, tmpRoot);
    const linkedPath = join(linkedCopy, 'settings.json');
    const linkedStat = await lstat(linkedPath);
    assert.equal(linkedStat.isSymbolicLink(), false);
    assert.equal(linkedStat.mode & 0o777, 0o600);
    const linkedText = await readFile(linkedPath, 'utf8');
    assert.equal(linkedText.includes('from-link'), false);
    assert.equal(linkedText.includes('keep-out'), false);
    assert.equal(await readFile(outsideSettings, 'utf8'), JSON.stringify({theme: 'from-link', secret: 'keep-out'}));
    const linked = JSON.parse(linkedText) as {permissions: {deny: string[]}};
    assert.ok(linked.permissions.deny.includes('Read(/account/.credentials.json)'));
    assert.ok(linked.permissions.deny.includes('Read(//account/.credentials.json)'));
    const exam = examAccountMount(source, true);
    assert.equal(exam.writable, false);
    assert.equal(exam.destination, '/account');
    assert.equal(describeBind(exam), source + ':/account:ro');
    const normal = examAccountMount(source, false);
    assert.equal(normal.writable, true);
    assert.equal(describeBind(normal), source + ':/account:rw');
    assert.deepEqual(examWorkerEnv(['PATH=/usr/local/bin:/usr/bin:/bin'], false), ['PATH=/usr/local/bin:/usr/bin:/bin']);
    assert.deepEqual(examWorkerEnv(['PATH=/usr/local/bin:/usr/bin:/bin'], true), ['PATH=/usr/local/bin:/usr/bin:/bin', 'AC_VERIFY_EXAM=1']);
  } finally {
    await rm(source, {recursive: true, force: true});
    await rm(sourceLink, {recursive: true, force: true});
    await rm(tmpRoot, {recursive: true, force: true});
  }
});

test('o argv do Codex e do Grok no exame não aponta config de projeto', () => {
  const command = codexPersonalCommand({role: 'specialist', model: 'gpt-6.1-sol', effort: 'high', prompt: 'examine the tree', outputSchema: {type: 'object'}});
  const poisoned = [...command.args, '--config', '/work/.codex/config.toml', '/repo/.codex/config.toml'];
  const args = examCodexArgv(poisoned);
  assert.deepEqual(args, command.args);
  assert.equal(args.some(arg => /config\.toml/i.test(arg) || /(?:^|\/)\.codex(?:\/|$)/i.test(arg)), false);
  assert.ok(args.includes('-c'));
  assert.equal(args[args.indexOf('-C') + 1], '/planning');
  assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
  const savedExam = process.env.AC_VERIFY_EXAM;
  delete process.env.AC_VERIFY_EXAM;
  try {
    const plain = grokProgrammerArgs('grok-4.7', 'high', 'examine the tree', 'specialist');
    assert.equal(plain.includes('--always-approve'), true);
    process.env.AC_VERIFY_EXAM = '1';
    const grok = grokProgrammerArgs('grok-4.7', 'high', 'examine the tree', 'specialist');
    assert.equal(grok.some(arg => arg.includes('.grok') || arg.includes('GROK.md') || arg.includes('--config')), false);
    assert.equal(grok.includes('--always-approve'), false);
    assert.deepEqual(grok, ['-p', grok[1], '--model', 'grok-4.7', '--reasoning-effort', 'high', '--output-format', 'plain', '--cwd', '/planning', '--no-plan']);
    const programmer = grokProgrammerArgs('grok-4.7', 'high', 'implement the change', 'programmer');
    assert.equal(programmer[programmer.length - 1], '--always-approve');
    assert.equal(programmer[programmer.indexOf('--cwd') + 1], '/work');
  } finally {
    if (savedExam === undefined) delete process.env.AC_VERIFY_EXAM;
    else process.env.AC_VERIFY_EXAM = savedExam;
  }
});
