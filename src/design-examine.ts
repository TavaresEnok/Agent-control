import {Refusal} from './contracts.ts';
import {
  DesignConfirmResult,
  DesignCoverageRow,
  DesignExamFinding,
  DesignExamResult,
  DesignWorkerCall,
  clampHighSeverity,
  type DesignChecklistItem,
  type DesignRawFinding,
  type DesignWorker,
} from './design-types.ts';

type DesignSeat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};

export type DesignExamineInput = {
  repo: string;
  intentId: string;
  screens: readonly {
    file: string;
    route: string;
    code: string;
    captureNote: string;
  }[];
  checklist: readonly DesignChecklistItem[];
  rawFindings: readonly DesignRawFinding[];
  worker: DesignWorker;
  reserve(role: 'specialist' | 'reviewer', avoidProvider?: string): Promise<DesignSeat>;
  release(seat: DesignSeat): Promise<void>;
};

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]) as unknown;
      } catch {
        return null;
      }
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll(' | ', ' / ').trim();
}

function toolLine(finding: DesignRawFinding): string {
  const line = finding.line === null ? '-' : String(finding.line);
  return `- tool=${oneLine(finding.tool)} | rule=${oneLine(finding.rule)} | severity=${finding.severity} | line=${line} | file=${oneLine(finding.file)} | snippet=${oneLine(finding.snippet)}`;
}

function examTask(
  screen: DesignExamineInput['screens'][number],
  ids: readonly string[],
  checklist: readonly DesignChecklistItem[],
  rawFindings: readonly DesignRawFinding[],
): string {
  const related = rawFindings.filter(item => item.file === screen.file);
  const questions = checklist
    .filter(entry => ids.includes(entry.id))
    .map(entry => `- ${entry.id} [${entry.appliesTo}]: ${entry.prompt}`);
  return [
    'Pedido de exame.',
    'Responda só um JSON com kind "exame", filesRead, checklist e findings.',
    'Cada finding usa title, severity, file, line, scenario, suggestion, cwe, reference e snippet.',
    'O campo suggestion traz cor, px ou texto concreto. Não escreva no repositório.',
    `Tela: ${oneLine(screen.route)}`,
    'Arquivos:',
    `- ${screen.file}`,
    `Itens: ${ids.join(', ')}`,
    'Achados de ferramenta:',
    ...related.map(toolLine),
    'Nota de captura:',
    screen.captureNote.trim() || 'sem nota',
    'Perguntas:',
    ...questions,
    'Código:',
    screen.code.slice(0, 20000),
  ].join('\n').slice(0, 100000);
}

/** Arquivo, linha, regra, trecho e código. Sem a sugestão e sem a conclusão. */
function confirmationTask(finding: DesignExamFinding, code: string): string {
  return [
    'Pedido de confirmação.',
    'Tente derrubar o ponto. Responda só um JSON com kind "confirmacao", status (confirmado, provavel ou descartado), reason e proof.',
    `Arquivo: ${finding.file}`,
    `Linha: ${finding.line ?? 'não informada'}`,
    `Título: ${oneLine(finding.title)}`,
    `Regra: ${oneLine(finding.reference)}`,
    `Trecho: ${oneLine(finding.snippet)}`,
    'Código:',
    code.slice(0, 20000),
  ].join('\n').slice(0, 100000);
}

async function confirmFinding(
  input: DesignExamineInput,
  examinerProvider: string,
  finding: DesignExamFinding,
  code: string,
): Promise<{seat: DesignSeat; confirm: DesignConfirmResult}> {
  const seat = await input.reserve('reviewer', examinerProvider);
  try {
    if (seat.provider === examinerProvider) throw new Refusal('DESIGN_PROVIDER_MUST_DIFFER');
    const call = DesignWorkerCall.parse({
      role: 'reviewer',
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId: input.intentId,
      task: confirmationTask(finding, code),
      repo: input.repo,
      writePaths: [] as const,
    });
    const output = await input.worker.run(call);
    const parsed = DesignConfirmResult.safeParse(parseJson(output));
    if (!parsed.success) throw new Refusal('DESIGN_CONFIRMATION_INVALID');
    return {seat, confirm: parsed.data};
  } finally {
    await input.release(seat);
  }
}

export async function examineDesignScreens(input: DesignExamineInput): Promise<{
  findings: DesignExamFinding[];
  coverage: DesignCoverageRow[];
  confirmations: {
    finding: DesignExamFinding;
    confirm: DesignConfirmResult;
    verifier: {model: string; provider: string};
  }[];
  notes: string[];
}> {
  const findings: DesignExamFinding[] = [];
  const coverage: DesignCoverageRow[] = [];
  const confirmations: {
    finding: DesignExamFinding;
    confirm: DesignConfirmResult;
    verifier: {model: string; provider: string};
  }[] = [];
  const notes: string[] = [];
  const ids = input.checklist.map(entry => entry.id).filter(id => id.length > 0 && id.length <= 80).slice(0, 80);
  if (ids.length === 0) {
    notes.push('A lista de verificação veio vazia.');
    return {findings, coverage, confirmations, notes};
  }
  if (input.screens.length === 0) notes.push('Nenhuma tela para examinar.');

  for (const screen of input.screens) {
    const seat = await input.reserve('specialist');
    let output = '';
    try {
      const call = DesignWorkerCall.parse({
        role: 'specialist',
        provider: seat.provider,
        accountId: seat.accountId,
        profileId: seat.profileId,
        model: seat.model,
        grantId: seat.grantId,
        intentId: input.intentId,
        task: examTask(screen, ids, input.checklist, input.rawFindings),
        repo: input.repo,
        writePaths: [] as const,
      });
      output = await input.worker.run(call);
    } finally {
      await input.release(seat);
    }

    const exam = DesignExamResult.safeParse(parseJson(output));
    const echoed = exam.success ? exam.data.checklist : [];
    const applied = (echoed.length > 0 ? echoed : ids)
      .map(id => id.slice(0, 80))
      .filter(id => id.length > 0)
      .slice(0, 80);
    coverage.push(DesignCoverageRow.parse({
      file: screen.file,
      examinerProvider: seat.provider,
      examinerModel: seat.model,
      profileId: seat.profileId,
      checklist: applied,
    }));
    if (!exam.success) {
      notes.push(`O exame de ${screen.file} não veio em JSON válido.`);
      continue;
    }
    if (!exam.data.filesRead.includes(screen.file)) {
      notes.push(`O examinador não marcou como lido: ${screen.file}.`);
    }
    for (const finding of exam.data.findings) {
      const reviewed = await confirmFinding(input, seat.provider, finding, screen.code);
      const clamped = DesignExamFinding.parse({
        ...finding,
        severity: clampHighSeverity(finding.severity, finding.reference),
      });
      findings.push(clamped);
      confirmations.push({
        finding: clamped,
        confirm: reviewed.confirm,
        verifier: {model: reviewed.seat.model, provider: reviewed.seat.provider},
      });
    }
  }

  return {findings, coverage, confirmations, notes};
}
