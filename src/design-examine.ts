import {Refusal} from './contracts.ts';
import {EXAM_LOGIN_STALE_TEXT, providerFailureCode, safeFailureCode} from './exam-login.ts';
import {acceptClaudeExamSeat} from './exam-provider.ts';
import {
  parseVisualScores,
  uncertainVisualAxes,
  visualExamFindings,
  type VisualScore,
} from './design-visual.ts';
import {
  DesignConfirmResult,
  DesignCoverageRow,
  DesignExamFinding,
  DesignExamResult,
  DesignWorkerCall,
  type DesignExamCoverage,
  clampHighSeverity,
  type DesignChecklistItem,
  type DesignMeasure as DesignMeasureValue,
  type DesignRawFinding,
  type DesignWorker,
} from './design-types.ts';

export type DesignReserveOptions = {
  purpose?: 'create' | 'examiner' | 'reviewer';
  avoidProfileId?: string;
  avoidProfileIds?: readonly string[];
  avoidAccountId?: string;
  avoidAccountIds?: readonly string[];
};

export type DesignSeat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
  grantRole?: 'specialist' | 'reviewer';
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
  reserve(role: 'specialist' | 'reviewer', avoidProvider?: string, options?: DesignReserveOptions): Promise<DesignSeat>;
  release(seat: DesignSeat): Promise<void>;
  /** Fora dos testes de sequência: a CLI liga a crítica visual. */
  scoreVisual?: boolean;
  referenceNote?: string;
  references?: readonly {path: string; sha256: string; name: string}[];
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
    if (ids.length >= 120) break;
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
    }];
  }).slice(0, 40);
  return {
    kind: 'exame',
    filesRead: (files.length > 0 ? files : [fallback.file]).slice(0, 80),
    checklist: (checklist.length > 0 ? checklist : [...fallback.checklist]).slice(0, 120),
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

function captureBasename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function emptyCaptureListed(capture: string, captures: readonly DesignScreenCapture[] | undefined): boolean {
  for (const item of captures ?? []) {
    if (captureBasename(item.path) === capture) return true;
    if (`${item.sha256}.png` === capture) return true;
  }
  return false;
}

const MEASURE_TOOL_RANK: Record<string, number> = {
  axe: 0,
  pa11y: 1,
  lighthouse: 2,
  tokens: 3,
  'css-analyzer': 4,
  régua: 5,
};

function examMeasure(
  finding: DesignExamFinding,
  rawFindings: readonly DesignRawFinding[],
  captures: readonly DesignScreenCapture[] | undefined,
): DesignMeasureValue | undefined {
  let best: DesignMeasureValue | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const raw of rawFindings) {
    if (raw.measure === undefined) continue;
    if (raw.file !== finding.file) continue;
    const named = finding.reference === raw.rule || finding.reference.includes(raw.rule) || finding.title.includes(raw.rule);
    if (!named) continue;
    if (raw.measure.kind === 'empty' && !emptyCaptureListed(raw.measure.capture, captures)) continue;
    const rank = MEASURE_TOOL_RANK[raw.tool] ?? 100;
    if (rank < bestRank) {
      best = raw.measure;
      bestRank = rank;
    }
  }
  return best;
}

