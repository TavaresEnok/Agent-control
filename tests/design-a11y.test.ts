import assert from 'node:assert/strict';
import {test} from 'node:test';
import {axeToFindings, pa11yToFindings, staticHtmlFindings} from '../src/design-a11y.ts';
import {DESIGN_PLANTED_RULES} from '../src/design-types.ts';

const low = '<p style="color: #8a8a8a; background-color: #f4f4f4; font-size: 16px;">Texto cinza</p>';
const named = '<button type="button">Salvar</button>';
const empty = '<button type="button"></button>';

test('contraste baixo gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', low);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.contrast && item.severity === 'alta'), true);
});

test('botao com texto nao gera achado de nome', () => {
  const findings = staticHtmlFindings('tela.html', named);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton), false);
});

test('botao vazio gera a regra plantada', () => {
  const findings = staticHtmlFindings('tela.html', empty);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton && item.severity === 'alta' && item.tool === 'html'), true);
});

test('axe color-contrast vira a regra plantada', () => {
  const findings = axeToFindings('tela.html', {
    violations: [{id: 'color-contrast', impact: 'serious', help: 'Contraste', nodes: [{html: '<p>Texto</p>'}]}],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.equal(findings[0]?.severity, 'alta');
  assert.equal(findings[0]?.tool, 'axe');
});

test('pa11y de contraste vira a regra plantada', () => {
  const findings = pa11yToFindings('tela.html', [{code: 'WCAG2AA.Principle1.Guideline1_4.1_4_3', message: 'contrast', context: '<p>'}]);
  assert.equal(findings[0]?.rule, DESIGN_PLANTED_RULES.contrast);
  assert.equal(findings[0]?.tool, 'pa11y');
});
