import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clampHighSeverity, designRawFinding} from '../src/design-types.ts';
import {
  WALLACE_COLORS_MAX,
  WALLACE_DUPLICATE_DECLARATIONS_MAX,
  WALLACE_FONT_FAMILIES_MAX,
  WALLACE_FONT_SIZES_MAX,
  WALLACE_IMPORTANT_MAX,
  WALLACE_SELECTORS_MEAN_MAX,
  WALLACE_SPECIFICITY_MAX,
  WALLACE_UNITS_MAX,
  WALLACE_ZINDEX_MAX,
  wallaceFindings,
} from '../src/design-wallace.ts';

const FILE = 'css/tela.css';

test('limites documentados', () => {
  assert.deepEqual(WALLACE_SPECIFICITY_MAX, [0, 3, 0]);
  assert.equal(WALLACE_FONT_SIZES_MAX, 8);
  assert.equal(WALLACE_FONT_FAMILIES_MAX, 3);
  assert.equal(WALLACE_COLORS_MAX, 16);
  assert.equal(WALLACE_SELECTORS_MEAN_MAX, 3);
  assert.equal(WALLACE_DUPLICATE_DECLARATIONS_MAX, 0);
  assert.equal(WALLACE_ZINDEX_MAX, 4);
  assert.equal(WALLACE_UNITS_MAX, 1);
  assert.equal(WALLACE_IMPORTANT_MAX, 0);
});

function atLimit(): Record<string, unknown> {
  return {
    file: 'outra.css',
    stylesheet: {size: 80000, sourceLinesOfCode: 400, complexity: 90},
    rules: {total: 40, selectors: {mean: 3, max: 40}},
    selectors: {total: 80, specificity: {max: [0, 3, 0], mean: [1, 0, 0]}},
    declarations: {
      total: 20,
      totalUnique: 20,
      importants: {total: 0, ratio: 0, inKeyframes: {total: 7}},
    },
    properties: {custom: {importants: {total: 6}}},
    values: {
      colors: {total: 40, totalUnique: 16},
      fontSizes: {total: 30, totalUnique: 8},
      fontFamilies: {total: 10, totalUnique: 3},
      zindexes: {total: 12, totalUnique: 4},
      units: {total: 50, totalUnique: 1},
    },
  };
}

test('folha abaixo de todos os limites não gera achado', () => {
  assert.deepEqual(wallaceFindings(FILE, atLimit()), []);
  assert.deepEqual(wallaceFindings(FILE, {
    selectors: {specificity: {max: [0, 2, 99], mean: [2, 0, 0]}},
    rules: {selectors: {max: 9, mean: 3}},
  }), []);
});

test('folha que estoura cada limite gera o achado wallace', () => {
  const findings = wallaceFindings(FILE, {
    file: 'outra.css',
    stylesheet: {size: 1},
    values: {
      fontSizes: {totalUnique: 9},
      fontFamilies: {totalUnique: 4},
      colors: {totalUnique: 17},
      zindexes: {totalUnique: 5},
      units: {totalUnique: 2},
    },
    selectors: {specificity: {max: [0, 3, 1], mean: [0, 0, 1]}},
    rules: {total: 1, selectors: {mean: 4, max: 4}},
    declarations: {total: 11, totalUnique: 8, importants: {total: 2}},
  });
  assert.deepEqual(findings.map(item => item.rule), [
    'DESIGN-WALLACE-FONTES',
    'DESIGN-WALLACE-FAMILIAS',
    'DESIGN-WALLACE-CORES',
    'DESIGN-WALLACE-ESPECIFICIDADE',
    'DESIGN-WALLACE-SELETORES',
    'DESIGN-WALLACE-DUPLICADAS',
    'DESIGN-WALLACE-ZINDEX',
    'DESIGN-WALLACE-UNIDADES',
    'DESIGN-WALLACE-IMPORTANT',
  ]);
  assert.deepEqual(findings.map(item => item.measure), [
    {kind: 'wallace', metric: 'fontes', value: 9},
    {kind: 'wallace', metric: 'familias', value: 4},
    {kind: 'wallace', metric: 'cores', value: 17},
    {kind: 'wallace', metric: 'especificidade', value: 1},
    {kind: 'wallace', metric: 'seletores', value: 4},
    {kind: 'wallace', metric: 'duplicadas', value: 3},
    {kind: 'wallace', metric: 'zindex', value: 5},
    {kind: 'wallace', metric: 'unidades', value: 2},
    {kind: 'wallace', metric: 'important', value: 2},
  ]);
  for (const finding of findings) {
    assert.equal(finding.tool, 'css-analyzer');
    assert.equal(finding.file, FILE);
    assert.equal(finding.severity, 'media');
    assert.equal(finding.line, null);
    assert.equal(finding.measure?.kind, 'wallace');
  }
  assert.equal(findings[0]?.snippet, '9 tamanhos de fonte');
  assert.equal(findings[3]?.snippet, 'max 0,3,1');
  assert.equal(findings[5]?.snippet, '3 declarações duplicadas');
  assert.equal(findings[8]?.snippet, '2 !important');
});

