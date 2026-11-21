import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {BRAND_RULE, brandFindings, brandMarkdown, compareWithDeclared, parseDeclaredTokens} from '../src/design-brand-tokens.ts';

const blue = JSON.stringify({
  color: {
    $type: 'color',
    blue: {500: {$value: '#2563eb'}, 600: {$value: '#1d4ed8'}},
    white: {$value: '#ffffff'},
    primary: {$value: '{color.blue.500}'},
  },
});

const block = (route: string, samples: object[]) => ({route, viewport: 1440, theme: 'claro', state: 'padrao', samples});

test('DTCG com alias de um nível e ciclo recusado', () => {
  const tokens = parseDeclaredTokens('tokens.json', JSON.stringify({
    color: {
      $type: 'color',
      base: {$value: {colorSpace: 'srgb', components: [1, 0, 0]}},
      alias: {$value: '{color.base}'},
      a: {$value: '{color.b}'},
      b: {$value: '{color.a}'},
    },
    space: {$type: 'dimension', md: {$value: {value: 1, unit: 'rem'}}},
    font: {body: {$type: 'fontFamily', $value: ['Inter', 'sans-serif']}},
  }));
  assert.deepEqual(tokens.colors.map(item => item.name), ['color.base', 'color.alias']);
  assert.deepEqual(tokens.spaces, [16]);
  assert.deepEqual(tokens.families, ['inter']);
  assert.equal(tokens.notes.filter(note => /Ciclo de alias recusado/.test(note)).length, 2);
});

test('CSS --radius-sm: 0.25rem vira 4px e var() resolve um nível', () => {
  const tokens = parseDeclaredTokens('src/tokens.css', ':root {\n  --radius-sm: 0.25rem;\n  --space-2: 8px;\n  --brand: #2563eb;\n  --accent: var(--brand);\n  --font-sans: "Inter", system-ui;\n}');
  assert.deepEqual(tokens.radii, [4]);
  assert.deepEqual(tokens.spaces, [8]);
  assert.equal(tokens.colors.length, 2);
  assert.deepEqual(tokens.families, ['inter']);
});

test('#fefefe casa com o token #ffffff e #7c3aed fica fora da paleta azul', () => {
  const declared = parseDeclaredTokens('tokens.json', blue);
  const near = compareWithDeclared([block('/', [{color: 'rgb(254, 254, 254)', backgroundColor: 'rgb(37, 99, 235)'}])], declared);
  assert.deepEqual(near.off, []);
  const violet = compareWithDeclared([block('/', [{color: 'rgb(124, 58, 237)', backgroundColor: 'rgba(0, 0, 0, 0)', borderColor: 'currentcolor'}])], declared);
  assert.deepEqual(violet.off, [{route: '/', category: 'cor', values: ['#7c3aed']}]);
  const findings = brandFindings(violet.off, 'tokens.json');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, BRAND_RULE);
  assert.equal(findings[0]?.tool, 'tokens-projeto');
  assert.equal(findings[0]?.severity, 'media');
  assert.equal(findings[0]?.measure, undefined);
  assert.equal(findings[0]?.file, '/');
  assert.match(findings[0]?.snippet ?? '', /cores fora de tokens\.json: #7c3aed/);
});

test('15px contra os passos 14 e 16 fica fora; 14,4px fica dentro', () => {
  const declared = parseDeclaredTokens('tokens.json', JSON.stringify({fontSize: {$type: 'dimension', sm: {$value: '14px'}, md: {$value: '16px'}}}));
  const result = compareWithDeclared([block('/a', [{fontSize: '15px'}, {fontSize: '14.4px'}, {fontSize: '16px'}])], declared);
  assert.deepEqual(result.off, [{route: '/a', category: 'tamanho', values: ['15px']}]);
});

test('categoria que o arquivo não declara não é julgada', () => {
  const declared = parseDeclaredTokens('tokens.json', blue);
  const result = compareWithDeclared([block('/', [{color: 'rgb(37, 99, 235)', fontSize: '13px', padding: '7px', borderRadius: '3px', fontFamily: 'Comic Sans MS, cursive'}])], declared);
  assert.deepEqual(result.categories, ['cor']);
  assert.deepEqual(result.off, []);
  assert.match(brandMarkdown(result), /Todas as rotas usam só valores declarados\./);
});

test('um achado por rota e categoria, com no máximo 5 valores', () => {
  const declared = parseDeclaredTokens('t.css', ':root { --space-1: 4px; --space-2: 8px; --font-body: Inter; }');
  const samples = [{padding: '5px 6px 7px 9px', margin: '10px', gap: '11px', fontFamily: '"Roboto", sans-serif'}];
  const result = compareWithDeclared([block('/a', samples), block('/a', samples), block('/b', [{padding: '8px', fontFamily: 'Inter'}])], declared);
  const findings = brandFindings(result.off, 't.css');
  assert.deepEqual(findings.map(item => [item.file, item.snippet]), [
    ['/a', 'espaçamentos fora de t.css: 5px, 6px, 7px, 9px, 10px e mais 1'],
    ['/a', 'famílias fora de t.css: roboto'],
  ]);
  assert.match(brandMarkdown(result), /- \/a: espaçamentos fora do declarado: 5px, 6px, 7px, 9px, 10px e mais 1\./);
});

test('JSON quebrado dá nota e nenhum achado; arquivo grande é recusado', () => {
  const declared = parseDeclaredTokens('tokens.json', '{');
  assert.equal(declared.notes.length, 1);
  const result = compareWithDeclared([block('/', [{color: 'rgb(124, 58, 237)'}])], declared);
  assert.deepEqual(result.off, []);
  assert.deepEqual(brandFindings(result.off, 'tokens.json'), []);
  assert.match(brandMarkdown(result), /não é JSON válido/);
  assert.throws(() => parseDeclaredTokens('tokens.css', `:root{--a:${'x'.repeat(300 * 1024)}}`), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CONFIG_INVALID');
});

test('tema escuro e @media que redefinem o token não apagam o valor claro', () => {
  const css = ':root{--bg:#ffffff;--fg:#111111;--space-md:16px}\n.dark{--bg:#000000;--fg:#eeeeee}\n@media (min-width: 900px){:root{--space-md:24px}}';
  const declared = parseDeclaredTokens('tokens.css', css);
  const light = compareWithDeclared([block('/', [{color: 'rgb(17, 17, 17)', backgroundColor: 'rgb(255, 255, 255)', padding: '16px'}])], declared);
  assert.deepEqual(light.off, []);
  const dark = compareWithDeclared([block('/', [{color: 'rgb(238, 238, 238)', backgroundColor: 'rgb(0, 0, 0)', padding: '24px'}])], declared);
  assert.deepEqual(dark.off, []);
  const stray = compareWithDeclared([block('/', [{color: 'rgb(124, 58, 237)'}])], declared);
  assert.deepEqual(stray.off, [{route: '/', category: 'cor', values: ['#7c3aed']}]);
});

test('dimensão sem categoria, como --header-height, não abre tamanho, raio nem espaço', () => {
  const declared = parseDeclaredTokens('tokens.css', ':root{--brand:#2563eb;--header-height:64px;--border-width:1px}');
  assert.deepEqual(declared.dimensions, [64, 1]);
  const result = compareWithDeclared([block('/', [{color: 'rgb(37, 99, 235)', fontSize: '16px', padding: '12px', borderRadius: '6px'}])], declared);
  assert.deepEqual(result.categories, ['cor']);
  assert.deepEqual(result.off, []);
});
