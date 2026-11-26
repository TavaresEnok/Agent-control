// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {designBenchWorker} from '../src/design-bench.ts';
import {parseCreateBundle, runDesignCreate} from '../src/design-create.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {parseDesignProjectConfig, planDesignRoutes} from '../src/design-project-config.ts';
import {Refusal} from '../src/contracts.ts';
import {stageDesignReferences} from '../src/design-reference-files.ts';
import {approveDesignBaseline, comparePngBuffers} from '../src/design-regression.ts';
import {analyzeDesignTokens, loadDesignReferences} from '../src/design-tokens.ts';
import {benchVisualScores, uncertainVisualAxes} from '../src/design-visual.ts';
import {DESIGN_PLANTED_RULES, type DesignWorker} from '../src/design-types.ts';

const require = createRequire(import.meta.url);
const {PNG} = require(fileURLToPath(new URL('../deploy/design-tools/node_modules/pngjs/lib/png.js', import.meta.url))) as {
  PNG: {new (input: {width: number; height: number}): {data: Buffer; width: number; height: number}; sync: {write: (png: {data: Buffer; width: number; height: number}) => Buffer}};
};

function png(width: number, height: number, rgba: number[]): Buffer {
  const image = new PNG({width, height});
  for (let index = 0; index < width * height; index += 1) {
    image.data[index * 4] = rgba[0] ?? 0;
    image.data[index * 4 + 1] = rgba[1] ?? 0;
    image.data[index * 4 + 2] = rgba[2] ?? 0;
    image.data[index * 4 + 3] = rgba[3] ?? 255;
  }
  return PNG.sync.write(image);
}