test('especificidade [0,3,0] não gera e [0,3,1], [0,4,0] e [1,0,0] geram', () => {
  assert.deepEqual(wallaceFindings(FILE, {selectors: {specificity: {max: [0, 3, 0]}}}), []);
  const justOver = wallaceFindings(FILE, {selectors: {specificity: {max: [0, 3, 1]}}});
  assert.equal(justOver.length, 1);
  assert.equal(justOver[0]?.rule, 'DESIGN-WALLACE-ESPECIFICIDADE');
  assert.equal(justOver[0]?.snippet, 'max 0,3,1');
  assert.deepEqual(justOver[0]?.measure, {kind: 'wallace', metric: 'especificidade', value: 1});
  const classOver = wallaceFindings(FILE, {selectors: {specificity: {max: [0, 4, 0]}}});
  assert.deepEqual(classOver[0]?.measure, {kind: 'wallace', metric: 'especificidade', value: 4});
  assert.equal(classOver[0]?.snippet, 'max 0,4,0');
  const idOver = wallaceFindings(FILE, {selectors: {specificity: {max: [1, 0, 0]}}});
  assert.deepEqual(idOver[0]?.measure, {kind: 'wallace', metric: 'especificidade', value: 1});
  assert.equal(idOver[0]?.snippet, 'max 1,0,0');
});

test('relatório inválido ou vazio devolve lista vazia', () => {
  assert.deepEqual(wallaceFindings(FILE, null), []);
  assert.deepEqual(wallaceFindings(FILE, undefined), []);
  assert.deepEqual(wallaceFindings(FILE, {}), []);
  assert.deepEqual(wallaceFindings(FILE, []), []);
  assert.deepEqual(wallaceFindings(FILE, ''), []);
  assert.deepEqual(wallaceFindings(FILE, 'css'), []);
  assert.deepEqual(wallaceFindings(FILE, {values: null, declarations: [], selectors: 0}), []);
});

test('medida lighthouse e wallace permanecem na alta', () => {
  const lighthouse = designRawFinding({
    tool: 'lighthouse',
    rule: 'LH-LCP',
    file: 'rota',
    severity: 'alta',
    snippet: 'LCP 4200',
    measure: {kind: 'lighthouse', metric: 'lcp', value: 4200},
  });
  assert.equal(lighthouse.severity, 'alta');
  assert.deepEqual(lighthouse.measure, {kind: 'lighthouse', metric: 'lcp', value: 4200});
  assert.equal(clampHighSeverity('alta', {kind: 'lighthouse', metric: 'cls', value: 0.3}), 'alta');
  assert.equal(clampHighSeverity('alta', {kind: 'lighthouse', metric: 'tbt', value: 0}), 'alta');
  assert.equal(clampHighSeverity('alta', {kind: 'wallace', metric: 'cores', value: 17}), 'alta');
  const bare = designRawFinding({
    tool: 'css-analyzer',
    rule: 'DESIGN-WALLACE-CORES',
    file: FILE,
    severity: 'alta',
    snippet: 'sem medida',
  });
  assert.equal(bare.severity, 'media');
  assert.equal(bare.measure, undefined);
});
