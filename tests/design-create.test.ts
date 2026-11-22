import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {createTask, MAX_CREATE_TASK_CHARS, runDesignCreate} from '../src/design-create.ts';
import type {DesignWorker, DesignWorkerCall} from '../src/design-types.ts';

function seat() {
  return {
    provider: 'claude',
    model: 'claude-opus-5-5',
    accountId: randomUUID(),
    profileId: randomUUID(),
    grantId: randomUUID(),
  };
}

async function withDirs(run: (paths: {data: string; repo: string}) => Promise<void>): Promise<void> {
  const data = await mkdtemp(join(tmpdir(), 'design-create-a5-'));
  const repo = await mkdtemp(join(tmpdir(), 'design-repo-a5-'));
  try {
    await run({data, repo});
  } finally {
    await rm(data, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
}

test('briefing longo completo é enviado sem corte em todas as rodadas com a instrução condicional genérica', async () => {
  const baseBriefing = [
    '# Briefing longo',
    'Contexto detalhado da tela inicial. '.repeat(260),
    '## Variedade entre as telas',
    'Conceitos diferentes da mesma tela.',
  ].join('\n');
  const directions = [
    '### Direções deste lote',
    '- Conceito A (editorial-claro): fundo #FAF8F5 e tipografia serifada.',
    '- Conceito B (noturno-mineral): fundo #0D131A e contraste alto.',
  ].join('\n');
  const briefing = `${baseBriefing}\n\n${directions}`;
  assert.ok(baseBriefing.length > 8000);
  assert.ok(briefing.length > 8000);

  await withDirs(async ({data, repo}) => {
    const calls: DesignWorkerCall[] = [];
    const worker: DesignWorker = {
      async run(call) {
        calls.push(call);
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {color: {bg: {$type: 'color', $value: '#0d131a'}}},
            screens: [
              {name: 'noturno-mineral', html: '<html><body><main><h1>Conceito B corrigido</h1></main></body></html>', css: 'body{background:#0d131a;color:#f1f5f9}'},
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {color: {bg: {$type: 'color', $value: '#faf8f5'}}},
          screens: [
            {name: 'editorial-claro', html: '<html><body><main><h1>Conceito A</h1></main></body></html>', css: 'body{background:#faf8f5;color:#111}'},
            {name: 'noturno-mineral', html: '<html><body><main><h1>Conceito B inicial</h1></main></body></html>', css: 'body{background:#0d131a;color:#94a3b8}'},
          ],
        });
      },
    };

    const tokensSeen: {path: string; text: string}[] = [];
    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing,
      screens: 2,
      rounds: 2,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, _files, context) => {
        tokensSeen.push(context.tokens);
        return {
        notes: [`rodada ${round}`],
        screens: [
          {name: 'editorial-claro', rejected: false, findings: [], visualNotes: []},
          {
            name: 'noturno-mineral',
            rejected: round === 1,
            findings: round === 1
              ? [{
                  tool: 'visual',
                  rule: 'WCAG-1-4-3-CONTRASTE',
                  cwe: null,
                  file: 'noturno-mineral.css',
                  line: 1,
                  severity: 'alta',
                  snippet: 'contraste baixo',
                  fingerprint: 'a'.repeat(64),
                  measure: {kind: 'contrast', ratio: 3.1},
                }]
              : [],
            visualNotes: round === 1 ? ['elevar contraste do conceito B'] : [],
          },
        ],
        };
      },
    });

    assert.equal(calls.length, 2);
    // O exame de cada rodada recebe o tokens.json gerado, para comparar as telas com os tokens.
    assert.equal(tokensSeen.length, 2);
    for (const [at, seen] of tokensSeen.entries()) {
      assert.equal(seen.path, 'tokens.json');
      assert.equal(seen.text, await readFile(join(created.directory, `rodada-${at + 1}`, 'tokens.json'), 'utf8'));
    }
    assert.deepEqual(JSON.parse(tokensSeen[0]?.text ?? '{}'), {color: {bg: {$type: 'color', $value: '#faf8f5'}}});
    assert.equal(created.rounds.length, 2);
    for (const call of calls) {
      assert.equal(call.forcedModel, 'claude-opus-5-5');
      assert.equal(call.forcedEffort, 'high');
      assert.equal(call.task.includes(briefing), true);
      assert.equal(call.task.includes(directions), true);
      assert.equal(call.task.includes(briefing.slice(8000)), true);
      assert.match(
        call.task,
        /Quando o briefing pedir conceitos diferentes da mesma tela, preserve a função e as ações e siga as direções fornecidas a cada conceito, inclusive no retrabalho dos nomes rejeitados\./,
      );
    }
  });
});

