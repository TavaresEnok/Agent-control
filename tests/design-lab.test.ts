import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {staticHtmlFindings} from '../src/design-a11y.ts';
import {discoverRoutesFromSource, missingEmptyStateFindings} from '../src/design-discover.ts';
import {inventoryFindingsFromCss} from '../src/design-inventory.ts';
import {focusFindingsFromCss} from '../src/design-keyboard.ts';
import {DESIGN_PLANTED_RULES, type DesignRawFinding} from '../src/design-types.ts';

const labRoot = fileURLToPath(new URL('./fixtures/design-lab/', import.meta.url));

const routes = [
  '/contraste',
  '/botao',
  '/foco',
  '/cinzas',
  '/espaco',
  '/itens',
  '/estreito',
  '/cortado',
  '/boa-inicio',
  '/boa-detalhe',
] as const;

const cleanFiles = [
  'html/boa-inicio.html',
  'html/boa-detalhe.html',
  'css/boa.css',
  'src/BoaInicio.tsx',
  'src/BoaDetalhe.tsx',
] as const;

function labFile(relative: string): {path: string; text: string} {
  const path = join(labRoot, relative);
  return {path, text: readFileSync(path, 'utf8')};
}

function assertPlanted(findings: readonly DesignRawFinding[], rule: string, relative: string): void {
  const hit = findings.some(item => item.rule === rule && item.severity === 'alta');
  assert.equal(hit, true, `${relative} deve gerar ${rule} com gravidade alta`);
}

function cleanFindings(file: string, text: string): DesignRawFinding[] {
  return [
    ...staticHtmlFindings(file, text),
    ...focusFindingsFromCss(file, text),
    ...inventoryFindingsFromCss(file, text),
    ...missingEmptyStateFindings(file, text),
  ];
}

test('descobre as dez rotas do App', () => {
  const app = labFile('src/App.tsx');
  const found = discoverRoutesFromSource([{path: app.path, text: app.text}]);
  assert.equal(found.length, routes.length);
  assert.deepEqual(found.map(item => item.route).sort(), [...routes].sort());
  for (const item of found) {
    assert.equal(item.file, app.path);
    assert.equal(item.source, 'codigo');
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.title, 'string');
    assert.equal(item.line >= 1, true);
  }
});

test('contraste baixo gera a regra plantada', () => {
  const file = labFile('html/contraste.html');
  assertPlanted(staticHtmlFindings(file.path, file.text), DESIGN_PLANTED_RULES.contrast, 'html/contraste.html');
});

test('botao sem nome gera a regra plantada', () => {
  const file = labFile('html/botao.html');
  assertPlanted(staticHtmlFindings(file.path, file.text), DESIGN_PLANTED_RULES.unlabeledButton, 'html/botao.html');
});

test('foco invisivel gera a regra plantada', () => {
  const file = labFile('css/foco.css');
  assertPlanted(focusFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.invisibleFocus, 'css/foco.css');
});

test('nove cinzas geram a regra plantada', () => {
  const file = labFile('css/cinzas.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.grays, 'css/cinzas.css');
});

test('espacamento fora da grade gera a regra plantada', () => {
  const file = labFile('css/espaco.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.spacing, 'css/espaco.css');
});

test('lista sem estado vazio gera a regra plantada', () => {
  const file = labFile('src/Itens.tsx');
  assertPlanted(missingEmptyStateFindings(file.path, file.text), DESIGN_PLANTED_RULES.empty, 'src/Itens.tsx');
});

test('largura fixa gera a regra plantada', () => {
  const file = labFile('css/estreito.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.narrow, 'css/estreito.css');
});

test('texto cortado gera a regra plantada', () => {
  const file = labFile('css/cortado.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.truncated, 'css/cortado.css');
});

for (const relative of cleanFiles) {
  test(`sem achado alto em ${relative}`, () => {
    const file = labFile(relative);
    const high = cleanFindings(file.path, file.text).filter(item => item.severity === 'alta').map(item => item.rule);
    assert.deepEqual(high, []);
  });
}
