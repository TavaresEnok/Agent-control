import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {designBenchWorker} from '../src/design-bench.ts';
import {assembleAchados, collectDesignGaps, filesDark, runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {DESIGN_LIMITS_TEXT} from '../src/design-report.ts';
import {DESIGN_SUGGESTION_FALLBACK, suggestionFor} from '../src/design-suggestions.ts';
import {CLICK_WITHOUT_KEYBOARD_RULE} from '../src/design-a11y.ts';
import {BRAND_RULE} from '../src/design-brand-tokens.ts';
import {CONSISTENCY_ISOLATED_RULE, HEADING_SCALE_RULE} from '../src/design-consistency.ts';
import {FOCUS_COVERED_RULE} from '../src/design-keyboard.ts';
import {DESIGN_RENDER_RULES} from '../src/design-render.ts';
import {designRawFinding, type DesignConfirmResult, type DesignExamFinding} from '../src/design-types.ts';

const labRoot = fileURLToPath(new URL('./fixtures/design-lab/', import.meta.url));

function labFiles(): {path: string; text: string}[] {
  const out: {path: string; text: string}[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push({path, text: readFileSync(path, 'utf8')});
    }
  };
  walk(labRoot);
  return out;
}

function request(dataDirectory: string, extra: Partial<DesignModuleInput> = {}): DesignModuleInput {
  const bench = designBenchWorker();
  const seat = (provider: string, model: string) => ({provider, model, accountId: randomUUID(), profileId: randomUUID()});
  return {
    activation: 'personal',
    projectId: randomUUID(),
    repo: labRoot,
    targetUrl: 'http://127.0.0.1:4173',
    dataDirectory,
    intentId: randomUUID(),
    runId: randomUUID(),
    createdAt: new Date('2026-11-17T03:04:05.000Z'),
    commit: 'abc123',
    files: labFiles(),
    worker: {async run(call) { return bench.run(call); }},
    reserve: async role => ({...(role === 'reviewer' ? seat('claude', 'revisor') : seat('claude', 'especialista')), grantId: randomUUID()}),
    release: async () => {},
    ...extra,
  };
}

const plan = {
  routes: [
    {route: '/', themes: ['claro', 'escuro'], states: ['padrao', {name: 'vazio'}]},
    {route: '/painel', themes: ['claro'], states: ['padrao']},
  ],
  viewports: [375, 1440],
};

function shot(route: string, viewport: number, theme: string, state: string) {
  return {route, viewport, theme, state};
}

const base = {
  imageRan: true,
  shots: [] as ReturnType<typeof shot>[],
  toolRows: [],
  omittedFiles: [],
  visualMissing: [],
  rawFindings: [],
  screenFiles: [],
};

test('rota sem captura dá uma linha e nenhuma de largura; estado e largura faltando entram à parte', () => {
  const gaps = collectDesignGaps({
    ...base,
    plan,
    shots: [shot('/', 375, 'claro', 'padrao'), shot('/', 1440, 'claro', 'padrao'), shot('/', 375, 'escuro', 'padrao')],
  });
  assert.deepEqual(gaps, [
    {kind: 'viewport', item: '/ 1440px escuro padrao', reason: 'sem captura'},
    {kind: 'estado', item: '/ vazio', reason: 'sem captura em nenhuma largura'},
    {kind: 'rota', item: '/painel', reason: 'nenhuma captura'},
  ]);
});

test('sem imagem há uma linha só, e a imagem que rodou não gera essa linha', () => {
  assert.deepEqual(collectDesignGaps({...base, imageRan: false, plan}), [{kind: 'ferramenta', item: 'imagem', reason: 'não executada'}]);
  const full = collectDesignGaps({
    ...base,
    plan: {routes: [{route: '/', themes: ['claro'], states: ['padrao']}], viewports: [375]},
    shots: [shot('/', 375, 'claro', 'padrao')],
  });
  assert.deepEqual(full, []);
});

