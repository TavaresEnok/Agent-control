import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectDesignFindings, DESIGN_RAW_SCHEMA, designRawDocument} from '../src/design-collect.ts';
import {DESIGN_PLANTED_RULES} from '../src/design-types.ts';

const contrast = '<p style="color: #8a8a8a; background-color: #f4f4f4; font-size: 16px;">Texto</p>';
const named = '<button type="button">Salvar</button>';
const emptyButton = '<button type="button"></button>';
const goodCss = [
  'body { color: #1a1a1a; background-color: #ffffff; margin: 8px; padding: 16px; width: 100%; max-width: 720px; }',
  'button:focus-visible { outline: 2px solid #0b57d0; outline-offset: 2px; }',
].join('\n');
const focusCss = 'button:focus { outline: none; } button:focus-visible { outline: none; }';

test('coleta estática marca a régua e poupa a folha correta', () => {
  const findings = collectDesignFindings([
    {path: 'html/contraste.html', text: contrast},
    {path: 'html/botao.html', text: emptyButton},
    {path: 'html/boa.html', text: named},
    {path: 'css/foco.css', text: focusCss},
    {path: 'css/boa.css', text: goodCss},
    {path: 'src/Itens.tsx', text: '<ul data-list>{items.map(item => <li>{item}</li>)}</ul>'},
    {path: 'src/Boa.tsx', text: '<p>Tudo certo</p>'},
  ]);
  const rules = (file: string) => findings.filter(item => item.file === file).map(item => item.rule);
  assert.ok(rules('html/contraste.html').includes(DESIGN_PLANTED_RULES.contrast));
  assert.ok(rules('html/botao.html').includes(DESIGN_PLANTED_RULES.unlabeledButton));
  assert.ok(rules('css/foco.css').includes(DESIGN_PLANTED_RULES.invisibleFocus));
  assert.ok(rules('src/Itens.tsx').includes(DESIGN_PLANTED_RULES.empty));
  assert.equal(findings.some(item => item.file === 'html/boa.html' && item.severity === 'alta'), false);
  assert.equal(findings.some(item => item.file === 'css/boa.css' && item.severity === 'alta'), false);
  assert.equal(findings.some(item => item.file === 'src/Boa.tsx' && item.severity === 'alta'), false);
  for (const finding of findings) {
    assert.equal(finding.cwe, null);
    assert.equal(finding.fingerprint.length, 64);
  }
});

test('converte axe, pa11y, lighthouse, stylelint e teclado sem promover gosto a alta', () => {
  const findings = collectDesignFindings([], {
    axe: [{file: 'tela.html', json: {violations: [{id: 'color-contrast', impact: 'serious', help: 'contraste', nodes: [{html: 'color:#777'}]}]}}],
    pa11y: [{file: 'tela.html', json: [{code: 'WCAG2AA.Principle1.Guideline1_4.1_4_3', message: 'contrast', context: '<p>'}]}],
    lighthouse: [{file: 'tela.html', lhr: {categories: {performance: {score: 0.2}, accessibility: {score: 0.4}}, audits: {'cumulative-layout-shift': {numericValue: 0.4}, 'largest-contentful-paint': {numericValue: 5000}}}}],
    stylelint: [{file: 'tela.css', report: {results: [{warnings: [{rule: 'block-no-empty', text: 'bloco vazio', line: 3, severity: 'warning'}]}]}}],
    keyboard: [{file: 'tela.html', steps: [{selector: 'button', index: 0, outlineWidth: '0px', outlineStyle: 'none', visible: false, x: 0, y: 10}]}],
  });
  assert.ok(findings.some(item => item.tool === 'axe' && item.rule === DESIGN_PLANTED_RULES.contrast && item.severity === 'alta'));
  assert.ok(findings.some(item => item.tool === 'pa11y' && item.severity === 'alta'));
  assert.ok(findings.some(item => item.tool === 'lighthouse' && item.rule === 'LH-PERFORMANCE' && item.severity === 'media'));
  assert.equal(findings.some(item => item.tool === 'lighthouse' && item.severity === 'alta'), false);
  assert.ok(findings.some(item => item.tool === 'stylelint' && item.severity === 'baixa'));
  assert.equal(findings.some(item => item.tool === 'stylelint' && item.severity === 'alta'), false);
  assert.ok(findings.some(item => item.tool === 'teclado' && item.rule === DESIGN_PLANTED_RULES.invisibleFocus));
  const document = designRawDocument('http://127.0.0.1:4173', findings);
  assert.equal(document.schema, DESIGN_RAW_SCHEMA);
  assert.equal(document.findings.length, findings.length);
});
