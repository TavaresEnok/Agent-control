import {Refusal} from './contracts.ts';

/** Consecutive failures with the same infrastructure code that stop an exam. */
export const EXAM_BREAKER_LIMIT = 3;
/** The exam reached `economy.maxModelCalls`. */
export const EXAM_MODEL_CALL_LIMIT = 'EXAM_MODEL_CALL_LIMIT';
/** A dependency of the exam (egress proxy, database, pinned image) is down. */
export const EXAM_DEPENDENCY_DOWN = 'EXAM_DEPENDENCY_DOWN';

/**
 * Codes that say the infrastructure failed, not the model's answer: a timeout, a worker that died, the egress proxy,
 * the native supervisor or the disk. Content codes (an invalid JSON answer, say) never count.
 */
export function isInfrastructureFailure(code: string): boolean {
  return /^EXECUTION_/u.test(code) || code === 'WORKER_EXITED_WITHOUT_RESULT' || /_EGRESS_/u.test(code)
    || /^NATIVE_/u.test(code) || /^PERSONAL_DISK_/u.test(code) || code === 'PERSONAL_SPACE_BUDGET_EXCEEDED'
    || code === 'STORAGE_LOW_SPACE' || code === EXAM_DEPENDENCY_DOWN;
}

/** Codes that stop the exam at the first occurrence: no space, a dependency down or the call ceiling reached. */
export function isImmediateStop(code: string): boolean {
  return code === 'PERSONAL_DISK_FULL' || code === 'PERSONAL_DISK_UNAVAILABLE' || code === 'STORAGE_LOW_SPACE'
    || code === 'PERSONAL_SPACE_BUDGET_EXCEEDED' || code === EXAM_DEPENDENCY_DOWN || code === EXAM_MODEL_CALL_LIMIT;
}

/** Thrown inside an exam once the breaker opens: every caller up to the exam loop lets it through. */
export class ExamStop extends Refusal {
  constructor(public readonly stopCode: string) { super(stopCode, 503); }
}

/**
 * One per exam, shared by examiner, visual critique and reviewer. Three failures in a row with the same infrastructure
 * code open it; a success or a content failure (the model answered) closes the streak; another infrastructure code
 * starts a new one. An immediate-stop code opens it at once.
 */
export class ExamBreaker {
  lastFailureCode: string | null = null;
  streak = 0;
  calls = 0;
  stopped: string | null = null;
  private streakCode: string | null = null;
  constructor(readonly limit = EXAM_BREAKER_LIMIT, readonly maxCalls?: number) {}

  /** Records one failure. True when the breaker is (now) open. */
  failure(code: string): boolean {
    this.lastFailureCode = code;
    if (isImmediateStop(code)) { this.stopped ??= code; return true; }
    if (!isInfrastructureFailure(code)) { this.streak = 0; this.streakCode = null; return this.stopped !== null; }
    this.streak = this.streakCode === code ? this.streak + 1 : 1;
    this.streakCode = code;
    if (this.streak >= this.limit) this.stopped ??= code;
    return this.stopped !== null;
  }

  /** The model answered: the infrastructure streak ends. */
  success(): void { this.streak = 0; this.streakCode = null; }

  /** Before reserving a seat: throws ExamStop when the breaker is open or the call ceiling is reached. */
  admit(): void {
    if (!this.stopped && this.maxCalls !== undefined && this.calls >= this.maxCalls) this.stopped = EXAM_MODEL_CALL_LIMIT;
    if (this.stopped) throw new ExamStop(this.stopped);
  }

  /** Counts one model call, right before it is made. */
  called(): void { this.calls++; }
}

/** Operator warning for an exam the breaker stopped. */
export function examStopText(code: string, limit = EXAM_BREAKER_LIMIT): string {
  if (code === EXAM_MODEL_CALL_LIMIT) return `Exame parado: chegou ao teto de chamadas ao modelo do projeto (economy.maxModelCalls). O relatório é parcial (${code}).`;
  if (code === EXAM_DEPENDENCY_DOWN) return `Exame parado: uma dependência do exame caiu. O relatório é parcial (${code}).`;
  if (isImmediateStop(code)) return `Exame parado por falta de espaço em disco. Libere espaço e rode de novo. O relatório é parcial (${code}).`;
  return `Exame parado: ${limit} falhas seguidas de infraestrutura com o código ${code}. Confira o runtime, o proxy de saída e o disco antes de rodar de novo. O relatório é parcial.`;
}
