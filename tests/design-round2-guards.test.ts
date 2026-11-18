import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {DESIGN_IMAGE, designRunArguments} from '../src/design-image.ts';
import {executeDesignImage, toolCoverageTable, type ToolCoverageRow} from '../src/design-image-run.ts';
import {approveDesignBaseline, baselineBuffer, baselineFileName} from '../src/design-regression.ts';

const runInput = {
  image: DESIGN_IMAGE,
  repository: '/var/lib/design/repo',
  output: '/var/lib/design/out',
  targetUrl: 'http://127.0.0.1:4173',
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 128,
};

test('baselineFileName separa /a-b de /a/b pelo hash da rota', () => {
  const left = baselineFileName('/a-b', 375, 'claro', 'padrao');
  const right = baselineFileName('/a/b', 375, 'claro', 'padrao');
  const leftHash = createHash('sha256').update('/a-b').digest('hex').slice(0, 8);
  const rightHash = createHash('sha256').update('/a/b').digest('hex').slice(0, 8);
  assert.notEqual(left, right);
  assert.equal(left.includes(leftHash), true);
  assert.equal(right.includes(rightHash), true);
  assert.equal(left.includes(rightHash), false);
  assert.match(left, /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/);
  assert.match(right, /^[A-Za-z0-9][A-Za-z0-9._-]{0,140}\.png$/);
});

