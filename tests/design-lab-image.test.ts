import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {readDesignRepository} from '../src/design-command.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {readRebuildImagePin} from '../src/design-image-run.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {DESIGN_PLANTED_RULES, type DesignWorker} from '../src/design-types.ts';

const labRoot = fileURLToPath(new URL('./fixtures/design-lab-v2/', import.meta.url));
const enabled = process.env.AC_DESIGN_LAB === '1';

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

test('a imagem real encontra os defeitos plantados do laboratório', {skip: !enabled}, async () => {
  const pin = readRebuildImagePin(await readFile(new URL('../deploy/design-image-digest.txt', import.meta.url), 'utf8'));
  const files = await readDesignRepository(labRoot);
  const data = await mkdtemp(join(tmpdir(), 'design-lab-v2-'));
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo: labRoot,
      targetUrl: 'http://design-lab.local:8080',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T18:00:00.000Z'),
      commit: 'lab',
      files,
      ...harness(),
      image: {pinnedImage: pin, timeoutMs: 1_800_000},
      scoreVisual: true,
      recordStates: true,
      regressionThreshold: 0.1,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    const raw = await readFile(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8');
    const coverage = await readFile(join(result.directory, 'cobertura-ferramentas.md'), 'utf8');
    const parsed = JSON.parse(raw) as {findings: {tool: string; rule: string; severity: string; snippet: string; measure?: {kind?: string; px?: number}}[]};
    const rules = parsed.findings.map(item => `${item.tool} ${item.rule} ${item.severity} ${item.snippet}`);
    await writeFile('/tmp/design-lab-summary.json', JSON.stringify({
      directory: result.directory,
      coverage,
      readmeExcerpt: readme.slice(0, 12000),
      rules,
      achados: result.achados.map(item => ({id: item.id, reference: item.reference, status: item.status, severity: item.severity})),
    }, null, 2));
    const has = (tool: string, rule: string) => parsed.findings.some(item => item.tool === tool && item.rule.includes(rule));
    assert.equal(has('axe', 'WCAG-1-4-3-CONTRASTE') || has('axe', DESIGN_PLANTED_RULES.contrast), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.tool === 'pa11y' && /alt|image-alt|H37/i.test(item.rule + item.snippet)), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.tool === 'lighthouse' && (item.rule === 'LH-CLS' || item.rule === 'LH-LCP')), true, rules.join('\n'));
    assert.equal(has('stylelint', 'declaration-no-important'), true, rules.join('\n'));
    assert.equal(has('tokens', 'DESIGN-TOKENS-TIPO-CONTAGEM'), true, rules.join('\n'));
    assert.equal(has('tokens', DESIGN_PLANTED_RULES.grays), true, rules.join('\n'));
    assert.equal(parsed.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA' && item.measure?.kind === 'target' && item.measure.px === 30), true, rules.join('\n'));
    assert.match(readme, /Crítica visual/);
    assert.match(readme, /Julgamento incerto/);
    assert.match(readme, /A rota \/item\/:id usou o exemplo \/item\/42/);
    assert.match(readme, /\/painel: estado vazio, carregando, erro e logado não capturado/);
    assert.doesNotMatch(readme, /\/: estado vazio, carregando, erro e logado não capturado/);
    assert.match(readme, /Esta rodada executou o contêiner/);
    assert.match(coverage, /3 rotas/);
    const imageDoc = JSON.parse(await readFile(join(result.directory, 'imagem-achados-brutos.json'), 'utf8')) as {
      screenshots?: {route?: string; state?: string}[];
    };
    const shots = imageDoc.screenshots ?? [];
    assert.equal(shots.some(item => item.route === '/' && item.state === 'logado'), true);
    assert.equal(shots.some(item => item.route === '/' && item.state === 'vazio'), true);
    assert.equal(shots.some(item => item.route === '/item/42' && item.state === 'padrao'), true);
    for (const line of coverage.split('\n')) {
      if (!line.startsWith('|') || line.startsWith('| Ferramenta') || line.startsWith('|---')) continue;
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells.length, 5, line);
      for (const cell of cells) assert.notEqual(cell, '');
    }
    assert.match(coverage, /axe-core/);
    assert.match(coverage, /css-analyzer/);
    assert.equal(result.achados.some(item => item.reference.includes('WCAG') || item.reference.startsWith('DESIGN-')), true);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
