import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {BRAND_TOOL} from '../src/design-brand-tokens.ts';
import {CONSISTENCY_TOOL} from '../src/design-consistency.ts';
import {DESIGN_DELTA_TOOLS} from '../src/design-delta.ts';
import {imageStateNotes, runDesignModule, toolsThatRan, type DesignModuleInput} from '../src/design-module.ts';
import {renderFindings} from '../src/design-render.ts';
import type {DesignRawFinding} from '../src/design-types.ts';

const files = [
  {path: 'app/page.tsx', text: 'export default function Page(){return <main><h1>Início</h1><button>Ir</button></main>}'},
  {path: 'app/painel/page.tsx', text: 'export default function Painel(){return <main><h1>Painel</h1><h2>Resumo</h2></main>}'},
];

const sample = (selector: string, extra: Record<string, string> = {}) => ({
  selector,
  color: '#111111',
  backgroundColor: '#ffffff',
  fontSize: '16px',
  padding: '8px',
  borderRadius: '4px',
  ...extra,
});

/** Duas rotas com valores comuns; /painel tem h2 maior que h1 e uma cor fora dos tokens. */
const blocks = [
  {route: '/', viewport: 1440, theme: 'claro' as const, state: 'padrao', samples: [
    sample('h1', {fontSize: '32px'}), sample('h2', {fontSize: '24px'}), sample('p'), sample('button'),
  ]},
  {route: '/painel', viewport: 1440, theme: 'claro' as const, state: 'padrao', samples: [
    sample('h1', {fontSize: '20px'}), sample('h2', {fontSize: '28px'}), sample('p', {color: '#7c3aed'}), sample('button'),
  ]},
];

const render = [
  {route: '/', viewport: 375 as const, theme: 'claro' as const, state: 'padrao', title: 'Loja',
    overflow: {px: 80, clip: false, offenders: [{sel: 'div.faixa', right: 455}]}},
  {route: '/painel', viewport: 375 as const, theme: 'claro' as const, state: 'padrao', title: 'Loja'},
];

const keyboard = [{file: '/painel 1440 claro padrao', steps: [
  {selector: 'a.menu', index: 0, outlineWidth: '2px', outlineStyle: 'solid', visible: true, covered: 1, x: 10, y: 10},
]}];

function request(repo: string, data: string, extra: Partial<DesignModuleInput> = {}): DesignModuleInput {
  const bench = designBenchWorker();
  return {
    activation: 'personal',
    projectId: randomUUID(),
    repo,
    targetUrl: 'http://127.0.0.1:4173',
    dataDirectory: data,
    intentId: randomUUID(),
    runId: randomUUID(),
    createdAt: new Date('2026-11-21T10:00:00.000Z'),
    commit: 'abc123',
    files,
    worker: {async run(call) { return bench.run(call); }},
    reserve: async role => ({provider: 'claude', model: role, accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()}),
    release: async () => {},
    tools: {render, keyboard},
    computedBlocks: blocks,
    ...extra,
  };
}

async function withDirs(run: (repo: string, data: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'ac-design-wiring-repo-'));
  const data = await mkdtemp(join(tmpdir(), 'ac-design-wiring-data-'));
  try {
    await run(repo, data);
  } finally {
    await rm(repo, {recursive: true, force: true});
    await rm(data, {recursive: true, force: true});
  }
}

async function rawOf(directory: string): Promise<{findings: DesignRawFinding[]; ferramentas: string[]}> {
  return JSON.parse(await readFile(join(directory, 'bruto', 'achados-brutos.json'), 'utf8')) as {findings: DesignRawFinding[]; ferramentas: string[]};
}

