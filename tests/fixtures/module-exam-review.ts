import type {ModuleReviewObservation} from '../../src/module-exam-proof.ts';
import type {ModuleRawFinding} from '../../src/verification-modules.ts';

export const skipQuestion = 'A declaração nomeada de teste usa o modificador explícito skip ou todo?';
export const qaStaticTool = 'qa-auditoria-estatica-testes';

export function qaStaticFinding(file: string, line: number, expression: string, kind: 'skip' | 'nondeterminism' = 'skip'): ModuleRawFinding {
  const [rule, prefix] = kind === 'skip'
    ? ['QA-TESTE-PULADO', 'skip/todo explícito']
    : ['QA-PADRAO-NAO-DETERMINISTICO', 'uso de Math.random/waitForTimeout'];
  return {tool: qaStaticTool, rule: rule!, file, line, severity: 'media',
    message: 'CONCLUSAO_DO_AUTOR', evidence: `${prefix} em ${file}:${line} -> ${expression}`};
}

export type ReviewTaskFixture = Omit<ModuleReviewObservation, 'column' | 'expression'> & {
  code: string; binding: string; reasonTemplate?: string; discardReasonTemplate?: string;
};
export function reviewFixtureVerdict(task: ReviewTaskFixture, expression: string, status: 'confirmado' | 'descartado' = 'confirmado') {
  const {binding, code, criterion, file, line, tool, rule, commit} = task;
  const column = code.indexOf(expression) + 1;
  const testCall = /^(?:test|it)(?:\.(skip|todo))?\(\s*(['"])(.*?)\2/u.exec(expression);
  const values: Record<string, string> = {
    coluna: String(column), titulo: JSON.stringify(testCall?.[3] ?? ''), modificador: testCall?.[1] ?? '',
  };
  const template = status === 'confirmado' ? task.reasonTemplate : task.discardReasonTemplate;
  return {kind: 'confirmacao' as const, status, binding, proof: code, decision: status === 'confirmado' ? 'sustenta' as const : 'contradiz' as const,
    reason: template?.replace(/\{(\w+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder) ?? 'Observação sintética.',
    observation: {criterion, file, line, tool, rule, ...(commit ? {commit} : {}), column, expression}};
}
