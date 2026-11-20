import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {Refusal} from '../src/contracts.ts';
import {examineDesignScreens, type DesignScreenCapture} from '../src/design-examine.ts';
import {designRawFinding, type DesignWorker} from '../src/design-types.ts';

const screen = {
  file: 'src/Tela.tsx',
  route: '/tela',
  code: 'export function Tela() {\n  return <button type="button">Salvar</button>;\n}\n',
  captureNote: 'captura clara em 375',
};

const invented = {kind: 'contrast' as const, ratio: 1.2};

function claudeSeats(reviewerProvider = 'claude') {
  const accounts = {specialist: randomUUID(), reviewer: randomUUID()};
  const reserve = async (role: 'specialist' | 'reviewer') => ({
    provider: role === 'reviewer' ? reviewerProvider : 'claude',
    model: role === 'reviewer' ? 'modelo-revisor' : 'modelo-especialista',
    accountId: accounts[role],
    profileId: randomUUID(),
    grantId: randomUUID(),
  });
  const release = async () => {};
  return {reserve, release};
}

function worker(finding: Record<string, unknown>): DesignWorker {
  return {
    async run(call) {
      if (call.task.startsWith('Pedido de confirmação.')) {
        return JSON.stringify({
          kind: 'confirmacao',
          status: 'confirmado',
          reason: 'O ponto aparece no código da tela.',
          proof: 'Trecho visto na captura.',
        });
      }
      return JSON.stringify({
        kind: 'exame',
        filesRead: [screen.file],
        checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
        findings: [finding],
      });
    },
  };
}

function modelFinding(reference: string): Record<string, unknown> {
  return {
    title: 'Contraste insuficiente',
    severity: 'alta',
    file: screen.file,
    line: 4,
    scenario: 'O texto cinza some no fundo branco.',
    suggestion: 'Use #595959 no texto.',
    cwe: null,
    reference,
    snippet: 'color:#777',
    measure: invented,
  };
}

async function examineOnce(input: {
  finding: Record<string, unknown>;
  rawFindings: ReturnType<typeof designRawFinding>[];
  captures?: readonly DesignScreenCapture[];
}, reviewerProvider: string) {
  const seats = claudeSeats(reviewerProvider);
  return examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [{...screen, ...(input.captures === undefined ? {} : {captures: input.captures})}],
    checklist: loadDesignChecklist().slice(0, 1),
    rawFindings: input.rawFindings,
    worker: worker(input.finding),
    reserve: seats.reserve,
    release: seats.release,
  });
}

/** Assentos Claude. Enquanto o mesmo provedor é recusado, o revisor repete sem ser Grok. */
async function examine(input: {
  finding: Record<string, unknown>;
  rawFindings: ReturnType<typeof designRawFinding>[];
  captures?: readonly DesignScreenCapture[];
}) {
  let result: Awaited<ReturnType<typeof examineDesignScreens>>;
  try {
    result = await examineOnce(input, 'claude');
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'DESIGN_PROVIDER_MUST_DIFFER') throw error;
    result = await examineOnce(input, 'revisor');
  }
  assert.equal(result.findings.length, 1);
  return result.findings[0];
}

test('medida inventada pelo modelo não fica no achado nem sustenta alta', async () => {
  const stored = await examine({
    finding: modelFinding('REGRA-INVENTADA'),
    rawFindings: [designRawFinding({
      tool: 'axe',
      rule: 'outra-regra',
      file: screen.file,
      line: 4,
      severity: 'alta',
      snippet: 'color:#777',
      measure: {kind: 'contrast', ratio: 9},
    })],
  });
  assert.equal(stored?.measure, undefined);
  assert.notEqual(stored?.severity, 'alta');
});

test('a medida guardada é a do axe, não a razão inventada pelo modelo', async () => {
  const rule = 'color-contrast';
  const stored = await examine({
    finding: modelFinding(rule),
    rawFindings: [
      designRawFinding({
        tool: 'axe', rule, file: screen.file, line: 18, severity: 'alta', snippet: 'outro botão',
        measure: {kind: 'contrast', ratio: 1.5},
      }),
      designRawFinding({
        tool: 'stylelint',
        rule,
        file: screen.file,
        line: 4,
        severity: 'alta',
        snippet: 'color:#777',
        measure: {kind: 'contrast', ratio: 9.9},
      }),
      designRawFinding({
        tool: 'axe',
        rule,
        file: screen.file,
        line: 4,
        severity: 'alta',
        snippet: 'color:#777',
        measure: {kind: 'contrast', ratio: 2.1},
      }),
    ],
  });
  assert.deepEqual(stored?.measure, {kind: 'contrast', ratio: 2.1});
  assert.notDeepEqual(stored?.measure, invented);
});

test('medida empty da régua só vale se a captura está na tela', async () => {
  const rule = 'ESTADOS-VAZIO-AUSENTE';
  const capture = 'vazio-375-claro-vazio.png';
  const raw = designRawFinding({
    tool: 'régua',
    rule,
    file: screen.file,
    line: 2,
    severity: 'alta',
    snippet: 'lista vazia',
    measure: {kind: 'empty', capture},
  });
  const listed: DesignScreenCapture = {
    path: `/tmp/capturas/${capture}`,
    viewport: 375,
    theme: 'claro',
    state: 'vazio',
    sha256: 'ab'.repeat(32),
  };
  const kept = await examine({
    finding: modelFinding(rule),
    rawFindings: [raw],
    captures: [listed],
  });
  assert.deepEqual(kept?.measure, {kind: 'empty', capture});

  const missing = await examine({
    finding: modelFinding(rule),
    rawFindings: [raw],
    captures: [{...listed, path: '/tmp/capturas/outra-coisa.png'}],
  });
  assert.equal(missing?.measure, undefined);
  assert.notEqual(missing?.severity, 'alta');
});