test('lote explicitamente direcionado e telas distintas preservam o briefing original sem injetar direções padrão de outro domínio', async () => {
  const clinicalBriefing = [
    '# Painel de triagem hospitalar',
    'Desenhe dois conceitos diferentes da mesma tela de triagem clínica.',
    'Ações: classificar risco, chamar paciente e registrar sinais vitais.',
    'Direções do lote:',
    '- Conceito 1 (plantao-claro): superfície clara cirúrgica com fila priorizada por gravidade.',
    '- Conceito 2 (plantao-escuro): superfície escura para posto de enfermagem noturno.',
  ].join('\n');

  const task = createTask({
    briefing: clinicalBriefing,
    screens: 2,
    round: 1,
    referenceNote: '',
    rework: [],
  });

  assert.equal(task.includes(clinicalBriefing), true);
  assert.equal(/fatura|internet|pix|assinante/i.test(task), false);

  await withDirs(async ({data, repo}) => {
    let seenTask = '';
    const worker: DesignWorker = {
      async run(call) {
        seenTask = call.task;
        return JSON.stringify({
          kind: 'criacao',
          tokens: {color: {surface: {$type: 'color', $value: '#ffffff'}}},
          screens: [
            {name: 'triagem', html: '<html><body><h1>Triagem</h1></body></html>', css: 'body{color:#111}'},
            {name: 'prontuario', html: '<html><body><h1>Prontuário</h1></body></html>', css: 'body{color:#222}'},
          ],
        });
      },
    };

    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: 'Desenhe duas telas distintas do sistema clínico: triagem e prontuário.',
      screens: 2,
      rounds: 1,
      referenceNote: '2 referências visuais.',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async () => ({
        notes: [],
        screens: [
          {name: 'triagem', rejected: false, findings: [], visualNotes: []},
          {name: 'prontuario', rejected: false, findings: [], visualNotes: []},
        ],
      }),
    });

    assert.equal(seenTask.includes('2 referências visuais.'), true);
    assert.equal(/fatura|internet|pix|assinante/i.test(seenTask), false);
    assert.deepEqual(created.rounds[0]?.approved, ['triagem', 'prontuario']);
    const triagemHtml = await readFile(join(created.directory, 'rodada-1', 'triagem.html'), 'utf8');
    const prontuarioHtml = await readFile(join(created.directory, 'rodada-1', 'prontuario.html'), 'utf8');
    assert.match(triagemHtml, /href="triagem\.css"/);
    assert.match(prontuarioHtml, /href="prontuario\.css"/);
  });
});

test('retrabalho pede só os nomes rejeitados, preserva os aprovados e mantém as direções do briefing', async () => {
  await withDirs(async ({data, repo}) => {
    const tasks: string[] = [];
    const briefing = [
      '# Briefing — conceitos da mesma tela de logística',
      'Gere dois conceitos diferentes da mesma tela de expedição.',
      '- Conceito 1 (conceito-compacto): grade densa de docas.',
      '- Conceito 2 (conceito-editorial): foco no embarque prioritário.',
    ].join('\n');

    const worker: DesignWorker = {
      async run(call) {
        tasks.push(call.task);
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {rodada: 2},
            screens: [
              {name: 'conceito-compacto', html: '<html><body><h1>Compacto adulterado</h1></body></html>', css: 'body{color:#999}'},
              {name: 'conceito-editorial', html: '<html><body><h1>Editorial corrigido</h1></body></html>', css: 'body{color:#222}'},
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {rodada: 1},
          screens: [
            {name: 'conceito-compacto', html: '<html><body><h1>Compacto aprovado</h1></body></html>', css: 'body{color:#111}'},
            {name: 'conceito-editorial', html: '<html><body><h1>Editorial rejeitado</h1></body></html>', css: 'body{color:#444}'},
          ],
        });
      },
    };

    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing,
      screens: 2,
      rounds: 2,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => ({
        notes: [],
        screens: files.filter(file => file.path.endsWith('.html')).map(file => {
          const name = file.path.slice(0, -'.html'.length);
          const rejected = round === 1 && name === 'conceito-editorial';
          return {
            name,
            rejected,
            findings: rejected
              ? [{
                  tool: 'visual',
                  rule: 'TELA-375-QUEBRADA',
                  cwe: null,
                  file: 'conceito-editorial.html',
                  line: 1,
                  severity: 'alta',
                  snippet: 'overflow horizontal',
                  fingerprint: 'b'.repeat(64),
                  measure: {kind: 'overflow', px: 16},
                }]
              : [],
            visualNotes: rejected ? ['ajustar largura do conceito-editorial'] : [],
          };
        }),
      }),
    });

    assert.equal(tasks.length, 2);
    const reworkTask = tasks[1]!;
    assert.match(reworkTask, /screens tem 1 itens\./);
    assert.match(reworkTask, /Devolva só as telas rejeitadas, com o mesmo name\. Altere só o que os achados e as notas apontam\./);
    assert.match(reworkTask, /controles nativos do HTML/);
    assert.match(reworkTask, /foco visível/);
    assert.match(reworkTask, /Tela rejeitada conceito-editorial\./);
    assert.equal(reworkTask.includes('Tela rejeitada conceito-compacto'), false);
    assert.equal(reworkTask.includes(briefing), true);
    assert.match(reworkTask, /ajustar largura do conceito-editorial/);

    assert.deepEqual(created.rounds[0]?.approved, ['conceito-compacto']);
    assert.deepEqual(created.rounds[0]?.rejected, ['conceito-editorial']);
    assert.deepEqual(created.rounds[1]?.approved, ['conceito-compacto', 'conceito-editorial']);

    const compactR1 = await readFile(join(created.directory, 'rodada-1', 'conceito-compacto.html'), 'utf8');
    const compactR2 = await readFile(join(created.directory, 'rodada-2', 'conceito-compacto.html'), 'utf8');
    const editorialR2 = await readFile(join(created.directory, 'rodada-2', 'conceito-editorial.html'), 'utf8');
    assert.equal(compactR2, compactR1);
    assert.match(editorialR2, /Editorial corrigido/);
  });
});

