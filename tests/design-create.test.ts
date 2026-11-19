import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {
  createTask,
  extractSameScreenVarietyContext,
  isSameScreenVarietyBriefing,
  MAX_CREATE_TASK_CHARS,
  runDesignCreate,
} from '../src/design-create.ts';
import type {DesignRawFinding, DesignWorker, DesignWorkerCall} from '../src/design-types.ts';

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

function measuredFinding(file: string, snippet: string): DesignRawFinding {
  return {
    tool: 'visual',
    rule: 'TEXTO-CORTADO',
    cwe: null,
    file,
    line: 12,
    severity: 'alta',
    snippet,
    fingerprint: 'a'.repeat(64),
    measure: {kind: 'overflow', px: 18},
  };
}

test('briefing real tela-inicial-assinante.md (>8000 chars) preserva o fim, intenção, ações, rótulos e direções na criação e no retrabalho', async () => {
  const briefingPath = '/home/app/design-briefings/tela-inicial-assinante.md';
  assert.equal(existsSync(briefingPath), true, 'briefing tela-inicial-assinante.md deve existir');
  const briefing = await readFile(briefingPath, 'utf8');
  assert.ok(briefing.length > 8000, `briefing deve ultrapassar 8000 caracteres (atual: ${briefing.length})`);
  assert.equal(isSameScreenVarietyBriefing(briefing), true);

  const context = extractSameScreenVarietyContext(briefing, 2);
  assert.equal(context.intent.some(item => item.includes('Vértice Fibra')), true);
  assert.equal(context.actions.some(item => item.includes('Ver e pagar a fatura')), true);
  assert.equal(context.actions.some(item => item.includes('Situação da conexão e do plano')), true);
  assert.equal(context.actions.some(item => item.includes('Desbloqueio em confiança')), true);
  assert.equal(context.labels.includes('PIX copia e cola'), true);
  assert.equal(context.labels.includes('Código de barras'), true);
  assert.equal(context.labels.includes('2ª via'), true);
  assert.equal(context.directions.length, 2);

  await withDirs(async ({data, repo}) => {
    const calls: DesignWorkerCall[] = [];
    const worker: DesignWorker = {
      async run(call) {
        calls.push(call);
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {color: {fundo: {$type: 'color', $value: '#0b1215'}}},
            screens: [
              {
                name: 'noturno-tecnico',
                html: '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"></head><body><main><h1>Marina</h1><button>Código de barras</button></main></body></html>',
                css: 'body{margin:0;background:#0b1215;color:#f8fafc}button{white-space:nowrap}',
              },
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {color: {fundo: {$type: 'color', $value: '#faf7f2'}}},
          screens: [
            {
              name: 'editorial-claro',
              html: '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"></head><body><main><h1>Marina</h1><button>PIX copia e cola</button></main></body></html>',
              css: 'body{margin:0;background:#faf7f2;color:#111827}button{white-space:nowrap}',
            },
            {
              name: 'noturno-tecnico',
              html: '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"></head><body><main><h1>Marina</h1><button class="quebrado">Código de barras</button></main></body></html>',
              css: 'body{margin:0;background:#0b1215;color:#f8fafc}',
            },
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
        notes: [`rodada ${round}`],
        screens: files
          .filter(file => file.path.endsWith('.html'))
          .map(file => {
            const name = file.path.slice(0, -'.html'.length);
            const rejected = round === 1 && name === 'noturno-tecnico';
            return {
              name,
              rejected,
              findings: rejected ? [measuredFinding(file.path, 'Código de barras quebrando em 2 linhas')] : [],
              visualNotes: rejected ? ['manter rótulo Código de barras em linha única'] : [],
            };
          }),
      }),
    });

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.forcedModel, 'claude-opus-5-5');
      assert.equal(call.forcedEffort, 'medium');
      assert.equal(call.role, 'specialist');
      assert.deepEqual(call.writePaths, []);
      // O trecho após 8000 caracteres (## Variedade entre as telas) não pode ser cortado.
      assert.match(call.task, /## Variedade entre as telas/);
      assert.match(call.task, /conceito visual diferente[\s\S]*mesma tela inicial/);
      assert.match(call.task, /não telas diferentes do app/);
      // Intenção, ações, rótulos e todas as direções do lote presentes na criação e no retrabalho.
      assert.match(call.task, /Modo variedade da mesma tela:/);
      assert.match(call.task, /Intenção da mesma tela a preservar em todos os conceitos:/);
      assert.match(call.task, /Vértice Fibra/);
      assert.match(call.task, /Ações da mesma tela a preservar em todos os conceitos/);
      assert.match(call.task, /Ver e pagar a fatura/);
      assert.match(call.task, /Situação da conexão e do plano/);
      assert.match(call.task, /Desbloqueio em confiança/);
      assert.match(call.task, /Rótulos a preservar inteiros em linha única:/);
      assert.match(call.task, /white-space: nowrap/);
      assert.match(call.task, /Código de barras/);
      assert.match(call.task, /PIX copia e cola/);
      assert.match(call.task, /2ª via/);
      assert.match(call.task, /Direções por lote \(2 direções preservadas em todas as rodadas\):/);
      assert.match(call.task, /Lote direção 1: Direção 1/);
      assert.match(call.task, /Lote direção 2: Direção 2/);
    }

    const reworkTask = calls[1]!.task;
    assert.match(reworkTask, /screens tem 1 itens/);
    assert.match(reworkTask, /Retrabalho de variedade da mesma tela:/);
    assert.match(reworkTask, /Tela rejeitada noturno-tecnico\./);
    assert.match(reworkTask, /Direção deste conceito no lote \(2 de 2\): Direção 2/);
    assert.equal(reworkTask.includes('Tela rejeitada editorial-claro'), false);
    assert.deepEqual(created.rounds[0]?.approved, ['editorial-claro']);
    assert.deepEqual(created.rounds[0]?.rejected, ['noturno-tecnico']);
    assert.deepEqual(created.rounds[1]?.approved, ['editorial-claro', 'noturno-tecnico']);
  });
});

