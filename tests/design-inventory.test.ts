import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  inventoryFindingsFromCss,
  inventoryFromComputed,
  inventoryFromCss,
  inventoryFromCssAnalyzer,
} from '../src/design-inventory.ts';
import {
  DESIGN_FIXED_WIDTH_PX,
  DESIGN_GRAY_MIN,
  DESIGN_OFFSCALE_SPACING_MIN,
  DESIGN_PLANTED_RULES,
} from '../src/design-types.ts';

const CORRECT_CSS = [
  '.pagina {',
  '  color: #1a1a1a;',
  '  background: #ffffff;',
  '  margin: 8px 16px;',
  '  padding: 8px 16px;',
  '  width: 100%;',
  '  max-width: 720px;',
  '}',
  '.suave { color: #5c5c5c; }',
  '.acento { color: #0b57d0; }',
  ':focus-visible { outline: 2px solid #0b57d0; }',
].join('\n');

function grayCss(colors: readonly string[]): string {
  return colors.map((color, index) => `.g${index} { color: ${color}; }`).join('\n');
}

test('constantes da régua', () => {
  assert.equal(DESIGN_GRAY_MIN, 8);
  assert.equal(DESIGN_OFFSCALE_SPACING_MIN, 4);
  assert.equal(DESIGN_FIXED_WIDTH_PX, 400);
  assert.equal(DESIGN_PLANTED_RULES.grays, 'TOKENS-CINZAS-DEMAIS');
  assert.equal(DESIGN_PLANTED_RULES.spacing, 'TOKENS-ESPACAMENTO');
  assert.equal(DESIGN_PLANTED_RULES.narrow, 'TELA-375-QUEBRADA');
  assert.equal(DESIGN_PLANTED_RULES.truncated, 'TEXTO-CORTADO');
});

test('nove cinzas geram TOKENS-CINZAS-DEMAIS e dois não', () => {
  const nine = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888', '#999999'];
  const hit = inventoryFindingsFromCss('css/cinzas.css', grayCss(nine));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.rule, DESIGN_PLANTED_RULES.grays);
  assert.equal(hit[0]?.tool, 'inventario');
  assert.equal(hit[0]?.severity, 'alta');
  assert.equal(hit[0]?.cwe, null);
  assert.equal(hit[0]?.file, 'css/cinzas.css');
  assert.equal(hit[0]?.line, DESIGN_GRAY_MIN);
  assert.match(hit[0]?.fingerprint ?? '', /^[a-f0-9]{64}$/);
  assert.match(hit[0]?.snippet ?? '', /9 cinzas distintos/);

  const two = inventoryFindingsFromCss('css/boa.css', grayCss(['#1a1a1a', '#5c5c5c']));
  assert.equal(two.length, 0);
  const inventory = inventoryFromCss(grayCss(['#1a1a1a', 'rgb(26, 26, 26)', '#5c5c5c', '#ffffff', '#000000', '#0b57d0']));
  assert.deepEqual(inventory.grays, ['#1a1a1a', '#5c5c5c']);
});

test('sombra com alfa baixo não entra na lista de cinzas', () => {
  const eight = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'];
  const css = `${grayCss(eight)}\n.sombra { box-shadow: 0 1px 2px rgba(27, 28, 29, 0.04); }`;
  const inventory = inventoryFromCss(css);
  assert.deepEqual(inventory.grays, eight);
  assert.equal(inventory.grays.includes('#1b1c1d'), false);
  const hit = inventoryFindingsFromCss('css/cinzas.css', css);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.rule, DESIGN_PLANTED_RULES.grays);
  assert.equal(hit[0]?.severity, 'alta');
  assert.equal((hit[0]?.snippet ?? '').includes('#1b1c1d'), false);
});

