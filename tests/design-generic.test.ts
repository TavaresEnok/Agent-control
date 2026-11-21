import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectDesignFindings} from '../src/design-collect.ts';
import {collectGenericSignals, genericLookMarkdown, genericSignalsFromCss, genericSignalsFromMarkup} from '../src/design-generic.ts';
import {colorsIn, cssDeclarations} from '../src/design-inventory.ts';

const ids = (files: {path: string; text: string}[]) => collectGenericSignals(files).map(item => item.id);

test('(a) gradiente violeta no CSS vira S1', () => {
  const hits = genericSignalsFromCss('css/app.css', '.hero {\n  background: linear-gradient(135deg, #7c3aed, #6366f1);\n}');
  assert.deepEqual(hits.map(item => [item.id, item.line]), [['S1', 2]]);
});

test('(b) gradiente azul ou cinza não é violeta', () => {
  assert.deepEqual(ids([{path: 'a.css', text: '.a { background: linear-gradient(#2563eb, #ffffff); } .b { background-image: radial-gradient(#111, #eee); }'}]), []);
  assert.deepEqual(ids([{path: 'a.css', text: '.a { color: #7c3aed; }'}]), []);
});

test('(c) texto com gradiente vira S2', () => {
  const css = '.titulo { background: linear-gradient(90deg, #f97316, #facc15); -webkit-background-clip: text; color: transparent; }';
  assert.deepEqual(ids([{path: 'a.css', text: css}]), ['S2']);
});

test('(d) vidro só conta com 3 regras de desfoque', () => {
  const rule = (name: string) => `.${name} {\n  backdrop-filter: blur(12px);\n  -webkit-backdrop-filter: blur(12px);\n}\n`;
  assert.deepEqual(ids([{path: 'a.css', text: rule('a') + rule('b')}]), []);
  const signals = collectGenericSignals([{path: 'a.css', text: rule('a') + rule('b') + rule('c')}]);
  assert.equal(signals[0]?.id, 'S3');
  assert.equal(signals[0]?.count, 3);
});

test('(e) emoji no lugar de ícone vira S4; símbolo e texto comum não', () => {
  const html = '<ul>\n  <li><span>🚀</span> Rápido</li>\n  <li>✨ Bonito</li>\n</ul>\n<p>Feito com carinho ❤️</p>\n<footer>© 2026 Loja™</footer>';
  const hits = genericSignalsFromMarkup('index.html', html);
  assert.deepEqual(hits.map(item => [item.id, item.line]), [['S4', 2], ['S4', 3]]);
  const tsx = "const itens = [{icon: '⚡', titulo: 'Rápido'}];\nexport function A() { return <p>Sem emoji -&gt; nada</p>; }";
  assert.deepEqual(genericSignalsFromMarkup('A.tsx', tsx).map(item => item.id), ['S4']);
});

test('(f) classes do Tailwind e blocos <style> também contam', () => {
  const markup = [
    '<style>',
    '.x { background: linear-gradient(#8b5cf6, #ec4899); }',
    '</style>',
    '<div className="bg-gradient-to-r from-violet-500 to-fuchsia-500">',
    '<h1 class="bg-clip-text text-transparent">Oi</h1>',
    '<div class="backdrop-blur-md"></div><div class="backdrop-blur"></div><div class="backdrop-blur-sm"></div>',
    '</div>',
  ].join('\n');
  const hits = genericSignalsFromMarkup('page.tsx', markup);
  assert.deepEqual(hits.filter(item => item.id === 'S1').map(item => item.line), [2, 4]);
  assert.deepEqual(ids([{path: 'page.tsx', text: markup}]), ['S1', 'S2', 'S3']);
  assert.deepEqual(ids([{path: 'page.tsx', text: '<div class="bg-gradient-to-r from-blue-500 to-sky-400"></div>'}]), []);
  assert.deepEqual(ids([{path: 'dados.json', text: '{"icon": "🚀"}'}]), []);
});

test('(g) a seção lista os sinais e sempre termina com a ressalva', () => {
  const empty = genericLookMarkdown([]);
  assert.match(empty, /Nenhum sinal encontrado\./);
  assert.equal(empty.trimEnd().endsWith('É preferência, não falha.'), true);
  assert.equal(empty.startsWith('#'), false);
  const css = Array.from({length: 7}, (_, index) => `.g${index} { background: linear-gradient(#7c3aed, #a855f7); }`).join('\n');
  const markdown = genericLookMarkdown(collectGenericSignals([{path: 'css/app.css', text: css}]));
  assert.match(markdown, /- Gradiente violeta: 7 ocorrências \(css\/app\.css:1, css\/app\.css:2, css\/app\.css:3, css\/app\.css:4, css\/app\.css:5 e mais 2\)\./);
  assert.equal(markdown.trimEnd().endsWith('É preferência, não falha.'), true);
});

test('os sinais não viram achado bruto', () => {
  const files = [
    {path: 'css/app.css', text: '.a { background: linear-gradient(#7c3aed, #a855f7); -webkit-background-clip: text; }'},
    {path: 'index.html', text: '<button>🚀</button>'},
  ];
  assert.equal(collectGenericSignals(files).length > 0, true);
  const findings = collectDesignFindings(files, {});
  assert.equal(findings.some(item => item.tool === 'generico' || /gen[eé]rico/i.test(item.rule)), false);
  const clean = collectDesignFindings([{path: 'css/app.css', text: '.a { color: #111; }'}, {path: 'index.html', text: '<button>Ir</button>'}], {});
  assert.equal(clean.some(item => item.tool === 'generico'), false);
});

test('cssDeclarations e colorsIn expõem o leitor do inventário', () => {
  assert.deepEqual(cssDeclarations('/* x */\n@media (min-width: 10px) {\n  .a { color: red; padding: 4px }\n}'), [
    {prop: 'color', value: 'red', line: 3},
    {prop: 'padding', value: '4px', line: 3},
  ]);
  assert.deepEqual(colorsIn('linear-gradient(#fff, rgb(0 0 0 / 50%))'), [{r: 255, g: 255, b: 255, a: 1}, {r: 0, g: 0, b: 0, a: 0.5}]);
});
