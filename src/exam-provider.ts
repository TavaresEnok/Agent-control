import {Refusal} from './contracts.ts';

export type ExamSeat = {grantId: string; accountId: string; provider: string};

export type ExamReservationChoice =
  | {kind: 'use'; seat: ExamSeat}
  | {kind: 'hold'; accountId: string; seat: ExamSeat}
  | {kind: 'skip'; accountId: string};

/** Read-only exams accept only Claude. Grok and Codex are never returned. */
export function acceptClaudeExamSeat<T extends {provider: string}>(seat: T): T {
  if (seat.provider !== 'claude') throw new Refusal('EXAM_PROVIDER_UNSUPPORTED', 409);
  return seat;
}

/**
 * Prefer another Claude account when `avoidAccountIds` lists that account.
 * The same Claude account remains acceptable. A non-claude seat is skipped.
 */
export function classifyExamReservation(
  seat: ExamSeat,
  avoidAccountIds: readonly string[] | undefined,
  attempt: number,
): ExamReservationChoice {
  if (seat.provider !== 'claude') return {kind: 'skip', accountId: seat.accountId};
  const accepted = acceptClaudeExamSeat(seat);
  if (avoidAccountIds?.includes(accepted.accountId) && attempt < 3) {
    return {kind: 'hold', accountId: accepted.accountId, seat: accepted};
  }
  return {kind: 'use', seat: accepted};
}
