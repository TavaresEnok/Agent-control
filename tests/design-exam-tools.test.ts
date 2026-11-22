import assert from 'node:assert/strict';
import {test} from 'node:test';

type CoverageRow = {tool: string; version: string; executed: string; findings: number; failure: string};

const {classifyPa11yRun, coverageRows, failureText} = await import(new URL('../deploy/design-tools/run-exam.mjs', import.meta.url).href) as {
  classifyPa11yRun: (status: number | undefined, stdout: string) => {ok: boolean; issues: unknown[]; detail: string};
  coverageRows: (parts: {
    versions: {axe: string; pa11y: string; lighthouse: string; stylelint: string; analyzer: string};
    executed: {axe: string; pa11y: string; lighthouse: string; stylelint: string; analyzer: string};
    findings: {axe: number; pa11y: number; lighthouse: number; stylelint: number};
    failures: {axe: readonly string[]; pa11y: readonly string[]; lighthouse: readonly string[]; stylelint: readonly string[]; analyzer: readonly string[]};
  }) => CoverageRow[];
  failureText: (items: readonly string[]) => string;
};

const tools = await import(new URL('../deploy/design-tools/run-exam.mjs', import.meta.url).href) as {
  redirectedTo: (requested: string, landed: string) => string | null;
  plainPath: (value: string) => string;
  contrastRatio: (a: {r: number; g: number; b: number}, b: {r: number; g: number; b: number}) => number;
  parseColor: (value: string) => {r: number; g: number; b: number; a: number} | null;
  inPage: (fn: (arg: unknown) => unknown, helpers: readonly ((...args: never[]) => unknown)[], arg: unknown) => string;
  bounded: <T>(promise: Promise<T>, ms?: number) => Promise<T>;
  slimLighthouse: (lhr: unknown) => {audits: Record<string, {score: number | null}>} | null;
  snippetOf: (value: unknown, max: number) => string;
  RESIDUE_PATTERNS: {kind: string; source: string; flags: string}[];
};

const versions = {axe: '4', pa11y: '10', lighthouse: '13', stylelint: '18', analyzer: '9'};
const executed = {
  axe: '2 células',
  pa11y: '1 células rota×viewport',
  lighthouse: '1 mobile, 1 desktop',
  stylelint: '0 arquivos do repositório, 1 blocos de página',
  analyzer: '1 folhas',
};
const findings = {axe: 1, pa11y: 2, lighthouse: 0, stylelint: 0};
const none = {axe: [] as string[], pa11y: [] as string[], lighthouse: [] as string[], stylelint: [] as string[], analyzer: [] as string[]};

test('pa11y com status 2 e lista termina; JSON ilegível ou outro status não conta', () => {
  const found = classifyPa11yRun(2, '[{"code":"H37"}]');
  assert.equal(found.ok, true);
  assert.equal(found.issues.length, 1);
  assert.equal(classifyPa11yRun(0, '[]').ok, true);
  const illegible = classifyPa11yRun(0, '<html>nao json</html>');
  assert.equal(illegible.ok, false);
  assert.match(illegible.detail, /json inválido/);
  assert.equal(classifyPa11yRun(1, '[]').ok, false);
  assert.equal(classifyPa11yRun(undefined, '[]').ok, false);
});

test('uma ferramenta quebrada de cada vez marca só a própria linha', () => {
  const cases = [
    ['axe-core', {...none, axe: ['DESIGN_AXE_FAILED / inicio']}],
    ['pa11y', {...none, pa11y: ['DESIGN_PA11Y_FAILED / 375 axe status 0 json inválido']}],
    ['lighthouse', {...none, lighthouse: ['DESIGN_LIGHTHOUSE_FAILED / mobile sem LHR']}],
  ] as const;
  for (const [tool, failures] of cases) {
    const table = coverageRows({versions, executed, findings, failures});
    assert.equal(table.length, 5);
    for (const row of table) {
      if (row.tool === tool) assert.match(row.failure, /^1 falha: /);
      else assert.equal(row.failure, 'nenhuma');
    }
    assert.equal(table.find(row => row.tool === 'css-analyzer')?.findings, 0);
  }
  const listed = failureText(Array.from({length: 10}, (_item, index) => `quebra ${index}`));
  assert.match(listed, /^10 falhas: /);
  assert.match(listed, /e mais 2$/);
});

test('redirecionamento é outro caminho no mesmo origin; barra do fim e query não contam', () => {
  assert.equal(tools.redirectedTo('http://lab.local/painel', 'http://lab.local/entrar?volta=1'), '/entrar');
  assert.equal(tools.redirectedTo('http://lab.local/painel', 'http://lab.local/painel/'), null);
  assert.equal(tools.redirectedTo('http://lab.local/estado/vazio', 'http://lab.local/estado/vazio?x=1'), null);
  assert.equal(tools.redirectedTo('http://lab.local/', 'http://lab.local/'), null);
  assert.equal(tools.redirectedTo('nada', 'http://lab.local/'), null);
  assert.equal(tools.plainPath('http://lab.local'), '/');
});

test('contraste e cor seguem o WCAG', () => {
  const white = {r: 255, g: 255, b: 255};
  const black = {r: 0, g: 0, b: 0};
  assert.equal(Math.round(tools.contrastRatio(white, black) * 100) / 100, 21);
  assert.equal(tools.contrastRatio(white, white), 1);
  assert.equal(Math.round(tools.contrastRatio({r: 29, g: 78, b: 216}, white) * 100) / 100, 6.7);
  assert.deepEqual(tools.parseColor('rgb(1 2 3 / 50%)'), {r: 1, g: 2, b: 3, a: 0.5});
  assert.equal(tools.parseColor('color(srgb 1 0 0)'), null);
});

test('inPage leva as funções de apoio e o argumento em JSON; nada de fora', () => {
  function double(value: number): number {
    return value * 2;
  }
  const source = tools.inPage(function probe(arg: unknown) {
    const input = arg as {n: number; text: string};
    return {n: double(input.n), text: input.text};
  }, [double], {n: 21, text: '"</script>'});
  assert.deepEqual((0, eval)(source), {n: 42, text: '"</script>'});
  assert.doesNotMatch(source, /^export /m);
});

test('bounded corta leitura presa em 5s e não deixa rejeição solta', async () => {
  await assert.rejects(tools.bounded(new Promise(() => undefined), 20), /sem resposta em 20ms/);
  assert.equal(await tools.bounded(Promise.resolve(7), 20), 7);
  const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('tarde')), 30));
  await assert.rejects(tools.bounded(late, 5), /sem resposta/);
  await new Promise(resolve => setTimeout(resolve, 40));
});

test('slimLighthouse guarda viewport e font-size', () => {
  const slim = tools.slimLighthouse({
    configSettings: {formFactor: 'mobile'},
    audits: {viewport: {score: 0, title: 'v'}, 'font-size': {score: null}, 'tap-targets': {score: 0}},
  });
  assert.equal(slim?.audits.viewport?.score, 0);
  assert.equal(slim?.audits['font-size']?.score, null);
  assert.equal(slim?.audits['tap-targets'], undefined);
});

test('padrões de sobra compilam e o trecho perde controle', () => {
  for (const pattern of tools.RESIDUE_PATTERNS) assert.doesNotThrow(() => new RegExp(pattern.source, pattern.flags), pattern.kind);
  assert.equal(tools.snippetOf('  a\n\u0007b  c ', 40), 'a b c');
  assert.equal(tools.snippetOf('x'.repeat(80), 40).length, 40);
});
