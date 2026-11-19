import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {Refusal} from '../src/contracts.ts';
import {examineDesignScreens, type DesignReserveOptions} from '../src/design-examine.ts';
import {
  DESIGN_PLANTED_RULES,
  DesignConfirmResult,
  DesignExamResult,
  DesignWorkerCall,
  clampHighSeverity,
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

function harness(reviewerProvider: 'claude' | 'grok' | 'codex' = 'claude') {
  const events: string[] = [];
  const specialist = {
    provider: 'claude',
    model: 'modelo-especialista',
    accountId: randomUUID(),
    profileId: randomUUID(),
  };
  const reviewer = {
    provider: reviewerProvider,
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
    if (role === 'reviewer') assert.equal(avoidProvider, undefined);
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
  const kit = harness();
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
      measure: {kind: 'contrast', ratio: 4.478089453577214},
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
      severity: 'media',
      snippet: 'radius 13px',
    }),
    designRawFinding({
      tool: 'css',
      rule: 'BONITO',
      file: screen.file,
      line: 9,
      severity: 'media',
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
  assert.deepEqual(planted?.finding.measure, {kind: 'contrast', ratio: 4.478089453577214});
  assert.equal(planted?.verifier, null);
  assert.equal(result.coverage[0]?.examinerProvider, 'claude');
  assert.match(planted?.confirm.proof ?? '', /color:#777/);
  assert.match(planted?.confirm.proof ?? '', /Medido/);
  assert.equal(taste?.confirm.status, 'descartado');
  assert.equal(taste?.finding.severity, 'media');
  assert.equal(opinion?.confirm.status, 'provavel');
  assert.equal(opinion?.finding.severity, 'media');
  assert.deepEqual(kit.events.slice(0, 6), [
    'reserve:specialist',
    'run:specialist',
    'release:claude',
    'reserve:reviewer',
    'run:reviewer',
    'release:claude',
  ]);
  const reviewerTasks = tasks.filter(task => task.startsWith('Pedido de confirmação.'));
  const examTask = tasks.find(task => task.startsWith('Pedido de exame.'));
  assert.equal(reviewerTasks.length, 2);
  assert.equal(reviewerTasks.some(task => task.includes(DESIGN_PLANTED_RULES.contrast)), false);
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
  assert.match(reviewerTasks[0] ?? '', /GOSTO-PREFERENCIA/);
});

test('dois papéis Claude são aceitos e grok ou codex são recusados', async () => {
  const allowed = harness();
  const raw = [
    designRawFinding({
      tool: 'axe',
      rule: DESIGN_PLANTED_RULES.contrast,
      file: screen.file,
      line: 4,
      severity: 'alta',
      snippet: 'color:#777',
      measure: {kind: 'contrast', ratio: 4.478089453577214},
    }),
    designRawFinding({
      tool: 'html',
      rule: 'GOSTO-PREFERENCIA',
      file: screen.file,
      line: 8,
      severity: 'media',
      snippet: 'radius 13px',
    }),
  ];
  const passed = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [screen],
    checklist: loadDesignChecklist(),
    rawFindings: raw,
    worker: allowed.worker,
    reserve: allowed.reserve,
    release: allowed.release,
  });
  assert.equal(passed.confirmations[0]?.verifier, null);
  assert.equal(passed.confirmations.find(item => item.verifier !== null)?.verifier?.provider, 'claude');
  assert.equal(passed.coverage[0]?.examinerProvider, 'claude');
  assert.ok(allowed.events.includes('run:reviewer'));
  for (const provider of ['grok', 'codex'] as const) {
    const kit = harness(provider);
    await assert.rejects(
      () => examineDesignScreens({
        repo: '/tmp/repo-design',
        intentId: randomUUID(),
        screens: [screen],
        checklist: loadDesignChecklist(),
        rawFindings: raw,
        worker: kit.worker,
        reserve: kit.reserve,
        release: kit.release,
      }),
      (error: unknown) => {
        assert.equal(error instanceof Refusal, true);
        assert.equal((error as Refusal).code, 'EXAM_PROVIDER_UNSUPPORTED');
        return true;
      },
    );
    assert.deepEqual(kit.events, [
      'reserve:specialist',
      'run:specialist',
      'release:claude',
      'reserve:reviewer',
      `release:${provider}`,
    ]);
  }
});