test('lote com 4 direções explícitas preserva todas as direções do lote na criação e no retrabalho parcial', async () => {
  const baseBriefing = await readFile('/home/app/design-briefings/tela-inicial-assinante.md', 'utf8');
  const batchDirections = [
    '',
    '## Lote 2 — Direções visuais por lote',
    '1. **Conceito Editorial Solar (`editorial-solar`)**: fundo marfim #FAF6EE, serifada Fraunces no valor R$ 99,90 e bordas 1px.',
    '2. **Conceito Noturno Fibra (`noturno-fibra`)**: fundo carvão #0A1014, tipografia Space Grotesk e faixa compacta de conexão.',
    '3. **Conceito Grade Suíça (`grade-suica`)**: divisores aparentes de 1px, alinhamento tabular em métricas e superfície branca pura.',
    '4. **Conceito Herói Fatura (`heroi-fatura`)**: cartão herói centralizado na fatura com PIX e código de barras lado a lado em linha única.',
  ].join('\n');
  const briefing = `${baseBriefing}\n${batchDirections}`;

  await withDirs(async ({data, repo}) => {
    const tasks: string[] = [];
    const worker: DesignWorker = {
      async run(call) {
        tasks.push(call.task);
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {lote: 2, rodada: 2},
            screens: [
              {name: 'noturno-fibra', html: '<html><body><main><h1>Noturno corrigido</h1></main></body></html>', css: 'body{color:#eee}'},
              {name: 'heroi-fatura', html: '<html><body><main><h1>Heroi corrigido</h1></main></body></html>', css: 'body{color:#111}'},
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {lote: 2, rodada: 1},
          screens: [
            {name: 'editorial-solar', html: '<html><body><main><h1>Editorial ok</h1></main></body></html>', css: 'body{color:#111}'},
            {name: 'noturno-fibra', html: '<html><body><main><h1>Noturno pendente</h1></main></body></html>', css: 'body{color:#222}'},
            {name: 'grade-suica', html: '<html><body><main><h1>Suica ok</h1></main></body></html>', css: 'body{color:#333}'},
            {name: 'heroi-fatura', html: '<html><body><main><h1>Heroi pendente</h1></main></body></html>', css: 'body{color:#444}'},
          ],
        });
      },
    };

    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing,
      screens: 4,
      rounds: 2,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => ({
        notes: [],
        screens: files
          .filter(file => file.path.endsWith('.html'))
          .map(file => {
            const name = file.path.slice(0, -'.html'.length);
            const rejected = round === 1 && (name === 'noturno-fibra' || name === 'heroi-fatura');
            return {
              name,
              rejected,
              findings: rejected ? [measuredFinding(file.path, 'contraste insuficiente')] : [],
              visualNotes: rejected ? ['ajustar contraste mantendo direção do lote'] : [],
            };
          }),
      }),
    });

    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.match(task, /Direções por lote \(4 direções preservadas em todas as rodadas\):/);
      assert.match(task, /Conceito Editorial Solar \(editorial-solar\)/);
      assert.match(task, /Conceito Noturno Fibra \(noturno-fibra\)/);
      assert.match(task, /Conceito Grade Suíça \(grade-suica\)/);
      assert.match(task, /Conceito Herói Fatura \(heroi-fatura\)/);
    }

    const reworkTask = tasks[1]!;
    assert.match(reworkTask, /screens tem 2 itens/);
    assert.match(reworkTask, /Direção deste conceito no lote \(2 de 4\): 2\. Conceito Noturno Fibra \(noturno-fibra\)/);
    assert.match(reworkTask, /Direção deste conceito no lote \(4 de 4\): 4\. Conceito Herói Fatura \(heroi-fatura\)/);
    assert.equal(reworkTask.includes('Tela rejeitada editorial-solar'), false);
    assert.equal(reworkTask.includes('Tela rejeitada grade-suica'), false);
    assert.deepEqual(created.rounds[1]?.approved, ['editorial-solar', 'noturno-fibra', 'grade-suica', 'heroi-fatura']);
  });
});