function harness(): Pick<DesignModuleInput, 'worker' | 'reserve' | 'release'> {
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) { return bench.run(call); }};
  return {
    worker,
    reserve: async role => ({provider: 'claude', model: role, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
    release: async () => {},
  };
}

test('tokens DTCG apontam 14 tamanhos, cinzas e alvo de 30px contra 44', () => {
  const samples = [];
  for (let size = 10; size <= 23; size += 1) samples.push({selector: 'span', fontSize: `${size}px`, color: 'rgb(0,0,0)', backgroundColor: 'rgb(255,255,255)', fontFamily: 'Arial', fontWeight: '400'});
  const grays = ['#777', '#767676', '#787878', '#757575', '#797979', '#747474', '#7a7a7a', '#737373', '#7b7b7b'];
  for (const gray of grays) samples.push({selector: 'span', fontSize: '16px', color: gray, backgroundColor: '#ffffff', fontFamily: 'Georgia', fontWeight: '400'});
  samples.push({selector: 'button', width: '30px', height: '30px', fontSize: '16px', color: '#111', backgroundColor: '#fff'});
  const references = loadDesignReferences(resolve('deploy/design-references'));
  assert.ok(references.some(item => item.id === 'apple-hig' && item.targetMinPx === 44));
  const analysis = analyzeDesignTokens('lab', samples, references);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-TOKENS-TIPO-CONTAGEM' && item.measure?.kind === 'token'), true);
  assert.equal(analysis.findings.some(item => item.rule === DESIGN_PLANTED_RULES.grays && item.severity === 'alta'), true);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA' && item.measure?.kind === 'target' && item.measure.px === 30), true);
  assert.equal(typeof analysis.document.$schema, 'string');
  assert.equal(analysis.nearest.name.length > 0, true);
});

test('crítica visual diverge na tela genérica e confirma o eixo baixo', async () => {
  const generic = 'Pedido de crítica visual.\nCódigo:\nbody{background:linear-gradient(#6d28d9,#7c3aed)}.cartao{}.emoji';
  const review = generic.replace('Pedido de crítica visual.', 'Pedido de crítica visual do revisor.');
  const left = benchVisualScores(generic, 'specialist').scores;
  const right = benchVisualScores(review, 'reviewer').scores;
  const uncertain = uncertainVisualAxes(left, right);
  assert.equal(uncertain.some(item => item.startsWith('marca:')), true);
  const data = await mkdtemp(join(tmpdir(), 'design-visual-'));
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo: resolve('tests/fixtures/design-lab'),
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T15:00:00.000Z'),
      commit: 'abc123',
      files: [{path: 'app/page.tsx', text: 'export default function Page(){return <main className="cartao">Recurso</main>}\nconst tema = "linear-gradient(#6d28d9,#7c3aed)"'}],
      ...harness(),
      scoreVisual: true,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /Crítica visual/);
    assert.match(readme, /Julgamento incerto/);
    assert.equal(result.achados.some(item => item.reference === 'DESIGN-VISUAL-MARCA'), true);
    assert.equal(result.visualLow, true);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('estados sem declaração ficam como não capturado e o parâmetro sem exemplo é pulado', async () => {
  const config = parseDesignProjectConfig(JSON.stringify({routes: {'/': {states: ['vazio', 'logado'], dark: true}}}));
  const planned = planDesignRoutes({discovered: [{route: '/'}], dynamicSkipped: ['/item/:id'], config, darkInSource: false});
  assert.deepEqual(planned.planned[0]?.states, [{name: 'padrao'}]);
  assert.equal(planned.wantsLogin, true);
  assert.equal(planned.notes.some(note => note === '/: estado vazio e logado não capturado.'), true);
  assert.equal(planned.notes.some(note => note.includes('/item/:id') && note.includes('sem exemplo')), true);
  const withExample = parseDesignProjectConfig(JSON.stringify({
    routes: {
      '/': {states: ['vazio', 'logado'], dark: true},
      '/painel': {states: [], dark: true},
      '/item/:id': {example: '/item/42', states: ['erro'], dark: false},
    },
  }));
  const resolved = planDesignRoutes({
    discovered: [{route: '/'}, {route: '/painel'}],
    dynamicSkipped: ['/item/:id'],
    config: withExample,
    darkInSource: false,
  });
  assert.equal(resolved.planned.some(item => item.route === '/item/42' && item.states.every(state => state.name === 'padrao')), true);
  assert.equal(resolved.notes.some(note => note.includes('A rota /item/:id usou o exemplo /item/42')), true);
  assert.equal(resolved.notes.some(note => note === '/: estado vazio e logado não capturado.'), true);
  assert.equal(resolved.notes.some(note => note === '/item/42: estado erro não capturado.'), true);
  assert.equal(resolved.notes.some(note => note.startsWith('/painel: estado')), true);
  const data = await mkdtemp(join(tmpdir(), 'design-states-'));
  try {
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo: resolve('tests/fixtures/design-lab'),
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T15:04:00.000Z'),
      commit: 'abc123',
      files: [
        {path: 'app/page.tsx', text: 'export default function Page(){return <main>oi</main>}'},
        {path: 'design.config.json', text: '{"routes":{"/":{"states":[]}}}'},
      ],
      ...harness(),
      recordStates: true,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /não capturado/);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('o módulo lê design.config.json na raiz e não segue symlink', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'design-config-repo-'));
  const data = await mkdtemp(join(tmpdir(), 'design-config-data-'));
  const outside = await mkdtemp(join(tmpdir(), 'design-config-out-'));
  const home = '<Route path="/" />\n<Route path="/item/:id" />\nexport default function Page(){return null}\n';
  const painel = '<Route path="/painel" />\nexport default function Painel(){return null}\n';
  const config = JSON.stringify({
    routes: {
      '/': {states: ['vazio', 'carregando', 'erro', 'logado'], dark: true},
      '/painel': {states: [], dark: true},
      '/item/:id': {example: '/item/42', states: [], dark: false},
    },
  });
  try {
    await mkdir(join(repo, 'app', 'painel'), {recursive: true});
    await writeFile(join(repo, 'app', 'page.tsx'), home);
    await writeFile(join(repo, 'app', 'painel', 'page.tsx'), painel);
    await writeFile(join(repo, 'design.config.json'), config);
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T15:05:00.000Z'),
      commit: 'abc123',
      files: [{path: 'app/page.tsx', text: home}, {path: 'app/painel/page.tsx', text: painel}],
      ...harness(),
      recordStates: true,
    });
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /A rota \/item\/:id usou o exemplo \/item\/42/);
    assert.match(readme, /\/: estado vazio, carregando, erro e logado não capturado/);
    assert.match(readme, /\/painel: estado vazio, carregando, erro e logado não capturado/);
    await rm(join(repo, 'design.config.json'));
    await writeFile(join(outside, 'design.config.json'), '{"routes":{"/":{"states":["logado"]}}}');
    await symlink(join(outside, 'design.config.json'), join(repo, 'design.config.json'));
    const ignored = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:4173',
      dataDirectory: data,
      intentId: randomUUID(),
      runId: randomUUID(),
      createdAt: new Date('2026-11-18T15:06:00.000Z'),
      commit: 'abc123',
      files: [{path: 'app/page.tsx', text: home}],
      ...harness(),
      recordStates: true,
    });
    const ignoredReadme = await readFile(join(ignored.directory, 'README.md'), 'utf8');
    assert.match(ignoredReadme, /\/: estado vazio, carregando, erro e logado não capturado/);
    await rm(join(repo, 'design.config.json'));
    await writeFile(join(repo, 'design.config.json'), '{');
    await assert.rejects(
      () => runDesignModule({
        activation: 'personal',
        projectId: randomUUID(),
        repo,
        targetUrl: 'http://127.0.0.1:4173',
        dataDirectory: data,
        intentId: randomUUID(),
        runId: randomUUID(),
        createdAt: new Date('2026-11-18T15:07:00.000Z'),
        commit: 'abc123',
        files: [{path: 'app/page.tsx', text: home}],
        ...harness(),
        recordStates: true,
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CONFIG_INVALID',
    );
  } finally {
    await rm(repo, {recursive: true, force: true});
    await rm(data, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});

test('referência fica fora do repositório e a regressão mede pixelmatch', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-ref-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-repo-'));
  try {
    const bytes = png(2, 2, [10, 20, 30, 255]);
    const staged = await stageDesignReferences({dataDirectory: data, runId: randomUUID(), files: [{name: 'ref.png', bytes}], repository: repo});
    assert.equal(staged.directory.startsWith(repo), false);
    assert.equal((await stat(join(staged.directory, 'ref.png'))).mode & 0o077, 0);
    const other = png(2, 2, [250, 250, 250, 255]);
    const compared = comparePngBuffers(bytes, other, 0.1);
    assert.equal(compared.percent > 0, true);
    assert.ok(compared.diff);
    const baseline = await approveDesignBaseline({dataDirectory: data, projectId: 'projeto', captures: [{fileName: 'tela.png', bytes}]});
    assert.equal((await stat(join(baseline, 'tela.png'))).mode & 0o077, 0);
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});

test('modo criar faz a rodada, grava fora do repositório e para quando a tela melhora', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-create-'));
  const repo = resolve('tests/fixtures/design-lab');
  try {
    const worker = designBenchWorker();
    let rounds = 0;
    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: 'Uma tela calma.',
      screens: 2,
      rounds: 3,
      referenceNote: '',
      worker,
      reserve: async () => ({provider: 'claude', model: 'claude-opus-5-5', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => {
        rounds += 1;
        assert.equal(files.every(file => !file.text.includes('base64,')), true);
        const names = files.filter(file => file.path.endsWith('.html')).map(file => file.path.slice(0, -'.html'.length));
        return {
          notes: [`rodada ${round}`],
          screens: names.map(name => {
            const css = files.find(file => file.path === `${name}.css`)?.text ?? '';
            const rejected = css.includes('linear-gradient');
            return {
              name,
              rejected,
              findings: rejected ? [{tool: 'visual', rule: 'DESIGN-VISUAL-MARCA', cwe: null, file: `${name}.css`, line: 1, severity: 'media', snippet: 'gradiente', fingerprint: 'a'.repeat(64), measure: {kind: 'token', px: 32}}] : [],
              visualNotes: [],
            };
          }),
        };
      },
    });
    assert.equal(rounds, 2);
    assert.equal(created.directory.startsWith(repo), false);
    const index = await readFile(created.indexPath, 'utf8');
    assert.match(index, /Vitrine/);
    assert.match(index, /Rejeitadas/);
    assert.equal(created.rounds[0]?.rejected.includes('inicio'), true);
    assert.equal(created.rounds[1]?.approved.includes('inicio'), true);
    const bundle = parseCreateBundle(JSON.parse(await worker.run({
      role: 'specialist', provider: 'claude', accountId: randomUUID(), profileId: randomUUID(), model: 'm', grantId: randomUUID(), intentId: randomUUID(), task: 'Pedido de criação.', repo, writePaths: [],
    })), 2);
    assert.ok(bundle);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
