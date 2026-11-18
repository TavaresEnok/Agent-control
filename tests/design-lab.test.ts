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

function assertPlanted(findings: readonly DesignRawFinding[], rule: string, relative: string, alta: boolean): void {
  const hits = findings.filter(item => item.rule === rule);
  assert.ok(hits.length > 0, `${relative} deve gerar ${rule}`);
  assert.equal(hits.some(item => item.severity === 'alta'), alta, `${relative} ${rule}`);
  if (!alta) assert.equal(hits.some(item => item.measure !== undefined), false, `${relative} nao tem medida`);
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
  const findings = staticHtmlFindings(file.path, file.text);
  assertPlanted(findings, DESIGN_PLANTED_RULES.contrast, 'html/contraste.html', true);
  const hit = findings.find(item => item.rule === DESIGN_PLANTED_RULES.contrast);
  assert.equal(hit?.measure?.kind, 'contrast');
  if (hit?.measure?.kind !== 'contrast') return;
  assert.equal(Number.isFinite(hit.measure.ratio), true);
  assert.match(hit.snippet, new RegExp(hit.measure.ratio.toFixed(2).replace('.', '\\.')));
});

test('botao sem nome gera a regra plantada', () => {
  const file = labFile('html/botao.html');
  const findings = staticHtmlFindings(file.path, file.text);
  assertPlanted(findings, DESIGN_PLANTED_RULES.unlabeledButton, 'html/botao.html', false);
  assert.equal(findings.find(item => item.rule === DESIGN_PLANTED_RULES.unlabeledButton)?.severity, 'media');
});

test('foco invisivel gera a regra plantada', () => {
  const file = labFile('css/foco.css');
  assertPlanted(focusFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.invisibleFocus, 'css/foco.css', false);
});

test('nove cinzas geram a regra plantada', () => {
  const file = labFile('css/cinzas.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.grays, 'css/cinzas.css', false);
});

test('espacamento fora da grade gera a regra plantada', () => {
  const file = labFile('css/espaco.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.spacing, 'css/espaco.css', false);
});

test('lista sem estado vazio gera a regra plantada', () => {
  const file = labFile('src/Itens.tsx');
  const findings = missingEmptyStateFindings(file.path, file.text);
  assertPlanted(findings, DESIGN_PLANTED_RULES.empty, 'src/Itens.tsx', false);
  assert.equal(findings[0]?.severity, 'media');
});

test('largura fixa gera a regra plantada', () => {
  const file = labFile('css/estreito.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.narrow, 'css/estreito.css', false);
});

test('texto cortado gera a regra plantada', () => {
  const file = labFile('css/cortado.css');
  assertPlanted(inventoryFindingsFromCss(file.path, file.text), DESIGN_PLANTED_RULES.truncated, 'css/cortado.css', false);
});

for (const relative of cleanFiles) {
  test(`sem achado alto em ${relative}`, () => {
    const file = labFile(relative);
    const high = cleanFindings(file.path, file.text).filter(item => item.severity === 'alta').map(item => item.rule);
    assert.deepEqual(high, []);
  });
}