test('baselineBuffer recusa projectId e fileName inseguros e não lê o caminho', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-baseline-'));
  try {
    await assert.rejects(
      () => baselineBuffer(data, '../x', 'tela.png'),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
    );
    await assert.rejects(
      () => baselineBuffer(data, 'projeto', '../tela.png'),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
    );
    const name = baselineFileName('/a-b', 1440, 'escuro', 'padrao');
    await approveDesignBaseline({dataDirectory: data, projectId: 'projeto', captures: [{fileName: name, bytes: Buffer.from('png')}]});
    const read = await baselineBuffer(data, 'projeto', name);
    assert.equal(read?.equals(Buffer.from('png')), true);
    assert.equal(await baselineBuffer(data, 'projeto', 'ausente.png'), null);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('toolCoverageTable escapa pipe e quebra de linha', () => {
  const row: ToolCoverageRow = {
    tool: 'axe|core',
    version: '1\n2',
    executed: 'a|b',
    findings: '0',
    failure: 'linha\n|quebra',
  };
  const table = toolCoverageTable([row]);
  const line = table.split('\n').find(item => item.includes('axe/core'));
  assert.equal(line, '| axe/core | 1 2 | a/b | 0 | linha /quebra |');
  assert.equal(table.includes('linha\n'), false);
  assert.equal(line?.split('|').length, 7);
});

test('designRunArguments só monta o login quando loginState vem no input', () => {
  const plain = designRunArguments(runInput);
  const mounted = designRunArguments({...runInput, loginState: '/var/lib/design/login-state.json'});
  assert.equal(plain.some(item => item.includes('/login/state.json')), false);
  assert.equal(mounted.includes('type=bind,source=/var/lib/design/login-state.json,destination=/login/state.json,readonly'), true);
  assert.deepEqual(
    mounted.filter(item => item.startsWith('type=bind')),
    [...plain.filter(item => item.startsWith('type=bind')), 'type=bind,source=/var/lib/design/login-state.json,destination=/login/state.json,readonly'],
  );
  const envOf = (argv: readonly string[]) => argv.filter((item, index) => argv[index - 1] === '--env');
  assert.deepEqual(envOf(mounted), envOf(plain));
  assert.throws(
    () => designRunArguments({...runInput, loginState: '/tmp/../login.json'}),
    (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
  );
});

test('diretório temporário fica 1777 e JSON de outro uid ou symlink não é lido', async () => {
  let outputPath = '';
  let outputMode = 0;
  let capturesMode = 0;
  const foreign = await executeDesignImage({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    targetUrl: 'http://127.0.0.1:4173',
    plan: {},
    run: async (_argv, output) => {
      outputPath = output;
      outputMode = (await lstat(output)).mode & 0o7777;
      capturesMode = (await lstat(join(output, 'capturas'))).mode & 0o7777;
      await writeFile(join(output, 'achados-brutos.json'), JSON.stringify({reports: {axe: []}}), {mode: 0o644});
      await chmod(join(output, 'achados-brutos.json'), 0o644);
      return {code: 0, stderr: ''};
    },
  });
  assert.equal(outputMode, 0o1777);
  assert.equal(capturesMode, 0o1777);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'DESIGN_IMAGE_FAILED');
  assert.equal(foreign.document, null);
  await assert.rejects(() => lstat(outputPath));

  let linked = '';
  const symlinkRun = await executeDesignImage({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    targetUrl: 'http://127.0.0.1:4173',
    plan: {},
    run: async (_argv, output) => {
      linked = output;
      await writeFile(join(output, 'real.json'), JSON.stringify({reports: {axe: []}}), {mode: 0o644});
      await symlink(join(output, 'real.json'), join(output, 'achados-brutos.json'));
      return {code: 0, stderr: ''};
    },
  });
  assert.equal(symlinkRun.ok, false);
  assert.equal(symlinkRun.document, null);
  await assert.rejects(() => lstat(linked));
});

test('JSON 0666 do uid 65532 não é lido; saída diferente de 0 preserva a cobertura', async () => {
  const wide = await executeDesignImage({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    targetUrl: 'http://127.0.0.1:4173',
    plan: {},
    run: async (_argv, output) => {
      await writeContainerMode(output, JSON.stringify({reports: {axe: []}}), '666');
      return {code: 0, stderr: ''};
    },
  });
  assert.equal(wide.ok, false);
  assert.equal(wide.code, 'DESIGN_IMAGE_FAILED');
  assert.equal(wide.document, null);

  const missing = await executeDesignImage({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    targetUrl: 'http://127.0.0.1:4173',
    plan: {},
    run: async (_argv, output) => {
      await writeContainerMode(output, JSON.stringify({notes: ['sem reports']}), '644');
      return {code: 0, stderr: ''};
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DESIGN_IMAGE_FAILED');
  assert.equal(missing.coverage.length, 5);
  assert.equal(missing.coverage.every(row => row.failure === 'DESIGN_IMAGE_FAILED'), true);

  const rows: ToolCoverageRow[] = [
    {tool: 'axe-core', version: '1', executed: '1', findings: '0', failure: 'nenhuma'},
    {tool: 'pa11y', version: '1', executed: '1', findings: '0', failure: 'pa11y quebrou'},
    {tool: 'lighthouse', version: '1', executed: '1', findings: '0', failure: 'nenhuma'},
    {tool: 'stylelint', version: '1', executed: '1', findings: '0', failure: 'nenhuma'},
    {tool: 'css-analyzer', version: '1', executed: '1', findings: '0', failure: 'nenhuma'},
  ];
  const failed = await executeDesignImage({
    image: DESIGN_IMAGE,
    repository: '/var/lib/design/repo',
    targetUrl: 'http://127.0.0.1:4173',
    plan: {},
    run: async (_argv, output) => {
      await writeContainerMode(output, JSON.stringify({reports: {axe: []}, coverage: rows, notes: ['interno']}), '644');
      return {code: 2, stderr: ''};
    },
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.code, 'DESIGN_IMAGE_FAILED');
  assert.equal(failed.document !== null, true);
  assert.equal(failed.coverage.find(row => row.tool === 'axe-core')?.failure, 'nenhuma');
  assert.equal(failed.coverage.find(row => row.tool === 'pa11y')?.failure, 'pa11y quebrou');
  assert.equal(failed.coverage.filter(row => row.tool === 'axe-core').length, 1);
  assert.equal(failed.notes.some(note => note.includes('O contêiner saiu com código 2.')), true);
  assert.equal(failed.notes.some(note => note.includes('interno')), true);
});

async function writeContainerMode(directory: string, body: string, mode: '644' | '666'): Promise<void> {
  const staging = join(directory, '.host-achados.json');
  await writeFile(staging, body, {mode: 0o644});
  await chmod(staging, 0o644);
  try {
    const result = spawnSync('docker', [
      'run', '--rm', '--network', 'none', '--user', '65532:65532',
      '--entrypoint', '/bin/sh',
      '--mount', `type=bind,source=${directory},destination=/out`,
      'ac-design:reconstrucao',
      '-c', 'cp /out/.host-achados.json /out/achados-brutos.json && chmod "$1" /out/achados-brutos.json',
      'sh', mode,
    ], {encoding: 'utf8', timeout: 120_000});
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'CONTAINER_WRITE_FAILED');
  } finally {
    await rm(staging, {force: true});
  }
}
