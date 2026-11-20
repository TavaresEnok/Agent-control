import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Id} from './contracts.ts';

/**
 * Shapes aligned with module 1 (RawFinding, Achado, CoverageRow, VerifyWorkerCall).
 * This branch does not import the other worktree. Keep the fields identical at merge.
 * Locked mode never accepts a design run. Callers must pass activation "personal".
 */

export const DesignSeverity = z.enum(['alta', 'media', 'baixa', 'informativa']);
export type DesignSeverity = z.infer<typeof DesignSeverity>;
export const DesignStatus = z.enum(['confirmado', 'provavel', 'descartado', 'fechado', 'reaberto']);
export type DesignStatus = z.infer<typeof DesignStatus>;

export const DesignChecklistSource = z.enum([
  'NIELSEN', 'UX-LAW', 'WCAG-2.2', 'TOKENS', 'STATES', 'UX-WRITING', 'SMALL-SCREEN', 'VISUAL',
]);
export type DesignChecklistSource = z.infer<typeof DesignChecklistSource>;

export const DesignChecklistItem = z.object({
  id: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,80}$/),
  source: DesignChecklistSource,
  title: z.string().min(1).max(200),
  appliesTo: z.enum(['screen', 'style', 'copy', 'any']),
  prompt: z.string().min(1).max(2000),
}).strict();
export type DesignChecklistItem = z.infer<typeof DesignChecklistItem>;

const MEASURE_PX = z.number().finite().positive();
const EMPTY_CAPTURE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.png$/);

/** Medida que autoriza gravidade alta. Texto de regra não substitui o número ou o arquivo. */
export const DesignMeasure = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('contrast'), ratio: MEASURE_PX}).strict(),
  z.object({kind: z.literal('target'), px: MEASURE_PX}).strict(),
  z.object({kind: z.literal('overflow'), px: MEASURE_PX}).strict(),
  z.object({kind: z.literal('empty'), capture: EMPTY_CAPTURE}).strict(),
  z.object({kind: z.literal('token'), px: MEASURE_PX}).strict(),
  z.object({kind: z.literal('lighthouse'), metric: z.enum(['lcp', 'cls', 'tbt']), value: z.number().finite().nonnegative()}).strict(),
  z.object({kind: z.literal('wallace'), metric: z.string().min(1).max(40), value: z.number().finite().nonnegative()}).strict(),
]);
export type DesignMeasure = z.infer<typeof DesignMeasure>;

export const DesignRawFinding = z.object({
  tool: z.string().min(1).max(40),
  rule: z.string().min(1).max(200),
  cwe: z.string().regex(/^CWE-\d{1,5}$/).nullable(),
  file: z.string().min(1).max(400),
  line: z.number().int().positive().nullable(),
  severity: DesignSeverity,
  snippet: z.string().max(240),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  measure: DesignMeasure.optional(),
}).strict();
export type DesignRawFinding = z.infer<typeof DesignRawFinding>;

export const DesignExamFinding = z.object({
  title: z.string().min(1).max(200),
  severity: DesignSeverity,
  file: z.string().min(1).max(400),
  line: z.number().int().positive().nullable(),
  scenario: z.string().min(1).max(2000),
  suggestion: z.string().min(1).max(2000),
  cwe: z.string().regex(/^CWE-\d{1,5}$/).nullable(),
  reference: z.string().min(1).max(120),
  snippet: z.string().max(240),
  measure: DesignMeasure.optional(),
}).strict();
export type DesignExamFinding = z.infer<typeof DesignExamFinding>;

export const DesignExamResult = z.object({
  kind: z.literal('exame'),
  filesRead: z.array(z.string().min(1).max(400)).min(1).max(80),
  checklist: z.array(z.string().min(1).max(80)).min(1).max(120),
  findings: z.array(DesignExamFinding).max(40),
}).strict();
export type DesignExamResult = z.infer<typeof DesignExamResult>;

export const DesignConfirmResult = z.object({
  kind: z.literal('confirmacao'),
  status: z.enum(['confirmado', 'provavel', 'descartado']),
  reason: z.string().min(1).max(2000),
  proof: z.string().max(2000),
}).strict();
export type DesignConfirmResult = z.infer<typeof DesignConfirmResult>;

export const DesignPurpose = z.enum(['examiner', 'visual', 'create', 'reviewer']);
export type DesignPurpose = z.infer<typeof DesignPurpose>;

export const DesignWorkerCall = z.object({
  role: z.enum(['specialist', 'reviewer']),
  provider: z.string().min(1).max(80),
  accountId: Id,
  profileId: Id,
  model: z.string().min(1).max(100),
  grantId: Id,
  intentId: Id,
  task: z.string().min(1).max(100000),
  repo: z.string().min(1).max(500),
  writePaths: z.tuple([]),
  designPurpose: DesignPurpose.optional(),
  /** Só o modo criar. O exame de leitura não preenche. */
  forcedModel: z.literal('claude-opus-5-5').optional(),
  forcedEffort: z.literal('high').optional(),
}).strict();
export type DesignWorkerCall = z.infer<typeof DesignWorkerCall>;

export type DesignWorker = {
  run(call: DesignWorkerCall): Promise<string>;
};

/** Examiner and reviewer rows appended to the design coverage table. */
export type DesignExamCoverage = {
  examiner: {model: string; requested: number; judged: number; failure: string};
  reviewer: {model: string; requested: number; judged: number; failure: string};
};

