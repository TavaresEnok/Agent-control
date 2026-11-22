import {z} from 'zod';
import {Id} from './contracts.ts';

/** Personal-mode security verification. Locked mode never accepts these values. */
export const VerifySeverity = z.enum(['alta', 'media', 'baixa', 'informativa']);
export type VerifySeverity = z.infer<typeof VerifySeverity>;
export const VerifyStatus = z.enum(['confirmado', 'provavel', 'descartado', 'fechado', 'reaberto']);
export type VerifyStatus = z.infer<typeof VerifyStatus>;
export const ChecklistSource = z.enum(['ASVS-5.0', 'OWASP-2025', 'CWE-TOP-25']);
export const ChecklistAppliesTo = z.enum(['code', 'route', 'config', 'dependency', 'secret', 'dockerfile', 'any']);

export const ChecklistItem = z.object({
  id: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,80}$/),
  source: ChecklistSource,
  title: z.string().min(1).max(200),
  appliesTo: ChecklistAppliesTo,
  prompt: z.string().min(1).max(2000),
}).strict();
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const RawFinding = z.object({
  tool: z.string().min(1).max(40),
  rule: z.string().min(1).max(200),
  cwe: z.string().regex(/^CWE-\d{1,5}$/).nullable(),
  file: z.string().min(1).max(400),
  line: z.number().int().positive().nullable(),
  severity: VerifySeverity,
  snippet: z.string().max(240),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RawFinding = z.infer<typeof RawFinding>;

export const ExamFinding = z.object({
  title: z.string().min(1).max(200),
  severity: VerifySeverity,
  file: z.string().min(1).max(400),
  line: z.number().int().positive().nullable(),
  scenario: z.string().min(1).max(2000),
  suggestion: z.string().min(1).max(2000),
  cwe: z.string().regex(/^CWE-\d{1,5}$/).nullable(),
  reference: z.string().min(1).max(120),
  snippet: z.string().max(240),
}).strict();
export type ExamFinding = z.infer<typeof ExamFinding>;

export const MapResult = z.object({
  kind: z.literal('mapa'),
  routes: z.array(z.object({
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(240),
    file: z.string().min(1).max(400),
    line: z.number().int().positive(),
  }).strict()).max(500),
  surfaces: z.array(z.string().min(1).max(200)).max(80),
}).strict();
export type MapResult = z.infer<typeof MapResult>;

export const ExamResult = z.object({
  kind: z.literal('exame'),
  filesRead: z.array(z.string().min(1).max(400)).min(1).max(80),
  checklist: z.array(z.string().min(1).max(80)).min(1).max(80),
  findings: z.array(ExamFinding).max(40),
}).strict();
export type ExamResult = z.infer<typeof ExamResult>;

export const ConfirmResult = z.object({
  kind: z.literal('confirmacao'),
  status: z.enum(['confirmado', 'provavel', 'descartado']),
  reason: z.string().min(1).max(2000),
  proof: z.string().max(2000),
}).strict();
export type ConfirmResult = z.infer<typeof ConfirmResult>;

/** What a specialist or reviewer sees. The reviewer task never carries the examiner conclusion. */
export const VerifyWorkerCall = z.object({
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
  avoidProviders: z.array(z.string().min(1).max(80)).max(4).optional(),
  avoidProfiles: z.array(Id).max(20).optional(),
  avoidAccounts: z.array(Id).max(8).optional(),
  avoidExaminerAccounts: z.array(Id).max(20).optional(),
}).strict();
export type VerifyWorkerCall = z.infer<typeof VerifyWorkerCall>;

export type VerifyWorker = {
  run(call: VerifyWorkerCall): Promise<string>;
  stop?(): Promise<void>;
};

export const Achado = z.object({
  id: z.string().regex(/^ACH-\d{3}$/),
  title: z.string().min(1).max(200),
  severity: VerifySeverity,
  status: VerifyStatus,
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
export type Achado = z.infer<typeof Achado>;

/** `checklist` is the confirmed list: only what the examiner declared for the file. `requested` is what the plan asked and
 * `pending` is the part of `requested` the examiner did not declare, so a gap stays visible after any re-examination. */
export const CoverageRow = z.object({
  file: z.string().min(1).max(400),
  examinerProvider: z.string().min(1).max(80),
  examinerModel: z.string().min(1).max(100),
  profileId: Id.nullable(),
  checklist: z.array(z.string().min(1).max(80)),
  requested: z.array(z.string().min(1).max(80)).optional(),
  pending: z.array(z.string().min(1).max(80)).optional(),
}).strict();
export type CoverageRow = z.infer<typeof CoverageRow>;

/** clean run, valid findings, tool unavailable or failed, truncated or unreadable output. */
export const ToolState = z.enum(['limpa', 'achado', 'indisponivel', 'truncada']);
export type ToolState = z.infer<typeof ToolState>;

/** One result per exam tool, kept next to the report. `reason` says why a tool was dismissed. */
export const ToolResult = z.object({
  name: z.string().min(1).max(40),
  tool: z.string().min(1).max(40),
  version: z.string().max(200).nullable(),
  exitCode: z.number().int().nullable(),
  expectedFile: z.string().min(1).max(100),
  fileFound: z.boolean(),
  formatValid: z.boolean().nullable(),
  state: ToolState,
  reason: z.string().max(300).nullable(),
  findings: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative().nullable(),
  stderrTail: z.string().max(300),
}).strict();
export type ToolResult = z.infer<typeof ToolResult>;

/** Where a budget stop left the exam. Absent when the exam ran to the end. */
export const PartialStop = z.object({
  phase: z.enum(['mapa', 'exame', 'confirmacao']),
  reason: z.literal('VERIFY_MODEL_BUDGET'),
  point: z.string().min(1).max(200),
  budget: z.number().positive(),
  calls: z.number().int().nonnegative(),
  pendingFiles: z.array(z.string().min(1).max(400)).max(100000),
  unreviewed: z.array(z.string().min(1).max(500)).max(100000),
}).strict();
export type PartialStop = z.infer<typeof PartialStop>;

export const ReportSummary = z.object({
  id: Id,
  directoryName: z.string().regex(/^\d{8}-\d{6}(?:-[a-f0-9]{8})?-seguranca$/),
  createdAt: z.string().min(1).max(40),
  counts: z.object({alta: z.number().int().nonnegative(), media: z.number().int().nonnegative(), baixa: z.number().int().nonnegative(), informativa: z.number().int().nonnegative()}).strict(),
  note: z.string().max(500),
  partial: z.boolean().optional(),
  tools: z.object({limpa: z.number().int().nonnegative(), achado: z.number().int().nonnegative(), indisponivel: z.number().int().nonnegative(), truncada: z.number().int().nonnegative()}).strict().optional(),
}).strict();
export type ReportSummary = z.infer<typeof ReportSummary>;

export const REMEDIATION_ACCEPTANCE = 'O teste de regressão passa e a nova verificação do mesmo ponto não reabre o achado. A correção muda só o necessário para fechar o achado, reaproveita o que o projeto e a biblioteca padrão já oferecem, não adiciona dependência e não mexe em código fora do achado.';
