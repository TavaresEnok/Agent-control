import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stylelintConfig, stylelintToFindings} from '../src/design-stylelint.ts';
import {designRawFinding} from '../src/design-types.ts';

test('stylelintConfig liga block-no-empty e color-no-invalid-hex', () => {
  const config = stylelintConfig();
  const rules = config['rules'];
  assert.ok(rules !== null && typeof rules === 'object' && !Array.isArray(rules));
  const record = rules as Record<string, unknown>;
  assert.equal(record['block-no-empty'], true);
  assert.equal(record['color-no-invalid-hex'], true);
  record['block-no-empty'] = false;
  const fresh = stylelintConfig()['rules'];
  assert.ok(fresh !== null && typeof fresh === 'object' && !Array.isArray(fresh));
  assert.equal((fresh as Record<string, unknown>)['block-no-empty'], true);
});

test('um warning do Stylelint vira achado bruto baixa', () => {
  const findings = stylelintToFindings('src/app.css', {
    cwd: '/tmp/folha',
    errored: false,
    results: [
      {
        source: 'outro.css',
        warnings: [
          {
            line: 4,
            column: 1,
            rule: 'block-no-empty',
            severity: 'warning',
            text: 'Unexpected empty block (block-no-empty)',
          },
        ],
      },
    ],
  });
  assert.deepEqual(findings, [
    designRawFinding({
      tool: 'stylelint',
      rule: 'block-no-empty',
      cwe: null,
      file: 'src/app.css',
      line: 4,
      severity: 'baixa',
      snippet: 'Unexpected empty block (block-no-empty)',
    }),
  ]);
  assert.equal(findings[0]?.severity, 'baixa');
  assert.notEqual(findings[0]?.severity, 'alta');
});

test('error vira media, warning vira baixa, e nenhuma regra do Stylelint vira alta', () => {
  const findings = stylelintToFindings('css/app.css', {
    results: [
      {
        warnings: [
          {line: 2, rule: 'color-no-invalid-hex', severity: 'error', text: 'Unexpected invalid hex color "#ab"'},
          {line: 8, rule: 'block-no-empty', severity: 'warning', text: 'Unexpected empty block'},
          {line: 3, rule: 'TOKENS-CINZAS-DEMAIS', severity: 'error', text: 'nao promover'},
          {line: 5, rule: 'WCAG-2-4-7-FOCO-INVISIVEL', severity: 'warning', text: 'foco'},
          {rule: 'block-no-empty', severity: 'ERROR', text: '   bloco vazio   '},
        ],
      },
    ],
  });
  assert.deepEqual(findings.map(item => item.severity), ['media', 'baixa', 'media', 'baixa', 'media']);
  assert.equal(findings.some(item => item.severity === 'alta'), false);
  assert.equal(findings[0]?.tool, 'stylelint');
  assert.equal(findings[0]?.cwe, null);
  assert.equal(findings[0]?.file, 'css/app.css');
  assert.equal(findings[0]?.line, 2);
  assert.equal(findings[4]?.line, null);
  assert.equal(findings[4]?.snippet, 'bloco vazio');
  assert.equal(findings[2]?.rule, 'TOKENS-CINZAS-DEMAIS');
});

test('json vazio ou sem warnings não gera achado', () => {
  assert.deepEqual(stylelintToFindings('css/app.css', null), []);
  assert.deepEqual(stylelintToFindings('css/app.css', {}), []);
  assert.deepEqual(stylelintToFindings('css/app.css', {results: []}), []);
  assert.deepEqual(stylelintToFindings('css/app.css', {results: [{warnings: [null, {text: 'sem regra'}]}]}), []);
  const fromCli = stylelintToFindings('css/app.css', [
    {warnings: [{line: 1, rule: 'block-no-empty', severity: 'warning', text: 'vazio'}]},
  ]);
  assert.equal(fromCli.length, 1);
  assert.equal(fromCli[0]?.severity, 'baixa');
  assert.equal(fromCli[0]?.line, 1);
});
