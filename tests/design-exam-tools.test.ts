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
