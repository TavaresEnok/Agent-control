import {Refusal} from './contracts.ts';
import {
  DesignConfirmResult,
  DesignCoverageRow,
  DesignExamFinding,
  DesignExamResult,
  DesignWorkerCall,
  DesignMeasure,
  clampHighSeverity,
  type DesignChecklistItem,
  type DesignMeasure as DesignMeasureValue,
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

/** One PNG the examiner and the reviewer both open. The path is on disk for the call. */
export type DesignScreenCapture = {
  path: string;
  viewport: number;
  theme: 'claro' | 'escuro';
  state: string;
  sha256: string;
};

export type DesignExamineInput = {
  repo: string;
  intentId: string;
  screens: readonly {
    file: string;
    route: string;
    code: string;
    captureNote: string;
    captures?: readonly DesignScreenCapture[];
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

const SEVERITY_ALIASES: Record<string, 'alta' | 'media' | 'baixa' | 'informativa'> = {
  alta: 'alta', high: 'alta', critical: 'alta', critica: 'alta', crítico: 'alta', critico: 'alta',
  media: 'media', medium: 'media', média: 'media', medio: 'media',
  baixa: 'baixa', low: 'baixa',
  informativa: 'informativa', info: 'informativa', informative: 'informativa', nota: 'informativa',
};

function textOf(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function checklistIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value) : [];
  const ids: string[] = [];
  for (const item of raw) {
    const source = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? String((item as {id?: unknown; item?: unknown}).id ?? (item as {item?: unknown}).item ?? '')
        : '';
    const id = source.trim().slice(0, 80);
    if (id.length > 0 && !ids.includes(id)) ids.push(id);
    if (ids.length >= 80) break;
  }
  return ids;
}

function fileToken(value: unknown): string {
  return String(value ?? '').trim().split(/[\s(]/)[0]?.slice(0, 400) ?? '';
}

/** A real model keeps the fields and drifts on names. The bench already matches the schema. */
function normalizeDesignExam(value: unknown, fallback: {file: string; checklist: readonly string[]}): unknown {
  if (!value || typeof value !== 'object' || (value as {kind?: unknown}).kind !== 'exame') return value;
  const row = value as {filesRead?: unknown; checklist?: unknown; findings?: unknown};
  const files = (Array.isArray(row.filesRead) ? row.filesRead : []).map(fileToken).filter(item => item.length > 0).slice(0, 80);
  const checklist = checklistIds(row.checklist);
  const findings = (Array.isArray(row.findings) ? row.findings : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const finding = item as Record<string, unknown>;
    const title = textOf(finding.title, 200);
    const file = textOf(finding.file, 400);
    const scenario = textOf(finding.scenario ?? finding.note, 2000);
    const suggestion = textOf(finding.suggestion, 2000);
    const reference = textOf(finding.reference, 120);
    if (!title || !file || !scenario || !suggestion || !reference) return [];
    const lineNumber = typeof finding.line === 'number' ? finding.line : Number.NaN;
    const line = Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : null;
    const cwe = typeof finding.cwe === 'string' && /^CWE-\d{1,5}$/.test(finding.cwe) ? finding.cwe : null;
    const severity = SEVERITY_ALIASES[textOf(finding.severity, 40).toLowerCase()] ?? 'informativa';
    const measure = readMeasure(finding.measure);
    return [{
      title,
      severity,
      file,
      line,
      scenario,
      suggestion,
      cwe,
      reference,
      snippet: textOf(finding.snippet, 240),
      ...(measure === undefined ? {} : {measure}),
    }];
  }).slice(0, 40);
  return {
    kind: 'exame',
    filesRead: (files.length > 0 ? files : [fallback.file]).slice(0, 80),
    checklist: (checklist.length > 0 ? checklist : [...fallback.checklist]).slice(0, 80),
    findings,
  };
}

function normalizeDesignConfirm(value: unknown): unknown {
  if (!value || typeof value !== 'object' || (value as {kind?: unknown}).kind !== 'confirmacao') return value;
  const row = value as {status?: unknown; reason?: unknown; proof?: unknown};
  const status = textOf(row.status, 40).toLowerCase();
  const mapped = status === 'confirmed' || status === 'confirm' ? 'confirmado'
    : status === 'provável' || status === 'probable' || status === 'likely' ? 'provavel'
      : status === 'discarded' || status === 'rejected' || status === 'rejeitado' ? 'descartado'
        : status;
  return {kind: 'confirmacao', status: mapped, reason: textOf(row.reason, 2000), proof: textOf(row.proof, 2000)};
}

function readMeasure(value: unknown): DesignMeasureValue | undefined {
  const parsed = DesignMeasure.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function examMeasure(finding: DesignExamFinding, rawFindings: readonly DesignRawFinding[]): DesignMeasureValue | undefined {
  if (finding.measure !== undefined) return finding.measure;
  for (const raw of rawFindings) {
    if (raw.measure === undefined) continue;
    if (raw.file !== finding.file) continue;
    if (finding.reference === raw.rule || finding.reference.includes(raw.rule)) return raw.measure;
  }
  return undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll(' | ', ' / ').trim();
}

const CAPTURE_SHA = /^[a-f0-9]{64}$/;
const CAPTURE_STATE = /^(?:padrao|vazio|carregando|erro)$/;

function usableCapture(item: DesignScreenCapture): boolean {
  return CAPTURE_SHA.test(item.sha256)
    && (item.theme === 'claro' || item.theme === 'escuro')
    && CAPTURE_STATE.test(item.state)
    && Number.isInteger(item.viewport)
    && item.viewport > 0
    && item.viewport < 10000
    && item.path.length > 1
    && item.path.length <= 500
    && !/[\s\r\n]/.test(item.path);
}

/**
 * After the lists the bench reads. `listAfter` stops at the first line that does not start with `- `.
 * The line is not `- tool=`, so it is not a tool finding.
 * `/work` is the checkout bind in native-execution-supervisor.ts (tools mount, and the worker when it receives one).
 */
function captureBlock(captures: readonly DesignScreenCapture[] | undefined): string[] {
  const lines = (captures ?? []).filter(usableCapture);
  if (lines.length === 0) return [];
  return [
    'Abra o PNG no caminho e olhe a imagem. Não decida só pelo código.',
    'No contêiner o mesmo arquivo está em /planning/capturas/<sha256>.png e, se /work existir, em /work/capturas/<sha256>.png.',
    'Capturas:',
    ...lines.map(item => `- arquivo=${item.path} viewport=${item.viewport} tema=${item.theme} estado=${item.state} sha256=${item.sha256}`),
    ...lines.map(item => `- contêiner=/planning/capturas/${item.sha256}.png`),
    ...lines.map(item => `- contêiner=/work/capturas/${item.sha256}.png`),
  ];
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
    'checklist é uma lista de ids em texto. severity é alta, media, baixa ou informativa. cwe é null ou CWE-n.',
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
    ...captureBlock(screen.captures),
    'Código:',
    screen.code.slice(0, 20000),
  ].join('\n').slice(0, 100000);
}

/** Arquivo, linha, regra, trecho e código. Sem a sugestão e sem a conclusão. */
function confirmationTask(finding: DesignExamFinding, code: string, captures: readonly DesignScreenCapture[] | undefined): string {
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
    ...captureBlock(captures),
  ].join('\n').slice(0, 100000);
}

async function confirmFinding(
  input: DesignExamineInput,
  examinerProvider: string,
  finding: DesignExamFinding,
  code: string,
  captures: readonly DesignScreenCapture[] | undefined,
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
      task: confirmationTask(finding, code, captures),
      repo: input.repo,
      writePaths: [] as const,
    });
    const output = await input.worker.run(call);
    const parsed = DesignConfirmResult.safeParse(normalizeDesignConfirm(parseJson(output)));
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

    const exam = DesignExamResult.safeParse(normalizeDesignExam(parseJson(output), {file: screen.file, checklist: ids}));
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
      const reviewed = await confirmFinding(input, seat.provider, finding, screen.code, screen.captures);
      const measure = examMeasure(finding, input.rawFindings);
      const clamped = DesignExamFinding.parse({
        ...finding,
        ...(measure === undefined ? {} : {measure}),
        severity: clampHighSeverity(finding.severity, measure),
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
