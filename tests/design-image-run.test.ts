import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {coverageRow, readRebuildImagePin, toolCoverageMarkdown} from '../src/design-image-run.ts';
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
