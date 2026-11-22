import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderModuleReadme} from '../src/verification-modules-report.ts';
import type {Achado} from '../src/verify-types.ts';

const base = {
  module: 'documentacao' as const, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', directoryName: 'dir',
  createdAt: new Date('2026-11-22T00:00:00Z'), commit: 'a'.repeat(40), note: 'Nota.', discarded: 0, toolCoverage: [],
};

function achado(index: number, reference: string, severity: Achado['severity'], status: Achado['status']) {
  return {id: `ACH-${String(index).padStart(3, '0')}`, title: 't', severity, status, verifier: null, reference,
    where: {file: 'src/a.ts', line: 1}, scenario: 's', proof: 'p', suggestion: 'x', acceptance: 'y',
    sources: ['typedoc', 'R'], secretPreview: null} as unknown as Achado;
}

test('a contagem por gravidade mostra o total e os confirmados, e a tabela por regra mostra a inundação', () => {
  const achados = [
    achado(1, 'typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'media', 'provavel'),
    achado(2, 'typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'media', 'provavel'),
    achado(3, 'typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'media', 'provavel'),
    achado(4, 'mermaid:DOC-MERMAID-SINTAXE-INVALIDA', 'alta', 'confirmado'),
    achado(5, 'mermaid:DOC-MERMAID-SINTAXE-INVALIDA', 'alta', 'descartado'),
  ];
  const counts = {alta: 1, media: 0, baixa: 0, informativa: 0};
  const readme = renderModuleReadme({...base, total: achados.length, counts, achados});
  assert.ok(readme.includes('| Gravidade | Total sem descartados | Confirmados ou reabertos (nota de falha) |'));
  assert.ok(readme.includes('| média | 3 | 0 |'));
  assert.ok(readme.includes('| alta | 1 | 1 |'));
  assert.ok(readme.includes('| typedoc:DOC-TYPEDOC-SIMBOLO-SEM-DOC | 3 | média | provável 3 |'));
  assert.ok(readme.includes('| mermaid:DOC-MERMAID-SINTAXE-INVALIDA | 2 | alta | confirmado 1, descartado 1 |'));
  assert.match(readme, /Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta\./);

  const many = Array.from({length: 25}, (_, index) => achado(index + 1, `ferramenta:R-${index}`, 'baixa', 'provavel'));
  const limited = renderModuleReadme({...base, total: many.length, counts, achados: many});
  assert.ok(limited.includes('As 20 regras com mais achados, de 25.'));
  assert.equal(limited.split('\n').filter(line => line.startsWith('| ferramenta:R-')).length, 20);

  // Sem a lista de achados, a tabela continua a de antes.
  const legacy = renderModuleReadme({...base, total: 4, counts});
  assert.ok(legacy.includes('| Gravidade | Quantidade |'));
  assert.ok(legacy.includes('| alta | 1 |'));
  assert.ok(!legacy.includes('## Por regra'));
});