test('régua e Tab entram pelo collect e a rota vira o arquivo da tela', async () => {
  await withDirs(async (repo, data) => {
    const result = await runDesignModule(request(repo, data));
    const raw = await rawOf(result.directory);
    const scroll = raw.findings.find(item => item.tool === 'régua' && item.rule === 'DESIGN-TELA-ROLAGEM-HORIZONTAL');
    assert.equal(scroll?.file, 'app/page.tsx');
    assert.equal(scroll?.measure?.kind, 'overflow');
    // Título repetido compara as rotas: só sai com renderFindings numa chamada única.
    const titles = raw.findings.filter(item => item.rule === 'DESIGN-TITULO-REPETIDO');
    assert.equal(titles.length > 0, true, JSON.stringify(raw.findings.map(item => item.rule)));
    assert.equal(titles.every(item => item.file === 'app/page.tsx' || item.file === 'app/painel/page.tsx'), true);
    const covered = raw.findings.find(item => item.tool === 'teclado' && item.rule === 'WCAG-2-4-11-FOCO-ENCOBERTO');
    assert.equal(covered?.file, 'app/painel/page.tsx');
  });
});

test('consistência entre telas roda, atribui o achado e aparece na seção e na lista de ferramentas', async () => {
  await withDirs(async (repo, data) => {
    const result = await runDesignModule(request(repo, data));
    const raw = await rawOf(result.directory);
    const heading = raw.findings.find(item => item.tool === CONSISTENCY_TOOL && item.rule === 'DESIGN-TITULOS-ESCALA');
    assert.equal(heading?.file, 'app/painel/page.tsx');
    assert.equal(raw.ferramentas.includes(CONSISTENCY_TOOL), true);
    assert.equal(raw.ferramentas.includes(BRAND_TOOL), false);
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Consistência entre telas/);
    assert.doesNotMatch(readme, /## Tokens do projeto/);
  });
});

test('tokens do projeto: arquivo lido sem symlink, achado atribuído e ferramenta rodada mesmo sem achado', async () => {
  await withDirs(async (repo, data) => {
    await mkdir(join(repo, 'estilo'));
    await writeFile(join(repo, 'estilo', 'tokens.css'), ':root{--texto:#111111;--fundo:#ffffff;}');
    const config = {path: 'design.config.json', text: JSON.stringify({tokens: 'estilo/tokens.css'})};
    const result = await runDesignModule(request(repo, data, {files: [...files, config]}));
    const raw = await rawOf(result.directory);
    const off = raw.findings.filter(item => item.tool === BRAND_TOOL);
    assert.deepEqual(off.map(item => item.file), ['app/painel/page.tsx']);
    assert.match(off[0]?.snippet ?? '', /#7c3aed/);
    assert.equal(raw.ferramentas.includes(BRAND_TOOL), true);
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Tokens do projeto/);
    assert.match(readme, /estilo\/tokens\.css/);
  });
  await withDirs(async (repo, data) => {
    await writeFile(join(repo, 'tokens.css'), ':root{--texto:#111111;--fundo:#ffffff;--roxo:#7c3aed;}');
    const config = {path: 'design.config.json', text: JSON.stringify({tokens: 'tokens.css'})};
    const result = await runDesignModule(request(repo, data, {files: [...files, config]}));
    const raw = await rawOf(result.directory);
    assert.equal(raw.findings.some(item => item.tool === BRAND_TOOL), false);
    assert.equal(raw.ferramentas.includes(BRAND_TOOL), true);
  });
});