test('estouro do teto de 100000 caracteres falha claramente antes de reservar assento ou disparar o worker', async () => {
  const baseLength = createTask({
    briefing: '',
    screens: 1,
    round: 1,
    referenceNote: '',
    rework: [],
  }).length;
  const exactBriefing = 'a'.repeat(MAX_CREATE_TASK_CHARS - baseLength);
  const exactTask = createTask({
    briefing: exactBriefing,
    screens: 1,
    round: 1,
    referenceNote: '',
    rework: [],
  });
  assert.equal(exactTask.length, MAX_CREATE_TASK_CHARS);

  await withDirs(async ({data, repo}) => {
    let reserveCalls = 0;
    let workerCalls = 0;

    await assert.rejects(
      () =>
        runDesignCreate({
          dataDirectory: data,
          runId: randomUUID(),
          repository: repo,
          briefing: `${exactBriefing}x`,
          screens: 1,
          rounds: 1,
          referenceNote: '',
          worker: {
            async run() {
              workerCalls += 1;
              return '{}';
            },
          },
          reserve: async () => {
            reserveCalls += 1;
            return seat();
          },
          release: async () => {},
          intentId: randomUUID(),
          examine: async () => ({notes: [], screens: []}),
        }),
      (error: unknown) =>
        error instanceof Refusal &&
        error.code === 'DESIGN_CREATE_PROMPT_TOO_LARGE' &&
        error.status === 400 &&
        error.message.includes('100000'),
    );
    assert.equal(reserveCalls, 0);
    assert.equal(workerCalls, 0);

    // Também quando a rodada 1 cabe no teto, mas o HTML anterior da rodada 2 faz o prompt montado exceder 100000 caracteres.
    let round2ReserveCalls = 0;
    let round2WorkerCalls = 0;
    let round2ReleaseCalls = 0;
    const nearLimitBriefing = 'b'.repeat(MAX_CREATE_TASK_CHARS - baseLength - 1000);

    await assert.rejects(
      () =>
        runDesignCreate({
          dataDirectory: data,
          runId: randomUUID(),
          repository: repo,
          briefing: nearLimitBriefing,
          screens: 1,
          rounds: 2,
          referenceNote: '',
          worker: {
            async run() {
              round2WorkerCalls += 1;
              return JSON.stringify({
                kind: 'criacao',
                tokens: {color: {bg: {$type: 'color', $value: '#fff'}}},
                screens: [
                  {name: 'conceito-a', html: `<html><body><p>${'h'.repeat(4000)}</p></body></html>`, css: 'body{color:#111}'},
                ],
              });
            },
          },
          reserve: async () => {
            round2ReserveCalls += 1;
            return seat();
          },
          release: async () => {
            round2ReleaseCalls += 1;
          },
          intentId: randomUUID(),
          examine: async () => ({
            notes: [],
            screens: [{name: 'conceito-a', rejected: true, findings: [], visualNotes: ['corrigir']}],
          }),
        }),
      (error: unknown) =>
        error instanceof Refusal &&
        error.code === 'DESIGN_CREATE_PROMPT_TOO_LARGE' &&
        error.status === 400 &&
        error.message.includes('100000'),
    );
    assert.equal(round2ReserveCalls, 1);
    assert.equal(round2WorkerCalls, 1);
    assert.equal(round2ReleaseCalls, 1);
  });
});
