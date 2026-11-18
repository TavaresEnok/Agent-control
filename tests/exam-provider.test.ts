import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {acceptClaudeExamSeat, classifyExamReservation} from '../src/exam-provider.ts';
import {highFindingCloses} from '../src/verify-remediate.ts';

const seat = (provider: string, accountId = 'conta-a') => ({provider, accountId, grantId: 'grant-1'});

test('a reserva de exame aceita Claude e recusa Grok e Codex', () => {
  const accepted = acceptClaudeExamSeat(seat('claude'));
  assert.equal(accepted.provider, 'claude');
  assert.equal(accepted, acceptClaudeExamSeat(accepted));
  for (const provider of ['grok', 'codex']) {
    assert.throws(
      () => acceptClaudeExamSeat(seat(provider)),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_PROVIDER_UNSUPPORTED',
    );
    const choice = classifyExamReservation(seat(provider, 'conta-outra'), ['conta-a'], 0);
    assert.equal(choice.kind, 'skip');
    assert.equal('seat' in choice, false);
  }
  assert.equal(classifyExamReservation(seat('claude', 'conta-a'), undefined, 0).kind, 'use');
  const held = classifyExamReservation(seat('claude', 'conta-a'), ['conta-a'], 0);
  assert.equal(held.kind, 'hold');
  if (held.kind === 'hold') assert.equal(held.seat.provider, 'claude');
  const sameAccount = classifyExamReservation(seat('claude', 'conta-a'), ['conta-a'], 3);
  assert.equal(sameAccount.kind, 'use');
  if (sameAccount.kind === 'use') assert.equal(sameAccount.seat.provider, 'claude');
});

test('highFindingCloses fecha por Claude distinto ou pela prova de diff', () => {
  const review = (accountId: string, sessionId: string, provider = 'claude', status: 'descartado' | 'confirmado' = 'descartado') => ({
    status, provider, accountId, sessionId,
  });
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: false,
    first: review('conta-a', 'sessao-1'),
    second: review('conta-b', 'sessao-1'),
  }), true);
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: false,
    first: review('conta-a', 'sessao-1'),
    second: review('conta-a', 'sessao-2'),
  }), true);
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: false,
    first: review('conta-a', 'sessao-1'),
    second: review('conta-a', 'sessao-1'),
  }), false);
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: false,
    first: review('conta-a', 'sessao-1', 'grok'),
    second: review('conta-b', 'sessao-2', 'codex'),
  }), false);
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: true,
    first: review('conta-a', 'sessao-1'),
    second: review('conta-a', 'sessao-1', 'claude', 'confirmado'),
  }), true);
  assert.equal(highFindingCloses({
    seen: true,
    snippetGone: false,
    first: review('', 'sessao-1'),
    second: review('conta-b', 'sessao-1'),
  }), false);
});
