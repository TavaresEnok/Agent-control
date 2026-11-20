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

test('DESIGN_BUSY dá mensagem clara e não vaza MANAGER_ACTIVE', () => {
  const text = designCliFailureText(new Refusal('DESIGN_BUSY', 409));
  assert.match(text, /design/i);
  assert.match(text, /andamento/i);
  assert.equal(text.includes('MANAGER_ACTIVE'), false);
});

test('CAPACITY_BUSY informa quando repetir o exame sem divulgar detalhes da reserva', () => {
  const error = new Refusal('CAPACITY_BUSY');
  error.message = leaked;
  assert.equal(designCliFailureText(error), 'As vagas de execução para o design estão ocupadas. Repita o exame quando houver uma vaga.');
});

test('DESIGN_REVIEWER_UNAVAILABLE orienta rodar preparar --aplicar e não cai em EXAM_PROVIDER_UNSUPPORTED', () => {
  const text = designCliFailureText(new Refusal('DESIGN_REVIEWER_UNAVAILABLE', 409));
  assert.match(text, /npm run personal:design -- preparar .*--aplicar/);
  assert.notEqual(text, designCliFailureText(new Refusal('EXAM_PROVIDER_UNSUPPORTED', 409)));
});

test('DESIGN_CREATE_PROMPT_TOO_LARGE explica o limite de 100000 caracteres e orienta reduzir briefing ou retrabalho sem vazar o prompt', () => {
  const refusal = new Refusal('DESIGN_CREATE_PROMPT_TOO_LARGE', 400);
  refusal.message = `O prompt de criação excedeu o limite: ${leaked}`;
  const text = designCliFailureText(refusal);
  assert.match(text, /100000/);
  assert.match(text, /briefing/i);
  assert.match(text, /retrabalho/i);
  assert.match(text, /reduza/i);
  assert.equal(text.includes('secret-token-xyz'), false);
  assert.equal(text.includes('/home/app/private'), false);
  assert.equal(designCliFailureText(new Error('DESIGN_CREATE_PROMPT_TOO_LARGE')), text);
});
