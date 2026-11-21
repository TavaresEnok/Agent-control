import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  CONSISTENCY_ISOLATED_RULE,
  HEADING_SCALE_RULE,
  analyzeConsistency,
  consistencyFindings,
  consistencyMarkdown,
} from '../src/design-consistency.ts';

/** Três cores comuns a todas as rotas. */
const shared = [
  {selector: 'p', color: 'rgb(17, 24, 39)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px'},
  {selector: 'a', color: 'rgb(37, 99, 235)', fontSize: '16px'},
];

const block = (route: string, samples: object[], theme = 'claro', viewport = 1440) => ({route, viewport, theme, state: 'padrao', samples});

test('cor usada 2 vezes numa só rota vira valor isolado baixo, sem medida', () => {
  const odd = {selector: 'button', color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(124, 58, 237)'};
  const result = analyzeConsistency([
    block('/', shared),
    block('/sobre', shared),
    block('/precos', [...shared, odd, odd]),
  ]);
  assert.deepEqual(result.compared, ['cor']);
  assert.deepEqual(result.isolated.map(item => [item.route, item.values]), [['/precos', [{category: 'cor', value: '#7c3aed', count: 2}]]]);
  const findings = consistencyFindings(result);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, CONSISTENCY_ISOLATED_RULE);
  assert.equal(findings[0]?.tool, 'consistencia');
  assert.equal(findings[0]?.severity, 'baixa');
  assert.equal(findings[0]?.measure, undefined);
  assert.equal(findings[0]?.file, '/precos');
  assert.match(consistencyMarkdown(result), /- \/precos: cor #7c3aed \(2x\)\./);
});

test('uso único, rota sozinha e categoria sem 3 valores comuns não contam', () => {
  const once = {selector: 'button', backgroundColor: 'rgb(124, 58, 237)'};
  assert.deepEqual(analyzeConsistency([block('/', shared), block('/a', [...shared, once])]).isolated, []);
  const alone = analyzeConsistency([block('/', [...shared, once, once])]);
  assert.deepEqual(alone.isolated, []);
  assert.match(alone.notes.join(' '), /menos de 2 rotas/);
  const thin = analyzeConsistency([
    block('/', [{selector: 'p', color: 'rgb(0, 0, 0)'}]),
    block('/a', [{selector: 'p', color: 'rgb(0, 0, 0)'}, once, once]),
  ]);
  assert.deepEqual(thin.isolated, []);
  assert.deepEqual(thin.compared, []);
});

test('cores a menos de ΔE2000 2 são a mesma cor', () => {
  const near = {selector: 'span', color: 'rgb(38, 100, 234)'};
  const result = analyzeConsistency([block('/', shared), block('/a', [...shared, near, near])]);
  assert.deepEqual(result.isolated, []);
});

test('tema escuro compara só com o escuro', () => {
  const dark = [
    {selector: 'p', color: 'rgb(229, 231, 235)', backgroundColor: 'rgb(17, 24, 39)'},
    {selector: 'a', color: 'rgb(96, 165, 250)'},
  ];
  const result = analyzeConsistency([
    block('/', shared),
    block('/a', shared),
    block('/', dark, 'escuro'),
    block('/a', dark, 'escuro'),
  ]);
  assert.deepEqual(result.isolated, []);
  assert.deepEqual(result.routes, ['/', '/a', '/#escuro', '/a#escuro']);
  const odd = {selector: 'b', color: 'rgb(250, 204, 21)'};
  const flagged = analyzeConsistency([
    block('/', shared),
    block('/a', shared),
    block('/', dark, 'escuro'),
    block('/a', [...dark, odd, odd], 'escuro'),
  ]);
  assert.deepEqual(flagged.isolated.map(item => item.key), ['/a#escuro']);
  assert.equal(consistencyFindings(flagged)[0]?.file, '/a escuro');
});

test('no máximo 15 valores isolados', () => {
  const many = Array.from({length: 20}, (_, index) => ({selector: 'div', padding: `${101 + index}px`}));
  const spaces = [{selector: 'div', padding: '4px', margin: '8px', gap: '16px'}];
  const result = analyzeConsistency([
    block('/', spaces),
    block('/a', [...spaces, ...many, ...many]),
  ]);
  const total = result.isolated.reduce((sum, item) => sum + item.values.length, 0);
  assert.equal(total, 15);
  assert.equal(consistencyFindings(result).filter(item => item.rule === CONSISTENCY_ISOLATED_RULE).length, 1);
});

test('h2 maior que h1 ou h3 maior que h2 vira escala de títulos baixa, uma por rota', () => {
  const result = analyzeConsistency([
    block('/', [{selector: 'h1', fontSize: '24px'}, {selector: 'h2', fontSize: '28px'}], 'claro', 375),
    block('/', [{selector: 'h1', fontSize: '24px'}, {selector: 'h2', fontSize: '30px'}], 'claro', 1440),
    block('/a', [{selector: 'h2', fontSize: '20px'}, {selector: 'h3', fontSize: '22px'}]),
    block('/b', [{selector: 'h1', fontSize: '32px'}, {selector: 'h2', fontSize: '32.4px'}, {selector: 'h3', fontSize: '20px'}]),
  ]);
  const findings = consistencyFindings(result).filter(item => item.rule === HEADING_SCALE_RULE);
  assert.deepEqual(findings.map(item => item.file), ['/', '/a']);
  assert.equal(findings.every(item => item.severity === 'baixa' && item.measure === undefined), true);
  assert.match(findings[0]?.snippet ?? '', /h2 de 28px maior que h1 de 24px \(375 claro padrao\)/);
  assert.match(consistencyMarkdown(result), /- \/a: h3 de 22px maior que h2 de 20px\./);
  const ordered = analyzeConsistency([block('/', [{selector: 'h1', fontSize: '32px'}, {selector: 'h2', fontSize: '24px'}])]);
  assert.deepEqual(ordered.headings, []);
  assert.match(consistencyMarkdown(ordered), /Títulos em ordem/);
});
