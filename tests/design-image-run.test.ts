// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {computedBlocksOf, coverageRow, interpretDesignImageDocument, readRebuildImagePin, toolCoverageMarkdown} from '../src/design-image-run.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import type {DesignWorker} from '../src/design-types.ts';

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

test('a tabela de cobertura não deixa campo vazio', () => {
  const row = coverageRow({tool: '', version: ' ', executed: '', findings: Number.NaN, failure: ''});
  for (const value of [row.tool, row.version, row.executed, row.findings, row.failure]) assert.notEqual(value.trim(), '');
  const markdown = toolCoverageMarkdown([row]);
  assert.match(markdown, /desconhecida/);
  assert.match(markdown, /nenhuma/);
  assert.equal(readRebuildImagePin(`sha256:${'b'.repeat(64)}`), `ac-design:reconstrucao@sha256:${'b'.repeat(64)}`);
});

test('imagem que não grava JSON vira falha na tabela e recusa o exame', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-img-fail-'));
  try {
    const projectId = randomUUID();
    const runId = randomUUID();
    await assert.rejects(
      runDesignModule({
        activation: 'personal',
        projectId,
        repo: labRoot,
        targetUrl: 'http://127.0.0.1:4173',
        dataDirectory: data,
        intentId: randomUUID(),
        runId,
        createdAt: new Date('2026-11-18T12:00:01.000Z'),
        commit: 'abc123',
        files: [{path: 'app/page.tsx', text: 'export default function Page(){return <main>oi</main>}'}],
        ...harness(),
        image: {
          pinnedImage: pin,
          run: async () => ({code: 1, stderr: 'boom'}),
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_IMAGE_FAILED',
    );
    const coverage = await readFile(join(data, 'verificacoes', projectId, '20261118-120001-design', 'cobertura-ferramentas.md'), 'utf8');
    for (const tool of ['axe-core', 'pa11y', 'lighthouse', 'stylelint', 'css-analyzer']) {
      assert.match(coverage, new RegExp(`${tool} \\| desconhecida \\| 0 \\| 0 \\| DESIGN_IMAGE_FAILED`));
    }
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('documento sem render, teclado ou blocos dá listas vazias', () => {
  for (const document of [{}, {reports: {}}, {reports: {render: 'x', keyboard: 3}, computed: 'nada'}, null]) {
    const read = interpretDesignImageDocument(document);
    assert.deepEqual(read.render, []);
    assert.deepEqual(read.keyboard, []);
    assert.deepEqual(read.computedBlocks, []);
  }
});

test('render e teclado passam pelos parsers: limites valem e NaN sai', () => {
  const read = interpretDesignImageDocument({
    reports: {
      render: [
        {file: '/a 375 claro padrao', route: '/a', viewport: 375, theme: 'claro', state: 'padrao', overflow: {px: 37, clip: false, offenders: []}},
        {route: '/a', viewport: 375, theme: 'claro', state: 'padrao', overflow: {px: Number.NaN, clip: false, offenders: []}},
        {route: '/a', viewport: Number.NaN, theme: 'claro', state: 'padrao'},
      ],
      keyboard: [
        {file: '/a 1440 claro padrao', steps: [
          {selector: 'a', index: 0, outlineWidth: '2px', outlineStyle: 'solid', visible: true, covered: 1, x: 0, y: 0},
          {selector: 'b', index: 1, outlineWidth: '2px', outlineStyle: 'solid', visible: true, covered: Number.NaN, x: 0, y: 0},
        ]},
      ],
    },
  });
  assert.equal(read.render.length, 2);
  assert.deepEqual(read.render[0]?.overflow, {px: 37, clip: false, offenders: []});
  assert.equal(read.render[1]?.overflow, undefined);
  assert.equal(read.keyboard.length, 1);
  assert.equal(read.keyboard[0]?.steps.length, 1);
});

test('o teto de 2000 amostras é dividido entre os blocos', () => {
  const sample = (index: number) => ({selector: 'p', color: `rgb(${index % 255}, 0, 0)`});
  const block = (route: string, viewport: number, count: number) => ({
    route, viewport, theme: 'claro', state: 'padrao', samples: Array.from({length: count}, (_item, index) => sample(index)),
  });
  const blocks = computedBlocksOf([
    block('/a', 375, 1500),
    block('/b', 375, 1500),
    block('/c', 1440, 10),
    {route: 'sem-barra', viewport: 375, samples: [sample(1)]},
    {route: '/d', viewport: 999, samples: [sample(1)]},
  ]);
  assert.deepEqual(blocks.map(item => [item.route, item.samples.length]), [['/a', 667], ['/b', 667], ['/c', 10]]);
  const total = blocks.reduce((sum, item) => sum + item.samples.length, 0);
  assert.ok(total <= 2000);
  const five = computedBlocksOf(Array.from({length: 5}, (_item, index) => block(`/r${index}`, 768, 900)));
  assert.deepEqual(five.map(item => item.samples.length), [400, 400, 400, 400, 400]);
  const three = computedBlocksOf(Array.from({length: 3}, (_item, index) => block(`/r${index}`, 768, 900)));
  assert.equal(three.reduce((sum, item) => sum + item.samples.length, 0), 2000);
  const read = interpretDesignImageDocument({reports: {}, computed: [block('/a', 375, 1500), block('/b', 375, 1500)]});
  assert.equal(read.computed.length, 2000);
  assert.deepEqual(read.computedBlocks.map(item => item.samples.length), [1000, 1000]);
  assert.equal(read.computedBlocks[0]?.theme, 'claro');
  assert.deepEqual(computedBlocksOf('x'), []);
});