export const DesignAchado = z.object({
  id: z.string().regex(/^ACH-\d{3}$/),
  title: z.string().min(1).max(200),
  severity: DesignSeverity,
  status: DesignStatus,
  verifier: z.object({model: z.string().min(1).max(100), provider: z.string().min(1).max(80)}).strict().nullable(),
  reference: z.string().min(1).max(200),
  where: z.object({file: z.string().min(1).max(400), line: z.number().int().positive().nullable()}).strict(),
  scenario: z.string().min(1).max(2000),
  proof: z.string().max(2000),
  suggestion: z.string().min(1).max(2000),
  acceptance: z.string().min(1).max(500),
  sources: z.array(z.string().min(1).max(200)).min(1).max(20),
  secretPreview: z.string().max(80).nullable(),
}).strict();
export type DesignAchado = z.infer<typeof DesignAchado>;

export const DesignCoverageRow = z.object({
  file: z.string().min(1).max(400),
  examinerProvider: z.string().min(1).max(80),
  examinerModel: z.string().min(1).max(100),
  profileId: Id,
  checklist: z.array(z.string().min(1).max(80)).min(1),
}).strict();
export type DesignCoverageRow = z.infer<typeof DesignCoverageRow>;

export const DesignReportSummary = z.object({
  id: Id,
  directoryName: z.string().regex(/^\d{8}-\d{6}-design$/),
  createdAt: z.string().min(1).max(40),
  counts: z.object({
    alta: z.number().int().nonnegative(),
    media: z.number().int().nonnegative(),
    baixa: z.number().int().nonnegative(),
    informativa: z.number().int().nonnegative(),
  }).strict(),
  note: z.string().max(500),
}).strict();
export type DesignReportSummary = z.infer<typeof DesignReportSummary>;

export const DESIGN_ACCEPTANCE = 'O teste de regressão passa e a nova verificação do mesmo ponto não reabre o achado.';

/** Stable rule ids. The lab fixture must trip each one. Correct screens must not trip them. */
export const DESIGN_PLANTED_RULES = {
  contrast: 'WCAG-1-4-3-CONTRASTE',
  unlabeledButton: 'WCAG-2-4-4-BOTAO-SEM-NOME',
  invisibleFocus: 'WCAG-2-4-7-FOCO-INVISIVEL',
  grays: 'TOKENS-CINZAS-DEMAIS',
  spacing: 'TOKENS-ESPACAMENTO',
  empty: 'ESTADOS-VAZIO-AUSENTE',
  narrow: 'TELA-375-QUEBRADA',
  truncated: 'TEXTO-CORTADO',
} as const;

export const DESIGN_GRAY_MIN = 8;
export const DESIGN_OFFSCALE_SPACING_MIN = 4;
export const DESIGN_FIXED_WIDTH_PX = 400;
export const DESIGN_CONTRAST_AA = 4.5;
export const DESIGN_CONTRAST_AA_LARGE = 3;

export const DESIGN_VIEWPORTS = [375, 768, 1440] as const;
export type DesignViewport = (typeof DESIGN_VIEWPORTS)[number];

export function designFingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function measureToken(measure: DesignMeasure): string {
  if (measure.kind === 'contrast') return `contrast:${measure.ratio}`;
  if (measure.kind === 'empty') return `empty:${measure.capture}`;
  if (measure.kind === 'lighthouse') return `lighthouse:${measure.metric}:${measure.value}`;
  if (measure.kind === 'wallace') return `wallace:${measure.metric}:${measure.value}`;
  return `${measure.kind}:${measure.px}`;
}

function acceptedMeasure(measure: DesignMeasure | null | undefined): DesignMeasure | undefined {
  const parsed = DesignMeasure.safeParse(measure);
  return parsed.success ? parsed.data : undefined;
}

export function designRawFinding(input: {
  tool: string;
  rule: string;
  cwe?: string | null;
  file: string;
  line?: number | null;
  severity: DesignSeverity;
  snippet: string;
  measure?: DesignMeasure | null;
}): DesignRawFinding {
  const snippet = input.snippet.replace(/\s+/g, ' ').trim().slice(0, 240);
  const line = input.line ?? null;
  const cwe = input.cwe ?? null;
  const measure = acceptedMeasure(input.measure);
  // Inventário e teclado sem medida continuam informativos; o resto da alta sem medida vira media.
  const staysInformative = input.tool === 'inventario' || input.tool === 'teclado';
  const severity = input.severity === 'alta' && measure === undefined
    ? (staysInformative ? 'informativa' : 'media')
    : input.severity;
  const parts = [input.tool, input.rule, input.file, String(line ?? ''), snippet];
  if (measure !== undefined) parts.push(measureToken(measure));
  return DesignRawFinding.parse({
    tool: input.tool.slice(0, 40),
    rule: input.rule.slice(0, 200),
    cwe,
    file: input.file.slice(0, 400),
    line,
    severity,
    snippet,
    fingerprint: designFingerprint(parts),
    ...(measure === undefined ? {} : {measure}),
  });
}

export function dedupeDesignFindings(findings: readonly DesignRawFinding[]): DesignRawFinding[] {
  const seen = new Set<string>();
  const kept: DesignRawFinding[] = [];
  for (const finding of findings) {
    const parsed = DesignRawFinding.parse(finding);
    if (seen.has(parsed.fingerprint)) continue;
    seen.add(parsed.fingerprint);
    kept.push(parsed);
  }
  return kept;
}

/** Alta exige uma das quatro medidas. WCAG, DESIGN- e id plantado no texto não contam. */
export function clampHighSeverity(severity: DesignSeverity, measure?: DesignMeasure | null): DesignSeverity {
  if (severity === 'alta' && acceptedMeasure(measure) === undefined) return 'media';
  return severity;
}