test('limiar de cinza é 8 e o intervalo 16–239 com max-min <= 8', () => {
  const eight = ['#101010', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#efefef'];
  assert.equal(inventoryFindingsFromCss('css/cinzas.css', grayCss(eight)).length, 1);
  assert.equal(inventoryFindingsFromCss('css/cinzas.css', grayCss(eight.slice(0, 7))).length, 0);

  const edge = inventoryFromCss([
    '.a { color: #101010; background: #0f0f0f; }',
    '.b { color: #efefef; background-color: #f0f0f0; }',
    '.c { color: #1a1a22; border-color: #1a1a23; }',
    '.d { color: white; background: black; outline: 1px solid blue; }',
    '.e { color: gray; }',
    '.f { color: hsl(0 0% 10%); }',
  ].join('\n'));
  assert.deepEqual(edge.grays, ['#101010', '#efefef', '#1a1a22', '#808080', '#1a1a1a']);
  assert.ok(edge.colors.includes('#ffffff'));
  assert.ok(edge.colors.includes('#000000'));
  assert.ok(edge.colors.includes('#0000ff'));
  assert.ok(!edge.grays.includes('#ffffff'));
  assert.ok(!edge.grays.includes('#000000'));
  assert.ok(!edge.grays.includes('#0000ff'));
  assert.ok(!edge.grays.includes('#0f0f0f'));
  assert.ok(!edge.grays.includes('#f0f0f0'));
  assert.ok(!edge.grays.includes('#1a1a23'));
});

test('cinco espaçamentos ímpares geram TOKENS-ESPACAMENTO e a grade de 4 não', () => {
  const five = '.box { margin: 1px; padding: 3px; gap: 5px; margin-top: 7px; padding-left: 9px; }';
  const hit = inventoryFindingsFromCss('css/espaco.css', five);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.rule, DESIGN_PLANTED_RULES.spacing);
  assert.equal(hit[0]?.severity, 'alta');
  assert.equal(hit[0]?.tool, 'inventario');
  assert.equal(hit[0]?.cwe, null);
  assert.match(hit[0]?.snippet ?? '', /5 espaçamentos fora da grade de 4px: 1px 3px 5px 7px 9px/);

  const four = '.box { margin: 1px 3px 5px 7px; }';
  assert.equal(inventoryFindingsFromCss('css/espaco.css', four)[0]?.rule, DESIGN_PLANTED_RULES.spacing);
  const evens = '.box { margin: 2px; padding: 6px; gap: 10px; column-gap: 14px; }';
  assert.equal(inventoryFindingsFromCss('css/espaco.css', evens).some(item => item.rule === DESIGN_PLANTED_RULES.spacing), true);

  assert.equal(inventoryFindingsFromCss('css/espaco.css', '.box { margin: 1px; padding: 3px; gap: 5px; }').length, 0);
  assert.equal(inventoryFindingsFromCss('css/espaco.css', '.box { margin: 0; padding: 0px; gap: 4px; margin-top: 8px; padding-left: 16px; }').length, 0);
  assert.equal(inventoryFindingsFromCss('css/espaco.css', '.box { margin: 1px; padding: 1px; gap: 1px; margin-top: 1px; }').length, 0);
  const scale = inventoryFromCss('.box { margin: 0 8px; padding: 16px 0px; }');
  assert.deepEqual(scale.spacings, ['0px', '8px', '16px']);
  assert.deepEqual(scale.offScaleSpacings, []);
});

test('width e min-width em px >= 400 quebram 375; max-width e prelúdio não', () => {
  const wide = inventoryFindingsFromCss('css/estreito.css', '.a {\n  width: 980px;\n}\n');
  assert.equal(wide.length, 1);
  assert.equal(wide[0]?.rule, DESIGN_PLANTED_RULES.narrow);
  assert.equal(wide[0]?.severity, 'alta');
  assert.equal(wide[0]?.line, 2);
  assert.equal(wide[0]?.snippet, 'width: 980px');

  const min = inventoryFindingsFromCss('css/estreito.css', '.a { min-width: 400px; }');
  assert.equal(min[0]?.rule, DESIGN_PLANTED_RULES.narrow);
  assert.equal(min[0]?.snippet, 'min-width: 400px');
  assert.equal(inventoryFindingsFromCss('css/estreito.css', '.a { width: 399px; }').length, 0);
  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a { max-width: 720px; width: 100%; }').length, 0);
  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a { max-width: 980px; }').length, 0);
  const media = '@media (min-width: 800px) {\n  .a { width: 100%; }\n}\n';
  assert.equal(inventoryFindingsFromCss('css/boa.css', media).length, 0);
  const commented = '/*\nwidth: 980px;\n*/\n.a { width: 100%; }\n';
  assert.equal(inventoryFindingsFromCss('css/boa.css', commented).length, 0);
});

test('texto cortado exige overflow hidden e nowrap ou ellipsis no mesmo bloco', () => {
  const nowrap = inventoryFindingsFromCss('css/cortado.css', '.titulo {\n  overflow: hidden;\n  white-space: nowrap;\n}\n');
  assert.equal(nowrap.length, 1);
  assert.equal(nowrap[0]?.rule, DESIGN_PLANTED_RULES.truncated);
  assert.equal(nowrap[0]?.severity, 'alta');
  assert.equal(nowrap[0]?.tool, 'inventario');
  assert.equal(nowrap[0]?.cwe, null);
  assert.equal(nowrap[0]?.line, 2);
  assert.match(nowrap[0]?.snippet ?? '', /white-space: nowrap/);

  const ellipsis = inventoryFindingsFromCss('css/cortado.css', '.titulo { overflow: hidden; text-overflow: ellipsis; }');
  assert.equal(ellipsis[0]?.rule, DESIGN_PLANTED_RULES.truncated);
  assert.match(ellipsis[0]?.snippet ?? '', /text-overflow: ellipsis/);

  const upper = inventoryFindingsFromCss('css/cortado.css', '.A { OVERFLOW: HIDDEN; WHITE-SPACE: NOWRAP; }');
  assert.equal(upper.length, 1);

  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a { overflow: hidden; }\n.b { white-space: nowrap; }\n').length, 0);
  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a {\n  overflow: hidden;\n  .b { white-space: nowrap; }\n}\n').length, 0);
  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a { overflow: clip; white-space: nowrap; }').length, 0);
  assert.equal(inventoryFindingsFromCss('css/boa.css', '.a { overflow: hidden; overflow: visible; white-space: nowrap; }').length, 0);
});