test('confirmação com JSON inválido é recusada e a vaga sai', async () => {
  const kit = harness();
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
        severity: 'media',
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
  assert.deepEqual(releases, ['claude', 'claude']);
});

test('cada tela reserva um especialista e o revisor lê o JSON cercado', async () => {
  const kit = harness();
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
      severity: 'media',
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
  assert.equal(result.confirmations[0]?.finding.severity, 'media');
  assert.equal(kit.events.filter(event => event === 'reserve:specialist').length, 2);
  assert.equal(kit.events.filter(event => event === 'reserve:reviewer').length, 1);
});

test('captura falsa entra no exame e na confirmação com o mesmo caminho e o mesmo sha256', async () => {
  const kit = harness();
  const tasks: string[] = [];
  const sha256 = 'ab'.repeat(32);
  const path = `/work/.design-captures/${sha256}.png`;
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [{
      ...screen,
      captureNote: 'sem captura',
      captures: [{path, viewport: 375, theme: 'claro', state: 'padrao', sha256}],
    }],
    checklist: loadDesignChecklist(),
    rawFindings: [
      designRawFinding({
        tool: 'axe',
        rule: DESIGN_PLANTED_RULES.contrast,
        file: screen.file,
        line: 4,
        severity: 'alta',
        snippet: 'color:#777',
        measure: {kind: 'contrast', ratio: 4.478089453577214},
      }),
      designRawFinding({
        tool: 'html',
        rule: 'GOSTO-PREFERENCIA',
        file: screen.file,
        line: 8,
        severity: 'media',
        snippet: 'radius 13px',
      }),
    ],
    worker: {
      async run(workerCall) {
        tasks.push(workerCall.task);
        assert.equal(workerCall.writePaths.length, 0);
        return kit.worker.run(workerCall);
      },
    },
    reserve: kit.reserve,
    release: kit.release,
  });
  const examTask = tasks.find(task => task.startsWith('Pedido de exame.')) ?? '';
  const reviewTask = tasks.find(task => task.startsWith('Pedido de confirmação.')) ?? '';
  assert.match(examTask, /Arquivos:\n- src\/Tela\.tsx/);
  assert.match(examTask, /Itens: DESIGN-NIELSEN-H1-ESTADO/);
  assert.match(examTask, new RegExp(`- tool=axe \\| rule=${DESIGN_PLANTED_RULES.contrast} \\| severity=alta`));
  assert.match(examTask, /Nota de captura:\nsem captura/);
  assert.match(examTask, /Abra o PNG no caminho e olhe a imagem/);
  assert.match(examTask, new RegExp(`Capturas:\\n- arquivo=${path.replaceAll('/', '\\/')} viewport=375 tema=claro estado=padrao sha256=${sha256}`));
  assert.match(reviewTask, new RegExp(`arquivo=${path.replaceAll('/', '\\/')} viewport=375 tema=claro estado=padrao sha256=${sha256}`));
  assert.equal(reviewTask.includes('suggestion'), false);
  assert.equal(result.confirmations[0]?.finding.reference, DESIGN_PLANTED_RULES.contrast);
  assert.equal(result.confirmations[0]?.verifier, null);
  assert.match(reviewTask, /GOSTO-PREFERENCIA|BONITO|radius 13px|sombra/);
  const bare = tasks.length;
  const without = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [{...screen, captureNote: 'sem captura'}],
    checklist: loadDesignChecklist().slice(0, 1),
    rawFindings: [],
    worker: {
      async run(workerCall) {
        assert.equal(workerCall.task.includes('Capturas:'), false);
        assert.match(workerCall.task, /Nota de captura:\nsem captura/);
        return kit.worker.run(workerCall);
      },
    },
    reserve: kit.reserve,
    release: kit.release,
  });
  assert.equal(without.findings.length, 0);
  assert.ok(bare >= 2);
});

