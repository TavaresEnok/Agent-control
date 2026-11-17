import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {Refusal} from '../src/contracts.ts';
import {examineDesignScreens} from '../src/design-examine.ts';
import {
  DESIGN_PLANTED_RULES,
  DesignConfirmResult,
  DesignExamResult,
  DesignWorkerCall,
  designRawFinding,
  type DesignWorker,
} from '../src/design-types.ts';

function concrete(value: string): boolean {
  return /#[0-9a-fA-F]{3,8}\b/.test(value) || /\d+px\b/.test(value) || /"[^"]+"/.test(value);
}

function call(role: 'specialist' | 'reviewer', task: string): DesignWorkerCall {
  return {
    role,
    provider: 'claude',
    accountId: randomUUID(),
    profileId: randomUUID(),
    model: 'modelo',
    grantId: randomUUID(),
    intentId: randomUUID(),
    task,
    repo: '/tmp/repo-design',
    writePaths: [],
  };
}

test('bancada copia arquivos e itens e só promove alta e media', async () => {
  const worker = designBenchWorker();
  const exam = DesignExamResult.parse(JSON.parse(await worker.run(call('specialist', [
    'Pedido de exame.',
    'Arquivos:',
    '- src/Tela.tsx',
    'Itens: DESIGN-WCAG-143-CONTRASTE, DESIGN-NIELSEN-H1-ESTADO',
    'Achados de ferramenta:',
    `- tool=axe | rule=${DESIGN_PLANTED_RULES.contrast} | severity=alta | line=4 | file=src/Tela.tsx | snippet=color:#777`,
    '- tool=html | rule=GOSTO-PREFERENCIA | severity=media | line=8 | file=src/Tela.tsx | snippet=radius 13px',
    '- tool=stylelint | rule=block-no-empty | severity=baixa | line=2 | file=src/Tela.tsx | snippet=vazio',
    '- tool=inventario | rule=TOKENS-CINZAS-DEMAIS | severity=informativa | line=9 | file=src/Tela.tsx | snippet=cinza',
  ].join('\n')))));
  assert.deepEqual(exam.filesRead, ['src/Tela.tsx']);
  assert.deepEqual(exam.checklist, ['DESIGN-WCAG-143-CONTRASTE', 'DESIGN-NIELSEN-H1-ESTADO']);
  assert.deepEqual(exam.findings.map(entry => entry.reference), [DESIGN_PLANTED_RULES.contrast, 'GOSTO-PREFERENCIA']);
  assert.equal(exam.findings[0]?.severity, 'alta');
  assert.equal(exam.findings[1]?.severity, 'media');
  for (const finding of exam.findings) {
    assert.equal(concrete(finding.suggestion), true, finding.suggestion);
    assert.match(finding.title, /[A-Za-zÀ-ú]/);
  }
  assert.match(exam.findings[0]?.suggestion ?? '', /#1b1b1b/);
  assert.match(exam.findings[0]?.suggestion ?? '', /4\.5:1/);

  const planted = DesignConfirmResult.parse(JSON.parse(await worker.run(call('reviewer', [
    'Pedido de confirmação.',
    'Arquivo: src/Tela.tsx',
    'Linha: 4',
    'Título: Contraste abaixo de 4.5:1',
    `Regra: ${DESIGN_PLANTED_RULES.contrast}`,
    'Trecho: color:#777',
    'Código:',
    '<button type="button">Salvar</button>',
  ].join('\n')))));
  assert.equal(planted.status, 'confirmado');
  assert.match(planted.proof, /color:#777/);

  const grays = DesignConfirmResult.parse(JSON.parse(await worker.run(call('reviewer', [
    'Pedido de confirmação.',
    'Título: Cinzas demais',
    `Regra: ${DESIGN_PLANTED_RULES.grays}`,
    'Trecho: #888888',
  ].join('\n')))));
  assert.equal(grays.status, 'confirmado');
  assert.match(grays.proof, /#888888/);

  const named = DesignConfirmResult.parse(JSON.parse(await worker.run(call('reviewer', [
    'Pedido de confirmação.',
    'Título: Alvo',
    'Regra: DESIGN-WCAG-258-ALVO-24',
    'Trecho: 16px',
  ].join('\n')))));
  assert.equal(named.status, 'confirmado');

  const taste = DesignConfirmResult.parse(JSON.parse(await worker.run(call('reviewer', [
    'Pedido de confirmação.',
    'Título: preferencia pessoal',
    'Regra: VISUAL',
    'Trecho: radius 13px',
  ].join('\n')))));
  assert.equal(taste.status, 'descartado');
  assert.match(taste.proof, /radius 13px/);

  const open = DesignConfirmResult.parse(JSON.parse(await worker.run(call('reviewer', [
    'Pedido de confirmação.',
    'Título: Ponto de interface',
    'Regra: VISUAL',
    'Trecho: sombra',
  ].join('\n')))));
  assert.equal(open.status, 'provavel');
});

type Seat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};

function harness(sameProvider: boolean) {
  const events: string[] = [];
  const specialist = {
    provider: 'claude',
    model: 'modelo-especialista',
    accountId: randomUUID(),
    profileId: randomUUID(),
  };
  const reviewer = {
    provider: sameProvider ? 'claude' : 'grok',
    model: 'modelo-revisor',
    accountId: randomUUID(),
    profileId: randomUUID(),
  };
  const bench = designBenchWorker();
  const worker: DesignWorker = {
    async run(workerCall) {
      events.push(`run:${workerCall.role}`);
      assert.equal(workerCall.writePaths.length, 0);
      return bench.run(workerCall);
    },
  };
  const reserve = async (role: 'specialist' | 'reviewer', avoidProvider?: string): Promise<Seat> => {
    events.push(`reserve:${role}`);
    if (role === 'reviewer') assert.equal(avoidProvider, specialist.provider);
    const base = role === 'reviewer' ? reviewer : specialist;
    return {...base, grantId: randomUUID()};
  };
  const release = async (seat: Seat) => {
    events.push(`release:${seat.provider}`);
  };
  return {events, specialist, reviewer, worker, reserve, release};
}

const screen = {
  file: 'src/Tela.tsx',
  route: '/tela',
  code: 'export function Tela() {\n  return <button type="button">Salvar</button>;\n}\n',
  captureNote: 'captura clara em 375',
};

test('exame confirma regra plantada, descarta gosto e esconde a sugestão', async () => {
  const kit = harness(false);
  const tasks: string[] = [];
  const checklist = loadDesignChecklist();
  const rawFindings = [
    designRawFinding({
      tool: 'axe',
      rule: DESIGN_PLANTED_RULES.contrast,
      file: screen.file,
      line: 4,
      severity: 'alta',
      snippet: 'color:#777;background:#ffffff',
    }),
    designRawFinding({
      tool: 'stylelint',
      rule: 'block-no-empty',
      file: screen.file,
      line: 2,
      severity: 'baixa',
      snippet: 'vazio',
    }),
    designRawFinding({
      tool: 'html',
      rule: 'GOSTO-PREFERENCIA',
      file: screen.file,
      line: 8,
      severity: 'alta',
      snippet: 'radius 13px',
    }),
    designRawFinding({
      tool: 'css',
      rule: 'BONITO',
      file: screen.file,
      line: 9,
      severity: 'alta',
      snippet: 'sombra',
    }),
  ];
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [screen],
    checklist,
    rawFindings,
    worker: {
      async run(workerCall) {
        tasks.push(workerCall.task);
        return kit.worker.run(workerCall);
      },
    },
    reserve: kit.reserve,
    release: kit.release,
  });
  assert.deepEqual(result.notes, []);
  assert.equal(result.coverage.length, 1);
  assert.equal(result.coverage[0]?.file, screen.file);
  assert.equal(result.coverage[0]?.examinerProvider, 'claude');
  assert.equal(result.coverage[0]?.examinerModel, 'modelo-especialista');
  assert.equal(result.coverage[0]?.profileId, kit.specialist.profileId);
  assert.deepEqual(result.coverage[0]?.checklist, checklist.map(entry => entry.id));
  assert.deepEqual(result.findings.map(entry => entry.reference), [
    DESIGN_PLANTED_RULES.contrast,
    'GOSTO-PREFERENCIA',
    'BONITO',
  ]);
  const byRule = new Map(result.confirmations.map(row => [row.finding.reference, row]));
  const planted = byRule.get(DESIGN_PLANTED_RULES.contrast);
  const taste = byRule.get('GOSTO-PREFERENCIA');
  const opinion = byRule.get('BONITO');
  assert.equal(planted?.confirm.status, 'confirmado');
  assert.equal(planted?.finding.severity, 'alta');
  assert.equal(planted?.verifier.provider, 'grok');
  assert.notEqual(planted?.verifier.provider, result.coverage[0]?.examinerProvider);
  assert.match(planted?.confirm.proof ?? '', /color:#777/);
  assert.equal(taste?.confirm.status, 'descartado');
  assert.equal(taste?.finding.severity, 'informativa');
  assert.equal(opinion?.confirm.status, 'provavel');
  assert.equal(opinion?.finding.severity, 'informativa');
  assert.deepEqual(kit.events.slice(0, 6), [
    'reserve:specialist',
    'run:specialist',
    'release:claude',
    'reserve:reviewer',
    'run:reviewer',
    'release:grok',
  ]);
  const reviewerTasks = tasks.filter(task => task.startsWith('Pedido de confirmação.'));
  const examTask = tasks.find(task => task.startsWith('Pedido de exame.'));
  assert.equal(reviewerTasks.length, 3);
  assert.match(examTask ?? '', /Arquivos:\n- src\/Tela\.tsx/);
  assert.match(examTask ?? '', /Itens: DESIGN-NIELSEN-H1-ESTADO/);
  assert.match(examTask ?? '', new RegExp(`- tool=axe \\| rule=${DESIGN_PLANTED_RULES.contrast} \\| severity=alta`));
  for (const task of reviewerTasks) {
    assert.equal(task.includes('suggestion'), false);
    assert.equal(task.toLowerCase().includes('conclusão do examinador'), false);
    assert.match(task, /Código:/);
    assert.match(task, /Salvar/);
    for (const finding of result.findings) {
      assert.equal(task.includes(finding.suggestion), false);
      assert.equal(task.includes(finding.scenario), false);
    }
  }
  assert.match(reviewerTasks[0] ?? '', new RegExp(DESIGN_PLANTED_RULES.contrast));
  assert.match(reviewerTasks[0] ?? '', /color:#777/);
});

test('mesmo provedor nos dois papéis é recusado e a vaga sai', async () => {
  const kit = harness(true);
  await assert.rejects(
    () => examineDesignScreens({
      repo: '/tmp/repo-design',
      intentId: randomUUID(),
      screens: [screen],
      checklist: loadDesignChecklist(),
      rawFindings: [designRawFinding({
        tool: 'axe',
        rule: DESIGN_PLANTED_RULES.contrast,
        file: screen.file,
        line: 4,
        severity: 'alta',
        snippet: 'color:#777',
      })],
      worker: kit.worker,
      reserve: kit.reserve,
      release: kit.release,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'DESIGN_PROVIDER_MUST_DIFFER');
      return true;
    },
  );
  assert.deepEqual(kit.events, [
    'reserve:specialist',
    'run:specialist',
    'release:claude',
    'reserve:reviewer',
    'release:claude',
  ]);
});

test('confirmação com JSON inválido é recusada e a vaga sai', async () => {
  const kit = harness(false);
  const releases: string[] = [];
  await assert.rejects(
    () => examineDesignScreens({
      repo: '/tmp/repo-design',
      intentId: randomUUID(),
      screens: [screen],
      checklist: loadDesignChecklist(),
      rawFindings: [designRawFinding({
        tool: 'axe',
        rule: DESIGN_PLANTED_RULES.narrow,
        file: screen.file,
        line: 3,
        severity: 'alta',
        snippet: 'width:980px',
      })],
      worker: {
        async run(workerCall) {
          assert.equal(workerCall.writePaths.length, 0);
          if (workerCall.task.startsWith('Pedido de confirmação.')) return 'sem-json';
          return designBenchWorker().run(workerCall);
        },
      },
      reserve: kit.reserve,
      release: async seat => {
        releases.push(seat.provider);
        await kit.release(seat);
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'DESIGN_CONFIRMATION_INVALID');
      return true;
    },
  );
  assert.deepEqual(releases, ['claude', 'grok']);
});

test('cada tela reserva um especialista e o revisor lê o JSON cercado', async () => {
  const kit = harness(false);
  const screens = [
    {file: 'src/A.tsx', route: '/a', code: 'export const a = 1;\n', captureNote: 'a'},
    {file: 'src/B.tsx', route: '/b', code: 'export const b = 2;\n', captureNote: 'b'},
  ];
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens,
    checklist: loadDesignChecklist(),
    rawFindings: [designRawFinding({
      tool: 'html',
      rule: DESIGN_PLANTED_RULES.empty,
      file: 'src/B.tsx',
      line: 1,
      severity: 'alta',
      snippet: 'data-list',
    })],
    worker: {
      async run(workerCall) {
        assert.equal(workerCall.writePaths.length, 0);
        if (workerCall.task.startsWith('Pedido de confirmação.')) {
          const body = JSON.stringify({
            kind: 'confirmacao',
            status: 'confirmado',
            reason: 'A lista não tem vazio.',
            proof: 'Trecho: data-list',
          });
          return '```json\n' + body + '\n```';
        }
        return designBenchWorker().run(workerCall);
      },
    },
    reserve: kit.reserve,
    release: kit.release,
  });
  assert.deepEqual(result.coverage.map(row => row.file), ['src/A.tsx', 'src/B.tsx']);
  assert.equal(result.confirmations.length, 1);
  assert.equal(result.confirmations[0]?.confirm.status, 'confirmado');
  assert.equal(result.confirmations[0]?.finding.reference, DESIGN_PLANTED_RULES.empty);
  assert.equal(result.confirmations[0]?.finding.severity, 'alta');
  assert.equal(kit.events.filter(event => event === 'reserve:specialist').length, 2);
  assert.equal(kit.events.filter(event => event === 'reserve:reviewer').length, 1);
});