test('ferramenta, arquivo, exame, visual e achado sem tela viram lacuna', () => {
  const noMeasure = designRawFinding({tool: 'stylelint', rule: 'color-no-hex', file: '/ 375 claro padrao', severity: 'baixa', snippet: 'x'});
  const onScreen = designRawFinding({tool: 'html', rule: 'X', file: 'a.html', severity: 'baixa', snippet: 'x'});
  const measured = designRawFinding({tool: 'axe', rule: 'WCAG-1-4-3-CONTRASTE', file: 'fora.html', severity: 'alta', snippet: 'x', measure: {kind: 'contrast', ratio: 2}});
  const routeDown = designRawFinding({tool: 'navegacao', rule: 'DESIGN-ROTA-INDISPONIVEL', file: '/x', severity: 'media', snippet: 'rota indisponível (404)'});
  const gaps = collectDesignGaps({
    ...base,
    toolRows: [
      {tool: 'axe-core', version: '4', executed: '6', findings: '1', failure: 'nenhuma'},
      {tool: 'lighthouse', version: '13', executed: '0', findings: '0', failure: 'nenhuma'},
      {tool: 'pa11y', version: '10', executed: '0', findings: '0', failure: 'DESIGN_TOOL_MISSING'},
      {tool: 'stylelint', version: '16', executed: '0', findings: '0', failure: 'Erro: /home/app/segredo não existe'},
    ],
    omittedFiles: ['src/Z.tsx'],
    modelCoverage: {
      examiner: {model: 'opus', requested: 4, judged: 3, failure: 'texto livre com /home/app'},
      reviewer: {model: 'opus', requested: 2, judged: 2, failure: 'nenhuma'},
    },
    visualMissing: [{route: '/', file: 'index.html'}],
    rawFindings: [noMeasure, onScreen, measured, routeDown],
    screenFiles: ['a.html'],
  });
  assert.deepEqual(gaps, [
    {kind: 'ferramenta', item: 'lighthouse', reason: 'não executou'},
    {kind: 'ferramenta', item: 'pa11y', reason: 'falhou: DESIGN_TOOL_MISSING'},
    {kind: 'ferramenta', item: 'stylelint', reason: 'falhou: EXECUTION_NATIVE_FAILED'},
    {kind: 'arquivo', item: 'src/Z.tsx', reason: 'fora do limite de 40 telas do exame'},
    {kind: 'exame', item: 'examinador opus', reason: '3 de 4 julgadas, falha EXECUTION_NATIVE_FAILED'},
    {kind: 'visual', item: '/ (index.html)', reason: 'sem crítica visual completa'},
    {kind: 'exame', item: 'achados de ferramenta', reason: '1 achados de ferramenta sem tela para conferir'},
  ]);
});

function examFinding(severity: DesignExamFinding['severity'], extra: Partial<DesignExamFinding> = {}): DesignExamFinding {
  return {
    title: `t-${severity}`,
    severity,
    file: 'a.html',
    line: 1,
    scenario: 'cenario',
    suggestion: 'corrigir',
    cwe: null,
    reference: `REF-${severity}`,
    snippet: 'x',
    ...extra,
  };
}

function confirm(status: DesignConfirmResult['status']): DesignConfirmResult {
  return {kind: 'confirmacao', status, reason: 'motivo', proof: ''};
}

test('os achados vêm numerados por gravidade e depois por situação', () => {
  const verifier = {model: 'm', provider: 'p'};
  const measuredLow = designRawFinding({tool: 'tokens', rule: 'DESIGN-ALVO-24', file: 'a.css', severity: 'baixa', snippet: 'x', measure: {kind: 'target', px: 20}});
  const achados = assembleAchados([measuredLow], [
    {finding: examFinding('baixa'), confirm: confirm('confirmado'), verifier},
    {finding: examFinding('alta', {title: 'alta descartada'}), confirm: confirm('descartado'), verifier},
    {finding: examFinding('media', {title: 'media provavel'}), confirm: confirm('provavel'), verifier},
    {finding: examFinding('alta', {title: 'alta confirmada'}), confirm: confirm('confirmado'), verifier},
    {finding: examFinding('media', {title: 'media confirmada'}), confirm: confirm('confirmado'), verifier},
  ]);
  assert.deepEqual(achados.map(item => [item.id, item.severity, item.status, item.title]), [
    ['ACH-001', 'alta', 'confirmado', 'alta confirmada'],
    ['ACH-002', 'alta', 'descartado', 'alta descartada'],
    ['ACH-003', 'media', 'confirmado', 'media confirmada'],
    ['ACH-004', 'media', 'provavel', 'media provavel'],
    ['ACH-005', 'baixa', 'confirmado', 't-baixa'],
    ['ACH-006', 'baixa', 'confirmado', 'DESIGN-ALVO-24'],
  ]);
  assert.equal(achados[5]?.basis, 'medido');
  assert.equal(achados[5]?.suggestion, suggestionFor('DESIGN-ALVO-24'));
  assert.equal(achados[0]?.basis, 'hipotese');
});

test('toAchado marca base e fontes: preferência, medida com título do examinador e julgado', () => {
  const measure = {kind: 'contrast' as const, ratio: 3.1};
  const [preference, examinerMeasured, judged] = assembleAchados([], [
    {finding: examFinding('alta', {basis: 'preferencia', severity: 'informativa'}), confirm: confirm('provavel'), verifier: null},
    {finding: examFinding('media', {measure, title: 'Contraste fraco'}), confirm: confirm('confirmado'), verifier: null},
    {finding: examFinding('baixa', {measure}), confirm: confirm('confirmado'), verifier: {model: 'm', provider: 'p'}},
  ]).sort((a, b) => a.title.localeCompare(b.title)).reverse();
  assert.ok(preference && examinerMeasured && judged);
  const byBasis = new Map([preference, examinerMeasured, judged].map(item => [item.basis, item]));
  assert.deepEqual(byBasis.get('preferencia')?.sources, ['preferencia', 'REF-alta']);
  const medido = [preference, examinerMeasured, judged].filter(item => item.basis === 'medido');
  const own = medido.find(item => item.verifier === null);
  const reviewed = medido.find(item => item.verifier !== null);
  assert.deepEqual(own?.sources, ['medida', 'REF-media', 'examinador']);
  assert.deepEqual(reviewed?.sources, ['examinador', 'REF-baixa', 'p', 'medida']);
});