test('o JSON de um modelo real entra mesmo com lista, gravidade e cwe fora do esquema', async () => {
  const kit = harness();
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [screen],
    checklist: loadDesignChecklist().slice(0, 2),
    rawFindings: [],
    worker: {
      async run(workerCall) {
        assert.equal(workerCall.writePaths.length, 0);
        if (workerCall.task.startsWith('Pedido de confirmação.')) {
          return JSON.stringify({
            kind: 'confirmacao',
            status: 'confirmed',
            reason: 'O contraste medido fica abaixo de 4.5.',
            proof: 'Captura em 375 px.',
          });
        }
        return JSON.stringify({
          kind: 'exame',
          filesRead: ['src/Tela.tsx (código do pedido)'],
          checklist: [{id: 'DESIGN-WCAG-143-CONTRASTE', status: 'fail'}],
          findings: [{
            title: 'Texto cinza no branco',
            severity: 'high',
            file: 'src/Tela.tsx',
            line: 4,
            scenario: 'O texto #777 sobre #fff em 375 px.',
            suggestion: 'Troque para #595959.',
            cwe: '',
            reference: 'WCAG-1-4-3-CONTRASTE',
            snippet: 'color:#777',
          }],
        });
      },
    },
    reserve: kit.reserve,
    release: kit.release,
  });
  assert.equal(result.notes.length, 0);
  assert.deepEqual(result.coverage[0]?.checklist, ['DESIGN-WCAG-143-CONTRASTE']);
  assert.equal(result.confirmations.length, 1);
  assert.equal(result.confirmations[0]?.finding.severity, 'media');
  assert.equal(result.confirmations[0]?.finding.cwe, null);
  assert.equal(result.confirmations[0]?.confirm.status, 'confirmado');
  assert.equal(result.confirmations[0]?.verifier?.provider, 'claude');
  assert.equal(result.confirmations[0]?.finding.measure, undefined);
});

test('corpo JSON ou nao-HTML nao e tela e nao gera achado', async () => {
  const kit = harness();
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [
      {file: 'src/Tarefa.tsx', route: '/tasks/1', code: '{"error":"AUTH_REQUIRED"}', captureNote: 'captura'},
      {file: 'src/Texto.tsx', route: '/texto', code: 'AUTH_REQUIRED', captureNote: 'captura'},
      screen,
    ],
    checklist: loadDesignChecklist().slice(0, 1),
    rawFindings: [],
    worker: kit.worker,
    reserve: kit.reserve,
    release: kit.release,
  });
  assert.equal(result.findings.length, 0);
  assert.equal(result.confirmations.length, 0);
  assert.deepEqual(result.coverage.map(row => row.file), [screen.file]);
  assert.equal(kit.events.filter(event => event === 'reserve:specialist').length, 1);
  assert.match(result.notes.join('\n'), /\/tasks\/1/);
  assert.match(result.notes.join('\n'), /\/texto/);
  assert.match(result.notes.join('\n'), /não é tela/);
});

test('alta sem medida estruturada vira media e a razao medida permanece alta', () => {
  assert.equal(clampHighSeverity('alta', null), 'media');
  assert.equal(clampHighSeverity('alta', undefined), 'media');
  assert.equal(clampHighSeverity('media', {kind: 'contrast', ratio: 2.1}), 'media');
  assert.equal(clampHighSeverity('alta', {kind: 'contrast', ratio: 2.1}), 'alta');
  assert.equal(clampHighSeverity('alta', {kind: 'target', px: 24}), 'alta');
  assert.equal(clampHighSeverity('alta', {kind: 'overflow', px: 12}), 'alta');
  assert.equal(clampHighSeverity('alta', {kind: 'empty', capture: 'vazio-375-claro-vazio.png'}), 'alta');
  const kept = designRawFinding({
    tool: 'axe',
    rule: DESIGN_PLANTED_RULES.contrast,
    file: 'tela.html',
    line: 2,
    severity: 'alta',
    snippet: 'contraste 2.10:1',
    measure: {kind: 'contrast', ratio: 2.1},
  });
  assert.equal(kept.severity, 'alta');
  assert.deepEqual(kept.measure, {kind: 'contrast', ratio: 2.1});
  const bare = designRawFinding({
    tool: 'html',
    rule: 'WCAG-2-4-4-BOTAO-SEM-NOME',
    file: 'tela.html',
    line: 3,
    severity: 'alta',
    snippet: 'button',
  });
  assert.equal(bare.severity, 'media');
  assert.equal(bare.measure, undefined);
});

