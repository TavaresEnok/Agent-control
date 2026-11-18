import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {Refusal} from '../src/contracts.ts';
import {examineDesignScreens, referenceCaptureLines} from '../src/design-examine.ts';
import {stageDesignReferences} from '../src/design-reference-files.ts';
import {DESIGN_PLANTED_RULES, designRawFinding, type DesignWorker} from '../src/design-types.ts';
import {parseVisualScores, visualReportMarkdown, VISUAL_AXES, type VisualScore} from '../src/design-visual.ts';

/** PNG 1x1. The header is the signature stageDesignReferences checks. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function refusedReference(error: unknown): boolean {
  assert.equal(error instanceof Refusal, true);
  assert.equal((error as Refusal).code, 'DESIGN_REFERENCE_INVALID');
  assert.equal(String((error as {code?: unknown}).code).includes('EEXIST'), false);
  assert.equal((error as Error).message.includes('EEXIST'), false);
  return true;
}

test('pedido do worker lista a referência no mesmo contêiner da captura', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-ref-image-'));
  try {
    const pngSha = createHash('sha256').update(PNG_1X1).digest('hex');
    const staged = await stageDesignReferences({
      dataDirectory: data,
      runId: randomUUID(),
      files: [{name: 'Foto.PNG', bytes: PNG_1X1}],
    });
    const refPath = join(staged.directory, 'foto.png');
    const captureSha = 'ab'.repeat(32);
    const capturePath = `/tmp/design-captures/${captureSha}.png`;
    const tasks: string[] = [];
    const bench = designBenchWorker();
    const worker: DesignWorker = {
      async run(call) {
        tasks.push(call.task);
        return bench.run(call);
      },
    };
    const seat = () => ({
      provider: 'claude',
      model: 'modelo',
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    });
    await examineDesignScreens({
      repo: '/tmp/repo-design',
      intentId: randomUUID(),
      screens: [{
        file: 'src/Tela.tsx',
        route: '/tela',
        code: 'export function Tela() {\n  return <button type="button">Salvar</button>;\n}\n',
        captureNote: 'sem captura',
        captures: [{path: capturePath, viewport: 375, theme: 'claro', state: 'padrao', sha256: captureSha}],
      }],
      checklist: loadDesignChecklist().slice(0, 2),
      rawFindings: [
        designRawFinding({
          tool: 'axe',
          rule: DESIGN_PLANTED_RULES.contrast,
          file: 'src/Tela.tsx',
          line: 4,
          severity: 'alta',
          snippet: 'color:#777',
          measure: {kind: 'contrast', ratio: 4.478089453577214},
        }),
        designRawFinding({
          tool: 'html',
          rule: 'GOSTO-PREFERENCIA',
          file: 'src/Tela.tsx',
          line: 8,
          severity: 'media',
          snippet: 'radius 13px',
        }),
      ],
      references: [{path: refPath, sha256: pngSha, name: 'Foto.PNG'}],
      scoreVisual: true,
      worker,
      reserve: async () => seat(),
      release: async () => {},
    });
    const exam = tasks.find(task => task.startsWith('Pedido de exame.')) ?? '';
    const visual = tasks.find(task => task.startsWith('Pedido de crítica visual.')) ?? '';
    const review = tasks.find(task => task.startsWith('Pedido de confirmação.')) ?? '';
    const listed = referenceCaptureLines([{path: refPath, sha256: pngSha, name: 'Foto.PNG'}]);
    assert.deepEqual(listed, [
      'Referências visuais:',
      `- arquivo=${refPath} nome=Foto.PNG sha256=${pngSha}`,
      `- contêiner=/planning/capturas/${pngSha}.png`,
      `- contêiner=/work/capturas/${pngSha}.png`,
    ]);
    for (const task of [exam, visual, review]) {
      assert.ok(task.includes(listed.join('\n')));
      assert.ok(task.includes(`- contêiner=/planning/capturas/${captureSha}.png`));
      assert.ok(task.includes(`- contêiner=/planning/capturas/${pngSha}.png`));
      assert.equal(task.includes(PNG_1X1.toString('base64')), false);
      assert.equal(task.includes('IHDR'), false);
    }
    assert.ok(exam.indexOf('Referências visuais:') > exam.indexOf('Capturas:'));
    assert.match(visual, /distance de 0 a 10/);
    assert.match(visual, /0 é igual à referência, 10 é outra solução/);
    assert.match(exam, new RegExp(`- arquivo=${capturePath.replaceAll('/', '\\/')} viewport=375 tema=claro estado=padrao sha256=${captureSha}`));
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('Foto.PNG e foto.png no mesmo stage recusam a segunda sem EEXIST', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-ref-case-'));
  try {
    await assert.rejects(
      () => stageDesignReferences({
        dataDirectory: data,
        runId: randomUUID(),
        files: [
          {name: 'Foto.PNG', bytes: PNG_1X1},
          {name: 'foto.png', bytes: PNG_1X1},
        ],
      }),
      refusedReference,
    );
    const runId = randomUUID();
    const staged = await stageDesignReferences({
      dataDirectory: data,
      runId,
      files: [{name: 'Foto.PNG', bytes: PNG_1X1}],
    });
    assert.equal(staged.note.includes('foto.png'), true);
    await assert.rejects(
      () => stageDesignReferences({
        dataDirectory: data,
        runId,
        files: [{name: 'foto.png', bytes: PNG_1X1}],
      }),
      refusedReference,
    );
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('crítica visual lê distance e põe o revisor na mesma linha', () => {
  const scores = VISUAL_AXES.map(axis => ({
    axis,
    score: axis === 'hierarquia' ? 4 : 8,
    region: axis === 'hierarquia' ? 'hero' : 'tela',
    suggestion: axis === 'hierarquia' ? 'Título 32px.' : 'Ajuste para 16px.',
    ...(axis === 'hierarquia' ? {distance: 3} : {}),
    ...(axis === 'cor' ? {distance: 11} : {}),
    ...(axis === 'ritmo' ? {distance: 0} : {}),
  }));
  const parsed = parseVisualScores({kind: 'visual', scores});
  assert.ok(parsed);
  assert.equal(parsed.find(item => item.axis === 'hierarquia')?.distance, 3);
  assert.equal(parsed.find(item => item.axis === 'cor')?.distance, undefined);
  assert.equal(parsed.find(item => item.axis === 'ritmo')?.distance, 0);
  assert.equal(parsed.find(item => item.axis === 'marca')?.distance, undefined);
  const examiner: VisualScore[] = parsed.map(item => item.axis === 'hierarquia' ? {...item, score: 4, distance: 3} : item);
  const reviewer: VisualScore[] = parsed.map(item => item.axis === 'hierarquia' ? {...item, score: 6, distance: undefined} : {...item, distance: undefined});
  const markdown = visualReportMarkdown([{
    route: '/tela',
    examiner,
    reviewer,
    uncertain: ['marca: examinador 3, revisor 6'],
  }]);
  assert.match(markdown, /- hierarquia: examinador 4\/10, revisor 6\/10 em hero\. Título 32px\. distância 3\/10/);
  assert.match(markdown, /Julgamento incerto: marca: examinador 3, revisor 6\./);
  assert.match(markdown, /- ritmo: examinador 8\/10, revisor 8\/10 em tela\. Ajuste para 16px\. distância 0\/10/);
});
