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

export type ReviewTaskFixture = Omit<ModuleReviewObservation, 'column' | 'expression'> & {code: string; binding: string};
export function reviewFixtureVerdict(task: ReviewTaskFixture, expression: string, status: 'confirmado' | 'descartado' = 'confirmado') {
  const {binding, code, criterion, file, line, tool, rule, commit} = task;
  return {kind: 'confirmacao' as const, status, binding, proof: code,
    reason: `Observação independente da chamada \`${expression}\`.`,
    observation: {criterion, file, line, tool, rule, ...(commit ? {commit} : {}),
      column: code.indexOf(expression) + 1, expression}};
}