test('crítica visual e confirmações excluem todos os perfis que examinaram a tela na execução', async () => {
  const codeExaminer = {provider: 'claude', model: 'modelo-codigo', accountId: randomUUID(), profileId: randomUUID()};
  const visualExaminer = {provider: 'claude', model: 'modelo-visual', accountId: randomUUID(), profileId: randomUUID()};
  const reviewerSeat = {provider: 'claude', model: 'modelo-revisor', accountId: randomUUID(), profileId: randomUUID()};
  const visualScores = [
    'hierarquia', 'tipografia', 'cor', 'ritmo', 'grade', 'densidade', 'componentes', 'marca', 'polimento',
  ].map(axis => ({axis, score: axis === 'marca' ? 3 : 9, region: 'topo', suggestion: 'Trocar gradiente por #1b1917.'}));
  const reviewOptions: (DesignReserveOptions | undefined)[] = [];
  let specialistCalls = 0;

  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [screen],
    checklist: loadDesignChecklist().slice(0, 1),
    rawFindings: [],
    scoreVisual: true,
    worker: {
      async run(workerCall) {
        if (workerCall.task.startsWith('Pedido de exame.')) {
          assert.equal(workerCall.profileId, codeExaminer.profileId);
          return JSON.stringify({
            kind: 'exame',
            filesRead: [screen.file],
            checklist: ['DESIGN-WCAG-143-CONTRASTE'],
            findings: [{
              title: 'Contraste baixo',
              severity: 'media',
              file: screen.file,
              line: 2,
              scenario: 'Texto claro',
              suggestion: 'Usar #1b1b1b',
              cwe: null,
              reference: 'WCAG-1-4-3',
              snippet: 'color:#777',
            }],
          });
        }
        if (workerCall.task.startsWith('Pedido de crítica visual do revisor.')) {
          assert.equal(workerCall.profileId, reviewerSeat.profileId);
          return JSON.stringify({kind: 'visual', scores: visualScores});
        }
        if (workerCall.task.startsWith('Pedido de crítica visual.')) {
          assert.equal(workerCall.profileId, visualExaminer.profileId);
          return JSON.stringify({kind: 'visual', scores: visualScores});
        }
        if (workerCall.task.startsWith('Pedido de confirmação.')) {
          assert.equal(workerCall.profileId, reviewerSeat.profileId);
          return JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'Confirmado.', proof: 'trecho'});
        }
        throw new Error(`unexpected task: ${workerCall.task}`);
      },
    },
    reserve: async (role, _avoidProvider, options) => {
      if (role === 'specialist') {
        specialistCalls += 1;
        const base = specialistCalls === 1 ? codeExaminer : visualExaminer;
        return {...base, grantId: randomUUID()};
      }
      reviewOptions.push(options);
      assert.equal(options?.avoidProfileIds?.includes(codeExaminer.profileId), true);
      assert.equal(options?.avoidProfileIds?.includes(visualExaminer.profileId), true);
      assert.equal(options?.avoidAccountIds?.includes(codeExaminer.accountId), true);
      assert.equal(options?.avoidAccountIds?.includes(visualExaminer.accountId), true);
      return {...reviewerSeat, grantId: randomUUID()};
    },
    release: async () => {},
  });

  // 1) confirmação do achado de código, 2) crítica visual do revisor, 3) confirmação do achado visual
  assert.equal(reviewOptions.length, 3);
  assert.equal(result.confirmations.length, 2);
  assert.equal(result.visual.length, 1);
});
