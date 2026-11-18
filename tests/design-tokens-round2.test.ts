import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyzeDesignTokens, loadDesignReferences} from '../src/design-tokens.ts';
import {apcaLc, parseCssColor} from '../src/design-color.ts';

test('texto escuro sobre transparente não vira contraste falso', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'p', color: '#1c1c1c', backgroundColor: 'rgba(0,0,0,0)'},
  ], []);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-TOKENS-CONTRASTE'), false);
  assert.equal(analysis.summary.contrastUnmeasured, 1);
});

test('texto escuro sobre branco efetivo não gera achado de contraste', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'p', color: '#1c1c1c', backgroundColor: 'rgb(255, 255, 255)'},
  ], []);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-TOKENS-CONTRASTE'), false);
  assert.equal(analysis.summary.contrastUnmeasured, 0);
});

test('fundo com imagem não vira achado de contraste', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'p', color: '#111111', backgroundColor: 'rgb(0, 0, 0)', contrastNote: 'nao-medido'},
  ], []);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-TOKENS-CONTRASTE'), false);
});

test('contraste plantado continua medido', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'p', color: '#b0b0b0', backgroundColor: '#d0d0d0'},
  ], []);
  const finding = analysis.findings.find(item => item.rule === 'DESIGN-TOKENS-CONTRASTE');
  assert.ok(finding);
  assert.equal(finding.measure?.kind, 'contrast');
});

test('alvo abaixo de 24 e de 44 gera as duas medidas', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'button', width: '20px', height: '20px', color: '#111', backgroundColor: '#fff'},
  ], []);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-ALVO-24' && item.measure?.kind === 'target'), true);
  assert.equal(analysis.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA' && item.measure?.kind === 'target'), true);
});

test('referência com um só campo não ganha a disputa', () => {
  const analysis = analyzeDesignTokens('lab', [
    {selector: 'p', fontSize: '16px', padding: '8px', color: '#111', backgroundColor: '#fff'},
  ], [
    {id: 'so-tipo', name: 'Só tipo', source: 'teste', url: '', consulted: '', typePx: [16], spacePx: [], radiusPx: [], elevation: [], colorSteps: [], targetMinPx: null},
    {id: 'dois', name: 'Dois campos', source: 'teste', url: '', consulted: '', typePx: [16], spacePx: [8], radiusPx: [], elevation: [], colorSteps: [], targetMinPx: null},
  ]);
  assert.equal(analysis.nearest.id, 'dois');
});

test('Radix entra na paleta pelos passos de cor', () => {
  const references = loadDesignReferences(new URL('../deploy/design-references/', import.meta.url).pathname);
  const radix = references.find(item => item.id === 'radix-colors');
  assert.ok(radix);
  assert.equal(radix.colorSteps.length, 12);
  const colors = [1, 2, 3, 4, 5, 6, 7, 8].map(step => ({
    selector: 'span',
    color: `rgb(${step * 20}, ${40 + step}, ${80 + step})`,
    backgroundColor: '#ffffff',
  }));
  const analysis = analyzeDesignTokens('lab', colors, references);
  assert.equal(analysis.summary.palette.referenceSteps >= 12, true);
  assert.equal(parseCssColor('rgba(0,0,0,0)')?.a, 0);
  const black = {r: 0, g: 0, b: 0};
  const white = {r: 255, g: 255, b: 255};
  assert.ok(apcaLc(black, white) > 100);
  assert.ok(apcaLc(white, black) < -100);
});
