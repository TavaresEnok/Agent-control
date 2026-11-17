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
  'NIELSEN', 'UX-LAW', 'WCAG-2.2', 'TOKENS', 'STATES', 'UX-WRITING', 'SMALL-SCREEN',
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

export const DesignRawFinding = z.object({
  tool: z.string().min(1).max(40),
  rule: z.string().min(1).max(200),
  cwe: z.string().regex(/^CWE-\d{1,5}$/).nullable(),
  file: z.string().min(1).max(400),
  line: z.number().int().positive().nullable(),
  severity: DesignSeverity,
  snippet: z.string().max(240),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
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
}).strict();
export type DesignExamFinding = z.infer<typeof DesignExamFinding>;

export const DesignExamResult = z.object({
  kind: z.literal('exame'),
  filesRead: z.array(z.string().min(1).max(400)).min(1).max(80),
  checklist: z.array(z.string().min(1).max(80)).min(1).max(80),
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
}).strict();
export type DesignWorkerCall = z.infer<typeof DesignWorkerCall>;

export type DesignWorker = {
  run(call: DesignWorkerCall): Promise<string>;
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

export function designRawFinding(input: {
  tool: string;
  rule: string;
  cwe?: string | null;
  file: string;
  line?: number | null;
  severity: DesignSeverity;
  snippet: string;
}): DesignRawFinding {
  const snippet = input.snippet.replace(/\s+/g, ' ').trim().slice(0, 240);
  const line = input.line ?? null;
  const cwe = input.cwe ?? null;
  return DesignRawFinding.parse({
    tool: input.tool.slice(0, 40),
    rule: input.rule.slice(0, 200),
    cwe,
    file: input.file.slice(0, 400),
    line,
    severity: input.severity,
    snippet,
    fingerprint: designFingerprint([input.tool, input.rule, input.file, String(line ?? ''), snippet]),
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

/** Opinion without a rule cannot be alta. A WCAG id, a planted rule or a DESIGN- checklist id can. */
export function highSeverityAllowed(reference: string): boolean {
  if (Object.values(DESIGN_PLANTED_RULES).some(rule => reference.includes(rule))) return true;
  if (reference.includes('WCAG')) return true;
  if (/(?:^|[^A-Z0-9])DESIGN-[A-Z0-9-]{3,80}/.test(reference)) return true;
  return false;
}

export function clampHighSeverity(severity: DesignSeverity, reference: string): DesignSeverity {
  if (severity === 'alta' && !highSeverityAllowed(reference)) return 'informativa';
  return severity;
}
