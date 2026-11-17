import assert from 'node:assert/strict';
import {test} from 'node:test';
import {focusFindingsFromCss, keyboardFindings} from '../src/design-keyboard.ts';
import {DESIGN_PLANTED_RULES} from '../src/design-types.ts';

const invisible = 'button:focus { outline: none; }\nbutton:focus-visible { outline: none; }\n';
const visible = 'button:focus-visible { outline: 2px solid #0b57d0; outline-offset: 2px; }\n';

test('foco invisivel gera a regra plantada', () => {
  const findings = focusFindingsFromCss('foco.css', invisible);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.invisibleFocus && item.severity === 'informativa' && item.tool === 'teclado'), true);
  assert.equal(findings.some(item => item.severity === 'alta'), false);
});

test('foco visivel nao gera achado', () => {
  assert.deepEqual(focusFindingsFromCss('boa.css', visible), []);
});

test('passo de teclado sem foco visivel gera a regra', () => {
  const findings = keyboardFindings('tela.html', [{
    selector: 'button', index: 0, outlineWidth: '0px', outlineStyle: 'none', visible: false, x: 10, y: 10,
  }]);
  assert.equal(findings.some(item => item.rule === DESIGN_PLANTED_RULES.invisibleFocus), true);
});

test('ordem que volta mais de 200px gera regra media', () => {
  const findings = keyboardFindings('tela.html', [
    {selector: 'a', index: 0, outlineWidth: '2px', outlineStyle: 'solid', visible: true, x: 10, y: 400},
    {selector: 'b', index: 1, outlineWidth: '2px', outlineStyle: 'solid', visible: true, x: 10, y: 40},
  ]);
  const order = findings.find(item => item.rule === 'WCAG-2-4-3-ORDEM-DO-FOCO');
  assert.equal(order?.severity, 'media');
});
