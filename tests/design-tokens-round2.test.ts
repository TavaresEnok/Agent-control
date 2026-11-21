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

test('alvo de 44px é baixa no exame e alta quando o modo criar pede', () => {
  const sample = [{selector: 'button', width: '30px', height: '30px'}];
  const normal = analyzeDesignTokens('lab', sample, []).findings.find(item => item.rule === 'DESIGN-ALVO-REFERENCIA');
  assert.equal(normal?.severity, 'baixa');
  assert.deepEqual(normal?.measure, {kind: 'target', px: 30});
  const create = analyzeDesignTokens('lab', sample, [], {referenceTargetSeverity: 'alta'}).findings.find(item => item.rule === 'DESIGN-ALVO-REFERENCIA');
  assert.equal(create?.severity, 'alta');
  assert.deepEqual(create?.measure, {kind: 'target', px: 30});
});

test('link no meio do texto fica fora das regras de alvo', () => {
  const inline = analyzeDesignTokens('lab', [{selector: 'a', width: '40px', height: '18px', inText: true}], []);
  assert.equal(inline.findings.some(item => item.rule.startsWith('DESIGN-ALVO')), false);
  const button = analyzeDesignTokens('lab', [{selector: 'button', width: '40px', height: '18px', inText: true}], []);
  assert.equal(button.findings.some(item => item.rule === 'DESIGN-ALVO-24'), true);
  assert.equal(button.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA'), true);
  const plain = analyzeDesignTokens('lab', [{selector: 'a', width: '40px', height: '18px'}], []);
  assert.equal(plain.findings.some(item => item.rule === 'DESIGN-ALVO-24'), true);
  assert.equal(plain.findings.some(item => item.rule === 'DESIGN-ALVO-REFERENCIA'), true);
});

test('acentos contam por grupo de ΔE2000 menor que 2', () => {
  const analysis = analyzeDesignTokens('lab', ['#2563eb', '#2564ea', '#2462ea', '#dc2626'].map(color => ({selector: 'span', color})), []);
  assert.equal(analysis.summary.accents, 2);
  assert.equal(analysis.summary.accentsRaw, 4);
});

test('entrelinha apertada em parágrafo vira achado baixo sem medida', () => {
  const tight = analyzeDesignTokens('lab', [{selector: 'p', fontSize: '16px', lineHeight: '20px'}], []);
  const finding = tight.findings.find(item => item.rule === 'DESIGN-TOKENS-ENTRELINHA');
  assert.ok(finding);
  assert.equal(finding.severity, 'baixa');
  assert.equal(finding.measure, undefined);
  assert.deepEqual(tight.summary.lineRatios, [1.25]);
  const loose = analyzeDesignTokens('lab', [{selector: 'p', fontSize: '16px', lineHeight: '24px'}], []);
  assert.equal(loose.findings.some(item => item.rule === 'DESIGN-TOKENS-ENTRELINHA'), false);
  const normal = analyzeDesignTokens('lab', [{selector: 'p', fontSize: '16px', lineHeight: 'normal'}], []);
  assert.equal(normal.findings.some(item => item.rule === 'DESIGN-TOKENS-ENTRELINHA'), false);
  const heading = analyzeDesignTokens('lab', [{selector: 'h1', fontSize: '32px', lineHeight: '34px'}], []);
  assert.equal(heading.findings.some(item => item.rule === 'DESIGN-TOKENS-ENTRELINHA'), false);
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