test('extrai direções em subcabeçalhos ### e linhas Direções por lote / Rótulos', () => {
  const briefing = [
    '# Painel do assinante — mesma tela inicial',
    'Intenção: exibir status da fibra e permitir pagamento imediato.',
    'Ações: Pagar fatura com PIX, Copiar código de barras, Desbloqueio em confiança.',
    'Rótulos: Pagar fatura, PIX copia e cola, Código de barras, Desbloqueio em confiança.',
    'Variedade da mesma tela: gere 2 conceitos visuais diferentes da mesma tela.',
    '## Direções do lote',
    '### Conceito 1 — Claro Mineral',
    '- Fundo pedra clara #F5F5F0',
    '- Tipografia humanista com peso 700 no valor',
    '### Conceito 2 — Escuro Grafite',
    '- Fundo grafite #101418',
    '- Tipografia geométrica e acento ciano',
  ].join('\n');

  assert.equal(isSameScreenVarietyBriefing(briefing), true);
  const ctx = extractSameScreenVarietyContext(briefing, 2);
  assert.equal(ctx.directions.length, 2);
  assert.match(ctx.directions[0] ?? '', /Conceito 1 — Claro Mineral — Fundo pedra clara #F5F5F0 — Tipografia humanista/);
  assert.match(ctx.directions[1] ?? '', /Conceito 2 — Escuro Grafite — Fundo grafite #101418 — Tipografia geométrica/);
  assert.equal(ctx.labels.includes('Código de barras'), true);
  assert.equal(ctx.labels.includes('PIX copia e cola'), true);
  assert.equal(ctx.labels.includes('Desbloqueio em confiança'), true);
});

test('modo normal de telas distintas com briefing longo (>8000 chars) e retrabalho não ativa variedade da mesma tela', async () => {
  const filler = Array.from({length: 180}, (_, index) => `Detalhe funcional do fluxo ${index + 1}: validação de campos, estados de erro e confirmação acessível.`).join('\n');
  const normalBriefing = [
    '# Aplicativo de atendimento técnico',
    'Desenhe 3 telas distintas do fluxo de atendimento em campo:',
    '1. Tela de login do técnico com matrícula e senha.',
    '2. Tela de fila de ordens de serviço do dia.',
    '3. Tela de encerramento da visita com assinatura.',
    filler,
    'MARCADOR_FINAL_BRIEFING_LONGO_NORMAL: todas as 3 telas distintas usam tokens consistentes.',
  ].join('\n');

  assert.ok(normalBriefing.length > 12_000);
  assert.equal(isSameScreenVarietyBriefing(normalBriefing), false);

  await withDirs(async ({data, repo}) => {
    const tasks: string[] = [];
    const worker: DesignWorker = {
      async run(call) {
        tasks.push(call.task);
        if (call.task.includes('HTML anterior:')) {
          return JSON.stringify({
            kind: 'criacao',
            tokens: {rodada: 2},
            screens: [
              {name: 'fila-ordens', html: '<html><body><main><h1>Fila corrigida</h1></main></body></html>', css: 'body{color:#111}'},
            ],
          });
        }
        return JSON.stringify({
          kind: 'criacao',
          tokens: {rodada: 1},
          screens: [
            {name: 'login-tecnico', html: '<html><body><main><h1>Login</h1></main></body></html>', css: 'body{color:#111}'},
            {name: 'fila-ordens', html: '<html><body><main><h1>Fila com defeito</h1></main></body></html>', css: 'body{color:#222}'},
            {name: 'encerramento', html: '<html><body><main><h1>Encerramento</h1></main></body></html>', css: 'body{color:#333}'},
          ],
        });
      },
    };

    const created = await runDesignCreate({
      dataDirectory: data,
      runId: randomUUID(),
      repository: repo,
      briefing: normalBriefing,
      screens: 3,
      rounds: 2,
      referenceNote: '',
      worker,
      reserve: async () => seat(),
      release: async () => {},
      intentId: randomUUID(),
      examine: async (round, files) => ({
        notes: [`rodada ${round}`],
        screens: files
          .filter(file => file.path.endsWith('.html'))
          .map(file => {
            const name = file.path.slice(0, -'.html'.length);
            const rejected = round === 1 && name === 'fila-ordens';
            return {
              name,
              rejected,
              findings: rejected ? [measuredFinding(file.path, 'alvo menor que 44px')] : [],
              visualNotes: rejected ? ['aumentar botão de filtro'] : [],
            };
          }),
      }),
    });

    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.equal(task.includes('Modo variedade da mesma tela:'), false);
      assert.equal(task.includes('Retrabalho de variedade da mesma tela:'), false);
      assert.equal(task.includes('MARCADOR_FINAL_BRIEFING_LONGO_NORMAL'), true);
    }
    assert.match(tasks[0]!, /screens tem 3 itens/);
    assert.match(tasks[1]!, /screens tem 1 itens/);
    assert.match(tasks[1]!, /Tela rejeitada fila-ordens\./);
    assert.equal(tasks[1]!.includes('Tela rejeitada login-tecnico'), false);
    assert.equal(tasks[1]!.includes('Tela rejeitada encerramento'), false);
    assert.deepEqual(created.rounds[1]?.approved, ['login-tecnico', 'fila-ordens', 'encerramento']);
  });
});

test('limites do runtime falham explicitamente com DESIGN_CREATE_INVALID sem truncamento silencioso nem vazamento de assento', async () => {
  await withDirs(async ({data, repo}) => {
    let reserved = 0;
    let released = 0;
    const base = {
      dataDirectory: data,
      repository: repo,
      screens: 2,
      rounds: 2,
      referenceNote: '',
      reserve: async () => {
        reserved += 1;
        return seat();
      },
      release: async () => {
        released += 1;
      },
      intentId: randomUUID(),
      worker: {
        async run() {
          throw new Error('worker-should-not-run');
        },
      },
      examine: async () => {
        throw new Error('examine-should-not-run');
      },
    };

    // Briefing vazio ou só espaço.
    await assert.rejects(
      () => runDesignCreate({...base, runId: randomUUID(), briefing: '   \n\t  '}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );

    // Telas ou rodadas não inteiras ou fora da faixa.
    for (const bad of [
      {screens: 0, rounds: 1},
      {screens: 9, rounds: 1},
      {screens: 1.5, rounds: 1},
      {screens: Number.NaN, rounds: 1},
      {screens: 1, rounds: 0},
      {screens: 1, rounds: 6},
      {screens: 1, rounds: 2.5},
    ]) {
      await assert.rejects(
        () => runDesignCreate({...base, ...bad, runId: randomUUID(), briefing: 'Uma tela.'}),
        (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
      );
    }

    // Briefing que ultrapassa MAX_CREATE_TASK_CHARS (100000) falha antes de reservar assento.
    const oversizedBriefing = `Briefing enorme.\n${'x'.repeat(MAX_CREATE_TASK_CHARS)}`;
    assert.throws(
      () => createTask({briefing: oversizedBriefing, screens: 2, round: 1, referenceNote: '', rework: []}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
    await assert.rejects(
      () => runDesignCreate({...base, runId: randomUUID(), briefing: oversizedBriefing}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
    assert.equal(reserved, 0);
    assert.equal(released, 0);

    // Briefing que cabe na rodada 1 mas estoura 100000 caracteres ao somar o retrabalho na rodada 2 falha explicitamente na rodada 2 sem truncar.
    const nearLimitBriefing = `Variedade entre as telas: conceitos da mesma tela inicial.\n${'b'.repeat(94_000)}`;
    let roundCalls = 0;
    await assert.rejects(
      () =>
        runDesignCreate({
          ...base,
          runId: randomUUID(),
          briefing: nearLimitBriefing,
          screens: 1,
          rounds: 2,
          worker: {
            async run() {
              roundCalls += 1;
              return JSON.stringify({
                kind: 'criacao',
                tokens: {rodada: roundCalls},
                screens: [
                  {
                    name: 'conceito-1',
                    html: `<html><body><p>${'h'.repeat(7500)}</p></body></html>`,
                    css: 'body{color:#111}',
                  },
                ],
              });
            },
          },
          examine: async () => ({
            notes: [],
            screens: [
              {
                name: 'conceito-1',
                rejected: true,
                findings: [measuredFinding('conceito-1.html', 'overflow')],
                visualNotes: ['corrigir largura'],
              },
            ],
          }),
        }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
    assert.equal(roundCalls, 1);
    assert.equal(reserved, 1);
    assert.equal(released, 1);

    // HTML ou CSS retornado pelo modelo acima do limite de 200000 bytes falha explicitamente com DESIGN_CREATE_INVALID.
    await assert.rejects(
      () =>
        runDesignCreate({
          ...base,
          runId: randomUUID(),
          briefing: 'Uma tela.',
          screens: 1,
          rounds: 1,
          worker: {
            async run() {
              return JSON.stringify({
                kind: 'criacao',
                tokens: {color: {}},
                screens: [{name: 'inicio', html: `<p>${'a'.repeat(200_005)}</p>`, css: 'body{color:#111}'}],
              });
            },
          },
        }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_INVALID',
    );
    assert.equal(reserved, 2);
    assert.equal(released, 2);
  });
});
