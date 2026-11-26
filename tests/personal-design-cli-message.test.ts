import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Refusal} from '../src/contracts.ts';
import {designCliFailureText, designExamStatus} from '../src/personal-design-cli.ts';
import {interpretDesignImageDocument} from '../src/design-image-run.ts';

const leaked = 'secret-token-xyz /home/app/private';
const redacted = 'O exame de design falhou.';

test('erro desconhecido e recusa com código desconhecido saem numa frase fixa, sem segredo nem caminho', () => {
  for (const error of [new Error(leaked), new Refusal(leaked), new Error('DESIGN_CODE_UNKNOWN')]) {
    const text = designCliFailureText(error);
    assert.equal(text, redacted);
    assert.equal(text.includes('secret-token-xyz'), false);
    assert.equal(text.includes('/home/app/private'), false);
    if (error instanceof Error && error.stack) assert.equal(text.includes(error.stack), false);
  }
});

test('recusa com código desconhecido mostra só o código, que não tem caminho nem segredo', () => {
  assert.equal(designCliFailureText(new Refusal('DESIGN_CODE_UNKNOWN')), 'O exame de design falhou (código DESIGN_CODE_UNKNOWN).');
});

test('DESIGN_PREPARE_NO_CLAUDE diz que o projeto não tem conta Claude', () => {
  assert.equal(designCliFailureText(new Refusal('DESIGN_PREPARE_NO_CLAUDE')), 'O projeto não tem conta Claude.');
});

test('DESIGN_USAGE continua a linha de uso em português', () => {
  const usage = 'Uso: npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo>] [--ca <arquivo.pem>] [--esperar-cota]';
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
  assert.equal(designCliFailureText(error), 'As vagas de execução para o design estão ocupadas. Repita com --esperar-cota para esperar na fila.');
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

test('uma rota que perde a sessão mantém o relatório e reprova a execução do design', () => {
  assert.deepEqual(designExamStatus({captureLoginFailed: true}), {
    code: 1,
    lines: ['Uma ou mais rotas perderam a sessão autenticada. Consulte o relatório de design.'],
  });
});

test('cada auditoria que perde a sessão reprova o CLI com as capturas disponíveis', () => {
  for (const tool of ['pa11y', 'lighthouse']) {
    const result = interpretDesignImageDocument({
      screenshots: [{fileName: 'painel.png', route: '/painel', viewport: 375}],
      unavailable: [],
      auditLoginFailures: [{tool, route: '/painel'}],
    });
    assert.equal(result.shotMeta.length, 1);
    assert.equal(designExamStatus(result).code, 1, tool);
  }
  const genericFailure = interpretDesignImageDocument({coverage: [{tool: 'pa11y', failure: 'DESIGN_PA11Y_FAILED'}]});
  assert.equal(designExamStatus(genericFailure).code, 0);
});
