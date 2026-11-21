import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FOCUS_COVERED_RULE, focusFindingsFromCss, keyboardFindings, parseFocusWalks} from '../src/design-keyboard.ts';
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

const step = {selector: 'a.menu', index: 0, outlineWidth: '0px', outlineStyle: 'none', visible: true, covered: 0, x: 10, y: 10};

test('anel de foco feito com box-shadow não gera achado', () => {
  const findings = keyboardFindings('/a 1440 claro padrao', [{...step, boxShadow: 'rgb(11, 87, 208) 0px 0px 0px 3px'}]);
  assert.deepEqual(findings, []);
});

test('outline none sem sombra gera foco invisível, que fica informativo', () => {
  for (const boxShadow of [undefined, 'none']) {
    const findings = keyboardFindings('/a 1440 claro padrao', [{...step, ...(boxShadow === undefined ? {} : {boxShadow})}]);
    const hit = findings.find(item => item.rule === DESIGN_PLANTED_RULES.invisibleFocus);
    assert.ok(hit);
    assert.equal(hit.severity, 'informativa');
  }
});

test('foco inteiro sob elemento fixo gera 2.4.11 média; 0.4 não gera', () => {
  const ring = {outlineWidth: '2px', outlineStyle: 'solid'};
  const covered = keyboardFindings('/a 1440 claro padrao', [{...step, ...ring, covered: 1}]);
  const hit = covered.find(item => item.rule === FOCUS_COVERED_RULE);
  assert.equal(hit?.rule, 'WCAG-2-4-11-FOCO-ENCOBERTO');
  assert.equal(hit?.severity, 'media');
  assert.equal(hit?.measure, undefined);
  assert.deepEqual(keyboardFindings('/a 1440 claro padrao', [{...step, ...ring, covered: 0.4}]), []);
});

test('parseFocusWalks descarta passo malformado e respeita os limites', () => {
  const good = {selector: 'button', index: 0, outlineWidth: '2px', outlineStyle: 'solid', boxShadow: 'none', visible: true, covered: 0, x: 1, y: 2, extra: 'x'};
  const walks = parseFocusWalks([
    null,
    {file: 'sem-barra', steps: [good]},
    {file: '/vazio 1440 claro padrao', steps: [{...good, x: Number.NaN}]},
    {
      file: '/a 1440 claro padrao',
      steps: [
        good,
        {...good, index: -1},
        {...good, covered: 2},
        {...good, visible: 'sim'},
        {...good, selector: ''},
        {...good, y: Number.POSITIVE_INFINITY},
        {...good, selector: 'a'.repeat(500), outlineStyle: 'dotted\u0000'},
        ...Array.from({length: 60}, (_item, index) => ({...good, index})),
      ],
    },
  ]);
  assert.equal(walks.length, 1);
  const [walk] = walks;
  assert.equal(walk?.file, '/a 1440 claro padrao');
  assert.equal(walk?.steps.length, 35);
  assert.equal(Object.hasOwn(walk?.steps[0] ?? {}, 'extra'), false);
  assert.equal(walk?.steps[1]?.selector.length, 120);
  assert.equal(walk?.steps[1]?.outlineStyle, 'dotted');
  assert.deepEqual(parseFocusWalks('nada'), []);
  const many = parseFocusWalks(Array.from({length: 50}, (_item, index) => ({file: `/r${index} 1440 claro padrao`, steps: [good]})));
  assert.equal(many.length, 40);
  const old = parseFocusWalks([{file: '/a', steps: [{selector: 'a', index: 0, outlineWidth: '0px', outlineStyle: 'none', visible: true, x: 0, y: 0}]}]);
  assert.equal(old[0]?.steps[0]?.boxShadow, undefined);
  assert.equal(old[0]?.steps[0]?.covered, undefined);
});