test('a folha correta não gera achado alta', () => {
  const findings = inventoryFindingsFromCss('css/boa.css', CORRECT_CSS);
  assert.equal(findings.length, 0);
  assert.equal(findings.some(item => item.severity === 'alta'), false);
  assert.deepEqual(inventoryFromCss(CORRECT_CSS), {
    colors: ['#1a1a1a', '#ffffff', '#5c5c5c', '#0b57d0'],
    grays: ['#1a1a1a', '#5c5c5c'],
    fontFamilies: [],
    fontSizes: [],
    spacings: ['8px', '16px'],
    offScaleSpacings: [],
    radii: [],
    shadows: [],
  });
});

test('inventário lê fonte, raio, sombra e estilos computados', () => {
  const css = [
    '.card {',
    '  font-family: "Inter", system-ui, sans-serif;',
    '  font-size: 16px;',
    '  border-radius: 4px 8px;',
    '  box-shadow: 0 1px 2px #000000;',
    '  text-shadow: none;',
    '  margin: 8px;',
    '}',
  ].join('\n');
  assert.deepEqual(inventoryFromCss(css), {
    colors: ['#000000'],
    grays: [],
    fontFamilies: ['Inter', 'system-ui', 'sans-serif'],
    fontSizes: ['16px'],
    spacings: ['8px'],
    offScaleSpacings: [],
    radii: ['4px', '8px'],
    shadows: ['0 1px 2px #000000'],
  });

  const computed = inventoryFromComputed([
    {
      selector: '.a',
      color: 'rgb(26, 26, 26)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontFamily: 'Inter, sans-serif',
      fontSize: '16px',
      margin: '8px 15px',
      padding: '0px',
      gap: 'normal',
      borderRadius: '4px',
      boxShadow: 'none',
    },
    {
      selector: '.b',
      color: '#5c5c5c',
      margin: '1px',
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
    },
  ]);
  assert.deepEqual(computed.grays, ['#1a1a1a', '#5c5c5c']);
  assert.ok(computed.colors.includes('#ffffff'));
  assert.deepEqual(computed.fontFamilies, ['Inter', 'sans-serif']);
  assert.deepEqual(computed.fontSizes, ['16px']);
  assert.deepEqual(computed.spacings, ['8px', '15px', '0px', '1px']);
  assert.deepEqual(computed.offScaleSpacings, ['15px', '1px']);
  assert.deepEqual(computed.radii, ['4px']);
  assert.equal(computed.shadows.length, 1);
  assert.match(computed.shadows[0] ?? '', /rgba\(0,\s*0,\s*0,\s*0\.2\)/);
});

test('json do css-analyzer preenche listas e campo ausente fica vazio', () => {
  const report = {
    values: {
      colors: {
        total: 3,
        totalUnique: 3,
        unique: {'#111111': 1, '#ffffff': 1, blue: 1},
        uniquenessRatio: 1,
      },
      fontFamilies: {unique: {'Inter, sans-serif': 1}},
      fontSizes: {unique: {'16px': 2}},
      boxShadows: {unique: {'0 1px 2px #111111': 1}},
      textShadows: {unique: {}},
      borderRadiuses: {unique: {'4px': 1}},
    },
  };
  const inventory = inventoryFromCssAnalyzer(report);
  assert.deepEqual(inventory.colors, ['#111111', '#ffffff', '#0000ff']);
  assert.deepEqual(inventory.grays, ['#111111']);
  assert.deepEqual(inventory.fontFamilies, ['Inter', 'sans-serif']);
  assert.deepEqual(inventory.fontSizes, ['16px']);
  assert.deepEqual(inventory.radii, ['4px']);
  assert.deepEqual(inventory.shadows, ['0 1px 2px #111111']);
  assert.deepEqual(inventory.spacings, []);
  assert.deepEqual(inventory.offScaleSpacings, []);

  const partial = inventoryFromCssAnalyzer({values: {colors: {unique: {'#222222': 1}}}});
  assert.deepEqual(partial.grays, ['#222222']);
  assert.deepEqual(partial.fontFamilies, []);
  assert.deepEqual(partial.fontSizes, []);
  assert.deepEqual(partial.shadows, []);
  assert.deepEqual(partial.radii, []);
  assert.deepEqual(inventoryFromCssAnalyzer(null), {
    colors: [], grays: [], fontFamilies: [], fontSizes: [], spacings: [], offScaleSpacings: [], radii: [], shadows: [],
  });
  const lists = inventoryFromCssAnalyzer({
    colors: ['#333333', '#ffffff'],
    fontSizes: ['12px'],
    shadows: ['0 0 0 1px #333333'],
    spacings: ['1px', '8px', '3px'],
  });
  assert.deepEqual(lists.grays, ['#333333']);
  assert.deepEqual(lists.fontSizes, ['12px']);
  assert.deepEqual(lists.offScaleSpacings, ['1px', '3px']);
});
