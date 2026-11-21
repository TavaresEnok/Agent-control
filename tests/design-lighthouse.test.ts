import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lighthouseToFindings} from '../src/design-lighthouse.ts';
import type {DesignRawFinding} from '../src/design-types.ts';

const FILE = 'telas/inicio.html';

function rulesOf(findings: readonly DesignRawFinding[]): string[] {
  return findings.map(item => item.rule);
}

test('relatório ruim gera as três regras de média e não gera alta', () => {
  const findings = lighthouseToFindings(FILE, {
    categories: {
      performance: {score: 0.42},
      accessibility: {score: 0.71},
    },
    audits: {
      'cumulative-layout-shift': {numericValue: 0.48},
      'largest-contentful-paint': {numericValue: 5400},
    },
  });
  const media = findings.filter(item => item.severity === 'media');
  assert.deepEqual(rulesOf(media), ['LH-PERFORMANCE', 'LH-CLS', 'LH-LCP']);
  assert.equal(findings.some(item => item.severity === 'alta'), false);
  const accessibility = findings.find(item => item.rule === 'LH-ACESSIBILIDADE');
  assert.ok(accessibility);
  assert.equal(accessibility.severity, 'baixa');
  assert.match(accessibility.snippet, /0\.71/);
  for (const item of findings) {
    assert.equal(item.tool, 'lighthouse');
    assert.equal(item.line, null);
    assert.equal(item.cwe, null);
    assert.equal(item.file, FILE);
    assert.notEqual(item.severity, 'alta');
  }
  assert.match(findings[0]?.snippet ?? '', /0\.42/);
  assert.match(findings[1]?.snippet ?? '', /0\.48/);
  assert.match(findings[2]?.snippet ?? '', /5400/);
});

test('relatório bom não gera achado', () => {
  const findings = lighthouseToFindings(FILE, {
    categories: {
      performance: {score: 0.99},
      accessibility: {score: 1},
    },
    audits: {
      'cumulative-layout-shift': {numericValue: 0.01},
      'largest-contentful-paint': {numericValue: 1000},
    },
  });
  assert.deepEqual(findings, []);
});

test('limiares exatos não geram achado', () => {
  const findings = lighthouseToFindings(FILE, {
    categories: {
      performance: {score: 0.5},
      accessibility: {score: 0.9},
    },
    audits: {
      'cumulative-layout-shift': {numericValue: 0.25},
      'largest-contentful-paint': {numericValue: 4000},
    },
  });
  assert.deepEqual(findings, []);
});

test('JSON ausente ou malformado devolve lista vazia', () => {
  assert.deepEqual(lighthouseToFindings(FILE, null), []);
  assert.deepEqual(lighthouseToFindings(FILE, undefined), []);
  assert.deepEqual(lighthouseToFindings(FILE, '{'), []);
  assert.deepEqual(lighthouseToFindings(FILE, '[]'), []);
  assert.deepEqual(lighthouseToFindings(FILE, []), []);
  assert.deepEqual(lighthouseToFindings(FILE, 3), []);
  assert.deepEqual(lighthouseToFindings(FILE, true), []);
  assert.deepEqual(lighthouseToFindings(FILE, {categories: null, audits: 'nao'}), []);
  assert.deepEqual(lighthouseToFindings(FILE, {
    categories: {performance: {score: 'ruim'}, accessibility: {score: null}},
    audits: {
      'cumulative-layout-shift': {numericValue: 'alto'},
      'largest-contentful-paint': {},
    },
  }), []);
});

test('texto JSON válido de um LHR ruim gera só desempenho médio', () => {
  const findings = lighthouseToFindings(FILE, JSON.stringify({
    categories: {
      performance: {score: 0.2},
      accessibility: {score: 1},
    },
    audits: {
      'cumulative-layout-shift': {numericValue: 0.01},
      'largest-contentful-paint': {numericValue: 1000},
    },
  }));
  assert.deepEqual(rulesOf(findings), ['LH-PERFORMANCE']);
  assert.equal(findings[0]?.severity, 'media');
  assert.match(findings[0]?.snippet ?? '', /0\.2/);
});

function mobileLhr(audits: Record<string, unknown>, formFactor: string | null = 'mobile'): unknown {
  return {
    configSettings: {formFactor},
    categories: {performance: {score: 0.99}, accessibility: {score: 1}},
    audits: {'cumulative-layout-shift': {numericValue: 0.01}, 'largest-contentful-paint': {numericValue: 1000}, ...audits},
  };
}

test('no celular, viewport com nota 0 dá LH-VIEWPORT média e font-size 0 dá LH-FONTE-LEGIVEL baixa', () => {
  const findings = lighthouseToFindings('/a mobile', mobileLhr({viewport: {score: 0}, 'font-size': {score: 0}}));
  assert.deepEqual(rulesOf(findings), ['LH-VIEWPORT', 'LH-FONTE-LEGIVEL']);
  assert.equal(findings[0]?.severity, 'media');
  assert.equal(findings[1]?.severity, 'baixa');
  for (const item of findings) {
    assert.equal(item.measure, undefined);
    assert.equal(item.file, '/a mobile mobile');
  }
});

test('nota nula, nota 1 ou auditoria ausente não gera viewport nem fonte', () => {
  assert.deepEqual(lighthouseToFindings('/a mobile', mobileLhr({viewport: {score: null}, 'font-size': {score: null}})), []);
  assert.deepEqual(lighthouseToFindings('/a mobile', mobileLhr({viewport: {score: 1}, 'font-size': {score: 1}})), []);
  assert.deepEqual(lighthouseToFindings('/a mobile', mobileLhr({})), []);
  assert.deepEqual(lighthouseToFindings('/a mobile', mobileLhr({viewport: 'x', 'font-size': {score: '0'}})), []);
});

test('relatório desktop não gera viewport nem fonte', () => {
  assert.deepEqual(lighthouseToFindings('/a desktop', mobileLhr({viewport: {score: 0}, 'font-size': {score: 0}}, 'desktop')), []);
  assert.deepEqual(lighthouseToFindings('/a', mobileLhr({viewport: {score: 0}, 'font-size': {score: 0}}, null)), []);
});