test('arquivo de tokens ausente, por symlink ou dentro de pasta symlink vira nota, sem achado', async () => {
  for (const setup of ['ausente', 'symlink', 'pasta-symlink'] as const) {
    await withDirs(async (repo, data) => {
      const outside = await mkdtemp(join(tmpdir(), 'ac-design-wiring-fora-'));
      try {
        await writeFile(join(outside, 'tokens.css'), ':root{--texto:#000000;}');
        if (setup === 'symlink') await symlink(join(outside, 'tokens.css'), join(repo, 'tokens.css'));
        if (setup === 'pasta-symlink') await symlink(outside, join(repo, 'estilo'));
        const path = setup === 'pasta-symlink' ? 'estilo/tokens.css' : 'tokens.css';
        const config = {path: 'design.config.json', text: JSON.stringify({tokens: path})};
        const result = await runDesignModule(request(repo, data, {files: [...files, config]}));
        const raw = await rawOf(result.directory);
        assert.equal(raw.findings.some(item => item.tool === BRAND_TOOL), false, setup);
        assert.equal(raw.ferramentas.includes(BRAND_TOOL), false, setup);
        const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
        assert.match(readme, /## Tokens do projeto/, setup);
        assert.match(readme, /não pôde ser lido\. Nada foi comparado\./, setup);
      } finally {
        await rm(outside, {recursive: true, force: true});
      }
    });
  }
});

test('modo criar usa os tokens gerados e mantém o alvo de 44px como alta; o exame comum usa baixa', async () => {
  const target = [{selector: 'button', width: '30px', height: '30px'}];
  for (const createMode of [false, true]) {
    await withDirs(async (repo, data) => {
      const result = await runDesignModule(request(repo, data, {
        computedSamples: target,
        ...(createMode
          ? {createMode: true, brandTokens: {path: 'tokens.json', text: JSON.stringify({cor: {texto: {$type: 'color', $value: '#111111'}, fundo: {$type: 'color', $value: '#ffffff'}}})}}
          : {}),
      }));
      const raw = await rawOf(result.directory);
      const alvo = raw.findings.find(item => item.rule === 'DESIGN-ALVO-REFERENCIA');
      assert.equal(alvo?.severity, createMode ? 'alta' : 'baixa');
      assert.equal(raw.findings.some(item => item.tool === BRAND_TOOL && item.file === 'app/painel/page.tsx'), createMode);
      assert.equal(raw.ferramentas.includes(BRAND_TOOL), createMode);
    });
  }
});

test('sinais de modelo genérico: seção com crítica visual ou com sinal, e a chave do config desliga', async () => {
  const gradient = {path: 'app/estilo.css', text: '.hero{background:linear-gradient(90deg,#7c3aed,#4f46e5)}'};
  await withDirs(async (repo, data) => {
    const result = await runDesignModule(request(repo, data, {files: [...files, gradient]}));
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /## Sinais de modelo genérico/);
    assert.match(readme, /É preferência, não falha\./);
    const raw = await rawOf(result.directory);
    assert.equal(raw.ferramentas.includes('generico'), false);
  });
  await withDirs(async (repo, data) => {
    const result = await runDesignModule(request(repo, data));
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /## Sinais de modelo genérico/);
  });
  await withDirs(async (repo, data) => {
    const off = {path: 'design.config.json', text: JSON.stringify({sinaisGenericos: false})};
    const result = await runDesignModule(request(repo, data, {files: [...files, gradient, off]}));
    const readme = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /## Sinais de modelo genérico/);
  });
});

test('notas de rota redirecionada e indisponível vão para Estados; as outras não', () => {
  assert.deepEqual(imageStateNotes([
    'rota /conta redirecionou para /entrar',
    'rota indisponível (tela de erro do servidor de desenvolvimento) / 375 claro padrao',
    'O contêiner saiu com código 1.',
  ]), [
    'rota /conta redirecionou para /entrar',
    'rota indisponível (tela de erro do servidor de desenvolvimento) / 375 claro padrao',
  ]);
});

test('régua e teclado contam como rodados pela linha de cobertura; análises sem achado também', () => {
  const rows = [
    {tool: 'régua', version: '1.0', executed: '12 células', findings: '0', failure: 'nenhuma'},
    {tool: 'teclado', version: '1.0', executed: '3 rotas', findings: '0', failure: 'nenhuma'},
    {tool: 'axe-core', version: '4', executed: '0', findings: '0', failure: 'nenhuma'},
  ];
  const ran = toolsThatRan([], undefined, rows, false, [], [CONSISTENCY_TOOL, BRAND_TOOL]);
  for (const tool of ['régua', 'teclado', CONSISTENCY_TOOL, BRAND_TOOL]) assert.equal(ran.includes(tool), true, tool);
  assert.equal(ran.includes('axe'), false);
});

test('a lista do delta usa os nomes reais das ferramentas novas', () => {
  const tool = renderFindings([{route: '/', viewport: 375, theme: 'claro', state: 'padrao', overflow: {px: 80, clip: false, offenders: [{sel: 'div', right: 455}]}}])[0]?.tool;
  for (const name of [tool ?? '', 'teclado', 'html', 'navegacao', BRAND_TOOL, CONSISTENCY_TOOL]) {
    assert.equal(DESIGN_DELTA_TOOLS.includes(name), true, name);
  }
});