function measureProof(measure: DesignMeasureValue, snippet: string): string {
  const detail = measure.kind === 'contrast' ? `razão ${measure.ratio}`
    : measure.kind === 'empty' ? `captura ${measure.capture}`
      : measure.kind === 'lighthouse' ? `${measure.metric} ${measure.value}`
        : measure.kind === 'wallace' ? `${measure.metric} ${measure.value}`
          : `${measure.kind} ${measure.px}px`;
  return `Medido: ${detail}. ${snippet}`.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function isNonHtmlResponse(code: string): boolean {
  const trimmed = code.trim().replace(/^\uFEFF/, '');
  if (trimmed.length === 0 || looksLikeSource(trimmed)) return false;
  return !/<\/?[A-Za-z!][^>]*>/.test(trimmed);
}

function looksLikeSource(text: string): boolean {
  if (/\b(?:function|export|const|let|var|import|return|class|interface|type)\b/.test(text)) return true;
  return /[.#]?[A-Za-z_-][\w-]*\s*\{/.test(text);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll(' | ', ' / ').trim();
}

const CAPTURE_SHA = /^[a-f0-9]{64}$/;
const CAPTURE_STATE = /^(?:padrao|vazio|carregando|erro|logado)$/;

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

const REFERENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpe?g)$/i;

function usableReference(item: {path: string; sha256: string; name: string}): boolean {
  return CAPTURE_SHA.test(item.sha256)
    && REFERENCE_NAME.test(item.name)
    && item.path.length > 1
    && item.path.length <= 500
    && !/[\s\r\n]/.test(item.path);
}

/** Same container paths as the screen PNG. The task names the file; it never embeds bytes. */
export function referenceCaptureLines(references: readonly {path: string; sha256: string; name: string}[] | undefined): string[] {
  const lines = (references ?? []).filter(usableReference).slice(0, 10);
  if (lines.length === 0) return [];
  return [
    'Referências visuais:',
    ...lines.map(item => `- arquivo=${item.path} nome=${item.name} sha256=${item.sha256}`),
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
  references: DesignExamineInput['references'],
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
    ...referenceCaptureLines(references),
    'Código:',
    screen.code.slice(0, 20000),
  ].join('\n').slice(0, 100000);
}

function visualTask(
  screen: DesignExamineInput['screens'][number],
  role: 'specialist' | 'reviewer',
  referenceNote: string | undefined,
  references: DesignExamineInput['references'],
): string {
  return [
    role === 'specialist' ? 'Pedido de crítica visual.' : 'Pedido de crítica visual do revisor.',
    'Responda só um JSON com kind "visual" e scores. Não escreva no repositório.',
    'Eixos, cada um de 0 a 10: hierarquia, tipografia, cor, ritmo, grade, densidade, componentes, marca, polimento.',
    'Cada item tem axis, score, region e suggestion. A suggestion traz cor, px, fonte ou layout.',
    'Cada eixo inclui distance de 0 a 10: 0 é igual à referência, 10 é outra solução. No JSON de scores, distance é numérico e opcional.',
    'A region aponta um trecho da captura ou um elemento. Não receba notas de outro examinador.',
    `Tela: ${oneLine(screen.route)}`,
    'Arquivos:',
    `- ${screen.file}`,
    ...(referenceNote && referenceNote.trim().length > 0 ? ['Referências:', referenceNote.trim().slice(0, 4000)] : []),
    ...captureBlock(screen.captures),
    ...referenceCaptureLines(references),
    'Código:',
    screen.code.slice(0, 12000),
  ].join('\n').slice(0, 100000);
}

type ModelHit = {output: string; failure: string | null};

/** A thrown model error or an auth sentence becomes a code. Login and provider refusal still propagate. */
async function runModel(worker: DesignWorker, call: DesignWorkerCall): Promise<ModelHit> {
  try {
    const output = await worker.run(call);
    const trimmed = output.trim();
    if (trimmed.length === 0) return {output: '', failure: 'EXECUTION_NATIVE_FAILED'};
    if (providerFailureCode(output) === 'PROVIDER_AUTH_FAILED' && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return {output: '', failure: 'PROVIDER_AUTH_FAILED'};
    }
    return {output, failure: null};
  } catch (error) {
    if (error instanceof Refusal && (error.code === 'EXAM_LOGIN_STALE' || error.code === 'EXAM_PROVIDER_UNSUPPORTED' || error.code === 'EXAM_LOGIN_BUSY' || error.code === 'EXAM_LOGIN_RESTORE_FAILED' || error.code === 'NATIVE_PRELAUNCH_SETTLEMENT_PENDING')) throw error;
    return {
      output: '',
      failure: error instanceof Refusal ? safeFailureCode(error.code) : 'EXECUTION_NATIVE_FAILED',
    };
  }
}

function blankExamCoverage(): DesignExamCoverage {
  const row = {model: 'desconhecido', requested: 0, judged: 0, failure: 'nenhuma'};
  return {examiner: {...row}, reviewer: {...row}};
}

async function askVisual(
  input: DesignExamineInput,
  screen: DesignExamineInput['screens'][number],
  role: 'specialist' | 'reviewer',
  avoid?: DesignReserveOptions,
): Promise<{scores: VisualScore[] | null; failure: string | null; model: string; seat: DesignSeat}> {
  const seat = await input.reserve(role, undefined, avoid);
  try {
    acceptClaudeExamSeat(seat);
    const call = DesignWorkerCall.parse({
      role: seat.grantRole ?? role,
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId: input.intentId,
      task: visualTask(screen, role, input.referenceNote, input.references),
      repo: input.repo,
      writePaths: [] as const,
    });
    const hit = await runModel(input.worker, call);
    if (hit.failure) return {scores: null, failure: hit.failure, model: seat.model, seat};
    return {scores: parseVisualScores(parseJson(hit.output)), failure: null, model: seat.model, seat};
  } finally {
    await input.release(seat);
  }
}

/** Arquivo, linha, regra, trecho e código. Sem a sugestão e sem a conclusão. */
function confirmationTask(
  finding: DesignExamFinding,
  code: string,
  captures: readonly DesignScreenCapture[] | undefined,
  references: DesignExamineInput['references'],
): string {
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
    ...referenceCaptureLines(references),
  ].join('\n').slice(0, 100000);
}

