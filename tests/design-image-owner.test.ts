import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {designBenchWorker} from '../src/design-bench.ts';
import {DESIGN_RUNTIME_BIN} from '../src/design-image.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {DESIGN_PLANTED_RULES, type DesignWorker} from '../src/design-types.ts';

const pin = `ac-design:reconstrucao@sha256:${'a'.repeat(64)}`;
const labRoot = fileURLToPath(new URL('./fixtures/design-lab/', import.meta.url));

function harness(): Pick<DesignModuleInput, 'worker' | 'reserve' | 'release'> {
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) { return bench.run(call); }};
  return {
    worker,
    reserve: async role => ({
      provider: 'claude',
      model: role,
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    }),
    release: async () => {},
  };
}

function imageDocument(): unknown {
  return {
    schema: 'design-achados-brutos-1',
    target: 'http://127.0.0.1:4173',
    findings: [],
    reports: {
      axe: [{
        file: 'app/page.tsx',
        json: {
          violations: [{
            id: 'color-contrast',
            impact: 'serious',
            help: 'contraste 2.1:1',
            nodes: [{html: '<p>', data: {contrastRatio: 2.1}}],
          }],
        },
      }],
      pa11y: [{
        file: 'app/page.tsx',
        json: [{code: 'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37', message: 'Img missing alt', context: '<img src="/foto.png">'}],
      }],
      lighthouse: [{
        file: 'app/page.tsx',
        lhr: {
          categories: {performance: {score: 0.2}, accessibility: {score: 0.5}},
          audits: {'cumulative-layout-shift': {numericValue: 0.42}, 'largest-contentful-paint': {numericValue: 5200}},
        },
      }],
      stylelint: [{
        file: 'app/page.tsx',
        report: {results: [{warnings: [{rule: 'declaration-no-important', severity: 'error', line: 4, text: 'Unexpected !important'}]}]},
      }],
    },
    computed: [],
    screenshots: [],
    coverage: [
      {tool: 'axe-core', version: '', executed: '1 rotas × 3 viewports', findings: 1, failure: ''},
      {tool: 'pa11y', version: '10.0.0', executed: '2 urls × runners axe+htmlcs', findings: 1, failure: 'nenhuma'},
      {tool: 'lighthouse', version: '13.6.0', executed: '2 corridas mobile+desktop', findings: 1, failure: 'nenhuma'},
      {tool: 'stylelint', version: '18.0.0', executed: '1 arquivos css', findings: 1, failure: 'nenhuma'},
      {tool: 'css-analyzer', version: '9.9.9', executed: '1 folhas', findings: 0, failure: 'nenhuma'},
    ],
    notes: ['Não executa código do repositório.'],
  };
}

/** O host deste teste não é o uid 65532. A imagem local grava o JSON com esse uid e modo 0644. */
async function writeContainerJson(directory: string, body: string): Promise<void> {
  const staging = join(directory, '.host-achados.json');
  await writeFile(staging, body, {mode: 0o644});
  await chmod(staging, 0o644);
  try {
    const result = spawnSync('docker', [
      'run', '--rm', '--network', 'none', '--user', '65532:65532',
      '--entrypoint', '/bin/sh',
      '--mount', `type=bind,source=${directory},destination=/out`,
      'ac-design:reconstrucao',
      '-c', 'cp /out/.host-achados.json /out/achados-brutos.json && chmod 644 /out/achados-brutos.json',
    ], {encoding: 'utf8', timeout: 120_000});
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'CONTAINER_WRITE_FAILED');
  } finally {
    await rm(staging, {force: true});
  }
}

test('runDesignModule no caminho da CLI converte o JSON da imagem e publica a cobertura', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-img-'));
  try {
    let sawArguments = false;
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo: labRoot,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T12:00:00.000Z'),
      commit: 'abc123',
      files: [{path: 'app/page.tsx', text: 'export default function Page(){return <main>oi</main>}'}],
      ...harness(),
      image: {
        pinnedImage: pin,
        run: async (argv, output) => {
          sawArguments = argv[0] === DESIGN_RUNTIME_BIN
            && argv.includes('--user')
            && argv.includes('65532:65532')
            && argv.includes('--network')
            && argv.includes('design-homologation')
            && argv.includes(pin)
            && argv.includes('--read-only');
          await writeContainerJson(output, JSON.stringify(imageDocument()));
          return {code: 0, stderr: ''};
        },
      },
    });
    assert.equal(sawArguments, true);
    const raw = JSON.parse(await readFile(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8')) as {findings: {tool: string; rule: string}[]};
    const tools = new Set(raw.findings.map(item => item.tool));
    assert.equal(tools.has('axe'), true);
    assert.equal(tools.has('pa11y'), true);
    assert.equal(tools.has('lighthouse'), true);
    assert.equal(tools.has('stylelint'), true);
    assert.equal(raw.findings.some(item => item.rule === DESIGN_PLANTED_RULES.contrast), true);
    const coverage = await readFile(join(result.directory, 'cobertura-ferramentas.md'), 'utf8');
    for (const tool of ['axe-core', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer']) assert.match(coverage, new RegExp(tool));
    assert.match(coverage, /desconhecida/);
    for (const line of coverage.split('\n').filter(item => item.startsWith('| ') && !item.includes('---'))) {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells.length, 5);
      for (const cell of cells) assert.notEqual(cell, '');
    }
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /Cobertura das ferramentas/);
    assert.match(readme, /Esta rodada executou o contêiner/);
    assert.match(readme, /não executou o contêiner/);
    const achados = JSON.parse(await readFile(join(result.directory, 'achados.json'), 'utf8')) as {achados: {reference: string; status: string}[]};
    assert.equal(achados.achados.some(item => item.reference === DESIGN_PLANTED_RULES.contrast && item.status === 'confirmado'), true);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
