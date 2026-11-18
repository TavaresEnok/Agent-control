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