function rethrowReviewer(error: unknown): boolean {
  return error instanceof Refusal && (
    error.code === 'EXAM_LOGIN_STALE'
    || error.code === 'NATIVE_PRELAUNCH_SETTLEMENT_PENDING'
    || error.code === 'DESIGN_CONFIRMATION_INVALID'
    || error.code === 'EXAM_PROVIDER_UNSUPPORTED'
    || error.code === 'DESIGN_REVIEWER_UNAVAILABLE'
    || error.code === 'EXAM_LOGIN_BUSY'
    || error.code === 'EXAM_LOGIN_RESTORE_FAILED'
  );
}

async function confirmFinding(
  input: DesignExamineInput,
  finding: DesignExamFinding,
  code: string,
  captures: readonly DesignScreenCapture[] | undefined,
  noteModel: (model: string) => void,
  avoid?: DesignReserveOptions,
): Promise<{seat: DesignSeat; confirm: DesignConfirmResult}> {
  const seat = await input.reserve('reviewer', undefined, avoid);
  try {
    acceptClaudeExamSeat(seat);
    noteModel(seat.model);
    const call = DesignWorkerCall.parse({
      role: seat.grantRole ?? 'reviewer',
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId: input.intentId,
      task: confirmationTask(finding, code, captures, input.references),
      repo: input.repo,
      writePaths: [] as const,
    });
    const hit = await runModel(input.worker, call);
    if (hit.failure) {
      throw new Refusal(hit.failure);
    }
    const parsed = DesignConfirmResult.safeParse(normalizeDesignConfirm(parseJson(hit.output)));
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
    verifier: {model: string; provider: string} | null;
  }[];
  notes: string[];
  visual: {file: string; route: string; examiner: VisualScore[]; reviewer: VisualScore[]; uncertain: string[]}[];
  visualMissing: {file: string; route: string}[];
  loginStale: boolean;
  modelCoverage: DesignExamCoverage;
}> {
  const findings: DesignExamFinding[] = [];
  const coverage: DesignCoverageRow[] = [];
  const confirmations: {
    finding: DesignExamFinding;
    confirm: DesignConfirmResult;
    verifier: {model: string; provider: string} | null;
  }[] = [];
  const notes: string[] = [];
  const visual: {file: string; route: string; examiner: VisualScore[]; reviewer: VisualScore[]; uncertain: string[]}[] = [];
  const ids = input.checklist.map(entry => entry.id).filter(id => id.length > 0 && id.length <= 80).slice(0, 120);
  if (ids.length === 0) {
    notes.push('A lista de verificação veio vazia.');
    if (input.scoreVisual === true) notes.push('A crítica visual foi pedida, mas nenhuma tela entrou no exame.');
    return {findings, coverage, confirmations, notes, visual, visualMissing: [], loginStale: false, modelCoverage: blankExamCoverage()};
  }
  if (input.screens.length === 0) notes.push('Nenhuma tela para examinar.');

  const htmlCount = input.screens.filter(screen => !isNonHtmlResponse(screen.code)).length;
  if (input.scoreVisual === true && htmlCount === 0) {
    notes.push('A crítica visual foi pedida, mas nenhuma tela entrou no exame.');
  }
  const modelCoverage: DesignExamCoverage = {
    examiner: {model: 'desconhecido', requested: htmlCount, judged: 0, failure: 'nenhuma'},
    reviewer: {model: 'desconhecido', requested: input.scoreVisual === true ? htmlCount : 0, judged: 0, failure: 'nenhuma'},
  };
  const visualComplete = new Set<(typeof input.screens)[number]>();
  const remember = (role: 'examiner' | 'reviewer', model: string) => {
    if (modelCoverage[role].model !== 'desconhecido') return;
    const clean = model.replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (clean.length > 0) modelCoverage[role].model = clean;
  };
  const noteFailure = (role: 'examiner' | 'reviewer', code: string) => {
    if (modelCoverage[role].failure !== 'nenhuma') return;
    modelCoverage[role].failure = safeFailureCode(code);
  };
  let loginStale = false;
  try {
  for (const screen of input.screens) {
    if (isNonHtmlResponse(screen.code)) {
      notes.push(`A resposta de ${oneLine(screen.route)} não é tela: o corpo não é HTML.`);
      continue;
    }
    const seat = await input.reserve('specialist');
    let hit: ModelHit;
    try {
      acceptClaudeExamSeat(seat);
      const call = DesignWorkerCall.parse({
        role: seat.grantRole ?? 'specialist',
        provider: seat.provider,
        accountId: seat.accountId,
        profileId: seat.profileId,
        model: seat.model,
        grantId: seat.grantId,
        intentId: input.intentId,
        task: examTask(screen, ids, input.checklist, input.rawFindings, input.references),
        repo: input.repo,
        writePaths: [] as const,
      });
      hit = await runModel(input.worker, call);
    } finally {
      await input.release(seat);
    }
    remember('examiner', seat.model);
    if (hit.failure) {
      noteFailure('examiner', hit.failure);
      notes.push(`O examinador falhou em ${screen.file} com ${hit.failure}.`);
    }

    const exam = hit.failure ? null : DesignExamResult.safeParse(normalizeDesignExam(parseJson(hit.output), {file: screen.file, checklist: ids}));
    const echoed = exam?.success ? exam.data.checklist : [];
    const applied = (echoed.length > 0 ? echoed : ids)
      .map(id => id.slice(0, 80))
      .filter(id => id.length > 0)
      .slice(0, 120);
    coverage.push(DesignCoverageRow.parse({
      file: screen.file,
      examinerProvider: seat.provider,
      examinerModel: seat.model,
      profileId: seat.profileId,
      checklist: applied,
    }));
    const examinerProfileIds = [seat.profileId];
    const examinerAccountIds = [seat.accountId];
    const addExaminerSeat = (used: DesignSeat) => {
      if (!examinerProfileIds.includes(used.profileId)) examinerProfileIds.push(used.profileId);
      if (!examinerAccountIds.includes(used.accountId)) examinerAccountIds.push(used.accountId);
    };
    const examinerVisual = input.scoreVisual === true
      ? await askVisual(input, screen, 'specialist')
      : undefined;
    if (examinerVisual) {
      addExaminerSeat(examinerVisual.seat);
      remember('examiner', examinerVisual.model);
      if (examinerVisual.failure) noteFailure('examiner', examinerVisual.failure);
      if (examinerVisual.scores) modelCoverage.examiner.judged += 1;
    }
    const reviewAvoid: DesignReserveOptions = {
      avoidProfileId: examinerProfileIds[0],
      avoidProfileIds: [...examinerProfileIds],
      avoidAccountId: examinerAccountIds[0],
      avoidAccountIds: [...examinerAccountIds],
    };
    if (hit.failure) {
      /* The provider code is already on the coverage row. Visual scoring still runs when it was requested. */
    } else if (!exam?.success) {
      notes.push(`O exame de ${screen.file} não veio em JSON válido.`);
    } else {
      if (input.scoreVisual !== true) modelCoverage.examiner.judged += 1;
      if (!exam.data.filesRead.includes(screen.file)) {
        notes.push(`O examinador não marcou como lido: ${screen.file}.`);
      }
      let reviewerAsked = false;
      let reviewerJudged = false;
      for (const finding of exam.data.findings) {
        const measure = examMeasure(finding, input.rawFindings, screen.captures);
        const clamped = DesignExamFinding.parse({
          title: finding.title,
          severity: clampHighSeverity(finding.severity, measure),
          file: finding.file,
          line: finding.line,
          scenario: finding.scenario,
          suggestion: finding.suggestion,
          cwe: finding.cwe,
          reference: finding.reference,
          snippet: finding.snippet,
          ...(measure === undefined ? {} : {measure}),
        });
        findings.push(clamped);
        if (measure !== undefined) {
          confirmations.push({
            finding: clamped,
            confirm: {
              kind: 'confirmacao',
              status: 'confirmado',
              reason: 'A medida confirma o achado.',
              proof: measureProof(measure, clamped.snippet),
            },
            verifier: null,
          });
          continue;
        }
        if (input.scoreVisual !== true && !reviewerAsked) {
          modelCoverage.reviewer.requested += 1;
          reviewerAsked = true;
        }
        try {
          const reviewed = await confirmFinding(
            input,
            finding,
            screen.code,
            screen.captures,
            model => remember('reviewer', model),
            reviewAvoid,
          );
          if (input.scoreVisual !== true && !reviewerJudged) {
            modelCoverage.reviewer.judged += 1;
            reviewerJudged = true;
          }
          confirmations.push({
            finding: clamped,
            confirm: reviewed.confirm,
            verifier: {model: reviewed.seat.model, provider: reviewed.seat.provider},
          });
        } catch (error) {
          if (rethrowReviewer(error)) throw error;
          const code = error instanceof Refusal ? safeFailureCode(error.code) : 'EXECUTION_NATIVE_FAILED';
          noteFailure('reviewer', code);
          notes.push(`O revisor falhou em ${screen.file} com ${code}.`);
        }
      }
    }
    if (examinerVisual) {
      const reviewerVisual = await askVisual(input, screen, 'reviewer', reviewAvoid);
      remember('reviewer', reviewerVisual.model);
      if (reviewerVisual.failure) noteFailure('reviewer', reviewerVisual.failure);
      if (reviewerVisual.scores) modelCoverage.reviewer.judged += 1;
      if (!examinerVisual.scores || !reviewerVisual.scores) {
        const missingRoles = !examinerVisual.scores && !reviewerVisual.scores
          ? 'examinador e revisor'
          : !examinerVisual.scores
            ? 'examinador'
            : 'revisor';
        notes.push(`A crítica visual de ${oneLine(screen.route)} (${screen.file}) não veio completa (${missingRoles}).`);
      } else {
        visualComplete.add(screen);
        const uncertain = uncertainVisualAxes(examinerVisual.scores, reviewerVisual.scores);
        visual.push({file: screen.file, route: screen.route, examiner: examinerVisual.scores, reviewer: reviewerVisual.scores, uncertain});
        if (uncertain.length > 0) notes.push(`Julgamento incerto em ${oneLine(screen.route)}: ${uncertain.join('; ')}.`.slice(0, 500));
        for (const finding of visualExamFindings(screen.file, examinerVisual.scores)) {
          try {
            const reviewed = await confirmFinding(
              input,
              finding,
              screen.code,
              screen.captures,
              model => remember('reviewer', model),
              reviewAvoid,
            );
            findings.push(finding);
            confirmations.push({
              finding,
              confirm: reviewed.confirm,
              verifier: {model: reviewed.seat.model, provider: reviewed.seat.provider},
            });
          } catch (error) {
            if (rethrowReviewer(error)) throw error;
            const code = error instanceof Refusal ? safeFailureCode(error.code) : 'EXECUTION_NATIVE_FAILED';
            noteFailure('reviewer', code);
            notes.push(`O revisor falhou em ${screen.file} com ${code}.`);
          }
        }
      }
    }
  }
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'EXAM_LOGIN_STALE') throw error;
    loginStale = true;
    modelCoverage.examiner.failure = 'EXAM_LOGIN_STALE';
    modelCoverage.reviewer.failure = 'EXAM_LOGIN_STALE';
    if (!notes.includes(EXAM_LOGIN_STALE_TEXT)) notes.push(EXAM_LOGIN_STALE_TEXT);
  }

  const visualMissing = input.scoreVisual === true
    ? input.screens
        .filter(screen => !isNonHtmlResponse(screen.code) && !visualComplete.has(screen))
        .map(screen => ({file: screen.file, route: screen.route}))
    : [];

  return {findings, coverage, confirmations, notes, visual, visualMissing, loginStale, modelCoverage};
}
