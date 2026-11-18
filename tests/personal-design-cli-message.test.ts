import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Refusal} from '../src/contracts.ts';
import {designCliFailureText} from '../src/personal-design-cli.ts';

const leaked = 'secret-token-xyz /home/app/private';
const redacted = 'O exame de design falhou.';

test('erro desconhecido e recusa com código desconhecido saem numa frase fixa, sem segredo nem caminho', () => {
  for (const error of [new Error(leaked), new Refusal(leaked), new Refusal('DESIGN_CODE_UNKNOWN')]) {
    const text = designCliFailureText(error);
    assert.equal(text, redacted);
    assert.equal(text.includes('secret-token-xyz'), false);
    assert.equal(text.includes('/home/app/private'), false);
    if (error instanceof Error && error.stack) assert.equal(text.includes(error.stack), false);
  }
});

test('DESIGN_PREPARE_NO_CLAUDE diz que o projeto não tem conta Claude', () => {
  assert.equal(designCliFailureText(new Refusal('DESIGN_PREPARE_NO_CLAUDE')), 'O projeto não tem conta Claude.');
});

test('DESIGN_USAGE continua a linha de uso em português', () => {
  const usage = 'Uso: npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo>]';
  assert.equal(designCliFailureText(new Refusal('DESIGN_USAGE')), usage);
  assert.equal(designCliFailureText(new Error('DESIGN_USAGE')), usage);
});