test('cada regra medida tem frase própria; regra desconhecida usa o texto de antes', () => {
  for (const rule of [
    'WCAG-1-4-3-CONTRASTE', 'DESIGN-TELA-ROLAGEM-HORIZONTAL', 'DESIGN-CONTRASTE-ESTADO', 'DESIGN-ALVO-24', 'DESIGN-ALVO-REFERENCIA',
    'LH-CLS', 'LH-LCP', 'LH-TBT', 'DESIGN-WALLACE-CORES', 'ESTADOS-VAZIO-AUSENTE', 'TOKENS-CINZAS-DEMAIS',
    'DESIGN-TEXTO-CORTADO-MEDIDO', 'DESIGN-IMAGEM-QUEBRADA', 'DESIGN-TELA-ZOOM-CAMPO', 'DESIGN-TEXTO-SOBRA',
    'DESIGN-GRAFICO-SEM-ALTERNATIVA', 'DESIGN-MOVIMENTO-REDUZIDO', 'DESIGN-TITULO-REPETIDO',
    'WCAG-2-4-11-FOCO-ENCOBERTO', 'LH-VIEWPORT', 'LH-FONTE-LEGIVEL',
    'DESIGN-TOKENS-ENTRELINHA', 'WCAG-2-1-1-CLIQUE-SEM-TECLADO', 'DESIGN-TOKENS-FORA-DO-DECLARADO',
    'DESIGN-CONSISTENCIA-VALOR-ISOLADO', 'DESIGN-TITULOS-ESCALA',
  ]) {
    assert.notEqual(suggestionFor(rule), DESIGN_SUGGESTION_FALLBACK, rule);
  }
  assert.equal(suggestionFor('REGRA-NOVA'), DESIGN_SUGGESTION_FALLBACK);
  assert.equal(suggestionFor('toString'), DESIGN_SUGGESTION_FALLBACK);
});

test('toda regra nova da régua, do Tab e dos analisadores tem frase própria', () => {
  const rules = [
    ...Object.values(DESIGN_RENDER_RULES),
    FOCUS_COVERED_RULE,
    'LH-VIEWPORT',
    'LH-FONTE-LEGIVEL',
    CLICK_WITHOUT_KEYBOARD_RULE,
    'DESIGN-TOKENS-ENTRELINHA',
    BRAND_RULE,
    CONSISTENCY_ISOLATED_RULE,
    HEADING_SCALE_RULE,
    'declaration-property-value-disallowed-list',
  ];
  assert.equal(rules.length, 18);
  for (const rule of rules) assert.notEqual(suggestionFor(rule), DESIGN_SUGGESTION_FALLBACK, rule);
});

test('color-scheme só conta como escuro quando cita dark', () => {
  assert.equal(filesDark([{text: ':root { color-scheme: light; }'}]), false);
  assert.equal(filesDark([{text: ':root { color-scheme: light dark; }'}]), true);
  assert.equal(filesDark([{text: ':root{color-scheme:light}.dark-toggle{color:red}'}]), false);
  assert.equal(filesDark([{text: ':root{color-scheme:light dark}'}]), true);
  assert.equal(filesDark([{text: '@media (prefers-color-scheme: dark) {}'}]), true);
  assert.equal(filesDark([{text: '<html data-theme="x">'}]), true);
});

test('o módulo grava lacunas, limites, blocos e a comparação; todo achado medido tem frase própria', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-gaps-'));
  try {
    const first = request(data);
    const result = await runDesignModule(first);
    const readme = readFileSync(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /- imagem: não executada/);
    assert.ok(readme.includes(DESIGN_LIMITS_TEXT));
    assert.match(readme, /## Auditoria técnica/);
    assert.match(readme, /## Crítica de design/);
    assert.match(readme, /## Preferências/);
    assert.doesNotMatch(readme, /## Medido e julgado/);
    assert.match(readme, /## Desde o último relatório\n\nPrimeira rodada deste projeto\./);
    const severities = ['alta', 'media', 'baixa', 'informativa'];
    const order = result.achados.map(item => severities.indexOf(item.severity));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    result.achados.forEach((item, index) => assert.equal(item.id, `ACH-${String(index + 1).padStart(3, '0')}`));
    for (const finding of result.findings.filter(item => item.measure !== undefined)) {
      assert.notEqual(suggestionFor(finding.rule), DESIGN_SUGGESTION_FALLBACK, finding.rule);
    }
    const rawDoc = JSON.parse(readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8')) as {ferramentas?: string[]};
    assert.ok(rawDoc.ferramentas?.includes('html'));
    const second = await runDesignModule({...request(data), projectId: first.projectId, createdAt: new Date('2026-11-18T03:04:05.000Z')});
    const again = readFileSync(join(second.directory, 'README.md'), 'utf8');
    assert.match(again, /Comparado com `20261117-030405-design`/);
    assert.match(again, /- Novos: 0\n- Não apareceram: 0\n- Mantidos: [1-9]/);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
